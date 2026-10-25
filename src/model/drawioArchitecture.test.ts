import { describe, expect, it } from "vitest";
import { drawioToMermaid } from "./fromDrawio";
import { archLabel, iconFor } from "./drawioArchitecture";
import { readPositions } from "./positions";
import realFile from "../../tests/fixtures/vpc-swimlanes.drawio?raw";
import { parseDiagram } from "./diagram";

/** A cell drawn with an AWS stencil, as draw.io writes one. */
const aws = (id: string, label: string, stencil: string, geo: string, parent = "1") =>
  `<mxCell id="${id}" value="${label}" style="sketch=0;points=[[0,0,0]];outlineConnect=0;shape=mxgraph.aws4.${stencil};" vertex="1" parent="${parent}">
     <mxGeometry ${geo} as="geometry" />
   </mxCell>`;

const container = (id: string, label: string, geo: string, parent = "1") =>
  `<mxCell id="${id}" value="${label}" style="sketch=0;points=[[0,0,0]];shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_vpc;container=1;" vertex="1" parent="${parent}">
     <mxGeometry ${geo} as="geometry" />
   </mxCell>`;

const link = (id: string, source: string, target: string, label = "") =>
  `<mxCell id="${id}" value="${label}" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="${source}" target="${target}">
     <mxGeometry relative="1" as="geometry" />
   </mxCell>`;

const file = (cells: string) => `<mxfile>
  <diagram name="Cloud" id="p1">
    <mxGraphModel><root>
      <mxCell id="0" /><mxCell id="1" parent="0" />
      ${cells}
    </root></mxGraphModel>
  </diagram>
</mxfile>`;

describe("recognising a cloud drawing", () => {
  it("reads AWS stencils as an architecture diagram, not a flowchart", () => {
    // The whole point: a flowchart has nowhere to put the icons, which are
    // the part of a cloud drawing that makes it legible.
    const { code } = drawioToMermaid(
      file(aws("2", "API", "api_gateway", 'x="0" y="0" width="78" height="78"')),
    );
    expect(code).toContain("architecture-beta");
    expect(code).not.toContain("flowchart");
  });

  it("leaves an ordinary drawing as a flowchart", () => {
    const plain = file(
      `<mxCell id="2" value="A" style="rounded=0;" vertex="1" parent="1">
         <mxGeometry x="0" y="0" width="120" height="60" as="geometry" />
       </mxCell>`,
    );
    expect(drawioToMermaid(plain).code).toContain("flowchart");
  });

  it("can be overruled either way", () => {
    const cloud = file(aws("2", "API", "api_gateway", 'x="0" y="0" width="78" height="78"'));
    expect(drawioToMermaid(cloud, "flowchart").code).toContain("flowchart");

    const plain = file(
      `<mxCell id="2" value="Thing" style="rounded=0;" vertex="1" parent="1">
         <mxGeometry x="0" y="0" width="120" height="60" as="geometry" />
       </mxCell>`,
    );
    expect(drawioToMermaid(plain, "architecture").code).toContain("architecture-beta");
  });
});

describe("choosing an icon", () => {
  it.each([
    ["shape=mxgraph.aws4.rds;", "", "database"],
    ["shape=mxgraph.aws4.s3;", "", "disk"],
    ["shape=mxgraph.aws4.lambda;", "", "logos:aws-lambda"],
    ["shape=mxgraph.aws4.sqs;", "", "logos:aws-sqs"],
    ["shape=mxgraph.aws4.elastic_load_balancing;", "", "logos:aws-elb"],
    ["", "PostgreSQL primary", "database"],
    ["", "Mobile App", "internet"],
    ["", "Order service", "server"],
    ["", "Something odd", "server"],
    // draw.io's real AWS shapes put the service in `resIcon`, not `shape`.
    ["shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.s3;", "Catalogo", "disk"],
    ["shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_vpc;", "Rete", "cloud"],
  ])("maps %s / %s", (style, label, expected) => {
    expect(iconFor(style, label)).toBe(expected);
  });
});

describe("labels the grammar will take", () => {
  it.each([
    ["Amazon VPC (10.0.0.0/16)", "Amazon VPC"],
    ["Utente / Client", "Utente Client"],
    ["Route53 / Cloudflare<br/>DNS", "Route53 Cloudflare DNS"],
    ["Redis Cache & Token", "Redis Cache Token"],
    ["(10.0.0.0/16)", "10 0 0 0 16"],
    ["…", "node"],
  ])("cleans %s", (raw, expected) => {
    // The grammar takes letters, digits, spaces and underscores and nothing
    // else, so a slash or a bracket takes the whole diagram down.
    expect(archLabel(raw)).toBe(expected);
  });
});

describe("the converted diagram", () => {
  const CLOUD = file(
    container("10", "Amazon VPC", 'x="40" y="40" width="600" height="400"') +
      aws(
        "11",
        "Load Balancer",
        "elastic_load_balancing",
        'x="40" y="60" width="78" height="78"',
        "10",
      ) +
      aws("12", "Orders API", "ec2", 'x="240" y="60" width="78" height="78"', "10") +
      aws("13", "PostgreSQL", "rds", 'x="240" y="260" width="78" height="78"', "10") +
      link("20", "11", "12", "http") +
      link("21", "12", "13"),
  );

  it("keeps an id from beginning with a word the grammar takes over", async () => {
    // `service title_text(server)` does not parse: `title` starts the
    // diagram's title wherever it begins a token, so the id never arrives.
    const { code } = drawioToMermaid(
      file(
        aws("11", "Title text", "ec2", 'x="40" y="60" width="78" height="78"') +
          aws("12", "Orders API", "ec2", 'x="240" y="60" width="78" height="78"') +
          link("20", "11", "12"),
      ),
    );
    expect(code).toContain("service n_title_text(server)[Title text]");
    await expect(parseDiagram(code)).resolves.toBeTruthy();
  });

  it("makes the container a group and the shapes services", () => {
    // Lower-case ids: `architecture-beta` rejects a capital outright, which
    // the labels beside them do not.
    const { code, nodes, edges } = drawioToMermaid(CLOUD);
    expect([nodes, edges]).toEqual([4, 2]);
    expect(code).toContain("group amazon_vpc(cloud)[Amazon VPC]");
    expect(code).toContain("service postgresql(database)[PostgreSQL]");
    expect(code).toContain("service orders_api(server)[Orders API] in amazon_vpc");
  });

  it("anchors each connection on the side the other end lies", () => {
    // `architecture-beta` has no coordinates, so the relative positions
    // survive as the anchors or not at all.
    const { code } = drawioToMermaid(CLOUD);
    // The API is to the right of the load balancer…
    expect(code).toContain("load_balancer:R -[http]-> L:orders_api");
    // …and the database is below the API.
    expect(code).toContain("orders_api:B --> T:postgresql");
  });

  it("moves a connection off a container onto something inside it", async () => {
    // Mermaid documents a `{group}` endpoint and then throws on one, so a
    // line drawn to the edge of a box has to land on a service in it or the
    // whole document fails to open.
    const withGroupEdge = file(
      container("10", "Zone", 'x="0" y="0" width="400" height="300"') +
        aws("11", "Api", "ec2", 'x="20" y="40" width="78" height="78"', "10") +
        aws("12", "Client", "user", 'x="600" y="40" width="78" height="78"') +
        link("20", "12", "10"),
    );
    const { code, edges } = drawioToMermaid(withGroupEdge, "architecture");
    expect(edges).toBe(1);
    expect(code).not.toContain("{group}");
    expect(code).toContain("client:L --> R:api");
    await expect(parseDiagram(code)).resolves.toBeTruthy();
  });

  it("parses back as an architecture diagram", async () => {
    const graph = await parseDiagram(drawioToMermaid(CLOUD).code);
    expect(graph.kind).toBe("architecture");
    expect(graph.nodes.filter((n) => n.type === "service")).toHaveLength(3);
    expect(graph.nodes.find((n) => n.id === "orders_api")?.parentId).toBe("amazon_vpc");
    expect(graph.edges).toHaveLength(2);
  });
});

describe("a real drawing, read as architecture", () => {
  // The file a user brought: nested swimlanes, twenty connections, and no
  // vendor stencils — so this is the *forced* architecture path.
  it("keeps the arrangement it was drawn in", () => {
    const { code, nodes } = drawioToMermaid(realFile, "architecture");
    const positions = readPositions(code);

    // `architecture-beta` has no coordinates of its own, so without the
    // layout comment every one of these went to a layout engine and came
    // back as a tall column. Each element carries its place.
    expect(Object.keys(positions ?? {})).toHaveLength(nodes);
    // The whole space is stretched by one factor — a service is drawn taller
    // than the flat box it had in draw.io — so the arrangement is intact
    // while nothing is packed into a slot too small for it.
    const vpc = positions!.amazon_vpc;
    // Two decimals, not three: both sides are whole pixels, so the ratio of
    // the stretched box can only match the original up to that rounding, and
    // how far off it lands depends on the factor rather than on anything the
    // reader would call a change in behaviour.
    expect(vpc.w! / vpc.h!).toBeCloseTo(960 / 680, 2);
    expect(vpc.w!).toBeGreaterThan(960);
    expect(Object.keys(positions?.aws_waf_firewall_applica ?? {})).toEqual(["x", "y"]);
  });

  it("stretches the space so a node is not packed into a slot too small", () => {
    // A service draws taller than the flat box it had in draw.io, so keeping
    // the coordinates as they were made neighbours collide. Whether they
    // actually overlap is measured on the rendered canvas by the e2e suite;
    // what belongs here is that the stretch happened and is uniform.
    const { code } = drawioToMermaid(realFile, "architecture");
    const positions = readPositions(code)!;
    const vpc = positions.amazon_vpc;
    const monitoring = positions.monitoraggio_sicurezza;

    // The factor itself is not the claim, and pinning it made this fail the
    // day nodes started being measured instead of assumed a flat 110×96. What
    // is the claim: the space grew, and every coordinate grew by the one
    // factor — so whatever a service turns out to need, the arrangement it was
    // drawn in survives.
    const factor = vpc.w! / 960;
    expect(factor).toBeGreaterThan(1);
    expect(monitoring.x! / 1030).toBeCloseTo(factor, 2);
  });

  it("nests the subnets inside the VPC", () => {
    const { code } = drawioToMermaid(realFile, "architecture");
    expect(code).toContain("group subnet_pubblica(cloud)[Subnet Pubblica] in amazon_vpc");
    expect(code).toContain("group subnet_dati(cloud)[Subnet Dati] in amazon_vpc");
  });

  it("does not leave a separator dangling on a cut identifier", () => {
    const { code } = drawioToMermaid(realFile, "architecture");
    expect(code).not.toMatch(/^\s*service \w+_\(/m);
  });

  it("parses back, with every element and connection", async () => {
    const { code, nodes, edges } = drawioToMermaid(realFile, "architecture");
    expect([nodes, edges]).toEqual([24, 20]);
    const graph = await parseDiagram(code);
    expect(graph.kind).toBe("architecture");
    expect(graph.nodes).toHaveLength(24);
    expect(graph.edges).toHaveLength(20);
  });
});
