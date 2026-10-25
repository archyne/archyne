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
import { BOXES, face } from "../render/boxModel";
import { labelLines } from "./label";
import { idFactory, readableOn } from "./importShared";
import { buildArchitecture, CLOUD_STENCILS } from "./drawioArchitecture";
import { positionsLine, type PositionMap } from "./positions";
import { waypointKey, waypointsLine, type WaypointMap } from "./waypoints";

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
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
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

    out.push({
      id: (wrapped ? element.getAttribute("id") : cell.getAttribute("id")) ?? "",
      label: plainText(label),
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
  return out.filter((c) => c.id);
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
  umlActor: "square",
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

  const isEllipse = style.names.has("ellipse") || named === "ellipse";
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
  return fill && fill !== "transparent" ? fill : null;
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

  const fill = colour(style.of.fillColor);
  const stroke = colour(style.of.strokeColor);
  const text = colour(style.of.fontColor);
  if (fill) out.push(`fill:${fill}`);
  if (stroke) out.push(`stroke:${stroke === "transparent" ? "none" : stroke}`);

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

/* ---------- the conversion ---------- */

/**
 * Whether a drawing is cloud architecture, from the stencils it uses.
 *
 * A VPC drawn with `mxgraph.aws4.*` shapes is not a flowchart, and reading it
 * as one throws away the icons — the part that makes it legible.
 */
function looksArchitectural(cells: RawCell[]): boolean {
  // Unless its icons are mostly pictures the canvas can show. A flowchart
  // draws those now, with its boxes and captions as they were; one cloud
  // stencil among seventy pasted icons sent a whole drawing to
  // architecture-beta, which has neither. Pictures from elsewhere on the web
  // do not count: the canvas loads them from a short list of hosts only.
  const stencils = cells.filter((c) => CLOUD_STENCILS.test(c.style)).length;
  const pictures = cells.filter((c) => {
    const src = pictureOf(c.style);
    return !!src && (src.startsWith("data:") || src.startsWith(DRAWIO_IMAGES));
  }).length;
  return stencils > 0 && stencils >= pictures;
}

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
function fittingSize(fits: (font: ReturnType<typeof face>) => boolean): number | null {
  if (fits(face(LABEL_PX))) return null;
  for (let px = LABEL_PX - 0.5; px >= SMALLEST_PX; px -= 0.5) {
    if (fits(face(px))) return px;
  }
  return SMALLEST_PX;
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

/** Read a draw.io file. Throws when the file is not one, or is unreadable. */
export function drawioToMermaid(xml: string, as?: DrawioAs, which = 0): DrawioImport {
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

  const cells = dissolveGroups(readCells(model));
  const byId = new Map(cells.map((c) => [c.id, c]));

  // A cell parented to an edge and styled as its label *is* that label, not a
  // node — which is where draw.io puts most edge labels.
  const edgeLabels = new Map<string, string>();
  for (const cell of cells) {
    const parent = byId.get(cell.parent);
    if (cell.vertex && parent?.edge && parseStyle(cell.style).names.has("edgelabel")) {
      if (cell.label) edgeLabels.set(cell.parent, cell.label);
    }
  }

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
  if (as === "architecture" || (as !== "flowchart" && looksArchitectural(cells))) {
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
        .filter((c) => c.vertex && !parseStyle(c.style).names.has("edgelabel"))
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
            label: c.label || edgeLabels.get(c.id) || "",
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
    (c) =>
      c.vertex &&
      c.geometry &&
      !parseStyle(c.style).names.has("edgelabel") &&
      !pictureOf(c.style),
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
  const zoned = cells.filter(
    (c) => c.vertex && c.geometry && !parseStyle(c.style).names.has("edgelabel"),
  );
  const zones = placed.filter((c) => {
    if (isContainer(c) || parseStyle(c.style).names.has("text")) return false;
    // Pictures count among what a panel holds — an icon and its caption in a
    // box is a panel round two things.
    const held = zoned.filter((o) => encloses(c, o)).length;
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
  for (const cell of groupCells) {
    const id = nextId(cell.label, `g${nodes.length + 1}`);
    idOf.set(cell.id, id);
    const parentId = parentIdOf(cell);
    // Its own colours, and its dash if it had one: every panel was the same
    // faint tint, so "Cluster nodes" and its node pools read as one surface,
    // and a card stacked on another showed the one behind through it.
    // draw.io fills a panel white unless told otherwise, and the words in it
    // are drawn to be read on that.
    const look = parseStyle(cell.style);
    const fill = panelFill(look);
    const styles = [
      ...colourStyles(look).filter((d) => !d.startsWith("fill:")),
      ...(fill ? [`fill:${fill}`] : look.of.fillColor ? ["fill:transparent"] : []),
      ...(look.of.dashed === "1" ? [`stroke-dasharray:${dashOf(look)}`] : []),
    ];
    if (fill && !styles.some((d) => d.startsWith("color:"))) {
      const readable = readableOn(fill);
      if (readable) styles.push(`color:${readable}`);
    }
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
  }

  for (const cell of cells) {
    if (!cell.vertex || isGroupCell(cell)) continue;
    const style = parseStyle(cell.style);
    // Edge labels were harvested above; they are not nodes.
    if (style.names.has("edgelabel")) continue;
    if (!cell.label && !cell.geometry) {
      dropped++;
      continue;
    }

    const id = nextId(cell.label, `n${nodes.length + 1}`);
    idOf.set(cell.id, id);
    const parentId = parentIdOf(cell);
    const picture = pictureOf(cell.style);
    // A picture is drawn with no box round it, its label above or below as
    // in draw.io — inside a box its own size, the words had a few pixels and
    // were cut to "Gateway (to On-".
    const styles = picture
      ? [
          "fill:none",
          "stroke:none",
          ...colourStyles(style).filter((d) => d.startsWith("color:")),
        ]
      : colourStyles(style);
    // Words with no box of their own, and a picture's caption, are read on
    // the panel under them: in the theme's colour, the dark theme's pale
    // text vanished on draw.io's white and pale-blue panels.
    const boxless = picture || styles.some((d) => /^fill:(none|transparent)$/.test(d));
    if (boxless && !styles.some((d) => d.startsWith("color:"))) {
      const surface = surfaceOf(cell);
      const readable = surface && readableOn(surface);
      if (readable) styles.push(`color:${readable}`);
    }
    // Words fitted inside the box they were drawn in, with the padding the
    // canvas gives them: almost none for words with no box and for a small
    // tag, the label's usual padding for anything else.
    // Words draw.io puts beside the shape — under a stick figure — are not
    // in its box there, and are not fitted to it.
    const outside =
      /^(top|bottom)$/.test(style.of.verticalLabelPosition ?? "") ||
      /^(left|right)$/.test(style.of.labelPosition ?? "");
    let nudge = { x: 0, y: 0 };
    if (!picture && !outside && cell.label && cell.geometry) {
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
      const px = fittingSize((font) => placed(font) !== null);
      if (px !== null) styles.push(`font-size:${px}px`);
      nudge = placed(face(px ?? LABEL_PX)) ?? { x: 0, y: 0 };
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
          const px = fittingSize((font) => {
            let widest = 0;
            let tall = 0;
            for (const line of labelLines(cell.label)) {
              const size = metrics.measure(line, font);
              widest = Math.max(widest, size.width);
              tall += size.height;
            }
            return widest / 2 <= across && 4 + tall <= down - FRAME_INSET - EDGE_CLEARANCE;
          });
          if (px !== null) {
            node.data.styles = [...(node.data.styles ?? []), `font-size:${px}px`];
          }
        }
        const size = measureNode(node);
        const above = node.data.imgPos === "t";
        positions[id] = {
          x: at.x + w / 2 - size.width / 2,
          // `.shape-label.with-image`: 6px above whatever comes first.
          y: above ? at.y - (size.height - h - 6) : at.y - 6,
        };
      } else {
        positions[id] = { ...at, x: at.x + nudge.x, y: at.y + nudge.y };
      }
    }
  }

  const edges: FlowEdge[] = [];
  const waypoints: WaypointMap = {};
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
   */
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
    return best && idOf.get(best.id);
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
    if (!source || !target || looseLoop) {
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
    ) => {
      const raw = [...idOf.entries()].find(([, v]) => v === node)?.[0];
      const box = onPage.find((b) => b.id === raw);
      if (!box) return null;
      const fx = Number(x);
      const fy = Number(y);
      const at =
        tied && Number.isFinite(fx) && Number.isFinite(fy)
          ? { x: box.x + fx * box.w, y: box.y + fy * box.h }
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
      return { x: px + out.x * PORT_STUB, y: py + out.y * PORT_STUB };
    };
    const leaving = port(
      source,
      style.of.exitX,
      style.of.exitY,
      cell.loose.source,
      !!tiedSource,
    );
    const arriving = port(
      target,
      style.of.entryX,
      style.of.entryY,
      cell.loose.target,
      !!tiedTarget,
    );
    let corners = [
      ...(leaving ? [leaving] : []),
      ...cell.points.map((q) => ({ x: q.x + ox, y: q.y + oy })),
      ...(arriving ? [arriving] : []),
    ];

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
        label: cell.label || edgeLabels.get(cell.id) || "",
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
    if (corners.length) {
      const pair = `${source}>${target}`;
      const ordinal = ordinals.get(pair) ?? 0;
      ordinals.set(pair, ordinal + 1);
      waypoints[waypointKey(source, target, ordinal)] = corners;
    } else {
      const pair = `${source}>${target}`;
      ordinals.set(pair, (ordinals.get(pair) ?? 0) + 1);
    }
  }

  const body = serializeFlowchart("TB", nodes, edges);
  const trailer = [positionsLine(positions)];
  if (Object.keys(waypoints).length) trailer.push(waypointsLine(waypoints));

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
