import { AI_MODELS, DEFAULT_AI_MODEL } from "./types";
import type { AiModel, AiProvider, ChatMessage, GenerateOptions } from "./types";

/**
 * The real brain of "Generate".
 *
 * This build's model is Qwen2.5-Coder running through Transformers.js in this
 * very browser tab — the diagram never leaves the machine. The weights are
 * ONNX exports fetched from Hugging Face on first use (a few hundred
 * megabytes, cached by the browser afterwards), which is why the engine
 * reports its own progress and is loaded on demand instead of with the page:
 * the package itself is a comfortable several megabytes, and the model is a
 * download the user should choose, not discover.
 *
 * The API surface here is deliberately small and structural. Transformers.js
 * is a fast-moving dependency, so instead of leaning on its types we describe
 * exactly the two things this file uses — a text-generation pipeline and its
 * token streamer — and let the real module satisfy them at runtime.
 */

/** Where a model's loading has got to, so the panel can show its work. */
export type LocalStatus =
  | { state: "idle" }
  | {
      state: "downloading";
      model: AiModel;
      file: string;
      /** 0–100 when known (Transformer.js gives no total for every file). */
      percent: number | null;
    }
  | { state: "warming"; model: AiModel }
  | { state: "ready"; model: AiModel; device: Backend["device"] }
  | { state: "error"; model: AiModel; error: string };

export interface LocalProviderOptions {
  /** Called whenever the engine's loading state changes. */
  onStatus?: (status: LocalStatus) => void;
  /**
   * Injectable for tests; the default pulls Transformers.js in lazily so the
   * initial bundle never pays for a model that might not be used at all.
   */
  load?: () => Promise<LocalRuntime>;
  /**
   * The generation limit. A flowchart of a typical size serializes to five
   * hundred plus characters, and an answer cut off at its own limit is a
   * parse error it will spend a retry fixing — so give a real diagram room.
   */
  maxNewTokens?: number;
  /**
   * Which execution provider and weights to run. Injectable for tests; the
   * default asks the browser for a GPU (see `pickBackend`).
   */
  backend?: () => Promise<Backend>;
}

/**
 * An execution provider and the weights that suit it. The pairing matters as
 * much as the device: `q4f16` is the export built for WebGPU, and `q4` is the
 * one the WASM kernels run least badly single-threaded.
 */
export interface Backend {
  device: "webgpu" | "wasm";
  dtype: "q4f16" | "q4";
}

export const WEBGPU_BACKEND: Backend = { device: "webgpu", dtype: "q4f16" };
export const WASM_BACKEND: Backend = { device: "wasm", dtype: "q4" };

/**
 * WebGPU when the browser hands out an adapter, WASM otherwise.
 *
 * Measured on the 0.5B model (Ryzen 7 7700, Edge): WASM decodes about one
 * token a second on a single thread — a full answer is a quarter of an hour —
 * while WebGPU decodes fifty to sixty, and a whole turn takes a second or two.
 * WASM only goes multithreaded on a cross-origin isolated page, which the
 * static hosting this app ships on cannot declare. So the GPU is not an
 * optimisation here, it is the difference between a feature and none.
 *
 * `navigator.gpu` existing is not enough: a blocklisted driver or a disabled
 * flag still exposes it and returns no adapter, so the adapter is asked for.
 */
export async function pickBackend(): Promise<Backend> {
  const gpu = (
    globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined
  )?.gpu;
  if (!gpu) return WASM_BACKEND;
  try {
    return (await gpu.requestAdapter()) ? WEBGPU_BACKEND : WASM_BACKEND;
  } catch {
    return WASM_BACKEND;
  }
}

/**
 * The tiny slice of `@huggingface/transformers` this engine runs on. A layer
 * below the `pipeline()` convenience, because that is where the tokens turn
 * into text: `TextStreamer` hands each decoded piece to a callback, which is
 * what streams the answer into the conversation.
 */
export interface LocalRuntime {
  pipeline: (
    task: "text-generation",
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<LocalGenerator>;
  TextStreamer: new (
    tokenizer: unknown,
    options?: {
      skip_prompt?: boolean;
      skip_special_tokens?: boolean;
      callback_function?: (piece: string) => void;
    },
  ) => unknown;
}

type LocalGenerator = {
  tokenizer: unknown;
  dispose?: () => void;
  model_id?: string;
  model_name?: string;
} & ((messages: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown>);

/** The module, fetched once per page. */
let runtimePromise: Promise<LocalRuntime> | undefined;

/**
 * Import Transformers.js dynamically and keep the sliver of it we use. The
 * environment is set before any model is fetched: only remote models (this
 * build never bundles one) and browser cache, so a redraw re-uses the bytes
 * already downloaded instead of asking for them again.
 */
async function loadTransformersRuntime(): Promise<LocalRuntime> {
  runtimePromise ??= import("@huggingface/transformers").then((module) => {
    const m = module as unknown as {
      env?: {
        allowLocalModels?: boolean;
        useBrowserCache?: boolean;
      };
      pipeline?: LocalRuntime["pipeline"];
      TextStreamer?: LocalRuntime["TextStreamer"];
    };
    if (m.env) {
      m.env.allowLocalModels = false;
      m.env.useBrowserCache = true;
    }
    if (!m.pipeline || !m.TextStreamer) {
      throw new Error("Transformers.js did not expose the pipeline");
    }
    return { pipeline: m.pipeline, TextStreamer: m.TextStreamer };
  });
  return runtimePromise;
}

/** The start of a generation that was abandoned, matching the orchestrator. */
function abortError(): DOMException {
  return new DOMException("Generation cancelled", "AbortError");
}

/**
 * Turn Transformers.js's download reporting into the status the panel can
 * paint. Files arrive as `{ status, file, loaded, total, progress }`; only
 * `download`/`progress`/`ready` mark real movement worth showing.
 */
function applyProgress(
  info: Record<string, unknown>,
  model: AiModel,
  onStatus: (status: LocalStatus) => void,
): void {
  const status = String(info.status ?? "");
  if (status === "download" || status === "progress") {
    let percent: number | null = null;
    const progress = Number(info.progress);
    if (Number.isFinite(progress)) {
      // Transformers.js hands progress as a 0–1 fraction (and bytes always
      // fall back below), but defend against 0–100 just in case.
      percent = Math.round(progress > 1 ? progress : progress * 100);
    } else if (
      typeof info.loaded === "number" &&
      typeof info.total === "number" &&
      info.total > 0
    ) {
      percent = Math.round((info.loaded / info.total) * 100);
    }
    onStatus({
      state: "downloading",
      model,
      file: String(info.file ?? ""),
      percent: Math.min(percent ?? 100, 100),
    });
  } else if (status === "ready") {
    onStatus({ state: "warming", model });
  }
}

export function localProvider(options: LocalProviderOptions = {}): AiProvider {
  const onStatus = options.onStatus ?? (() => undefined);
  const maxNewTokens = options.maxNewTokens ?? 1024;
  const load = options.load ?? loadTransformersRuntime;
  const pickBackendFor = options.backend ?? pickBackend;

  let runtime: Promise<LocalRuntime> | null = null;
  const getRuntime = (): Promise<LocalRuntime> => (runtime ??= load());
  let buildPromise: Promise<LocalGenerator> | null = null;
  let engine: { model: AiModel; generator: LocalGenerator } | null = null;

  const ensure = async (model: AiModel): Promise<LocalGenerator> => {
    if (engine?.model === model) return engine.generator;
    buildPromise ??= (async () => {
      if (engine) {
        engine.generator.dispose?.();
        engine = null;
      }
      onStatus({ state: "downloading", model, file: "", percent: null });
      const rt = await getRuntime();
      // In the browser the CPU backend is the WASM execution provider:
      // onnxruntime-web knows `wasm` and `webgpu`, and "cpu" is a Node
      // (onnxruntime-node) device name, not one the page can run on.
      const build = (backend: Backend) =>
        rt.pipeline("text-generation", AI_MODELS[model].repo, {
          ...backend,
          progress_callback: (info: Record<string, unknown>) =>
            applyProgress(info, model, onStatus),
        });
      try {
        const backend = await pickBackendFor();
        let generator: LocalGenerator;
        let device = backend.device;
        try {
          generator = await build(backend);
        } catch (err) {
          // An adapter can be handed out and the session still fail to build
          // on it (an unsupported operator, a lost device). The slow engine
          // is still an engine; nothing is gained by refusing to run.
          if (backend.device !== "webgpu") throw err;
          generator = await build(WASM_BACKEND);
          device = WASM_BACKEND.device;
        }
        engine = { model, generator };
        onStatus({ state: "ready", model, device });
        return generator;
      } catch (err) {
        onStatus({
          state: "error",
          model,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    })();
    try {
      return await buildPromise;
    } finally {
      buildPromise = null;
    }
  };

  return {
    kind: "transformers",
    // A real engine always stands behind this provider; a model not loaded
    // yet is "downloading", not "missing" — that is precisely the lazy-load
    // the first request triggers. `generateDiagram` uses `available()` to
    // reject providers that can never produce, which is not this one.
    available: () => true,
    async generate(chat: ChatMessage[], options?: GenerateOptions): Promise<string> {
      if (options?.signal?.aborted) throw abortError();
      const model = options?.model ?? DEFAULT_AI_MODEL;
      const generator = await ensure(model);
      let text = "";
      const streamer = new (await getRuntime()).TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (piece: string) => {
          if (options?.signal?.aborted) throw abortError();
          text += piece;
          options?.onToken?.(text);
        },
      });
      try {
        await generator(chat, {
          streamer,
          max_new_tokens: maxNewTokens,
          temperature: 0.6,
          do_sample: false,
          return_full_text: false,
        });
      } catch (err) {
        // A run that was asked to stop must come back as that, whatever the
        // engine underneath threw while unwinding.
        if (options?.signal?.aborted) throw abortError();
        throw err;
      }
      return text;
    },
  };
}
