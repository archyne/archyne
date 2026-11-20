/**
 * Moving the end of a connection, driven by a real pointer.
 *
 * The arithmetic is unit-tested (`src/reconnect.test.ts`). What it cannot
 * reach is the gesture, and the gesture was the bug: the end of a selected
 * line sits on a node's face, right on that node's own connection point, and
 * a press there reached the connection point — which starts a new line. The
 * old line stayed where it was and a second one appeared beside it.
 *
 * Run:  npm run dev, then npx tsx tests/e2e-reconnect.mts
 */
import { chromium, type Page } from "playwright";
import { CHANNEL, codeUrl } from "./env.mts";

const FLOW = `flowchart LR
  a["Alpha"] --> b["Beta"]
  c["Gamma"]
%% graph:positions {"a":{"x":0,"y":0},"b":{"x":360,"y":0},"c":{"x":360,"y":300}}
`;

const ARCH = `architecture-beta
  service a(server)[A]
  service b(server)[B]
  a:R --> L:b
%% graph:positions {"a":{"x":0,"y":0},"b":{"x":400,"y":0}}
`;

let failed = false;

function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failed = true;
    console.error(`✗ ${label} — ${detail}`);
  }
}

interface Graph {
  edges: Array<{
    source: string;
    target: string;
    data?: { points?: Array<{ x: number; y: number }>; arch?: { rhsDir: string } };
  }>;
  code: string;
}

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page: Page = await context.newPage();

const ready = (p: Page) =>
  p.waitForFunction(
    () => (window as unknown as { __graphTest?: { ready(): boolean } }).__graphTest?.ready(),
    undefined,
    { timeout: 30000 },
  );

const graph = (): Promise<Graph> =>
  page.evaluate(() => {
    const s = (
      window as unknown as { __graphTest: { store: { getState(): unknown } } }
    ).__graphTest.store.getState() as Graph;
    return { edges: s.edges, code: s.code };
  });

/** The middle of an element on screen. */
const centreOf = async (selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** Select the only connection, so its ends are offered. */
const selectEdge = async () => {
  // On the line itself, halfway along it. The middle of the box the line fits
  // in is on the line only while the line is straight or a Z: pinned to a far
  // face it goes round its node, the middle of that box is bare canvas, and a
  // click there deselects.
  const at = await page.evaluate(() => {
    const path = document.querySelector<SVGPathElement>(
      ".react-flow__edge .react-flow__edge-path",
    )!;
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: p.x * m.a + m.e, y: p.y * m.d + m.f };
  });
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(250);
};

/** Drag the target end of the selected connection to a point on screen. */
const dragTargetEnd = async (to: { x: number; y: number }) => {
  const from = await centreOf(".edge-end >> nth=1");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(600);
};

// --- A flowchart: the face is the router's, unless a point is aimed at.

await page.goto(codeUrl(FLOW));
await ready(page);
await page.waitForTimeout(300);

await selectEdge();
check(
  "a selected connection offers a handle on each end",
  (await page.locator(".edge-end").count()) === 2,
  `${await page.locator(".edge-end").count()} end handle(s)`,
);

// A press and release with no travel leaves everything as it was.
const end = await centreOf(".edge-end >> nth=1");
await page.mouse.click(end.x, end.y);
await page.waitForTimeout(300);
let g = await graph();
check(
  "a press on an end that does not travel changes nothing",
  g.edges.length === 1 && g.edges[0].target === "b",
  JSON.stringify(g.edges.map((e) => `${e.source}>${e.target}`)),
);

// Let go in the middle of another node: the end moves there.
await selectEdge();
await dragTargetEnd(await centreOf('.react-flow__node[data-id="c"]'));
g = await graph();
check(
  "dragging an end onto another node moves the connection, rather than drawing a second",
  g.edges.length === 1 && g.edges[0].source === "a" && g.edges[0].target === "c",
  JSON.stringify(g.edges.map((e) => `${e.source}>${e.target}`)),
);
check("and the file says so", /^\s*a --> c\s*$/m.test(g.code) && !/--> b/.test(g.code), g.code);
check(
  "let go in the middle of the node, the face is left to the router",
  !g.edges[0].data?.points?.length,
  JSON.stringify(g.edges[0].data?.points),
);

// Let go on a connection point: the end is pinned to that face.
await selectEdge();
const gamma = (await page.locator('.react-flow__node[data-id="c"]').boundingBox())!;
await dragTargetEnd({ x: gamma.x + gamma.width, y: gamma.y + gamma.height / 2 });
g = await graph();
const pin = g.edges[0].data?.points?.at(-1);
const zoom = await page.evaluate(() => {
  const el = document.querySelector(".react-flow__viewport") as HTMLElement;
  return new DOMMatrixReadOnly(getComputedStyle(el).transform).a;
});
check(
  "let go on a connection point, the end is pinned to that face",
  g.edges.length === 1 &&
    g.edges[0].target === "c" &&
    pin !== undefined &&
    pin.x > 360 + gamma.width / zoom,
  JSON.stringify(g.edges[0].data?.points),
);

// Let go on nothing: the connection stays where it was.
await selectEdge();
await dragTargetEnd({ x: gamma.x + gamma.width + 400, y: gamma.y - 200 });
const after = await graph();
check(
  "let go on empty canvas, the connection is left as it was",
  after.edges.length === 1 &&
    after.edges[0].target === "c" &&
    JSON.stringify(after.edges[0].data?.points) === JSON.stringify(g.edges[0].data?.points),
  JSON.stringify(after.edges),
);

// --- An architecture diagram: the face is written into the file.

await page.goto(codeUrl(ARCH));
await ready(page);
await page.waitForTimeout(300);
await selectEdge();
const bee = (await page.locator('.react-flow__node[data-id="b"]').boundingBox())!;
await dragTargetEnd({ x: bee.x + bee.width / 2, y: bee.y });
g = await graph();
check(
  "in an architecture diagram, moving an end to another face writes the face",
  g.edges.length === 1 && g.edges[0].data?.arch?.rhsDir === "T" && /a:R --> T:b/.test(g.code),
  `${g.edges[0].data?.arch?.rhsDir}; ${g.code.split("\n").find((l) => l.includes("-->"))}`,
);

await browser.close();
process.exit(failed ? 1 : 0);
