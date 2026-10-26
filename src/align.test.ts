import { beforeEach, describe, expect, it } from "vitest";
import { useGraphStore, alignableSelection, canGroup, groupableSelection } from "./store";
import type { AnyNode } from "./model/types";

/**
 * Aligning and distributing, which exist so that arranging a diagram does
 * not require dragging anything — and so that two boxes end up actually
 * level rather than nearly level.
 */

/** A node of a known size, so the arithmetic has something exact to hit. */
function node(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  parentId?: string,
): AnyNode {
  return {
    id,
    type: "shape",
    position: { x, y },
    selected: true,
    style: { width: w, height: h },
    data: { label: id, shape: "rect" },
    ...(parentId ? { parentId } : {}),
  } as unknown as AnyNode;
}

const boxes = () =>
  Object.fromEntries(
    useGraphStore.getState().nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }]),
  );

function seed(nodes: AnyNode[]) {
  useGraphStore.setState({ nodes, edges: [], code: "flowchart TD\n" });
}

beforeEach(() => {
  useGraphStore.setState({ nodes: [], edges: [] });
});

describe("what can be aligned", () => {
  it("needs at least two nodes", () => {
    seed([node("a", 0, 0, 100, 50)]);
    expect(alignableSelection(useGraphStore.getState().nodes)).toHaveLength(0);
  });

  it("ignores nodes that are not selected", () => {
    const a = node("a", 0, 0, 100, 50);
    const b = { ...node("b", 10, 10, 100, 50), selected: false } as AnyNode;
    seed([a, b]);
    expect(alignableSelection(useGraphStore.getState().nodes)).toHaveLength(0);
  });

  it("refuses a selection spanning different parents", () => {
    // A child's position is relative to its group, so comparing it with a
    // top-level node would be comparing two coordinate systems.
    seed([node("a", 0, 0, 100, 50), node("b", 10, 10, 100, 50, "g1")]);
    expect(alignableSelection(useGraphStore.getState().nodes)).toHaveLength(0);
  });

  it("accepts a selection sharing one parent", () => {
    seed([node("a", 0, 0, 100, 50, "g1"), node("b", 10, 10, 100, 50, "g1")]);
    expect(alignableSelection(useGraphStore.getState().nodes)).toHaveLength(2);
  });
});

describe("aligning", () => {
  beforeEach(() => {
    // Widths differ on purpose: an edge and a centre are different answers.
    seed([node("a", 0, 0, 100, 40), node("b", 50, 100, 200, 40), node("c", 30, 200, 60, 40)]);
  });

  it("puts every left edge on the leftmost one", () => {
    useGraphStore.getState().alignSelection("left");
    const p = boxes();
    expect([p.a.x, p.b.x, p.c.x]).toEqual([0, 0, 0]);
  });

  it("puts every right edge on the rightmost one", () => {
    useGraphStore.getState().alignSelection("right");
    const p = boxes();
    // The selection's right edge is b's: 50 + 200 = 250.
    expect([p.a.x + 100, p.b.x + 200, p.c.x + 60]).toEqual([250, 250, 250]);
  });

  it("centres on the middle of the selection, not the average node", () => {
    useGraphStore.getState().alignSelection("centerX");
    const p = boxes();
    // Bounding box spans 0..250, so every centre lands on 125.
    expect([p.a.x + 50, p.b.x + 100, p.c.x + 30]).toEqual([125, 125, 125]);
  });

  it("leaves the other axis alone", () => {
    const before = boxes();
    useGraphStore.getState().alignSelection("left");
    const after = boxes();
    expect([after.a.y, after.b.y, after.c.y]).toEqual([before.a.y, before.b.y, before.c.y]);
  });

  it("aligns tops and bottoms the same way", () => {
    useGraphStore.getState().alignSelection("top");
    expect(Object.values(boxes()).map((p) => p.y)).toEqual([0, 0, 0]);

    seed([node("a", 0, 0, 100, 40), node("b", 0, 100, 100, 80)]);
    useGraphStore.getState().alignSelection("bottom");
    const p = boxes();
    // The lowest edge is b's: 100 + 80 = 180.
    expect([p.a.y + 40, p.b.y + 80]).toEqual([180, 180]);
  });

  it("turns a row aligned on its left edges into a column, not a stack", () => {
    // Every left edge on one line puts a row of boxes on top of each other.
    // They move down instead, in the order they stood, 40px apart.
    seed([node("a", 0, 0, 100, 40), node("b", 200, 0, 60, 40), node("c", 400, 0, 80, 40)]);
    useGraphStore.getState().alignSelection("left");
    const p = boxes();
    expect([p.a.x, p.b.x, p.c.x]).toEqual([0, 0, 0]);
    expect([p.a.y, p.b.y, p.c.y]).toEqual([0, 80, 160]);
  });

  it("turns a column aligned on its tops into a row, not a stack", () => {
    seed([node("a", 0, 0, 100, 40), node("b", 0, 100, 60, 40)]);
    useGraphStore.getState().alignSelection("top");
    const p = boxes();
    expect([p.a.y, p.b.y]).toEqual([0, 0]);
    expect([p.a.x, p.b.x]).toEqual([0, 140]);
  });

  it("keeps a slightly ragged row in reading order", () => {
    // c stands 15px higher than the rest, but it is the last of a row: it
    // goes at the bottom of the column, not the top.
    seed([node("a", 0, 15, 90, 87), node("b", 110, 15, 90, 87), node("c", 220, 0, 90, 87)]);
    useGraphStore.getState().alignSelection("centerX");
    const p = boxes();
    expect(p.a.y).toBeLessThan(p.b.y);
    expect(p.b.y).toBeLessThan(p.c.y);
  });

  it("grows the group the selection sits in, so nothing hangs out of it", () => {
    const group = {
      id: "g",
      type: "group",
      position: { x: 0, y: 0 },
      style: { width: 400, height: 120 },
      data: { label: "g" },
    } as unknown as AnyNode;
    seed([group, node("a", 16, 40, 100, 40, "g"), node("b", 200, 40, 100, 40, "g")]);
    useGraphStore.getState().alignSelection("left");
    const g = useGraphStore.getState().nodes.find((n) => n.id === "g")!;
    // b drops to 40 + 40 + 40 = 120, ending at 160, plus the 16px inset.
    expect(boxes().b.y).toBe(120);
    expect(g.style).toMatchObject({ width: 400, height: 176 });
  });

  it("does not respace what was never going to overlap", () => {
    // A column 10px apart stays 10px apart: only an overlap is resolved.
    seed([node("a", 0, 0, 100, 40), node("b", 30, 50, 100, 40)]);
    useGraphStore.getState().alignSelection("left");
    expect(boxes().b).toEqual({ x: 0, y: 50 });
  });

  it("does nothing when there is nothing to align against", () => {
    seed([node("a", 7, 9, 100, 40)]);
    useGraphStore.getState().alignSelection("left");
    expect(boxes().a).toEqual({ x: 7, y: 9 });
  });
});

describe("distributing", () => {
  it("evens the gaps rather than the centres", () => {
    // Widths 100, 20, 100 across 0..400: equal centres and equal gaps are
    // different arrangements, and this asserts the second.
    seed([node("a", 0, 0, 100, 40), node("b", 150, 0, 20, 40), node("c", 300, 0, 100, 40)]);
    useGraphStore.getState().distributeSelection("x");

    const p = boxes();
    const gapAB = p.b.x - (p.a.x + 100);
    const gapBC = p.c.x - (p.b.x + 20);
    expect(gapAB).toBe(gapBC);
    // The outer two do not move: distributing arranges what is between them.
    expect(p.a.x).toBe(0);
    expect(p.c.x).toBe(300);
  });

  it("works down the page too", () => {
    seed([node("a", 0, 0, 40, 100), node("b", 0, 120, 40, 20), node("c", 0, 300, 40, 100)]);
    useGraphStore.getState().distributeSelection("y");
    const p = boxes();
    expect(p.b.y - (p.a.y + 100)).toBe(p.c.y - (p.b.y + 20));
  });

  it("uses the visual order, not the selection order", () => {
    seed([node("c", 300, 0, 50, 40), node("a", 0, 0, 50, 40), node("b", 100, 0, 50, 40)]);
    useGraphStore.getState().distributeSelection("x");
    const p = boxes();
    expect(p.a.x).toBe(0);
    expect(p.c.x).toBe(300);
    expect(p.b.x).toBeGreaterThan(p.a.x);
    expect(p.b.x).toBeLessThan(p.c.x);
  });

  it("does nothing with two nodes, which have nothing between them", () => {
    seed([node("a", 0, 0, 50, 40), node("b", 300, 0, 50, 40)]);
    useGraphStore.getState().distributeSelection("x");
    const p = boxes();
    expect([p.a.x, p.b.x]).toEqual([0, 300]);
  });
});

describe("matching sizes", () => {
  const sizes = () =>
    Object.fromEntries(
      useGraphStore
        .getState()
        .nodes.map((n) => [n.id, { w: Number(n.style?.width), h: Number(n.style?.height) }]),
    );

  it("widens everything to the widest, and leaves heights alone", () => {
    seed([node("a", 0, 0, 100, 40), node("b", 0, 100, 180, 60), node("c", 0, 200, 60, 30)]);
    useGraphStore.getState().matchSelectionSize("width");
    expect(sizes()).toEqual({
      a: { w: 180, h: 40 },
      b: { w: 180, h: 60 },
      c: { w: 180, h: 30 },
    });
  });

  it("raises everything to the tallest", () => {
    seed([node("a", 0, 0, 100, 40), node("b", 200, 0, 180, 60)]);
    useGraphStore.getState().matchSelectionSize("height");
    expect(sizes()).toEqual({ a: { w: 100, h: 60 }, b: { w: 180, h: 60 } });
  });

  it("works across groups, since a size has no coordinate system", () => {
    seed([node("a", 0, 0, 100, 40), node("b", 10, 10, 150, 40, "g1")]);
    useGraphStore.getState().matchSelectionSize("width");
    expect(sizes().a.w).toBe(150);
  });

  it("does not size a box to the group beside it", () => {
    const group = {
      id: "g",
      type: "group",
      position: { x: 300, y: 0 },
      selected: true,
      style: { width: 600, height: 400 },
      data: { label: "g" },
    } as unknown as AnyNode;
    seed([group, node("a", 0, 0, 100, 40), node("b", 0, 100, 120, 40)]);
    useGraphStore.getState().matchSelectionSize("width");
    const s = sizes();
    expect([s.a.w, s.b.w, s.g.w]).toEqual([120, 120, 600]);
  });
});

describe("grouping from the panel", () => {
  it("offers what the store will actually group", () => {
    seed([node("a", 0, 0, 100, 40, "g1"), node("b", 10, 10, 100, 40)]);
    expect(groupableSelection(useGraphStore.getState().nodes)).toHaveLength(0);
    seed([node("a", 0, 0, 100, 40), node("b", 10, 10, 100, 40)]);
    expect(groupableSelection(useGraphStore.getState().nodes)).toHaveLength(2);
  });

  it("agrees with the store on which families can group", () => {
    expect(
      (["flowchart", "state", "architecture", "c4", "class"] as const).every(canGroup),
    ).toBe(true);
    expect(canGroup("sequence")).toBe(false);
    expect(canGroup("er")).toBe(false);
  });
});
