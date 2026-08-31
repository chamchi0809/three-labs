/**
 * Vector arithmetic for the brush kernel.
 *
 * Deliberately plain tuples rather than three's `Vector3`: the kernel runs in checks under bare node,
 * it is called hundreds of times per drag, and `Vec3` is already the shape `tscene`'s brush faces are
 * written in — so there is no conversion at either end.
 *
 * No imports beyond the two types, so `*.check.ts` runs this under `node --experimental-strip-types`.
 */
import type { Plane, Vec3 } from "tscene";

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

/** `undefined` rather than a zero vector, so a caller cannot silently carry on with a direction it lacks */
export function normalize(a: Vec3): Vec3 | undefined {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : undefined;
}

/**
 * The same point with its negative zeros turned back into zeros. `-0` is the same number as `0`, but it
 * prints as `-0` in the inspector, writes `-0` into the sheet, and fails an equality check against `0` —
 * so it is scrubbed wherever a coordinate is computed rather than typed.
 */
export const clean = (p: Vec3): Vec3 => [p[0] + 0, p[1] + 0, p[2] + 0];

/** the mean of `points`; the caller guarantees at least one */
export function centroid(points: Vec3[]): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (const p of points) {
    out[0] += p[0];
    out[1] += p[1];
    out[2] += p[2];
  }
  return mul(out, 1 / points.length);
}

/** signed distance from `p` to `plane`: positive is outside the solid, which is `n · x <= d` */
export const planeDistance = (plane: Plane, p: Vec3): number => dot(plane.n, p) - plane.d;

/** the same half-space turned inside out — what a CSG subtraction clips against */
export const flip = (plane: Plane): Plane => ({ n: clean(neg(plane.n)), d: -plane.d + 0 });

/**
 * Where three planes meet, or `undefined` if two of them are parallel enough that the meeting point
 * would be further away than it is accurate. Cramer's rule; the determinant is the scalar triple product.
 */
export function intersectPlanes(a: Plane, b: Plane, c: Plane): Vec3 | undefined {
  const bc = cross(b.n, c.n);
  const det = dot(a.n, bc);
  if (Math.abs(det) < 1e-9) return undefined;
  const ca = cross(c.n, a.n);
  const ab = cross(a.n, b.n);
  return mul(add(add(mul(bc, a.d), mul(ca, b.d)), mul(ab, c.d)), 1 / det);
}

/** a pair of unit axes spanning the plane of `n`, right-handed so that `cross(u, v)` is `n` */
export function planeBasis(n: Vec3): { u: Vec3; v: Vec3 } {
  // any axis not nearly parallel to n; the smallest component of n is the safest to lean on
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  const seed: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const v = normalize(cross(n, seed))!;
  return { u: normalize(cross(v, n))!, v };
}

/** an axis-aligned box that contains every point; `undefined` for an empty list */
export function bounds(points: Vec3[]): { min: Vec3; max: Vec3 } | undefined {
  if (!points.length) return undefined;
  const min: Vec3 = [...points[0]!];
  const max: Vec3 = [...points[0]!];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      if (p[k]! < min[k]!) min[k] = p[k]!;
      if (p[k]! > max[k]!) max[k] = p[k]!;
    }
  }
  return { min, max };
}

/** a 4x3 affine transform, row-major: `[m00 m01 m02 m03, m10 …]`. The fourth row is always `0 0 0 1`. */
export type Mat4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export const IDOBJECT: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export const transformPoint = (m: Mat4, p: Vec3): Vec3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

/** a direction, so the translation column is skipped — not a normal, which needs the inverse transpose */
export const transformDirection = (m: Mat4, p: Vec3): Vec3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2],
];

export const translation = (t: Vec3): Mat4 => [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2]];

export const scaling = (s: Vec3, about: Vec3 = [0, 0, 0]): Mat4 => [
  s[0], 0, 0, about[0] - s[0] * about[0],
  0, s[1], 0, about[1] - s[1] * about[1],
  0, 0, s[2], about[2] - s[2] * about[2],
];

/** a right-handed rotation of `angle` radians about `axis` through `about`; `axis` need not be unit */
export function rotation(axis: Vec3, angle: number, about: Vec3 = [0, 0, 0]): Mat4 {
  const a = normalize(axis) ?? [0, 1, 0];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const [x, y, z] = a;
  const r = [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
  // rotate about a point: translate to the origin, rotate, translate back — folded into the last column
  const back: Vec3 = [
    about[0] - (r[0]! * about[0] + r[1]! * about[1] + r[2]! * about[2]),
    about[1] - (r[3]! * about[0] + r[4]! * about[1] + r[5]! * about[2]),
    about[2] - (r[6]! * about[0] + r[7]! * about[1] + r[8]! * about[2]),
  ];
  return [r[0]!, r[1]!, r[2]!, back[0], r[3]!, r[4]!, r[5]!, back[1], r[6]!, r[7]!, r[8]!, back[2]];
}

/**
 * The matrix behind the shear tool: everything slides by `along` for each metre it stands along the `by`
 * axis, so dragging the top face of a box sideways leaves the bottom where it is.
 *
 * `along`'s own `by` component is ignored — a shear that stretched the axis it is measured along would
 * be a scale as well, and the tool that wants that has one.
 */
export function shear(along: Vec3, by: 0 | 1 | 2, about: Vec3 = [0, 0, 0]): Mat4 {
  const m: Mat4 = [...IDOBJECT];
  m[by] = by === 0 ? 1 : along[0];
  m[4 + by] = by === 1 ? 1 : along[1];
  m[8 + by] = by === 2 ? 1 : along[2];
  const p = transformDirection(m, about);
  m[3] = about[0] - p[0];
  m[7] = about[1] - p[1];
  m[11] = about[2] - p[2];
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = [...IDOBJECT] as Mat4;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 4 + c] = a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[4 + c]! + a[r * 4 + 2]! * b[8 + c]!;
    }
    out[r * 4 + 3] = a[r * 4]! * b[3]! + a[r * 4 + 1]! * b[7]! + a[r * 4 + 2]! * b[11]! + a[r * 4 + 3]!;
  }
  return out;
}

/**
 * A node's own transform, the way three keeps one and the way a sheet writes one: `position: vec3(…)`,
 * `rotation: euler(…)` in XYZ order, `scale: vec3(…)`.
 *
 * This is the pair that lets a tool move a light. A solid has geometry for a matrix to act on; an object
 * has only these three numbers, so a rotate or a scale has to be read out of the matrix and back into
 * them. XYZ is three's default Euler order, and matching it is not optional — a sheet's `rotation` *is* an
 * `Euler`, so any other order would place the object somewhere the runtime does not.
 */
export type Trs = { position: Vec3; rotation: Vec3; scale: Vec3 };

export const IDENTITY_TRS: Trs = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

/** translate ∘ rotate ∘ scale, in that order — the one three applies and the only one that composes right */
export function compose({ position, rotation: r, scale: s }: Trs): Mat4 {
  const [c1, c2, c3] = [Math.cos(r[0]), Math.cos(r[1]), Math.cos(r[2])];
  const [s1, s2, s3] = [Math.sin(r[0]), Math.sin(r[1]), Math.sin(r[2])];
  return [
    c2 * c3 * s[0], -c2 * s3 * s[1], s2 * s[2], position[0],
    (c1 * s3 + c3 * s1 * s2) * s[0], (c1 * c3 - s1 * s2 * s3) * s[1], -c2 * s1 * s[2], position[1],
    (s1 * s3 - c1 * c3 * s2) * s[0], (c3 * s1 + c1 * s2 * s3) * s[1], c1 * c2 * s[2], position[2],
  ];
}

/**
 * The three back out of a matrix.
 *
 * A general matrix is not a TRS — a shear is not expressible as one — so this is a best fit rather than an
 * inverse, and that is the honest answer for an object: three cannot store a shear on one either. A
 * negative determinant is charged entirely to `scale.x`, which is the convention three itself uses, and
 * gimbal lock falls back on `z = 0` for the same reason `Euler` does.
 */
export function decompose(m: Mat4): Trs {
  const col = (c: number): Vec3 => [m[c]!, m[4 + c]!, m[8 + c]!];
  const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
  const flip = determinant(m) < 0 ? -1 : 1;
  const scale: Vec3 = [len(col(0)) * flip, len(col(1)), len(col(2))];
  // a zero axis has no direction left to read a rotation off, so it contributes none rather than a NaN
  const r = (row: number, c: number) => (scale[c] ? m[row * 4 + c]! / scale[c]! : row === c ? 1 : 0);
  const y = Math.asin(Math.min(1, Math.max(-1, r(0, 2))));
  const locked = Math.abs(r(0, 2)) > 0.9999999;
  return {
    position: [m[3], m[7], m[11]],
    rotation: locked
      ? [Math.atan2(r(2, 1), r(1, 1)), y, 0]
      : [Math.atan2(-r(1, 2), r(2, 2)), y, Math.atan2(-r(0, 1), r(0, 0))],
    scale,
  };
}

/** the determinant of the linear part: negative means the transform turns the world inside out */
export const determinant = (m: Mat4): number =>
  m[0] * (m[5] * m[10] - m[6] * m[9]) -
  m[1] * (m[4] * m[10] - m[6] * m[8]) +
  m[2] * (m[4] * m[9] - m[5] * m[8]);

/**
 * The transform that undoes this one, or nothing when it flattens space.
 *
 * Linked groups need it and nothing else does: a copy's edit has to be carried back into the set's own
 * space before it can be replayed into the others, and "back" is exactly this. It is the general inverse
 * rather than the rigid-motion shortcut because a linked group may well have been mirrored, and a
 * transpose would quietly get that case wrong.
 */
export function invert(m: Mat4): Mat4 | undefined {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined;
  const k = 1 / det;
  // the adjugate of the linear part, scaled — the classic cofactor formula, written out because three by
  // three is small enough that a loop would only hide it
  const a: Mat4 = [
    (m[5] * m[10] - m[6] * m[9]) * k, (m[2] * m[9] - m[1] * m[10]) * k, (m[1] * m[6] - m[2] * m[5]) * k, 0,
    (m[6] * m[8] - m[4] * m[10]) * k, (m[0] * m[10] - m[2] * m[8]) * k, (m[2] * m[4] - m[0] * m[6]) * k, 0,
    (m[4] * m[9] - m[5] * m[8]) * k, (m[1] * m[8] - m[0] * m[9]) * k, (m[0] * m[5] - m[1] * m[4]) * k, 0,
  ];
  // the translation of the inverse is the inverse linear part applied to the negated translation
  const t = transformDirection(a, [-m[3], -m[7], -m[11]]);
  a[3] = t[0];
  a[7] = t[1];
  a[11] = t[2];
  return a;
}
