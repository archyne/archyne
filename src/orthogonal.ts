/**
 * Orthogonal routing: turning the points a user placed into a path made only
 * of horizontal and vertical runs, the way draw.io and Visio draw a
 * connector.
 *
 * The stored waypoints do not change meaning or shape — they are still the
 * absolute points the connection is routed *through*, and the file format is
 * untouched. What changes is what happens between two of them: instead of the
 * straight line that produced diagonals, this puts a right angle in.
 *
 * Kept away from React, like `routing.ts`, so the arithmetic can be read and
 * tested as arithmetic.
 */
import type { Point } from "./routing";

/** Which way a run travels: "x" is horizontal, "y" vertical. */
export type Axis = "x" | "y";

const other = (axis: Axis): Axis => (axis === "x" ? "y" : "x");

/** The axis an edge travels on when it leaves or meets a given side. */
export function axisOfSide(side: string): Axis {
  return side === "left" || side === "right" ? "x" : "y";
}

/** A face of a box, named as React Flow names them. */
export type Side = "left" | "right" | "top" | "bottom";

/** A box, as the canvas knows it. */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

const centre = (r: Frame): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** The space between two boxes along an axis; negative where they overlap. */
function gap(a: Frame, b: Frame, axis: Axis): number {
  const [aLo, aHi] = axis === "x" ? [a.x, a.x + a.w] : [a.y, a.y + a.h];
  const [bLo, bHi] = axis === "x" ? [b.x, b.x + b.w] : [b.y, b.y + b.h];
  return Math.max(aLo, bLo) - Math.min(aHi, bHi);
}

/** Do these two boxes share any of the given axis? */
function overlaps(a: Frame, b: Frame, axis: Axis): boolean {
  const [aLo, aHi] = axis === "x" ? [a.x, a.x + a.w] : [a.y, a.y + a.h];
  const [bLo, bHi] = axis === "x" ? [b.x, b.x + b.w] : [b.y, b.y + b.h];
  return aLo < bHi && bLo < aHi;
}

/**
 * Which faces two boxes should be joined by.
 *
 * The sides used to come from the diagram's direction and nothing else: in a
 * left-to-right flowchart every connection left its node on the right and
 * arrived on the left, however the two were actually arranged. Drag a node
 * above its predecessor and the line went out to the right, back past both of
 * them and in from the left — the shape of a rule being obeyed rather than a
 * connection being drawn. This is Visio's dynamic glue: the faces follow the
 * geometry.
 *
 * The rule is the obvious one, with one correction. Ordinarily the wider
 * separation wins — boxes far apart across and close vertically are joined
 * side to side. But when the boxes *overlap* on that axis there is no clear
 * side to speak of, and the other axis is used instead: two boxes in a column,
 * one slightly wider than the other, are joined bottom to top, not by a line
 * that squeezes around their flanks.
 */
export function bestSides(from: Frame, to: Frame): { from: Side; to: Side } {
  const a = centre(from);
  const b = centre(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  const horizontal = Math.abs(dx) >= Math.abs(dy);
  let useX = horizontal ? !overlaps(from, to, "x") : overlaps(from, to, "y");

  // Two faces closer together than a stub each have no room between them
  // for the line to leave one square and arrive at the other square, so the
  // route went out, round the outside of both boxes and back — hundreds of
  // units to cross a gap of ten. When the other pair of faces has that room,
  // they are the ones to use.
  const room = 2 * STUB;
  const gapX = gap(from, to, "x");
  const gapY = gap(from, to, "y");
  if (useX && gapX < room && gapY >= room) useX = false;
  else if (!useX && gapY < room && gapX >= room) useX = true;

  if (useX) {
    return dx >= 0 ? { from: "right", to: "left" } : { from: "left", to: "right" };
  }
  return dy >= 0 ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
}

/** The middle of one face of a box: where a connection meets it. */
export function attachPoint(r: Frame, side: Side): Point {
  const c = centre(r);
  switch (side) {
    case "left":
      return { x: r.x, y: c.y };
    case "right":
      return { x: r.x + r.w, y: c.y };
    case "top":
      return { x: c.x, y: r.y };
    case "bottom":
      return { x: c.x, y: r.y + r.h };
  }
}

/** Which way is away from the box, through this face. */
export function outward(side: Side): Point {
  switch (side) {
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
  }
}

/** How far a connection steps away from a node before it turns. */
export const STUB = 20;

/**
 * Is the other end behind this face?
 *
 * An architecture diagram names its sides in the file, and they are the
 * author's decision — until the nodes are rearranged under them. Move the
 * far node round to the other side and the named face points away from it:
 * obeying it then means setting off in the wrong direction and coming back
 * across the node's own box, which is how an arrowhead ends up behind a
 * block.
 *
 * Behind, not merely level. Two nodes stacked in a column and joined right to
 * right have each face pointing along the other — nothing is behind anything,
 * the step away from the face is enough, and the author's choice stands.
 */
export function facesAway(from: Frame, side: Side, to: Frame): boolean {
  const d = outward(side);
  const gap =
    d.x !== 0
      ? d.x > 0
        ? to.x + to.w - (from.x + from.w)
        : from.x - to.x
      : d.y > 0
        ? to.y + to.h - (from.y + from.h)
        : from.y - to.y;
  return gap < 0;
}

/** How far `to` lies away from `from` in the direction `d`. */
const reach = (from: Point, to: Point, d: Point): number =>
  (to.x - from.x) * d.x + (to.y - from.y) * d.y;

/**
 * A short leg away from each node, where the route would not take one.
 *
 * A connector leaves a face perpendicular to it and only then turns — Visio
 * and draw.io both insist on it, and the reason shows itself the moment two
 * nodes are stacked and joined right side to right side: with both faces on
 * the same vertical, the route was a straight line down the border, resting
 * against both boxes, with the arrowhead flat against the second one and
 * invisible.
 *
 * The leg is added only where it is missing. A connection running left to
 * right between two ordinary nodes already leaves its face going right, and
 * putting a corner in it would make the drawing worse, not better.
 */
export function withStubs(anchors: Point[], from: Side, to: Side, stub = STUB): Point[] {
  if (anchors.length < 2) return anchors;
  const out = [...anchors];

  // Already square: the next point is straight out from the face, however
  // near. A stub then would land beyond it, and the line would go out past
  // its own corner and come back.
  const square = (a: Point, b: Point, d: Point) =>
    reach(a, b, d) > 0.5 && (d.x !== 0 ? Math.abs(a.y - b.y) < 0.5 : Math.abs(a.x - b.x) < 0.5);

  const leaving = outward(from);
  if (reach(out[0], out[1], leaving) < stub && !square(out[0], out[1], leaving)) {
    out.splice(1, 0, { x: out[0].x + leaving.x * stub, y: out[0].y + leaving.y * stub });
  }

  const arriving = outward(to);
  const last = out.length - 1;
  if (
    reach(out[last], out[last - 1], arriving) < stub &&
    !square(out[last], out[last - 1], arriving)
  ) {
    out.splice(last, 0, {
      x: out[last].x + arriving.x * stub,
      y: out[last].y + arriving.y * stub,
    });
  }
  return out;
}

/** Same place, to within the rounding the file keeps. */
function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

/** Between the two, allowing for the half-unit everything here allows for. */
function within(v: number, m: number, n: number): boolean {
  return v >= Math.min(m, n) - 0.5 && v <= Math.max(m, n) + 0.5;
}

/**
 * Is `b` on the straight line between `a` and `c`, *and between them*?
 *
 * The second half is not decoration. Three points sharing an x are on one
 * line whether the middle one lies between the others or a long way past
 * them, and dropping it in the second case shortens the path: a corner
 * dragged below both its neighbours was discarded, the line stopped at the
 * neighbour, and the handle was left stranded off the end of it.
 */
function collinear(a: Point, b: Point, c: Point): boolean {
  const horizontal =
    Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5 && within(b.x, a.x, c.x);
  const vertical =
    Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5 && within(b.y, a.y, c.y);
  return horizontal || vertical;
}

/**
 * Drop the points that say nothing: repeats, and the middle of three in a
 * line. Two runs in the same direction are one run, and a corner that turns
 * through nothing is not a corner — left in, both would put a handle on the
 * path with no segment to move.
 */
export function tidy(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length && samePoint(out[out.length - 1], p)) continue;
    out.push({ ...p });
  }
  for (let i = 1; i < out.length - 1;) {
    if (collinear(out[i - 1], out[i], out[i + 1])) out.splice(i, 1);
    else i++;
  }
  return out;
}

/**
 * The corner between two points, given which axis the run leaves `a` on.
 *
 * Travelling horizontally first from (0,0) to (100,50) turns at (100,0);
 * vertically first, at (0,50). Points already sharing a coordinate need no
 * corner at all, and returning none is what keeps a straight run straight.
 */
function cornerBetween(a: Point, b: Point, first: Axis): Point | null {
  if (Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5) return null;
  return first === "x" ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
}

/**
 * The full orthogonal path through a set of anchors.
 *
 * `anchors` is the whole connection: where it starts, the corners the user
 * placed, and where it ends. `from` is the axis it leaves the source on and
 * `to` the axis it arrives at the target on — both read off the sides the
 * handles sit on, so an edge leaving a node's right side sets out sideways
 * and one entering a top enters from above.
 *
 * Between two anchors the path turns once. Which way round is decided in
 * order: the first run follows `from`; the last is made to arrive along `to`;
 * in between each pair turns away from the direction the previous run
 * arrived on, so the path alternates rather than doubling back on itself.
 */
export function orthogonalRoute(anchors: Point[], from: Axis, to: Axis): Point[] {
  if (anchors.length < 2) return tidy(anchors);

  // With nothing of the user's in between, and leaving and arriving on the
  // same axis, the classic connector is a Z: out of the node, across at the
  // halfway line, and in. A single corner would work but is lopsided — it
  // hugs one of the two nodes — and this is the shape React Flow's own
  // smooth step drew, which is worth keeping now that it no longer draws it.
  if (anchors.length === 2 && from === to) {
    const [a, b] = anchors;
    const apart = Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5;
    if (apart && from === "x") {
      const mid = (a.x + b.x) / 2;
      return tidy([a, { x: mid, y: a.y }, { x: mid, y: b.y }, b]);
    }
    if (apart && from === "y") {
      const mid = (a.y + b.y) / 2;
      return tidy([a, { x: a.x, y: mid }, { x: b.x, y: mid }, b]);
    }
  }

  const out: Point[] = [{ ...anchors[0] }];
  let arriving: Axis = from;

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const last = i === anchors.length - 2;

    // The last pair has to *end* on `to`, so it starts on the other axis.
    // Every other pair starts by turning off the run that reached it.
    const first: Axis = i === 0 ? from : last ? other(to) : other(arriving);

    const corner = cornerBetween(a, b, first);
    if (corner) {
      out.push(corner);
      // Having turned at the corner, the run into `b` is on the other axis.
      arriving = other(first);
    } else {
      arriving = Math.abs(a.x - b.x) < 0.5 ? "y" : "x";
    }
    out.push({ ...b });
  }

  return tidy(out);
}

/** A run of the path: the two points it joins, and where it sits. */
export interface Segment {
  from: Point;
  to: Point;
  /** Which way it runs. A zero-length run is reported as "x". */
  axis: Axis;
  /** Its index in the point list: it joins `points[index]` to `[index + 1]`. */
  index: number;
  /** The middle, where a handle for it goes. */
  mid: Point;
}

/**
 * Slide one run of the path sideways, which is the whole gesture: a
 * horizontal run moves up and down, a vertical one left and right, and the
 * runs on either side stretch to keep up. Nothing else about the path moves,
 * and it stays orthogonal because only one coordinate changed.
 *
 * `value` is the run's new position on the axis it moves along — a y for a
 * horizontal run, an x for a vertical one.
 *
 * The two ends are pinned to the handles on the nodes and cannot be dragged
 * anywhere. Moving a run that touches one therefore does not move that point;
 * it puts a new corner beside it, and the connection leaves its node the way
 * it always did before turning off to where it is now wanted.
 */
export function moveSegment(points: Point[], index: number, value: number): Point[] {
  const runs = segmentsOf(points);
  const run = runs[index];
  if (!run) return points;

  // A horizontal run is moved by changing y, and the other way about.
  const moving: Axis = run.axis === "x" ? "y" : "x";
  const set = (q: Point): Point =>
    moving === "x" ? { x: value, y: q.y } : { x: q.x, y: value };

  const last = points.length - 1;
  const out: Point[] = [];
  for (let j = 0; j <= last; j++) {
    const q = points[j];
    if (j === index && j === 0) {
      // Leave the source where it is and turn off it.
      out.push({ ...q }, set(q));
    } else if (j === index + 1 && j === last) {
      // Reach the target's own coordinate, then run into it.
      out.push(set(q), { ...q });
    } else if (j === index || j === index + 1) {
      out.push(set(q));
    } else {
      out.push({ ...q });
    }
  }
  return tidy(out);
}

/**
 * The corners to *store* after a run has been slid.
 *
 * Not simply the new path. A path holds corners the router worked out —
 * including the two just outside the nodes, where the line turns off its
 * handle — and writing those to the file pins the connection to wherever the
 * nodes happen to be standing: move one afterwards and the line keeps a
 * corner at the old height. Sliding three corners into six, then twelve, was
 * the same fault compounding.
 *
 * So the stored list is edited rather than replaced. A run that already has a
 * corner of the user's on it moves that corner; a run made only of the
 * router's own corners gains the two that pin it, and nothing else changes.
 *
 * The slide is bounded by the faces at either end. A run dragged past the
 * face it leaves from cannot be drawn as asked: the line still has to come
 * out of that face, so it goes out, turns, and comes back over the node —
 * and what appears is not a moved corridor but a fold, drawn as a stack of
 * segments doubling over each other with a cusp at each turn. `STUB` is the
 * same straight stretch the router reserves so an arrowhead has something to
 * sit on; the gesture stops there rather than being allowed to ask for a path
 * that cannot exist.
 */
export function slideRun(
  stored: Point[],
  drawn: Point[],
  index: number,
  value: number,
): Point[] {
  const runs = segmentsOf(drawn);
  const run = runs[index];
  if (!run) return stored;

  // A horizontal run is pinned by its y, a vertical one by its x.
  const pinned: Axis = run.axis === "x" ? "y" : "x";
  const along: Axis = run.axis;
  const was = pinned === "x" ? run.from.x : run.from.y;

  for (const anchor of [
    index - 1 === 0 ? drawn[0][pinned] : null,
    index + 1 === runs.length - 1 ? drawn[drawn.length - 1][pinned] : null,
  ]) {
    if (anchor === null) continue;
    value = was >= anchor ? Math.max(value, anchor + STUB) : Math.min(value, anchor - STUB);
  }
  const lo = Math.min(run.from[along], run.to[along]);
  const hi = Math.max(run.from[along], run.to[along]);

  const onThisRun = (q: Point): boolean =>
    Math.abs(q[pinned] - was) < 0.5 && q[along] >= lo - 0.5 && q[along] <= hi + 0.5;

  const moved = stored.map((q) =>
    onThisRun(q) ? (pinned === "x" ? { x: value, y: q.y } : { x: q.x, y: value }) : { ...q },
  );
  if (stored.some(onThisRun)) return moved;

  // Nothing of the user's on this run: it is the router's, and pinning it
  // takes two corners — one at each end of the run, at its new position.
  const before = drawn
    .slice(0, index + 1)
    .filter((q) =>
      stored.some((s) => Math.abs(s.x - q.x) < 0.5 && Math.abs(s.y - q.y) < 0.5),
    ).length;
  const set = (q: Point): Point =>
    pinned === "x" ? { x: value, y: q.y } : { x: q.x, y: value };

  /**
   * Pinning corners, held clear of the points the route hangs from.
   *
   * A corner that shares a coordinate with the point on a node's face is the
   * one that draws a spur. It looks harmless — the line passes through there
   * on its way out — but which face a route leaves by is worked out *from*
   * its corners, so adding one can move the exit round to another side, and
   * against the new side that corner sits behind the line rather than on it.
   * The route then leaves the face, turns, comes back to collect the corner,
   * and sets off again: one drag, three extra lines. It is not only the run
   * at the very end of a route that does this — a route often turns a few
   * units off a node before its first real corridor, so the run *after* the
   * first one carries the node's coordinate too.
   *
   * The clearance is a whole `STUB` and not some fraction of the run,
   * because `STUB` is exactly what the router reserves for itself: a corner
   * any nearer to a face than that is a corner the route's own leg steps
   * straight past, and the line goes out, back to collect it, and out again.
   */
  const dir = run.to[along] >= run.from[along] ? 1 : -1;
  const startsAt = drawn[0][along];
  const endsAt = drawn[drawn.length - 1][along];
  const clear = (v: number, face: number, side: number): number =>
    Math.abs(v - face) < STUB ? face + side * STUB : v;

  const first = clear(run.from[along], startsAt, dir);
  const second = clear(run.to[along], endsAt, -dir);

  // Held clear of both faces, the two corners have met or swapped over: this
  // run is shorter than the two legs the route needs at its ends, so there is
  // no path that does what the drag asks — a straight hop between two boxes
  // forty units apart cannot be bowed around anything, since the legs alone
  // use up the whole gap. Leaving the corners alone makes the gesture do
  // nothing, which is the honest answer; the alternative on offer is the
  // spike out and back that made a drag look like it had shattered the line.
  if ((second - first) * dir <= 0) return stored;

  const on = (v: number, q: Point): Point =>
    along === "x" ? { x: v, y: q.y } : { x: q.x, y: v };

  return tidy([
    ...moved.slice(0, before),
    set(on(first, run.from)),
    set(on(second, run.to)),
    ...moved.slice(before),
  ]);
}

/**
 * Carry an edge's corners along when the nodes it hangs from move.
 *
 * The corners are absolute canvas positions — they have to be, since an edge
 * can run between two nodes in different groups, with no shared frame to be
 * relative to. The cost of that is this: move a node and its connection kept
 * every corner exactly where it was, so the line went off on an errand and
 * came back. Visio re-glues; draw.io re-routes.
 *
 * The rule here is that a corner belongs more to the end it is nearer along
 * the route. The first corner follows the source almost entirely, the last
 * follows the target, and the ones between share. Two consequences worth
 * having: dragging a whole group, where both ends move together, shifts every
 * corner by the same amount and the shape is untouched; and dragging one node
 * a long way does not drag the far end of the line with it.
 */
export function carryWaypoints(points: Point[], bySource: Point, byTarget: Point): Point[] {
  if (points.length === 0) return points;
  const still =
    Math.abs(bySource.x) < 0.01 &&
    Math.abs(bySource.y) < 0.01 &&
    Math.abs(byTarget.x) < 0.01 &&
    Math.abs(byTarget.y) < 0.01;
  if (still) return points;

  return points.map((q, i) => {
    // 0 at the source end, 1 at the target end, never quite either: a corner
    // is always its own point, not one of the two nodes.
    const towardsTarget = (i + 1) / (points.length + 1);
    const towardsSource = 1 - towardsTarget;
    return {
      x: q.x + bySource.x * towardsSource + byTarget.x * towardsTarget,
      y: q.y + bySource.y * towardsSource + byTarget.y * towardsTarget,
    };
  });
}

/** Do these two paths draw the same line? */
function samePath(a: Point[], b: Point[]): boolean {
  return a.length === b.length && a.every((q, i) => samePoint(q, b[i]));
}

/**
 * The shortest list of corners that still draws this exact line.
 *
 * Pinning a run takes two corners, and a run made by pinning another one can
 * be pinned in its turn, so the list grows every time a fresh run is moved —
 * three corners became five, then nine. Most of those are saying what the
 * router would have said anyway.
 *
 * So each is tried for removal, and kept only if the line changes without it.
 * The test is the line itself rather than a rule about which corners matter:
 * whatever the router does, this cannot alter the drawing.
 *
 * Quadratic in the number of corners, over a list that is a handful long.
 */
export function prune(
  stored: Point[],
  source: Point,
  target: Point,
  from: Axis,
  to: Axis,
): Point[] {
  const drawnWith = (corners: Point[]): Point[] =>
    orthogonalRoute([source, ...corners, target], from, to);

  const wanted = drawnWith(stored);
  let kept = stored;
  // Backwards, so an index stays valid while the list shrinks under it.
  for (let i = kept.length - 1; i >= 0; i--) {
    const without = [...kept.slice(0, i), ...kept.slice(i + 1)];
    if (samePath(drawnWith(without), wanted)) kept = without;
  }
  return kept;
}

/** Every run of an orthogonal path, in order. */
export function segmentsOf(points: Point[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    out.push({
      from,
      to,
      axis: Math.abs(from.y - to.y) < 0.5 ? "x" : "y",
      index: i,
      mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
    });
  }
  return out;
}
