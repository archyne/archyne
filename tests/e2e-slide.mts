/**
 * Dragging a connection sideways, on every run of every connection in a real
 * imported diagram.
 *
 * `e2e-waypoints` already drives the gesture, but on a two-node diagram with
 * one straight edge — which is the case that works. What kept coming back on
 * a real import was a drag that did not move a line so much as shatter it:
 * one pull upwards and the connection came back as a stack of segments
 * doubling over each other, with a cusp at every turn. Three separate faults
 * produced that same picture, and none of them could be reached from a
 * diagram simple enough to write out by hand:
 *
 *   - every pointermove re-applied the slide to the result of the last one,
 *     and pinning a run costs two corners, so one drag left a dozen behind;
 *   - a pinning corner landing within `STUB` of a node's face is a corner the
 *     route's own leg steps past, so the line went out, back to collect it,
 *     and out again;
 *   - a crossing hop within half its own width of the end of a run finished
 *     past where the run stopped, and the line travelled back to the corner.
 *
 * So the check is not on the numbers but on the drawn path: after a drag,
 * does the line ever reverse along the axis it is travelling on? A connection
 * that doubles back is one a reader sees as several. The corners are counted
 * too — one drag is one edit, and it may pin the run it moved, but it has no
 * business leaving a trail.
 *
 * Run:  npm run dev, then npx tsx tests/e2e-slide.mts
 */
import { chromium, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { BASE, CHANNEL } from "./env.mts";

const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

/** Imports with enough shape to have runs worth taking hold of. */
const FIXTURES = ["vpc-swimlanes.drawio", "order-flow.drawio"];

/** How far each drag pulls, in diagram units, each way across the run. */
const PULL = 70;

interface Grip {
  x: number;
  y: number;
  scale: number;
  flat: boolean;
}

interface State {
  corners: number;
  d: string;
}

let failures = 0;
let drags = 0;

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addInitScript(() => {
  try {
    localStorage.setItem("graph:locale", "en");
  } catch {
    // Storage unavailable; English is the default anyway.
  }
});
const page: Page = await context.newPage();

const ready = (p: Page) =>
  p.waitForFunction(
    () => (window as unknown as { __graphTest?: { ready(): boolean } }).__graphTest?.ready(),
    undefined,
    { timeout: 30000 },
  );

/**
 * Wait until the drawing has stopped changing: every connection the store
 * holds is drawn, and neither the paths nor the viewport moved between two
 * looks a few frames apart. This used to be a flat three seconds per import,
 * fifty imports a run — most of the suite's six minutes spent waiting on a
 * drawing that had settled long before.
 */
const settled = async () => {
  await page.evaluate(() => {
    (window as unknown as { __lastDrawn?: string }).__lastDrawn = "";
  });
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __lastDrawn?: string;
        __graphTest: { store: { getState(): { edges: unknown[] } } };
      };
      const paths = [...document.querySelectorAll(".react-flow__edge-path")];
      if (paths.length < w.__graphTest.store.getState().edges.length) return false;
      const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
      const now = paths.map((p) => p.getAttribute("d")).join("|") + viewport?.style.transform;
      const same = now === w.__lastDrawn;
      w.__lastDrawn = now;
      return same;
    },
    undefined,
    { polling: 250, timeout: 30000 },
  );
};

const open = async (name: string) => {
  await page.goto(BASE);
  await ready(page);
  await page.setInputFiles('input[type="file"]', fixture(name));
  await page.locator(".modal").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.locator(".modal").waitFor({ state: "detached", timeout: 30000 });
  await settled();
  await page.locator(".react-flow__controls-fitview").click();
  await settled();
};

/**
 * The points of a drawn path, corners and hop ends alike.
 *
 * Written without inner named functions on purpose where it crosses into the
 * page: `tsx` compiles one with esbuild's `keepNames`, which injects a
 * `__name` helper that does not exist in the browser Playwright sends the
 * body to.
 */
const pointsOf = (d: string): Array<{ x: number; y: number }> => {
  const tokens = d.match(/[MLQA]|-?\d+(\.\d+)?/g) ?? [];
  const pts: Array<{ x: number; y: number }> = [];
  let i = 0;
  let cmd = "M";
  while (i < tokens.length) {
    if (/^[MLQA]$/.test(tokens[i])) {
      cmd = tokens[i];
      i++;
      continue;
    }
    // A quadratic ends at its last pair; an elliptical arc at its last two of
    // seven. Only where the pen ends up matters here.
    const take = cmd === "Q" ? 4 : cmd === "A" ? 7 : 2;
    const chunk = tokens.slice(i, i + take).map(Number);
    pts.push({ x: chunk[take - 2], y: chunk[take - 1] });
    i += take;
  }
  return pts;
};

/** Where the drawn line turns back on itself. */
const reversals = (d: string): string[] => {
  const bad: string[] = [];
  const pts = pointsOf(d);
  for (let k = 1; k < pts.length - 1; k++) {
    const [a, b, c] = [pts[k - 1], pts[k], pts[k + 1]];
    for (const axis of ["x", "y"] as const) {
      const across = axis === "x" ? "y" : "x";
      if (Math.abs(a[across] - b[across]) > 0.5 || Math.abs(b[across] - c[across]) > 0.5)
        continue;
      // Out and straight back: the two steps point opposite ways.
      if ((b[axis] - a[axis]) * (c[axis] - b[axis]) < -0.25) {
        bad.push(`${Math.round(b.x)},${Math.round(b.y)}`);
      }
    }
  }
  return [...new Set(bad)];
};

const stateOf = (id: string): Promise<State> =>
  page.evaluate((edgeId) => {
    const store = (
      window as unknown as { __graphTest: { store: { getState(): unknown } } }
    ).__graphTest.store.getState() as {
      edges: Array<{ id: string; data?: { points?: unknown[] } }>;
    };
    const edge = store.edges.find((e) => e.id === edgeId);
    const el = document.querySelector(`.react-flow__edge[data-id="${edgeId}"]`);
    return {
      corners: edge?.data?.points?.length ?? 0,
      d: el?.querySelector(".react-flow__edge-path")?.getAttribute("d") ?? "",
    };
  }, id);

/**
 * A point on each run long enough to be worth dragging, where the line itself
 * is what the pointer would hit.
 *
 * The middle of a run is often under the label that names the connection, and
 * a press there takes hold of the label instead — so it walks outwards from
 * the middle until the pointer would land on the line.
 */
const gripsOn = (id: string): Promise<Grip[]> =>
  page.evaluate((edgeId) => {
    const edge = document.querySelector(`.react-flow__edge[data-id="${edgeId}"]`);
    const d = edge?.querySelector(".react-flow__edge-path")?.getAttribute("d");
    if (!edge || !d) return [];
    const tokens = d.match(/[MLQA]|-?\d+(\.\d+)?/g) ?? [];
    const pts: Array<{ x: number; y: number }> = [];
    let i = 0;
    let cmd = "M";
    while (i < tokens.length) {
      if (/^[MLQA]$/.test(tokens[i])) {
        cmd = tokens[i];
        i++;
        continue;
      }
      const take = cmd === "Q" ? 4 : cmd === "A" ? 7 : 2;
      const chunk = tokens.slice(i, i + take).map(Number);
      pts.push({ x: chunk[take - 2], y: chunk[take - 1] });
      i += take;
    }
    const vp = document.querySelector(".react-flow__viewport") as HTMLElement;
    const m = new DOMMatrix(getComputedStyle(vp).transform);
    const host = (document.querySelector(".react-flow") as HTMLElement).getBoundingClientRect();
    const out: Array<{ x: number; y: number; scale: number; flat: boolean }> = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const flat = Math.abs(a.y - b.y) < 0.5;
      const len = flat ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
      if (len < 30) continue;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      let taken = false;
      for (let step = 0; step <= len / 2 - 8 && !taken; step += 3) {
        for (const side of [-1, 1]) {
          const at = {
            x: host.x + m.e + (flat ? mid.x + side * step : mid.x) * m.a,
            y: host.y + m.f + (flat ? mid.y : mid.y + side * step) * m.d,
          };
          const top = document.elementFromPoint(at.x, at.y);
          if (top && edge.contains(top)) {
            out.push({ x: at.x, y: at.y, scale: m.a, flat });
            taken = true;
            break;
          }
        }
      }
    }
    return out;
  }, id);

for (const name of FIXTURES) {
  await open(name);
  const ids: string[] = await page.evaluate(() => {
    const store = (
      window as unknown as { __graphTest: { store: { getState(): unknown } } }
    ).__graphTest.store.getState() as { edges: Array<{ id: string }> };
    return store.edges.map((e) => e.id);
  });
  console.log(`\n${name} — ${ids.length} connections`);

  for (const id of ids) {
    for (const away of [-PULL, PULL]) {
      // Freshly imported each time: a drag that is left in place changes what
      // the next one takes hold of, and the case being pinned down here is a
      // single drag on an untouched diagram.
      await open(name);
      const grips = await gripsOn(id);
      for (const grip of grips) {
        const before = await stateOf(id);
        await page.mouse.move(grip.x, grip.y);
        await page.mouse.down();
        for (const part of [0.25, 0.5, 0.75, 1]) {
          const step = away * part * grip.scale;
          await page.mouse.move(
            grip.flat ? grip.x : grip.x + step,
            grip.flat ? grip.y + step : grip.y,
            { steps: 3 },
          );
          await page.waitForTimeout(40);
        }
        await page.mouse.up();
        await page.waitForTimeout(400);
        drags++;

        const after = await stateOf(id);
        const bent = reversals(after.d);
        // Pinning the run it moved takes two corners; anything beyond that is
        // a drag that has been applied more than once.
        const grew = after.corners > before.corners + 2;
        if (bent.length > 0 || grew) {
          failures++;
          console.error(
            `  ✗ ${id} pulled ${away > 0 ? "on" : "back"}\n` +
              `      corners ${before.corners} -> ${after.corners}` +
              (bent.length > 0 ? `, doubles back at ${bent.slice(0, 3).join(" ")}` : "") +
              `\n      ${after.d.slice(0, 220)}`,
          );
        }
        await page.keyboard.press("Control+z");
        await page.waitForTimeout(200);
      }
    }
  }
  if (failures === 0) console.log("  ✓ every run moves without folding the line");
}

console.log(`\n${drags} drags across ${FIXTURES.length} imported diagrams`);
console.log(
  failures === 0
    ? "dragging a connection moves it and nothing else"
    : `${failures} drags leave the line folded over itself`,
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
