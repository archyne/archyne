import { describe, expect, it, vi } from "vitest";
import { workerEngine } from "./workerEngine";
import type { MainToWorker, WorkerToMain } from "./workerMessages";
import type { AiProvider, ChatMessage } from "./types";
import type { LocalStatus } from "./transformers";

/**
 * The engine is exercised on both sides of its one real decision — worker or
 * main thread — without a worker or a model in sight. jsdom has neither, so
 * `spawn` and `fallback` are injected and the protocol is played out by hand.
 */

const MSG: ChatMessage[] = [{ role: "user", content: "draw me a thing" }];

/** A worker that answers the protocol, scripted by the test. */
class FakeWorker {
  readonly posted: MainToWorker[] = [];
  private listeners: Array<(event: MessageEvent<WorkerToMain>) => void> = [];
  terminated = false;

  constructor(private readonly onRequest: (worker: FakeWorker, msg: MainToWorker) => void) {}

  postMessage(message: MainToWorker): void {
    this.posted.push(message);
    // Asynchronously, as a real worker would answer.
    setTimeout(() => this.onRequest(this, message), 0);
  }

  addEventListener(type: string, fn: (event: MessageEvent<WorkerToMain>) => void): void {
    if (type === "message") this.listeners.push(fn);
  }

  removeEventListener(type: string, fn: (event: MessageEvent<WorkerToMain>) => void): void {
    if (type === "message") this.listeners = this.listeners.filter((l) => l !== fn);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Deliver a message to the page, the way `postMessage` would. */
  emit(message: WorkerToMain): void {
    for (const fn of [...this.listeners]) fn({ data: message } as MessageEvent<WorkerToMain>);
  }
}

const asWorker = (w: FakeWorker): Worker => w as unknown as Worker;

/** Answers the ping, streams two pieces, then finishes. */
function scripted(): FakeWorker {
  return new FakeWorker((worker, msg) => {
    if (msg.type === "ping") {
      worker.emit({ type: "pong" });
      return;
    }
    if (msg.type === "generate") {
      worker.emit({ type: "token", run: msg.run, text: "flow" });
      worker.emit({ type: "token", run: msg.run, text: "flowchart TD" });
      worker.emit({ type: "done", run: msg.run, text: "flowchart TD" });
    }
  });
}

describe("the local engine's choice of thread", () => {
  it("uses the worker once it has answered the ping", async () => {
    const worker = scripted();
    const engine = workerEngine({ spawn: () => asWorker(worker) });
    const tokens: string[] = [];
    const text = await engine.generate(MSG, {
      model: "qwen2.5-coder-0.5b",
      onToken: (t) => tokens.push(t),
    });
    expect(text).toBe("flowchart TD");
    expect(tokens).toEqual(["flow", "flowchart TD"]);
    expect(worker.posted.some((m) => m.type === "generate")).toBe(true);
  });

  it("sends the chosen model across, rather than assuming the default", async () => {
    const worker = scripted();
    const engine = workerEngine({ spawn: () => asWorker(worker) });
    await engine.generate(MSG, { model: "qwen2.5-coder-1.5b" });
    const sent = worker.posted.find((m) => m.type === "generate");
    expect(sent).toMatchObject({ model: "qwen2.5-coder-1.5b" });
  });

  it("builds the worker once and reuses it across turns", async () => {
    const worker = scripted();
    const spawn = vi.fn(() => asWorker(worker));
    const engine = workerEngine({ spawn });
    await engine.generate(MSG, { model: "qwen2.5-coder-0.5b" });
    await engine.generate(MSG, { model: "qwen2.5-coder-0.5b" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("forwards the model's loading status to the panel", async () => {
    const status: LocalStatus = { state: "warming", model: "qwen2.5-coder-0.5b" };
    const worker = new FakeWorker((w, msg) => {
      if (msg.type === "ping") {
        w.emit({ type: "pong" });
        w.emit({ type: "status", status });
        return;
      }
      if (msg.type === "generate") w.emit({ type: "done", run: msg.run, text: "ok" });
    });
    const seen: LocalStatus[] = [];
    const engine = workerEngine({
      spawn: () => asWorker(worker),
      onStatus: (s) => seen.push(s),
    });
    await engine.generate(MSG, { model: "qwen2.5-coder-0.5b" });
    expect(seen).toContainEqual(status);
  });

  it("falls back to the main thread when the worker cannot be built", async () => {
    const main: AiProvider = {
      kind: "transformers",
      available: () => true,
      generate: async () => "from the main thread",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const engine = workerEngine({
      spawn: () => {
        throw new Error("no workers here");
      },
      fallback: () => main,
    });
    await expect(engine.generate(MSG, { model: "qwen2.5-coder-0.5b" })).resolves.toBe(
      "from the main thread",
    );
    // The fallback is a fact worth seeing in the console, not a silent demotion.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("turns a cancel into a message, since a signal cannot cross", async () => {
    const worker = new FakeWorker((w, msg) => {
      if (msg.type === "ping") {
        w.emit({ type: "pong" });
        return;
      }
      if (msg.type === "cancel") {
        w.emit({
          type: "error",
          run: msg.run,
          message: "Generation cancelled",
          name: "AbortError",
        });
      }
      // A `generate` is deliberately left hanging: only the cancel ends it.
    });
    const engine = workerEngine({ spawn: () => asWorker(worker) });
    const ctrl = new AbortController();
    const run = engine.generate(MSG, { model: "qwen2.5-coder-0.5b", signal: ctrl.signal });
    // Let the ping and the generate reach the worker before cancelling.
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.posted.some((m) => m.type === "cancel")).toBe(true);
  });

  it("ignores messages belonging to another run", async () => {
    const worker = new FakeWorker((w, msg) => {
      if (msg.type === "ping") {
        w.emit({ type: "pong" });
        return;
      }
      if (msg.type === "generate") {
        // A straggler from a run that is not this one must not be heard.
        w.emit({ type: "done", run: msg.run + 99, text: "someone else's answer" });
        w.emit({ type: "done", run: msg.run, text: "mine" });
      }
    });
    const engine = workerEngine({ spawn: () => asWorker(worker) });
    await expect(engine.generate(MSG, { model: "qwen2.5-coder-0.5b" })).resolves.toBe("mine");
  });
});
