import type {
  AnyNode,
  ArrowType,
  ClassDefs,
  Direction,
  EdgeStroke,
  FlowEdge,
  GroupNode,
  Shape,
  ShapeNode,
} from "../types";
import { IMG_SIZE, SHAPES, isGroup } from "../types";
import { entriesOf, normalizeDirection, quote } from "./shared";

function normalizeShape(type: unknown): Shape {
  if (typeof type === "string" && (SHAPES as readonly string[]).includes(type)) {
    return type as Shape;
  }
  return "square";
}

/**
 * The picture on a node, as mermaid's parser reports it.
 *
 * Mermaid keeps these beside the vertex rather than in its `type`, and a
 * node that has one has no `type` at all — which is why an image node used
 * to come back as a plain rectangle with its picture quietly dropped on the
 * next save. `icon` is read for the same reason and only to hand it back
 * unchanged; Archyne never writes one.
 */
function imageOf(v: Record<string, unknown>): Partial<ShapeNode["data"]> {
  const img = typeof v.img === "string" && v.img ? v.img : undefined;
  const icon = typeof v.icon === "string" && v.icon ? v.icon : undefined;
  if (!img && !icon) return {};

  const width = Number(v.assetWidth);
  const height = Number(v.assetHeight);
  return {
    ...(img ? { img } : {}),
    ...(icon ? { icon } : {}),
    ...(v.pos === "t" || v.pos === "b" ? { imgPos: v.pos } : {}),
    ...(Number.isFinite(width) && width > 0 ? { imgWidth: width } : {}),
    ...(Number.isFinite(height) && height > 0 ? { imgHeight: height } : {}),
    ...(v.constraint === "on" ? { imgConstrained: true } : {}),
  };
}

export function parseFlowchart(db: Record<string, (...a: unknown[]) => unknown>): {
  direction: Direction;
  nodes: AnyNode[];
  edges: FlowEdge[];
  classDefs: ClassDefs;
} {
  const vertices = entriesOf(db.getVertices?.());
  const rawEdges = (db.getEdges?.() ?? []) as Array<Record<string, unknown>>;
  const rawSubgraphs = (db.getSubGraphs?.() ?? []) as Array<Record<string, unknown>>;
  const direction = normalizeDirection(db.getDirection?.());

  const groupIds = new Set(rawSubgraphs.map((sg) => String(sg.id)));
  const vertexOf = new Map(vertices);
  const parentOf = new Map<string, string>();
  for (const sg of rawSubgraphs) {
    for (const child of (sg.nodes ?? []) as unknown[]) {
      parentOf.set(String(child), String(sg.id));
    }
  }

  const nodes: AnyNode[] = [];
  const emitGroup = (gid: string) => {
    if (nodes.some((n) => n.id === gid)) return;
    const sg = rawSubgraphs.find((x) => String(x.id) === gid);
    if (!sg) return;
    const parent = parentOf.get(gid);
    if (parent) emitGroup(parent);
    // mermaid keeps a `style` statement naming a subgraph with the vertices,
    // under the subgraph's id.
    const styles = ((vertexOf.get(gid)?.styles ?? []) as unknown[]).map(String);
    const g: GroupNode = {
      id: gid,
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        label: String(sg.title ?? gid),
        subgraphId: gid,
        ...(styles.length ? { styles } : {}),
      },
      style: { width: 320, height: 220 },
      ...(parent ? { parentId: parent } : {}),
    };
    nodes.push(g);
  };
  for (const sg of rawSubgraphs) emitGroup(String(sg.id));

  const classDefs: ClassDefs = {};
  for (const [name, def] of entriesOf(db.getClasses?.())) {
    if (name === "default") continue;
    classDefs[name] = ((def.styles ?? []) as unknown[]).map(String);
  }

  for (const [id, v] of vertices) {
    if (groupIds.has(id)) continue;
    const parent = parentOf.get(id);
    const classes = ((v.classes ?? []) as unknown[]).map(String).filter((c) => c !== "default");
    const styles = ((v.styles ?? []) as unknown[]).map(String);
    const n: ShapeNode = {
      id,
      type: "shape",
      position: { x: 0, y: 0 },
      data: {
        label: String(v.text ?? id),
        shape: normalizeShape(v.type),
        direction,
        ...(classes.length ? { classes } : {}),
        ...(styles.length ? { styles } : {}),
        ...imageOf(v),
      },
      ...(parent ? { parentId: parent } : {}),
    };
    nodes.push(n);
  }

  const edges: FlowEdge[] = rawEdges.map((e, i) => {
    const raw = String(e.type ?? "arrow_point");
    const both = raw.startsWith("double_");
    const t = raw.replace(/^double_/, "");
    const arrow: ArrowType =
      t === "arrow_open" || t === "arrow_circle" || t === "arrow_cross"
        ? (t as ArrowType)
        : "arrow_point";
    const s = String(e.stroke ?? "normal");
    const stroke: EdgeStroke = s === "dotted" || s === "thick" ? s : "normal";
    return {
      id: `e${i}_${e.start}_${e.end}`,
      source: String(e.start),
      target: String(e.end),
      data: { label: String(e.text ?? ""), stroke, arrow, ...(both ? { both: true } : {}) },
    };
  });

  return { direction, nodes, edges, classDefs };
}

/* ---------- serialize ---------- */

/**
 * A node written in mermaid's `@{ … }` form, for the two kinds that cannot
 * be written any other way — or null when the node is an ordinary shape.
 *
 * The label goes inside the braces rather than in brackets beside them:
 * mermaid accepts only one of the two forms per node, and mixing them is a
 * parse error rather than a merge.
 */
function pictureDecl(data: ShapeNode["data"]): string | null {
  if (!data.img && !data.icon) return null;

  const parts = [
    data.img ? `img: ${quote(data.img)}` : `icon: ${quote(data.icon ?? "")}`,
    `label: ${quote(data.label)}`,
  ];
  if (data.imgPos) parts.push(`pos: "${data.imgPos}"`);

  if (data.img) {
    // The size is written even when nobody chose one, because mermaid's
    // default is not Archyne's and the difference is not subtle. Mermaid
    // draws the picture at its *intrinsic* size — for an icon set that is
    // the `width: 1.25em` in the SVG, so about 20×16 — then, whenever the
    // node has a label, widens it to the flowchart wrapping width (200px)
    // and stretches it to fit with `preserveAspectRatio="none"`. An icon
    // that looks right on the canvas therefore arrives in the Live Editor
    // as a 200×16 smear.
    //
    // `constraint: "on"` is the only way out: it is what makes mermaid
    // derive the width from the height and the picture's own ratio instead
    // of from the wrapping width. That is also what the canvas does, with
    // `object-fit: contain`, which is why it is written for every picture
    // and not only for the ones that arrived with it.
    parts.push(
      `w: ${Math.round(data.imgWidth ?? IMG_SIZE)}`,
      `h: ${Math.round(data.imgHeight ?? IMG_SIZE)}`,
      `constraint: "on"`,
    );
  } else {
    // An `icon:` node is somebody else's, down to its sizing: hand back
    // what was there and invent nothing.
    if (data.imgWidth) parts.push(`w: ${Math.round(data.imgWidth)}`);
    if (data.imgHeight) parts.push(`h: ${Math.round(data.imgHeight)}`);
    if (data.imgConstrained) parts.push(`constraint: "on"`);
  }
  return `@{ ${parts.join(", ")} }`;
}

/**
 * A node's or group's label, quoted for its brackets.
 *
 * Mermaid refuses an empty pair of quotes — `n1[""]` is a parse error, and so
 * is a subgraph titled `""` — and a box with no text is everywhere in what
 * comes in from draw.io and Visio: icons, dots, separators. A single space
 * draws the same nothing, parses, and reads back as an empty label, so the
 * file survives being saved and opened again.
 */
function boxLabel(label: string): string {
  return quote(label === "" ? " " : label);
}

function bracket(shape: Shape, label: string): string {
  const l = boxLabel(label);
  switch (shape) {
    case "square":
      return `[${l}]`;
    case "round":
      return `(${l})`;
    case "stadium":
      return `([${l}])`;
    case "subroutine":
      return `[[${l}]]`;
    case "cylinder":
      return `[(${l})]`;
    case "circle":
      return `((${l}))`;
    case "doublecircle":
      return `(((${l})))`;
    case "diamond":
      return `{${l}}`;
    case "hexagon":
      return `{{${l}}}`;
    case "odd":
      return `>${l}]`;
    case "trapezoid":
      return `[/${l}\\]`;
    case "inv_trapezoid":
      return `[\\${l}/]`;
    case "lean_right":
      return `[/${l}/]`;
    case "lean_left":
      return `[\\${l}\\]`;
  }
}

function edgeOp(stroke: EdgeStroke, arrow: ArrowType, both?: boolean): string {
  const head =
    arrow === "arrow_point"
      ? ">"
      : arrow === "arrow_circle"
        ? "o"
        : arrow === "arrow_cross"
          ? "x"
          : "";
  const tail = !both || !head ? "" : arrow === "arrow_point" ? "<" : head;
  switch (stroke) {
    case "dotted":
      return head ? `${tail}-.-${head}` : "-.-";
    case "thick":
      return head ? `${tail}==${head}` : "===";
    default:
      return head ? `${tail}--${head}` : "---";
  }
}

export function serializeFlowchart(
  direction: Direction,
  nodes: AnyNode[],
  edges: FlowEdge[],
  classDefs: ClassDefs = {},
): string {
  const lines: string[] = [`flowchart ${direction}`];
  const groups = nodes.filter(isGroup);
  const byParent = new Map<string | undefined, AnyNode[]>();
  for (const n of nodes) {
    if (isGroup(n)) continue;
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }

  const emitNode = (n: AnyNode, indent: string) => {
    if (n.type !== "shape") return;
    const picture = pictureDecl(n.data);
    lines.push(`${indent}${n.id}${picture ?? bracket(n.data.shape, n.data.label)}`);
  };

  for (const n of byParent.get(undefined) ?? []) emitNode(n, "  ");

  const emitGroup = (g: GroupNode, indent: string) => {
    lines.push(`${indent}subgraph ${g.id} [${boxLabel(g.data.label)}]`);
    for (const child of byParent.get(g.id) ?? []) emitNode(child, indent + "  ");
    for (const nested of groups.filter((x) => x.parentId === g.id)) {
      emitGroup(nested, indent + "  ");
    }
    lines.push(`${indent}end`);
  };
  for (const g of groups.filter((x) => !x.parentId)) emitGroup(g, "  ");

  if (edges.length > 0) lines.push("");
  for (const e of edges) {
    const d = e.data;
    const op = edgeOp(d?.stroke ?? "normal", d?.arrow ?? "arrow_point", d?.both);
    const label = d?.label ? `|${quote(d.label)}|` : "";
    lines.push(`  ${e.source} ${op}${label} ${e.target}`);
  }

  const styleLines: string[] = [];
  for (const [name, styles] of Object.entries(classDefs)) {
    if (styles.length) styleLines.push(`  classDef ${name} ${styles.join(",")}`);
  }
  for (const g of groups) {
    if (g.data.styles?.length) styleLines.push(`  style ${g.id} ${g.data.styles.join(",")}`);
  }
  const byClass = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.type !== "shape") continue;
    for (const c of n.data.classes ?? []) {
      byClass.set(c, [...(byClass.get(c) ?? []), n.id]);
    }
    if (n.data.styles?.length) {
      styleLines.push(`  style ${n.id} ${n.data.styles.join(",")}`);
    }
  }
  for (const [name, ids] of byClass) {
    styleLines.push(`  class ${ids.join(",")} ${name}`);
  }
  if (styleLines.length) lines.push("", ...styleLines);
  return lines.join("\n") + "\n";
}
