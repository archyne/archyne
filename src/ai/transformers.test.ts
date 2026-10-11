import { afterEach, describe, expect, it } from "vitest";
import { localProvider, pickBackend, WASM_BACKEND, WEBGPU_BACKEND } from "./transformers";
import type { LocalRuntime, LocalStatus } from "./transformers";
import type { ChatMessage } from "./types";

/**
 * The real engine is exercised here without downloading anything: the
 * Transformers.js module is injectable, so a scripted stand-in plays its part
 * — a pipeline that reports progress, a generator that plays back pieces into
 * the streamer callback, a model that can be disposed. The genuine binary is
 * many megabytes and a network trip; what this file pins is the *contract*
 * the engine holds the real one to.
 */

interface Script {
  built: string[];
  disposed: string[];
  texts: Record<string, string[]>;
  failing?: boolean;
}

/** A scripted Transformers.js: keyed by model repo, built once per repo. */
function scripted(script: Script): LocalRuntime {
  const cbs = new WeakMap<object, (piece: string) => void>();
  let current: { cb?: (piece: string) => void } = {};
  return {
    pipeline: async (_task, repo, options) => {
      if (script.failing) throw new Error("engine exploded");
      const emitProgress = options?.progress_callback as
        ((info: Record<string, unknown>) => void) | undefined;
      const cbHolder: { cb?: (piece: string) => void } = {};
      script.built.push(String(repo));
      emitProgress?.({
        status: "download",
        file: "model_q4f16.onnx",
        loaded: 256,
        total: 1024,
        progress: 0,
      });
      emitProgress?.({ status: "ready" });
      const generator = async () => {
        const pieces = script.texts[String(repo)] ?? [];
        for (const piece of pieces) cbHolder.cb?.(piece);
        return {};
      };
      current = cbHolder;
      return Object.assign(generator, {
        tokenizer: {},
        dispose: () => script.disposed.push(String(repo)),
      });
    },
    TextStreamer: class {
      constructor(
        _tokenizer: unknown,
        config?: { callback_function?: (piece: string) => void },
      ) {
        void cbs;
        current.cb = config?.callback_function;
      }
    },
  };
}

const MSG: ChatMessage[] = [{ role: "user", content: "draw me a thing" }];

describe("localProvider", () => {
  it("streams the answer piece by piece and returns the whole text", async () => {
    const script: Script = {
      built: [],
      disposed: [],
      texts: { "onnx-community/Qwen2.5-Coder-0.5B-Instruct": ["flow", "chart", " TD"] },
    };
    const statuses: LocalStatus[] = [];
    const provider = localProvider({
      onStatus: (s) => statuses.push(s),
      load: async () => scripted(script),
    });
    const tokens: string[] = [];
    const text = await provider.generate(MSG, {
      model: "qwen2.5-coder-0.5b",
      onToken: (t) => tokens.push(t),
    });
    expect(text).toBe("flowchart TD");
    expect(tokens).toEqual(["flow", "flowchart", "flowchart TD"]);
    // The download was reported with a percentage, and the run ended ready.
    const downloads = statuses.filter(
      (s): s is Extract<LocalStatus, { state: "downloading" }> => s.state === "downloading",
    );
    expect(downloads[0]?.percent).toBeNull();
    expect(downloads.some((s) => s.percent === 0)).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ state: "ready", model: "qwen2.5-coder-0.5b" });
    expect(script.built).toEqual(["onnx-community/Qwen2.5-Coder-0.5B-Instruct"]);
    expect(script.disposed).toEqual([]);
  });

  it("reuses the loaded model across turns", async () => {
    const script: Script = {
      built: [],
      disposed: [],
      texts: { "onnx-community/Qwen2.5-Coder-0.5B-Instruct": ["a"] },
    };
    const provider = localProvider({ load: async () => scripted(script) });
    await provider.generate(MSG, { model: "qwen2.5-coder-0.5b" });
    await provider.generate(MSG, { model: "qwen2.5-coder-0.5b" });
    expect(script.built).toHaveLength(1);
    expect(script.disposed).toEqual([]);
  });

  it("switching the model drops the old one before building the new", async () => {
    const script: Script = {
      built: [],
      disposed: [],
      texts: {
        "onnx-community/Qwen2.5-Coder-0.5B-Instruct": ["small"],
        "onnx-community/Qwen2.5-Coder-1.5B-Instruct": ["large"],
      },
    };
    const statuses: LocalStatus[] = [];
    const provider = localProvider({
      onStatus: (s) => statuses.push(s),
      load: async () => scripted(script),
    });
    await provider.generate(MSG, { model: "qwen2.5-coder-0.5b" });
    await provider.generate(MSG, { model: "qwen2.5-coder-1.5b" });
    expect(script.built).toEqual([
      "onnx-community/Qwen2.5-Coder-0.5B-Instruct",
      "onnx-community/Qwen2.5-Coder-1.5B-Instruct",
    ]);
    expect(script.disposed).toEqual(["onnx-community/Qwen2.5-Coder-0.5B-Instruct"]);
    expect(statuses.at(-1)).toMatchObject({ state: "ready", model: "qwen2.5-coder-1.5b" });
  });

  it("aborting cuts the run, and the text stops where it stopped", async () => {
    const script: Script = {
      built: [],
      disposed: [],
      texts: { "onnx-community/Qwen2.5-Coder-0.5B-Instruct": ["one", "two", "three"] },
    };
    const provider = localProvider({ load: async () => scripted(script) });
    const ctrl = new AbortController();
    const tokens: string[] = [];
    const run = provider.generate(MSG, {
      model: "qwen2.5-coder-0.5b",
      signal: ctrl.signal,
      onToken: (t) => {
        tokens.push(t);
        if (tokens.length === 1) ctrl.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(tokens).toEqual(["one"]);
  });

  it("refuses to start when the run is already cancelled", async () => {
    const script: Script = { built: [], disposed: [], texts: {} };
    const provider = localProvider({ load: async () => scripted(script) });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      provider.generate(MSG, { model: "qwen2.5-coder-0.5b", signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(script.built).toEqual([]);
  });

  it("a pipeline that dies is reported as an error, not a silent stall", async () => {
    const script: Script = { built: [], disposed: [], texts: {}, failing: true };
    const statuses: LocalStatus[] = [];
    const provider = localProvider({
      onStatus: (s) => statuses.push(s),
      load: async () => scripted(script),
    });
    await expect(provider.generate(MSG, { model: "qwen2.5-coder-0.5b" })).rejects.toThrow(
      "engine exploded",
    );
    expect(statuses.at(-1)).toMatchObject({
      state: "error",
      model: "qwen2.5-coder-0.5b",
      error: "engine exploded",
    });
  });
});

describe("the backend", () => {
  /** A runtime that records what each build asked for, and can refuse WebGPU. */
  function recording(refuseGpu: boolean): { runtime: LocalRuntime; asked: unknown[] } {
    const asked: unknown[] = [];
    const runtime: LocalRuntime = {
      pipeline: async (_task, _repo, options) => {
        asked.push({ device: options?.device, dtype: options?.dtype });
        if (refuseGpu && options?.device === "webgpu") throw new Error("no such operator");
        return Object.assign(async () => ({}), { tokenizer: {} });
      },
      TextStreamer: class {},
    };
    return { runtime, asked };
  }

  it("builds on the GPU with the weights made for it, when there is one", async () => {
    const { runtime, asked } = recording(false);
    const statuses: LocalStatus[] = [];
    const provider = localProvider({
      onStatus: (s) => statuses.push(s),
      load: async () => runtime,
      backend: async () => WEBGPU_BACKEND,
    });
    await provider.generate(MSG);
    expect(asked).toEqual([{ device: "webgpu", dtype: "q4f16" }]);
    expect(statuses.at(-1)).toMatchObject({ state: "ready", device: "webgpu" });
  });

  it("falls back to WASM when the GPU session will not build, and says so", async () => {
    const { runtime, asked } = recording(true);
    const statuses: LocalStatus[] = [];
    const provider = localProvider({
      onStatus: (s) => statuses.push(s),
      load: async () => runtime,
      backend: async () => WEBGPU_BACKEND,
    });
    await provider.generate(MSG);
    expect(asked).toEqual([
      { device: "webgpu", dtype: "q4f16" },
      { device: "wasm", dtype: "q4" },
    ]);
    expect(statuses.at(-1)).toMatchObject({ state: "ready", device: "wasm" });
  });

  describe("pickBackend", () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "gpu");
    const withGpu = (gpu: unknown) =>
      Object.defineProperty(navigator, "gpu", { value: gpu, configurable: true });
    afterEach(() => {
      if (original) Object.defineProperty(navigator, "gpu", original);
      else delete (navigator as { gpu?: unknown }).gpu;
    });

    it("is WASM where WebGPU does not exist", async () => {
      expect(await pickBackend()).toEqual(WASM_BACKEND);
    });

    it("is WebGPU when an adapter is handed out", async () => {
      withGpu({ requestAdapter: async () => ({}) });
      expect(await pickBackend()).toEqual(WEBGPU_BACKEND);
    });

    it("is WASM when WebGPU exists but gives no adapter, or throws", async () => {
      withGpu({ requestAdapter: async () => null });
      expect(await pickBackend()).toEqual(WASM_BACKEND);
      withGpu({
        requestAdapter: async () => {
          throw new Error("blocklisted");
        },
      });
      expect(await pickBackend()).toEqual(WASM_BACKEND);
    });
  });
});
