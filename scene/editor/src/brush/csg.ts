/**
 * Constructive solid geometry on convex solids.
 *
 * Everything here is written in terms of `clip`, because a convex solid minus a convex solid is exactly
 * "the part outside face 1, plus the part inside face 1 but outside face 2, plus …" — one fragment per
 * face of the subtrahend, each of them still convex. No BSP tree, no triangle soup, and the result is a
 * set of brushes a level designer can carry on editing rather than a mesh they can only look at.
 *
 * Face attribution rides along in `PolyFace.source`. The caller numbers the two operands' faces apart
 * before calling — see `sourced` — so every face of every fragment can say which face of which brush it
 * came from, and the brush layer copies the material and UV across.
 */
import type { Plane, Vec3 } from "tscene";
import {
  EPSILON, clip, dedupePlanes, fromPlanes, hullPlanes, integrity, polyBounds, volume,
  type BuildResult, type Polyhedron,
} from "./polyhedron.ts";
import { dot, flip, planeDistance } from "./vec.ts";

/** a plane and the face it is meant to inherit from — `source` is the caller's numbering, not an index */
export type SourcedPlane = { plane: Plane; source: number };

/** the smallest solid worth keeping: a cubic millimetre, well under the finest grid cell */
export const MIN_VOLUME = 1e-9;

/** the faces of `poly` as sourced planes, renumbered so two operands' faces cannot be confused */
export const sourced = (poly: Polyhedron, offset = 0): SourcedPlane[] =>
  poly.faces.map((f) => ({ plane: f.plane, source: f.source + offset }));

/** `fromPlanes`, with the caller's numbering carried through instead of the index in the plane list */
export function build(planes: SourcedPlane[]): BuildResult {
  const result = fromPlanes(planes.map((p) => p.plane));
  if (!result.poly) return result;
  const faces = result.poly.faces.map((f) => ({ ...f, source: planes[f.source]?.source ?? -1 }));
  return { poly: { vertices: result.poly.vertices, faces }, problems: result.problems };
}

// ---------------------------------------------------------------- overlap

/**
 * Whether two solids share any volume. A convex solid's own faces are the only separating planes it can
 * need, so this is a face loop rather than a search.
 *
 * Touching does not count as overlapping: two brushes laid flush against each other are how every wall
 * in every level is built, and a subtraction that carved one of them would be unusable.
 */
export function overlaps(a: Polyhedron, b: Polyhedron): boolean {
  const separates = (planes: Polyhedron, points: Polyhedron) =>
    planes.faces.some((f) => points.vertices.every((v) => planeDistance(f.plane, v) >= -EPSILON));
  return !separates(a, b) && !separates(b, a);
}

/** whether `inner` is wholly inside `outer` — the test behind "this subtraction leaves nothing" */
export const contains = (outer: Polyhedron, inner: Polyhedron): boolean =>
  inner.vertices.every((v) => outer.faces.every((f) => planeDistance(f.plane, v) <= EPSILON));

// ---------------------------------------------------------------- the operations

/**
 * `a` with `b` cut out of it, as a set of convex fragments.
 *
 * One fragment per face of `b`: the part of what is left that falls outside that face. Faces of `b`
 * become faces of the fragments, flipped, so the inside of the hole is textured from the brush that
 * made it — which is what a designer expects when they carve a doorway with a textured brush.
 */
export function subtract(a: Polyhedron, b: Polyhedron): Polyhedron[] {
  if (!overlaps(a, b)) return [a];
  const fragments: Polyhedron[] = [];
  let remainder: Polyhedron = a;
  for (const face of b.faces) {
    const outside = clip(remainder, flip(face.plane), face.source);
    if (outside.poly && outside.cut && volume(outside.poly) > MIN_VOLUME) fragments.push(outside.poly);
    const inside = clip(remainder, face.plane, face.source);
    // nothing of `a` is on this side, so `b` never really touched it after all
    if (!inside.poly) return [a];
    remainder = inside.poly;
  }
  return fragments;
}

/** the solid both `a` and `b` enclose, or `undefined` if they miss each other */
export function intersect(a: Polyhedron, b: Polyhedron, offset = 1e6): Polyhedron | undefined {
  if (!overlaps(a, b)) return undefined;
  const result = build([...sourced(a), ...sourced(b, offset)]);
  return result.poly && volume(result.poly) > MIN_VOLUME ? result.poly : undefined;
}

/**
 * The convex hull of several solids.
 *
 * Only a convex union is a brush, so this is the one CSG operation that can quietly give you more than
 * you asked for: merging two boxes that meet at a corner fills in the corner. `exact` says whether it
 * did, so the editor can warn rather than silently adding solid to the level.
 */
export function merge(polys: Polyhedron[], offset = 1e6): { poly?: Polyhedron; exact: boolean } {
  const faces = polys.flatMap((p, i) => sourced(p, i * offset));
  const planes = hullPlanes(polys.flatMap((p) => p.vertices));
  if (!planes) return { exact: false };
  const result = build(planes.map((plane) => ({ plane, source: attribute(plane, faces) })));
  if (!result.poly) return { exact: false };
  // the parts are brushes, so they do not overlap; anything the hull adds is volume nobody drew
  const parts = polys.reduce((sum, p) => sum + volume(p), 0);
  return { poly: result.poly, exact: Math.abs(volume(result.poly) - parts) <= 1e-6 * Math.max(1, parts) };
}

/** which of `faces` a hull plane came from, or -1 if the hull invented it */
function attribute(plane: Plane, faces: SourcedPlane[]): number {
  const same = faces.find((f) => dot(f.plane.n, plane.n) > 1 - 1e-6 && Math.abs(f.plane.d - plane.d) < 1e-4);
  return same?.source ?? -1;
}

/**
 * `poly` with every face pushed out (or, negatively, pulled in) by `by` metres along its own normal.
 *
 * Not a scale: a wall shrunk this way keeps its thickness uniform, which is what a hollow needs and what
 * scaling about the centre would not give.
 */
export function offsetFaces(poly: Polyhedron, by: number): Polyhedron | undefined {
  const result = build(sourced(poly).map((f) => ({ source: f.source, plane: { n: f.plane.n, d: f.plane.d + by } })));
  return result.poly && volume(result.poly) > MIN_VOLUME ? result.poly : undefined;
}

/**
 * `poly` turned into a shell `thickness` metres thick: the solid minus a copy of itself shrunk inward.
 * A brush too small to have a cavity comes back whole, because a wall thicker than the room is a wall.
 */
export function hollow(poly: Polyhedron, thickness: number): Polyhedron[] {
  const cavity = thickness > 0 ? offsetFaces(poly, -thickness) : undefined;
  return cavity ? subtract(poly, cavity) : [poly];
}

/**
 * The two halves `plane` cuts `poly` into — the clip tool's whole job. The kept half comes first, and
 * the cut face carries `source` so the editor can give it the material of the face it was drawn on.
 */
export function split(poly: Polyhedron, plane: Plane, source = -1): { front?: Polyhedron; back?: Polyhedron } {
  const back = clip(poly, plane, source);
  const front = clip(poly, flip(plane), source);
  return {
    front: front.poly && volume(front.poly) > MIN_VOLUME ? front.poly : undefined,
    back: back.poly && volume(back.poly) > MIN_VOLUME ? back.poly : undefined,
  };
}

// ---------------------------------------------------------------- vertex editing

/**
 * The solid whose corners are `points` — how moving, adding and removing vertices is done. The hull is
 * taken, the coplanar triangles it produces are collapsed back into single planes, and the solid is
 * rebuilt from those, so dragging a corner flat against its neighbours merges the faces the way a
 * modeller expects rather than leaving a crease.
 *
 * `keep` supplies the faces to inherit attributes from — normally the faces of the solid before the drag.
 */
export function fromPoints(points: Vec3[], keep: SourcedPlane[] = []): Polyhedron | undefined {
  const planes = hullPlanes(points);
  if (!planes) return undefined;
  const result = build(dedupePlanes(planes).map((plane) => ({ plane, source: nearest(plane, keep) })));
  return result.poly && volume(result.poly) > MIN_VOLUME ? result.poly : undefined;
}

/**
 * The face of `keep` this plane most looks like. Unlike `attribute` this never gives up: a dragged
 * vertex tilts a face without replacing it, so the closest normal is the right answer and losing the
 * material off a face the designer only nudged would be the wrong one.
 */
function nearest(plane: Plane, keep: SourcedPlane[]): number {
  let best = -1;
  let bestDot = 0.2; // past 78° apart it is a different face, not the same one tilted
  for (const f of keep) {
    const d = dot(f.plane.n, plane.n);
    if (d > bestDot) ((bestDot = d), (best = f.source));
  }
  return best;
}

/** a box that contains every solid — the selection bounds the transform tools work in */
export function unionBounds(polys: Polyhedron[]): { min: Vec3; max: Vec3 } | undefined {
  let out: { min: Vec3; max: Vec3 } | undefined;
  for (const p of polys) {
    const b = polyBounds(p);
    if (!out) out = { min: [...b.min], max: [...b.max] };
    else {
      for (let k = 0; k < 3; k++) {
        out.min[k] = Math.min(out.min[k]!, b.min[k]!);
        out.max[k] = Math.max(out.max[k]!, b.max[k]!);
      }
    }
  }
  return out;
}

/** every fragment of a CSG result that is actually a solid, with the reasons the rest were dropped */
export function keepSolid(polys: Polyhedron[]): { kept: Polyhedron[]; dropped: string[] } {
  const kept: Polyhedron[] = [];
  const dropped: string[] = [];
  for (const [i, p] of polys.entries()) {
    const bad = integrity(p);
    if (bad.length) dropped.push(`fragment ${i}: ${bad[0]}`);
    else kept.push(p);
  }
  return { kept, dropped };
}
