/**
 * React Flow's own value for a filled arrowhead, as the string it is.
 *
 * Importing the enum pulls `@xyflow/react` — and React with it — into anything
 * that parses a diagram, which in `archyne-render` is the difference between a
 * library and half an application. The type still comes from there, so a
 * change in React Flow is still a compile error here.
 */
const ARROW_CLOSED = "arrowclosed" as MarkerType.ArrowClosed;
import type { MarkerType } from "@xyflow/react";
import type {
  AnyNode,
  ClassDefs,
  DiagramKind,
  Direction,
  FlowEdge,
  FlowEdgeData,
  SeqItem,
} from "./types";
import { getMermaid, withMermaid } from "./fromMermaid";
import { normalizeDirection } from "./kinds/shared";
import { parseFlowchart, serializeFlowchart } from "./kinds/flowchart";
import { parseState, serializeState } from "./kinds/state";
import { parseEr, serializeEr } from "./kinds/er";
import { parseClass, serializeClass } from "./kinds/cls";
import { parseSequence, serializeSequence } from "./kinds/sequence";
import { parseArchitecture, serializeArchitecture } from "./kinds/architecture";
import { parseC4, serializeC4 } from "./kinds/c4";
import { parseRequirement, serializeRequirement } from "./kinds/requirement";
import { positionsLine, type PositionMap } from "./positions";

/**
 * The code is valid Mermaid, but of a family Archyne has no visual editor
 * for (gantt, pie, mindmap, …).
 *
 * Thrown as its own type rather than a plain `Error` so callers can tell
 * "we can't edit this" apart from "this doesn't parse" without matching on
 * message text. The app renders these read-only instead of refusing to open
 * them — Mermaid is already bundled and can draw them.
 */
export class UnsupportedDiagramError extends Error {
  constructor(readonly diagramType: string) {
    super(
      `Unsupported diagram type "${diagramType}". Visual editing supports: flowchart, stateDiagram-v2, erDiagram, classDiagram, sequenceDiagram, architecture-beta, C4, requirementDiagram.`,
    );
    this.name = "UnsupportedDiagramError";
  }
}
import { edgeColors } from "../edgeTheme";

export interface ParsedDiagram {
  kind: DiagramKind;
  direction: Direction;
  /** Bare nodes at (0,0); the store assigns positions. */
  nodes: AnyNode[];
  edges: FlowEdge[];
  /** classDef definitions (flowchart and requirement). */
  classDefs: ClassDefs;
  /** Non-fatal notice, e.g. constructs the canvas cannot edit yet. */
  warning?: string;
  /** Sequence only: the ordered statement stream (messages, notes, blocks). */
  items?: SeqItem[];
  /** C4 only: which C4 statement opened the diagram (C4Context, …). */
  c4Flavor?: string;
  /** Diagram title (C4 only for now). */
  title?: string;
  /** Accessibility title/description — supported by every mermaid kind. */
  accTitle?: string;
  accDescr?: string;
}

export function parseDiagram(code: string): Promise<ParsedDiagram> {
  return withMermaid((mermaid) => parseDiagramLocked(mermaid, code));
}

async function parseDiagramLocked(
  mermaid: Awaited<ReturnType<typeof getMermaid>>,
  code: string,
): Promise<ParsedDiagram> {
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(code);
  const type: string = (diagram as { type?: string }).type ?? "";
  const db = (diagram as unknown as { db: Record<string, (...a: unknown[]) => unknown> }).db;
  const direction = normalizeDirection(db.getDirection?.());
  const accTitle = String(db.getAccTitle?.() ?? "");
  const accDescr = String(db.getAccDescription?.() ?? "");

  let kind: DiagramKind;
  let parsed: {
    nodes: AnyNode[];
    edges: FlowEdge[];
    classDefs?: ClassDefs;
    warning?: string;
    c4Flavor?: string;
    title?: string;
    items?: SeqItem[];
  };
  if (/^(flowchart|graph)/.test(type)) {
    kind = "flowchart";
    parsed = parseFlowchart(db);
  } else if (type.startsWith("stateDiagram")) {
    kind = "state";
    parsed = parseState(db);
  } else if (type === "er" || type === "erDiagram") {
    kind = "er";
    parsed = parseEr(db);
  } else if (type === "class" || type.startsWith("classDiagram")) {
    kind = "class";
    parsed = parseClass(db);
  } else if (type === "sequence" || type.startsWith("sequenceDiagram")) {
    kind = "sequence";
    parsed = parseSequence(db);
  } else if (type === "architecture") {
    kind = "architecture";
    parsed = parseArchitecture(db);
  } else if (type === "c4") {
    kind = "c4";
    parsed = parseC4(db);
  } else if (type === "requirement" || type.startsWith("requirementDiagram")) {
    kind = "requirement";
    parsed = parseRequirement(db);
  } else {
    throw new UnsupportedDiagramError(type);
  }

  const nodes = parsed.nodes.map((n) =>
    n.type === "group" ? n : { ...n, data: { ...n.data, direction } },
  ) as AnyNode[];
  const edges = parsed.edges.map((e) => presentEdge(kind, e));
  return {
    kind,
    direction,
    nodes,
    edges,
    classDefs: parsed.classDefs ?? {},
    ...(parsed.warning ? { warning: parsed.warning } : {}),
    ...(parsed.items ? { items: parsed.items } : {}),
    ...(parsed.c4Flavor ? { c4Flavor: parsed.c4Flavor } : {}),
    ...(parsed.title ? { title: parsed.title } : {}),
    ...(accTitle ? { accTitle } : {}),
    ...(accDescr ? { accDescr } : {}),
  };
}

export interface SerializeDiagramOptions {
  kind: DiagramKind;
  direction: Direction;
  nodes: AnyNode[];
  edges: FlowEdge[];
  positions?: PositionMap;
  classDefs?: ClassDefs;
  c4Flavor?: string;
  title?: string;
  accTitle?: string;
  accDescr?: string;
  items?: SeqItem[];
}

export function serializeDiagram({
  kind,
  direction,
  nodes,
  edges,
  positions,
  classDefs,
  c4Flavor,
  title,
  accTitle,
  accDescr,
  items,
}: SerializeDiagramOptions): string {
  let out: string;
  switch (kind) {
    case "flowchart":
      out = serializeFlowchart(direction, nodes, edges, classDefs);
      break;
    case "state":
      out = serializeState(direction, nodes, edges);
      break;
    case "er":
      out = serializeEr(direction, nodes, edges);
      break;
    case "class":
      out = serializeClass(direction, nodes, edges);
      break;
    case "sequence":
      out = serializeSequence(nodes, edges, items);
      break;
    case "architecture":
      out = serializeArchitecture(nodes, edges);
      break;
    case "c4":
      out = serializeC4(nodes, edges, c4Flavor, title);
      break;
    case "requirement":
      out = serializeRequirement(direction, nodes, edges, classDefs);
      break;
  }
  // acc statements are valid right after the header in every kind.
  const accLines = [
    ...(accTitle ? [`  accTitle: ${accTitle.replace(/\n/g, " ")}`] : []),
    ...(accDescr ? [`  accDescr: ${accDescr.replace(/\n/g, " ")}`] : []),
  ];
  if (accLines.length > 0) {
    const lines = out.split("\n");
    lines.splice(1, 0, ...accLines);
    out = lines.join("\n");
  }
  if (positions && Object.keys(positions).length > 0) {
    out += `\n${positionsLine(positions)}\n`;
  }
  return out;
}

/* ---------- visual presentation of edges ---------- */

// Plain marker ids: React Flow wraps string markers in url(#…) itself.
const ER_MARKER: Record<string, string> = {
  ONLY_ONE: "er-one",
  ZERO_OR_ONE: "er-zero-one",
  ZERO_OR_MORE: "er-zero-more",
  ONE_OR_MORE: "er-one-more",
};

const CLS_MARKER: Record<string, string | undefined> = {
  none: undefined,
  extension: "cls-extension",
  composition: "cls-composition",
  aggregation: "cls-aggregation",
  dependency: "cls-dependency",
};

const SEQ_MARKER: Record<string, string | undefined> = {
  ">>": "seq-arrow",
  ">": "seq-open",
  x: "seq-cross",
  ")": "seq-open",
};

/** Compute label/style/markers for an edge from its semantic data. */
export function presentEdge(kind: DiagramKind, e: FlowEdge): FlowEdge {
  const d: FlowEdgeData = e.data ?? { label: "" };
  const pal = edgeColors();
  // Colors are explicit (not CSS vars): captured exports can't resolve
  // custom properties on SVG elements.
  const base: FlowEdge = {
    ...e,
    // `routed` draws the smooth-step path unchanged until a corner is put in
    // it, and it is the default so that the handles for putting the first
    // corner in are there to begin with. Sequence messages override this
    // below: the overlay owns their geometry.
    type: "routed",
    label: d.label || undefined,
    // Both markers are cleared here rather than left to each branch to
    // remember. Presenting spreads the edge it is handed, so whatever the
    // last pass drew is still on it, and a branch that adds a marker only
    // when it wants one has no way to take one off: unticking "arrowheads at
    // both ends" left the second head exactly where it was. Every branch
    // below sets `markerEnd`, and the ones that want a head at the start set
    // `markerStart` — so starting from nothing is enough.
    markerStart: undefined,
    markerEnd: undefined,
  };

  if (kind === "architecture" && d.arch) {
    return {
      ...base,
      style: { stroke: pal.stroke, strokeWidth: 1.5 },
      markerStart: d.arch.lhsInto ? "seq-arrow" : undefined,
      markerEnd: d.arch.rhsInto ? "seq-arrow" : undefined,
    };
  }
  if (kind === "c4" && d.c4) {
    return {
      ...base,
      label: d.c4.techn ? `${d.label} [${d.c4.techn}]` : d.label || undefined,
      style: { stroke: pal.stroke, strokeWidth: 1.5, strokeDasharray: "6 4" },
      markerEnd: { type: ARROW_CLOSED, width: 18, height: 18, color: pal.stroke },
      ...(d.c4.relType === "birel"
        ? {
            markerStart: {
              type: ARROW_CLOSED,
              width: 18,
              height: 18,
              color: pal.stroke,
            },
          }
        : {}),
    };
  }
  if (kind === "requirement" && d.req) {
    // The relationship *is* the label: SysML writes it in guillemets on the
    // line, and mermaid's syntax has no room for any other text there.
    const contains = d.req.rel === "contains";
    return {
      ...base,
      label: `«${d.req.rel}»`,
      style: {
        stroke: pal.stroke,
        strokeWidth: 1.5,
        // Containment is a solid line with a crosshair at the container;
        // every other relationship is a dashed dependency with an open head.
        ...(contains ? {} : { strokeDasharray: "6 4" }),
      },
      ...(contains ? { markerStart: "req-contains" } : { markerEnd: "seq-open" }),
    };
  }
  if (kind === "sequence" && d.seq) {
    const op = d.seq.op;
    const head = op.endsWith(">>")
      ? ">>"
      : op.endsWith(")")
        ? ")"
        : op.endsWith("x")
          ? "x"
          : ">";
    return {
      ...base,
      type: "message",
      label: undefined, // the message edge draws its own label
      style: {
        stroke: pal.stroke,
        strokeWidth: 1.5,
        ...(op.startsWith("--") ? { strokeDasharray: "6 4" } : {}),
      },
      markerEnd: SEQ_MARKER[head],
    };
  }

  if (kind === "er" && d.er) {
    return {
      ...base,
      style: {
        stroke: pal.stroke,
        strokeWidth: 1.5,
        ...(d.er.identifying ? {} : { strokeDasharray: "6 4" }),
      },
      // In `A |x--y| B` syntax the marker next to A is cardB, next to B is cardA.
      markerStart: ER_MARKER[d.er.cardB],
      markerEnd: ER_MARKER[d.er.cardA],
    };
  }
  if (kind === "class" && d.cls) {
    return {
      ...base,
      style: {
        stroke: pal.stroke,
        strokeWidth: 1.5,
        ...(d.cls.dotted ? { strokeDasharray: "6 4" } : {}),
      },
      markerStart: CLS_MARKER[d.cls.left],
      markerEnd: CLS_MARKER[d.cls.right],
    };
  }
  if (kind === "state") {
    return {
      ...base,
      style: { stroke: pal.stroke, strokeWidth: 1.5 },
      markerEnd: { type: ARROW_CLOSED, width: 18, height: 18, color: pal.stroke },
    };
  }
  // flowchart
  const flowMarker =
    d.arrow === "arrow_open"
      ? undefined
      : { type: ARROW_CLOSED, width: 18, height: 18, color: pal.stroke };
  return {
    ...base,
    style: {
      stroke: pal.stroke,
      strokeWidth: d.stroke === "thick" ? 3 : 1.5,
      ...(d.stroke === "dotted" ? { strokeDasharray: "6 4" } : {}),
    },
    markerEnd: flowMarker,
    ...(d.both ? { markerStart: flowMarker } : {}),
  };
}

/** Default data for an edge drawn on the canvas, per diagram kind. */
export function defaultEdgeData(kind: DiagramKind): FlowEdgeData {
  switch (kind) {
    case "flowchart":
      return { label: "", stroke: "normal", arrow: "arrow_point" };
    case "state":
      return { label: "" };
    case "er":
      return { label: "", er: { cardA: "ZERO_OR_MORE", cardB: "ONLY_ONE", identifying: true } };
    case "class":
      return { label: "", cls: { left: "none", right: "dependency", dotted: false } };
    case "sequence":
      return { label: "message", seq: { op: "->>" } };
    case "architecture":
      return {
        label: "",
        arch: {
          lhsDir: "R",
          rhsDir: "L",
          lhsInto: false,
          rhsInto: true,
          lhsGroup: false,
          rhsGroup: false,
        },
      };
    case "c4":
      return { label: "Uses", c4: { relType: "rel", techn: "" } };
    case "requirement":
      return { label: "", req: { rel: "satisfies" } };
  }
}
