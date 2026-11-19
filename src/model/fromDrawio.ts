/**
 * Reading a draw.io (`.drawio`, `diagrams.net`) file into a Mermaid flowchart.
 *
 * The point of this is migration, not fidelity. draw.io's model is free-form
 * geometry — arbitrary paths, rotation, layers, per-shape fonts — and Mermaid
 * has none of that, so an exact import is not on offer and pretending
 * otherwise would produce a worse result than saying so. What does carry over
 * is the part people actually drew: the boxes, what they say, which shape they
 * are, what colour they were given, what connects to what, the containers
 * around them, and *where everything sits* — which lands in the
 * `%% graph:positions` comment, so an imported diagram opens looking like the
 * one that was left behind rather than re-laid-out from scratch.
 *
 * The output goes through the same serializer as everything else, so an import
 * is an ordinary Mermaid document from the first moment: undo, round-trip and
 * the file-format contract all apply to it with no special case.
 */
import { inflateSync } from "fflate";
import type {
  AnyNode,
  ArrowType,
  EdgeStroke,
  FlowEdge,
  GroupNode,
  Shape,
  ShapeNode,
} from "./types";
import { serializeFlowchart } from "./kinds/flowchart";
import { measureNode } from "../measureNode";
import { textMetrics, wrapText } from "../textMetrics";
import { BOXES, COMPACT_SHAPE, face } from "../render/boxModel";
import { labelLines } from "./label";
import { idFactory, readableOn } from "./importShared";
import { buildArchitecture } from "./drawioArchitecture";
import { shapePicture, stencilPicture, tilePicture, type Outline } from "./drawioPictures";
import { stencilNames, type StencilLookup } from "./drawioStencils";
import type { StencilPaint } from "./stencilSvg";
import { positionsLine, type PositionMap } from "./positions";
import { waypointKey, waypointsLine, type WaypointMap } from "./waypoints";
import { edgeStylesLine, type EdgeStyleMap, type RouteStyle } from "./edgeStyle";

export interface DrawioImport {
  /** A complete Mermaid document, layout comments included. */
  code: string;
  /** How many shapes and connections came across. */
  nodes: number;
  edges: number;
  /** Every page in the file, by name. */
  pages: string[];
  /** Which of them was converted, as an index. */
  page: number;
  /** Cells that had nothing to become and were left out. */
  dropped: number;
  /**
   * The family the drawing looks like, when that is *not* the flowchart it
   * was converted to. draw.io has no diagram type of its own — a sequence
   * diagram there is lifeline shapes on the same canvas as everything else —
   * so the only honest thing is to convert what can be converted and say
   * what the file appeared to be.
   */
  looksLike?: "sequence" | "er" | "class";
}

/** The families a draw.io drawing can be read as. */
export type DrawioAs = "flowchart" | "architecture";

/** Style markers that give away a family Archyne cannot yet convert. */
const FAMILY_MARKS: Array<[RegExp, "sequence" | "er" | "class"]> = [
  [/umlLifeline|umlFrame|shape=umlActor/i, "sequence"],
  [/entityRelationEdgeStyle|shape=table\b|childLayout=tableLayout/i, "er"],
  [/swimlane;.*startSize=26|umlEmptyClass|shape=umlClass/i, "class"],
];

/** The family the styles suggest, or undefined for an ordinary drawing. */
function looksLike(cells: RawCell[]): DrawioImport["looksLike"] {
  const styles = cells.map((c) => c.style).join(";");
  for (const [pattern, family] of FAMILY_MARKS) {
    if (pattern.test(styles)) return family;
  }
  return undefined;
}

/* ---------- unwrapping the container ---------- */

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("this file is not valid XML");
  return doc;
}

/**
 * The XML of one page.
 *
 * draw.io stores a page either as plain `<mxGraphModel>` or — the default when
 * "Compressed" is on — as base64 of raw DEFLATE of the URI-encoded XML. Three
 * layers deep, and no marker distinguishes the two, so the compressed path is
 * simply what is tried when there is no element inside the `<diagram>`.
 */
function pageModel(diagram: Element): Element {
  const inline = diagram.querySelector("mxGraphModel");
  if (inline) return inline;

  const payload = (diagram.textContent ?? "").trim();
  if (!payload) throw new Error("this page is empty");

  let xml: string;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    xml = decodeURIComponent(new TextDecoder().decode(inflateSync(bytes)));
  } catch {
    throw new Error("this page is compressed in a way Archyne cannot read");
  }
  const model = parseXml(xml).querySelector("mxGraphModel");
  if (!model) throw new Error("this page holds no diagram");
  return model;
}

/* ---------- reading cells ---------- */

interface RawCell {
  id: string;
  label: string;
  /** The label as draw.io wrote it: HTML when the style says `html=1`. */
  html: string;
  /**
   * The properties draw.io lets a shape carry, `status="New"` on a kanban
   * column — what a `%status%` in a label below it stands for.
   */
  vars: Record<string, string>;
  style: string;
  parent: string;
  vertex: boolean;
  edge: boolean;
  source: string;
  target: string;
  geometry: { x: number; y: number; w: number; h: number } | null;
  points: Array<{ x: number; y: number }>;
  /**
   * Where a connection's ends are when it is not tied to a shape: draw.io
   * lets an arrow start or stop on empty canvas, or on a container's edge
   * without being glued to it.
   */
  loose: { source?: { x: number; y: number }; target?: { x: number; y: number } };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * A cell's label as text.
 *
 * draw.io labels are HTML — bold runs, `<br>`, sometimes a whole table. Only
 * the words survive, because a Mermaid label is text; the line breaks survive
 * as `<br/>`, which Mermaid does render.
 */
function plainText(value: string): string {
  const lines = value
    // Attributes and all: draw.io copies a style onto a pasted break
    // (`<br style="border-color: …">`), and that one was swallowed whole by
    // the tag strip below, joining the lines it separated.
    .replace(/<br\b[^>]*>/gi, "\n")
    // A block starts a line as well as ending one: "Living Room<div>192.168.3.x</div>"
    // is two lines in draw.io, and read only at the closing tag it was one.
    .replace(/<\/?(p|div|li|tr|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return (
    decodeEntities(lines)
      .split("\n")
      // `\s` covers the non-breaking spaces `&nbsp;` just turned into, which
      // draw.io uses freely for spacing inside a label.
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("<br/>")
  );
}

interface Style {
  /** Bare tokens: `ellipse`, `rounded`, `swimlane`, `group`. */
  names: Set<string>;
  /** `key=value` pairs. */
  of: Record<string, string>;
}

function parseStyle(style: string): Style {
  const names = new Set<string>();
  const of: Record<string, string> = {};
  for (const part of style.split(";")) {
    const token = part.trim();
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq < 0) names.add(token.toLowerCase());
    else of[token.slice(0, eq).trim()] = token.slice(eq + 1).trim();
  }
  return { names, of };
}

function geometryOf(cell: Element): RawCell["geometry"] {
  const g = [...cell.children].find((c) => c.getAttribute("as") === "geometry");
  if (!g) return null;
  const n = (name: string) => Number(g.getAttribute(name) ?? NaN);
  const x = n("x");
  const y = n("y");
  // draw.io leaves out a coordinate that is zero, so a shape in the corner of
  // its group has neither — and was read as having no geometry at all, and an
  // unlabelled one dropped. Only a cell with no position *and* no size has
  // none.
  if (
    !Number.isFinite(x) &&
    !Number.isFinite(y) &&
    !Number.isFinite(n("width")) &&
    !Number.isFinite(n("height"))
  ) {
    return null;
  }
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    w: Number.isFinite(n("width")) ? n("width") : 120,
    h: Number.isFinite(n("height")) ? n("height") : 60,
  };
}

function looseOf(cell: Element): RawCell["loose"] {
  const g = [...cell.children].find((c) => c.getAttribute("as") === "geometry");
  const out: RawCell["loose"] = {};
  for (const p of g ? [...g.children] : []) {
    const as = p.getAttribute("as");
    if (p.tagName !== "mxPoint" || (as !== "sourcePoint" && as !== "targetPoint")) continue;
    const point = { x: Number(p.getAttribute("x") ?? 0), y: Number(p.getAttribute("y") ?? 0) };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    out[as === "sourcePoint" ? "source" : "target"] = point;
  }
  return out;
}

function pointsOf(cell: Element): RawCell["points"] {
  const g = [...cell.children].find((c) => c.getAttribute("as") === "geometry");
  const array = g && [...g.children].find((c) => c.getAttribute("as") === "points");
  if (!array) return [];
  return [...array.children]
    .filter((p) => p.tagName === "mxPoint")
    .map((p) => ({ x: Number(p.getAttribute("x") ?? 0), y: Number(p.getAttribute("y") ?? 0) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/**
 * Every cell in the model, in document order.
 *
 * A cell may be wrapped in `<object>` (or `<UserObject>`), which is how
 * draw.io attaches custom properties and where the label then lives — so the
 * identity comes from the wrapper and everything else from the `mxCell`
 * inside it.
 */
function readCells(model: Element): RawCell[] {
  const root = model.querySelector("root");
  if (!root) return [];

  const out: RawCell[] = [];
  for (const element of [...root.children]) {
    const wrapped = element.tagName !== "mxCell";
    const cell = wrapped ? element.querySelector("mxCell") : element;
    if (!cell) continue;

    const label = wrapped
      ? (element.getAttribute("label") ?? element.getAttribute("value") ?? "")
      : (cell.getAttribute("value") ?? "");
    const vars: Record<string, string> = {};
    if (wrapped) {
      for (const a of [...element.attributes]) {
        if (!["id", "label", "value", "placeholders"].includes(a.name)) vars[a.name] = a.value;
      }
      if (element.getAttribute("placeholders") === "1") vars["%placeholders%"] = "1";
    }

    out.push({
      id: (wrapped ? element.getAttribute("id") : cell.getAttribute("id")) ?? "",
      label: plainText(label),
      html: label,
      vars,
      style: cell.getAttribute("style") ?? "",
      parent: cell.getAttribute("parent") ?? "",
      vertex: cell.getAttribute("vertex") === "1",
      edge: cell.getAttribute("edge") === "1",
      source: cell.getAttribute("source") ?? "",
      target: cell.getAttribute("target") ?? "",
      geometry: geometryOf(cell),
      points: pointsOf(cell),
      loose: looseOf(cell),
    });
  }
  return resolved(out.filter((c) => c.id)).map(turned);
}

/**
 * A shape turned a quarter, with the box it is drawn in turned too.
 *
 * draw.io keeps a rotated shape's box as it was before the turn and turns
 * the drawing about its middle; the canvas has no turn, so the box is turned
 * instead — a triangle 24 wide and 72 tall, turned a quarter, is the 72-wide
 * roof of a house. Only shapes with no words: words cannot be turned here,
 * and their box is better left the way they read.
 */
function turned(cell: RawCell): RawCell {
  const g = cell.geometry;
  const turn = Number(/(?:^|;)\s*rotation=(-?[\d.]+)/.exec(cell.style)?.[1]);
  if (!g || !cell.vertex || cell.label || !Number.isFinite(turn)) return cell;
  const quarter = Math.round(turn / 90);
  if (Math.abs(turn - quarter * 90) > 1 || quarter % 2 === 0) return cell;
  const cx = g.x + g.w / 2;
  const cy = g.y + g.h / 2;
  return { ...cell, geometry: { x: cx - g.h / 2, y: cy - g.w / 2, w: g.h, h: g.w } };
}

/**
 * What draw.io works out from a shape's surroundings, worked out.
 *
 * A label with `placeholders="1"` stands for a property of the shape or of
 * anything holding it: every card in draw.io's kanban reads `%status%`, and
 * the column it is in says what that is. A colour of `swimlane` or `inherit`
 * is the colour of the shape holding it — the cards there are filled
 * `swimlane`, so each took its column's, and read as the keyword came out
 * black.
 */
function resolved(cells: RawCell[]): RawCell[] {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const up = function* (cell: RawCell) {
    for (let at: RawCell | undefined = cell, n = 0; at && n < 64; n++) {
      yield at;
      at = byId.get(at.parent);
    }
  };
  const lookup = (cell: RawCell, name: string) => {
    for (const at of up(cell)) if (name in at.vars) return at.vars[name];
    return undefined;
  };
  /** The nearest holder's own value for `key`, passing over ones that defer too. */
  const inherited = (cell: RawCell, key: string) => {
    for (const at of [...up(cell)].slice(1)) {
      const value = parseStyle(at.style).of[key];
      if (value && !/^(swimlane|inherit|default)$/i.test(value)) return value;
    }
    return undefined;
  };
  return cells.map((cell) => {
    let { html, label, style } = cell;
    if (cell.vars["%placeholders%"] === "1" && /%[\w.-]+%/.test(html)) {
      html = html.replace(/%([\w.-]+)%/g, (whole, name: string) => lookup(cell, name) ?? whole);
      label = plainText(html);
    }
    style = style.replace(
      /(^|;)(\s*)(fillColor|strokeColor|fontColor)=(swimlane|inherit)(?=;|$)/gi,
      (whole, lead: string, gap: string, key: string) => {
        const from = inherited(cell, key);
        return from ? `${lead}${gap}${key}=${from}` : whole;
      },
    );
    return html === cell.html && style === cell.style ? cell : { ...cell, html, label, style };
  });
}

/* ---------- shapes ---------- */

/** draw.io's built-in style names, and the Mermaid shape each becomes. */
const BY_NAME: Record<string, Shape> = {
  rhombus: "diamond",
  hexagon: "hexagon",
  cylinder: "cylinder",
  cylinder3: "cylinder",
  datastore: "cylinder",
  parallelogram: "lean_right",
  trapezoid: "trapezoid",
  process: "subroutine",
  step: "odd",
  display: "odd",
  card: "square",
  note: "square",
  document: "square",
  tape: "square",
  cube: "square",
  cloud: "square",
  triangle: "square",
  actor: "square",
  umlactor: "square",
  // UML's final state is a ring round a dot, its initial state a dot.
  endstate: "doublecircle",
  startstate: "circle",
};

/** The shape library draw.io's own flowchart stencils come from. */
const BY_STENCIL: Record<string, Shape> = {
  decision: "diamond",
  database: "cylinder",
  direct_data: "cylinder",
  stored_data: "cylinder",
  internal_storage: "square",
  terminator: "stadium",
  start_1: "circle",
  start_2: "circle",
  on_page_reference: "circle",
  off_page_reference: "odd",
  predefined_process: "subroutine",
  data: "lean_right",
  manual_input: "lean_right",
  manual_operation: "inv_trapezoid",
  preparation: "hexagon",
  document: "square",
  process: "square",
  or: "circle",
  summing_function: "circle",
};

/**
 * The Mermaid shape closest to what draw.io drew.
 *
 * Mermaid has fourteen vertex shapes and draw.io has thousands, so this is a
 * best fit and nothing more. Anything unrecognised becomes a rectangle, which
 * is what an unrecognised box looks like in draw.io too.
 */
function mapShape(style: Style, geometry: RawCell["geometry"]): Shape {
  const named = style.of.shape?.toLowerCase() ?? "";
  if (named.startsWith("mxgraph.")) {
    const stencil = BY_STENCIL[named.split(".").pop() ?? ""];
    if (stencil) return stencil;
  }

  // The outline a shape is hit-tested on says what it is when its name does
  // not: draw.io's BPMN events are `mxgraph.bpmn.shape` with an ellipse
  // perimeter, its gateways the same with a rhombus one. Read by name alone,
  // every event and gateway in a process came out a square.
  const perimeter = (style.of.perimeter ?? "").toLowerCase();
  if (perimeter.startsWith("rhombus")) return "diamond";
  const isEllipse =
    style.names.has("ellipse") || named === "ellipse" || perimeter.startsWith("ellipse");
  if (isEllipse || named === "doubleellipse") {
    if (style.of.shape === "doubleEllipse" || named === "doubleellipse") return "doublecircle";
    // A wide ellipse is a pill in everything but name; only a round one is
    // really a circle, and Mermaid's circle forces its label into a square.
    const ratio = geometry ? geometry.w / Math.max(1, geometry.h) : 1;
    return ratio > 1.3 ? "stadium" : "circle";
  }

  for (const name of style.names) {
    if (BY_NAME[name]) return BY_NAME[name];
  }
  if (named && BY_NAME[named]) return BY_NAME[named];

  if (style.of.rounded === "1") {
    // draw.io's terminator is a rectangle with its corners rounded all the
    // way, which is exactly Mermaid's stadium.
    return Number(style.of.arcSize ?? 0) >= 40 ? "stadium" : "round";
  }
  return "square";
}

/**
 * The colour a panel is filled with: its own, draw.io's white when it names
 * none, or `null` when it is see-through or its colour cannot be read.
 */
function panelFill(style: Style): string | null {
  if (style.of.fillColor === undefined) return "#ffffff";
  const fill = colourStyles(style)
    .find((d) => d.startsWith("fill:"))
    ?.slice(5);
  return fill && fill !== "transparent" ? onWhite(fill) : null;
}

/**
 * A see-through colour as it looked on draw.io's white page.
 *
 * A panel drawn at 60% is a pale tint there. On the dark canvas the same
 * alpha let the dark through and every room in a home network came out a
 * muddy grey-brown. A panel is a backdrop: nothing behind it is meant to
 * show, so its colour is the one the author saw.
 */
function onWhite(colour: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  if (!m) return colour;
  const a = parseInt(m[4], 16) / 255;
  const mix = (h: string) =>
    Math.round(parseInt(h, 16) * a + 255 * (1 - a))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(m[1])}${mix(m[2])}${mix(m[3])}`;
}

/**
 * The dash a dashed cell is drawn with: its own `dashPattern` — the VNets in
 * aks-baseline are dotted, `1 1` — or draw.io's default.
 */
function dashOf(style: Style): string {
  const pattern = (style.of.dashPattern ?? "").trim();
  return /^\d+(\.\d+)?( \d+(\.\d+)?)*$/.test(pattern) ? pattern : "3 3";
}

/** `fill:` / `stroke:` / `color:` for a cell that was given colours. */
function colourStyles(style: Style): string[] {
  const out: string[] = [];
  // Only what a Mermaid `style` line can carry. draw.io also writes `default`
  // (the theme's colour, which Mermaid reads as a keyword and refuses) and,
  // since its dark mode, `light-dark(#333333,#cccccc)` — whose comma ends the
  // property halfway through. The light half is the colour the drawing was
  // made in; anything else unreadable is left to the theme.
  const colour = (value: string | undefined): string | null => {
    if (!value) return null;
    const v = value.trim();
    const lower = v.toLowerCase();
    if (lower === "none") return "transparent";
    if (lower === "default" || lower === "inherit") return null;
    const pair = /^light-dark\(\s*([^,()]+?)\s*,/i.exec(v);
    const picked = pair ? pair[1] : v;
    return /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(picked) ? picked : null;
  };

  // See-through, as draw.io's Venn circles are: `opacity` for the whole
  // shape, `fillOpacity` and `strokeOpacity` for one half. Taken out, the
  // three circles were three solid blocks, each hiding the overlap it was
  // drawn to show. The words stay solid, as draw.io keeps them.
  const percent = (key: string) => {
    const n = Number(style.of[key]);
    return Number.isFinite(n) && n >= 0 && n < 100 ? n / 100 : 1;
  };
  const seen = percent("opacity");
  const fill = withAlpha(colour(style.of.fillColor), seen * percent("fillOpacity"));
  const stroke = withAlpha(colour(style.of.strokeColor), seen * percent("strokeOpacity"));
  const text = colour(style.of.fontColor);
  if (fill) out.push(`fill:${fill}`);
  if (stroke) out.push(`stroke:${stroke === "transparent" ? "none" : stroke}`);
  // A heavy border is part of what a shape says — a BPMN end event is the
  // thick circle — and draw.io's default hairline is near enough the
  // canvas's own that it is left to it.
  const width = Number(style.of.strokeWidth);
  if (Number.isFinite(width) && width >= 2 && stroke !== "transparent") {
    out.push(`stroke-width:${width}px`);
  }

  if (text) {
    out.push(`color:${text}`);
  } else if (fill) {
    const readable = readableOn(fill);
    if (readable) out.push(`color:${readable}`);
  }
  // A label with no box is a real draw.io idiom for a heading. Mermaid has no
  // such shape, but a rectangle painted out of existence reads the same.
  if (style.names.has("text") && !fill && !stroke) {
    out.push("fill:transparent", "stroke:none");
  }
  return out;
}

/** How a label is set: what a Mermaid `style` line can say about its words. */
interface Type {
  color?: string;
  bold: boolean;
  italic: boolean;
  /** In pixels; absent when draw.io was left at its own size. */
  size?: number;
  align?: "left" | "right";
  valign?: "top" | "bottom";
  /** How solid the words are, 0 to 1: draw.io's `textOpacity`. */
  opacity?: number;
}

/** Tags with no closing half, which must not be waited for. */
const VOID_TAGS = new Set(["br", "img", "hr", "input", "wbr"]);

/**
 * How a cell's words are set: its style's font size, `fontStyle` (a bit
 * mask, 1 bold and 2 italic) and alignment, and whatever the label's own
 * HTML says over them.
 *
 * A Mermaid label is plain text, set one way throughout, and a draw.io label
 * is HTML that can change colour halfway through a word. So the HTML is read
 * for what most of its letters are: the org chart's labels are white by
 * style and dark blue by a `<font color>` round every word, and read by
 * style alone they came out white on pale grey.
 */
function typeOf(style: Style, html: string): Type {
  const bits = Number(style.of.fontStyle ?? 0) || 0;
  const size = Number(style.of.fontSize);
  const base = {
    color: style.of.fontColor,
    bold: (bits & 1) !== 0,
    italic: (bits & 2) !== 0,
    size: Number.isFinite(size) && size > 0 ? size : undefined,
  };
  const align =
    style.of.align === "left" || style.of.align === "right" ? style.of.align : undefined;
  const valign =
    style.of.verticalAlign === "top" || style.of.verticalAlign === "bottom"
      ? style.of.verticalAlign
      : undefined;
  const seen = Number(style.of.textOpacity);
  const opacity = Number.isFinite(seen) && seen >= 0 && seen < 100 ? seen / 100 : undefined;
  const placed: Pick<Type, "align" | "valign" | "opacity"> = {
    ...(align ? { align } : {}),
    ...(valign ? { valign } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
  };
  if (style.of.html !== "1" || !html.includes("<")) return { ...base, ...placed };

  type Run = typeof base;
  const stack: Array<{ tag: string; run: Run }> = [{ tag: "", run: base }];
  const colours = new Map<string, number>();
  const sizes = new Map<number, number>();
  let letters = 0;
  let bold = 0;
  let italic = 0;
  const pick = (css: string, name: string) =>
    new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(css)?.[1].trim();
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|([^<]+)/gi)) {
    const [, closing, rawTag, attrs, text] = m;
    const run = stack[stack.length - 1].run;
    if (text !== undefined) {
      const n = decodeEntities(text).replace(/\s+/g, "").length;
      if (!n) continue;
      letters += n;
      if (run.bold) bold += n;
      if (run.italic) italic += n;
      if (run.color) colours.set(run.color, (colours.get(run.color) ?? 0) + n);
      if (run.size) sizes.set(run.size, (sizes.get(run.size) ?? 0) + n);
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (closing) {
      const at = stack.map((f) => f.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    if (VOID_TAGS.has(tag)) continue;
    const next = { ...run };
    if (tag === "b" || tag === "strong" || /^h[1-6]$/.test(tag)) next.bold = true;
    if (tag === "i" || tag === "em") next.italic = true;
    const colour = /\bcolor\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    if (tag === "font" && colour) next.color = colour;
    const css = /\bstyle\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "";
    const c = pick(css, "color");
    if (c) next.color = c;
    const weight = pick(css, "font-weight");
    if (weight) next.bold = /bold|[6-9]00/i.test(weight);
    const slant = pick(css, "font-style");
    if (slant) next.italic = /italic|oblique/i.test(slant);
    const px = /^([\d.]+)px$/i.exec(pick(css, "font-size") ?? "")?.[1];
    if (px) next.size = Number(px);
    stack.push({ tag, run: next });
  }
  const most = <K>(tally: Map<K, number>): K | undefined =>
    [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    color: most(colours) ?? base.color,
    bold: letters ? bold * 2 > letters : base.bold,
    italic: letters ? italic * 2 > letters : base.italic,
    size: most(sizes) ?? base.size,
    ...placed,
  };
}

/** A colour as a Mermaid `style` line can carry it, or `null`. */
function cssColour(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
  if (rgb) {
    return `#${rgb
      .slice(1, 4)
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"))
      .join("")}`;
  }
  return /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(v) && !/^(none|default|inherit)$/i.test(v)
    ? v
    : null;
}

/**
 * A `#rgb` or `#rrggbb` colour made see-through, or the colour as it was:
 * a named colour has no alpha to give it, and a whole one needs none.
 */
function withAlpha(colour: string | null, alpha: number): string | null {
  if (!colour || alpha >= 1) return colour;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(colour);
  const hex = short
    ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
    : colour;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return colour;
  return `${hex}${Math.round(Math.max(0, alpha) * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/** The declarations for a label's type, beside the colours `colourStyles` gives. */
function typeStyles(type: Type): string[] {
  const out: string[] = [];
  // See-through words, as the SWOT's great faint letters are: drawn solid,
  // each covered the list laid over it.
  const colour = withAlpha(cssColour(type.color), type.opacity ?? 1);
  if (colour) out.push(`color:${colour}`);
  if (type.bold) out.push("font-weight:bold");
  if (type.italic) out.push("font-style:italic");
  if (type.align) out.push(`text-align:${type.align}`);
  if (type.valign) out.push(`vertical-align:${type.valign}`);
  return out;
}

/** Whether draw.io sets a shape's words beside it rather than in it. */
function labelOutside(style: Style): boolean {
  return (
    /^(top|bottom)$/.test(style.of.verticalLabelPosition ?? "") ||
    /^(left|right)$/.test(style.of.labelPosition ?? "")
  );
}

/**
 * A stencil's name, when the shape is one: draw.io's libraries all live under
 * `mxgraph.`, and its own built-in shapes — `rectangle`, `ellipse`,
 * `triangle` — do not. The flowchart library's symbols the canvas has a
 * shape of its own for (`BY_STENCIL`) are left to it, since there they stay
 * editable shapes rather than pictures.
 */
function stencilName(style: Style): string | null {
  const shape = (style.of.shape ?? "").toLowerCase();
  if (!shape.startsWith("mxgraph.")) return null;
  if (shape.startsWith("mxgraph.flowchart.") && BY_STENCIL[shape.split(".").pop() ?? ""]) {
    return null;
  }
  return shape;
}

/** A colour from a style, as draw.io would paint it: the light half of a `light-dark()`. */
function paintColour(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const pair = /^light-dark\(\s*([^,()]+?)\s*,/i.exec(value.trim());
  const v = (pair ? pair[1] : value).trim();
  if (/^none$/i.test(v)) return "none";
  return cssColour(v) ?? undefined;
}

/** The cell's own paint, as a stencil is drawn with it. */
function paintOf(style: Style): StencilPaint {
  const fill = paintColour(style.of.fillColor);
  const stroke = paintColour(style.of.strokeColor);
  const gradient = paintColour(style.of.gradientColor);
  return {
    fill: fill ?? "#ffffff",
    stroke: stroke ?? "#000000",
    strokeWidth: Number(style.of.strokeWidth) || 1,
    ...(gradient && gradient !== "none" ? { gradient } : {}),
    ...(style.of.gradientDirection ? { gradientDirection: style.of.gradientDirection } : {}),
    ...(style.of.dashed === "1" ? { dashed: true } : {}),
    ...(style.of.dashPattern ? { dashPattern: style.of.dashPattern } : {}),
    ...(paintColour(style.of.fontColor) ? { fontColor: paintColour(style.of.fontColor) } : {}),
    style: style.of,
  };
}

/**
 * A picture to draw a shape as, or `null` for one the canvas draws itself.
 *
 * In order: a stencil, run from draw.io's own definition of it; a box that
 * names a stencil in one of its properties (a tile with an icon on it);
 * a stencil that could not be had, as its outline; and one of draw.io's
 * built-in shapes the canvas has no node for, or that draw.io sets its words
 * beside, as that shape.
 */
function drawnPicture(cell: RawCell, style: Style, stencils: StencilLookup): string | null {
  if (!cell.geometry) return null;
  const { w, h } = cell.geometry;
  const paint = paintOf(style);
  const placement = {
    ...(style.of.direction ? { direction: style.of.direction } : {}),
    ...(style.of.flipH === "1" ? { flipH: true } : {}),
    ...(style.of.flipV === "1" ? { flipV: true } : {}),
  };

  const name = stencilName(style);
  const stencil = name ? stencils(name) : undefined;
  if (stencil) return stencilPicture(stencil, w, h, paint, stencils, placement);

  // A box naming a stencil in a property of its own.
  for (const [key, value] of Object.entries(style.of)) {
    if (key === "shape" || !/^mxgraph\./i.test(value)) continue;
    const named = stencils(value.toLowerCase());
    if (!named) continue;
    return tilePicture(named, w, h, paint, stencils);
  }

  const shape = (style.of.shape ?? "").toLowerCase();
  const widthOf = Number(style.of.strokeWidth) || 1;

  // A shape there is no definition for — offline, a shape draw.io draws in
  // code rather than from a stencil, a name no library has — is what
  // draw.io itself falls back to: a box in the cell's own colours, below.

  // draw.io's built-in shapes the canvas has no node for.
  if (shape === "triangle" || style.names.has("triangle")) {
    // It points east unless told otherwise, and a quarter turn turns it.
    const ways = ["n", "e", "s", "w"];
    const dir = { north: 0, east: 1, south: 2, west: 3 }[style.of.direction ?? "east"] ?? 1;
    const turns = Math.round((Number(style.of.rotation) || 0) / 90);
    const way = ways[(((dir + turns) % 4) + 4) % 4];
    return shapePicture(`triangle-${way}` as Outline, w, h, {
      fill: paint.fill,
      stroke: paint.stroke,
      width: widthOf,
    });
  }
  if (shape === "waypoint") {
    return shapePicture("dot", w, h, {
      fill: "none",
      stroke: paint.stroke,
      width: (Number(style.of.size) || 6) / 2,
    });
  }
  if (shape === "umldestroy") {
    return shapePicture("cross", w, h, { fill: "none", stroke: paint.stroke, width: widthOf });
  }

  // Any other shape is drawn by the canvas — unless draw.io sets its words
  // beside it, when the canvas would cram them inside: then it is a picture
  // of its outline, its words under it.
  if (!labelOutside(style) || !cell.label) return null;
  // Words with nothing drawn round them stay words.
  if (style.names.has("text") || (paint.fill === "none" && paint.stroke === "none"))
    return null;
  const actor = shape === "umlactor" || shape === "actor" || style.names.has("umlactor");
  return shapePicture(actor ? "actor" : outlineOf(mapShape(style, cell.geometry)), w, h, {
    fill: paint.fill,
    stroke: paint.stroke,
    width: widthOf,
  });
}

/** The outline a canvas shape is drawn with in a picture. */
function outlineOf(shape: Shape): Outline {
  return shape === "circle" || shape === "stadium"
    ? "ellipse"
    : shape === "doublecircle"
      ? "double"
      : shape === "diamond"
        ? "diamond"
        : shape === "round"
          ? "round"
          : "box";
}

/* ---------- the conversion ---------- */

/**
 * draw.io's groups dissolved, their shapes moved up to where the group was.
 *
 * A draw.io group (`style="group"`, no label) is not a thing on the page: it
 * is what selecting several shapes and pressing Ctrl+G leaves behind, so they
 * move together. Read as a container it became a subgraph titled with its own
 * id — `g1`, `g10` — wrapped round the panel that really was the box, and the
 * picture gained a frame for every group the author ever made.
 *
 * So each one goes, and what it held takes its place: geometry, corners and
 * loose ends shifted by the group's offset, since they were all measured from
 * it. A connection tied to a group is tied instead to the biggest shape the
 * group held, which is the panel the group was made round.
 */
/** Whether a cell is an icon: a stencil or a picture, drawn as one thing. */
function isIconCell(c: RawCell): boolean {
  if (!c.vertex) return false;
  const style = parseStyle(c.style);
  // A stencil or a picture, but not a container: a vendor group or a VPC
  // holds its services on purpose.
  const picture =
    stencilName(style) !== null || (style.of.shape ?? "").toLowerCase() === "image";
  return picture && !style.names.has("group") && style.of.container !== "1";
}

/**
 * Shapes laid on an icon, moved out from it to stand where they stood.
 *
 * draw.io lets any shape hold others, and an icon often does: the Windows
 * logo on a laptop's screen is the laptop's child. A shape holding another
 * becomes a container here, and a container is a box with a title strip —
 * so every laptop in a home office was an empty rounded box with a logo in
 * its corner. An icon is a picture, not a box: what it holds is set beside
 * it, in the page's frame, on top of it.
 */
function unnestFromIcons(cells: RawCell[]): RawCell[] {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const isIcon = (c: RawCell | undefined) => !!c && !!c.geometry && isIconCell(c);
  if (!cells.some((c) => isIcon(byId.get(c.parent)))) return cells;
  return cells.map((c) => {
    const icon = byId.get(c.parent);
    if (!c.vertex || !c.geometry || !isIcon(icon)) return c;
    return {
      ...c,
      parent: icon!.parent,
      geometry: {
        ...c.geometry,
        x: c.geometry.x + icon!.geometry!.x,
        y: c.geometry.y + icon!.geometry!.y,
      },
    };
  });
}

function dissolveGroups(cells: RawCell[]): RawCell[] {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const invisible = (c: RawCell | undefined): boolean =>
    !!c && c.vertex && !c.label && parseStyle(c.style).names.has("group");
  if (!cells.some(invisible)) return cells;

  /** Climb out of every dissolved group, adding up where each one stood. */
  const lifted = (cell: RawCell) => {
    let parent = cell.parent;
    let dx = 0;
    let dy = 0;
    for (let guard = 0; guard < 64; guard++) {
      const group = byId.get(parent);
      if (!group || !invisible(group)) break;
      dx += group.geometry?.x ?? 0;
      dy += group.geometry?.y ?? 0;
      parent = group.parent;
    }
    return { parent, dx, dy };
  };
  const shift = (p: { x: number; y: number }, dx: number, dy: number) => ({
    x: p.x + dx,
    y: p.y + dy,
  });

  // Each group's stand-in, for connections tied to it: its biggest shape,
  // looked for through any groups nested inside it.
  const area = (c: RawCell) => (c.geometry ? c.geometry.w * c.geometry.h : 0);
  const standIn = (group: RawCell): string | undefined => {
    let best: RawCell | undefined;
    for (const c of cells) {
      if (!c.vertex || invisible(c)) continue;
      let at = byId.get(c.parent);
      for (let guard = 0; at && invisible(at) && guard < 64; guard++) {
        if (at === group) {
          if (!best || area(c) > area(best)) best = c;
          break;
        }
        at = byId.get(at.parent);
      }
    }
    return best?.id;
  };
  const stand = new Map<string, string | undefined>();
  const tied = (id: string) => {
    const cell = byId.get(id);
    if (!cell || !invisible(cell)) return id;
    if (!stand.has(id)) stand.set(id, standIn(cell));
    return stand.get(id) ?? "";
  };

  return cells
    .filter((c) => !invisible(c))
    .map((c) => {
      const { parent, dx, dy } = lifted(c);
      return {
        ...c,
        parent,
        geometry:
          c.geometry && c.vertex ? { ...c.geometry, ...shift(c.geometry, dx, dy) } : c.geometry,
        points: c.points.map((p) => shift(p, dx, dy)),
        loose: {
          ...(c.loose.source ? { source: shift(c.loose.source, dx, dy) } : {}),
          ...(c.loose.target ? { target: shift(c.loose.target, dx, dy) } : {}),
        },
        source: c.source ? tied(c.source) : c.source,
        target: c.target ? tied(c.target) : c.target,
      };
    });
}

/** How far words are kept from the edge of the space they are fitted to. */
const EDGE_CLEARANCE = 4;

/** The width of the line a zone's frame is drawn with: `.group-node`'s border. */
const FRAME_INSET = 2;

/** How far outside a box the corner standing for a pinned end is put. */
const PORT_STUB = 20;

/** Where draw.io keeps its own picture library, to fetch from. */
const DRAWIO_IMAGES = "https://raw.githubusercontent.com/jgraph/drawio/dev/src/main/webapp/";

/**
 * The picture a cell is drawn as, as a URL a browser can load — or null for
 * a cell that is not a picture.
 *
 * Three spellings come out of draw.io. A picture pasted in is a data URL,
 * written without the `;base64` it needs (draw.io's own reader assumes it),
 * so that is put back. One taken from draw.io's libraries is a path inside
 * draw.io, `img/lib/azure2/…`, which is fetched from draw.io's repository.
 * Anything else is a URL already. The Azure, AWS and GCP icons in most cloud
 * drawings are the first kind, so the picture travels inside the file just as
 * it did in the drawing it came from.
 */
function pictureOf(rawStyle: string): string | null {
  const style = parseStyle(rawStyle);
  if (!style.names.has("image") && style.of.shape !== "image") return null;
  // Read from the raw string: a data URL can hold a `;` of its own
  // (`data:image/png;base64,…`), which the style split cuts in two.
  const m = /(?:^|;)image=(data:[^,;]*(?:;base64)?,[^;]*|[^;]+)/.exec(rawStyle);
  const src = m?.[1].trim();
  if (!src) return null;
  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    const head = src.slice(0, comma);
    const body = src.slice(comma + 1);
    if (!head.includes(";base64") && /^[A-Za-z0-9+/=]+$/.test(body)) {
      return `${head};base64,${body}`;
    }
    return src;
  }
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("img/")) return DRAWIO_IMAGES + src;
  return null;
}

/** The canvas's own type size for a node's words, and the least it is taken down to. */
const LABEL_PX = 12;
const SMALLEST_PX = 7;

/**
 * The type size at which words fit a space, a half-point at a time down from
 * the canvas's own, or `null` when they fit as they are.
 *
 * draw.io's text runs a little narrower than the canvas's, and its boxes are
 * drawn to fit its text: so a caption that sat inside its box there wrapped
 * onto one more line here and ran over the border — "(AKS-managed)" hung
 * below the panel it labels. Making the box bigger moves everything round it;
 * making the words smaller, which is what draw.io itself does with a caption
 * that will not fit, moves nothing.
 *
 * `fits` is asked of each size in turn, with the font to measure in.
 */
function fittingSize(
  fits: (font: ReturnType<typeof face>) => boolean,
  from = LABEL_PX,
  weight?: number,
): number | null {
  if (fits(face(from, weight))) return from === LABEL_PX ? null : from;
  for (let px = from - 0.5; px >= SMALLEST_PX; px -= 0.5) {
    if (fits(face(px, weight))) return px;
  }
  return SMALLEST_PX;
}

/**
 * Declarations in order, a later one for the same property replacing an
 * earlier: a colour read from the label's HTML over the style's own.
 */
function lastWins(decls: string[]): string[] {
  const at = new Map<string, number>();
  decls.forEach((d, i) => at.set(d.slice(0, d.indexOf(":")), i));
  return decls.filter((d, i) => at.get(d.slice(0, d.indexOf(":"))) === i);
}

/**
 * The block these words make wrapped at `width`, or `null` when a word is
 * wider than that on its own: the canvas breaks such a word mid-word, which
 * is worse than a smaller size. A hyphen is somewhere the browser may break,
 * so "kube-controller-manager" is three words here, not one.
 */
function wrappedBlock(label: string, font: ReturnType<typeof face>, width: number) {
  const metrics = textMetrics();
  let wide = 0;
  let tall = 0;
  for (const line of labelLines(label)) {
    for (const word of line.split(/\s+|(?<=-)/).filter(Boolean)) {
      if (metrics.measure(word, font).width > width) return null;
    }
    // Wrapped where the browser would wrap, hyphens included.
    const rows = line.trim()
      ? wrapText(line.replace(/-(?=\S)/g, "- "), font, width, metrics)
      : [""];
    for (const row of rows) {
      wide = Math.max(wide, metrics.measure(row.replace(/- /g, "-"), font).width);
    }
    tall += rows.length * metrics.measure("M", font).height;
  }
  return { wide, tall };
}

/**
 * The stencils a page of a draw.io file names, for `loadStencils` to fetch
 * before it is converted. Throws as `drawioToMermaid` does on a file that is
 * not one.
 */
export function drawioStencilNames(xml: string, which = 0): Set<string> {
  const doc = parseXml(xml);
  const diagrams = [...doc.querySelectorAll("diagram")];
  const page = which >= 0 && which < diagrams.length ? which : 0;
  const model = diagrams.length
    ? pageModel(diagrams[page])
    : (doc.querySelector("mxGraphModel") ?? null);
  if (!model) return new Set();
  return stencilNames(readCells(model).map((c) => c.style));
}

/**
 * Read a draw.io file. Throws when the file is not one, or is unreadable.
 *
 * `stencils` draws the shapes that come from draw.io's libraries; without it
 * they are drawn as their outlines.
 */
export function drawioToMermaid(
  xml: string,
  as?: DrawioAs,
  which = 0,
  stencils: StencilLookup = () => undefined,
): DrawioImport {
  const doc = parseXml(xml);
  const diagrams = [...doc.querySelectorAll("diagram")];
  const pages = diagrams.map((d, i) => d.getAttribute("name") || `Page ${i + 1}`);
  // The page asked for, when there is one: a file of several pages is often
  // an overview and its details, and the first is not always the one wanted.
  const page = which >= 0 && which < diagrams.length ? which : 0;

  const model = diagrams.length
    ? pageModel(diagrams[page])
    : (doc.querySelector("mxGraphModel") ?? null);
  if (!model) throw new Error("this file holds no diagram");

  const cells = unnestFromIcons(dissolveGroups(readCells(model)));
  const byId = new Map(cells.map((c) => [c.id, c]));

  // A shape parented to an edge *is* one of its labels, not a node — which is
  // where draw.io puts most of them. Its place along the edge is a fraction
  // from -1 at the source to 1 at the target, and the ones at an end are
  // that end's: a UML association's "0..1" and "1". Each of those used to
  // come out as a node of its own, adrift where the arithmetic left it, the
  // "1" a box in the corner of the class diagram. Mermaid has one label to a
  // connection, so they join it, in the order they stand.
  const onEdge = (cell: RawCell) => cell.vertex && !!byId.get(cell.parent)?.edge;
  const edgeParts = new Map<string, { from: string[]; mid: string[]; to: string[] }>();
  for (const cell of cells) {
    if (!onEdge(cell) || !cell.label) continue;
    const parts = edgeParts.get(cell.parent) ?? { from: [], mid: [], to: [] };
    const along = cell.geometry?.x ?? 0;
    (along <= -0.9 ? parts.from : along >= 0.9 ? parts.to : parts.mid).push(cell.label);
    edgeParts.set(cell.parent, parts);
  }
  /** An edge's whole label, read from its source to its target or back. */
  const labelOf = (edge: RawCell, backwards = false) => {
    const parts = edgeParts.get(edge.id);
    const mid = edge.label || parts?.mid.join(" ") || "";
    const order = [parts?.from.join(" "), mid, parts?.to.join(" ")];
    return (backwards ? order.reverse() : order).filter(Boolean).join(" · ");
  };

  // Layers are cells parented to the model root. They carry nothing Mermaid
  // can express, so their children are treated as top-level.
  const layers = new Set(cells.filter((c) => !c.vertex && !c.edge).map((c) => c.id));
  const hasVertexChild = new Set(
    cells.filter((c) => c.vertex && byId.get(c.parent)?.vertex).map((c) => c.parent),
  );

  const isContainer = (cell: RawCell): boolean => {
    if (!cell.vertex) return false;
    const style = parseStyle(cell.style);
    return (
      hasVertexChild.has(cell.id) ||
      style.names.has("group") ||
      style.names.has("swimlane") ||
      style.of.container === "1"
    );
  };

  // A cloud drawing is read as `architecture-beta` instead, unless the reader
  // has asked for a flowchart: its stencils carry icons, and a flowchart has
  // nowhere to put them.
  // Read as `architecture-beta` only when asked. It used to be chosen for any
  // drawing made mostly of cloud stencils, for the sake of their icons — and
  // it lays the services out afresh, so it lost every container, caption and
  // position the drawing had. Checked against thirty-four real files, every
  // cloud and network drawing among them came out closer to the original as
  // a flowchart, which keeps all three and draws each stencil as a picture.
  // The import dialog still offers architecture for anyone who wants it.
  if (as === "architecture") {
    const centreOf = (cell: RawCell) => {
      if (!cell.geometry) return null;
      // Geometry is parent-relative, so walk up to get one frame of reference.
      let x = cell.geometry.x + cell.geometry.w / 2;
      let y = cell.geometry.y + cell.geometry.h / 2;
      let at = byId.get(cell.parent);
      for (let guard = 0; at && guard < 64; guard++) {
        if (at.geometry) {
          x += at.geometry.x;
          y += at.geometry.y;
        }
        at = byId.get(at.parent);
      }
      return { x, y };
    };

    const result = buildArchitecture(
      cells
        .filter((c) => c.vertex && !onEdge(c))
        .map((c) => ({
          id: c.id,
          label: c.label,
          style: c.style,
          centre: centreOf(c),
          box: c.geometry ? { ...c.geometry } : null,
          parent: byId.get(c.parent) && !layers.has(c.parent) ? c.parent : null,
          container: isContainer(c),
        })),
      cells
        .filter((c) => c.edge)
        .map((c) => {
          const style = parseStyle(c.style);
          return {
            source: c.source,
            target: c.target,
            label: labelOf(c),
            intoSource: (style.of.startArrow ?? "none").toLowerCase() !== "none",
            intoTarget: (style.of.endArrow ?? "classic").toLowerCase() !== "none",
          };
        }),
    );
    return { ...result, pages, page };
  }

  const nextId = idFactory();
  const idOf = new Map<string, string>();
  const nodes: AnyNode[] = [];
  const positions: PositionMap = {};
  let dropped = 0;

  // Zones drawn round other shapes rather than holding them. A trust
  // boundary, a VPC, a "backend" box: in draw.io these are very often a plain
  // rectangle with no fill laid over the nodes it encloses, not a container
  // the nodes belong to. Read as a node, one became a giant box with its
  // title in the middle — and an obstacle every connection starting inside
  // it was walled in by. So a box that wholly encloses other shapes beside it
  // — at the top level or within one container — is a group, and each shape
  // belongs to the smallest zone it lies in.
  const frame = (cell: RawCell) => (layers.has(cell.parent) ? "" : cell.parent);
  const placed = cells.filter(
    (c) => c.vertex && c.geometry && !onEdge(c) && !pictureOf(c.style),
  );
  const encloses = (outer: RawCell, inner: RawCell): boolean => {
    const a = outer.geometry!;
    const b = inner.geometry!;
    return (
      outer !== inner &&
      frame(outer) === frame(inner) &&
      a.w * a.h > b.w * b.h &&
      b.x >= a.x - 1 &&
      b.y >= a.y - 1 &&
      b.x + b.w <= a.x + a.w + 1 &&
      b.y + b.h <= a.y + a.h + 1
    );
  };
  const unfilled = (cell: RawCell) => {
    const fill = parseStyle(cell.style).of.fillColor?.toLowerCase();
    return fill === "none" || fill === "transparent";
  };
  // A filled panel is a zone too once it holds two shapes or more — a
  // coloured background, a swimlane drawn by hand. Holding one, it is far more
  // often a box with a tag on its corner, which is a node and stays one.
  // Pictures are placed in zones too, though they are never one themselves.
  const zoned = cells.filter((c) => c.vertex && c.geometry && !onEdge(c));
  const zones = placed.filter((c) => {
    if (isContainer(c) || parseStyle(c.style).names.has("text")) return false;
    // Only a box is a zone. A circle with words laid over it is a circle —
    // the three of a Venn diagram, each with its words on it — and as a
    // zone it was squared off into a rectangle, which a container always is.
    const outline = mapShape(parseStyle(c.style), c.geometry);
    if (outline !== "square" && outline !== "round") return false;
    // Pictures count among what a panel holds — an icon and its caption in a
    // box is a panel round two things.
    const held = zoned.filter((o) => encloses(c, o)).length;
    // A drawn shape — a stencil, a picture — holding one thing is that shape
    // with something laid on it: a laptop with a logo on its screen, which as
    // a zone was an empty box round the logo. Holding several, it is the
    // frame round them, as a cloud provider's group is.
    if (isIconCell(c)) return held >= 2;
    return unfilled(c) ? held >= 1 : held >= 2;
  });
  const zoneIds = new Set(zones.map((z) => z.id));
  /** The smallest zone each shape lies wholly inside. */
  const zoneOf = new Map<string, RawCell>();
  for (const cell of zoned) {
    let best: RawCell | undefined;
    for (const zone of zones) {
      if (!encloses(zone, cell)) continue;
      const area = zone.geometry!.w * zone.geometry!.h;
      if (!best || area < best.geometry!.w * best.geometry!.h) best = zone;
    }
    if (best) zoneOf.set(cell.id, best);
  }
  const isGroupCell = (cell: RawCell) => isContainer(cell) || zoneIds.has(cell.id);

  /**
   * The colour a shape stands on: the fill of the nearest zone or container
   * round it that has one, or `null` for the page.
   */
  const surfaceOf = (cell: RawCell): string | null => {
    let at: RawCell | undefined = cell;
    for (let guard = 0; at && guard < 64; guard++) {
      const parent = byId.get(at.parent);
      const holder: RawCell | undefined =
        zoneOf.get(at.id) ??
        (parent && !layers.has(parent.id) && isContainer(parent) ? parent : undefined);
      if (!holder) return null;
      const fill = panelFill(parseStyle(holder.style));
      if (fill) return fill;
      at = holder;
    }
    return null;
  };

  const parentIdOf = (cell: RawCell): string | undefined => {
    const zone = zoneOf.get(cell.id);
    if (zone) return idOf.get(zone.id);
    const parent = byId.get(cell.parent);
    if (!parent || layers.has(parent.id) || !isContainer(parent)) return undefined;
    return idOf.get(parent.id);
  };

  /** Where a shape goes: its own geometry, made relative to a zone it is in. */
  const placeOf = (cell: RawCell, w: number, h: number) => {
    const g = cell.geometry;
    const zone = zoneOf.get(cell.id)?.geometry;
    const x = (g?.x ?? 0) - (zone?.x ?? 0);
    const y = (g?.y ?? 0) - (zone?.y ?? 0);
    return { x, y, w, h };
  };

  /**
   * The box that holds a shape — its zone, or its container — in the frame
   * the shape's own geometry is in; `null` for one standing free.
   */
  const holderOf = (cell: RawCell): RawCell["geometry"] => {
    const zone = zoneOf.get(cell.id)?.geometry;
    if (zone) return zone;
    const parent = byId.get(cell.parent);
    if (parent && !layers.has(parent.id) && isContainer(parent) && parent.geometry) {
      // Geometry inside a container is measured from the container's corner.
      return { x: 0, y: 0, w: parent.geometry.w, h: parent.geometry.h };
    }
    return null;
  };

  // Groups first, and outermost first, so a child always finds its parent
  // already named.
  const depth = (cell: RawCell): number => {
    let n = 0;
    let at = byId.get(cell.parent);
    while (at && n < 64) {
      n++;
      at = byId.get(at.parent);
    }
    return n;
  };

  // Zones nest by size, not by the file's hierarchy, so among siblings the
  // larger goes first: an enclosing zone is always the bigger of two.
  const area = (cell: RawCell) => (cell.geometry ? cell.geometry.w * cell.geometry.h : 0);
  const groupCells = cells
    .filter(isGroupCell)
    .sort((a, b) => depth(a) - depth(b) || area(b) - area(a));
  /** Containers whose words draw.io sets beside them; see `sideLabel`. */
  const besideGroups: Array<{ cell: RawCell; style: Style; id: string; parentId?: string }> =
    [];
  for (const drawn of groupCells) {
    const sideStyle = parseStyle(drawn.style);
    // Words set anywhere but along its top go where draw.io set them; along
    // the top they are the container's title, in the strip it has for one.
    const side =
      !!drawn.label &&
      !!drawn.geometry &&
      !sideStyle.names.has("swimlane") &&
      ((sideStyle.of.labelPosition ?? "center") !== "center" ||
        (sideStyle.of.verticalLabelPosition ?? "middle") !== "middle" ||
        sideStyle.of.verticalAlign === "bottom");
    const cell = side ? { ...drawn, label: "", html: "" } : drawn;
    const id = nextId(drawn.label, `g${nodes.length + 1}`);
    idOf.set(cell.id, id);
    const parentId = parentIdOf(cell);
    // Its own colours, and its dash if it had one: every panel was the same
    // faint tint, so "Cluster nodes" and its node pools read as one surface,
    // and a card stacked on another showed the one behind through it.
    // draw.io fills a panel white unless told otherwise, and the words in it
    // are drawn to be read on that.
    const look = parseStyle(cell.style);
    // A draw.io group is never drawn, named or not — it is what Ctrl+G left
    // round some shapes. Kept for its name, it was painted the white of a
    // panel with no colour of its own: a white box round a house, and round
    // every laptop in a home office.
    const unseen = look.names.has("group") && !look.of.fillColor && !look.of.strokeColor;
    const fill = unseen ? null : panelFill(look);
    const styles = unseen
      ? ["fill:transparent", "stroke:none"]
      : [
          ...colourStyles(look).filter((d) => !d.startsWith("fill:")),
          ...(fill ? [`fill:${fill}`] : look.of.fillColor ? ["fill:transparent"] : []),
          ...(look.of.dashed === "1" ? [`stroke-dasharray:${dashOf(look)}`] : []),
        ];
    if (fill && !styles.some((d) => d.startsWith("color:"))) {
      const readable = readableOn(fill);
      if (readable) styles.push(`color:${readable}`);
    }
    // Its title set as draw.io set it, along the strip a container's title
    // has: centred unless the drawing said otherwise, as draw.io centres it.
    // A UML class's name sat in its corner, where nothing had put it.
    const titled = typeOf(look, cell.html);
    styles.push(...typeStyles({ ...titled, align: undefined, valign: undefined }));
    styles.push(`text-align:${titled.align ?? "center"}`);
    if (titled.size && titled.size !== LABEL_PX) styles.push(`font-size:${titled.size}px`);
    styles.splice(0, styles.length, ...lastWins(styles));
    const group: GroupNode = {
      id,
      type: "group",
      position: { x: 0, y: 0 },
      // A container with no title has none. Titled with its id, every frame
      // drawn without words read `g1`, `g10`.
      data: { label: cell.label, subgraphId: id, ...(styles.length ? { styles } : {}) },
      style: { width: cell.geometry?.w ?? 320, height: cell.geometry?.h ?? 220 },
      ...(parentId ? { parentId } : {}),
    };
    nodes.push(group);
    positions[id] = placeOf(cell, cell.geometry?.w ?? 320, cell.geometry?.h ?? 220);
    if (side) besideGroups.push({ cell: drawn, style: sideStyle, id, parentId });
  }

  /**
   * A shape's words where draw.io sets them, as a node of words alone.
   *
   * draw.io works out a label's space from the shape: the shape's own box, or
   * the one beside it that `labelPosition` and `verticalLabelPosition` name,
   * shrunk by `spacing` and its four sides — which may be negative, and pull
   * the words out over the edge. `align` and `verticalAlign` then place the
   * words in that space. A rack's server names sit to its right; a home
   * network's room names hang under their rooms; a Kubernetes namespace is
   * named in its bottom corner. A node of words given exactly that space, and
   * the same alignment, lands where draw.io drew them.
   */
  const sideLabel = (cell: RawCell, style: Style, of: string, parentId?: string) => {
    const g = cell.geometry!;
    const n = (key: string, otherwise = 0) => {
      const v = Number(style.of[key]);
      return Number.isFinite(v) ? v : otherwise;
    };
    const lp = style.of.labelPosition;
    const vlp = style.of.verticalLabelPosition;
    const at = placeOf(cell, g.w, g.h);
    const spacing = n("spacing", 2);
    const left =
      (lp === "left" ? at.x - g.w : lp === "right" ? at.x + g.w : at.x) +
      spacing +
      n("spacingLeft");
    const top =
      (vlp === "top" ? at.y - g.h : vlp === "bottom" ? at.y + g.h : at.y) +
      spacing +
      n("spacingTop");
    const w = Math.max(8, g.w - 2 * spacing - n("spacingLeft") - n("spacingRight"));
    const h = Math.max(8, g.h - 2 * spacing - n("spacingTop") - n("spacingBottom"));
    const type = typeOf(style, cell.html);
    const size = type.size ?? LABEL_PX;
    const align =
      style.of.align === "left" || style.of.align === "right" ? style.of.align : undefined;
    const valign =
      style.of.verticalAlign === "top" || style.of.verticalAlign === "bottom"
        ? style.of.verticalAlign
        : undefined;
    // draw.io wraps only when told to; otherwise a line is as long as it is,
    // centred on the space or run from the side it is aligned to.
    const wraps = style.of.whiteSpace === "wrap";
    const id = nextId(`${cell.label} label`, `${of}_label`);
    const label: ShapeNode = {
      id,
      type: "shape",
      position: { x: 0, y: 0 },
      data: {
        label: cell.label,
        shape: "square",
        direction: "TB",
        styles: lastWins([
          "fill:transparent",
          "stroke:none",
          // Words with no colour of their own, on a panel, in one that reads
          // on it — as every other word with no box is given. Left to the
          // theme, they were pale on the pale room in the dark.
          ...(() => {
            if (cssColour(type.color)) return [];
            const surface = surfaceOf(cell);
            const readable = surface && readableOn(surface);
            return readable ? [`color:${readable}`] : [];
          })(),
          ...typeStyles({ ...type, align, valign }),
          ...(align ? [] : ["text-align:center"]),
          ...(size !== LABEL_PX ? [`font-size:${size}px`] : []),
          ...(wraps ? [] : ["white-space:nowrap"]),
        ]),
      },
      ...(parentId ? { parentId } : {}),
    };
    nodes.push(label);
    // The node is the words' own size, stood where alignment puts them in
    // that space: the space beside a wide container is as wide as the
    // container, and a node that size was an empty box reaching far off the
    // drawing, which "fit" then made room for.
    const font = face(size, type.bold ? 700 : undefined);
    const metrics = textMetrics();
    const lines = labelLines(cell.label);
    const textW = Math.ceil(Math.max(...lines.map((l) => metrics.measure(l, font).width)) + 8);
    const textH = Math.ceil(lines.length * metrics.measure("M", font).height + 4);
    // Words that wrap keep the whole width only when they need it.
    const bw = Math.min(w, textW);
    const bh = Math.min(h, textH);
    positions[id] = {
      x: align === "left" ? left : align === "right" ? left + w - bw : left + (w - bw) / 2,
      y: valign === "top" ? top : valign === "bottom" ? top + h - bh : top + (h - bh) / 2,
      w: wraps ? bw : textW,
      h: wraps && textW > w ? h : bh,
    };
  };

  // Placed now that `sideLabel` exists; after their containers, before the
  // shapes, so a word never lands under a box drawn later.
  for (const g of besideGroups) sideLabel(g.cell, g.style, g.id, g.parentId);

  for (const drawn of cells) {
    if (!drawn.vertex || isGroupCell(drawn)) continue;
    const style = parseStyle(drawn.style);
    // Edge labels were harvested above; they are not nodes.
    if (onEdge(drawn)) continue;
    // Words draw.io sets to the left or right of a shape are not in it: a
    // rack's servers are fifteen units tall with their names beside them.
    // Inside, or hung underneath as a picture's caption is, each name lay on
    // the server below. So the shape goes in bare and its words become words
    // of their own, standing where draw.io stood them.
    // So are words set over a picture: the numbered badges in a reference
    // architecture are a black disc with the number in white across it, and
    // hung under the disc as a caption the number was white on the page.
    const side =
      !!drawn.label &&
      !!drawn.geometry &&
      (/^(left|right)$/.test(style.of.labelPosition ?? "") ||
        (!!pictureOf(drawn.style) && style.of.verticalLabelPosition === "middle"));
    const cell = side ? { ...drawn, label: "", html: "" } : drawn;
    if (!cell.label && !cell.geometry) {
      dropped++;
      continue;
    }

    const id = nextId(drawn.label, `n${nodes.length + 1}`);
    idOf.set(cell.id, id);
    const parentId = parentIdOf(cell);
    const picture = pictureOf(cell.style) ?? drawnPicture(cell, style, stencils);
    // A picture is drawn with no box round it, its label above or below as
    // in draw.io — inside a box its own size, the words had a few pixels and
    // were cut to "Gateway (to On-".
    // Its words in their own colour only. A colour worked out to read on the
    // fill is no use here: a picture's fill is its ink, not what its words
    // stand on, and a black icon's caption came out white on a white page.
    const words = cssColour(style.of.fontColor);
    const styles = picture
      ? ["fill:none", "stroke:none", ...(words ? [`color:${words}`] : [])]
      : colourStyles(style);
    // Words with no box of their own, and a picture's caption, are read on
    // the panel under them: in the theme's colour, the dark theme's pale
    // text vanished on draw.io's white and pale-blue panels.
    const boxless = picture || styles.some((d) => /^fill:(none|transparent)$/.test(d));
    const type = typeOf(style, cell.html);
    if (boxless && !styles.some((d) => d.startsWith("color:")) && !cssColour(type.color)) {
      const surface = surfaceOf(cell);
      const readable = surface && readableOn(surface);
      if (readable) styles.push(`color:${readable}`);
    }
    // Set as draw.io set the words. A picture's caption is set under it, so
    // its alignment is the picture's business.
    styles.push(
      ...typeStyles(picture ? { ...type, align: undefined, valign: undefined } : type),
    );
    styles.splice(0, styles.length, ...lastWins(styles));
    const weight = type.bold ? 700 : undefined;
    const typeSize = type.size ?? LABEL_PX;
    // A heading set larger than the canvas's own words, and not told to
    // wrap, keeps to its line as draw.io keeps it: wrapped to its narrow box,
    // "IoT Enabled House" came out a few letters a line.
    const heading = typeSize > LABEL_PX && style.of.whiteSpace !== "wrap";
    if (heading) styles.push("white-space:nowrap");
    // Words fitted inside the box they were drawn in, with the padding the
    // canvas gives them: almost none for words with no box and for a small
    // tag, the label's usual padding for anything else.
    // Words draw.io puts beside the shape — under a stick figure — are not
    // in its box there, and are not fitted to it.
    const outside = labelOutside(style);
    let nudge = { x: 0, y: 0 };
    if (!picture && !outside && !heading && cell.label && cell.geometry) {
      const { w, h } = cell.geometry;
      const bare =
        styles.includes("stroke:none") &&
        styles.some((d) => /^fill:(none|transparent)$/.test(d));
      const tight = bare || w < 64 || h < 32;
      const [padX, padY] = tight ? [4, 0] : [BOXES.shape.padX, BOXES.shape.padY];
      // Words with no box of their own are drawn whole, spilling out of the
      // space they were given if they must, so what they have to keep inside
      // is the zone or container they stand in, within its frame: fitted to
      // their own few pixels, the subnets' titles came out unreadably small,
      // and "Internal Load Balancer" still ran from one side of its subnet to
      // the other. Words that would fit but were drawn across the frame —
      // a subnet's title along its top, "Node pool" in its zone's corner —
      // are moved in instead, as long as that does not put them on a shape
      // beside them.
      const holder = bare ? holderOf(cell) : null;
      const { x, y } = cell.geometry;
      const inset = FRAME_INSET + EDGE_CLEARANCE;
      const neighbours = holder
        ? cells
            .filter(
              (c) =>
                c !== cell &&
                c.vertex &&
                c.geometry &&
                !isGroupCell(c) &&
                c.parent === cell.parent &&
                zoneOf.get(c.id) === zoneOf.get(cell.id),
            )
            .map((c) => c.geometry!)
        : [];
      /** How far words over `a` lie over `b`. */
      const overlap = (
        a: NonNullable<RawCell["geometry"]>,
        b: NonNullable<RawCell["geometry"]>,
      ) =>
        Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      /** How far a stretch from `start` has to move to lie in [from, to]. */
      const into = (start: number, size: number, from: number, to: number) =>
        Math.max(0, from - start) - Math.max(0, start + size - to);
      /** How far the words are moved at a size, or `null` when they do not fit. */
      const placed = (font: ReturnType<typeof face>) => {
        // Words with no box in a space too small for padding are set whole,
        // running past it as draw.io lets them (`.compact`): "Engine" at 22px
        // in draw.io's 40-unit space, which was made smaller and smaller to
        // fit a box nobody can see.
        if (bare && !holder && (w < COMPACT_SHAPE.width || h < COMPACT_SHAPE.height)) {
          return { x: 0, y: 0 };
        }
        const block = wrappedBlock(cell.label, font, w - padX);
        if (!block) return null;
        // Words with no box and nothing round them have no edge to keep off.
        if (!holder) return bare || block.tall <= h - padY + 0.5 ? { x: 0, y: 0 } : null;
        if (block.wide > holder.w - 2 * inset + 0.5) return null;
        if (block.tall > holder.h - 2 * inset + 0.5) return null;
        const at = {
          x: x + w / 2 - block.wide / 2,
          y: y + h / 2 - block.tall / 2,
          w: block.wide,
          h: block.tall,
        };
        const shift = {
          x: into(at.x, at.w, holder.x + inset, holder.x + holder.w - inset),
          y: into(at.y, at.h, holder.y + inset, holder.y + holder.h - inset),
        };
        const moved = { ...at, x: at.x + shift.x, y: at.y + shift.y };
        // Moved further onto a shape — "Internal Load Balancer" on three
        // lines, pushed up onto its icon — the words are made smaller instead.
        if (neighbours.some((n) => overlap(moved, n) > overlap(at, n) + 0.5)) return null;
        return shift;
      };
      const px = fittingSize((font) => placed(font) !== null, typeSize, weight);
      if (px !== null) styles.push(`font-size:${px}px`);
      nudge = placed(face(px ?? LABEL_PX, weight)) ?? { x: 0, y: 0 };
    } else if (!picture && typeSize !== LABEL_PX) {
      styles.push(`font-size:${typeSize}px`);
    }
    // draw.io's `line` is a rule, not a box: the bar between a UML class's
    // attributes and its methods, a divider in a wireframe. Drawn as the box
    // it is given, each was an empty frame eight units tall. A bar the line's
    // own thickness, in its colour, is the line.
    const rule =
      !picture && ((style.of.shape ?? "").toLowerCase() === "line" || style.names.has("line"));
    const thickness = Math.max(1, Number(style.of.strokeWidth) || 1);
    if (rule) {
      const ink = cssColour(style.of.strokeColor) ?? "#000000";
      styles.splice(0, styles.length, `fill:${ink}`, "stroke:none");
    }
    const node: ShapeNode = {
      id,
      type: "shape",
      position: { x: 0, y: 0 },
      data: {
        label: cell.label,
        shape: picture ? "square" : mapShape(style, cell.geometry),
        direction: "TB",
        ...(styles.length ? { styles } : {}),
        ...(picture
          ? {
              img: picture,
              imgPos:
                style.of.verticalLabelPosition === "top" ? ("t" as const) : ("b" as const),
              ...(cell.geometry
                ? { imgWidth: cell.geometry.w, imgHeight: cell.geometry.h }
                : {}),
            }
          : {}),
      },
      ...(parentId ? { parentId } : {}),
    };
    nodes.push(node);
    if (side) sideLabel(drawn, style, id, parentId);
    if (cell.geometry) {
      const at = placeOf(cell, cell.geometry.w, cell.geometry.h);
      if (picture) {
        // A picture's node is the size of the picture and its words together,
        // which the canvas works out; given the picture's own size it would
        // squeeze the words back inside it. And it is placed so the picture
        // lands where draw.io drew it: there the caption hangs centred under
        // the icon, however wide; here the node widens to hold it, and placed
        // by its corner the icon slid right of where it was.
        const { w, h } = cell.geometry;
        // A caption that will not fit the room its icon stands in — the zone,
        // or the container — is made smaller rather than left lying across
        // the border. Across, the room is measured from the icon's middle
        // each way, since the caption is centred on it; up or down, from the
        // icon to the side the caption hangs towards. `measureNode`'s
        // arithmetic: a 4px gap between icon and caption.
        const holder = holderOf(cell);
        if (cell.label && holder) {
          const metrics = textMetrics();
          const cx = cell.geometry.x + w / 2;
          const across =
            Math.min(cx - holder.x, holder.x + holder.w - cx) - FRAME_INSET - EDGE_CLEARANCE;
          const down =
            node.data.imgPos === "t"
              ? cell.geometry.y - holder.y
              : holder.y + holder.h - (cell.geometry.y + h);
          const px = fittingSize(
            (font) => {
              let widest = 0;
              let tall = 0;
              for (const line of labelLines(cell.label)) {
                const size = metrics.measure(line, font);
                widest = Math.max(widest, size.width);
                tall += size.height;
              }
              return widest / 2 <= across && 4 + tall <= down - FRAME_INSET - EDGE_CLEARANCE;
            },
            typeSize,
            weight,
          );
          if (px !== null) {
            node.data.styles = [...(node.data.styles ?? []), `font-size:${px}px`];
          }
        } else if (typeSize !== LABEL_PX) {
          node.data.styles = [...(node.data.styles ?? []), `font-size:${typeSize}px`];
        }
        const size = measureNode(node);
        const above = node.data.imgPos === "t";
        positions[id] = {
          x: at.x + w / 2 - size.width / 2,
          // `.shape-label.with-image`: 6px above whatever comes first.
          y: above ? at.y - (size.height - h - 6) : at.y - 6,
        };
      } else {
        positions[id] = rule
          ? // Across the middle of the box it was given, as draw.io draws it.
            { ...at, y: at.y + at.h / 2 - thickness / 2, h: thickness }
          : { ...at, x: at.x + nudge.x, y: at.y + nudge.y };
      }
    }
  }

  const edges: FlowEdge[] = [];
  const waypoints: WaypointMap = {};
  const routes: EdgeStyleMap = {};
  const ordinals = new Map<string, number>();

  /** Where a cell's frame starts on the page: the sum of its containers'. */
  const offsetOf = (cell: RawCell) => {
    let dx = 0;
    let dy = 0;
    for (let at = byId.get(cell.parent), guard = 0; at && guard < 64; guard++) {
      if (at.geometry && at.vertex) {
        dx += at.geometry.x;
        dy += at.geometry.y;
      }
      at = byId.get(at.parent);
    }
    return { dx, dy };
  };
  // Every shape that became a node or a group, as a box on the page.
  const onPage = cells
    .filter((c) => c.vertex && c.geometry && idOf.has(c.id))
    .map((c) => {
      const { dx, dy } = offsetOf(c);
      return {
        id: c.id,
        x: c.geometry!.x + dx,
        y: c.geometry!.y + dy,
        w: c.geometry!.w,
        h: c.geometry!.h,
      };
    });
  /**
   * The shape a loose end of a connection rests on: the smallest one whose
   * box holds the point, give or take a few units. draw.io lets an arrow end
   * on a container's border without being glued to it — "VNet peering"
   * between two networks is drawn that way — and Mermaid has no arrow that
   * ends on nothing, so without this it was dropped.
   *
   * An end that rests on nothing, or inside a container rather than on its
   * border, is a point: the end of a line drawn freehand. A network diagram
   * draws its bus that way, a bar with every switch's line ending on it, and
   * tied to the container round them each line was routed to the
   * container's edge, into a tangle. Such an end becomes an anchor — a node
   * of no size and no look — where the line ended.
   */
  const anchors = new Set<string>();
  const anchorAt = (x: number, y: number) => {
    const raw = `anchor:${anchors.size}`;
    const id = nextId("", `pt${anchors.size + 1}`);
    anchors.add(id);
    idOf.set(raw, id);
    onPage.push({ id: raw, x, y, w: 0, h: 0 });
    nodes.push({
      id,
      type: "shape",
      position: { x: 0, y: 0 },
      data: {
        label: "",
        shape: "square",
        direction: "TB",
        styles: ["fill:none", "stroke:none"],
      },
    });
    positions[id] = { x: Math.round(x) - 1, y: Math.round(y) - 1, w: 2, h: 2 };
    return id;
  };
  const restingOn = (cell: RawCell, p: { x: number; y: number } | undefined) => {
    if (!p) return undefined;
    const { dx, dy } = offsetOf(cell);
    const x = p.x + dx;
    const y = p.y + dy;
    const slack = 6;
    let best: (typeof onPage)[number] | undefined;
    for (const b of onPage) {
      if (
        x < b.x - slack ||
        x > b.x + b.w + slack ||
        y < b.y - slack ||
        y > b.y + b.h + slack
      ) {
        continue;
      }
      if (!best || b.w * b.h < best.w * best.h) best = b;
    }
    const holder = best && byId.get(best.id);
    const inside =
      best &&
      holder &&
      isGroupCell(holder) &&
      x > best.x + slack &&
      x < best.x + best.w - slack &&
      y > best.y + slack &&
      y < best.y + best.h - slack;
    // A bar drawn as a `line` is the bus itself: the line meets it where it was drawn to.
    const bar = holder && /(^|;)\s*(shape=)?line(;|$)/i.test(holder.style);
    if (!best || inside || bar) return anchorAt(x, y);
    return idOf.get(best.id);
  };

  for (const cell of cells) {
    if (!cell.edge) continue;
    const tiedSource = idOf.get(cell.source);
    const tiedTarget = idOf.get(cell.target);
    let source = tiedSource ?? restingOn(cell, cell.loose.source);
    let target = tiedTarget ?? restingOn(cell, cell.loose.target);
    // Mermaid has no dangling connection: an arrow has two ends or it is not
    // an arrow. One drawn to empty canvas, with nothing under either end,
    // cannot come across — nor one whose loose ends both rest on the same
    // box, which is a line drawn across it, not a loop the author tied.
    const looseLoop = source === target && (!tiedSource || !tiedTarget);
    // A loop that leaves a box at the very point it comes back in is no
    // line at all, and draw.io draws none; drawn here, the SWOT's "W" grew a
    // loop over its corner.
    const loopStyle = parseStyle(cell.style).of;
    const nowhere =
      source === target &&
      loopStyle.exitX !== undefined &&
      loopStyle.exitX === loopStyle.entryX &&
      loopStyle.exitY === loopStyle.entryY;
    if (!source || !target || looseLoop || nowhere) {
      dropped++;
      continue;
    }

    const style = parseStyle(cell.style);

    // Where the line meets each box, when the drawing says. draw.io pins an
    // end to a point of the box (`exitX`/`exitY`, `entryX`/`entryY`, as
    // fractions of it) or leaves it resting on one; Mermaid has no such
    // port, so the point becomes a corner a stub outside it — the router
    // lines the end up with the corner it starts from. Left out, "VNet
    // peered" set off from the hub's side instead of its foot, and lay along
    // the gateway's own line.
    const { dx: ox, dy: oy } = offsetOf(cell);
    const port = (
      node: string,
      x: string | undefined,
      y: string | undefined,
      loose: { x: number; y: number } | undefined,
      tied: boolean,
      stub = PORT_STUB,
      nudge: [string | undefined, string | undefined] = [undefined, undefined],
    ) => {
      // A line ends at an anchor itself, not a stub away from a face of it.
      if (anchors.has(node)) return null;
      const raw = [...idOf.entries()].find(([, v]) => v === node)?.[0];
      const box = onPage.find((b) => b.id === raw);
      if (!box) return null;
      const fx = Number(x);
      const fy = Number(y);
      const at =
        tied && Number.isFinite(fx) && Number.isFinite(fy)
          ? // The point is a fraction of the box and then a distance from
            // there (`exitDx`, `exitDy`): draw.io writes a point on a shape's
            // own outline as its corner plus so many units, and read as the
            // corner alone the line set off from the corner, with a hook.
            {
              x: box.x + fx * box.w + (Number(nudge[0]) || 0),
              y: box.y + fy * box.h + (Number(nudge[1]) || 0),
            }
          : !tied && loose
            ? { x: loose.x + ox, y: loose.y + oy }
            : null;
      if (!at) return null;
      // Out through the face it lies nearest.
      const gaps = [
        { d: Math.abs(at.x - box.x), out: { x: -1, y: 0 } },
        { d: Math.abs(at.x - (box.x + box.w)), out: { x: 1, y: 0 } },
        { d: Math.abs(at.y - box.y), out: { x: 0, y: -1 } },
        { d: Math.abs(at.y - (box.y + box.h)), out: { x: 0, y: 1 } },
      ].sort((m, n) => m.d - n.d);
      const { out } = gaps[0];
      const px = out.x !== 0 ? (out.x < 0 ? box.x : box.x + box.w) : at.x;
      const py = out.y !== 0 ? (out.y < 0 ? box.y : box.y + box.h) : at.y;
      return { x: px + out.x * stub, y: py + out.y * stub };
    };
    // An elbow connector with no ends pinned leaves and arrives along its
    // elbow: one bent up and down — an org chart's — out of the foot of the
    // box above and into the head of the one below; one bent sideways, out
    // of the side facing the other box. Left to choose, the router took
    // whichever face was nearest, and the head of an org chart sent its
    // lines out of its sides.
    const boxFor = (node: string) => {
      const raw = [...idOf.entries()].find(([, v]) => v === node)?.[0];
      return onPage.find((b) => b.id === raw);
    };
    let drop: { x: number; y: number } | null = null;
    let exit: [string | undefined, string | undefined] = [style.of.exitX, style.of.exitY];
    let entry: [string | undefined, string | undefined] = [style.of.entryX, style.of.entryY];
    const from = boxFor(source);
    const to = boxFor(target);
    //
    // Where the elbow stands is the one point such a connector keeps, and
    // each end faces it: the org chart's lower branches all run down a rail
    // to the left of the boxes, out of each parent's left side and into each
    // child's. With no point, the elbow is midway, and each end faces the
    // other box.
    if ((style.of.edgeStyle ?? "").toLowerCase() === "elbowedgestyle" && from && to) {
      const upright = style.of.elbow === "vertical";
      const bend = cell.points[0] && { x: cell.points[0].x + ox, y: cell.points[0].y + oy };
      const mid = (b: typeof from) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
      // An elbow standing across a box's own span — a parent's rail down
      // from its middle — is left from the face looking at the other box,
      // not from the side: the line comes straight out of the parent's foot.
      const side = (b: typeof from, other: typeof from): [string, string] => {
        const at = bend ?? mid(other);
        const there = mid(other);
        if (upright) {
          if (bend && at.y > b.y + 1 && at.y < b.y + b.h - 1) {
            return [there.x >= mid(b).x ? "1" : "0", "0.5"];
          }
          return ["0.5", at.y >= mid(b).y ? "1" : "0"];
        }
        if (bend && at.x > b.x + 1 && at.x < b.x + b.w - 1) {
          return ["0.5", there.y >= mid(b).y ? "1" : "0"];
        }
        return [at.x >= mid(b).x ? "1" : "0", "0.5"];
      };
      // With no point of its own and the two boxes one above the other, a
      // sideways elbow has nowhere to stand: draw.io puts it midway across
      // the stretch the boxes share, finds that inside both of them, and
      // draws no elbow at all — one straight line down, there. A laptop over
      // the bus it hangs from is drawn so, forty-seven times on one page;
      // read as leaving by the side, each line went out of its laptop's
      // flank and round to the end of the bar. The same holds turned on its
      // side for an upright elbow between two boxes level with each other.
      const span = (b: typeof from, axis: "x" | "y"): [number, number] =>
        axis === "x" ? [b.x, b.x + b.w] : [b.y, b.y + b.h];
      const across = upright ? "y" : "x";
      const lo = Math.max(span(from, across)[0], span(to, across)[0]);
      const hi = Math.min(span(from, across)[1], span(to, across)[1]);
      const free =
        !bend && exit[0] === undefined && entry[0] === undefined && tiedSource && tiedTarget;
      if (free && hi - lo > 1) {
        const at = (lo + hi) / 2;
        const frac = (b: typeof from) =>
          String((at - span(b, across)[0]) / (across === "x" ? b.w : b.h));
        const after = (b: typeof from, other: typeof from) =>
          (across === "x" ? mid(other).y >= mid(b).y : mid(other).x >= mid(b).x) ? "1" : "0";
        exit = across === "x" ? [frac(from), after(from, to)] : [after(from, to), frac(from)];
        entry = across === "x" ? [frac(to), after(to, from)] : [after(to, from), frac(to)];
        // Held by one corner midway between the two boxes, not by a pin a
        // stub out from each: the boxes are often closer than two stubs, and
        // the pins then stand past each other.
        const along = across === "x" ? "y" : "x";
        const gapLo = Math.min(span(from, along)[1], span(to, along)[1]);
        const gapHi = Math.max(span(from, along)[0], span(to, along)[0]);
        const between = (gapLo + gapHi) / 2;
        drop = across === "x" ? { x: at, y: between } : { x: between, y: at };
      }
      if (exit[0] === undefined && tiedSource) exit = side(from, to);
      if (entry[0] === undefined && tiedTarget) entry = side(to, from);
    }
    // A square-cornered connector bent through points of its own leaves its
    // box straight towards the first of them, and arrives from the last:
    // draw.io lines the end up with the point. Every device in a rack hangs
    // off its switch by a line down one shared x, and left to choose its own
    // place on the switch's face each line took a different one, so the rail
    // they share in draw.io came out as a dozen strands side by side.
    if (
      /orthogonaledgestyle/i.test(style.of.edgeStyle ?? "") &&
      cell.points.length > 0 &&
      from &&
      to
    ) {
      const towards = (
        b: typeof from,
        p: { x: number; y: number },
      ): [string, string] | null => {
        if (p.x > b.x && p.x < b.x + b.w) {
          return [String((p.x - b.x) / b.w), p.y >= b.y + b.h / 2 ? "1" : "0"];
        }
        if (p.y > b.y && p.y < b.y + b.h) {
          return [p.x >= b.x + b.w / 2 ? "1" : "0", String((p.y - b.y) / b.h)];
        }
        return null;
      };
      const first = { x: cell.points[0].x + ox, y: cell.points[0].y + oy };
      const lastPoint = cell.points[cell.points.length - 1];
      const last = { x: lastPoint.x + ox, y: lastPoint.y + oy };
      if (exit[0] === undefined && tiedSource) exit = towards(from, first) ?? exit;
      if (entry[0] === undefined && tiedTarget) entry = towards(to, last) ?? entry;
    }
    // How the line is drawn between its corners. draw.io draws a connection
    // with no `edgeStyle` straight, through whatever points it was given,
    // and one marked `curved` as a curve; only its connector styles turn
    // square corners. Squared off, every straight line in a dependency graph
    // or a mind map ran in steps beside the others it used to cross, and the
    // drawing became a tangle.
    const kind = (style.of.edgeStyle ?? "").toLowerCase();
    // A line to a point drawn freehand is drawn straight to it, as draw.io
    // draws a bus drop; squared off and fanned out, each became a hook.
    const anchored = anchors.has(source) || anchors.has(target);
    // `curved` bends a line only through points of its own; with none,
    // draw.io draws it straight from one end to the other.
    const route: RouteStyle =
      style.of.curved === "1" && cell.points.length > 0
        ? "curved"
        : // An isometric connector runs on the slant from one box to the
          // other, with a kink in it; squared off, the mesh of a WAN drawn
          // with it became a maze of right angles round every router.
          anchored || !kind || kind === "none" || kind === "isometricedgestyle"
          ? "straight"
          : "orthogonal";
    const direct = route !== "orthogonal";
    // A direct line starts on the face itself, where draw.io pinned it; the
    // step out of the face is for square corners.
    const reach = direct ? 0 : PORT_STUB;
    let leaving = port(source, exit[0], exit[1], cell.loose.source, !!tiedSource, reach, [
      style.of.exitDx,
      style.of.exitDy,
    ]);
    let arriving = port(target, entry[0], entry[1], cell.loose.target, !!tiedTarget, reach, [
      style.of.entryDx,
      style.of.entryDy,
    ]);
    // A straight line leaves a box level with where it is going when it can:
    // draw.io meets the box square on when the far end lies across from one
    // of its faces. A sequence diagram's messages are drawn so, each a level
    // line from one activation bar to the next; left to the router, each set
    // off from the middle of a bar six hundred units tall, and crossed the
    // diagram on a slant.
    // Only between two boxes with no bend of their own: a line through
    // bends already heads for the first of them.
    if (direct && cell.points.length === 0) {
      const across = (node: string, toward: { x: number; y: number } | null) => {
        const box = boxFor(node);
        if (!box || !toward) return null;
        if (toward.y > box.y && toward.y < box.y + box.h) {
          const right = toward.x > box.x + box.w;
          return { x: right ? box.x + box.w : box.x, y: toward.y };
        }
        if (toward.x > box.x && toward.x < box.x + box.w) {
          const below = toward.y > box.y + box.h;
          return { x: toward.x, y: below ? box.y + box.h : box.y };
        }
        return null;
      };
      if (!leaving && tiedSource) leaving = across(source, arriving);
      if (!arriving && tiedTarget) arriving = across(target, leaving);
    }
    // An elbow connector's one point fixes only where its elbow stands —
    // across for a sideways elbow, down for an upright one — and draw.io
    // ignores the other coordinate, which is often far off the page. Taken
    // as a corner, the line went out to it and back.
    const elbowed =
      (style.of.edgeStyle ?? "").toLowerCase() === "elbowedgestyle" && cell.points.length === 1;
    const bends =
      elbowed && leaving && arriving
        ? style.of.elbow === "vertical"
          ? [
              { x: leaving.x, y: cell.points[0].y + oy },
              { x: arriving.x, y: cell.points[0].y + oy },
            ]
          : [
              { x: cell.points[0].x + ox, y: leaving.y },
              { x: cell.points[0].x + ox, y: arriving.y },
            ]
        : cell.points.map((q) => ({ x: q.x + ox, y: q.y + oy }));
    let corners = drop
      ? [drop]
      : [...(leaving ? [leaving] : []), ...bends, ...(arriving ? [arriving] : [])];

    // An arrow drawn with its head at the start only. Mermaid draws a head at
    // the end or at both, so the connection is turned round: read as it was,
    // its one head was dropped and it pointed nowhere.
    const headless = (v: string | undefined) => (v ?? "").toLowerCase() === "none";
    const backwards = headless(style.of.endArrow) && !headless(style.of.startArrow ?? "none");
    if (backwards) {
      [source, target] = [target, source];
      corners = corners.reverse();
    }
    const stroke: EdgeStroke =
      style.of.dashed === "1"
        ? "dotted"
        : Number(style.of.strokeWidth ?? 1) >= 3
          ? "thick"
          : "normal";
    const end = (
      (backwards ? style.of.startArrow : style.of.endArrow) ?? "classic"
    ).toLowerCase();
    const arrow: ArrowType =
      end === "none"
        ? "arrow_open"
        : end === "oval" || end === "circle"
          ? "arrow_circle"
          : end === "cross" || end === "ercross"
            ? "arrow_cross"
            : "arrow_point";
    const start = backwards ? "none" : (style.of.startArrow ?? "none").toLowerCase();
    const both = start !== "none" && arrow !== "arrow_open";

    const id = `e${edges.length}_${source}_${target}`;
    edges.push({
      id,
      source,
      target,
      data: {
        label: labelOf(cell, backwards),
        stroke,
        arrow,
        ...(both ? { both: true } : {}),
      },
    });

    // draw.io keeps an edge's points in the frame of the cell it belongs to —
    // a swimlane, a container — and the canvas keeps corners in one frame
    // for the whole page, so they were shifted above. Taken as they stood,
    // the corners of every connection drawn inside a lane landed short of it
    // by the lane's offset, and the line went off to them and came back.
    const pair = `${source}>${target}`;
    const ordinal = ordinals.get(pair) ?? 0;
    ordinals.set(pair, ordinal + 1);
    const key = waypointKey(source, target, ordinal);
    if (corners.length) waypoints[key] = corners;
    if (direct) routes[key] = { route };
  }

  const body = serializeFlowchart("TB", nodes, edges);
  const trailer = [positionsLine(positions)];
  if (Object.keys(waypoints).length) trailer.push(waypointsLine(waypoints));
  if (Object.keys(routes).length) trailer.push(edgeStylesLine(routes));

  const family = looksLike(cells);
  return {
    code: `${body}${trailer.join("\n")}\n`,
    nodes: nodes.length,
    edges: edges.length,
    pages,
    page,
    dropped,
    ...(family ? { looksLike: family } : {}),
  };
}
