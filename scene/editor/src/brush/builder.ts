/**
 * The primitives the create-brush tools drop into the level.
 *
 * Every shape but the box is described by the points on its surface and then hulled, which is a fraction
 * of the code of writing out tilted plane equations per shape and cannot produce a cone whose sides do
 * not meet. The box is the exception: it is by far the most used, its faces have an order designers
 * rely on (+x, −x, +y, −y, +z, −z, so "the top face" is always the third), and its planes are exact.
 *
 * Everything is generated inside a bounding box, because every one of these tools is a drag in a
 * viewport and a drag is a bounding box.
 */
import type { Vec3 } from "tscene";
import { fromPoints } from "./csg.ts";
import { boxPolyhedron, reindex, type Polyhedron } from "./polyhedron.ts";

/** a shape from the points on its surface, its faces numbered so attributes have something to hold on to */
function hulled(points: Vec3[]): Polyhedron | undefined {
  const poly = fromPoints(points);
  return poly && reindex(poly);
}

/** which world axis a shape stands up along */
export type Axis = 0 | 1 | 2;

export type Bounds = { min: Vec3; max: Vec3 };

/** the fewest sides a round shape can have before it stops being round and starts being a mistake */
export const MIN_SIDES = 3;
export const MAX_SIDES = 64;

export const clampSides = (sides: number): number =>
  Math.max(MIN_SIDES, Math.min(MAX_SIDES, Math.round(sides)));

/** an axis-aligned box, faces in the order +x, -x, +y, -y, +z, -z */
export const cuboid = (b: Bounds): Polyhedron => reindex(boxPolyhedron(b.min, b.max));

/** a cube of side `size` centred on `at` */
export const cube = (size: number, at: Vec3 = [0, 0, 0]): Polyhedron =>
  cuboid({
    min: [at[0] - size / 2, at[1] - size / 2, at[2] - size / 2],
    max: [at[0] + size / 2, at[1] + size / 2, at[2] + size / 2],
  });

/**
 * A prism filling `b`, standing along `axis`. Its cross-section is the ellipse inscribed in the box, so
 * a drag in a square gives a circle and a drag in a rectangle gives the oval that fits — the same thing
 * dragging out an ellipse in any drawing program does.
 */
export function cylinder(b: Bounds, sides = 8, axis: Axis = 1): Polyhedron | undefined {
  const ring = (t: number) => ellipse(b, axis, clampSides(sides), t);
  return hulled([...ring(0), ...ring(1)]);
}

/** a cone standing along `axis`, its base filling the bottom of `b` and its tip at the top */
export function cone(b: Bounds, sides = 8, axis: Axis = 1): Polyhedron | undefined {
  const tip: Vec3 = [
    (b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2,
  ];
  tip[axis] = b.max[axis]!;
  return hulled([...ellipse(b, axis, clampSides(sides), 0), tip]);
}

/** a wedge: a box with one edge collapsed, the ramp every staircase and buttress starts as */
export function wedge(b: Bounds, axis: Axis = 1): Polyhedron | undefined {
  const box = boxPolyhedron(b.min, b.max);
  // drop the two corners at the top of the `axis` on the far side, leaving a slope
  const cut = (axis + 1) % 3;
  const points = box.vertices.filter((v) => !(v[axis] === b.max[axis] && v[cut] === b.max[cut]));
  return hulled(points);
}

/**
 * A sphere from a latitude/longitude grid — `rings` bands of `sides` — inscribed in `b`. It is the shape
 * designers reach for when the seams have to line up with a wrapped texture.
 */
export function uvSphere(b: Bounds, sides = 8, rings = 4, axis: Axis = 1): Polyhedron | undefined {
  const n = clampSides(sides);
  const bands = Math.max(2, Math.min(MAX_SIDES, Math.round(rings)));
  const points: Vec3[] = [];
  for (let r = 0; r <= bands; r++) {
    const t = r / bands;
    // a band of latitude, its radius the sine of the angle from the pole
    points.push(...ellipse(b, axis, n, t, Math.sin(t * Math.PI)));
  }
  return hulled(points);
}

/**
 * A sphere from a subdivided icosahedron: every face nearly the same size, so it stays round from every
 * direction rather than bunching at the poles. `steps` of 0 is the icosahedron itself, 20 faces.
 */
export function icoSphere(b: Bounds, steps = 1): Polyhedron | undefined {
  const g = (1 + Math.sqrt(5)) / 2;
  const seed: Vec3[] = [];
  for (const s of [-1, 1]) {
    for (const t of [-g, g]) {
      seed.push([0, s, t], [s, t, 0], [t, 0, s]);
    }
  }
  let points = seed.map(unit);
  for (let i = 0; i < Math.max(0, Math.min(2, Math.round(steps))); i++) {
    // every midpoint pushed back out to the sphere; the hull sorts out which of them are corners
    const grown = [...points];
    for (let a = 0; a < points.length; a++) {
      for (let c = a + 1; c < points.length; c++) {
        const p = points[a]!;
        const q = points[c]!;
        // only neighbours, or the midpoints of long chords land inside and do nothing but cost time
        if (dot3(p, q) > 0.4) grown.push(unit([p[0] + q[0], p[1] + q[1], p[2] + q[2]]));
      }
    }
    points = grown;
  }
  return hulled(points.map((p) => inBox(p, b)));
}

// ---------------------------------------------------------------- shared

/**
 * `n` points around the ellipse inscribed in `b`, at height `t` along `axis` (0 at the bottom, 1 at the
 * top), the cross-section scaled by `radius`. Half a step of rotation is added so an even-sided prism
 * gets flat sides facing the axes rather than corners — which is what makes an 8-sided pillar look
 * square-on to the walls it stands against.
 */
function ellipse(b: Bounds, axis: Axis, n: number, t: number, radius = 1): Vec3[] {
  const [u, v] = [(axis + 1) % 3, (axis + 2) % 3] as [Axis, Axis];
  const mid = (k: Axis) => (b.min[k]! + b.max[k]!) / 2;
  const half = (k: Axis) => (b.max[k]! - b.min[k]!) / 2;
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    const p: Vec3 = [0, 0, 0];
    p[axis] = b.min[axis]! + (b.max[axis]! - b.min[axis]!) * t;
    p[u] = mid(u) + Math.cos(a) * half(u) * radius;
    p[v] = mid(v) + Math.sin(a) * half(v) * radius;
    out.push(p);
  }
  return out;
}

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const unit = (p: Vec3): Vec3 => {
  const l = Math.hypot(...p) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
};

/** a point on the unit sphere mapped into `b` */
const inBox = (p: Vec3, b: Bounds): Vec3 => [
  (b.min[0] + b.max[0]) / 2 + (p[0] * (b.max[0] - b.min[0])) / 2,
  (b.min[1] + b.max[1]) / 2 + (p[1] * (b.max[1] - b.min[1])) / 2,
  (b.min[2] + b.max[2]) / 2 + (p[2] * (b.max[2] - b.min[2])) / 2,
];
