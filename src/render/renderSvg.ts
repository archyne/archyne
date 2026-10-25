/**
 * A diagram as a self-contained SVG string.
 *
 * This is the shape that makes Archyne importable. The editor can already be
 * embedded — an iframe and a `postMessage` protocol (`src/embed.ts`) — but an
 * application can only ever be *embedded*, and every Markdown preview that
 * draws diagrams bundles a library or shells out to a binary instead. Mermaid
 * is in all of them because it is those two things, not because of any plugin
 * protocol; none of those previews has a hook where another extension supplies
 * the renderer.
 *
 * So the output here is deliberately a *string* and not a DOM: geometry as real
 * `<rect>` and `<path>`, sizes worked out by `measureNode` rather than measured
 * afterwards by a browser, and the paint inlined as a `<style>` inside the
 * `<svg>` so the picture survives the page that made it. Cache it, put it in an
 * `<img>`, hand it to a PDF.
 *
 * ## What it does not do yet
 *
 * Every family Archyne edits: flowchart, state, ER, class, C4, architecture and
 * sequence. A kind it does not know is refused rather than half-drawn — see
 * `SUPPORTED`.
 *
 * Labels are real `<text>`, wrapped and positioned here from measured widths
 * and baselines. They were `<foreignObject>` first — Mermaid's own default —
 * until it became clear that the one route needing nobody's cooperation,
 * pre-rendering diagrams to `.svg` files beside a document, is exactly the route
 * where a foreignObject is not painted: `<img>`, GitHub, resvg, librsvg and
 * most PDF pipelines all drop it, leaving boxes with no words in them.
 */
import { labelLines } from "../model/label";
import { IMG_SIZE, labelSize } from "../model/types";
import { styleProps } from "../model/nodeStyle";
import {
  C4_TAGS,
  isGroup,
  type AnyNode,
  type DiagramKind,
  type ClassDefs,
  type FlowEdge,
  type SeqItem,
  type ShapeNodeData,
} from "../model/types";
import { absoluteBoxes } from "../boxes";
import { allLabels, LABEL_PAD, plateSize } from "../labels";
import { allRoutes } from "../routes";
import { roundedPolyline, type Point } from "../routing";
import {
  NODE_FONT,
  measureBlock,
  textMetrics,
  wrapText,
  type FontSpec,
  type TextMetrics,
} from "../textMetrics";
import {
  ACTOR_GLYPH_BOX,
  ARCH_ICON,
  BORDER_WIDTH as BOX_MODEL_BORDER,
  BOXES,
  COMPACT_SHAPE,
  SLIM_LABEL_PAD_X,
  C4_COLOURS,
  C4_HEAD,
  FONTS,
  TABLE_ROWS,
  GROUP_TITLE,
  PALETTE,
  type PaletteName,
  SERVICE_LABEL_MAX,
  TABLE_TITLE,
  face,
} from "./boxModel";
import { ACTOR_PATH } from "./actorPath";
import { markerDefs } from "./markers";
import { blockFrames, messageRows, sequenceGeometry } from "./sequence";
import { pointsAttr, shapeGeometry } from "./shapes";

/**
 * The families that have a drawing here.
 *
 * All seven. The two that arrived last did so for reasons rather than for want
 * of typing, and both are settled: an architecture service is an icon, and
 * icons now come in resolved through `RenderOptions.icons` so the emitter stays
 * pure and sync; a sequence diagram is not routed at all, and has its own
 * geometry in `render/sequence.ts`.
 *
 * The guard stays for a kind this build does not know — Mermaid grows families,
 * and one parsed but not drawn should say so rather than come back empty.
 */
const SUPPORTED = new Set<DiagramKind>([
  "sequence",
  "flowchart",
  "state",
  "er",
  "class",
  "c4",
  "architecture",
]);

/** Whether this family has a drawing here, for callers deciding a route. */
export function canRender(kind: DiagramKind): boolean {
  return SUPPORTED.has(kind);
}

/** Thrown for a diagram family this cannot draw yet. */
export class UnsupportedFamilyError extends Error {
  constructor(readonly kind: DiagramKind) {
    super(`renderSvg draws ${[...SUPPORTED].join(", ")}; "${kind}" is not implemented yet`);
    this.name = "UnsupportedFamilyError";
  }
}

export interface RenderOptions {
  /** Which palette to paint with. Defaults to dark, as the app does. */
  theme?: PaletteName;
  /** Space around the diagram, in px. */
  padding?: number;
  /** Paint the ground, or leave it transparent for the page underneath. */
  background?: boolean;
  /**
   * `classDef` definitions, which a flowchart uses to colour a *set* of nodes.
   *
   * Without them every `class a,b hot` in a document is silently ignored and
   * the export comes back in the default palette — which is what it did.
   * `parseDiagram` returns them; `render()` passes them on.
   */
  classDefs?: ClassDefs;
  /**
   * The ordered statement stream a sequence diagram is made of.
   *
   * Its rows *are* its layout — a message, a note, a block, a divider, each at
   * its position in the stream — so without this a sequence diagram has
   * participants and nothing else. `parseDiagram` returns it as `items`.
   */
  seqItems?: SeqItem[];
  /**
   * Icon markup by name, for the families that draw one.
   *
   * Resolving an icon is asynchronous — `getIconHtml` lazy-loads an Iconify
   * collection — and making the whole renderer async for that would put an
   * `await` in front of every caller for the sake of one family. So the caller
   * resolves them and this stays a pure function of its inputs.
   * `renderSvgWithIcons` in `./withIcons.ts` does the resolving for callers who
   * would rather not.
   *
   * **The markup is inserted verbatim.** Anything from outside this repository
   * must go through `sanitiseSvg` (`model/svg.ts`) first, which is what the
   * editor does with an imported icon pack.
   */
  icons?: Record<string, string>;
}

/**
 * Text going into markup.
 *
 * Every label here is untrusted: it arrives from a `?code=` link, from the
 * embed bridge, or from a file somebody opened. The output is a string nobody
 * will parse again before putting it on a page, so this is the only thing
 * standing between a diagram and script in whatever document embeds it.
 * Applied to *all* text and *all* attribute values, without exception, rather
 * than to the ones that look dangerous.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Numbers, short enough to read and precise enough to draw. */
function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * The colours and type a node is drawn with, from both places they come from.
 *
 * A diagram states them twice over: `style a fill:#f9f` names one node, and
 * `classDef hot fill:#c04` with `class a,b hot` names a set. The canvas
 * resolves the two together, class first so an inline style wins — and this did
 * not, which meant every `classDef` colour was dropped from an export. The
 * order here is `ShapeNode`'s, deliberately.
 */
function drawnStyle(node: AnyNode, classDefs: ClassDefs) {
  const data = node.data as { classes?: string[]; styles?: string[] };
  return styleProps([
    ...(data.classes ?? []).flatMap((c) => classDefs[c] ?? []),
    ...(data.styles ?? []),
  ]);
}

/**
 * A node's own colours, as an **inline style** rather than as attributes.
 *
 * This matters and is easy to get wrong: the document carries a `<style>` block
 * with `.sf { fill: … }`, and in SVG a CSS rule beats a presentation attribute.
 * So `fill="#ff8800"` on the element was in the file, visible to anyone reading
 * it, and painted nothing — the class won. An inline `style` beats the class,
 * which is what the canvas does too (`boxStyleOf` returns React inline styles).
 */
function paintAttrs(s: ReturnType<typeof drawnStyle>, part: "fill" | "line" = "fill"): string {
  const decls = [
    // A detail line — a subroutine's bars, a cylinder's rim — takes the custom
    // *stroke* but never the fill, which would blot it out. That is what
    // `.shape-line { stroke: var(--custom-stroke, …) }` does on the canvas, and
    // keeping only the theme colour here left a purple rim on a green cylinder.
    ...(part === "fill" && s.fill ? [`fill:${s.fill}`] : []),
    ...(s.stroke ? [`stroke:${s.stroke}`] : []),
  ];
  return decls.length ? ` style="${esc(decls.join(";"))}"` : "";
}

/**
 * The label's own face and colour.
 *
 * `fill` on a `<tspan>` rather than a class, because a node's `color:` is the
 * one paint that cannot come from the stylesheet — it is written in the
 * diagram.
 */
function labelFace(s: ReturnType<typeof drawnStyle>, base: FontSpec) {
  const size = s.fontSize ? Number.parseFloat(s.fontSize) : base.size;
  const font: FontSpec = {
    family: base.family,
    size: Number.isFinite(size) ? size : base.size,
    ...(s.fontWeight ? { weight: s.fontWeight } : base.weight ? { weight: base.weight } : {}),
  };
  // Inline for the same reason the box's paint is: `.t { fill: … }` in the
  // document's own stylesheet would otherwise win over a `fill` attribute.
  const decls = [
    ...(s.color ? [`fill:${s.color}`] : []),
    ...(s.fontStyle ? [`font-style:${s.fontStyle}`] : []),
  ];
  const attrs = decls.length ? ` style="${esc(decls.join(";"))}"` : "";
  return { font, attrs };
}

/** One shape's primitives, as elements. */
function shapeMarkup(node: AnyNode, w: number, h: number, classDefs: ClassDefs): string {
  if (node.type !== "shape") return "";
  const custom = drawnStyle(node, classDefs);
  const bodyPaint = paintAttrs(custom, "fill");
  const linePaint = paintAttrs(custom, "line");

  return shapeGeometry(node.data.shape, w, h)
    .map((p) => {
      // The body takes the node's own colours if it has any; detail drawn over
      // it keeps the theme's, so a custom fill cannot swallow a subroutine's
      // bars or a cylinder's rim.
      const cls = p.paint === "fill" ? "sf" : "sl";
      const own = p.paint === "fill" ? bodyPaint : linePaint;
      switch (p.kind) {
        case "rect":
          return `<rect class="${cls}" x="${n(p.x)}" y="${n(p.y)}" width="${n(p.width)}" height="${n(p.height)}"${p.rx !== undefined ? ` rx="${n(p.rx)}"` : ""}${own}/>`;
        case "ellipse":
          return `<ellipse class="${cls}" cx="${n(p.cx)}" cy="${n(p.cy)}" rx="${n(p.rx)}" ry="${n(p.ry)}"${own}/>`;
        case "polygon":
          return `<polygon class="${cls}" points="${pointsAttr(p.points)}"${own}/>`;
        case "path":
          return `<path class="${cls}" d="${p.d}"${own}/>`;
        case "line":
          return `<line class="${cls}" x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}"${own}/>`;
      }
    })
    .join("");
}

/**
 * A run of text drawn as real SVG, laid out here rather than by a browser.
 *
 * This replaced `<foreignObject>`, and the reason is the whole point of the
 * renderer. An SVG loaded through `<img>`, rendered by resvg or librsvg, put
 * into a PDF, or shown by GitHub is drawn in a mode where a foreignObject's
 * HTML is simply **not painted**: the boxes appear and the words do not. So the
 * route that needs no cooperation from anybody — pre-render the diagrams to
 * `.svg` files beside the document — produced pictures with no text in them.
 * Mermaid's default output has the same hole; it is not a reason to keep it.
 *
 * The cost is that line breaking and vertical placement are arithmetic here
 * instead of a browser's job. `wrapText` does the first from measured widths,
 * and `ascent` does the second: SVG positions text by its **baseline**, and
 * `dominant-baseline` — the attribute that would spare us the sums — is exactly
 * the kind of thing the non-browser renderers this exists for implement
 * unevenly. So every baseline is computed and written out.
 */
interface TextBlock {
  text: string;
  font: FontSpec;
  /** Where the text sits inside `width`. */
  align: "start" | "middle";
  /** Extra attributes, for the odd line that is bold or dimmed. */
  attrs?: string;
}

/**
 * Lay `blocks` out one under another inside a box, and draw them.
 *
 * `top` is where the first line box begins; `place` says whether the stack
 * hangs from there or is centred on the whole height.
 */
function textStack(
  blocks: TextBlock[],
  opts: {
    x: number;
    width: number;
    top: number;
    height?: number;
    place?: "hang" | "centre";
    metrics?: TextMetrics;
  },
): string {
  const metrics = opts.metrics ?? textMetrics();
  type Line = { text: string; font: FontSpec; attrs: string; h: number; ascent: number };
  const lines: Line[] = [];

  for (const block of blocks) {
    for (const raw of labelLines(block.text)) {
      for (const line of wrapText(raw, block.font, opts.width, metrics)) {
        const size = metrics.measure(line, block.font);
        lines.push({
          text: line,
          font: block.font,
          attrs: block.attrs ?? "",
          h: size.height,
          ascent: size.ascent,
        });
      }
    }
  }
  if (lines.length === 0) return "";

  const total = lines.reduce((sum, l) => sum + l.h, 0);
  let y =
    opts.place === "centre" && opts.height !== undefined
      ? opts.top + (opts.height - total) / 2
      : opts.top;

  const anchor = blocks[0].align === "middle" ? "middle" : "start";
  const x = blocks[0].align === "middle" ? opts.x + opts.width / 2 : opts.x;

  const spans = lines
    .map((l) => {
      const baseline = y + l.ascent;
      y += l.h;
      const weight = l.font.weight ? ` font-weight="${l.font.weight}"` : "";
      return (
        `<tspan x="${n(x)}" y="${n(baseline)}" font-size="${n(l.font.size)}"` +
        ` font-family="${esc(l.font.family)}"${weight}${l.attrs}>${esc(l.text)}</tspan>`
      );
    })
    .join("");

  return `<text class="t" text-anchor="${anchor}">${spans}</text>`;
}

/**
 * A flowchart shape's label, centred in the box the shape occupies.
 *
 * The node does not grow around it — `measureNode` explains why — so a label
 * too long for its box wraps and then simply runs past it, exactly as the
 * canvas clips it. Wrapping at the box's inner width is what keeps the common
 * case looking right.
 */
function shapeLabel(node: AnyNode, w: number, h: number, classDefs: ClassDefs): string {
  const data = node.data as ShapeNodeData;
  const custom = drawnStyle(node, classDefs);
  const { font, attrs } = labelFace(custom, face(labelSize(data.styles)));
  // Neither fill nor stroke: no box to draw, nor to fit the words into.
  const unboxed = (v?: string) => v === "none" || v === "transparent";
  const boxless = unboxed(custom.fill) && unboxed(custom.stroke);
  if (data.img) {
    return pictureLabel(data, w, h, font, attrs, boxless, node.style?.width == null);
  }
  // Words with no box round them, and a box too small for the usual padding,
  // keep 2px a side, as `.text-only` and `.compact` give them on the canvas.
  // With the full padding an imported caption — "Azure Firewall" in a box
  // drawn just wide enough for it — broke onto a third line and climbed up
  // over the icon above it.
  const slim =
    boxless ||
    (node.style?.width != null && (w < COMPACT_SHAPE.width || h < COMPACT_SHAPE.height));
  const padX = slim ? SLIM_LABEL_PAD_X : BOXES.shape.padX;
  return textStack([{ text: data.label, font, align: "middle", attrs }], {
    x: padX / 2,
    width: w - padX,
    top: 0,
    height: h,
    place: "centre",
  });
}

/**
 * Mermaid's image shape: the picture, and the name above or below it.
 *
 * Laid out as `.shape-label.with-image` lays it out on the canvas — a column
 * centred in the box, 6px 8px of padding, 4px between picture and name, the
 * picture at its own size unless the box is too small for it, and then fitted
 * inside keeping its proportions. Without this every picture was missing from
 * the SVG export and from a copy pasted into a slide: an imported cloud
 * diagram came out as its captions with nothing above them.
 */
function pictureLabel(
  data: ShapeNodeData,
  w: number,
  h: number,
  font: FontSpec,
  attrs: string,
  bare: boolean,
  unsized: boolean,
): string {
  const PAD_X = 8;
  const PAD_Y = 6;
  const GAP = 4;
  const metrics = textMetrics();
  const inner = { width: w - PAD_X * 2, height: h - PAD_Y * 2 };
  // A bare picture nobody sized is as wide as its widest line, so on the
  // canvas its words break only where the label breaks them. Wrapped at the
  // box instead, a line measured here a fraction wider than the browser made
  // it broke in two — "Azure / Container / Registry" — and ran out of the box.
  const widest = Math.max(
    0,
    ...labelLines(data.label).map((line) => metrics.measure(line, font).width),
  );
  const wrapAt = bare && unsized ? Math.max(inner.width, widest) : inner.width;
  let words = 0;
  for (const raw of labelLines(data.label)) {
    for (const line of wrapText(raw, font, wrapAt, metrics)) {
      words += metrics.measure(line, font).height;
    }
  }
  const gap = words > 0 ? GAP : 0;
  const pw = Math.max(0, Math.min(data.imgWidth ?? IMG_SIZE, inner.width));
  // In a frame the column is the frame's height and the picture gives way to
  // the words; with none (`.bare`) it keeps its height and the column runs
  // past the box, centred on it, as it does on the canvas.
  const ph = bare
    ? (data.imgHeight ?? IMG_SIZE)
    : Math.max(0, Math.min(data.imgHeight ?? IMG_SIZE, inner.height - words - gap));
  const top = PAD_Y + (inner.height - (ph + gap + words)) / 2;
  const above = data.imgPos === "t";
  const imageTop = above ? top + words + gap : top;
  const wordsTop = above ? top : top + ph + gap;
  const href = esc(data.img ?? "");
  const image =
    pw > 0 && ph > 0
      ? `<image href="${href}" xlink:href="${href}" x="${n((w - pw) / 2)}" y="${n(imageTop)}" ` +
        `width="${n(pw)}" height="${n(ph)}" preserveAspectRatio="xMidYMid meet"/>`
      : "";
  return (
    image +
    textStack([{ text: data.label, font, align: "middle", attrs }], {
      x: (w - wrapAt) / 2,
      width: wrapAt,
      top: wordsTop,
      place: "hang",
    })
  );
}

/** A state: a rounded box with its name, or one of the markers that carry none. */
function stateMarkup(
  node: AnyNode,
  w: number,
  h: number,
  text: string,
  classDefs: ClassDefs,
): string {
  if (node.type !== "state") return "";
  const custom = drawnStyle(node, classDefs);
  const t = node.data.stateType;
  if (t === "choice") {
    // `.choice-state` is a square turned 45°, which is a diamond drawn plainly.
    return `<polygon class="sf" points="${pointsAttr([
      [w / 2, 1],
      [w - 1, h / 2],
      [w / 2, h - 1],
      [1, h / 2],
    ])}"/>`;
  }
  if (t === "fork" || t === "join") {
    return `<rect class="bar" x="0" y="0" width="${n(w)}" height="${n(h)}" rx="3"/>`;
  }
  if (t !== "normal") {
    // Start is a filled disc; end is a ring with one inside it.
    const r = w / 2 - 1;
    if (t === "start")
      return `<circle class="bar" cx="${n(w / 2)}" cy="${n(h / 2)}" r="${n(r)}"/>`;
    return (
      `<circle class="ring" cx="${n(w / 2)}" cy="${n(h / 2)}" r="${n(r - 1)}"/>` +
      `<circle class="bar" cx="${n(w / 2)}" cy="${n(h / 2)}" r="7"/>`
    );
  }
  const pad = BOXES.state;
  const face_ = labelFace(custom, FONTS.state);
  return (
    `<rect class="sf" x="0.75" y="0.75" width="${n(w - 1.5)}" height="${n(h - 1.5)}" rx="10"${paintAttrs(custom)}/>` +
    textStack([{ text, font: face_.font, align: "middle", attrs: face_.attrs }], {
      x: pad.padX / 2,
      width: w - pad.padX,
      top: 0,
      height: h,
      place: "centre",
    })
  );
}

/**
 * The title band and rows shared by an ER entity and a class.
 *
 * The vertical arithmetic is `measureNode`'s, run forwards: it worked out the
 * height from a title band, a rule, and rows of a known step, so the text goes
 * back at those same offsets. Both read the offsets from `render/boxModel.ts`,
 * which is generated from the stylesheet — so the drawing and the measurement
 * cannot disagree about where row three begins.
 */
function tableMarkup(
  w: number,
  h: number,
  title: TextBlock[],
  groups: TextBlock[][],
  paint = "",
): string {
  const metrics = textMetrics();
  const parts = [
    `<rect class="sf" x="0.75" y="0.75" width="${n(w - 1.5)}" height="${n(h - 1.5)}" rx="8"${paint}/>`,
  ];

  // The title band, centred across the node, with its own padding above it.
  let y = TABLE_TITLE.padY / 2;
  const titleWidth = w - TABLE_TITLE.padX - BOXES.table.border;
  parts.push(textStack(title, { x: (w - titleWidth) / 2, width: titleWidth, top: y, metrics }));
  for (const block of title) {
    for (const line of wrapText(block.text, block.font, titleWidth, metrics)) {
      y += metrics.measure(line, block.font).height;
    }
  }
  y += TABLE_TITLE.padY / 2;

  // The rule under it, then each group of rows.
  parts.push(`<line class="rule" x1="0" y1="${n(y)}" x2="${n(w)}" y2="${n(y)}"/>`);
  y += TABLE_TITLE.rule;

  const rowX = TABLE_ROWS.rowPadX / 2;
  const rowWidth = w - TABLE_ROWS.rowPadX - BOXES.table.border;
  for (const group of groups) {
    y += TABLE_ROWS.padY / 2;
    for (const rowBlock of group) {
      const size = metrics.measure(rowBlock.text, rowBlock.font);
      parts.push(
        textStack([rowBlock], {
          x: rowX,
          width: rowWidth,
          top: y + TABLE_ROWS.rowPadY / 2,
          metrics,
        }),
      );
      y += size.height + TABLE_ROWS.rowPadY;
    }
    y += TABLE_ROWS.padY / 2;
  }

  return parts.join("");
}

/**
 * An icon, placed at a size, from markup the caller resolved.
 *
 * A nested `<svg>` is the right primitive: it carries its own `viewBox`, so
 * giving it `x`, `y`, `width` and `height` scales the drawing into that box
 * without anybody parsing the paths. Any `width`/`height` the pack shipped is
 * dropped first — Iconify writes `1em`, which would otherwise win.
 */
function iconMarkup(markup: string, x: number, y: number, size: number): string {
  const opening = markup.match(/^\s*<svg\b[^>]*>/i);
  if (!opening) return "";
  const attrs = opening[0]
    .replace(/^\s*<svg/i, "")
    .replace(/>$/, "")
    .replace(/\s(width|height|x|y)\s*=\s*"[^"]*"/gi, "");
  const rest = markup.slice(opening[0].length);
  return `<svg${attrs} x="${n(x)}" y="${n(y)}" width="${n(size)}" height="${n(size)}">${rest}`;
}

/**
 * An architecture service: an icon with its name under it.
 *
 * The icon is not required. A service whose icon the caller did not resolve —
 * or did not have — still draws as a box with a name in it, because a diagram
 * missing one logo is a diagram, and a diagram missing every node is not.
 */
function serviceMarkup(
  node: AnyNode,
  w: number,
  h: number,
  icons: Record<string, string>,
): string {
  if (node.type !== "service") return "";
  const box = BOXES.service;
  const bare = node.data.style?.look === "icon";
  const frame = bare
    ? ""
    : `<rect class="sf" x="0.75" y="0.75" width="${n(w - 1.5)}" height="${n(h - 1.5)}" rx="10"/>`;

  const markup = node.data.icon ? icons[node.data.icon] : undefined;
  const iconSize = Math.min(ARCH_ICON, w - box.padX, h - box.padY);
  const icon = markup ? iconMarkup(markup, (w - iconSize) / 2, box.padY / 2, iconSize) : "";

  const label = textStack([{ text: node.data.label, font: FONTS.service, align: "middle" }], {
    x: box.padX / 2,
    width: Math.min(SERVICE_LABEL_MAX, w - box.padX),
    top: box.padY / 2 + (markup ? iconSize + box.gap : 0),
  });
  return frame + icon + label;
}

/** A C4 element: the tag, the name, and a description under them. */
function c4Markup(node: AnyNode, w: number, h: number): string {
  if (node.type !== "c4") return "";
  const tag = C4_TAGS[node.data.c4Shape] ?? node.data.c4Shape;
  const person = node.data.c4Shape.includes("person");
  const box = BOXES.c4;
  const blocks: TextBlock[] = [
    { text: `«${tag}»`, font: FONTS.c4Tag, align: "middle", attrs: ' opacity="0.75"' },
    { text: node.data.label, font: FONTS.c4Label, align: "middle" },
  ];
  if (node.data.descr) {
    blocks.push({
      text: node.data.descr,
      font: FONTS.c4Descr,
      align: "middle",
      attrs: ' opacity="0.85"',
    });
  }
  // `.c4-head` is only drawn for a person, and the text starts under it.
  const head = person
    ? `<circle class="c4-head" cx="${n(w / 2)}" cy="${n(box.padY / 2 + 13)}" r="13"/>`
    : "";
  return (
    `<rect class="c4" x="0.75" y="0.75" width="${n(w - 1.5)}" height="${n(h - 1.5)}" rx="8"/>` +
    head +
    textStack(blocks, {
      // Centred on the node itself. Wrapping uses the content width, which the
      // border shrinks, but the *centre* of a border-box is still its middle —
      // taking the border off one side only pulled every centred label 1.5px
      // to the left.
      x: (w - (w - box.padX - box.border)) / 2,
      width: w - box.padX - box.border,
      top: box.padY / 2 + (person ? C4_HEAD : 0),
    })
  );
}

/**
 * Whatever this node is, drawn in its own frame.
 *
 * One place that knows the families, so adding the next one is a case here
 * rather than a condition threaded through the caller.
 */
function nodeInner(
  node: AnyNode,
  w: number,
  h: number,
  icons: Record<string, string>,
  classDefs: ClassDefs,
): string {
  if (isGroup(node)) return groupMarkup(node, w, h, drawnStyle(node, classDefs));
  // Every box-shaped family takes the colours the diagram gives it, from a
  // `style` statement or from a `classDef` the node is a member of.
  const custom = drawnStyle(node, classDefs);
  const paint = paintAttrs(custom);
  switch (node.type) {
    case "shape":
      return shapeMarkup(node, w, h, classDefs) + shapeLabel(node, w, h, classDefs);
    case "state":
      return stateMarkup(node, w, h, node.data.label, classDefs);
    case "entity": {
      const title = labelFace(custom, FONTS.tableTitle);
      const row = labelFace(custom, FONTS.table);
      return tableMarkup(
        w,
        h,
        [{ text: node.data.label, font: title.font, align: "middle", attrs: title.attrs }],
        [
          node.data.attributes.map((a) => ({
            // One run per row: the type column, the name and the keys read as
            // one line, and splitting them into three anchored spans would put
            // the renderer in the business of laying out a flex row.
            text: [a.type, a.name, a.keys.join(",")].filter(Boolean).join("  "),
            font: row.font,
            align: "start" as const,
            attrs: row.attrs,
          })),
        ],
        paint,
      );
    }
    case "class": {
      const name = node.data.generic
        ? `${node.data.label}<${node.data.generic}>`
        : node.data.label;
      const heading = labelFace(custom, FONTS.tableTitle);
      const title: TextBlock[] = [
        ...node.data.annotations.map((a) => ({
          text: `«${a}»`,
          font: FONTS.annotation,
          align: "middle" as const,
          attrs: ' opacity="0.7"',
        })),
        { text: name, font: heading.font, align: "middle" as const, attrs: heading.attrs },
      ];
      const groups = [node.data.members, node.data.methods]
        .filter((g) => g.length > 0)
        .map((g) =>
          g.map((m) => ({
            text: m,
            font: FONTS.mono,
            align: "start" as const,
            attrs: custom.color ? ` style="${esc(`fill:${custom.color}`)}"` : "",
          })),
        );
      return tableMarkup(w, h, title, groups, paint);
    }
    case "participant": {
      // The head only. Its lifeline belongs to the diagram rather than to the
      // node — its length is how many rows there are — so `sequenceMarkup`
      // draws it, which is also why `measureNode` answers for the head alone.
      const head = labelFace(custom, FONTS.state);
      const glyph = node.data.ptype === "actor" ? ACTOR_GLYPH_MARKUP(h) : "";
      return (
        `<rect class="sf" x="0.75" y="0.75" width="${n(w - 1.5)}" height="${n(h - 1.5)}" rx="10"${paint}/>` +
        glyph +
        textStack(
          [{ text: node.data.label, font: head.font, align: "middle", attrs: head.attrs }],
          {
            x: node.data.ptype === "actor" ? ACTOR_GLYPH_BOX.width + TABLE_ROWS.gap : 0,
            width:
              w - (node.data.ptype === "actor" ? ACTOR_GLYPH_BOX.width + TABLE_ROWS.gap : 0),
            top: 0,
            height: h,
            place: "centre",
          },
        )
      );
    }
    case "service":
      return serviceMarkup(node, w, h, icons);
    case "junction":
      // A dot. `.junction-node` is a filled disc with no content at all.
      return `<circle class="bar" cx="${n(w / 2)}" cy="${n(h / 2)}" r="${n(w / 2 - 1)}"/>`;
    case "c4":
      return c4Markup(node, w, h);
    default:
      // A family with no drawing yet. Reached only if `SUPPORTED` lets its
      // diagram through, so it is a bug in that list rather than in the data.
      return "";
  }
}

/**
 * The stick figure marking a sequence actor.
 *
 * The path is `ActorGlyph`'s, shared rather than redrawn — the palette entry,
 * the canvas and this all trace the same figure, which is the point of it being
 * a constant.
 */
function ACTOR_GLYPH_MARKUP(h: number): string {
  const x = BOXES.participant.padX / 2 - 2;
  const y = (h - ACTOR_GLYPH_BOX.height) / 2;
  return (
    `<svg x="${n(x)}" y="${n(y)}" width="${ACTOR_GLYPH_BOX.width}" height="${ACTOR_GLYPH_BOX.height}" viewBox="15 1 18 22">` +
    `<path class="glyph" d="${ACTOR_PATH}" fill="none" stroke-width="1.6" stroke-linecap="round"/></svg>`
  );
}

/**
 * A group's frame and its title, which sits above the children. Given
 * colours, the frame is solid unless given a dash as well — as on the canvas
 * (`.group-node.painted`) and as mermaid draws a styled subgraph.
 */
function groupMarkup(
  node: AnyNode,
  w: number,
  h: number,
  custom: ReturnType<typeof drawnStyle>,
): string {
  const title = isGroup(node) ? node.data.label : "";
  const decls = [
    ...(custom.fill ? [`fill:${custom.fill}`] : []),
    ...(custom.stroke ? [`stroke:${custom.stroke}`] : []),
    ...(custom.fill || custom.stroke
      ? [`stroke-dasharray:${custom.strokeDasharray ?? "none"}`]
      : []),
  ];
  const paint = decls.length ? ` style="${esc(decls.join(";"))}"` : "";
  const frame = `<rect class="gf" x="0.75" y="0.75" width="${n(w - 1.5)}" height="${n(h - 1.5)}" rx="10"${paint}/>`;
  if (!title) return frame;
  const { font, attrs } = labelFace(custom, FONTS.groupTitle);
  return (
    frame +
    textStack([{ text: title, font, align: "start", attrs }], {
      x: GROUP_TITLE.padX / 2,
      width: w - GROUP_TITLE.padX,
      top: GROUP_TITLE.padY / 2,
    })
  );
}

/**
 * An edge's label, on a plate so the line does not read through it.
 *
 * The plate is the one `labels.ts` reserved when it decided where the label
 * could go, down to the padding: a label placed clear of a box and then drawn
 * wider than the space claimed for it is back to overlapping the box.
 */
function edgeLabelMarkup(text: string, at: { x: number; y: number }): string {
  if (!text) return "";
  const { w, h } = plateSize(text);
  const lines = labelLines(text);
  // One line per `<br>`, stacked about the middle of the plate.
  const step = (h - LABEL_PAD.y * 2) / lines.length;
  const body =
    lines.length === 1
      ? esc(text)
      : lines
          .map(
            (line, i) =>
              `<tspan x="${n(w / 2)}"${i ? ` dy="${n(step)}"` : ""}>${esc(line)}</tspan>`,
          )
          .join("");
  const y = h / 2 - ((lines.length - 1) * step) / 2;
  return (
    `<g transform="translate(${n(at.x - w / 2)},${n(at.y - h / 2)})">` +
    `<rect class="el-bg" x="0" y="0" width="${n(w)}" height="${n(h)}" rx="4"/>` +
    `<text class="el" x="${n(w / 2)}" y="${n(y)}" text-anchor="middle" dominant-baseline="central">${body}</text>` +
    `</g>`
  );
}

/**
 * The markers and dash an edge already carries.
 *
 * `presentEdge` works these out at parse time and puts them on the edge: a
 * class diagram's extension triangle, an ER relationship's crow's foot, a
 * sequence message's open head, and a dashed line for anything the syntax drew
 * dashed. The emitter used to ignore all of it and end every edge in the plain
 * arrowhead — the eleven markers shipped in `<defs>` and nothing referenced
 * them, so an ER diagram came out with no cardinalities at all.
 *
 * React Flow's own marker is an object rather than a name; ours are names, and
 * only a name can point at a definition in this document. The object is the
 * plain closed arrowhead wherever the model uses it — a flowchart's, a state's,
 * a C4 relationship's — so it is drawn as `arch-arrow`, at whichever end has it.
 */
function edgeAttrs(edge: FlowEdge): string {
  // Flowchart edges carry their arrowhead as an object, not a marker id;
  // map it to the plain arrow so `<-->` keeps both heads.
  const named = (m: unknown) => {
    if (typeof m === "string" && m) {
      return m;
    } else if (typeof m === "object" && m) {
      return "arch-arrow";
    } else {
      return null;
    }
  };
  const end = named(edge.markerEnd);
  const start = named(edge.markerStart);

  // A class diagram's inheritance edge carries a triangle at its *start* and
  // nothing at its end, and adding the plain arrowhead anyway would draw an
  // arrow the canvas does not. So once an edge names a marker at either end,
  // what it names is all it gets. An edge naming none ends in the plain
  // arrowhead only if it says nothing about its ends — one a consumer built
  // by hand. A flowchart's open link (`---`) and an architecture edge drawn
  // without `<` or `>` do say: no head, and the canvas draws none either.
  const headless = edge.data?.arrow === "arrow_open" || edge.data?.arch !== undefined;
  const fallback = !end && !start && !headless ? "arch-arrow" : null;
  const dash = (edge.style as { strokeDasharray?: string } | undefined)?.strokeDasharray;

  return (
    (end || fallback ? ` marker-end="url(#${end ?? fallback})"` : "") +
    (start ? ` marker-start="url(#${start})"` : "") +
    (dash ? ` stroke-dasharray="${esc(String(dash))}"` : "")
  );
}

/**
 * A sequence diagram, drawn row by row rather than routed.
 *
 * Everything about its geometry is in `render/sequence.ts`, which reads the
 * same constants `SequenceView` and `SequenceOverlay` do. What is here is the
 * markup: lifelines, message lines with the head their operator asks for, and
 * the notes, blocks, dividers and activation tags the overlay draws.
 */
function sequenceMarkup(
  nodes: AnyNode[],
  edges: FlowEdge[],
  boxes: Map<string, { x: number; y: number; w: number; h: number }>,
  items: SeqItem[],
  classDefs: ClassDefs,
  icons: Record<string, string>,
): { markup: string; bounds: { minX: number; maxX: number; maxY: number } } {
  const rowCount = items.length || edges.length;
  const geo = sequenceGeometry(nodes, boxes, rowCount);
  const rows = messageRows(items, edges);
  const parts: string[] = [];

  /*
   * The extent of what is actually drawn, accumulated as it is drawn.
   *
   * Deriving it from the lifelines was not enough: a `Note right of` hangs 190px
   * past the rightmost one, and the note came back cropped by the document's
   * own edge. Anything placed beside the diagram — a note, a block frame, a
   * divider's tag — has to widen it.
   */
  let minX = geo.bounds.minX;
  let maxX = geo.bounds.maxX;
  const span_ = (left: number, right: number) => {
    minX = Math.min(minX, left);
    maxX = Math.max(maxX, right);
  };

  // Lifelines first, so every message and note sits over them.
  for (const line of geo.lifelines) {
    parts.push(
      `<line class="lifeline" x1="${n(line.x)}" y1="${n(line.top)}" x2="${n(line.x)}" y2="${n(line.bottom)}"/>`,
    );
  }

  // The blocks are frames behind their contents.
  const span = { left: geo.bounds.minX - 60, width: geo.bounds.maxX - geo.bounds.minX + 120 };
  for (const frame of blockFrames(items)) {
    const top = geo.rowY(frame.start) - 6;
    const height = geo.rowY(frame.end) - geo.rowY(frame.start) + 12;
    span_(span.left, span.left + span.width);
    parts.push(
      `<rect class="seq-block" x="${n(span.left)}" y="${n(top)}" width="${n(span.width)}" height="${n(height)}" rx="4"/>`,
    );
    const tag = frame.label ? `${frame.op} [${frame.label}]` : frame.op;
    parts.push(
      textStack([{ text: tag, font: FONTS.c4Tag, align: "start" }], {
        x: span.left + 8,
        width: span.width - 16,
        top: top + 4,
      }),
    );
  }

  items.forEach((item, i) => {
    const y = geo.rowY(i);
    if (item.kind === "note") {
      const ax = geo.centres.get(item.a) ?? geo.bounds.minX;
      const bx = item.b ? (geo.centres.get(item.b) ?? ax) : ax;
      const width = item.placement === "over" ? Math.max(150, Math.abs(bx - ax) + 20) : 170;
      const left =
        item.placement === "left"
          ? ax - width - 20
          : item.placement === "right"
            ? ax + 20
            : (ax + bx) / 2 - width / 2;
      const text = measureBlock(item.text, FONTS.note, width - 16);
      const height = Math.ceil(text.height + 12);
      span_(left, left + width);
      parts.push(
        `<rect class="seq-note" x="${n(left)}" y="${n(y - 14)}" width="${n(width)}" height="${n(height)}" rx="3"/>`,
      );
      parts.push(
        textStack([{ text: item.text, font: FONTS.note, align: "middle" }], {
          x: left + 8,
          width: width - 16,
          top: y - 14,
          height,
          place: "centre",
        }),
      );
    } else if (item.kind === "divider") {
      span_(geo.bounds.minX - 50, geo.bounds.maxX + 50);
      parts.push(
        `<line class="seq-divider" x1="${n(geo.bounds.minX - 50)}" y1="${n(y)}" x2="${n(geo.bounds.maxX + 50)}" y2="${n(y)}"/>`,
      );
      parts.push(
        textStack(
          [{ text: `${item.op} ${item.label}`.trim(), font: FONTS.c4Tag, align: "start" }],
          {
            x: geo.bounds.minX - 46,
            width: 200,
            top: y - 14,
          },
        ),
      );
    } else if (item.kind === "active") {
      const x = geo.centres.get(item.actor);
      if (x !== undefined) {
        parts.push(
          textStack(
            [
              {
                text: `${item.on ? "activate" : "deactivate"} ${item.actor}`,
                font: FONTS.c4Tag,
                align: "start",
                attrs: ' opacity="0.75"',
              },
            ],
            { x: x + 8, width: 200, top: y - 8 },
          ),
        );
      }
    }
  });

  // The messages themselves.
  for (const edge of edges) {
    const from = geo.centres.get(edge.source);
    const to = geo.centres.get(edge.target);
    const row = rows.get(edge.id);
    if (from === undefined || to === undefined || row === undefined) continue;
    const y = geo.rowY(row);
    // A message to the same participant is a small loop out and back, which is
    // what a self-call looks like everywhere it is drawn.
    const d =
      from === to
        ? `M ${n(from)},${n(y)} L ${n(from + 40)},${n(y)} L ${n(from + 40)},${n(y + 18)} L ${n(from)},${n(y + 18)}`
        : `M ${n(from)},${n(y)} L ${n(to)},${n(y)}`;
    parts.push(`<path class="e" d="${d}"${edgeAttrs(edge)}/>`);
    parts.push(
      edgeLabelMarkup(edge.data?.label ?? "", {
        x: from === to ? from + 60 : (from + to) / 2,
        y: from === to ? y + 9 : y - 10,
      }),
    );
  }

  // Participants last: their heads sit over the top of every lifeline.
  for (const node of nodes) {
    if (node.type !== "participant") continue;
    const b = boxes.get(node.id);
    if (!b) continue;
    parts.push(
      `<g transform="translate(${n(b.x)},${n(b.y)})">${nodeInner(node, b.w, b.h, icons, classDefs)}</g>`,
    );
  }

  return { markup: parts.join(""), bounds: { ...geo.bounds, minX, maxX } };
}

/**
 * Draw `nodes` and `edges` as one SVG document.
 *
 * Positions are taken from the nodes as they stand — from the layout comment a
 * document carries, or from `autoLayout` — and sizes from `absoluteBoxes`,
 * which is the same resolution the canvas uses and ends at `measureNode`.
 */
export function renderSvg(
  nodes: AnyNode[],
  edges: FlowEdge[],
  kind: DiagramKind,
  options: RenderOptions = {},
): string {
  if (!SUPPORTED.has(kind)) throw new UnsupportedFamilyError(kind);

  const theme = options.theme ?? "dark";
  const pad = options.padding ?? 24;
  const c = PALETTE[theme];
  const boxes = absoluteBoxes(nodes);
  // A sequence diagram is not routed: its geometry is rows, not paths. Asking
  // `allRoutes` for one would answer with the orthogonal router's idea of a
  // connection between two boxes on a single top row, which is not a message.
  const sequence =
    kind === "sequence"
      ? sequenceMarkup(
          nodes,
          edges,
          boxes,
          options.seqItems ?? [],
          options.classDefs ?? {},
          options.icons ?? {},
        )
      : null;
  const routes = sequence ? new Map<string, Point[]>() : allRoutes(nodes, edges, kind);

  // The extent of everything drawn, nodes and routes both: an edge that loops
  // out around a node reaches past every box.
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const grow = (x: number, y: number) => {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  };
  for (const node of nodes) {
    const b = boxes.get(node.id);
    if (!b) continue;
    grow(b.x, b.y);
    grow(b.x + b.w, b.y + b.h);
  }
  for (const points of routes.values()) for (const p of points) grow(p.x, p.y);
  if (sequence) {
    grow(sequence.bounds.minX - 10, 0);
    grow(sequence.bounds.maxX + 10, sequence.bounds.maxY);
  }
  if (!Number.isFinite(x1)) {
    x1 = 0;
    y1 = 0;
    x2 = 0;
    y2 = 0;
  }

  const width = Math.ceil(x2 - x1 + pad * 2);
  const height = Math.ceil(y2 - y1 + pad * 2);
  const dx = pad - x1;
  const dy = pad - y1;

  // Groups first, so their frames sit behind what they contain.
  const ordered = [...nodes].sort((a, b) => Number(isGroup(b)) - Number(isGroup(a)));
  const nodeMarkup = ordered
    .map((node) => {
      const b = boxes.get(node.id);
      if (!b) return "";
      return `<g transform="translate(${n(b.x)},${n(b.y)})">${nodeInner(node, b.w, b.h, options.icons ?? {}, options.classDefs ?? {})}</g>`;
    })
    .join("");

  const edgeMarkup = edges
    .map((edge) => {
      const points = routes.get(edge.id);
      if (!points || points.length < 2) return "";
      return `<path class="e" d="${roundedPolyline(points)}"${edgeAttrs(edge)}/>`;
    })
    .join("");

  // Where the labels ended up is not each edge's own business — one that would
  // land on a box or on its neighbour is slid clear, which can only be decided
  // for all of them together. The canvas asks the same question of the same
  // module, so a diagram exports with its labels where they were on screen.
  const placed = sequence ? new Map() : allLabels(nodes, edges, kind);
  const labelMarkup = edges
    .map((edge) => {
      const at = placed.get(edge.id);
      return at ? edgeLabelMarkup(at.text, at.at) : "";
    })
    .join("");

  const style = [
    `.sf{fill:${c.nodeFill};stroke:${c.nodeStroke};stroke-width:${BOX_MODEL_BORDER};vector-effect:non-scaling-stroke}`,
    `.sl{fill:none;stroke:${c.nodeStroke};stroke-width:${BOX_MODEL_BORDER}}`,
    `.gf{fill:none;stroke:${c.nodeStroke};stroke-width:1.5;stroke-dasharray:6 4}`,
    `.e{fill:none;stroke:${c.edge};stroke-width:1.5}`,
    `.el{fill:${c.edgeLabel};font-family:${NODE_FONT.family};font-size:11px}`,
    `.el-bg{fill:${c.edgeLabelBg}}`,
    // Sequence: the lifelines, the frames a block draws, and a note's plate.
    `.lifeline{stroke:${c.nodeStroke};stroke-width:1;stroke-dasharray:4 4;opacity:0.7}`,
    `.seq-block{fill:none;stroke:${c.nodeStroke};stroke-width:1;opacity:0.6}`,
    `.seq-note{fill:${c.edgeLabelBg};stroke:${c.nodeStroke};stroke-width:1}`,
    `.seq-divider{stroke:${c.nodeStroke};stroke-width:1;stroke-dasharray:2 3}`,
    `.glyph{stroke:${c.text}}`,
    // State markers: a fork bar, a start disc and an end ring are all painted
    // in the text colour rather than the node's.
    `.bar{fill:${c.text}}`,
    `.ring{fill:none;stroke:${c.text};stroke-width:2}`,
    `.c4{fill:${C4_COLOURS.fill};stroke:${C4_COLOURS.stroke};stroke-width:1.5}`,
    `.c4-head{fill:${C4_COLOURS.text};opacity:0.85}`,
    // Every label. A C4 element paints its own, being a dark box in both
    // themes; everything else takes the theme's text colour.
    `.t{fill:${c.text}}`,
    `.c4 ~ .t tspan{fill:${C4_COLOURS.text}}`,
    `.rule{stroke:${c.nodeStroke};stroke-width:1}`,
  ].join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${style}</style>` +
    // Every marker, not only the arrowhead: a class diagram's edges end in
    // diamonds and an ER diagram's in crow's feet, and the same table draws
    // them for the canvas.
    `<defs>${markerDefs(c.edge, c.markerHollow)}</defs>` +
    (options.background === false ? "" : `<rect width="100%" height="100%" fill="${c.bg}"/>`) +
    // Labels last: a connection may run behind a box, but what it is called
    // has to stay readable, which is also the order the canvas paints in.
    `<g transform="translate(${n(dx)},${n(dy)})">${sequence ? sequence.markup : edgeMarkup + nodeMarkup + labelMarkup}</g>` +
    `</svg>`
  );
}
