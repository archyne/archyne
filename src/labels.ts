/**
 * Where each connection's label goes, once they can all see each other.
 *
 * A label wants the middle of its route, and for a diagram with a few
 * connections that is the end of it. Import a real drawing and it is not: the
 * middle of one route is the middle of a box, or the middle of the route
 * beside it, and the plate the label is drawn on then hides a node's text, or
 * another label, or both. Nothing is wrong with any single placement — as with
 * `spread.ts`, the fault only exists between them, so as there, it can only be
 * fixed knowing every one of them at once.
 *
 * The label is moved *along its own route* first. That is the one direction
 * that costs nothing to read: wherever it ends up it is still sitting on the
 * line it names, so it never becomes unclear which connection it belongs to.
 * Only when nowhere along the route will do does it step off to the side,
 * which is a last resort because a floating label has to be traced back to
 * its line.
 *
 * There are two more things it has to keep off, and both are lines rather
 * than boxes. Its **own** connection, because the plate is opaque, so a label
 * lying along a short route covers the whole of it and the connection
 * disappears — which is what an imported drawing is full of, since two boxes
 * a hand's width apart with a long name between them is how people draw. And
 * **everybody else's**, because a label resting on a line reads as that
 * line's name: a label moved clear of its own connection and onto its
 * neighbour has not been made more readable, it has been made wrong.
 *
 * A crowded diagram has labels with nowhere clean to go at all, so this does
 * not insist: `Cost` ranks the five ways a placement can be wrong and the
 * least bad wins when there is no perfect one. Ranked rather than added up,
 * because there is no honest exchange rate between hiding someone else's
 * words and pointing at the wrong line.
 *
 * A label the user has dragged is never moved. It is where it was put, and it
 * takes part only as something for the others to avoid.
 */
import { labelLines } from "./model/label";
import type { Rect } from "./avoid";
import { absoluteBoxes } from "./boxes";
import { isGroup, type AnyNode, type DiagramKind, type FlowEdge } from "./model/types";
import { allRoutes } from "./routes";
import { drawnPoints, type Point } from "./routing";
import { NODE_FONT, textMetrics } from "./textMetrics";

/** The type size a label is drawn at, in both the canvas and the emitter. */
export const LABEL_FONT = { family: NODE_FONT.family, size: 11 };

/** How far the plate stands off the text, per side. */
export const LABEL_PAD = { x: 6, y: 3 };

/** How much clear space a label keeps around itself. */
const BREATHING_ROOM = 2;

/**
 * An overlap smaller than this is not an overlap.
 *
 * `perfect` asks for zero, and zero is the wrong question to put to a measured
 * area. Two plates that graze each other by a tenth of a square unit — a
 * fraction of one pixel of ink, at any zoom a reader will use — are not
 * overlapping in any sense that matters, and treating it as a fault is not
 * being careful, it is being wrong: a placement sitting neatly on its own
 * connection was thrown out over fourteen hundredths of a unit, and the label
 * went fifty units away to a spot that was arithmetically spotless and looked
 * like it belonged to a different arrow.
 *
 * One square unit, and one unit of length for the runs, which is below the
 * width of the lines being measured.
 */
const NOTICEABLE = 1;

/** A measurement, with the part too small to see treated as none. */
const seen = (amount: number): number => (amount < NOTICEABLE ? 0 : amount);

/**
 * How far a label stands off the line when it steps beside it.
 *
 * Not the width of the line, which is a unit and a half: an arrowhead is
 * around twelve units across, so half of it reaches six units either side of
 * the line it is drawn on, and a plate two units clear of the line is still
 * touching the head. Eight — six for the head and two of air, so it reads as
 * beside the line rather than balanced on it.
 */
const CLEAR_OF_LINE = 8;

/**
 * How far along its route a label may be slid, as a fraction of the route's
 * length either side of the middle.
 *
 * A third: past that the label is closer to one end than to the middle, and
 * reads as belonging to the node it has drifted towards rather than to the
 * connection.
 */
const REACH = 1 / 3;

/** The steps tried within that reach, nearest the middle first. */
const STEPS = 12;

/**
 * Sideways offsets that still leave the plate on the line, as fractions of
 * half its thickness across the run.
 *
 * The move a person makes without thinking: keep the label on its line, but
 * shove it up a bit so the line runs near the plate's edge instead of through
 * the middle of the words. It covers half as much of the crowded band either
 * side, and it costs nothing at all to read, because the label is still on the
 * line it names.
 *
 * Leaving these out left a hole in the search between "centred on the line"
 * and "clear of the line" — a whole plate-height wide — and in a tight lane
 * that hole is exactly where the only clean placements are.
 */
const NUDGES = [0.3, 0.6, 0.9];

/**
 * The gaps tried between the line and the near edge of a plate standing clear
 * of it, as multiples of `CLEAR_OF_LINE`.
 *
 * Multiples of the *gap* and not of the plate, which is the correction that
 * matters. Stepping "one plate further out" sounds like a small second try and
 * is nothing of the sort: for a two-word label it puts a hundred units of
 * empty space between the words and the line they name, and out there the
 * label touches nothing at all — so every rule about not covering things is
 * satisfied, and the result is a caption floating in the middle of the diagram
 * belonging to no connection a reader can find. Three gaps of eight units keep
 * the furthest one within twenty-four of its own line.
 */
const LIFTS = [1, 2, 3];

/**
 * The farther hops, as multiples of the plate's thickness across the run.
 *
 * The lifts above stop at three plate-heights out, which is enough to clear a
 * stray box that grazes a route — and not enough to clear what a *short* route
 * is usually buried in: two boxes a hand's width apart, with the label caught
 * in the twenty units between them. No position on that line fits the plate,
 * and every position near it touches one of the boxes or the other, so the
 * search pads out by a whole plate at a time until the label can stand clear
 * of the pair. Still best-first — the hop a hundred units away only wins if
 * nothing closer is acceptable — but a far clean corner now beats a near graze
 * that hides someone else's words.
 */
const HOPS = [2, 3, 4];

/**
 * How much of its own connection a label may cover before it goes beside the
 * line instead of on it.
 *
 * The plate is opaque — it has to be, or the line reads through the words —
 * so a label sitting on a short connection hides the whole of it, and the
 * connection reads as absent. Two nodes a hand's width apart with a long name
 * between them is not an unusual arrangement; it is most of what an imported
 * drawing is made of.
 *
 * Half: a plate hiding more than half its connection is a plate the arrow
 * disappears behind — the reader sees a name with no line, which is the very
 * danger the on-the-line placements exist to avoid. Seven tenths drew the
 * line too straight for the convention to protect: a short route whose name
 * eats three fifths of it still kept the label on the line, and the short
 * routes are precisely the ones whose names do that.
 */
const SWALLOWS = 0.5;

/**
 * Is the plate lying along this line, or does the line merely cross it?
 *
 * Asked as a question about which sides the line goes in and out of, and not
 * as a length, because a length needs a threshold and every threshold I tried
 * was wrong for some plate: a wide one and a nearly square one have entirely
 * different ideas of how far "along" is, and a rule tuned for one lets the
 * other through.
 *
 * The reader's impression is what is being modelled, and it is simple. A line
 * that goes in the left edge and out the right edge is a line the words are
 * written on — it runs the length of the plate and comes out the far end, so
 * the plate reads as its name. Anything else — in the top and out the bottom,
 * in the left and out the bottom, in and back out the same side — is a line
 * passing behind a label.
 *
 * Only the *first* stretch is judged. A line that dips under the plate twice
 * has already come out from under it once, which is all a reader needs.
 */
function lyingAlong(box: Rect, line: Point[]): number {
  const side = (p: Point): "left" | "right" | "top" | "bottom" | null => {
    if (p.x < box.x) return "left";
    if (p.x > box.x + box.w) return "right";
    if (p.y < box.y) return "top";
    if (p.y > box.y + box.h) return "bottom";
    return null;
  };

  let from = -1;
  for (let i = 0; i < line.length; i++) {
    if (holds(box, line[i])) {
      from = i;
      break;
    }
  }
  if (from <= 0) return 0;
  let to = from;
  while (to + 1 < line.length && holds(box, line[to + 1])) to++;
  if (to + 1 >= line.length) return 0;

  const enter = side(line[from - 1]);
  const leave = side(line[to + 1]);
  const lengthwise =
    (enter === "left" && leave === "right") || (enter === "right" && leave === "left");
  if (!lengthwise) return 0;

  let run = 0;
  for (let i = from + 1; i <= to; i++) {
    run += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
  }
  return run;
}

/**
 * The words actually drawn beside a connection.
 *
 * `data.label` is what the document says; `label` is what `presentEdge` made
 * of it, and they are not always the same string — a C4 relationship carries
 * its technology, so `Charges cards` is drawn as `Charges cards [HTTPS]`. The
 * plate has to be the size of what is *drawn*, or a C4 label is measured two
 * words short and placed as though it were.
 */
export function labelTextOf(edge: FlowEdge): string {
  if (typeof edge.label === "string" && edge.label !== "") return edge.label;
  return edge.data?.label ?? "";
}

/**
 * The plate a label is drawn on, given the text: its widest line, all its
 * lines tall. An imported label breaks often — `6443<br/>HTTPS<br/>TLS1.2` —
 * and measured as one line it claimed a plate three times too wide and a
 * third of the height it is drawn at.
 */
export function plateSize(text: string): { w: number; h: number } {
  let width = 0;
  let height = 0;
  for (const line of labelLines(text)) {
    const size = textMetrics().measure(line, LABEL_FONT);
    width = Math.max(width, size.width);
    height += size.height;
  }
  return { w: width + LABEL_PAD.x * 2, h: height + LABEL_PAD.y * 2 };
}

/** The plate, as a rectangle, centred on a point. */
export function plateBox(text: string, at: Point): Rect {
  const { w, h } = plateSize(text);
  return { x: at.x - w / 2, y: at.y - h / 2, w, h };
}

/** A rectangle with a margin round it. */
const grow = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
});

/** How much ground two rectangles cover between them, in square units. */
function shared(a: Rect, b: Rect): number {
  return (
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  );
}

/** The length of each leg of a route, and the total. */
function legs(points: Point[]): { each: number[]; total: number } {
  const each: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    each.push(d);
    total += d;
  }
  return { each, total };
}

/** The point `distance` along the route, and the direction of travel there. */
function walk(points: Point[], distance: number): { at: Point; along: Point } {
  const { each, total } = legs(points);
  const want = Math.max(0, Math.min(total, distance));
  let travelled = 0;
  for (let i = 0; i < each.length; i++) {
    if (travelled + each[i] >= want || i === each.length - 1) {
      const t = each[i] === 0 ? 0 : (want - travelled) / each[i];
      const from = points[i];
      const to = points[i + 1];
      const len = each[i] || 1;
      return {
        at: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
        along: { x: (to.x - from.x) / len, y: (to.y - from.y) / len },
      };
    }
    travelled += each[i];
  }
  return { at: points[0], along: { x: 1, y: 0 } };
}

/**
 * The middle of a route, measured by length.
 *
 * By length rather than by corner: a route with one long leg and three short
 * ones has its middle corner nowhere near its middle, and a label on it looks
 * pushed to one end for no reason a reader can see.
 */
export function midpointOf(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  return walk(points, legs(points).total / 2).at;
}

/**
 * Every place a label would rather be, best first.
 *
 * Sorted by how far the label has had to leave the line it names: first every
 * place *on* it, nearest the middle first, then the places beside it in order
 * of how far beside. Distance and not the number of steps taken to get there,
 * which is the whole point of sorting rather than nesting two loops — how far
 * a step off the line actually throws the plate depends on which way the run
 * under it travels. Stepping off a horizontal run moves it half a plate's
 * *height*, twenty units or so; off a vertical one, half its **width**, which
 * for a name of two words is three times as far. Ordering by the step number
 * tried the second before a nearer place on the other side of the same
 * corner, and a label three plate-widths from its own line is a label the
 * nearest other line will claim.
 *
 * Along the line costs nothing at all: wherever it slides it is still sitting
 * on the connection it names, so those come first whatever the distance.
 */
function choices(points: Point[], size: { w: number; h: number }): Point[] {
  const { total } = legs(points);
  const middle = total / 2;
  const stride = (total * REACH) / STEPS;

  const spots = [middle];
  for (let i = 1; i <= STEPS; i++) spots.push(middle + stride * i, middle - stride * i);

  const on: Point[] = [];
  const beside: { at: Point; off: number; along: number }[] = [];
  spots.forEach((spot, order) => {
    const { at, along } = walk(points, spot);
    on.push(at);
    // How thick the plate is across this run is what a sideways step has to
    // reckon with, and it depends on the way the run travels.
    const away = { x: -along.y, y: along.x };
    const across = Math.abs(along.x) >= Math.abs(along.y) ? size.h : size.w;
    const offsets = [
      ...NUDGES.map((k) => (across / 2) * k),
      ...LIFTS.map((n) => across / 2 + CLEAR_OF_LINE * n),
      ...HOPS.map((n) => across / 2 + CLEAR_OF_LINE * LIFTS.length + across * n),
    ];
    for (const off of offsets) {
      beside.push({
        at: { x: at.x + away.x * off, y: at.y + away.y * off },
        off,
        along: order,
      });
      beside.push({
        at: { x: at.x - away.x * off, y: at.y - away.y * off },
        off,
        along: order,
      });
    }
  });

  beside.sort((a, b) => a.off - b.off || a.along - b.along);
  return [...on, ...beside.map((b) => b.at)];
}

function holds(box: Rect, p: Point): boolean {
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}

/**
 * How far back from the end of a route the arrowhead reaches.
 *
 * The marker itself is about ten units long; a little more than that is the
 * stretch a reader's eye needs to see which line the head belongs to.
 */
export const HEAD_REACH = 16;

/** How finely the stretch a head covers is sampled. */
const HEAD_STEP = 2;

/**
 * The room kept between a label and an arrowhead. Labels are placed from
 * measured text and drawn by the browser, and the two disagree by a pixel or
 * two from one font to the next — with none to spare, a plate that cleared a
 * head on Windows sat on it on Linux.
 */
const HEAD_CLEARANCE = 6;

/**
 * The points along the first `reach` units of a line: where its marker is
 * drawn. Sampled rather than taken at the corners, since a head on a straight
 * last leg has no corner under it but its tip — and a plate could cover the
 * rest of it while missing that one point.
 */
function alongFrom(line: Point[], reach: number): Point[] {
  const out: Point[] = [line[0]];
  let walked = 0;
  let next = HEAD_STEP;
  for (let i = 1; i < line.length && next <= reach; i++) {
    const a = line[i - 1];
    const b = line[i];
    const leg = Math.hypot(b.x - a.x, b.y - a.y);
    while (next <= reach && next <= walked + leg) {
      const t = leg === 0 ? 0 : (next - walked) / leg;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      next += HEAD_STEP;
    }
    walked += leg;
  }
  return out;
}

/**
 * One connection as it is drawn: the line, its two ends, and what it covers.
 *
 * The bounds are the reason this is worth building once. Deciding a label's
 * place asks, of every candidate, whether it lands on somebody else's line —
 * and on a big drawing almost every answer is "that line is nowhere near
 * here", which a rectangle settles in four comparisons instead of hundreds.
 */
export interface Drawn {
  id: string;
  /** The line, corners cut the way the renderer cuts them. */
  line: Point[];
  /** The stretch at each end that the marker occupies. */
  heads: Point[];
  bounds: Rect;
}

function boundsOf(points: Point[]): Rect {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const p of points) {
    x1 = Math.min(x1, p.x);
    y1 = Math.min(y1, p.y);
    x2 = Math.max(x2, p.x);
    y2 = Math.max(y2, p.y);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Every connection, drawn.
 *
 * The heads are both ends, not just the pointed one: a class diagram's
 * inheritance triangle and an ER diagram's crow's foot are drawn at the start,
 * and either way the last stretch of a line is where it says which box it is
 * talking about. Corners are cut as the renderer cuts them — the last corner
 * of a route is often within a marker's length of its end, so the head sits on
 * the rounded part.
 */
export function drawnLines(routes: Map<string, Point[]>): Drawn[] {
  const out: Drawn[] = [];
  for (const [id, route] of routes) {
    if (route.length < 2) continue;
    const line = drawnPoints(route);
    const heads = [
      ...alongFrom(line, HEAD_REACH),
      ...alongFrom([...line].reverse(), HEAD_REACH),
    ];
    out.push({ id, line, heads, bounds: boundsOf(line) });
  }
  return out;
}

/**
 * What is wrong with a placement, in the order it matters.
 *
 * Five separate harms, and they are not worth trading off against each other
 * with weights nobody could defend, so they are compared in order and a
 * placement is better than another only if it is better at the first thing
 * they differ on:
 *
 *   - **`onHead`** — over an arrowhead. First because it is the worst and the
 *     easiest to avoid: a head is a small target, so there is nearly always
 *     somewhere else to stand, and a covered one takes with it the one thing
 *     the line was drawn to say, which of the two boxes it points at. Any
 *     connection's head, not just this label's own: the reader is tracing a
 *     line, and does not care whose label is sitting on the end of it.
 *   - **`onStranger`** — lying *along* a connection that is not the one it
 *     names. Second because it does not merely hide something, it says
 *     something false: a label resting on a line reads as that line's name, so
 *     moving one clear of its own connection and onto its neighbour has not
 *     made the drawing more readable, it has made it wrong.
 *
 *     Along, not across — but only while the label is still touching the line
 *     it names. A plate sitting on its own connection can be crossed by
 *     anything: the reader can see what it belongs to, and a line passing
 *     behind it reads as a line passing behind a label. A plate that has had
 *     to step away from its own connection has no such protection, and the
 *     nearest line it touches will be read as its own — so once it is off its
 *     own line it must be clear of every other one too, crossings included.
 *     `lyingAlong` is what tells the two apart.
 *   - **`onNode`** — over a box, hiding someone else's words.
 *   - **`onLabel`** — over another label, hiding its words.
 *   - **`hidden`** — lying along its own connection, hiding the line. Near
 *     the bottom because a label is *meant* to interrupt the line it names; it
 *     only counts once the plate covers most of the connection, and it is
 *     measured against the route rather than guessed at from its length — a
 *     route that turns twice has its middle on a corner, where the plate lies
 *     across the line rather than along it, and no arithmetic on the total
 *     says so.
 *   - **`crossed`** — how many other connections pass behind the plate. Last,
 *     and only a count, because being crossed is the mildest of these: the
 *     label is still on its own line and the crossing line comes out the other
 *     side, so nothing is misread. But a crossing is still a break in
 *     somebody's line, and where two placements are otherwise equally good the
 *     one interrupting fewer of them is better. It settles ties rather than
 *     driving the search, which matters: widening the lanes the router fans
 *     coincident runs into barely touches this number — the crossings are
 *     mostly connections genuinely travelling across each other, which no
 *     amount of spacing separates — so the only thing that helps is the label
 *     stepping aside, and only when there is somewhere to step.
 */
interface Cost {
  onHead: number;
  onStranger: number;
  onNode: number;
  onLabel: number;
  hidden: number;
  crossed: number;
}

/** Do two rectangles touch at all? The cheap test before the dear one. */
function near(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

function costOf(
  box: Rect,
  obstacles: Rect[],
  taken: Rect[],
  mine: Drawn,
  lines: Drawn[],
): Cost {
  // A plate that has left its own connection cannot afford even a crossing:
  // there is nothing else nearby for the reader to attach it to.
  const touchingMine = mine.line.some((p) => holds(box, p));
  let onHead = 0;
  let onStranger = 0;
  let crossed = 0;
  const clear = grow(box, HEAD_CLEARANCE);
  for (const other of lines) {
    if (!near(clear, other.bounds)) continue;
    if (other.heads.some((p) => holds(clear, p))) onHead++;
    if (other.id === mine.id) continue;
    const along = seen(lyingAlong(box, other.line));
    if (along > 0) {
      onStranger += along;
    } else if (other.line.some((p) => holds(box, p))) {
      if (touchingMine) crossed++;
      else onStranger += NOTICEABLE;
    }
  }
  const on = mine.line.filter((p) => holds(box, p)).length;
  return {
    onHead,
    onStranger,
    onNode: seen(obstacles.reduce((sum, o) => sum + shared(box, o), 0)),
    onLabel: seen(taken.reduce((sum, o) => sum + shared(grow(box, BREATHING_ROOM), o), 0)),
    hidden: on > mine.line.length * SWALLOWS ? on : 0,
    crossed,
  };
}

/** Nothing wrong with it at all: the search can stop here. */
const perfect = (c: Cost): boolean =>
  c.onHead === 0 &&
  c.onStranger === 0 &&
  c.onNode === 0 &&
  c.onLabel === 0 &&
  c.hidden === 0 &&
  c.crossed === 0;

const better = (a: Cost, b: Cost): boolean =>
  a.onHead !== b.onHead
    ? a.onHead < b.onHead
    : a.onStranger !== b.onStranger
      ? a.onStranger < b.onStranger
      : a.onNode !== b.onNode
        ? a.onNode < b.onNode
        : a.onLabel !== b.onLabel
          ? a.onLabel < b.onLabel
          : a.hidden !== b.hidden
            ? a.hidden < b.hidden
            : a.crossed < b.crossed;

/** One connection's label: the text, and where it ended up. */
export interface Placed {
  text: string;
  at: Point;
  box: Rect;
}

/**
 * Where every label goes.
 *
 * Settled in edge order, which the document fixes, so that the same diagram
 * always places them the same way — the drawing must not depend on which edge
 * happened to render first.
 */
export function placeLabels(
  edges: FlowEdge[],
  routes: Map<string, Point[]>,
  obstacles: Rect[],
): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const taken: Rect[] = [];
  // Every connection as drawn, worked out once: what a label has to keep off
  // is not only the line it names but all of them, and their ends most of all.
  const lines = drawnLines(routes);
  const byId = new Map(lines.map((l) => [l.id, l]));

  // Hand-placed labels first, whatever order they come in: they cannot move,
  // so every label that can must be free to avoid all of them.
  const labelled = edges.filter((e) => labelTextOf(e) !== "");
  const moved = (e: FlowEdge) => {
    const off = e.data?.style?.label;
    return off && (off.x !== 0 || off.y !== 0) ? off : null;
  };
  const settled = [...labelled].sort((a, b) => Number(!!moved(b)) - Number(!!moved(a)));

  for (const edge of settled) {
    const route = routes.get(edge.id);
    const text = labelTextOf(edge);
    if (!route || route.length < 2) continue;

    const off = moved(edge);
    if (off) {
      const anchor = midpointOf(route);
      const at = { x: anchor.x + off.x, y: anchor.y + off.y };
      const box = plateBox(text, at);
      out.set(edge.id, { text, at, box });
      taken.push(box);
      continue;
    }

    const size = plateSize(text);
    // The line as drawn, so a plate is judged against the shape a reader sees.
    const mine = byId.get(edge.id);
    if (!mine) continue;
    // The first candidate that is wrong in no way at all wins, and since the
    // candidates come out best-first that is also the smallest move. Failing
    // that — a crowded diagram has labels with nowhere clean to go — the least
    // bad one wins, which is what stops a hopeless case from falling back on
    // the very placement the search set out to avoid.
    let placed: { at: Point; box: Rect } | null = null;
    let cost: Cost | null = null;
    for (const at of choices(route, size)) {
      const box = plateBox(text, at);
      const now = costOf(box, obstacles, taken, mine, lines);
      if (perfect(now)) {
        placed = { at, box };
        break;
      }
      if (!cost || better(now, cost)) {
        placed = { at, box };
        cost = now;
      }
    }

    out.set(edge.id, { text, at: placed!.at, box: placed!.box });
    taken.push(placed!.box);
  }

  return out;
}

let cached: {
  nodes: AnyNode[];
  edges: FlowEdge[];
  kind: DiagramKind;
  labels: Map<string, Placed>;
} | null = null;

/**
 * Every label's place, by edge id.
 *
 * Held by the identity of the arrays it was worked out from, exactly as
 * `allRoutes` is: the canvas asks once per edge per render and the emitter
 * asks once per drawing, and both have to be given the same answer or a
 * picture would not export as it appears.
 *
 * Groups are not obstacles. Everything on the canvas is inside one, so
 * avoiding them would leave nowhere for a label to go; what a label must stay
 * off is the boxes that carry text of their own.
 */
export function allLabels(
  nodes: AnyNode[],
  edges: FlowEdge[],
  kind: DiagramKind,
): Map<string, Placed> {
  if (cached && cached.nodes === nodes && cached.edges === edges && cached.kind === kind) {
    return cached.labels;
  }
  const solid = nodes.filter((n) => !isGroup(n));
  const boxes = absoluteBoxes(nodes);
  const obstacles = solid.map((n) => boxes.get(n.id)).filter((b): b is Rect => !!b);
  const labels = placeLabels(edges, allRoutes(nodes, edges, kind), obstacles);
  cached = { nodes, edges, kind, labels };
  return labels;
}
