import { describe, expect, it } from "vitest";
import { deflateSync } from "fflate";
import { drawioToMermaid } from "./fromDrawio";
import { isDrawio } from "../importFile";
import { parseDiagram } from "./diagram";
import { useGraphStore } from "../store";
import { readPositions } from "./positions";
import { readWaypoints } from "./waypoints";

/** Wrap loose `<mxCell>` markup in the file structure draw.io writes. */
function file(cells: string, attrs = ""): string {
  return `<mxfile host="app.diagrams.net">
  <diagram name="Page-1" id="p1"${attrs}>
    <mxGraphModel dx="800" dy="600" grid="1">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        ${cells}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}

const box = (
  id: string,
  label: string,
  style = "",
  geo = 'x="40" y="40" width="120" height="60"',
) =>
  `<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="1">
     <mxGeometry ${geo} as="geometry" />
   </mxCell>`;

const link = (id: string, source: string, target: string, style = "", label = "") =>
  `<mxCell id="${id}" value="${label}" style="${style}" edge="1" parent="1" source="${source}" target="${target}">
     <mxGeometry relative="1" as="geometry" />
   </mxCell>`;

/** The shape of one node in the generated source, e.g. `Check{"Valid?"}`. */
function lineFor(code: string, id: string): string {
  const line = code.split("\n").find((l) => l.trim().startsWith(id));
  if (!line) throw new Error(`no line for ${id} in\n${code}`);
  return line.trim();
}

describe("recognising a draw.io file", () => {
  it("knows one when it sees it, compressed or not", () => {
    expect(isDrawio(file(box("2", "A")))).toBe(true);
    expect(isDrawio('<mxGraphModel dx="1"><root /></mxGraphModel>')).toBe(true);
  });

  it("does not mistake Mermaid for one", () => {
    expect(isDrawio("flowchart TD\n  a --> b\n")).toBe(false);
    expect(isDrawio("")).toBe(false);
  });
});

describe("shapes and labels", () => {
  it("names nodes after what they say", () => {
    const { code } = drawioToMermaid(file(box("2", "Start") + box("3", "Ship it")));
    expect(lineFor(code, "Start")).toBe('Start["Start"]');
    expect(lineFor(code, "Ship_it")).toBe('Ship_it["Ship it"]');
  });

  it("keeps two nodes with the same label apart", () => {
    const { code } = drawioToMermaid(file(box("2", "Step") + box("3", "Step")));
    expect(lineFor(code, "Step[")).toBe('Step["Step"]');
    expect(lineFor(code, "Step_2")).toBe('Step_2["Step"]');
  });

  it("renames a label that Mermaid claims for itself", () => {
    // `end` as an id closes the enclosing block instead of naming a node.
    const { code } = drawioToMermaid(file(box("2", "end")));
    expect(lineFor(code, "end_")).toBe('end_["end"]');
  });

  it("falls back to a generated id for a node with no label", () => {
    const { code } = drawioToMermaid(file(box("2", "")));
    expect(code).toMatch(/n1\[" "\]/);
  });

  it("writes a node with no label so that Mermaid can read it", async () => {
    // `n1[""]` is a parse error, and a box with no text — an icon, a dot, a
    // separator — is in nearly every busy draw.io file: one was enough to
    // stop the whole import opening.
    const { code } = drawioToMermaid(
      file(box("2", "") + box("3", "", "ellipse;aspect=fixed;") + box("4", "B")),
    );
    const parsed = await parseDiagram(code);
    expect(parsed.nodes.map((n) => (n.data as { label?: string }).label).sort()).toEqual([
      "",
      "",
      "B",
    ]);
  });

  it.each([
    ["rhombus;whiteSpace=wrap;", 'Q{"Q"}'],
    ["rounded=1;whiteSpace=wrap;", 'Q("Q")'],
    ["rounded=1;arcSize=40;", 'Q(["Q"])'],
    ["shape=hexagon;", 'Q{{"Q"}}'],
    ["shape=cylinder3;", 'Q[("Q")]'],
    ["shape=process;", 'Q[["Q"]]'],
    ["shape=parallelogram;", 'Q[/"Q"/]'],
    ["shape=trapezoid;", 'Q[/"Q"\\]'],
    ["shape=mxgraph.flowchart.decision;", 'Q{"Q"}'],
    ["shape=mxgraph.flowchart.terminator;", 'Q(["Q"])'],
    ["shape=mxgraph.flowchart.manual_operation;", 'Q[\\"Q"/]'],
    ["whiteSpace=wrap;html=1;", 'Q["Q"]'],
  ])("maps %s", (style, expected) => {
    const { code } = drawioToMermaid(file(box("2", "Q", style)));
    expect(lineFor(code, "Q")).toBe(expected);
  });

  it("reads a wide ellipse as a pill and a round one as a circle", () => {
    const wide = drawioToMermaid(
      file(box("2", "Q", "ellipse;", 'x="0" y="0" width="160" height="60"')),
    );
    const round = drawioToMermaid(
      file(box("2", "Q", "ellipse;", 'x="0" y="0" width="80" height="80"')),
    );
    expect(lineFor(wide.code, "Q")).toBe('Q(["Q"])');
    expect(lineFor(round.code, "Q")).toBe('Q(("Q"))');
  });

  it("turns an HTML label into text, keeping the line breaks", async () => {
    const { code } = drawioToMermaid(
      file(box("2", "&lt;b&gt;Pay&lt;/b&gt;&lt;br&gt;service &amp;amp; more")),
    );
    expect(lineFor(code, "Pay_service_more")).toBe(
      'Pay_service_more["Pay<br/>service & more"]',
    );
    // The ampersand is the interesting half: it must not take the parser with
    // it. Mermaid reads a label holding markup as HTML, so it comes back
    // escaped and with its own spelling of the break — and stays that way
    // rather than gaining an escape on every save.
    const graph = await parseDiagram(code);
    expect(graph.nodes[0].data.label).toBe("Pay<br>service &amp; more");
  });

  it("takes the label off an <object> wrapper", () => {
    const { code } = drawioToMermaid(
      file(`<object label="Wrapped" tag="x" id="9">
              <mxCell style="rhombus;" vertex="1" parent="1">
                <mxGeometry x="0" y="0" width="80" height="80" as="geometry" />
              </mxCell>
            </object>`),
    );
    expect(lineFor(code, "Wrapped")).toBe('Wrapped{"Wrapped"}');
  });
});

describe("colours", () => {
  it("carries fill, stroke and text colour across as a style line", () => {
    const { code } = drawioToMermaid(
      file(box("2", "A", "fillColor=#d5e8d4;strokeColor=#82b366;fontColor=#111111;")),
    );
    expect(code).toContain("style A fill:#d5e8d4,stroke:#82b366,color:#111111");
  });

  it("reads a colourless label as text rather than an invisible box", () => {
    const { code } = drawioToMermaid(file(box("2", "Title", "text;html=1;")));
    expect(code).toContain("style Title fill:transparent,stroke:none");
  });

  it("gives a pale fill dark text, so the label survives the dark theme", () => {
    // draw.io's palettes are all pale because it draws labels black. Without
    // this the words vanish into Archyne's light-on-dark node.
    const { code } = drawioToMermaid(file(box("2", "A", "fillColor=#d5e8d4;")));
    expect(code).toContain("style A fill:#d5e8d4,color:#111111");
  });

  it("gives a dark fill light text", () => {
    const { code } = drawioToMermaid(file(box("2", "A", "fillColor=#1a1a2e;")));
    expect(code).toContain("style A fill:#1a1a2e,color:#ffffff");
  });

  it("does not overrule a text colour the diagram already chose", () => {
    const { code } = drawioToMermaid(
      file(box("2", "A", "fillColor=#d5e8d4;fontColor=#ff0000;")),
    );
    expect(code).toContain("style A fill:#d5e8d4,color:#ff0000");
  });

  it("leaves a node with no fill to the theme", () => {
    const { code } = drawioToMermaid(file(box("2", "A", "strokeColor=#82b366;")));
    expect(code).toContain("style A stroke:#82b366");
    expect(code).not.toContain("color:#");
  });

  it("leaves draw.io's `default` colour to the theme", async () => {
    // Mermaid reads `default` as a keyword, and the style line stopped the
    // file parsing.
    const { code } = drawioToMermaid(
      file(box("2", "A", "fillColor=default;strokeColor=#82b366;fontColor=default;")),
    );
    expect(code).toContain("style A stroke:#82b366");
    expect(code).not.toContain("default");
    await expect(parseDiagram(code)).resolves.toBeTruthy();
  });

  it("takes the light half of a light-dark colour", async () => {
    // Written by draw.io's dark mode; the comma inside it ends the property.
    const { code } = drawioToMermaid(
      file(box("2", "A", "fillColor=#d5e8d4;fontColor=light-dark(#333333,#cccccc);")),
    );
    expect(code).toContain("style A fill:#d5e8d4,color:#333333");
    await expect(parseDiagram(code)).resolves.toBeTruthy();
  });

  it("writes `none` as transparent", () => {
    const { code } = drawioToMermaid(file(box("2", "A", "fillColor=none;strokeColor=none;")));
    expect(code).toContain("style A fill:transparent,stroke:none");
  });
});

describe("connections", () => {
  it("carries an arrow between two boxes", () => {
    const { code, edges } = drawioToMermaid(
      file(box("2", "A") + box("3", "B") + link("4", "2", "3")),
    );
    expect(edges).toBe(1);
    expect(code).toContain("A --> B");
  });

  it("reads the label draw.io parks on the connection itself", () => {
    const { code } = drawioToMermaid(
      file(box("2", "A") + box("3", "B") + link("4", "2", "3", "", "yes")),
    );
    expect(code).toContain('A -->|"yes"| B');
  });

  it("reads the label draw.io parks in a child cell", () => {
    // Which is where it goes whenever the label has been dragged along the
    // line — the common case, and invisible in the edge's own `value`.
    const { code } = drawioToMermaid(
      file(
        box("2", "A") +
          box("3", "B") +
          link("4", "2", "3") +
          `<mxCell id="5" value="no" style="edgeLabel;html=1;" vertex="1" connectable="0" parent="4">
             <mxGeometry x="0.1" relative="1" as="geometry" />
           </mxCell>`,
      ),
    );
    expect(code).toContain('A -->|"no"| B');
    // …and the label cell is not also a node.
    expect(code).not.toMatch(/^\s+no\[/m);
  });

  it.each([
    ["dashed=1;", "A -.-> B"],
    ["strokeWidth=4;", "A ==> B"],
    ["endArrow=none;", "A --- B"],
    ["endArrow=oval;", "A --o B"],
    ["endArrow=cross;", "A --x B"],
    ["startArrow=classic;endArrow=classic;", "A <--> B"],
  ])("maps %s", (style, expected) => {
    const { code } = drawioToMermaid(
      file(box("2", "A") + box("3", "B") + link("4", "2", "3", style)),
    );
    expect(code).toContain(expected);
  });

  it("leaves out a connection with a loose end", () => {
    const { code, edges, dropped } = drawioToMermaid(
      file(
        box("2", "A") +
          `<mxCell id="4" edge="1" parent="1" source="2"><mxGeometry as="geometry" /></mxCell>`,
      ),
    );
    expect(edges).toBe(0);
    expect(dropped).toBe(1);
    expect(code).toContain('A["A"]');
  });
});

describe("layout", () => {
  it("keeps every box where it was drawn", () => {
    const { code } = drawioToMermaid(
      file(box("2", "A", "", 'x="240" y="80" width="160" height="70"')),
    );
    expect(readPositions(code)).toEqual({ A: { x: 240, y: 80, w: 160, h: 70 } });
  });

  it("carries the corners of a hand-routed connection", () => {
    const { code } = drawioToMermaid(
      file(
        box("2", "A") +
          box("3", "B") +
          `<mxCell id="4" edge="1" parent="1" source="2" target="3">
             <mxGeometry relative="1" as="geometry">
               <Array as="points">
                 <mxPoint x="100" y="200" />
                 <mxPoint x="300" y="200" />
               </Array>
             </mxGeometry>
           </mxCell>`,
      ),
    );
    expect(readWaypoints(code)).toEqual({
      "A>B": [
        { x: 100, y: 200 },
        { x: 300, y: 200 },
      ],
    });
  });
});

describe("containers", () => {
  const GROUPED = file(
    `<mxCell id="10" value="VPC" style="swimlane;" vertex="1" parent="1">
       <mxGeometry x="40" y="40" width="320" height="240" as="geometry" />
     </mxCell>
     <mxCell id="11" value="Web" style="" vertex="1" parent="10">
       <mxGeometry x="20" y="60" width="120" height="60" as="geometry" />
     </mxCell>
     <mxCell id="12" value="Api" style="" vertex="1" parent="10">
       <mxGeometry x="20" y="150" width="120" height="60" as="geometry" />
     </mxCell>` + link("13", "11", "12"),
  );

  it("becomes a subgraph holding its children", () => {
    const { code } = drawioToMermaid(GROUPED);
    expect(code).toContain('subgraph VPC ["VPC"]');
    expect(code).toMatch(/subgraph VPC \["VPC"\]\n\s+Web\["Web"\]\n\s+Api\["Api"\]\n\s+end/);
  });

  it("leaves child coordinates relative to the container, as the store wants", () => {
    const positions = readPositions(drawioToMermaid(GROUPED).code)!;
    expect(positions.VPC).toEqual({ x: 40, y: 40, w: 320, h: 240 });
    expect(positions.Web).toEqual({ x: 20, y: 60, w: 120, h: 60 });
  });

  it("treats a plain box with children as a container too", () => {
    const { code } = drawioToMermaid(
      file(
        box("10", "Zone", "", 'x="0" y="0" width="300" height="200"') +
          `<mxCell id="11" value="Inner" vertex="1" parent="10">
             <mxGeometry x="10" y="10" width="80" height="40" as="geometry" />
           </mxCell>`,
      ),
    );
    expect(code).toMatch(/subgraph Zone \["Zone"\]\n\s+Inner\["Inner"\]/);
  });
});

describe("recognising a drawing that is not a flowchart", () => {
  it("says when a drawing looks like a sequence diagram", () => {
    // draw.io has no diagram type of its own — a sequence diagram there is
    // lifeline shapes on the ordinary canvas — so this converts as a
    // flowchart and says what the file appeared to be.
    const result = drawioToMermaid(
      file(box("2", "Web", "shape=umlLifeline;perimeter=lifelinePerimeter;")),
    );
    expect(result.looksLike).toBe("sequence");
    expect(result.code).toContain("flowchart");
  });

  it("says when it looks like an ER diagram", () => {
    const result = drawioToMermaid(
      file(box("2", "orders", "shape=table;startSize=30;childLayout=tableLayout;")),
    );
    expect(result.looksLike).toBe("er");
  });

  it("says nothing about an ordinary drawing", () => {
    expect(drawioToMermaid(file(box("2", "A"))).looksLike).toBeUndefined();
  });
});

describe("the file around the diagram", () => {
  it("lists every page and converts the first", () => {
    const two = `<mxfile>
      <diagram name="Overview" id="a"><mxGraphModel><root>
        <mxCell id="0" /><mxCell id="1" parent="0" />
        ${box("2", "First")}
      </root></mxGraphModel></diagram>
      <diagram name="Detail" id="b"><mxGraphModel><root>
        <mxCell id="0" /><mxCell id="1" parent="0" />
        ${box("3", "Second")}
      </root></mxGraphModel></diagram>
    </mxfile>`;
    const result = drawioToMermaid(two);
    expect(result.pages).toEqual(["Overview", "Detail"]);
    expect(result.code).toContain('First["First"]');
    expect(result.code).not.toContain("Second");
  });

  it("reads the compressed form draw.io writes by default", () => {
    // base64 of raw DEFLATE of the URI-encoded XML — three layers, and no
    // marker in the file to say so.
    const inner = `<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />${box("2", "Packed")}</root></mxGraphModel>`;
    const bytes = deflateSync(new TextEncoder().encode(encodeURIComponent(inner)));
    const packed = btoa(String.fromCharCode(...bytes));
    const { code } = drawioToMermaid(`<mxfile><diagram name="P">${packed}</diagram></mxfile>`);
    expect(code).toContain('Packed["Packed"]');
  });

  it("refuses something that is not XML at all", () => {
    expect(() => drawioToMermaid("not xml {")).toThrow();
  });

  it("refuses XML that holds no diagram", () => {
    expect(() => drawioToMermaid("<html><body>hi</body></html>")).toThrow(/no diagram/);
  });
});

describe("what comes out is a Mermaid document", () => {
  it("parses back, with every node, edge and container intact", async () => {
    const { code } = drawioToMermaid(
      file(
        `<mxCell id="10" value="Zone" style="swimlane;" vertex="1" parent="1">
           <mxGeometry x="0" y="0" width="400" height="300" as="geometry" />
         </mxCell>
         <mxCell id="11" value="Start" style="rounded=1;arcSize=40;fillColor=#d5e8d4;" vertex="1" parent="10">
           <mxGeometry x="20" y="40" width="120" height="60" as="geometry" />
         </mxCell>` +
          box("12", "Valid?", "rhombus;", 'x="200" y="200" width="100" height="80"') +
          box("13", "end", "shape=cylinder3;", 'x="400" y="200" width="100" height="80"') +
          link("14", "11", "12", "dashed=1;", "check") +
          link("15", "12", "13", "startArrow=classic;endArrow=classic;"),
      ),
    );

    const graph = await parseDiagram(code);
    expect(graph.kind).toBe("flowchart");
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["Start", "Valid", "Zone", "end_"]);
    expect(graph.nodes.find((n) => n.id === "Start")?.parentId).toBe("Zone");
    expect(graph.edges.map((e) => [e.source, e.target, e.data?.label])).toEqual([
      ["Start", "Valid", "check"],
      ["Valid", "end_", ""],
    ]);
    expect(graph.edges[0].data?.stroke).toBe("dotted");
    expect(graph.edges[1].data?.both).toBe(true);
  });

  it("opens on the canvas where draw.io had it, not re-laid-out", async () => {
    // The whole point of carrying the geometry across: loading the imported
    // source must not send it through auto-layout.
    const { code } = drawioToMermaid(
      file(box("2", "A", "", 'x="120" y="240" width="160" height="80"')),
    );
    await useGraphStore.getState().applyCode(code);
    const node = useGraphStore.getState().nodes.find((n) => n.id === "A")!;
    expect(node.position).toEqual({ x: 120, y: 240 });
  });
});

describe("zones drawn round shapes rather than holding them", () => {
  // A trust boundary, a VPC, a coloured panel: a rectangle laid over the
  // shapes it encloses, not a container they belong to.
  const zone = (id: string, label: string, style: string, geo: string) =>
    `<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="1">
       <mxGeometry ${geo} as="geometry" />
     </mxCell>`;

  it("reads an unfilled box round other shapes as a group, with them in it", async () => {
    const { code } = drawioToMermaid(
      file(
        zone(
          "z",
          "Cluster",
          "fillColor=none;dashed=1;",
          'x="0" y="0" width="400" height="300"',
        ) +
          box("a", "Inside", "", 'x="40" y="60" width="120" height="60"') +
          box("b", "Outside", "", 'x="600" y="60" width="120" height="60"'),
      ),
    );
    expect(code).toMatch(/subgraph Cluster \["Cluster"\]\n\s+Inside\["Inside"\]\n\s+end/);
    // Placed within the group, so the canvas puts it where draw.io did.
    expect(readPositions(code)?.Inside).toMatchObject({ x: 40, y: 60 });
    const parsed = await parseDiagram(code);
    expect(parsed.nodes.find((n) => n.id === "Inside")?.parentId).toBe("Cluster");
  });

  it("nests a zone inside a bigger one", () => {
    const { code } = drawioToMermaid(
      file(
        zone("o", "Outer", "fillColor=none;", 'x="0" y="0" width="600" height="400"') +
          zone("i", "Inner", "fillColor=none;", 'x="100" y="100" width="300" height="200"') +
          box("a", "Deep", "", 'x="150" y="150" width="100" height="40"'),
      ),
    );
    expect(code).toMatch(/subgraph Outer[^\n]*\n\s+subgraph Inner[^\n]*\n\s+Deep/);
    expect(readPositions(code)?.Inner).toMatchObject({ x: 100, y: 100 });
    expect(readPositions(code)?.Deep).toMatchObject({ x: 50, y: 50 });
  });

  it("reads a filled panel round two shapes as a group", () => {
    const { code } = drawioToMermaid(
      file(
        zone("p", "Panel", "fillColor=#dae8fc;", 'x="0" y="0" width="400" height="300"') +
          box("a", "One", "", 'x="20" y="20" width="100" height="40"') +
          box("b", "Two", "", 'x="200" y="20" width="100" height="40"'),
      ),
    );
    expect(code).toContain('subgraph Panel ["Panel"]');
  });

  it("brings a panel's colours, its dash, and draw.io's white when it names no fill", () => {
    const { code } = drawioToMermaid(
      file(
        zone(
          "o",
          "Hub",
          "fillColor=#f5f5f5;strokeColor=#666666;dashed=1;dashPattern=1 1;",
          'x="0" y="0" width="600" height="400"',
        ) +
          zone(
            "p",
            "Subnet",
            "strokeColor=#A9C4EB;",
            'x="20" y="20" width="400" height="300"',
          ) +
          box("a", "One", "", 'x="40" y="60" width="100" height="40"') +
          box("b", "Two", "", 'x="200" y="60" width="100" height="40"'),
      ),
    );
    expect(code).toMatch(/style Hub [^\n]*fill:#f5f5f5[^\n]*stroke-dasharray:1 1/);
    expect(code).toMatch(/style Subnet stroke:#A9C4EB,fill:#ffffff,color:#111111/);
  });

  it("writes words with no box in a colour that reads on the panel under them", () => {
    // In the dark theme's pale text they vanished on draw.io's white panels.
    const { code } = drawioToMermaid(
      file(
        zone("p", "", "fillColor=#ffffff;", 'x="0" y="0" width="400" height="300"') +
          box("t", "Caption", "text;", 'x="20" y="20" width="100" height="30"') +
          box("a", "One", "", 'x="40" y="100" width="100" height="40"'),
      ),
    );
    expect(code).toMatch(/style Caption fill:transparent,stroke:none,color:#111111/);
  });

  it("keeps a filled box with one tag on it a node", () => {
    // etcd with TO18 on its corner, in the Kubernetes threat model.
    const { code } = drawioToMermaid(
      file(
        box("e", "etcd", "fillColor=#dae8fc;", 'x="0" y="0" width="140" height="50"') +
          box("t", "TO18", "fillColor=#fff2cc;", 'x="100" y="30" width="40" height="20"'),
      ),
    );
    expect(code).not.toContain("subgraph");
  });
});

describe("what draw.io writes inside a label or a lane", () => {
  it("breaks a line at a <br> that carries a style", () => {
    const { code } = drawioToMermaid(
      file(
        box("a", "A") +
          box("b", "B", "", 'x="300" y="40" width="120" height="60"') +
          link(
            "e",
            "a",
            "b",
            "",
            "10250&lt;br style=&quot;border-color: var(--border-color);&quot;&gt;HTTPS",
          ),
      ),
    );
    expect(code).toContain('"10250<br/>HTTPS"');
  });

  it("puts the corners of a connection inside a lane where the lane puts them", () => {
    const { code } = drawioToMermaid(
      file(
        `<mxCell id="lane" value="Lane" style="swimlane;" vertex="1" parent="1">
           <mxGeometry x="200" y="100" width="600" height="300" as="geometry" />
         </mxCell>
         <mxCell id="a" value="A" style="" vertex="1" parent="lane">
           <mxGeometry x="20" y="40" width="80" height="40" as="geometry" />
         </mxCell>
         <mxCell id="b" value="B" style="" vertex="1" parent="lane">
           <mxGeometry x="400" y="200" width="80" height="40" as="geometry" />
         </mxCell>
         <mxCell id="e" style="" edge="1" parent="lane" source="a" target="b">
           <mxGeometry relative="1" as="geometry">
             <Array as="points"><mxPoint x="300" y="60" /></Array>
           </mxGeometry>
         </mxCell>`,
      ),
    );
    // The lane stands at 200,100 on the page; the corner was written within it.
    expect(readWaypoints(code)?.["A>B"]).toEqual([{ x: 500, y: 160 }]);
  });
});

describe("a file of several pages", () => {
  const page = (name: string, cells: string) => `
  <diagram name="${name}" id="${name}">
    <mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />${cells}</root></mxGraphModel>
  </diagram>`;
  const twoPages = `<mxfile host="app.diagrams.net">${page("Overview", box("a", "Overview box"))}${page(
    "Details",
    box("b", "Detail box"),
  )}</mxfile>`;

  it("converts the first page unless asked for another", () => {
    const first = drawioToMermaid(twoPages);
    expect(first.pages).toEqual(["Overview", "Details"]);
    expect(first.page).toBe(0);
    expect(first.code).toContain("Overview box");
  });

  it("converts the page asked for", () => {
    // An overview and its details: the second was not reachable at all.
    const second = drawioToMermaid(twoPages, undefined, 1);
    expect(second.page).toBe(1);
    expect(second.code).toContain("Detail box");
    expect(second.code).not.toContain("Overview box");
  });
});

describe("draw.io's own groups", () => {
  // Ctrl+G in draw.io: an invisible cell holding a panel and what is on it.
  const grouped = `
    <mxCell id="g" value="" style="group" vertex="1" parent="1" connectable="0">
      <mxGeometry x="100" y="50" width="200" height="120" as="geometry" />
    </mxCell>
    <mxCell id="panel" value="" style="rounded=0;fillColor=#1e2a3a;" vertex="1" parent="g">
      <mxGeometry width="200" height="120" as="geometry" />
    </mxCell>
    <mxCell id="t" value="Subnet" style="text;fillColor=none;strokeColor=none;" vertex="1" parent="g">
      <mxGeometry x="20" y="10" width="80" height="20" as="geometry" />
    </mxCell>
    <mxCell id="i" value="Firewall" style="text;fillColor=none;strokeColor=none;" vertex="1" parent="g">
      <mxGeometry x="20" y="60" width="80" height="20" as="geometry" />
    </mxCell>`;

  it("are not containers: the panel inside one is", () => {
    // Read as a container, the group became a subgraph titled `g1` wrapped
    // round the panel that really was the box.
    const { code } = drawioToMermaid(file(grouped), "flowchart");
    expect(code).not.toMatch(/subgraph g\d+ \["g\d+"\]/);
    expect(code.match(/subgraph/g)).toHaveLength(1);
    expect(code).toMatch(
      /subgraph \w+ \[" "\]\n\s+Subnet\["Subnet"\]\n\s+Firewall\["Firewall"\]/,
    );
  });

  it("keeps a shape in the corner of its group, which draw.io writes with no x or y", () => {
    // The panel above sits at 0,0 in its group, so its geometry has only a
    // size — and was read as having none, and dropped.
    const { dropped, code } = drawioToMermaid(file(grouped), "flowchart");
    expect(dropped).toBe(0);
    // Placed where the group stood, since it was measured from it.
    const positions = readPositions(code)!;
    const panel = Object.entries(positions).find(([, p]) => p.w === 200 && p.h === 120);
    expect(panel?.[1]).toMatchObject({ x: 100, y: 50 });
  });

  it("hands a connection tied to a group to the biggest shape it held", () => {
    // Tied to the group itself, the arrow pointed at a frame nobody drew.
    const loose = `
      <mxCell id="g" value="" style="group" vertex="1" parent="1" connectable="0">
        <mxGeometry x="100" y="50" width="200" height="140" as="geometry" />
      </mxCell>
      <mxCell id="small" value="Tag" style="" vertex="1" parent="g">
        <mxGeometry width="40" height="20" as="geometry" />
      </mxCell>
      <mxCell id="big" value="Big" style="" vertex="1" parent="g">
        <mxGeometry y="40" width="200" height="100" as="geometry" />
      </mxCell>`;
    const { edges, code } = drawioToMermaid(
      file(
        loose +
          box("x", "Outside", "", 'x="500" y="80" width="80" height="40"') +
          link("e", "x", "g"),
      ),
      "flowchart",
    );
    expect(edges).toBe(1);
    expect(code).toContain("Outside --> Big");
    expect(code).not.toContain("subgraph");
  });
});

describe("pictures", () => {
  const svg = btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><rect width="18" height="18"/></svg>',
  );
  const icon = (id: string, label: string, image: string, extra = "") =>
    `<mxCell id="${id}" value="${label}" style="image;aspect=fixed;html=1;image=${image};verticalLabelPosition=bottom;verticalAlign=top;${extra}" vertex="1" parent="1">
       <mxGeometry x="40" y="40" width="40" height="40" as="geometry" />
     </mxCell>`;

  it("come across as pictures with their caption under them and no box", async () => {
    // They were boxes the icon's size with an empty square inside and the
    // caption cut short within them.
    const { code } = drawioToMermaid(file(icon("k", "Key Vault", `data:image/svg+xml,${svg}`)));
    expect(code).toContain(`img: "data:image/svg+xml;base64,${svg}"`);
    expect(code).toContain('label: "Key Vault", pos: "b", w: 40, h: 40');
    expect(code).toMatch(/style Key_Vault fill:none,stroke:none/);
    // No size of its own, so the node takes the picture and its words —
    // and it is placed so the picture stays where draw.io drew it: centred
    // on x 60, and 6 units of the label's padding below the node's top.
    const at = readPositions(code)!.Key_Vault;
    expect(at.w).toBeUndefined();
    expect(at.y).toBe(34);
    expect(at.x).toBeLessThanOrEqual(40);
    const parsed = await parseDiagram(code);
    expect((parsed.nodes[0].data as { img?: string }).img).toMatch(
      /^data:image\/svg\+xml;base64,/,
    );
  });

  it("fetch one from draw.io's own library from draw.io's repository", () => {
    const { code } = drawioToMermaid(
      file(icon("f", "Firewall", "img/lib/azure2/networking/Firewalls.svg")),
    );
    expect(code).toContain(
      'img: "https://raw.githubusercontent.com/jgraph/drawio/dev/src/main/webapp/img/lib/azure2/networking/Firewalls.svg"',
    );
  });

  it("keep a drawing of mostly pictures a flowchart, whatever stencil is among them", () => {
    // One Azure stencil among the icons sent the whole page to
    // architecture-beta, which has no boxes or captions to put them in.
    const { code } = drawioToMermaid(
      file(
        icon("a", "One", `data:image/svg+xml,${svg}`) +
          icon("b", "Two", `data:image/svg+xml,${svg}`) +
          box("s", "AAD", "shape=mxgraph.azure.azure_active_directory;"),
      ),
    );
    expect(code.startsWith("flowchart")).toBe(true);
  });
});

describe("words fitted where draw.io drew them", () => {
  // aks-baseline: draw.io's text runs narrower than the canvas's, and the
  // canvas draws a zone's frame inside its box, so words that sat inside
  // their space there ran over its edge here.
  const sizeOf = (code: string, id: string) =>
    code.match(new RegExp(`style ${id} [^\\n]*font-size:([\\d.]+)px`))?.[1];
  const subnet = (inside: string) =>
    file(
      box("z", "", "fillColor=none;", 'x="0" y="0" width="120" height="90"') +
        box("p", "Peer", "", 'x="400" y="0" width="80" height="40"') +
        inside,
    );

  it("makes a box's words smaller when they would run out of it", () => {
    const { code } = drawioToMermaid(
      file(
        box(
          "k",
          "Kubernetes&#xa;system nodes and more",
          "",
          'x="0" y="0" width="100" height="40"',
        ) + box("s", "Short", "", 'x="200" y="0" width="100" height="40"'),
      ),
    );
    expect(Number(sizeOf(code, "Kubernetes_system_nodes"))).toBeLessThan(12);
    // Words with room are left at the canvas's own size.
    expect(sizeOf(code, "Short")).toBeUndefined();
  });

  it("lets a long name break at its hyphens rather than shrinking it to nothing", () => {
    // kube-controller-manager, in a circle in the Kubernetes threat model:
    // taken as one word it went down to the smallest size there is.
    const { code } = drawioToMermaid(
      file(
        box("c", "kube-controller-manager", "ellipse;", 'x="0" y="0" width="80" height="80"'),
      ),
    );
    expect(Number(sizeOf(code, "kube_controller_manager") ?? 12)).toBeGreaterThanOrEqual(9.5);
  });

  it("leaves alone words draw.io puts beside the shape", () => {
    // A stick figure's name, under it: not in its 40×60 box.
    const { code } = drawioToMermaid(
      file(
        box(
          "a",
          "AvengedExquiste",
          "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;",
          'x="0" y="0" width="40" height="60"',
        ),
      ),
    );
    expect(sizeOf(code, "AvengedExquiste")).toBeUndefined();
  });

  it("keeps words with no box inside the frame of the zone they stand in", () => {
    // Under its icon, as in aks-baseline: wrapped onto three lines, the
    // words would only fit by climbing onto it.
    const { code } = drawioToMermaid(
      subnet(
        box("i", "", "", 'x="40" y="4" width="40" height="40"') +
          box(
            "t",
            "Internal Load Balancer&#xa;(AKS-managed)",
            "text;",
            'x="0" y="50" width="120" height="40"',
          ),
      ),
    );
    expect(Number(sizeOf(code, "Internal_Load_Balancer_A"))).toBeLessThan(12);
    expect(readPositions(code)!.Internal_Load_Balancer_A.y).toBeGreaterThanOrEqual(44);
  });

  it("moves a zone's title in off its frame rather than shrinking it", () => {
    // A title in a box shallower than its line, along the zone's top edge:
    // centred on that box, its letters stood on the frame.
    const { code } = drawioToMermaid(
      subnet(box("t", "Subnet", "text;", 'x="30" y="0" width="60" height="10"')),
    );
    expect(sizeOf(code, "Subnet")).toBeUndefined();
    expect(readPositions(code)!.Subnet.y).toBeGreaterThan(0);
  });

  it("makes a picture's caption smaller when it would hang out of its zone", () => {
    const { code } = drawioToMermaid(
      subnet(
        `<mxCell id="i" value="Azure Container&#xa;Registry" style="image;image=data:image/svg+xml,PHN2Zy8+;verticalLabelPosition=bottom;" vertex="1" parent="1">
           <mxGeometry x="40" y="36" width="40" height="40" as="geometry" />
         </mxCell>`,
      ),
    );
    expect(Number(sizeOf(code, "Azure_Container_Registry"))).toBeLessThan(12);
  });
});

describe("a connection with a loose end", () => {
  it("is tied to the shape its end rests on", () => {
    // draw.io lets an arrow end on a container's border without being glued
    // to it; Mermaid has no arrow that ends on nothing, so it was dropped.
    const loose = `<mxCell id="e" value="VNet peering" style="endArrow=classic;" edge="1" parent="1" source="a">
        <mxGeometry relative="1" as="geometry">
          <mxPoint x="420" y="70" as="targetPoint" />
        </mxGeometry>
      </mxCell>`;
    const { edges, dropped, code } = drawioToMermaid(
      file(
        box("a", "Hub") +
          box("b", "Spoke", "", 'x="400" y="40" width="120" height="60"') +
          loose,
      ),
    );
    expect([edges, dropped]).toEqual([1, 0]);
    expect(code).toContain('Hub -->|"VNet peering"| Spoke');
  });

  it("does not turn a loop the author drew into nothing", () => {
    const { edges } = drawioToMermaid(file(box("a", "Self") + link("e", "a", "a")));
    expect(edges).toBe(1);
  });
});

describe("where a connection meets its boxes", () => {
  it("leaves from the point draw.io pinned it to", () => {
    // `exitX=0.5;exitY=1`: out of the foot of A, though B lies to the right.
    // Ignored, the line left from A's side and lay along another's.
    const { code } = drawioToMermaid(
      file(
        box("a", "A") +
          box("b", "B", "", 'x="400" y="40" width="120" height="60"') +
          link("e", "a", "b", "exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0;entryY=0.5;"),
      ),
    );
    // A stands at 40,40 and is 120 by 60: its foot's middle is 100,100.
    expect(readWaypoints(code)?.["A>B"]).toEqual([
      { x: 100, y: 120 },
      { x: 380, y: 70 },
    ]);
  });

  it("keeps where a loose end touched its box", () => {
    // Both ends resting on the boxes' edges at x 100: a straight line down.
    const loose = `<mxCell id="e" style="startArrow=classic;endArrow=classic;" edge="1" parent="1">
        <mxGeometry relative="1" as="geometry">
          <mxPoint x="100" y="100" as="sourcePoint" />
          <mxPoint x="100" y="200" as="targetPoint" />
        </mxGeometry>
      </mxCell>`;
    const { code } = drawioToMermaid(
      file(
        box("a", "Hub") +
          box("b", "Spoke", "", 'x="40" y="200" width="120" height="60"') +
          loose,
      ),
    );
    expect(code).toContain("Hub <--> Spoke");
    expect(readWaypoints(code)?.["Hub>Spoke"]).toEqual([
      { x: 100, y: 120 },
      { x: 100, y: 180 },
    ]);
  });

  it("turns round an arrow whose only head is at its start", () => {
    // Mermaid draws a head at the end or at both; read as it was, the one
    // head was dropped and the arrow pointed nowhere.
    const { code } = drawioToMermaid(
      file(
        box("a", "Hub") +
          box("b", "Spoke", "", 'x="400" y="40" width="120" height="60"') +
          link("e", "a", "b", "startArrow=classic;endArrow=none;"),
      ),
    );
    expect(code).toContain("Spoke --> Hub");
  });
});
