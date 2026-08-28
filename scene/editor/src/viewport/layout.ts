/**
 * How the panes are arranged.
 *
 * TrenchBroom offers one, two, three and four panes and a designer switches between them constantly —
 * four to lay a room out, one to walk through it, three for everything in between. So the layout is a
 * value rather than a component tree: the panes do not move, the rectangles they are drawn into do, and a
 * pane that is not in the current layout keeps its camera for when it comes back.
 *
 * Everything here is fractions of the container, never pixels. The renderer multiplies up at the last
 * moment, which is what lets a splitter drag be a single number and a resize be nothing at all.
 */
import type { ViewKind } from "./view.ts";

export type LayoutKind = "one" | "two" | "three" | "four";

export const LAYOUTS: LayoutKind[] = ["one", "two", "three", "four"];

/** the two splits every layout is built from: one vertical, one horizontal */
export type Split = { x: number; y: number };

/** three panes with the 3D view given most of the width — the layout the editor opens on */
export const DEFAULT_LAYOUT: LayoutKind = "three";
export const DEFAULT_SPLIT: Split = { x: 0.62, y: 0.5 };

/** no pane may be squeezed below this fraction; a pane you cannot see is one you cannot get back */
export const MIN_FRACTION = 0.12;

/** a pane's rectangle, in fractions of the container, measured from the top left */
export type Cell = { view: ViewKind; x: number; y: number; w: number; h: number };

/**
 * The panes of a layout.
 *
 * The 3D view is always first and always the largest, because it is the one a designer looks at; the 2D
 * views come in the order top, front, side, which is the order they are reached for.
 */
export function cellsOf(kind: LayoutKind, split: Split = DEFAULT_SPLIT): Cell[] {
  const { x, y } = clampSplit(split);
  switch (kind) {
    case "one":
      return [{ view: "3d", x: 0, y: 0, w: 1, h: 1 }];
    case "two":
      return [
        { view: "3d", x: 0, y: 0, w: x, h: 1 },
        { view: "top", x, y: 0, w: 1 - x, h: 1 },
      ];
    case "three":
      return [
        { view: "3d", x: 0, y: 0, w: x, h: 1 },
        { view: "top", x, y: 0, w: 1 - x, h: y },
        { view: "front", x, y, w: 1 - x, h: 1 - y },
      ];
    case "four":
      return [
        { view: "3d", x: 0, y: 0, w: x, h: y },
        { view: "top", x, y: 0, w: 1 - x, h: y },
        { view: "front", x: 0, y, w: x, h: 1 - y },
        { view: "side", x, y, w: 1 - x, h: 1 - y },
      ];
  }
}

/** one pane filling the container — what maximising does, and what the loop draws instead of `cellsOf` */
export const soloCell = (view: ViewKind): Cell[] => [{ view, x: 0, y: 0, w: 1, h: 1 }];

/**
 * The draggable divisions of a layout.
 *
 * A splitter is described by the split it moves and the strip it occupies, so the component that draws it
 * needs to know nothing about which layout it is in — which matters because the horizontal splitter spans
 * the whole container in a four-pane layout and only the right column in a three-pane one.
 */
export type Splitter = { axis: "x" | "y"; x: number; y: number; w: number; h: number };

export function splittersOf(kind: LayoutKind, split: Split = DEFAULT_SPLIT): Splitter[] {
  const { x, y } = clampSplit(split);
  switch (kind) {
    case "one":
      return [];
    case "two":
      return [{ axis: "x", x, y: 0, w: 0, h: 1 }];
    case "three":
      return [
        { axis: "x", x, y: 0, w: 0, h: 1 },
        { axis: "y", x, y, w: 1 - x, h: 0 },
      ];
    case "four":
      return [
        { axis: "x", x, y: 0, w: 0, h: 1 },
        { axis: "y", x: 0, y, w: 1, h: 0 },
      ];
  }
}

export const clampSplit = (split: Split): Split => ({
  x: clamp(split.x, MIN_FRACTION, 1 - MIN_FRACTION),
  y: clamp(split.y, MIN_FRACTION, 1 - MIN_FRACTION),
});

/** the next layout round, so one key can walk the whole set rather than four keys naming them */
export function cycleLayout(kind: LayoutKind, step = 1): LayoutKind {
  const at = LAYOUTS.indexOf(kind);
  const next = (at + step + LAYOUTS.length * 2) % LAYOUTS.length;
  return LAYOUTS[next]!;
}

/** which pane a point in the container falls in, or nothing if it fell on a splitter's own strip */
export function cellAt(cells: Cell[], at: { x: number; y: number }): number {
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (at.x >= cell.x && at.x < cell.x + cell.w && at.y >= cell.y && at.y < cell.y + cell.h) return i;
  }
  return -1;
}

/** a cell in CSS pixels, rounded so that neighbouring panes share an edge rather than overlapping it */
export function rectOf(cell: Cell, size: { width: number; height: number }) {
  const left = Math.round(cell.x * size.width);
  const top = Math.round(cell.y * size.height);
  return {
    left,
    top,
    width: Math.round((cell.x + cell.w) * size.width) - left,
    height: Math.round((cell.y + cell.h) * size.height) - top,
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
