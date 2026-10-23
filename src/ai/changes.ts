/**
 * What an answer changed in the diagram, so the conversation can say it and
 * the canvas can show it: a turn that only reported "applied" left the
 * reader to find the difference by eye.
 *
 * Both drawings are parsed the way the canvas parses them; the comparison is
 * by node id (Mermaid's own, which an edit keeps) and by connection end to
 * end. A label that changed on a node that stayed is a rename.
 */
import { parseDiagram } from "../model/diagram";
import type { AnyNode, FlowEdge } from "../model/types";

export interface NodeChange {
  id: string;
  label: string;
}

export interface EdgeChange {
  source: string;
  target: string;
  /** The ends' labels, for saying it; the ids are for finding it. */
  from: string;
  to: string;
  label: string;
}

export interface DiagramChanges {
  addedNodes: NodeChange[];
  removedNodes: NodeChange[];
  renamedNodes: Array<NodeChange & { was: string }>;
  addedEdges: EdgeChange[];
  removedEdges: EdgeChange[];
}

/** What a node is called on the canvas: its label, else its id. */
function nameOf(node: AnyNode | undefined, id: string): string {
  const data = node?.data as { label?: unknown } | undefined;
  const label = typeof data?.label === "string" ? data.label.trim() : "";
  return label || id;
}

function edgeKey(e: FlowEdge): string {
  return JSON.stringify([e.source, e.target, (e.data?.label ?? "").trim()]);
}

/**
 * The changes from one drawing to the next, or null when they cannot be
 * compared — either does not parse, or the diagram changed kind.
 */
export async function diagramChanges(
  before: string,
  after: string,
): Promise<DiagramChanges | null> {
  let a, b;
  try {
    [a, b] = await Promise.all([parseDiagram(before), parseDiagram(after)]);
  } catch {
    return null;
  }
  if (a.kind !== b.kind) return null;
  return compare(a.nodes, a.edges, b.nodes, b.edges);
}

/** The comparison itself, apart from parsing, for the tests. */
export function compare(
  beforeNodes: AnyNode[],
  beforeEdges: FlowEdge[],
  afterNodes: AnyNode[],
  afterEdges: FlowEdge[],
): DiagramChanges {
  const was = new Map(beforeNodes.map((n) => [n.id, n]));
  const now = new Map(afterNodes.map((n) => [n.id, n]));
  const name = (id: string) => nameOf(now.get(id) ?? was.get(id), id);

  const addedNodes: NodeChange[] = [];
  const renamedNodes: Array<NodeChange & { was: string }> = [];
  for (const [id, node] of now) {
    const old = was.get(id);
    if (!old) addedNodes.push({ id, label: nameOf(node, id) });
    else if (nameOf(old, id) !== nameOf(node, id)) {
      renamedNodes.push({ id, label: nameOf(node, id), was: nameOf(old, id) });
    }
  }
  const removedNodes = [...was]
    .filter(([id]) => !now.has(id))
    .map(([id, node]) => ({ id, label: nameOf(node, id) }));

  // Connections compared as a multiset: two identical arrows are two.
  const count = (edges: FlowEdge[]) => {
    const m = new Map<string, FlowEdge[]>();
    for (const e of edges) m.set(edgeKey(e), [...(m.get(edgeKey(e)) ?? []), e]);
    return m;
  };
  const describe = (e: FlowEdge): EdgeChange => ({
    source: e.source,
    target: e.target,
    from: name(e.source),
    to: name(e.target),
    label: (e.data?.label ?? "").trim(),
  });
  const diff = (from: Map<string, FlowEdge[]>, to: Map<string, FlowEdge[]>) =>
    [...from].flatMap(([key, list]) => list.slice(to.get(key)?.length ?? 0).map(describe));
  const beforeCount = count(beforeEdges);
  const afterCount = count(afterEdges);

  return {
    addedNodes,
    removedNodes,
    renamedNodes,
    addedEdges: diff(afterCount, beforeCount),
    removedEdges: diff(beforeCount, afterCount),
  };
}

/** Whether anything at all changed. */
export function hasChanges(c: DiagramChanges): boolean {
  return (
    c.addedNodes.length +
      c.removedNodes.length +
      c.renamedNodes.length +
      c.addedEdges.length +
      c.removedEdges.length >
    0
  );
}
