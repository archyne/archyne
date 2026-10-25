import { describe, expect, it } from "vitest";
import { GAP, spreadRuns } from "./spread";
import { crosses } from "./avoid";
import { segmentsOf, STUB } from "./orthogonal";
import type { Point } from "./routing";

const p = (x: number, y: number): Point => ({ x, y });

/** Where the vertical run of a route sits, for reading the fan-out. */
const verticalAt = (route: Point[]): number[] =>
  segmentsOf(route)
    .filter((r) => r.axis === "y")
    .map((r) => r.from.x);

describe("fanning out connections that share a corridor", () => {
  // Two routes taking the same halfway line: out, down the middle, and in.
  const one = [p(0, 0), p(200, 0), p(200, 300), p(400, 300)];
  const two = [p(0, 100), p(200, 100), p(200, 400), p(400, 400)];

  it("moves them apart", () => {
    const out = spreadRuns(
      new Map([
        ["a", one],
        ["b", two],
      ]),
    );
    const [first] = verticalAt(out.get("a")!);
    const [second] = verticalAt(out.get("b")!);
    expect(first).not.toBe(second);
    expect(Math.abs(first - second)).toBe(GAP);
  });

  it("leaves one exactly where the router put it — the one that avoids a crossing", () => {
    // Moving `b` aside would take its top run across `a`'s column; moving `a`
    // crosses nothing. Picking by name, it was `b` that moved.
    const out = spreadRuns(
      new Map([
        ["a", one],
        ["b", two],
      ]),
    );
    expect(verticalAt(out.get("b")!)).toEqual([200]);
    expect(verticalAt(out.get("a")!)).not.toEqual([200]);
  });

  it("does nothing to a corridor with one connection in it", () => {
    const out = spreadRuns(new Map([["a", one]]));
    expect(out.get("a")).toEqual(one);
  });

  it("leaves alone two runs on the same line that never meet", () => {
    // Both vertical at x = 200, but one is above the other.
    const above = [p(0, 0), p(200, 0), p(200, 100), p(400, 100)];
    const below = [p(0, 500), p(200, 500), p(200, 700), p(400, 700)];
    const out = spreadRuns(
      new Map([
        ["a", above],
        ["b", below],
      ]),
    );
    expect(out.get("a")).toEqual(above);
    expect(out.get("b")).toEqual(below);
  });

  it("ignores stubs, which are joins rather than corridors", () => {
    const stubby = [p(0, 0), p(10, 0), p(10, 8), p(20, 8)];
    const alike = [p(0, 40), p(10, 40), p(10, 48), p(20, 48)];
    const out = spreadRuns(
      new Map([
        ["a", stubby],
        ["b", alike],
      ]),
    );
    expect(out.get("a")).toEqual(stubby);
    expect(out.get("b")).toEqual(alike);
  });

  it("fans three apart on both sides of the first", () => {
    const three = [p(0, 200), p(200, 200), p(200, 500), p(400, 500)];
    const out = spreadRuns(
      new Map([
        ["a", one],
        ["b", two],
        ["c", three],
      ]),
    );
    const at = [
      verticalAt(out.get("a")!)[0],
      verticalAt(out.get("b")!)[0],
      verticalAt(out.get("c")!)[0],
    ];
    expect(new Set(at).size).toBe(3);
  });

  it("does not depend on the order the routes arrive in", () => {
    const forwards = spreadRuns(
      new Map([
        ["a", one],
        ["b", two],
      ]),
    );
    const backwards = spreadRuns(
      new Map([
        ["b", two],
        ["a", one],
      ]),
    );
    expect(verticalAt(backwards.get("a")!)).toEqual(verticalAt(forwards.get("a")!));
    expect(verticalAt(backwards.get("b")!)).toEqual(verticalAt(forwards.get("b")!));
  });

  it("moves each connection once, however many corridors it shares", () => {
    const long = [p(0, 0), p(200, 0), p(200, 300), p(400, 300), p(400, 600)];
    const rival = [p(0, 100), p(200, 100), p(200, 400), p(400, 400), p(400, 700)];
    const out = spreadRuns(
      new Map([
        ["a", long],
        ["b", rival],
      ]),
    );
    // The second route moved, and only its first shared run did.
    expect(out.get("b")).not.toEqual(rival);
    expect(segmentsOf(out.get("b")!).filter((r) => r.axis === "y").length).toBeGreaterThan(0);
  });
});

describe("what a corridor may not be moved into", () => {
  const p = (x: number, y: number): Point => ({ x, y });

  it("leaves an approach long enough for its arrowhead", () => {
    // Out of a face, along, and in again — with the corridor sitting exactly
    // one stub above the node it arrives at. Two of them, so one must move.
    const one = [p(0, 0), p(0, 80), p(200, 80), p(200, 100)];
    const two = [p(0, 20), p(0, 80), p(300, 80), p(300, 200)];
    const out = spreadRuns(
      new Map([
        ["a", one],
        ["b", two],
      ]),
    );
    // `b`'s corridor may drop as far as it likes; `a`'s cannot come nearer
    // than a stub to (200, 100) or the arrowhead ends up on the corner.
    for (const [, route] of out) {
      const last = route[route.length - 1];
      const before = route[route.length - 2];
      expect(Math.hypot(last.x - before.x, last.y - before.y)).toBeGreaterThanOrEqual(20);
    }
  });

  it("pushes a connection off a frame's border", () => {
    // A lone connection, running exactly along the bottom of a group.
    const along = [p(0, 300), p(400, 300)];
    const frame = { x: 0, y: 100, w: 500, h: 200 };
    const out = spreadRuns(new Map([["a", along]]), [frame]);
    // The two ends stay on the boxes they came from, each with a stub that
    // leaves its face square; the long run between them is what steps off
    // the border.
    const runs = segmentsOf(out.get("a")!).filter((r) => r.axis === "x");
    expect(runs).toHaveLength(3);
    expect(runs[0].from).toEqual(p(0, 300));
    expect(runs[0].to).toEqual(p(STUB, 300));
    expect(Math.abs(runs[1].from.y - 300)).toBe(GAP);
    expect(runs[2].from).toEqual(p(400 - STUB, 300));
    expect(runs[2].to).toEqual(p(400, 300));
  });

  it("keeps an approach square when it is the run that moves", () => {
    // Two connections leaving one face and running together the whole way:
    // the one that moves still sets off away from the face, not along it.
    const one = [p(0, 0), p(0, 200)];
    const two = [p(0, 0.5), p(0, 200)];
    const out = spreadRuns(
      new Map([
        ["a", one],
        ["b", two],
      ]),
    );
    const moved = out.get("b")!;
    expect(moved[0]).toEqual(p(0, 0.5));
    expect(moved[1].x).toBe(0);
    expect(moved[1].y - moved[0].y).toBeCloseTo(STUB);
    expect(moved[moved.length - 1]).toEqual(p(0, 200));
    expect(moved[moved.length - 2].x).toBe(0);
  });

  it("leaves a connection that only crosses a border alone", () => {
    // Straight through the frame rather than along it: nothing to hide in.
    const across = [p(250, 0), p(250, 400)];
    const frame = { x: 0, y: 100, w: 500, h: 200 };
    const out = spreadRuns(new Map([["a", across]]), [frame]);
    expect(out.get("a")).toEqual(across);
  });

  it("moves the connection and never the border", () => {
    const along = [p(0, 300), p(400, 300)];
    const frame = { x: 0, y: 100, w: 500, h: 200 };
    const out = spreadRuns(new Map([["a", along]]), [frame]);
    // Only the one route comes back; a frame is not a route and cannot be
    // returned as one.
    expect([...out.keys()]).toEqual(["a"]);
  });
});

describe("what a separation may not do", () => {
  it("never draws a run on the slant", () => {
    // `b` comes down to a corner and steps back up a few units before it
    // turns: two runs on one line. Moving the first moved the corner they
    // share, and the second was dragged off square.
    const a = [p(0, 0), p(0, 200), p(100, 200)];
    const b = [p(0.5, 0), p(0.5, 160), p(0.5, 150), p(-100, 150)];
    const out = spreadRuns(
      new Map([
        ["a", a],
        ["b", b],
      ]),
    );
    for (const route of out.values()) {
      expect(
        route.every(
          (q, i) =>
            i === 0 ||
            Math.abs(q.x - route[i - 1].x) < 0.5 ||
            Math.abs(q.y - route[i - 1].y) < 0.5,
        ),
      ).toBe(true);
    }
  });
});

describe("what a separation must leave alone", () => {
  it("never moves a run in towards the node it leaves", () => {
    // Out of a left face at x=100, a stub to x=80, then down a column shared
    // with another connection. The run moved in to x=89 — a stub of eleven,
    // and the room was checked on the wrong side.
    const a = [p(100, 0), p(80, 0), p(80, 300), p(300, 300)];
    const b = [p(100, 40), p(80, 40), p(80, 300.4), p(300, 300.4)];
    const out = spreadRuns(
      new Map([
        ["a", a],
        ["b", b],
      ]),
    );
    for (const route of out.values()) expect(route[1].x).toBeLessThanOrEqual(80);
  });

  it("does not push a lane across a node", () => {
    // A box on each side of the shared column, a lane's width off: one lane
    // either way runs through a box, and only two lanes clears it.
    const one = [p(0, 0), p(100, 0), p(100, 400), p(300, 400)];
    const two = [p(0, 50), p(100, 50), p(100, 400.4), p(300, 400.4)];
    const boxes = [
      { x: 85, y: 100, w: 10, h: 200 },
      { x: 105, y: 100, w: 10, h: 200 },
    ];
    const out = spreadRuns(
      new Map([
        ["one", one],
        ["two", two],
      ]),
      [],
      undefined,
      boxes,
    );
    for (const route of out.values()) {
      for (const box of boxes) {
        expect(route.every((q, i) => i === 0 || !crosses(route[i - 1], q, box))).toBe(true);
      }
    }
  });
});
