/**
 * Which family a diagram belongs to, read off the top of its source.
 *
 * The parser answers this properly, but it answers for *one* document — the
 * open one — and the tab strip has to label every document it lists without
 * opening any of them. Parsing each in turn to put a two-letter badge on a
 * tab would be absurd; the first word of a Mermaid file already says it.
 *
 * Deliberately forgiving and deliberately shallow: it reads a header, not a
 * diagram. Anything it does not recognise is nothing, and the tab simply goes
 * unlabelled rather than mislabelled.
 */
import type { DiagramKind } from "./types";

/** The header each family begins with, longest first so `graph` cannot win. */
const HEADERS: Array<[RegExp, DiagramKind]> = [
  [/^architecture-beta\b/, "architecture"],
  [/^sequenceDiagram\b/, "sequence"],
  [/^stateDiagram(-v2)?\b/, "state"],
  [/^classDiagram(-v2)?\b/, "class"],
  [/^erDiagram\b/, "er"],
  [/^C4(Context|Container|Component|Dynamic|Deployment)\b/, "c4"],
  [/^(flowchart|graph)\b/, "flowchart"],
];

/** Whether one (trimmed) line is a header the editor knows. */
export function isHeaderLine(line: string): boolean {
  return HEADERS.some(([pattern]) => pattern.test(line));
}

/**
 * The family, or null when the source says nothing recognisable.
 *
 * Skips blank lines, comments and the front matter a Mermaid file may carry,
 * because the header is not always the first character of the file.
 */
export function sniffKind(code: string): DiagramKind | null {
  const lines = code.split("\n");
  let inFrontMatter = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // `---` fences a YAML block at the very top; everything until the closing
    // fence is configuration rather than diagram.
    if (line === "---") {
      inFrontMatter = !inFrontMatter;
      continue;
    }
    if (inFrontMatter) continue;
    if (line.startsWith("%%")) continue;

    for (const [pattern, kind] of HEADERS) {
      if (pattern.test(line)) return kind;
    }
    // The first real line was not a header the editor knows.
    return null;
  }
  return null;
}
