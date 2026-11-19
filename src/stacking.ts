/**
 * Which things on the canvas are drawn over which.
 *
 * React Flow stacks a node one above the container it sits in, and leaves a
 * node in no container at the bottom. That is right for what a Mermaid layout
 * produces, where a box outside a subgraph never lies over one. A drawing
 * brought in from elsewhere keeps the places it was drawn at, and there a box
 * can straddle two swimlanes without belonging to either: "Invoice" in
 * draw.io's activity example sits across the line between Accounting and
 * Customer. It was in the document and nowhere on screen, under both lanes'
 * fill — and so was any connection between two such boxes that crossed a lane.
 *
 * A container is a backdrop for what is put on it, never a cover over what is
 * not. So every container keeps the depth React Flow gives it, one above the
 * container holding it, and everything else — boxes and connections alike —
 * is lifted above the deepest of them. Among themselves they keep the order
 * they always had.
 */
import type { Edge, Node } from "@xyflow/react";

/**
 * The nodes and edges with their stacking set, or the very same arrays when
 * there is no container for anything to be hidden under.
 */
export function stacked<N extends Node, E extends Edge>(
  nodes: N[],
  edges: E[],
): { nodes: N[]; edges: E[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const holders = new Set<string>();
  for (const n of nodes) if (n.parentId) holders.add(n.parentId);
  for (const n of nodes) if (n.type === "group") holders.add(n.id);
  if (holders.size === 0) return { nodes, edges };

  // How many containers deep the deepest one is: the root ones are 1.
  let levels = 0;
  for (const id of holders) {
    let depth = 1;
    for (let at = byId.get(id)?.parentId; at && depth < 64; at = byId.get(at)?.parentId)
      depth++;
    levels = Math.max(levels, depth);
  }

  const above = nodes.map((n) =>
    holders.has(n.id) || n.zIndex !== undefined ? n : { ...n, zIndex: levels },
  );
  // A connection with an end inside a container is raised by React Flow to
  // that end's own level, which is now `levels`. One between two boxes in no
  // container is not raised at all, so it is given the level outright.
  const inContainer = (id: string) => !!byId.get(id)?.parentId;
  const lifted = edges.map((e) =>
    e.zIndex !== undefined || inContainer(e.source) || inContainer(e.target)
      ? e
      : { ...e, zIndex: levels },
  );
  return { nodes: above, edges: lifted };
}
