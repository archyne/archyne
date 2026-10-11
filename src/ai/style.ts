/**
 * The house style, applied after the model rather than asked of it.
 *
 * A model of a few hundred megabytes follows a brief loosely and differently
 * each run: ask it for icons and you get them in one draw out of three, under
 * names that may not exist. So the brief in `prompt.ts` still asks — a model
 * that obliges writes a better diagram than this pass can — and everything
 * that has to be *true* of the result is done here instead, in code, where it
 * is the same every time.
 *
 * This pass only ever adds what the answer left out: a node that already
 * carries an icon or a picture is somebody's choice and is left exactly as it
 * is. It is also text-in, text-out and never throws — the caller re-parses
 * the result and keeps the unstyled answer if this made something Mermaid
 * cannot read, so a bad guess here costs nothing.
 */

/**
 * Words that earn an icon, and the icon they earn.
 *
 * Ordered, first hit wins, so the specific names come before the generic
 * ones — `database` before `server`, which would otherwise take `db server`.
 * Every name is from a set this build bundles (`logos:`, `carbon:`), because
 * an icon fetched from the network needs a host in the policy and a round
 * trip, and neither belongs in a pass that runs on every answer.
 */
const ICONS: Array<[RegExp, string]> = [
  [/\b(postgres|mysql|sqlite|oracle)\b/i, "logos:postgresql"],
  [/\b(mongo|mongodb)\b/i, "logos:mongodb"],
  [/\b(redis|cache|memcach)/i, "logos:redis"],
  [/\b(database|db|datastore|storage|table)\b/i, "carbon:data-base"],
  [/\b(kubernetes|k8s)\b/i, "logos:kubernetes"],
  [/\b(docker|container)\b/i, "logos:docker-icon"],
  [/\b(kafka|queue|topic|broker|event bus)\b/i, "carbon:queued"],
  [/\b(s3|bucket|blob|object store)\b/i, "carbon:object-storage"],
  [/\b(email|mail|smtp|notification|notify)\b/i, "carbon:email"],
  [/\b(payment|invoice|billing|charge|checkout|card)\b/i, "carbon:purchase"],
  [/\b(auth|login|sign.?in|token|oauth|credential)\b/i, "carbon:password"],
  [/\b(user|customer|client|person|actor|admin)\b/i, "carbon:user"],
  [/\b(browser|website|web|frontend|ui)\b/i, "carbon:application-web"],
  [/\b(api|endpoint|rest|graphql|gateway)\b/i, "carbon:api"],
  [/\b(server|backend|service|worker|host)\b/i, "carbon:bare-metal-server"],
  [/\b(cloud|aws|azure|gcp)\b/i, "carbon:cloud"],
  [/\b(log|audit|metric|monitor|trace)\b/i, "carbon:catalog"],
  [/\b(report|document|file|export|pdf)\b/i, "carbon:document"],
  [/\b(search|query|lookup|index)\b/i, "carbon:search"],
  [/\b(error|fail|reject|decline|invalid)\b/i, "carbon:warning"],
];

/** The icon a label earns, or null when nothing in it asks for one. */
export function iconForLabel(label: string): string | null {
  for (const [pattern, icon] of ICONS) {
    if (pattern.test(label)) return icon;
  }
  return null;
}

/**
 * One node definition: an id, then the bracket form carrying its label.
 *
 * Only the quoted forms are touched. An unquoted label — `a[Start]` — is
 * legal Mermaid, but rewriting it means deciding where its text ends, and the
 * model is told to quote; one that is not quoted is simply left alone rather
 * than guessed at.
 */
const RECT_DEF = /([A-Za-z_][\w-]*)\["([^"]*)"\]/g;

/**
 * A line that is one node definition and nothing else.
 *
 * The distinction matters because it decides *where* the rewritten node can
 * go — see `withIcons`. Any bracket counts here, not just the rectangle: a
 * line holding only `check{"Valid?"}` is still a definition standing alone,
 * and it must not be mistaken for a chain.
 */
const WHOLE_LINE = /^\s*[A-Za-z_][\w-]*[[({][^\n]*[\])}]\s*$/;

/** A line that already says how it is drawn is not this pass's business. */
const HAS_PICTURE = /@\{/;

/**
 * Give unadorned nodes an icon, where their own label asks for one.
 *
 * Mermaid takes one form per node — a bracket shape *or* an `@{ … }`
 * composition — so gaining an icon means giving up the shape. That is a real
 * trade, and it is why only the plain rectangles qualify: a decision diamond
 * or a terminator says something by being that shape, and an icon in its
 * place would say less, not more.
 *
 * Definitions are not always alone on a line, which is the thing a stub
 * provider never shows you: a real model writes `b --> d["Wait"] --> e[…]`,
 * and an earlier version of this pass — which only ever matched a line that
 * was *nothing but* a definition — decorated none of it. So a definition
 * inside a chain has its label lifted out: the arrow keeps the bare id, and
 * the node is declared on its own line underneath.
 *
 * It is done that way round, rather than rewriting in place, because mermaid
 * refuses to merge the two node forms — `flowchart.ts` documents that mixing
 * them is a parse error. The bare id in the chain is a reference, not a
 * second declaration, so only one form ever describes the node.
 */
export function withIcons(code: string): string {
  /** Nodes already given an icon, so no node is declared twice. */
  const claimed = new Set<string>();
  const declarations: string[] = [];

  const rewritten = code.split("\n").map((line) => {
    if (HAS_PICTURE.test(line)) return line;
    const alone = WHOLE_LINE.test(line);
    return line.replace(RECT_DEF, (whole, id: string, label: string) => {
      const icon = iconForLabel(label);
      if (!icon || claimed.has(id)) return whole;
      claimed.add(id);
      const declaration = `${id}@{ icon: "${icon}", label: "${label}", pos: "t" }`;
      // Standing alone, the definition simply becomes the new form; inside a
      // chain it cannot, so the chain keeps the id and the declaration moves.
      if (alone) return declaration;
      declarations.push(`  ${declaration}`);
      return id;
    });
  });

  const body = rewritten.join("\n");
  if (declarations.length === 0) return body;
  return `${body.replace(/\n+$/, "")}\n${declarations.join("\n")}\n`;
}

/**
 * The whole house-style pass, as one call.
 *
 * Separate from `withIcons` so the steps stay individually testable and the
 * caller has one name to reach for; more passes join here rather than at the
 * call site.
 */
export function applyHouseStyle(code: string): string {
  return withIcons(code);
}
