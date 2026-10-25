/**
 * How big a node actually is, worked out rather than assumed.
 *
 * `estimateSize` in `model/types.ts` answers the same question with constants —
 * 150×46 for a state, a flat 210 for a class however many members it lists — and
 * for the editor that has always been enough: React Flow measures the real
 * element a frame later, every caller prefers `measured` when there is one, and
 * the constant only has to be a plausible starting point for the frame before.
 *
 * A renderer gets no second frame. Outside the editor nothing measures anything
 * afterwards, so the number handed to ELK is the number that ends up in the
 * picture. That is the gap this closes.
 *
 * ## What it returns
 *
 * The size the browser would compute for a node nobody has given a size to —
 * which is not one rule but two, and the difference matters.
 *
 * Most families are shrink-to-fit boxes with a `min-width` floor: a state, a
 * table, a C4 element and a note all grow around what is written in them, so
 * they are measured. A **flowchart shape does not** — `ShapeNode` gives the
 * element the shape's default size and lets a long label wrap and clip inside
 * it, on the principle that a diagram is a set of boxes whose sizes are the
 * author's. Assuming otherwise here over-predicted a long node by 100px.
 *
 * Callers that already have a width pass it, and get the height that width
 * implies.
 *
 * ## Its relationship with the stylesheet
 *
 * The numbers are **not** restated here. `render/boxModel.ts` takes them from
 * `render/boxModel.generated.ts`, which `scripts/build-box-model.mjs` extracts
 * out of `src/styles.css` and CI re-checks — so editing a padding in the
 * stylesheet either updates the measurement or fails the build. They used to be
 * mirrored by hand, and a hand-mirrored constant is wrong the moment somebody
 * edits the original, silently, until a diagram looks off.
 *
 * What that cannot check is whether the arithmetic *around* those numbers is
 * right. `tests/e2e-measure.mts` does: it drives a diagram of every family
 * through the real app and compares what this predicts against what React Flow
 * measured, within 4px.
 *
 * Treat a disagreement as this file being wrong. Every one so far has been:
 * shapes growing when they do not, an ER row missing the gap of an empty span
 * that is always rendered, a code-face row assumed to have the text face's line
 * height, an actor's stick figure uncounted, and three pseudo-state constants
 * that had never matched the stylesheet at all.
 */
import {
  C4_TAGS,
  IMG_SIZE,
  defaultSize,
  isFrameless,
  labelSize,
  type AnyNode,
  type ClassNodeData,
  type EntityNodeData,
  type ShapeNodeData,
} from "./model/types";
import {
  ACTOR_GLYPH_BOX,
  ARCH_ICON,
  BOXES,
  C4_HEAD,
  ER_TYPE_MIN,
  FONTS,
  NOTE_LINE_HEIGHT,
  SERVICE_LABEL_MAX,
  TABLE_ROWS,
  TABLE_TITLE,
  face,
} from "./render/boxModel";
import { labelLines } from "./model/label";
import {
  measureBlock,
  textMetrics,
  wrapText,
  type FontSpec,
  type TextMetrics,
  type TextSize,
} from "./textMetrics";

/*
 * The numbers this works from live in `render/boxModel.ts`, which takes them
 * from `render/boxModel.generated.ts` — extracted out of `src/styles.css` by
 * `scripts/build-box-model.mjs` and checked in CI. They used to be restated
 * here by hand, which meant a padding changed in the stylesheet left the
 * measurement quietly wrong until somebody noticed a diagram looked off.
 */

/* ---------- helpers ---------- */

/**
 * A block of text in a box: the content measured, the padding and border added,
 * and the floor applied.
 *
 * `width` is the width the node has been given, if it has one. Without it the
 * text is measured on one line, which is what a shrink-to-fit box does; with
 * it, the text wraps into whatever the padding leaves.
 */
function boxed(
  text: string,
  font: FontSpec,
  box: { padX: number; padY: number; border: number; minWidth: number; maxWidth?: number },
  metrics: TextMetrics,
  width?: number,
): { width: number; height: number } {
  const chrome = box.padX + box.border;
  const limit =
    width !== undefined
      ? Math.max(0, width - chrome)
      : box.maxWidth !== undefined
        ? box.maxWidth - chrome
        : Infinity;

  const content: TextSize =
    limit === Infinity ? metrics.measure(text, font) : measureBlock(text, font, limit, metrics);

  return {
    width: Math.max(box.minWidth, Math.ceil(content.width + chrome)),
    height: Math.ceil(content.height + box.padY + box.border),
  };
}

/** One row of a table node: its text, its padding, and the floor it sits on. */
function row(width: number, height: number) {
  return { width: width + TABLE_ROWS.rowPadX, height: height + TABLE_ROWS.rowPadY };
}

/* ---------- per family ---------- */

/**
 * A flowchart shape, which — and the tolerance test is what settled this — does
 * **not** grow with its label.
 *
 * `ShapeNode` gives the element `width: style?.width ?? defaultSize(shape)`, so
 * a framed node is exactly its default size until somebody resizes it, and a
 * label too long for that box wraps and clips inside it (`overflow-wrap:
 * break-word`, `.shape-node.sized .shape-label { overflow: hidden }`). The
 * stylesheet's comment says why: a diagram is a set of boxes whose sizes are
 * the author's, and a node that silently widened because of what was typed in
 * it is not a size anybody chose.
 *
 * So measuring the text here and returning it would be *more* work and *less*
 * correct — it was, at first, by 100px on a long label. What the text decides
 * is how small the box may be dragged, and that question belongs to
 * `contentSize.ts`, which asks the rendered element.
 */
function measureShape(
  data: ShapeNodeData,
  metrics: TextMetrics,
  width?: number,
): { width: number; height: number } {
  const size = labelSize(data.styles);
  const font = face(size);
  const floor = defaultSize(data.shape);

  if (data.img && isFrameless(data.styles)) {
    // A picture with its frame switched off is the size of what it shows: the
    // picture, the name under it, and `.shape-label.with-image`'s padding of
    // 6px 8px plus its 4px gap. The old form of this guessed the label's width
    // from its length; now it is measured.
    const w = data.imgWidth ?? IMG_SIZE;
    const h = data.imgHeight ?? IMG_SIZE;
    // Line by line: a caption under an icon is very often two lines
    // ("Azure<br>Key Vault"), and measured as one it came out the width of
    // both and the height of neither.
    let labelWidth = 0;
    let labelHeight = 0;
    for (const line of labelLines(data.label)) {
      const size = metrics.measure(line, font);
      labelWidth = Math.max(labelWidth, size.width);
      labelHeight += size.height;
    }
    return {
      width: Math.ceil(Math.max(w, labelWidth) + 16),
      height: Math.ceil(h + labelHeight + 4 + 12),
    };
  }

  // The box is the one the node was given, or the shape's own. The label has
  // no say in it.
  return { width: width ?? floor.width, height: floor.height };
}

/** An ER entity: a title, then one row per attribute. */
function measureEntity(
  data: EntityNodeData,
  metrics: TextMetrics,
  width?: number,
): { width: number; height: number } {
  const title = metrics.measure(data.label, FONTS.tableTitle);
  let widest = title.width + TABLE_TITLE.padX;
  let rows = 0;

  for (const attr of data.attributes) {
    // `.table-row` is a flex line of three spans: the type column (with a 48px
    // floor), the name, and the keys. The third is rendered **even when there
    // are no keys** — `EntityNodeView` writes the span unconditionally — and an
    // empty flex child still costs its `gap`. Leaving that gap out was the
    // 7px this was short by on every unkeyed row.
    const type = Math.max(ER_TYPE_MIN, metrics.measure(attr.type, FONTS.table).width);
    const name = metrics.measure(attr.name, FONTS.table);
    // Joined with a comma, as the view joins them.
    const keys = metrics.measure(attr.keys.join(","), FONTS.keys).width;
    const line = row(type + TABLE_ROWS.gap + name.width + TABLE_ROWS.gap + keys, name.height);
    widest = Math.max(widest, line.width);
    rows += line.height;
  }

  const height =
    title.height +
    TABLE_TITLE.padY +
    TABLE_TITLE.rule +
    (data.attributes.length ? rows + TABLE_ROWS.padY : 0) +
    BOXES.table.border;

  return {
    width: Math.max(BOXES.table.minWidth, Math.ceil((width ?? widest) + BOXES.table.border)),
    height: Math.ceil(height),
  };
}

/**
 * A class: the annotations and the name in the title, then members and methods
 * in two groups with a rule between them.
 */
function measureClass(
  data: ClassNodeData,
  metrics: TextMetrics,
  width?: number,
): { width: number; height: number } {
  const name = data.generic ? `${data.label}<${data.generic}>` : data.label;
  const title = metrics.measure(name, FONTS.tableTitle);
  let widest = title.width + TABLE_TITLE.padX;
  let titleHeight = title.height;

  for (const annotation of data.annotations) {
    const a = metrics.measure(`«${annotation}»`, FONTS.annotation);
    widest = Math.max(widest, a.width + TABLE_TITLE.padX);
    titleHeight += a.height;
  }

  const groups = [data.members, data.methods].filter((g) => g.length > 0);
  let rows = 0;
  for (const group of groups) {
    rows += TABLE_ROWS.padY;
    for (const text of group) {
      // Both numbers from the backend, height included. Assuming a line box of
      // 1.33× here cost 7px over four rows: `line-height: normal` resolves
      // through the *font's* metrics, and the code face this row is set in
      // (`.table-row.mono`) asks for a tighter line than the text face does.
      const measured = metrics.measure(text, FONTS.mono);
      const line = row(measured.width, measured.height);
      widest = Math.max(widest, line.width);
      rows += line.height;
    }
  }
  // `.table-rows + .table-rows` puts a 1px rule between the two groups.
  if (groups.length === 2) rows += 1;

  return {
    width: Math.max(BOXES.table.minWidth, Math.ceil((width ?? widest) + BOXES.table.border)),
    height: Math.ceil(
      titleHeight + TABLE_TITLE.padY + TABLE_TITLE.rule + rows + BOXES.table.border,
    ),
  };
}

/**
 * An architecture service: an icon with its name under it. The icon's 44px is a
 * size it wants rather than one it insists on, so a node given a width keeps it
 * and the icon fits in.
 */
function measureService(
  label: string,
  metrics: TextMetrics,
  width?: number,
): { width: number; height: number } {
  const box = BOXES.service;
  const chrome = box.padX + box.border;
  // `.service-label` caps itself at 130px whatever the node does.
  const limit = Math.min(
    SERVICE_LABEL_MAX,
    width !== undefined ? Math.max(0, width - chrome) : SERVICE_LABEL_MAX,
  );
  const text = measureBlock(label, FONTS.service, limit, metrics);
  return {
    width: Math.max(box.minWidth, Math.ceil(Math.max(ARCH_ICON, text.width) + chrome)),
    height: Math.ceil(ARCH_ICON + 6 + text.height + box.padY + box.border),
  };
}

/**
 * A C4 element: the tag in guillemets, the name, and a description if there is
 * one — with a 26px disc above them, but only for a person. `C4NodeView`
 * renders `.c4-head` behind `person`, so a system box does not carry its
 * height.
 */
function measureC4(
  data: { label: string; c4Shape: string; descr: string },
  metrics: TextMetrics,
  width?: number,
): { width: number; height: number } {
  const box = BOXES.c4;
  const chrome = box.padX + box.border;
  const tag = C4_TAGS[data.c4Shape] ?? data.c4Shape;
  const lines = [
    { text: `«${tag}»`, font: FONTS.c4Tag },
    { text: data.label, font: FONTS.c4Label },
    ...(data.descr ? [{ text: data.descr, font: FONTS.c4Descr }] : []),
  ];

  // A box with a `max-width` shrink-to-fits to its **max-content** width — the
  // text on one line — and is then capped. It does *not* wrap first and take
  // the widest resulting line, which is what this used to compute: for a
  // description whose natural width was over the cap, that gave whatever the
  // wrap happened to leave rather than the cap itself. It agreed on Windows
  // and was 12px short on a Linux runner, whose wider fonts pushed the same
  // text past 230.
  const maxContent = Math.max(...lines.map((l) => metrics.measure(l.text, l.font).width));
  const resolved =
    width ?? Math.min(box.maxWidth, Math.max(box.minWidth, Math.ceil(maxContent + chrome)));

  // Height follows from the width actually settled on, not from the cap.
  const inner = Math.max(0, resolved - chrome);
  const stacked = lines.reduce(
    (sum, l) => sum + measureBlock(l.text, l.font, inner, metrics).height,
    // `.c4-label` carries `margin: 2px 0`.
    4,
  );
  const head = data.c4Shape.includes("person") ? C4_HEAD : 0;

  return { width: resolved, height: Math.ceil(head + stacked + box.padY + box.border) };
}

/* ---------- the answer ---------- */

/**
 * The size this node wants, measured.
 *
 * `width`, when given, is a width already chosen for the node: the label wraps
 * into it and the height that comes back is the height that width implies.
 * Without it the node is measured shrink-to-fit, as an unsized one is drawn.
 *
 * Shapes with no text to measure — a junction, a fork bar, a start or end
 * marker — are their constants, because that is what they are: they have no
 * content, so there is nothing about them a measurement could discover.
 */
export function measureNode(
  n: AnyNode,
  metrics: TextMetrics = textMetrics(),
  width?: number,
): { width: number; height: number } {
  switch (n.type) {
    case "shape":
      return measureShape(n.data, metrics, width);

    case "state": {
      // The three that carry no text are the sizes the stylesheet states, and
      // `* { box-sizing: border-box }` means those numbers are the whole box.
      // The old constants here were 40, 12 and 28 — each off by a little, and
      // each unnoticed because nothing ever compared them with the drawing.
      const t = n.data.stateType;
      if (t === "choice") return { width: 36, height: 36 }; // `.choice-state`
      if (t === "fork" || t === "join") return { width: 70, height: 10 }; // `.forkjoin-state`
      if (t !== "normal") return { width: 26, height: 26 }; // `.pseudo-state`
      return boxed(n.data.label, FONTS.state, BOXES.state, metrics, width);
    }

    case "entity":
      return measureEntity(n.data, metrics, width);

    case "class":
      return measureClass(n.data, metrics, width);

    case "participant": {
      // `.participant-head` is a flex row, and an actor puts a 14px stick
      // figure in front of the name with the row's 8px gap after it.
      const head = boxed(n.data.label, FONTS.state, BOXES.participant, metrics, width);
      if (n.data.ptype !== "actor") return head;
      return {
        width: Math.max(
          BOXES.participant.minWidth,
          head.width + ACTOR_GLYPH_BOX.width + TABLE_ROWS.gap,
        ),
        height: head.height,
      };
    }

    case "note": {
      const box = BOXES.note;
      const chrome = box.padX + box.border;
      // Same rule as the C4 element above: a `max-width` box takes its
      // max-content width and is then capped, rather than wrapping first and
      // measuring what the wrap left.
      const maxContent = metrics.measure(n.data.text, FONTS.note).width;
      const resolved =
        width ?? Math.min(box.maxWidth, Math.max(box.minWidth, Math.ceil(maxContent + chrome)));
      // `.note-node` states `line-height: 1.45` rather than leaving it to the
      // font, so the lines are counted and multiplied instead of taking the
      // stacked height `measureBlock` returns.
      const lines = wrapText(n.data.text, FONTS.note, Math.max(0, resolved - chrome), metrics);
      return {
        width: resolved,
        height: Math.ceil(
          Math.max(1, lines.length) * FONTS.note.size * NOTE_LINE_HEIGHT + box.padY,
        ),
      };
    }

    case "service":
      return measureService(n.data.label, metrics, width);

    case "junction":
      // `.junction-node` is 14px with no content and a 1px ring around it.
      return { width: 16, height: 16 };

    case "c4":
      return measureC4(n.data, metrics, width);

    default:
      // A group, whose size is decided by what it contains — layout's job, not
      // measurement's. The constant matches `estimateSize`, and both are only
      // ever a starting point: `autoLayout` gives ELK the group's children and
      // takes back the box they needed.
      return { width: 320, height: 220 };
  }
}

/**
 * The font a plain label is drawn in, for callers that need to measure one
 * without building a node around it.
 */
export const DEFAULT_LABEL_FONT = FONTS.label;
