import type { DiagramKind } from "../model/types";

/**
 * The models Archyne can run, each small enough to be on a machine that is not
 * a resource hog. The repo names pair with a Hugging Face `onnx-community`
 * export; the model itself is fetched on demand and not part of this build.
 * Qwen2.5-Coder is Apache-2.0.
 */
export const AI_MODELS = {
  "qwen2.5-coder-0.5b": { repo: "onnx-community/Qwen2.5-Coder-0.5B-Instruct" },
  "qwen2.5-coder-1.5b": { repo: "onnx-community/Qwen2.5-Coder-1.5B-Instruct" },
} as const;

export type AiModel = keyof typeof AI_MODELS;

export const DEFAULT_AI_MODEL: AiModel = "qwen2.5-coder-0.5b";

/**
 * The hosts a model's weights are actually fetched from, named here so the
 * policy in index.html is a decision written twice and checked against
 * itself — the same arrangement `ICON_HOSTS` has, for the same reason: a
 * `connect-src` that names a host no module here does is a page reachable
 * from further away than intended.
 *
 * Hugging Face serves the manifest from its own domain and redirects the
 * large files to a CDN: the legacy `cdn-lfs` hosts, and the `xet` locations
 * under `*.cdn.hf.co` that a repo resolves to today. Nothing is requested
 * until somebody sends a prompt in local mode.
 */
export const MODEL_HOSTS = [
  "huggingface.co",
  "cdn.huggingface.co",
  "cdn-lfs.huggingface.co",
  "*.cdn.hf.co",
] as const;

/** One turn of the model's conversation. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** What a generation asks of the model. */
export interface AiRequest {
  /** The open document's family — the answer must start from its header. */
  kind: DiagramKind;
  /** The document as it stands, so the model edits rather than rewrites. */
  code: string;
  /** The user's own words, trimmed. */
  request: string;
  /** Which model to run. */
  model: AiModel;
}

export interface GenerateOptions {
  signal?: AbortSignal;
  /** Which model the turn asked for; the real engines load it on demand. */
  model?: AiModel;
  /**
   * The text as it arrives, from empty up to the whole answer. Called with
   * the running text (not per-character), so a caller can paint it directly.
   */
  onToken?: (text: string) => void;
  /** Fired at the start of every attempt — the first, and each retry. */
  onAttempt?: (attempt: number) => void;
}

/**
 * One answered exchange in the conversation panel.
 *
 * A turn is what the panel scrolls as a pair of bubbles: what the user asked,
 * then whatever the model made of it. Cancelling a run removes the half-drawn
 * turn again, so the thread only ever holds exchanges that reached the end.
 */
export interface AiTurn {
  /** Unique within the conversation; the buttons of one turn use it. */
  id: string;
  /** The user's words, trimmed. */
  request: string;
  /** "working" while streaming; the settled outcome once a run ends. */
  state: "working" | "done" | "error";
  /**
   * The answer as it streams, or the finished one. On error it still holds
   * the last draw, so the failure is not opaque.
   */
  code: string;
  /** Why the turn stopped, when it stopped in error. */
  error: string | null;
  /**
   * When a local server was the reason, which kind of failure (see
   * `Reachability` in server.ts), so the panel can say how to fix it rather
   * than repeat a browser's "Failed to fetch".
   */
  reason?: string | null;
  /** Which draw of this turn is in progress (1 = the first). */
  attempts: number;
  /**
   * The document as it stood immediately before this turn's answer was put on
   * the canvas, so the turn can be taken back on its own.
   *
   * An answer now lands on the drawing by itself — there is no "Insert" to
   * press — and the price of that is a way back that names *this* change
   * rather than "whatever happened last". Null until an answer lands, and on
   * a turn that never drew one.
   */
  codeBefore: string | null;
}

/**
 * Where a model runs. A provider may exist without being usable (the model
 * bits have not been fetched yet); the UI says so rather than pretending.
 */
export interface AiProvider {
  /** "fake" in stub builds; later "transformers", "llama", … */
  readonly kind: string;
  /** True once the model this provider wraps is ready to run. */
  available(): boolean;
  /** Answer the turn: the full text, streamed to `onToken` as it goes. */
  generate(chat: ChatMessage[], options?: GenerateOptions): Promise<string>;
}
