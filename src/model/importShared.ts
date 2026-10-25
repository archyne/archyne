/**
 * The parts every importer needs.
 *
 * Two problems turn up whatever the source format is: foreign identifiers are
 * not Mermaid identifiers, and foreign palettes are drawn for black text on a
 * white page. Both were solved once for draw.io and are solved here so the
 * next importer inherits the answer rather than a near-miss of it.
 */

/**
 * Words Mermaid's flowchart grammar claims for itself. A node called `end`
 * closes the enclosing subgraph instead of appearing in it — the single most
 * common way a generated flowchart fails to parse.
 */
const RESERVED = new Set([
  "end",
  "graph",
  "flowchart",
  "subgraph",
  "class",
  "classDef",
  "click",
  "style",
  "linkStyle",
  "direction",
  "default",
  "call",
  "href",
  "o",
  "x",
]);

/**
 * Words the architecture grammar reads as the start of a statement wherever
 * they begin a token, not only standing alone: `service title_text(server)`
 * fails because `title` is taken as the diagram's title and the id after
 * `service` never arrives. A suffix cannot help here, so the id is prefixed.
 */
const SWALLOWED = /^(title|accTitle|accDescr)/;

/**
 * Readable Mermaid ids, derived from the labels.
 *
 * Foreign ids are rarely usable as they stand — draw.io writes
 * `WIyWlLk6GJQsqaUBKTNV-1`, and a DOT file from Terraform writes
 * `aws_instance.web`. Both would be read as arrows or nonsense. Naming a node
 * after what it says keeps the generated source worth reading, which is the
 * whole reason for importing into Mermaid rather than into a canvas format.
 *
 * Each factory owns one document's namespace, so repeats get a suffix rather
 * than colliding.
 */
export function idFactory() {
  const used = new Set<string>();
  return (label: string, fallback: string): string => {
    const base =
      label
        .replace(/<br\/>/g, " ")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 24)
        // Trimmed again after the cut: slicing mid-word can leave the
        // separator dangling, and `servizio_autenticazione_` reads worse than
        // the same name without it.
        .replace(/_+$/, "")
        .replace(/^(?=\d)/, "n") || fallback;

    let candidate = RESERVED.has(base) ? `${base}_` : SWALLOWED.test(base) ? `n_${base}` : base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}_${n}`;
    used.add(candidate);
    return candidate;
  };
}

/**
 * How light a colour is, by the WCAG relative-luminance formula. Null when it
 * is not a hex colour — both formats also write `none` and X11 colour names.
 */
function luminance(hex: string): number | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const digits =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : match[1];
  const channel = (at: number) => {
    const value = parseInt(digits.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * A text colour that can be read on `fill`, or null when the fill is not a
 * colour this can judge.
 *
 * Every editor Archyne imports from draws its labels black on a white page,
 * so its palettes are all pale. Carrying a fill across without a text colour
 * puts a pale fill under Archyne's light-on-dark label and the words
 * disappear. The value is chosen for contrast rather than copied, because a
 * dark fill would be just as unreadable in black.
 */
export function readableOn(fill: string): string | null {
  const light = luminance(fill);
  return light === null ? null : light > 0.179 ? "#111111" : "#ffffff";
}
