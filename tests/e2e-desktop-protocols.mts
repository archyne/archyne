/**
 * The hosted dialects through the desktop shell, set up in the panel: an
 * Anthropic Messages service and an Azure OpenAI deployment, each a stand-in
 * on a loopback port that answers only in its own dialect and only with its
 * own key header.
 *
 * What only the real app can show: that choosing a kind of service in the
 * panel fills in what it should, that the choice reaches the shell, and that
 * the shell then speaks that service's dialect end to end — the answer
 * landing in the diagram is the proof.
 *
 * Run:  npm run build, then npx tsx tests/e2e-desktop-protocols.mts
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright";

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
const seen: Array<{ url: string; body?: Record<string, unknown> }> = [];

/** The user's document, out of the envelope prompt.ts wraps it in. */
function documentOf(text: string): string {
  const start = text.lastIndexOf("It looks like this:\n\n");
  const end = text.lastIndexOf("\n\nChange it so that:");
  return text.slice(start + "It looks like this:\n\n".length, end).trim();
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(JSON.parse(body) as Record<string, unknown>));
  });
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
  seen.push({ url });
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

const userData = mkdtempSync(join(tmpdir(), "archyne-protocols-"));
const app = await electron.launch({
  args: ["desktop/main.cjs", `--user-data-dir=${userData}`],
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
  await page.locator(".ai-composer textarea").fill(request);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForSelector(".ai-assistant.done, .ai-assistant.error", { timeout: 30_000 });
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

await app.close();
service.close();
service.closeAllConnections();
rmSync(userData, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("\nAnthropic and Azure OpenAI work through the desktop shell");
