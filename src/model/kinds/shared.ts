import type { Direction } from "../types";

export function quote(label: string): string {
  return `"${label.replace(/"/g, "#quot;")}"`;
}

/**
 * A label as it was written, from the text Mermaid's parser hands back.
 *
 * Mermaid hides an entity in a label behind a placeholder while it parses —
 * `#quot;` becomes `ﬂ°quot¶ß`, `#34;` becomes `ﬂ°°34¶ß` — and turns it back
 * only when it renders. The parser's text is the placeholder, so a quoted
 * word in a node read `ﬂ°quot¶ßLogin failedﬂ°quot¶ß` on the canvas. Put
 * back, it is the `#quot;` that `quote` writes and the canvas draws as `"`.
 */
export function unplaceholder(text: string): string {
  return text.replace(/ﬂ°°(\d+)¶ß/g, "#$1;").replace(/ﬂ°(\w+)¶ß/g, "#$1;");
}

export function normalizeDirection(dir: unknown): Direction {
  const d = typeof dir === "string" ? dir.toUpperCase() : "TB";
  return d === "TB" || d === "TD" || d === "LR" || d === "RL" || d === "BT"
    ? (d as Direction)
    : "TB";
}

export function entriesOf(collection: unknown): Array<[string, Record<string, unknown>]> {
  if (collection instanceof Map) {
    return [...collection.entries()] as Array<[string, Record<string, unknown>]>;
  }
  if (collection && typeof collection === "object") {
    return Object.entries(collection as Record<string, Record<string, unknown>>);
  }
  return [];
}

/**
 * The inline styles a node carries, as a list, or nothing.
 *
 * Mermaid spells the field differently per family — `styles` in a state and
 * a class, `cssStyles` in an entity — and it is the same `style <id> …`
 * statement in every one of them, so it is read here rather than three times.
 */
export function stylesOf(v: Record<string, unknown>): { styles?: string[] } {
  const raw = (v.styles ?? v.cssStyles) as unknown;
  const list = Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
  return list.length ? { styles: list } : {};
}

/** `style a fill:#f9f,stroke:#333` — one line per node that has any. */
export function styleLines(
  nodes: Array<{ id: string; data: { styles?: string[] } }>,
  indent = "  ",
): string[] {
  return nodes
    .filter((n) => (n.data.styles?.length ?? 0) > 0)
    .map((n) => `${indent}style ${n.id} ${n.data.styles!.join(",")}`);
}
