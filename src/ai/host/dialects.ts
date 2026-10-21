import { EventStreamCodec } from "@smithy/core/event-streams";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { OPENAI_DIALECT, ServerError, type Dialect } from "../server";
import type { ChatMessage } from "../types";
import type { Protocol } from "./connection";

/**
 * The hosted dialects, spoken only from a host process — the page reaches
 * loopback servers alone, and those all speak OpenAI's.
 */

/**
 * Anthropic's Messages API (`POST {base}/messages`, base ending in `/v1`).
 *
 * Its differences from the OpenAI dialect are the ones that matter here: the
 * system prompt is a field, not a message; `max_tokens` is required; the
 * answer streams as `text_delta`s inside `content_block_delta` events, beside
 * thinking deltas that are not part of it; and an error can arrive mid-stream
 * as an `error` event after a 200.
 *
 * No `temperature`: models after Claude Opus 4.6 reject any value but the
 * default with a 400, so sending 0 would break the newest ones.
 */
export const ANTHROPIC_DIALECT: Dialect = {
  // The list is paginated, 20 by default; one page of the most there may be.
  modelsPath: "models?limit=1000",
  chatPath: () => "messages",
  headers: { "anthropic-version": "2023-06-01" },
  body: (model: string, chat: ChatMessage[]) => {
    const system = chat
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    return {
      model,
      max_tokens: 8192,
      ...(system ? { system } : {}),
      messages: chat
        .filter((m) => m.role !== "system")
        .map(({ role, content }) => ({ role, content })),
      stream: true,
    };
  },
  piece: (event) => {
    const e = event as {
      type?: unknown;
      delta?: { type?: unknown; text?: unknown };
      error?: { type?: unknown; message?: unknown };
    };
    if (e.type === "error") {
      const why = typeof e.error?.message === "string" ? e.error.message : e.error?.type;
      throw new ServerError(
        `The service reported an error: ${String(why ?? "unknown")}`,
        "http",
      );
    }
    if (e.type !== "content_block_delta" || e.delta?.type !== "text_delta") return undefined;
    return typeof e.delta.text === "string" ? e.delta.text : undefined;
  },
};

/**
 * Amazon Bedrock's Converse API (`POST {base}/model/{id}/converse-stream`,
 * base `https://bedrock-runtime.{region}.amazonaws.com`), one shape for every
 * model Bedrock serves.
 *
 * The stream is not SSE but AWS's binary event stream: length-prefixed
 * messages, each with typed headers naming the event and a JSON payload.
 * Only `contentBlockDelta.delta.text` is the answer; `reasoningContent`
 * deltas are the model thinking, and an `exception` message is an error that
 * arrived after the 200.
 *
 * No `temperature` and no `maxTokens`: Converse passes them through to the
 * model, and what one model requires another refuses — the newest Claude
 * models reject any temperature but the default, some models cap the output
 * below a budget that suits another. The model's defaults suit a diagram.
 */
export const BEDROCK_DIALECT: Dialect = {
  modelsPath: null,
  chatPath: (model) => `model/${encodeURIComponent(model)}/converse-stream`,
  body: (_model: string, chat: ChatMessage[]) => {
    const system = chat.filter((m) => m.role === "system").map((m) => ({ text: m.content }));
    // Converse wants the turns to alternate; two in a row become one.
    const messages: Array<{ role: string; content: Array<{ text: string }> }> = [];
    for (const m of chat) {
      if (m.role === "system") continue;
      const last = messages.at(-1);
      if (last?.role === m.role) last.content.push({ text: m.content });
      else messages.push({ role: m.role, content: [{ text: m.content }] });
    }
    return { ...(system.length ? { system } : {}), messages };
  },
  read: readEventStream,
  listModels: bedrockModels,
};

/** AWS's event stream, read as it arrives: each message once it is whole. */
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onPiece: (piece: string) => void,
): Promise<void> {
  const codec = new EventStreamCodec(toUtf8, fromUtf8);
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const joined = new Uint8Array(buffer.length + value.length);
    joined.set(buffer);
    joined.set(value, buffer.length);
    buffer = joined;
    // Each message starts with its own total length, big-endian.
    while (buffer.length >= 4) {
      const total = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
      if (buffer.length < total) break;
      // Checks both CRCs; a corrupted message throws rather than misleads.
      const message = codec.decode(buffer.subarray(0, total));
      buffer = buffer.slice(total);
      const header = (name: string) => {
        const h = message.headers[name];
        return h && h.type === "string" ? h.value : undefined;
      };
      const payload = JSON.parse(toUtf8(message.body) || "{}") as {
        message?: unknown;
        delta?: { text?: unknown };
      };
      const kind = header(":message-type");
      if (kind === "exception" || kind === "error") {
        const name = header(":exception-type") ?? header(":error-code") ?? "error";
        const why = typeof payload.message === "string" ? `: ${payload.message}` : "";
        throw new ServerError(`The service reported ${name}${why}`, "http");
      }
      if (
        header(":event-type") === "contentBlockDelta" &&
        typeof payload.delta?.text === "string"
      ) {
        onPiece(payload.delta.text);
      }
    }
  }
}

/**
 * What a person can name as the model: the inference profiles first — the
 * newest models are served only through one — then the base models that
 * stream text on demand. Both lists come from Bedrock's control plane, the
 * runtime's host without `-runtime`, signed the same way.
 *
 * Listing needs `bedrock:ListInferenceProfiles` and
 * `bedrock:ListFoundationModels`, which a key allowed only to invoke may
 * lack; the panel takes a typed model id all the same.
 */
async function bedrockModels(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<string[] | { status: number }> {
  const runtime = new URL(baseUrl);
  if (!/^bedrock-runtime(-fips)?\./.test(runtime.hostname)) return [];
  const control = `${runtime.protocol}//${runtime.host.replace("bedrock-runtime", "bedrock")}`;
  const profiles = await fetchImpl(`${control}/inference-profiles?maxResults=1000`);
  if (!profiles.ok) return { status: profiles.status };
  const models = await fetchImpl(`${control}/foundation-models?byOutputModality=TEXT`);
  if (!models.ok) return { status: models.status };
  const p = (await profiles.json()) as {
    inferenceProfileSummaries?: Array<{ inferenceProfileId?: unknown; status?: unknown }>;
  };
  const m = (await models.json()) as {
    modelSummaries?: Array<{
      modelId?: unknown;
      responseStreamingSupported?: unknown;
      inferenceTypesSupported?: unknown;
    }>;
  };
  const ids: string[] = [];
  for (const profile of p.inferenceProfileSummaries ?? []) {
    if (typeof profile.inferenceProfileId === "string" && profile.status !== "INACTIVE") {
      ids.push(profile.inferenceProfileId);
    }
  }
  for (const model of m.modelSummaries ?? []) {
    if (
      typeof model.modelId === "string" &&
      model.responseStreamingSupported !== false &&
      Array.isArray(model.inferenceTypesSupported) &&
      model.inferenceTypesSupported.includes("ON_DEMAND")
    ) {
      ids.push(model.modelId);
    }
  }
  return ids;
}

/**
 * Google Vertex AI through its OpenAI-compatible endpoint
 * (`https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi`,
 * or `aiplatform.googleapis.com` for `global`), with models named
 * `google/gemini-…`. The wire is OpenAI's; the token is Google's — OAuth with
 * the `cloud-platform` scope, from a service account's signed assertion or a
 * person signing in.
 *
 * The endpoint lists no models, so a check asks for the location itself: one
 * authenticated GET that proves the token, the project and the address.
 */
export const VERTEX_DIALECT: Dialect = {
  ...OPENAI_DIALECT,
  relays: false,
  modelsPath: null,
  listModels: async (baseUrl, fetchImpl) => {
    const location = /^(.*\/projects\/[^/]+\/locations\/[^/]+)\/endpoints\/openapi\/?$/.exec(
      baseUrl,
    )?.[1];
    if (!location) return [];
    const response = await fetchImpl(location);
    return response.ok ? [] : { status: response.status };
  },
};

/**
 * Alibaba Cloud Model Studio (DashScope) speaks the OpenAI dialect at
 * `…/compatible-mode/v1`, with an API key as a bearer token. Its model list
 * is not documented for that mode, so a 404 there is a service that answers
 * but does not list: the model is typed, and the key is proven by the first
 * turn instead. Any other refusal — a key from another region is a 401 — is
 * reported as it is.
 */
export const ALIBABA_DIALECT: Dialect = {
  ...OPENAI_DIALECT,
  relays: false,
  listModels: async (baseUrl, fetchImpl) => {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`);
    if (response.status === 404) return [];
    if (!response.ok) return { status: response.status };
    const body = (await response.json().catch(() => null)) as {
      data?: Array<{ id?: unknown }>;
    } | null;
    return (body?.data ?? [])
      .map((m) => (typeof m.id === "string" ? m.id : ""))
      .filter((id) => id && !/embed|rerank|tts|asr|image|wanx/i.test(id));
  },
};

/**
 * The dialect for each protocol a connection can name.
 *
 * Azure OpenAI and AI Foundry are the OpenAI dialect: their v1 API
 * (`https://{resource}.openai.azure.com/openai/v1`, or `.services.ai.azure.com`)
 * takes no `api-version` and names a deployment where OpenAI names a model.
 * What makes them a protocol of their own is the panel's defaults — the
 * `api-key` header, the Entra scope — not the wire.
 */
export function dialectFor(protocol: Protocol): Dialect | null {
  switch (protocol) {
    case "openai":
    case "azure":
      return OPENAI_DIALECT;
    case "anthropic":
      return ANTHROPIC_DIALECT;
    case "bedrock":
      return BEDROCK_DIALECT;
    case "vertex":
      return VERTEX_DIALECT;
    case "alibaba":
      return ALIBABA_DIALECT;
    case "vault":
      return null;
  }
}
