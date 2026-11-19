/**
 * Pictures drawn for draw.io shapes the canvas has no node for.
 *
 * Two kinds of shape came across badly as boxes. A vendor icon — a Citrix
 * laptop, an AWS M4 chip, a Cisco router — is a stencil, drawn from a library
 * the canvas does not have, and its `fillColor` is the colour of the icon's
 * ink: read as a box's fill, every one was a solid black, blue or green
 * block. And a shape draw.io writes its words beside rather than in — a BPMN
 * event with "Order received" under it, a stick figure with its name — was a
 * small box with the words crammed into it and cut off: "Availab", "Custo".
 *
 * Both are what a picture node already is: something drawn, with its words
 * under or over it. So each is carried as one, the way a pasted icon is, as
 * an SVG in the file. A stencil is drawn by running draw.io's own definition
 * of it (`stencilSvg.ts`); a built-in shape is drawn as that shape, in the
 * cell's own colours. Nothing here knows any shape by name.
 */
import type { StencilLookup, StencilNode } from "./drawioStencils";
import { stencilBody, type StencilPaint, type StencilPlacement } from "./stencilSvg";

/** An SVG as a picture to put in the file: one unbroken word in the Mermaid. */
function asPicture(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** Characters a colour may hold, so nothing else reaches an attribute. */
const safe = (colour: string) =>
  /^(#[0-9a-f]{3,8}|[a-z]+|none)$/i.test(colour) ? colour : "none";

/**
 * A draw.io stencil drawn at `w` × `h` in the cell's own paint, as a picture
 * to put in the file — or `null` when it draws nothing.
 */
export function stencilPicture(
  stencil: StencilNode,
  w: number,
  h: number,
  paint: StencilPaint,
  lookup: StencilLookup,
  placement?: StencilPlacement,
): string | null {
  const body = stencilBody(stencil, w, h, paint, lookup, placement);
  if (!body) return null;
  return asPicture(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`,
  );
}

/**
 * A stencil drawn in a box that names it.
 *
 * Some draw.io shapes are a box that holds another stencil named in a
 * property of their own — `resIcon=mxgraph.aws4.lambda`,
 * `network2Icon=mxgraph.networks2.phone`. How each library sets the stencil
 * in its box differs, and none of that is followed here. The stencil is
 * drawn as any stencil is, in the cell's own fill and stroke; and when the
 * cell has a gradient, which only a backdrop can show, on a tile of it, with
 * a margin round the stencil.
 */
export function tilePicture(
  stencil: StencilNode,
  w: number,
  h: number,
  paint: StencilPaint,
  lookup: StencilLookup,
): string | null {
  const tile = !!paint.gradient && paint.fill !== "none";
  const inset = tile ? Math.min(w, h) * 0.15 : 0;
  const body = stencilBody(
    stencil,
    w - 2 * inset,
    h - 2 * inset,
    { ...paint, gradient: undefined },
    lookup,
  );
  if (!body && !tile) return null;
  const backdrop = tile
    ? `<defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${safe(paint.fill)}"/><stop offset="1" stop-color="${safe(paint.gradient!)}"/></linearGradient></defs>` +
      `<rect x="0" y="0" width="${w}" height="${h}" fill="url(#t)"/>`
    : "";
  const inner = body ? `<g transform="translate(${inset} ${inset})">${body}</g>` : "";
  return asPicture(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${backdrop}${inner}</svg>`,
  );
}

/** The outlines a shape with its words outside it is drawn as. */
export type Outline =
  | "ellipse"
  | "double"
  | "diamond"
  | "actor"
  | "cross"
  | "box"
  | "round"
  | "dot"
  | "triangle-n"
  | "triangle-e"
  | "triangle-s"
  | "triangle-w";

export interface Paint {
  fill: string;
  stroke: string;
  /** In the drawing's units. */
  width: number;
}

/** A shape at `w`×`h`, in its own colours, with its stroke kept inside the box. */
export function shapePicture(outline: Outline, w: number, h: number, paint: Paint): string {
  const sw = Math.max(0.5, paint.width);
  const fill = safe(paint.fill);
  const stroke = safe(paint.stroke);
  const ink = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"`;
  const i = sw / 2;
  const cx = w / 2;
  const cy = h / 2;
  let body: string;
  switch (outline) {
    case "ellipse":
      body = `<ellipse cx="${cx}" cy="${cy}" rx="${cx - i}" ry="${cy - i}" ${ink}/>`;
      break;
    case "double": {
      const gap = Math.max(2, Math.min(w, h) * 0.08);
      body =
        `<ellipse cx="${cx}" cy="${cy}" rx="${cx - i}" ry="${cy - i}" ${ink}/>` +
        `<ellipse cx="${cx}" cy="${cy}" rx="${Math.max(1, cx - i - gap)}" ry="${Math.max(1, cy - i - gap)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
      break;
    }
    case "dot": {
      // draw.io's waypoint: a small solid disc at the middle of its box.
      const r = Math.max(1, Math.min(cx, cy, paint.width));
      body = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${stroke}"/>`;
      break;
    }
    case "triangle-n":
    case "triangle-e":
    case "triangle-s":
    case "triangle-w": {
      // Pointing the way draw.io's `direction`, after its rotation, says.
      const tip = {
        "triangle-n": [`${cx},${i}`, `${w - i},${h - i}`, `${i},${h - i}`],
        "triangle-s": [`${i},${i}`, `${w - i},${i}`, `${cx},${h - i}`],
        "triangle-e": [`${i},${i}`, `${w - i},${cy}`, `${i},${h - i}`],
        "triangle-w": [`${w - i},${i}`, `${w - i},${h - i}`, `${i},${cy}`],
      }[outline];
      body = `<polygon points="${tip.join(" ")}" ${ink}/>`;
      break;
    }
    case "cross":
      // UML's end of a lifeline: an X in its own colour.
      body = `<path d="M${i} ${i}L${w - i} ${h - i}M${w - i} ${i}L${i} ${h - i}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
      break;
    case "diamond":
      body = `<polygon points="${cx},${i} ${w - i},${cy} ${cx},${h - i} ${i},${cy}" ${ink}/>`;
      break;
    case "actor": {
      // draw.io's stick figure: a head a quarter of the height, arms a third
      // of the way down, legs from two thirds.
      const head = h / 8;
      const line = `fill="none" stroke="${stroke}" stroke-width="${sw}"`;
      body =
        `<ellipse cx="${cx}" cy="${head + i}" rx="${Math.min(head, cx - i)}" ry="${head}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>` +
        `<path d="M${cx} ${2 * head + i}V${(2 * h) / 3}M${i} ${h / 3}H${w - i}M${cx} ${(2 * h) / 3}L${i} ${h - i}M${cx} ${(2 * h) / 3}L${w - i} ${h - i}" ${line}/>`;
      break;
    }
    default: {
      const r = outline === "round" ? Math.min(w, h) * 0.15 : 0;
      body = `<rect x="${i}" y="${i}" width="${w - sw}" height="${h - sw}" rx="${r}" ${ink}/>`;
    }
  }
  return asPicture(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`,
  );
}
