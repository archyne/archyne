/**
 * What each flowchart shape is, as geometry rather than as markup.
 *
 * This used to be a `switch` returning JSX inside `ShapeNode.tsx`, which was
 * exactly right while the canvas was the only thing that drew. It stops being
 * right the moment a second drawer exists: a renderer that emits an SVG string
 * has no React, and the obvious move — writing the same shapes again, in
 * strings — produces two definitions of "cylinder" that agree until somebody
 * edits one.
 *
 * That failure has a precedent here worth not repeating. `renderWithMermaid`
 * (`model/fromMermaid.ts`) exists because the canvas and the preview drew
 * *different pictures of one file*, and the fix was one route rather than two
 * careful ones.
 *
 * So the shapes are described here, once, as primitives, and each consumer
 * turns a primitive into whatever it emits — JSX for the canvas, a string for
 * the renderer. Neither owns the geometry, and a change to a hexagon is a
 * change to the hexagon.
 *
 * Coordinates are in the node's own frame: `0,0` to `w,h`. The 1px inset that
 * runs through nearly all of them is the stroke, which straddles the path and
 * would otherwise be clipped in half by the element's edge.
 */
import type { Shape } from "../model/types";

/**
 * Which of the two paints a primitive takes.
 *
 * `fill` is the body of the shape — `.shape-fill` in the stylesheet, which is
 * also what carries a node's custom colours. `line` is the detail drawn over
 * it: a subroutine's inner bars, a cylinder's rim, the inner ring of a double
 * circle. They are separate because a custom fill must not swallow the detail.
 */
export type Paint = "fill" | "line";

export type Primitive =
  | {
      kind: "rect";
      paint: Paint;
      x: number;
      y: number;
      width: number;
      height: number;
      rx?: number;
    }
  | { kind: "ellipse"; paint: Paint; cx: number; cy: number; rx: number; ry: number }
  | { kind: "polygon"; paint: Paint; points: [number, number][] }
  | { kind: "path"; paint: Paint; d: string }
  | { kind: "line"; paint: Paint; x1: number; y1: number; x2: number; y2: number };

/** The rounded rectangle nearly every shape is a variation on. */
function body(w: number, h: number, rx?: number): Primitive {
  return {
    kind: "rect",
    paint: "fill",
    x: 1,
    y: 1,
    width: w - 2,
    height: h - 2,
    ...(rx !== undefined ? { rx } : {}),
  };
}

/**
 * The primitives that draw `shape` at `w` × `h`, in paint order.
 *
 * Every shape in `Shape` is covered, and the switch is exhaustive on purpose:
 * adding a shape to the union without drawing it should not compile.
 */
export function shapeGeometry(shape: Shape, w: number, h: number): Primitive[] {
  switch (shape) {
    case "round":
      return [body(w, h, 8)];

    case "stadium":
      return [body(w, h, (h - 2) / 2)];

    case "subroutine":
      return [
        body(w, h),
        { kind: "line", paint: "line", x1: 9, y1: 1, x2: 9, y2: h - 1 },
        { kind: "line", paint: "line", x1: w - 9, y1: 1, x2: w - 9, y2: h - 1 },
      ];

    case "cylinder": {
      // The barrel, then the rim drawn back over its top so the ellipse reads
      // as a lid rather than as a seam.
      const ry = 8;
      const rx = (w - 2) / 2;
      return [
        {
          kind: "path",
          paint: "fill",
          d: `M1 ${ry} A ${rx} ${ry} 0 0 1 ${w - 1} ${ry} L ${w - 1} ${h - ry} A ${rx} ${ry} 0 0 1 1 ${h - ry} Z`,
        },
        { kind: "path", paint: "line", d: `M1 ${ry} A ${rx} ${ry} 0 0 0 ${w - 1} ${ry}` },
      ];
    }

    case "circle":
      return [
        { kind: "ellipse", paint: "fill", cx: w / 2, cy: h / 2, rx: w / 2 - 1, ry: h / 2 - 1 },
      ];

    case "doublecircle":
      return [
        { kind: "ellipse", paint: "fill", cx: w / 2, cy: h / 2, rx: w / 2 - 1, ry: h / 2 - 1 },
        { kind: "ellipse", paint: "line", cx: w / 2, cy: h / 2, rx: w / 2 - 6, ry: h / 2 - 6 },
      ];

    case "diamond":
      return [
        {
          kind: "polygon",
          paint: "fill",
          points: [
            [w / 2, 1],
            [w - 1, h / 2],
            [w / 2, h - 1],
            [1, h / 2],
          ],
        },
      ];

    case "hexagon": {
      // The corner cut is a share of the width, but never more than half the
      // height — otherwise a short wide hexagon collapses into a diamond.
      const c = Math.min(h / 2, w * 0.18);
      return [
        {
          kind: "polygon",
          paint: "fill",
          points: [
            [c, 1],
            [w - c, 1],
            [w - 1, h / 2],
            [w - c, h - 1],
            [c, h - 1],
            [1, h / 2],
          ],
        },
      ];
    }

    case "odd":
      return [
        {
          kind: "polygon",
          paint: "fill",
          points: [
            [1, h / 2],
            [14, 1],
            [w - 1, 1],
            [w - 1, h - 1],
            [14, h - 1],
          ],
        },
      ];

    case "trapezoid":
      return [
        {
          kind: "polygon",
          paint: "fill",
          points: [
            [w * 0.18, 1],
            [w * 0.82, 1],
            [w - 1, h - 1],
            [1, h - 1],
          ],
        },
      ];

    case "inv_trapezoid":
      return [
        {
          kind: "polygon",
          paint: "fill",
          points: [
            [1, 1],
            [w - 1, 1],
            [w * 0.82, h - 1],
            [w * 0.18, h - 1],
          ],
        },
      ];

    case "lean_right":
      return [
        {
          kind: "polygon",
          paint: "fill",
          points: [
            [w * 0.15, 1],
            [w - 1, 1],
            [w * 0.85, h - 1],
            [1, h - 1],
          ],
        },
      ];

    case "lean_left":
      return [
        {
          kind: "polygon",
          paint: "fill",
          points: [
            [1, 1],
            [w * 0.85, 1],
            [w - 1, h - 1],
            [w * 0.15, h - 1],
          ],
        },
      ];

    case "square":
      return [body(w, h)];
  }

  // Unreachable for any `Shape`, and TypeScript proves it — `shape` is `never`
  // by this line, so adding a member to the union without a case above still
  // fails to compile. What this catches is the other direction: `data.shape`
  // is parsed out of a file, and a document naming a shape this build does not
  // have would otherwise fall out of the switch as `undefined` and take the
  // whole render down. A plain box is a poor drawing of an unknown shape and a
  // very good one of a crash.
  return [body(w, h)];
}

/** `points="x,y x,y"`, the one form both consumers want it in. */
export function pointsAttr(points: [number, number][]): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

/** A face of the box a shape is drawn in. */
type Face = "left" | "right" | "top" | "bottom";

/**
 * How far in from a face of its box a shape's outline lies, at `at` along it.
 *
 * A connection meets a node on a face of its box, and for a rectangle that is
 * the outline. For anything else it is not: off the middle of a diamond's
 * face there is nothing there but the box, and a connection ending on it
 * stops short in the air. This is the distance a line square to the face has
 * still to travel to reach what is drawn.
 *
 * `at` is in the node's own frame — a y for a left or right face, an x for a
 * top or bottom one. Measured from the 1px stroke inset every shape shares, so
 * an ordinary box answers 0.
 */
export function outlineDepth(
  shape: Shape,
  w: number,
  h: number,
  face: Face,
  at: number,
): number {
  const fill = shapeGeometry(shape, w, h).find((p) => p.paint === "fill");
  if (!fill) return 0;
  // The ray in from the face: where it starts, and which way is inwards.
  const across = face === "left" || face === "right";
  const origin: [number, number] =
    face === "left" ? [0, at] : face === "right" ? [w, at] : face === "top" ? [at, 0] : [at, h];
  const inward: [number, number] =
    face === "left" ? [1, 0] : face === "right" ? [-1, 0] : face === "top" ? [0, 1] : [0, -1];
  const deepest = across ? w / 2 : h / 2;
  const settle = (t: number) => Math.max(0, Math.min(deepest, t) - 1);

  if (shape === "cylinder") {
    // A barrel between two elliptical caps; only the caps are curved.
    if (across) return 0;
    const rx = (w - 2) / 2;
    const u = Math.min(1, Math.abs(at - w / 2) / rx);
    return settle(1 + 8 * (1 - Math.sqrt(1 - u * u)));
  }

  switch (fill.kind) {
    case "ellipse": {
      const [ra, rb] = across ? [fill.rx, fill.ry] : [fill.ry, fill.rx];
      const centre = across ? fill.cy : fill.cx;
      const u = Math.abs(at - centre) / rb;
      if (u >= 1) return settle(deepest);
      return settle((across ? w / 2 : h / 2) - ra * Math.sqrt(1 - u * u));
    }
    case "rect": {
      const r = Math.min(fill.rx ?? 0, fill.width / 2, fill.height / 2);
      if (r <= 0) return 0;
      // Only the rounded corners are set back from the face.
      const lo = (across ? fill.y : fill.x) + r;
      const hi = (across ? fill.y + fill.height : fill.x + fill.width) - r;
      const off = at < lo ? lo - at : at > hi ? at - hi : 0;
      if (off === 0) return 0;
      if (off >= r) return settle(deepest);
      return settle(1 + r - Math.sqrt(r * r - off * off));
    }
    case "polygon": {
      // The nearest edge the ray crosses.
      let best = Infinity;
      const pts = fill.points;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const ex = bx - ax;
        const ey = by - ay;
        const den = inward[0] * ey - inward[1] * ex;
        if (Math.abs(den) < 1e-9) continue;
        const qx = ax - origin[0];
        const qy = ay - origin[1];
        const t = (qx * ey - qy * ex) / den;
        const s = (qx * inward[1] - qy * inward[0]) / den;
        if (t >= 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t);
      }
      return Number.isFinite(best) ? settle(best) : settle(deepest);
    }
    default:
      return 0;
  }
}
