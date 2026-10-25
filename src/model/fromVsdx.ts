/**
 * Reading a Visio `.vsdx` drawing into a Mermaid flowchart.
 *
 * The most awkward format Archyne reads, for reasons that are all Visio's:
 * the file is an OPC package (a zip of XML with a relationship graph on the
 * side), a shape's position is the centre of it measured in **inches from the
 * bottom-left of the page**, and what a shape *is* lives in a master in
 * another part of the package rather than on the shape itself. Connectivity
 * is not on the connectors either — it is a separate `<Connects>` table that
 * says which cell of which sheet glues to which.
 *
 * So the mapping is: `Shape` → node, master name → the closest of Mermaid's
 * fourteen, `<Connects>` → edges, and PinX/PinY/Width/Height → the positions
 * comment, converted to pixels with the Y axis turned over.
 *
 * Not attempted, and not pretended: containers and list membership, layers,
 * themes, and the sub-shapes of a group — a Visio group is usually one
 * composite stencil rather than a logical container, so it comes across as
 * the single shape it looks like.
 */
import { unzipSync } from "fflate";
import type { AnyNode, EdgeStroke, FlowEdge, Shape, ShapeNode } from "./types";
import { serializeFlowchart } from "./kinds/flowchart";
import { positionsLine, type PositionMap } from "./positions";
import { idFactory, readableOn } from "./importShared";

export interface VsdxImport {
  code: string;
  nodes: number;
  edges: number;
  /** Every page in the file, by name. */
  pages: string[];
  /** Which of them was converted, as an index. */
  page: number;
  /** Connectors with an end glued to nothing. */
  dropped: number;
}

/** Visio measures in inches; the canvas is 96 pixels to one. */
const PX_PER_INCH = 96;

/** A page is 11 inches tall unless it says otherwise. */
const DEFAULT_PAGE_HEIGHT = 11;

function parseXml(text: string, what: string): Document {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error(`${what} is not valid XML`);
  return doc;
}

/** `<Cell N="PinX" V="4.25"/>` — the value of one named cell of a shape. */
function cell(shape: Element, name: string): string | null {
  for (const c of shape.children) {
    if (c.tagName === "Cell" && c.getAttribute("N") === name) return c.getAttribute("V");
  }
  return null;
}

function cellNumber(shape: Element, name: string): number | null {
  const raw = cell(shape, name);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * A shape's own text.
 *
 * `<Text>` is a run list — `<cp/>` marks a character-formatting change and
 * `<pp/>` a paragraph one — so the words are what is left once the markup is
 * out of the way.
 */
function shapeText(shape: Element): string {
  const text = [...shape.children].find((c) => c.tagName === "Text");
  if (!text) return "";
  return (text.textContent ?? "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("<br/>");
}

/** Visio writes literal colours as `#rrggbb` and theme colours as an index. */
function literalColour(value: string | null): string | null {
  return value && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : null;
}

/** Master names, lower-cased, and the Mermaid shape each suggests. */
const BY_MASTER: Array<[RegExp, Shape]> = [
  [/decision|diamond/, "diamond"],
  [/terminator|start\/end|start.end|rounded\s*rect|oval/, "stadium"],
  [/\bdata\b|input.output|parallelogram/, "lean_right"],
  [/database|stored\s*data|direct\s*data|disk|cylinder/, "cylinder"],
  [/predefined|subprocess|sub-?process/, "subroutine"],
  [/preparation|hexagon/, "hexagon"],
  [/on-?page\s*reference|connector\s*\(circle\)|circle|ellipse/, "circle"],
  [/off-?page\s*reference/, "odd"],
  [/manual\s*operation/, "inv_trapezoid"],
  [/manual\s*input/, "lean_right"],
];

function mapShape(master: string): Shape {
  const name = master.toLowerCase();
  for (const [pattern, shape] of BY_MASTER) {
    if (pattern.test(name)) return shape;
  }
  return "square";
}

/** Masters whose name says the shape is a line rather than a box. */
const CONNECTOR = /connector|link|arrow|line/i;

interface Part {
  /** Path inside the package, e.g. `visio/pages/page1.xml`. */
  path: string;
  text: string;
}

/** Read the package, decoding only the XML parts this needs. */
function open(bytes: Uint8Array): Map<string, Part> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("this file is not a readable Visio package");
  }
  const decoder = new TextDecoder();
  const parts = new Map<string, Part>();
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".xml") && !path.endsWith(".rels")) continue;
    parts.set(path.toLowerCase(), { path, text: decoder.decode(content) });
  }
  if (!parts.has("visio/pages/pages.xml")) {
    throw new Error("this file holds no Visio drawing");
  }
  return parts;
}

/** Master id → its name, so a shape can be told what it is. */
function masterNames(parts: Map<string, Part>): Map<string, string> {
  const out = new Map<string, string>();
  const part = parts.get("visio/masters/masters.xml");
  if (!part) return out;
  for (const master of parseXml(part.text, "the masters").querySelectorAll("Master")) {
    const id = master.getAttribute("ID");
    const name = master.getAttribute("NameU") || master.getAttribute("Name") || "";
    if (id) out.set(id, name);
  }
  return out;
}

/**
 * One page's shapes — the first unless another is asked for — and how tall
 * its sheet is.
 *
 * The page list names the pages and points at their parts through the
 * relationship file beside it, so both have to be read to get from "Page-1"
 * to `page1.xml`.
 */
function pageAt(
  parts: Map<string, Part>,
  which: number,
): {
  pages: string[];
  page: number;
  contents: Document;
  height: number;
} {
  const list = parseXml(parts.get("visio/pages/pages.xml")!.text, "the page list");
  const pageElements = [...list.querySelectorAll("Page")];
  const pages = pageElements.map(
    (p, i) => p.getAttribute("NameU") || p.getAttribute("Name") || `Page ${i + 1}`,
  );
  if (pageElements.length === 0) throw new Error("this drawing has no pages");

  const rels = parts.get("visio/pages/_rels/pages.xml.rels");
  const target = new Map<string, string>();
  if (rels) {
    for (const rel of parseXml(rels.text, "the page relationships").querySelectorAll(
      "Relationship",
    )) {
      const id = rel.getAttribute("Id");
      const to = rel.getAttribute("Target");
      if (id && to) target.set(id, to.replace(/^\.?\//, ""));
    }
  }

  const page = which >= 0 && which < pageElements.length ? which : 0;
  const first = pageElements[page];
  const relId = first.querySelector("Rel")?.getAttribute("r\\:id") ?? firstRelId(first);
  const file = (relId && target.get(relId)) || "page1.xml";
  const part = parts.get(`visio/pages/${file.toLowerCase()}`);
  if (!part) throw new Error("that page of this drawing is missing");

  // The page height is on the page's own sheet, and everything vertical is
  // measured from the bottom of it.
  const sheet = first.querySelector("PageSheet");
  const height = sheet
    ? (cellNumber(sheet, "PageHeight") ?? DEFAULT_PAGE_HEIGHT)
    : DEFAULT_PAGE_HEIGHT;

  return { pages, page, contents: parseXml(part.text, "the page"), height };
}

/** `r:id` is namespaced, which `querySelector` cannot always reach. */
function firstRelId(page: Element): string | null {
  const rel = [...page.children].find((c) => c.tagName.endsWith("Rel"));
  if (!rel) return null;
  for (const attr of rel.attributes) {
    if (attr.name === "r:id" || attr.localName === "id") return attr.value;
  }
  return null;
}

/** Read a Visio `.vsdx`. Throws when it is not one. */
export function vsdxToMermaid(bytes: Uint8Array, which = 0): VsdxImport {
  const parts = open(bytes);
  const masters = masterNames(parts);
  const { pages, page, contents, height: pageHeight } = pageAt(parts, which);

  // Only the top level: the sub-shapes of a group belong to one composite
  // stencil far more often than they are a container of their own.
  const shapesRoot = contents.querySelector("Shapes");
  const shapes = shapesRoot
    ? [...shapesRoot.children].filter((c) => c.tagName === "Shape")
    : [];

  const nextId = idFactory();
  const idOf = new Map<string, string>();
  const nodes: AnyNode[] = [];
  const positions: PositionMap = {};
  const connectors = new Map<string, Element>();

  for (const shape of shapes) {
    const sheet = shape.getAttribute("ID");
    if (!sheet) continue;
    const master = masters.get(shape.getAttribute("Master") ?? "") ?? "";
    const nameU = shape.getAttribute("NameU") ?? "";

    // A 1-D shape is a line. `BeginX` is the giveaway that survives a file
    // whose masters were renamed or stripped.
    if (cell(shape, "BeginX") !== null || CONNECTOR.test(master) || CONNECTOR.test(nameU)) {
      connectors.set(sheet, shape);
      continue;
    }

    const label = shapeText(shape);
    const id = nextId(label, `n${nodes.length + 1}`);
    idOf.set(sheet, id);

    const fill = literalColour(cell(shape, "FillForegnd"));
    const stroke = literalColour(cell(shape, "LineColor"));
    const styles: string[] = [];
    if (fill) styles.push(`fill:${fill}`);
    if (stroke) styles.push(`stroke:${stroke}`);
    if (fill) {
      const readable = readableOn(fill);
      if (readable) styles.push(`color:${readable}`);
    }

    const node: ShapeNode = {
      id,
      type: "shape",
      position: { x: 0, y: 0 },
      data: {
        label,
        shape: mapShape(master || nameU),
        direction: "TB",
        ...(styles.length ? { styles } : {}),
      },
    };
    nodes.push(node);

    // PinX/PinY are the centre, in inches, with Y measured upwards from the
    // bottom of the page. The canvas wants the top-left corner in pixels
    // with Y downwards, which is every one of those three the other way.
    const pinX = cellNumber(shape, "PinX");
    const pinY = cellNumber(shape, "PinY");
    const width = cellNumber(shape, "Width") ?? 1;
    const heightIn = cellNumber(shape, "Height") ?? 0.75;
    if (pinX !== null && pinY !== null) {
      positions[id] = {
        x: Math.round((pinX - width / 2) * PX_PER_INCH),
        y: Math.round((pageHeight - pinY - heightIn / 2) * PX_PER_INCH),
        w: Math.round(width * PX_PER_INCH),
        h: Math.round(heightIn * PX_PER_INCH),
      };
    }
  }

  // `<Connect FromSheet="5" FromCell="BeginX" ToSheet="1"/>` — the ends of
  // every connector, listed apart from the connectors themselves.
  const ends = new Map<string, { from?: string; to?: string }>();
  for (const connect of contents.querySelectorAll("Connect")) {
    const from = connect.getAttribute("FromSheet");
    const to = connect.getAttribute("ToSheet");
    const which = connect.getAttribute("FromCell") ?? "";
    if (!from || !to) continue;
    const entry = ends.get(from) ?? {};
    if (/^Begin/i.test(which)) entry.from = to;
    else if (/^End/i.test(which)) entry.to = to;
    ends.set(from, entry);
  }

  const edges: FlowEdge[] = [];
  let dropped = 0;
  for (const [sheet, connector] of connectors) {
    const pair = ends.get(sheet);
    const source = pair?.from ? idOf.get(pair.from) : undefined;
    const target = pair?.to ? idOf.get(pair.to) : undefined;
    // A connector glued at one end only, or drawn between two shapes that did
    // not come across. Mermaid has no connection with a loose end.
    if (!source || !target) {
      dropped++;
      continue;
    }

    const pattern = cellNumber(connector, "LinePattern");
    const weight = cellNumber(connector, "LineWeight");
    const stroke: EdgeStroke =
      pattern !== null && pattern > 1 ? "dotted" : (weight ?? 0) >= 0.04 ? "thick" : "normal";
    const arrow = cellNumber(connector, "EndArrow");

    edges.push({
      id: `e${edges.length}_${source}_${target}`,
      source,
      target,
      data: {
        label: shapeText(connector),
        stroke,
        arrow: arrow === 0 ? "arrow_open" : "arrow_point",
        ...(cellNumber(connector, "BeginArrow") ? { both: true } : {}),
      },
    });
  }

  const body = serializeFlowchart("TB", nodes, edges);
  const trailer = Object.keys(positions).length ? `${positionsLine(positions)}\n` : "";
  return {
    code: `${body}${trailer}`,
    nodes: nodes.length,
    edges: edges.length,
    pages,
    page,
    dropped,
  };
}
