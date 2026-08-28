// Convex brushes: a solid described by the half-spaces of its faces, the way Quake and TrenchBroom
// describe one. Pure arithmetic — no three import — so the checker can run it on literal coordinates
// and say "these faces bound no volume" at build time instead of a sheet rendering nothing.
//
// A face is three points, counter-clockwise seen from outside (decision 9 of the editor's roadmap).
// Normal-plus-distance would be one number shorter, and would lose the anchor the paraxial uv system
// derives from the same three points.

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

/** `n · x = d`, `n` unit length and pointing out of the solid */
export type Plane = { n: Vec3; d: number };

/**
 * How a face lays its material out.
 * - `paraxial` — the axis pair of whichever world axis the normal is closest to, so a wall that is
 *   nudged off-axis keeps the alignment of the wall it was cut from. Quake's system.
 * - `parallel` — axes that lie in the face's own plane, either given or derived from the normal. Stays
 *   put under rotation, which is what a non-axial face wants.
 */
export type UvMode = { kind: "paraxial" } | { kind: "parallel"; u?: Vec3; v?: Vec3 };

export type BrushFace = {
  points: [Vec3, Vec3, Vec3];
  uv?: UvMode;
  /** metres along the face's own u and v */
  offset?: Vec2;
  /** metres of world per full texture tile — not a multiplier */
  scale?: Vec2;
  /** radians, about the uv basis normal — a sheet writes `rotation: 30deg` */
  rotation?: number;
};

/** one contiguous run of the index-free vertex arrays, and the face it came from */
export type BrushGroup = { start: number; count: number; face: number };

export type BrushMesh = {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** in face order, skipping the faces that bound nothing */
  groups: BrushGroup[];
  /** the polygon each face turned into, in winding order — what vertex editing and the uv editor read */
  polygons: (Vec3[] | undefined)[];
};

export type BrushProblem = {
  /** the face this is about, or -1 for the solid as a whole */
  face: number;
  message: string;
};

export type BrushResult = { mesh?: BrushMesh; problems: BrushProblem[] };

// ---------------------------------------------------------------- vector arithmetic

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.sqrt(dot(a, a));
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];

function normalize(a: Vec3): Vec3 | undefined {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : undefined;
}

/**
 * The plane through three points, wound counter-clockwise seen from outside — so the normal is the
 * right-hand cross product and points away from the solid.
 */
export function planeFromPoints(p: [Vec3, Vec3, Vec3]): Plane | undefined {
  const n = normalize(cross(sub(p[1], p[0]), sub(p[2], p[0])));
  return n && { n, d: dot(n, p[0]) };
}

// ---------------------------------------------------------------- uv

/**
 * Y-up paraxial base axes: the axis pair of the world axis the normal is closest to. Quake's table is
 * Z-up and reads its v axis downward because its textures are stored upside down; this one keeps v
 * pointing the way the world does, so an unrotated material is not upside down in three.
 */
function paraxialBasis(n: Vec3): { u: Vec3; v: Vec3 } {
  const [x, y, z] = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  if (y >= x && y >= z) return { u: [1, 0, 0], v: [0, 0, n[1] > 0 ? -1 : 1] }; // floor / ceiling
  if (x >= z) return { u: [0, 0, n[0] > 0 ? -1 : 1], v: [0, 1, 0] };
  return { u: [n[2] > 0 ? 1 : -1, 0, 0], v: [0, 1, 0] };
}

/** axes inside the face's own plane: `u` across whichever world axis the normal is least aligned with */
function parallelBasis(n: Vec3): { u: Vec3; v: Vec3 } {
  const [x, y, z] = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  const up: Vec3 = y <= x && y <= z ? [0, 1, 0] : z <= x ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(up, n)) ?? X;
  return { u, v: normalize(cross(n, u))! };
}

/** Rodrigues, about a unit axis */
function rotateAbout(v: Vec3, axis: Vec3, radians: number): Vec3 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}

/** The u/v axes a face projects world positions onto, with its rotation already applied. */
export function uvBasis(face: BrushFace, n: Vec3): { u: Vec3; v: Vec3 } {
  const mode: UvMode = face.uv ?? { kind: "paraxial" };
  const given: { u: Vec3; v: Vec3 } | undefined =
    mode.kind === "parallel" && mode.u && mode.v ? { u: normalize(mode.u) ?? X, v: normalize(mode.v) ?? Y } : undefined;
  let { u, v } = given ?? (mode.kind === "paraxial" ? paraxialBasis(n) : parallelBasis(n));
  if (face.rotation) {
    // about the basis' own normal, not the face's: for a paraxial face those differ, and rotating
    // about the face normal would tilt the axes out of the base plane the alignment depends on
    const axis = normalize(cross(u, v));
    if (axis) {
      u = rotateAbout(u, axis, face.rotation);
      v = rotateAbout(v, axis, face.rotation);
    }
  }
  return { u, v };
}

/** where a world point lands on a face's material, in tiles */
export function uvAt(p: Vec3, basis: { u: Vec3; v: Vec3 }, face: BrushFace): Vec2 {
  const [ox, oy] = face.offset ?? [0, 0];
  const [sx, sy] = face.scale ?? [1, 1];
  return [(dot(p, basis.u) + ox) / (sx || 1), (dot(p, basis.v) + oy) / (sy || 1)];
}

// ---------------------------------------------------------------- half-space intersection

/** how far off a plane a point may be and still count as on it — a millimetre of a millimetre */
const ON_PLANE = 1e-6;
/** how close two vertices may be before they are the same vertex */
const WELD = 1e-5;

/**
 * The polygon a plane cuts out of the solid: start with a square on the plane large enough to contain
 * anything the sheet could have meant, then clip it by every other half-space. This is how Quake has
 * always built a brush, and it needs no hull algorithm — the convexity is in the representation.
 */
function facePolygon(plane: Plane, others: Plane[], extent: number): Vec3[] {
  const { u, v } = parallelBasis(plane.n);
  const centre = scale(plane.n, plane.d);
  let poly: Vec3[] = [
    add(centre, add(scale(u, -extent), scale(v, -extent))),
    add(centre, add(scale(u, extent), scale(v, -extent))),
    add(centre, add(scale(u, extent), scale(v, extent))),
    add(centre, add(scale(u, -extent), scale(v, extent))),
  ];
  for (const o of others) {
    poly = clip(poly, o);
    if (poly.length < 3) return [];
  }
  return poly;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Sutherland–Hodgman against one half-space, keeping the inside (`n · x <= d`) */
function clip(poly: Vec3[], plane: Plane): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = dot(plane.n, a) - plane.d;
    const db = dot(plane.n, b) - plane.d;
    if (da <= ON_PLANE) out.push(a);
    // a crossing, and only a real one: two points on the plane must not manufacture a vertex
    if ((da > ON_PLANE && db < -ON_PLANE) || (da < -ON_PLANE && db > ON_PLANE)) {
      const t = da / (da - db);
      out.push(add(a, scale(sub(b, a), t)));
    }
  }
  return weld(out);
}

/** drops vertices that clipping put on top of each other, which is what makes a sliver a triangle */
function weld(poly: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (last && len(sub(p, last)) < WELD) continue;
    out.push(p);
  }
  while (out.length > 1 && len(sub(out[0]!, out[out.length - 1]!)) < WELD) out.pop();
  return out;
}

/** a coordinate every brush a sheet can sensibly mean fits inside, before clipping cuts it down */
function startingExtent(faces: BrushFace[]): number {
  let max = 1;
  for (const f of faces) for (const p of f.points) for (const c of p) max = Math.max(max, Math.abs(c));
  return max * 8;
}

// ---------------------------------------------------------------- build

/**
 * Turns a brush's faces into triangles, or into the reasons it is not a solid. Both at once is possible
 * and deliberate: a brush with one redundant face still has a mesh, and the editor draws it while
 * saying so.
 */
export function buildBrush(faces: BrushFace[]): BrushResult {
  const problems: BrushProblem[] = [];
  if (faces.length < 4) {
    problems.push({ face: -1, message: `a solid needs at least 4 faces, got ${faces.length}` });
  }

  const planes: (Plane | undefined)[] = faces.map((f, i) => {
    const plane = planeFromPoints(f.points);
    if (!plane) problems.push({ face: i, message: "the three points of this face are collinear, so they define no plane" });
    return plane;
  });

  for (let i = 0; i < planes.length; i++) {
    const a = planes[i];
    if (!a) continue;
    for (let j = i + 1; j < planes.length; j++) {
      const b = planes[j];
      if (!b) continue;
      if (dot(a.n, b.n) > 1 - 1e-9 && Math.abs(a.d - b.d) < ON_PLANE) {
        problems.push({ face: j, message: `this face is the same plane as face ${i + 1}` });
      }
    }
  }

  const usable = planes.filter((p): p is Plane => p !== undefined);
  if (usable.length < 4) return { problems };

  const extent = startingExtent(faces);
  const polygons: (Vec3[] | undefined)[] = [];
  let unbounded = false;
  for (let i = 0; i < planes.length; i++) {
    const plane = planes[i];
    if (!plane) { polygons.push(undefined); continue; }
    const poly = facePolygon(plane, usable.filter((o) => o !== plane), extent);
    if (poly.length < 3) {
      polygons.push(undefined);
      problems.push({ face: i, message: "this face bounds nothing — the other faces already close the solid without it" });
      continue;
    }
    // a vertex still out at the starting square's rim means nothing cut it: the half-spaces are open
    if (poly.some((p) => p.some((c) => Math.abs(c) > extent * 0.99))) unbounded = true;
    polygons.push(poly);
  }

  if (unbounded) problems.push({ face: -1, message: "these faces do not close a solid — the volume they bound is infinite" });
  const solid = polygons.filter((p): p is Vec3[] => p !== undefined);
  if (!solid.length) {
    problems.push({ face: -1, message: "these faces bound no volume" });
    return { problems };
  }
  if (unbounded) return { problems, mesh: undefined };

  let vertices = 0;
  for (const poly of solid) vertices += (poly.length - 2) * 3;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const groups: BrushGroup[] = [];
  let at = 0;

  for (let i = 0; i < polygons.length; i++) {
    const poly = polygons[i];
    const plane = planes[i];
    if (!poly || !plane) continue;
    const face = faces[i]!;
    const basis = uvBasis(face, plane.n);
    const start = at;
    // a convex polygon fans from any vertex, and every one of ours is convex by construction
    for (let k = 1; k + 1 < poly.length; k++) {
      for (const p of [poly[0]!, poly[k]!, poly[k + 1]!]) {
        positions[at * 3] = p[0];
        positions[at * 3 + 1] = p[1];
        positions[at * 3 + 2] = p[2];
        normals[at * 3] = plane.n[0];
        normals[at * 3 + 1] = plane.n[1];
        normals[at * 3 + 2] = plane.n[2];
        const [tu, tv] = uvAt(p, basis, face);
        uvs[at * 2] = tu;
        uvs[at * 2 + 1] = tv;
        at++;
      }
    }
    groups.push({ start, count: at - start, face: i });
  }

  return { problems, mesh: { positions, normals, uvs, groups, polygons } };
}

/**
 * The axis-aligned box of a brush, from its face points alone — cheap enough to call on every brush of
 * a level, and the checker's answer to "is this thing anywhere near the rest of the map".
 */
export function brushBounds(faces: BrushFace[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const f of faces) {
    for (const p of f.points) {
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i]!, p[i]!);
        max[i] = Math.max(max[i]!, p[i]!);
      }
    }
  }
  return { min, max };
}

/**
 * A box brush: six faces, each three points wound counter-clockwise from outside. What the editor's
 * draw-shape tool emits, and what every example in the docs is.
 */
export function boxFaces(min: Vec3, max: Vec3): [Vec3, Vec3, Vec3][] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1]], // +y
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], // -y
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], // +x
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], // -x
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1]], // +z
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], // -z
  ];
}
