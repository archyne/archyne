import { parseDiagram } from "../model/diagram";
import { isHeaderLine } from "../model/sniff";
import {
  buildChat,
  EXAMPLE_FEEDBACK,
  EXAMPLES,
  RETRY_FEEDBACK,
  UNCHANGED_FEEDBACK,
} from "./prompt";
import type { AiProvider, AiRequest, GenerateOptions } from "./types";

/** A "Generate" run: the first draw, then a bounded number of retries. */
export const MAX_ATTEMPTS = 3;

/** Thrown when the provider exists but the model cannot actually run. */
export class AiNotConfiguredError extends Error {
  constructor() {
    super("The local model is not set up");
    this.name = "AiNotConfiguredError";
  }
}

/**
 * Every model answer the orchestrator accepted or, after its last retry, the
 * one it refused — so the UI can show what the model actually made.
 */
export class DiagramGenerationError extends Error {
  constructor(
    error: string,
    readonly code: string,
    readonly attempts: number,
  ) {
    super(error);
    this.name = "DiagramGenerationError";
  }
}

export interface GenerateResult {
  /** The last answer, stripped of fences and trimmed. */
  code: string;
  /** How many draws it took (1 = fine first time). */
  attempts: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError");
}

/**
 * Take the model's raw reply and keep only the Mermaid.
 *
 * The prompt forbids fences and prose, but a model that was instructed once
 * greets you the next time — so the answer is wrung out here regardless:
 * a possible ```mermaid wrapper is dropped, and anything after the first
 * closing fence is not the diagram.
 */
function stripFence(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```(?:mermaid)?\s*\n?/i);
  if (fence) text = text.slice(fence[0].length);
  const closing = text.indexOf("```");
  if (closing !== -1) text = text.slice(0, closing);
  // Whatever stands before the header is not the diagram either. The 3B model
  // opens a good share of its answers with a stray `mer` line — the start of
  // a fence it never finished — above an otherwise correct diagram, and the
  // whole answer failed to parse on that one line. With no header anywhere,
  // the text is left as it is and the parser says what is wrong with it.
  const lines = text.split("\n");
  const header = lines.findIndex((line) => isHeaderLine(line.trim()));
  if (header > 0) text = lines.slice(header).join("\n");
  return text.trim();
}

/**
 * Ask the model to draw the diagram, validating every answer and, when one
 * does not parse *or changes nothing*, asking again with the complaint as the
 * feedback.
 *
 * The "changed nothing" check exists because a request is about the diagram
 * on screen: "make it clearer" is an instruction to change it, and an answer
 * that merely echoes the document back has missed the point — so it earns the
 * same fate as one that does not parse.
 *
 * Layout is none of this function's business: the document that comes back is
 * applied through `applyCode({ forceLayout })`, which re-parses, runs the
 * automatic arrangement and rewrites the positions comment. Coordinates in a
 * model answer are noise.
 */
export async function generateDiagram(
  request: AiRequest,
  provider: AiProvider,
  options?: GenerateOptions,
): Promise<GenerateResult> {
  if (!provider.available()) throw new AiNotConfiguredError();
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    throwIfAborted(options?.signal);
    options?.onAttempt?.(attempt);
    const raw = await provider.generate(
      buildChat(
        request,
        attempt === 1
          ? undefined
          : lastError === UNCHANGED
            ? UNCHANGED_FEEDBACK
            : lastError === ECHOED
              ? EXAMPLE_FEEDBACK
              : RETRY_FEEDBACK({ kind: request.kind, error: lastError }),
      ),
      // The engine needs to know which language model this turn is for.
      { ...options, model: request.model },
    );
    throwIfAborted(options?.signal);
    const code = stripFence(raw);
    try {
      await parseDiagram(code);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_ATTEMPTS) {
        throw new DiagramGenerationError(lastError, code, attempt);
      }
      continue;
    }
    // Parses, but a no-op is still a failed answer: a turn is an instruction
    // to change the diagram, not to recite it back.
    if (code.trim() === request.code.trim()) {
      lastError = UNCHANGED;
      if (attempt === MAX_ATTEMPTS) {
        throw new DiagramGenerationError(
          "The answer never changed the diagram.",
          code,
          attempt,
        );
      }
      continue;
    }
    // Parses and changes something, but perhaps the wrong thing: the worked
    // example sits right above the real turn, and a small model sometimes
    // edits that instead.
    if (echoesExample(code, request)) {
      lastError = ECHOED;
      if (attempt === MAX_ATTEMPTS) {
        throw new DiagramGenerationError(
          "The answer kept changing the example instead of the diagram.",
          code,
          attempt,
        );
      }
      continue;
    }
    return { code, attempts: attempt };
  }
  throw new Error("unreachable");
}

/**
 * Whether an answer carries names that only the worked example uses.
 *
 * Measured on Qwen3.5-4B, about one answer in eight edited the example (a
 * kitchen taking a pizza order) instead of the user's diagram. A name counts
 * only when the user's own document and request do not use it, so a person
 * who really is drawing a kitchen is never refused for it.
 */
export function echoesExample(code: string, request: AiRequest): boolean {
  const theirs = words(`${request.code}\n${request.request}`);
  const answer = words(code);
  return EXAMPLES[request.kind].marks.some((mark) => {
    const word = mark.toLowerCase();
    return !theirs.has(word) && answer.has(word);
  });
}

/** The words of a text, lower-cased; a hyphen joins, so `on-call` is one. */
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []);
}

/** Marks a fallback that parsed but edited nothing (see the check above). */
const UNCHANGED = "the answer did not change the diagram";

/** Marks a fallback that edited the worked example instead. */
const ECHOED = "the answer changed the example, not the diagram";
