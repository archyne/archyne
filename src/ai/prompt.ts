import type { AiRequest, ChatMessage } from "./types";

/**
 * The system instructions, sent as-is every turn. Kept to two short paragraphs
 * and a compact example: the models Archyne targets are a few hundred
 * megabytes, sized to run on an ordinary machine — they have room for a short
 * brief, not for an essay.
 */
const SYSTEM = `You draft Mermaid diagrams for the user of a local diagram editor. Reply with Mermaid code only: no prose, no code fences, no "here is". The first line must be a header for the kind of diagram asked of you. The user is looking at a diagram that is already written — shown below — and describes a change to it; edit what is there rather than rewriting from scratch, and keep ids the text refers to. The editor lays the diagram out itself, so say nothing about positions and write no %% graph comments.

Keep the picture's own styling: icons written as Mermaid node-text compositions (@{ icon: "logo:name", ... }) and colour via style or classDef lines must round-trip, and a node that would earn an icon or a colour should gain one rather than staying plain — colours like fill:#135 or fill:#e5484d, icons from familiar sets such as logos:, l: or azure:.

House style, which the editor also enforces after you: give a step a shape that says what it is — a decision is {"..."}, a start or end is (["..."]), an input or output is [/"..."/] — and name nodes with short ids and quoted labels. Do not draw a node that only repeats its neighbour, and do not leave a diagram as one unbroken chain when a branch is what the request describes. A flowchart example:

flowchart TD
  a[Check] --> b{Paid?}
  b -- yes --> c[Ship]
  b -- no --> d[Wait]`;

/**
 * The line that tells the model what to change, every turn. Exported because
 * the stub provider reads the user's request out of the same envelope.
 */
export const EDIT_LABEL = "Change it so that:";

/**
 * What the orchestrator appends when an answer did not parse, to ask for
 * another draw. The stub provider recognises the phrase to *fail its next
 * attempt or not*; a real model reads it as an instruction.
 */
export const RETRY_FEEDBACK = ({ kind, error }: { kind: string; error: string }): string =>
  `That last answer did not parse as valid Mermaid (${error}). Reply again with only valid Mermaid, starting from a ${kind} header.`;

/**
 * What the orchestrator appends when an answer parsed but changed nothing:
 * a model that echoes the document has missed the point of the turn.
 */
export const UNCHANGED_FEEDBACK =
  "That last answer was exactly the diagram already there. Reply again with an actual change to it, still valid Mermaid.";

/**
 * The turn sent to the model for one generation attempt.
 *
 * The whole picture is in the user message — the open document — so the
 * model sees what a person preparing the prompt sees, and the retry feedback
 * lands on the same message the request lives in.
 */
export function buildChat(request: AiRequest, feedback?: string): ChatMessage[] {
  const document = request.code.trim() || "(the diagram is empty)";
  const user = [
    `The open document is a ${request.kind}. It looks like this:`,
    "",
    document,
    "",
    EDIT_LABEL,
    request.request,
  ];
  if (feedback) user.push("", feedback);
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user.join("\n") },
  ];
}
