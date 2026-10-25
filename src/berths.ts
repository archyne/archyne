/**
 * Where each connection ties up against a face.
 *
 * A connection meets a box in the middle of whichever face points at the other
 * end. That is right for one connection and wrong for the second: five edges
 * leaving a node's underside all leave from the same point, so five lines set
 * off stacked on top of each other and five arrowheads land in the same place.
 * The picture then says one connection where there are five, and no amount of
 * routing afterwards separates them — they never cross, they coincide.
 *
 * So the face is treated as a quay rather than a point, and the connections
 * using it are given berths along it. This is what draw.io and Visio do, and
 * it is the thing that makes a hub node — a gateway, a queue, a database —
 * readable at all.
 *
 * Two rules keep it from looking arbitrary:
 *
 *   - **Order follows the other end.** Berths are handed out in the order the
 *     far ends lie along the face, so the lines fan out without crossing each
 *     other on the way. Ties go to the edge id, so a drawing is always laid
 *     out the same way.
 *   - **The middle is the middle.** Berths are spread symmetrically about the
 *     centre of the face, so one connection still meets it dead centre and an
 *     odd number always has one down the middle.
 *
 * Like `spread.ts` this can only be decided with every connection in hand,
 * which is why it is a pass over all of them rather than something an edge
 * works out about itself.
 */
import { axisOfSide, outward, type Side } from "./orthogonal";
import type { Ends } from "./routes";
import type { Point } from "./routing";
import type { Rect } from "./avoid";

/** How far apart berths are set, in canvas units, when the face allows it. */
export const BERTH_GAP = 16;

/**
 * How far the outermost berth stays from the corner.
 *
 * A connection meeting a box right on its corner reads as missing the box, and
 * the arrowhead has nothing behind it. Capped at a quarter of the face so a
 * small node still has a usable middle.
 */
const CORNER_ROOM = 14;

/** One end of one connection, waiting for its place on a face. */
interface Slot {
  edge: string;
  end: "from" | "to";
  /** Where the *other* end of this connection is, along the face's axis. */
  towards: number;
}

/**
 * Where on a face connections may meet it: by default the whole face. A
 * caller that knows the node's outline narrows it — on a circle, a berth
 * near the corner of its box is carried a long way in to the curve, where it
 * meets the berths of the neighbouring face coming the other way.
 */
export type QuayOf = (node: string, side: Side, box: Rect) => { from: number; span: number };

/** The extent of a face along the axis a berth can move on. */
function quay(box: Rect, side: Side): { from: number; span: number } {
  return axisOfSide(side) === "x" ? { from: box.y, span: box.h } : { from: box.x, span: box.w };
}

/**
 * Every connection's ends, with the ones sharing a face spread along it.
 *
 * `ends` is what `endsOf` decided — which faces, and the middle of each. Only
 * the points move; which face a connection uses is settled before this and is
 * not this pass's business.
 */
export function spreadBerths(
  edges: { id: string; source: string; target: string; data?: { points?: Point[] } }[],
  ends: Map<string, Ends>,
  boxes: Map<string, Rect>,
  gap = BERTH_GAP,
  quayOf: QuayOf = (_node, side, box) => quay(box, side),
): Map<string, Ends> {
  // Each face, and everything wanting to meet it. A self-loop puts both of its
  // ends in, on two different faces, which is exactly right: it queues for
  // each of them like anything else.
  const quays = new Map<string, { node: string; side: Side; slots: Slot[] }>();
  const add = (node: string, side: Side, slot: Slot) => {
    const key = `${node}|${side}`;
    const at = quays.get(key) ?? { node, side, slots: [] };
    at.slots.push(slot);
    quays.set(key, at);
  };

  for (const edge of edges) {
    const at = ends.get(edge.id);
    if (!at) continue;
    // Ordered by where the line goes next along the same axis the berths
    // move on: for a left or right face that is a y, for a top or bottom an
    // x. That is the far end — or, for a connection with corners, the corner
    // beside this end, since that is where the line actually heads. Ordered
    // by the far end instead, two lines whose corners took them the other way
    // round crossed each other on the way out.
    const corners = edge.data?.points ?? [];
    const next = corners[0] ?? at.end;
    const prev = corners[corners.length - 1] ?? at.start;
    const axis = axisOfSide(at.fromSide) === "x" ? "y" : "x";
    const toAxis = axisOfSide(at.toSide) === "x" ? "y" : "x";
    add(edge.source, at.fromSide, { edge: edge.id, end: "from", towards: next[axis] });
    add(edge.target, at.toSide, { edge: edge.id, end: "to", towards: prev[toAxis] });
  }

  const out = new Map(ends);
  for (const { node, side, slots } of quays.values()) {
    if (slots.length < 2) continue;
    const box = boxes.get(node);
    if (!box) continue;

    const { from, span } = quayOf(node, side, box);
    const middle = from + span / 2;
    const room = Math.max(0, span - Math.min(CORNER_ROOM, span / 4) * 2);
    const step = Math.min(gap, room / (slots.length - 1));

    const queue = [...slots].sort(
      (a, b) => a.towards - b.towards || (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0),
    );
    queue.forEach((slot, i) => {
      const at = out.get(slot.edge);
      if (!at) return;
      const along = middle + (i - (queue.length - 1) / 2) * step;
      const point: Point = slot.end === "from" ? { ...at.start } : { ...at.end };
      if (axisOfSide(side) === "x") point.y = along;
      else point.x = along;
      out.set(slot.edge, slot.end === "from" ? { ...at, start: point } : { ...at, end: point });
    });
  }
  return out;
}

/**
 * How far out of line two ends can be and still be drawn as one straight
 * line. Below this a connection between two nearly level nodes was a Z whose
 * step was a unit or two high — drawn, with its two rounded corners, as a
 * kink in what reads as a straight line. Two berths' worth: a step that small
 * is the fan on one face against the middle of the other, not a place the
 * line is going.
 */
export const NEARLY_STRAIGHT = BERTH_GAP * 2;

/**
 * Connections between two faces that look at each other, nearly level, drawn
 * straight.
 *
 * An end is moved only to where its node's outline lies on the face — the
 * whole face of a box, only the point of a diamond.
 *
 * An end that shares its face is moved only as far as keeps it a full gap
 * from every other berth there, and never past one — the berths are in the
 * order that keeps the fan from crossing itself. And only as far as the face
 * reaches, keeping clear of its corners like any berth.
 */
export function straightenNearlyLevel(
  edges: { id: string; source: string; target: string }[],
  ends: Map<string, Ends>,
  boxes: Map<string, Rect>,
  gap = BERTH_GAP,
  flat: (node: string, side: Side, at: number) => boolean = () => true,
): Map<string, Ends> {
  const out = new Map(ends);
  // Every berth on every face, by edge, so a move can be checked against the
  // others — as they stand after any earlier move.
  const berths = new Map<string, Array<{ edge: string; end: "from" | "to" }>>();
  const add = (node: string, side: Side, edge: string, end: "from" | "to") => {
    const key = `${node}|${side}`;
    berths.set(key, [...(berths.get(key) ?? []), { edge, end }]);
  };
  for (const edge of edges) {
    const at = ends.get(edge.id);
    if (!at) continue;
    add(edge.source, at.fromSide, edge.id, "from");
    add(edge.target, at.toSide, edge.id, "to");
  }
  const where = (edge: string, end: "from" | "to", across: "x" | "y") => {
    const at = out.get(edge)!;
    return (end === "from" ? at.start : at.end)[across];
  };
  const canMove = (
    node: string,
    side: Side,
    edge: string,
    end: "from" | "to",
    to: number,
  ): boolean => {
    const box = boxes.get(node);
    if (!box) return false;
    const { from, span } = quay(box, side);
    const room = Math.min(CORNER_ROOM, span / 4);
    if (to < from + room || to > from + span - room) return false;
    // Only where the outline lies on the face: off a diamond's point the line
    // would have to reach in to its edge, and a straight line meeting a
    // slanted side is not what a decision's arrow looks like.
    if (!flat(node, side, to)) return false;
    const across = axisOfSide(side) === "x" ? "y" : "x";
    const was = where(edge, end, across);
    const here = berths.get(`${node}|${side}`) ?? [];
    // A short face packs its berths closer than `gap`, and that spacing is
    // the one to keep: a bundle of parallel connections then straightens one
    // by one, each moving into room the one before it left.
    const spacing = here
      .map((b) => (b.end === "from" ? ends.get(b.edge)!.start : ends.get(b.edge)!.end)[across])
      .sort((m, n) => m - n)
      .reduce((least, v, i, all) => (i ? Math.min(least, v - all[i - 1]) : least), gap);
    return here.every((b) => {
      if (b.edge === edge && b.end === end) return true;
      const other = where(b.edge, b.end, across);
      return (
        Math.abs(other - to) >= spacing - 0.5 &&
        Math.sign(other - to) === Math.sign(other - was)
      );
    });
  };

  // Round again while anything moves: in a bundle, the one nearest the room
  // has to move before the next has anywhere to go.
  for (let moved = true, rounds = 0; moved && rounds < edges.length; rounds++) {
    moved = false;
    for (const edge of edges) {
      const at = out.get(edge.id);
      if (!at || edge.source === edge.target) continue;
      if (at.from !== at.to || at.fromSide === at.toSide) continue;
      // Faces on the x axis meet along a y, and the other way about.
      const across = at.from === "x" ? "y" : "x";
      const step = at.end[across] - at.start[across];
      if (Math.abs(step) < 0.01 || Math.abs(step) >= NEARLY_STRAIGHT) continue;
      if (canMove(edge.target, at.toSide, edge.id, "to", at.start[across])) {
        out.set(edge.id, { ...at, end: { ...at.end, [across]: at.start[across] } });
        moved = true;
      } else if (canMove(edge.source, at.fromSide, edge.id, "from", at.end[across])) {
        out.set(edge.id, { ...at, start: { ...at.start, [across]: at.end[across] } });
        moved = true;
      }
    }
  }
  return out;
}

/**
 * Ends lined up with the corners next to them, for connections that have
 * corners.
 *
 * A berth is the router's guess at where a line should meet a face, made
 * without knowing where the line goes next. A connection with corners says
 * where it goes next: an end whose neighbouring corner faces the box from
 * within the face's reach is placed level with that corner, so the line runs
 * straight in. Spread along the face instead, the line came down to the
 * corner and then stepped a few units back up to its berth — a spike, and a
 * diagonal once the corridors were separated. It is what draw.io does too,
 * and what a diagram drawn there with a corner at a node's middle expects.
 */
export function alignWithCorners(
  edges: { id: string; source: string; target: string; data?: { points?: Point[] } }[],
  ends: Map<string, Ends>,
  boxes: Map<string, Rect>,
  quayOf: QuayOf = (_node, side, box) => quay(box, side),
): Map<string, Ends> {
  const out = new Map(ends);
  // Where a berth could be, and no nearer its corners than one: on a round
  // node that is the middle of the face, or two ends on neighbouring faces
  // run in to the same stretch of curve. And never the very corner, where
  // draw.io likes to put the point between two boxes stacked edge to edge —
  // a line from each set off from that one spot. Out of reach, the end keeps
  // its berth and the corner is drawn level with it instead (`turnsInto`).
  const reachable = (node: string, side: Side, v: number) => {
    const box = boxes.get(node);
    if (!box) return false;
    const { from, span } = quayOf(node, side, box);
    const room = Math.min(CORNER_ROOM, span / 4);
    return v >= from + room - 0.5 && v <= from + span - room + 0.5;
  };
  for (const edge of edges) {
    const corners = edge.data?.points ?? [];
    const at = out.get(edge.id);
    if (!at || corners.length === 0 || edge.source === edge.target) continue;
    let next = at;
    const first = corners[0];
    const alongFrom = axisOfSide(at.fromSide) === "x" ? "y" : "x";
    if (reachable(edge.source, at.fromSide, first[alongFrom])) {
      next = { ...next, start: { ...next.start, [alongFrom]: first[alongFrom] } };
    }
    const last = corners[corners.length - 1];
    const alongTo = axisOfSide(at.toSide) === "x" ? "y" : "x";
    if (reachable(edge.target, at.toSide, last[alongTo])) {
      next = { ...next, end: { ...next.end, [alongTo]: last[alongTo] } };
    }
    if (next !== at) out.set(edge.id, next);
  }
  return out;
}

/** How far apart two arrowheads on one face must be not to touch. */
export const HEAD_ROOM = 14;

/**
 * The ends on one face, pushed apart until none touches another: no two
 * arrowheads touching, no head on the start of another line, and no two lines
 * setting off from one point.
 *
 * Every pass before this one moves ends for a reason of its own — spreading,
 * straightening, lining up with a corner — and none of them looks at where
 * the others put theirs, so two heads could land on the same spot. This is
 * the last word: the heads keep their order along the face and as much of
 * their place as they can, and move only as far as it takes to stand
 * `HEAD_ROOM` apart. A face too short for all of them shares itself out
 * evenly instead.
 */
export function separateHeads(
  edges: { id: string; source: string; target: string; data?: { points?: Point[] } }[],
  ends: Map<string, Ends>,
  boxes: Map<string, Rect>,
  quayOf: QuayOf = (_node, side, box) => quay(box, side),
  room = HEAD_ROOM,
): Map<string, Ends> {
  // Every end on a face, not only the heads: a line leaving where a head
  // arrives is drawn on top of it just the same, and a head pushed clear of
  // its neighbours was pushed straight onto the start of another connection.
  type End = { id: string; end: "from" | "to" };
  const faces = new Map<string, { node: string; side: Side; list: End[] }>();
  const add = (node: string, side: Side, item: End) => {
    const key = `${node}|${side}`;
    const face = faces.get(key) ?? { node, side, list: [] };
    face.list.push(item);
    faces.set(key, face);
  };
  for (const edge of edges) {
    const at = ends.get(edge.id);
    if (!at || edge.source === edge.target) continue;
    add(edge.source, at.fromSide, { id: edge.id, end: "from" });
    add(edge.target, at.toSide, { id: edge.id, end: "to" });
  }

  const out = new Map(ends);
  const pointOf = (e: End) => (e.end === "from" ? out.get(e.id)!.start : out.get(e.id)!.end);
  const corners = new Map(edges.map((e) => [e.id, e.data?.points ?? []]));

  /**
   * Where a line belongs along its face, as a sort key: the rule a metro map
   * follows. Lines turning off towards the low end of the face (up, for a
   * side face) go first, the one turning off nearest the node outermost;
   * then those running straight on; then those turning off towards the high
   * end, the nearest turn again outermost. A line that turns off sooner than
   * its neighbour, on that neighbour's far side, crosses it — two lines
   * leaving one side and both dropping down crossed because the upper one
   * dropped first.
   */
  const nesting = (e: End, side: Side): number => {
    const at = pointOf(e);
    const ends = out.get(e.id)!;
    const bends = corners.get(e.id) ?? [];
    // The line from this end onwards, whichever way the connection runs.
    const path =
      e.end === "from" ? [...bends, ends.end] : [...[...bends].reverse(), ends.start];
    const along = axisOfSide(side) === "x" ? "y" : "x";
    const n = outward(side);
    const depth = (p: Point) => (p.x - at.x) * n.x + (p.y - at.y) * n.y;
    let prev: Point | null = null;
    for (const [i, p] of path.entries()) {
      const off = p[along] - at[along];
      // The corner beside the end is drawn level with it when it is near
      // (`turnsInto`), so it is read as level here too.
      const near = i === 0 && i < path.length - 1 && Math.abs(off) <= 3 * room;
      if (Math.abs(off) > 0.5 && !near) {
        // Turning at the last point still level with the face — or, with
        // none, partway out: at its corner, or halfway for a plain Z.
        const turn = prev ? depth(prev) : bends.length ? depth(p) : depth(p) / 2;
        return off < 0 ? -1e6 + turn : 1e6 - turn;
      }
      prev = p;
    }
    return 0;
  };
  for (const { node, side, list } of faces.values()) {
    // Lines only leaving together count too. Left to the corridor pass, they
    // set off from one point and lay on each other for their first stub —
    // the one stretch that pass will not move — before fanning out.
    if (list.length < 2) continue;
    const box = boxes.get(node);
    if (!box) continue;
    const across = axisOfSide(side) === "x" ? "y" : "x";
    const { from, span } = quayOf(node, side, box);
    const lo = from + Math.min(2, span / 4);
    const hi = from + span - Math.min(2, span / 4);

    // The places on the face stay the ones the earlier passes chose; which
    // line takes which is decided by where each one turns (`nesting`), so
    // none of them turning off crosses another still running on.
    const want = list.map((e) => pointOf(e)[across]).sort((a, b) => a - b);
    const sorted = list
      .map((e) => ({ e, at: pointOf(e)[across], key: nesting(e, side) }))
      .sort((a, b) => a.key - b.key || a.at - b.at || (a.e.id < b.e.id ? -1 : 1));
    const n = want.length;
    let placed: number[];
    if (hi - lo < (n - 1) * room) {
      placed = want.map((_, i) => lo + ((hi - lo) * i) / (n - 1));
    } else {
      placed = [...want];
      placed[0] = Math.max(placed[0], lo);
      for (let i = 1; i < n; i++) placed[i] = Math.max(placed[i], placed[i - 1] + room);
      placed[n - 1] = Math.min(placed[n - 1], hi);
      for (let i = n - 2; i >= 0; i--) placed[i] = Math.min(placed[i], placed[i + 1] - room);
    }
    sorted.forEach(({ e, at }, i) => {
      if (Math.abs(placed[i] - at) < 0.5) return;
      const cur = out.get(e.id)!;
      const moved = { ...pointOf(e), [across]: placed[i] };
      out.set(e.id, e.end === "from" ? { ...cur, start: moved } : { ...cur, end: moved });
    });
  }
  return out;
}
