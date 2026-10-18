import { describe, expect, it } from "vitest";
import { authHeaders, connectionProblem, type Connection } from "./connection";
import { AiHost, secretKey, type HostEvent, type SecretStore } from "./core";

/**
 * The host half of Generate, driven by a scripted network and an in-memory
 * secret store. What matters here is what crosses which boundary: that the
 * credential reaches the service and only the service, that nothing secret
 * comes back in an event, and that the network rules hold.
 */

function memorySecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

type Seen = { url: string; headers: Record<string, string>; redirect?: RequestRedirect };

function service(): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const encoder = new TextEncoder();
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      redirect: init?.redirect,
    });
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "gw-model" }] });
    if (url.endsWith("/api/tags")) return new Response("", { status: 404 });
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "graph TD" } }] })}\n\n`,
            ),
          );
          c.enqueue(encoder.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetch: fake, seen };
}

const GATEWAY: Connection = {
  id: "gw",
  label: "Gateway",
  baseUrl: "https://gateway.example.com/v1",
  protocol: "openai",
  auth: { type: "header", name: "api-key" },
  headers: { "X-Tenant": "acme" },
};

const MSG = [{ role: "user" as const, content: "draw" }];

describe("authHeaders", () => {
  it("puts a key in the header the service asked for, with its prefix", () => {
    expect(
      authHeaders(
        { ...GATEWAY, auth: { type: "header", name: "Authorization", prefix: "Bearer " } },
        { key: "k1" },
      ),
    ).toMatchObject({ Authorization: "Bearer k1" });
    expect(authHeaders(GATEWAY, { key: "k2" })).toEqual({
      "X-Tenant": "acme",
      "api-key": "k2",
    });
  });

  it("encodes Basic credentials as UTF-8", () => {
    const h = authHeaders(
      { ...GATEWAY, auth: { type: "basic", username: "dario" } },
      { password: "pässword" },
    );
    expect(h.Authorization).toBe(
      `Basic ${Buffer.from("dario:pässword", "utf8").toString("base64")}`,
    );
  });

  it("never lets an extra header shadow the credential", () => {
    const sneaky = { ...GATEWAY, headers: { "api-key": "from-config" } };
    expect(authHeaders(sneaky, { key: "secret" })["api-key"]).toBe("secret");
  });
});

describe("connectionProblem", () => {
  it("accepts a well-formed connection", () => {
    expect(connectionProblem(GATEWAY)).toBeNull();
  });

  it("refuses what would make a broken or dangerous request", () => {
    expect(connectionProblem({ ...GATEWAY, protocol: "bedrock" })).toBe("protocol");
    expect(connectionProblem({ ...GATEWAY, auth: { type: "header", name: "bad name" } })).toBe(
      "header-name",
    );
    expect(connectionProblem({ ...GATEWAY, auth: { type: "basic", username: "a:b" } })).toBe(
      "username",
    );
    expect(connectionProblem({ ...GATEWAY, headers: { Authorization: "x" } })).toBe(
      "extra-header",
    );
    expect(connectionProblem({ ...GATEWAY, headers: { Cookie: "x" } })).toBe("extra-header");
  });
});

describe("AiHost", () => {
  it("sends the credential and the extra headers with every request, and nothing back", async () => {
    const secrets = memorySecrets();
    const net = service();
    const host = new AiHost({ fetch: net.fetch, secrets });
    await host.setConnections([GATEWAY]);
    await host.setSecret("gw", "key", "s3cr3t");

    const events: HostEvent[] = [];
    await host.chat("r1", "gw", "gw-model", MSG, (e) => events.push(e));

    const chat = net.seen.find((s) => s.url.endsWith("/chat/completions"))!;
    expect(chat.headers["api-key"]).toBe("s3cr3t");
    expect(chat.headers["X-Tenant"]).toBe("acme");
    expect(events.at(-1)).toEqual({ type: "ai:done", requestId: "r1", text: "graph TD" });
    expect(JSON.stringify(events)).not.toContain("s3cr3t");
  });

  it("refuses to follow a redirect, so a credential cannot be bounced elsewhere", async () => {
    const net = service();
    const host = new AiHost({ fetch: net.fetch, secrets: memorySecrets() });
    await host.setConnections([GATEWAY]);
    await host.chat("r1", "gw", "m", MSG, () => {});
    expect(net.seen.every((s) => s.redirect === "error")).toBe(true);
  });

  it("reaches any https address but plain http only on loopback", async () => {
    const net = service();
    const host = new AiHost({ fetch: net.fetch, secrets: memorySecrets() });
    await host.setConnections([
      GATEWAY,
      { ...GATEWAY, id: "clear", baseUrl: "http://gateway.example.com/v1" },
      { ...GATEWAY, id: "local", baseUrl: "http://localhost:1234/v1" },
    ]);
    expect(await host.probe("gw")).toMatchObject({ state: "ok", models: ["gw-model"] });
    expect(await host.probe("clear")).toEqual({ state: "not-local" });
    expect(await host.probe("local")).toMatchObject({ state: "ok" });
    expect(net.seen.some((s) => s.url.startsWith("http://gateway"))).toBe(false);
  });

  it("tells which secrets are set without ever returning them", async () => {
    const host = new AiHost({ fetch: service().fetch, secrets: memorySecrets() });
    await host.setConnections([GATEWAY]);
    expect(await host.secretFields("gw")).toEqual([]);
    await host.setSecret("gw", "key", "k");
    expect(await host.secretFields("gw")).toEqual(["key"]);
    await host.setSecret("gw", "key", null);
    expect(await host.secretFields("gw")).toEqual([]);
  });

  it("deletes a connection's secrets when the connection is removed", async () => {
    const secrets = memorySecrets();
    const host = new AiHost({ fetch: service().fetch, secrets });
    await host.setConnections([GATEWAY]);
    await host.setSecret("gw", "key", "k");
    expect(secrets.data.has(secretKey("gw", "key"))).toBe(true);
    await host.setConnections([]);
    expect(secrets.data.size).toBe(0);
  });

  it("ignores a malformed connection sent by the page", async () => {
    const host = new AiHost({ fetch: service().fetch, secrets: memorySecrets() });
    await host.setConnections([{ id: "x" } as unknown as Connection, GATEWAY]);
    expect(await host.probe("x")).toEqual({ state: "invalid", problem: "unknown" });
    expect(await host.probe("gw")).toMatchObject({ state: "ok" });
  });

  it("reports an invalid connection instead of calling it", async () => {
    const net = service();
    const host = new AiHost({ fetch: net.fetch, secrets: memorySecrets() });
    await host.setConnections([{ ...GATEWAY, protocol: "vertex" }]);
    const events: HostEvent[] = [];
    await host.chat("r1", "gw", "m", MSG, (e) => events.push(e));
    expect(events).toEqual([
      { type: "ai:error", requestId: "r1", reason: "invalid", detail: "protocol" },
    ]);
    expect(net.seen).toHaveLength(0);
  });

  it("stops a running request on cancel and says so", async () => {
    const host = new AiHost({
      fetch: ((_i: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as typeof fetch,
      secrets: memorySecrets(),
    });
    await host.setConnections([GATEWAY]);
    const events: HostEvent[] = [];
    const run = host.chat("r1", "gw", "m", MSG, (e) => events.push(e));
    host.cancel("r1");
    await run;
    expect(events.at(-1)).toMatchObject({ type: "ai:error", reason: "aborted" });
  });

  it("refuses a secret field name that is not a plain word", async () => {
    const host = new AiHost({ fetch: service().fetch, secrets: memorySecrets() });
    await expect(host.setSecret("gw", "../other", "x")).rejects.toThrow();
  });
});
