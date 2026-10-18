// @vitest-environment node
import { describe, expect, it } from "vitest";
import { connectionProblem, type Connection } from "./connection";
import { AiHost, type HostEvent, type SecretStore } from "./core";
import { bedrockEvent, bedrockException, verifySigV4 } from "./sigv4.testkit";

/**
 * Amazon Bedrock through the host: every request signed (and the signature
 * checked the way AWS checks it), a turn sent as Converse, the binary event
 * stream read into an answer — however it is cut into chunks.
 */

function memorySecrets(): SecretStore {
  const data = new Map<string, string>();
  return {
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

const KEYS = { accessKeyId: "AKIDBEDROCKTEST", secretAccessKey: "bedrock/secret+key" };
const SCOPE = { region: "eu-central-1", service: "bedrock" };

const BEDROCK: Connection = {
  id: "aws",
  label: "Bedrock",
  baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com",
  protocol: "bedrock",
  auth: { type: "sigv4", region: "eu-central-1" },
};

type Seen = {
  url: string;
  method: string;
  body?: string;
  signature: { ok: boolean; why?: string };
};

/** Bedrock, as far as these tests need it: the runtime and the control plane. */
function aws(stream: Uint8Array[], chunk = 0): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const method = init?.method ?? "GET";
    const body = init?.body as string | undefined;
    const signature = await verifySigV4({ method, url, headers, body }, KEYS, SCOPE);
    seen.push({ url, method, body, signature });
    if (!signature.ok) return new Response("{}", { status: 403 });
    const path = new URL(url).pathname;
    if (path === "/inference-profiles") {
      return Response.json({
        inferenceProfileSummaries: [
          { inferenceProfileId: "eu.anthropic.claude-test-v1:0", status: "ACTIVE" },
        ],
      });
    }
    if (path === "/foundation-models") {
      return Response.json({
        modelSummaries: [
          {
            modelId: "amazon.nova-test-v1:0",
            responseStreamingSupported: true,
            inferenceTypesSupported: ["ON_DEMAND"],
          },
          // Only through a profile: not something to call by this id.
          {
            modelId: "anthropic.claude-test-v1:0",
            inferenceTypesSupported: ["INFERENCE_PROFILE"],
          },
          { modelId: "amazon.batch-only-v1", inferenceTypesSupported: ["PROVISIONED"] },
        ],
      });
    }
    const bytes = new Uint8Array(stream.reduce((n, s) => n + s.length, 0));
    let at = 0;
    for (const s of stream) {
      bytes.set(s, at);
      at += s.length;
    }
    return new Response(
      new ReadableStream({
        start(c) {
          // Cut anywhere, as a network does: mid-header, mid-payload.
          const size = chunk || bytes.length;
          for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
          c.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "application/vnd.amazon.eventstream" } },
    );
  }) as typeof fetch;
  return { fetch: fake, seen };
}

async function hostWith(svc: { fetch: typeof fetch }, keys = KEYS) {
  const host = new AiHost({ fetch: svc.fetch, secrets: memorySecrets() });
  await host.setConnections([BEDROCK]);
  await host.setSecret("aws", "accessKeyId", keys.accessKeyId);
  await host.setSecret("aws", "secretAccessKey", keys.secretAccessKey);
  return host;
}

const CHAT = [
  { role: "system" as const, content: "You draw diagrams." },
  { role: "user" as const, content: "a login flow" },
  { role: "user" as const, content: "with a retry" },
];

const ANSWER = [
  bedrockEvent("messageStart", { role: "assistant", p: "abc" }),
  bedrockEvent("contentBlockDelta", {
    contentBlockIndex: 0,
    delta: { reasoningContent: { text: "they want a retry" } },
  }),
  bedrockEvent("contentBlockDelta", {
    contentBlockIndex: 1,
    delta: { text: "flowchart TD\n" },
  }),
  bedrockEvent("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "  A --> B" } }),
  bedrockEvent("contentBlockStop", { contentBlockIndex: 1 }),
  bedrockEvent("messageStop", { stopReason: "end_turn" }),
  bedrockEvent("metadata", { usage: { inputTokens: 10, outputTokens: 5 } }),
];

describe("Amazon Bedrock (Converse)", () => {
  it("signs a Converse turn and reads the event stream into the answer", async () => {
    const svc = aws(ANSWER);
    const host = await hostWith(svc);
    const events: HostEvent[] = [];
    await host.chat("r1", "aws", "eu.anthropic.claude-test-v1:0", CHAT, (e) => events.push(e));

    const call = svc.seen.at(-1)!;
    expect(call.signature).toEqual({ ok: true });
    expect(call.url).toBe(
      "https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-test-v1%3A0/converse-stream",
    );
    expect(JSON.parse(call.body!)).toEqual({
      system: [{ text: "You draw diagrams." }],
      messages: [
        { role: "user", content: [{ text: "a login flow" }, { text: "with a retry" }] },
      ],
    });
    expect(events.at(-1)).toEqual({
      type: "ai:done",
      requestId: "r1",
      text: "flowchart TD\n  A --> B",
    });
  });

  it("reads the stream the same when the network cuts it into small pieces", async () => {
    const svc = aws(ANSWER, 7);
    const host = await hostWith(svc);
    const events: HostEvent[] = [];
    await host.chat("r1", "aws", "m", CHAT, (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "ai:done", text: "flowchart TD\n  A --> B" });
  });

  it("reports an exception that arrives after the 200", async () => {
    const svc = aws([ANSWER[0], bedrockException("throttlingException", "Too many requests")]);
    const host = await hostWith(svc);
    const events: HostEvent[] = [];
    await host.chat("r1", "aws", "m", CHAT, (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({
      type: "ai:error",
      reason: "http",
      detail: expect.stringMatching(/throttlingException: Too many requests/),
    });
  });

  it("lists inference profiles and on-demand models from the control plane, signed", async () => {
    const svc = aws([]);
    const host = await hostWith(svc);
    expect(await host.probe("aws")).toEqual({
      state: "ok",
      models: ["eu.anthropic.claude-test-v1:0", "amazon.nova-test-v1:0"],
      remote: [],
    });
    expect(svc.seen.map((s) => new URL(s.url).host)).toEqual([
      "bedrock.eu-central-1.amazonaws.com",
      "bedrock.eu-central-1.amazonaws.com",
    ]);
    expect(svc.seen.every((s) => s.signature.ok)).toBe(true);
  });

  it("explains a wrong secret as refused credentials", async () => {
    const svc = aws([]);
    const host = await hostWith(svc, { ...KEYS, secretAccessKey: "wrong" });
    expect(await host.probe("aws")).toEqual({ state: "http", status: 403 });
  });

  it("refuses a region that is not one, and extra headers that would forge the signature's own", () => {
    expect(connectionProblem(BEDROCK)).toBeNull();
    expect(
      connectionProblem({ ...BEDROCK, auth: { type: "sigv4", region: "eu central" } }),
    ).toBe("region");
    expect(
      connectionProblem({ ...BEDROCK, headers: { "X-Amz-Date": "20000101T000000Z" } }),
    ).toBe("extra-header");
  });
});
