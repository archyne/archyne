import { describe, expect, it } from "vitest";
import {
  attachPoint,
  axisOfSide,
  bestSides,
  facesAway,
  carryWaypoints,
  moveSegment,
  orthogonalRoute,
  prune,
  segmentsOf,
  slideRun,
  STUB,
  tidy,
  withStubs,
} from "./orthogonal";
import type { Point } from "./routing";

const p = (x: number, y: number): Point => ({ x, y });
/** Every run is horizontal or vertical — the property the whole file is for. */
const isOrthogonal = (route: Point[]): boolean =>
  route.every(
    (q, i) =>
      i === 0 || Math.abs(q.x - route[i - 1].x) < 0.5 || Math.abs(q.y - route[i - 1].y) < 0.5,
  );

describe("which way a run travels", () => {
  it("leaves the sides sideways and the ends vertically", () => {
    expect(axisOfSide("left")).toBe("x");
    expect(axisOfSide("right")).toBe("x");
    expect(axisOfSide("top")).toBe("y");
    expect(axisOfSide("bottom")).toBe("y");
  });
});

describe("which faces two boxes should be joined by", () => {
  const box = (x: number, y: number, w = 100, h = 60) => ({ x, y, w, h });

  it("joins side to side when the boxes are apart across", () => {
    expect(bestSides(box(0, 0), box(400, 20))).toEqual({ from: "right", to: "left" });
    expect(bestSides(box(400, 0), box(0, 20))).toEqual({ from: "left", to: "right" });
  });

  it("joins end to end when they are apart down the page", () => {
    expect(bestSides(box(0, 0), box(20, 400))).toEqual({ from: "bottom", to: "top" });
    expect(bestSides(box(0, 400), box(20, 0))).toEqual({ from: "top", to: "bottom" });
  });

  it("uses the ends for a column, even when one box is wider", () => {
    // Centres 300 apart down the page and 10 across: the boxes share their
    // x range, so there are no sides to speak of.
    expect(bestSides(box(0, 0, 200, 60), box(10, 300, 100, 60))).toEqual({
      from: "bottom",
      to: "top",
    });
  });

  it("uses the sides for a row, even when one box is taller", () => {
    expect(bestSides(box(0, 0, 100, 200), box(300, 10, 100, 60))).toEqual({
      from: "right",
      to: "left",
    });
  });

  it("uses the other faces when the nearer pair has no room for the stubs", () => {
    // Wide boxes, side by side ten units apart across but far apart down the
    // page. The sides face each other across a gap too narrow to leave one
    // and arrive at the other square, and the route went round the outside of
    // both; the ends have all the room in the world.
    expect(bestSides(box(0, 0, 300, 60), box(310, 200, 300, 60))).toEqual({
      from: "bottom",
      to: "top",
    });
  });

  it("keeps the nearer pair when neither has room", () => {
    expect(bestSides(box(0, 0, 300, 60), box(310, 70, 300, 60))).toEqual({
      from: "right",
      to: "left",
    });
  });

  it("answers for boxes lying on top of one another rather than refusing", () => {
    const sides = bestSides(box(0, 0), box(10, 10));
    expect(["left", "right", "top", "bottom"]).toContain(sides.from);
    expect(["left", "right", "top", "bottom"]).toContain(sides.to);
  });
});

describe("where a connection meets a box", () => {
  const r = { x: 100, y: 200, w: 80, h: 40 };

  it("meets the middle of the face it is given", () => {
    expect(attachPoint(r, "left")).toEqual(p(100, 220));
    expect(attachPoint(r, "right")).toEqual(p(180, 220));
    expect(attachPoint(r, "top")).toEqual(p(140, 200));
    expect(attachPoint(r, "bottom")).toEqual(p(140, 240));
  });

  it("hands the axis of that face to the router", () => {
    expect(axisOfSide("right")).toBe("x");
    expect(axisOfSide("bottom")).toBe("y");
  });
});

describe("noticing that a named face points the wrong way", () => {
  const box = (x: number, y: number, w = 100, h = 60) => ({ x, y, w, h });

  it("is content when the other node lies that way", () => {
    expect(facesAway(box(0, 0), "right", box(300, 0))).toBe(false);
    expect(facesAway(box(300, 0), "left", box(0, 0))).toBe(false);
  });

  it("objects when the other node is the other way entirely", () => {
    // What happens when a node is dragged round to the far side: obeying the
    // named face means setting off away from it and coming back across.
    expect(facesAway(box(300, 0), "right", box(0, 0))).toBe(true);
    expect(facesAway(box(0, 0), "left", box(300, 0))).toBe(true);
  });

  it("is content when the two are level, which is not behind", () => {
    // Two boxes in a column joined right to right: neither is behind the
    // other, and the author's choice stands.
    expect(facesAway(box(0, 0), "right", box(0, 200))).toBe(false);
  });

  it("reads the same way on the vertical faces", () => {
    expect(facesAway(box(0, 0), "bottom", box(0, 300))).toBe(false);
    expect(facesAway(box(0, 300), "bottom", box(0, 0))).toBe(true);
    expect(facesAway(box(0, 300), "top", box(0, 0))).toBe(false);
  });
});

describe("stepping away from a node before turning", () => {
  it("adds nothing to a connection that already leaves its face", () => {
    // Out of a right side towards a node well to the right: the first leg
    // already goes that way.
    const anchors = [p(100, 50), p(400, 90)];
    expect(withStubs(anchors, "right", "left")).toEqual(anchors);
  });

  it("steps out when the two faces share a line", () => {
    // Two nodes stacked, joined right side to right side: the route was a
    // straight drop down the border, with the arrowhead flat against the box.
    const out = withStubs([p(118, 67), p(118, 174)], "right", "right");
    expect(out).toEqual([p(118, 67), p(138, 67), p(118, 174)]);
  });

  it("steps out of the arrival face too, when the line comes the wrong way", () => {
    const out = withStubs([p(0, 0), p(200, 0)], "right", "right");
    expect(out[out.length - 2]).toEqual(p(220, 0));
    expect(out[out.length - 1]).toEqual(p(200, 0));
  });

  it("measures the step from the face it leaves, whichever that is", () => {
    expect(withStubs([p(50, 100), p(50, 100)], "top", "top")[1]).toEqual(p(50, 80));
    expect(withStubs([p(50, 100), p(50, 100)], "bottom", "bottom")[1]).toEqual(p(50, 120));
  });

  it("has nothing to step away from with fewer than two points", () => {
    expect(withStubs([p(1, 2)], "left", "right")).toEqual([p(1, 2)]);
  });
});

describe("tidying a path", () => {
  it("drops a repeated point", () => {
    expect(tidy([p(0, 0), p(0, 0), p(10, 0)])).toEqual([p(0, 0), p(10, 0)]);
  });

  it("drops the middle of three in a line", () => {
    expect(tidy([p(0, 0), p(50, 0), p(100, 0)])).toEqual([p(0, 0), p(100, 0)]);
  });

  it("keeps a real corner", () => {
    expect(tidy([p(0, 0), p(100, 0), p(100, 50)])).toHaveLength(3);
  });

  it("keeps a point that shares the line but overshoots it", () => {
    // All three at x = 100, but the middle one is 200 below both its
    // neighbours: the path goes down to it and back, and dropping it would
    // cut the journey short and strand the handle drawn there.
    expect(tidy([p(100, 0), p(100, 300), p(100, 100)])).toHaveLength(3);
    expect(tidy([p(0, 50), p(300, 50), p(100, 50)])).toHaveLength(3);
  });

  it("keeps going after a removal, so three in a row collapse to two", () => {
    expect(tidy([p(0, 0), p(10, 0), p(20, 0), p(30, 0)])).toEqual([p(0, 0), p(30, 0)]);
  });
});

describe("routing a connection orthogonally", () => {
  it("leaves on the axis it is told to", () => {
    // Out of a right-hand side and into a left one: across, over at the
    // halfway line, and across again.
    expect(orthogonalRoute([p(0, 0), p(100, 50)], "x", "x")).toEqual([
      p(0, 0),
      p(50, 0),
      p(50, 50),
      p(100, 50),
    ]);
    // Out of a bottom and into a top: the same turned on its side.
    expect(orthogonalRoute([p(0, 0), p(100, 50)], "y", "y")).toEqual([
      p(0, 0),
      p(0, 25),
      p(100, 25),
      p(100, 50),
    ]);
  });

  it("turns once when it leaves and arrives on different axes", () => {
    // Out of a side and into a top: there is nothing to balance, one corner
    // is the whole journey.
    expect(orthogonalRoute([p(0, 0), p(100, 50)], "x", "y")).toEqual([
      p(0, 0),
      p(100, 0),
      p(100, 50),
    ]);
  });

  it("keeps the halfway jog clear of both nodes", () => {
    const route = orthogonalRoute([p(0, 0), p(200, 80)], "x", "x");
    expect(route[1].x).toBe(100);
    expect(route[2].x).toBe(100);
  });

  it("puts no corner in a run that is already straight", () => {
    expect(orthogonalRoute([p(0, 0), p(0, 80)], "y", "y")).toEqual([p(0, 0), p(0, 80)]);
    expect(orthogonalRoute([p(0, 0), p(80, 0)], "x", "x")).toEqual([p(0, 0), p(80, 0)]);
  });

  it("arrives along the axis of the side it is entering", () => {
    // Into a left-hand side, so the last run must be horizontal.
    const route = orthogonalRoute([p(0, 0), p(120, 90)], "y", "x");
    expect(route[route.length - 1]).toEqual(p(120, 90));
    const lastRun = route[route.length - 2];
    expect(lastRun.y).toBe(90);
  });

  it("is orthogonal throughout, corners and all", () => {
    const route = orthogonalRoute([p(0, 0), p(60, 40), p(20, 120), p(140, 200)], "x", "y");
    expect(isOrthogonal(route)).toBe(true);
  });

  it("passes through every corner the user placed", () => {
    const waypoints = [p(60, 40), p(20, 120)];
    const route = orthogonalRoute([p(0, 0), ...waypoints, p(140, 200)], "x", "y");
    for (const w of waypoints) {
      expect(route.some((q) => q.x === w.x && q.y === w.y)).toBe(true);
    }
  });

  it("alternates rather than doubling back through a corner", () => {
    // Arriving vertically at (60,40), the next run sets off horizontally.
    const route = orthogonalRoute([p(0, 0), p(60, 40), p(140, 90)], "x", "y");
    const at = route.findIndex((q) => q.x === 60 && q.y === 40);
    expect(at).toBeGreaterThan(0);
    expect(route[at + 1].y).toBe(40);
  });

  it("survives a route with nothing in it", () => {
    expect(orthogonalRoute([], "x", "x")).toEqual([]);
    expect(orthogonalRoute([p(5, 5)], "x", "x")).toEqual([p(5, 5)]);
  });

  it("survives both ends in the same place", () => {
    expect(orthogonalRoute([p(10, 10), p(10, 10)], "x", "y")).toEqual([p(10, 10)]);
  });
});

describe("sliding a run sideways", () => {
  // Out of a right side, across, down, and into a left side.
  const route = [p(0, 0), p(100, 0), p(100, 200), p(200, 200)];

  it("moves a vertical run left and right, and the runs either side follow", () => {
    const moved = moveSegment(route, 1, 60);
    expect(moved).toEqual([p(0, 0), p(60, 0), p(60, 200), p(200, 200)]);
  });

  it("leaves everything else where it was", () => {
    const moved = moveSegment(route, 1, 60);
    expect(moved[0]).toEqual(p(0, 0));
    expect(moved[moved.length - 1]).toEqual(p(200, 200));
  });

  it("stays orthogonal", () => {
    expect(isOrthogonal(moveSegment(route, 1, 60))).toBe(true);
    expect(isOrthogonal(moveSegment(route, 0, 40))).toBe(true);
    expect(isOrthogonal(moveSegment(route, 2, 150))).toBe(true);
  });

  it("cannot drag the source along, so it turns off it instead", () => {
    // The first run is horizontal at y = 0 and leaves the source at (0,0).
    // Dragged to y = 40 the source stays put and a corner appears beside it.
    const moved = moveSegment(route, 0, 40);
    expect(moved[0]).toEqual(p(0, 0));
    expect(moved[1]).toEqual(p(0, 40));
    expect(moved[2]).toEqual(p(100, 40));
  });

  it("does the same at the target end", () => {
    const moved = moveSegment(route, 2, 260);
    expect(moved[moved.length - 1]).toEqual(p(200, 200));
    expect(moved[moved.length - 2]).toEqual(p(200, 260));
  });

  it("turns a single run into a Z when it is dragged off both its ends", () => {
    const straight = [p(0, 0), p(200, 0)];
    const moved = moveSegment(straight, 0, 80);
    expect(moved).toEqual([p(0, 0), p(0, 80), p(200, 80), p(200, 0)]);
  });

  it("ignores a run that is not there", () => {
    expect(moveSegment(route, 9, 10)).toBe(route);
  });

  it("leaves a path it has already routed alone, so dragging is repeatable", () => {
    const moved = moveSegment(route, 1, 60);
    expect(orthogonalRoute(moved, "x", "x")).toEqual(moved);
  });
});

describe("what gets stored when a run is slid", () => {
  // Source at (0,0), one corner of the user's at (100,200), target (300,200).
  const stored = [p(100, 200)];
  const drawn = [p(0, 0), p(100, 0), p(100, 200), p(300, 200)];

  it("moves the corner that is already on the run, and adds none", () => {
    // The vertical run x = 100 carries the stored corner.
    const next = slideRun(stored, drawn, 1, 160);
    expect(next).toEqual([p(160, 200)]);
  });

  it("pins a run of the router's own with two corners, not the whole path", () => {
    // The first run is horizontal at y = 0 and has nothing of the user's.
    const next = slideRun(stored, drawn, 0, 40);
    expect(next).toHaveLength(3);
    expect(next.every((q) => q.y === 40 || q.x === 100)).toBe(true);
  });

  it("does not grow without end when the same run is slid twice", () => {
    const once = slideRun(stored, drawn, 1, 160);
    const drawnAgain = [p(0, 0), p(160, 0), p(160, 200), p(300, 200)];
    const twice = slideRun(once, drawnAgain, 1, 220);
    expect(twice).toEqual([p(220, 200)]);
  });

  it("leaves the list alone when the run does not exist", () => {
    expect(slideRun(stored, drawn, 9, 10)).toBe(stored);
  });

  it("keeps corners that are nowhere near the run", () => {
    const many = [p(100, 200), p(400, 500)];
    expect(slideRun(many, drawn, 1, 160)).toEqual([p(160, 200), p(400, 500)]);
  });

  it("stops the run at the face it leaves from rather than folding over it", () => {
    // Dragged back past the source at x = 0. The line still has to come out
    // of that face, so a path through x = 5 would leave, turn, and come back
    // over the node — a fold drawn as segments doubling over each other.
    expect(slideRun(stored, drawn, 1, 5)).toEqual([p(STUB, 200)]);
  });

  it("stops it at the face it arrives at, too", () => {
    expect(slideRun(stored, drawn, 1, 295)).toEqual([p(300 - STUB, 200)]);
  });

  it("holds a pinning corner clear of the point the route hangs from", () => {
    // A route that turns nine units off its node before its first corridor.
    // Pinning that corridor at the corner it starts from puts a corner on the
    // node's own x — and since the face a route leaves by is worked out from
    // its corners, adding one there can move the exit to another side, with
    // the corner now behind the line. The route then leaves, comes back to
    // collect it, and leaves again.
    const off = [p(0, 0), p(0, 9), p(-300, 9), p(-300, 100)];
    const next = slideRun([], off, 1, 60);
    expect(next).toEqual([p(-STUB, 60), p(-300 + STUB, 60)]);
    expect(next.every((q) => q.x !== 0 && q.x !== -300)).toBe(true);
  });

  it("does nothing to a run too short to be pinned clear of both ends", () => {
    // Two boxes forty units apart, joined by one straight hop. Both legs are
    // `STUB` long, so they use up the whole gap: there is no path that bows
    // this line around anything, and the drag has to be refused rather than
    // answered with a spike out and straight back.
    const hop = [p(0, 0), p(2 * STUB, 0)];
    expect(slideRun([], hop, 0, -70)).toEqual([]);
  });

  it("still lets a run cross a face it is not attached to", () => {
    // A run in the middle of a longer path touches neither face, so it can
    // be taken anywhere — the fold the bound guards against cannot happen.
    const long = [p(0, 0), p(100, 0), p(100, 200), p(300, 200), p(300, 400), p(500, 400)];
    expect(slideRun([p(100, 200), p(300, 200)], long, 2, 5)).toEqual([p(100, 5), p(300, 5)]);
  });
});

describe("keeping the corner list to the minimum that draws the line", () => {
  const source = p(0, 0);
  const target = p(300, 200);

  it("throws away a corner the router would have put there anyway", () => {
    // The jog at the halfway line is exactly what routing from a right side
    // to a left one produces unaided, so storing it says nothing.
    const kept = prune([p(150, 0)], source, target, "x", "x");
    expect(kept).toEqual([]);
  });

  it("keeps a corner that is the only reason the line goes that way", () => {
    const kept = prune([p(150, 400)], source, target, "x", "x");
    expect(kept).toEqual([p(150, 400)]);
  });

  it("draws the same line after pruning as before", () => {
    const stored = [p(0, 60), p(300, 60), p(300, 120)];
    const before = orthogonalRoute([source, ...stored, target], "x", "x");
    const kept = prune(stored, source, target, "x", "x");
    expect(orthogonalRoute([source, ...kept, target], "x", "x")).toEqual(before);
  });

  it("takes a list swollen by repeated pinning back down", () => {
    // What sliding four runs in turn leaves behind: mostly corners that only
    // repeat what the ones around them already say.
    const swollen = [p(0, 60), p(150, 60), p(150, 60), p(150, 140), p(300, 140)];
    const kept = prune(swollen, source, target, "x", "x");
    expect(kept.length).toBeLessThan(swollen.length);
  });

  it("has nothing to do with an empty list", () => {
    expect(prune([], source, target, "x", "x")).toEqual([]);
  });
});

describe("carrying the corners when the nodes move", () => {
  const corners = [p(100, 0), p(100, 200), p(300, 200)];
  const still = p(0, 0);

  it("does nothing when nothing moved", () => {
    expect(carryWaypoints(corners, still, still)).toBe(corners);
  });

  it("shifts every corner alike when both ends move together", () => {
    // Dragging a group takes both nodes; the connection between them should
    // arrive looking exactly as it left.
    const by = p(50, -30);
    expect(carryWaypoints(corners, by, by)).toEqual([p(150, -30), p(150, 170), p(350, 170)]);
  });

  it("moves the near corner most when only the source moves", () => {
    const moved = carryWaypoints(corners, p(100, 0), still);
    const shifted = moved.map((q, i) => q.x - corners[i].x);
    expect(shifted[0]).toBeGreaterThan(shifted[1]);
    expect(shifted[1]).toBeGreaterThan(shifted[2]);
    expect(shifted[2]).toBeGreaterThan(0);
  });

  it("moves the far corner most when only the target moves", () => {
    const moved = carryWaypoints(corners, still, p(0, 100));
    const shifted = moved.map((q, i) => q.y - corners[i].y);
    expect(shifted[2]).toBeGreaterThan(shifted[1]);
    expect(shifted[1]).toBeGreaterThan(shifted[0]);
  });

  it("never hands a corner the whole of one end's movement", () => {
    // A corner is a point of its own; it does not sit on either node.
    const moved = carryWaypoints([p(50, 50)], p(200, 0), still);
    expect(moved[0].x).toBeGreaterThan(50);
    expect(moved[0].x).toBeLessThan(250);
  });

  it("has nothing to carry on a straight edge", () => {
    expect(carryWaypoints([], p(10, 10), p(5, 5))).toEqual([]);
  });
});

describe("the runs of a path", () => {
  const route = [p(0, 0), p(100, 0), p(100, 50)];

  it("names each run's direction", () => {
    expect(segmentsOf(route).map((s) => s.axis)).toEqual(["x", "y"]);
  });

  it("puts the handle in the middle of the run", () => {
    expect(segmentsOf(route)[0].mid).toEqual(p(50, 0));
    expect(segmentsOf(route)[1].mid).toEqual(p(100, 25));
  });

  it("indexes a run by the point it starts at", () => {
    expect(segmentsOf(route).map((s) => s.index)).toEqual([0, 1]);
  });

  it("has one fewer run than there are points", () => {
    expect(segmentsOf([p(0, 0)])).toHaveLength(0);
  });
});
