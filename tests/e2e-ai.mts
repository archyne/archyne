/**
 * The Generate (AI) panel, as a conversation against the stub provider.
 *
 * The dev server runs the whole AI pipeline on a fake brain (`src/ai/fake.ts`)
 * that streams, fails, retries and threads like a real one — deliberately,
 * because the moments worth pinning here are the ones a model cannot be
 * trusted to repeat: that an answer lands in the thread, that a follow-up
 * edits the document on screen, that a bad draw surfaces as an error rather
 * than as silent nothing, that an earlier turn can still be taken back on its
 * own, and that Stop leaves both thread and document exactly as they were.
 *
 * Run:  npm run dev, then npx tsx tests/e2e-ai.mts
 */
import { chromium } from "playwright";
import { BASE, CHANNEL } from "./env.mts";

let failed = false;

function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failed = true;
    console.error(`✗ ${label} — ${detail}`);
  }
}

interface StoreView {
  aiTurns: Array<{ request: string; state: string; code: string; error: string | null }>;
  code: string;
}

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE);
await page.waitForFunction(
  () =>
    (window as unknown as { __graphTest?: { ready(): boolean } }).__graphTest?.ready() ?? false,
  undefined,
  { timeout: 60_000 },
);

/** The store, from the dev-only test hook. */
const ws = () =>
  page.evaluate((): StoreView => {
    const s = (
      window as unknown as {
        __graphTest: {
          store: {
            getState(): {
              aiTurns: Array<{
                request: string;
                state: string;
                code: string;
                error: string | null;
              }>;
              code: string;
            };
          };
        };
      }
    ).__graphTest.store.getState();
    return { aiTurns: s.aiTurns, code: s.code };
  });

const last = (s: StoreView) => s.aiTurns[s.aiTurns.length - 1];

const openGenerateTab = async () => {
  await page.getByRole("button", { name: "More" }).click();
  await page
    .getByRole("group", { name: "More" })
    .getByRole("button", { name: "Generate" })
    .click();
  await page.waitForSelector("#panel-generate");
};

const waitForState = (state: string) =>
  page.waitForFunction(
    (want) => {
      const s = (
        window as unknown as {
          __graphTest: { store: { getState(): { aiTurns: Array<{ state: string }> } } };
        }
      ).__graphTest.store.getState();
      const latest = s.aiTurns[s.aiTurns.length - 1];
      return latest ? latest.state === want : want === "idle";
    },
    state,
    { timeout: 30_000 },
  );

const request = async (text: string) => {
  await page.locator(".ai-composer textarea.ai-request").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
};

/* ---------- the panel opens as a conversation ---------- */

await openGenerateTab();
check(
  "the thread starts with an invitation",
  (await page.locator(".ai-seed").count()) === 1,
  "no seed line",
);
check(
  "the model choice offers both Qwen sizes",
  (await page.locator("select[aria-label='Model'] option").allTextContents()).length === 2,
  (await page.locator("select[aria-label='Model'] option").allTextContents()).join(", "),
);

/* ---------- a happy draw, then follow-ups that actually change it ---------- */

await request("make the checkout clearer");
await waitForState("done");
const good = await ws();
check(
  "a valid draw lands as the answer to its question",
  good.aiTurns.length === 1 && last(good).code.startsWith("flowchart TD"),
  JSON.stringify(good.aiTurns.map((t) => [t.request, t.code.slice(0, 16)])),
);
check(
  "the bubble reports that it landed, instead of drawing it a second time",
  // The diagram is on the canvas at full size; a preview here would be a
  // smaller copy of what the reader is already looking at.
  (await page.locator(".ai-assistant .ai-applied").count()) === 1 &&
    (await page.locator(".ai-assistant .ai-preview").count()) === 0 &&
    good.code === last(good).code,
  `${await page.locator(".ai-applied").count()} applied notes`,
);

await request("colour it blue");
await waitForState("done");
const coloured = await ws();
check(
  "a follow-up changes the drawing: a colour finds the first step",
  coloured.aiTurns.length === 2 &&
    coloured.aiTurns[1].code.includes("style start fill:#3b82f6") &&
    coloured.aiTurns[1].code !== good.aiTurns[0].code,
  JSON.stringify(coloured.aiTurns.map((t) => [t.request, t.code.slice(0, 24)])),
);

await request("add another step");
await waitForState("done");
const grown = await ws();
check(
  "the next follow-up threads and grows the flowchart",
  grown.aiTurns.length === 3 &&
    grown.aiTurns[2].code.includes('x1["More"]') &&
    grown.aiTurns[2].code !== coloured.aiTurns[1].code,
  JSON.stringify(grown.aiTurns.map((t) => [t.request, t.code.slice(0, 24)])),
);

await request("a sign-in flow as a sequence diagram");
await waitForState("done");
const threaded = await ws();
check(
  "a kind request redraws in that kind, still in the thread",
  threaded.aiTurns.length === 4 &&
    threaded.aiTurns[0].code.startsWith("flowchart TD") &&
    threaded.aiTurns[3].code.startsWith("sequenceDiagram"),
  JSON.stringify(threaded.aiTurns.map((t) => [t.request, t.code.slice(0, 16)])),
);
check(
  "each answer is its own bubble on the page",
  (await page.locator(".ai-user").count()) === 4 &&
    (await page.locator(".ai-assistant").count()) === 4,
  `${await page.locator(".ai-user").count()} user bubbles`,
);

/* ---------- the answer is on the canvas already ---------- */

const afterApply = await ws();
check(
  "the answer reaches the canvas without anything being pressed",
  afterApply.code === threaded.aiTurns[3].code && afterApply.code.startsWith("sequenceDiagram"),
  JSON.stringify(afterApply.code.slice(0, 40)),
);

/* ---------- a persistently broken draw surfaces as an error ---------- */

await request("never parses, always answer broken");
await waitForState("error");
const err = await ws();
const refused = last(err);
check(
  "the failure is reported, not hidden",
  (refused.error?.length ?? 0) > 0 && (await page.locator(".ai-error").count()) === 1,
  `error=${JSON.stringify(refused.error)}`,
);
check(
  "the refused draw is shown back",
  refused.code.includes("--> -->"),
  JSON.stringify(refused.code),
);
check(
  "a draw that never became valid offers nothing to undo",
  (await page
    .locator(".ai-turn")
    .nth(4)
    .getByRole("button", { name: "Undo this change", exact: true })
    .count()) === 0,
  "a failed turn offered a way back it never earned",
);

/* ---------- one earlier turn can be taken back on its own ---------- */

const before = (await ws()).code;
await page
  .locator(".ai-turn")
  .nth(2)
  .getByRole("button", { name: "Undo this change", exact: true })
  .click();
await page.waitForFunction((prevCode) => {
  const s = (
    window as unknown as { __graphTest: { store: { getState(): { code: string } } } }
  ).__graphTest.store.getState();
  return s.code !== prevCode;
}, before);
const undone = await ws();
check(
  "undoing one turn puts the diagram back, and does not offer it twice",
  undone.code !== before &&
    (await page
      .locator(".ai-turn")
      .nth(2)
      .getByRole("button", { name: "Undo this change", exact: true })
      .count()) === 0,
  JSON.stringify(undone.code.slice(0, 40)),
);

/* ---------- New conversation starts over ---------- */

await page.getByRole("button", { name: "New conversation", exact: true }).click();
const cleared = await ws();
check(
  "New conversation forgets the thread",
  cleared.aiTurns.length === 0 && (await page.locator(".ai-user").count()) === 0,
  `${cleared.aiTurns.length} turns left`,
);

/* ---------- Stop leaves both thread and document alone ---------- */

const docBefore = (await ws()).code;
await request("never parses, always answer broken");
await page.getByRole("button", { name: "Stop", exact: true }).click();
await waitForState("idle");
const stopped = await ws();
check(
  "Stop abandons the half-drawn turn and keeps the document",
  stopped.aiTurns.length === 0 && stopped.code === docBefore,
  JSON.stringify(stopped),
);

await browser.close();
console.log(
  failed
    ? "\nGenerate FAILED"
    : "\nthe Generate conversation draws, threads, applies, undoes and stops as asked",
);
process.exit(failed ? 1 : 0);
