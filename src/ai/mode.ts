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
