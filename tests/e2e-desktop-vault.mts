/**
 * A service's key read from a vault, in the real desktop app (AUTH.local.md,
 * phase 5).
 *
 * A fake `az` goes first on the PATH: it writes down how it was called and
 * prints the secret only for the one Key Vault secret it knows. The dialog
 * the shell asks with is replaced by one that writes down what it was asked.
 * What only the real app shows: that a vault and a reference made in the
 * panel reach the shell, that the shell asks in its own window — in the
 * language the app speaks — before the secret first goes anywhere, that it
 * runs the vendor's CLI and sends what it printed, that it reads the secret
 * again when the service refuses it, and that the secret is never in the
 * page nor in the shell's store.
 *
 * Run:  npm run build, then npx tsx tests/e2e-desktop-vault.mts
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { _electron as electron } from "playwright";

let failed = false;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failed = true;
    console.error(`✗ ${label} — ${detail}`);
  }
}

const VAULT = "https://kv-e2e.vault.azure.net";
const FIRST = "sk-vault-e2e-first-91c2";
const ROTATED = "sk-vault-e2e-rotated-4d07";
let accepted = FIRST;

/* ---------- a fake az, first on the PATH ---------- */

const bin = mkdtempSync(join(tmpdir(), "archyne-fake-az-"));
writeFileSync(join(bin, "secret.txt"), FIRST);
writeFileSync(
  join(bin, "az.cjs"),
  `const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(args) + "\\n");
const known = ["keyvault", "secret", "show", "--id", ${JSON.stringify(`${VAULT}/secrets/openai-key`)},
  "--query", "value", "--output", "tsv"];
if (JSON.stringify(args) === JSON.stringify(known)) {
  process.stdout.write(fs.readFileSync(path.join(__dirname, "secret.txt"), "utf8") + "\\n");
  process.exit(0);
}
process.stderr.write("ERROR: (SecretNotFound) A secret with (name/id) " + args[4] + " was not found in this key vault.\\n");
process.exit(1);
`,
);
writeFileSync(join(bin, "az.cmd"), `@node "%~dp0az.cjs" %*\r\n`);
writeFileSync(join(bin, "az"), `#!/bin/sh\nexec node "$(dirname "$0")/az.cjs" "$@"\n`);
chmodSync(join(bin, "az"), 0o755);
const calls = () =>
  existsSync(join(bin, "calls.log"))
    ? readFileSync(join(bin, "calls.log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as string[])
    : [];

/* ---------- the service, which wants the vault's key ---------- */

const seen: Array<{ url: string; authorization?: string }> = [];
function documentOf(text: string): string {
  const start = text.lastIndexOf("It looks like this:\n\n");
  const end = text.lastIndexOf("\n\nChange it so that:");
  return text.slice(start + "It looks like this:\n\n".length, end).trim();
}
const service = createServer((req: IncomingMessage, res) => {
  const authorization = req.headers.authorization;
  seen.push({ url: req.url ?? "", authorization });
  if (authorization !== `Bearer ${accepted}`) {
    res.writeHead(401).end("bad key");
    return;
  }
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "vault-model" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const messages = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages;
    const answer = `${documentOf(messages.at(-1)!.content)}\n  vault["Via the vault"]`;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

/* ---------- the app ---------- */

const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const env = { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ""}` };
const userData = mkdtempSync(join(tmpdir(), "archyne-vault-"));
const app = await electron.launch({
  args: ["desktop/main.cjs", `--user-data-dir=${userData}`],
  env: env as Record<string, string>,
});
// The shell's own question, answered from here and written down.
await app.evaluate(({ dialog }) => {
  const g = globalThis as unknown as { asked: string[]; answer: number };
  g.asked = [];
  g.answer = 1;
  dialog.showMessageBox = (async (...args: unknown[]) => {
    const options = args.at(-1) as { detail?: string };
    g.asked.push(options.detail ?? "");
    return { response: g.answer, checkboxChecked: false };
  }) as typeof dialog.showMessageBox;
});
const asked = () =>
  app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked.slice());

const page = await app.firstWindow();
await page.waitForSelector(".app", { timeout: 60_000 });
await page.getByRole("button", { name: "More" }).click();
await page
  .getByRole("group", { name: "More" })
  .getByRole("button", { name: "Generate" })
  .click();
await page.waitForSelector("#panel-generate");
await page.getByRole("combobox", { name: "Engine" }).selectOption("remote");

const services = page.locator(".ai-server");
const vaults = page.locator(".ai-vaults");
const field = (scope: typeof services, label: string) =>
  scope.locator(".ai-server-field", { hasText: label }).locator("input").first();
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
  const before = await page.locator(".ai-assistant.done, .ai-assistant.error").count();
  if ((await page.locator(".ai-server[open]").count()) > 0) {
    // Open, the settings have the panel; the conversation is a click away.
    await page.getByRole("button", { name: "Back to the conversation" }).click();
  }
  await page.locator(".ai-composer textarea").fill(request);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".ai-assistant.done, .ai-assistant.error").length > n,
    before,
    { timeout: 30_000 },
  );
  return (await page.locator(".ai-assistant").last().textContent()) ?? "";
};

// A service, and a vault.
if ((await page.locator(".ai-server[open]").count()) === 0) {
  await services.locator("summary").click();
}
await page.getByRole("button", { name: "Add service" }).click();
await field(services, "Address").fill(`${base}/v1`);
await vaults.locator("summary").click();
await page.getByRole("button", { name: "Add vault" }).click();
await field(vaults, "Name").fill("Team vault");
await field(vaults, "Address").fill(VAULT);

// The service's key, from the vault.
await page
  .getByRole("combobox", { name: "API key · Source" })
  .selectOption({ label: "From the vault Team vault" });
await field(services, "Secret name").fill("openai-key");
await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="ok"]', { timeout: 30_000 });
const first = await asked();
check(
  "the shell asked, in its own window, which secret goes where and as what",
  first.length === 1 &&
    ["openai-key", "Team vault", base, "API key"].every((s) => first[0].includes(s)),
  JSON.stringify(first),
);
check(
  "it read the secret with the vendor's CLI, by the vault's address and the secret's name",
  calls().length === 1 && calls()[0].includes(`${VAULT}/secrets/openai-key`),
  JSON.stringify(calls()),
);

await page.getByRole("combobox", { name: "Model" }).selectOption("vault-model");
await send("add a step from the vault");
check(
  "the service got the vault's key, and the answer lands",
  seen.some(
    (s) => s.url.endsWith("/chat/completions") && s.authorization === `Bearer ${FIRST}`,
  ) && (await onCanvas("Via the vault")),
  JSON.stringify(seen.map((s) => [s.url, s.authorization])),
);
check(
  "a second turn asks nothing and reads nothing again",
  calls().length === 1,
  String(calls().length),
);

// Rotated in the vault: the service refuses the old key, and the shell reads the new one.
writeFileSync(join(bin, "secret.txt"), ROTATED);
accepted = ROTATED;
const rotatedTurn = await send("add another step");
check(
  "a key rotated in the vault is read again when the service refuses the old one",
  calls().length === 2 &&
    !rotatedTurn.includes("did not draw") &&
    seen.at(-1)?.authorization === `Bearer ${ROTATED}` &&
    (await asked()).length === 1,
  `${calls().length} calls; ${rotatedTurn}`,
);

const view = await page.evaluate(() => ({
  storage: JSON.stringify({ ...localStorage }),
  html: document.documentElement.outerHTML,
}));
const store = existsSync(join(userData, "ai-secrets.json"))
  ? readFileSync(join(userData, "ai-secrets.json"), "utf8")
  : "";
check(
  "the secret is in neither the page nor the shell's store",
  [FIRST, ROTATED].every(
    (s) => !view.storage.includes(s) && !view.html.includes(s) && !store.includes(s),
  ) && view.storage.includes("openai-key"),
  "found",
);

// Another service, the app in Italian, and the person says no.
await app.evaluate(() => {
  (globalThis as unknown as { answer: number }).answer = 0;
});
// Choosing a model folded the settings away.
if ((await page.locator(".ai-server[open]").count()) === 0) {
  await services.locator("summary").click();
}
await page.getByRole("button", { name: "Add service" }).click();
await field(services, "Address").fill(`${base}/other/v1`);
await page
  .getByRole("combobox", { name: "API key · Source" })
  .selectOption({ label: "From the vault Team vault" });
await field(services, "Secret name").fill("other-key");
await page.locator(".overflow-menu > button").click();
await page.locator(".menu-popover select").nth(1).selectOption("it");
await page.keyboard.press("Escape");
await page.waitForFunction(() => document.documentElement.lang === "it");
await services.locator(".ai-server-check .editor-action").first().click();
await page.waitForSelector('.ai-server-status[data-state="vault"]', { timeout: 30_000 });
const italian = (await asked()).at(-1) ?? "";
const refusal =
  (await services.locator('.ai-server-status[data-state="vault"]').textContent()) ?? "";
check(
  "asked in the app's language, a no sends nothing and says so",
  italian.includes("cassaforte") &&
    italian.includes("other-key") &&
    refusal.startsWith("Impossibile leggere un segreto dalla cassaforte") &&
    calls().length === 2 &&
    !seen.some((s) => s.url.startsWith("/other/") && s.authorization),
  `${italian} / ${refusal}`,
);

await app.close();
service.close();
service.closeAllConnections();
rmSync(userData, { recursive: true, force: true });
rmSync(bin, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("\nA key in a vault is asked for, read with the CLI, sent, and never kept");
