/**
 * A brush: the solid, plus what each of its faces is made of.
 *
 * The two are kept as parallel arrays — `brush.faces[i]` describes `brush.poly.faces[i]` — and every
 * operation goes through `settle`, which is the only place attributes are ever re-attached. That is the
 * whole answer to the hardest problem in a brush editor: an edit changes the *topology*, so the face
 * that was third before the drag may be fifth after it, may have merged with its neighbour, or may have
 * disappeared. Attributes follow the numbering the kernel carries in `PolyFace.source`, and when the
 * kernel invented a face outright they follow the nearest normal instead.
 *
 * Everything returns problems rather than throwing. A brush editor spends its life in states that are
 * momentarily not solids — mid-drag, a face is through the far wall — and the tool wants to hear "that
 * would leave nothing" so it can refuse the frame, not catch an exception.
 */
import {
  buildBrush, planeFromPoints, type BrushFace, type BrushMesh, type Plane, type UvMode, type Vec2,
  type Vec3,
} from "tscene";
import { snap } from "../grid/snap.ts";
import { build, fromPoints, sourced, type SourcedPlane } from "./csg.ts";
import {
  EPSILON, facePoints, integrity, planeOfLoop, polyBounds, polyCentre, reindex, transform, volume,
  type Polyhedron,
} from "./polyhedron.ts";
import { centroid, determinant, dot, sub, type Mat4 } from "./vec.ts";

/** what a face is made of, in the same words the sheet writes */
export type FaceAttributes = {
  /** the name of a `--var` holding a material, or undefined for the brush's default */
  material?: string;
  uv: UvMode;
  /** metres along the face's own u and v */
  offset: Vec2;
  /** metres of world per full texture tile */
  scale: Vec2;
  /** radians */
  rotation: number;
};

export type Brush = { poly: Polyhedron; faces: FaceAttributes[] };

/**
 * The result of any edit: the new brush, or nothing and the reasons.
 *
 * `from[i]` is the face of the brush that went in which face `i` of the brush that came out grew from,
 * or `-1` for a face the kernel invented. Attributes are already carried across — that is `settle`'s job
 * — but uv lock needs to know which face *used to be* which in order to work out how far each one turned,
 * and after `settle` the numbering has been reset and the answer is gone.
 */
export type BrushEdit = { brush?: Brush; problems: string[]; from?: number[] };

/** which face of the previous brush each face came from, read off before `settle` renumbers them */
export const sourcesOf = (poly: Polyhedron): number[] => poly.faces.map((f) => f.source);

export const DEFAULT_FACE: FaceAttributes = {
  uv: { kind: "paraxial" },
  offset: [0, 0],
  scale: [1, 1],
  rotation: 0,
};

export const faceAttributes = (over: Partial<FaceAttributes> = {}): FaceAttributes => ({
  ...DEFAULT_FACE,
  offset: [...DEFAULT_FACE.offset],
  scale: [...DEFAULT_FACE.scale],
  ...over,
});

// ---------------------------------------------------------------- settling

/**
 * Re-attaches attributes after an operation and puts the brush back in its canonical form.
 *
 * `poly`'s faces carry, in `source`, which face of `before` they came from. A face the kernel invented —
 * the inside of a hole, a face split off by a clip — has no source, and takes the attributes of the face
 * of `before` whose normal is closest, which is what a designer expects when they bevel an edge and the
 * new sliver comes out matching the wall rather than blank.
 */
export function settle(before: Brush, poly: Polyhedron): Brush {
  const faces = poly.faces.map((f) => before.faces[f.source] ?? nearestAttributes(before, f.plane));
  return { poly: reindex(poly), faces: faces.map((f) => ({ ...f, offset: [...f.offset], scale: [...f.scale] })) };
}

function nearestAttributes(before: Brush, plane: Plane): FaceAttributes {
  let best = -1;
  let bestDot = -2;
  for (const [i, f] of before.poly.faces.entries()) {
    const d = dot(f.plane.n, plane.n);
    if (d > bestDot) ((bestDot = d), (best = i));
  }
  return before.faces[best] ?? faceAttributes();
}

/** a brush from a bare solid, every face the same to start with */
export const brushOf = (poly: Polyhedron, over: Partial<FaceAttributes> = {}): Brush => ({
  poly: reindex(poly),
  faces: poly.faces.map(() => faceAttributes(over)),
});

/** the sourced planes an operation should carry into the kernel */
export const brushPlanes = (brush: Brush): SourcedPlane[] => sourced(brush.poly);

// ---------------------------------------------------------------- the sheet, both ways

/**
 * The brush a sheet's `face(…)` list describes. Faces that bound nothing are reported and dropped, so a
 * hand-edited sheet with a stray face still opens instead of refusing to load.
 */
export function brushFromFaces(faces: BrushFace[]): BrushEdit {
  const problems: string[] = [];
  const planes: SourcedPlane[] = [];
  for (const [i, face] of faces.entries()) {
    const plane = planeFromPoints(face.points);
    if (!plane) problems.push(`face ${i}: its three points are in a line, so they name no plane`);
    else planes.push({ plane, source: i });
  }
  if (planes.length < 4) {
    problems.push(`a solid needs at least 4 faces, got ${planes.length}`);
    return { problems };
  }
  const built = build(planes);
  for (const p of built.problems) problems.push("source" in p ? `face ${p.source}: ${p.message}` : p.message);
  if (!built.poly) return { problems };

  const before: Brush = {
    poly: built.poly,
    faces: faces.map((f) =>
      faceAttributes({
        uv: f.uv ?? DEFAULT_FACE.uv,
        offset: f.offset ? [...f.offset] : [0, 0],
        scale: f.scale ? [...f.scale] : [1, 1],
        rotation: f.rotation ?? 0,
      }),
    ),
  };
  return { brush: settle(before, built.poly), problems, from: sourcesOf(built.poly) };
}

/**
 * The `face(…)` list a sheet writes. Defaults are left off — a face that has never been touched writes
 * three points and an empty body, which is what makes a hand-written sheet readable.
 */
export function brushToFaces(brush: Brush): BrushFace[] {
  return brush.poly.faces.map((f, i) => {
    const a = brush.faces[i] ?? DEFAULT_FACE;
    const face: BrushFace = { points: facePoints(brush.poly, f) };
    if (a.uv.kind !== "paraxial") face.uv = a.uv;
    if (a.offset[0] || a.offset[1]) face.offset = [...a.offset];
    if (a.scale[0] !== 1 || a.scale[1] !== 1) face.scale = [...a.scale];
    if (a.rotation) face.rotation = a.rotation;
    return face;
  });
}

/** the mesh three renders, built by the same code the runtime uses so the editor cannot drift from it */
export const brushToMesh = (brush: Brush): { mesh?: BrushMesh; problems: string[] } => {
  const result = buildBrush(brushToFaces(brush));
  return { mesh: result.mesh, problems: result.problems.map((p) => (p.face < 0 ? p.message : `face ${p.face}: ${p.message}`)) };
};

// ---------------------------------------------------------------- geometry queries

export const brushBounds = (brush: Brush) => polyBounds(brush.poly);
export const brushCentre = (brush: Brush) => polyCentre(brush.poly);
export const brushVolume = (brush: Brush) => volume(brush.poly);

/** the corners of one face, in winding order */
export const facePolygon = (brush: Brush, face: number): Vec3[] =>
  (brush.poly.faces[face]?.loop ?? []).map((i) => brush.poly.vertices[i]!);

export const faceCentre = (brush: Brush, face: number): Vec3 => centroid(facePolygon(brush, face));

export const faceNormal = (brush: Brush, face: number): Vec3 =>
  brush.poly.faces[face]?.plane.n ?? [0, 1, 0];

/** the area of a face, by fanning it from its first corner */
export function faceArea(brush: Brush, face: number): number {
  const p = facePolygon(brush, face);
  let twice = 0;
  for (let k = 1; k + 1 < p.length; k++) {
    const a = sub(p[k]!, p[0]!);
    const b = sub(p[k + 1]!, p[0]!);
    twice += Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  }
  return twice / 2;
}

/** the total surface area — what the lightmap budget is spent per */
export const brushArea = (brush: Brush): number =>
  brush.poly.faces.reduce((sum, _, i) => sum + faceArea(brush, i), 0);

// ---------------------------------------------------------------- editing

const rebuild = (before: Brush, planes: SourcedPlane[], what: string): BrushEdit => {
  const built = build(planes);
  if (!built.poly) return { problems: [`${what} would leave nothing`] };
  const bad = integrity(built.poly);
  if (bad.length) return { problems: bad.map((b) => `${what}: ${b}`) };
  return { brush: settle(before, built.poly), problems: [], from: sourcesOf(built.poly) };
};

/** every vertex moved; a mirroring transform reverses the winding rather than turning the brush inside out */
export function transformBrush(brush: Brush, m: Mat4): BrushEdit {
  const moved = transform(brush.poly, m, determinant(m) < 0);
  const bad = integrity(moved);
  if (bad.length) return { problems: bad };
  return { brush: settle(brush, moved), problems: [], from: sourcesOf(moved) };
}

/**
 * A face slid along its own normal — the face drag, and the only edit that cannot change how many
 * corners the brush has unless it pushes one out of existence, in which case the kernel says so.
 */
export const moveFace = (brush: Brush, face: number, distance: number): BrushEdit =>
  moveFaces(brush, [face], distance);

export function moveFaces(brush: Brush, faces: number[], distance: number): BrushEdit {
  const chosen = new Set(faces);
  const planes = brushPlanes(brush).map((p, i) =>
    chosen.has(i) ? { source: p.source, plane: { n: p.plane.n, d: p.plane.d + distance } } : p,
  );
  return rebuild(brush, planes, "moving the face");
}

/** a face put on a plane outright — what dragging a face onto a snapped position resolves to */
export function setFacePlane(brush: Brush, face: number, plane: Plane): BrushEdit {
  const planes = brushPlanes(brush).map((p, i) => (i === face ? { source: p.source, plane } : p));
  return rebuild(brush, planes, "moving the face");
}

/** every face pushed out along its own normal, keeping wall thickness rather than scaling it */
export const expandBrush = (brush: Brush, by: number): BrushEdit =>
  rebuild(brush, brushPlanes(brush).map((p) => ({ source: p.source, plane: { n: p.plane.n, d: p.plane.d + by } })), "resizing the brush");

/**
 * Vertices dragged. The brush is rebuilt as the hull of its moved corners, which is what makes a corner
 * dragged flat against its neighbours merge into them instead of leaving an invisible crease, and what
 * makes a corner dragged past the far side simply refuse.
 */
export function moveVertices(brush: Brush, vertices: number[], delta: Vec3): BrushEdit {
  const chosen = new Set(vertices);
  const moved = brush.poly.vertices.map((v, i): Vec3 =>
    chosen.has(i) ? [v[0] + delta[0], v[1] + delta[1], v[2] + delta[2]] : v,
  );
  return hull(brush, moved, "moving the corner");
}

/** an edge dragged: both its ends, together */
export const moveEdge = (brush: Brush, a: number, b: number, delta: Vec3): BrushEdit =>
  moveVertices(brush, [a, b], delta);

/**
 * A corner removed. The brush closes over the gap — with a box that means a corner cut off flat, which
 * is exactly what the tool is for.
 */
export function removeVertex(brush: Brush, vertex: number): BrushEdit {
  const left = brush.poly.vertices.filter((_, i) => i !== vertex);
  if (left.length < 4) return { problems: ["a solid needs at least 4 corners"] };
  return hull(brush, left, "removing the corner");
}

/** a corner added at `at`, if it is outside the brush; inside, there is nothing for it to do */
export function addVertex(brush: Brush, at: Vec3): BrushEdit {
  return hull(brush, [...brush.poly.vertices, at], "adding a corner");
}

function hull(before: Brush, points: Vec3[], what: string): BrushEdit {
  const poly = fromPoints(points, brushPlanes(before));
  if (!poly) return { problems: [`${what} would leave nothing`] };
  const bad = integrity(poly);
  if (bad.length) return { problems: bad.map((b) => `${what}: ${b}`) };
  return { brush: settle(before, poly), problems: [], from: sourcesOf(poly) };
}

// ---------------------------------------------------------------- snapping

/**
 * Every corner pulled onto the grid, then the brush rebuilt from the corners that survive.
 *
 * Snapping is the operation most likely to destroy a brush, because a face thinner than one grid cell
 * collapses onto itself. So it is done as a hull of the snapped corners rather than by snapping the
 * planes: corners that land on top of each other merge, and if what is left is not a solid the brush is
 * refused rather than quietly flattened.
 */
export function snapBrush(brush: Brush, size: number): BrushEdit {
  const points = brush.poly.vertices.map((v): Vec3 => [snap(v[0], size), snap(v[1], size), snap(v[2], size)]);
  return hull(brush, points, "snapping to the grid");
}

/** how far the brush is from being on the grid, in metres — what the "snap" button greys out on */
export const gridError = (brush: Brush, size: number): number => {
  let worst = 0;
  for (const v of brush.poly.vertices) {
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(v[k]! - snap(v[k]!, size)));
  }
  return worst;
};

export const isOnGrid = (brush: Brush, size: number): boolean => gridError(brush, size) <= EPSILON;

// ---------------------------------------------------------------- integrity

/** everything wrong with a brush, in the words the issue browser shows */
export function brushProblems(brush: Brush): string[] {
  const out = integrity(brush.poly);
  if (brush.faces.length !== brush.poly.faces.length) {
    out.push(`${brush.faces.length} face descriptions for ${brush.poly.faces.length} faces`);
  }
  for (const [i, f] of brush.faces.entries()) {
    if (f.scale[0] === 0 || f.scale[1] === 0) out.push(`face ${i}: a scale of zero tiles the material infinitely`);
  }
  for (const [i, f] of brush.poly.faces.entries()) {
    if (!planeOfLoop(brush.poly.vertices, f.loop)) out.push(`face ${i}: too thin to have a normal`);
  }
  return out;
}
