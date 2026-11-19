import { describe, expect, it } from "vitest";
import { allEnds, allRoutes, faceReach, settleCorners } from "./routes";
import { outward, segmentsOf, slidePath, STUB } from "./orthogonal";
import { crosses } from "./avoid";
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

  it("brings a bus into one face as one trunk with one head, without folding back", async () => {
    // Three connections down one column with their last corner all at the
    // middle of the target's face, as draw.io draws a bus: one trunk, one
    // arrow. The heads were once parted, a head's width each, and every line
    // then stepped off the trunk to reach its own — a comb where draw.io has
    // a line. They arrive together now, as drawn.
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
        expect(Math.hypot(heads[i].x - heads[j].x, heads[i].y - heads[j].y)).toBeLessThan(0.5);
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

  it("routes an order flow out of its boxes and round the subgraphs it is not in", async () => {
    // Two lines arriving at the top of one box ("Preparazione Spedizione"),
    // from two boxes a long way apart. Swapping the runs they cross over on made one of them set off
    // upwards out of the bottom of its own box, through it and the two above
    // it, because that crossed one line fewer.
    // The order-handling flow it was found in, as it came.
    await load(`flowchart TD
    subgraph start["Inizio"]
        S0([Inizio])
    end
    subgraph end["Fine"]
        S20([Fine])
    end
    subgraph order["Inserimento Ordine"]
        S0 --> S1([Ordine Ricevuto])
        S1 --> S2([Validazione Ordine])
        S2 --> S3([Elaborazione Pagamento])
    end
    subgraph payment["Pagamento"]
        S3 --> S4{Pagamento Approvato?}
        S4 -->|Sì| S5([Verifica Inventario])
        S4 -->|No| S6([Pagamento Rifiutato])
        S6 --> S20
    end
    subgraph inventory["Inventario"]
        S5 --> S7{Inventario Disponibile?}
        S7 -->|Sì| S8([Riserva Inventario])
        S7 -->|No| S9([Processo di Riordino])
    end
    subgraph backorder["Processo di Riordino"]
        S9 --> S10([Notifica Cliente])
        S10 --> S11([Attesa Riassortimento])
        S11 --> S12{Riassortimento Ricevuto?}
        S12 -->|Sì| S13([Riordino Completato])
        S12 -->|No| S14([Escalation al Supporto])
        S13 --> S8
    end
    subgraph shipment["Spedizione"]
        S8 --> S15([Preparazione Spedizione])
        S15 --> S16([Spedizione Ordine])
        S16 --> S17([Aggiorna Stato Ordine])
        S17 --> S18([Invia Email di Conferma])
        S18 --> S20
    end
    subgraph fraud["Rilevamento Frodi"]
        S3 --> V([Controllo Frodi])
        V -->|Frodi Rilevati| S21([Mantenimento Ordine])
        V -->|Nessuna Frode| S15
        S21 --> S22([Notifica Team Frodi])
        S22 --> S23([Supporto Clienti])
        S23 --> S15
    end
    S14 --> S23
`);
    const boxes = absoluteBoxes(state().nodes);
    const groups = new Set(
      state()
        .nodes.filter((n) => n.type === "group")
        .map((n) => n.id),
    );
    const ends = allEnds(state().nodes, state().edges, state().kind);
    for (const e of state().edges) {
      const r = route(e.source, e.target);
      // Out through the face it leaves, not back into its own box. (Not
      // "never inside it": a line off a diamond starts on the outline, which
      // is inside the box.)
      const side = ends.get(e.id)!.fromSide;
      const out = outward(side);
      expect((r[1].x - r[0].x) * out.x + (r[1].y - r[0].y) * out.y).toBeGreaterThan(0);
      // Nor through a subgraph it is no part of: the long ones go round them,
      // as the Mermaid preview draws them.
      const holders = (id: string) => {
        const out = new Set<string>();
        for (let at = state().nodes.find((n) => n.id === id)?.parentId; at;) {
          out.add(at);
          at = state().nodes.find((n) => n.id === at)?.parentId;
        }
        return out;
      };
      const own = new Set([...holders(e.source), ...holders(e.target)]);
      for (const g of groups) {
        if (own.has(g)) continue;
        const frame = boxes.get(g)!;
        expect(r.every((q, i) => i === 0 || !crosses(r[i - 1], q, frame))).toBe(true);
      }
      // And through no box but its own two.
      for (const [id, box] of boxes) {
        if (groups.has(id) || id === e.source || id === e.target) continue;
        expect(r.every((q, i) => i === 0 || !crosses(r[i - 1], q, box))).toBe(true);
      }
    }
  });
});

describe("dragging a run of a connection", () => {
  /**
   * The gesture as the canvas makes it: the line on the screen with one run
   * moved, kept, and then the corners the router would draw anyway dropped.
   */
  const drag = (id: string, index: number, to: number): Point[] | null => {
    const { nodes, edges, kind } = state();
    const drawn = allRoutes(nodes, edges, kind).get(id)!;
    const at = allEnds(nodes, edges, kind).get(id)!;
    const path = [at.start, ...drawn.slice(1, -1), at.end];
    const corners = slidePath(path, index, to, faceReach(nodes, edges, kind, id));
    if (!corners) return null;
    state().setWaypoints(id, corners, false);
    const kept = settleCorners(state().nodes, state().edges, kind, id);
    state().setWaypoints(id, kept, false);
    return corners;
  };

  it.each(["approval", "order-state", "domain", "webapp"])(
    "puts every run of %s where it is dragged, and folds none",
    async (template) => {
      // Sliding used to store two corners to pin the run and trust the router
      // to draw the rest as before. It did not — the rest was the obstacle
      // search's work, or the corridor pass's — and barely half the drags on
      // these diagrams ended with the run where the pointer had left it.
      const code = TEMPLATES.find((t) => t.id === template)!.code;
      await load(code);
      const base = { nodes: state().nodes, edges: state().edges };
      const first = new Map(routes());
      for (const edge of base.edges) {
        if (edge.source === edge.target) continue;
        const drawn = first.get(edge.id)!;
        const runs = segmentsOf(drawn);
        for (const run of runs) {
          if (Math.abs(run.to.x - run.from.x) + Math.abs(run.to.y - run.from.y) < 24) continue;
          const across = run.axis === "x" ? "y" : "x";
          for (const by of [-60, -30, 30, 60]) {
            useGraphStore.setState(base);
            const asked = drag(edge.id, run.index, run.from[across] + by);
            if (!asked) continue;
            const now = routes().get(edge.id)!;
            expect(folds(now)).toBe(false);
            // Where the gesture said the run would be: the pointer's place,
            // or as near it as a face or a stub allows.
            const places = asked.map((c) => c[across]);
            if (places.length === 0) continue;
            const want = places.reduce((m, v) =>
              Math.abs(v - (run.from[across] + by)) < Math.abs(m - (run.from[across] + by))
                ? v
                : m,
            );
            const landed = segmentsOf(now).some(
              (s) => s.axis === run.axis && Math.abs(s.from[across] - want) <= 1.5,
            );
            expect(landed, `${edge.source}->${edge.target} run ${run.index} by ${by}`).toBe(
              true,
            );
          }
        }
      }
    },
  );

  it("comes back to the line it was when the run is dragged out and back", async () => {
    await load("flowchart LR\n  a --> b\n  a --> c\n");
    const e = state().edges.find((x) => x.target === "c")!;
    const before = routes().get(e.id)!;
    const run = segmentsOf(before).find((s) => s.axis === "y")!;
    const taken = { nodes: state().nodes, edges: state().edges };
    const path = [
      allEnds(taken.nodes, taken.edges, state().kind).get(e.id)!.start,
      ...before.slice(1, -1),
      allEnds(taken.nodes, taken.edges, state().kind).get(e.id)!.end,
    ];
    const reach = faceReach(taken.nodes, taken.edges, state().kind, e.id);
    // Every move of one drag starts from the line taken at pointerdown.
    state().setWaypoints(e.id, slidePath(path, run.index, run.from.x + 40, reach)!, false);
    state().setWaypoints(e.id, slidePath(path, run.index, run.from.x, reach)!, false);
    state().setWaypoints(e.id, settleCorners(state().nodes, state().edges, state().kind, e.id));
    expect(routes().get(e.id)).toEqual(before);
    expect(state().edges.find((x) => x.id === e.id)!.data?.points ?? []).toEqual([]);
  });

  it("moves the end along its face, not its neighbour's", async () => {
    // Two lines leave one face. Dragging the run one of them leaves on used
    // to hand its new place to the other — the berths were re-dealt by where
    // each line turns — and the line that was dragged went to the old place
    // and came back along the face.
    await load("flowchart TD\n  a --> b\n  a --> c\n");
    const [ab, ac] = ["b", "c"].map((t) => state().edges.find((x) => x.target === t)!);
    const other = routes().get(ac.id)![0];
    const start = routes().get(ab.id)![0];
    const reach = faceReach(state().nodes, state().edges, state().kind, ab.id).from!;
    const to = start.x < other.x ? reach[0] : reach[1];
    drag(ab.id, 0, to);
    expect(routes().get(ab.id)![0].x).toBeCloseTo(to, 0);
    expect(routes().get(ac.id)![0].x).toBeCloseTo(other.x, 0);
  });

  it("goes round a box to an end pinned on its far face, and does not turn back", async () => {
    // The corner pinning an end stands a stub out from its face, which is
    // where the search for a way round starts from too. As a leg of its own
    // it had no length and a direction to arrive in; the leg before it,
    // no longer the last, arrived from whichever side was nearer.
    await load(
      'flowchart LR\n  a["Alpha"] --> c["Gamma"]\n  b["Beta"]\n' +
        '%% graph:positions {"a":{"x":0,"y":0},"b":{"x":360,"y":0},"c":{"x":360,"y":300}}\n',
    );
    const boxes = absoluteBoxes(state().nodes);
    const c = boxes.get("c")!;
    const e = state().edges[0];
    state().setWaypoints(e.id, [{ x: c.x + c.w + STUB, y: c.y + c.h / 2 }]);
    const r = routes().get(e.id)!;
    expect(r[r.length - 1].x).toBeCloseTo(c.x + c.w, 0);
    expect(folds(r)).toBe(false);
    const b = boxes.get("b")!;
    expect(r.every((q, i) => i === 0 || !crosses(r[i - 1], q, b))).toBe(true);
    expect(r.every((q, i) => i === 0 || i === r.length - 1 || !crosses(r[i - 1], q, c))).toBe(
      true,
    );
  });
});

describe("ends that cannot be met where they are pinned", () => {
  const at = (positions: Record<string, { x: number; y: number }>) =>
    `flowchart LR\n  a["Alpha"] --> b["Beta"]\n  c["Gamma"]\n%% graph:positions ${JSON.stringify(positions)}\n`;

  it("lets go of a pin with a box standing on it, rather than fold the line", async () => {
    // A drawing from draw.io pins most of its ends, and its boxes are often
    // closer together than a line needs to come in between them: an icon ten
    // units from its neighbour, pinned on the side that faces it. Obeyed, the
    // line reached the pin through the neighbour and turned straight back.
    await load(at({ a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 300, y: 200 } }));
    const first = absoluteBoxes(state().nodes).get("b")!;
    // Gamma hard against Beta's far side, where the pin is to stand.
    await load(
      at({ a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 300 + first.w + 10, y: 0 } }),
    );
    const boxes = absoluteBoxes(state().nodes);
    const b = boxes.get("b")!;
    const e = state().edges[0];
    state().setWaypoints(e.id, [{ x: b.x + b.w + STUB, y: b.y + b.h / 2 }]);
    const r = routes().get(e.id)!;
    expect(folds(r)).toBe(false);
    for (const id of ["b", "c"]) {
      const box = boxes.get(id)!;
      const inner = { x: box.x + 3, y: box.y + 3, w: box.w - 6, h: box.h - 6 };
      expect(r.every((q, i) => i === 0 || !crosses(r[i - 1], q, inner))).toBe(true);
    }
    // The corner is still the file's: only the drawing went without it.
    expect(state().edges[0].data?.points).toHaveLength(1);
  });

  it("draws a line straight through a marker laid on it", async () => {
    // The numbered badge on a line says which step the line is. Gone round,
    // every line drawn through its own number had a hump in it.
    await load(
      'flowchart LR\n  a["Alpha"] --> b["Beta"]\n  n(("6"))\n' +
        '%% graph:positions {"a":{"x":0,"y":0},"b":{"x":400,"y":0},"n":{"x":250,"y":10,"w":24,"h":24}}\n',
    );
    const r = routes().get(state().edges[0].id)!;
    expect(r).toHaveLength(2);
  });

  it("shares a narrow gap between two rows, however far aside the boxes are", async () => {
    // Faces sixteen units apart and a box-width aside: a full stub from each
    // crossed over, and the line went down past the lower box's head and
    // came back up to it.
    await load(at({ a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 600, y: 0 } }));
    const a = absoluteBoxes(state().nodes).get("a")!;
    await load(
      at({ a: { x: 0, y: 0 }, b: { x: a.w * 0.6, y: a.h + 16 }, c: { x: 600, y: 0 } }),
    );
    const r = routes().get(state().edges[0].id)!;
    expect(folds(r)).toBe(false);
  });
});
