/**
 * The editor grid: a power-of-two ladder in metres, Y-up.
 *
 * TrenchBroom's grid is a ladder of powers of two over Quake's integer unit, and every tool snaps
 * through it rather than rounding on its own. three-broom keeps the ladder and changes the rung it is
 * centred on: the sheet a brush is written into is three's own world, so a grid step is a metre and its
 * subdivisions, not an inch.
 *
 * Every size here is a power of two, so it is exact in binary and `round(v / size) * size` never drifts
 * — which is what lets a face plane be stored as three snapped points and read back as the same plane.
 *
 * No imports: the whole module is arithmetic, so `snap.check.ts` runs it under bare node.
 */

/** 2^-6 m — 15.625 mm. Below this a face plane's three points stop being distinguishable at map scale. */
export const MIN_EXPONENT = -6;
/** 2^3 m — 8 m. A step this coarse is for blocking out, and nothing above it is useful. */
export const MAX_EXPONENT = 3;
/** 2^-2 m — 25 cm. Coarse enough to block out a room, fine enough for a door frame. */
export const DEFAULT_EXPONENT = -2;

/** Every Nth line is drawn as a major one. 8 puts a major line every 2 m on the default grid. */
export const MAJOR_EVERY = 8;

/** The size in metres of one cell of the grid at `exponent`. Always an exact binary fraction. */
export const gridSize = (exponent: number): number => 2 ** clampExponent(exponent);

export const clampExponent = (exponent: number): number =>
  Math.min(MAX_EXPONENT, Math.max(MIN_EXPONENT, Math.round(exponent)));

/** The exponents the grid can be set to, coarse last. */
export const exponents = (): number[] =>
  Array.from({ length: MAX_EXPONENT - MIN_EXPONENT + 1 }, (_, i) => MIN_EXPONENT + i);

/**
 * How a size is written in the UI. Exact rather than rounded — 0.015625 is the size, and a grid
 * labelled "0.016" would not be the one the arithmetic uses.
 */
export const formatSize = (size: number): string =>
  size >= 1 ? `${size} m` : `${size * 1000} mm`;

/** The nearest multiple of `size`. Ties go up, as `Math.round` does. */
export const snap = (value: number, size: number): number => Math.round(value / size) * size;

export const snapDown = (value: number, size: number): number => Math.floor(value / size) * size;

export const snapUp = (value: number, size: number): number => Math.ceil(value / size) * size;

/**
 * Snap `value` in the direction `sign` points, and never back past where it started: what an extrude
 * drag wants, where rounding to nearest would make the first pixel of a pull collapse the face.
 * `sign` of 0 falls back to nearest.
 */
export const snapTowards = (value: number, size: number, sign: number): number =>
  sign > 0 ? snapUp(value, size) : sign < 0 ? snapDown(value, size) : snap(value, size);

/**
 * A translation snapped so that `origin + delta` lands on the grid, rather than the translation itself
 * being a multiple of the grid.
 *
 * `origin` is the point being made to land — a corner of what is moving, not its centre — so dragging a
 * box towards a wall puts its side on a grid line where the wall is. The price is that something built
 * off-grid is pulled onto it the first time it is moved, and that is the right price: a grid that only
 * ever moved things by whole cells would preserve every misalignment it was ever given.
 */
export const snapDelta = (origin: number, delta: number, size: number): number =>
  snap(origin + delta, size) - origin;

/** True where the line `index` cells from the origin is drawn as a major one. */
export const isMajor = (index: number, majorEvery: number = MAJOR_EVERY): boolean =>
  index % majorEvery === 0;

/**
 * How far the grid is drawn either side of the origin, in metres, for a given cell size.
 *
 * Two bounds meet here: a grid is useless if it does not reach as far as the room being built, and a
 * fine grid drawn that far is hundreds of thousands of lines. `maxCells` is the budget, 32 m the reach.
 */
export const gridExtent = (size: number, maxCells: number = 2048): number =>
  Math.min(32, (size * maxCells) / 2);
