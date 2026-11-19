/**
 * Every connection's route, worked out once.
 *
 * Each edge used to route itself while it rendered. That was tolerable while
 * a route depended only on its own two nodes, and stopped being so for two
 * reasons at once. The obstacle search is not cheap, and running it inside a
 * render meant running it again for every frame of a node drag. And an edge
 * cannot know where to hop over another edge without knowing where that other
 * edge went — which it cannot ask, because the other edge is deciding the
 * same thing at the same moment.
 *
 * So the routing happens here, for all of them together, and the answer is
 * kept until the nodes or the edges change. React renders every edge in one
 * pass from the same arrays, so the first edge to ask pays and the rest read.
 */
import { absoluteBoxes } from "./boxes";
import { isGroup, type AnyNode, type DiagramKind, type FlowEdge } from "./model/types";
import {
  attachPoint,
  axisOfSide,
  bestSides,
  facesAway,
  orthogonalRoute,
  outward,
  STUB,
  tidy,
  withStubs,
  type Axis,
  type FaceReach,
  type Side,
} from "./orthogonal";
import { blocked, CLEARANCE, crosses, routeAround, type Rect } from "./avoid";
import {
  alignWithCorners,
  berthRange,
  HEAD_ROOM,
  separateHeads,
  spreadBerths,
  straightenNearlyLevel,
  type QuayOf,
} from "./berths";
import { holds, SAME_LINE, spreadRuns } from "./spread";
import type { Point } from "./routing";
import { outlineDepth } from "./render/shapes";
import type { Shape } from "./model/types";
import { styleProps } from "./model/nodeStyle";

/**
 * The margins and stubs the obstacle search tries, in order, until one finds
 * a way. The first is the usual one; the others are for nodes packed closer
 * than it allows, and still keep a line passing a box off its border.
 */
const TRIES: Array<[clearance: number, stub: number]> = [
  [CLEARANCE, STUB],
  [6, STUB],
  [4, STUB / 2],
];

/** The letters mermaid writes into an architecture diagram, as faces. */
const AUTHORED: Record<string, Side> = {
  L: "left",
  R: "right",
  T: "top",
  B: "bottom",
};

/**
 * The whole connection routed around what is in its way, leg by leg.
 *
 * Leg by leg rather than end to end because the corners the user placed are
 * not suggestions: the line goes through them, and only the way it gets from
 * one to the next is the router's business. A leg with no way round is left
 * as it was — a line through a box is poor, a line that vanishes is worse —
 * unless `strict` asks for `null` instead, so the caller can try another way.
 */
function aroundObstacles(
  anchors: Point[],
  from: Axis,
  to: Axis,
  obstacles: Rect[],
  opts: {
    leave?: Point;
    arrive?: Point;
    clearance?: number;
    strict?: boolean;
    soft?: Rect[];
  } = {},
): Point[] | null {
  // A corner standing where a stub ends is no leg at all — and that is where
  // the corner pinning an end to its face stands, a stub out from it. Searched
  // as a leg, it had nowhere to go and a direction to arrive in, and went
  // round the block to come back to where it started; and the leg before it,
  // no longer the last, was free to arrive from any side, so the line reached
  // its pin and turned straight back. Taken out first, the leg into the pin
  // is the last one and arrives the way the face needs.
  anchors = anchors.filter(
    (p, i) =>
      i === 0 ||
      Math.abs(p.x - anchors[i - 1].x) >= 0.5 ||
      Math.abs(p.y - anchors[i - 1].y) >= 0.5,
  );
  if (anchors.length < 2) return anchors;
  const out: Point[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const first = i === 0 ? from : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? "x" : "y";
    const last =
      i === anchors.length - 2 ? to : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? "x" : "y";
    const found = routeAround(
      a,
      b,
      first,
      last,
      obstacles,
      opts.clearance,
      i === 0 ? opts.leave : undefined,
      i === anchors.length - 2 ? opts.arrive : undefined,
      opts.soft,
    );
    if (!found && opts.strict) return null;
    const leg = found ?? orthogonalRoute([a, b], first, last);
    out.push(...(out.length ? leg.slice(1) : leg));
  }
  return tidy(out);
}

/** Where a connection meets its two nodes, and by which faces. */
export interface Ends {
  start: Point;
  end: Point;
  from: Axis;
  to: Axis;
  fromSide: Side;
  toSide: Side;
}

/**
 * How far a loop back to the same node stands off it.
 *
 * `STUB` is the step a connection takes away from a face before it turns,
 * and a loop is two of those with a corner between them: any less and the
 * line would run along the node's own edge.
 */
const LOOP = STUB;

/**
 * The faces a connection uses.
 *
 * An architecture diagram writes them into the file (`web:R --> L:db`), where
 * they are the author's decision and not a guess of ours. Everywhere else
 * they follow the geometry, which is Visio's dynamic glue.
 */
export function endsOf(
  edge: FlowEdge,
  boxes: Map<string, Rect>,
  kind: DiagramKind,
): Ends | null {
  const fromBox = boxes.get(edge.source);
  const toBox = boxes.get(edge.target);
  if (!fromBox || !toBox) return null;

  // A connection from a node to itself. `bestSides` compares two centres,
  // and for one box against itself every difference is zero — it answered
  // "leave the bottom, arrive at the top", which asks the router to get from
  // under the node to above it. It did: out of the bottom, down past the
  // label, around the outside of the group and back. Two adjacent faces are
  // what a loop wants, and the corner between them is where it goes.
  //
  // An architecture diagram writes its faces into the file, and they are the
  // author's here as much as anywhere — `db:B --> L:db` is a loop round the
  // bottom-left corner. Only when they are adjacent, though: two opposite
  // faces are the very request that produced the tour, and one face twice
  // has no corner to go round.
  if (edge.source === edge.target) {
    const authored =
      kind === "architecture"
        ? { from: AUTHORED[edge.sourceHandle ?? ""], to: AUTHORED[edge.targetHandle ?? ""] }
        : null;
    const usable =
      authored?.from &&
      authored.to &&
      axisOfSide(authored.from) !== axisOfSide(authored.to) &&
      (authored as { from: Side; to: Side });
    const sides = usable || { from: "right" as Side, to: "top" as Side };
    return {
      start: attachPoint(fromBox, sides.from),
      end: attachPoint(fromBox, sides.to),
      from: axisOfSide(sides.from),
      to: axisOfSide(sides.to),
      fromSide: sides.from,
      toSide: sides.to,
    };
  }

  const named =
    kind === "architecture"
      ? {
          from: AUTHORED[edge.sourceHandle ?? ""] ?? "right",
          to: AUTHORED[edge.targetHandle ?? ""] ?? "left",
        }
      : null;

  // A named face is the author's decision and is kept — unless the nodes have
  // since been arranged so that it points away from the other one. Obeying it
  // then sends the line back across a node's own box, which is how an
  // arrowhead ends up hidden behind a block.
  const stale =
    named !== null &&
    (facesAway(fromBox, named.from, toBox) || facesAway(toBox, named.to, fromBox));
  const sides = named && !stale ? named : facesFor(edge, fromBox, toBox);

  return {
    start: attachPoint(fromBox, sides.from),
    end: attachPoint(toBox, sides.to),
    from: axisOfSide(sides.from),
    to: axisOfSide(sides.to),
    fromSide: sides.from,
    toSide: sides.to,
  };
}

/** How far a corner may be drawn from where it is stored to meet its end square. */
const TURN_SLACK = 3 * HEAD_ROOM;

/**
 * The corners a route is drawn through, with the turn into each end lined up
 * with that end, and a stub clear of its face.
 *
 * The corner a line turns at to go into a node sits level with where it
 * meets the node — draw.io puts it at the node's middle row. When the end has
 * since been moved along the face, to stand clear of another arrowhead, the
 * line went to the corner's row, turned, and came back a few units to its
 * end: a spike, and in a bus of connections sharing one corner a dozen of
 * them lying on each other. So a corner in front of the face and only a few
 * units out of line with its end is drawn level with it. The stored corner is
 * untouched; only the drawing turns where the end now is.
 */
function turnsInto(corners: Point[], ends: Ends): Point[] {
  if (corners.length === 0) return corners;
  const out = corners.map((c) => ({ ...c }));
  // `at` is the corner by the end, `next` the index of the point the line
  // reaches it from on the other side (-1 for the far end itself).
  const level = (at: number, next: number, end: Point, side: Side, far: Point) => {
    const c = out[at];
    const beside = next >= 0 ? out[next] : far;
    const along = axisOfSide(side) === "x" ? "y" : "x";
    const normal = along === "x" ? "y" : "x";
    const d = outward(side);
    const ahead = (c.x - end.x) * d.x + (c.y - end.y) * d.y;
    if (ahead <= 0.5) return;
    // A run lying along the face already, from `beside` to this corner.
    const running = Math.abs(beside[normal] - c[normal]) < 0.5;
    // How far it may be drawn from where it is stored: a little, ordinarily —
    // but any distance when the line reaches it running along the face
    // already. Then the corner is only where that run stops, and stopping it
    // level with the end is a shorter run, not a different route. draw.io
    // puts that corner on a group's corner, a long way off any berth, and the
    // line went there and came back.
    const off = Math.abs(c[along] - end[along]);
    if (off > 0.5 && off <= (running ? Infinity : TURN_SLACK)) c[along] = end[along];
    // A corner hard against the face — draw.io leaves one a unit off it to
    // mark where the line comes out — is drawn a whole stub away, so the line
    // leaves square and has room to be moved aside. Drawn where it is, the
    // line ran down the face's own edge. A run along the face goes out with
    // it, or its far end would be left behind and the line fold back to it.
    if (ahead < STUB) {
      c[normal] = end[normal] + d[normal] * STUB;
      if (running && next >= 0) out[next][normal] = c[normal];
    }
  };
  const last = out.length - 1;
  // A single corner is the turn at both ends, and is lined up with each.
  level(0, last > 0 ? 1 : -1, ends.start, ends.fromSide, ends.end);
  level(last, last > 0 ? last - 1 : -1, ends.end, ends.toSide, ends.start);
  return out;
}

/** The corners that lie inside neither of two boxes. */
function clearOf(points: Point[], a?: Rect, b?: Rect): Point[] {
  const within = (p: Point, r?: Rect) =>
    !!r && p.x > r.x + 0.5 && p.x < r.x + r.w - 0.5 && p.y > r.y + 0.5 && p.y < r.y + r.h - 0.5;
  const out = points.filter((p) => !within(p, a) && !within(p, b));
  return out.length === points.length ? points : out;
}

/**
 * The faces a connection with corners of its own should use.
 *
 * The two boxes decide, by where each lies from the other — unless a corner
 * stands behind or level with the face that gives: then the line is not
 * heading out that way at all. It is heading for its first corner and
 * arriving from its last, and the face is chosen against that corner, which
 * is how Visio and draw.io glue a routed connector. Without it, a connection
 * whose first corner stood beside its source left by the face pointing
 * elsewhere, went out, turned back to collect the corner, and tied a knot.
 *
 * A corner in front of the face changes nothing. That is the corner a slid
 * run leaves, and moving the exit round to it would turn the slide into a
 * different route from the one the user dragged.
 */
function facesFor(edge: FlowEdge, fromBox: Rect, toBox: Rect): { from: Side; to: Side } {
  const sides = bestSides(fromBox, toBox);
  const corners = clearOf(edge.data?.points ?? [], fromBox, toBox);
  if (corners.length === 0) return sides;
  const at = (p: Point): Rect => ({ x: p.x, y: p.y, w: 0, h: 0 });
  const ahead = (box: Rect, side: Side, p: Point) => {
    const face = attachPoint(box, side);
    const d = outward(side);
    return (p.x - face.x) * d.x + (p.y - face.y) * d.y > 0;
  };
  const first = corners[0];
  const last = corners[corners.length - 1];
  return {
    from: ahead(fromBox, sides.from, first) ? sides.from : bestSides(fromBox, at(first)).from,
    to: ahead(toBox, sides.to, last) ? sides.to : bestSides(at(last), toBox).to,
  };
}

/**
 * The arrowhead's arrival, squared up again.
 *
 * `spreadRuns` separates coincident corridors by sliding a whole run sideways.
 * When the run it slides is the one a connection *arrives* on, the slide's
 * pinned corner lands on the plane of the face the connection is heading for,
 * and the line then runs the last few units along the face itself before it
 * meets the box — an arrowhead on the end of that reads as arriving sideways.
 * The router aimed square-on; the pass that separates the corridors slipped
 * it. So after the runs have been put back apart, the arrival is straightened
 * once more: a corner that has been slid onto the box's own plane is pushed
 * back out to a full stub, and the straight run into the face is whole again.
 *
 * Only when nothing stands where the stub would go: a route whose own
 * approach cannot be rebuilt squared is left as the slide left it, which is
 * poor but drawn, and never drawn-and-gone.
 */
function dressArrival(
  route: Point[],
  ends: Ends | undefined,
  solid: Array<[string, Rect]>,
  edge: FlowEdge,
): Point[] {
  if (!ends || route.length < 2) return route;
  const at = route[route.length - 1];
  const prev = route[route.length - 2];
  const same = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
  if (same(prev, at)) return route;

  // The face plane is constant on one axis: x for a left/right face, y for a
  // top/bottom one. A proper arrival ends a long way from the face on the
  // other axis; a corner on the plane with a short tail is a slide victim.
  const face: Axis = ends.to === "x" ? "x" : "y";
  const along: Axis = ends.to === "x" ? "y" : "x";
  if (Math.abs(prev[face] - at[face]) >= 0.5) return route;
  if (Math.abs(prev[along] - at[along]) >= STUB) return route;

  const out = outward(ends.toSide);
  const away = { x: at.x + out.x * STUB, y: at.y + out.y * STUB };
  // Carry the run that reached `prev` on to the stub column, then across it,
  // then in: `prev` ↔ `projected` ↔ `away` ↔ `at`. A segment already in place
  // is left alone, so a corner already at the stub column keeps its shape.
  const projected = { ...prev, [face]: away[face] };

  const obstacles = solid
    .filter(([id]) => id !== edge.source && id !== edge.target)
    .map(([, b]) => b);
  const pieces: Point[] = [prev];
  if (!same(prev, projected)) pieces.push(projected);
  if (!same(projected, away)) pieces.push(away);
  pieces.push(at);
  for (let i = 1; i < pieces.length; i++)
    if (blocked(pieces[i - 1], pieces[i], obstacles)) return route;
  return [...route.slice(0, route.length - 2), ...pieces];
}

/** One connection's route: squared off, and around whatever is in the way. */
function routeOf(
  edge: FlowEdge,
  solid: Array<[string, Rect]>,
  ends: Ends | null,
  boxes?: Map<string, Rect>,
  foreign: Rect[] = [],
): Point[] {
  if (!ends) return [];

  // A loop back to the same node: out of one face, round the corner it shares
  // with the other, and in again. Squared off like everything else here
  // rather than drawn as mermaid's little arc, because it is the same
  // connector as the rest and takes the same corners, hops and label. No
  // obstacle search either — it never leaves the node it belongs to, so
  // there is nothing on the way.
  if (edge.source === edge.target) {
    const away = outward(ends.fromSide);
    const back = outward(ends.toSide);
    const out = { x: ends.start.x + away.x * LOOP, y: ends.start.y + away.y * LOOP };
    const into = { x: ends.end.x + back.x * LOOP, y: ends.end.y + back.y * LOOP };
    // The faces are adjacent, so one leg is horizontal and the other
    // vertical: the corner is simply where the two stubs meet.
    const corner = { x: away.x !== 0 ? out.x : into.x, y: away.y !== 0 ? out.y : into.y };
    const user = edge.data?.points ?? [];
    return tidy([ends.start, out, ...user, ...(user.length ? [] : [corner]), into, ends.end]);
  }

  // The corners the line is drawn through: not one lying inside either of
  // its own boxes. Such a corner still says where along the faces the line
  // should meet them — the berths are lined up with it — but the line cannot
  // go to it: a drop from an icon to the bus under it, held by a corner
  // midway, had that corner under the icon's own caption, went up to it out
  // of the icon's foot and came back down.
  const corners = clearOf(
    edge.data?.points ?? [],
    boxes?.get(edge.source),
    boxes?.get(edge.target),
  );

  // A connector leaves a face perpendicular to it before it turns; without
  // that, two nodes joined side to side down a column produced a line flat
  // against both of them, arrowhead included.
  // Two faces looking at each other from closer than two stubs share the
  // gap between them, half each. Full stubs crossed over: out past the far
  // face, back, and in — a spike in a line that wanted to be straight.
  const out = outward(ends.fromSide);
  const facing =
    corners.length === 0 &&
    out.x === -outward(ends.toSide).x &&
    out.y === -outward(ends.toSide).y
      ? (ends.end.x - ends.start.x) * out.x + (ends.end.y - ends.start.y) * out.y
      : Infinity;
  // However far apart across: this was once only for faces more or less
  // looking at each other, on the reasoning that two a long way aside have
  // room to go round. They have not — the faces are fixed by then — and two
  // icons in neighbouring rows, a box-width apart, were joined by a line
  // that went down past the lower one's head and came back up to it.
  const stub = facing > 0 && facing < 2 * STUB ? facing / 2 : STUB;
  const anchors = withStubs(
    [ends.start, ...turnsInto(corners, ends), ends.end],
    ends.fromSide,
    ends.toSide,
    stub,
  );

  // Straight and curved both go directly from corner to corner; only the
  // drawing differs, and that is the edge's business, not the router's. They
  // also skip the obstacle search, since a line the user asked to be direct
  // is not one to send round the houses.
  //
  // And with no step out of the face first: a direct line leaves its node
  // towards where it is going, as draw.io draws one. Stepped out square, a
  // line from a router down to a device set off with a hook, and a curve
  // through those hooks became an S. A corner lying on the face the line
  // leaves by — the point draw.io pinned the end to — is where it starts.
  if (edge.data?.style?.route === "straight" || edge.data?.style?.route === "curved") {
    // On any face of its own node, not only the one the router would have
    // chosen: a mesh router's lines are pinned to its foot, and taken only
    // when the router happened to choose the foot, half of them set off
    // from its side instead.
    const points = [...(edge.data?.points ?? [])];
    const onBorder = (p: Point | undefined, id: string, at: Point, side: Side) => {
      if (!p) return false;
      const b = boxes?.get(id);
      if (!b)
        return (outward(side).x !== 0 ? Math.abs(p.x - at.x) : Math.abs(p.y - at.y)) < 1.5;
      const inside =
        p.x >= b.x - 1.5 &&
        p.x <= b.x + b.w + 1.5 &&
        p.y >= b.y - 1.5 &&
        p.y <= b.y + b.h + 1.5;
      // On the border, or a little inside it: a picture's node is its
      // picture with a few units of padding round it, so the point draw.io
      // pinned to the picture's foot lies just inside the node, and missed
      // by a strict test the line set off from a side instead, in a hook.
      return inside;
    };
    const start = onBorder(points[0], edge.source, ends.start, ends.fromSide)
      ? points.shift()!
      : ends.start;
    const end = onBorder(points[points.length - 1], edge.target, ends.end, ends.toSide)
      ? points.pop()!
      : ends.end;
    return tidy([start, ...points, end]);
  }

  const squared = orthogonalRoute(anchors, ends.from, ends.to);

  // Every node that stands in the way (see `obstaclesOf`). The two a
  // connection joins stay in — it may touch them at the faces it uses, which
  // is the one allowance the obstacle tolerance makes, but nothing draws
  // through either box's middle. Leave them out and a route that approaches
  // its face from the wrong side cuts across the node it is heading for and
  // comes straight back out, leaving the arrowhead on a spike.
  const obstacles = solid.map(([, b]) => b);

  // Cheap, and it decides whether the expensive thing runs at all. Passing
  // through a subgraph the connection has nothing to do with counts: the
  // search may still go that way, but only when going round costs more.
  //
  // Not a frame one of its ends lies in, though — a box straddling two lanes
  // without belonging to either. There is no keeping out of that one.
  const within = (p: Point, r: Rect) =>
    p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
  const avoidable = foreign.filter((r) => !within(ends.start, r) && !within(ends.end, r));
  const obstructed = squared.some(
    (q, i) =>
      i > 0 && (blocked(squared[i - 1], q, obstacles) || blocked(squared[i - 1], q, avoidable)),
  );
  if (!obstructed) return squared;

  // The search starts a stub out from each face, not on it. A point on the
  // face lies inside its own node's clearance, and every step from there
  // counts as blocked — so the search gave up on any connection whose ends
  // faced each other, and the fallback drove it straight through whatever
  // stood between them. It also knows which way the line is already going at
  // each stub, so it cannot fold straight back towards the face.
  //
  // Nodes closer together than a stub and a clearance leave a stub inside a
  // neighbour's margin, and the search finds nothing; a tighter margin, and
  // then a shorter stub as well, are tried before falling back to the legs as
  // they were.
  const inward = outward(ends.toSide);
  const placed = corners.length > 0;
  for (const [clearance, stub] of TRIES) {
    const away = (p: Point, side: Side): Point => {
      const d = outward(side);
      return { x: p.x + d.x * stub, y: p.y + d.y * stub };
    };
    const stubbed = [away(ends.start, ends.fromSide), ...corners, away(ends.end, ends.toSide)];
    const legs = aroundObstacles(stubbed, ends.from, ends.to, obstacles, {
      leave: outward(ends.fromSide),
      arrive: { x: -inward.x, y: -inward.y },
      clearance,
      strict: true,
      soft: avoidable,
    });
    if (!legs) continue;
    const found = tidy([ends.start, ...legs, ends.end]);
    if (!placed || !reverses(found)) return found;
  }
  const last = aroundObstacles(anchors, ends.from, ends.to, obstacles, { soft: avoidable })!;
  // The corners someone placed are gone through, leg by leg, and a leg that
  // has to go round a box can only set off the way the last one arrived or
  // turn — so with a box in an awkward place the line went up to its corner
  // and straight back down past it. A line across a box is poor; one that
  // doubles back on itself reads as two. Then it is drawn as it was placed.
  return placed && reverses(last) ? squared : last;
}

/**
 * The nodes a connection has to go round, by id.
 *
 * Not the groups: a connection between two members of one must not be walled
 * in by its own container. And not two kinds of node that are drawn as nodes
 * but behave as something else:
 *
 *   - **A box with other boxes inside it.** A panel laid behind part of a
 *     diagram — a VPC, a swimlane, a coloured background, very often in
 *     imported drawings — is a frame, whatever its file calls it. As an
 *     obstacle it walled in every connection that started inside it, and the
 *     search gave up and drew straight through.
 *   - **Words with no box.** No fill and no stroke: a note, a caption, often
 *     a "Yes" laid on the very line it names. Going round it took the line
 *     away from its own label. A picture is drawn the same way — no fill, no
 *     stroke — but it is a thing, not words, and a line through an imported
 *     icon ran across the service it stood for.
 *   - **A marker.** Something small that nothing is joined to: the numbered
 *     badge a drawing lays on each of its lines to say which step it is. It
 *     is on the line on purpose, and going round it put a hump in every line
 *     that had been drawn straight through its own number.
 */
function obstaclesOf(
  nodes: AnyNode[],
  boxes: Map<string, Rect>,
  edges: FlowEdge[],
): Array<[string, Rect]> {
  const joined = new Set(edges.flatMap((e) => [e.source, e.target]));
  const marker = (n: AnyNode) => {
    const box = boxes.get(n.id)!;
    return !joined.has(n.id) && box.w <= MARKER && box.h <= MARKER;
  };
  const candidates = nodes.filter((n) => !isGroup(n) && boxes.has(n.id) && !marker(n));
  const encloses = (a: Rect, b: Rect) =>
    a.w * a.h > b.w * b.h &&
    b.x >= a.x - 0.5 &&
    b.y >= a.y - 0.5 &&
    b.x + b.w <= a.x + a.w + 0.5 &&
    b.y + b.h <= a.y + a.h + 0.5;
  const bare = (n: AnyNode) => {
    if (n.type !== "shape" || (n.data as { img?: string }).img) return false;
    const drawn = styleProps((n.data as { styles?: string[] }).styles ?? []);
    const none = (v?: string) => v === "none" || v === "transparent";
    return none(drawn.fill) && none(drawn.stroke);
  };
  return candidates
    .filter((n) => !bare(n))
    .filter((n) => {
      const box = boxes.get(n.id)!;
      return !candidates.some((o) => o !== n && encloses(box, boxes.get(o.id)!));
    })
    .map((n) => [n.id, boxes.get(n.id)!]);
}

/** The most a node nothing is joined to can measure, each way, and be a marker. */
const MARKER = 40;

/**
 * Where a picture node's picture is, within its box.
 *
 * The box holds the picture, its caption and the padding round both, and is
 * wider than the picture whenever the caption is. A line drawn in draw.io
 * hard beside an icon — "VNet peering" running down past its own glyph —
 * met the padding, and went round the box in a loop. The picture is the
 * thing in the way; the padding beside it is not.
 */
function pictureOnly(n: AnyNode, box: Rect): Rect {
  const data = n.data as {
    img?: string;
    imgWidth?: number;
    imgHeight?: number;
    imgPos?: string;
  };
  if (n.type !== "shape" || !data.img || !data.imgWidth || !data.imgHeight) return box;
  const w = Math.min(box.w, data.imgWidth);
  const h = Math.min(box.h, data.imgHeight);
  // `.shape-label.with-image`: the picture is centred across, and stands
  // 6px from the top, or from the bottom when its caption is above it.
  const y = data.imgPos === "t" ? box.y + box.h - 6 - h : box.y + Math.min(6, box.h - h);
  return { x: box.x + (box.w - w) / 2, y, w, h };
}

/**
 * The outline a node is drawn with, where it is not simply its box.
 *
 * A flowchart shape names its own; a state diagram's start and end markers are
 * circles and its choice a diamond. Everything else is drawn as its box.
 */
function outlineOf(node: AnyNode | undefined): Shape | null {
  if (!node) return null;
  if (node.type === "shape") return (node.data as { shape?: Shape }).shape ?? null;
  if (node.type === "state") {
    const t = (node.data as { stateType?: string }).stateType;
    if (t === "start" || t === "end") return "circle";
    if (t === "choice") return "diamond";
  }
  return null;
}

/** How far inside `side` of the node's box its outline is, at `at` along it. */
function depthAt(
  node: AnyNode | undefined,
  box: Rect | undefined,
  side: Side,
  at: number,
): number {
  const shape = outlineOf(node);
  if (!shape || !box) return 0;
  const local = axisOfSide(side) === "x" ? at - box.y : at - box.x;
  return outlineDepth(shape, box.w, box.h, side, local);
}

/**
 * A route carried on from the face of each box to the outline drawn inside it.
 *
 * Faces and berths are worked out on the box, which is right for routing —
 * everything else stands clear of the box, not of the outline. But a diamond
 * touches its box only at its four points, so a connection given any other
 * place on a face, or straightened to line up with its far end, stopped on
 * the box with nothing there. The first and last runs meet the face square,
 * so carrying the end point straight on inwards keeps the route orthogonal.
 */
function toOutline(
  route: Point[],
  ends: Ends | undefined,
  edge: FlowEdge,
  byId: Map<string, AnyNode>,
  boxes: Map<string, Rect>,
): Point[] {
  if (!ends || route.length < 2) return route;
  const reach = (p: Point, node: string, side: Side): Point => {
    const along = axisOfSide(side) === "x" ? p.y : p.x;
    const depth = depthAt(byId.get(node), boxes.get(node), side, along);
    if (depth < 0.5) return p;
    const out = outward(side);
    return { x: p.x - out.x * depth, y: p.y - out.y * depth };
  };
  const first = reach(route[0], edge.source, ends.fromSide);
  const last = reach(route[route.length - 1], edge.target, ends.toSide);
  if (first === route[0] && last === route[route.length - 1]) return route;
  return [first, ...route.slice(1, -1), last];
}

/**
 * The lines on each face put in the order that keeps them from crossing,
 * once their routes are known.
 *
 * The berths were ordered before routing, by where each line turns — but
 * lines sharing a corner turn at the same place then, and only the corridor
 * pass gives them columns of their own. Ordered blind, two lines leaving a
 * side and both climbing could have the upper one climb further out, and the
 * lower one's climb cut across it.
 *
 * So the lines that leave a face square and then turn swap places among
 * themselves, by the metro-map rule (`separateHeads` has it at length): the
 * ones turning towards the low end of the face first, nearest turn
 * outermost; the ones turning towards the high end last, likewise. Only the
 * first run and the corner at its end move, along the face, so every route
 * stays square. A swap that would turn a climb into a drop is not made.
 *
 * Nor one that sends a line the wrong way out of a box, or through one. Two
 * lines arriving at the same face can come from anywhere, and swapping the
 * runs they cross over on swaps how far each one travels before it turns: a
 * line leaving the bottom of a box was given the turn of one coming from
 * three boxes higher up, set off upwards through the box it was leaving and
 * the two above it, and was counted an improvement because it crossed one
 * line fewer on the way.
 */
function untangleFaces(
  edges: FlowEdge[],
  ends: Map<string, Ends>,
  routes: Map<string, Point[]>,
  solid: Rect[],
): Map<string, Point[]> {
  const sides = new Map<string, Ends>(ends);
  type Line = {
    id: string;
    first: boolean;
    at: number;
    key: number;
    next: number;
    /** Its run out of the face, or the one it turns on to, is where someone put it. */
    placed: boolean;
    turned: boolean;
  };
  const cornersOf = new Map(edges.map((e) => [e.id, e.data?.points]));
  const faces = new Map<string, { along: Axis; lines: Line[] }>();
  for (const edge of edges) {
    const route = routes.get(edge.id);
    const at = ends.get(edge.id);
    if (!route || !at || route.length < 3 || edge.source === edge.target) continue;
    for (const first of [true, false]) {
      const side = first ? at.fromSide : at.toSide;
      const along: Axis = axisOfSide(side) === "x" ? "y" : "x";
      const normal: Axis = along === "x" ? "y" : "x";
      // The end, the corner where it turns, and the point the turn heads to.
      const [p0, p1, p2] = first
        ? [route[0], route[1], route[2]]
        : [route[route.length - 1], route[route.length - 2], route[route.length - 3]];
      // Square off the face, then a run along it.
      if (Math.abs(p0[along] - p1[along]) > 0.5 || Math.abs(p1[normal] - p2[normal]) > 0.5)
        continue;
      const toward = Math.sign(p2[along] - p1[along]);
      if (toward === 0) continue;
      const turn = Math.abs(p1[normal] - p0[normal]);
      const key = toward < 0 ? -1e6 + turn : 1e6 - turn;
      const node = first ? edge.source : edge.target;
      const face = `${node}|${side}`;
      const entry = faces.get(face) ?? { along, lines: [] };
      entry.lines.push({
        id: edge.id,
        first,
        at: p0[along],
        key,
        next: p2[along],
        placed: holds(cornersOf.get(edge.id), p0, p1),
        turned: holds(cornersOf.get(edge.id), p1, p2),
      });
      faces.set(face, entry);
    }
  }

  const out = new Map(routes);
  for (const { along, lines } of faces.values()) {
    if (lines.length < 2) continue;
    // A line whose way out of the face is where someone put it keeps its
    // place; the others change places among themselves.
    const free = lines.filter((l) => !l.placed);
    const slots = free.map((l) => l.at).sort((a, b) => a - b);
    const wanted = [...free].sort((a, b) => a.key - b.key || a.at - b.at);
    // Each line would keep heading the same way from its new place.
    const keeps = wanted.every(
      (l, i) => Math.sign(l.next - slots[i]) === Math.sign(l.next - l.at) || slots[i] === l.at,
    );
    if (keeps) {
      wanted.forEach((l, i) => {
        if (Math.abs(slots[i] - l.at) < 0.5) return;
        const route = [...out.get(l.id)!].map((q) => ({ ...q }));
        const [a, b] = l.first ? [0, 1] : [route.length - 1, route.length - 2];
        route[a][along] = slots[i];
        route[b][along] = slots[i];
        out.set(l.id, route);
      });
    }

    // The sort decides by where each line turns, but which column each one
    // climbs or drops in was the corridor pass's choice, made before the
    // places were swapped — and a line can still cross a neighbour further
    // on. So each pair turning the same way is tried with its places
    // swapped, its columns swapped, and both, against every route, and the
    // arrangement with the fewest crossings is kept — counting a stretch of
    // one line lying on another as worse than a crossing, since it hides one.
    const normal: Axis = along === "x" ? "y" : "x";
    const ends = (l: Line) => {
      const r = out.get(l.id)!;
      return l.first ? [0, 1, 2] : [r.length - 1, r.length - 2, r.length - 3];
    };
    /** Out of the face it leaves and into the one it reaches, both ways round. */
    const faces = (id: string, r: Point[]) => {
      const at = sides.get(id);
      if (!at) return true;
      const out = outward(at.fromSide);
      const into = outward(at.toSide);
      const [a, b] = [r[0], r[1]];
      const [y, z] = [r[r.length - 2], r[r.length - 1]];
      return (
        (b.x - a.x) * out.x + (b.y - a.y) * out.y > 0 &&
        (y.x - z.x) * into.x + (y.y - z.y) * into.y > 0
      );
    };
    const through = (r: Point[]) => {
      let n = 0;
      for (let k = 1; k < r.length; k++) if (blocked(r[k - 1], r[k], solid)) n++;
      return n;
    };
    // Only routes whose extent meets the pair's can cross either of them.
    const tally = (ids: string[]) => {
      let n = 0;
      for (const id of ids) {
        const mine = out.get(id)!;
        const area = extentOf(mine);
        for (const [other, route] of out) {
          if (other === id || (ids.includes(other) && other < id)) continue;
          if (!meets(area, extentOf(route))) continue;
          n += crossingsOf(mine, route) + overlapOf(mine, route) / OVERLAP_COST;
        }
      }
      return n;
    };
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const [p, q] = [lines[i], lines[j]];
        if (Math.sign(p.key) !== Math.sign(q.key)) continue;
        const before = [out.get(p.id)!, out.get(q.id)!];
        const [pi, qi] = [ends(p), ends(q)];
        const variant = (place: boolean, column: boolean) => {
          const a = before[0].map((c) => ({ ...c }));
          const b = before[1].map((c) => ({ ...c }));
          if (place) {
            const [x, y] = [a[pi[0]][along], b[qi[0]][along]];
            a[pi[0]][along] = a[pi[1]][along] = y;
            b[qi[0]][along] = b[qi[1]][along] = x;
          }
          if (column) {
            const [x, y] = [a[pi[1]][normal], b[qi[1]][normal]];
            a[pi[1]][normal] = a[pi[2]][normal] = y;
            b[qi[1]][normal] = b[qi[2]][normal] = x;
          }
          return [a, b];
        };
        let best = tally([p.id, q.id]);
        let chosen = before;
        const passed = through(before[0]) + through(before[1]);
        for (const [place, column] of [
          [true, false],
          [false, true],
          [true, true],
        ] as const) {
          // Not by moving a run that was placed where it is.
          if (place && (p.placed || q.placed)) continue;
          if (column && (p.turned || q.turned)) continue;
          const [a, b] = variant(place, column);
          // Still square, and no run squeezed shorter than a stub.
          if (![a, b].every((r) => isSquare(r) && !foldsBack(r))) continue;
          if (!faces(p.id, a) || !faces(q.id, b)) continue;
          if (through(a) + through(b) > passed) continue;
          out.set(p.id, a);
          out.set(q.id, b);
          const n = tally([p.id, q.id]);
          if (n < best) {
            best = n;
            chosen = [a, b];
          }
        }
        out.set(p.id, chosen[0]);
        out.set(q.id, chosen[1]);
      }
    }
  }
  return out;
}

/** Is every run of the route horizontal or vertical? */
function isSquare(route: Point[]): boolean {
  return route.every(
    (q, i) =>
      i === 0 || Math.abs(q.x - route[i - 1].x) < 0.5 || Math.abs(q.y - route[i - 1].y) < 0.5,
  );
}

/** Does the route turn straight back on itself anywhere, or run shorter than a stub at an end? */
function foldsBack(route: Point[]): boolean {
  const n = route.length;
  const len = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  if (
    n >= 2 &&
    (len(route[0], route[1]) < STUB / 2 || len(route[n - 2], route[n - 1]) < STUB / 2)
  ) {
    return true;
  }
  return reverses(route);
}

/** Does the route turn straight back on itself anywhere? */
function reverses(route: Point[]): boolean {
  const n = route.length;
  return route.some((b, i) => {
    if (i === 0 || i === n - 1) return false;
    const a = route[i - 1];
    const c = route[i + 1];
    const level = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5;
    const plumb = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5;
    return (level && (b.x - a.x) * (c.x - b.x) < 0) || (plumb && (b.y - a.y) * (c.y - b.y) < 0);
  });
}

/** The box a route stays within, grown by enough to count lying alongside. */
function extentOf(route: Point[]): Rect {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const q of route) {
    x0 = Math.min(x0, q.x);
    y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x);
    y1 = Math.max(y1, q.y);
  }
  return {
    x: x0 - SAME_LINE,
    y: y0 - SAME_LINE,
    w: x1 - x0 + 2 * SAME_LINE,
    h: y1 - y0 + 2 * SAME_LINE,
  };
}

/** Do two boxes share any ground, edges included? */
function meets(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** How many units of lying on another line count as much as one crossing. */
const OVERLAP_COST = 8;

/** How far two routes run along one line, together. */
function overlapOf(a: Point[], b: Point[]): number {
  let n = 0;
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const [p, q, r, t] = [a[i - 1], a[i], b[j - 1], b[j]];
      const level = Math.abs(p.y - q.y) < 0.5;
      if (level !== Math.abs(r.y - t.y) < 0.5) continue;
      if ((level ? Math.abs(p.y - r.y) : Math.abs(p.x - r.x)) > SAME_LINE) continue;
      const k: Axis = level ? "x" : "y";
      const lo = Math.max(Math.min(p[k], q[k]), Math.min(r[k], t[k]));
      const hi = Math.min(Math.max(p[k], q[k]), Math.max(r[k], t[k]));
      n += Math.max(0, hi - lo);
    }
  }
  return n;
}

/** How many times two routes cross at right angles, ends aside. */
function crossingsOf(a: Point[], b: Point[]): number {
  let n = 0;
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const [p, q, r, t] = [a[i - 1], a[i], b[j - 1], b[j]];
      const level = Math.abs(p.y - q.y) < 0.5;
      if (level === Math.abs(r.y - t.y) < 0.5) continue;
      const [h0, h1, v0, v1] = level ? [p, q, r, t] : [r, t, p, q];
      if (
        v0.x > Math.min(h0.x, h1.x) + 0.5 &&
        v0.x < Math.max(h0.x, h1.x) - 0.5 &&
        h0.y > Math.min(v0.y, v1.y) + 0.5 &&
        h0.y < Math.max(v0.y, v1.y) - 0.5
      ) {
        n++;
      }
    }
  }
  return n;
}

let cached: {
  nodes: AnyNode[];
  edges: FlowEdge[];
  kind: DiagramKind;
  ends: Map<string, Ends>;
  routes: Map<string, Point[]>;
  reach: Map<string, FaceReach>;
} | null = null;

/**
 * How far along its face each end of a connection could be moved: what a
 * slide of the run beside it is allowed to ask for (`slidePath`). A loop back
 * to its own node has none — its ends are where the loop is, not berths.
 */
export function faceReach(
  nodes: AnyNode[],
  edges: FlowEdge[],
  kind: DiagramKind,
  id: string,
): FaceReach {
  return fill(nodes, edges, kind).reach.get(id) ?? {};
}

/**
 * The fewest of a connection's corners that still draw the line it has now.
 *
 * Asked of the router itself, all of it: a corner is dropped only when the
 * whole pass — faces, berths, the way round the boxes, the corridors — draws
 * this connection the same without it. `prune` asks the squaring-off alone,
 * which is one step of several, and the corners it called redundant were
 * often the ones holding the line where the user had put it.
 */
export function settleCorners(
  nodes: AnyNode[],
  edges: FlowEdge[],
  kind: DiagramKind,
  id: string,
): Point[] {
  const edge = edges.find((e) => e.id === id);
  const points = edge?.data?.points ?? [];
  if (!edge || points.length === 0) return points;
  const held = cached;
  const drawnWith = (corners: Point[]): Point[] =>
    fill(
      nodes,
      edges.map((e) =>
        e.id === id ? { ...e, data: { ...(e.data ?? { label: "" }), points: corners } } : e,
      ),
      kind,
    ).routes.get(id) ?? [];
  const same = (a: Point[], b: Point[]) =>
    a.length === b.length &&
    a.every((q, i) => Math.abs(q.x - b[i].x) < 0.5 && Math.abs(q.y - b[i].y) < 0.5);
  const wanted = drawnWith(points);
  let kept = points;
  // Backwards, so an index stays valid while the list shrinks under it.
  for (let i = kept.length - 1; i >= 0; i--) {
    const without = [...kept.slice(0, i), ...kept.slice(i + 1)];
    if (same(drawnWith(without), wanted)) kept = without;
  }
  cached = held;
  return kept;
}

/**
 * Where every connection meets its two nodes, with the ones sharing a face
 * given a place each along it.
 *
 * Separate from `allRoutes` because the canvas wants these on their own: the
 * corner-dragging magnet lines a new corner up with the point a connection
 * actually leaves from, and an edge working that out from `endsOf` alone would
 * aim at the middle of a face its line no longer touches.
 */
export function allEnds(
  nodes: AnyNode[],
  edges: FlowEdge[],
  kind: DiagramKind,
): Map<string, Ends> {
  return fill(nodes, edges, kind).ends;
}

/**
 * Every edge's route, by id.
 *
 * Held by the identity of the arrays it was worked out from, which is what
 * makes it free for the second edge to ask and every one after: the store
 * hands out the same arrays until something actually changes.
 */
export function allRoutes(
  nodes: AnyNode[],
  edges: FlowEdge[],
  kind: DiagramKind,
): Map<string, Point[]> {
  return fill(nodes, edges, kind).routes;
}

type Laid = {
  ends: Map<string, Ends>;
  routes: Map<string, Point[]>;
  reach: Map<string, FaceReach>;
};

/** The connections drawn without some of their corners, and what they were drawn for. */
let loosened = new Map<string, { key: string; points: Point[] }>();

/** How near a box a connection's first or last corner is taken to be pinning its end there. */
const PIN_REACH = 30;

/**
 * The whole pass, and then again for the connections it could not draw.
 *
 * A corner beside a box pins that end to a face — a drawing from draw.io
 * pins most of its ends so — and some pins cannot be honoured: the far end of
 * a bar the line lies along in draw.io, the side of an icon whose neighbour
 * stands ten units off. Obeyed, the line went through the very box it was
 * joining, or reached its pin and turned straight back. A line that does
 * either is laid again without its pins, the faces left to the geometry as
 * they are for any other connection; and one still wrong after that, with no
 * corners at all. Each try is kept only if it leaves fewer lines wrong than
 * the one before — where the line meets a box matters less than that it is
 * one line.
 *
 * The stored corners are not touched: this is how they are drawn, not what
 * the file says.
 */
function fill(nodes: AnyNode[], edges: FlowEdge[], kind: DiagramKind): Laid {
  if (cached && cached.nodes === nodes && cached.edges === edges && cached.kind === kind) {
    return cached;
  }
  const boxes = routingBoxes(nodes);
  const inside = (r: Rect): Rect => ({ x: r.x + 3, y: r.y + 3, w: r.w - 6, h: r.h - 6 });
  const wrong = (edge: FlowEdge, laid: Laid): boolean => {
    const route = laid.routes.get(edge.id);
    const style = edge.data?.style?.route ?? "orthogonal";
    if (!route || route.length < 2 || style !== "orthogonal" || edge.source === edge.target) {
      return false;
    }
    if (reverses(route)) return true;
    // Across one of its own two boxes, the runs that meet them aside.
    const own = [boxes.get(edge.source), boxes.get(edge.target)].filter((b): b is Rect => !!b);
    for (let i = 2; i < route.length - 1; i++) {
      if (own.some((b) => crosses(route[i - 1], route[i], inside(b)))) return true;
    }
    return false;
  };
  const near = (p: Point, box: Rect | undefined): boolean => {
    if (!box) return false;
    const dx = Math.max(box.x - p.x, 0, p.x - (box.x + box.w));
    const dy = Math.max(box.y - p.y, 0, p.y - (box.y + box.h));
    return dx <= PIN_REACH && dy <= PIN_REACH;
  };
  const unpinned = (edge: FlowEdge): Point[] => {
    const points = [...(edge.data?.points ?? [])];
    if (points.length && near(points[0], boxes.get(edge.source))) points.shift();
    if (points.length && near(points[points.length - 1], boxes.get(edge.target))) points.pop();
    return points;
  };

  // What was settled last time stands while the connection and its two
  // boxes are as they were, so a drag — one layout a frame — does not lay
  // everything out three times a frame to reach the same answer.
  const keyOf = (e: FlowEdge): string =>
    JSON.stringify([boxes.get(e.source), boxes.get(e.target), e.data?.points ?? []]);
  let effective = edges.map((e) => {
    const was = loosened.get(e.id);
    return was && was.key === keyOf(e)
      ? { ...e, data: { ...(e.data ?? { label: "" }), points: was.points } }
      : e;
  });
  let laid = layOut(nodes, effective, kind);
  let bad = effective.filter((e) => wrong(e, laid));
  for (const loosen of [unpinned, (): Point[] => []]) {
    const again = bad.filter((e) => (e.data?.points ?? []).length > 0);
    if (again.length === 0) break;
    const ids = new Set(again.map((e) => e.id));
    const tried = effective.map((e) =>
      ids.has(e.id) ? { ...e, data: { ...(e.data ?? { label: "" }), points: loosen(e) } } : e,
    );
    const next = layOut(nodes, tried, kind);
    const still = tried.filter((e) => wrong(e, next));
    if (still.length >= bad.length) continue;
    [effective, laid, bad] = [tried, next, still];
  }
  loosened = new Map();
  edges.forEach((e, i) => {
    const drawn = effective[i].data?.points ?? [];
    if (drawn.length !== (e.data?.points ?? []).length) {
      loosened.set(e.id, { key: keyOf(e), points: drawn });
    }
  });
  cached = { nodes, edges, kind, ...laid };
  return cached;
}

/**
 * Every box as the router sees it: a picture node is its picture.
 *
 * The node holds the picture, room for a caption and padding round both, and
 * is a good deal bigger than what is drawn — forty units taller for an icon
 * with no caption at all. A line met the node, not the icon: it stopped short
 * of the picture in empty canvas, and an icon standing just above the bus it
 * hangs from had its node reach down over the bus, so there was no gap for
 * the drop to cross and the line went round. draw.io ties a line to the
 * picture, with the caption outside it, and so does this.
 */
function routingBoxes(nodes: AnyNode[]): Map<string, Rect> {
  const boxes = absoluteBoxes(nodes);
  for (const n of nodes) {
    const box = boxes.get(n.id);
    if (box) boxes.set(n.id, pictureOnly(n, box));
  }
  return boxes;
}

/** One pass: where the connections meet, and where they then go. */
function layOut(nodes: AnyNode[], edges: FlowEdge[], kind: DiagramKind): Laid {
  const boxes = routingBoxes(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const flat = (node: string, side: Side, at: number): boolean =>
    depthAt(byId.get(node), boxes.get(node), side, at) < 0.5;

  // Faces first. Which face a connection uses depends only on the two boxes,
  // but *where* along it depends on every other connection using the same
  // face, so the two are settled one after the other and before any routing:
  // a route drawn from the middle of a face and then moved would take its
  // corners with it.
  const meeting = new Map<string, Ends>();
  for (const edge of edges) {
    const at = endsOf(edge, boxes, kind);
    if (at) meeting.set(edge.id, at);
  }
  const solid = obstaclesOf(nodes, boxes, edges);
  // On a shaped node only the middle of each face is close to the outline;
  // berths are kept there, so ones on neighbouring faces do not run in to
  // the same stretch of curve. A plain box keeps its whole face.
  const quayOf: QuayOf = (node, side, box) => {
    const vertical = axisOfSide(side) === "x";
    const from = vertical ? box.y : box.x;
    const span = vertical ? box.h : box.w;
    const limit = Math.max(4, (vertical ? box.w : box.h) * 0.1);
    const middle = from + span / 2;
    let half = 0;
    while (half < span / 2 && depthAt(byId.get(node), box, side, middle + half + 1) <= limit)
      half++;
    return half >= span / 2 - 0.5 ? { from, span } : { from: middle - half, span: half * 2 };
  };
  const ends = separateHeads(
    edges,
    alignWithCorners(
      edges,
      straightenNearlyLevel(
        edges,
        spreadBerths(edges, meeting, boxes, undefined, quayOf),
        boxes,
        undefined,
        flat,
      ),
      boxes,
      quayOf,
    ),
    boxes,
    quayOf,
  );

  // The subgraphs each connection is no part of: neither of its ends is in
  // them, at any depth. It may cross them, at a price (see `SOFT_COST`).
  const groups = nodes.filter(isGroup);
  const holders = (id: string): Set<string> => {
    const out = new Set<string>();
    for (let at = byId.get(id)?.parentId; at && !out.has(at); at = byId.get(at)?.parentId) {
      out.add(at);
    }
    return out;
  };
  const drawn = new Map<string, Point[]>();
  for (const edge of edges) {
    const own = new Set([...holders(edge.source), ...holders(edge.target)]);
    const foreign = groups
      .filter((g) => !own.has(g.id) && g.id !== edge.source && g.id !== edge.target)
      .map((g) => boxes.get(g.id))
      .filter((b): b is Rect => !!b);
    drawn.set(edge.id, routeOf(edge, solid, ends.get(edge.id) ?? null, boxes, foreign));
  }
  // Only now, with all of them in hand, can two that lie on top of each other
  // be told apart and moved aside. The group frames go in as lines that cannot
  // move: a connection flush with a container's border vanishes into it.
  const frames = nodes.filter(isGroup).map((n) => boxes.get(n.id));
  // Except connections someone routed by hand out of, or into, the same
  // node. A trunk shared by design — a switch's line running down past every
  // device in its rack, an org chart's rail — is drawn that way in draw.io
  // and in Visio, and fanned apart here each line became a strand of a
  // tangle beside the others. They stay as drawn.
  //
  // As drawn, but not out of sight. They used to be left out of the pass
  // altogether, so nothing else knew they were there: two connections of one
  // node touched by hand, and every other line that came their way was drawn
  // straight on top of them. They take part now, as lines that do not move
  // and that the rest make room for — only not for each other, the trunk
  // being the point.
  const shared = new Set<string>();
  const routed = edges.filter((e) => (e.data?.points ?? []).length > 0);
  for (const e of routed) {
    if (routed.some((o) => o !== e && (o.source === e.source || o.target === e.target))) {
      shared.add(e.id);
    }
  }
  const endsOfEdge = new Map(edges.map((e) => [e.id, e]));
  const spread = spreadRuns(
    drawn,
    frames.filter((b): b is Rect => !!b),
    undefined,
    solid.map(([, b]) => b),
    {
      corners: new Map(routed.map((e) => [e.id, e.data?.points ?? []])),
      still: shared,
      mates: (a, b) => {
        if (!shared.has(a) || !shared.has(b)) return false;
        const [p, q] = [endsOfEdge.get(a), endsOfEdge.get(b)];
        return !!p && !!q && (p.source === q.source || p.target === q.target);
      },
    },
  );
  const routes = untangleFaces(
    edges,
    ends,
    spread,
    solid.map(([, b]) => b),
  );
  for (const edge of edges) {
    const route = routes.get(edge.id);
    if (!route) continue;
    const dressed = dressArrival(route, ends.get(edge.id), solid, edge);
    const reached = toOutline(dressed, ends.get(edge.id), edge, byId, boxes);
    if (reached !== route) routes.set(edge.id, reached);
  }
  const reach = new Map<string, FaceReach>();
  for (const edge of edges) {
    const at = ends.get(edge.id);
    const from = boxes.get(edge.source);
    const to = boxes.get(edge.target);
    if (!at || !from || !to || edge.source === edge.target) continue;
    reach.set(edge.id, {
      from: berthRange(quayOf(edge.source, at.fromSide, from)),
      to: berthRange(quayOf(edge.target, at.toSide, to)),
    });
  }
  return { ends, routes, reach };
}
