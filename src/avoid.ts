/**
 * Routing a connection *around* the boxes in its way.
 *
 * `orthogonal.ts` squares a path off; this decides where the path should go
 * when a node stands in the middle of it. Visio and draw.io both do this, and
 * without it a connector between two distant nodes drives straight through
 * everything between them.
 *
 * The method is the usual one for orthogonal connectors, and it is worth
 * stating because the shape of the code follows from it. A path that avoids
 * rectangles only ever needs to turn on a line that grazes one of them, so
 * rather than searching open space we build the small lattice of those lines
 * — every obstacle's four sides, pushed out by a clearance, plus the two
 * endpoints — and search that. A dozen nodes make a lattice of a few hundred
 * points, which is nothing.
 *
 * Cost is length plus a charge per turn. The charge is what makes the result
 * look drawn rather than computed: of two paths the same length, the one with
 * fewer corners wins, and a detour is taken only when it is genuinely
 * shorter than the bends it saves.
 *
 * No React, no store — arithmetic, tested as arithmetic.
 */
import { tidy, type Axis } from "./orthogonal";
import type { Point } from "./routing";

/** A box to stay out of. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How far a path keeps off a box it is passing, in canvas units. */
export const CLEARANCE = 14;

/**
 * How much a corner costs, as a length. High enough that the router will go
 * a long way round to save one, which is what stops it staircasing.
 */
const BEND_COST = 40;

/** Beyond this many boxes near a path the lattice stops being cheap; the caller falls back. */
const TOO_MANY = 60;

const grown = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
});

/** Strictly inside — touching the edge is allowed, that is what clearance is for. */
function inside(p: Point, r: Rect): boolean {
  return p.x > r.x + 0.5 && p.x < r.x + r.w - 0.5 && p.y > r.y + 0.5 && p.y < r.y + r.h - 0.5;
}

/**
 * Does the axis-aligned run `a`–`b` pass through `r`?
 *
 * Touching a side is not passing through it: two boxes placed flush leave a
 * line between them that a path is entitled to use.
 */
export function crosses(a: Point, b: Point, r: Rect): boolean {
  const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
  const hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
  return (
    lo.x < r.x + r.w - 0.5 && hi.x > r.x + 0.5 && lo.y < r.y + r.h - 0.5 && hi.y > r.y + 0.5
  );
}

/** Is any part of this run blocked? */
export function blocked(a: Point, b: Point, obstacles: Rect[]): boolean {
  return obstacles.some((r) => crosses(a, b, r));
}

const sortedUnique = (values: number[]): number[] =>
  [...new Set(values.map((v) => Math.round(v)))].sort((m, n) => m - n);

/** A place the path may turn, and the direction it was travelling on arrival. */
interface State {
  at: number; // index into the lattice
  dir: Axis;
  /** Which way along `dir`: +1 towards larger coordinates, -1 towards smaller. */
  sign: number;
}

const key = (s: State): string => `${s.at}:${s.dir}${s.sign}`;

/**
 * An orthogonal path from `a` to `b` that touches none of `obstacles`,
 * leaving along `from` and arriving along `to`.
 *
 * `leave` and `arrive`, when given, also fix *which way* along those axes:
 * the direction the path is already travelling at `a`, and the one it must be
 * travelling in at `b`. A path never turns straight back on itself, so a
 * search starting a stub out from a face cannot step back towards it — that
 * step is free, being on the axis it set out on, and it drew a spike at the
 * node: out, back a few units, and only then away.
 *
 * Returns the corners including both ends, or `null` when there is no way
 * through — a node sitting on the target, most often — so the caller can fall
 * back to the direct route rather than draw nothing.
 */
export function routeAround(
  a: Point,
  b: Point,
  from: Axis,
  to: Axis,
  obstacles: Rect[],
  clearance = CLEARANCE,
  leave?: Point,
  arrive?: Point,
): Point[] | null {
  if (obstacles.length === 0) return null;
  // Only the boxes near the two ends take part, widening the neighbourhood
  // when the path found there runs into one left out. The cap below is on
  // the search, not on the diagram: applied to every box on the page, it
  // switched the search off for any drawing of more than sixty nodes — which
  // is to say every busy one — and their connections went straight through.
  for (const margin of NEIGHBOURHOODS) {
    const near =
      margin === Infinity ? obstacles : obstacles.filter((r) => meets(r, around(a, b, margin)));
    if (near.length === 0) continue;
    if (near.length > TOO_MANY) return null;
    const found = search(a, b, from, to, near, clearance, leave, arrive);
    // Fewer boxes is more room: no way through these is no way through all.
    if (!found) return null;
    if (found.every((q, i) => i === 0 || !blocked(found[i - 1], q, obstacles))) return found;
  }
  return null;
}

/** How far round the two ends the boxes that matter are looked for, in turn. */
const NEIGHBOURHOODS = [160, 480, Infinity];

/** The box spanning two points, grown by `by` on every side. */
function around(a: Point, b: Point, by: number): Rect {
  const x = Math.min(a.x, b.x) - by;
  const y = Math.min(a.y, b.y) - by;
  return { x, y, w: Math.abs(a.x - b.x) + by * 2, h: Math.abs(a.y - b.y) + by * 2 };
}

/** Do two boxes share any area? */
function meets(r: Rect, s: Rect): boolean {
  return r.x < s.x + s.w && s.x < r.x + r.w && r.y < s.y + s.h && s.y < r.y + r.h;
}

/** The search itself, over the boxes it is given. */
function search(
  a: Point,
  b: Point,
  from: Axis,
  to: Axis,
  obstacles: Rect[],
  clearance: number,
  leave?: Point,
  arrive?: Point,
): Point[] | null {
  const walls = obstacles.map((r) => grown(r, clearance));

  // The lines worth turning on: every wall's sides, and the ends themselves —
  // and, where a direction is fixed, one a little way along it from each end.
  // A path told to arrive travelling downwards has to come from somewhere
  // above the goal, and with no wall up there the lattice had no line to come
  // from, so it found nothing at all.
  const ahead = Math.max(clearance, 1);
  const extra: Point[] = [];
  if (leave)
    extra.push({ x: a.x + Math.sign(leave.x) * ahead, y: a.y + Math.sign(leave.y) * ahead });
  if (arrive) {
    extra.push({ x: b.x - Math.sign(arrive.x) * ahead, y: b.y - Math.sign(arrive.y) * ahead });
  }
  const xs = sortedUnique([
    a.x,
    b.x,
    ...extra.map((q) => q.x),
    ...walls.flatMap((r) => [r.x, r.x + r.w]),
  ]);
  const ys = sortedUnique([
    a.y,
    b.y,
    ...extra.map((q) => q.y),
    ...walls.flatMap((r) => [r.y, r.y + r.h]),
  ]);

  const lattice: Point[] = [];
  const indexOf = new Map<string, number>();
  for (const y of ys) {
    for (const x of xs) {
      const p = { x, y };
      // A point buried in a box is no use, but the ends stay whatever
      // happens: a node's own handle sits on its edge, and one nudged inside
      // by rounding must not disqualify the whole route.
      if (walls.some((r) => inside(p, r))) continue;
      indexOf.set(`${x},${y}`, lattice.length);
      lattice.push(p);
    }
  }
  const endpoint = (p: Point): number => {
    const at = indexOf.get(`${Math.round(p.x)},${Math.round(p.y)}`);
    if (at !== undefined) return at;
    indexOf.set(`${Math.round(p.x)},${Math.round(p.y)}`, lattice.length);
    lattice.push({ x: Math.round(p.x), y: Math.round(p.y) });
    return lattice.length - 1;
  };
  const startAt = endpoint(a);
  const goalAt = endpoint(b);

  // Neighbours: the next lattice point along each axis, when the run to it is
  // clear. Built lazily — most of the lattice is never visited.
  const byRow = new Map<number, number[]>();
  const byColumn = new Map<number, number[]>();
  lattice.forEach((p, i) => {
    (byRow.get(p.y) ?? byRow.set(p.y, []).get(p.y)!).push(i);
    (byColumn.get(p.x) ?? byColumn.set(p.x, []).get(p.x)!).push(i);
  });
  for (const row of byRow.values()) row.sort((m, n) => lattice[m].x - lattice[n].x);
  for (const col of byColumn.values()) col.sort((m, n) => lattice[m].y - lattice[n].y);
  // Where each point stands in its row and its column, so finding its
  // neighbours is a lookup rather than a scan along the line.
  const inRow = new Map<number, number>();
  const inColumn = new Map<number, number>();
  for (const row of byRow.values()) row.forEach((at, i) => inRow.set(at, i));
  for (const col of byColumn.values()) col.forEach((at, i) => inColumn.set(at, i));

  function neighbours(at: number): Array<{ at: number; dir: Axis; sign: number }> {
    const p = lattice[at];
    const out: Array<{ at: number; dir: Axis; sign: number }> = [];
    for (const [line, dir, here] of [
      [byRow.get(p.y) ?? [], "x", inRow.get(at) ?? -1],
      [byColumn.get(p.x) ?? [], "y", inColumn.get(at) ?? -1],
    ] as Array<[number[], Axis, number]>) {
      if (here < 0) continue;
      for (const step of [-1, 1]) {
        const next = line[here + step];
        if (next === undefined) continue;
        if (!blocked(p, lattice[next], walls)) out.push({ at: next, dir, sign: step });
      }
    }
    return out;
  }

  const manhattan = (i: number): number =>
    Math.abs(lattice[i].x - lattice[goalAt].x) + Math.abs(lattice[i].y - lattice[goalAt].y);

  const best = new Map<string, number>();
  const cameFrom = new Map<string, State>();
  // A binary heap, cheapest guess first and, between equals, the one pushed
  // first — the order the sorted list this replaces gave, so the same path
  // wins every tie. Sorting the whole list on every step was most of the
  // time a busy drawing took to route.
  type Entry = { state: State; cost: number; guess: number; seq: number };
  const open: Entry[] = [];
  let pushed = 0;
  const before = (m: Entry, n: Entry) =>
    m.guess < n.guess || (m.guess === n.guess && m.seq < n.seq);
  const push = (state: State, cost: number) => {
    const k = key(state);
    if ((best.get(k) ?? Infinity) <= cost) return;
    best.set(k, cost);
    const entry = { state, cost, guess: cost + manhattan(state.at), seq: pushed++ };
    let i = open.push(entry) - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!before(open[i], open[up])) break;
      [open[i], open[up]] = [open[up], open[i]];
      i = up;
    }
  };
  const pop = (): Entry => {
    const top = open[0];
    const last = open.pop()!;
    if (open.length) {
      open[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < open.length && before(open[l], open[m])) m = l;
        if (r < open.length && before(open[r], open[m])) m = r;
        if (m === i) break;
        [open[i], open[m]] = [open[m], open[i]];
        i = m;
      }
    }
    return top;
  };
  // Leaving along `from` is not optional: an edge quits its node sideways or
  // vertically according to the handle it is tied to.
  const signOf = (v: Point | undefined, axis: Axis): number | null =>
    v ? Math.sign(axis === "x" ? v.x : v.y) || null : null;
  const leaving = signOf(leave, from);
  const arriving = signOf(arrive, to);
  for (const sign of leaving === null ? [1, -1] : [leaving]) {
    push({ at: startAt, dir: from, sign }, 0);
  }

  let guard = 20000;
  while (open.length && guard-- > 0) {
    const { state, cost } = pop();
    if (cost > (best.get(key(state)) ?? Infinity)) continue;

    if (
      state.at === goalAt &&
      state.dir === to &&
      (arriving === null || state.sign === arriving || startAt === goalAt)
    ) {
      const path: Point[] = [];
      for (let s: State | undefined = state; s; s = cameFrom.get(key(s))) {
        path.push({ ...lattice[s.at] });
      }
      // The lattice puts a point wherever a line crosses, so a straight run
      // arrives chopped into pieces. They are not corners and must not be
      // reported as any: a handle would appear on each.
      // The lattice works in whole units, so the ends it reports are `a` and
      // `b` rounded. Put the real ones back, and the corner beside each with
      // them, or the first and last runs come out half a unit off square.
      // Tidied first, so the corner beside each end is the real one and not
      // the next lattice point along a straight run.
      const corners = tidy(path.reverse());
      const snap = (end: Point, at: number, next: number) => {
        const p0 = corners[at];
        const p1 = corners[next];
        if (p1 && Math.abs(p1.x - p0.x) < 0.5) p1.x = end.x;
        if (p1 && Math.abs(p1.y - p0.y) < 0.5) p1.y = end.y;
        corners[at] = { ...end };
      };
      snap(a, 0, 1);
      snap(b, corners.length - 1, corners.length - 2);
      return tidy(corners);
    }

    for (const step of neighbours(state.at)) {
      const p = lattice[state.at];
      const q = lattice[step.at];
      const length = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      // Straight back the way it came is not a turn, it is a fold.
      if (step.dir === state.dir && step.sign !== state.sign) continue;
      const next: State = { at: step.at, dir: step.dir, sign: step.sign };
      const k = key(next);
      const total = cost + length + (step.dir === state.dir ? 0 : BEND_COST);
      if ((best.get(k) ?? Infinity) <= total) continue;
      cameFrom.set(k, state);
      push(next, total);
    }
  }
  return null;
}
