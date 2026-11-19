/**
 * Making an SVG from outside safe to put on the page.
 *
 * Archyne renders an icon by writing its markup into the DOM, which is fine
 * for the five it draws itself and for the bundled collections — they are
 * part of the build and cannot change under it. An icon a user imports is
 * different: it is a file from the internet, and the vendors' official packs
 * are exactly the files people will bring.
 *
 * The application's own Content-Security-Policy already refuses inline
 * scripts and every remote origin, so an SVG cannot easily do harm here. That
 * is not a reason to insert one unread. The policy is one layer, and a
 * diagram travels — the same file is opened in the desktop build, exported,
 * and pasted into whatever else reads Mermaid.
 *
 * So: an allow-list, not a list of things to strip. Anything unrecognised is
 * dropped rather than reasoned about, because the elements an icon needs are
 * few and well known, and the ones an attack needs are the ones nobody
 * thought to forbid.
 */

/** Elements an icon is built from. Everything else is dropped. */
const ALLOWED_TAGS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "use",
  "title",
  "desc",
  "symbol",
  "pattern",
  "text",
  "tspan",
]);

/**
 * Attributes an icon is described by.
 *
 * `style` is not among them. Its value is a stylesheet, which is a second
 * language to have to be sure about, and everything an icon legitimately says
 * with it can be said with these instead.
 */
const ALLOWED_ATTRS = new Set([
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "stroke-miterlimit",
  "opacity",
  "transform",
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "points",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "spreadmethod",
  "patternunits",
  "clip-path",
  "mask",
  "id",
  "class",
  "xmlns",
  "preserveaspectratio",
  "text-anchor",
  "font-size",
  "font-family",
  "font-weight",
  "dominant-baseline",
]);

/**
 * A reference that stays inside the document.
 *
 * `href` is how `use`, `clip-path` and `mask` point at a definition, and it
 * is also how an SVG fetches something remote or runs a `javascript:` url. In
 * an icon it should never be anything but a fragment.
 */
function safeReference(value: string): boolean {
  return value.trim().startsWith("#");
}

/** A value that does not reach outside the document. */
function safeValue(value: string): boolean {
  const v = value.toLowerCase();
  if (v.includes("javascript:") || v.includes("data:text/html")) return false;
  // `url(#gradient)` is how a fill names a definition; anything else it can
  // name is somewhere else.
  const urls = [...v.matchAll(/url\(\s*['"]?([^'")]*)/g)].map((m) => m[1]);
  return urls.every((u) => u.trim().startsWith("#"));
}

/**
 * The icon, with everything not recognised taken out.
 *
 * Returns null when what is left is not an icon at all — no `svg` element, or
 * markup that did not parse — so a caller can say so rather than store an
 * empty string and wonder later.
 */
export function sanitiseSvg(source: string): string | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(source, "image/svg+xml");
  } catch {
    return null;
  }
  if (doc.getElementsByTagName("parsererror").length > 0) return null;

  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;

  const walk = (el: Element): void => {
    for (const child of [...el.children]) {
      if (!ALLOWED_TAGS.has(child.tagName.toLowerCase())) {
        child.remove();
        continue;
      }
      walk(child);
    }
    // A `style` attribute goes, like anything else that can carry more than
    // it shows — but what it says about how the shape is painted is kept, as
    // the attributes of the same names. Inkscape writes every colour there
    // (`style="fill:url(#a);stroke:none"`), and so do Microsoft's own Azure
    // icons: with the attribute simply dropped, each of them came out a
    // black silhouette. A declaration is kept only if it is one an attribute
    // may say, with a value an attribute may have.
    const style = el.getAttribute("style");
    if (style) {
      for (const declaration of style.split(";")) {
        const colon = declaration.indexOf(":");
        if (colon < 0) continue;
        const name = declaration.slice(0, colon).trim().toLowerCase();
        const value = declaration.slice(colon + 1).trim();
        if (!name || !value || name === "style" || name === "id" || name === "class") continue;
        if (name === "href" || !ALLOWED_ATTRS.has(name) || !safeValue(value)) continue;
        // What the style says wins over the attribute, as it does in a browser.
        el.setAttribute(name, value);
      }
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const isRef = name === "href" || name === "xlink:href";
      if (isRef) {
        if (!safeReference(attr.value)) el.removeAttribute(attr.name);
        continue;
      }
      if (!ALLOWED_ATTRS.has(name) || !safeValue(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  };
  walk(root);

  // An icon has to be scalable to be drawn at the size a node asks for, and
  // a fixed width and height in the file would fight that. The box stays —
  // and where the file had no box, one is made from the size before it goes,
  // because otherwise the icon is left with no dimensions at all.
  //
  // That was not a hypothetical: vendors ship plenty of icons with a width
  // and height and no `viewBox` (draw.io's Azure `Subnet.svg` is one). The
  // canvas still drew them, since a browser will scale anything, but mermaid
  // draws from icon *packs* and a pack entry needs numbers — so those icons,
  // and only those, came out as mermaid's "?" box in the preview beside a
  // canvas that had just drawn them correctly.
  if (!root.getAttribute("viewBox")) {
    const width = Number.parseFloat(root.getAttribute("width") ?? "");
    const height = Number.parseFloat(root.getAttribute("height") ?? "");
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      root.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }
  }
  root.removeAttribute("width");
  root.removeAttribute("height");
  return new XMLSerializer().serializeToString(root);
}

/**
 * An SVG taken apart the way an icon pack stores one: the markup inside the
 * root element, and the box it is drawn in.
 *
 * Needed because mermaid draws icons from *packs*, not from markup, so an
 * icon the user imported could not be handed to it as-is — which is why the
 * canvas showed imported icons and the preview showed mermaid's "?" box for
 * the same diagram.
 *
 * Returns null for anything without a usable box: a size guessed wrong draws
 * an icon at the wrong scale, which is worse than not drawing it.
 */
export function svgToIcon(svg: string): { body: string; width: number; height: number } | null {
  const open = /<svg\b([^>]*)>/i.exec(svg);
  if (!open) return null;

  const attrs = open[1];
  const body = svg.slice(open.index + open[0].length).replace(/<\/svg\s*>\s*$/i, "");
  if (!body.trim()) return null;

  const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
  const [, , boxW, boxH] = viewBox
    ? viewBox
        .trim()
        .split(/[\s,]+/)
        .map(Number)
    : [];
  // The sanitiser strips width and height from a stored icon, so the box is
  // usually all there is; a file that kept them is still read.
  const width = Number(boxW) || Number(/width\s*=\s*["']([\d.]+)/i.exec(attrs)?.[1]);
  const height = Number(boxH) || Number(/height\s*=\s*["']([\d.]+)/i.exec(attrs)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) return null;

  return { body: body.trim(), width: Math.round(width), height: Math.round(height) };
}
