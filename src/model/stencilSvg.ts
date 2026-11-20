/**
 * A draw.io stencil, run, as SVG.
 *
 * A stencil (see `drawioStencils.ts`) is a short program for a canvas:
 * `<path>` with `<move>`, `<line>`, `<curve>`, `<arc>` and `<close>` in it,
 * the shapes `<rect>`, `<roundrect>` and `<ellipse>`, and `<fill>`,
 * `<stroke>` or `<fillstroke>` to paint what was drawn — with `<save>`,
 * `<restore>`, colour, width and dash settings between. Its coordinates are in
 * the stencil's own `w` × `h`, scaled to the cell, or kept in proportion when
 * the stencil says `aspect="fixed"`. Its colours, unless it sets its own, are
 * the cell's `fillColor` and `strokeColor`.
 *
 * This follows `mxStencil.drawShape` and `drawNode` in draw.io's source, the
 * one definition of what a stencil means. Nothing here knows any stencil by
 * name: a Cisco router and a BPMN timer are run the same way.
 */
import type { StencilLookup, StencilNode } from "./drawioStencils";

/** What a stencil is drawn with: the cell's own paint, from its style. */
export interface StencilPaint {
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** draw.io's `gradientColor`: the fill runs from `fill` to this. */
  gradient?: string;
  /** Which way the gradient runs: `south` (the default), `north`, `east`, `west`. */
  gradientDirection?: string;
  dashed?: boolean;
  dashPattern?: string;
  fontColor?: string;
  fontSize?: number;
  /**
   * The cell's style, for the colours a stencil names rather than spells:
   * `<fillcolor color="neutralFill"/>` is whatever the cell's `neutralFill`
   * says.
   */
  style?: Record<string, string>;
}

/** How the stencil is set in its box: turned and mirrored as the cell says. */
export interface StencilPlacement {
  /** `east` (as drawn), `south`, `west` or `north`. */
  direction?: string;
  flipH?: boolean;
  flipV?: boolean;
}

interface State {
  fill: string;
  stroke: string;
  sw: number;
  dashed: boolean;
  dash: number[] | null;
  alpha: number;
  fillAlpha: number;
  strokeAlpha: number;
  cap: string;
  join: string;
  miter: number | null;
  fontColor: string;
  fontSize: number;
  /** Whether the fill is still the cell's own, which is what a gradient applies to. */
  ownFill: boolean;
}

/** Characters a colour may hold, so nothing else reaches an attribute. */
const colour = (c: string | undefined): string | null => {
  if (!c) return null;
  const v = c.trim();
  if (/^none$/i.test(v)) return "none";
  // The light half of draw.io's `light-dark(a,b)`: the drawing's own colour.
  const pair = /^light-dark\(\s*([^,()]+?)\s*,/i.exec(v);
  const picked = pair ? pair[1] : v;
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(picked) ||
    NAMED.has(picked.toLowerCase())
    ? picked
    : null;
};

/** CSS colour names a stencil spells out; any other word names a style property. */
const NAMED = new Set([
  "black",
  "white",
  "red",
  "green",
  "blue",
  "yellow",
  "orange",
  "purple",
  "gray",
  "grey",
  "silver",
  "maroon",
  "olive",
  "lime",
  "aqua",
  "teal",
  "navy",
  "fuchsia",
  "transparent",
]);

const num = (v: string | undefined, otherwise = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : otherwise;
};

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** One decimal place is finer than anything a stencil is drawn at. */
const f = (n: number) => String(Math.round(n * 100) / 100);

/**
 * The stencil drawn at `w` × `h`, as the body of an SVG — or `null` when it
 * draws nothing at all.
 */
export function stencilBody(
  stencil: StencilNode,
  w: number,
  h: number,
  paint: StencilPaint,
  lookup: StencilLookup,
  placement: StencilPlacement = {},
): string | null {
  const out: string[] = [];
  const defs: string[] = [];
  let gradientId: string | null = null;
  const gradient = colour(paint.gradient);
  if (gradient && gradient !== "none" && colour(paint.fill) && paint.fill !== "none") {
    gradientId = "g";
    const dir = (paint.gradientDirection ?? "south").toLowerCase();
    const [x1, y1, x2, y2] =
      dir === "north"
        ? [0, 1, 0, 0]
        : dir === "east"
          ? [0, 0, 1, 0]
          : dir === "west"
            ? [1, 0, 0, 0]
            : [0, 0, 0, 1];
    defs.push(
      `<linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
        `<stop offset="0" stop-color="${colour(paint.fill)}"/>` +
        `<stop offset="1" stop-color="${gradient}"/></linearGradient>`,
    );
  }

  const direction = (placement.direction ?? "east").toLowerCase();
  // Turned a quarter, a stencil is drawn into the box turned the other way
  // and the drawing turned back, as draw.io does: a tall box for a wide shape.
  if (direction === "north" || direction === "south") {
    drawStencil(stencil, (w - h) / 2, (h - w) / 2, h, w, true);
  } else {
    drawStencil(stencil, 0, 0, w, h, true);
  }

  function drawStencil(
    shape: StencilNode,
    x: number,
    y: number,
    bw: number,
    bh: number,
    top: boolean,
  ) {
    const w0 = num(shape.attrs.w, 1) || 1;
    const h0 = num(shape.attrs.h, 1) || 1;
    let sx = bw / w0;
    let sy = bh / h0;
    let x0 = x;
    let y0 = y;
    if (shape.attrs.aspect === "fixed") {
      sx = sy = Math.min(sx, sy);
      x0 += (bw - w0 * sx) / 2;
      y0 += (bh - h0 * sy) / 2;
    }
    const minScale = Math.min(sx, sy);
    const state: State = {
      fill: colour(paint.fill) ?? "#ffffff",
      stroke: colour(paint.stroke) ?? "#000000",
      sw:
        shape.attrs.strokewidth === "inherit" || shape.attrs.strokewidth === undefined
          ? paint.strokeWidth
          : num(shape.attrs.strokewidth, 1) * minScale,
      dashed: !!paint.dashed,
      dash: paint.dashPattern ? paint.dashPattern.split(/\s+/).map(Number) : null,
      alpha: 1,
      fillAlpha: 1,
      strokeAlpha: 1,
      cap: "butt",
      join: "miter",
      miter: null,
      fontColor: colour(paint.fontColor) ?? "#000000",
      fontSize: paint.fontSize ?? 11,
      ownFill: top,
    };
    const stack: State[] = [];
    let path = "";
    /**
     * A colour a stencil sets: spelt out, or named — `fill` and `stroke` for
     * the cell's own, any other name for that property of the cell's style.
     * A name the style does not give leaves the colour as it was.
     */
    const named = (value: string | undefined): string | null => {
      const v = (value ?? "").trim();
      const key = v.toLowerCase();
      if (key === "fill") return colour(paint.fill) ?? "#ffffff";
      if (key === "stroke") return colour(paint.stroke) ?? "#000000";
      const spelt = colour(v);
      if (spelt) return spelt;
      const fromStyle = paint.style?.[v];
      return fromStyle ? colour(fromStyle) : null;
    };

    const X = (n: string | undefined) => f(x0 + num(n) * sx);
    const Y = (n: string | undefined) => f(y0 + num(n) * sy);

    const emit = (fill: boolean, stroke: boolean) => {
      if (!path) return;
      const fillPaint =
        fill && state.fill !== "none"
          ? state.ownFill && gradientId
            ? `url(#${gradientId})`
            : state.fill
          : "none";
      const strokePaint =
        stroke && state.stroke !== "none" && state.sw > 0 ? state.stroke : "none";
      if (fillPaint === "none" && strokePaint === "none") {
        path = "";
        return;
      }
      const attrs = [`d="${path}"`, `fill="${fillPaint}"`, `stroke="${strokePaint}"`];
      if (strokePaint !== "none") {
        attrs.push(`stroke-width="${f(state.sw)}"`);
        if (state.cap !== "butt") attrs.push(`stroke-linecap="${state.cap}"`);
        if (state.join !== "miter") attrs.push(`stroke-linejoin="${state.join}"`);
        if (state.miter !== null) attrs.push(`stroke-miterlimit="${f(state.miter)}"`);
        if (state.dashed) {
          const pattern = (state.dash ?? [3, 3]).map((d) => f(d * Math.max(1, state.sw)));
          attrs.push(`stroke-dasharray="${pattern.join(" ")}"`);
        }
        const so = state.alpha * state.strokeAlpha;
        if (so < 1) attrs.push(`stroke-opacity="${f(so)}"`);
      }
      const fo = state.alpha * state.fillAlpha;
      if (fillPaint !== "none" && fo < 1) attrs.push(`fill-opacity="${f(fo)}"`);
      out.push(`<path ${attrs.join(" ")}/>`);
      path = "";
    };

    const run = (node: StencilNode) => {
      const a = node.attrs;
      switch (node.name) {
        case "save":
          stack.push({ ...state, dash: state.dash ? [...state.dash] : null });
          break;
        case "restore":
          Object.assign(state, stack.pop() ?? state);
          break;
        case "path":
          path = "";
          node.children.forEach(run);
          break;
        case "move":
          path += `M${X(a.x)} ${Y(a.y)}`;
          break;
        case "line":
          path += `L${X(a.x)} ${Y(a.y)}`;
          break;
        case "quad":
          path += `Q${X(a.x1)} ${Y(a.y1)} ${X(a.x2)} ${Y(a.y2)}`;
          break;
        case "curve":
          path += `C${X(a.x1)} ${Y(a.y1)} ${X(a.x2)} ${Y(a.y2)} ${X(a.x3)} ${Y(a.y3)}`;
          break;
        case "arc":
          path +=
            `A${f(num(a.rx) * sx)} ${f(num(a.ry) * sy)} ${f(num(a["x-axis-rotation"]))} ` +
            `${num(a["large-arc-flag"]) ? 1 : 0} ${num(a["sweep-flag"]) ? 1 : 0} ${X(a.x)} ${Y(a.y)}`;
          break;
        case "close":
          path += "Z";
          break;
        case "rect": {
          const rx = x0 + num(a.x) * sx;
          const ry = y0 + num(a.y) * sy;
          const rw = num(a.w) * sx;
          const rh = num(a.h) * sy;
          path = `M${f(rx)} ${f(ry)}h${f(rw)}v${f(rh)}h${f(-rw)}Z`;
          break;
        }
        case "roundrect": {
          const rx = x0 + num(a.x) * sx;
          const ry = y0 + num(a.y) * sy;
          const rw = num(a.w) * sx;
          const rh = num(a.h) * sy;
          // draw.io's default rounding is 15 per cent of the shorter side.
          const factor = (num(a.arcsize) || 15) / 100;
          const r = Math.min(rw * factor, rh * factor);
          path =
            `M${f(rx + r)} ${f(ry)}h${f(rw - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(r)}` +
            `v${f(rh - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(r)}h${f(-(rw - 2 * r))}` +
            `a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(-r)}v${f(-(rh - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-r)}Z`;
          break;
        }
        case "ellipse": {
          const ex = x0 + num(a.x) * sx;
          const ey = y0 + num(a.y) * sy;
          const rx = (num(a.w) * sx) / 2;
          const ry = (num(a.h) * sy) / 2;
          path =
            `M${f(ex)} ${f(ey + ry)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0` +
            `a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0Z`;
          break;
        }
        case "fillstroke":
          emit(true, true);
          break;
        case "fill":
          emit(true, false);
          break;
        case "stroke":
          emit(false, true);
          break;
        case "strokewidth":
          state.sw = num(a.width) * (a.fixed === "1" ? 1 : minScale);
          break;
        case "dashed":
          state.dashed = a.dashed === "1";
          break;
        case "dashpattern":
          state.dash = (a.pattern ?? "").split(/\s+/).map(Number).filter(Number.isFinite);
          break;
        case "strokecolor": {
          const c = named(a.color);
          if (c) state.stroke = c;
          break;
        }
        case "fillcolor": {
          const c = named(a.color);
          if (c) {
            state.ownFill = (a.color ?? "").trim().toLowerCase() === "fill" && top;
            state.fill = c;
          }
          break;
        }
        case "fontcolor": {
          const c = named(a.color);
          if (c) state.fontColor = c;
          break;
        }
        case "fontsize":
          state.fontSize = num(a.size, state.fontSize);
          break;
        case "alpha":
          state.alpha = num(a.alpha, 1);
          break;
        case "fillalpha":
          state.fillAlpha = num(a.alpha, 1);
          break;
        case "strokealpha":
          state.strokeAlpha = num(a.alpha, 1);
          break;
        case "linecap":
          state.cap = a.cap === "round" || a.cap === "square" ? a.cap : "butt";
          break;
        case "linejoin":
          state.join = a.join === "round" || a.join === "bevel" ? a.join : "miter";
          break;
        case "miterlimit":
          state.miter = num(a.limit, 10);
          break;
        case "text": {
          const anchor = a.align === "left" ? "start" : a.align === "right" ? "end" : "middle";
          const baseline =
            a.valign === "top" ? "hanging" : a.valign === "bottom" ? "auto" : "middle";
          out.push(
            `<text x="${X(a.x)}" y="${Y(a.y)}" text-anchor="${anchor}" dominant-baseline="${baseline}" ` +
              `font-family="Helvetica, Arial, sans-serif" font-size="${f(state.fontSize)}" fill="${state.fontColor}">` +
              `${escape(a.str ?? "")}</text>`,
          );
          break;
        }
        case "include-shape": {
          const inner = lookup((a.name ?? "").toLowerCase());
          if (inner) {
            drawStencil(
              inner,
              x0 + num(a.x) * sx,
              y0 + num(a.y) * sy,
              num(a.w) * sx,
              num(a.h) * sy,
              false,
            );
          }
          break;
        }
        default:
          // `connections`, `image` and anything newer: nothing to draw.
          break;
      }
    };

    const background = shape.children.find((c) => c.name === "background");
    const foreground = shape.children.find((c) => c.name === "foreground");
    // The background is the outline, and stays the current path for the
    // foreground to paint: most stencils open their foreground with
    // `<fillstroke/>`, which fills the background they drew.
    background?.children.forEach(run);
    foreground?.children.forEach(run);
    if (!foreground && background) emit(true, true);
  }

  if (out.length === 0) return null;
  const turn = { east: 0, south: 90, west: 180, north: 270 }[direction] ?? 0;
  const t: string[] = [];
  if (placement.flipH) t.push(`translate(${f(w)} 0) scale(-1 1)`);
  if (placement.flipV) t.push(`translate(0 ${f(h)}) scale(1 -1)`);
  if (turn) t.push(`rotate(${turn} ${f(w / 2)} ${f(h / 2)})`);
  const body = (defs.length ? `<defs>${defs.join("")}</defs>` : "") + out.join("");
  return t.length ? `<g transform="${t.join(" ")}">${body}</g>` : body;
}
