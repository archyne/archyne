/**
 * The local engine as the page sees it: a worker when there can be one, and
 * the main thread when there cannot.
 *
 * This follows the arrangement `src/layout/autoLayout.ts` already uses for
 * ELK, deliberately and for the same reasons — a worker is faster to trust
 * than to assume:
 *
 *   - jsdom, under Vitest, has no `Worker` at all;
 *   - `worker-src` is a CSP directive, and index.html's policy is only the
 *     floor: a self-hoster or reverse proxy can send a narrower header and
 *     the intersection wins. Generating must not be what breaks;
 *   - constructing a worker can succeed and still never answer, so the round
 *     trip is proved with a `ping` and bounded, rather than trusted.
 *
 * The Electron shell loads the build over `file://` (`desktop/main.cjs` uses
 * `loadFile`), where Chromium would block a worker and Electron does not —
 * measured for ELK, in the packaged build. The same is assumed here, and the
 * fallback is what makes being wrong survivable rather than fatal.
 *
 * The choice is made on the first generation, not when the provider is built,
 * so that `getProvider()` stays synchronous and the store is untouched.
 */
import { localProvider } from "./transformers";
import type { LocalStatus } from "./transformers";
import type { AiProvider, ChatMessage, GenerateOptions } from "./types";
import { DEFAULT_AI_MODEL } from "./types";
import type { MainToWorker, WorkerToMain } from "./workerMessages";

/** A worker that has not answered a ping by now is not going to. */
const PROBE_TIMEOUT_MS = 5000;

export interface WorkerEngineOptions {
  onStatus?: (status: LocalStatus) => void;
  /** Injectable for tests; the default builds the real module worker. */
  spawn?: () => Worker;
  /** Injectable for tests; the default is the main-thread engine. */
  fallback?: (onStatus?: (status: LocalStatus) => void) => AiProvider;
}

function defaultSpawn(): Worker {
  return new Worker(new URL("./aiWorker.ts", import.meta.url), { type: "module" });
}

/** Resolve once the worker answers `pong`, or reject when it does not. */
function probe(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener("message", onMessage);
      reject(new Error("AI worker did not respond"));
    }, PROBE_TIMEOUT_MS);
    function onMessage(event: MessageEvent<WorkerToMain>): void {
      if (event.data.type !== "pong") return;
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      resolve();
    }
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("AI worker failed to start"));
    });
    const ping: MainToWorker = { type: "ping" };
    worker.postMessage(ping);
  });
}

/**
 * Drive one generation across the worker boundary.
 *
 * The run id is what lets `cancel` name this run and nothing else, and what
 * keeps a late message from a cancelled run out of a live one's text.
 */
function generateVia(
  worker: Worker,
  run: number,
  chat: ChatMessage[],
  options: GenerateOptions | undefined,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const abort = (): void => {
      const cancel: MainToWorker = { type: "cancel", run };
      worker.postMessage(cancel);
    };
    const finish = (): void => {
      worker.removeEventListener("message", onMessage);
      options?.signal?.removeEventListener("abort", abort);
    };
    function onMessage(event: MessageEvent<WorkerToMain>): void {
      const message = event.data;
      if (!("run" in message) || message.run !== run) return;
      if (message.type === "token") {
        options?.onToken?.(message.text);
        return;
      }
      if (message.type === "done") {
        finish();
        resolve(message.text);
        return;
      }
      if (message.type === "error") {
        finish();
        // Rebuilt on this side, because an Error does not survive the trip.
        const err =
          message.name === "AbortError"
            ? new DOMException(message.message, "AbortError")
            : Object.assign(new Error(message.message), { name: message.name });
        reject(err);
      }
    }
    worker.addEventListener("message", onMessage);
    options?.signal?.addEventListener("abort", abort, { once: true });
    const request: MainToWorker = {
      type: "generate",
      run,
      chat,
      model: options?.model ?? DEFAULT_AI_MODEL,
    };
    worker.postMessage(request);
  });
}

/**
 * The engine the page runs: worker-backed where possible, main-thread
 * otherwise, behind one unchanging provider.
 */
export function workerEngine(options: WorkerEngineOptions = {}): AiProvider {
  const onStatus = options.onStatus;
  const spawn = options.spawn ?? defaultSpawn;
  const fallback = options.fallback ?? ((cb) => localProvider({ onStatus: cb }));

  let backend: Promise<{ worker: Worker } | { main: AiProvider }> | null = null;
  let runSeq = 0;

  const choose = (): Promise<{ worker: Worker } | { main: AiProvider }> =>
    (backend ??= (async () => {
      // An injected `spawn` overrides the guard: jsdom has no `Worker` at
      // all, so without this the worker path could never be tested — and an
      // untested fallback is the one that runs the day it is needed.
      if (options.spawn !== undefined || typeof Worker !== "undefined") {
        let worker: Worker | undefined;
        try {
          worker = spawn();
          // The worker reports the model's loading for every run, so its
          // status messages are forwarded for as long as it lives.
          worker.addEventListener("message", (event: MessageEvent<WorkerToMain>) => {
            if (event.data.type === "status") onStatus?.(event.data.status);
          });
          await probe(worker);
          return { worker };
        } catch (err) {
          worker?.terminate();
          console.warn("AI worker unavailable; generating on the main thread instead.", err);
        }
      }
      return { main: fallback(onStatus) };
    })());

  return {
    kind: "worker",
    // A real engine always stands behind this: a model not loaded yet is
    // "downloading", not "missing". Same reasoning as `localProvider`.
    available: () => true,
    async generate(chat: ChatMessage[], generateOptions?: GenerateOptions): Promise<string> {
      const chosen = await choose();
      if ("main" in chosen) return chosen.main.generate(chat, generateOptions);
      return generateVia(chosen.worker, ++runSeq, chat, generateOptions);
    },
  };
}
