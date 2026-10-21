/**
 * Generate through the desktop shell, in the real Electron app.
 *
 * What only this can show: that the page, the preload bridge and the main
 * process agree on the `ai:*` calls; that a secret typed into the panel goes
 * to the main process, is stored encrypted (safeStorage) and never comes back
 * — not in the page, not in its storage, not in clear on disk; that the main
 * process adds it to the request; and that the local server, reached through
 * the shell, needs no CORS from the server at all.
 *
 * A stand-in OpenAI-compatible service on a loopback port wants an `api-key`
 * header. Loopback because a plain-http remote is refused by design (that rule
 * is unit-tested in src/ai/host); the path through the shell is the same.
 *
 * Run:  npm run build, then npx tsx tests/e2e-desktop-ai.mts
 * (Opens an Archyne window for a few seconds. Needs a system keychain — the
 * shell refuses to keep secrets without one — so on Linux run it inside a
 * desktop session.)
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
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

const SECRET = "s3cr3t-e2e-7f41";
const seen: Array<{ url: string; key?: string; tenant?: string }> = [];

/** The user's document, out of the envelope prompt.ts wraps it in. */
function documentOf(text: string): string {
  const start = text.lastIndexOf("It looks like this:\n\n");
  const end = text.lastIndexOf("\n\nChange it so that:");
  return text.slice(start + "It looks like this:\n\n".length, end).trim();
}

const service = createServer((req: IncomingMessage, res) => {
  // No CORS headers at all: only a caller that is not a page can use this.
  const key = req.headers["api-key"] as string | undefined;
  seen.push({ url: req.url ?? "", key, tenant: req.headers["x-tenant"] as string | undefined });
  if (req.url?.startsWith("/local/")) {
    // The "local server": no key needed.
  } else if (key !== SECRET) {
    res.writeHead(401).end("bad key");
    return;
  }
  if (req.method === "GET" && req.url?.endsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "gw-model" }] }));
    return;
  }
  if (req.method === "POST" && req.url?.endsWith("/v1/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
      const answer = `${documentOf(parsed.messages.at(-1)!.content)}\n  remote["Via the shell"]`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
const port = (service.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

const userData = mkdtempSync(join(tmpdir(), "archyne-e2e-"));
const app = await electron.launch({
  args: ["desktop/main.cjs", `--user-data-dir=${userData}`],
});
const page = await app.firstWindow();
await page.waitForSelector(".app", { timeout: 60_000 });

const openGenerate = async () => {
  await page.getByRole("button", { name: "More" }).click();
  await page
    .getByRole("group", { name: "More" })
    .getByRole("button", { name: "Generate" })
    .click();
  await page.waitForSelector("#panel-generate");
};
await openGenerate();

const engines = await page
  .getByRole("combobox", { name: "Engine" })
  .locator("option")
  .allTextContents();
check(
  "the desktop offers a remote service",
  engines.includes("Remote service"),
  engines.join(", "),
);
await page.getByRole("combobox", { name: "Engine" }).selectOption("remote");

/* ---------- set up a service with an API key in a header ---------- */

await page.getByRole("button", { name: "Add service" }).click();
const field = (label: string) =>
  page.locator(".ai-server-field", { hasText: label }).locator("input").first();
await field("Address").fill(`${base}/v1`);
await page.getByRole("combobox", { name: "Authentication" }).selectOption("header");
await field("Header").fill("api-key");
await field("Prefix").fill("");
await page
  .locator(".ai-server-field", { hasText: "Extra headers" })
  .locator("textarea")
  .fill("X-Tenant: acme");
await page.locator(".ai-server-field", { hasText: "Extra headers" }).locator("textarea").blur();

// A wrong key first: the service says 401 and the panel says what that means.
await field("API key").fill("wrong-key");
await field("API key").press("Enter");
await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="http"]', { timeout: 15_000 });
check(
  "a refused key is explained as refused credentials",
  /refused the credentials \(401\)/.test(
    (await page.locator(".ai-server-status").textContent()) ?? "",
  ),
  (await page.locator(".ai-server-status").textContent()) ?? "",
);

await field("API key").fill(SECRET);
await field("API key").press("Enter");
await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="ok"]', { timeout: 15_000 });
check("with the right key the service answers", true, "");

/* ---------- the secret stays in the shell ---------- */

const pageView = await page.evaluate(() => ({
  storage: JSON.stringify({ ...localStorage }),
  inputs: [...document.querySelectorAll("input")]
    .map((i) => (i as HTMLInputElement).value)
    .join("|"),
  html: document.documentElement.outerHTML,
}));
check(
  "the key is nowhere in the page: not its storage, not its inputs, not its markup",
  !pageView.storage.includes(SECRET) &&
    !pageView.inputs.includes(SECRET) &&
    !pageView.html.includes(SECRET),
  "found in the page",
);
check(
  "the key field reads as saved, not as the key",
  (await field("API key").getAttribute("data-saved")) === "true" &&
    (await field("API key").inputValue()) === "",
  await field("API key").inputValue(),
);
const onDisk = existsSync(join(userData, "ai-secrets.json"))
  ? readFileSync(join(userData, "ai-secrets.json"), "utf8")
  : "";
check(
  "on disk it is stored, encrypted",
  onDisk.length > 0 && !onDisk.includes(SECRET),
  onDisk ? "plain text on disk" : "nothing on disk",
);

/* ---------- a turn through the shell ---------- */

await page.getByRole("combobox", { name: "Model" }).selectOption("gw-model");
if ((await page.locator(".ai-server[open]").count()) > 0) {
  // Open, the settings have the panel; the conversation is a click away.
  await page.getByRole("button", { name: "Back to the conversation" }).click();
}
await page.locator(".ai-composer textarea").fill("add a step from the remote service");
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.waitForSelector(".ai-assistant.done, .ai-assistant.error", { timeout: 30_000 });
const chat = seen.filter((s) => s.url.endsWith("/chat/completions")).at(-1);
check(
  "the answer lands, and the shell sent the key and the extra header",
  (await page.locator(".ai-assistant.done").count()) === 1 &&
    chat?.key === SECRET &&
    chat?.tenant === "acme",
  JSON.stringify(chat),
);

/* ---------- plain http off this machine is refused ---------- */

// Choosing a model folds the settings away; open them again to edit.
if ((await page.locator(".ai-server[open]").count()) === 0) {
  await page.locator(".ai-server summary").click();
}
await field("Address").fill("http://example.com/v1");
await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="not-local"]', { timeout: 15_000 });
check(
  "plain http to another machine is refused before anything is sent",
  /Use an https address/.test((await page.locator(".ai-server-status").textContent()) ?? "") &&
    !seen.some((s) => s.url.includes("example.com")),
  (await page.locator(".ai-server-status").textContent()) ?? "",
);

/* ---------- removing the service forgets its key ---------- */

await page.getByRole("button", { name: "Remove service" }).click();
await page.waitForTimeout(500);
const afterRemove = existsSync(join(userData, "ai-secrets.json"))
  ? readFileSync(join(userData, "ai-secrets.json"), "utf8")
  : "{}";
check(
  "removing the service deletes its key from the keychain file",
  Object.keys(JSON.parse(afterRemove)).length === 0,
  afterRemove,
);

/* ---------- the local server, through the shell, needs no CORS ---------- */

await page.getByRole("combobox", { name: "Engine" }).selectOption("server");
const address = page.locator(".ai-server-field", { hasText: "Address" }).locator("input");
await address.fill(`${base}/local/v1`);
await address.press("Enter");
await page.waitForSelector('.ai-server-status[data-state="ok"]', { timeout: 15_000 });
check("a local server that sends no CORS headers works through the shell", true, "");

await app.close();
service.close();
service.closeAllConnections();
rmSync(userData, { recursive: true, force: true });
if (failed) process.exit(1);
console.log(
  "\nGenerate through the desktop shell keeps its secrets and reaches what it should",
);
