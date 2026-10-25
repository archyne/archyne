import { describe, expect, it } from "vitest";
import {
  dataUrlToBlob,
  previewOptions,
  DEFAULT_EXPORT_OPTIONS,
  FORMAT_INFO,
  type ExportOptions,
  wellFormedSvg,
} from "./export";

const withFormat = (format: ExportOptions["format"]): ExportOptions => ({
  ...DEFAULT_EXPORT_OPTIONS,
  format,
});

describe("what the preview renders", () => {
  it("leaves the raster and vector formats alone", () => {
    expect(previewOptions(withFormat("png")).format).toBe("png");
    expect(previewOptions(withFormat("svg")).format).toBe("svg");
  });

  it("previews a PDF as the image that will go on the page", () => {
    // Nothing displays a PDF in an <img>, and re-rendering for the download
    // would let the file differ from what was approved on screen.
    const opts = { ...withFormat("pdf"), page: "a4" as const, scale: 3 as const };
    expect(previewOptions(opts)).toEqual({ ...opts, format: "png" });
  });
});

describe("reading a data URL back", () => {
  it("decodes base64 to the original bytes", async () => {
    const blob = dataUrlToBlob("data:application/pdf;base64,JVBERi0=");
    expect(blob.type).toBe("application/pdf");
    expect(await blob.text()).toBe("%PDF-");
  });

  it("decodes the percent-encoded form the SVG export produces", async () => {
    const svg = "<svg><text>a & b</text></svg>";
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const blob = dataUrlToBlob(url);
    expect(blob.type).toBe("image/svg+xml");
    expect(await blob.text()).toBe(svg);
  });

  it("rejects anything that is not a data URL", () => {
    expect(() => dataUrlToBlob("https://example.com/x.png")).toThrow(/data URL/);
    expect(() => dataUrlToBlob("data:image/png;base64")).toThrow(/data URL/);
  });
});

describe("the formats on offer", () => {
  it("names a MIME type and extension for each", () => {
    for (const format of ["png", "svg", "pdf"] as const) {
      expect(FORMAT_INFO[format].extension).toBe(format);
      expect(FORMAT_INFO[format].mime).toMatch(/\//);
    }
  });
});

describe("mermaid's own drawing, exported", () => {
  it("is well-formed XML even with a label of two lines", () => {
    // What mermaid hands back for "Gateway<br/>(to On-premises)": a bare
    // <br> inside the label's HTML, which no XML reader accepts — so the PNG
    // could not be made and the .svg opened nowhere.
    const raw =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><foreignObject width="100" height="50">' +
      '<div xmlns="http://www.w3.org/1999/xhtml"><span><p>Gateway<br>(to On-premises)</p></span></div>' +
      "</foreignObject></svg>";
    const parse = (svg: string) =>
      new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("parsererror");
    expect(parse(raw)).not.toBeNull();
    const out = wellFormedSvg(raw);
    expect(parse(out)).toBeNull();
    expect(out).toContain("Gateway<br />(to On-premises)");
  });
});
