import { describe, expect, it } from "vitest";
import { withStoredLooks } from "./graph";
import { parseDiagram } from "./model/diagram";
import { render } from "./render/fromCode";

/**
 * A document's comments put back onto a fresh parse: the same everywhere the
 * document is drawn, or the canvas, the import preview and the renderer each
 * draw a different picture of one file.
 */

const BENT = `flowchart LR
  a["A"] --> b["B"]
%% graph:positions {"a":{"x":0,"y":0},"b":{"x":400,"y":200}}
%% graph:waypoints {"a>b":[[250,20],[250,220]]}
%% graph:edges {"a>b":{"route":"curved"}}
`;

describe("what a document says about its own drawing", () => {
  it("puts each connection's corners and style back on", async () => {
    const parsed = await parseDiagram(BENT);
    const { edges } = withStoredLooks(BENT, parsed.nodes, parsed.edges);
    expect(edges[0].data?.points).toEqual([
      { x: 250, y: 20 },
      { x: 250, y: 220 },
    ]);
    expect(edges[0].data?.style?.route).toBe("curved");
  });

  it("leaves a document with nothing stored as it was parsed", async () => {
    const plain = 'flowchart LR\n  a["A"] --> b["B"]\n';
    const parsed = await parseDiagram(plain);
    const out = withStoredLooks(plain, parsed.nodes, parsed.edges);
    expect(out.edges).toBe(parsed.edges);
    expect(out.nodes).toBe(parsed.nodes);
  });

  it("is drawn by the renderer through the corners, as on the canvas", async () => {
    // archyne-render drew the connection afresh, ignoring where it was bent.
    const { svg } = await render(BENT);
    const d = svg.match(/<path class="e" d="([^"]+)"/)![1];
    expect(d).toContain("250,");
  });
});
