/**
 * The convex polytope the brush kernel is built on.
 *
 * TrenchBroom carries a full half-edge `Polyhedron`. This carries an indexed face set instead — a shared
 * vertex array plus one counter-clockwise loop of vertex indices per face — because every adjacency a
 * brush editor asks for (which faces meet at this vertex, which two faces share this edge) is one pass
 * over a solid that has six to twenty faces, and a loop of indices cannot get out of step with itself the
 * way four cross-linked pointers can. What the half-edge structure buys is asymptotics this problem does
 * not have.
 *
 * A solid is always the intersection of its faces' half-spaces, `n · x <= d`. Vertices are never stored
 * as the truth; they are where the planes meet, recomputed after every edit. That is what makes moving a
 * face incapable of tearing a hole in the solid, and it is the reason the format on disk is three points
 * per face rather than a vertex list.
 *
 * No three, no DOM: the checks run this under bare node.
 */
import type { Plane, Vec3 } from "tscene";
import {
  bounds, centroid, clean, cross, dot, intersectPlanes, normalize, planeBasis, planeDistance, sub,
  transformDirection, transformPoint, type Mat4,
} from "./vec.ts";

/** a micron. Brushes are metres and the finest grid rung is 15.6 mm, so this is far below anything real. */
export const EPSILON = 1e-6;

/**
 * One face: the plane it lies in, the counter-clockwise loop of vertex indices seen from outside, and
 * which of the planes handed to `fromPlanes` produced it. `source` is how face attributes survive a
 * rebuild — see `matchFaces`.
 */
export type PolyFace = { plane: Plane; loop: number[]; source: number };

export type Polyhedron = { vertices: Vec3[]; faces: PolyFace[] };

/** an undirected edge, and the two faces that meet along it — always exactly two in a closed solid */
export type PolyEdge = { a: number; b: number; faces: [number, number] };

/** why a set of half-spaces is not a solid, in the same words the tscene checker uses */
export type PolyProblem =
  | { kind: "unbounded"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "redundant"; source: number; message: string }
  | { kind: "degenerate"; source: number; message: string };

export type BuildResult = { poly?: Polyhedron; problems: PolyProblem[] };

// ---------------------------------------------------------------- construction

/** the six faces of an axis-aligned box, wound counter-clockwise seen from outside */
export function boxPolyhedron(min: Vec3, max: Vec3, source = -1): Polyhedron {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  // indexed by bits: x adds 1, y adds 2, z adds 4
  const vertices: Vec3[] = [
    [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
  ];
  // `d + 0` because `-x0` is `-0` when the box starts at the origin, and a plane distance of `-0`
  // compares unequal to the `0` the same box gets after a round trip through the sheet
  const face = (n: Vec3, d: number, loop: number[]): PolyFace => ({ plane: { n, d: d + 0 }, loop, source });
  return {
    vertices,
    faces: [
      face([1, 0, 0], x1, [1, 3, 7, 5]),
      face([-1, 0, 0], -x0, [0, 4, 6, 2]),
      face([0, 1, 0], y1, [2, 6, 7, 3]),
      face([0, -1, 0], -y0, [0, 1, 5, 4]),
      face([0, 0, 1], z1, [4, 5, 7, 6]),
      face([0, 0, -1], -z0, [0, 2, 3, 1]),
    ],
  };
}

/**
 * The solid bounded by `planes`, built by starting from a box big enough to contain it and clipping once
 * per plane. A plane that never cuts anything is reported rather than silently dropped: in a level it is
 * almost always a face that has been dragged through the solid and out the other side.
 */
export function fromPlanes(planes: Plane[], extent?: number): BuildResult {
  const problems: PolyProblem[] = [];
  if (planes.length < 4) {
    return { problems: [{ kind: "empty", message: `a solid needs at least 4 faces, got ${planes.length}` }] };
  }
  const reach = extent ?? startingExtent(planes);
  let poly: Polyhedron | undefined = boxPolyhedron([-reach, -reach, -reach], [reach, reach, reach]);

  for (const [i, plane] of planes.entries()) {
    const result = clip(poly, plane, i);
    if (!result.poly) {
      problems.push({ kind: "empty", message: "these faces bound no volume" });
      return { problems };
    }
    if (!result.cut) {
      problems.push({
        kind: "redundant", source: i,
        message: "this face bounds nothing — the other faces already close the solid without it",
      });
    }
    poly = result.poly;
  }

  // a surviving face of the starting box means the planes never closed: the box is holding the solid in
  if (poly.faces.some((f) => f.source === -1)) {
    problems.push({ kind: "unbounded", message: "these faces do not close a solid — the volume they bound is infinite" });
    return { problems };
  }
  if (poly.faces.length < 4) {
    problems.push({ kind: "empty", message: "these faces bound no volume" });
    return { problems };
  }
  return { poly: refine(poly), problems };
}

/**
 * Puts every vertex back exactly where its planes meet.
 *
 * Clipping finds each vertex by walking along an edge, so it lands a rounding error off the plane it
 * was cut by, and the next clip starts from there. Over a dozen faces that drift is visible in the
 * inspector — a box typed as 4 metres wide reading 3.9999999999999964. Solving the three planes the
 * vertex actually lies on is exact for the axis-aligned case and stops the error compounding for the
 * rest, and it costs one 3x3 solve per corner.
 */
function refine(poly: Polyhedron): Polyhedron {
  const incident = vertexFaces(poly);
  const vertices = poly.vertices.map((v, i) => {
    const at = incident[i]!;
    if (at.length < 3) return v;
    // the three least parallel of the faces meeting here: the most nearly parallel triple is the one
    // whose intersection is least certain, and at a vertex where four faces meet any three will do
    let best: Vec3 | undefined;
    let bestDet = 1e-4;
    for (let a = 0; a < at.length; a++) {
      for (let b = a + 1; b < at.length; b++) {
        for (let c = b + 1; c < at.length; c++) {
          const [pa, pb, pc] = [poly.faces[at[a]!]!.plane, poly.faces[at[b]!]!.plane, poly.faces[at[c]!]!.plane];
          const det = Math.abs(dot(pa.n, cross(pb.n, pc.n)));
          if (det <= bestDet) continue;
          const p = intersectPlanes(pa, pb, pc);
          if (p) ((bestDet = det), (best = p));
        }
      }
    }
    // a solve that lands somewhere else entirely means the topology, not the arithmetic, is wrong
    return best && dist2(best, v) < 1e-6 * Math.max(1, dot(v, v)) ? clean(best) : v;
  });
  return { vertices, faces: poly.faces };
}

/** far enough out that the starting box cannot clip anything the planes themselves would have kept */
function startingExtent(planes: Plane[]): number {
  let far = 1;
  for (const p of planes) far = Math.max(far, Math.abs(p.d));
  return far * 8 + 1;
}

// ---------------------------------------------------------------- clipping

export type ClipResult = {
  /** the part of `poly` inside the half-space, or `undefined` if nothing is left */
  poly?: Polyhedron;
  /** whether the plane actually removed anything — false means it was redundant */
  cut: boolean;
  /** the loop of the face the cut opened up, in `poly`'s indices, or `undefined` if it opened none */
  section?: number[];
};

/**
 * The part of `poly` on the inside of `plane`, plus the cross-section the cut exposed as a new face.
 *
 * The vertices where the plane crosses an edge are computed **per edge** and shared by both faces that
 * meet along it, which is what keeps the result a closed solid rather than two independently clipped
 * polygons that nearly line up.
 */
export function clip(poly: Polyhedron, plane: Plane, source: number): ClipResult {
  const d = poly.vertices.map((v) => planeDistance(plane, v));
  const outside = d.some((x) => x > EPSILON);
  const inside = d.some((x) => x < -EPSILON);
  if (!outside) return { poly, cut: false };
  if (!inside) return { cut: true };

  const vertices: Vec3[] = [];
  const kept = new Map<number, number>();
  const split = new Map<string, number>();
  /** an original vertex that survives — everything not strictly outside */
  const keep = (i: number): number => {
    let at = kept.get(i);
    if (at === undefined) kept.set(i, (at = vertices.push(poly.vertices[i]!) - 1));
    return at;
  };
  /** where the plane crosses the edge between `i` and `j`, made once and shared by both its faces */
  const cross_ = (i: number, j: number): number => {
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    let at = split.get(key);
    if (at === undefined) {
      const t = d[i]! / (d[i]! - d[j]!);
      const a = poly.vertices[i]!;
      const b = poly.vertices[j]!;
      at = vertices.push(clean([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])) - 1;
      split.set(key, at);
    }
    return at;
  };

  const faces: PolyFace[] = [];
  const onPlane = new Set<number>();
  for (const face of poly.faces) {
    const loop: number[] = [];
    for (let k = 0; k < face.loop.length; k++) {
      const i = face.loop[k]!;
      const j = face.loop[(k + 1) % face.loop.length]!;
      if (d[i]! <= EPSILON) {
        const at = keep(i);
        loop.push(at);
        if (d[i]! >= -EPSILON) onPlane.add(at);
      }
      // only a strict crossing makes a new vertex; a vertex sitting on the plane already is the crossing
      if ((d[i]! < -EPSILON && d[j]! > EPSILON) || (d[i]! > EPSILON && d[j]! < -EPSILON)) {
        const at = cross_(i, j);
        loop.push(at);
        onPlane.add(at);
      }
    }
    if (loop.length >= 3) faces.push({ plane: face.plane, loop, source: face.source });
  }

  const opened = onPlane.size >= 3;
  if (opened) faces.push({ plane, loop: ring([...onPlane], vertices, plane), source });
  if (faces.length < 4) return { cut: true };
  const out = compact({ vertices, faces });
  // the cap went on last, so after renumbering it is still the last face
  return { poly: out, cut: true, section: opened ? out.faces.at(-1)!.loop : undefined };
}

/**
 * `indices` sorted into the boundary of the convex polygon they form, counter-clockwise seen from `+n`.
 * They are the cross-section of a convex solid, so every one of them is a corner of it and sorting by
 * angle about their own centre is the whole job.
 */
function ring(indices: number[], vertices: Vec3[], plane: Plane): number[] {
  const { u, v } = planeBasis(plane.n);
  const c = centroid(indices.map((i) => vertices[i]!));
  return indices
    .map((i) => {
      const r = sub(vertices[i]!, c);
      return { i, angle: Math.atan2(dot(r, v), dot(r, u)) };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((x) => x.i);
}

/** drop vertices no face refers to any more, and renumber what is left */
function compact(poly: Polyhedron): Polyhedron {
  const moved = new Map<number, number>();
  const vertices: Vec3[] = [];
  const faces = poly.faces.map((f) => ({
    ...f,
    loop: f.loop.map((i) => {
      let at = moved.get(i);
      if (at === undefined) moved.set(i, (at = vertices.push(poly.vertices[i]!) - 1));
      return at;
    }),
  }));
  return { vertices, faces };
}

// ---------------------------------------------------------------- queries

/** every edge once, with the two faces that meet along it */
export function edges(poly: Polyhedron): PolyEdge[] {
  const found = new Map<string, PolyEdge>();
  for (const [fi, face] of poly.faces.entries()) {
    for (let k = 0; k < face.loop.length; k++) {
      const a = face.loop[k]!;
      const b = face.loop[(k + 1) % face.loop.length]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const seen = found.get(key);
      if (seen) seen.faces[1] = fi;
      else found.set(key, { a: Math.min(a, b), b: Math.max(a, b), faces: [fi, -1] });
    }
  }
  return [...found.values()];
}

/** the faces that meet at each vertex, in no particular order */
export function vertexFaces(poly: Polyhedron): number[][] {
  const out: number[][] = poly.vertices.map(() => []);
  for (const [fi, face] of poly.faces.entries()) for (const i of face.loop) out[i]!.push(fi);
  return out;
}

/**
 * Every face made to point at itself. A brush's faces are attributes held by position, so `source` is
 * its own index for as long as nothing has happened to it; an operation then carries those numbers
 * through to whatever it produces, and that is the thread the material follows.
 */
export const reindex = (poly: Polyhedron): Polyhedron => ({
  vertices: poly.vertices,
  faces: poly.faces.map((f, i) => ({ ...f, source: i })),
});

export const polyBounds = (poly: Polyhedron) => bounds(poly.vertices)!;

export const polyCentre = (poly: Polyhedron): Vec3 => {
  const b = polyBounds(poly);
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
};

/** the volume of the solid, by summing the signed volumes of the tetrahedra over a fan of each face */
export function volume(poly: Polyhedron): number {
  const o = poly.vertices[0] ?? ([0, 0, 0] as Vec3);
  let total = 0;
  for (const face of poly.faces) {
    for (let k = 1; k + 1 < face.loop.length; k++) {
      const a = sub(poly.vertices[face.loop[0]!]!, o);
      const b = sub(poly.vertices[face.loop[k]!]!, o);
      const c = sub(poly.vertices[face.loop[k + 1]!]!, o);
      total += dot(a, cross(b, c));
    }
  }
  return total / 6;
}

export const containsPoint = (poly: Polyhedron, p: Vec3, slack = EPSILON): boolean =>
  poly.faces.every((f) => planeDistance(f.plane, p) <= slack);

/** the three points a face is written as on disk: the first corner, and two more spread around the loop */
export function facePoints(poly: Polyhedron, face: PolyFace): [Vec3, Vec3, Vec3] {
  const n = face.loop.length;
  const at = (k: number) => poly.vertices[face.loop[k % n]!]!;
  // thirds rather than three neighbours: the further apart they are, the less the plane wobbles when the
  // coordinates are snapped to the grid on the way out
  return [at(0), at(Math.max(1, Math.round(n / 3))), at(Math.max(2, Math.round((2 * n) / 3)))];
}

// ---------------------------------------------------------------- transforms

/**
 * Moves every vertex and re-derives the planes from the moved loops. A mirroring transform reverses
 * every loop, so the solid stays wound outward instead of turning inside out.
 */
export function transform(poly: Polyhedron, m: Mat4, mirrored: boolean): Polyhedron {
  const vertices = poly.vertices.map((v) => transformPoint(m, v));
  const faces = poly.faces.map((f) => {
    const loop = mirrored ? [...f.loop].reverse() : f.loop;
    return { ...f, loop, plane: planeOfLoop(vertices, loop) ?? transformedPlane(f.plane, m, mirrored) };
  });
  return { vertices, faces };
}

/** the plane of a loop, from the corner where its two edges are furthest from parallel */
export function planeOfLoop(vertices: Vec3[], loop: number[]): Plane | undefined {
  let best: { n: Vec3; area: number } | undefined;
  for (let k = 0; k < loop.length; k++) {
    const a = vertices[loop[k]!]!;
    const b = vertices[loop[(k + 1) % loop.length]!]!;
    const c = vertices[loop[(k + 2) % loop.length]!]!;
    const n = cross(sub(b, a), sub(c, b));
    const area = dot(n, n);
    if (!best || area > best.area) best = { n, area };
  }
  const n = best && normalize(best.n);
  return n && { n, d: dot(n, vertices[loop[0]!]!) };
}

/** a fallback for a loop too thin to take a normal from: carry the old plane through the transform */
function transformedPlane(plane: Plane, m: Mat4, mirrored: boolean): Plane {
  const p = transformPoint(m, mul3(plane.n, plane.d));
  const raw = transformDirection(m, plane.n);
  const n = normalize(mirrored ? mul3(raw, -1) : raw) ?? plane.n;
  return { n, d: dot(n, p) };
}

const mul3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

// ---------------------------------------------------------------- convex hull

/**
 * The planes of the convex hull of `points`, deduplicated so that a flat side comes back as one plane
 * rather than as the triangles that covered it. Feeding these to `fromPlanes` is how the kernel turns a
 * moved set of vertices back into a solid with proper polygonal faces.
 */
export function hullPlanes(points: Vec3[], epsilon = EPSILON): Plane[] | undefined {
  const pts = weld(points, epsilon);
  if (pts.length < 4) return undefined;

  // a starting tetrahedron: two points furthest apart, then furthest from that line, then from that plane
  const a = 0;
  let b = 1;
  for (let i = 1; i < pts.length; i++) if (dist2(pts[a]!, pts[i]!) > dist2(pts[a]!, pts[b]!)) b = i;
  const axis = normalize(sub(pts[b]!, pts[a]!));
  if (!axis) return undefined;
  let c = -1;
  let bestC = epsilon;
  for (let i = 0; i < pts.length; i++) {
    const area = Math.hypot(...cross(sub(pts[i]!, pts[a]!), axis));
    if (area > bestC) ((bestC = area), (c = i));
  }
  if (c < 0) return undefined;
  const base = normalize(cross(sub(pts[b]!, pts[a]!), sub(pts[c]!, pts[a]!)));
  if (!base) return undefined;
  let e = -1;
  let bestE = epsilon;
  for (let i = 0; i < pts.length; i++) {
    const h = Math.abs(dot(base, sub(pts[i]!, pts[a]!)));
    if (h > bestE) ((bestE = h), (e = i));
  }
  if (e < 0) return undefined; // every point is coplanar, so there is no solid to hull

  const interior = centroid([pts[a]!, pts[b]!, pts[c]!, pts[e]!]);
  /** a triangle wound so that its normal points away from `interior` */
  const facing = (i: number, j: number, k: number): [number, number, number] =>
    dot(cross(sub(pts[j]!, pts[i]!), sub(pts[k]!, pts[i]!)), sub(pts[i]!, interior)) > 0 ? [i, j, k] : [i, k, j];

  let tris: [number, number, number][] = [
    facing(a, b, c), facing(a, b, e), facing(a, c, e), facing(b, c, e),
  ];

  for (let i = 0; i < pts.length; i++) {
    if (i === a || i === b || i === c || i === e) continue;
    const p = pts[i]!;
    const visible = tris.filter((t) => triDistance(pts, t, p) > epsilon);
    if (!visible.length) continue; // already inside the hull so far

    // the horizon is every directed edge of a visible triangle whose reverse no visible triangle owns
    const directed = new Set(visible.flatMap(([x, y, z]) => [`${x},${y}`, `${y},${z}`, `${z},${x}`]));
    const horizon: [number, number][] = [];
    for (const key of directed) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      if (!directed.has(`${y},${x}`)) horizon.push([x, y]);
    }
    const gone = new Set(visible);
    tris = tris.filter((t) => !gone.has(t));
    for (const [x, y] of horizon) tris.push(facing(x, y, i));
  }

  return dedupePlanes(tris.map((t) => triPlane(pts, t)).filter((p): p is Plane => !!p), epsilon);
}

const dist2 = (a: Vec3, b: Vec3): number => {
  const d = sub(a, b);
  return dot(d, d);
};

function triPlane(pts: Vec3[], [i, j, k]: [number, number, number]): Plane | undefined {
  const n = normalize(cross(sub(pts[j]!, pts[i]!), sub(pts[k]!, pts[i]!)));
  return n && { n, d: dot(n, pts[i]!) };
}

const triDistance = (pts: Vec3[], t: [number, number, number], p: Vec3): number => {
  const plane = triPlane(pts, t);
  return plane ? planeDistance(plane, p) : -Infinity;
};

/** one representative per cluster of points closer together than `epsilon` */
export function weld(points: Vec3[], epsilon = EPSILON): Vec3[] {
  const out: Vec3[] = [];
  for (const p of points) if (!out.some((q) => dist2(p, q) <= epsilon * epsilon)) out.push(p);
  return out;
}

/** the same plane written twice — which every flat side of a triangulated hull is — collapses to one */
export function dedupePlanes(planes: Plane[], epsilon = EPSILON): Plane[] {
  const out: Plane[] = [];
  for (const p of planes) {
    if (!out.some((q) => dot(p.n, q.n) > 1 - epsilon && Math.abs(p.d - q.d) <= epsilon * 1e3)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- integrity

/**
 * Everything that has to be true of a closed convex solid. Called by the checks after every operation,
 * and by the editor behind a debug flag: a kernel that silently produces a solid with a hole in it is
 * worse than one that throws, because the hole surfaces three operations later.
 */
export function integrity(poly: Polyhedron): string[] {
  const bad: string[] = [];
  if (poly.faces.length < 4) bad.push(`a solid needs at least 4 faces, got ${poly.faces.length}`);

  for (const [fi, face] of poly.faces.entries()) {
    if (face.loop.length < 3) bad.push(`face ${fi} has ${face.loop.length} corners`);
    if (new Set(face.loop).size !== face.loop.length) bad.push(`face ${fi} visits a vertex twice`);
    const plane = planeOfLoop(poly.vertices, face.loop);
    if (!plane) {
      bad.push(`face ${fi} is too thin to have a normal`);
    } else {
      if (dot(plane.n, face.plane.n) < 1 - 1e-4) bad.push(`face ${fi} is wound against its own plane`);
      for (const i of face.loop) {
        if (Math.abs(planeDistance(face.plane, poly.vertices[i]!)) > 1e-4) bad.push(`face ${fi} has a corner off its plane`);
      }
    }
  }

  const shared = edges(poly);
  for (const e of shared) if (e.faces[1] < 0) bad.push(`the edge ${e.a}-${e.b} borders one face, so the solid is open`);
  const euler = poly.vertices.length - shared.length + poly.faces.length;
  if (euler !== 2) bad.push(`V - E + F is ${euler}, not 2, so this is not a simple closed surface`);

  for (const [vi, v] of poly.vertices.entries()) {
    for (const [fi, face] of poly.faces.entries()) {
      if (planeDistance(face.plane, v) > 1e-4) bad.push(`vertex ${vi} is outside face ${fi}, so the solid is not convex`);
    }
  }
  if (poly.faces.length >= 4 && volume(poly) <= EPSILON) bad.push("the solid encloses no volume");
  return bad;
}
