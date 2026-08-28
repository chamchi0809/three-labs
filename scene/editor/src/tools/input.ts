/**
 * What a tool is told about the mouse.
 *
 * TrenchBroom's `InputState` accumulates the pointer, the buttons, the modifiers and the current pick into
 * one value that every controller reads. That shape is right and it is kept here, with one change: this
 * `InputState` carries the *pure* camera — the {@link View} from `viewport/view.ts` — rather than a
 * three.js camera. So a tool is a function of plain data, and a whole drag can be replayed in a check
 * without a GPU, a canvas or a document.
 *
 * A tool never reads the DOM and never reads a renderer. Everything it is allowed to know is in here.
 */
import type { Vec3 } from "tscene";
import type { NodeId } from "../doc/document.ts";
import type { Handle } from "../render/handles.ts";
import type { Point, Size, View, ViewKind } from "../viewport/view.ts";
import { pointOnPlane, rayThrough, type Ray } from "../viewport/view.ts";

/** which of the three keys are down; named rather than a bitfield because tools read them by name */
export type Mods = { shift: boolean; ctrl: boolean; alt: boolean };

export const NO_MODS: Mods = { shift: false, ctrl: false, alt: false };

/**
 * What the pick pass found under the pointer.
 *
 * `point` is where on the solid the ray met it. It is optional because a hover only needs to know *what*
 * is under the mouse, and working out *where* costs a ray-triangle pass the pick target cannot answer —
 * the tools that need it (extrude, entity placement) ask for it when a drag starts, not every frame.
 */
export type Hit = {
  node?: NodeId;
  face?: number;
  point?: Vec3;
  handle?: Handle;
};

export type InputState = {
  /** which pane, which is what decides whether a drag is in a plane or in a perspective */
  view: ViewKind;
  camera: View;
  size: Size;
  /** pane-local CSS pixels, top-left origin */
  at: Point;
  mods: Mods;
  /** the button that is down, if one is; `0` left, `1` middle, `2` right, as the DOM numbers them */
  button?: number;
  hit?: Hit;
};

export const newInput = (over: Partial<InputState> & Pick<InputState, "camera" | "size" | "at">): InputState => ({
  view: over.camera.kind,
  mods: NO_MODS,
  ...over,
});

/** the ray under the pointer, which is what every drag that has to find a depth starts from */
export const rayOf = (input: InputState): Ray => rayThrough(input.camera, input.at, input.size);

/** the point under the pointer in the plane through the pivot — the cheap answer, and often the right one */
export const planePointOf = (input: InputState): Vec3 => pointOnPlane(input.camera, input.at, input.size);

/** how far, in CSS pixels, two pointer positions are apart */
export const pixelsBetween = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * How far a pointer must travel before a press becomes a drag.
 *
 * Without a threshold every click is a one-pixel move of whatever was under it, and a designer who selects
 * a wall by clicking it has nudged it by a millimetre. Four pixels is TrenchBroom's number and it is a good
 * one: below a trackpad's own jitter is too small, above it and a deliberate short drag is swallowed.
 */
export const DRAG_THRESHOLD = 4;

/** a rectangle from the two corners a drag has reached, in whichever order they were reached */
export type Rect = { left: number; top: number; right: number; bottom: number };

export const rectBetween = (a: Point, b: Point): Rect => ({
  left: Math.min(a.x, b.x),
  top: Math.min(a.y, b.y),
  right: Math.max(a.x, b.x),
  bottom: Math.max(a.y, b.y),
});

export const rectContains = (r: Rect, p: Point): boolean =>
  p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

export const rectArea = (r: Rect): number => (r.right - r.left) * (r.bottom - r.top);
