import { describe, expect, it } from "vitest";
import {
  isPlainNode,
  labelPlaceOf,
  patchNodeStyles,
  readNodeStyles,
  stripNodeStyles,
  styleProps,
  readableLabel,
} from "./nodeStyle";

const DIAGRAM = "architecture-beta\n  service web(internet)[Web]\n";

describe("reading the node presentation line", () => {
  it("finds nothing in a file that has none", () => {
    expect(readNodeStyles(DIAGRAM)).toBeNull();
  });

  it("reads a node asked to show its icon alone", () => {
    const code = `${DIAGRAM}%% graph:nodes {"web":{"look":"icon"}}\n`;
    expect(readNodeStyles(code)).toEqual({ web: { look: "icon" } });
  });

  it("refuses a look it does not know", () => {
    expect(readNodeStyles(`${DIAGRAM}%% graph:nodes {"web":{"look":"hexagon"}}\n`)).toEqual({});
  });

  it("drops the default rather than carrying it about", () => {
    expect(readNodeStyles(`${DIAGRAM}%% graph:nodes {"web":{"look":"boxed"}}\n`)).toEqual({});
  });

  it("survives a line that is not JSON at all", () => {
    expect(readNodeStyles(`${DIAGRAM}%% graph:nodes {oops\n`)).toBeNull();
  });
});

describe("writing it back", () => {
  it("adds the line when there is something to say", () => {
    expect(patchNodeStyles(DIAGRAM, { web: { look: "icon" } })).toContain(
      '%% graph:nodes {"web":{"look":"icon"}}',
    );
  });

  it("leaves no line when every node is ordinary", () => {
    expect(patchNodeStyles(DIAGRAM, { web: { look: "boxed" } })).not.toContain("graph:nodes");
  });

  it("replaces the line rather than stacking another up", () => {
    const once = patchNodeStyles(DIAGRAM, { web: { look: "icon" } });
    const twice = patchNodeStyles(once, { web: { look: "icon" }, db: { look: "icon" } });
    expect(twice.match(/graph:nodes/g)).toHaveLength(1);
    expect(twice).toContain("db");
  });

  it("takes the line away when the last node goes back to ordinary", () => {
    const once = patchNodeStyles(DIAGRAM, { web: { look: "icon" } });
    expect(patchNodeStyles(once, {})).not.toContain("graph:nodes");
  });

  it("comes back out the way it went in", () => {
    const style = { web: { look: "icon" as const } };
    expect(readNodeStyles(patchNodeStyles(DIAGRAM, style))).toEqual(style);
  });

  it("strips the line without disturbing the diagram", () => {
    const code = patchNodeStyles(DIAGRAM, { web: { look: "icon" } });
    expect(stripNodeStyles(code).trim()).toBe(DIAGRAM.trim());
  });
});

describe("telling an ordinary node from a styled one", () => {
  it("counts nothing and the default as ordinary", () => {
    expect(isPlainNode(undefined)).toBe(true);
    expect(isPlainNode({})).toBe(true);
    expect(isPlainNode({ look: "boxed" })).toBe(true);
  });

  it("counts the icon alone as worth keeping", () => {
    expect(isPlainNode({ look: "icon" })).toBe(false);
  });
});

describe("where a label stands in its box", () => {
  it("runs from the edge the style names", () => {
    // A draw.io wireframe's words start at the left; a class's name sits at the top.
    expect(labelPlaceOf(styleProps(["text-align:left", "vertical-align:top"]))).toEqual({
      justifyContent: "flex-start",
      alignItems: "flex-start",
    });
    expect(labelPlaceOf(styleProps(["text-align:right", "vertical-align:bottom"]))).toEqual({
      justifyContent: "flex-end",
      alignItems: "flex-end",
    });
  });

  it("says nothing for words centred both ways", () => {
    expect(labelPlaceOf(styleProps(["text-align:center", "fill:#fff"]))).toEqual({});
  });
});

describe("a label on a filled box", () => {
  it("is given a text colour that reads on a pale fill", () => {
    // `classDef process fill:#bbf`: Mermaid's own theme writes dark words on
    // it, and the dark canvas's light grey could not be read there.
    expect(readableLabel({ fill: "#bbf" }).color).toBe("#111111");
    expect(readableLabel({ fill: "#ff9" }).color).toBe("#111111");
  });

  it("and one that reads on a dark fill", () => {
    expect(readableLabel({ fill: "#1e3a5f" }).color).toBe("#ffffff");
  });

  it("keeps a text colour the file states", () => {
    expect(readableLabel({ fill: "#bbf", color: "#c00" }).color).toBe("#c00");
  });

  it("leaves a box with no fill, or one it cannot judge, alone", () => {
    expect(readableLabel({}).color).toBeUndefined();
    expect(readableLabel({ fill: "none" }).color).toBeUndefined();
    expect(readableLabel({ fill: "rebeccapurple" }).color).toBeUndefined();
  });
});
