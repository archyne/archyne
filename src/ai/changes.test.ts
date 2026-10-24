import { describe, expect, it } from "vitest";
import { diagramChanges, hasChanges } from "./changes";

/**
 * What an answer changed, read off two real drawings the way the canvas
 * reads them.
 */

const BEFORE = `flowchart TD
  start([Start]) --> valid{Valid?}
  valid -->|yes| process[Process request]
  valid -->|no| error[Show error]
  process --> db[(Database)]`;

describe("what an answer changed", () => {
  it("names the nodes and connections it added, by their labels", async () => {
    const after = `${BEFORE}
  process --> cache[(Redis cache)]
  cache --> db`;
    const c = await diagramChanges(BEFORE, after);
    expect(c?.addedNodes).toEqual([{ id: "cache", label: "Redis cache" }]);
    expect(c?.addedEdges).toEqual([
      {
        source: "process",
        target: "cache",
        from: "Process request",
        to: "Redis cache",
        label: "",
      },
      { source: "cache", target: "db", from: "Redis cache", to: "Database", label: "" },
    ]);
    expect(c?.removedNodes).toEqual([]);
    expect(c?.removedEdges).toEqual([]);
  });

  it("tells a node it removed, and a connection it moved, from one it kept", async () => {
    const after = `flowchart TD
  start([Start]) --> valid{Valid?}
  valid -->|yes| process[Process request]
  process -->|no| error[Show error]`;
    const c = await diagramChanges(BEFORE, after);
    expect(c?.removedNodes).toEqual([{ id: "db", label: "Database" }]);
    expect(c?.removedEdges.map((e) => `${e.from}→${e.to}:${e.label}`)).toEqual([
      "Valid?→Show error:no",
      "Process request→Database:",
    ]);
    expect(c?.addedEdges.map((e) => `${e.from}→${e.to}:${e.label}`)).toEqual([
      "Process request→Show error:no",
    ]);
  });

  it("calls a new label on the same node a rename", async () => {
    const after = BEFORE.replace("[Show error]", "[Show the error page]");
    const c = await diagramChanges(BEFORE, after);
    expect(c?.renamedNodes).toEqual([
      { id: "error", label: "Show the error page", was: "Show error" },
    ]);
    expect(c?.addedNodes).toEqual([]);
  });

  it("finds nothing in a drawing that only moved or restyled", async () => {
    const after = `${BEFORE}
  style db fill:#f9f`;
    const c = await diagramChanges(BEFORE, after);
    expect(c && hasChanges(c)).toBe(false);
  });

  it("does not compare a drawing it cannot read, nor one of another kind", async () => {
    expect(await diagramChanges(BEFORE, "flowchart TD\n  a -->")).toBeNull();
    expect(await diagramChanges(BEFORE, "sequenceDiagram\n  A->>B: hi")).toBeNull();
  });
});
