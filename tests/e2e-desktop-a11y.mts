/**
 * The accessibility audit of Generate's remote-service settings, in the real
 * desktop app — the only place they exist: the web build has no host to keep
 * a secret, so `e2e-a11y.mts` never sees them.
 *
 * Every variant of the form is opened in turn — each kind of service, each
 * way of authenticating, each OAuth flow, a client certificate, a saved
 * secret, a status message — and axe runs over the panel in both themes,
 * with layout, so contrast and target size mean something.
 *
 * Run:  npm run build, then npx tsx tests/e2e-desktop-a11y.mts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type Page } from "playwright";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string[]; failureSummary?: string }>;
}

/**
 * Run axe over the Generate panel. The app's CSP rightly refuses an injected
 * script tag; evaluating through the debugger protocol is not a page script,
 * so the policy stays as it ships.
 */
async function audit(page: Page): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.evaluate(AXE);
  return page.evaluate(async () => {
    const options = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] } };
    // @ts-expect-error axe is evaluated above, not imported.
    const results = await window.axe.run("#panel-generate", options);
    return results.violations.map((v: Violation) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 4).map((n) => ({
        target: n.target,
        failureSummary: n.failureSummary,
      })),
    }));
  });
}

let failed = false;
function report(tag: string, violations: Violation[]): void {
  if (violations.length === 0) {
    console.log(`✓ ${tag}`);
    return;
  }
  failed = true;
  console.error(`✗ ${tag} — ${violations.length} violation(s)`);
  for (const v of violations) {
    console.error(`    [${v.impact}] ${v.id}: ${v.help}`);
    for (const n of v.nodes) {
      console.error(`        ${n.target.join(" ")}`);
      if (n.failureSummary) {
        console.error(
          `          ${n.failureSummary.replace(/\n/g, "\n          ").slice(0, 400)}`,
        );
      }
    }
  }
}

const userData = mkdtempSync(join(tmpdir(), "archyne-a11y-"));
const app = await electron.launch({
  args: ["desktop/main.cjs", `--user-data-dir=${userData}`],
});
const page = await app.firstWindow();
await page.waitForSelector(".app", { timeout: 60_000 });
await page.setViewportSize({ width: 1500, height: 900 });

const field = (label: string) =>
  page.locator(".ai-server-field", { hasText: label }).locator("input").first();
const select = (name: string) => page.getByRole("combobox", { name });

/** The form variants, each reached from the one before. */
const VARIANTS: Array<{ label: string; go: () => Promise<void> }> = [
  {
    label: "OpenAI-compatible, key in a header, with a status message",
    go: async () => {
      // An address that is refused before anything is sent: a status to audit.
      await field("Address").fill("http://example.com/v1");
      await page.getByRole("button", { name: "Check connection" }).click();
      await page.waitForSelector(".ai-server-status[data-state]", { timeout: 15_000 });
    },
  },
  {
    label: "a saved secret",
    go: async () => {
      await field("API key").fill("a11y-not-a-real-key");
      await field("API key").press("Enter");
      await page.locator('[data-saved="true"]').first().waitFor({ timeout: 15_000 });
    },
  },
  {
    label: "Basic auth",
    go: () =>
      select("Authentication")
        .selectOption("basic")
        .then(() => {}),
  },
  {
    label: "OAuth in the browser, with a client certificate",
    go: async () => {
      await select("Authentication").selectOption("oauth");
      await page.getByLabel(/Present a client certificate/).check();
    },
  },
  {
    label: "OAuth device code",
    go: () =>
      select("How to sign in")
        .selectOption("device_code")
        .then(() => {}),
  },
  {
    label: "OAuth machine identity with a private key",
    go: async () => {
      await select("How to sign in").selectOption("client_credentials");
      await select("Client authentication").selectOption("private_key_jwt");
    },
  },
  {
    label: "OAuth signed assertion",
    go: () =>
      select("How to sign in")
        .selectOption("jwt_bearer")
        .then(() => {}),
  },
  {
    label: "Anthropic",
    go: () =>
      select("Kind of service")
        .selectOption("anthropic")
        .then(() => {}),
  },
  {
    label: "Azure OpenAI",
    go: () =>
      select("Kind of service")
        .selectOption("azure")
        .then(() => {}),
  },
  {
    label: "Amazon Bedrock with SigV4",
    go: () =>
      select("Kind of service")
        .selectOption("bedrock")
        .then(() => {}),
  },
  {
    label: "Google Vertex AI",
    go: () =>
      select("Kind of service")
        .selectOption("vertex")
        .then(() => {}),
  },
];

for (const theme of ["dark", "light"] as const) {
  await page.locator(".overflow-menu > button").click();
  await page.locator(".menu-popover").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".menu-popover select").first().selectOption(theme);
  await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
  await page.keyboard.press("Escape");
  await page.locator(".menu-popover").waitFor({ state: "hidden", timeout: 15_000 });

  // The overflow menu is also where Generate lives.
  await page.getByRole("button", { name: "More" }).click();
  await page
    .getByRole("group", { name: "More" })
    .getByRole("button", { name: "Generate" })
    .click();
  await page.waitForSelector("#panel-generate");
  await select("Engine").selectOption("remote");
  // A fresh service for each theme, so every variant starts from the defaults.
  if ((await page.locator(".ai-server[open]").count()) === 0) {
    await page.locator(".ai-server summary").click();
  }
  await page.getByRole("button", { name: "Add service" }).click();
  for (const { label, go } of VARIANTS) {
    await go();
    await page.waitForTimeout(250);
    report(`${theme} / ${label}`, await audit(page));
  }
  await page.getByRole("button", { name: "Remove service" }).click();
}

await app.close();
rmSync(userData, { recursive: true, force: true });
console.log(failed ? "\naccessibility audit FAILED" : "\nno WCAG 2.2 AA violations found");
process.exit(failed ? 1 : 0);
