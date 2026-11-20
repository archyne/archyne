/**
 * The arrowheads, diamonds and crow's feet an edge can end in.
 *
 * Extracted from `MarkerDefs` in `components/KindNodes.tsx` for the reason the
 * shapes were: the canvas draws them as JSX and the SVG renderer has to emit
 * the same eleven markers as a string, and two copies of "aggregation" agree
 * only until somebody adjusts one. The stroke colour is the one thing that
 * differs between the two — the canvas resolves it from the live theme, the
 * renderer from the palette it was asked for — so it is a parameter and
 * everything else is data.
 *
 * `orient="auto-start-reverse"` throughout: a marker placed at the start of a
 * path has to point back down it, and that is what makes one definition serve
 * both ends.
 */

/**
 * How a marker's ink is filled: with the edge's own colour, with the page
 * behind it (a hollow arrowhead has to hide the line under it), or not at all.
 */
export type MarkerFill = "stroke" | "hollow" | "none";

/** One shape inside a marker, in the marker's own viewBox coordinates. */
export type Ink =
  | { d: string; fill: MarkerFill; stroke?: boolean; width?: number }
  | { circle: [number, number, number]; width: number };

export interface MarkerSpec {
  id: string;
  viewBox: string;
  refX: number;
  refY: number;
  width: number;
  height: number;
  ink: Ink[];
}

export const MARKERS: MarkerSpec[] = [
  {
    id: "cls-extension",
    viewBox: "0 0 14 14",
    refX: 12,
    refY: 7,
    width: 14,
    height: 14,
    ink: [{ d: "M1,1 L12,7 L1,13 Z", fill: "hollow", stroke: true, width: 1.2 }],
  },
  {
    id: "cls-composition",
    viewBox: "0 0 16 12",
    refX: 14,
    refY: 6,
    width: 16,
    height: 12,
    ink: [{ d: "M1,6 L8,1 L15,6 L8,11 Z", fill: "stroke", stroke: true, width: 1 }],
  },
  {
    id: "cls-aggregation",
    viewBox: "0 0 16 12",
    refX: 14,
    refY: 6,
    width: 16,
    height: 12,
    ink: [{ d: "M1,6 L8,1 L15,6 L8,11 Z", fill: "hollow", stroke: true, width: 1.2 }],
  },
  {
    id: "cls-dependency",
    viewBox: "0 0 12 12",
    refX: 10,
    refY: 6,
    width: 12,
    height: 12,
    ink: [{ d: "M2,1 L10,6 L2,11", fill: "none", stroke: true, width: 1.4 }],
  },
  {
    id: "seq-arrow",
    viewBox: "0 0 12 12",
    refX: 10,
    refY: 6,
    width: 12,
    height: 12,
    ink: [{ d: "M1,1 L11,6 L1,11 Z", fill: "stroke" }],
  },
  {
    id: "seq-open",
    viewBox: "0 0 12 12",
    refX: 10,
    refY: 6,
    width: 12,
    height: 12,
    ink: [{ d: "M2,1 L10,6 L2,11", fill: "none", stroke: true, width: 1.4 }],
  },
  {
    id: "seq-cross",
    viewBox: "0 0 12 12",
    refX: 9,
    refY: 6,
    width: 12,
    height: 12,
    ink: [{ d: "M3,2 L11,10 M11,2 L3,10", fill: "none", stroke: true, width: 1.5 }],
  },
  {
    id: "er-one",
    viewBox: "0 0 12 12",
    refX: 10,
    refY: 6,
    width: 12,
    height: 12,
    ink: [{ d: "M5,1 L5,11", fill: "none", stroke: true, width: 1.5 }],
  },
  {
    id: "er-zero-one",
    viewBox: "0 0 16 12",
    refX: 14,
    refY: 6,
    width: 16,
    height: 12,
    ink: [
      { circle: [4, 6, 3], width: 1.2 },
      { d: "M10,1 L10,11", fill: "none", stroke: true, width: 1.5 },
    ],
  },
  {
    id: "er-zero-more",
    viewBox: "0 0 18 12",
    refX: 16,
    refY: 6,
    width: 18,
    height: 12,
    ink: [
      { circle: [4, 6, 3], width: 1.2 },
      { d: "M9,6 L17,1 M9,6 L17,6 M9,6 L17,11", fill: "none", stroke: true, width: 1.2 },
    ],
  },
  {
    id: "er-one-more",
    viewBox: "0 0 18 12",
    refX: 16,
    refY: 6,
    width: 18,
    height: 12,
    ink: [
      { d: "M4,1 L4,11", fill: "none", stroke: true, width: 1.5 },
      { d: "M8,6 L17,1 M8,6 L17,6 M8,6 L17,11", fill: "none", stroke: true, width: 1.2 },
    ],
  },
  {
    // SysML containment: a circle with a cross in it, at the container's end.
    // Hollow rather than open, so the line it sits on does not show through.
    id: "req-contains",
    viewBox: "0 0 16 16",
    refX: 15,
    refY: 8,
    width: 16,
    height: 16,
    ink: [
      {
        d: "M1,8 a7,7 0 1 0 14,0 a7,7 0 1 0 -14,0 Z",
        fill: "hollow",
        stroke: true,
        width: 1.2,
      },
      { d: "M1,8 L15,8 M8,1 L8,15", fill: "none", stroke: true, width: 1.2 },
    ],
  },
  {
    // The plain arrowhead a flowchart, state, C4 or architecture edge ends in.
    // The canvas gets this one from React Flow's own `MarkerType.ArrowClosed`,
    // which generates it into the live document — so it has no entry in
    // `MarkerDefs` and the renderer, having no live document, needs its own.
    id: "arch-arrow",
    viewBox: "0 0 10 10",
    refX: 9,
    refY: 5,
    width: 7,
    height: 7,
    ink: [{ d: "M0,1 L9,5 L0,9 z", fill: "stroke" }],
  },
];

/** Every marker, as a `<defs>` body, painted for one theme. */
export function markerDefs(stroke: string, hollowFill: string): string {
  const paint = (fill: MarkerFill) =>
    fill === "stroke" ? stroke : fill === "hollow" ? hollowFill : "none";

  return MARKERS.map((m) => {
    const ink = m.ink
      .map((i) => {
        if ("circle" in i) {
          const [cx, cy, r] = i.circle;
          return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${stroke}" stroke-width="${i.width}"/>`;
        }
        const strokeAttr = i.stroke ? ` stroke="${stroke}" stroke-width="${i.width ?? 1}"` : "";
        return `<path d="${i.d}" fill="${paint(i.fill)}"${strokeAttr}/>`;
      })
      .join("");
    return (
      `<marker id="${m.id}" viewBox="${m.viewBox}" refX="${m.refX}" refY="${m.refY}" ` +
      `markerWidth="${m.width}" markerHeight="${m.height}" orient="auto-start-reverse">` +
      `${ink}</marker>`
    );
  }).join("");
}
