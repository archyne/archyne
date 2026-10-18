// @vitest-environment node
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Connection } from "./connection";
import { AiHost, type HostEvent, type SecretStore } from "./core";

/**
 * Google Vertex AI through the host, against a scripted Google: discovery at
 * accounts.google.com, a service account's assertion exchanged at
 * oauth2.googleapis.com, and the OpenAI-compatible endpoint called with the
 * token it issues.
 */

function memorySecrets(): SecretStore {
  const data = new Map<string, string>();
  return {
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_FILE = JSON.stringify({
  type: "service_account",
  project_id: "acme-ai",
  private_key_id: "kid-vertex",
  private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  client_email: "diagrams@acme-ai.iam.gserviceaccount.com",
});
const BASE =
  "https://aiplatform.googleapis.com/v1/projects/acme-ai/locations/global/endpoints/openapi";
const TOKEN = "ya29.vertex-test-token";

type Seen = { url: string; headers: Record<string, string>; body?: string };

function google(): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const encoder = new TextEncoder();
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      new Headers(init?.headers as HeadersInit).entries(),
    ) as Record<string, string>;
    const body = typeof init?.body === "string" ? init.body : undefined;
    seen.push({ url, headers, body });
    if (url === "https://accounts.google.com/.well-known/openid-configuration") {
      return Response.json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
      });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(body);
      const [h, p, sig] = (form.get("assertion") ?? "").split(".");
      const signed = verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        pair.publicKey,
        Buffer.from(sig ?? "", "base64url"),
      );
      if (!signed) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: TOKEN, token_type: "Bearer", expires_in: 3599 });
    }
    if (headers.authorization !== `Bearer ${TOKEN}`) return new Response("", { status: 401 });
    if (url === "https://aiplatform.googleapis.com/v1/projects/acme-ai/locations/global") {
      return Response.json({ name: "projects/acme-ai/locations/global" });
    }
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

const VERTEX: Connection = {
  id: "gcp",
  label: "Vertex",
  baseUrl: BASE,
  protocol: "vertex",
  auth: {
    type: "oauth",
    flow: "jwt_bearer",
    issuer: "https://accounts.google.com",
    scopes: "https://www.googleapis.com/auth/cloud-platform",
  },
};

describe("Google Vertex AI", () => {
  it("exchanges a service account's assertion the way Google documents, then calls the endpoint", async () => {
    const svc = google();
    const host = new AiHost({ fetch: svc.fetch, secrets: memorySecrets() });
    await host.setConnections([VERTEX]);
    await host.setSecret("gcp", "privateKey", KEY_FILE);
    const auth: HostEvent[] = [];
    await host.signIn("gcp", (e) => auth.push(e));
    expect(auth.at(-1)).toMatchObject({ state: "signed-in" });

    const exchange = svc.seen.find((s) => s.url === "https://oauth2.googleapis.com/token")!;
    const form = new URLSearchParams(exchange.body);
    // Google: grant type and assertion only — the scope rides in the assertion.
    expect([...form.keys()].sort()).toEqual(["assertion", "grant_type"]);
    const [h, p] = form.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toMatchObject({
      alg: "RS256",
      kid: "kid-vertex",
    });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({
      iss: "diagrams@acme-ai.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/cloud-platform",
    });

    const events: HostEvent[] = [];
    await host.chat(
      "r1",
      "gcp",
      "google/gemini-test",
      [{ role: "user", content: "draw" }],
      (e) => events.push(e),
    );
    expect(svc.seen.at(-1)?.url).toBe(`${BASE}/chat/completions`);
    expect(JSON.parse(svc.seen.at(-1)!.body!)).toMatchObject({ model: "google/gemini-test" });
    expect(events.at(-1)).toMatchObject({ type: "ai:done", text: "graph TD" });
  });

  it("checks a connection by asking for its location, which proves the token and the project", async () => {
    const svc = google();
    const host = new AiHost({ fetch: svc.fetch, secrets: memorySecrets() });
    await host.setConnections([VERTEX]);
    await host.setSecret("gcp", "privateKey", KEY_FILE);
    expect(await host.probe("gcp")).toEqual({ state: "ok", models: [], remote: [] });
    expect(svc.seen.at(-1)?.url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/acme-ai/locations/global",
    );
  });
});
