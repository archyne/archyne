import { describe, expect, it } from "vitest";
import { iconCaption, iconPicture } from "./iconPicture";

describe("an icon put in a flowchart", () => {
  it("is named in words under it", () => {
    expect(iconCaption("azure:10061-icon-service-key-vaults")).toBe("Key vaults");
    expect(iconCaption("logos:aws-lambda")).toBe("Aws lambda");
    expect(iconCaption("database")).toBe("Database");
  });

  it("is its own SVG, carried in the file at its own proportions", async () => {
    const picture = await iconPicture("database");
    expect(picture.src.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = atob(picture.src.slice(picture.src.indexOf(",") + 1));
    expect(svg).toMatch(/^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(Math.max(picture.width, picture.height)).toBe(48);
  });
});
