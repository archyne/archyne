/**
 * Tidy up hand-written Mermaid.
 *
 * Deliberately *only* whitespace. Indentation carries no meaning in Mermaid,
 * so re-indenting a document cannot change what it draws — while rewriting
 * statements could, and a formatter that occasionally changes your diagram is
 * one nobody dares press twice. So: leading indentation per block depth,
 * trailing spaces dropped, runs of blank lines collapsed. Everything inside a
 * line is left exactly as the author typed it.
 *
 * The result matches what the app's own serializers emit — two spaces per
 * level, statements one level under the header — so formatting a document and
 * then dragging a node do not fight over the file.
 */

const INDENT = "  ";

/** Machine-written metadata (`%% graph:positions …`). Always at column 0. */
const META = /^%%\s*graph:/;

/** `%%{init: …}%%` and friends: a directive, not a comment on a statement. */
const DIRECTIVE = /^%%\{/;

const COMMENT = /^%%/;

interface Blocks {
  /** Opens a block on its own keyword, e.g. `subgraph`, `loop`. */
  open: RegExp | null;
  /** Closes one, e.g. `end`. */
  close: RegExp | null;
  /** Neither, but sits one level out: `else`, `and`, `option`. */
  middle: RegExp | null;
}

/**
 * Which keywords nest, per family.
 *
 * Scoped by diagram kind rather than applied everywhere because these words
 * are only structural in the family that defines them: `opt` opens a block in
 * a sequence diagram, and is a perfectly good node id in a flowchart.
 */
const BLOCKS: Record<string, Blocks> = {
  flowchart: { open: /^subgraph\b/, close: /^end(\s|$)/, middle: null },
  sequence: {
    open: /^(loop|alt|opt|par|critical|break|rect|box)\b/,
    close: /^end(\s|$)/,
    middle: /^(else|and|option)\b/,
  },
};

const HEADERS: Array<[RegExp, string]> = [
  [/^(flowchart|graph)\b/, "flowchart"],
  [/^sequenceDiagram\b/, "sequence"],
  [/^stateDiagram(-v2)?\b/, "state"],
  [/^erDiagram\b/, "er"],
  [/^classDiagram(-v2)?\b/, "class"],
  [/^architecture-beta\b/, "architecture"],
  [/^C4(Context|Container|Component|Dynamic|Deployment)\b/, "c4"],
  [/^requirementDiagram\b/, "requirement"],
];

function familyOf(header: string): string {
  for (const [re, family] of HEADERS) if (re.test(header)) return family;
  return "other";
}

/** `"` marks a Mermaid string; an odd count means the line left one open. */
function unbalancedQuotes(line: string): boolean {
  return (line.match(/"/g)?.length ?? 0) % 2 === 1;
}

/**
 * Re-indent and tidy a Mermaid document.
 *
 * Idempotent: the output is already in the shape this produces, so pressing
 * the command twice does nothing the second time and a formatted file never
 * shows up as a diff of its own.
 */
export function formatMermaid(code: string): string {
  const hadTrailingNewline = /\n$/.test(code);
  const lines = code.replace(/\r\n?/g, "\n").split("\n");

  let family: string | null = null;
  let depth = 0;
  let blankRun = 0;
  /** Inside a string that a previous line opened: hands off entirely. */
  let inString = false;
  const out: string[] = [];

  for (const raw of lines) {
    if (inString) {
      out.push(raw.replace(/\s+$/, ""));
      if (unbalancedQuotes(raw)) inString = false;
      continue;
    }

    const line = raw.trim();

    if (!line) {
      // Blank lines separate sections, which is worth keeping; a screenful of
      // them is not. Leading ones are dropped by never emitting a blank
      // before the header.
      blankRun++;
      if (blankRun === 1 && out.length > 0) out.push("");
      continue;
    }
    blankRun = 0;

    if (family === null && !COMMENT.test(line)) {
      // The first statement is the header: it names the family, sits at
      // column 0, and everything after it is a statement inside it.
      family = familyOf(line);
      out.push(line);
      depth = 1;
      if (unbalancedQuotes(line)) inString = true;
      continue;
    }

    if (META.test(line) || DIRECTIVE.test(line)) {
      out.push(line);
      continue;
    }

    const blocks = (family && BLOCKS[family]) || { open: null, close: null, middle: null };
    const closesBlock =
      (blocks.close?.test(line) ?? false) || (family !== null && /^\}/.test(line));
    const middle = blocks.middle?.test(line) ?? false;

    if (closesBlock) depth = Math.max(depth - 1, family === null ? 0 : 1);
    const at = middle ? Math.max(depth - 1, 1) : depth;
    out.push(INDENT.repeat(Math.max(at, 0)) + line);

    // A trailing `{` opens a block in every family that has braces — state
    // composites, class bodies, ER attribute lists, C4 boundaries — so it
    // needs no keyword list of its own.
    const opensBlock = (blocks.open?.test(line) ?? false) || /\{\s*$/.test(line);
    if (opensBlock && !closesBlock) depth++;

    if (unbalancedQuotes(line)) inString = true;
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  const text = out.join("\n");
  return hadTrailingNewline || text === "" ? `${text}\n` : text;
}
