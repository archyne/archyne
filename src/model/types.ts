import type { Node, Edge } from "@xyflow/react";
import type { EdgeStyle } from "./edgeStyle";
import type { NodeStyle } from "./nodeStyle";

/** Diagram families the editor supports on the shared canvas. */
export type DiagramKind =
  "flowchart" | "state" | "er" | "class" | "sequence" | "architecture" | "c4";

/** Mermaid direction. */
export type Direction = "TD" | "TB" | "LR" | "RL" | "BT";

/**
 * Flowchart node shapes, named exactly as mermaid's flowchart parser names
 * vertex types so import/export round-trips without a mapping table.
 */
export const SHAPES = [
  "square",
  "round",
  "stadium",
  "subroutine",
  "cylinder",
  "circle",
  "doublecircle",
  "diamond",
  "hexagon",
  "odd",
  "trapezoid",
  "inv_trapezoid",
  "lean_right",
  "lean_left",
] as const;

export type Shape = (typeof SHAPES)[number];

export const SHAPE_LABELS: Record<Shape, string> = {
  square: "Process",
  round: "Rounded",
  stadium: "Terminator",
  subroutine: "Subroutine",
  cylinder: "Database",
  circle: "Circle",
  doublecircle: "Double circle",
  diamond: "Decision",
  hexagon: "Hexagon",
  odd: "Flag",
  trapezoid: "Trapezoid",
  inv_trapezoid: "Trapezoid alt",
  lean_right: "Input/Output",
  lean_left: "Output/Input",
};

export type EdgeStroke = "normal" | "dotted" | "thick";
export type ArrowType = "arrow_point" | "arrow_open" | "arrow_circle" | "arrow_cross";

/** State diagram node roles. */
export type StateType = "normal" | "start" | "end" | "choice" | "fork" | "join";

/** ER entity attribute, matching mermaid's parsed shape. */
export interface EntityAttr {
  type: string;
  name: string;
  keys: string[];
  comment: string;
}

/** ER relationship cardinalities, named as mermaid names them. */
export const ER_CARDS = ["ONLY_ONE", "ZERO_OR_ONE", "ZERO_OR_MORE", "ONE_OR_MORE"] as const;
export type ErCard = (typeof ER_CARDS)[number];
export const ER_CARD_LABELS: Record<ErCard, string> = {
  ONLY_ONE: "exactly 1",
  ZERO_OR_ONE: "0 or 1",
  ZERO_OR_MORE: "0..N",
  ONE_OR_MORE: "1..N",
};

/** Class relation end markers. */
export const CLASS_MARKERS = [
  "none",
  "extension",
  "composition",
  "aggregation",
  "dependency",
] as const;
export type ClassMarker = (typeof CLASS_MARKERS)[number];

/* ---------- node data ---------- */

/**
 * How big a picture on a node is drawn, in pixels, when nobody has said.
 *
 * A real number rather than "whatever the file says", because the file often
 * says nothing and the two renderers disagree about what that means: the
 * canvas fits the picture into the shape, while mermaid falls back to the
 * SVG's own intrinsic size — which for an icon set is around 16px.
 */
export const IMG_SIZE = 60;

/**
 * The type size a node label is drawn at when nobody has chosen one, in
 * pixels.
 *
 * Kept in step with `.shape-label` in the stylesheet by hand, there being no
 * import between the two. The inspector needs the number to know when a size
 * has stopped being a choice: back at the default, the `font-size`
 * declaration comes out of the file rather than being written down.
 */
export const LABEL_SIZE = 12;

export interface ShapeNodeData extends Record<string, unknown> {
  label: string;
  shape: Shape;
  direction: Direction;
  /** classDef names assigned via `class a,b name` or `a:::name`. */
  classes?: string[];
  /** Inline styles from a `style <id> ...` statement, e.g. "fill:#f9f". */
  styles?: string[];
  /**
   * A picture drawn on the node, as a URL — mermaid's image shape:
   *
   *   A@{ img: "https://…/aws.svg", label: "AWS", pos: "t", w: 60, h: 60 }
   *
   * The one form of icon that survives leaving Archyne. Every other kind is
   * a *name* that the tool doing the drawing must already have a pack for,
   * and the official Mermaid Live Editor registers none — so `logos:aws`
   * renders there as a "?" box while this renders as the logo.
   */
  img?: string;
  /** Which side of the picture the label sits on. Mermaid's default is "b". */
  imgPos?: "t" | "b";
  /** The size mermaid draws the picture at, in pixels. Default IMG_SIZE. */
  imgWidth?: number;
  imgHeight?: number;
  /**
   * Mermaid's `constraint: "on"`, which fixes the aspect ratio.
   *
   * Read on import, but not consulted when drawing or when writing an `img`
   * node back out: the canvas fits every picture with `object-fit: contain`,
   * so aspect ratio is always kept here, and the serializer says so. See
   * `pictureDecl` in `kinds/flowchart.ts` for why leaving it off is not an
   * option.
   */
  imgConstrained?: boolean;
  /**
   * Mermaid's `icon:` form, kept only so that re-serialising a file written
   * elsewhere does not throw it away. Archyne does not offer it: it names an
   * icon pack the reader may not have, which is the problem `img` solves.
   */
  icon?: string;
}

/** classDef name → style declarations ("fill:#f9f", "stroke:#333", …). */
export type ClassDefs = Record<string, string[]>;

export interface StateNodeData extends Record<string, unknown> {
  label: string;
  /**
   * Inline styles from a `style <id> ...` statement, e.g. "fill:#f9f".
   *
   * The same field, spelled the same way, as a flowchart shape's: mermaid
   * takes `style` in this family too, and a colour chosen here is a colour
   * every reader of the file draws with. Only the ones the diagram itself
   * can carry — `architecture-beta` has no `style` statement at all, which
   * is why a service has no such field to offer.
   */
  styles?: string[];
  stateType: StateType;
  direction: Direction;
}

export interface EntityNodeData extends Record<string, unknown> {
  label: string;
  /**
   * Inline styles from a `style <id> ...` statement, e.g. "fill:#f9f".
   *
   * The same field, spelled the same way, as a flowchart shape's: mermaid
   * takes `style` in this family too, and a colour chosen here is a colour
   * every reader of the file draws with. Only the ones the diagram itself
   * can carry — `architecture-beta` has no `style` statement at all, which
   * is why a service has no such field to offer.
   */
  styles?: string[];
  attributes: EntityAttr[];
  direction: Direction;
}

export interface ClassNodeData extends Record<string, unknown> {
  label: string;
  /**
   * Inline styles from a `style <id> ...` statement, e.g. "fill:#f9f".
   *
   * The same field, spelled the same way, as a flowchart shape's: mermaid
   * takes `style` in this family too, and a colour chosen here is a colour
   * every reader of the file draws with. Only the ones the diagram itself
   * can carry — `architecture-beta` has no `style` statement at all, which
   * is why a service has no such field to offer.
   */
  styles?: string[];
  members: string[];
  methods: string[];
  /** <<interface>>, <<abstract>>, … */
  annotations: string[];
  /** Generic parameter, e.g. "T" for List~T~. */
  generic?: string;
  direction: Direction;
}

/** Sequence-diagram message operators, as written in the syntax. */
export const SEQ_OPS = ["->>", "-->>", "->", "-->", "-x", "--x", "-)", "--)"] as const;
export type SeqOp = (typeof SEQ_OPS)[number];
export const SEQ_OP_LABELS: Record<SeqOp, string> = {
  "->>": "Solid arrow",
  "-->>": "Dotted arrow",
  "->": "Solid open",
  "-->": "Dotted open",
  "-x": "Solid cross",
  "--x": "Dotted cross",
  "-)": "Async",
  "--)": "Dotted async",
};

/** One row of a sequence diagram, in order. Messages reference edges. */
export type SeqItem =
  | { kind: "message"; edgeId: string }
  | { kind: "note"; placement: "left" | "right" | "over"; a: string; b?: string; text: string }
  | { kind: "block"; op: string; label: string }
  | { kind: "divider"; op: string; label: string }
  | { kind: "end" }
  | { kind: "active"; on: boolean; actor: string }
  | { kind: "autonumber" };

/** Free-floating note (class diagrams), optionally attached to a class. */
export interface NoteNodeData extends Record<string, unknown> {
  text: string;
  target?: string;
  direction: Direction;
}

export interface ParticipantNodeData extends Record<string, unknown> {
  label: string;
  ptype: "participant" | "actor";
  direction: Direction;
}

export interface GroupNodeData extends Record<string, unknown> {
  label: string;
  /** Original mermaid subgraph / composite-state id, kept for export. */
  subgraphId: string;
  /** Group icon (architecture diagrams), e.g. "cloud" or "logos:aws-vpc". */
  icon?: string;
  /** C4 boundary type: ENTERPRISE, SYSTEM, CONTAINER. */
  boundaryType?: string;
  /** How the container is drawn: dashed by default, solid, or a hairline. */
  style?: NodeStyle;
  /**
   * Its colours, as a flowchart's `style` statement gives them to a subgraph:
   * `fill:#dae8fc`, `stroke:#6c8ebf`, `color:` for its title.
   */
  styles?: string[];
}

/** C4 element node, typed as mermaid's typeC4Shape names them. */
export const C4_SHAPES = [
  "person",
  "external_person",
  "system",
  "external_system",
  "system_db",
  "system_queue",
  "container",
  "external_container",
  "container_db",
  "container_queue",
  "component",
  "external_component",
  "component_db",
  "component_queue",
  "external_system_db",
  "external_system_queue",
  "external_container_db",
  "external_container_queue",
  "external_component_db",
  "external_component_queue",
] as const;
export type C4Shape = (typeof C4_SHAPES)[number];

/**
 * What each C4 shape is called on the node, drawn in guillemets above the name.
 *
 * Here rather than beside the component that draws it because it is a fact
 * about the model, and because measurement needs it too: the tag is a line of
 * text inside the box, so a node's height depends on it, and `measureNode`
 * cannot import a React component to find out what it says. A shape with no
 * entry falls back to its own name.
 */
export const C4_TAGS: Record<string, string> = {
  person: "Person",
  external_person: "Person (ext)",
  system: "System",
  external_system: "System (ext)",
  system_db: "System DB",
  system_queue: "System Queue",
  container: "Container",
  external_container: "Container (ext)",
  container_db: "Container DB",
  container_queue: "Container Queue",
  component: "Component",
  external_component: "Component (ext)",
  component_db: "Component DB",
  component_queue: "Component Queue",
};

export interface C4NodeData extends Record<string, unknown> {
  label: string;
  c4Shape: C4Shape;
  descr: string;
  direction: Direction;
}

export interface C4EdgeInfo {
  /** mermaid rel type: rel, birel, rel_u, rel_d, rel_l, rel_r, rel_b. */
  relType: string;
  techn: string;
}

/** Architecture-beta service node. */
export interface ServiceNodeData extends Record<string, unknown> {
  label: string;
  /** How it is drawn: a box with the icon inside, or the icon alone. */
  style?: NodeStyle;
  /** Built-in name (cloud, database, disk, internet, server) or iconify "logos:aws-s3". */
  icon: string;
  direction: Direction;
}

/** Architecture-beta connection endpoints. */
export type ArchDir = "L" | "R" | "T" | "B";
export interface ArchEdgeInfo {
  lhsDir: ArchDir;
  rhsDir: ArchDir;
  /** Arrow pointing into the lhs / rhs endpoint. */
  lhsInto: boolean;
  rhsInto: boolean;
  /** Endpoint attaches to a group border rather than the node itself. */
  lhsGroup: boolean;
  rhsGroup: boolean;
}

export type ShapeNode = Node<ShapeNodeData, "shape">;
export type StateNode = Node<StateNodeData, "state">;
export type EntityNode = Node<EntityNodeData, "entity">;
export type ClassNode = Node<ClassNodeData, "class">;
export type ParticipantNode = Node<ParticipantNodeData, "participant">;
export type ServiceNode = Node<ServiceNodeData, "service">;
export type JunctionNode = Node<Record<string, unknown>, "junction">;
export type C4Node = Node<C4NodeData, "c4">;
export type NoteNode = Node<NoteNodeData, "note">;
export type GroupNode = Node<GroupNodeData, "group">;
export type AnyNode =
  | ShapeNode
  | StateNode
  | EntityNode
  | ClassNode
  | ParticipantNode
  | ServiceNode
  | JunctionNode
  | C4Node
  | NoteNode
  | GroupNode;

export function isGroup(n: AnyNode): n is GroupNode {
  return n.type === "group";
}

/* ---------- edge data ---------- */

export interface ErEdgeInfo {
  cardA: ErCard;
  cardB: ErCard;
  identifying: boolean;
}

export interface ClassEdgeInfo {
  left: ClassMarker;
  right: ClassMarker;
  dotted: boolean;
  card1?: string;
  card2?: string;
}

/**
 * One edge data shape for every kind; the kind-specific part is optional.
 * flowchart uses stroke/arrow, er uses `er`, class uses `cls`, state uses
 * only the label.
 */
export interface FlowEdgeData extends Record<string, unknown> {
  label: string;
  stroke?: EdgeStroke;
  arrow?: ArrowType;
  /** Flowchart: arrowheads at both ends (<-->, x--x, o--o). */
  both?: boolean;
  er?: ErEdgeInfo;
  cls?: ClassEdgeInfo;
  seq?: { op: SeqOp };
  arch?: ArchEdgeInfo;
  c4?: C4EdgeInfo;
  /** Set when several edges share the same node pair: index, count, and
   *  a direction-normalizing sign for the perpendicular offset. */
  par?: { i: number; n: number; s?: 1 | -1 };
  /** Corners the edge is routed through, in absolute canvas coordinates. */
  points?: Array<{ x: number; y: number }>;
  /** How it is presented: where its label sits, how it is routed. */
  style?: EdgeStyle;
}

export type FlowEdge = Edge<FlowEdgeData>;

/** What a palette item drops onto the canvas. */
export type NodeSeed =
  | { type: "shape"; shape: Shape }
  | { type: "state"; stateType: StateType }
  | { type: "entity" }
  | { type: "class" }
  | { type: "participant"; ptype: "participant" | "actor" }
  | { type: "service"; icon: string }
  | { type: "junction" }
  | { type: "c4"; c4Shape: C4Shape }
  // An icon on a group is how a VNet, a VPC or a subscription is drawn:
  // a container that says what it is. Optional, since most groups are just
  // groups.
  | { type: "group"; icon?: string }
  | { type: "note" }
  | { type: "seqnote" }
  | { type: "seqblock"; op: "loop" | "alt" | "opt" };

/* ---------- sizing ---------- */

export function defaultSize(shape: Shape): { width: number; height: number } {
  switch (shape) {
    case "circle":
    case "doublecircle":
      return { width: 96, height: 96 };
    case "diamond":
      return { width: 150, height: 86 };
    default:
      return { width: 160, height: 54 };
  }
}

/**
 * A picture does not change the box.
 *
 * Mermaid's image shape carries a `w`/`h` for the picture, and the obvious
 * reading is that the node grows around it — but a diagram is a set of boxes
 * whose sizes are the author's, and having one silently become two thirds
 * taller because of the file it points at is not a size anybody chose. The
 * picture is fitted into the shape instead (`.shape-image` in the
 * stylesheet), and a node that should be bigger is resized like any other.
 *
 * Unless there is no box. A picture with its frame switched off has nothing
 * to be fitted into, and a 160×54 rectangle around a 60px logo is not a box
 * the author chose either — it is the absence of one, drawn at the default
 * size. So that node is the size of what it shows, which is also how mermaid
 * draws it and how a bare service node has always behaved here.
 */

/**
 * Whether a node's own style takes the frame off it: `fill:none` together
 * with `stroke:none`, which is what the inspector's "No frame" writes.
 *
 * Only the node's own declarations, not any classDef it also carries. The
 * canvas resolves both (`styleProps` in `ShapeNode`) and passes the result
 * in; this reading is for the callers that have the model and not the
 * stylesheet.
 */
export function isFrameless(styles: string[] | undefined): boolean {
  const says = (key: string) => styles?.some((s) => s.replace(/\s+/g, "") === `${key}:none`);
  return Boolean(says("fill") && says("stroke"));
}

/** The type size a node's own style asks for, in pixels, or the default. */
export function labelSize(styles: string[] | undefined): number {
  const d = (styles ?? []).find((s) => s.trim().startsWith("font-size:"));
  const m = /^(\d+(?:\.\d+)?)px$/.exec(d?.slice(d.indexOf(":") + 1).trim() ?? "");
  return m ? Number(m[1]) : LABEL_SIZE;
}

/*
 * `estimateSize` used to live here: one constant per node type — 150×46 for
 * any state, a flat 210 wide for every entity and class — as the size to lay
 * out with before the browser had measured anything.
 *
 * It is gone, and `measureNode` in `src/measureNode.ts` answers instead, by
 * measuring the text the node actually carries. The constants were harmless
 * while the only consumer was an editor that re-measured a frame later; they
 * stop being harmless the moment something has to draw the diagram without a
 * browser, because then the guess is the final answer. The floors those
 * constants encoded did not disappear — `defaultSize` above still holds the
 * ones that are real, and the rest came from the stylesheet.
 */
