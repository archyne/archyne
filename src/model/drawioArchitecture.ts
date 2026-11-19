/**
 * Reading a draw.io **cloud architecture** drawing as `architecture-beta`.
 *
 * A VPC with subnets and a database is not a flowchart, and converting it to
 * one throws away the thing that makes it readable: the icons. Archyne has an
 * architecture editor with 16 600 vendor icons in it, so the shape *stencil*
 * a cell was drawn with — `mxgraph.aws4.rds`, `mxgraph.azure.sql_database` —
 * is worth far more than the rectangle it would otherwise become.
 *
 * The mapping is: a container becomes a `group`, everything else a `service`,
 * the stencil name becomes an icon, and the geometry decides which side of
 * each service a connection leaves from — `architecture-beta` has no
 * coordinates, so the relative positions are all the layout information that
 * can survive, and they survive as the anchors.
 */
import type { AnyNode, ArchDir, FlowEdge, GroupNode, ServiceNode } from "./types";
import { measureNode } from "../measureNode";
import { serializeArchitecture } from "./kinds/architecture";
import { positionsLine, type PositionMap } from "./positions";
import { idFactory } from "./importShared";

/**
 * Stencil and label fragments, and the icon each suggests.
 *
 * Ordered: the first hit wins, so the specific names come before the generic
 * ones. The five built-ins are the fallbacks; everything else is an Iconify
 * name that Archyne already bundles.
 */
const ICONS: Array<[RegExp, string]> = [
  // No trailing word boundary on the long names: a stencil is
  // `elastic_load_balancing` and a label is `PostgreSQL`, and both would
  // slip past a pattern that insisted the word ended where the token does.
  // No leading boundary: the stencil is `group_vpc`, and `_` is a word
  // character, so `\bvpc` would never match the very name this is for.
  [/(vpc|virtual.?network|vnet)\b/i, "cloud"],
  [/\b(internet|user|client|browser|mobile|cdn|cloudfront|route.?53|dns)/i, "internet"],
  [/\b(s3|bucket|blob|storage|disk|volume|ebs|efs)/i, "disk"],
  [
    /\b(rds|aurora|postgres|mysql|sql|dynamo|mongo|cosmos|database|redis|cache|elasticache)/i,
    "database",
  ],
  [/\bdb\b/i, "database"],
  [/\b(lambda|serverless)|\bfunction/i, "logos:aws-lambda"],
  [/\b(sqs|sns|kafka|rabbit|queue|topic|event.?bus|pubsub)/i, "logos:aws-sqs"],
  [/\bapi.?gateway/i, "logos:aws-api-gateway"],
  [/(load.?balanc|\belb\b|\balb\b|\bnlb\b|\bingress)/i, "logos:aws-elb"],
  [/\b(kubernetes|k8s|eks|aks|gke)\b/i, "logos:kubernetes"],
  [/\b(docker|container)/i, "logos:docker-icon"],
  [/\b(ec2|vm|instance|compute|server|service|app)\b/i, "server"],
];

/**
 * The icon a cell should carry, from its stencil name and then its label.
 *
 * All three stencil attributes are read. draw.io's AWS shapes set `shape` to
 * the generic `mxgraph.aws4.resourceIcon` and put the *actual* service in
 * `resIcon` — so looking only at `shape` finds nothing on the very files this
 * exists for. Containers do the same with `grIcon`.
 */
export function iconFor(style: string, label: string): string {
  const stencil = [...style.matchAll(/(?:shape|resIcon|grIcon)=([\w.]+)/gi)]
    .map((m) => m[1])
    .join(" ");
  for (const [pattern, icon] of ICONS) {
    if (pattern.test(stencil)) return icon;
  }
  for (const [pattern, icon] of ICONS) {
    if (pattern.test(label)) return icon;
  }
  return "server";
}

/**
 * A label `architecture-beta` will accept.
 *
 * Its grammar takes letters, digits, spaces and underscores inside `[…]` and
 * nothing else — a slash, a dot, a comma, a colon, an ampersand or a bracket
 * all fail to parse, which is how `Amazon VPC (10.0.0.0/16)` took a whole
 * diagram down. A trailing parenthetical goes first, because dropping the
 * detail in brackets reads far better than spelling an IP address out as
 * separate words; whatever is left has the rest replaced by spaces.
 */
export function archLabel(text: string): string {
  const clean = (value: string) =>
    value
      .replace(/[^A-Za-z0-9 _]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  const flat = text.replace(/<br\s*\/?>/gi, " ");
  return clean(flat.replace(/\([^)]*\)/g, " ")) || clean(flat) || "node";
}

/** One cell, reduced to what an architecture diagram needs from it. */
export interface ArchCell {
  id: string;
  label: string;
  style: string;
  /** Absolute centre, for working out which side a connection leaves from. */
  centre: { x: number; y: number } | null;
  /** Parent-relative box, which is what the canvas stores. */
  box: { x: number; y: number; w: number; h: number } | null;
  parent: string | null;
  container: boolean;
}

export interface ArchEdgeIn {
  source: string;
  target: string;
  label: string;
  /** Whether each end carries an arrowhead. */
  intoSource: boolean;
  intoTarget: boolean;
}

/**
 * Which side of a shape a connection should leave from.
 *
 * `architecture-beta` anchors every connection to one of four sides rather
 * than routing it, so the honest reading of a drawing is the direction the
 * other end lies in — whichever of the two axes it differs on most.
 */
function sides(
  from: { x: number; y: number } | null,
  to: { x: number; y: number } | null,
): [ArchDir, ArchDir] {
  if (!from || !to) return ["R", "L"];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["R", "L"] : ["L", "R"];
  return dy >= 0 ? ["B", "T"] : ["T", "B"];
}

/** Build an `architecture-beta` document from the cells of a drawing. */
export function buildArchitecture(
  cells: ArchCell[],
  incoming: ArchEdgeIn[],
): { code: string; nodes: number; edges: number; dropped: number } {
  /**
   * `architecture-beta` has no coordinates, but Archyne's own layout comment
   * does — and it is read for every diagram family. So the drawing keeps the
   * arrangement it was made in, instead of being handed to a layout engine
   * that turns a wide picture into a tall column.
   */
  const positions: PositionMap = {};

  /**
   * How much room the arrangement needs, over what it had.
   *
   * A service is drawn as an icon with its name beneath it, which is taller
   * than the flat box the same thing occupied in draw.io. Keeping the
   * coordinates as they were therefore packed nodes into slots too small for
   * them and they overlapped — and spilled out of the subnet they belong to.
   * Stretching the whole coordinate space by the worst case keeps every
   * relationship in the drawing while giving each node the room it draws in.
   *
   * Each cell is measured with the name it actually carries rather than one
   * stand-in for all of them. That used to be a single constant, which quietly
   * assumed every node was the same size as every other; a long name makes a
   * wider node, and it is the widest one that decides whether the arrangement
   * still fits.
   */
  let scale = 1;
  for (const cell of cells) {
    if (cell.container || !cell.box) continue;
    const natural = measureNode({
      id: cell.id,
      type: "service",
      position: { x: 0, y: 0 },
      data: { label: archLabel(cell.label), icon: "", direction: "TB" },
    } as unknown as ServiceNode);
    scale = Math.max(
      scale,
      natural.width / Math.max(1, cell.box.w),
      natural.height / Math.max(1, cell.box.h),
    );
  }
  // `architecture-beta` ids must be lower case — the grammar rejects a
  // capital outright — so the label is folded before it becomes one, which
  // also makes the de-duplication case-insensitive. The label itself keeps
  // whatever case it was written in.
  // Named from the *cleaned* label, so the id and the words beside it agree:
  // `amazon_vpc`, not `amazon_vpc_10_0_0_0_16` next to "Amazon VPC".
  const naming = idFactory();
  const nextId = (label: string, fallback: string) => naming(label.toLowerCase(), fallback);
  const idOf = new Map<string, string>();
  const nodes: AnyNode[] = [];
  const centres = new Map<string, { x: number; y: number } | null>();
  const isGroupId = new Set<string>();

  // Containers first, outermost first, so a child finds its group named.
  const depth = (cell: ArchCell): number => {
    let n = 0;
    let at = cell.parent ? cells.find((c) => c.id === cell.parent) : undefined;
    while (at && n < 64) {
      n++;
      at = at.parent ? cells.find((c) => c.id === at!.parent) : undefined;
    }
    return n;
  };
  const parentOf = (cell: ArchCell) => (cell.parent ? idOf.get(cell.parent) : undefined);

  for (const cell of [...cells]
    .filter((c) => c.container)
    .sort((a, b) => depth(a) - depth(b))) {
    const id = nextId(archLabel(cell.label), `g${nodes.length + 1}`);
    idOf.set(cell.id, id);
    isGroupId.add(id);
    centres.set(id, cell.centre);
    const group: GroupNode = {
      id,
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        label: archLabel(cell.label),
        subgraphId: id,
        icon:
          iconFor(cell.style, cell.label) === "server"
            ? "cloud"
            : iconFor(cell.style, cell.label),
      },
      style: { width: 320, height: 220 },
      ...(parentOf(cell) ? { parentId: parentOf(cell) } : {}),
    };
    nodes.push(group);
    if (cell.box) {
      positions[id] = {
        x: cell.box.x * scale,
        y: cell.box.y * scale,
        w: cell.box.w * scale,
        h: cell.box.h * scale,
      };
    }
  }

  for (const cell of cells) {
    if (cell.container) continue;
    const id = nextId(archLabel(cell.label), `s${nodes.length + 1}`);
    idOf.set(cell.id, id);
    centres.set(id, cell.centre);
    const service: ServiceNode = {
      id,
      type: "service",
      position: { x: 0, y: 0 },
      data: {
        label: archLabel(cell.label),
        icon: iconFor(cell.style, cell.label),
        direction: "TB",
      },
      ...(parentOf(cell) ? { parentId: parentOf(cell) } : {}),
    };
    nodes.push(service);
    // Position only, never size: a service knows how much room its own name
    // needs, and forcing the draw.io box on to it cropped the name off almost
    // every one. Centred on where the box was, so growing it does not push
    // the arrangement to one side.
    if (cell.box) {
      // Centred on the size *this* node draws at, which is the node just
      // built rather than a stand-in for all of them.
      const natural = measureNode(service);
      positions[id] = {
        x: (cell.box.x + cell.box.w / 2) * scale - natural.width / 2,
        y: (cell.box.y + cell.box.h / 2) * scale - natural.height / 2,
      };
    }
  }

  /**
   * A connection that lands on a container is moved onto something inside it.
   *
   * Mermaid documents a `{group}` endpoint, but its own parser throws on one
   * — service to group, group to service and group to group all crash before
   * the diagram is built. Rather than emit a document that cannot be opened,
   * an edge touching a container is re-pointed at the first service within
   * it, which is a fair reading of a line drawn to the edge of a box.
   */
  const insideOf = (id: string): string | undefined => {
    if (!isGroupId.has(id)) return id;
    const children = nodes.filter((n) => n.parentId === id);
    for (const child of children) {
      if (child.type === "service") return child.id;
    }
    for (const child of children) {
      const deeper = insideOf(child.id);
      if (deeper && deeper !== child.id) return deeper;
    }
    return undefined;
  };

  const edges: FlowEdge[] = [];
  let dropped = 0;
  for (const edge of incoming) {
    const source = insideOf(idOf.get(edge.source) ?? "");
    const target = insideOf(idOf.get(edge.target) ?? "");
    if (!source || !target || source === target) {
      dropped++;
      continue;
    }
    const [lhsDir, rhsDir] = sides(centres.get(source) ?? null, centres.get(target) ?? null);
    edges.push({
      id: `a${edges.length}_${source}_${target}`,
      source,
      target,
      data: {
        label: edge.label ? archLabel(edge.label) : "",
        arch: {
          lhsDir,
          rhsDir,
          lhsInto: edge.intoSource,
          rhsInto: edge.intoTarget,
          // Never a group endpoint: mermaid's parser cannot read one back.
          lhsGroup: false,
          rhsGroup: false,
        },
      },
    });
  }

  const body = serializeArchitecture(nodes, edges);
  const layout = Object.keys(positions).length
    ? `${positionsLine(positions)}
`
    : "";
  return {
    code: `${body}${layout}`,
    nodes: nodes.length,
    edges: edges.length,
    dropped,
  };
}
