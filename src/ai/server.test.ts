import { describe, expect, it } from "vitest";
import {
  isLocalUrl,
  presetOf,
  probeServer,
  readStream,
  serverProvider,
  ServerError,
  stripThinking,
  type ServerSettings,
} from "./server";
import type { ChatMessage } from "./types";

/**
 * The server engine is exercised against a scripted `fetch`: the dialect is
 * small and fixed (OpenAI chat completions, streamed as server-sent events),
 * and what matters is how this file reads it and how it explains a failure.
 * A real LM Studio was used to check the dialect itself; see server.ts.
 */

const SETTINGS: ServerSettings = { baseUrl: "http://localhost:1234/v1", model: "qwen" };
const MSG: ChatMessage[] = [{ role: "user", content: "draw me a thing" }];

/** A response whose body streams the given SSE chunks, split where given. */
function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

const event = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

type Call = { url: string; init?: RequestInit };

function scripted(handler: (call: Call) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: fake, calls };
}

describe("the address", () => {
  it("is only ever loopback", () => {
    expect(isLocalUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLocalUrl("https://api.example.com/v1")).toBe(false);
    expect(isLocalUrl("http://192.168.1.10:1234/v1")).toBe(false);
    expect(isLocalUrl("not a url")).toBe(false);
  });

  it("knows which server it belongs to, by port, whichever loopback name is used", () => {
    expect(presetOf("http://localhost:11434/v1")).toBe("ollama");
    expect(presetOf("http://127.0.0.1:1234/v1/")).toBe("lmstudio");
    expect(presetOf("http://localhost:8080/v1")).toBeNull();
  });
});

describe("readStream", () => {
  it("joins the answer from deltas, even when an event is split across chunks", async () => {
    const pieces: string[] = [];
    const whole = event({ content: "flowchart" }) + event({ content: " TD" });
    await readStream(
      sse([whole.slice(0, 20), whole.slice(20), "data: [DONE]\n\n"]).body!,
      (p) => pieces.push(p),
    );
    expect(pieces.join("")).toBe("flowchart TD");
  });

  it("leaves a reasoning model's thinking out of the answer", async () => {
    const pieces: string[] = [];
    await readStream(
      sse([event({ reasoning_content: "let me think" }), event({ content: "graph TD" })]).body!,
      (p) => pieces.push(p),
    );
    expect(pieces.join("")).toBe("graph TD");
  });

  it("drops inline <think> blocks, closed or still open", () => {
    expect(stripThinking("<think>hmm</think>\nflowchart TD")).toBe("flowchart TD");
    expect(stripThinking("flowchart TD\n<think>still going")).toBe("flowchart TD");
  });
});

describe("serverProvider", () => {
  it("posts the conversation to chat/completions and streams the answer back", async () => {
    const { fetch, calls } = scripted(() =>
      sse([
        event({ content: "flowchart TD\n" }),
        event({ content: "  a --> b" }),
        "data: [DONE]\n\n",
      ]),
    );
    const seen: string[] = [];
    const text = await serverProvider(SETTINGS, fetch).generate(MSG, {
      onToken: (t) => seen.push(t),
    });
    expect(text).toBe("flowchart TD\n  a --> b");
    expect(seen.at(-1)).toBe(text);
    expect(calls[0].url).toBe("http://localhost:1234/v1/chat/completions");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({ model: "qwen", stream: true, temperature: 0, messages: MSG });
  });

  it("sends a key only when one is set", async () => {
    const { fetch, calls } = scripted(() => sse(["data: [DONE]\n\n"]));
    await serverProvider(SETTINGS, fetch).generate(MSG);
    await serverProvider({ ...SETTINGS, apiKey: "k" }, fetch).generate(MSG);
    const auth = calls.map((c) => (c.init?.headers as Record<string, string>).Authorization);
    expect(auth).toEqual([undefined, "Bearer k"]);
  });

  it("is not available until a model is picked, and never off loopback", () => {
    expect(serverProvider({ ...SETTINGS, model: "" }).available()).toBe(false);
    expect(
      serverProvider({ ...SETTINGS, baseUrl: "https://api.example.com/v1" }).available(),
    ).toBe(false);
    expect(serverProvider(SETTINGS).available()).toBe(true);
  });

  it("refuses an address off this machine without making a request", async () => {
    const { fetch, calls } = scripted(() => sse([]));
    const run = serverProvider(
      { ...SETTINGS, baseUrl: "https://api.example.com/v1" },
      fetch,
    ).generate(MSG);
    await expect(run).rejects.toMatchObject({ reason: "not-local" });
    expect(calls).toHaveLength(0);
  });

  it("explains a refused origin as such, not as a dead server", async () => {
    // A CORS refusal: the real request fails, the no-cors probe resolves.
    const { fetch } = scripted((call) => {
      if (call.init?.mode === "no-cors") return new Response(null, { status: 200 });
      throw new TypeError("Failed to fetch");
    });
    const run = serverProvider(SETTINGS, fetch).generate(MSG);
    await expect(run).rejects.toBeInstanceOf(ServerError);
    await expect(serverProvider(SETTINGS, fetch).generate(MSG)).rejects.toMatchObject({
      reason: "blocked",
    });
  });

  it("explains a closed port as a server that is not running", async () => {
    const { fetch } = scripted(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(serverProvider(SETTINGS, fetch).generate(MSG)).rejects.toMatchObject({
      reason: "down",
    });
  });

  it("passes on what the server said when it answers with an error", async () => {
    const { fetch } = scripted(() => new Response("model not loaded", { status: 404 }));
    await expect(serverProvider(SETTINGS, fetch).generate(MSG)).rejects.toThrow(
      /404: model not loaded/,
    );
  });

  it("comes back as an AbortError when stopped", async () => {
    const ctrl = new AbortController();
    const { fetch } = scripted(() => {
      ctrl.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const run = serverProvider(SETTINGS, fetch).generate(MSG, { signal: ctrl.signal });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("probeServer", () => {
  it("lists the models, leaving out embedding models that cannot chat", async () => {
    const { fetch } = scripted(() =>
      Response.json({ data: [{ id: "qwen/qwen3-coder-30b" }, { id: "text-embedding-nomic" }] }),
    );
    expect(await probeServer(SETTINGS, fetch)).toEqual({
      state: "ok",
      models: ["qwen/qwen3-coder-30b"],
      remote: [],
    });
  });

  it("tells which listed models only relay to a cloud service", async () => {
    // Ollama: the OpenAI list does not say, its own /api/tags does.
    const { fetch } = scripted((call) =>
      call.url.endsWith("/api/tags")
        ? Response.json({
            models: [
              { name: "gpt-oss:120b-cloud", remote_host: "https://ollama.com" },
              { name: "qwen3:8b" },
              { name: "relay-model", remote_host: "https://example.com" },
            ],
          })
        : Response.json({
            data: [{ id: "gpt-oss:120b-cloud" }, { id: "qwen3:8b" }, { id: "relay-model" }],
          }),
    );
    const result = await probeServer(
      { ...SETTINGS, baseUrl: "http://localhost:11434/v1" },
      fetch,
    );
    expect(result).toMatchObject({
      state: "ok",
      remote: ["gpt-oss:120b-cloud", "relay-model"],
    });
  });

  it("falls back to Ollama's -cloud naming when /api/tags cannot be read", async () => {
    const { fetch } = scripted((call) => {
      if (call.url.endsWith("/api/tags")) throw new TypeError("Failed to fetch");
      return Response.json({ data: [{ id: "deepseek-v3.1:671b-cloud" }, { id: "qwen3:8b" }] });
    });
    expect(await probeServer(SETTINGS, fetch)).toMatchObject({
      remote: ["deepseek-v3.1:671b-cloud"],
    });
  });

  it("reports an error status", async () => {
    const { fetch } = scripted(() => new Response("", { status: 401 }));
    expect(await probeServer(SETTINGS, fetch)).toEqual({ state: "http", status: 401 });
  });
});
