/**
 * The select/hand tool, and the palette's icon sections, driven by a real
 * pointer.
 *
 * The canvas showed the hand all the time while a left drag drew a selection
 * — React Flow puts it on any canvas that pans — and there was no way to pan
 * with the left button. Now one button swaps the pointer for the hand, V and
 * H pick one, Space holds the hand, and the cursor says which. With the hand
 * a drag that starts on a box moves the canvas and leaves the box alone.
 *
 * And "In this diagram" listed every icon the browser had kept, from every
 * diagram: it lists the ones this diagram uses now, and the rest are under
 * imported icons, where they can be forgotten.
 *
 * Run:  npm run dev, then npx tsx tests/e2e-tool.mts
 */
import { chromium } from "playwright";
import { CHANNEL, codeUrl } from "./env.mts";

const FLOW = `architecture-beta
  service a(custom:used-one)[A]
  service b(server)[B]
  a:R --> L:b
%% graph:positions {"a":{"x":0,"y":0},"b":{"x":400,"y":0}}
`;
const SVG = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" style="fill:${fill}"/></svg>`;

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
await context.addInitScript(
  ([used, unused]) => {
    localStorage.setItem("graph:locale", "it");
    localStorage.setItem(
      "graph:icon-pack",
      JSON.stringify({ "used-one": used, "not-used": unused }),
    );
  },
  [SVG("#ff0000"), SVG("#00aa00")],
);
const page = await context.newPage();
await page.goto(codeUrl(FLOW));
await page.waitForFunction(
  () => (window as unknown as { __graphTest?: { ready(): boolean } }).__graphTest?.ready(),
  undefined,
  {
    timeout: 30000,
  },
);
await page.waitForTimeout(1500);

let failed = false;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
};
const paneCursor = () =>
  page.evaluate(() => getComputedStyle(document.querySelector(".react-flow__pane")!).cursor);
const viewport = () =>
  page.evaluate(
    () => (document.querySelector(".react-flow__viewport") as HTMLElement).style.transform,
  );
const nodeAt = () =>
  page.evaluate(() => {
    const s = (
      window as unknown as {
        __graphTest: {
          store: {
            getState(): { nodes: Array<{ id: string; position: { x: number; y: number } }> };
          };
        };
      }
    ).__graphTest.store.getState();
    const n = s.nodes.find((x) => x.id === "a")!;
    return `${n.position.x},${n.position.y}`;
  });

const toggles = await page.locator(".react-flow__controls .canvas-tool").count();
check("one tool button", toggles === 1, `${toggles}`);
check("arrow with selection", (await paneCursor()) === "default", await paneCursor());

await page.locator(".canvas-tool").click();
check("hand after a click", (await paneCursor()) === "grab", await paneCursor());
check(
  "button says hand",
  (await page.locator(".canvas-tool").getAttribute("aria-pressed")) === "true",
);

// A drag that starts on a box moves the canvas, not the box.
const box = (await page.locator('.react-flow__node[data-id="a"]').boundingBox())!;
const [vp0, n0] = [await viewport(), await nodeAt()];
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 + 60, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
check("hand: dragging from a box pans", (await viewport()) !== vp0, "viewport unchanged");
check("hand: the box stays put", (await nodeAt()) === n0, `${n0} -> ${await nodeAt()}`);

await page.keyboard.press("v");
check("V back to selection", (await paneCursor()) === "default", await paneCursor());
await page.locator(".react-flow__pane").hover({ position: { x: 700, y: 600 } });
await page.keyboard.down(" ");
check("Space held: hand", (await paneCursor()) === "grab", await paneCursor());
await page.keyboard.up(" ");
check("Space released: arrow", (await paneCursor()) === "default", await paneCursor());
await page.keyboard.press("h");
check("H: hand", (await paneCursor()) === "grab", await paneCursor());
await page.keyboard.press("v");

// Selection still drags a box.
const n1 = await nodeAt();
const box2 = (await page.locator('.react-flow__node[data-id="a"]').boundingBox())!;
await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
await page.mouse.down();
await page.mouse.move(box2.x + box2.width / 2 + 120, box2.y + box2.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
check("selection: dragging a box moves it", (await nodeAt()) !== n1, "box did not move");

// Palette sections.
const sections = await page.evaluate(() =>
  [...document.querySelectorAll(".palette .panel-title")].map((e) => e.textContent?.trim()),
);
const titled = (title: string) =>
  page.evaluate((t) => {
    const head = [...document.querySelectorAll(".palette .panel-title")].find(
      (e) => e.textContent?.trim() === t,
    );
    const grid = head?.nextElementSibling;
    return grid
      ? [...grid.querySelectorAll(".icon-add")].map((b) => b.getAttribute("title") ?? "")
      : null;
  }, title);
const inDiagram = await titled("In questo diagramma");
const imported = await titled("Icone importate");
check(
  "'In this diagram' has only the used icon",
  !!inDiagram && inDiagram.length === 1 && inDiagram[0].includes("used-one"),
  JSON.stringify({ sections, inDiagram }),
);
check(
  "the unused one is under imported icons",
  !!imported && imported.length === 1 && imported[0].includes("not-used"),
  JSON.stringify({ sections, imported }),
);
const color = await page.evaluate(() => {
  const r = document.querySelector(".palette .icon-cell rect") as SVGRectElement | null;
  return r ? getComputedStyle(r).fill : null;
});
check(
  "an imported icon keeps its colour",
  color === "rgb(255, 0, 0)" || color === "rgb(0, 170, 0)",
  String(color),
);

const cell = page
  .locator(".palette .icon-cell")
  .filter({ has: page.locator('[title*="not-used"]') })
  .first();
await cell.hover();
await cell.locator(".remove").click();
await page.waitForTimeout(300);
check(
  "removed from the palette",
  (await titled("Icone importate")) === null,
  JSON.stringify(await titled("Icone importate")),
);
const stored = await page.evaluate(() =>
  Object.keys(JSON.parse(localStorage.getItem("graph:icon-pack") ?? "{}")),
);
check(
  "removed from this browser",
  !stored.includes("not-used") && stored.includes("used-one"),
  JSON.stringify(stored),
);

await browser.close();
console.log(failed ? "the canvas tool is broken" : "the canvas tool works");
process.exit(failed ? 1 : 0);
