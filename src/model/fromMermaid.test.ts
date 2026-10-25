import { describe, expect, it } from "vitest";
import { getMermaid, MAX_TEXT_SIZE } from "./fromMermaid";

describe("the mermaid every drawing goes through", () => {
  it("draws a diagram longer than mermaid's own 50,000 characters", async () => {
    // aks-baseline, imported from draw.io with its icons as data URIs, is
    // 57,000: the preview and export showed "Maximum text size in diagram
    // exceeded" in its place.
    const mermaid = await getMermaid();
    expect(mermaid.mermaidAPI.getConfig().maxTextSize).toBe(MAX_TEXT_SIZE);
    expect(MAX_TEXT_SIZE).toBeGreaterThan(1_000_000);
  });
});
