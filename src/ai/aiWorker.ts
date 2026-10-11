/// <reference lib="webworker" />
/**
 * The generation worker: the local model, off the page's thread.
 *
 * Qwen through onnxruntime's WASM backend pins a core for as long as it takes
 * to write a diagram — on the main thread that is a frozen editor: no
 * repaint, no scroll, no Stop button. Measured on the real 0.5B model, the
 * page stopped answering for over a minute, which is what this file exists to
 * prevent.
 *
 * It deliberately hosts `localProvider` unchanged rather than reimplementing
 * it: the engine's contract — streaming, model switching, disposal, abort —
 * is already pinned by `transformers.test.ts`, and a second copy of that
 * logic living in a worker is a second copy to keep true.
 */
import { localProvider } from "./transformers";
import type { MainToWorker, WorkerToMain } from "./workerMessages";

const scope = self as unknown as DedicatedWorkerGlobalScope;

const post = (message: WorkerToMain): void => scope.postMessage(message);

/** One engine for the life of the worker; it owns the loaded model. */
const provider = localProvider({ onStatus: (status) => post({ type: "status", status }) });

/**
 * The runs in flight, so `cancel` can reach one.
 *
 * An `AbortSignal` cannot cross `postMessage`, so the controller stays here
 * and the message is what travels — which is why every run carries an id.
 */
const running = new Map<number, AbortController>();

scope.addEventListener("message", (event: MessageEvent<MainToWorker>) => {
  const message = event.data;

  if (message.type === "ping") {
    post({ type: "pong" });
    return;
  }

  if (message.type === "cancel") {
    running.get(message.run)?.abort();
    return;
  }

  const { run, chat, model } = message;
  const controller = new AbortController();
  running.set(run, controller);
  void provider
    .generate(chat, {
      model,
      signal: controller.signal,
      onToken: (text) => post({ type: "token", run, text }),
    })
    .then((text) => post({ type: "done", run, text }))
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      // The name travels separately: an Error crossing `postMessage` arrives
      // as a plain object, and the orchestrator decides what a cancelled run
      // was by reading `name === "AbortError"`.
      post({ type: "error", run, message: error.message, name: error.name });
    })
    .finally(() => running.delete(run));
});
