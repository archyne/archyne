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
  return (
    text
      .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);|#quot;/g, (m) => ENTITIES[m] ?? m)
      // Mermaid's own spelling of a character by number, `#34;`.
      .replace(/#(\d{1,6});/g, (m, n: string) => {
        const code = Number(n);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      })
  );
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
 */
export function labelToText(label: string): string {
  return label.split(/<br\s*\/?>/i).join("\n");
}

export function textToLabel(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("<br>");
}
