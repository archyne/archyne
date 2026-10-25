import { describe, expect, it } from "vitest";
import { allRoutes } from "./routes";
import { crosses } from "./avoid";
import { HEAD_ROOM } from "./berths";
import { absoluteBoxes, useGraphStore } from "./store";
import { TEMPLATES } from "./templates";
import type { Point } from "./routing";

/**
 * Every connection's route, through the whole pass: faces, berths, the
 * obstacle search and the separation of shared corridors together.
 */

const load = (code: string) => useGraphStore.getState().applyCode(code, { forceLayout: true });
const state = () => useGraphStore.getState();
const routes = () => allRoutes(state().nodes, state().edges, state().kind);
const route = (source: string, target: string) => {
  const e = state().edges.find((x) => x.source === source && x.target === target)!;
  return routes().get(e.id)!;
};

/** Two runs in a row on one axis, travelling opposite ways: a spike. */
const folds = (r: Point[]): boolean =>
  r.some((b, i) => {
    if (i === 0 || i === r.length - 1) return false;
    const a = r[i - 1];
    const c = r[i + 1];
    const level = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5;
    const plumb = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5;
    return (level && (b.x - a.x) * (c.x - b.x) < 0) || (plumb && (b.y - a.y) * (c.y - b.y) < 0);
  });

describe("routing every connection together", () => {
  it("goes round the nodes between two that face each other", async () => {
    // a and e are the ends of a column, with b, c and d stacked between
    // them. Their faces look straight at each other, and the search that
    // goes round obstacles started on the face itself — inside its own
    // node's margin, where every step is blocked — so it gave up, and the
    // line went straight down through all three.
    await load("flowchart TD\n  a --> b --> c --> d --> e\n  a --> e\n");
    const boxes = absoluteBoxes(state().nodes);
    const r = route("a", "e");
    for (const id of ["b", "c", "d"]) {
      const box = boxes.get(id)!;
      expect(r.every((q, i) => i === 0 || !crosses(r[i - 1], q, box))).toBe(true);
    }
  });

  it("does not fold back on itself next to a node", async () => {
    // The webapp template: api leaves by its bottom for cache, whose top is
    // twenty units under db — too close for the usual margin, and a search
    // that gives up there must not fall back to a spike at either end.
    const webapp = TEMPLATES.find((t) => t.id === "webapp")!;
    await load(webapp.code);
    for (const r of routes().values()) expect(folds(r)).toBe(false);
  });

  it("carries a connection off a diamond's point on to its edge", async () => {
    // Two connections leave the decision's right face, so neither can have
    // its point: each is given a berth on the box, where there is no diamond.
    // They stopped there, in the air.
    await load(
      'flowchart LR\n  check{"Valid?"} -->|"yes"| work["Process"]\n  check -->|"retry"| work\n',
    );
    const box = absoluteBoxes(state().nodes).get("check")!;
    for (const e of state().edges) {
      const start = routes().get(e.id)![0];
      expect(start.x).toBeLessThan(box.x + box.w - 2);
      // On the edge between the right point and the top or bottom one.
      const half = { w: box.w / 2, h: box.h / 2 };
      const along =
        Math.abs(start.x - (box.x + half.w)) / half.w +
        Math.abs(start.y - (box.y + half.h)) / half.h;
      expect(along).toBeCloseTo(1, 1);
    }
  });

  /** A flowchart with every node where it is told to be. */
  const placed = (
    body: string,
    at: Record<string, [number, number, number, number]>,
    corners?: Record<string, Array<[number, number]>>,
  ) => {
    const positions = Object.fromEntries(
      Object.entries(at).map(([id, [x, y, w, h]]) => [id, { x, y, w, h }]),
    );
    return (
      `flowchart LR\n${body}\n%% graph:positions ${JSON.stringify(positions)}\n` +
      (corners ? `%% graph:waypoints ${JSON.stringify(corners)}\n` : "")
    );
  };
  const loadPlaced = (code: string) => useGraphStore.getState().applyCode(code);

  it("leaves by the face that looks at the first corner, not at the far node", async () => {
    // The far node is straight up; the first corner is straight out to the
    // left. Chosen against the node, the line left by the top, went up, and
    // came back down for the corner.
    await loadPlaced(
      placed(
        '  a["A"] --> b["B"]',
        { a: [400, 400, 80, 40], b: [380, 0, 80, 40] },
        {
          "a>b": [
            [300, 420],
            [300, 20],
          ],
        },
      ),
    );
    const r = route("a", "b");
    expect(r[0]).toEqual({ x: 400, y: 420 });
    expect(r[1].y).toBe(420);
    expect(folds(r)).toBe(false);
  });

  it("meets a face level with the corner beside it", async () => {
    // The last corner stands off the middle of the face, where draw.io puts
    // it. Given a berth of its own instead, the line came down to the corner
    // and stepped back up a few units to meet it.
    await loadPlaced(
      placed(
        '  a["A"] --> t["T"]\n  b["B"] --> t',
        { a: [300, 0, 80, 40], b: [300, 300, 80, 40], t: [0, 140, 80, 40] },
        {
          "a>t": [
            [200, 20],
            [200, 150],
          ],
        },
      ),
    );
    const r = route("a", "t");
    expect(r[r.length - 1].y).toBe(150);
    expect(folds(r)).toBe(false);
  });

  it("shares a gap narrower than two stubs between the two ends", async () => {
    // Fourteen apart across, forty down: full stubs crossed over, out past
    // the far face and back.
    await loadPlaced(placed('  a["A"] --> b["B"]', { a: [0, 0, 80, 40], b: [94, 40, 80, 40] }));
    const r = route("a", "b");
    expect(folds(r)).toBe(false);
    expect(r.every((q) => q.x >= 80 && q.x <= 94)).toBe(true);
  });

  it("treats a panel the two ends are inside as a frame, not an obstacle", async () => {
    // A coloured background behind the drawing: a node by its file, a frame
    // by what it does. As an obstacle it walled both ends in, the search gave
    // up, and the line went straight through the node between them.
    await loadPlaced(
      placed('  bg[" "]\n  a["A"] --> b["B"]\n  c["C"]\n  style bg fill:#eeeeee', {
        bg: [0, 0, 600, 300],
        a: [40, 100, 80, 40],
        c: [220, 90, 80, 60],
        b: [400, 100, 80, 40],
      }),
    );
    const c = absoluteBoxes(state().nodes).get("c")!;
    const r = route("a", "b");
    expect(r.every((q, i) => i === 0 || !crosses(r[i - 1], q, c))).toBe(true);
  });

  it("does not go round words with no box", async () => {
    // A "Yes" laid on the line it names.
    await loadPlaced(
      placed('  a["A"] --> b["B"]\n  yes["Yes"]\n  style yes fill:transparent,stroke:none', {
        a: [0, 0, 80, 40],
        b: [400, 0, 80, 40],
        yes: [220, 10, 40, 20],
      }),
    );
    expect(route("a", "b")).toHaveLength(2);
  });

  it("keeps the heads of a bus into one face apart, without folding back", async () => {
    // Three connections down one column with their last corner all at the
    // middle of the target's face, as draw.io draws a bus. Their heads landed
    // on one spot; parted, each line overshot its turn and came back.
    await loadPlaced(
      placed(
        '  a["A"] --> t["T"]\n  b["B"] --> t\n  c["C"] --> t',
        {
          a: [300, 300, 80, 40],
          b: [300, 400, 80, 40],
          c: [300, 500, 80, 40],
          t: [300, 0, 80, 60],
        },
        {
          "a>t": [
            [200, 320],
            [200, 30],
          ],
          "b>t": [
            [200, 420],
            [200, 30],
          ],
          "c>t": [
            [200, 520],
            [200, 30],
          ],
        },
      ),
    );
    const heads = ["a", "b", "c"].map((from) => {
      const r = route(from, "t");
      expect(folds(r)).toBe(false);
      return r[r.length - 1];
    });
    for (let i = 0; i < heads.length; i++) {
      for (let j = i + 1; j < heads.length; j++) {
        expect(
          Math.hypot(heads[i].x - heads[j].x, heads[i].y - heads[j].y),
        ).toBeGreaterThanOrEqual(HEAD_ROOM - 0.5);
      }
    }
  });

  it("keeps arrowheads on a circle from two faces apart", async () => {
    // Five into the top and five into the left: spread along the faces of
    // its box, the outer ones were carried a long way in to the curve, where
    // the ones from the other face met them.
    const above = ["a1", "a2", "a3", "a4", "a5"];
    const beside = ["b1", "b2", "b3", "b4", "b5"];
    const at: Record<string, [number, number, number, number]> = { t: [300, 300, 80, 80] };
    above.forEach((id, i) => (at[id] = [200 + i * 50, 0, 40, 30]));
    beside.forEach((id, i) => (at[id] = [0, 200 + i * 50, 40, 30]));
    await loadPlaced(
      placed(
        ['  t(("T"))', ...[...above, ...beside].map((id) => `  ${id}["${id}"] --> t`)].join(
          "\n",
        ),
        at,
      ),
    );
    const heads = [...above, ...beside].map((from) => route(from, "t").at(-1)!);
    for (let i = 0; i < heads.length; i++) {
      for (let j = i + 1; j < heads.length; j++) {
        expect(
          Math.hypot(heads[i].x - heads[j].x, heads[i].y - heads[j].y),
        ).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it("lines a single corner up with both its ends", async () => {
    // One corner, off to the side of the source's top and too near its
    // corner to line the start up with: lined up only with the far end, the
    // line went up, stepped sideways to it, and came back the other way.
    await loadPlaced(
      placed(
        '  a["A"] --> b["B"]',
        { a: [0, 200, 80, 40], b: [400, 0, 80, 40] },
        {
          "a>b": [[8, 20]],
        },
      ),
    );
    expect(folds(route("a", "b"))).toBe(false);
  });

  it("does not set two stacked boxes' lines off from the point between them", async () => {
    // draw.io puts the corner on the line where two boxes touch; lined up
    // with it, a line from each left from that one spot.
    await loadPlaced(
      placed(
        '  a["A"] --> x["X"]\n  b["B"] --> y["Y"]',
        {
          a: [0, 0, 40, 20],
          b: [0, 20, 40, 20],
          x: [300, -200, 80, 40],
          y: [300, 200, 80, 40],
        },
        {
          "a>x": [
            [200, 20],
            [200, -180],
          ],
          "b>y": [
            [200, 20],
            [200, 220],
          ],
        },
      ),
    );
    const a = route("a", "x")[0];
    const b = route("b", "y")[0];
    expect(Math.abs(a.y - b.y)).toBeGreaterThan(4);
  });

  it("stops a run at its end when its corner stands on a group's corner", async () => {
    // The corner sits level with the top of the target; the line used to
    // run up to it and come back down to its berth.
    await loadPlaced(
      placed(
        '  a["A"] --> t["T"]',
        { a: [400, 300, 80, 40], t: [0, 0, 200, 140] },
        {
          "a>t": [
            [300, 320],
            [300, 0],
          ],
        },
      ),
    );
    expect(folds(route("a", "t"))).toBe(false);
  });

  it("orders lines leaving one face so that turning off does not cross", async () => {
    // Both leave the right face and drop down, `near` much sooner than
    // `far`. Ordered by where they end up, `near` — ending higher — took the
    // upper berth, and its drop cut straight across `far`'s run.
    await loadPlaced(
      placed('  s["S"] --> near["Near"]\n  s --> far["Far"]', {
        s: [0, 0, 80, 80],
        near: [150, 150, 80, 40],
        far: [500, 300, 80, 40],
      }),
    );
    const a = route("s", "near");
    const b = route("s", "far");
    const crossing = a.some((p, i) =>
      b.some((q, j) => {
        if (i === 0 || j === 0) return false;
        const [p0, q0] = [a[i - 1], b[j - 1]];
        const level = Math.abs(p0.y - p.y) < 0.5;
        if (level === Math.abs(q0.y - q.y) < 0.5) return false;
        const [h0, h1, v0, v1] = level ? [p0, p, q0, q] : [q0, q, p0, p];
        return (
          v0.x > Math.min(h0.x, h1.x) + 1 &&
          v0.x < Math.max(h0.x, h1.x) - 1 &&
          h0.y > Math.min(v0.y, v1.y) + 1 &&
          h0.y < Math.max(v0.y, v1.y) - 1
        );
      }),
    );
    expect(crossing).toBe(false);
  });

  it("orders lines through one shared column so that none crosses another", async () => {
    // TA01 in the threat model, cut down: every corner on the column at
    // x=140, so the face could not tell the lines apart until the corridor
    // pass gave each a column of its own — in an order that put a line
    // dropping sooner above one dropping later, and its drop cut across.
    await loadPlaced(
      placed(
        '  AV10["AV10"] --> TA01["TA01"]\n  TA01 --> AV11["AV11"]\n  TA01 --> AV12["AV12"]\n  AV06["AV06"] --> TA01',
        {
          TA01: [30, 320, 80, 40],
          AV10: [170, 230, 40, 20],
          AV11: [170, 170, 40, 20],
          AV12: [170, 470, 40, 20],
          AV06: [170, 520, 40, 20],
        },
        {
          "AV10>TA01": [
            [140, 240],
            [140, 340],
          ],
          "TA01>AV11": [
            [140, 340],
            [140, 190],
          ],
          "TA01>AV12": [
            [140, 340],
            [140, 480],
          ],
          "AV06>TA01": [
            [140, 530],
            [140, 340],
          ],
        },
      ),
    );
    const all = [...routes().values()];
    const crossing = (p: Point[], q: Point[]) =>
      p.some((p1, i) =>
        q.some((q1, j) => {
          if (i === 0 || j === 0) return false;
          const [p0, q0] = [p[i - 1], q[j - 1]];
          const level = Math.abs(p0.y - p1.y) < 0.5;
          if (level === Math.abs(q0.y - q1.y) < 0.5) return false;
          const [h0, h1, v0, v1] = level ? [p0, p1, q0, q1] : [q0, q1, p0, p1];
          return (
            v0.x > Math.min(h0.x, h1.x) + 1 &&
            v0.x < Math.max(h0.x, h1.x) - 1 &&
            h0.y > Math.min(v0.y, v1.y) + 1 &&
            h0.y < Math.max(v0.y, v1.y) - 1
          );
        }),
      );
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) expect(crossing(all[i], all[j])).toBe(false);
    }
  });
});
