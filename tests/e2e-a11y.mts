/**
 * Browser-driven accessibility audit.
 *
 * The Vitest suite runs axe under jsdom, which has no layout engine — so the
 * `color-contrast` and `target-size` rules are disabled there and would pass
 * vacuously. This runs the same engine against the real, rendered app in both
 * themes, which is the only place those rules mean anything.
 *
 * Run:  npm run dev, then npx tsx tests/e2e-a11y.mts
 */
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { createRequire } from "node:module";
import { CHANNEL, codeUrl } from "./env.mts";

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const CODE = `flowchart TD
  start(["Start"]) --> check{"Valid?"}
  check -->|yes| work["Process request"]
  check -->|no| err["Show error"]
  work --> db[("Database")]
`;

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string[]; failureSummary?: string }>;
}

/** Run axe over the page and return violations, worst impact first. */
async function audit(page: Page, context?: string): Promise<Violation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (sel) => {
    const options = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] } };
    // @ts-expect-error axe is injected above, not imported.
    const results = await window.axe.run(sel ?? document, options);
    return results.violations.map((v: Violation) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 4).map((n) => ({
        target: n.target,
        failureSummary: n.failureSummary,
      })),
    }));
  }, context);
}

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
// The app's CSP is `script-src 'self'`, which (correctly) blocks injecting
// axe. Bypassing it here is scoped to this audit context only — the policy
// itself is verified separately by tests/e2e-csp.mts.
const context = await browser.newContext({
  viewport: { width: 1500, height: 900 },
  bypassCSP: true,
});
// Pin the locale: this script drives the UI by English accessible name, and
// the app otherwise remembers the last language or follows the browser's.
await context.addInitScript(() => {
  try {
    localStorage.setItem("graph:locale", "en");
  } catch {
    // Storage unavailable; the default is English anyway.
  }
});
/**
 * Every surface to audit, and the element whose appearance means it is fully
 * open. Waiting on that element rather than on a timer is what lets this run
 * on a cold CI runner: `color-contrast` and `target-size` are measured from
 * real layout, so auditing mid-transition produces noise, not findings.
 */
const SURFACES: Array<{
  label: string;
  /** Toolbar button, by accessible name. */
  open?: string;
  /** Source-panel tab, by accessible name. */
  tab?: string;
  /** Keyboard shortcut that opens the surface. */
  key?: string;
  /** A second button, for surfaces reached through a menu. */
  then?: string;
  /** A CSS selector to click, for controls with no stable accessible name. */
  click?: string;
  /** Must be visible before auditing, and gone again afterwards. */
  appears?: string;
  /** Clicked to close, where Escape is not what dismisses the surface. */
  dismiss?: string;
  /** Click without the visibility check, for targets with no area. */
  force?: boolean;
}> = [
  // The document tab strip is always on screen, so it is covered here.
  { label: "editor" },
  { label: "outline", tab: "Outline", appears: "#panel-outline" },
  { label: "export dialog", open: "Export…", appears: ".modal" },
  // The wordmark is no longer a button; About lives in the overflow menu.
  { label: "about dialog", open: "More", then: "About Archyne", appears: ".modal" },
  { label: "template gallery", open: "Templates", appears: ".modal" },
  { label: "overflow menu", open: "More", appears: ".menu-popover" },
  { label: "command palette", key: "Control+k", appears: ".modal.command-palette" },
  { label: "shortcuts sheet", key: "Shift+Slash", appears: ".modal" },
  // The two document dialogs: rename from the overflow menu, delete from a
  // tab's close button.
  // Selecting an edge fills the inspector with its label and line controls
  // and puts the routing handles on the canvas. The handles are the signal:
  // the corner list that used to be in the panel moved to the context menu.
  {
    label: "edge inspector",
    click: ".react-flow__edge-path",
    // A straight vertical edge is a zero-width box, which Playwright reads
    // as invisible. It is on screen; the click just has to be told so.
    force: true,
    appears: ".edge-handle",
    dismiss: ".react-flow__pane",
  },
  // Selecting a node fills the inspector and puts resize handles on the
  // canvas — neither is on screen until something is selected.
  {
    label: "node inspector",
    click: ".react-flow__node",
    appears: ".size-row",
    dismiss: ".react-flow__pane",
  },
  // Select-all shows the arrange panel, which replaces the single-node
  // fields; it is only reachable with more than one node selected.
  {
    label: "selection panel",
    key: "Control+a",
    appears: ".arrange",
    // Escape does not clear a selection; clicking empty canvas does.
    dismiss: ".react-flow__pane",
  },
  { label: "rename dialog", open: "More", then: "Rename…", appears: ".modal" },
  { label: "delete confirmation", click: ".doc-tab-close", appears: ".modal" },
];

/** Long enough for the open/close transition, short enough to stay cheap. */
const TRANSITION_MS = 350;

/**
 * The icon palette belongs to architecture diagrams, so the flowchart above
 * cannot reach it — and with it goes the dialog that imports icons from a
 * link, which is a form and therefore worth auditing.
 */
const ARCH_CODE = `architecture-beta
  service web(server)[Web]
`;

let failed = false;

/** Print one surface's result, and remember a failure for the exit code. */
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

for (const theme of ["dark", "light"] as const) {
  const page = await context.newPage();
  await page.goto(codeUrl(CODE));
  await page.waitForFunction(
    () => (window as unknown as { __graphTest?: { ready(): boolean } }).__graphTest?.ready(),
    undefined,
    { timeout: 30000 },
  );

  // Theme now lives in the overflow panel, so it has to be opened first.
  await page.locator(".overflow-menu > button").click();
  await page.locator(".menu-popover").waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".menu-popover select").first().selectOption(theme);
  await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme, {
    timeout: 15000,
  });
  await page.keyboard.press("Escape");
  await page.locator(".menu-popover").waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForTimeout(TRANSITION_MS);

  for (const { label, open, tab, key, then, click, appears, dismiss, force } of SURFACES) {
    if (tab) await page.getByRole("tab", { name: tab }).click();
    if (key) await page.keyboard.press(key);
    if (click) await page.locator(click).first().click({ force });
    if (open) await page.getByRole("button", { name: open }).click();
    if (then) {
      await page.locator(".menu-popover").waitFor({ state: "visible", timeout: 15000 });
      await page
        .locator(".menu-popover")
        .getByRole("button", { name: then, exact: true })
        .click();
    }
    if (appears) {
      await page.locator(appears).first().waitFor({ state: "visible", timeout: 15000 });
      await page.waitForTimeout(TRANSITION_MS);
    }

    report(`${theme} / ${label}`, await audit(page));

    if (open || key || click) {
      if (dismiss) await page.locator(dismiss).click({ position: { x: 5, y: 5 } });
      else await page.keyboard.press("Escape");
      if (appears) {
        await page.locator(appears).first().waitFor({ state: "hidden", timeout: 15000 });
      }
      await page.waitForTimeout(TRANSITION_MS);
    }
  }

  // A second document, for the surfaces only an architecture diagram has.
  // The theme is remembered in storage, so it survives the navigation.
  await page.goto(codeUrl(ARCH_CODE));
  await page.waitForFunction(
    () => (window as unknown as { __graphTest?: { ready(): boolean } }).__graphTest?.ready(),
    undefined,
    { timeout: 30000 },
  );
  await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme, {
    timeout: 15000,
  });
  await page.getByRole("button", { name: "From a link…" }).first().click();
  await page.locator(".link-list").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(TRANSITION_MS);
  report(`${theme} / icon link dialog`, await audit(page));
  await page.keyboard.press("Escape");
  await page.locator(".link-list").waitFor({ state: "hidden", timeout: 15000 });

  // The icon picker, which needs a node selected to have something to put an
  // icon on. A grid of several hundred small buttons is exactly where target
  // size and contrast are worth measuring.
  await page.locator(".react-flow__node").first().click();
  await page.getByRole("button", { name: "Choose icon…" }).click();
  await page.locator(".icon-picker-scroll").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(TRANSITION_MS);
  report(`${theme} / icon picker`, await audit(page));
  await page.keyboard.press("Escape");

  // The import preview, which only exists once a foreign file has been
  // converted — so it needs a real file rather than a button to reach.
  await page.setInputFiles(
    'input[type="file"]',
    fileURLToPath(new URL("fixtures/order-flow.drawio", import.meta.url)),
  );
  await page
    .locator(".import-canvas .react-flow__node")
    .first()
    .waitFor({ state: "visible", timeout: 30000 });
  await page.waitForTimeout(TRANSITION_MS);
  report(`${theme} / import preview`, await audit(page));
  await page.keyboard.press("Escape");
  await page.locator(".import-canvas").waitFor({ state: "hidden", timeout: 15000 });

  // The list of every open document. It only exists with more than one, and
  // a `?code=` load replaces the current document rather than adding to it,
  // so the second one has to be made here — last, because it moves off the
  // architecture diagram the surfaces above needed.
  await page.getByRole("button", { name: "New diagram" }).click();
  await page.locator(".doc-tab-list").waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".doc-tab-list").click();
  await page.locator(".doc-list-panel").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(TRANSITION_MS);
  report(`${theme} / document list`, await audit(page));

  await page.close();
}

await browser.close();
console.log(failed ? "\naccessibility audit FAILED" : "\nno WCAG 2.2 AA violations found");
process.exit(failed ? 1 : 0);
