import { describe, expect, it } from "vitest";
import { AiHost, type SecretStore } from "../../../src/ai/host/core";
import { answerCall, type AiHostLike } from "./aiCalls";

/**
 * The extension host's answers to the webview, with the real shared host
 * behind them. The point is the boundary: what the webview receives back is
 * results and text, and never the secret it sent in.
 */

const SECRET = "vsc-s3cr3t";

function setup() {
  const data = new Map<string, string>();
  const secrets: SecretStore = {
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
  const sentKeys: Array<string | undefined> = [];
  const encoder = new TextEncoder();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = (init?.headers as Record<string, string> | undefined)?.["x-api-key"];
    sentKeys.push(key);
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "m" }] });
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "graph TD" } }] })}\n\n`,
            ),
          );
          c.close();
        },
      }),
    );
  }) as typeof fetch;
  const host = new AiHost({ fetch: fetchImpl, secrets }) as unknown as AiHostLike;
  const posted: unknown[] = [];
  let id = 0;
  const call = async (method: string, ...args: unknown[]) => {
    const callId = ++id;
    await answerCall(
      () => host,
      { type: "ai:call", callId, method, args },
      (m) => posted.push(m),
    );
    return posted.find(
      (m) =>
        (m as { type: string; callId?: number }).type === "ai:result" &&
        (m as { callId: number }).callId === callId,
    ) as { ok: boolean; value?: unknown; error?: string };
  };
  return { call, posted, sentKeys, data };
}

const CONNECTION = {
  id: "gw",
  label: "Gateway",
  baseUrl: "https://gw.example.com/v1",
  protocol: "openai",
  auth: { type: "header", name: "x-api-key" },
};

describe("answerCall", () => {
  it("runs a whole turn: connections, secret, probe, chat — and the secret never comes back", async () => {
    const { call, posted, sentKeys } = setup();
    expect((await call("setConnections", [CONNECTION])).ok).toBe(true);
    expect((await call("setSecret", "gw", "key", SECRET)).ok).toBe(true);
    expect((await call("secretFields", "gw")).value).toEqual(["key"]);
    expect((await call("probe", "gw")).value).toMatchObject({ state: "ok", models: ["m"] });
    expect((await call("chat", "r1", "gw", "m", [{ role: "user", content: "x" }])).ok).toBe(
      true,
    );

    expect(posted).toContainEqual({
      type: "ai:event",
      event: { type: "ai:done", requestId: "r1", text: "graph TD" },
    });
    expect(sentKeys.every((k) => k === SECRET)).toBe(true);
    expect(JSON.stringify(posted)).not.toContain(SECRET);
  });

  it("answers an unknown method with an error, under the same call id", async () => {
    const { call } = setup();
    expect(await call("readSecret", "gw", "key")).toMatchObject({
      ok: false,
      error: "Unknown call.",
    });
  });

  it("ignores messages that are not calls", async () => {
    const posted: unknown[] = [];
    await answerCall(
      () => ({}) as AiHostLike,
      { type: "change", code: "x" } as never,
      (m) => posted.push(m),
    );
    expect(posted).toEqual([]);
  });
});
