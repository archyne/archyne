/**
 * E2E: can you actually read the drawing?
 *
 * The router and the label placer are covered as arithmetic by their own unit
 * tests — `spread.test.ts`, `berths.test.ts`, `labels.test.ts` — and those
 * check the rules on cases written to exercise them. What they cannot check is
 * the thing the rules exist for: that on a real diagram, laid out by somebody
 * else, nothing important ends up hidden underneath something else.
 *
 * So this measures the finished picture, over every diagram this repository
 * ships, and fails on six things a reader would notice:
 *
 *   - **a connection drawn on top of another one.** Worst when the two are
 *     drawn differently — a dashed line under a solid one does not read as a
 *     crowded corridor, it reads as a connection that is not there.
 *   - **a connection drawn along a group's border**, which is the same fault
 *     against a line that is not a connection: it disappears into the frame.
 *   - **an arrowhead on a bend.** A connection meets a box square on, and the
 *     straight run before the head is what says which face it arrived at; a
 *     head on the rounded part of a corner reads as arriving sideways.
 *     Once watched rather than gated (`endsOf` could face a connection away
 *     from its node and the line came back through the box); the joined nodes
 *     are obstacles now, so the count gates.
 *   - **an arrowhead under a label.** A covered head takes with it the one
 *     thing the line was drawn to say: which of the two boxes it points at.
 *   - **a label sitting on a connection it does not name.** A label resting on
 *     a line reads as that line's name, so this does not hide anything — it
 *     says something false, and points the reader at the wrong arrow.
 *   - **a label over a box**, hiding the box's own words.
 *   - **a label over another label.**
 *   - **a box drawn outside the group it belongs to**, or two unrelated groups
 *     overlapping. Checked twice over: as the diagram arrives, and again after
 *     Auto-layout has rearranged it, because a container's size lives in three
 *     places and a rearrangement that updates only one of them draws every
 *     frame at its old size in its new place.
 *
 * Everything is measured in *diagram* units rather than screen pixels, so the
 * thresholds mean the same thing whatever the window size or the zoom.
 *
 * Run:  npm run dev, then npx tsx tests/e2e-legibility.mts
 */
import { chromium, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { BASE, CHANNEL, codeUrl } from "./env.mts";
import { TEMPLATES } from "../src/templates.ts";
// The thresholds come from the code being measured. The *measurements* are
// this file's own, taken off the rendered page rather than from the modules
// that placed it — otherwise this would only prove the code agrees with
// itself. But a threshold is a statement about what a reader can see, and two
// copies of one are two chances to be wrong about it.
import { LAYOUT_STYLES } from "../src/layout/autoLayout.ts";
import { SAME_LINE } from "../src/spread.ts";
import { HEAD_REACH } from "../src/labels.ts";

const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

/** The imports with enough connections in them to crowd each other. */
const FIXTURES = [
  "cloud-aws.drawio",
  "order-flow.drawio",
  "vpc-swimlanes.drawio",
  "order-process.vsdx",
  "services.gv",
  "terraform-graph.dot",
  "shop.sql",
  "login.puml",
];

/**
 * Fixtures read as a family other than their default, chosen in the dialog.
 *
 * cloud-aws was written for this suite when it opened as architecture-beta,
 * and that reading is still offered. Read as the flowchart it now opens as,
 * its "Pubblica" label has a 20-unit connection under an icon's caption to
 * sit on, and the label search sends it a long way off — a crowding case of
 * its own, not a measure of the import.
 */
const READ_AS: Record<string, string> = { "cloud-aws.drawio": "architecture" };

/**
 * How much of that a reader would notice, in diagram units.
 *
 * This one is the test's own and not the code's: `spread.ts` has no opinion
 * about how long a shared stretch has to be before it is worth complaining
 * about, only about when two runs count as one line.
 */
const TOLERATED_RUN = 24;

/** What each arrangement is called in the menu, in the default locale. */
const STYLE_LABEL: Record<string, string> = {
  layered: "Hierarchical",
  bands: "Banded",
  rectpacking: "Compact",
  mrtree: "Tree",
  force: "Organic",
};

/**
 * How much straight line an arrowhead needs behind it.
 *
 * The test's own tolerance rather than a rule of the router's: `STUB` is 20
 * and the corner before it is rounded by up to `CORNER_RADIUS`, so a healthy
 * approach leaves ten straight units. Eight, so that what this catches is a
 * bend and not the last two units of arithmetic.
 */
const STRAIGHT_APPROACH = 8;

interface Found {
  edges: number;
  labels: number;
  escaped: string[];
  groupsOver: string[];
  together: string[];
  onFrame: string[];
  bentHeads: string[];
  heads: string[];
  onStranger: string[];
  onNode: string[];
  onLabel: string[];
}

async function look(page: Page): Promise<Found> {
  // The body is written without inner named functions on purpose: `tsx`
  // compiles one with esbuild's `keepNames`, which injects a `__name` helper
  // that does not exist in the page Playwright ships the body to.
  return page.evaluate(
    ({ SAME_LINE, TOLERATED_RUN, HEAD_REACH, STRAIGHT_APPROACH }) => {
      // Flow units, not screen: the paths are drawn in them, and the label
      // plates and boxes come back through the viewport transform.
      const vp = document.querySelector(".react-flow__viewport") as HTMLElement;
      const m = new DOMMatrix(getComputedStyle(vp).transform);
      const host = (
        document.querySelector(".react-flow") as HTMLElement
      ).getBoundingClientRect();
      const ox = host.x + m.e;
      const oy = host.y + m.f;

      const labels = [...document.querySelectorAll(".edge-label")].map((el) => {
        const b = el.getBoundingClientRect();
        return {
          text: el.textContent ?? "",
          x: (b.x - ox) / m.a,
          y: (b.y - oy) / m.d,
          right: (b.right - ox) / m.a,
          bottom: (b.bottom - oy) / m.d,
        };
      });
      const nodes = [...document.querySelectorAll(".react-flow__node")]
        .filter((el) => !el.classList.contains("react-flow__node-group"))
        .map((el) => {
          const b = el.getBoundingClientRect();
          return {
            id: (el as HTMLElement).dataset.id ?? "",
            x: (b.x - ox) / m.a,
            y: (b.y - oy) / m.d,
            right: (b.right - ox) / m.a,
            bottom: (b.bottom - oy) / m.d,
          };
        });

      const SAMPLES = 120;
      const edges = [...document.querySelectorAll(".react-flow__edge")]
        .map((el) => {
          const p = el.querySelector("path.react-flow__edge-path") as SVGPathElement | null;
          if (!p) return null;
          const len = p.getTotalLength();
          const pts: { x: number; y: number }[] = [];
          for (let i = 0; i <= SAMPLES; i++) pts.push(p.getPointAtLength((len * i) / SAMPLES));
          return {
            id: (el as HTMLElement).dataset.id ?? "",
            dashed: getComputedStyle(p).strokeDasharray !== "none",
            pts,
            len,
          };
        })
        .filter((e): e is NonNullable<typeof e> => !!e && e.len > 0);

      // Two edges that merely cross one another are fine — every drawing has
      // them, hopping over, and they only touch in a point. What the reader
      // notices is two drawing *along the same course*: parallel legs a few
      // units apart for far too long. The sampled points cannot tell a
      // crossing from a short overlap on their own, but which one it was is
      // in the chords: parallel where they run alongside, square where they
      // cross. So a near point counts only if the two paths are roughly
      // parallel there. (All inline: the body must stay without named
      // functions, since `keepNames` would inject a `__name` helper the page
      // does not have.)
      const together: string[] = [];
      for (let i = 0; i < edges.length; i++) {
        for (let j = i + 1; j < edges.length; j++) {
          let near = 0;
          for (let a = 0; a < edges[i].pts.length; a++) {
            const p = edges[i].pts[a];
            const la = edges[i].pts[Math.max(0, a - 1)];
            const ha = edges[i].pts[Math.min(edges[i].pts.length - 1, a + 1)];
            const ax = ha.x - la.x;
            const ay = ha.y - la.y;
            let hit = false;
            for (let b = 0; b < edges[j].pts.length && !hit; b++) {
              const q = edges[j].pts[b];
              if (Math.hypot(q.x - p.x, q.y - p.y) >= SAME_LINE) continue;
              const lb = edges[j].pts[Math.max(0, b - 1)];
              const hb = edges[j].pts[Math.min(edges[j].pts.length - 1, b + 1)];
              const bx = hb.x - lb.x;
              const by = hb.y - lb.y;
              const n = Math.hypot(ax, ay) * Math.hypot(bx, by);
              hit = n !== 0 && Math.abs((ax * bx + ay * by) / n) >= 0.866;
            }
            if (hit) near++;
          }
          const run = (near / SAMPLES) * edges[i].len;
          if (run >= TOLERATED_RUN) {
            const mixed = edges[i].dashed !== edges[j].dashed ? " — one of them dashed" : "";
            together.push(
              `${edges[i].id} over ${edges[j].id} for ${Math.round(run)} units${mixed}`,
            );
          }
        }
      }

      // Group frames, as the four lines each one draws.
      const frames = [...document.querySelectorAll(".react-flow__node-group")].map((el) => {
        const b = el.getBoundingClientRect();
        return {
          id: (el as HTMLElement).dataset.id ?? "",
          x: (b.x - ox) / m.a,
          y: (b.y - oy) / m.d,
          right: (b.right - ox) / m.a,
          bottom: (b.bottom - oy) / m.d,
        };
      });

      const onFrame: string[] = [];
      for (const e of edges) {
        for (const f of frames) {
          const sides = [
            { flat: "y" as const, at: f.y, from: f.x, to: f.right, name: "top" },
            { flat: "y" as const, at: f.bottom, from: f.x, to: f.right, name: "bottom" },
            { flat: "x" as const, at: f.x, from: f.y, to: f.bottom, name: "left" },
            { flat: "x" as const, at: f.right, from: f.y, to: f.bottom, name: "right" },
          ];
          for (const s of sides) {
            let near = 0;
            for (const p of e.pts) {
              const off = s.flat === "y" ? Math.abs(p.y - s.at) : Math.abs(p.x - s.at);
              const along = s.flat === "y" ? p.x : p.y;
              if (off < SAME_LINE && along >= s.from && along <= s.to) near++;
            }
            const run = (near / SAMPLES) * e.len;
            if (run >= TOLERATED_RUN)
              onFrame.push(
                `${e.id} runs along the ${s.name} of ${f.id} for ${Math.round(run)} units`,
              );
          }
        }
      }

      // The straight run behind each arrowhead. Measured from the tip
      // backwards: how far the line stays on the tangent it arrives on.
      const bentHeads: string[] = [];
      for (const e of edges) {
        const tip = e.pts[SAMPLES];
        const just = e.pts[SAMPLES - 1];
        const dx = tip.x - just.x;
        const dy = tip.y - just.y;
        const norm = Math.hypot(dx, dy);
        if (norm === 0) continue;
        let straight = 0;
        for (let i = SAMPLES - 1; i >= 0; i--) {
          const p = e.pts[i];
          // Distance from the line through the tip along the arrival tangent.
          const off = Math.abs((tip.x - p.x) * (dy / norm) - (tip.y - p.y) * (dx / norm));
          if (off > 1) break;
          straight = Math.hypot(tip.x - p.x, tip.y - p.y);
        }
        if (straight < STRAIGHT_APPROACH)
          bentHeads.push(`${e.id} arrives on a bend (${straight.toFixed(1)} units straight)`);
      }

      const heads: string[] = [];
      for (const e of edges) {
        for (let i = 0; i <= SAMPLES; i++) {
          const d = (i * e.len) / SAMPLES;
          if (d > HEAD_REACH && e.len - d > HEAD_REACH) continue;
          const p = e.pts[i];
          const by = labels.find(
            (l) => p.x >= l.x && p.x <= l.right && p.y >= l.y && p.y <= l.bottom,
          );
          if (by) {
            heads.push(`${e.id} ends under [${by.text}]`);
            break;
          }
        }
      }

      // A label lying across a connection that is not its own. The label layer
      // is a portal, so the DOM does not say which edge a plate belongs to;
      // the store does, and matching on the drawn text is enough to pair them.
      const owners = new Map<string, Set<string>>();
      const store = (
        window as unknown as {
          __graphTest: { store: { getState(): { edges: { id: string; label?: unknown }[] } } };
        }
      ).__graphTest.store.getState();
      for (const e of store.edges) {
        const text = typeof e.label === "string" ? e.label : "";
        if (!text) continue;
        const set = owners.get(text) ?? new Set<string>();
        set.add(e.id);
        owners.set(text, set);
      }

      // Along, not across: a line that goes in the left edge of a plate and
      // out the right edge is a line the words are written on. Anything else
      // — in the top and out the bottom, or in and back out the same side —
      // is a line passing behind a label. The same question `lyingAlong` in
      // `labels.ts` asks, put to the rendered path.
      const onStranger: string[] = [];
      for (const e of edges) {
        for (const l of labels) {
          if (!l.text || owners.get(l.text)?.has(e.id)) continue;
          let from = -1;
          for (let i = 0; i <= SAMPLES; i++) {
            const p = e.pts[i];
            if (p.x >= l.x && p.x <= l.right && p.y >= l.y && p.y <= l.bottom) {
              from = i;
              break;
            }
          }
          if (from <= 0) continue;
          let to = from;
          while (
            to + 1 <= SAMPLES &&
            e.pts[to + 1].x >= l.x &&
            e.pts[to + 1].x <= l.right &&
            e.pts[to + 1].y >= l.y &&
            e.pts[to + 1].y <= l.bottom
          )
            to++;
          if (to + 1 > SAMPLES) continue;
          const before = e.pts[from - 1];
          const after = e.pts[to + 1];
          const enteredLeft = before.x < l.x;
          const enteredRight = before.x > l.right;
          const leftLeft = after.x < l.x;
          const leftRight = after.x > l.right;
          if (!((enteredLeft && leftRight) || (enteredRight && leftLeft))) continue;
          let run = 0;
          for (let i = from + 1; i <= to; i++)
            run += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].y - e.pts[i - 1].y);
          onStranger.push(`[${l.text}] lies along ${e.id} for ${Math.round(run)} units`);
        }
      }

      const onNode: string[] = [];
      for (const l of labels)
        for (const n of nodes) {
          const w = Math.min(l.right, n.right) - Math.max(l.x, n.x);
          const h = Math.min(l.bottom, n.bottom) - Math.max(l.y, n.y);
          if (w > 0 && h > 0 && w * h > 1) onNode.push(`[${l.text}] over ${n.id}`);
        }

      // Containment, measured on the boxes as drawn rather than on the sizes
      // the store holds, since those are what a reader sees.
      const boxes = [...document.querySelectorAll(".react-flow__node")].map((el) => {
        const b = el.getBoundingClientRect();
        return {
          id: (el as HTMLElement).dataset.id ?? "",
          group: el.classList.contains("react-flow__node-group"),
          x: b.x,
          y: b.y,
          right: b.right,
          bottom: b.bottom,
        };
      });
      const parentOf = new Map<string, string | undefined>(
        (
          window as unknown as {
            __graphTest: {
              store: { getState(): { nodes: { id: string; parentId?: string }[] } };
            };
          }
        ).__graphTest.store
          .getState()
          .nodes.map((n) => [n.id, n.parentId]),
      );
      const drawn = new Map(boxes.map((f) => [f.id, f]));
      const escaped: string[] = [];
      for (const f of boxes) {
        const parent = parentOf.get(f.id);
        const p = parent ? drawn.get(parent) : undefined;
        if (!p) continue;
        const out = Math.max(p.x - f.x, p.y - f.y, f.right - p.right, f.bottom - p.bottom);
        if (out > 1) escaped.push(`${f.id} is drawn ${Math.round(out)}px outside ${parent}`);
      }
      const groupsOver: string[] = [];
      const gs = boxes.filter((f) => f.group);
      for (let i = 0; i < gs.length; i++)
        for (let j = i + 1; j < gs.length; j++) {
          if (parentOf.get(gs[i].id) === gs[j].id || parentOf.get(gs[j].id) === gs[i].id)
            continue;
          const w = Math.min(gs[i].right, gs[j].right) - Math.max(gs[i].x, gs[j].x);
          const h = Math.min(gs[i].bottom, gs[j].bottom) - Math.max(gs[i].y, gs[j].y);
          if (w > 1 && h > 1) groupsOver.push(`${gs[i].id} overlaps ${gs[j].id}`);
        }

      const onLabel: string[] = [];
      for (let i = 0; i < labels.length; i++)
        for (let j = i + 1; j < labels.length; j++) {
          const a = labels[i];
          const b = labels[j];
          const w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
          if (w > 0 && h > 0 && w * h > 1) onLabel.push(`[${a.text}] over [${b.text}]`);
        }

      return {
        edges: edges.length,
        labels: labels.length,
        together,
        onFrame,
        onStranger,
        bentHeads,
        heads,
        onNode,
        onLabel,
        escaped,
        groupsOver,
      };
    },
    { SAME_LINE, TOLERATED_RUN, HEAD_REACH, STRAIGHT_APPROACH },
  );
}

let failures = 0;
/** Counted and failed. */
function check(what: string, wrong: string[]) {
  if (wrong.length === 0) {
    console.log(`  ✓ ${what}`);
    return;
  }
  failures++;
  console.error(`  ✗ ${what}`);
  for (const w of wrong.slice(0, 4)) console.error(`      ${w}`);
  if (wrong.length > 4) console.error(`      …and ${wrong.length - 4} more`);
}

async function ready(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __graphTest?: { ready(): boolean } }).__graphTest?.ready(),
    undefined,
    { timeout: 30000 },
  );
}

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("[console]", msg.text());
  });

  const totals = { edges: 0, labels: 0 };
  const judge = (name: string, found: Found) => {
    totals.edges += found.edges;
    totals.labels += found.labels;
    console.log(`\n${name} — ${found.edges} connections, ${found.labels} labels`);
    check("no connection is drawn on top of another", found.together);
    check("no connection is drawn along a group's border", found.onFrame);
    check("every arrowhead has straight line behind it", found.bentHeads);
    check("no arrowhead is hidden under a label", found.heads);
    check("no label lies across a connection it does not name", found.onStranger);
    check("no label is over a box", found.onNode);
    check("no label is over another label", found.onLabel);
    check("nothing is drawn outside the group it belongs to", found.escaped);
    check("no two unrelated groups overlap", found.groupsOver);
  };

  for (const template of TEMPLATES) {
    await page.goto(codeUrl(template.code));
    await ready(page);
    await page.waitForTimeout(800);
    judge(`template ${template.id}`, await look(page));
  }

  for (const name of FIXTURES) {
    await page.goto(BASE);
    await ready(page);
    await page.setInputFiles('input[type="file"]', fixture(name));
    await page.locator(".modal").waitFor({ timeout: 30000 });
    if (READ_AS[name]) {
      await page
        .locator(".import-canvas .react-flow__node")
        .first()
        .waitFor({ timeout: 30000 });
      await page.locator(".export-opts select").first().selectOption(READ_AS[name]);
      await page.waitForTimeout(1500);
    }
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.waitForTimeout(2000);
    judge(name, await look(page));

    // And again once Auto-layout has rearranged it. Only the containment is
    // re-checked: rearranging moves every label and connection, so the rest
    // would be measuring a different drawing, but a container that comes out
    // the wrong size is a fault of the rearranging itself.
    if ((await page.locator(".react-flow__node-group").count()) > 0) {
      // Every arrangement, not just the default: they are different algorithms
      // and only share the code that applies the result, which is where the
      // containers came out at their old size in their new place.
      for (const style of LAYOUT_STYLES) {
        await page.getByRole("button", { name: "Auto-layout", exact: true }).click();
        await page.getByRole("button", { name: STYLE_LABEL[style], exact: true }).click();
        await page.waitForTimeout(3000);
        const after = await look(page);
        console.log(`
${name}, rearranged — ${style}`);
        check("nothing is drawn outside the group it belongs to", after.escaped);
        check("no two unrelated groups overlap", after.groupsOver);
      }
    }
  }

  console.log(
    `\n${totals.edges} connections and ${totals.labels} labels across ` +
      `${TEMPLATES.length + FIXTURES.length} diagrams`,
  );
  console.log(
    failures === 0 ? "all of it legible" : `${failures} things a reader would notice`,
  );
} finally {
  await browser.close();
}

process.exit(failures === 0 ? 0 : 1);
