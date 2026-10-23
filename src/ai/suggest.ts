/**
 * What to ask, when nothing has been asked yet: a few requests built from
 * the diagram on screen — its own names in them — so the first one is a
 * click away and shows the kind of thing Generate does. An empty canvas
 * gets a few diagrams to start from instead.
 */
import type { MessageKey } from "../i18n";
import type { AnyNode, DiagramKind } from "../model/types";

export interface Suggestion {
  key: MessageKey;
  params?: Record<string, string>;
}

/** The nodes worth naming in a request: not groups, notes or junctions. */
function named(nodes: AnyNode[]): Array<{ label: string; shape?: string }> {
  return nodes
    .filter((n) => n.type !== "group" && n.type !== "note" && n.type !== "junction")
    .map((n) => {
      const data = n.data as { label?: unknown; shape?: unknown };
      const label = typeof data.label === "string" ? data.label.trim() : "";
      return { label, shape: typeof data.shape === "string" ? data.shape : undefined };
    })
    .filter((n) => n.label && n.label.length <= 40);
}

/** Up to three requests to offer for this diagram. */
export function suggestions(kind: DiagramKind, nodes: AnyNode[]): Suggestion[] {
  const all = named(nodes);
  if (all.length === 0) {
    return [
      { key: "ai.suggestStartLogin" },
      { key: "ai.suggestStartShop" },
      { key: "ai.suggestStartOrder" },
    ];
  }
  const out: Suggestion[] = [];
  if (kind === "flowchart") {
    // A store with no cache in its name: "a cache in front of Cache" says nothing.
    const db = all.find((n) => n.shape === "cylinder" && !/cache/i.test(n.label));
    const step = all.find((n) => n.shape === "square" || n.shape === "round") ?? all[0];
    const decision = all.find((n) => n.shape === "diamond");
    if (db) out.push({ key: "ai.suggestCache", params: { node: db.label } });
    out.push({ key: "ai.suggestRetry", params: { node: step.label } });
    if (decision) out.push({ key: "ai.suggestOutcome", params: { node: decision.label } });
    out.push({ key: "ai.suggestColour", params: { node: (all.at(-1) ?? step).label } });
  } else {
    out.push({ key: "ai.suggestConnect", params: { node: all[0].label } });
    out.push({ key: "ai.suggestRemove", params: { node: (all.at(-1) ?? all[0]).label } });
  }
  return out.slice(0, 3);
}
