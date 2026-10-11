import { fakeProvider } from "./fake";
import type { LocalStatus } from "./transformers";
import { workerEngine } from "./workerEngine";
import type { AiProvider } from "./types";

export type AiMode = "stub" | "local" | "off";

/**
 * Which brain this build runs.
 *
 *   - `VITE_AI_MODE=stub`, and any dev server by default, run the whole
 *     pipeline on a fake provider (`fake.ts`) that behaves like a real one —
 *     streams, fails, retries, edits the drawing — so the feature is
 *     developed and tested without a multi-hundred-megabyte download;
 *   - `VITE_AI_MODE=local` (or the historical `transformers`) runs the real
 *     engine: Qwen2.5-Coder through Transformers.js in the tab, fetching its
 *     ONNX weights on first use. This is the mode a person chooses, because
 *     it downloads a model into their browser;
 *   - anything else is `off`, and the panel says no model is connected
 *     rather than pretending.
 */
export function resolveAiMode(env: { dev: boolean; explicit?: string }): AiMode {
  const explicit = env.explicit;
  if (explicit === "stub") return "stub";
  if (explicit === "local" || explicit === "transformers") return "local";
  return env.dev ? "stub" : "off";
}

export function aiMode(): AiMode {
  return resolveAiMode({
    dev: import.meta.env.DEV,
    explicit: (import.meta.env as { VITE_AI_MODE?: string }).VITE_AI_MODE,
  });
}

/** The one local engine the page runs; created the first time it is asked. */
let local: AiProvider | null = null;

/**
 * The provider this build can run, or null when no model is connected.
 *
 * The local engine is a singleton: its state — which model is loaded — is the
 * page's state, shared by every turn. The status callback is captured at
 * creation; the store passes the same listener on every call.
 */
export function getProvider(onStatus?: (status: LocalStatus) => void): AiProvider | null {
  if (aiMode() === "stub") return fakeProvider;
  if (aiMode() === "local") {
    local ??= workerEngine({ onStatus });
    return local;
  }
  return null;
}
