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
  type Side,
} from "./orthogonal";
import { blocked, CLEARANCE, routeAround, type Rect } from "./avoid";
import {
  alignWithCorners,
  HEAD_ROOM,
  separateHeads,
  spreadBerths,
  straightenNearlyLevel,
  type QuayOf,
} from "./berths";
import { SAME_LINE, spreadRuns } from "./spread";
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
  opts: { leave?: Point; arrive?: Point; clearance?: number; strict?: boolean } = {},
): Point[] | null {
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
  const corners = edge.data?.points ?? [];
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
function routeOf(edge: FlowEdge, solid: Array<[string, Rect]>, ends: Ends | null): Point[] {
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

  // A connector leaves a face perpendicular to it before it turns; without
  // that, two nodes joined side to side down a column produced a line flat
  // against both of them, arrowhead included.
  // Two faces looking at each other from closer than two stubs share the
  // gap between them, half each. Full stubs crossed over: out past the far
  // face, back, and in — a spike in a line that wanted to be straight.
  const out = outward(ends.fromSide);
  const facing =
    (edge.data?.points ?? []).length === 0 &&
    out.x === -outward(ends.toSide).x &&
    out.y === -outward(ends.toSide).y
      ? (ends.end.x - ends.start.x) * out.x + (ends.end.y - ends.start.y) * out.y
      : Infinity;
  // Only for faces that more or less look at each other: two far apart across
  // and close only in depth have room to go round, and the full stubs take it.
  const aside =
    out.x !== 0 ? Math.abs(ends.end.y - ends.start.y) : Math.abs(ends.end.x - ends.start.x);
  const stub = facing > 0 && facing < 2 * STUB && aside <= 2 * STUB ? facing / 2 : STUB;
  const anchors = withStubs(
    [ends.start, ...turnsInto(edge.data?.points ?? [], ends), ends.end],
    ends.fromSide,
    ends.toSide,
    stub,
  );

  // Straight and curved both go directly from corner to corner; only the
  // drawing differs, and that is the edge's business, not the router's. They
  // also skip the obstacle search, since a line the user asked to be direct
  // is not one to send round the houses.
  if (edge.data?.style?.route === "straight" || edge.data?.style?.route === "curved") {
    return tidy(anchors);
  }

  const squared = orthogonalRoute(anchors, ends.from, ends.to);

  // Every node that stands in the way (see `obstaclesOf`). The two a
  // connection joins stay in — it may touch them at the faces it uses, which
  // is the one allowance the obstacle tolerance makes, but nothing draws
  // through either box's middle. Leave them out and a route that approaches
  // its face from the wrong side cuts across the node it is heading for and
  // comes straight back out, leaving the arrowhead on a spike.
  const obstacles = solid.map(([, b]) => b);

  // Cheap, and it decides whether the expensive thing runs at all.
  const obstructed = squared.some((q, i) => i > 0 && blocked(squared[i - 1], q, obstacles));
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
  for (const [clearance, stub] of TRIES) {
    const away = (p: Point, side: Side): Point => {
      const d = outward(side);
      return { x: p.x + d.x * stub, y: p.y + d.y * stub };
    };
    const stubbed = [
      away(ends.start, ends.fromSide),
      ...(edge.data?.points ?? []),
      away(ends.end, ends.toSide),
    ];
    const legs = aroundObstacles(stubbed, ends.from, ends.to, obstacles, {
      leave: outward(ends.fromSide),
      arrive: { x: -inward.x, y: -inward.y },
      clearance,
      strict: true,
    });
    if (legs) return tidy([ends.start, ...legs, ends.end]);
  }
  return aroundObstacles(anchors, ends.from, ends.to, obstacles)!;
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
 *     away from its own label.
 */
function obstaclesOf(nodes: AnyNode[], boxes: Map<string, Rect>): Array<[string, Rect]> {
  const candidates = nodes.filter((n) => !isGroup(n) && boxes.has(n.id));
  const encloses = (a: Rect, b: Rect) =>
    a.w * a.h > b.w * b.h &&
    b.x >= a.x - 0.5 &&
    b.y >= a.y - 0.5 &&
    b.x + b.w <= a.x + a.w + 0.5 &&
    b.y + b.h <= a.y + a.h + 0.5;
  const bare = (n: AnyNode) => {
    if (n.type !== "shape") return false;
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
 */
function untangleFaces(
  edges: FlowEdge[],
  ends: Map<string, Ends>,
  routes: Map<string, Point[]>,
): Map<string, Point[]> {
  type Line = { id: string; first: boolean; at: number; key: number; next: number };
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
      entry.lines.push({ id: edge.id, first, at: p0[along], key, next: p2[along] });
      faces.set(face, entry);
    }
  }

  const out = new Map(routes);
  for (const { along, lines } of faces.values()) {
    if (lines.length < 2) continue;
    const slots = lines.map((l) => l.at).sort((a, b) => a - b);
    const wanted = [...lines].sort((a, b) => a.key - b.key || a.at - b.at);
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
        for (const [place, column] of [
          [true, false],
          [false, true],
          [true, true],
        ] as const) {
          const [a, b] = variant(place, column);
          // Still square, and no run squeezed shorter than a stub.
          if (![a, b].every((r) => isSquare(r) && !foldsBack(r))) continue;
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
} | null = null;

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

/** The whole pass: where the connections meet, and where they then go. */
function fill(
  nodes: AnyNode[],
  edges: FlowEdge[],
  kind: DiagramKind,
): { ends: Map<string, Ends>; routes: Map<string, Point[]> } {
  if (cached && cached.nodes === nodes && cached.edges === edges && cached.kind === kind) {
    return cached;
  }
  const boxes = absoluteBoxes(nodes);
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
  const solid = obstaclesOf(nodes, boxes);
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

  const drawn = new Map<string, Point[]>();
  for (const edge of edges) {
    drawn.set(edge.id, routeOf(edge, solid, ends.get(edge.id) ?? null));
  }
  // Only now, with all of them in hand, can two that lie on top of each other
  // be told apart and moved aside. The group frames go in as lines that cannot
  // move: a connection flush with a container's border vanishes into it.
  const frames = nodes.filter(isGroup).map((n) => boxes.get(n.id));
  const routes = untangleFaces(
    edges,
    ends,
    spreadRuns(
      drawn,
      frames.filter((b): b is Rect => !!b),
      undefined,
      solid.map(([, b]) => b),
    ),
  );
  for (const edge of edges) {
    const route = routes.get(edge.id);
    if (!route) continue;
    const dressed = dressArrival(route, ends.get(edge.id), solid, edge);
    const reached = toOutline(dressed, ends.get(edge.id), edge, byId, boxes);
    if (reached !== route) routes.set(edge.id, reached);
  }
  cached = { nodes, edges, kind, ends, routes };
  return cached;
}
