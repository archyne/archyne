import { describe, expect, it } from "vitest";
import { localProvider } from "./transformers";
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
