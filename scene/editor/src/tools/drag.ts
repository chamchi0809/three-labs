/**
 * Turning a pointer that moved on a screen into something that moved in a world.
 *
 * Every dragging tool in the editor is one of exactly two gestures, and this file is both of them.
 *
 * **A drag on a plane** — moving a solid, dragging out a shape, placing an entity. The pointer ray is met
 * with a plane and the difference between where it lands now and where it landed when the drag began is
 * the translation. Which plane is the whole design of a move tool: in an orthographic pane it can only
 * sensibly be the pane's own plane, and in a perspective pane it is the ground under the thing being
 * moved, until the designer says otherwise and it becomes a wall facing them.
 *
 * **A drag along a line** — extruding a face, dragging a vertex on an axis. The pointer has two degrees of
 * freedom and the answer has one, so the ray and the axis are brought as close together as they get and
 * the position along the axis at that point is the answer. That is the standard closest-approach of two
 * skew lines, and it is what makes an extrude follow the mouse rather than the mouse's shadow.
 *
 * Both are pure functions of the {@link View}, so `drag.check.ts` runs them under bare node. No three.js,
 * no document, no renderer.
 */
import type { Vec3 } from "tscene";
import { snap, snapDelta, snapTowards } from "../grid/snap.ts";
import { basisOf, type Point, type Ray, type Size, type View } from "../viewport/view.ts";
import { rayThrough } from "../viewport/view.ts";

/** an infinite plane, as a point on it and a direction off it; the normal need not be unit */
export type DragPlane = { origin: Vec3; normal: Vec3 };

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}

// ---------------------------------------------------------------- choosing a plane

/**
 * The plane a move drag runs in, through `origin`.
 *
 * In an orthographic pane there is one honest answer — the pane's own plane — because the third axis is
 * the one the designer cannot see and moving along it invisibly is how solids end up a hundred metres
 * behind a wall.
 *
 * In a perspective pane the default is the ground, because level geometry is laid out on floors, and
 * `vertical` swaps it for a plane standing up and facing the camera, which is what a designer wants the
 * moment they are moving a light or a wall sconce. The vertical plane faces the camera rather than an axis
 * so that the drag stays responsive from every angle: a plane seen edge-on turns a pixel of motion into
 * a hundred metres.
 */
export function movePlane(view: View, origin: Vec3, vertical = false): DragPlane {
  const { forward } = basisOf(view);
  if (view.kind !== "3d") return { origin, normal: [-forward[0], -forward[1], -forward[2]] };
  if (!vertical) return { origin, normal: [0, 1, 0] };
  const flat: Vec3 = [-forward[0], 0, -forward[2]];
  // looking straight down there is no horizontal facing direction left, so fall back to the pane's up
  return { origin, normal: Math.hypot(flat[0], flat[2]) > 1e-6 ? unit(flat) : [0, 0, 1] };
}

/** the plane a face lies in, which is what an extrude measures along and a face drag stays inside */
export const planeThrough = (origin: Vec3, normal: Vec3): DragPlane => ({ origin, normal });

// ---------------------------------------------------------------- meeting a plane

/**
 * Where a ray meets a plane, or nothing when it runs along it.
 *
 * A drag that has lost its plane must stop rather than guess: the frame where a designer's aim slides past
 * the horizon is the frame where a guess puts a wall in the next county.
 */
export function meetPlane(ray: Ray, plane: DragPlane): Vec3 | undefined {
  const denominator = dot(ray.direction, plane.normal);
  if (Math.abs(denominator) < 1e-9) return undefined;
  const t = dot(sub(plane.origin, ray.origin), plane.normal) / denominator;
  // behind an orthographic ray is fine — it starts a kilometre back on purpose — but not behind an eye
  if (t < -1e6) return undefined;
  return add(ray.origin, mul(ray.direction, t));
}

/** where a screen point lands on a plane, which is the whole of a plane drag in one call */
export const pointOnDragPlane = (view: View, at: Point, size: Size, plane: DragPlane): Vec3 | undefined =>
  meetPlane(rayThrough(view, at, size), plane);

/**
 * How far the world moved between two screen points, dragging on a plane.
 *
 * Undefined when either end of the drag has no answer, so the caller holds its last good delta instead of
 * jumping — which is what makes a drag survive the pointer passing over the horizon.
 */
export function planeDelta(
  view: View, size: Size, from: Point, to: Point, plane: DragPlane,
): Vec3 | undefined {
  const a = pointOnDragPlane(view, from, size, plane);
  const b = pointOnDragPlane(view, to, size, plane);
  return a && b ? sub(b, a) : undefined;
}

// ---------------------------------------------------------------- along a line

/**
 * How far along `axis` from `origin` the pointer is, taking the closest approach of the pointer ray and
 * the axis line.
 *
 * `axis` need not be unit; the answer is in metres along it either way. Nothing when the two lines are
 * parallel, which on screen is the axis pointing straight at the designer — the one direction along which
 * a mouse cannot say anything at all.
 */
export function axisDistance(ray: Ray, origin: Vec3, axis: Vec3): number | undefined {
  const a = unit(axis);
  const w = sub(ray.origin, origin);
  const b = dot(a, ray.direction);
  const denominator = 1 - b * b;
  if (denominator < 1e-9) return undefined;
  const d = dot(a, w);
  const e = dot(ray.direction, w);
  // `w` runs from the axis to the ray, which is the opposite of the direction the textbook derivation
  // writes it in; the signs here are that derivation with `w` negated, and getting it wrong is an extrude
  // that pushes when it should pull
  return (d - b * e) / denominator;
}

/** how far along an axis the world moved between two screen points */
export function axisDelta(
  view: View, size: Size, from: Point, to: Point, origin: Vec3, axis: Vec3,
): number | undefined {
  const a = axisDistance(rayThrough(view, from, size), origin, axis);
  const b = axisDistance(rayThrough(view, to, size), origin, axis);
  return a === undefined || b === undefined ? undefined : b - a;
}

// ---------------------------------------------------------------- putting it on the grid

/**
 * A translation snapped so that the thing being moved lands on the grid, rather than the translation
 * itself being a whole number of cells.
 *
 * `anchor` is the point that is being made to land — a corner of the selection's box, not its centre, so
 * that dragging a box against a wall puts its side on a grid line where the wall is. Snapping the
 * translation instead would move things by whole cells and never fix an alignment, which is the one thing
 * a designer reaches for the grid to do.
 */
export const snapMove = (anchor: Vec3, delta: Vec3, size: number): Vec3 => [
  snapDelta(anchor[0], delta[0], size),
  snapDelta(anchor[1], delta[1], size),
  snapDelta(anchor[2], delta[2], size),
];

export const snapPoint = (p: Vec3, size: number): Vec3 => [
  snap(p[0], size), snap(p[1], size), snap(p[2], size),
];

/**
 * A distance along a face's normal, snapped outwards.
 *
 * Rounding to nearest is wrong here and the failure is specific: the first pixel of a pull rounds back to
 * zero, so the face does not move until the pointer is half a cell away and then it jumps. Snapping in the
 * direction of travel means the face leaves on the first pixel and lands on a grid line.
 */
export const snapExtrude = (at: number, distance: number, size: number): number =>
  snapTowards(at + distance, size, distance) - at;

/**
 * The axis of a drag when it is constrained to one: the world axis the free motion lies along most.
 *
 * This is what shift does in every editor, and doing it by projection rather than by asking which axis the
 * camera is nearest means the answer follows the drag rather than the view — so a designer who starts
 * pulling sideways gets sideways, whichever way they happen to be facing.
 */
export function majorAxis(delta: Vec3): 0 | 1 | 2 {
  const a = Math.abs(delta[0]);
  const b = Math.abs(delta[1]);
  const c = Math.abs(delta[2]);
  return a >= b && a >= c ? 0 : b >= c ? 1 : 2;
}

/** a delta with everything but one axis dropped */
export function onlyAxis(delta: Vec3, axis: 0 | 1 | 2): Vec3 {
  const out: Vec3 = [0, 0, 0];
  out[axis] = delta[axis];
  return out;
}
