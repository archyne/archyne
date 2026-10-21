/**
 * A machine identity through the desktop shell, set up entirely in the panel:
 * OAuth client credentials, the client proven by a private key
 * (private_key_jwt), tokens bound to the host's key (DPoP), and every request
 * made over mutual TLS with a client certificate — against a stand-in that
 * serves HTTPS from a throwaway CA, which the panel is given as a company CA.
 *
 * What only the real app can show: that the multi-line PEM fields reach the
 * shell and nothing comes back; that a certificate and its key chosen as one
 * file, in the shell's own dialog, are read by the shell and never pass
 * through the page; that the shell's mTLS transport, private-key
 * assertion and DPoP proofs all hold together on one connection; and that
 * neither key appears in the page or in clear on disk.
 *
 * Run:  npm run build, then npx tsx tests/e2e-desktop-machine.mts
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import { authorizationServer } from "../src/ai/host/authServer.testkit";
import { testPki } from "../src/ai/host/tls.testkit";

let failed = false;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failed = true;
    console.error(`✗ ${label} — ${detail}`);
  }
}

const pki = await testPki("CN=svc-machine");
const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privatePem = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const as = authorizationServer({
  tls: pki,
  client: { id: "svc-machine", publicKey: signing.publicKey, keyId: "k-e2e" },
});
await as.start();

const userData = mkdtempSync(join(tmpdir(), "archyne-machine-"));
const app = await electron.launch({
  args: ["desktop/main.cjs", `--user-data-dir=${userData}`],
});
// The shell's file dialog, answered from here with a PEM file that holds the
// client certificate and its key, the way many tools export them.
const certFile = join(userData, "client-with-key.pem");
writeFileSync(certFile, `${pki.client.cert}\n${pki.client.key}`);
await app.evaluate(({ dialog }, file) => {
  const g = globalThis as unknown as { titles: string[] };
  g.titles = [];
  dialog.showOpenDialog = (async (...args: unknown[]) => {
    g.titles.push((args.at(-1) as { title?: string }).title ?? "");
    return { canceled: false, filePaths: [file] };
  }) as typeof dialog.showOpenDialog;
}, certFile);
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

const input = (label: string) =>
  page.locator(".ai-server-field", { hasText: label }).locator("input").first();
const pem = (label: string) =>
  page.locator(".ai-server-field", { hasText: label }).locator("textarea").first();
const paste = async (field: ReturnType<typeof pem>, value: string) => {
  await field.fill(value);
  await field.blur();
};

await input("Address").fill(`${as.base}/v1`);
await page.getByRole("combobox", { name: "Authentication" }).selectOption("oauth");
await page.getByRole("combobox", { name: "How to sign in" }).selectOption("client_credentials");
await input("Authorization server").fill(as.base);
await input("Client ID").fill("svc-machine");
await page
  .getByRole("combobox", { name: "Client authentication" })
  .selectOption("private_key_jwt");
await input("Key ID").fill("k-e2e");
await page.getByLabel(/Bind tokens to a key/).check();
await page.getByLabel(/Present a client certificate/).check();

await paste(pem("Private key (PEM)"), privatePem);
await page
  .locator(".ai-server-field", { hasText: "Client certificate (PEM)" })
  .getByRole("button", { name: "Choose file…" })
  .first()
  .click();
await pem("Certificate key (PEM)").and(page.locator('[data-saved="true"]')).waitFor({
  timeout: 15_000,
});
const titles = await app.evaluate(() => (globalThis as unknown as { titles: string[] }).titles);
check(
  "one file, chosen in the shell's dialog, fills the certificate and its key",
  titles.length === 1 &&
    titles[0] === "Archyne — client certificate" &&
    (await pem("Client certificate (PEM)").getAttribute("data-saved")) === "true",
  JSON.stringify(titles),
);
await paste(pem("Extra trusted CA"), pki.ca);
await page.waitForTimeout(500);

await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForSelector('[data-auth="signed-in"], [data-auth="signed-out"]', {
  timeout: 30_000,
});
const token = as.log.find((l) => l.body?.grant_type === "client_credentials");
check(
  "the machine signed in: private-key assertion, DPoP proof, over mTLS",
  (await page.locator('[data-auth="signed-in"]').count()) === 1 &&
    token?.clientAuth === "private_key_jwt" &&
    /^[\w-]{43}$/.test(token?.dpop ?? "") &&
    token?.peer === "svc-machine",
  JSON.stringify(token),
);

await page.getByRole("button", { name: "Check connection" }).click();
await page.waitForSelector('.ai-server-status[data-state="ok"]', { timeout: 15_000 });
const call = as.log.filter((l) => l.path === "/v1/models").at(-1);
check(
  "the service is called with the bound token's proof, over mTLS",
  call?.dpop === token?.dpop && call?.peer === "svc-machine",
  JSON.stringify(call),
);

const keyBody = (p: string) =>
  p.split("\n").filter((l) => l && !l.startsWith("-----"))[1] ?? "";
const secrets = [keyBody(privatePem), keyBody(pki.client.key), as.issued.accessToken];
const pageView = await page.evaluate(() => ({
  storage: JSON.stringify({ ...localStorage }),
  html: document.documentElement.outerHTML,
}));
check(
  "neither key nor the token is in the page: not its storage, not its markup",
  secrets.every((s) => !pageView.storage.includes(s) && !pageView.html.includes(s)),
  "found in the page",
);
const onDisk = existsSync(join(userData, "ai-secrets.json"))
  ? readFileSync(join(userData, "ai-secrets.json"), "utf8")
  : "";
check(
  "on disk they are stored, encrypted",
  onDisk.length > 0 && secrets.every((s) => !onDisk.includes(s)),
  onDisk ? "something in clear on disk" : "nothing on disk",
);

await app.close();
as.close();
rmSync(userData, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("\nA machine identity with a key, DPoP and mTLS works through the desktop shell");
