/**
 * How far out the canvas zooms, for the editor and the import preview alike.
 *
 * React Flow stops at half size, and a draw.io page five thousand units tall —
 * with one stray label far below the rest — could not be fitted at all: "fit"
 * centred the empty middle and the canvas showed nothing.
 */
export const MIN_ZOOM = 0.05;
