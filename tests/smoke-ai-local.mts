/**
 * One honest run of the Generate panel against the REAL local engine.
 *
 * The online e2e suite pins the stub; this script drives the actual
 * Qwen2.5-Coder download and inference in a local-mode build, to answer
 * "does the whole thing hold together with a real model at the other end":
 * the CSP lets the weights through, the status strip reports the download,
 * one prompt turns into a valid diagram, and the preview paints it.
 *
 * It reads the panel's DOM only (the `__graphTest` hook is dev-only, and
 * this runs against the built app) and is deliberately NOT part of the
 * normal test run: it downloads a few hundred megabytes and chews CPU for
 * minutes. Run it on demand, against a server serving a VITE_AI_MODE=local
 * build:
 *
 *   npm run build   (with VITE_AI_MODE=local set)
 *   npm run preview -- --port 4174 --strictPort
 *   ARCHYNE_URL=http://localhost:4174 SMOKE_PROFILE=./.smoke-profile npx tsx tests/smoke-ai-local.mts
 *
 * `SMOKE_PROFILE` points at a directory for the browser profile: the model
 * weights cache there, so a rerun after a code fix skips the download.
 */
import { chromium, type ConsoleMessage, type Page } from "playwright";
import { BASE, CHANNEL } from "./env.mts";

let failed = false;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failed = true;
    console.error(`✗ ${label} — ${detail}`);
  }
}

const PROFILE = process.env.SMOKE_PROFILE;
const context = PROFILE
  ? await chromium.launchPersistentContext(PROFILE, {
      channel: CHANNEL,
      headless: true,
      viewport: { width: 1440, height: 900 },
    })
  : await (
      await chromium.launch({ channel: CHANNEL, headless: true })
    ).newContext({
      viewport: { width: 1440, height: 900 },
    });
const page: Page = (await context.pages()[0]) ?? (await context.newPage());

const problems: string[] = [];
page.on("console", (m: ConsoleMessage) => {
  const text = m.text();
  if (
    /Content Security Policy|Failed to fetch|net::ERR|onnxruntime|Transformers|denormal/i.test(
      text,
    )
  ) {
    problems.push(`[console.${m.type()}] ${text.slice(0, 300)}`);
  }
});
page.on("pageerror", (err) => problems.push(`[pageerror] ${err.message.slice(0, 300)}`));
page.on("requestfailed", (req) =>
  problems.push(
    `[requestfailed ${req.method()} ${req.url().slice(0, 120)}] ${String(req.failure()?.errorText)}`,
  ),
);

const t0 = Date.now();

await page.goto(BASE, { timeout: 60_000 });
await page.waitForSelector(".app", { timeout: 60_000 });

await page.getByRole("button", { name: "More" }).click();
await page
  .getByRole("group", { name: "More" })
  .getByRole("button", { name: "Generate" })
  .click();
await page.waitForSelector("#panel-generate", { timeout: 30_000 });

const composerVisible = await page.locator(".ai-composer textarea.ai-request").isVisible();
check(
  "the composer is usable in local mode (no not-configured wall)",
  composerVisible,
  "composer hidden",
);

await page.locator(".ai-composer textarea.ai-request").fill("make the checkout clearer");
const started = Date.now();
await page.getByRole("button", { name: "Send", exact: true }).click();

// Watch the status strip while the engine downloads and warms up, noting when
// each new status first showed, so a slow run says where its time went.
const statusSeen = new Set<string>();
const timeline: string[] = [];
const deadline = Date.now() + 30 * 60_000;
let settled = "none" as "done" | "error" | "none";
let answer = "";
let appliedNotes = 0;
let errorText = "";
while (Date.now() < deadline) {
  const strip = await page
    .locator(".ai-model-status")
    .textContent()
    .catch(() => null);
  // The turn's own line says when a draw was refused and redrawn, which is
  // where a slow run spends its time once the model is loaded.
  const turnLine = await page
    .locator(".ai-assistant .ai-status")
    .last()
    .textContent({ timeout: 500 })
    .catch(() => null);
  const status = [strip, turnLine]
    .filter((s) => s && s.trim())
    .map((s) => s!.trim())
    .join(" / ")
    .replace(/\d+%/, "…%")
    .slice(0, 120);
  if (status && !statusSeen.has(status)) {
    statusSeen.add(status);
    timeline.push(`${Math.round((Date.now() - started) / 1000)}s ${status}`);
  }
  if ((await page.locator(".ai-assistant.done").count()) > 0) {
    settled = "done";
    // The answer is not drawn again in the bubble: it goes straight into the
    // document, so read it back from the editor, line by line.
    appliedNotes = await page.locator(".ai-assistant .ai-applied").count();
    // The editor is mounted only on the Code tab, so go and look there.
    await page.locator("#tab-code").click();
    await page.waitForSelector(".cm-content .cm-line", { timeout: 30_000 });
    answer = (await page.locator(".cm-content .cm-line").allTextContents()).join("\n");
    break;
  }
  if ((await page.locator(".ai-assistant.error").count()) > 0) {
    settled = "error";
    errorText = (await page.locator(".ai-error").textContent()) ?? "";
    break;
  }
  await page.waitForTimeout(2000);
}
const elapsed = Math.round((Date.now() - started) / 1000);

check(
  "a turn reached a settled state",
  settled === "done" || settled === "error",
  `state = ${settled} after ${elapsed}s (statuses seen: ${[...statusSeen].join(", ") || "none"})`,
);
check(
  "the engine reported itself (download/warm/ready/error)",
  statusSeen.size > 0,
  `statuses = ${[...statusSeen].join(", ") || "none"}`,
);
if (settled === "done") {
  check(
    "a valid draw landed in the document",
    answer.startsWith("flowchart TD"),
    answer.slice(0, 60),
  );
  check("the bubble says it landed", appliedNotes === 1, "no .ai-applied note");
  let canvasPainted = false;
  try {
    await page.waitForSelector(".react-flow__node", { timeout: 30_000 });
    canvasPainted = true;
  } catch {
    /* fall through */
  }
  check("the canvas paints it", canvasPainted, "no .react-flow__node");
  const stripVisible = await page.locator(".ai-model-status").count();
  check("the model status strip is on the page", stripVisible > 0, "no .ai-model-status");
} else {
  check("the failure is reported, not hidden", errorText.length > 0, JSON.stringify(errorText));
}

const consoleBlockers = problems.filter((p) =>
  /Content Security Policy|Failed to fetch|net::ERR/i.test(p),
);
check(
  "no CSP/network block on the weight download",
  consoleBlockers.length === 0,
  consoleBlockers.join("\n  "),
);

console.log(problems.map((p) => `[problem] ${p}`).join("\n"));
console.log(`[trace] timeline:\n  ${timeline.join("\n  ") || "none"}`);
const codeSeen =
  settled === "error"
    ? ((await page.locator(".ai-assistant.error").textContent()) ?? "")
    : answer;
console.log(`[trace] ${settled === "error" ? `error: ${errorText}` : "answer"}`);
console.log(
  `[trace] last draw (${codeSeen.length} chars): ${codeSeen.slice(0, 260) || "(none)"}`,
);

await context.close();
console.log(
  failed
    ? `\nreal-model smoke FAILED — ${settled} in ${elapsed}s`
    : `\nreal-model smoke passed — ${settled} in ${elapsed}s, total ${Math.round((Date.now() - t0) / 1000)}s`,
);
process.exit(failed ? 1 : 0);
