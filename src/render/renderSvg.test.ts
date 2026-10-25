import { describe, expect, it } from "vitest";
import { render } from "./fromCode";
import { renderSvg, UnsupportedFamilyError } from "./renderSvg";
import type { AnyNode, FlowEdge } from "../model/types";

/**
 * The emitter, checked for the three things a string renderer has to get right:
 * that it is well-formed XML, that the diagram is actually in it, and that a
 * label cannot climb out of it.
 *
 * The last one is not a nicety. Labels arrive from `?code=` links, from the
 * embed bridge and from opened files, and the output is a string that whatever
 * embeds it will put on a page without parsing it again. Nothing downstream is
 * going to catch what `esc` misses.
 */

function shape(id: string, label: string, x: number, y: number, extra = {}): AnyNode {
  return {
    id,
    type: "shape",
    position: { x, y },
    data: { label, shape: "square", direction: "TB", ...extra },
  } as unknown as AnyNode;
}

function edge(source: string, target: string, label = ""): FlowEdge {
  return { id: `${source}-${target}`, source, target, data: { label } };
}

/** Parsed, so "is it well-formed" is answered by a parser and not by a regex. */
function parse(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const error = doc.querySelector("parsererror");
  if (error) throw new Error(`not well-formed: ${error.textContent}`);
  return doc;
}

const twoNodes = () => [shape("a", "Start", 0, 0), shape("b", "Finish", 0, 200)];

describe("the document it produces", () => {
  it("breaks a connection's label where it says <br>", () => {
    const doc = parse(renderSvg(twoNodes(), [edge("a", "b", "6443<br/>HTTPS")], "flowchart"));
    const text = doc.querySelector("text.el")!;
    expect([...text.querySelectorAll("tspan")].map((t) => t.textContent)).toEqual([
      "6443",
      "HTTPS",
    ]);
    expect(text.textContent).not.toContain("<br");
  });

  it("is well-formed SVG", () => {
    const doc = parse(renderSvg(twoNodes(), [edge("a", "b")], "flowchart"));
    expect(doc.documentElement.tagName).toBe("svg");
  });

  it("sizes the canvas around what is drawn, with padding on each side", () => {
    const doc = parse(renderSvg(twoNodes(), [], "flowchart", { padding: 24 }));
    const svg = doc.documentElement;
    // Two 160×54 nodes 200 apart: 160 + 48 across, 254 + 48 down.
    expect(svg.getAttribute("width")).toBe("208");
    expect(svg.getAttribute("height")).toBe("302");
  });

  it("draws a group behind the nodes it contains", () => {
    const group = {
      id: "g",
      type: "group",
      position: { x: 0, y: 0 },
      style: { width: 400, height: 300 },
      data: { label: "VPC", subgraphId: "vpc" },
    } as unknown as AnyNode;
    const child = shape("a", "Inside", 20, 40);
    (child as unknown as { parentId: string }).parentId = "g";

    const svg = renderSvg([child, group], [], "flowchart");
    // Whatever order they arrived in, the frame is emitted first.
    expect(svg.indexOf('class="gf"')).toBeLessThan(svg.indexOf('class="sf"'));
  });

  it("paints a group with its own colours, as the canvas does", () => {
    const group = {
      id: "g",
      type: "group",
      position: { x: 0, y: 0 },
      style: { width: 400, height: 300 },
      data: { label: "VNet", subgraphId: "g", styles: ["fill:#dae8fc", "stroke:#6c8ebf"] },
    } as unknown as AnyNode;
    const frame = parse(renderSvg([group], [], "flowchart")).querySelector("rect.gf")!;
    expect(frame.getAttribute("style")).toBe(
      "fill:#dae8fc;stroke:#6c8ebf;stroke-dasharray:none",
    );
  });

  it("refuses a family it cannot draw, rather than drawing half of one", () => {
    // Every family Archyne edits is drawn now, so this needs a name that is
    // not one of them. The guard stays: it is what a diagram kind added
    // upstream, and parsed before anybody draws it, would meet.
    expect(() => renderSvg([], [], "gantt" as never)).toThrow(UnsupportedFamilyError);
    expect(() => renderSvg([], [], "gantt" as never)).toThrow(/not implemented/);
  });

  it("has something to say about an empty diagram", () => {
    const doc = parse(renderSvg([], [], "flowchart"));
    expect(doc.documentElement.tagName).toBe("svg");
  });
});

describe("what is in it", () => {
  it("draws every node", () => {
    const doc = parse(renderSvg(twoNodes(), [], "flowchart"));
    expect(doc.querySelectorAll("rect.sf")).toHaveLength(2);
  });

  it("draws every edge, with an arrowhead", () => {
    const doc = parse(renderSvg(twoNodes(), [edge("a", "b")], "flowchart"));
    const paths = doc.querySelectorAll("path.e");
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute("marker-end")).toBe("url(#arch-arrow)");
    expect(doc.querySelector("marker#arch-arrow")).not.toBeNull();
  });

  // Through the parser, not by hand: the model hands a two-way connection over
  // with React Flow's arrowhead object at both ends, not a marker name, and
  // that is the shape that lost its start head.
  it("keeps both heads on a two-way flowchart connection", async () => {
    const { svg } = await render("flowchart LR\n  a --> b\n  c <--> d");
    const heads = [...parse(svg).querySelectorAll("path.e")].map((p) => [
      p.getAttribute("marker-start"),
      p.getAttribute("marker-end"),
    ]);
    expect(heads).toEqual(
      expect.arrayContaining([
        [null, "url(#arch-arrow)"],
        ["url(#arch-arrow)", "url(#arch-arrow)"],
      ]),
    );
  });

  it("draws no head on a connection written without one", async () => {
    const { svg } = await render("flowchart LR\n  a --- b\n  c --> d");
    const heads = [...parse(svg).querySelectorAll("path.e")].map((p) => [
      p.getAttribute("marker-start"),
      p.getAttribute("marker-end"),
    ]);
    expect(heads).toEqual(
      expect.arrayContaining([
        [null, null],
        [null, "url(#arch-arrow)"],
      ]),
    );
  });

  it("draws no head on an architecture edge drawn without an arrow", async () => {
    const { svg } = await render(
      "architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n  service c(server)[C]\n  a:R -- L:b\n  b:R --> L:c",
    );
    const heads = [...parse(svg).querySelectorAll("path.e")].map((p) => [
      p.getAttribute("marker-start"),
      p.getAttribute("marker-end"),
    ]);
    expect(heads).toHaveLength(2);
    expect(heads).toContainEqual([null, null]);
    expect(heads.filter(([, end]) => end !== null)).toHaveLength(1);
  });

  it("keeps both heads on a C4 relationship that runs both ways", async () => {
    const { svg } = await render(
      'C4Context\n  Person(a, "A")\n  System(b, "B")\n  BiRel(a, b, "talks")',
    );
    const path = parse(svg).querySelector("path.e");
    expect(path?.getAttribute("marker-start")).toBe("url(#arch-arrow)");
    expect(path?.getAttribute("marker-end")).toBe("url(#arch-arrow)");
  });

  it("carries its labels", () => {
    const svg = renderSvg(twoNodes(), [edge("a", "b", "then")], "flowchart");
    expect(svg).toContain("Start");
    expect(svg).toContain("Finish");
    expect(svg).toContain("then");
  });

  it("honours a node's own colours, as an inline style", () => {
    // Inline, not `fill="…"`, and the distinction is the whole bug: the
    // document carries a `<style>` with `.sf { fill: … }`, and in SVG a CSS
    // rule beats a presentation attribute. The colours were in the file and
    // painted nothing.
    const styled = shape("a", "Painted", 0, 0, { styles: ["fill:#f9f", "stroke:#333"] });
    const doc = parse(renderSvg([styled], [], "flowchart"));
    const body = doc.querySelector("rect.sf");
    expect(body?.getAttribute("style")).toBe("fill:#f9f;stroke:#333");
    expect(body?.getAttribute("fill")).toBeNull();
  });

  it("colours a node through a classDef it belongs to", () => {
    // `classDef hot …` + `class a hot` is how a flowchart colours a *set*, and
    // it used to be dropped entirely: the emitter read only `data.styles`.
    const member = shape("a", "Hot", 0, 0, { classes: ["hot"] });
    const doc = parse(
      renderSvg([member], [], "flowchart", {
        classDefs: { hot: ["fill:#c04", "color:#fff"] },
      }),
    );
    expect(doc.querySelector("rect.sf")?.getAttribute("style")).toContain("fill:#c04");
    expect(doc.querySelector("text.t tspan")?.getAttribute("style")).toContain("fill:#fff");
  });

  it("lets an inline style win over the class it also carries", () => {
    const both = shape("a", "Both", 0, 0, { classes: ["hot"], styles: ["fill:#0f0"] });
    const doc = parse(
      renderSvg([both], [], "flowchart", { classDefs: { hot: ["fill:#c04"] } }),
    );
    expect(doc.querySelector("rect.sf")?.getAttribute("style")).toBe("fill:#0f0");
  });

  it("colours the families that are not flowchart shapes", () => {
    // States, ER entities and classes ignored their `style` statements
    // altogether — only flowchart shapes were painted.
    const state = {
      id: "s",
      type: "state",
      position: { x: 0, y: 0 },
      data: {
        label: "Busy",
        stateType: "normal",
        direction: "TB",
        styles: ["fill:#ff8800"],
      },
    } as unknown as AnyNode;
    const doc = parse(renderSvg([state], [], "state"));
    expect(doc.querySelector("rect.sf")?.getAttribute("style")).toContain("fill:#ff8800");
  });

  it("paints the ground, unless asked not to", () => {
    expect(renderSvg(twoNodes(), [], "flowchart")).toContain('fill="#0f1014"');
    const bare = renderSvg(twoNodes(), [], "flowchart", { background: false });
    expect(bare).not.toContain('width="100%"');
  });

  it("takes the light palette when asked for it", () => {
    const light = renderSvg(twoNodes(), [], "flowchart", { theme: "light" });
    expect(light).toContain("#ffffff");
    expect(light).not.toContain("#1c1f2b");
  });

  it("keeps its own style rules inside the document", () => {
    // The point of the exercise: nothing here may depend on a stylesheet that
    // lives in the page the SVG lands in.
    const doc = parse(renderSvg(twoNodes(), [], "flowchart"));
    const style = doc.querySelector("style");
    expect(style?.textContent).toContain(".sf{fill:");
  });
});

describe("the other families", () => {
  const node = (type: string, data: Record<string, unknown>, y = 0): AnyNode =>
    ({ id: `${type}-${y}`, type, position: { x: 0, y }, data }) as unknown as AnyNode;

  it("draws a state, and the markers that carry no text", () => {
    const doc = parse(
      renderSvg(
        [
          node("state", { label: "Idle", stateType: "normal", direction: "TB" }, 0),
          node("state", { label: "", stateType: "start", direction: "TB" }, 120),
          node("state", { label: "", stateType: "choice", direction: "TB" }, 240),
          node("state", { label: "", stateType: "fork", direction: "TB" }, 360),
        ],
        [],
        "state",
      ),
    );
    expect(doc.querySelectorAll("rect.sf")).toHaveLength(1); // the named one
    expect(doc.querySelectorAll("polygon.sf")).toHaveLength(1); // the choice
    expect(doc.querySelectorAll("circle.bar")).toHaveLength(1); // the start
    expect(doc.querySelectorAll("rect.bar")).toHaveLength(1); // the fork
  });

  it("draws an ER entity with its attributes in it", () => {
    const svg = renderSvg(
      [
        node("entity", {
          label: "CUSTOMER",
          direction: "TB",
          attributes: [{ type: "int", name: "id", keys: ["PK"], comment: "" }],
        }),
      ],
      [],
      "er",
    );
    parse(svg);
    expect(svg).toContain("CUSTOMER");
    expect(svg).toContain("id");
    expect(svg).toContain("PK");
  });

  it("draws a class with its members and methods", () => {
    const svg = renderSvg(
      [
        node("class", {
          label: "Account",
          direction: "TB",
          members: ["+id: int"],
          methods: ["+close(): void"],
          annotations: ["interface"],
        }),
      ],
      [],
      "class",
    );
    parse(svg);
    expect(svg).toContain("Account");
    expect(svg).toContain("+close(): void");
    expect(svg).toContain("«interface»");
  });

  it("draws a C4 element with its tag and description", () => {
    const svg = renderSvg(
      [
        node("c4", {
          label: "Payments",
          c4Shape: "system",
          descr: "Handles settlement",
          direction: "TB",
        }),
      ],
      [],
      "c4",
    );
    parse(svg);
    expect(svg).toContain("Payments");
    expect(svg).toContain("System"); // from C4_TAGS, not the raw shape name
    expect(svg).toContain("Handles settlement");
  });

  it("draws an architecture service with the icon it was handed", () => {
    const service = node("service", {
      label: "Postgres",
      icon: "database",
      direction: "TB",
    });
    const doc = parse(
      renderSvg([service], [], "architecture", {
        icons: { database: '<svg viewBox="0 0 24 24" width="1em"><path d="M1 1h4"/></svg>' },
      }),
    );
    const icon = doc.querySelector("svg svg");
    expect(icon).not.toBeNull();
    // The pack's own `1em` is dropped for a size that fits the node.
    expect(icon?.getAttribute("width")).not.toBe("1em");
    expect(Number(icon?.getAttribute("width"))).toBeGreaterThan(0);
    expect(doc.querySelector("path")).not.toBeNull();
  });

  it("still draws a service whose icon nobody resolved", () => {
    // A diagram missing one logo is a diagram. A diagram missing every node is
    // not, which is what returning nothing here would produce.
    const service = node("service", { label: "Cache", icon: "redis", direction: "TB" });
    const svg = renderSvg([service], [], "architecture");
    parse(svg);
    expect(svg).toContain("Cache");
  });

  it("draws a sequence diagram from its statement stream", () => {
    // The rows *are* the layout: without `seqItems` there are participants and
    // nothing else, which is why they travel with the graph.
    const participant = (id: string, x: number, ptype = "participant") =>
      ({
        id,
        type: "participant",
        position: { x, y: 0 },
        data: { label: id, ptype, direction: "TB" },
      }) as unknown as AnyNode;
    const nodes = [participant("U", 0, "actor"), participant("S", 220)];
    const edges: FlowEdge[] = [
      { id: "m1", source: "U", target: "S", data: { label: "chiedi" } },
      { id: "m2", source: "S", target: "U", data: { label: "rispondi" } },
    ];
    const doc = parse(
      renderSvg(nodes, edges, "sequence", {
        seqItems: [
          { kind: "message", edgeId: "m1" },
          { kind: "block", op: "alt", label: "ok" },
          { kind: "message", edgeId: "m2" },
          { kind: "end" },
          { kind: "note", placement: "right", a: "S", text: "una nota" },
        ],
      }),
    );

    expect(doc.querySelectorAll("line.lifeline")).toHaveLength(2);
    expect(doc.querySelectorAll("path.e")).toHaveLength(2);
    expect(doc.querySelectorAll("rect.seq-block")).toHaveLength(1);
    expect(doc.querySelectorAll("rect.seq-note")).toHaveLength(1);
    // The actor's stick figure, from the path the canvas draws.
    expect(doc.querySelector("path.glyph")).not.toBeNull();
  });

  it("puts each message on the row its statement occupies", () => {
    const participant = (id: string, x: number) =>
      ({
        id,
        type: "participant",
        position: { x, y: 0 },
        data: { label: id, ptype: "participant", direction: "TB" },
      }) as unknown as AnyNode;
    const nodes = [participant("A", 0), participant("B", 220)];
    const edges: FlowEdge[] = [
      { id: "m1", source: "A", target: "B", data: { label: "" } },
      { id: "m2", source: "B", target: "A", data: { label: "" } },
    ];
    // The second message is two rows below the first, because a note sits
    // between them in the stream.
    const doc = parse(
      renderSvg(nodes, edges, "sequence", {
        seqItems: [
          { kind: "message", edgeId: "m1" },
          { kind: "note", placement: "left", a: "A", text: "x" },
          { kind: "message", edgeId: "m2" },
        ],
      }),
    );
    const ys = [...doc.querySelectorAll("path.e")].map((p) =>
      Number(/M [\d.]+,([\d.]+)/.exec(p.getAttribute("d") ?? "")?.[1]),
    );
    expect(ys[1] - ys[0]).toBe(88); // two rows at SEQ_SPACING
  });

  it("brings every marker a family's edges might end in", () => {
    // A class diagram ends in diamonds and an ER diagram in crow's feet. Both
    // come from the same table the canvas draws from.
    const doc = parse(renderSvg([shape("a", "x", 0, 0)], [], "flowchart"));
    for (const id of ["cls-extension", "cls-composition", "er-one-more", "arch-arrow"]) {
      expect(doc.querySelector(`marker#${id}`), id).not.toBeNull();
    }
  });
});

describe("a label cannot climb out", () => {
  it("escapes markup in a node label", () => {
    const svg = renderSvg([shape("a", "<script>alert(1)</script>", 0, 0)], [], "flowchart");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    parse(svg);
  });

  it("escapes markup in an edge label", () => {
    const svg = renderSvg(twoNodes(), [edge("a", "b", '"><script>x</script>')], "flowchart");
    expect(svg).not.toContain("<script>");
    parse(svg);
  });

  it("escapes a quote that would otherwise end an attribute", () => {
    const svg = renderSvg([shape("a", 'a" onload="alert(1)', 0, 0)], [], "flowchart");
    expect(svg).not.toContain('onload="alert(1)"');
    parse(svg);
  });

  it("escapes a colour that is really markup", () => {
    // Custom styles reach an attribute value, and they come from the file too.
    const svg = renderSvg(
      [shape("a", "x", 0, 0, { styles: ['fill:"><script>x</script>'] })],
      [],
      "flowchart",
    );
    expect(svg).not.toContain("<script>");
    parse(svg);
  });

  it("turns a line break into a second line, not an opening tag", () => {
    // `<br>` is Mermaid's own spelling inside a label. As SVG text there is no
    // break element to emit — the line becomes a second `<tspan>` on its own
    // baseline, which is also what makes the break survive an `<img>`.
    const svg = renderSvg([shape("a", "one<br>two", 0, 0)], [], "flowchart");
    const doc = parse(svg);
    const spans = [...doc.querySelectorAll("text.t tspan")].map((t) => t.textContent);
    expect(spans).toEqual(["one", "two"]);
    expect(svg).not.toContain("<br");
  });
});

describe("pictures", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const picture = (extra = {}) =>
    shape("p", "Key Vault", 0, 0, {
      img: PNG,
      imgWidth: 40,
      imgHeight: 40,
      styles: ["fill:none", "stroke:none"],
      ...extra,
    });

  it("draws a node's picture, which it used to leave out", () => {
    const doc = parse(renderSvg([picture()], [], "flowchart"));
    const image = doc.querySelector("image")!;
    expect(image.getAttribute("href")).toBe(PNG);
    expect(image.getAttribute("width")).toBe("40");
    expect(image.getAttribute("height")).toBe("40");
  });

  it("puts the name under the picture, or over it", () => {
    const below = parse(renderSvg([picture()], [], "flowchart"));
    const imageY = Number(below.querySelector("image")!.getAttribute("y"));
    const textY = Number(below.querySelector("tspan")!.getAttribute("y"));
    expect(textY).toBeGreaterThan(imageY + 40);

    const above = parse(renderSvg([picture({ imgPos: "t" })], [], "flowchart"));
    const imageTop = Number(above.querySelector("image")!.getAttribute("y"));
    const textTop = Number(above.querySelector("tspan")!.getAttribute("y"));
    expect(textTop).toBeLessThan(imageTop);
  });

  it("escapes a picture's address", () => {
    const svg = renderSvg([picture({ img: 'x" onload="alert(1)' })], [], "flowchart");
    expect(svg).not.toContain('onload="alert(1)"');
    parse(svg);
  });
});

describe("words with no box", () => {
  it("keep the slim padding the canvas gives them, and do not break early", () => {
    // An imported caption, in a box drawn just wide enough for its longest
    // line. With a box's full padding it broke onto a third line.
    const caption = shape("c", "Azure Firewall<br>(Outbound)", 0, 0, {
      styles: ["fill:transparent", "stroke:none"],
    });
    const boxed = { ...caption, style: { width: 100, height: 40 } } as AnyNode;
    const doc = parse(renderSvg([boxed], [], "flowchart"));
    expect(doc.querySelectorAll("tspan").length).toBe(2);
  });
});
