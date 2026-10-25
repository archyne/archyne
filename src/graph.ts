/**
 * Turning a parse into a graph that can be drawn.
 *
 * Both of these used to live in `store.ts`, and both are pure: given the nodes
 * and edges a parse produced, they say where each node goes and which edges
 * have to be fanned apart. Nothing about either needs a store, a browser or a
 * React Flow instance — but `store.ts` reaches the workspace, which touches
 * `window` while it is evaluating, so a renderer could not call them without
 * booting the editor. Same reason `boxes.ts` exists.
 */
import type { AnyNode, DiagramKind, FlowEdge } from "./model/types";
import type { PositionMap } from "./model/positions";
import { readNodeStyles } from "./model/nodeStyle";
import { readWaypoints, waypointKeys } from "./model/waypoints";
import { readEdgeStyles } from "./model/edgeStyle";

/**
 * Mark edges that share a node pair (and, for architecture, the same
 * handles) so the canvas can fan them out instead of overlapping them.
 */
export function annotateParallel(kind: DiagramKind, edges: FlowEdge[]): FlowEdge[] {
  if (kind === "sequence") return edges; // messages are stacked by order
  const keyOf = (e: FlowEdge) =>
    `${[e.source, e.target].sort().join("~")}|${e.sourceHandle ?? ""}|${e.targetHandle ?? ""}`;
  const groups = new Map<string, string[]>();
  for (const e of edges) {
    const key = keyOf(e);
    groups.set(key, [...(groups.get(key) ?? []), e.id]);
  }
  return edges.map((e) => {
    // A hand-routed edge keeps its own route: bending one by hand is a more
    // specific instruction than "these two overlap, spread them apart". The
    // lane info goes with the fan-out, so it is dropped rather than left to
    // reappear if the corners are removed later.
    if (e.data?.points?.length) {
      if (e.type === "routed" && !e.data.par) return e;
      const data = { ...(e.data ?? { label: "" }) };
      delete data.par;
      return { ...e, type: "routed" as const, data };
    }
    const g = groups.get(keyOf(e))!;
    if (g.length < 2) {
      // No longer parallel (siblings deleted): strip the stale lane info
      // so the edge snaps back to a plain centered path.
      if (e.type !== "parallel" && !e.data?.par) return e;
      const data = { ...(e.data ?? { label: "" }) };
      delete data.par;
      return { ...e, type: "routed", data };
    }
    return {
      ...e,
      type: "parallel",
      data: {
        ...(e.data ?? { label: "" }),
        // s normalizes the perpendicular offset for opposite-direction
        // edges so they land on distinct lanes, not the same one.
        par: { i: g.indexOf(e.id), n: g.length, s: e.source <= e.target ? 1 : -1 },
      },
    };
  });
}

/** Assign stored/cascade positions to bare nodes. */
export function placeNodes(
  nodes: AnyNode[],
  positions: PositionMap,
  kind: DiagramKind,
): AnyNode[] {
  if (kind === "sequence") {
    // Participants live on a single top row; x order = participant order.
    let col = 0;
    return nodes.map((n) => {
      const p = positions[n.id];
      const x = p?.x ?? col * 220;
      col++;
      return { ...n, position: { x, y: 0 } };
    });
  }
  const placed = Object.values(positions);
  let cascadeX = placed.length > 0 ? Math.max(...placed.map((p) => p.x)) + 260 : 0;
  let cascadeY = 0;
  return nodes.map((n) => {
    const p = positions[n.id];
    if (!p) {
      const pos = { x: cascadeX, y: cascadeY };
      cascadeY += 110;
      if (cascadeY > 660) {
        cascadeY = 0;
        cascadeX += 260;
      }
      return { ...n, position: pos };
    }
    return {
      ...n,
      position: { x: p.x, y: p.y },
      // React Flow reads the explicit dimensions off both places, and the
      // node views read `width`/`height` to draw themselves at the right
      // size, so both are set rather than one being derived later.
      ...(p.w !== undefined && p.h !== undefined
        ? { style: { ...n.style, width: p.w, height: p.h }, width: p.w, height: p.h }
        : {}),
    };
  });
}

/**
 * What a document's own comments say about its drawing, put back onto a
 * fresh parse: how each node is drawn, and each connection's corners and
 * style.
 *
 * They live in comments keyed by id and by endpoints, because a re-parse
 * replaces the node and edge objects and nothing on them survives. The
 * editor matched them back on; the import preview and `archyne-render` did
 * not, so the same file drew its connections without their corners — routed
 * from scratch, differently from the canvas it was about to be opened on.
 * One function now, for all three.
 */
export function withStoredLooks(
  code: string,
  nodes: AnyNode[],
  edges: FlowEdge[],
): { nodes: AnyNode[]; edges: FlowEdge[] } {
  const looks = readNodeStyles(code);
  const styled = looks
    ? nodes.map((n) =>
        looks[n.id] ? ({ ...n, data: { ...n.data, style: looks[n.id] } } as AnyNode) : n,
      )
    : nodes;

  const stored = readWaypoints(code);
  const styles = readEdgeStyles(code);
  if (!stored && !styles) return { nodes: styled, edges };
  const keys = waypointKeys(edges);
  const routed = edges.map((e) => {
    const key = keys.get(e.id)!;
    const points = stored?.[key];
    const style = styles?.[key];
    if (!points && !style) return e;
    return {
      ...e,
      data: {
        ...(e.data ?? { label: "" }),
        ...(points ? { points } : {}),
        ...(style ? { style } : {}),
      },
    };
  });
  return { nodes: styled, edges: routed };
}
