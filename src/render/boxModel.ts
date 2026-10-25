/**
 * The numbers `src/styles.css` draws a node with, in a form arithmetic can use.
 *
 * Two things need them and neither can read a stylesheet: `measureNode` works
 * out how big a node is before anything is drawn, and `renderSvg` places text
 * inside that box by hand. Keeping a second copy in each would guarantee they
 * drift from the CSS *and* from each other, so there is one copy and both
 * import it.
 *
 * Every entry names the selector it came from. `* { box-sizing: border-box }`
 * is in force throughout, so a stated width is the whole box, padding and
 * border included — which is why the arithmetic adds `padX + border` to the
 * content rather than to the frame.
 *
 * `scripts/build-box-model.mjs` regenerates the values below from the
 * stylesheet, and CI runs it with `--check`. Edit the CSS, not this file.
 */
import { LABEL_SIZE } from "../model/types";
import { BOX_MODEL } from "./boxModel.generated";
import type { FontSpec } from "../textMetrics";

/** The stroke a bordered node is drawn with, as the stylesheet sets it. */
export const BORDER_WIDTH = BOX_MODEL.borderWidth;

/** Borders are drawn on both sides, and both sides take space. */
export const BORDER = BOX_MODEL.borderWidth * 2;

/** The font stack every node label is drawn in — `body` in the stylesheet. */
export const FONT_FAMILY = BOX_MODEL.fontFamily;

export function face(size: number, weight?: number): FontSpec {
  return { family: FONT_FAMILY, size, ...(weight ? { weight } : {}) };
}

/**
 * The box each family is drawn in.
 *
 * `padX`/`padY` are the totals — left plus right, top plus bottom — because
 * that is the only form the arithmetic ever wants.
 */
/**
 * Below this size a shape's label gives up its usual padding — `.compact` on
 * the canvas — or draw.io's 40×20 tags had a letter's width to wrap in.
 */
export const COMPACT_SHAPE = { width: 64, height: 32 };

/** The padding a label keeps, left plus right, in a box that has given it up. */
export const SLIM_LABEL_PAD_X = 4;

export const BOXES = {
  /** `.shape-label`, inside a `.shape-node` with no border of its own. */
  shape: {
    padX: BOX_MODEL.shapeLabel.padX,
    padY: BOX_MODEL.shapeLabel.padY,
    border: 0,
    minWidth: 0,
  },
  /** `.state-node`. */
  state: {
    padX: BOX_MODEL.stateNode.padX,
    padY: BOX_MODEL.stateNode.padY,
    border: BORDER,
    minWidth: BOX_MODEL.stateNode.minWidth,
  },
  /** `.table-node`. Its rows carry their own padding. */
  table: { padX: 0, padY: 0, border: BORDER, minWidth: BOX_MODEL.tableNode.minWidth },
  /** `.participant-head`. */
  participant: {
    padX: BOX_MODEL.participantHead.padX,
    padY: BOX_MODEL.participantHead.padY,
    border: BORDER,
    minWidth: BOX_MODEL.participantHead.minWidth,
  },
  /** `.service-node`. */
  service: {
    padX: BOX_MODEL.serviceNode.padX,
    padY: BOX_MODEL.serviceNode.padY,
    border: BORDER,
    minWidth: BOX_MODEL.serviceNode.minWidth,
    gap: BOX_MODEL.serviceNode.gap,
  },
  /** `.c4-node`. */
  c4: {
    padX: BOX_MODEL.c4Node.padX,
    padY: BOX_MODEL.c4Node.padY,
    border: BORDER,
    minWidth: BOX_MODEL.c4Node.minWidth,
    maxWidth: BOX_MODEL.c4Node.maxWidth,
  },
  /** `.note-node`, which has no border. */
  note: {
    padX: BOX_MODEL.noteNode.padX,
    padY: BOX_MODEL.noteNode.padY,
    border: 0,
    minWidth: BOX_MODEL.noteNode.minWidth,
    maxWidth: BOX_MODEL.noteNode.maxWidth,
  },
} as const;

/** `.table-title`, plus the 1px rule under it. */
export const TABLE_TITLE = {
  padX: BOX_MODEL.tableTitle.padX,
  padY: BOX_MODEL.tableTitle.padY,
  rule: 1,
};

/** `.group-title`: the caption a container carries. */
export const GROUP_TITLE = {
  padX: BOX_MODEL.groupTitle.padX,
  padY: BOX_MODEL.groupTitle.padY,
};

/** `.table-rows` and `.table-row`. */
export const TABLE_ROWS = {
  padY: BOX_MODEL.tableRows.padY,
  rowPadX: BOX_MODEL.tableRow.padX,
  rowPadY: BOX_MODEL.tableRow.padY,
  gap: BOX_MODEL.tableRow.gap,
};

/** `.table-row .dim`: the column an ER attribute's type sits in. */
export const ER_TYPE_MIN = BOX_MODEL.erTypeColumn.minWidth;
// The two that are props rather than declarations, so no reading of the
// stylesheet would find them. See `glyphSizes.ts`.
export { ARCH_ICON_SIZE as ARCH_ICON } from "./glyphSizes";
export { ACTOR_GLYPH as ACTOR_GLYPH_BOX } from "./glyphSizes";
/** `.c4-head`: the disc a person carries, and the margin under it. */
export const C4_HEAD = BOX_MODEL.c4Head.size + BOX_MODEL.c4Head.marginBottom;
/** `.note-node` states its own line-height, unlike everything else. */
export const NOTE_LINE_HEIGHT = BOX_MODEL.noteNode.lineHeight;

/** The type sizes, each from the rule that sets it. */
export const FONTS = {
  /** `.state-node`, `.participant-head`. */
  state: face(BOX_MODEL.stateNode.fontSize),
  /** `.table-node`. */
  table: face(BOX_MODEL.tableNode.fontSize),
  /** `.table-title`, which is bold. */
  tableTitle: face(BOX_MODEL.tableNode.fontSize, BOX_MODEL.tableTitle.fontWeight),
  /** `.table-row .keys`. */
  keys: face(BOX_MODEL.tableRowKeys.fontSize),
  /** `.table-row.mono`, in the code face. */
  mono: { family: BOX_MODEL.tableRowMono.fontFamily, size: BOX_MODEL.tableRowMono.fontSize },
  /** `.class-annotation`. */
  annotation: face(BOX_MODEL.classAnnotation.fontSize),
  /** `.service-label`. */
  service: face(BOX_MODEL.serviceLabel.fontSize),
  /** `.c4-label`, which is bold. */
  c4Label: face(BOX_MODEL.c4Label.fontSize, BOX_MODEL.c4Label.fontWeight),
  /** `.c4-tag`. */
  c4Tag: face(BOX_MODEL.c4Tag.fontSize),
  /** `.c4-descr`. */
  c4Descr: face(BOX_MODEL.c4Descr.fontSize),
  /** `.note-node`. */
  note: face(BOX_MODEL.noteNode.fontSize),
  /** `.group-title`. */
  groupTitle: face(BOX_MODEL.groupTitle.fontSize),
  /** `.shape-label`, whose size a node's own style can override. */
  label: face(LABEL_SIZE),
} satisfies Record<string, FontSpec>;

/**
 * The two palettes, as literal colours.
 *
 * A rendered SVG has no document, so `var(--node-fill)` resolves to nothing in
 * it — the value has to be baked in. These used to be hand-copied into
 * `renderSvg.ts` *and* into `edgeColors()` in `theme.ts`, three copies of one
 * set of colours with nothing keeping them in step. Now the stylesheet is the
 * source and both read from here.
 */
export const PALETTE = BOX_MODEL.palette;
export type PaletteName = keyof typeof PALETTE;

/** A C4 element paints itself, in the same navy under either theme. */
export const C4_COLOURS = BOX_MODEL.c4;

/** `.service-label` will not grow past this, whatever the node does. */
export const SERVICE_LABEL_MAX = BOX_MODEL.serviceLabel.maxWidth;
