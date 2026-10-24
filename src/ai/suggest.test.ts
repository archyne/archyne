import { describe, expect, it } from "vitest";
import type { AnyNode } from "../model/types";
import { suggestions } from "./suggest";

const node = (id: string, label: string, shape = "square", type = "shape") =>
  ({ id, type, position: { x: 0, y: 0 }, data: { label, shape } }) as unknown as AnyNode;

describe("what to ask when nothing has been asked", () => {
  it("names the diagram's own nodes, and only asks what fits them", () => {
    const flow = [
      node("start", "Start", "stadium"),
      node("valid", "Valid?", "diamond"),
      node("process", "Process request"),
      node("db", "Database", "cylinder"),
    ];
    expect(suggestions("flowchart", flow)).toEqual([
      { key: "ai.suggestCache", params: { node: "Database" } },
      { key: "ai.suggestRetry", params: { node: "Process request" } },
      { key: "ai.suggestOutcome", params: { node: "Valid?" } },
    ]);
    // A cache is not offered a cache.
    expect(
      suggestions("flowchart", [node("c", "Redis cache", "cylinder")]).map((s) => s.key),
    ).not.toContain("ai.suggestCache");
    // No database, no cache to put in front of one.
    expect(suggestions("flowchart", [node("a", "Charge card")]).map((s) => s.key)).toEqual([
      "ai.suggestRetry",
      "ai.suggestColour",
    ]);
  });

  it("leaves out groups, notes and labels too long to read in a button", () => {
    const nodes = [
      node("g", "Backend", undefined, "group"),
      node("n", "A note", undefined, "note"),
      node("x", "x".repeat(60)),
      node("a", "Pay"),
    ];
    expect(suggestions("flowchart", nodes)[0]).toEqual({
      key: "ai.suggestRetry",
      params: { node: "Pay" },
    });
  });

  it("offers diagrams to start from on an empty canvas, and plainer requests elsewhere", () => {
    expect(suggestions("flowchart", []).map((s) => s.key)).toEqual([
      "ai.suggestStartLogin",
      "ai.suggestStartShop",
      "ai.suggestStartOrder",
    ]);
    expect(suggestions("sequence", [node("a", "Client", undefined, "participant")])).toEqual([
      { key: "ai.suggestConnect", params: { node: "Client" } },
      { key: "ai.suggestRemove", params: { node: "Client" } },
    ]);
  });
});
