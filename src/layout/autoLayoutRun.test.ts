import { describe, expect, it } from "vitest";
import { autoLayout, LAYOUT_STYLES } from "./autoLayout";
import type { AnyNode, FlowEdge } from "../model/types";
import { useGraphStore } from "../store";
import { allRoutes } from "../routes";
import type { Point } from "../routing";

/**
 * `autoLayout()` actually running, rather than the helpers around it.
 *
 * The plan for a renderer other tools can import rests on a claim nothing was
 * checking: that layout is pure enough to run without a browser. It looked
 * true — `autoLayout.ts` names no DOM API, and `createElk()` already falls back
 * to `elkjs/lib/elk.bundled.js` when `Worker` is undefined, which is exactly
 * the case here — but "looked true" is how the assumption in
 * `estimateSize` survived as long as it did.
 *
 * So this drives the real solver, in Node, through the real fallback. The
 * assertions are relationships rather than coordinates: ELK is a third-party
 * solver whose exact output may shift under a version bump, and a test that
 * pinned the numbers would fail for reasons that are not about us. What must
 * hold is that every node is placed, that the direction is obeyed, that a
 * node's size is what reserves its room, and that a group's children come back
 * in the group's frame.
 *
 * Kept in its own file, away from `autoLayout.test.ts`, because that one is a
 * pure unit test that runs in milliseconds and this one loads a 1.4 MB solver.
 */

/** A node of a stated size, so the arithmetic has something exact to hit. */
function node(id: string, width: number, height: number, parentId?: string): AnyNode {
  return {
    id,
    type: "shape",
    position: { x: 0, y: 0 },
    width,
    height,
    data: { label: id, shape: "rect" },
    ...(parentId ? { parentId } : {}),
  } as unknown as AnyNode;
}

function group(id: string): AnyNode {
  return {
    id,
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: id },
  } as unknown as AnyNode;
}

function edge(source: string, target: string): FlowEdge {
  return { id: `${source}-${target}`, source, target, data: { label: "" } };
}

describe("autoLayout, run for real", () => {
  it("places every node it is given", async () => {
    const nodes = [node("a", 160, 54), node("b", 160, 54), node("c", 160, 54)];
    const { positions } = await autoLayout(nodes, [edge("a", "b"), edge("b", "c")], "TB");

    expect(Object.keys(positions).sort()).toEqual(["a", "b", "c"]);
    for (const p of Object.values(positions)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("lays a chain out across the page when asked for LR", async () => {
    const nodes = [node("a", 160, 54), node("b", 160, 54)];
    const { positions } = await autoLayout(nodes, [edge("a", "b")], "LR");

    expect(positions.b.x).toBeGreaterThan(positions.a.x);
  });

  it("lays the same chain down the page when asked for TB", async () => {
    const nodes = [node("a", 160, 54), node("b", 160, 54)];
    const { positions } = await autoLayout(nodes, [edge("a", "b")], "TB");

    expect(positions.b.y).toBeGreaterThan(positions.a.y);
  });

  it("reserves room according to the size a node states", async () => {
    // The point of Phase 2b in RENDERER.local.md: what is fed in here is what
    // decides the picture. A node twice as wide must push its successor twice
    // as far, or the sizes are decoration.
    const narrow = (
      await autoLayout([node("a", 100, 54), node("b", 100, 54)], [edge("a", "b")], "LR")
    ).positions;
    const wide = (
      await autoLayout([node("a", 400, 54), node("b", 100, 54)], [edge("a", "b")], "LR")
    ).positions;

    expect(narrow.b.x - narrow.a.x).toBeGreaterThanOrEqual(100);
    expect(wide.b.x - wide.a.x).toBeGreaterThanOrEqual(400);
    expect(wide.b.x - wide.a.x).toBeGreaterThan(narrow.b.x - narrow.a.x);
  });

  it("returns a group's children in the group's own frame", async () => {
    const nodes = [group("g"), node("a", 160, 54, "g"), node("b", 160, 54, "g")];
    const { positions } = await autoLayout(nodes, [edge("a", "b")], "TB");

    // The group is sized by ELK and reported with `w`/`h`; a leaf is not.
    expect(positions.g.w).toBeGreaterThan(0);
    expect(positions.g.h).toBeGreaterThan(0);
    expect(positions.a.w).toBeUndefined();

    // Children are parent-relative, which is what React Flow expects — so they
    // sit inside the box rather than out at the group's absolute coordinates.
    for (const id of ["a", "b"]) {
      expect(positions[id].x).toBeGreaterThanOrEqual(0);
      expect(positions[id].x).toBeLessThan(positions.g.w!);
      expect(positions[id].y).toBeLessThan(positions.g.h!);
    }
  });

  it("coordinates the disconnected as well as the connected", async () => {
    const { positions } = await autoLayout([node("lonely", 160, 54)], [], "TB");
    expect(positions.lonely).toBeDefined();
  });

  it("auto draws every arrangement and keeps a single winner, deterministically", async () => {
    const [nodes, edges] = [
      [group("g"), node("a", 120, 60, "g"), node("b", 120, 60, "g")],
      [edge("a", "b")],
    ];
    const laid = await autoLayout(nodes, edges, "TB", "auto", "flowchart");
    const first = laid.positions;
    const again = (await autoLayout(nodes, edges, "TB", "auto", "flowchart")).positions;
    expect(again).toEqual(first);
    expect(Object.keys(first).sort()).toEqual(["a", "b", "g"]);
  });
});

describe("the arrangements on offer", () => {
  /** A group with two children and one connection between them. */
  const graph = (): [AnyNode[], FlowEdge[]] => [
    [group("g"), node("a", 120, 60, "g"), node("b", 120, 60, "g")],
    [edge("a", "b")],
  ];

  it.each(LAYOUT_STYLES)("keeps a group's children inside its frame — %s", async (style) => {
    const [nodes, edges] = graph();
    const out = (await autoLayout(nodes, edges, "TB", style)).positions;
    const frame = out.g;
    expect(frame.w).toBeGreaterThan(0);
    for (const id of ["a", "b"]) {
      expect(out[id].x).toBeGreaterThanOrEqual(0);
      expect(out[id].y).toBeGreaterThanOrEqual(0);
      expect(out[id].x + 120).toBeLessThanOrEqual(frame.w!);
      expect(out[id].y + 60).toBeLessThanOrEqual(frame.h!);
    }
  });

  it("lays the same graph out differently depending on the style", async () => {
    // Not asserting *which* is which — that is ELK's business and would pin
    // its version — only that the choice reaches the solver at all. A style
    // that silently fell back to the default would place them identically.
    const seen = new Set<string>();
    for (const style of LAYOUT_STYLES) {
      const [nodes, edges] = graph();
      const out = (await autoLayout(nodes, edges, "TB", style)).positions;
      seen.add(JSON.stringify([out.a, out.b, out.g]));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("puts a subgraph after the one that feeds it, when the two feed each other", async () => {
    // An order flow: the inventory check's "no" branch goes off to a backorder
    // process, and the backorder comes back to reserve the stock. The two
    // subgraphs feed each other, so one of the two connections has to be
    // turned round before they can be put in ranks. Greedy cycle breaking
    // counted connections and turned round the way out, and the backorder
    // process was drawn above the check that leads to it.
    const nodes = [
      group("pay"),
      node("p", 160, 54, "pay"),
      group("inv"),
      node("check", 150, 86, "inv"),
      node("reserve", 160, 54, "inv"),
      node("reorder", 160, 54, "inv"),
      group("back"),
      node("notify", 160, 54, "back"),
      node("wait", 160, 54, "back"),
      node("done", 160, 54, "back"),
      node("escalate", 160, 54, "back"),
    ];
    const edges = [
      edge("p", "check"),
      edge("check", "reserve"),
      edge("check", "reorder"),
      edge("reorder", "notify"),
      edge("notify", "wait"),
      edge("wait", "done"),
      edge("wait", "escalate"),
      edge("done", "reserve"),
    ];
    const out = (await autoLayout(nodes, edges, "TB", "layered")).positions;
    expect(out.pay.y).toBeLessThan(out.inv.y);
    expect(out.inv.y).toBeLessThan(out.back.y);
  });

  it("spaces the inside of a subgraph as it spaces the outside", async () => {
    const [nodes, edges] = [
      [group("g"), node("a", 160, 54, "g"), node("b", 160, 54, "g")],
      [edge("a", "b")],
    ];
    const out = (await autoLayout(nodes, edges, "TB", "layered")).positions;
    // The gap between ranks at the top level is 70; ELK's own default, which
    // a subgraph got, is 20.
    expect(out.b.y - (out.a.y + 54)).toBeGreaterThanOrEqual(70);
  });

  it("arranges hierarchically when no style is asked for", async () => {
    const [nodes, edges] = graph();
    const asked = (await autoLayout(nodes, edges, "TB", "layered")).positions;
    const silent = (await autoLayout(nodes, edges, "TB")).positions;
    expect(silent).toEqual(asked);
  });
});

describe("the lines an arrangement routes", () => {
  /** Two runs, one on each line, lying side by side closer than `near`. */
  const alongside = (a: Point[], b: Point[], near: number): number => {
    let n = 0;
    for (let i = 1; i < a.length; i++)
      for (let j = 1; j < b.length; j++) {
        const [p, q, r, t] = [a[i - 1], a[i], b[j - 1], b[j]];
        const across: "x" | "y" | null =
          Math.abs(p.y - q.y) < 0.5 && Math.abs(r.y - t.y) < 0.5
            ? "y"
            : Math.abs(p.x - q.x) < 0.5 && Math.abs(r.x - t.x) < 0.5
              ? "x"
              : null;
        if (!across || Math.abs(p[across] - r[across]) >= near) continue;
        const k = across === "x" ? "y" : "x";
        const lo = Math.max(Math.min(p[k], q[k]), Math.min(r[k], t[k]));
        const hi = Math.min(Math.max(p[k], q[k]), Math.max(r[k], t[k]));
        n += Math.max(0, hi - lo);
      }
    return n;
  };

  it("keeps them, and keeps them in lanes of their own", async () => {
    // An order-handling flow of eight subgraphs. Its lines were routed afresh
    // after the boxes were placed, ran down one another's lanes and crossed
    // six times; routed by the arrangement that placed the boxes for them,
    // and given room, they cross once and none lies alongside another.
    await useGraphStore.getState().applyCode(ORDER_FLOW, { forceLayout: true });
    await useGraphStore.getState().runAutoLayout("layered");
    const s = useGraphStore.getState();
    expect(s.edges.filter((e) => (e.data?.points ?? []).length > 0).length).toBeGreaterThan(0);
    const routes = [...allRoutes(s.nodes, s.edges, s.kind).values()];
    for (let i = 0; i < routes.length; i++)
      for (let j = i + 1; j < routes.length; j++) {
        expect(alongside(routes[i], routes[j], 12)).toBeLessThan(40);
      }
  });

  it("are not kept for an arrangement that does not route them", async () => {
    await useGraphStore.getState().applyCode(ORDER_FLOW, { forceLayout: true });
    await useGraphStore.getState().runAutoLayout("force");
    expect(
      useGraphStore.getState().edges.every((e) => (e.data?.points ?? []).length === 0),
    ).toBe(true);
  });
});

const ORDER_FLOW = `flowchart TD
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
`;
