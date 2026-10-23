import { describe, expect, it } from "vitest";
import { associated, patternsFor } from "./association";

/** `workbench.editorAssociations`, read as VS Code reads it. */

describe("which files the person associated with the canvas", () => {
  it("finds this editor's patterns, in the current and in the older form", () => {
    expect(
      patternsFor({ "*.mmd": "archyne.editor", "*.md": "default" }, "archyne.editor"),
    ).toEqual(["*.mmd"]);
    expect(
      patternsFor(
        [
          { viewType: "archyne.editor", filenamePattern: "*.mermaid" },
          { viewType: "other", filenamePattern: "*.mmd" },
        ],
        "archyne.editor",
      ),
    ).toEqual(["*.mermaid"]);
    expect(patternsFor(undefined, "archyne.editor")).toEqual([]);
  });

  it("matches a pattern with no slash against the name, one with a slash against the path", () => {
    expect(associated("C:/work/flow.mmd", ["*.mmd"])).toBe(true);
    expect(associated("C:\\work\\Flow.MMD", ["*.mmd"])).toBe(true);
    expect(associated("C:/work/flow.md", ["*.mmd"])).toBe(false);
    expect(associated("/repo/docs/a.mmd", ["**/docs/*.mmd"])).toBe(true);
    expect(associated("/repo/src/a.mmd", ["**/docs/*.mmd"])).toBe(false);
    expect(associated("/repo/a.mermaid", ["*.{mmd,mermaid}"])).toBe(true);
    expect(associated("/repo/a+b.mmd", ["a+b.mmd"])).toBe(true);
  });
});
