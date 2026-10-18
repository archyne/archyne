import { vscodeApi } from "../host";
import type { Connection } from "./host/connection";
import type { HostEvent } from "./host/core";
import { ServerError, type Reachability } from "./server";
import type { AiProvider, ChatMessage, GenerateOptions } from "./types";

/**
 * The page's side of Generate's host engine: one interface over the two
 * pipes a host can offer — Electron's IPC (`window.archyne.ai`, desktop/
 * preload.cjs) and a VS Code webview's `postMessage` (extensions/vscode/src/
 * ai.ts). The host keeps the secrets and makes the requests; this side only
 * describes connections and receives text (AUTH.local.md, "The one rule").
 */

export type HostProbe = Reachability | { state: "invalid"; problem: string };

export interface HostAi {
  setConnections(list: Connection[]): Promise<void>;
  setSecret(id: string, field: string, value: string | null): Promise<void>;
  secretFields(id: string): Promise<string[]>;
  canKeepSecrets(): Promise<boolean>;
  probe(id: string): Promise<HostProbe>;
  chat(requestId: string, id: string, model: string, messages: ChatMessage[]): Promise<void>;
  cancel(requestId: string): void;
  onEvent(callback: (event: HostEvent) => void): () => void;
}

let webviewAi: HostAi | null = null;

/** The host's Generate interface, or null in a plain browser tab. */
export function hostAi(): HostAi | null {
  const desktop = (globalThis as { archyne?: { ai?: HostAi } }).archyne?.ai;
  if (desktop) return desktop;
  const vscode = vscodeApi();
  if (!vscode) return null;
  webviewAi ??= overWebview(vscode);
  return webviewAi;
}

/**
 * The same interface over a webview: a call is a message with an id, and the
 * extension answers with `ai:result` under that id. Streaming arrives as
 * `ai:event` messages, the same events the desktop sends over IPC.
 */
function overWebview(vscode: { postMessage(message: unknown): void }): HostAi {
  let seq = 0;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const listeners = new Set<(event: HostEvent) => void>();

  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as {
      type?: unknown;
      callId?: number;
      ok?: boolean;
      value?: unknown;
      error?: string;
      event?: HostEvent;
    };
    if (msg?.type === "ai:result" && typeof msg.callId === "number") {
      const call = pending.get(msg.callId);
      if (!call) return;
      pending.delete(msg.callId);
      if (msg.ok) call.resolve(msg.value);
      else call.reject(new Error(msg.error ?? "The extension could not do that."));
    } else if (msg?.type === "ai:event" && msg.event) {
      for (const listener of listeners) listener(msg.event);
    }
  });

  const call = <T>(method: string, args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const callId = ++seq;
      pending.set(callId, { resolve: resolve as (v: unknown) => void, reject });
      vscode.postMessage({ type: "ai:call", callId, method, args });
    });

  return {
    setConnections: (list) => call("setConnections", [list]),
    setSecret: (id, field, value) => call("setSecret", [id, field, value]),
    secretFields: (id) => call("secretFields", [id]),
    canKeepSecrets: () => call("canKeepSecrets", []),
    probe: (id) => call("probe", [id]),
    chat: (requestId, id, model, messages) => call("chat", [requestId, id, model, messages]),
    cancel: (requestId) => void call("cancel", [requestId]),
    onEvent: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}

function abortError(): DOMException {
  return new DOMException("Generation cancelled", "AbortError");
}

let requestSeq = 0;

/**
 * A Generate engine that runs in the host, over one of its connections.
 * To the store it is one more `AiProvider`: the prompt, the retries and the
 * turn handling do not know the request left the page.
 */
export function hostProvider(
  ai: HostAi,
  connectionId: string,
  model: string,
  /** Resolves once the host knows the connection as it stands (engine.ts). */
  ready: () => Promise<void> = () => Promise.resolve(),
): AiProvider {
  return {
    kind: "host",
    available: () => model !== "",
    async generate(chat: ChatMessage[], options?: GenerateOptions): Promise<string> {
      if (options?.signal?.aborted) throw abortError();
      if (!model) throw new ServerError("No model is chosen.", "no-model");
      await ready();
      const requestId = `r${Date.now().toString(36)}-${++requestSeq}`;
      return new Promise<string>((resolve, reject) => {
        const stop = ai.onEvent((event) => {
          if (event.requestId !== requestId) return;
          if (event.type === "ai:chunk") {
            options?.onToken?.(event.text);
            return;
          }
          stop();
          options?.signal?.removeEventListener("abort", onAbort);
          if (event.type === "ai:done") resolve(event.text);
          else if (event.reason === "aborted") reject(abortError());
          else reject(new ServerError(event.detail || event.reason, event.reason as never));
        });
        const onAbort = () => ai.cancel(requestId);
        options?.signal?.addEventListener("abort", onAbort);
        ai.chat(requestId, connectionId, model, chat).catch((err: unknown) => {
          stop();
          options?.signal?.removeEventListener("abort", onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    },
  };
}
