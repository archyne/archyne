/**
 * Generate through the VS Code extension, in a real VS Code.
 *
 * The extension's call handler is unit-tested against the real host
 * (extensions/vscode/src/aiCalls.test.ts); what only a real window shows is
 * the rest of the path: that the webview acquires its one handle on the
 * extension host and shares it with the canvas bridge, that the page's calls
 * reach `attachAi`, that `ai-host.cjs` loads from the packaged `media/host`,
 * and that SecretStorage keeps the key out of the page and out of plain text
 * on disk.
 *
 * VS Code is downloaded once by @vscode/test-electron (cached in
 * `.vscode-test/`) and driven by Playwright as the Electron app it is; the
 * Archyne webview is an iframe inside the workbench. Fresh profile and
 * extensions directories, so the person's own VS Code is never touched.
 *
 * Run:  npm run build, then in extensions/vscode `npm run build`, then
 *       npx tsx tests/e2e-vscode-ai.mts
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { _electron as electron, type Frame } from "playwright";

let failed = false;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failed = true;
    console.error(`✗ ${label} — ${detail}`);
  }
}

const extension = resolve("extensions/vscode");
for (const built of ["out/extension.js", "media/app/index.html", "media/host/ai-host.cjs"]) {
  if (!existsSync(join(extension, built))) {
    console.error(
      `extensions/vscode/${built} is missing: build the app and the extension first.`,
    );
    process.exit(1);
  }
}

/* ---------- the stand-in service ---------- */

const SECRET = "vsc-e2e-s3cr3t-91c2";
const seen: Array<{ url: string; key?: string }> = [];

function documentOf(text: string): string {
  const start = text.lastIndexOf("It looks like this:\n\n");
  const end = text.lastIndexOf("\n\nChange it so that:");
  return text.slice(start + "It looks like this:\n\n".length, end).trim();
}

const service = createServer((req: IncomingMessage, res) => {
  const key = req.headers["x-api-key"] as string | undefined;
  seen.push({ url: req.url ?? "", key });
  if (key !== SECRET) {
    res.writeHead(401).end("bad key");
    return;
  }
  if (req.method === "GET" && req.url?.endsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "vsc-model" }] }));
    return;
  }
  if (req.method === "POST" && req.url?.endsWith("/v1/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
      const answer = `${documentOf(parsed.messages.at(-1)!.content)}\n  vsc["Via VS Code"]`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

/* ---------- a throwaway VS Code ---------- */

const root = mkdtempSync(join(tmpdir(), "archyne-vsc-"));
const userData = join(root, "user-data");
const workspace = join(root, "workspace");
mkdirSync(join(userData, "User"), { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    // The editor contributes at "option" priority, so a person picks it —
    // here, the way a person would make it stick.
    "workbench.editorAssociations": { "*.mmd": "archyne.editor" },
    "workbench.startupEditor": "none",
    "security.workspace.trust.enabled": false,
    "extensions.autoUpdate": false,
    "telemetry.telemetryLevel": "off",
  }),
);
const diagram = join(workspace, "flow.mmd");
writeFileSync(diagram, 'flowchart TD\n  a["Start"] --> b["Done"]\n');

const executablePath = await downloadAndUnzipVSCode("stable");
const app = await electron.launch({
  executablePath,
  args: [
    `--extensionDevelopmentPath=${extension}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${join(root, "extensions")}`,
    "--disable-extensions",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    workspace,
    diagram,
  ],
});
const window = await app.firstWindow();

/** The Archyne page: the frame, inside the webview's frames, that holds `.app`. */
async function archyneFrame(): Promise<Frame> {
  // Generous: a first start initialises a fresh profile and activates the
  // extension, and on a cold machine that alone has taken over a minute.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    for (const frame of window.frames()) {
      if (
        await frame
          .locator(".app")
          .count()
          .catch(() => 0)
      )
        return frame;
    }
    await window.waitForTimeout(500);
  }
  throw new Error("The Archyne webview never appeared.");
}
const page = await archyneFrame();
check("the .mmd opens in the Archyne webview", true, "");

await page.getByRole("button", { name: "More" }).click();
await page
  .getByRole("group", { name: "More" })
  .getByRole("button", { name: "Generate" })
  .click();
await page.waitForSelector("#panel-generate");

const engines = await page
  .getByRole("combobox", { name: "Engine" })
  .locator("option")
  .allTextContents();
check(
  "VS Code offers a remote service",
  engines.includes("Remote service"),
  engines.join(", "),
);
await page.getByRole("combobox", { name: "Engine" }).selectOption("remote");

await page.getByRole("button", { name: "Add service" }).click();
const field = (label: string) =>
  page.locator(".ai-server-field", { hasText: label }).locator("input").first();
await field("Address").fill(`${base}/v1`);
await page.getByRole("combobox", { name: "Authentication" }).selectOption("header");
await field("Header").fill("x-api-key");
await field("Prefix").fill("");
await field("API key").fill(SECRET);
await field("API key").press("Enter");
await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="ok"]', { timeout: 30_000 });
check("with the key in SecretStorage the service answers", true, "");

const pageView = await page.evaluate(() => ({
  storage: JSON.stringify({ ...localStorage }),
  html: document.documentElement.outerHTML,
}));
check(
  "the key is nowhere in the webview: not its storage, not its markup",
  !pageView.storage.includes(SECRET) && !pageView.html.includes(SECRET),
  "found in the webview",
);

await page.getByRole("combobox", { name: "Model" }).selectOption("vsc-model");
await page.locator(".ai-composer textarea").fill("add a step from VS Code");
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.waitForSelector(".ai-assistant.done, .ai-assistant.error", { timeout: 60_000 });
const chat = seen.filter((s) => s.url.endsWith("/chat/completions")).at(-1);
check(
  "the answer lands, and the extension host sent the key",
  (await page.locator(".ai-assistant.done").count()) === 1 && chat?.key === SECRET,
  JSON.stringify(chat),
);

await app.close();
service.close();
service.closeAllConnections();

/** Every file under a directory, for the plain-text search below. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const inClear = files(userData).filter((path) => {
  try {
    return readFileSync(path).includes(SECRET);
  } catch {
    return false;
  }
});
check(
  "nothing in VS Code's profile holds the key in plain text",
  inClear.length === 0,
  inClear.join(", "),
);

rmSync(root, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("\nGenerate through VS Code keeps its secret in the extension host");
