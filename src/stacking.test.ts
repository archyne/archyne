import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { stacked } from "./stacking";

const node = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  position: { x: 0, y: 0 },
  data: {},
  type: "shape",
  ...extra,
});
const edge = (source: string, target: string): Edge => ({
  id: `${source}-${target}`,
  source,
  target,
});

describe("stacking boxes over the containers they are not in", () => {
  // draw.io's activity example: a pool of lanes, and "Invoice" lying across
  // two of them without belonging to either.
  const pool = node("Actors", { type: "group" });
  const accounting = node("Accounting", { type: "group", parentId: "Actors" });
  const customer = node("Customer", { type: "group", parentId: "Actors" });
  const send = node("Send_invoice", { parentId: "Accounting" });
  const invoice = node("Invoice");
  const pay = node("Send_payment", { parentId: "Customer" });
  const other = node("Other");
  const nodes = [pool, accounting, customer, send, invoice, pay, other];

  it("lifts a box in no container above the deepest container", () => {
    const out = stacked(nodes, []);
    // React Flow puts a lane one above its pool: the pool is 0, a lane 1.
    expect(out.nodes.find((n) => n.id === "Invoice")!.zIndex).toBe(2);
  });

  it("lifts boxes inside containers to the same level, keeping their order", () => {
    const out = stacked(nodes, []);
    expect(out.nodes.find((n) => n.id === "Send_invoice")!.zIndex).toBe(2);
    expect(out.nodes.map((n) => n.id)).toEqual(nodes.map((n) => n.id));
  });

  it("leaves the containers at the depth React Flow gives them", () => {
    const out = stacked(nodes, []);
    for (const id of ["Actors", "Accounting", "Customer"]) {
      expect(out.nodes.find((n) => n.id === id)!.zIndex).toBeUndefined();
    }
  });

  it("lifts a connection between two boxes in no container", () => {
    const out = stacked(nodes, [edge("Invoice", "Other")]);
    expect(out.edges[0].zIndex).toBe(2);
  });

  it("leaves a connection with an end in a container for React Flow to raise", () => {
    // React Flow adds that end's own level, which is now the boxes' level;
    // a zIndex here as well would put the line over the boxes.
    const out = stacked(nodes, [
      edge("Send_invoice", "Invoice"),
      edge("Invoice", "Send_payment"),
    ]);
    expect(out.edges.map((e) => e.zIndex)).toEqual([undefined, undefined]);
  });

  it("counts a container by what it holds, not only by its type", () => {
    // A composite state holds other states and is not a "group".
    const out = stacked(
      [
        node("Outer", { type: "state" }),
        node("Inner", { type: "state", parentId: "Outer" }),
        node("Loose", { type: "state" }),
      ],
      [],
    );
    expect(out.nodes.find((n) => n.id === "Outer")!.zIndex).toBeUndefined();
    expect(out.nodes.find((n) => n.id === "Loose")!.zIndex).toBe(1);
  });

  it("keeps a stacking someone has already set", () => {
    const out = stacked([pool, node("Pinned", { zIndex: 7 })], []);
    expect(out.nodes[1].zIndex).toBe(7);
  });

  it("returns the very same arrays when there is no container", () => {
    const plain = [node("a"), node("b")];
    const lines = [edge("a", "b")];
    const out = stacked(plain, lines);
    expect(out.nodes).toBe(plain);
    expect(out.edges).toBe(lines);
  });
});
