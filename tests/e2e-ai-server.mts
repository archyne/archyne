/**
 * The Generate panel against a local model server, in a real browser.
 *
 * A small OpenAI-compatible server stands in for Ollama or LM Studio on a
 * random loopback port, so this runs in CI with no model at all. What it pins
 * is everything between the panel and that server that a unit test cannot
 * see: that the page's own connect-src lets a loopback request through, that
 * a server refusing the page's origin is explained as that (CORS) rather than
 * as a dead server, that a stopped server is explained as stopped, that an
 * answer streams in and lands on the canvas, and that the choice of server
 * survives a reload.
 *
 * Run:  npm run dev, then npx tsx tests/e2e-ai-server.mts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { BASE, CHANNEL } from "./env.mts";

let failed = false;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failed = true;
    console.error(`✗ ${label} — ${detail}`);
  }
}

/* ---------- the stand-in server ---------- */

let allowCors = false;
const received: Array<{ model?: string; stream?: boolean }> = [];

function cors(req: IncomingMessage, res: ServerResponse): void {
  if (!allowCors) return;
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

/** The user's document, out of the envelope prompt.ts wraps it in. */
function documentOf(text: string): string {
  const start = text.lastIndexOf("It looks like this:\n\n");
  const end = text.lastIndexOf("\n\nChange it so that:");
  return text.slice(start + "It looks like this:\n\n".length, end).trim();
}

const server = createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(allowCors ? 204 : 400).end();
    return;
  }
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fake-coder" }, { id: "nomic-embed-text" }] }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as {
        model?: string;
        stream?: boolean;
        messages: Array<{ content: string }>;
      };
      received.push({ model: parsed.model, stream: parsed.stream });
      const answer = `${documentOf(parsed.messages.at(-1)!.content)}\n  srv["From the server"]`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // In a few pieces, as a real server streams it.
      for (let i = 0; i < answer.length; i += 12) {
        const piece = answer.slice(i, i + 12);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const address = `http://127.0.0.1:${port}/v1`;

/* ---------- the page ---------- */

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const cspViolations: string[] = [];
page.on("console", (m) => {
  if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text());
});

const ready = () =>
  page.waitForFunction(
    () =>
      (window as unknown as { __graphTest?: { ready(): boolean } }).__graphTest?.ready() ??
      false,
    undefined,
    { timeout: 60_000 },
  );
const code = () =>
  page.evaluate(
    () =>
      (
        window as unknown as { __graphTest: { store: { getState(): { code: string } } } }
      ).__graphTest.store.getState().code,
  );

await page.goto(BASE);
await ready();
await page.getByRole("button", { name: "More" }).click();
await page
  .getByRole("group", { name: "More" })
  .getByRole("button", { name: "Generate" })
  .click();
await page.waitForSelector("#panel-generate");

await page.getByRole("combobox", { name: "Engine" }).selectOption("server");
const status = page.locator(".ai-server-status");
const addressField = page.locator(".ai-server-field input");

check(
  "choosing the local server opens its settings, and the composer waits for a model",
  (await page.locator(".ai-server[open]").count()) === 1 &&
    (await page.locator(".ai-composer textarea").isDisabled()),
  "settings closed or composer enabled",
);

/* ---------- a server that refuses the page's origin ---------- */

await addressField.fill(address);
await addressField.press("Enter");
await page.waitForSelector('.ai-server-status[data-state="blocked"]', { timeout: 15_000 });
check(
  "a server that refuses this page is explained as CORS, not as a dead server",
  /refuses this page/.test((await status.textContent()) ?? ""),
  (await status.textContent()) ?? "",
);

/* ---------- the same server, once it allows the page ---------- */

allowCors = true;
await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="ok"]', { timeout: 15_000 });
const options = await page
  .getByRole("combobox", { name: "Model" })
  .locator("option")
  .allTextContents();
check(
  "connected: the page's connect-src let a loopback request through",
  cspViolations.length === 0,
  cspViolations.join("\n"),
);
check(
  "the models come from the server, without the embedding model",
  options.includes("fake-coder") && !options.includes("nomic-embed-text"),
  options.join(", "),
);

await page.getByRole("combobox", { name: "Model" }).selectOption("fake-coder");
check(
  "the folded settings name the chosen model, and the composer opens",
  /fake-coder/.test((await page.locator(".ai-server summary").textContent()) ?? "") &&
    !(await page.locator(".ai-composer textarea").isDisabled()),
  (await page.locator(".ai-server summary").textContent()) ?? "",
);

/* ---------- a turn through the server ---------- */

if ((await page.locator(".ai-server[open]").count()) > 0) {
  // Open, the settings have the panel; the conversation is a click away.
  await page.getByRole("button", { name: "Back to the conversation" }).click();
}
await page.locator(".ai-composer textarea").fill("add a step from the server");
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.waitForSelector(".ai-assistant.done, .ai-assistant.error", { timeout: 30_000 });
check(
  "the answer streams in from the server and lands on the canvas",
  (await code()).includes("From the server") &&
    (await page.locator(".ai-assistant.done").count()) === 1,
  (await code()).slice(0, 200),
);
check(
  "the server was asked for the chosen model, streamed",
  received.at(-1)?.model === "fake-coder" && received.at(-1)?.stream === true,
  JSON.stringify(received.at(-1)),
);

/* ---------- the choice survives a reload ---------- */

await page.reload();
await ready();
await page.getByRole("button", { name: "More" }).click();
await page
  .getByRole("group", { name: "More" })
  .getByRole("button", { name: "Generate" })
  .click();
await page.waitForSelector("#panel-generate");
check(
  "after a reload the engine is still the local server, with its model",
  (await page.getByRole("combobox", { name: "Engine" }).inputValue()) === "server" &&
    /fake-coder/.test((await page.locator(".ai-server summary").textContent()) ?? ""),
  await page.getByRole("combobox", { name: "Engine" }).inputValue(),
);

/* ---------- a server that has stopped ---------- */

// Stopped the way a server that quits stops: listening ends and every socket
// drops at once. (Awaiting a graceful close instead, with the browser still
// holding a keep-alive connection, made the headless page crash outright —
// an artefact of this harness, not something a person can do to the app.)
server.close();
server.closeAllConnections();
if ((await page.locator(".ai-server[open]").count()) > 0) {
  // Open, the settings have the panel; the conversation is a click away.
  await page.getByRole("button", { name: "Back to the conversation" }).click();
}
await page.locator(".ai-composer textarea").fill("one more");
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.waitForSelector(".ai-assistant.error", { timeout: 30_000 });
const errorText = (await page.locator(".ai-assistant.error .ai-error").textContent()) ?? "";
check(
  "a stopped server is explained as not running, with its address",
  /Nothing is answering/.test(errorText) && errorText.includes(`127.0.0.1:${port}`),
  errorText,
);

/* ---------- an address off this machine ---------- */

await page.locator(".ai-server summary").click();
await page.locator(".ai-server-field input").fill("http://example.com/v1");
await page.locator(".ai-server-field input").press("Enter");
await page.waitForSelector('.ai-server-status[data-state="not-local"]', { timeout: 15_000 });
check(
  "an address off this machine is refused before anything is sent",
  /on this computer/.test((await status.textContent()) ?? ""),
  (await status.textContent()) ?? "",
);

await browser.close();
if (failed) process.exit(1);
console.log(
  "\nthe Generate panel reaches a local server, explains what stops it, and remembers it",
);
