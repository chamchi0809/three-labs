/**
 * Where a material sits on a face, and every way of moving it.
 *
 * The mapping itself lives in `tscene` — `uvBasis` and `uvAt` — and is deliberately *not* reimplemented
 * here, because the editor showing a material half a tile away from where the runtime renders it is the
 * one bug in a level editor nobody ever tracks down. Everything below reads through those two functions
 * and writes back the four numbers a sheet stores: `uv`, `offset`, `scale`, `rotation`.
 *
 * The mapping is `uv = (p · axis + offset) / scale`, with unit axes, so:
 *
 * - `offset` is in **metres along the face's own axes**, not pixels. A sheet is a scene description, and
 *   it has no idea how many pixels the material it names turns out to have.
 * - `scale` is **metres of world per full tile**, not a multiplier. `scale: 2` is a two-metre tile
 *   whatever the image resolution, which is the number a designer can reason about against a grid also
 *   measured in metres.
 *
 * Every operation is pure: attributes never change the solid, so nothing here can fail.
 */
import { uvAt, uvBasis, type BrushFace, type Vec2, type Vec3 } from "tscene";
import { faceCentre, faceNormal, facePolygon, transformBrush, type Brush, type BrushEdit, type FaceAttributes } from "./brush.ts";
import {
  cross, determinant, dot, intersectPlanes, length, normalize, rotation, transformDirection, transformPoint,
  type Mat4,
} from "./vec.ts";

/** which way to push a material against the edges of the face it is on */
export type Justify = "left" | "right" | "top" | "bottom" | "centre" | "middle";

/** the shape `tscene`'s uv functions read; the points are never looked at, only the four attributes */
const asFace = (a: FaceAttributes): BrushFace => ({
  points: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
  uv: a.uv,
  offset: a.offset,
  scale: a.scale,
  rotation: a.rotation,
});

/** the unit axes a face projects world positions onto, with its rotation already in them */
export const faceBasis = (brush: Brush, face: number): { u: Vec3; v: Vec3 } =>
  uvBasis(asFace(attributesOf(brush, face)), faceNormal(brush, face));

const attributesOf = (brush: Brush, face: number): FaceAttributes =>
  brush.faces[face] ?? { uv: { kind: "paraxial" }, offset: [0, 0], scale: [1, 1], rotation: 0 };

/** where a world point lands on a face's material, in tiles */
export const uvOf = (brush: Brush, face: number, p: Vec3): Vec2 =>
  uvAt(p, faceBasis(brush, face), asFace(attributesOf(brush, face)));

/**
 * The world point on a face's plane that a tile coordinate names — the inverse of `uvOf`, and what a
 * drag in the uv editor needs in order to say where on the wall the cursor is.
 */
export function worldAt(brush: Brush, face: number, uv: Vec2): Vec3 {
  const { u, v } = faceBasis(brush, face);
  const a = attributesOf(brush, face);
  const plane = brush.poly.faces[face]?.plane;
  if (!plane) return [0, 0, 0];
  // three conditions, three unknowns: the point projects to the right place along each axis and lies on
  // the face. Solving all three at once is what makes this work for a paraxial face, whose axes are the
  // world's rather than the face's and so are not perpendicular to its normal.
  const su = uv[0] * (a.scale[0] || 1) - a.offset[0];
  const sv = uv[1] * (a.scale[1] || 1) - a.offset[1];
  return intersectPlanes({ n: u, d: su }, { n: v, d: sv }, plane) ?? faceCentre(brush, face);
}

/** the tile rectangle a face covers: `min` and `max` in tiles, and the same in metres along its axes */
export function uvBounds(brush: Brush, face: number): { min: Vec2; max: Vec2; metres: Vec2 } {
  const polygon = facePolygon(brush, face);
  const { u, v } = faceBasis(brush, face);
  const a = attributesOf(brush, face);
  let lo: Vec2 = [Infinity, Infinity];
  let hi: Vec2 = [-Infinity, -Infinity];
  let loM: Vec2 = [Infinity, Infinity];
  let hiM: Vec2 = [-Infinity, -Infinity];
  for (const p of polygon) {
    const m: Vec2 = [dot(p, u), dot(p, v)];
    const t: Vec2 = [(m[0] + a.offset[0]) / (a.scale[0] || 1), (m[1] + a.offset[1]) / (a.scale[1] || 1)];
    for (const k of [0, 1] as const) {
      lo[k] = Math.min(lo[k], t[k]);
      hi[k] = Math.max(hi[k], t[k]);
      loM[k] = Math.min(loM[k], m[k]);
      hiM[k] = Math.max(hiM[k], m[k]);
    }
  }
  if (!polygon.length) ((lo = [0, 0]), (hi = [0, 0]), (loM = [0, 0]), (hiM = [0, 0]));
  return { min: lo, max: hi, metres: [hiM[0] - loM[0], hiM[1] - loM[1]] };
}

// ---------------------------------------------------------------- writing attributes

/** one face changed, everything else untouched — the shape every operation below returns */
export function withFace(brush: Brush, face: number, over: Partial<FaceAttributes>): Brush {
  const faces = brush.faces.map((f, i) => (i === face ? { ...f, ...over } : f));
  return { poly: brush.poly, faces };
}

/** the same change applied to several faces, so the inspector can drive a whole selection */
export const withFaces = (brush: Brush, faces: number[], over: Partial<FaceAttributes>): Brush =>
  faces.reduce((b, i) => withFace(b, i, over), brush);

/** the offset that puts `p` at `uv`, given the axes and scale already decided */
function offsetFor(brush: Brush, face: number, p: Vec3, uv: Vec2, over: Partial<FaceAttributes>): Vec2 {
  const next = withFace(brush, face, over);
  const { u, v } = faceBasis(next, face);
  const a = attributesOf(next, face);
  return [uv[0] * (a.scale[0] || 1) - dot(p, u), uv[1] * (a.scale[1] || 1) - dot(p, v)];
}

/**
 * The attributes changed while a world point keeps the tile coordinate it had. Every operation that
 * changes the axes or the scale goes through this, which is why rotating a face turns the material about
 * the middle of the wall rather than about wherever the world origin happens to be.
 */
function keeping(brush: Brush, face: number, anchor: Vec3, over: Partial<FaceAttributes>): Brush {
  const uv = uvOf(brush, face, anchor);
  return withFace(brush, face, { ...over, offset: offsetFor(brush, face, anchor, uv, over) });
}

// ---------------------------------------------------------------- the operations

export const resetUv = (brush: Brush, face: number): Brush =>
  withFace(brush, face, { uv: { kind: "paraxial" }, offset: [0, 0], scale: [1, 1], rotation: 0 });

/** the material slid along the face, in metres */
export function nudgeUv(brush: Brush, face: number, by: Vec2): Brush {
  const a = attributesOf(brush, face);
  return withFace(brush, face, { offset: [a.offset[0] + by[0], a.offset[1] + by[1]] });
}

/** the material turned about a point on the face — its centre unless the tool says otherwise */
export const rotateUv = (brush: Brush, face: number, radians: number, about?: Vec3): Brush =>
  keeping(brush, face, about ?? faceCentre(brush, face), { rotation: attributesOf(brush, face).rotation + radians });

/** the tile size multiplied — bigger metres per tile is a bigger material on the wall */
export const scaleUv = (brush: Brush, face: number, by: Vec2, about?: Vec3): Brush => {
  const a = attributesOf(brush, face);
  const scale: Vec2 = [(a.scale[0] || 1) * (by[0] || 1), (a.scale[1] || 1) * (by[1] || 1)];
  return keeping(brush, face, about ?? faceCentre(brush, face), { scale });
};

/** the tile size set outright, in metres per tile */
export const setUvScale = (brush: Brush, face: number, scale: Vec2, about?: Vec3): Brush =>
  keeping(brush, face, about ?? faceCentre(brush, face), { scale: [...scale] });

/** the material mirrored across the middle of the face */
export function flipUv(brush: Brush, face: number, axis: "u" | "v"): Brush {
  const a = attributesOf(brush, face);
  const scale: Vec2 = axis === "u" ? [-(a.scale[0] || 1), a.scale[1]] : [a.scale[0], -(a.scale[1] || 1)];
  return keeping(brush, face, faceCentre(brush, face), { scale });
}

/** a world point pinned to a tile coordinate — what dragging in the uv editor resolves to */
export const setUvAt = (brush: Brush, face: number, p: Vec3, uv: Vec2): Brush =>
  withFace(brush, face, { offset: offsetFor(brush, face, p, uv, {}) });

/**
 * One tile stretched to cover the whole face exactly. The face's current rotation is kept, so fitting a
 * rotated material stretches it along the axes it is already lying on rather than snapping it upright.
 */
export function fitUv(brush: Brush, face: number): Brush {
  const { metres } = uvBounds(brush, face);
  const scale: Vec2 = [metres[0] || 1, metres[1] || 1];
  const fitted = withFace(brush, face, { scale, offset: [0, 0] });
  return justifyUv(justifyUv(fitted, face, "left"), face, "bottom");
}

/**
 * The material pushed against one side of the face, so a tile boundary lands on that edge. `centre`
 * centres it across the face horizontally and `middle` vertically, which is the pair of words that keeps
 * the two axes apart in the inspector.
 */
export function justifyUv(brush: Brush, face: number, side: Justify): Brush {
  const { min, max } = uvBounds(brush, face);
  const a = attributesOf(brush, face);
  const axis = side === "left" || side === "right" || side === "centre" ? 0 : 1;
  const scale = a.scale[axis] || 1;
  // `min`/`max` are in tiles and already include the current offset, so the shift is a tile shift
  const shift =
    side === "left" || side === "bottom" ? -min[axis]
    : side === "right" || side === "top" ? 1 - max[axis]
    : (1 - (min[axis] + max[axis])) / 2;
  const offset: Vec2 = [...a.offset];
  offset[axis] = a.offset[axis]! + shift * scale;
  return withFace(brush, face, { offset });
}

/** everything but the material copied from one face to another — TrenchBroom's alt-click, half of it */
export function copyUv(brush: Brush, from: number, to: number): Brush {
  const a = attributesOf(brush, from);
  return withFace(brush, to, { uv: a.uv, offset: [...a.offset], scale: [...a.scale], rotation: a.rotation });
}

/** the material as well: the whole of alt-click */
export const copyFace = (brush: Brush, from: number, to: number): Brush =>
  withFace(copyUv(brush, from, to), to, { material: attributesOf(brush, from).material });

// ---------------------------------------------------------------- uv lock

/**
 * The attributes a face needs after `m` so that the material stays on the same square metre of wall.
 *
 * A translation is the easy case and is kept easy: the axes do not move, so only the offset changes and
 * a paraxial face stays paraxial — which matters, because paraxial is what keeps a whole room's walls
 * agreeing with each other, and silently converting a wall to `parallel` because it was nudged would
 * throw that away.
 *
 * Anything else — a rotation, a scale, a mirror — moves the axes off the world axes, which is precisely
 * what paraxial cannot describe. Those faces are written out as `parallel` with the axes stated, because
 * an editor that quietly approximates is worse than one that changes the words in the sheet.
 */
export function lockedAttributes(before: Brush, face: number, m: Mat4): Partial<FaceAttributes> {
  const a = attributesOf(before, face);
  const { u, v } = faceBasis(before, face);
  const anchor = faceCentre(before, face);
  const uv = uvOf(before, face, anchor);

  if (isTranslation(m)) {
    const moved = transformPoint(m, anchor);
    return { offset: [uv[0] * (a.scale[0] || 1) - dot(moved, u), uv[1] * (a.scale[1] || 1) - dot(moved, v)] };
  }

  // the axes carried through the transform; their new lengths are how much the world stretched along
  // them, which is exactly how much bigger a tile has to be to still cover the same wall
  const mu = transformDirection(m, u);
  const mv = transformDirection(m, v);
  const nu = normalize(mu);
  const nv = normalize(mv);
  if (!nu || !nv) return {};
  const scale: Vec2 = [(a.scale[0] || 1) * length(mu), (a.scale[1] || 1) * length(mv)];
  const moved = transformPoint(m, anchor);
  return {
    uv: { kind: "parallel", u: nu, v: nv },
    rotation: 0, // the rotation is in the axes now
    scale,
    offset: [uv[0] * scale[0] - dot(moved, nu), uv[1] * scale[1] - dot(moved, nv)],
  };
}

/** every face's attributes carried through a transform, given the brush as it was and as it now is */
export function lockUv(before: Brush, after: Brush, m: Mat4): Brush {
  if (before.poly.faces.length !== after.poly.faces.length) return after;
  return {
    poly: after.poly,
    faces: after.faces.map((f, i) => ({ ...f, ...lockedAttributes(before, i, m) })),
  };
}

/** a transform that only moves — the linear part is the identity, to within a rounding error */
export function isTranslation(m: Mat4): boolean {
  if (Math.abs(determinant(m) - 1) > 1e-9) return false;
  const linear = [m[0] - 1, m[1], m[2], m[4], m[5] - 1, m[6], m[8], m[9], m[10] - 1];
  return linear.every((x) => Math.abs(x) < 1e-9);
}

/** whether a transform turns the world inside out, so the caller knows to reverse the winding */
export const mirrors = (m: Mat4): boolean => determinant(m) < 0;

/**
 * The same lock for an edit that has no matrix behind it — dragging a vertex, snapping to the grid,
 * anything that tilts a face without moving the brush.
 *
 * There is no single transform to carry the axes through, so each face gets its own: the shortest
 * rotation from where it used to point to where it points now, about its own middle. Which face *is*
 * which comes from the `from` map the edit returns, because an edit that rebuilds the solid renumbers
 * its faces, and a lock applied to the wrong wall is worse than no lock at all.
 *
 * A face that did not tilt is returned untouched rather than recomputed — the common case, and one that
 * has to stay exact, or nudging a wall along its own normal would perturb the material by a rounding
 * error every single time.
 */
export function lockUvToPlanes(before: Brush, edit: BrushEdit): BrushEdit {
  const after = edit.brush;
  if (!after || !edit.from) return edit;
  const faces = after.faces.map((f, i) => {
    const was = edit.from![i]!;
    if (was < 0 || was >= before.poly.faces.length) return f; // a face the kernel invented has no earlier self
    const from = faceNormal(before, was);
    const to = faceNormal(after, i);
    const turn = cross(from, to);
    const axis = normalize(turn);
    if (!axis) return f; // still pointing the same way — or turned right round, where no rotation is the answer either
    const angle = Math.atan2(length(turn), dot(from, to));
    return { ...f, ...lockedAttributes(before, was, rotation(axis, angle, faceCentre(before, was))) };
  });
  return { ...edit, brush: { poly: after.poly, faces } };
}

/** a brush transformed with the materials staying where they are on the walls */
export function transformLocked(brush: Brush, m: Mat4): BrushEdit {
  const moved = transformBrush(brush, m);
  return moved.brush ? { brush: lockUv(brush, moved.brush, m), problems: moved.problems } : moved;
}

/**
 * The axes a face is using right now, written out as the `parallel(u, v)` that would reproduce them —
 * what the inspector offers as "pin these axes", and what turns a derived alignment into a stated one so
 * that later edits cannot re-derive it into something else.
 */
export const pinAxes = (brush: Brush, face: number): Brush => {
  const { u, v } = faceBasis(brush, face);
  return withFace(brush, face, { uv: { kind: "parallel", u, v }, rotation: 0 });
};
