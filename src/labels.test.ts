import { beforeAll, describe, expect, it } from "vitest";
import { approximateTextMetrics, resetTextMetrics } from "./textMetrics";
import { midpointOf, placeLabels, plateBox, plateSize } from "./labels";
import type { Rect } from "./avoid";
import type { FlowEdge } from "./model/types";
import type { Point } from "./routing";

// jsdom has no canvas to measure with, and the exact width does not matter
// here — what matters is that every case measures the same way on every
// machine, so the placements a case asserts are the ones it will keep getting.
beforeAll(() => resetTextMetrics(approximateTextMetrics()));

const p = (x: number, y: number): Point => ({ x, y });

const edge = (id: string, label: string, moved?: Point): FlowEdge =>
  ({
    id,
    source: `${id}-from`,
    target: `${id}-to`,
    data: { label, ...(moved ? { style: { label: moved } } : {}) },
  }) as FlowEdge;

const hits = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("the middle of a route", () => {
  it("is measured by length, not by corner", () => {
    // Three corners: one short leg and one long one. The middle *corner* is at
    // x = 20, which is nowhere near halfway along.
    const route = [p(0, 0), p(20, 0), p(20, 200)];
    expect(midpointOf(route)).toEqual({ x: 20, y: 90 });
  });

  it("copes with a route that has nowhere to go", () => {
    expect(midpointOf([])).toEqual({ x: 0, y: 0 });
    expect(midpointOf([p(5, 5)])).toEqual({ x: 5, y: 5 });
  });
});

describe("placing labels", () => {
  const straight = [p(0, 0), p(400, 0)];

  it("leaves a label in the middle when the middle is free", () => {
    const out = placeLabels([edge("e1", "hello")], new Map([["e1", straight]]), []);
    expect(out.get("e1")!.at).toEqual({ x: 200, y: 0 });
  });

  it("slides a label off a box that is sitting on the middle of its route", () => {
    const box: Rect = { x: 170, y: -20, w: 60, h: 40 };
    const out = placeLabels([edge("e1", "hello")], new Map([["e1", straight]]), [box]);
    const placed = out.get("e1")!;
    expect(hits(placed.box, box)).toBe(false);
    // Along the route, not off it: a label that leaves its own line stops
    // saying which connection it belongs to.
    expect(placed.at.y).toBe(0);
    expect(placed.at.x).not.toBe(200);
  });

  it("moves two labels that would land on each other apart", () => {
    const routes = new Map([
      ["e1", straight],
      ["e2", [p(0, 6), p(400, 6)]],
    ]);
    const out = placeLabels([edge("e1", "hello"), edge("e2", "world")], routes, []);
    expect(hits(out.get("e1")!.box, out.get("e2")!.box)).toBe(false);
  });

  it("shoves each of them off centre rather than off its own line", () => {
    // Six units apart is one line to a reader and two to the arithmetic, and a
    // plate is twenty tall, so neither can sit centred without covering its
    // neighbour. Each slides sideways until the neighbour is clear, and stops
    // there — still on the line it names, which is the whole point.
    const routes = new Map([
      ["e1", straight],
      ["e2", [p(0, 6), p(400, 6)]],
    ]);
    const out = placeLabels([edge("e1", "hello"), edge("e2", "world")], routes, []);
    const covers = (r: Rect, y: number) => r.y <= y && y <= r.y + r.h;
    expect(covers(out.get("e1")!.box, 0)).toBe(true);
    expect(covers(out.get("e1")!.box, 6)).toBe(false);
    expect(covers(out.get("e2")!.box, 6)).toBe(true);
    expect(covers(out.get("e2")!.box, 0)).toBe(false);
  });

  it("places them the same way whichever order the edges arrive in", () => {
    const routes = new Map([
      ["e1", straight],
      ["e2", [p(0, 6), p(400, 6)]],
    ]);
    const one = placeLabels([edge("e1", "hello"), edge("e2", "world")], routes, []);
    const two = placeLabels([edge("e1", "hello"), edge("e2", "world")], routes, []);
    expect(two.get("e2")!.at).toEqual(one.get("e2")!.at);
  });

  it("never moves a label the user has dragged", () => {
    const box: Rect = { x: 170, y: -20, w: 60, h: 40 };
    const out = placeLabels([edge("e1", "hello", p(0, 5))], new Map([["e1", straight]]), [box]);
    // Straight through the obstacle, because that is where it was put.
    expect(out.get("e1")!.at).toEqual({ x: 200, y: 5 });
  });

  it("makes the others avoid it", () => {
    const routes = new Map([
      ["e1", straight],
      ["e2", [p(0, 4), p(400, 4)]],
    ]);
    // e2 is dragged nowhere in particular but is nailed down; e1 comes first
    // in the list and would otherwise take the middle and win.
    const out = placeLabels([edge("e1", "hello"), edge("e2", "world", p(0, 2))], routes, []);
    expect(out.get("e2")!.at).toEqual({ x: 200, y: 6 });
    expect(hits(out.get("e1")!.box, out.get("e2")!.box)).toBe(false);
  });

  it("steps off the line when the whole route is blocked", () => {
    // A wall the length of the route: nowhere along it is free.
    const wall: Rect = { x: -50, y: -20, w: 500, h: 40 };
    const out = placeLabels([edge("e1", "hello")], new Map([["e1", straight]]), [wall]);
    const placed = out.get("e1")!;
    expect(placed.at.x).toBe(200);
    expect(placed.at.y).not.toBe(0);
    expect(hits(placed.box, wall)).toBe(false);
  });

  it("still draws a label with nowhere clean to go", () => {
    // Boxed in on every side it can reach. The label has to be drawn
    // somewhere, and the least bad place is still a place.
    const everywhere: Rect = { x: -500, y: -500, w: 1500, h: 1000 };
    const out = placeLabels([edge("e1", "hello")], new Map([["e1", straight]]), [everywhere]);
    expect(out.size).toBe(1);
    expect(Number.isFinite(out.get("e1")!.at.x)).toBe(true);
  });

  it("prefers to sit on a node rather than on nothing at all", () => {
    // One box over half the route and a second, larger one over the rest: the
    // placement that overlaps least wins, not the first one tried.
    const near: Rect = { x: 150, y: -30, w: 100, h: 60 };
    const out = placeLabels([edge("e1", "hello")], new Map([["e1", straight]]), [near]);
    const placed = out.get("e1")!;
    expect(hits(placed.box, near)).toBe(false);
  });

  it("goes beside a connection too short to carry its own name", () => {
    // The plate is wider than the whole route, so sitting on it would cover
    // the connection entirely and the line would read as absent.
    const stub = [p(0, 0), p(30, 0)];
    const out = placeLabels([edge("e1", "a rather long name")], new Map([["e1", stub]]), []);
    const placed = out.get("e1")!;
    expect(placed.at.x).toBe(15);
    // Off the line, and far enough off that the whole plate clears it.
    expect(Math.abs(placed.at.y)).toBeGreaterThanOrEqual(placed.box.h / 2);
  });

  it("stays on a connection long enough to show either side of it", () => {
    const out = placeLabels([edge("e1", "ok")], new Map([["e1", straight]]), []);
    expect(out.get("e1")!.at).toEqual({ x: 200, y: 0 });
  });

  it("has nothing to place for an edge with no label", () => {
    const out = placeLabels([edge("e1", "")], new Map([["e1", straight]]), []);
    expect(out.size).toBe(0);
  });

  it("has nothing to place for a label whose edge has no route", () => {
    const out = placeLabels([edge("e1", "hello")], new Map(), []);
    expect(out.size).toBe(0);
  });
});

describe("the plate a label is drawn on", () => {
  it("is the text plus its padding", () => {
    const { w, h } = plateSize("hello");
    expect(w).toBeGreaterThan(12);
    expect(h).toBeGreaterThan(6);
  });

  it("is as tall as its lines and as wide as the widest", () => {
    // An imported port label: `6443<br/>HTTPS<br/>TLS1.2`. Measured as one
    // line, its plate was three times too wide and a third of the height.
    const one = plateSize("HTTPS");
    const three = plateSize("6443<br/>HTTPS<br/>TLS1.2");
    expect(three.h).toBeGreaterThan(one.h * 2);
    expect(three.w).toBeLessThan(plateSize("6443 HTTPS TLS1.2").w);
  });

  it("is centred on the point the label was placed at", () => {
    const box = plateBox("hello", p(100, 50));
    expect(box.x + box.w / 2).toBeCloseTo(100);
    expect(box.y + box.h / 2).toBeCloseTo(50);
  });
});

describe("a label and the connections it does not name", () => {
  it("does not sit on somebody else's line", () => {
    // Two connections crossing the same open space. The middle of `e1` is
    // free of boxes, but `e2` runs straight through it.
    const routes = new Map([
      ["e1", [p(0, 0), p(400, 0)]],
      ["e2", [p(200, -100), p(200, 100)]],
    ]);
    const out = placeLabels([edge("e1", "hello"), edge("e2", "")], routes, []);
    const box = out.get("e1")!.box;
    const onOther = routes
      .get("e2")!
      .every((q) => q.x < box.x || q.x > box.x + box.w || q.y < box.y || q.y > box.y + box.h);
    expect(onOther).toBe(true);
  });

  it("would rather cover its own line than a stranger's", () => {
    // `e1` is short and hemmed in on one side by `e2`. Covering its own line
    // leaves it unambiguous; covering `e2` would make it read as `e2`'s name.
    const routes = new Map([
      ["e1", [p(0, 0), p(60, 0)]],
      ["e2", [p(0, 30), p(60, 30)]],
    ]);
    const out = placeLabels([edge("e1", "a long enough name")], routes, []);
    const box = out.get("e1")!.box;
    const clearOfE2 = box.y + box.h < 30 || box.y > 30;
    expect(clearOfE2).toBe(true);
  });

  it("still counts its own line as its own", () => {
    // Nothing else in the drawing: the label takes the middle as usual.
    const out = placeLabels([edge("e1", "ok")], new Map([["e1", [p(0, 0), p(400, 0)]]]), []);
    expect(out.get("e1")!.at).toEqual({ x: 200, y: 0 });
  });
});

describe("a label and an arrowhead", () => {
  const straight = [p(0, 0), p(400, 0)];
  const half = () => plateSize("hello").h / 2;

  it("does not sit on the body of a head whose tip it misses", () => {
    // A connection coming up from below, through where the plate would be,
    // its tip just past the plate's top edge. Only the tip and the far end
    // used to count as the head, so a plate covering the rest of it was fine.
    const tipY = -half() - 2;
    const routes = new Map([
      ["e1", straight],
      ["e2", [p(200, 120), p(200, tipY)]],
    ]);
    const placed = placeLabels([edge("e1", "hello"), edge("e2", "")], routes, []).get("e1")!;
    expect(placed.at.y).toBe(0);
    expect(placed.at.x).not.toBe(200);
  });

  it("keeps a few units clear of one, not merely off it", () => {
    // A head ending just short of the plate: not covered, but a pixel's
    // difference in how the words are drawn would cover it.
    const tipY = half() + 3;
    const routes = new Map([
      ["e1", straight],
      ["e2", [p(200, 120), p(200, tipY)]],
    ]);
    const placed = placeLabels([edge("e1", "hello"), edge("e2", "")], routes, []).get("e1")!;
    expect(placed.at.x).not.toBe(200);
  });
});
