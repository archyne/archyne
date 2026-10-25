import { describe, expect, it } from "vitest";
import {
  BERTH_GAP,
  HEAD_ROOM,
  separateHeads,
  spreadBerths,
  straightenNearlyLevel,
} from "./berths";
import type { Rect } from "./avoid";
import type { Ends } from "./routes";

const hub: Rect = { x: 0, y: 0, w: 120, h: 60 };
const boxes = new Map<string, Rect>([
  ["hub", hub],
  ["a", { x: -200, y: -100, w: 60, h: 40 }],
  ["b", { x: -200, y: 0, w: 60, h: 40 }],
  ["c", { x: -200, y: 100, w: 60, h: 40 }],
]);

/** Three connections leaving the same face of `hub`, towards a, b and c. */
const leaving = (): Map<string, Ends> =>
  new Map(
    (
      [
        ["e1", "a", -80],
        ["e2", "b", 20],
        ["e3", "c", 120],
      ] as const
    ).map(([id, , y]) => [
      id,
      {
        start: { x: 0, y: 30 },
        end: { x: -140, y },
        from: "x",
        to: "x",
        fromSide: "left",
        toSide: "right",
      } satisfies Ends,
    ]),
  );

const edges = [
  { id: "e1", source: "hub", target: "a" },
  { id: "e2", source: "hub", target: "b" },
  { id: "e3", source: "hub", target: "c" },
];

describe("giving connections that share a face a place each", () => {
  it("moves them apart along it", () => {
    const out = spreadBerths(edges, leaving(), boxes);
    const ys = edges.map((e) => out.get(e.id)!.start.y);
    expect(new Set(ys).size).toBe(3);
  });

  it("keeps them on the face they were given", () => {
    const out = spreadBerths(edges, leaving(), boxes);
    for (const e of edges) {
      const at = out.get(e.id)!;
      expect(at.start.x).toBe(0);
      expect(at.start.y).toBeGreaterThanOrEqual(hub.y);
      expect(at.start.y).toBeLessThanOrEqual(hub.y + hub.h);
    }
  });

  it("spreads them about the middle, so the middle one keeps it", () => {
    const out = spreadBerths(edges, leaving(), boxes);
    expect(out.get("e2")!.start.y).toBe(30);
  });

  it("hands them out in the order their far ends lie, so they do not cross", () => {
    const out = spreadBerths(edges, leaving(), boxes);
    const ys = edges.map((e) => out.get(e.id)!.start.y);
    expect(ys).toEqual([...ys].sort((x, y) => x - y));
  });

  it("leaves a face with one connection on it exactly where it was", () => {
    const ends = leaving();
    const one = new Map([["e1", ends.get("e1")!]]);
    const out = spreadBerths([edges[0]], one, boxes);
    expect(out.get("e1")!.start).toEqual({ x: 0, y: 30 });
  });

  it("sets them a gap apart when the face has room for it", () => {
    const out = spreadBerths(edges, leaving(), boxes);
    const ys = edges.map((e) => out.get(e.id)!.start.y).sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBe(BERTH_GAP);
    expect(ys[2] - ys[1]).toBe(BERTH_GAP);
  });

  it("crowds them closer rather than off the end of a short face", () => {
    const short = new Map(boxes);
    short.set("hub", { x: 0, y: 0, w: 120, h: 24 });
    const ends = new Map(leaving());
    for (const [, at] of ends) at.start = { x: 0, y: 12 };
    const out = spreadBerths(edges, ends, short);
    const ys = edges.map((e) => out.get(e.id)!.start.y).sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBeLessThan(BERTH_GAP);
    expect(ys[0]).toBeGreaterThanOrEqual(0);
    expect(ys[2]).toBeLessThanOrEqual(24);
  });

  it("gives the two ends of one connection a place on each face", () => {
    // Both edges run hub -> a, so a's right face is shared as well.
    const pair = [
      { id: "e1", source: "hub", target: "a" },
      { id: "e2", source: "hub", target: "a" },
    ];
    const ends = new Map<string, Ends>(
      pair.map((e) => [
        e.id,
        {
          start: { x: 0, y: 30 },
          end: { x: -140, y: -80 },
          from: "x",
          to: "x",
          fromSide: "left",
          toSide: "right",
        } satisfies Ends,
      ]),
    );
    const out = spreadBerths(pair, ends, boxes);
    expect(out.get("e1")!.start.y).not.toBe(out.get("e2")!.start.y);
    expect(out.get("e1")!.end.y).not.toBe(out.get("e2")!.end.y);
  });

  it("says the same thing whichever order the edges arrive in", () => {
    const one = spreadBerths(edges, leaving(), boxes);
    const two = spreadBerths([...edges].reverse(), leaving(), boxes);
    for (const e of edges) expect(two.get(e.id)!.start).toEqual(one.get(e.id)!.start);
  });
});

describe("drawing a nearly level connection straight", () => {
  // Two boxes in a column, the lower one slightly narrower: their middles are
  // five units apart, and the connection was a Z with a five-unit step.
  const column = new Map<string, Rect>([
    ["top", { x: 0, y: 0, w: 160, h: 54 }],
    ["bottom", { x: 5, y: 140, w: 150, h: 54 }],
  ]);
  const down = (start: number, end: number): Ends => ({
    start: { x: start, y: 54 },
    end: { x: end, y: 140 },
    from: "y",
    to: "y",
    fromSide: "bottom",
    toSide: "top",
  });

  it("lines the two ends up", () => {
    const out = straightenNearlyLevel(
      [{ id: "e", source: "top", target: "bottom" }],
      new Map([["e", down(80, 75)]]),
      column,
    );
    const at = out.get("e")!;
    expect(at.start.x).toBe(at.end.x);
  });

  it("leaves a real offset alone", () => {
    const out = straightenNearlyLevel(
      [{ id: "e", source: "top", target: "bottom" }],
      new Map([["e", down(80, 40)]]),
      column,
    );
    expect(out.get("e")).toEqual(down(80, 40));
  });

  it("moves the other end when this one would crowd a neighbour", () => {
    // Two connections arriving at the bottom box sixteen apart. Lining e1 up
    // by moving its arrival would put it eight from e2's; its departure has
    // the top face to itself bar e2's, far off, so that is the end that moves.
    const edges = [
      { id: "e1", source: "top", target: "bottom" },
      { id: "e2", source: "top", target: "bottom" },
    ];
    const ends = new Map([
      ["e1", down(80, 72)],
      ["e2", down(120, 88)],
    ]);
    const out = straightenNearlyLevel(edges, ends, column);
    expect(out.get("e1")!.end.x).toBe(72);
    expect(out.get("e1")!.start.x).toBe(72);
    expect(out.get("e2")).toEqual(down(120, 88));
  });

  it("moves an end only to where its node's outline lies on the face", () => {
    // A diamond touches its box at one point per face; anywhere else on the
    // face the line would stop in the air.
    const out = straightenNearlyLevel(
      [{ id: "e", source: "top", target: "bottom" }],
      new Map([["e", down(80, 75)]]),
      column,
      undefined,
      () => false,
    );
    expect(out.get("e")).toEqual(down(80, 75));
  });
});

describe("keeping arrowheads on one face apart", () => {
  const target: Rect = { x: 0, y: 0, w: 200, h: 60 };
  const into = (x: number): Ends => ({
    start: { x, y: -100 },
    end: { x, y: 0 },
    from: "y",
    to: "y",
    fromSide: "bottom",
    toSide: "top",
  });
  const boxesHere = new Map<string, Rect>([["t", target]]);
  const edges3 = ["a", "b", "c"].map((id) => ({ id, source: id, target: "t" }));

  it("pushes heads that landed on one spot apart, keeping their order", () => {
    // Lined up with corners that all stood at the middle of the face.
    const ends = new Map([
      ["a", into(98)],
      ["b", into(100)],
      ["c", into(102)],
    ]);
    const out = separateHeads(edges3, ends, boxesHere);
    const xs = ["a", "b", "c"].map((id) => out.get(id)!.end.x);
    expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(HEAD_ROOM - 0.01);
    expect(xs[2] - xs[1]).toBeGreaterThanOrEqual(HEAD_ROOM - 0.01);
  });

  it("leaves heads already apart where they are", () => {
    const ends = new Map([
      ["a", into(40)],
      ["b", into(100)],
      ["c", into(160)],
    ]);
    expect(separateHeads(edges3, ends, boxesHere)).toEqual(ends);
  });

  it("shares out a face too short for all of them evenly", () => {
    const small = new Map<string, Rect>([["t", { x: 0, y: 0, w: 20, h: 20 }]]);
    const ends = new Map([
      ["a", into(10)],
      ["b", into(10)],
      ["c", into(10)],
    ]);
    const xs = ["a", "b", "c"].map((id) => separateHeads(edges3, ends, small).get(id)!.end.x);
    expect(new Set(xs).size).toBe(3);
    expect(xs.every((x) => x >= 0 && x <= 20)).toBe(true);
  });

  it("does not push a head onto the start of another line", () => {
    // `out` leaves the top face at x=100; two heads arrive near it. Parted
    // from each other with only the heads in view, one landed on `out`'s
    // start and the two lines lay on top of each other.
    const leaving: Ends = {
      start: { x: 100, y: 0 },
      end: { x: 100, y: -300 },
      from: "y",
      to: "y",
      fromSide: "top",
      toSide: "bottom",
    };
    const ends = new Map([
      ["out", leaving],
      ["a", into(90)],
      ["b", into(92)],
    ]);
    const edges = [
      { id: "out", source: "t", target: "far" },
      { id: "a", source: "a", target: "t" },
      { id: "b", source: "b", target: "t" },
    ];
    const out = separateHeads(edges, ends, boxesHere);
    const xs = [out.get("out")!.start.x, out.get("a")!.end.x, out.get("b")!.end.x].sort(
      (m, n) => m - n,
    );
    expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(HEAD_ROOM - 0.01);
    expect(xs[2] - xs[1]).toBeGreaterThanOrEqual(HEAD_ROOM - 0.01);
  });

  it("sets lines leaving one face off from different points", () => {
    // Lined up with one shared corner, three lines left from one spot and
    // lay on each other for their first stub.
    const leave = (x: number): Ends => ({
      start: { x, y: 60 },
      end: { x, y: 400 },
      from: "y",
      to: "y",
      fromSide: "bottom",
      toSide: "top",
    });
    const ends = new Map([
      ["a", leave(100)],
      ["b", leave(100)],
      ["c", leave(100)],
    ]);
    const edges = ["a", "b", "c"].map((id) => ({ id, source: "t", target: `far-${id}` }));
    const out = separateHeads(edges, ends, boxesHere);
    const xs = ["a", "b", "c"].map((id) => out.get(id)!.start.x).sort((m, n) => m - n);
    expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(HEAD_ROOM - 0.01);
    expect(xs[2] - xs[1]).toBeGreaterThanOrEqual(HEAD_ROOM - 0.01);
  });
});
