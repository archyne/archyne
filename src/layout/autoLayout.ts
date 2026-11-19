import type { ElkNode } from "elkjs/lib/elk-api";
import type ELKType from "elkjs/lib/elk-api";
import type { AnyNode, DiagramKind, Direction, FlowEdge } from "../model/types";
import { isGroup } from "../model/types";
import { measureNode } from "../measureNode";
import type { PositionMap } from "../model/positions";
import { betterScore, layoutScore, placedNodes, type Score } from "./choose";

type Elk = InstanceType<typeof ELKType>;

// ELK's engine is ~1.4 MB — load it only when a layout is requested.
let elkPromise: Promise<Elk> | null = null;

/** A one-node graph is instant; anything slower means the worker is not there. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Layout in a worker, falling back to the main thread.
 *
 * ELK is a GWT-compiled solver: a big graph pins a core for a second or more,
 * and on the main thread that is a frozen canvas — no repaint, no scroll, no
 * cancel. In a worker the UI stays live.
 *
 * Why the fallback stays:
 *
 *   - jsdom, under Vitest, has no `Worker` at all;
 *   - `worker-src` is a CSP directive, and index.html's policy is only the
 *     floor — a self-hoster or reverse proxy can send a narrower header, and
 *     the intersection wins. Auto-layout must not be what breaks.
 *
 * The Electron shell is *not* one of those cases, though it looks like it
 * should be: it loads the build over `file://` (`desktop/main.cjs` uses
 * `loadFile`), and Chromium blocks workers from file URLs in a browser — but
 * Electron does not. This was measured, in the packaged build, both ways; the
 * worker runs there. Don't "fix" that assumption in either direction without
 * re-measuring.
 *
 * Both paths produce byte-identical positions, so the fallback is invisible
 * beyond the pause it reintroduces.
 */
async function createElk(): Promise<Elk> {
  if (typeof Worker !== "undefined") {
    let elk: Elk | undefined;
    try {
      const [{ default: ELK }, { default: ElkWorker }] = await Promise.all([
        import("elkjs/lib/elk-api"),
        import("elkjs/lib/elk-worker.min.js?worker"),
      ]);
      elk = new ELK({ workerFactory: () => new ElkWorker() });
      // Constructing a worker can succeed and still never answer — a blocked
      // `file://` worker fails on its error event, not at `new Worker()`. So
      // prove a round-trip, and bound it, rather than trusting the constructor.
      await Promise.race([
        elk.layout({ id: "probe", children: [{ id: "n", width: 1, height: 1 }] }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("ELK worker did not respond")), PROBE_TIMEOUT_MS),
        ),
      ]);
      return elk;
    } catch (err) {
      elk?.terminateWorker();
      console.warn("ELK worker unavailable; laying out on the main thread instead.", err);
    }
  }
  const { default: BundledELK } = await import("elkjs/lib/elk.bundled.js");
  return new BundledELK();
}

function getElk() {
  if (!elkPromise) elkPromise = createElk();
  return elkPromise;
}

/**
 * The arrangements on offer, as ELK names them.
 *
 * All four are already in the bundle — the engine ships every algorithm it
 * has, so this costs nothing to add and would cost nothing to extend.
 *
 *   - **layered** puts the graph in ranks along one direction. It is what a
 *     flowchart is for, and it stays the default.
 *   - **rectpacking** packs the boxes into a compact rectangle instead of
 *     ranking them. On a drawing that is mostly containers — an imported
 *     architecture diagram, a set of subnets — it is the one that reads like
 *     the original, because the containers sit side by side rather than in a
 *     column.
 *   - **mrtree** is a tree, for a graph that branches out from one root.
 *   - **force** settles the nodes as if the connections were springs, which
 *     suits a densely connected graph with no obvious direction.
 *
 * A *style* is not a *direction*: `flowchart LR` is Mermaid's own syntax and
 * belongs to the document, and Mermaid has nothing to say about arrangement.
 * So this is chosen when the rearranging is asked for and is not remembered —
 * what the file keeps is the positions it produced, exactly as before.
 */
export const LAYOUT_STYLES = ["layered", "bands", "rectpacking", "mrtree", "force"] as const;

export type LayoutStyle = (typeof LAYOUT_STYLES)[number];

/**
 * What `autoLayout` can be asked for. The five named arrangements, or `auto`,
 * which draws the file in each of them and keeps the one that reads best —
 * the whole point of arranging a *particular* drawing rather than satisfying
 * the philosophy of arrangements in general.
 */
export type Arrangement = LayoutStyle | "auto";

/**
 * What each style asks of ELK, at the root and inside a container.
 *
 * Four of the five are a single ELK algorithm run over the whole graph, so
 * their entry is one line. **bands** is not an algorithm at all — it is a
 * shape, described to ELK a level at a time:
 *
 *   - a container holding boxes lays them out in a *row*, left to right;
 *   - a container holding containers *stacks* them, by packing them into a
 *     column so narrow that only one fits across;
 *   - and the hierarchy is laid out one level at a time (`SEPARATE_CHILDREN`)
 *     rather than flattened, because flattening is what discards a
 *     container's own idea of how its contents should sit.
 *
 * The shape is worth having a name for because it is the one an architecture
 * drawing arrives in: tiers as bands, the things in a tier side by side. It
 * is what a subnet diagram, a layered system diagram or a swimlane looks like
 * when a person draws it, and none of ELK's algorithms produces it on their
 * own — `layered` ranks by *connections*, and tiers that have no connections
 * between them all land in the same rank, side by side.
 *
 * Two details are what make it a swimlane rather than a stack of oddments.
 * `elk.expandNodes` widens every band to the container, so their edges line
 * up instead of ending wherever their contents happen to stop — a ragged
 * right margin is the difference between tiers and a pile. And `elk.priority`
 * fixes the order: left to itself the packer sorts the bands by size, which
 * put the data tier above the application tier that feeds it. Priority
 * descends with the order the containers appear in the document, so the
 * drawing keeps the order its author wrote.
 */
/**
 * ELK's layered algorithm, breaking cycles the way Mermaid's layout does.
 *
 * A graph with a loop in it has to have one connection of the loop turned
 * round before it can be put in ranks, and which one decides the picture.
 * ELK's default is greedy: it reverses whatever leaves the fewest reversed,
 * counting connections rather than following them. In an order-handling flow
 * with an inventory check whose "no" branch goes off to a backorder process
 * and comes back, it turned round the way *out* — so the backorder process,
 * which the inventory check feeds, was drawn above it, and the line into it
 * climbed back up the page. Dagre, which draws the Mermaid preview, walks the
 * graph depth first from where it starts and turns round the connection that
 * leads back to somewhere already visited — the one coming back, which is the
 * one an author thinks of as going backwards. Depth first here gives the same
 * order the preview has.
 *
 * And trying harder to keep lines from crossing. `thoroughness` is how many
 * times ELK reshuffles each rank looking for fewer crossings, and its default
 * of 7 settled, in the same order flow, on a lane for the long line from
 * payment to fraud checking that the line from a refused payment to the end
 * then had to cross — a crossing Mermaid's preview does not have. At 15 it
 * found the other arrangement; 25 is that with room to spare, and on a
 * diagram of that size costs no time anyone would notice.
 */
const LAYERED: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
  "elk.layered.thoroughness": "25",
};

/**
 * Containers, one above the other and all the same width.
 *
 * An aspect ratio this narrow leaves room for one band across, so the packer
 * has no choice but to make a column of them; `expandNodes` then widens each
 * to the container so their edges line up, which is the difference between
 * tiers and a pile.
 */
const STACKED: Record<string, string> = {
  "elk.algorithm": "box",
  "elk.aspectRatio": "0.05",
  "elk.box.packingMode": "SIMPLE",
  "elk.expandNodes": "true",
};

/**
 * The `layered` arrangement, when the drawing nests containers.
 *
 * Flat `INCLUDE_CHILDREN` is right for a flowchart whose subgraphs sit in one
 * level: a connection may run *through* a subgroup, and ranking the whole thing
 * at once is what keeps the chain straight. It is the wrong model for an
 * architecture drawing — a VPC holding subnets holding services — where a
 * nested group is a boundary, not a corridor. Flattened, the VPC's inner ranks
 * spread it across the whole page so the box ends up taller than the diagram,
 * the boxes outside it hang in a corner, and a connection from one container
 * to a service inside the next cuts straight through the subnet it should be
 * passing next to.
 *
 * So when a container nests containers, the hierarchy is kept: the top level
 * still ranks (`layered`), but each container lays out its own contents in its
 * own frame (`SEPARATE_CHILDREN`), and a container that holds containers stacks
 * them as bands in the order they were written. Edges between containers then
 * meet at the boundary instead of dashing through a neighbouring subnet.
 */
const NESTED_LAYERED: {
  root: (holdsGroups: boolean) => Record<string, string>;
  group?: (holdsGroups: boolean, order: number, nested: boolean) => Record<string, string>;
} = {
  root: () => ({ "elk.hierarchyHandling": "SEPARATE_CHILDREN", ...LAYERED }),
  group: (holdsGroups, order, nested): Record<string, string> => ({
    // Only inside a container: the top level must keep ranking by its edges,
    // and a priority here would pull a tier up to where the entry chain sits.
    ...(nested ? { "elk.priority": String(1000 - order) } : {}),
    ...(holdsGroups ? STACKED : LAYERED),
  }),
};

const ELK_OPTIONS: Record<
  LayoutStyle,
  {
    /**
     * `holdsGroups` says whether the level being laid out contains containers.
     * The top level is a level like any other — a diagram whose subgraphs sit
     * at the top of the file, which is how most of them are written, has to
     * band them exactly as it would band subnets inside a VPC.
     */
    root: (holdsGroups: boolean) => Record<string, string>;
    /** `order` is the container's place among its siblings, first at zero. */
    group?: (holdsGroups: boolean, order: number, nested: boolean) => Record<string, string>;
  }
> = {
  layered: {
    root: () => ({ ...LAYERED, "elk.hierarchyHandling": "INCLUDE_CHILDREN" }),
  },
  rectpacking: {
    root: () => ({
      "elk.algorithm": "rectpacking",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    }),
  },
  mrtree: {
    root: () => ({ "elk.algorithm": "mrtree", "elk.hierarchyHandling": "INCLUDE_CHILDREN" }),
  },
  force: {
    root: () => ({ "elk.algorithm": "force", "elk.hierarchyHandling": "INCLUDE_CHILDREN" }),
  },
  bands: {
    root: (holdsGroups) => ({
      "elk.hierarchyHandling": "SEPARATE_CHILDREN",
      ...(holdsGroups ? STACKED : LAYERED),
    }),
    group: (holdsGroups, order): Record<string, string> => ({
      // Descending, because ELK places the most important first and the
      // containers should come out in the order they were written.
      "elk.priority": String(1000 - order),
      ...(holdsGroups ? STACKED : { ...LAYERED, "elk.direction": "RIGHT" }),
    }),
  },
};

/**
 * How far apart things are put: between ranks, and between neighbours in one.
 *
 * Given to every container as well as to the top level. ELK reads each
 * container's own options for laying out what is in it, so set at the top
 * alone it applied between the subgraphs and nowhere inside them, where ELK's
 * own default of 20 left a decision diamond and the boxes it branches to with
 * no room between them. A connection with no room to come out of the bottom of
 * one and go into the top of the next left sideways and hooked into the side
 * of its target, and the lines passing through a subgraph had to squeeze
 * between boxes or run along their edges. Mermaid's own layout spaces the
 * inside of a subgraph as it spaces everything else.
 */
const SPACING: Record<string, string> = {
  "elk.layered.spacing.nodeNodeBetweenLayers": "70",
  "elk.spacing.nodeNode": "40",
  // Room for the lines, as well as the boxes. ELK keeps ten units between two
  // lines running side by side, and between a line and a box, which at the
  // zoom a whole diagram is seen at is three pixels: two connections down one
  // corridor read as one, and the boxes were placed with no corridor wide
  // enough to part them. Twenty gives every line a lane of its own, and in an
  // order-handling flow of eight subgraphs took the crossings from six to one.
  "elk.spacing.edgeNode": "20",
  "elk.spacing.edgeEdge": "20",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
};

const ELK_DIRECTION: Record<Direction, string> = {
  TD: "DOWN",
  TB: "DOWN",
  BT: "UP",
  LR: "RIGHT",
  RL: "LEFT",
};

/**
 * The direction an architecture file has already stated, in the only way it
 * can state one.
 *
 * `architecture-beta` has no direction statement. What it has instead is a
 * side on every end of every edge — `web:R --> L:db` says web's right face
 * meets db's left face, which is to say db stands to the right of web. Laid
 * out downwards anyway, that edge has to leave rightwards, drop past the
 * target and come back into its left face, passing behind the very node it
 * points at: the starter diagram arrived with its one arrow apparently
 * detached, ending on one side of the box while the arrowhead sat on the
 * other. The sides were the layout, and the layout was ignoring them.
 *
 * The dominant axis decides, because one graph gets one direction: a file
 * that is mostly a left-to-right chain lays out left to right even if a
 * service or two hangs below. Files with no sides at all — every other
 * family — answer null and keep the direction they came with.
 */
export function statedDirection(edges: FlowEdge[]): Direction | null {
  let across = 0;
  let down = 0;
  for (const e of edges) {
    for (const side of [e.data?.arch?.lhsDir, e.data?.arch?.rhsDir]) {
      if (side === "L" || side === "R") across++;
      else if (side === "T" || side === "B") down++;
    }
  }
  if (across === 0 && down === 0) return null;
  return across >= down ? "LR" : "TB";
}

/**
 * Compute positions for every node with one of ELK's algorithms. Groups
 * become ELK hierarchy nodes, so child coordinates come back parent-relative
 * — exactly what React Flow expects.
 *
 * The spacing options below are named for the layered algorithm and ignored
 * by the others, which is ELK's own convention for options that do not apply.
 *
 * `style` can be `auto`, which runs every arrangement on the file and keeps
 * the one that reads best (see `choose.ts` for what "reads best" means, and
 * the scanner it takes to decide). `kind` is only read when the decision is
 * being made, and matters because routing — part of the scoring — is drawn
 * differently by family.
 *
 * The return carries the arrangement that actually produced the positions,
 * because `auto` hides it: asking who won is the only way the caller can tell
 * the user what they are looking at.
 */
export async function autoLayout(
  nodes: AnyNode[],
  edges: FlowEdge[],
  direction: Direction,
  style: Arrangement = "layered",
  kind: DiagramKind = "flowchart",
): Promise<{ positions: PositionMap; arranged: LayoutStyle; routes: Routes }> {
  if (style === "auto") {
    const { positions, winner, routes } = await chooseLayout(nodes, edges, direction, kind);
    return { positions, arranged: winner, routes };
  }
  const childrenOf = new Map<string | undefined, AnyNode[]>();
  for (const n of nodes) {
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }

  /** Where each node sits among its siblings, for the styles that care. */
  const order = new Map<string, number>();
  for (const list of childrenOf.values()) list.forEach((n, i) => order.set(n.id, i));

  /**
   * A container that holds containers is an architecture, not a flowchart, so
   * it keeps its hierarchy instead of being ranked flat. The others — and
   * `layered` on a plain flowchart — get the algorithm they always had.
   */
  const nested =
    style === "layered" &&
    // Stacked tiers are a vertical idea — the top edge enters the first tier
    // and drops through the rest. In a drawing that reads sideways the same
    // move would fight the author's stated direction: the containers would
    // still stack as a column, boxing in whatever an LR file put east of them.
    // Those stay flat, which is how they already sat before any of this.
    ["DOWN", "UP"].includes(ELK_DIRECTION[statedDirection(edges) ?? direction]) &&
    // A flowchart whose subgraphs nest — a VPC holding subnets. An
    // architecture drawing nests too, but every one of its edges says which
    // side meets which, and only flat ranking lets the engine honour that; the
    // per-level pass would have to guess where a connection may leave, and a
    // guess is a corner that shouldn't be there.
    !edges.some((e) => e.data?.arch) &&
    nodes.some((n) => isGroup(n) && (childrenOf.get(n.id) ?? []).some(isGroup));
  const opts = nested ? NESTED_LAYERED : ELK_OPTIONS[style];

  const toElk = (n: AnyNode): ElkNode => {
    if (isGroup(n)) {
      const children = childrenOf.get(n.id) ?? [];
      return {
        id: n.id,
        children: children.map(toElk),
        layoutOptions: {
          "elk.padding": "[top=40,left=16,bottom=16,right=16]",
          ...SPACING,
          ...(opts.group?.(children.some(isGroup), order.get(n.id) ?? 0, !!n.parentId) ?? {}),
        },
      };
    }
    // The width the node already has, if it has one — so a node given a width
    // but no height is measured at that width rather than at its natural one.
    // This is the site where sizes decide the picture: ELK reserves exactly the
    // room it is told to, so a number that is wrong here is a diagram that is
    // wrong everywhere.
    const stated = n.measured?.width ?? n.width;
    const size = measureNode(n, undefined, stated);
    return {
      id: n.id,
      width: stated ?? size.width,
      height: n.measured?.height ?? n.height ?? size.height,
      ...(nested && n.parentId
        ? { layoutOptions: { "elk.priority": String(1000 - (order.get(n.id) ?? 0)) } }
        : {}),
    };
  };

  const top = childrenOf.get(undefined) ?? [];
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.direction": ELK_DIRECTION[statedDirection(edges) ?? direction],
      ...SPACING,
      ...opts.root(top.some(isGroup)),
    },
    children: top.map(toElk),
    edges: edges.map((e, i) => ({
      id: e.id || `e${i}`,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  // The flat layered arrangement routes every connection as well as placing
  // every box, and the two were worked out together: the boxes stand where
  // they do so that the lines have the lanes ELK gave them. Thrown away and
  // routed afresh, the lines took whatever way was shortest between the boxes
  // as placed, which is not the way the boxes were placed for — they ran down
  // one another's lanes and crossed where ELK had kept them apart. So for this
  // arrangement the routes come back too, in the diagram's own coordinates,
  // and are kept as the connections' corners.
  const elk = await getElk();
  const routed = style === "layered" && !nested;
  if (routed) graph.layoutOptions = { ...graph.layoutOptions, "elk.json.edgeCoords": "ROOT" };
  const result = await elk.layout(graph);
  const routes: Record<string, Array<{ x: number; y: number }>> = {};
  if (routed) {
    const byElkId = new Map(edges.map((e, i) => [e.id || `e${i}`, e]));
    for (const r of result.edges ?? []) {
      const edge = byElkId.get(r.id);
      const section = r.sections?.length === 1 ? r.sections[0] : undefined;
      if (!edge || !section || edge.source === edge.target) continue;
      const bends = section.bendPoints ?? [];
      if (bends.length > 0) routes[edge.id] = bends.map((p) => ({ x: p.x, y: p.y }));
    }
  }
  const positions: PositionMap = {};
  const collect = (elkNode: ElkNode, isRoot: boolean) => {
    if (!isRoot) {
      positions[elkNode.id] = {
        x: elkNode.x ?? 0,
        y: elkNode.y ?? 0,
        ...(elkNode.children?.length ? { w: elkNode.width ?? 0, h: elkNode.height ?? 0 } : {}),
      };
    }
    for (const c of elkNode.children ?? []) collect(c, false);
  };
  collect(result, true);
  return { positions, arranged: style, routes };
}

/** The connections with the corners an arrangement routed them through. */
export function withRoutes(edges: FlowEdge[], routes: Routes): FlowEdge[] {
  return edges.map((e) => {
    const corners = routes[e.id];
    const style = e.data?.style?.route ?? "orthogonal";
    if (style !== "orthogonal" || e.source === e.target) {
      return e.data?.points?.length ? { ...e, data: { ...e.data, points: [] } } : e;
    }
    const points = (corners ?? []).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    if (points.length === 0 && !e.data?.points?.length) return e;
    return { ...e, data: { ...(e.data ?? { label: "" }), points } };
  });
}

/**
 * Draw the file in every arrangement and keep the one that reads best.
 *
 * The whole point of `auto` is that the shapes are all on the table, so every
 * one of them runs and the winner is the one with the best score (see
 * `choose.ts`). Each run is guarded: an arrangement the solver boggles at must
 * not take the rest down with it, and the best that *did* run wins. Ties keep
 * the first arrangement in the list, so the same file always picks the same
 * arrangement — and, because ELK is deterministic, lands on the same
 * positions every time.
 */
async function chooseLayout(
  nodes: AnyNode[],
  edges: FlowEdge[],
  direction: Direction,
  kind: DiagramKind,
): Promise<{ positions: PositionMap; winner: LayoutStyle; routes: Routes }> {
  let winner: {
    score: Score;
    positions: PositionMap;
    style: LayoutStyle;
    routes: Routes;
  } | null = null;
  for (const style of LAYOUT_STYLES) {
    let laid: { positions: PositionMap; routes: Routes };
    try {
      laid = await autoLayout(nodes, edges, direction, style, kind);
    } catch (err) {
      console.warn(`auto arrangement skipped ${style}:`, err);
      continue;
    }
    // The solver runs in a worker; the judging does not, and five of them
    // back to back held the window still for seconds with the notice that
    // something was happening unable to turn. A breath between them lets it.
    await new Promise((resolve) => setTimeout(resolve));
    // Judged as it will be drawn: with the corners this arrangement gives the
    // connections, and none of the ones they have now. Rearranging drops
    // those — they belong to the layout being replaced — and judged with them
    // every line set off for a corner where its node used to be.
    const drawn = withRoutes(edges, laid.routes);
    const score = layoutScore(placedNodes(nodes, laid.positions), drawn, kind);
    if (!winner || betterScore(score, winner.score)) winner = { score, style, ...laid };
  }
  if (!winner) throw new Error("no arrangement produced a layout");
  return { positions: winner.positions, winner: winner.style, routes: winner.routes };
}

/** The corners an arrangement routed each connection through, by edge id. */
export type Routes = Record<string, Array<{ x: number; y: number }>>;
