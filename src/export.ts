import { toPng, toSvg } from "html-to-image";
import type { AnyNode } from "./model/types";
import { isGroup, type ClassDefs, type DiagramKind, type FlowEdge } from "./model/types";
import { measureNode } from "./measureNode";
import { stripPositions } from "./model/positions";
import { renderWithMermaid } from "./model/mermaidRender";
import { canRender } from "./render/renderSvg";
import { renderSvgWithIcons } from "./render/withIcons";
import type { PageSize, PdfImage } from "./pdf";

export interface ExportOptions {
  /** What to render: the canvas as-is, or mermaid's own renderer. */
  source: "canvas" | "mermaid";
  format: "png" | "svg" | "pdf";
  background: "dark" | "light" | "transparent";
  /** PNG pixel density; for PDF, how much detail goes on the page. */
  scale: 1 | 2 | 3;
  /** Margin around the diagram (canvas source only). */
  padding: number;
  /** mermaid theme (mermaid source only). */
  theme: "default" | "dark" | "neutral" | "forest" | "base";
  /** Paper to place the diagram on (PDF only). */
  page: PageSize;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  source: "canvas",
  format: "png",
  background: "dark",
  scale: 2,
  padding: 48,
  theme: "dark",
  page: "fit",
};

/** The MIME type and file extension each format is delivered as. */
export const FORMAT_INFO: Record<ExportOptions["format"], { mime: string; extension: string }> =
  {
    png: { mime: "image/png", extension: "png" },
    svg: { mime: "image/svg+xml", extension: "svg" },
    pdf: { mime: "application/pdf", extension: "pdf" },
  };

const BG: Record<ExportOptions["background"], string | undefined> = {
  dark: "#12141a",
  light: "#ffffff",
  transparent: undefined,
};

/* ---------- canvas source ---------- */

/**
 * Bounds of all nodes in absolute coordinates. Child positions are
 * parent-relative in our store, so walk the parent chain ourselves.
 */
function computeBounds(nodes: AnyNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const n of nodes) {
    let x = n.position.x;
    let y = n.position.y;
    let p = n.parentId;
    while (p) {
      const pn = byId.get(p);
      if (!pn) break;
      x += pn.position.x;
      y += pn.position.y;
      p = pn.parentId;
    }
    const est = measureNode(n);
    const w = n.measured?.width ?? (isGroup(n) ? Number(n.style?.width ?? 320) : est.width);
    const h = n.measured?.height ?? (isGroup(n) ? Number(n.style?.height ?? 220) : est.height);
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x + w);
    y2 = Math.max(y2, y + h);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function frameFor(nodes: AnyNode[], padding: number) {
  const bounds = computeBounds(nodes);
  const MAX = 4000;
  // 1:1 scale with a fixed pixel margin; only scale down if the diagram
  // would exceed the size cap.
  const zoom = Math.min(
    1,
    (MAX - padding * 2) / bounds.width,
    (MAX - padding * 2) / bounds.height,
  );
  return {
    width: Math.max(240, Math.ceil(bounds.width * zoom + padding * 2)),
    height: Math.max(160, Math.ceil(bounds.height * zoom + padding * 2)),
    viewport: { x: -bounds.x * zoom + padding, y: -bounds.y * zoom + padding, zoom },
  };
}

/**
 * Capture the React Flow viewport re-framed around the given transform.
 * Marker defs living outside the viewport are temporarily cloned in so
 * arrowheads survive the capture.
 */
/**
 * The stylesheet rules that paint SVG, gathered from the live document.
 *
 * html-to-image inlines each element's computed style, but only for HTML
 * elements — SVG children are cloned without one. It does not copy
 * stylesheets either, so a rule like `.shape-fill { fill: … }` simply
 * vanished from the export, and every node shape fell back to the SVG
 * default fill: **black**. Boxes came out solid black on any background.
 *
 * Rather than restate those rules here, where they would drift from the ones
 * that actually paint the app, this collects any rule that sets `fill`,
 * `stroke` or `stroke-width`. That is exactly the set html-to-image drops,
 * and it stays correct as the stylesheet changes.
 */
function svgPaintRules(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // A cross-origin stylesheet cannot be read. Ours is same-origin; a
      // browser extension's is not, and is not ours to export anyway.
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const s = rule.style;
      if (s.fill || s.stroke || s.strokeWidth) out.push(rule.cssText);
    }
  }
  return out.join("\n");
}

async function captureCanvas(
  format: "png" | "svg",
  width: number,
  height: number,
  viewport: { x: number; y: number; zoom: number },
  background: string | undefined,
  scale: number,
): Promise<string> {
  const el = document.querySelector<HTMLElement>(".react-flow__viewport");
  if (!el) return "";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const temp = document.createElementNS(SVG_NS, "svg");
  temp.setAttribute("width", "0");
  temp.setAttribute("height", "0");
  const defs = document.createElementNS(SVG_NS, "defs");
  document.querySelectorAll("marker").forEach((m) => defs.appendChild(m.cloneNode(true)));
  temp.appendChild(defs);
  el.appendChild(temp);

  // Carried inside the captured element so it is cloned along with it; the
  // custom properties it relies on are already inlined onto the ancestors.
  const paint = document.createElement("style");
  paint.textContent = svgPaintRules();
  el.appendChild(paint);

  try {
    const options = {
      ...(background ? { backgroundColor: background } : {}),
      width,
      height,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
      filter: (node: HTMLElement) =>
        !node.classList?.contains("react-flow__handle") &&
        !node.classList?.contains("react-flow__resize-control"),
      ...(format === "png" ? { pixelRatio: scale } : {}),
    };
    return format === "png" ? await toPng(el, options) : await toSvg(el, options);
  } finally {
    temp.remove();
    paint.remove();
  }
}

/* ---------- mermaid source ---------- */

/**
 * The SVG mermaid returns, as a document an image can be loaded from.
 *
 * mermaid builds its labels as HTML inside `<foreignObject>` and hands the
 * drawing back serialised as HTML: a label of two lines holds a bare `<br>`.
 * Put in the page that is fine; as a file, or as an `<img>` source on the way
 * to a PNG, it is XML, and one `<br>` with no end tag made the whole document
 * unreadable — "could not rasterize the mermaid SVG", and an .svg that
 * opened nowhere. Read as HTML and written out as XML, every element is
 * closed and the labels keep their XHTML namespace.
 */
export function wellFormedSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "text/html");
  const root = doc.querySelector("svg");
  if (!root) return svg;
  // The HTML reader keeps a label's `xmlns="…xhtml"` as a plain attribute as
  // well as putting the element in that namespace, and some serialisers then
  // write it twice — a duplicate attribute, unreadable again. The serialiser
  // declares the namespace itself.
  for (const el of root.querySelectorAll("[xmlns]")) {
    if (el.namespaceURI !== root.namespaceURI) el.removeAttribute("xmlns");
  }
  return new XMLSerializer().serializeToString(root);
}

function prepareSvg(svg: string, background: string | undefined) {
  let width = 800;
  let height = 600;
  const vb = svg.match(/viewBox="([\d.\s-]+)"/);
  if (vb) {
    const p = vb[1].trim().split(/\s+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) {
      width = Math.ceil(p[2]);
      height = Math.ceil(p[3]);
    }
  }
  const out = svg.replace(/<svg([^>]*)>/, (_m, attrs: string) => {
    const cleaned = attrs
      .replace(/\s(width|height)="[^"]*"/g, "")
      .replace(/\sstyle="[^"]*"/g, "");
    const bgStyle = background ? ` style="background:${background}"` : "";
    return `<svg${cleaned} width="${width}" height="${height}"${bgStyle}>`;
  });
  return { svg: out, width, height };
}

function svgToPng(
  svgText: string,
  width: number,
  height: number,
  scale: number,
  background: string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const ctx = canvas.getContext("2d")!;
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("could not rasterize the SVG"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  });
}

async function renderMermaid(opts: ExportOptions, code: string): Promise<string> {
  const src = `%%{init: {"theme": "${opts.theme}"}}%%\n${stripPositions(code)}`;
  const raw = (await renderWithMermaid(`export-${Date.now()}`, src)).svg;
  const { svg, width, height } = prepareSvg(wellFormedSvg(raw), BG[opts.background]);
  if (opts.format === "svg") {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  return svgToPng(svg, width, height, opts.scale, BG[opts.background]);
}

/* ---------- pdf source ---------- */

/**
 * Pull the pixels back out of a rendered PNG.
 *
 * The PDF is built from the very image the preview showed rather than from a
 * second capture, so what is downloaded cannot differ from what was on screen.
 */
function decodePng(dataUrl: string): Promise<PdfImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no 2d context to read the diagram back from"));
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const count = canvas.width * canvas.height;
      const rgb = new Uint8Array(count * 3);
      const alpha = new Uint8Array(count);
      let opaque = true;
      for (let i = 0; i < count; i++) {
        rgb[i * 3] = data[i * 4];
        rgb[i * 3 + 1] = data[i * 4 + 1];
        rgb[i * 3 + 2] = data[i * 4 + 2];
        alpha[i] = data[i * 4 + 3];
        if (alpha[i] !== 255) opaque = false;
      }
      // A soft mask doubles the object count and every reader has to blend
      // it; skip it entirely for the two backgrounds that are not see-through.
      resolve({
        rgb,
        width: canvas.width,
        height: canvas.height,
        ...(opaque ? {} : { alpha }),
      });
    };
    img.onerror = () => reject(new Error("could not read the rendered diagram back"));
    img.src = dataUrl;
  });
}

/**
 * The options to render a preview with: a PDF is a PNG on a page, so the
 * preview is that PNG and the page is applied on the way out.
 */
export function previewOptions(opts: ExportOptions): ExportOptions {
  return opts.format === "pdf" ? { ...opts, format: "png" } : opts;
}

/**
 * Wrap an already-rendered PNG data URL as a PDF data URL.
 *
 * The writer and the compressor it needs are fetched on demand: PDF is one
 * of three formats behind a dialog most sessions never open, and neither
 * belongs in the bundle everyone downloads.
 */
export async function pdfFromPng(pngDataUrl: string, opts: ExportOptions): Promise<string> {
  if (!pngDataUrl) return "";
  const [{ buildPdf, pdfDataUrl }, image] = await Promise.all([
    import("./pdf"),
    decodePng(pngDataUrl),
  ]);
  return pdfDataUrl(buildPdf(image, { page: opts.page, pixelRatio: opts.scale }));
}

/* ---------- public API ---------- */

/** Build the export as a data URL, per the given options. */
export async function buildExport(
  opts: ExportOptions,
  nodes: AnyNode[],
  code: string,
  graph?: { edges: FlowEdge[]; kind: DiagramKind; classDefs?: ClassDefs },
): Promise<string> {
  if (opts.format === "pdf") {
    return pdfFromPng(await buildExport(previewOptions(opts), nodes, code, graph), opts);
  }
  if (opts.source === "mermaid") return renderMermaid(opts, code);
  if (nodes.length === 0) return "";

  // A vector export goes through the renderer when the renderer can draw this
  // family. `captureCanvas` produces an SVG only in the loosest sense: it is
  // html-to-image's serialisation of the live DOM, which is one enormous
  // `<foreignObject>` full of HTML. That opens in a browser and nowhere else —
  // not in an `<img>`, not on GitHub, not in Inkscape, not in a PDF tool — so
  // the file people took away as "the vector one" was the least portable
  // artifact the app produced. `renderSvg` emits real geometry and real text.
  if (opts.format === "svg" && opts.source === "canvas" && graph && canRender(graph.kind)) {
    // The icon-resolving wrapper, because this path is already async and an
    // architecture diagram exported without its logos is a worse picture than
    // the capture it replaces.
    return svgDataUrl(
      await renderSvgWithIcons(nodes, graph.edges, graph.kind, {
        theme: opts.background === "light" ? "light" : "dark",
        padding: opts.padding,
        background: opts.background !== "transparent",
        // Without these every `class a,b hot` in the document is ignored and
        // the export comes back in the default palette.
        classDefs: graph.classDefs,
      }),
    );
  }

  const { width, height, viewport } = frameFor(nodes, opts.padding);
  return captureCanvas(opts.format, width, height, viewport, BG[opts.background], opts.scale);
}

/** An SVG string as the data URL every other export path here returns. */
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* ---------- clipboard ---------- */

/**
 * Turn a data URL into a blob without `fetch`.
 *
 * `fetch("data:…")` would be the one-liner, but the Content Security Policy
 * names the handful of hosts `connect-src` allows and `data:` is not among
 * them — and widening it for a clipboard convenience is not a trade worth
 * making. Both shapes the exports produce are handled: base64 for the raster
 * formats, percent-encoded text for SVG.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) throw new Error("not a data URL");
  const header = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  const mime = header.split(";")[0] || "application/octet-stream";

  if (header.endsWith(";base64")) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(payload)], { type: mime });
}

/**
 * Whether this browser can be handed an image. Firefox only gained
 * `ClipboardItem` in 127 and the desktop shell can be older still, so the
 * button is hidden rather than offered and then failing.
 */
export function canCopyImage(): boolean {
  return (
    typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function"
  );
}

/**
 * Put the export on the clipboard, ready to paste into a document.
 *
 * SVG goes across as its markup: pasted into an editor it is the source, and
 * the applications that accept vector from the clipboard read the text too.
 * Everything else goes as a PNG image — including PDF, which no application
 * accepts as pasted content, so the picture is what the user meant.
 */
export async function copyExport(dataUrl: string): Promise<void> {
  if (dataUrl.startsWith("data:image/svg+xml")) {
    await navigator.clipboard.writeText(await dataUrlToBlob(dataUrl).text());
    return;
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": dataUrlToBlob(dataUrl) })]);
}

export function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read the picture"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Carry the pictures a drawing links to inside it.
 *
 * An SVG drawn as an image may not fetch anything, so a picture it names by
 * URL — draw.io's Azure and AWS icons, which come from draw.io's repository —
 * was simply not drawn: the copy pasted into a slide had every caption and no
 * icon above any of them. Fetched here and written in as data, they are. One
 * that cannot be fetched (a host the page may not reach) is left as it was,
 * and is missing, as before, rather than failing the whole picture.
 */
async function inlinePictures(svg: string): Promise<string> {
  const linked = /<image href="(https?:[^"]+)" xlink:href="\1"/g;
  const urls = [...new Set([...svg.matchAll(linked)].map((m) => m[1]))];
  const data = new Map<string, string>();
  await Promise.all(
    urls.map(async (attr) => {
      try {
        const url = attr.replace(/&amp;/g, "&");
        const res = await fetch(url);
        if (!res.ok) return;
        let blob = await res.blob();
        // Served as text by some hosts — raw.githubusercontent.com among them —
        // and an image of type text/plain is not drawn.
        if (/\.svg(\?|$)/i.test(url) && blob.type !== "image/svg+xml") {
          blob = new Blob([blob], { type: "image/svg+xml" });
        }
        data.set(attr, await readDataUrl(blob));
      } catch {
        // Left linked, and so left out.
      }
    }),
  );
  return svg.replace(linked, (whole, attr: string) => {
    const inline = data.get(attr);
    return inline ? `<image href="${inline}" xlink:href="${inline}"` : whole;
  });
}

/**
 * Part of the diagram as a PNG, for the clipboard: what a copy on the canvas
 * hands to a slide or a document.
 *
 * Drawn by the renderer from the part alone, so whatever else lies inside its
 * frame stays out of the picture, as it would not in a capture of the canvas.
 * The capture is still the way for a family the renderer does not draw.
 *
 * With no ground of its own: pasted onto a slide or into a document, the
 * diagram sits on the page as drawn shapes do, rather than in a dark or white
 * block of the app's colour.
 */
export async function picturePng(
  nodes: AnyNode[],
  edges: FlowEdge[],
  kind: DiagramKind,
  theme: "dark" | "light",
  classDefs?: ClassDefs,
): Promise<{ dataUrl: string; width: number; height: number }> {
  if (canRender(kind) && kind !== "sequence") {
    const raw = await inlinePictures(
      await renderSvgWithIcons(nodes, edges, kind, {
        theme,
        padding: 16,
        background: false,
        classDefs,
      }),
    );
    const { svg, width, height } = prepareSvg(raw, BG.transparent);
    return { dataUrl: await svgToPng(svg, width, height, 2, BG.transparent), width, height };
  }
  const { width, height, viewport } = frameFor(nodes, 16);
  return {
    dataUrl: await captureCanvas("png", width, height, viewport, BG.transparent, 2),
    width,
    height,
  };
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

/** Test hook: canvas PNG with default options. */
export async function exportDataUrlForTest(nodes: AnyNode[]): Promise<string> {
  if (nodes.length === 0) return "";
  const { width, height, viewport } = frameFor(nodes, 48);
  return captureCanvas("png", width, height, viewport, BG.dark, 2);
}
