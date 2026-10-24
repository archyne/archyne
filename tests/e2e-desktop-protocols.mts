/**
 * The hosted dialects through the desktop shell, set up in the panel: an
 * Anthropic Messages service, an Azure OpenAI deployment, Amazon Bedrock,
 * Google Vertex AI and Alibaba Cloud Model Studio, each a stand-in on a loopback port that answers only in
 * its own dialect and only with its own credentials — for Bedrock, a SigV4
 * signature checked the way AWS checks it, over the request as it arrived;
 * for Vertex, a token issued for a service account's signed assertion.
 *
 * What only the real app can show: that choosing a kind of service in the
 * panel fills in what it should, that the choice reaches the shell, and that
 * the shell then speaks that service's dialect end to end — the answer
 * landing in the diagram is the proof.
 *
 * Run:  npm run build, then npx tsx tests/e2e-desktop-protocols.mts
 */
import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import { authorizationServer } from "../src/ai/host/authServer.testkit";
import { bedrockEvent, verifySigV4 } from "../src/ai/host/sigv4.testkit";

let failed = false;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failed = true;
    console.error(`✗ ${label} — ${detail}`);
  }
}

const ANTHROPIC_KEY = "sk-ant-e2e-51c9";
const AZURE_KEY = "azure-e2e-0d77";
const DASHSCOPE_KEY = "sk-dashscope-e2e-7a1f";
const AWS_KEYS = { accessKeyId: "AKIDE2EBEDROCK", secretAccessKey: "e2e/bedrock+secret" };
const AWS_SCOPE = { region: "eu-central-1", service: "bedrock" };
const seen: Array<{
  url: string;
  body?: Record<string, unknown>;
  signature?: string;
  authorization?: string;
}> = [];

// Google, as far as Vertex needs it: an authorization server that takes a
// service account's assertion, and the service account's key file.
const serviceAccount = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_EMAIL = "diagrams-e2e@acme-ai.iam.gserviceaccount.com";
const KEY_FILE = JSON.stringify({
  type: "service_account",
  project_id: "acme-ai",
  private_key_id: "kid-e2e",
  private_key: serviceAccount.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  client_email: SA_EMAIL,
});
const google = authorizationServer({
  assertion: { issuer: SA_EMAIL, publicKey: serviceAccount.publicKey, keyId: "kid-e2e" },
});
await google.start();

/** The user's document, out of the envelope prompt.ts wraps it in. */
function documentOf(text: string): string {
  const start = text.lastIndexOf("It looks like this:\n\n");
  const end = text.lastIndexOf("\n\nChange it so that:");
  return text.slice(start + "It looks like this:\n\n".length, end).trim();
}

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse(await readRaw(req)) as Record<string, unknown>;
}

const sse = (name: string, data: unknown) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

const service = createServer(async (req, res) => {
  const url = req.url ?? "";
  if (url.startsWith("/anthropic/")) {
    if (
      req.headers["x-api-key"] !== ANTHROPIC_KEY ||
      req.headers["anthropic-version"] !== "2023-06-01"
    ) {
      seen.push({ url });
      res.writeHead(401).end('{"type":"error","error":{"type":"authentication_error"}}');
      return;
    }
    if (req.method === "GET" && url.startsWith("/anthropic/v1/models")) {
      seen.push({ url });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-e2e", type: "model" }], has_more: false }));
      return;
    }
    if (req.method === "POST" && url === "/anthropic/v1/messages") {
      const body = await readBody(req);
      seen.push({ url, body });
      const messages = body.messages as Array<{ content: string }>;
      const answer = `${documentOf(messages.at(-1)!.content)}\n  claude["Via Messages"]`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse("message_start", { type: "message_start", message: { id: "m1" } }));
      res.write(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "THINKING-NOT-ANSWER" },
        }),
      );
      res.write(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: answer },
        }),
      );
      res.end(sse("message_stop", { type: "message_stop" }));
      return;
    }
  }
  if (url.startsWith("/azure/")) {
    if (req.headers["api-key"] !== AZURE_KEY) {
      seen.push({ url });
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" && url === "/azure/openai/v1/models") {
      seen.push({ url });
      res.writeHead(200, { "Content-Type": "application/json" });
      // What Azure lists are base models, not the deployments a call names.
      res.end(JSON.stringify({ data: [{ id: "gpt-base-model" }] }));
      return;
    }
    if (req.method === "POST" && url === "/azure/openai/v1/chat/completions") {
      const body = await readBody(req);
      seen.push({ url, body });
      const messages = body.messages as Array<{ content: string }>;
      const answer = `${documentOf(messages.at(-1)!.content)}\n  azure["Via a deployment"]`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
  }
  if (url.startsWith("/alibaba/")) {
    if (req.headers.authorization !== `Bearer ${DASHSCOPE_KEY}`) {
      seen.push({ url });
      res.writeHead(401).end('{"code":"InvalidApiKey"}');
      return;
    }
    // compatible-mode documents no model list: a 404, as Model Studio may answer.
    if (req.method === "GET" && url === "/alibaba/compatible-mode/v1/models") {
      seen.push({ url });
      res.writeHead(404).end();
      return;
    }
    if (req.method === "POST" && url === "/alibaba/compatible-mode/v1/chat/completions") {
      const body = await readBody(req);
      seen.push({ url, body });
      const messages = body.messages as Array<{ content: string }>;
      const answer = `${documentOf(messages.at(-1)!.content)}\n  qwen["Via Model Studio"]`;
      const thinking = { choices: [{ delta: { reasoning_content: "THINKING-NOT-ANSWER" } }] };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(thinking)}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
  }
  if (url.startsWith("/bedrock/")) {
    const raw = await readRaw(req);
    const signature = await verifySigV4(
      {
        method: req.method ?? "GET",
        url: `${base}${url}`,
        headers: req.headers,
        body: raw || undefined,
      },
      AWS_KEYS,
      AWS_SCOPE,
    );
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    seen.push({ url, body, signature: signature.ok ? "ok" : signature.why });
    if (!signature.ok) {
      res
        .writeHead(403)
        .end('{"message":"The request signature we calculated does not match"}');
      return;
    }
    if (req.method === "POST" && /^\/bedrock\/model\/[^/]+\/converse-stream$/.test(url)) {
      const messages = body!.messages as Array<{ content: Array<{ text: string }> }>;
      const answer = `${documentOf(messages.at(-1)!.content.at(-1)!.text)}\n  aws["Via Converse"]`;
      res.writeHead(200, { "Content-Type": "application/vnd.amazon.eventstream" });
      res.write(bedrockEvent("messageStart", { role: "assistant" }));
      res.write(
        bedrockEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: answer } }),
      );
      res.end(bedrockEvent("messageStop", { stopReason: "end_turn" }));
      return;
    }
  }
  if (url.startsWith("/vertex/")) {
    const authorization = req.headers.authorization;
    if (authorization !== `Bearer ${google.issued.accessToken}` || !google.issued.accessToken) {
      seen.push({ url, authorization });
      res.writeHead(401).end();
      return;
    }
    const location = "/vertex/v1/projects/acme-ai/locations/global";
    if (req.method === "GET" && url === location) {
      seen.push({ url, authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "projects/acme-ai/locations/global" }));
      return;
    }
    if (req.method === "POST" && url === `${location}/endpoints/openapi/chat/completions`) {
      const body = await readBody(req);
      seen.push({ url, body, authorization });
      const messages = body.messages as Array<{ content: string }>;
      const answer = `${documentOf(messages.at(-1)!.content)}\n  gcp["Via Vertex"]`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
  }
  seen.push({ url });
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

const userData = mkdtempSync(join(tmpdir(), "archyne-protocols-"));
const app = await electron.launch({
  args: ["desktop/main.cjs", `--user-data-dir=${userData}`],
});
// The shell's file dialog, answered with whatever file is set next.
await app.evaluate(({ dialog }) => {
  dialog.showOpenDialog = (async () => ({
    canceled: false,
    filePaths: [(globalThis as unknown as { next: string }).next],
  })) as typeof dialog.showOpenDialog;
});
const page = await app.firstWindow();
await page.waitForSelector(".app", { timeout: 60_000 });
await page.getByRole("button", { name: "More" }).click();
await page
  .getByRole("group", { name: "More" })
  .getByRole("button", { name: "Generate" })
  .click();
await page.waitForSelector("#panel-generate");
await page.getByRole("combobox", { name: "Engine" }).selectOption("remote");

const field = (label: string) =>
  page.locator(".ai-server-field", { hasText: label }).locator("input").first();
const kind = page.getByRole("combobox", { name: "Kind of service" });
const openSettings = async () => {
  if ((await page.locator(".ai-server[open]").count()) === 0) {
    await page.locator(".ai-server summary").click();
  }
};
/** Whether a label drawn from an answer is on the canvas. */
const onCanvas = (label: string) =>
  page
    .getByText(label, { exact: true })
    .first()
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
const send = async (request: string) => {
  if ((await page.locator(".ai-server[open]").count()) > 0) {
    // Open, the settings have the panel; the conversation is a click away.
    await page.getByRole("button", { name: "Back to the conversation" }).click();
  }
  // A turn already answered matches ".done" too: wait for one more answer
  // than there was, not for any — or the check after this reads the stand-in
  // before this turn has reached it, and passes or fails by how fast it went.
  const before = await page.locator(".ai-assistant.done, .ai-assistant.error").count();
  await page.locator(".ai-composer textarea").fill(request);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".ai-assistant.done, .ai-assistant.error").length > n,
    before,
    { timeout: 30_000 },
  );
  return (await page.locator(".ai-assistant").last().textContent()) ?? "";
};

/* ---------- Anthropic Messages ---------- */

await page.getByRole("button", { name: "Add service" }).click();
await kind.selectOption("anthropic");
check(
  "choosing Anthropic fills in its address and its key header",
  (await field("Address").inputValue()) === "https://api.anthropic.com/v1" &&
    (await page.getByRole("combobox", { name: "Authentication" }).inputValue()) === "header" &&
    (await field("Header").inputValue()) === "x-api-key" &&
    (await field("Prefix").inputValue()) === "",
  `${await field("Address").inputValue()} / ${await field("Header").inputValue()}`,
);
await field("Address").fill(`${base}/anthropic/v1`);
await field("API key").fill(ANTHROPIC_KEY);
await field("API key").press("Enter");
await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="ok"]', { timeout: 15_000 });
check(
  "the shell lists Anthropic's models with the key and the API version",
  seen.some((s) => s.url === "/anthropic/v1/models?limit=1000"),
  JSON.stringify(seen.map((s) => s.url)),
);
await page.getByRole("combobox", { name: "Model" }).selectOption("claude-e2e");
const claudeTurn = await send("add a step from Claude");
const messagesCall = seen.filter((s) => s.url === "/anthropic/v1/messages").at(-1);
check(
  "a turn goes out as Messages: system as a field, no temperature, a token budget",
  typeof messagesCall?.body?.system === "string" &&
    !(messagesCall.body.messages as Array<{ role: string }>).some((m) => m.role === "system") &&
    !("temperature" in messagesCall.body) &&
    typeof messagesCall.body.max_tokens === "number",
  JSON.stringify(messagesCall?.body ? Object.keys(messagesCall.body) : null),
);
check(
  "the answer lands, without the thinking",
  (await page.locator(".ai-assistant.done").count()) === 1 &&
    !claudeTurn.includes("THINKING-NOT-ANSWER") &&
    (await onCanvas("Via Messages")),
  claudeTurn,
);

/* ---------- Azure OpenAI / AI Foundry ---------- */

await openSettings();
await page.getByRole("button", { name: "Add service" }).click();
await kind.selectOption("azure");
check(
  "choosing Azure fills in its key header and asks for a deployment, not a listed model",
  (await field("Header").inputValue()) === "api-key" &&
    (await page.getByRole("combobox", { name: "Model" }).count()) === 0 &&
    (await field("Deployment").count()) === 1,
  await field("Header").inputValue(),
);
await field("Address").fill(`${base}/azure/openai/v1`);
await field("API key").fill(AZURE_KEY);
await field("API key").press("Enter");
await field("Deployment").fill("diagrams-gpt");
await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="ok"]', { timeout: 15_000 });
await send("add a step from Azure");
const azureCall = seen.filter((s) => s.url === "/azure/openai/v1/chat/completions").at(-1);
check(
  "a turn names the deployment at the v1 address, and the answer lands",
  azureCall?.body?.model === "diagrams-gpt" && (await onCanvas("Via a deployment")),
  JSON.stringify(azureCall?.body?.model),
);

/* ---------- Amazon Bedrock, signed with SigV4 ---------- */

await openSettings();
await page.getByRole("button", { name: "Add service" }).click();
await kind.selectOption("bedrock");
check(
  "choosing Bedrock fills in the runtime address and a SigV4 signature for its region",
  (await field("Address").inputValue()) === "https://bedrock-runtime.us-east-1.amazonaws.com" &&
    (await page.getByRole("combobox", { name: "Authentication" }).inputValue()) === "sigv4" &&
    (await field("Region").inputValue()) === "us-east-1",
  await field("Address").inputValue(),
);
await field("Region").fill("eu-central-1");
check(
  "the address follows the region while it is still the default",
  (await field("Address").inputValue()) ===
    "https://bedrock-runtime.eu-central-1.amazonaws.com",
  await field("Address").inputValue(),
);
await field("Address").fill(`${base}/bedrock`);
for (const [label, value] of [
  ["Access key ID", AWS_KEYS.accessKeyId],
  ["Secret access key", AWS_KEYS.secretAccessKey],
] as const) {
  await field(label).fill(value);
  await field(label).press("Enter");
}
await field("Model ID or inference profile").fill("eu.anthropic.claude-e2e-v1:0");
await page.waitForTimeout(300);
await send("add a step from Bedrock");
const converse = seen.filter((s) => s.url.endsWith("/converse-stream")).at(-1);
check(
  "the turn reached the stand-in signed, the signature valid over what arrived",
  converse?.signature === "ok" &&
    converse.url === "/bedrock/model/eu.anthropic.claude-e2e-v1%3A0/converse-stream",
  JSON.stringify(converse ? { url: converse.url, signature: converse.signature } : null),
);
check("the Converse answer lands", await onCanvas("Via Converse"), "");
const awsView = await page.evaluate(() => ({
  storage: JSON.stringify({ ...localStorage }),
  html: document.documentElement.outerHTML,
}));
check(
  "the secret access key is not in the page",
  !awsView.storage.includes(AWS_KEYS.secretAccessKey) &&
    !awsView.html.includes(AWS_KEYS.secretAccessKey),
  "found in the page",
);

/* ---------- Google Vertex AI, as a service account ---------- */

await openSettings();
await page.getByRole("button", { name: "Add service" }).click();
await kind.selectOption("vertex");
check(
  "choosing Vertex fills in its address, and a service account's sign-in at Google",
  (await field("Address").inputValue()).includes("aiplatform.googleapis.com") &&
    (await page.getByRole("combobox", { name: "Authentication" }).inputValue()) === "oauth" &&
    (await page.getByRole("combobox", { name: "How to sign in" }).inputValue()) ===
      "jwt_bearer" &&
    (await field("Authorization server").inputValue()) === "https://accounts.google.com",
  await field("Authorization server").inputValue(),
);
await field("Address").fill(
  `${base}/vertex/v1/projects/acme-ai/locations/global/endpoints/openapi`,
);
await field("Authorization server").fill(google.base);
// The service account's key file, as Google hands it out, chosen in the dialog.
const keyFile = join(userData, "acme-ai-key.json");
writeFileSync(keyFile, KEY_FILE);
await app.evaluate((_electron, path) => {
  (globalThis as unknown as { next: string }).next = path;
}, keyFile);
await page
  .getByRole("button", { name: "Choose file… Private key (or a JSON key file)" })
  .click();
await page.locator('.ai-secret-file[data-saved="true"]').first().waitFor({ timeout: 15_000 });
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForSelector('[data-auth="signed-in"], [data-auth="signed-out"]', {
  timeout: 30_000,
});
const exchange = google.log.find(
  (l) => l.body?.grant_type === "urn:ietf:params:oauth:grant-type:jwt-bearer",
);
check(
  "the key file alone signs the service account in: an assertion Google's stand-in verified",
  (await page.locator('[data-auth="signed-in"]').count()) === 1 &&
    exchange?.assertion?.iss === SA_EMAIL,
  JSON.stringify(exchange?.assertion ?? exchange?.body ?? null),
);
await field("Model").fill("google/gemini-e2e");
await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="ok"]', { timeout: 15_000 });
await send("add a step from Vertex");
const vertexCall = seen
  .filter((s) => s.url.endsWith("/endpoints/openapi/chat/completions"))
  .at(-1);
check(
  "a turn reaches Vertex with the issued token, naming the model, and the answer lands",
  vertexCall?.authorization === `Bearer ${google.issued.accessToken}` &&
    vertexCall.body?.model === "google/gemini-e2e" &&
    (await onCanvas("Via Vertex")),
  JSON.stringify(vertexCall?.body?.model ?? null),
);
const gcpView = await page.evaluate(() => ({
  storage: JSON.stringify({ ...localStorage }),
  html: document.documentElement.outerHTML,
}));
const keyLine = KEY_FILE.split("\\n")[2] ?? "";
check(
  "neither the key file nor the token is in the page",
  keyLine.length > 20 &&
    [keyLine, google.issued.accessToken].every(
      (secret) => !gcpView.storage.includes(secret) && !gcpView.html.includes(secret),
    ),
  "found in the page",
);

/* ---------- Alibaba Cloud Model Studio ---------- */

await openSettings();
await page.getByRole("button", { name: "Add service" }).click();
await kind.selectOption("alibaba");
check(
  "choosing Alibaba fills in Singapore's compatible-mode address and a bearer key",
  (await field("Address").inputValue()) ===
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" &&
    (await field("Header").inputValue()) === "Authorization" &&
    (await field("Prefix").inputValue()) === "Bearer ",
  `${await field("Address").inputValue()} / ${await field("Header").inputValue()}`,
);
await field("Address").fill(`${base}/alibaba/compatible-mode/v1`);
await field("API key").fill(DASHSCOPE_KEY);
await field("API key").press("Enter");
await field("Model").fill("qwen-plus");
await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="ok"]', { timeout: 15_000 });
const qwenTurn = await send("add a step from Qwen");
const qwenCall = seen
  .filter((s) => s.url === "/alibaba/compatible-mode/v1/chat/completions")
  .at(-1);
check(
  "a service with no model list still connects, and a turn lands without the thinking",
  qwenCall?.body?.model === "qwen-plus" &&
    !qwenTurn.includes("THINKING-NOT-ANSWER") &&
    (await onCanvas("Via Model Studio")),
  JSON.stringify({
    model: qwenCall?.body?.model ?? null,
    turn: qwenTurn,
    seen: seen.slice(-6).map((s) => s.url),
  }),
);

await app.close();
google.close();
service.close();
service.closeAllConnections();
rmSync(userData, { recursive: true, force: true });
if (failed) process.exit(1);
console.log(
  "\nAnthropic, Azure OpenAI, Amazon Bedrock, Google Vertex AI and Alibaba Cloud work through the desktop shell",
);
