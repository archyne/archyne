/**
 * Which arrangement a drawing reads best in, worked out from the drawing.
 *
 * A flowchart can be banded, a relational model packed, a network settled as
 * if it were springs — and no single one of those is right for every file, so
 * "Arrange" had to be either a guess or a choice the reader has to make. The
 * reading of a file already knows the answer, though: a drawing reads best in
 * the arrangement that draws it least badly. Compare the arrangements
 * against each other, and *for this file* the choice makes itself.
 *
 * So `choose.ts` holds the one number that settles a comparison: a ranked
 * score of how badly an arrangement draws the file. The ranking is what the
 * drawing software has learned the hard way about what a reader recognises
 * first — and it is ranked rather than weighted because the parts have no
 * honest exchange rate, which is the same stand `Cost` in `labels.ts` takes.
 *
 *   - **`spill`** — a node sticking out of its own container. First because
 *     it is the worst and the rarest: every solver I tried at least once put
 *     a subnet's service on the subnet's frame, or the frame itself over its
 *     neighbour, and there is no reading where that looks intentional.
 *   - **overlap** — containers or boxes covering each other. The same kind
 *     of lie, without the boundary; a service sitting on a sibling reads as
 *     part of one box.
 *   - **coincident** — two connections drawn on top of each other. The
 *     reader sees one line and two arrowheads. Judged per pair of
 *     connections once, so a bundle of parallels from a shared port is not
 *     counted a dozen times.
 *   - **along a border** — a connection running flush with a container's
 *     edge, which reads as part of the frame.
 *   - **crossings** — connections genuinely travelling across each other,
 *     judged per pair of connections: one line crossing another in a bundle
 *     is still one crossing to the eye. The very thing an arrangement
 *     exists to reduce, so it carries weight — but a crossing is a break in
 *     a line, while the things above are lies about what the drawing is,
 *     and they outrank it.
 *   - **onStranger** — a label lying on a connection it does not name. It
 *     does not hide a line, it renames it.
 *   - **buryOwn** — a label hiding more than half of its own connection.
 *   - **overLabel** — labels covering each other's words.
 *   - **overBox** — a label covering a box's words.
 *   - **area** — the ground the drawing stands on. Last, because it is a
 *     preference and not a legibility harm: where two arrangements draw the
 *     file equally well, the one on less page is the one to keep.
 *
 * The score is measured with the whole pipeline the reader will see — the
 * routes are what the router will draw and the labels are laid out over the
 * obstacles the canvas will use — and the parts that have nothing to do with
 * arrangement never enter, so a drawing with few connections is not graded
 * easier than one with many. `layoutScore` is pure arithmetic over nodes and
 * edges; arrange the same file twice and it must agree with itself.
 */
import { absoluteBoxes } from "../boxes";
import { drawnLines, placeLabels } from "../labels";
import { isGroup, type AnyNode, type DiagramKind, type FlowEdge } from "../model/types";
import type { PositionMap } from "../model/positions";
import type { Rect } from "../avoid";
import type { Point } from "../routing";
import { allRoutes } from "../routes";

/** An overlap smaller than this is not an overlap. The same stand as `labels.ts`. */
const NOTICEABLE = 1;

/** How far in from a container's frame its contents are expected to sit. */
const EDGE = 8;

/** How far along a border a connection must run before it is "along the border". */
const RUN = 20;

/** How much of its own connection a label may hide before it counts as burying it. */
const BURY = 0.5;

/**
 * The nodes, with a layout's positions written onto them, the way the store
 * writes them after a pass.
 *
 * `absoluteBoxes`, `allRoutes` and `placeLabels` all judge what would be drawn,
 * and what would be drawn is not the nodes the layout was asked about: a group
 * comes back with a size as well as a place, so the frame the reader sees is
 * the size ELK settled on. Scoring positions without folding that in would
 * measure a drawing that is never drawn.
 */
export function placedNodes(nodes: AnyNode[], positions: PositionMap): AnyNode[] {
  return nodes.map((n) => {
    const p = positions[n.id];
    if (!p) return n;
    return {
      ...n,
      position: { x: p.x, y: p.y },
      ...(isGroup(n) && p.w !== undefined
        ? {
            style: { ...n.style, width: p.w, height: p.h },
            width: p.w,
            height: p.h,
            measured: undefined,
          }
        : {}),
    } as AnyNode;
  });
}

/** The measurements `layoutScore` returns, in the order they are compared. */
export const SCORE_NAMES = [
  "spill",
  "overlap",
  "coincident",
  "border",
  "crossings",
  "onStranger",
  "buryOwn",
  "overLabel",
  "overBox",
  "area",
] as const;

export type Score = readonly number[];

/** Is `a` a better score than `b`? First the measurements differ on decides. */
export function betterScore(a: Score, b: Score): boolean {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** The ground two rectangles cover between them, in square units. */
function shared(a: Rect, b: Rect): number {
  return (
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  );
}

/** The straight runs that make up a drawn line. */
type Seg = { a: Point; b: Point };
function segmentsOf(line: Point[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 1; i < line.length; i++) out.push({ a: line[i - 1], b: line[i] });
  return out;
}

/** How far two collinear axis-aligned segments overlap, or nothing. */
function collinearOverlap(s: Seg, t: Seg): number {
  if (
    Math.abs(s.a.y - s.b.y) < 0.5 &&
    Math.abs(t.a.y - t.b.y) < 0.5 &&
    Math.abs(s.a.y - t.a.y) < 0.5
  ) {
    const lo = Math.max(Math.min(s.a.x, s.b.x), Math.min(t.a.x, t.b.x));
    const hi = Math.min(Math.max(s.a.x, s.b.x), Math.max(t.a.x, t.b.x));
    return Math.max(0, hi - lo);
  }
  if (
    Math.abs(s.a.x - s.b.x) < 0.5 &&
    Math.abs(t.a.x - t.b.x) < 0.5 &&
    Math.abs(s.a.x - t.a.x) < 0.5
  ) {
    const lo = Math.max(Math.min(s.a.y, s.b.y), Math.min(t.a.y, t.b.y));
    const hi = Math.min(Math.max(s.a.y, s.b.y), Math.max(t.a.y, t.b.y));
    return Math.max(0, hi - lo);
  }
  return 0;
}

/** Does the segment enter the rectangle at all? */
function pocket(rect: Rect, p: Point): boolean {
  return p.x > rect.x && p.x < rect.x + rect.w && p.y > rect.y && p.y < rect.y + rect.h;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  return (
    properCrosses(a, b, c, d) ||
    (cross0(a, b, c) && onSeg(a, b, c)) ||
    (cross0(a, b, d) && onSeg(a, b, d)) ||
    (cross0(c, d, a) && onSeg(c, d, a)) ||
    (cross0(c, d, b) && onSeg(c, d, b))
  );
}

const cross0 = (a: Point, b: Point, p: Point) =>
  (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) === 0;

/** The reading-eye crossing: the two segments genuinely travel across each other. */
function properCrosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const ccw = (x: Point, y: Point, z: Point) =>
    (y.x - x.x) * (z.y - x.y) - (y.y - x.y) * (z.x - x.x);
  const d1 = ccw(a, b, c);
  const d2 = ccw(a, b, d);
  const d3 = ccw(c, d, a);
  const d4 = ccw(c, d, b);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

const onSeg = (a: Point, b: Point, p: Point) =>
  Math.min(a.x, b.x) <= p.x &&
  p.x <= Math.max(a.x, b.x) &&
  Math.min(a.y, b.y) <= p.y &&
  p.y <= Math.max(a.y, b.y);

/** Does the segment cross the rectangle (an endpoint coming out the other side)? */
function crossesRect(rect: Rect, seg: Seg): boolean {
  if (pocket(rect, seg.a) || pocket(rect, seg.b)) return true;
  const { x, y, w, h } = rect;
  return (
    segmentsIntersect(seg.a, seg.b, { x, y }, { x: x + w, y }) ||
    segmentsIntersect(seg.a, seg.b, { x: x + w, y }, { x: x + w, y: y + h }) ||
    segmentsIntersect(seg.a, seg.b, { x: x + w, y: y + h }, { x, y: y + h }) ||
    segmentsIntersect(seg.a, seg.b, { x, y: y + h }, { x, y })
  );
}

/** How far a segment runs flush with a horizontal line, or nothing. */
function alongLine(seg: Seg, lineY: number, fromX: number, toX: number): number {
  if (Math.abs(seg.a.y - lineY) > 0.5 || Math.abs(seg.b.y - lineY) > 0.5) return 0;
  const lo = Math.max(Math.min(seg.a.x, seg.b.x), fromX);
  const hi = Math.min(Math.max(seg.a.x, seg.b.x), toX);
  return Math.max(0, hi - lo);
}

/**
 * How badly this arrangement draws the file: ten measurements, in the order
 * a reader cares about them. Lower is better; the first one they differ on
 * decides.
 */
export function layoutScore(placed: AnyNode[], edges: FlowEdge[], kind: DiagramKind): Score {
  const boxes = absoluteBoxes(placed);
  const solids = placed.filter((n) => !isGroup(n));
  const groups = placed.filter(isGroup);
  const groupById = new Map(groups.map((n) => [n.id, n]));

  // A node sticking out of a container it belongs to.
  let spill = 0;
  for (const n of solids) {
    const b = boxes.get(n.id)!;
    let parentId = n.parentId;
    while (parentId) {
      const g = boxes.get(parentId)!;
      if (
        b.x < g.x + EDGE - 0.5 ||
        b.y < g.y + EDGE - 0.5 ||
        b.x + b.w > g.x + g.w - EDGE + 0.5 ||
        b.y + b.h > g.y + g.h - EDGE + 0.5
      )
        spill++;
      parentId = groupById.get(parentId)?.parentId;
    }
  }

  // Containers or boxes covering each other.
  let overlap = 0;
  const byParent = new Map<string | undefined, AnyNode[]>();
  for (const n of placed) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  for (const list of byParent.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (shared(boxes.get(list[i].id)!, boxes.get(list[j].id)!) > NOTICEABLE) overlap++;
      }

  // The drawing, as the reader will see it: routes, then the labels on them.
  // Crossings and long overlaps are judged per pair of connections once:
  // a fan of parallels leaving a shared port must not count a dozen times,
  // and neither must one line crossing another in a bundle.
  const routes = allRoutes(placed, edges, kind);
  const drawn = drawnLines(routes);
  const obstacles = solids.map((n) => boxes.get(n.id)).filter((b): b is Rect => !!b);
  const placedLabels = placeLabels(edges, routes, obstacles);

  const frames = groups.map((n) => boxes.get(n.id)!).filter((b): b is Rect => !!b);

  // Each line's runs, taken apart once, with the box each run fits in. A
  // drawn line is its route with every corner rounded, so a few dozen short
  // runs, and comparing every run of every line with every run of every
  // other — taking the second line apart again for each run of the first —
  // was thirteen seconds of a still window on a drawing of seventy-five
  // connections, for each of the five arrangements. Two lines whose boxes do
  // not meet share nothing and cross nowhere, and neither do two runs.
  const runs = drawn.map((d) =>
    segmentsOf(d.line).map((s) => ({
      s,
      x0: Math.min(s.a.x, s.b.x),
      x1: Math.max(s.a.x, s.b.x),
      y0: Math.min(s.a.y, s.b.y),
      y1: Math.max(s.a.y, s.b.y),
    })),
  );
  const extent = runs.map((list) => ({
    x0: Math.min(...list.map((r) => r.x0)),
    x1: Math.max(...list.map((r) => r.x1)),
    y0: Math.min(...list.map((r) => r.y0)),
    y1: Math.max(...list.map((r) => r.y1)),
  }));
  type Span = { x0: number; x1: number; y0: number; y1: number };
  const apart = (m: Span, n: Span) =>
    m.x1 < n.x0 - 0.5 || n.x1 < m.x0 - 0.5 || m.y1 < n.y0 - 0.5 || n.y1 < m.y0 - 0.5;

  let coincident = 0;
  let crossings = 0;
  for (let i = 0; i < drawn.length; i++)
    for (let j = i + 1; j < drawn.length; j++) {
      if (apart(extent[i], extent[j])) continue;
      let long = false;
      let crossed = false;
      scan: for (const m of runs[i]) {
        if (apart(m, extent[j])) continue;
        for (const n of runs[j]) {
          if (apart(m, n)) continue;
          if (!long && collinearOverlap(m.s, n.s) > RUN) long = true;
          if (!crossed && properCrosses(m.s.a, m.s.b, n.s.a, n.s.b)) crossed = true;
          if (long && crossed) break scan;
        }
      }
      if (long) coincident++;
      if (crossed) crossings++;
    }

  // A connection running flush with a container's border. Judged per line
  // and per frame once, not per pair of lines.
  let border = 0;
  for (const d of drawn)
    for (const frame of frames)
      for (const s of segmentsOf(d.line)) {
        const vertical = { a: { x: s.a.y, y: s.a.x }, b: { x: s.b.y, y: s.b.x } };
        if (
          alongLine(s, frame.y, frame.x, frame.x + frame.w) > RUN ||
          alongLine(s, frame.y + frame.h, frame.x, frame.x + frame.w) > RUN ||
          alongLine(vertical, frame.x, frame.y, frame.y + frame.h) > RUN ||
          alongLine(vertical, frame.x + frame.w, frame.y, frame.y + frame.h) > RUN
        )
          border++;
      }

  let onStranger = 0;
  let buryOwn = 0;
  let overLabel = 0;
  let overBox = 0;
  const byId = new Map(drawn.map((d) => [d.id, d]));
  const all = [...placedLabels.entries()];
  for (let i = 0; i < all.length; i++) {
    const [id, pl] = all[i];
    const mine = byId.get(id);
    if (!mine) continue;
    if (obstacles.some((o) => shared(pl.box, o) > NOTICEABLE)) overBox++;
    const inside = mine.line.filter((p) => pocket(pl.box, p)).length;
    if (mine.line.length > 0 && inside / mine.line.length > BURY) buryOwn++;
    for (let j = 0; j < all.length; j++) {
      if (i === j) continue;
      if (shared(pl.box, all[j][1].box) > NOTICEABLE) {
        overLabel++;
        break;
      }
    }
    for (const d of drawn) {
      if (d.id === id) continue;
      if (segmentsOf(d.line).some((seg) => crossesRect(pl.box, seg))) {
        onStranger++;
        break;
      }
    }
  }

  // The ground the drawing stands on: the smallest rectangle that holds it.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes.values()) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const area = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);

  return [
    spill,
    overlap,
    coincident,
    border,
    crossings,
    onStranger,
    buryOwn,
    overLabel,
    overBox,
    area,
  ];
}
