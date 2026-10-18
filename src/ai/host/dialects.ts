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
    default:
      return null;
  }
}
