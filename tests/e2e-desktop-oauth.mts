/**
 * OAuth sign-in through the desktop shell, in the real Electron app.
 *
 * Against the stand-in authorization server (src/ai/host/authServer.testkit),
 * which also plays the protected service. The person types only the
 * service's address: the authorization server is found from the service's
 * Protected Resource Metadata (RFC 9728) and Archyne registers itself (RFC
 * 7591). Then: sign in through the browser (PKCE, loopback redirect), call
 * the service with the token, sign out (revoked), and sign in again with a
 * device code shown in the panel.
 *
 * The system browser is the one thing replaced: Playwright patches
 * `shell.openExternal` inside Electron's main process with a browser that
 * consents at once and follows the redirect back to the loopback listener —
 * so no real browser opens, and the app's own code is unchanged.
 *
 * Run:  npm run build, then npx tsx tests/e2e-desktop-oauth.mts
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import { authorizationServer } from "../src/ai/host/authServer.testkit";

let failed = false;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failed = true;
    console.error(`✗ ${label} — ${detail}`);
  }
}

const as = authorizationServer({ pendingPolls: 3 });
await as.start();

const userData = mkdtempSync(join(tmpdir(), "archyne-oauth-"));
const app = await electron.launch({
  args: ["desktop/main.cjs", `--user-data-dir=${userData}`],
});

// The browser: consents at once and follows the redirect home. Patched in the
// main process, where the app calls shell.openExternal.
await app.evaluate(({ shell }) => {
  shell.openExternal = async (url: string) => {
    if (!url.includes("/authorize")) return; // a device-code page: nothing to follow
    const consent = await fetch(url, { redirect: "manual" });
    const back = consent.headers.get("location");
    if (back) await fetch(back);
  };
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
await page.getByRole("button", { name: "Add service" }).click();

const field = (label: string) =>
  page.locator(".ai-server-field", { hasText: label }).locator("input").first();
await field("Address").fill(`${as.base}/v1`);
await page.getByRole("combobox", { name: "Authentication" }).selectOption("oauth");
await field("Scopes").fill("models.read");
const authState = () => page.locator("[data-auth]").getAttribute("data-auth");

/* ---------- sign in through the browser ---------- */

await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForSelector('[data-auth="signed-in"]', { timeout: 30_000 });
check(
  "signed in with only the service's address: server found (RFC 9728), Archyne registered (RFC 7591)",
  as.log.some((l) => l.path === "/.well-known/oauth-protected-resource/v1") &&
    as.registered.length === 1,
  JSON.stringify(as.log.map((l) => l.path)),
);
check(
  "the code exchange carried a PKCE verifier the server checked",
  !!as.log.find((l) => l.body?.grant_type === "authorization_code")?.body?.code_verifier,
  "no verifier",
);

await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="ok"]', { timeout: 15_000 });
check("the service answers with the token the shell holds", true, "");

const { accessToken, refreshToken } = as.issued;
const pageView = await page.evaluate(() => ({
  storage: JSON.stringify({ ...localStorage }),
  html: document.documentElement.outerHTML,
}));
check(
  "no token is in the page: not its storage, not its markup",
  ![accessToken, refreshToken].some(
    (t) => pageView.storage.includes(t) || pageView.html.includes(t),
  ),
  "found a token in the page",
);
const onDisk = existsSync(join(userData, "ai-secrets.json"))
  ? readFileSync(join(userData, "ai-secrets.json"), "utf8")
  : "";
check(
  "on disk the tokens are stored, encrypted",
  onDisk.length > 0 && !onDisk.includes(accessToken) && !onDisk.includes(refreshToken),
  onDisk ? "a token in clear on disk" : "nothing on disk",
);

/* ---------- a turn with the token ---------- */

await page.getByRole("combobox", { name: "Model" }).selectOption("secured-model");
// The stand-in answers chat with 404; what matters is that the request left
// with the token — the probe above already proved the API accepts it.
const before = as.log.length;
await page.locator(".ai-composer textarea").fill("anything");
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.waitForSelector(".ai-assistant.done, .ai-assistant.error", { timeout: 30_000 });
check(
  "a turn reaches the service",
  as.log.slice(before).some((l) => l.path === "/v1/chat/completions"),
  JSON.stringify(as.log.slice(before).map((l) => l.path)),
);

/* ---------- sign out, then sign in with a device code ---------- */

if ((await page.locator(".ai-server[open]").count()) === 0) {
  await page.locator(".ai-server summary").click();
}
await page.getByRole("button", { name: "Sign out" }).click();
await page.waitForSelector('[data-auth="signed-out"]', { timeout: 15_000 });
check(
  "signing out revokes at the server",
  as.log.some((l) => l.path === "/revoke"),
  "no revocation",
);

await page.getByRole("combobox", { name: "How to sign in" }).selectOption("device_code");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForSelector(".ai-oauth-code", { timeout: 15_000 });
const code = await page.locator(".ai-oauth-code").textContent();
check("the device code is shown for the person to type", code === "WDJB-MJHT", String(code));
await page.waitForSelector('[data-auth="signed-in"]', { timeout: 30_000 });
check(
  "once the person finishes, the shell is signed in",
  (await authState()) === "signed-in",
  "",
);

await app.close();
as.close();
rmSync(userData, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("\nOAuth through the desktop shell signs in, uses, revokes, and keeps its tokens");
