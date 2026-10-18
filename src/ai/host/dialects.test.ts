import { describe, expect, it } from "vitest";
import type { Connection } from "./connection";
import { AiHost, secretKey, type HostEvent, type SecretStore } from "./core";
import { ANTHROPIC_DIALECT } from "./dialects";

/**
 * The hosted dialects, through the host: what goes on the wire for each, and
 * what of a streamed answer is the answer.
 */

function memorySecrets(): SecretStore {
  const data = new Map<string, string>();
  return {
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

type Seen = { url: string; headers: Record<string, string>; body?: unknown };

/** A service that answers one scripted stream, in whatever dialect it is given. */
function service(models: unknown, events: string[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const encoder = new TextEncoder();
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.includes("/models")) return Response.json(models);
    if (url.endsWith("/api/tags")) throw new Error("not asked of a hosted service");
    return new Response(
      new ReadableStream({
        start(c) {
          for (const e of events) c.enqueue(encoder.encode(e));
          c.close();
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetch: fake, seen };
}

const sse = (name: string, data: unknown) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

const CLAUDE: Connection = {
  id: "claude",
  label: "Claude",
  baseUrl: "https://api.anthropic.com/v1",
  protocol: "anthropic",
  auth: { type: "header", name: "x-api-key" },
};

const CHAT = [
  { role: "system" as const, content: "You draw diagrams." },
  { role: "user" as const, content: "a login flow" },
  { role: "assistant" as const, content: "flowchart TD" },
  { role: "user" as const, content: "now with a retry" },
];

async function run(host: AiHost, connection: Connection, model = "claude-test") {
  const events: HostEvent[] = [];
  await host.chat("r1", connection.id, model, CHAT, (e) => events.push(e));
  return events;
}

describe("Anthropic Messages", () => {
  const stream = [
    sse("message_start", { type: "message_start", message: { id: "m1" } }),
    sse("content_block_start", { type: "content_block_start", index: 0 }),
    sse("ping", { type: "ping" }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "the user wants a retry" },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "flowchart TD\n" },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "  A --> B" },
    }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    sse("message_stop", { type: "message_stop" }),
  ];

  it("sends the system prompt as a field, with the key and the API version", async () => {
    const svc = service({ data: [] }, stream);
    const host = new AiHost({ fetch: svc.fetch, secrets: memorySecrets() });
    await host.setConnections([CLAUDE]);
    await host.setSecret("claude", "key", "sk-ant-test");
    const events = await run(host, CLAUDE);

    const call = svc.seen.find((s) => s.url.endsWith("/messages"));
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.headers["x-api-key"]).toBe("sk-ant-test");
    expect(call?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call?.body).toEqual({
      model: "claude-test",
      max_tokens: 8192,
      system: "You draw diagrams.",
      messages: CHAT.slice(1),
      stream: true,
    });
    expect(call?.body).not.toHaveProperty("temperature");
    expect(events.at(-1)).toEqual({
      type: "ai:done",
      requestId: "r1",
      text: "flowchart TD\n  A --> B",
    });
  });

  it("keeps the thinking out of the answer", async () => {
    const svc = service({ data: [] }, stream);
    const host = new AiHost({ fetch: svc.fetch, secrets: memorySecrets() });
    await host.setConnections([CLAUDE]);
    const events = await run(host, CLAUDE);
    const texts = events.flatMap((e) => ("text" in e ? [e.text] : []));
    expect(texts.every((t) => !t.includes("retry"))).toBe(true);
  });

  it("reports an error that arrives after the stream began", async () => {
    const svc = service({ data: [] }, [
      stream[0],
      sse("error", {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    ]);
    const host = new AiHost({ fetch: svc.fetch, secrets: memorySecrets() });
    await host.setConnections([CLAUDE]);
    const events = await run(host, CLAUDE);
    expect(events.at(-1)).toMatchObject({
      type: "ai:error",
      reason: "http",
      detail: expect.stringContaining("Overloaded"),
    });
  });

  it("lists the models from the whole first page, and asks nothing Ollama-specific", async () => {
    const svc = service(
      { data: [{ id: "claude-a", type: "model" }, { id: "claude-b" }], has_more: false },
      [],
    );
    const host = new AiHost({ fetch: svc.fetch, secrets: memorySecrets() });
    await host.setConnections([CLAUDE]);
    await host.setSecret("claude", "key", "sk-ant-test");
    expect(await host.probe("claude")).toEqual({
      state: "ok",
      models: ["claude-a", "claude-b"],
      remote: [],
    });
    expect(svc.seen.map((s) => s.url)).toEqual([
      "https://api.anthropic.com/v1/models?limit=1000",
    ]);
    expect(svc.seen[0].headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("finds no answer in an event it does not define", () => {
    expect(ANTHROPIC_DIALECT.piece!({ type: "ping" })).toBeUndefined();
    expect(
      ANTHROPIC_DIALECT.piece!({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: "{" },
      }),
    ).toBeUndefined();
  });
});

describe("Azure OpenAI and AI Foundry", () => {
  it("speak the OpenAI dialect at the v1 address, naming a deployment", async () => {
    const svc = service({ data: [] }, [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "graph TD" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    const secrets = memorySecrets();
    const host = new AiHost({ fetch: svc.fetch, secrets });
    const azure: Connection = {
      id: "az",
      label: "Azure",
      baseUrl: "https://acme.openai.azure.com/openai/v1",
      protocol: "azure",
      auth: { type: "header", name: "api-key" },
    };
    await host.setConnections([azure]);
    await host.setSecret("az", "key", "azure-key");
    expect(await secrets.get(secretKey("az", "key"))).toBe("azure-key");
    const events = await run(host, azure, "my-gpt-deployment");

    const call = svc.seen.at(-1);
    expect(call?.url).toBe("https://acme.openai.azure.com/openai/v1/chat/completions");
    expect(call?.url).not.toContain("api-version");
    expect(call?.headers["api-key"]).toBe("azure-key");
    expect(call?.body).toMatchObject({ model: "my-gpt-deployment", stream: true });
    expect(events.at(-1)).toMatchObject({ type: "ai:done", text: "graph TD" });
  });
});
