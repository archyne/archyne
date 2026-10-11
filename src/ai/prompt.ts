import type { DiagramKind } from "../model/types";
import type { AiRequest, ChatMessage } from "./types";

/**
 * The system instructions, sent as-is every turn. Kept to a few short
 * paragraphs: the models Archyne targets are sized to run on an ordinary
 * machine — they have room for a short brief, not for an essay. The forms are
 * shown rather than described, by the worked exchange in `EXAMPLES`.
 */
const SYSTEM = `You draft Mermaid diagrams for the user of a local diagram editor. Reply with Mermaid code only: no prose, no code fences, no "here is". The first line must be a header for the kind of diagram asked of you. The user is looking at a diagram that is already written — shown below — and describes a change to it; edit what is there rather than rewriting from scratch, and keep ids the text refers to. The editor lays the diagram out itself, so say nothing about positions and write no %% graph comments.

Keep the icons and colours already in the document. Colour and icons have their own lines and forms, never brackets or arrows: use the forms the first exchange uses, and to colour something add a style or classDef line rather than changing the node.

House style, which the editor also enforces after you: give a step a shape that says what it is — a decision is {"..."}, a start or end is (["..."]), an input or output is [/"..."/] — and name nodes with short ids and quoted labels. Do not draw a node that only repeats its neighbour, and do not leave a diagram as one unbroken chain when a branch is what the request describes.

The first exchange is an example of the forms to use. It is not about the user's diagram: carry none of its nodes, labels or colours into your answer.`;

/**
 * One worked exchange per family — a document, a request, the edited answer —
 * sent ahead of the real turn as a previous conversation.
 *
 * Measured on the 1.5B model, a brief that only *describes* styling gets none
 * of it right: asked to colour a node it wrote `done{"Done"}[green]` or
 * `done(color:red)`, asked for an icon `db(@{icon: "database"})`, and an ER
 * relationship came back as `CUSTOMER--(ORDER)` — syntax it had to invent,
 * never having been shown any. Shown an example inside the brief instead, the
 * 3B wrote the forms correctly but pasted the example's *content* into its
 * answers: the example flowchart into an empty document, a `style` line for a
 * node that only existed in the example. As an exchange the example teaches
 * the operation — this document, this request, this edit — rather than a
 * picture to copy.
 *
 * Each one is on a subject far from anything a test asks (tickets, books, a
 * kitchen), so that a good answer cannot be the example recited back, and
 * `prompt.test.ts` parses both sides of every one: an example that does not
 * parse would teach the very mistake it is here to prevent. Sequence,
 * architecture and C4 nodes cannot ask for a colour in this editor, so their
 * exchanges show what those families can carry instead.
 */
export const EXAMPLES: Record<
  DiagramKind,
  { document: string; request: string; answer: string }
> = {
  flowchart: {
    document: `flowchart TD
  a(["Ticket opened"]) --> b["Triage"]
  b --> s[("Ticket store")]
  s --> c(["Closed"])`,
    request:
      "send urgent tickets to on-call first, colour that step orange, and give the store a database icon",
    answer: `flowchart TD
  a(["Ticket opened"]) --> u{"Urgent?"}
  u -- yes --> p["Page on-call"]
  u -- no --> b["Triage"]
  p --> b
  b --> s
  s@{ icon: "carbon:data-base", label: "Ticket store", pos: "t" }
  s --> c(["Closed"])
  style p fill:#f97316,color:#fff`,
  },
  state: {
    document: `stateDiagram-v2
  [*] --> Draft
  Draft --> Published : publish
  Published --> [*]`,
    request: "add an Archived state after Published, and colour it grey",
    answer: `stateDiagram-v2
  [*] --> Draft
  Draft --> Published : publish
  Published --> Archived : archive
  Archived --> [*]
  classDef old fill:#9ca3af,color:#fff
  class Archived old`,
  },
  er: {
    document: `erDiagram
  AUTHOR {
    int id PK
    string name
  }`,
    request: "an author writes many books",
    answer: `erDiagram
  AUTHOR {
    int id PK
    string name
  }
  BOOK {
    int id PK
    int author_id FK
    string title
  }
  AUTHOR ||--o{ BOOK : "writes"`,
  },
  class: {
    document: `classDiagram
  class Library {
    +string name
  }`,
    request: "a library holds many books; colour Book blue",
    answer: `classDiagram
  class Library {
    +string name
  }
  class Book {
    +string title
    +borrow() bool
  }
  Library "1" --> "*" Book : holds
  style Book fill:#3b82f6,color:#fff`,
  },
  sequence: {
    document: `sequenceDiagram
  actor C as Customer
  participant K as Kitchen
  C->>K: order a pizza`,
    request: "the kitchen confirms the order, and note that it bakes for ten minutes",
    answer: `sequenceDiagram
  actor C as Customer
  participant K as Kitchen
  C->>K: order a pizza
  K-->>C: order confirmed
  Note right of K: bakes for ten minutes`,
  },
  architecture: {
    document: `architecture-beta
  group app(cloud)[App]
  service api(server)[API] in app`,
    request: "add a database the API writes to",
    answer: `architecture-beta
  group app(cloud)[App]
  service api(server)[API] in app
  service store(database)[Store] in app
  api:R --> L:store`,
  },
  c4: {
    document: `C4Context
  title Library
  Person(reader, "Reader")
  System(lib, "Catalogue")
  Rel(reader, lib, "Searches")`,
    request: "the catalogue sends reminders through an external mail service",
    answer: `C4Context
  title Library
  Person(reader, "Reader")
  System(lib, "Catalogue")
  System_Ext(mail, "Mail service")
  Rel(reader, lib, "Searches")
  Rel(lib, mail, "Sends reminders via")`,
  },
};

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
 * The whole picture is in the last user message — the open document — so the
 * model sees what a person preparing the prompt sees, and the retry feedback
 * lands on the same message the request lives in. The family's worked
 * exchange (see `EXAMPLES`) goes before it, as an earlier turn.
 */
export function buildChat(request: AiRequest, feedback?: string): ChatMessage[] {
  const shot = EXAMPLES[request.kind];
  const user = turn(request.kind, request.code, request.request);
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: turn(request.kind, shot.document, shot.request) },
    { role: "assistant", content: shot.answer },
    { role: "user", content: feedback ? `${user}\n\n${feedback}` : user },
  ];
}

/** One request in the envelope the model is shown, example or real. */
function turn(kind: DiagramKind, code: string, request: string): string {
  return [
    `The open document is a ${kind}. It looks like this:`,
    "",
    code.trim() || "(the diagram is empty)",
    "",
    EDIT_LABEL,
    request,
  ].join("\n");
}
