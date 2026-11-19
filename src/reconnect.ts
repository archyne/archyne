/**
 * Moving one end of a connection to somewhere else.
 *
 * Grabbing the end of a selected line used to grab the connection point
 * underneath it instead, and a drag from a connection point is how a *new*
 * line is drawn: the old one stayed where it was and a second appeared beside
 * it. The end of a selected line is now its own handle, and this is the
 * arithmetic for what letting go of it means.
 *
 * Let go on one of a node's connection points and the end is pinned to that
 * face — the same promise draw.io makes. Let go anywhere else on a node and
 * the end is attached to the node and the router picks the face, the way a
 * new connection released there is.
 */
import type { Box } from "./boxes";
import { attachPoint, outward, type Side } from "./orthogonal";
import type { Point } from "./routing";

/**
 * How far outside a face the corner pinning an end to it stands.
 *
 * The draw.io importer pins an end the same way and by the same distance:
 * Mermaid has no port to write a face into, so the end is held by a corner
 * just outside it, which the router lines the end up with. One mechanism for
 * both means a line pinned here and a line pinned in draw.io behave alike.
 */
export const PIN_STUB = 20;

/**
 * How near a connection point, in screen pixels, letting go has to be to land
 * on it. The canvas hands the same number to React Flow for new connections.
 */
export const CONNECT_RADIUS = 38;

/**
 * The same reach, from inside the box the point belongs to.
 *
 * Narrower, because inside a box there is a second thing to mean. A new line
 * can afford the wide reach: on most boxes the face it lands on is not kept,
 * so landing near the middle of a small one and taking its top point comes to
 * the same thing. A moved end landing on a point is pinned there, and on a
 * 160×54 box every place in the middle is within 38 pixels of the top or the
 * bottom — so letting go in the middle, which means "this node", would pin
 * the end to a face nobody chose. Inside, it takes aiming at the dot.
 */
export const CONNECT_RADIUS_INSIDE = 14;

const SIDES: Side[] = ["left", "right", "top", "bottom"];

const inside = (at: Point, box: Box) =>
  at.x > box.x && at.x < box.x + box.w && at.y > box.y && at.y < box.y + box.h;

/**
 * The connection point nearest `at`, on any of the boxes, when one is within
 * reach: `radius` from outside its box, the reach React Flow gives a new
 * connection, and `insideRadius` from within it.
 */
export function nearestPin(
  at: Point,
  boxes: Map<string, Box>,
  radius: number,
  insideRadius: number,
): { node: string; side: Side } | null {
  let best: { node: string; side: Side } | null = null;
  let bestD = Infinity;
  for (const [node, box] of boxes) {
    const reach = inside(at, box) ? insideRadius : radius;
    for (const side of SIDES) {
      const p = attachPoint(box, side);
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      if (d <= reach && d < bestD) {
        best = { node, side };
        bestD = d;
      }
    }
  }
  return best;
}

/** The face of the box nearest `at`, wherever `at` is. */
export function nearestFace(at: Point, box: Box): Side {
  const gaps: Array<[Side, number]> = [
    ["left", Math.abs(at.x - box.x)],
    ["right", Math.abs(at.x - (box.x + box.w))],
    ["top", Math.abs(at.y - box.y)],
    ["bottom", Math.abs(at.y - (box.y + box.h))],
  ];
  return gaps.sort((a, b) => a[1] - b[1])[0][0];
}

/** The corner that pins an end to this face. */
export function pinFor(box: Box, side: Side): Point {
  const face = attachPoint(box, side);
  const out = outward(side);
  return { x: face.x + out.x * PIN_STUB, y: face.y + out.y * PIN_STUB };
}

/**
 * Whether a corner is one pinning an end to this box: just outside one face,
 * within the span of it, no further out than a pin stands.
 */
export function isPin(p: Point, box: Box): boolean {
  const reach = PIN_STUB + 1;
  const dx = p.x < box.x ? box.x - p.x : p.x > box.x + box.w ? p.x - (box.x + box.w) : 0;
  const dy = p.y < box.y ? box.y - p.y : p.y > box.y + box.h ? p.y - (box.y + box.h) : 0;
  return (dx > 0 && dx <= reach && dy === 0) || (dy > 0 && dy <= reach && dx === 0);
}

/**
 * The corners a connection keeps once one of its ends has moved.
 *
 * The ones in between are dropped. They were placed to get from where the end
 * was, and kept they would drag the line back there before letting it go on
 * to where it now is. What survives is the pin of the end that stayed put,
 * when it had one — an imported line pinned at both ends keeps the end that
 * was not touched — and the new pin of the end that moved, when it was let go
 * on a connection point.
 */
export function cornersAfterMove(
  points: Point[],
  end: "source" | "target",
  kept: Box,
  moved: Box,
  side: Side | null,
): Point[] {
  const keptPin = end === "source" ? points[points.length - 1] : points[0];
  const stay = keptPin && isPin(keptPin, kept) ? [keptPin] : [];
  const pin = side ? [pinFor(moved, side)] : [];
  return end === "source" ? [...pin, ...stay] : [...stay, ...pin];
}
