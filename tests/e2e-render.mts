/**
 * The rendered SVG, opened as a document nobody helped it become.
 *
 * Every other test here drives the *app*. This one deliberately does not: it
 * builds the string in Node, with no browser anywhere near it, writes it to a
 * file, and asks a browser to open that file cold. No dev server, no React, no
 * stylesheet, no `?code=` — nothing but the string.
 *
 * That is the entire claim behind `RENDERER.local.md`. Archyne can already be
 * *embedded*; what it could not do until now is hand somebody a picture that
 * survives the page that made it. If this passes, it can.
 *
 * Run:  npx tsx tests/e2e-render.mts   (no server needed — that is the point)
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { CHANNEL } from "./env.mts";
import { renderSvg } from "../src/render/renderSvg.js";
import type { AnyNode, DiagramKind, FlowEdge } from "../src/model/types.js";

function shape(id: string, label: string, x: number, y: number, shapeKind = "square"): AnyNode {
  return {
    id,
    type: "shape",
    position: { x, y },
    data: { label, shape: shapeKind, direction: "TB" },
  } as unknown as AnyNode;
}

const NODES: AnyNode[] = [
  shape("start", "Start", 0, 0, "stadium"),
  shape("check", "Valid?", 5, 140, "diamond"),
  shape("work", "Process the request", 0, 300),
  shape("db", "Database", 0, 440, "cylinder"),
];

const EDGES: FlowEdge[] = [
  { id: "e1", source: "start", target: "check", data: { label: "" } },
  { id: "e2", source: "check", target: "work", data: { label: "yes" } },
  { id: "e3", source: "work", target: "db", data: { label: "" } },
];

let failed = false;

function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failed = true;
    console.error(`✗ ${label} — ${detail}`);
  }
}

// Built here, in Node. If this line needed a browser the exercise would be
// pointless, so note what it does not do: no jsdom, no globals installed.
const svg = renderSvg(NODES, EDGES, "flowchart");
const file = join(tmpdir(), `archyne-render-${process.pid}.svg`);
await writeFile(file, svg, "utf8");
console.log(`  wrote ${Math.round(svg.length / 1024)} KB to ${file}`);

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
await page.goto(pathToFileURL(file).href);

// Written without an inner named function on purpose: `tsx` compiles one with
// esbuild's `keepNames`, which injects a `__name` helper that does not exist
// in the page Playwright ships the body to.
const drawn = await page.evaluate(() => {
  const rootEl = document.querySelector("svg");
  const rootRect = rootEl?.getBoundingClientRect();
  const labelEl = document.querySelector("text.t");
  const labelRect = labelEl?.getBoundingClientRect();
  const bodyEl = document.querySelector("rect.sf, polygon.sf");
  return {
    root: rootRect ? { w: rootRect.width, h: rootRect.height } : null,
    bodies: document.querySelectorAll("rect.sf, polygon.sf, path.sf, ellipse.sf").length,
    edges: document.querySelectorAll("path.e").length,
    marker: document.querySelectorAll("marker#arch-arrow").length,
    label: labelRect ? { w: labelRect.width, h: labelRect.height } : null,
    edgeLabel: document.querySelector("text.el")?.textContent ?? "",
    // A colour resolved by the document's own `<style>`, which is the thing
    // that has to travel with it.
    bodyFill: bodyEl ? getComputedStyle(bodyEl).fill : "",
  };
});

check(
  "the browser opened it as an SVG document",
  (drawn.root?.w ?? 0) > 0,
  JSON.stringify(drawn.root),
);
check("every node body is in it", drawn.bodies === NODES.length, `found ${drawn.bodies}`);
check("every edge is in it", drawn.edges === EDGES.length, `found ${drawn.edges}`);
check("the arrowhead came with it", drawn.marker === 1, `found ${drawn.marker}`);
check(
  "the labels laid out as real text, with a box of their own",
  (drawn.label?.w ?? 0) > 0 && (drawn.label?.h ?? 0) > 0,
  JSON.stringify(drawn.label),
);
check("an edge label came across", drawn.edgeLabel === "yes", `got "${drawn.edgeLabel}"`);
check(
  "the paint travelled with the picture, not with a page",
  drawn.bodyFill.replace(/\s/g, "") === "rgb(28,31,43)",
  `computed fill is ${drawn.bodyFill}`,
);

/*
 * The case the whole approach turns on: the same SVG through `<img>`.
 *
 * A browser draws an `<img>`-loaded SVG in a restricted mode, and a
 * `<foreignObject>`'s HTML is **not painted** in it — which is how the labels
 * used to disappear, leaving boxes with no words in them, in exactly the place
 * that mattered most: pre-rendering diagrams to `.svg` files beside a document
 * is the one route that needs nobody's cooperation, and `<img>` is how those
 * files get shown. GitHub, resvg, librsvg and most PDF pipelines have the same
 * restriction.
 *
 * So this does not merely check that the image loads. It rasterises it and
 * counts pixels of the text colour: if the labels were still in a foreignObject
 * there would be none.
 */
const asImage = await page.evaluate(async (markup) => {
  const img = new Image();
  const done = new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
  });
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  const ok = await done;
  if (!ok) return { ok, width: 0, textPixels: 0 };

  // The page here *is* the SVG document, where `createElement` builds an
  // element in the SVG namespace — and an SVG "canvas" has no 2D context.
  const canvas = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas",
  ) as HTMLCanvasElement;
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // The label colour is #ebebf0; anti-aliasing spreads it, so anything near it
  // counts. The node fill (#1c1f2b) and the ground (#0f1014) are nowhere close.
  let textPixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) textPixels++;
  }
  return { ok, width: img.naturalWidth, textPixels };
}, svg);

check(
  "it loads as an <img>, at its stated size",
  asImage.ok && asImage.width > 0,
  JSON.stringify(asImage),
);
check(
  "and its labels are actually painted there, which foreignObject never was",
  asImage.textPixels > 200,
  `${asImage.textPixels} pixels of label colour — near zero means the text did not render`,
);

/*
 * Every other family that has a drawing, opened the same way.
 *
 * Shallower than the flowchart above on purpose: what the flowchart case
 * establishes is that the *mechanism* works — a string, a file, a browser, real
 * paint. What these add is that each family produces a document with its own
 * content in it, rather than an empty `<svg>` that happens to parse.
 */
let column = 0;
const node = (id: string, type: string, data: Record<string, unknown>, y: number): AnyNode => {
  // Participants sit on one row at a fixed pitch, so they need distinct x.
  const x = type === "participant" ? column++ * 220 : 0;
  return { id, type, position: { x, y }, data } as unknown as AnyNode;
};

const FAMILIES: Array<{
  kind: DiagramKind;
  nodes: AnyNode[];
  edges?: FlowEdge[];
  items?: unknown[];
  wants: string;
}> = [
  {
    kind: "state",
    nodes: [
      node("s1", "state", { label: "", stateType: "start", direction: "TB" }, 0),
      node(
        "s2",
        "state",
        { label: "Awaiting review", stateType: "normal", direction: "TB" },
        90,
      ),
    ],
    wants: "Awaiting review",
  },
  {
    kind: "er",
    nodes: [
      node(
        "CUSTOMER",
        "entity",
        {
          label: "CUSTOMER",
          direction: "TB",
          attributes: [
            { type: "int", name: "id", keys: ["PK"], comment: "" },
            { type: "timestamptz", name: "created_at", keys: [], comment: "" },
          ],
        },
        0,
      ),
    ],
    wants: "created_at",
  },
  {
    kind: "class",
    nodes: [
      node(
        "Account",
        "class",
        {
          label: "Account",
          direction: "TB",
          members: ["+id: int"],
          methods: ["+close(): void"],
          annotations: [],
        },
        0,
      ),
    ],
    wants: "+close(): void",
  },
  {
    kind: "sequence",
    nodes: [
      node("U", "participant", { label: "Utente", ptype: "actor", direction: "TB" }, 0),
      node("S", "participant", { label: "Server", ptype: "participant", direction: "TB" }, 0),
    ],
    edges: [{ id: "m1", source: "U", target: "S", data: { label: "chiedi" } }],
    items: [{ kind: "message", edgeId: "m1" }],
    wants: "chiedi",
  },
  {
    kind: "c4",
    nodes: [
      node(
        "app",
        "c4",
        { label: "Payments", c4Shape: "system", descr: "Handles settlement", direction: "TB" },
        0,
      ),
    ],
    wants: "Handles settlement",
  },
  {
    kind: "requirement",
    nodes: [
      node(
        "speed",
        "requirement",
        {
          label: "speed",
          reqType: "performanceRequirement",
          reqId: "R-1",
          text: "Reach 200 km/h",
          direction: "TB",
        },
        0,
      ),
      node(
        "engine",
        "requirement",
        { label: "engine", reqType: "element", direction: "TB" },
        200,
      ),
    ],
    edges: [
      {
        id: "r1",
        source: "engine",
        target: "speed",
        markerEnd: "seq-open",
        data: { label: "", req: { rel: "satisfies" } },
      },
    ],
    wants: "Text: Reach 200 km/h",
  },
];

for (const family of FAMILIES) {
  const markup = renderSvg(family.nodes, family.edges ?? [], family.kind, {
    seqItems: family.items as never,
  });
  const path = join(tmpdir(), `archyne-render-${family.kind}-${process.pid}.svg`);
  await writeFile(path, markup, "utf8");
  await page.goto(pathToFileURL(path).href);
  const seen = await page.evaluate(() => {
    const root = document.querySelector("svg")?.getBoundingClientRect();
    return {
      w: root?.width ?? 0,
      bodies: document.querySelectorAll("[class^='sf'], rect.sf, polygon.sf, rect.c4").length,
      text: document.body?.textContent ?? document.documentElement.textContent ?? "",
    };
  });
  check(
    `${family.kind}: opens as a document with its content in it`,
    seen.w > 0 && seen.bodies > 0 && seen.text.includes(family.wants),
    `width ${seen.w}, ${seen.bodies} bodies, wanted "${family.wants}"`,
  );
}

await browser.close();
console.log(
  failed
    ? "\nstandalone render FAILED"
    : "\nthe SVG stands on its own, outside the app that made it",
);
process.exit(failed ? 1 : 0);
