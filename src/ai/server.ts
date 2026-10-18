import type { AiProvider, ChatMessage, GenerateOptions } from "./types";

/**
 * A model the user already runs on this machine: Ollama, LM Studio, a
 * llama.cpp server — anything that speaks the OpenAI chat-completions dialect,
 * which is what all of them expose.
 *
 * The in-tab engine is bounded by what a browser can download and hold, and
 * measured over seven languages no open model that small reached the quality
 * a drawing tool needs. A person who already has a 14B or 30B model loaded in
 * LM Studio does not have that ceiling. This is also the one engine that works
 * the same in every shell — the web page, the desktop app and the VS Code
 * webview — because it is only an HTTP request.
 *
 * Local means local: the address must be loopback. The page's connect-src
 * names only `localhost` and `127.0.0.1` for this (see `SERVER_ORIGINS`), so
 * the diagram never leaves the machine through this door either, and a
 * hosted endpoint is a separate decision rather than a field away.
 */

/** The connect-src entries this engine needs, checked against index.html. */
export const SERVER_ORIGINS = ["http://localhost:*", "http://127.0.0.1:*"] as const;

export interface ServerSettings {
  /** The OpenAI-compatible base, ending in `/v1`. */
  baseUrl: string;
  /** The model id as the server lists it; empty until one is picked. */
  model: string;
  /** Sent as a bearer token when set; most local servers want none. */
  apiKey?: string;
}

/** The servers people actually run, with the address each listens on. */
export const SERVER_PRESETS = {
  ollama: { label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  lmstudio: { label: "LM Studio", baseUrl: "http://localhost:1234/v1" },
} as const;

export type ServerPreset = keyof typeof SERVER_PRESETS;

/** The preset an address belongs to, so the panel can give the right advice. */
export function presetOf(baseUrl: string): ServerPreset | null {
  for (const [key, preset] of Object.entries(SERVER_PRESETS)) {
    if (sameOrigin(baseUrl, preset.baseUrl)) return key as ServerPreset;
  }
  return null;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.port === y.port && loopback(x.hostname) === loopback(y.hostname);
  } catch {
    return false;
  }
}

function loopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** Whether an address is one this engine may talk to: plain http on loopback, as connect-src allows. */
export function isLocalUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" && loopback(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The rule for a host process (desktop main, VS Code extension host), which
 * has no page CSP to stay inside: any `https:` address, and `http:` only on
 * loopback — so a credential is never sent in clear text over a network.
 */
export function isHostReachableUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback(url.hostname));
  } catch {
    return false;
  }
}

/** Which addresses an engine may use; the page's is loopback, a host's wider. */
export type UrlPolicy = (baseUrl: string) => boolean;

/** `http://localhost:1234/v1/` + `models`, without doubling the slash. */
function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path}`;
}

function headers(settings: ServerSettings): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey) h.Authorization = `Bearer ${settings.apiKey}`;
  return h;
}

/**
 * Why a server could not be reached, in the terms the panel explains.
 *
 *   - `ok`: it answered;
 *   - `blocked`: something is listening, but it refuses this page's origin
 *     (CORS) — the case with a fix the user can make in the server's settings;
 *   - `down`: nothing answered at that address;
 *   - `not-local`: the address is not loopback, so it is never tried;
 *   - `http`: it answered with an error status.
 */
export type Reachability =
  | {
      state: "ok";
      models: string[];
      /** The listed models that the server only relays to a cloud service. */
      remote: string[];
    }
  | { state: "blocked" }
  | { state: "down" }
  | { state: "not-local" }
  | { state: "http"; status: number };

type Fetch = typeof fetch;

/**
 * How one family of APIs is spoken: where its models are listed, what a turn
 * looks like on the wire, and where the answer is in each streamed event.
 * The OpenAI dialect is what every local server speaks; the host adds the
 * hosted ones (`host/dialects.ts`), so the page never carries them.
 */
export interface Dialect {
  /** Under the base, where the models are listed; null when the API keeps no such list. */
  modelsPath: string | null;
  /** Under the base, where a turn is sent. */
  chatPath(model: string): string;
  /** Headers the dialect itself needs, beside the credentials. */
  headers?: Record<string, string>;
  body(model: string, chat: ChatMessage[]): unknown;
  /**
   * The answer text one server-sent event carries, if any; throws on an
   * error event. For a dialect whose stream is SSE.
   */
  piece?(event: unknown): string | undefined;
  /** Reads a stream that is not SSE (AWS's binary event stream), throwing on an error in it. */
  read?(body: ReadableStream<Uint8Array>, onPiece: (piece: string) => void): Promise<void>;
  /**
   * Lists the models its own way, when one GET under the base is not how
   * (another host, several lists); the status instead when refused.
   */
  listModels?(baseUrl: string, fetchImpl: Fetch): Promise<string[] | { status: number }>;
  /** Whether a loopback server may relay some of its models to a cloud (Ollama). */
  relays?: boolean;
}

/**
 * Only `delta.content` is the answer. Reasoning models served by LM Studio
 * send their thinking as `delta.reasoning_content`, which is not part of it;
 * others put it inline in `<think>…</think>`, which `stripThinking` removes
 * once the text is whole.
 */
function openaiPiece(event: unknown): string | undefined {
  const piece = (event as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]
    ?.delta?.content;
  return typeof piece === "string" ? piece : undefined;
}

export const OPENAI_DIALECT: Dialect = {
  modelsPath: "models",
  chatPath: () => "chat/completions",
  body: (model, chat) => ({
    model,
    messages: chat,
    stream: true,
    // The same answer for the same request: an edit, not a muse.
    temperature: 0,
  }),
  piece: openaiPiece,
  relays: true,
};

/**
 * Ask the server for its models, and when that fails, find out why.
 *
 * A browser reports a CORS refusal and a closed port identically — a bare
 * `TypeError` — which is useless to somebody trying to fix it. A second,
 * `no-cors` request tells them apart: it cannot read the answer, but it
 * resolves when anything is listening and rejects when nothing is.
 */
export async function probeServer(
  settings: ServerSettings,
  fetchImpl: Fetch = fetch,
  allowed: UrlPolicy = isLocalUrl,
  dialect: Dialect = OPENAI_DIALECT,
): Promise<Reachability> {
  if (!allowed(settings.baseUrl)) return { state: "not-local" };
  if (dialect.listModels) {
    let listed: string[] | { status: number };
    try {
      listed = await dialect.listModels(settings.baseUrl, fetchImpl);
    } catch {
      return { state: "down" };
    }
    return Array.isArray(listed)
      ? { state: "ok", models: listed, remote: [] }
      : { state: "http", status: listed.status };
  }
  if (dialect.modelsPath === null) return { state: "ok", models: [], remote: [] };
  const url = endpoint(settings.baseUrl, dialect.modelsPath);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { ...headers(settings), ...dialect.headers } });
  } catch {
    try {
      await fetchImpl(url, { mode: "no-cors" });
      return { state: "blocked" };
    } catch {
      return { state: "down" };
    }
  }
  if (!response.ok) return { state: "http", status: response.status };
  const body = (await response.json().catch(() => null)) as {
    data?: Array<{ id?: unknown }>;
  } | null;
  const models = (body?.data ?? [])
    .map((m) => (typeof m.id === "string" ? m.id : ""))
    .filter((id) => id && !/embed/i.test(id));
  const remote = dialect.relays ? await remoteModels(settings, models, fetchImpl) : [];
  return { state: "ok", models, remote };
}

/**
 * The models a local server lists but does not run: Ollama's cloud models
 * (`gpt-oss:120b-cloud`) answer from ollama.com, so a diagram sent to one
 * leaves the machine even though the address is loopback.
 *
 * The OpenAI-style list does not say so; Ollama's own `/api/tags` does, as
 * `remote_host`. Asked of every server, because it costs one request and a
 * server without that endpoint simply has nothing to report. The `-cloud`
 * suffix, Ollama's naming, is a fallback when that request is refused.
 */
async function remoteModels(
  settings: ServerSettings,
  models: string[],
  fetchImpl: Fetch,
): Promise<string[]> {
  const byName = new Set(models.filter((id) => /[-:]cloud$/i.test(id)));
  try {
    const origin = new URL(settings.baseUrl).origin;
    const response = await fetchImpl(`${origin}/api/tags`);
    if (response.ok) {
      const tags = (await response.json()) as {
        models?: Array<{ name?: unknown; remote_host?: unknown }>;
      };
      for (const m of tags.models ?? []) {
        if (typeof m.name === "string" && m.remote_host) byName.add(m.name);
      }
    }
  } catch {
    // Not Ollama, or not reachable from this page: the name is all there is.
  }
  return models.filter((id) => byName.has(id));
}

/** A failure the panel shows as it is: the message is already the advice. */
export class ServerError extends Error {
  constructor(
    message: string,
    readonly reason: Reachability["state"] | "no-model",
  ) {
    super(message);
    this.name = "ServerError";
  }
}

function abortError(): DOMException {
  return new DOMException("Generation cancelled", "AbortError");
}

/**
 * Read a server-sent-events stream, calling `onPiece` with each piece of
 * answer text as the dialect finds it in an event.
 */
export async function readStream(
  body: ReadableStream<Uint8Array>,
  onPiece: (piece: string) => void,
  pick: (event: unknown) => string | undefined = openaiPiece,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        // A keep-alive or a line this dialect does not define; not the answer.
        continue;
      }
      const piece = pick(event);
      if (piece) onPiece(piece);
    }
  }
}

/** The answer without a model's inline reasoning, if it wrote any. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

export function serverProvider(
  settings: ServerSettings,
  fetchImpl: Fetch = fetch,
  allowed: UrlPolicy = isLocalUrl,
  dialect: Dialect = OPENAI_DIALECT,
): AiProvider {
  return {
    kind: "server",
    available: () => allowed(settings.baseUrl) && settings.model !== "",
    async generate(chat: ChatMessage[], options?: GenerateOptions): Promise<string> {
      if (options?.signal?.aborted) throw abortError();
      if (!settings.model) throw new ServerError("No model is chosen.", "no-model");
      if (!allowed(settings.baseUrl)) {
        throw new ServerError("The server address is not on this machine.", "not-local");
      }
      let response: Response;
      try {
        response = await fetchImpl(
          endpoint(settings.baseUrl, dialect.chatPath(settings.model)),
          {
            method: "POST",
            headers: { ...headers(settings), ...dialect.headers },
            signal: options?.signal,
            body: JSON.stringify(dialect.body(settings.model, chat)),
          },
        );
      } catch (err) {
        if (options?.signal?.aborted) throw abortError();
        const why = await probeServer(settings, fetchImpl, allowed, dialect);
        throw new ServerError(
          err instanceof Error ? err.message : String(err),
          why.state === "ok" ? "down" : why.state,
        );
      }
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new ServerError(
          `The server answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
          "http",
        );
      }
      let text = "";
      try {
        const onPiece = (piece: string) => {
          text += piece;
          options?.onToken?.(stripThinking(text));
        };
        await (dialect.read
          ? dialect.read(response.body, onPiece)
          : readStream(response.body, onPiece, dialect.piece));
      } catch (err) {
        if (options?.signal?.aborted) throw abortError();
        throw err;
      }
      return stripThinking(text);
    },
  };
}
