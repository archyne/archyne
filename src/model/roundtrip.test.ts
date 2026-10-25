import { describe, expect, it } from "vitest";
import { parseDiagram, serializeDiagram, UnsupportedDiagramError } from "./diagram";
import type { DiagramKind } from "./types";
import { carryOverPositions, patchPositions, readPositions, stripPositions } from "./positions";

const FLOW = `flowchart TD
  start(["Start"])
  check{"Valid?"}
  db[("Database")]

  start --> check
  check -->|"yes"| db
  check -.-> start
`;

/** parse → serialize → parse, then compare the structural essentials. */
async function roundTrip(code: string, kind: DiagramKind) {
  const g1 = await parseDiagram(code);
  expect(g1.kind).toBe(kind);
  const out = serializeDiagram({
    kind: g1.kind,
    direction: g1.direction,
    nodes: g1.nodes,
    edges: g1.edges,
  });
  const g2 = await parseDiagram(out);
  const nodeEssence = (g: typeof g1) =>
    g.nodes
      .map((n) => [n.id, n.type, n.data.label, n.parentId ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const edgeEssence = (g: typeof g1) =>
    g.edges
      .map((e) => [e.source, e.target, e.data?.label, e.data?.er, e.data?.cls])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  expect(g2.direction).toBe(g1.direction);
  expect(nodeEssence(g2)).toEqual(nodeEssence(g1));
  expect(edgeEssence(g2)).toEqual(edgeEssence(g1));
  return { g1, g2 };
}

describe("flowchart", () => {
  it("parses nodes, shapes, edges and direction", async () => {
    const g = await parseDiagram(FLOW);
    expect(g.kind).toBe("flowchart");
    // mermaid normalizes the TD synonym to TB
    expect(g.direction).toBe("TB");
    expect(g.nodes).toHaveLength(3);
    const shapes = Object.fromEntries(
      g.nodes.map((n) => [n.id, n.type === "shape" ? n.data.shape : null]),
    );
    expect(shapes).toEqual({ start: "stadium", check: "diamond", db: "cylinder" });
    expect(g.edges).toHaveLength(3);
    expect(g.edges[1].data?.label).toBe("yes");
    expect(g.edges[2].data?.stroke).toBe("dotted");
  });

  it("round-trips classDef, class assignments, and inline styles", async () => {
    const code = `flowchart TD
  a["A"]:::hot --> b["B"]
  classDef hot fill:#f96,stroke:#333
  style b fill:#90ee90
`;
    const g1 = await parseDiagram(code);
    expect(g1.classDefs).toEqual({ hot: ["fill:#f96", "stroke:#333"] });
    const a = g1.nodes.find((n) => n.id === "a");
    const b = g1.nodes.find((n) => n.id === "b");
    expect(a?.type === "shape" && a.data.classes).toEqual(["hot"]);
    expect(b?.type === "shape" && b.data.styles).toEqual(["fill:#90ee90"]);

    const out = serializeDiagram({
      kind: g1.kind,
      direction: g1.direction,
      nodes: g1.nodes,
      edges: g1.edges,
      classDefs: g1.classDefs,
    });
    const g2 = await parseDiagram(out);
    expect(g2.classDefs).toEqual(g1.classDefs);
    const a2 = g2.nodes.find((n) => n.id === "a");
    const b2 = g2.nodes.find((n) => n.id === "b");
    expect(a2?.type === "shape" && a2.data.classes).toEqual(["hot"]);
    expect(b2?.type === "shape" && b2.data.styles).toEqual(["fill:#90ee90"]);
  });

  it("round-trips, subgraphs included", async () => {
    await roundTrip(FLOW, "flowchart");
    const { g2 } = await roundTrip(
      `flowchart LR
  subgraph backend ["Backend"]
    api["API"]
  end
  ui["UI"] --> api
`,
      "flowchart",
    );
    expect(g2.nodes.find((n) => n.id === "api")?.parentId).toBe("backend");
  });

  it("keeps a subgraph's colours", async () => {
    // Read, they were dropped: every draw.io panel came out the same tint.
    const { g2 } = await roundTrip(
      `flowchart LR
  subgraph vnet ["VNet"]
    api["API"]
  end
  style vnet fill:#dae8fc,stroke:#6c8ebf
`,
      "flowchart",
    );
    expect(g2.nodes.find((n) => n.id === "vnet")?.data).toMatchObject({
      styles: ["fill:#dae8fc", "stroke:#6c8ebf"],
    });
  });
});

describe("state diagram", () => {
  const STATE = `stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
  state Running {
    Warm --> Hot
  }
  Running --> [*]
`;

  it("parses pseudo-states and composite states from the root doc", async () => {
    const g = await parseDiagram(STATE);
    expect(g.kind).toBe("state");
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get("root_start")?.type).toBe("state");
    expect((byId.get("root_start") as { data: { stateType: string } }).data.stateType).toBe(
      "start",
    );
    expect(byId.get("Running")?.type).toBe("group");
    expect(byId.get("Warm")?.parentId).toBe("Running");
    // nested transition is only in the root doc, not getRelations
    expect(g.edges.some((e) => e.source === "Warm" && e.target === "Hot")).toBe(true);
  });

  it("round-trips including nested transitions", async () => {
    await roundTrip(STATE, "state");
  });

  it("round-trips state descriptions", async () => {
    const g = await parseDiagram("stateDiagram-v2\n  s1 : My nice label\n  s1 --> s2\n");
    expect(g.nodes.find((n) => n.id === "s1")?.data.label).toBe("My nice label");
    await roundTrip("stateDiagram-v2\n  s1 : My nice label\n  s1 --> s2\n", "state");
  });
});

describe("er diagram", () => {
  const ER = `erDiagram
  CUSTOMER {
    string name PK "the name"
    int age
  }
  CUSTOMER ||--o{ ORDER : "places"
  ORDER }|..|{ LINE_ITEM : "contains"
`;

  it("parses entities, attributes and swapped cardinalities", async () => {
    const g = await parseDiagram(ER);
    expect(g.kind).toBe("er");
    const customer = g.nodes.find((n) => n.id === "CUSTOMER");
    expect(customer?.type).toBe("entity");
    const attrs = (customer as { data: { attributes: unknown[] } }).data.attributes;
    expect(attrs).toEqual([
      { type: "string", name: "name", keys: ["PK"], comment: "the name" },
      { type: "int", name: "age", keys: [], comment: "" },
    ]);
    const e = g.edges[0];
    expect(e.source).toBe("CUSTOMER");
    expect(e.target).toBe("ORDER");
    // `||` next to CUSTOMER is cardB, `o{` next to ORDER is cardA
    expect(e.data?.er).toEqual({
      cardA: "ZERO_OR_MORE",
      cardB: "ONLY_ONE",
      identifying: true,
    });
    expect(g.edges[1].data?.er?.identifying).toBe(false);
  });

  it("round-trips", async () => {
    await roundTrip(ER, "er");
  });
});

describe("class diagram", () => {
  const CLS = `classDiagram
  class Animal {
    +int age
    +swim() void
  }
  Animal <|-- Duck
  Animal ..> Food : eats
  Animal "1" o-- "many" Leg
`;

  it("parses members, methods and relation markers", async () => {
    const g = await parseDiagram(CLS);
    expect(g.kind).toBe("class");
    const animal = g.nodes.find((n) => n.id === "Animal");
    expect(animal?.type).toBe("class");
    const data = (animal as { data: { members: string[]; methods: string[] } }).data;
    expect(data.members).toEqual(["+int age"]);
    expect(data.methods).toEqual(["+swim() void"]);
    expect(g.edges[0].data?.cls).toMatchObject({ left: "extension", dotted: false });
    expect(g.edges[1].data?.cls).toMatchObject({ right: "dependency", dotted: true });
    expect(g.edges[1].data?.label).toBe("eats");
    expect(g.edges[2].data?.cls).toMatchObject({
      left: "aggregation",
      card1: "1",
      card2: "many",
    });
  });

  it("round-trips", async () => {
    await roundTrip(CLS, "class");
  });
});

describe("positions sidecar", () => {
  it("writes, reads and strips the positions comment", () => {
    const withPos = patchPositions(FLOW, {
      start: { x: 10.6, y: 20.2 },
      g1: { x: 0, y: 0, w: 300, h: 200 },
    });
    expect(readPositions(withPos)).toEqual({
      start: { x: 11, y: 20 },
      g1: { x: 0, y: 0, w: 300, h: 200 },
    });
    expect(stripPositions(withPos)).not.toContain("graph:positions");
  });

  it("patch replaces an existing line instead of appending", () => {
    const once = patchPositions(FLOW, { start: { x: 1, y: 2 } });
    const twice = patchPositions(once, { start: { x: 3, y: 4 } });
    expect(twice.match(/graph:positions/g)).toHaveLength(1);
    expect(readPositions(twice)).toEqual({ start: { x: 3, y: 4 } });
  });

  it("keeps the text valid for mermaid, for every kind", async () => {
    for (const code of [
      FLOW,
      "stateDiagram-v2\n  a --> b\n",
      'erDiagram\n  A ||--|| B : "x"\n',
    ]) {
      const withPos = patchPositions(code, { a: { x: 1, y: 2 } });
      await expect(parseDiagram(withPos)).resolves.toBeTruthy();
    }
  });

  it("carries old positions into a rewrite that dropped them", () => {
    const old = patchPositions(FLOW, { start: { x: 1, y: 2 }, gone: { x: 9, y: 9 } });
    const rewrite = 'flowchart TD\n  start(["Start"]) --> other["Other"]\n';
    const merged = carryOverPositions(old, rewrite, ["start", "other"]);
    expect(readPositions(merged)).toEqual({ start: { x: 1, y: 2 } });
  });

  it("does not override positions a rewrite brings itself", () => {
    const old = patchPositions(FLOW, { start: { x: 1, y: 2 } });
    const rewrite = patchPositions(FLOW, { start: { x: 5, y: 6 } });
    const merged = carryOverPositions(old, rewrite, ["start"]);
    expect(readPositions(merged)).toEqual({ start: { x: 5, y: 6 } });
  });
});

describe("sequence diagram", () => {
  const SEQ = `sequenceDiagram
  actor U as User
  participant S as Server
  U->>S: request
  S-->>U: response
  S-)U: async event
  U->U: think
`;

  it("parses participants, actor types, and message operators", async () => {
    const g = await parseDiagram(SEQ);
    expect(g.kind).toBe("sequence");
    const u = g.nodes.find((n) => n.id === "U");
    expect(u?.type === "participant" && u.data.ptype).toBe("actor");
    expect(u?.data.label).toBe("User");
    expect(g.edges.map((e) => e.data?.seq?.op)).toEqual(["->>", "-->>", "-)", "->"]);
    expect(g.edges[0].data?.label).toBe("request");
  });

  it("round-trips, message order preserved", async () => {
    const g1 = await parseDiagram(SEQ);
    const out = serializeDiagram({
      kind: g1.kind,
      direction: g1.direction,
      nodes: g1.nodes.map((n, i) => ({ ...n, position: { x: i * 220, y: 0 } })),
      edges: g1.edges,
    });
    const g2 = await parseDiagram(out);
    expect(g2.nodes.map((n) => [n.id, n.data.label])).toEqual(
      g1.nodes.map((n) => [n.id, n.data.label]),
    );
    expect(g2.edges.map((e) => [e.source, e.target, e.data?.label, e.data?.seq?.op])).toEqual(
      g1.edges.map((e) => [e.source, e.target, e.data?.label, e.data?.seq?.op]),
    );
  });

  it("notes are parsed into the item stream (no warning)", async () => {
    const g = await parseDiagram("sequenceDiagram\n  A->>B: hi\n  Note over A,B: careful\n");
    expect(g.warning).toBeUndefined();
    expect(g.items?.some((i) => i.kind === "note")).toBe(true);
  });
});

describe("architecture diagram", () => {
  const ARCH = `architecture-beta
  group vpc(cloud)[VPC]
  group priv(server)[Private] in vpc
  service web(logos:aws-ec2)[Web] in vpc
  service db(database)[Database] in priv
  junction j1

  web:R --> L:db
  db:B -- T:j1
`;

  it("parses groups, services, junctions, and edge sides", async () => {
    const g = await parseDiagram(ARCH);
    expect(g.kind).toBe("architecture");
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get("vpc")?.type).toBe("group");
    expect(byId.get("priv")?.parentId).toBe("vpc");
    const web = byId.get("web");
    expect(web?.type === "service" && web.data.icon).toBe("logos:aws-ec2");
    expect(byId.get("db")?.parentId).toBe("priv");
    expect(byId.get("j1")?.type).toBe("junction");
    const e = g.edges[0];
    expect(e.sourceHandle).toBe("R");
    expect(e.targetHandle).toBe("L");
    expect(e.data?.arch).toMatchObject({ lhsInto: false, rhsInto: true });
    expect(g.edges[1].data?.arch?.rhsInto).toBe(false);
  });

  it("keeps optional icon and label optional (no invented defaults)", async () => {
    const g1 = await parseDiagram(
      "architecture-beta\n  service a[Solo label]\n  service b(cloud)\n  group g[Un gruppo]\n",
    );
    const out = serializeDiagram({
      kind: g1.kind,
      direction: g1.direction,
      nodes: g1.nodes,
      edges: g1.edges,
    });
    expect(out).toContain("service a[Solo label]");
    expect(out).not.toContain("a(server)");
    expect(out).toContain("service b(cloud)\n");
    expect(out).not.toContain("b(cloud)[");
    expect(out).toContain("group g[Un gruppo]");
  });

  it("round-trips edge labels via the -[label]- syntax", async () => {
    const g1 = await parseDiagram(
      "architecture-beta\n  service a(cloud)[A]\n  service b(cloud)[B]\n  a:R -[HTTPS request]-> L:b\n",
    );
    expect(g1.edges[0].data?.label).toBe("HTTPS request");
    const out = serializeDiagram({
      kind: g1.kind,
      direction: g1.direction,
      nodes: g1.nodes,
      edges: g1.edges,
    });
    expect(out).toContain("-[HTTPS request]->");
    const g2 = await parseDiagram(out);
    expect(g2.edges[0].data?.label).toBe("HTTPS request");
  });

  it("warns about duplicate connections mermaid cannot render", async () => {
    const g = await parseDiagram(
      "architecture-beta\n  service a(cloud)[A]\n  service b(cloud)[B]\n  a:T --> T:b\n  a:B --> B:b\n",
    );
    expect(g.warning).toMatch(/ONE connection/);
    expect(g.edges).toHaveLength(2);
  });

  it("round-trips", async () => {
    const g1 = await parseDiagram(ARCH);
    const out = serializeDiagram({
      kind: g1.kind,
      direction: g1.direction,
      nodes: g1.nodes,
      edges: g1.edges,
    });
    const g2 = await parseDiagram(out);
    const essence = (g: typeof g1) => ({
      nodes: g.nodes
        .map((n) => [n.id, n.type, n.data.label ?? null, n.parentId ?? null])
        .sort(),
      edges: g.edges.map((e) => [e.source, e.target, e.data?.arch]).sort(),
    });
    expect(essence(g2)).toEqual(essence(g1));
  });
});

describe("c4 diagram", () => {
  const C4 = `C4Context
  title System Context
  Person(user, "User", "An end user")
  System_Ext(mail, "Mail system")
  Enterprise_Boundary(b0, "Corp") {
    System(app, "Application", "Core app")
  }

  Rel(user, app, "Uses", "HTTPS")
  BiRel(app, mail, "Exchanges mail")
`;

  it("parses elements, boundaries, flavor and rels", async () => {
    const g = await parseDiagram(C4);
    expect(g.kind).toBe("c4");
    expect(g.c4Flavor).toBe("C4Context");
    expect(g.title).toBe("System Context");
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const user = byId.get("user");
    expect(user?.type === "c4" && user.data.c4Shape).toBe("person");
    expect(user?.type === "c4" && user.data.descr).toBe("An end user");
    const mail = byId.get("mail");
    expect(mail?.type === "c4" && mail.data.c4Shape).toBe("external_system");
    expect(byId.get("b0")?.type).toBe("group");
    expect(byId.get("app")?.parentId).toBe("b0");
    expect(g.edges[0].data?.c4).toEqual({ relType: "rel", techn: "HTTPS" });
    expect(g.edges[1].data?.c4?.relType).toBe("birel");
  });

  it("round-trips", async () => {
    const g1 = await parseDiagram(C4);
    const out = serializeDiagram({
      kind: g1.kind,
      direction: g1.direction,
      nodes: g1.nodes,
      edges: g1.edges,
      c4Flavor: g1.c4Flavor,
      title: g1.title,
    });
    const g2 = await parseDiagram(out);
    const essence = (g: typeof g1) => ({
      flavor: g.c4Flavor,
      title: g.title,
      nodes: g.nodes
        .map((n) => [n.id, n.type, n.data.label ?? null, n.parentId ?? null])
        .sort(),
      edges: g.edges.map((e) => [e.source, e.target, e.data?.label, e.data?.c4]).sort(),
    });
    expect(essence(g2)).toEqual(essence(g1));
  });
});

describe("recovered constructs", () => {
  it("flowchart: double-headed arrows round-trip", async () => {
    const g1 = await parseDiagram("flowchart LR\n  a <--> b\n  c x--x d\n  e o--o f\n");
    expect(g1.edges.map((e) => [e.data?.arrow, e.data?.both])).toEqual([
      ["arrow_point", true],
      ["arrow_cross", true],
      ["arrow_circle", true],
    ]);
    const out = serializeDiagram({
      kind: "flowchart",
      direction: g1.direction,
      nodes: g1.nodes,
      edges: g1.edges,
    });
    expect(out).toContain("<-->");
    expect(out).toContain("x--x");
    expect(out).toContain("o--o");
    const g2 = await parseDiagram(out);
    expect(g2.edges.every((e) => e.data?.both)).toBe(true);
  });

  it("state: choice/fork/join round-trip", async () => {
    const code =
      "stateDiagram-v2\n  state c1 <<choice>>\n  state f1 <<fork>>\n  state j1 <<join>>\n  a --> c1\n  c1 --> b\n";
    const g1 = await parseDiagram(code);
    const types = Object.fromEntries(
      g1.nodes
        .filter((n) => n.type === "state")
        .map((n) => [n.id, (n.data as { stateType: string }).stateType]),
    );
    expect(types.c1).toBe("choice");
    expect(types.f1).toBe("fork");
    expect(types.j1).toBe("join");
    const out = serializeDiagram({
      kind: "state",
      direction: g1.direction,
      nodes: g1.nodes,
      edges: g1.edges,
    });
    expect(out).toContain("state c1 <<choice>>");
    expect(out).toContain("a --> c1");
    const g2 = await parseDiagram(out);
    expect(g2.edges.some((e) => e.target === "c1")).toBe(true);
  });

  it("class: annotations, classifiers, and generics round-trip", async () => {
    const code =
      "classDiagram\n  class Shape {\n    <<interface>>\n    +count$ int\n    +area()* int\n  }\n  class List~T~\n";
    const g1 = await parseDiagram(code);
    const shape = g1.nodes.find((n) => n.id === "Shape");
    expect(shape?.type === "class" && shape.data.annotations).toEqual(["interface"]);
    expect(shape?.type === "class" && shape.data.methods[0]).toContain("*");
    const list = g1.nodes.find((n) => n.id === "List");
    expect(list?.type === "class" && list.data.generic).toBe("T");
    const out = serializeDiagram({
      kind: "class",
      direction: g1.direction,
      nodes: g1.nodes,
      edges: g1.edges,
    });
    expect(out).toContain("<<interface>>");
    expect(out).toContain("List~T~");
    const g2 = await parseDiagram(out);
    const shape2 = g2.nodes.find((n) => n.id === "Shape");
    expect(shape2?.type === "class" && shape2.data.annotations).toEqual(["interface"]);
    expect(shape2?.type === "class" && shape2.data.methods.some((m) => m.includes("*"))).toBe(
      true,
    );
  });

  it("class: namespaces and notes round-trip as groups and note nodes", async () => {
    const code =
      'classDiagram\n  namespace core {\n    class Inner\n  }\n  class Out\n  note for Out "attached"\n  note "free"\n';
    const g1 = await parseDiagram(code);
    expect(g1.nodes.find((n) => n.id === "core")?.type).toBe("group");
    expect(g1.nodes.find((n) => n.id === "Inner")?.parentId).toBe("core");
    const notes = g1.nodes.filter((n) => n.type === "note");
    expect(notes).toHaveLength(2);
    const out = serializeDiagram({
      kind: "class",
      direction: g1.direction,
      nodes: g1.nodes,
      edges: g1.edges,
    });
    expect(out).toContain("namespace core {");
    expect(out).toContain('note for Out "attached"');
    expect(out).toContain('note "free"');
    const g2 = await parseDiagram(out);
    expect(g2.nodes.find((n) => n.id === "Inner")?.parentId).toBe("core");
    expect(g2.nodes.filter((n) => n.type === "note")).toHaveLength(2);
  });

  it("sequence: notes, blocks, and activations survive re-serialization", async () => {
    const code = `sequenceDiagram
  autonumber
  participant A
  participant B
  A->>B: req
  activate B
  Note over A,B: nota
  loop Every minute
    B-->>A: tick
  end
  alt ok
    A->>B: yes
  else ko
    A->>B: no
  end
  deactivate B
`;
    const g1 = await parseDiagram(code);
    expect(g1.items?.filter((i) => i.kind === "block")).toHaveLength(2);
    const out = serializeDiagram({
      kind: "sequence",
      direction: g1.direction,
      nodes: g1.nodes,
      edges: g1.edges,
      items: g1.items,
    });
    expect(out).toContain("autonumber");
    expect(out).toContain("Note over A,B: nota");
    expect(out).toContain("loop Every minute");
    expect(out).toContain("else ko");
    expect(out).toContain("activate B");
    expect(out).toContain("deactivate B");
    const g2 = await parseDiagram(out);
    expect(g2.items?.filter((i) => i.kind === "block")).toHaveLength(2);
    expect(g2.items?.filter((i) => i.kind === "note")).toHaveLength(1);
    expect(g2.edges).toHaveLength(g1.edges.length);
  });

  it("sequence: deleting a message keeps blocks and notes intact", async () => {
    const code =
      "sequenceDiagram\n  participant A\n  participant B\n  loop L\n    A->>B: uno\n    A->>B: due\n  end\n";
    const g1 = await parseDiagram(code);
    const removedId = g1.edges[0].id;
    const edges = g1.edges.filter((e) => e.id !== removedId);
    const items = g1.items!.filter((i) => i.kind !== "message" || i.edgeId !== removedId);
    const out = serializeDiagram({
      kind: "sequence",
      direction: g1.direction,
      nodes: g1.nodes,
      edges,
      items,
    });
    expect(out).toContain("loop L");
    expect(out).toContain("due");
    expect(out).not.toContain("uno");
    await expect(parseDiagram(out)).resolves.toBeTruthy();
  });

  it("c4: external db/queue variants and deployment nodes round-trip", async () => {
    const code =
      'C4Deployment\n  Node(n1, "Server") {\n    Container(c1, "App")\n  }\n  SystemQueue_Ext(q, "Queue")\n';
    const g1 = await parseDiagram(code);
    const q = g1.nodes.find((n) => n.id === "q");
    expect(q?.type === "c4" && q.data.c4Shape).toBe("external_system_queue");
    const n1 = g1.nodes.find((n) => n.id === "n1");
    expect(n1?.type).toBe("group");
    const out = serializeDiagram({
      kind: "c4",
      direction: g1.direction,
      nodes: g1.nodes,
      edges: g1.edges,
      c4Flavor: g1.c4Flavor,
      title: g1.title,
    });
    expect(out).toContain("SystemQueue_Ext(q");
    expect(out).toContain('Node(n1, "Server")');
    const g2 = await parseDiagram(out);
    expect(g2.nodes.find((n) => n.id === "c1")?.parentId).toBe("n1");
  });
});

describe("accessibility metadata", () => {
  it("round-trips accTitle and accDescr on every kind", async () => {
    for (const header of [
      "flowchart TD\n  a --> b",
      "stateDiagram-v2\n  a --> b",
      "architecture-beta\n  service a(cloud)[A]",
    ]) {
      const g1 = await parseDiagram(
        `${header.split("\n")[0]}\n  accTitle: My title\n  accDescr: My description\n${header.split("\n").slice(1).join("\n")}\n`,
      );
      expect(g1.accTitle).toBe("My title");
      expect(g1.accDescr).toBe("My description");
      const out = serializeDiagram({
        kind: g1.kind,
        direction: g1.direction,
        nodes: g1.nodes,
        edges: g1.edges,
        accTitle: g1.accTitle,
        accDescr: g1.accDescr,
      });
      const g2 = await parseDiagram(out);
      expect(g2.accTitle).toBe("My title");
      expect(g2.accDescr).toBe("My description");
    }
  });
});

describe("unsupported kinds", () => {
  it("reports unknown diagram types as their own error type", async () => {
    // A distinct type rather than a message match: the app has to tell
    // "cannot edit this" apart from "does not parse", and renders the former
    // read-only instead of refusing the file.
    await expect(parseDiagram('pie\n  "a": 1\n')).rejects.toThrow(UnsupportedDiagramError);
  });

  it("carries the diagram type so the UI can name it", async () => {
    await expect(parseDiagram("gantt\n  title X\n")).rejects.toMatchObject({
      diagramType: "gantt",
    });
  });
});
