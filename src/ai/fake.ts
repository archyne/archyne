import type { AiProvider, ChatMessage, GenerateOptions } from "./types";
import { EDIT_LABEL } from "./prompt";

/**
 * The brain behind "Generate" in stub builds.
 *
 * There is no model in this build — wiring the real one in is a separate
 * step. What the pipeline needs to develop against is a provider that behaves
 * like the real thing: an answer that streams, answers that fail to parse and
 * get retried, a request that can be cancelled. The fake answers from the
 * words it was asked — reading them out of the same turn a real model would
 * see (the request lives in `prompt.ts`'s envelope with the open document) —
 * so that asking to *change* the drawing changes it.
 *
 *   - request mentions "sequence"            → a fresh sequence diagram
 *   - request mentions "er diagram"          → a fresh ER diagram
 *   - "add another step"                     → appends a node and an edge
 *   - "remove"/"togli"                       → drops the last node and its edges
 *   - "rename ... to X"/"rinomina"           → renames the first node
 *   - "colour it blue"/"colore"/red/green    → styles the first node
 *   - "give it an icon"/"con un'icona"       → an `icon:` node-text composition
 *   - any other follow-up                    → appends a step (never no-ops)
 *   - "fail once" / "needs redrawing"        → first answer is broken, then fixed
 *   - "never parses"                         → every answer is broken
 *
 * The retry answers are recognised by the feedback the orchestrator appends
 * to the turn, not by the request — the marker lives in `prompt.ts` so a
 * future real provider sees exactly what a reader would.
 */
const STREAM_STEP_MS = 3;

const UNPARSABLE = `flowchart TD
  a --> --> b`;

const STREETS = `flowchart TD
  a[Start] --> b{Decide}
  b -- yes --> c[Done]
  b -- no --> d[Try again]`;

const SEQUENCE = `sequenceDiagram
  participant User
  participant App
  participant Service
  User->>App: Sign in
  App->>Service: Check credentials
  Service-->>App: OK
  App-->>User: Welcome`;

const ER = `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains`;

/**
 * Split the envelope `prompt.ts` wraps the document and the request in, so the
 * fake — exactly like the real model it stands in for — sees the drawing it is
 * being asked to change.
 */
function splitTurn(turn: string): { document: string; request: string } {
  const at = turn.indexOf(EDIT_LABEL);
  if (at === -1) return { document: "", request: turn };
  // The lead-in line ("The open document is a …") is not part of the code.
  const document = turn.slice(0, at).split("\n").slice(1).join("\n").trim();
  return { document, request: turn.slice(at + EDIT_LABEL.length).trim() };
}

/** A step spelling that can start a node: `a[id]`, `a{text}` or `a(["text"])`. */
const STEP_OPEN = /^\s{2}([\w.-]+)(?:\[|\{|\(\s*\[)/;

/** The node ids a drawing defines, in the order they appear: a step's own id
 * first, then the node on the far side of its arrow. `a[Start] --> b[Done]`
 * reads as `a`, then `b`; `b --> c[End]` reads as `c`. */
function nodeIds(lines: string[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    const own = line.match(STEP_OPEN);
    if (own) ids.push(own[1]);
    const via = line.match(/--[>x-]*\s*([\w.-]+)/);
    if (via) ids.push(via[1]);
  }
  return ids;
}

/** Whether a line references this node: its step, an arrow to it, a style. */
function mentions(line: string, id: string): boolean {
  return (
    line.includes(` ${id} `) ||
    line.includes(` ${id}[`) ||
    line.includes(` ${id}{`) ||
    (STEP_OPEN.test(line) && line.includes(id)) ||
    line.startsWith(`  style ${id}`)
  );
}

/** The line that defines this node — its own step, or the arrow into it. */
function defAt(lines: string[], id: string): number {
  const pattern = new RegExp(`(?:^\\s{2}${id}|-->\\s*${id})(?:\\[|\\{)`);
  return lines.findIndex((l) => pattern.test(l));
}

/** Swap the `id[shape]` part of a statement for another node spelling. */
function swapDef(line: string, id: string, replacement: string): string {
  return line.replace(new RegExp(`${id}\\[[^\\]]*\\]`), `${id}${replacement}`);
}

/** The first node's label inside its `["…"]`/`[…]` spelling. */
function labelOf(line: string): string {
  const m = line.match(/\["?([^"\]]*)"?\]/);
  return (m?.[1] ?? "").trim();
}

/** A fresh node id not already taken, like Archyne's own `xN` picker. */
function nextId(ids: Set<string>): string {
  let max = 0;
  for (const id of ids) {
    const m = id.match(/^x(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `x${max + 1}`;
}

/**
 * Edit an open flowchart so the change the request asks for is *visible*.
 * Every branch guarantees fresh output; the fallbacks make even a vague
 * request ("make it clearer") move the drawing rather than echo it back.
 *
 * The keyword stems stand on their own line on purpose (no closing \\b): the
 * fake recognizes "rename" and "rimuovi" alike as `renam`/`rimuov`.
 */
function editFlowchart(document: string, request: string): string {
  const lines = document.split("\n");
  const ids = nodeIds(lines);
  if (ids.length === 0) return STREETS;

  if (/\b(colou?r|colore)/i.test(request)) {
    const first = ids[0];
    if (first && !lines.some((l) => l.startsWith(`  style ${first}`))) {
      const fill = /\b(red|rosso)\b/i.test(request)
        ? "e5484d"
        : /\b(green|verde)\b/i.test(request)
          ? "22c55e"
          : "3b82f6";
      lines.push(`  style ${first} fill:#${fill}`);
      return lines.join("\n");
    }
  }

  if (/\b(renam|rinomin|chiam|chiama)/i.test(request)) {
    const target = ids[0];
    const at = defAt(lines, target);
    if (at !== -1) {
      const tail = request
        .split(/\bto\b|\bin\b/i)
        .pop()
        ?.trim();
      const name = tail && tail !== request ? tail.replace(/[.,;!?]*$/, "") : "Renamed";
      lines[at] = swapDef(lines[at], target, `["${name}"]`);
      return lines.join("\n");
    }
  }

  if (/\b(remov|delet|rimuov|elimin|togli)/i.test(request)) {
    const target = ids[ids.length - 1];
    const kept = lines.filter((l) => !mentions(l, target));
    if (nodeIds(kept).length === 0) return STREETS;
    return kept.join("\n");
  }

  if (/\b(icon|icona)/i.test(request)) {
    const target = ids[0];
    const at = defAt(lines, target);
    if (at !== -1) {
      const label = labelOf(lines[at]) || "Node";
      lines[at] = swapDef(
        lines[at],
        target,
        `@{ icon: "logos:layer", label: "${label}", pos: "tb" }`,
      );
      return lines.join("\n");
    }
  }

  // The default — and the "add"/"aggiungi" path: one more step, wired to the
  // last node, so an open drawing always grows.
  const last = ids[ids.length - 1];
  const id = nextId(new Set(ids));
  return `${document.trimEnd()}\n  ${last} --> ${id}["More"]\n`;
}

/** A sequence follow-up says something, at least. */
function editSequence(document: string, request: string): string {
  void request;
  return `${document.trimEnd()}\n  Service-->>App: acknowledged\n`;
}

/** Follow the request against the drawing that is open, visibly. */
function editDiagram(document: string, request: string): string {
  const head = document.split("\n", 1)[0];
  if (head.startsWith("sequenceDiagram")) return editSequence(document, request);
  if (head) return editFlowchart(document, request);
  return STREETS;
}

export const fakeCodeFor = (turn: string): string => {
  // The failure modes override everything, the way a broken draw does.
  if (turn.includes("never parses")) return UNPARSABLE;
  // The retry feedback the orchestrator appended: answer properly this time.
  if (turn.includes("did not parse")) return STREETS;
  if (turn.includes("fail once") || turn.includes("needs redrawing")) return UNPARSABLE;

  const { document, request } = splitTurn(turn);
  // "Draw this" requests answer fresh, whatever is on screen.
  if (/\ber[-_ ]?diagram\b/i.test(request)) return ER;
  if (/\bsequence\b/i.test(request)) return SEQUENCE;

  return editDiagram(document, request);
};

function abortSignalError(): DOMException {
  return new DOMException("Generation cancelled", "AbortError");
}

export const fakeProvider: AiProvider = {
  kind: "fake",
  available: () => true,
  async generate(chat: ChatMessage[], options?: GenerateOptions): Promise<string> {
    const turn = chat[chat.length - 1]?.content ?? "";
    const code = fakeCodeFor(turn);
    let sent = "";
    for (let i = 0; i < code.length; i += 3) {
      if (options?.signal?.aborted) throw abortSignalError();
      sent = code.slice(0, i + 3);
      options?.onToken?.(sent);
      await new Promise((resolve) => setTimeout(resolve, STREAM_STEP_MS));
    }
    return sent;
  },
};
