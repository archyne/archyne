/**
 * Reading a Mermaid label as text.
 *
 * A Mermaid label, drawn as text.
 *
 * Mermaid labels are HTML-ish in two small ways, and both were reaching the
 * canvas as characters: `<br>` is how a label holds more than one line, and
 * `&amp;` is what Mermaid's own parser hands back for `&` once a label
 * contains any markup. A node whose text read `Route53<br>DNS &amp; DDoS`
 * therefore *said* that, which is not what anyone wrote.
 *
 * This is deliberately not `dangerouslySetInnerHTML`: diagram text is
 * untrusted — it arrives from files, from imports, and from agents over MCP —
 * so the string is split into lines and the handful of named entities are
 * decoded, and everything else stays literal text. There is no path here that
 * can put markup from a diagram into the document.
 */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  // Mermaid's own escape for a quote inside a quoted label.
  "#quot;": '"',
};

/** Decode the entities Mermaid produces, and nothing else. */
export function decodeLabel(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);|#quot;/g, (m) => ENTITIES[m] ?? m);
}

/** Split on every spelling of a Mermaid line break. */
export function labelLines(text: string): string[] {
  return decodeLabel(text).split(/<br\s*\/?>/i);
}

/**
 * A label as it is edited, and back.
 *
 * `<br>` is how Mermaid holds a second line, and it is the right thing to
 * have in the file — every other tool reading it draws two lines too. It is
 * the wrong thing to have in a text field, where it is markup standing where
 * a line break should be, so the editors turn it into a real line on the way
 * in and back into `<br>` on the way out.
 *
 * Deliberately not `labelLines`: that also decodes `&amp;` and the rest, and
 * a field that decodes without re-encoding would quietly rewrite the label
 * every time it was opened and closed.
 *
 * `textToLabel` is deliberately lossless: it only trades line breaks for
 * `<br>`. The inspector's label field is controlled and re-renders from the
 * store on every keystroke, so a conversion that trimmed would strip the
 * trailing space between two words before the next character arrived —
 * "I went home" came out as "Iwenthome". Trimming belongs at the commit
 * boundary, where `useRename` and the inspector's own blur handler do it.
 */
export function labelToText(label: string): string {
  return label.split(/<br\s*\/?>/i).join("\n");
}

export function textToLabel(text: string): string {
  return text.split(/\r?\n/).join("<br>");
}
