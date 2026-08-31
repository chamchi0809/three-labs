// Bezier patches: a curved surface described by a grid of control points, the way Quake 3 and Radiant
// describe one. Pure arithmetic — no three import — so the checker can run it on literal coordinates and
// say "this grid has an even number of rows" at build time instead of a sheet rendering nothing.
//
// The grid is a tensor product of *quadratic* Bezier curves, which is the whole of the format: three
// control points to a span, spans sharing their end points, so a grid is always odd by odd and at least
// 3 x 3. Cubic patches would be smoother and would also be a second thing to teach every tool in the
// editor; a quadratic grid gets the same shapes out of more control points, which is what a level designer
// is dragging anyway.
//
// The surface interpolates its corners and the midpoint of every span, and only approximates the rest —
// the middle control point of a span is a handle that pulls, not a point on the surface. That is the one
// thing about patches that surprises people, and it is why the editor draws the control hull.

// the brush module's, not a second pair of aliases: one definition of "three numbers" in the package is
// what keeps a patch and a brush interchangeable everywhere a tool moves either of them
import type { Vec2, Vec3 } from "./brush.ts";

export type { Vec2, Vec3 };

/**
 * The control points, row-major: `grid[row][column]`. Both counts are odd and at least three, which is
 * what makes the grid an exact number of spans in each direction.
 *
 * Rows run along v and columns along u, the same way an image's rows run down and its columns run across.
 */
export type PatchGrid = Vec3[][];

export type Patch = {
  grid: PatchGrid;
  /** metres of world per full texture tile, along the surface — not a multiplier */
  scale?: Vec2;
  /** metres along the surface's own u and v */
  offset?: Vec2;
  /** radians, in the material's own plane */
  rotation?: number;
  /**
   * Segments per span. Omitted means "as many as the curvature needs", which is what keeps a barely-bent
   * patch from costing sixteen rows and a tight one from looking like a folded map.
   */
  subdivisions?: number;
};

export type PatchMesh = {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** the tessellated grid, which is what a tool walks to find the row under the cursor */
  rows: number;
  columns: number;
};

export type PatchProblem = {
  /** the row this is about, or -1 for the grid as a whole */
  row: number;
  message: string;
};

export type PatchResult = { mesh?: PatchMesh; problems: PatchProblem[] };

// ---------------------------------------------------------------- vector arithmetic

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.sqrt(dot(a, a));
const scaled = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

function normalize(a: Vec3): Vec3 | undefined {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : undefined;
}

// ---------------------------------------------------------------- the quadratic

/** how many spans a count of control points is; 3 points is one span, 5 is two, and so on */
export const spansIn = (points: number): number => (points - 1) / 2;

/** `(1-t)²P0 + 2t(1-t)P1 + t²P2` */
const at = (p0: Vec3, p1: Vec3, p2: Vec3, t: number): Vec3 => {
  const s = 1 - t;
  const [a, b, c] = [s * s, 2 * t * s, t * t];
  return [p0[0] * a + p1[0] * b + p2[0] * c, p0[1] * a + p1[1] * b + p2[1] * c, p0[2] * a + p1[2] * b + p2[2] * c];
};

/** the tangent of the same curve, which is `2((1-t)(P1-P0) + t(P2-P1))` and is not normalised */
const tangentAt = (p0: Vec3, p1: Vec3, p2: Vec3, t: number): Vec3 =>
  scaled(add(scaled(sub(p1, p0), 1 - t), scaled(sub(p2, p1), t)), 2);

/**
 * A parameter over the whole row, in `[0, spans]`, split into the span it lands in and the `t` inside it.
 *
 * The last point belongs to the last span rather than opening a new one, which is the entire reason this
 * is a function rather than two lines at each call site.
 */
function spanAt(g: number, spans: number): { span: number; t: number } {
  const span = Math.min(Math.floor(g), spans - 1);
  return { span, t: g - span };
}

/** where the surface is at `(u, v)`, each in `[0, spans]` of its own direction */
export function pointOn(grid: PatchGrid, u: number, v: number): Vec3 {
  const { span: cs, t: cu } = spanAt(u, spansIn(grid[0]!.length));
  const { span: rs, t: rv } = spanAt(v, spansIn(grid.length));
  const across = [0, 1, 2].map((i) => {
    const row = grid[2 * rs + i]!;
    return at(row[2 * cs]!, row[2 * cs + 1]!, row[2 * cs + 2]!, cu);
  }) as [Vec3, Vec3, Vec3];
  return at(across[0], across[1], across[2], rv);
}

/**
 * The outward normal at `(u, v)`, from the two partial derivatives.
 *
 * A patch can have a seam where both derivatives vanish — the tip of a cone is the usual one — and there
 * the cross product is nothing at all. Rather than hand back a zero vector for the renderer to divide by,
 * the sample is nudged a hair into the patch and taken again, which is the normal of the surface *beside*
 * the singularity and is what any eye would call the normal of the tip.
 */
export function normalOn(grid: PatchGrid, u: number, v: number): Vec3 {
  const us = spansIn(grid[0]!.length);
  const vs = spansIn(grid.length);
  const n = normalize(cross(dv(grid, u, v), du(grid, u, v)));
  if (n) return n;
  const nudge = 1e-3;
  const u2 = Math.min(Math.max(u + (u < us / 2 ? nudge : -nudge), 0), us);
  const v2 = Math.min(Math.max(v + (v < vs / 2 ? nudge : -nudge), 0), vs);
  return normalize(cross(dv(grid, u2, v2), du(grid, u2, v2))) ?? [0, 1, 0];
}

/** ∂P/∂u — the row curves differentiated across, then blended down */
function du(grid: PatchGrid, u: number, v: number): Vec3 {
  const { span: cs, t: cu } = spanAt(u, spansIn(grid[0]!.length));
  const { span: rs, t: rv } = spanAt(v, spansIn(grid.length));
  const across = [0, 1, 2].map((i) => {
    const row = grid[2 * rs + i]!;
    return tangentAt(row[2 * cs]!, row[2 * cs + 1]!, row[2 * cs + 2]!, cu);
  }) as [Vec3, Vec3, Vec3];
  return at(across[0], across[1], across[2], rv);
}

/** ∂P/∂v — the row curves evaluated across, then differentiated down */
function dv(grid: PatchGrid, u: number, v: number): Vec3 {
  const { span: cs, t: cu } = spanAt(u, spansIn(grid[0]!.length));
  const { span: rs, t: rv } = spanAt(v, spansIn(grid.length));
  const across = [0, 1, 2].map((i) => {
    const row = grid[2 * rs + i]!;
    return at(row[2 * cs]!, row[2 * cs + 1]!, row[2 * cs + 2]!, cu);
  }) as [Vec3, Vec3, Vec3];
  return tangentAt(across[0], across[1], across[2], rv);
}

// ---------------------------------------------------------------- how fine to cut it

/** the most segments a span is ever cut into, however bent it is — past this nobody can see the difference */
export const MAX_SUBDIVISIONS = 16;

/**
 * How far a span bows away from the straight line between its ends: the distance from the midpoint of the
 * chord to the point the curve actually reaches at `t = 0.5`, which is a quarter of the way from the chord
 * midpoint to the middle control point.
 */
const bow = (p0: Vec3, p1: Vec3, p2: Vec3): number => len(sub(mid(p0, p2), p1)) / 4;

/**
 * Segments per span, from the curvature, unless the patch says.
 *
 * One number for the whole patch rather than one per span, because the tessellation has to stay a regular
 * grid for the index buffer — and a patch whose spans need wildly different densities is a patch that
 * wants splitting, not a cleverer tessellator.
 *
 * The rule is the usual one: halving the segment count quadruples the error, so the count that keeps the
 * error under a tolerance goes as the square root of the bow. A millimetre of tolerance puts a metre-deep
 * bend at about the maximum and leaves a nearly flat patch as two triangles.
 */
export function subdivisionsFor(patch: Patch, tolerance = 0.001): number {
  if (patch.subdivisions !== undefined) return Math.min(Math.max(Math.round(patch.subdivisions), 1), MAX_SUBDIVISIONS);
  let worst = 0;
  const { grid } = patch;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c + 2 < grid[r]!.length; c += 2) {
      worst = Math.max(worst, bow(grid[r]![c]!, grid[r]![c + 1]!, grid[r]![c + 2]!));
    }
  }
  for (let c = 0; c < grid[0]!.length; c++) {
    for (let r = 0; r + 2 < grid.length; r += 2) {
      worst = Math.max(worst, bow(grid[r]![c]!, grid[r + 1]![c]!, grid[r + 2]![c]!));
    }
  }
  return Math.min(Math.max(Math.ceil(Math.sqrt(worst / tolerance)), 1), MAX_SUBDIVISIONS);
}

// ---------------------------------------------------------------- checking a grid

/**
 * What is wrong with a control grid, if anything. Reported as a list rather than thrown, because the
 * checker wants to name every mistake in a sheet at once and a patch with two short rows has two.
 */
export function gridProblems(grid: PatchGrid): PatchProblem[] {
  const out: PatchProblem[] = [];
  if (grid.length < 3) out.push({ row: -1, message: "a patch needs at least three rows of control points" });
  else if (grid.length % 2 === 0) {
    out.push({ row: -1, message: `a patch needs an odd number of rows, and this one has ${grid.length}` });
  }
  const width = grid[0]?.length ?? 0;
  if (width < 3) out.push({ row: 0, message: "a row of a patch needs at least three control points" });
  else if (width % 2 === 0) {
    out.push({ row: 0, message: `a row of a patch needs an odd number of control points, and this one has ${width}` });
  }
  for (let r = 1; r < grid.length; r++) {
    if (grid[r]!.length !== width) {
      out.push({ row: r, message: `every row of a patch is the same length, and this one has ${grid[r]!.length} where the first has ${width}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- uv

/**
 * Where each tessellated column and row sits along the material, in metres of surface.
 *
 * Measured along the surface rather than taken from the parameter, because the parameter is not
 * proportional to distance — a span whose middle control point is off to one side covers more ground in
 * its second half than its first, and a texture laid out by parameter visibly bunches up there. Averaging
 * the arc length across all the rows (and all the columns) gives one ruler for the whole patch, which is
 * what keeps the grid rectangular in uv even when the surface is not.
 */
function rulers(points: Vec3[][], rows: number, columns: number): { u: Float64Array; v: Float64Array } {
  const u = new Float64Array(columns);
  const v = new Float64Array(rows);
  for (let c = 1; c < columns; c++) {
    let total = 0;
    for (let r = 0; r < rows; r++) total += len(sub(points[r]![c]!, points[r]![c - 1]!));
    u[c] = u[c - 1]! + total / rows;
  }
  for (let r = 1; r < rows; r++) {
    let total = 0;
    for (let c = 0; c < columns; c++) total += len(sub(points[r]![c]!, points[r - 1]![c]!));
    v[r] = v[r - 1]! + total / columns;
  }
  return { u, v };
}

/** a point on the material, from its place along the two rulers */
function uvOf(patch: Patch, s: number, t: number): Vec2 {
  const [ox, oy] = patch.offset ?? [0, 0];
  const [sx, sy] = patch.scale ?? [1, 1];
  const [a, b] = [(s + ox) / (sx || 1), (t + oy) / (sy || 1)];
  if (!patch.rotation) return [a, b];
  const [c, d] = [Math.cos(patch.rotation), Math.sin(patch.rotation)];
  return [a * c - b * d, a * d + b * c];
}

// ---------------------------------------------------------------- tessellation

/**
 * The patch as a mesh: an indexed grid of quads, two triangles each, wound so the normal of the triangle
 * agrees with the normal of the surface.
 *
 * Indexed rather than the loose triples a brush produces, because the whole point of a patch is that it is
 * smooth — the vertices *are* shared, the normals *are* averaged by sharing them, and a patch tessellated
 * flat-shaded would be a patch that looks exactly like the low-poly thing it exists to avoid.
 */
export function buildPatch(patch: Patch): PatchResult {
  const problems = gridProblems(patch.grid);
  if (problems.length) return { problems };

  const n = subdivisionsFor(patch);
  const us = spansIn(patch.grid[0]!.length);
  const vs = spansIn(patch.grid.length);
  const columns = us * n + 1;
  const rows = vs * n + 1;

  const points: Vec3[][] = [];
  const normals: Vec3[][] = [];
  for (let r = 0; r < rows; r++) {
    const pr: Vec3[] = [];
    const nr: Vec3[] = [];
    for (let c = 0; c < columns; c++) {
      pr.push(pointOn(patch.grid, (c / n), (r / n)));
      nr.push(normalOn(patch.grid, (c / n), (r / n)));
    }
    points.push(pr);
    normals.push(nr);
  }

  const ruler = rulers(points, rows, columns);
  const count = rows * columns;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = r * columns + c;
      position.set(points[r]![c]!, i * 3);
      normal.set(normals[r]![c]!, i * 3);
      uv.set(uvOf(patch, ruler.u[c]!, ruler.v[r]!), i * 2);
    }
  }

  const indices = new Uint32Array((rows - 1) * (columns - 1) * 6);
  let w = 0;
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < columns; c++) {
      const a = r * columns + c;
      const b = a + 1;
      const d = a + columns;
      const e = d + 1;
      indices[w++] = a; indices[w++] = d; indices[w++] = b;
      indices[w++] = b; indices[w++] = d; indices[w++] = e;
    }
  }

  return { mesh: { positions: position, normals: normal, uvs: uv, indices, rows, columns }, problems: [] };
}

/**
 * The box the patch fits in.
 *
 * The control points, not the surface: a quadratic Bezier lies inside the convex hull of its control
 * points, so this never cuts the surface off, and it is what a designer sees when the control hull is
 * drawn. Tessellating first would give a tighter box that changed every time the subdivision did.
 */
export function patchBounds(grid: PatchGrid): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const row of grid) {
    for (const p of row) {
      for (let i = 0; i < 3; i++) {
        if (p[i]! < min[i]!) min[i] = p[i]!;
        if (p[i]! > max[i]!) max[i] = p[i]!;
      }
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------- primitives

/**
 * The radius the middle control point of a quarter-turn sits at.
 *
 * A quadratic Bezier cannot be a circular arc, and the closest anyone gets is to put the handle where the
 * two end tangents meet — the corner of the square the quarter fits in, which is `√2` out. Radiant builds
 * its cylinders this way and so does every map that has ever been made in it, so a cylinder here has the
 * same silhouette as a cylinder there rather than one that is technically rounder.
 */
const CORNER = Math.SQRT2;

/**
 * Control points of a full turn about the origin in the xz plane, nine of them, the last on top of the
 * first.
 *
 * Wound so that a patch built from it and stacked upwards faces *out*, which is what a pillar wants and
 * is one `flipPatch` away from what a tunnel wants. Winding it the other way would make every cylinder in
 * the editor inside-out and every cone's tip point down.
 */
const turn = (radius: number): Vec3[] =>
  Array.from({ length: 9 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const r = i % 2 === 0 ? radius : radius * CORNER;
    return [Math.cos(a) * r, 0, Math.sin(a) * r] as Vec3;
  });

const lift = (row: Vec3[], y: number): Vec3[] => row.map(([x, , z]) => [x, y, z] as Vec3);

/** a flat 3 x 3 patch spanning a box's footprint at its floor — the thing to bend into everything else */
export function planePatch(min: Vec3, max: Vec3): PatchGrid {
  const xs = [min[0]!, (min[0]! + max[0]!) / 2, max[0]!];
  const zs = [min[2]!, (min[2]! + max[2]!) / 2, max[2]!];
  return zs.map((z) => xs.map((x) => [x, min[1]!, z] as Vec3));
}

/** an open tube filling the box, nine columns round and three rows tall */
export function cylinderPatch(min: Vec3, max: Vec3): PatchGrid {
  const c = centreOf(min, max);
  const ring = turn(1).map(([x, , z]) => [c[0]! + x * radiusX(min, max), 0, c[2]! + z * radiusZ(min, max)] as Vec3);
  return [min[1]!, (min[1]! + max[1]!) / 2, max[1]!].map((y) => lift(ring, y));
}

/** a tube that closes to a point at the top of the box */
export function conePatch(min: Vec3, max: Vec3): PatchGrid {
  const grid = cylinderPatch(min, max);
  const c = centreOf(min, max);
  // the tip is one row of nine points that are all the same place: a degenerate row is how a patch grid
  // says "this edge is a point", and it is what the normal's nudge exists to survive
  grid[2] = grid[2]!.map(() => [c[0]!, max[1]!, c[2]!] as Vec3);
  // and the middle row is pulled halfway in, so the side is straight rather than bulging
  grid[1] = grid[1]!.map((p, i) => {
    const t = mid(grid[0]![i]!, grid[2]![i]!);
    return [t[0]!, p[1]!, t[2]!] as Vec3;
  });
  return grid;
}

/** the top half of a sphere filling the box: five rows from the equator to a single point */
export function domePatch(min: Vec3, max: Vec3): PatchGrid {
  const c = centreOf(min, max);
  const [rx, rz] = [radiusX(min, max), radiusZ(min, max)];
  const height = max[1]! - min[1]!;
  const ring = turn(1);
  // the same quarter-turn trick in the vertical: equator, corner, pole, and the corner row is the one
  // that is `√2` out in both the radius and the height
  const rows: [number, number][] = [[1, 0], [CORNER, CORNER], [0, 1]];
  return rows.map(([f, h]) =>
    ring.map(([x, , z]) => [c[0]! + x * rx * f, min[1]! + height * h, c[2]! + z * rz * f] as Vec3));
}

/**
 * A quarter-turn that fills the corner of the box — what a wall does when it turns, and the patch a
 * designer reaches for most often after the plain cylinder.
 */
export function bevelPatch(min: Vec3, max: Vec3): PatchGrid {
  const [rx, rz] = [max[0]! - min[0]!, max[2]! - min[2]!];
  const arc: Vec3[] = [
    [max[0]!, 0, min[2]!],
    [max[0]! - rx * (1 - CORNER / 2), 0, min[2]! + rz * (1 - CORNER / 2)],
    [min[0]!, 0, max[2]!],
  ];
  return [min[1]!, (min[1]! + max[1]!) / 2, max[1]!].map((y) => lift(arc, y));
}

const centreOf = (min: Vec3, max: Vec3): Vec3 => mid(min, max);
const radiusX = (min: Vec3, max: Vec3): number => (max[0]! - min[0]!) / 2;
const radiusZ = (min: Vec3, max: Vec3): number => (max[2]! - min[2]!) / 2;

/** every primitive a patch can be made as, in the order the tool lists them */
export const PATCH_SHAPES = ["plane", "cylinder", "cone", "dome", "bevel"] as const;
export type PatchShape = (typeof PATCH_SHAPES)[number];

export function patchOfShape(shape: PatchShape, min: Vec3, max: Vec3): PatchGrid {
  switch (shape) {
    case "cylinder": return cylinderPatch(min, max);
    case "cone": return conePatch(min, max);
    case "dome": return domePatch(min, max);
    case "bevel": return bevelPatch(min, max);
    default: return planePatch(min, max);
  }
}

// ---------------------------------------------------------------- editing the grid

/** the grid with one row of spans added after `span`, the surface unchanged — a de Casteljau split */
export const insertRow = (grid: PatchGrid, span: number): PatchGrid => split(grid, span, true);

/** the same, across: one more span of columns, and the surface it had before */
export const insertColumn = (grid: PatchGrid, span: number): PatchGrid => split(grid, span, false);

/**
 * Splitting a span in half, which is the only way to add control points without moving the surface.
 *
 * De Casteljau: the three points of a span become five, the new ends being the midpoints of the two
 * handles and the new middle being the point the curve was already passing through. Every other row (or
 * column) is copied straight across, which is why one function does both directions.
 */
function split(grid: PatchGrid, span: number, down: boolean): PatchGrid {
  const rows = grid.length;
  const columns = grid[0]!.length;
  const read = (r: number, c: number): Vec3 => grid[r]![c]!;
  const along = down ? rows : columns;
  const spans = spansIn(along);
  const k = 2 * Math.min(Math.max(span, 0), spans - 1);
  const other = down ? columns : rows;
  const out: Vec3[][] = Array.from({ length: down ? rows + 2 : rows }, () => new Array<Vec3>(down ? columns : columns + 2));
  for (let o = 0; o < other; o++) {
    const line: Vec3[] = [];
    for (let i = 0; i < along; i++) line.push(down ? read(i, o) : read(o, i));
    const [p0, p1, p2] = [line[k]!, line[k + 1]!, line[k + 2]!];
    const [a, b] = [mid(p0, p1), mid(p1, p2)];
    const m = mid(a, b);
    const grown = [...line.slice(0, k + 1), a, m, b, ...line.slice(k + 2)];
    for (let i = 0; i < grown.length; i++) {
      if (down) out[i]![o] = grown[i]!;
      else out[o]![i] = grown[i]!;
    }
  }
  return out;
}

/** the grid with a span of rows dropped, or the grid unchanged when it is down to its last one */
export function removeRow(grid: PatchGrid, span: number): PatchGrid {
  if (spansIn(grid.length) < 2) return grid;
  const k = 2 * Math.min(Math.max(span, 0), spansIn(grid.length) - 1);
  return [...grid.slice(0, k), ...grid.slice(k + 2)];
}

/** the same, across */
export function removeColumn(grid: PatchGrid, span: number): PatchGrid {
  if (spansIn(grid[0]!.length) < 2) return grid;
  const k = 2 * Math.min(Math.max(span, 0), spansIn(grid[0]!.length) - 1);
  return grid.map((row) => [...row.slice(0, k), ...row.slice(k + 2)]);
}

/** the grid with its rows reversed, which turns the surface inside out */
export const flipPatch = (grid: PatchGrid): PatchGrid => [...grid].reverse();

/** the grid with every control point moved through a 4x4, column-major the way three stores one */
export function transformPatch(grid: PatchGrid, m: number[]): PatchGrid {
  return grid.map((row) => row.map(([x, y, z]) => [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ] as Vec3));
}
