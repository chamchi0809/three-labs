/**
 * A patch: the control grid, plus what the whole surface is made of.
 *
 * The maths is tscene's — `buildPatch` and friends — because the runtime and the editor have to agree on
 * where a curve goes down to the last vertex, and two implementations of a Bezier evaluator agree right up
 * until the day somebody fixes one of them. What lives here is the part the runtime has no use for: the
 * material by `--var` name, the handles a tool drags, and the operations that keep a grid a grid.
 *
 * One material for the whole surface, unlike a brush's one per face. That is not a simplification: a patch
 * exists to be continuous, and a seam is exactly what it was reached for instead of.
 *
 * Like the brush module, nothing throws. A patch mid-drag is often a grid with a fold in it, and a tool
 * wants to hear about that rather than catch it.
 */
import {
  buildPatch, flipPatch as flipGrid, gridProblems, insertColumn, insertRow, patchBounds, patchOfShape,
  removeColumn, removeRow, spansIn, subdivisionsFor, transformPatch as transformGrid, type BrushMesh,
  type PatchGrid, type PatchMesh, type PatchShape, type Vec2, type Vec3,
} from "tscene";
import { snap } from "../grid/snap.ts";
import { add, distance, type Mat4 } from "../brush/vec.ts";

export type { PatchGrid, PatchMesh, PatchShape };

/** how the one material is laid out along the surface — a face's four knobs, in the same units */
export type PatchUv = {
  /** metres along the surface's own u and v */
  offset: Vec2;
  /** metres of world along the surface per full texture tile */
  scale: Vec2;
  /** radians */
  rotation: number;
};

export type Patch = {
  grid: PatchGrid;
  /** the name of a `--var` holding a material, or undefined for the default */
  material?: string;
  uv: PatchUv;
  /** segments per span, or undefined to let the curvature pick — which is what a sheet usually says */
  subdivisions?: number;
};

/** where a control point is: `grid[row][column]` */
export type PatchPoint = { row: number; column: number };

export const DEFAULT_UV: PatchUv = { offset: [0, 0], scale: [1, 1], rotation: 0 };

export const patchUv = (over: Partial<PatchUv> = {}): PatchUv => ({
  ...DEFAULT_UV,
  offset: [...DEFAULT_UV.offset],
  scale: [...DEFAULT_UV.scale],
  ...over,
});

export const patchOf = (grid: PatchGrid, over: Partial<Patch> = {}): Patch => ({
  ...over,
  grid,
  uv: patchUv(over.uv),
});

/** a patch of one of the primitive shapes, sized to a box the way the shape tool draws one */
export const patchShape = (shape: PatchShape, min: Vec3, max: Vec3, over: Partial<Patch> = {}): Patch =>
  patchOf(patchOfShape(shape, min, max), over);

// ---------------------------------------------------------------- shape

export const rowsOf = (grid: PatchGrid): number => grid.length;
export const columnsOf = (grid: PatchGrid): number => grid[0]?.length ?? 0;

/** how many spans the grid has each way — the unit a row or column is inserted and removed by */
export const spansOf = (grid: PatchGrid): { down: number; across: number } => ({
  down: spansIn(rowsOf(grid)),
  across: spansIn(columnsOf(grid)),
});

/** every control point, flattened — what the handle renderer and the box selector both walk */
export function patchPoints(grid: PatchGrid): (PatchPoint & { at: Vec3 })[] {
  const out: (PatchPoint & { at: Vec3 })[] = [];
  for (const [row, line] of grid.entries()) for (const [column, at] of line.entries()) out.push({ row, column, at });
  return out;
}

export const pointAt = (grid: PatchGrid, p: PatchPoint): Vec3 | undefined => grid[p.row]?.[p.column];

/**
 * The segments of the control net, as pairs of points.
 *
 * Drawn because the handle is not on the surface: at the middle of a span the curve reaches only half way
 * to the middle control point, so a designer dragging a handle in mid-air needs to see what it is attached
 * to or the drag looks like it did nothing.
 */
export function patchHull(grid: PatchGrid): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  for (const line of grid) for (let c = 1; c < line.length; c++) out.push([line[c - 1]!, line[c]!]);
  for (let r = 1; r < grid.length; r++) {
    const above = grid[r - 1]!;
    const line = grid[r]!;
    for (let c = 0; c < Math.min(above.length, line.length); c++) out.push([above[c]!, line[c]!]);
  }
  return out;
}

export const patchCentre = (grid: PatchGrid): Vec3 => {
  const b = patchBounds(grid);
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
};

export { patchBounds, subdivisionsFor };

// ---------------------------------------------------------------- building

/** the mesh a patch draws as, or the reasons it is not a patch at all */
export function patchToMesh(patch: Patch): { mesh?: PatchMesh; problems: string[] } {
  const { mesh, problems } = buildPatch({
    grid: patch.grid,
    offset: patch.uv.offset,
    scale: patch.uv.scale,
    rotation: patch.uv.rotation,
    ...(patch.subdivisions !== undefined ? { subdivisions: patch.subdivisions } : {}),
  });
  return { ...(mesh ? { mesh } : {}), problems: problems.map((p) => p.message) };
}

/** what is wrong with the grid, in the checker's own words, so the editor and a build agree */
export const patchProblems = (patch: Patch): string[] => gridProblems(patch.grid).map((p) => p.message);

/**
 * The same surface in the shape a solid's mesh has, so that one batch and one draw call hold both.
 *
 * The index buffer is expanded to loose triples, which is the one real cost here and is worth it: it buys
 * a patch every piece of machinery the solids already have — selection and hover in the flag attribute,
 * the pick buffer, the material slots, the frame-selection box — without a second code path anywhere.
 *
 * One group, numbered face 0, because a patch is one surface. That is also what makes a pick on a patch
 * come back as `face: 0` rather than as nothing, which is the answer the face inspector wants: there is a
 * surface here and this is it.
 */
export function patchToBrushMesh(patch: Patch): { mesh?: BrushMesh; problems: string[] } {
  const { mesh, problems } = patchToMesh(patch);
  if (!mesh) return { problems };

  const count = mesh.indices.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const v = mesh.indices[i]!;
    for (const a of [0, 1, 2]) {
      positions[i * 3 + a] = mesh.positions[v * 3 + a]!;
      normals[i * 3 + a] = mesh.normals[v * 3 + a]!;
    }
    uvs[i * 2] = mesh.uvs[v * 2]!;
    uvs[i * 2 + 1] = mesh.uvs[v * 2 + 1]!;
  }
  // no polygons: a patch has no flat face for vertex editing or the uv editor to take hold of, and an
  // empty list is how the machinery that walks them says "nothing here" rather than "a face of no corners"
  return { mesh: { positions, normals, uvs, groups: [{ start: 0, count, face: 0 }], polygons: [] }, problems };
}

/** the control net, flattened into the six-numbers-per-segment the line batch takes */
export function hullSegments(grid: PatchGrid): Float32Array {
  const hull = patchHull(grid);
  const out = new Float32Array(hull.length * 6);
  for (const [i, [a, b]] of hull.entries()) {
    out.set(a, i * 6);
    out.set(b, i * 6 + 3);
  }
  return out;
}

// ---------------------------------------------------------------- editing

const withGrid = (patch: Patch, grid: PatchGrid): Patch => (grid === patch.grid ? patch : { ...patch, grid });

/**
 * The whole grid through a matrix.
 *
 * The control points, not the surface: a quadratic Bezier is affine-invariant, so transforming the handles
 * transforms the curve exactly, and doing it the other way round would mean re-fitting a grid to a set of
 * moved vertices — which is both slower and lossy.
 *
 * `Mat4` here is the editor's row-major 3x4; tscene's takes three's column-major 4x4, so this converts.
 */
export const transformPatch = (patch: Patch, m: Mat4): Patch =>
  withGrid(patch, transformGrid(patch.grid, [
    m[0], m[4], m[8], 0,
    m[1], m[5], m[9], 0,
    m[2], m[6], m[10], 0,
    m[3], m[7], m[11], 1,
  ]));

/**
 * The surface turned inside out.
 *
 * Reversing the rows rather than the columns, because that is the direction `buildPatch` takes the cross
 * product in: a cylinder flipped this way is a tunnel with its walls facing the corridor, which is the
 * reason to have the operation at all.
 */
export const flip = (patch: Patch): Patch => withGrid(patch, flipGrid(patch.grid));

export const addRow = (patch: Patch, span: number): Patch => withGrid(patch, insertRow(patch.grid, span));
export const addColumn = (patch: Patch, span: number): Patch => withGrid(patch, insertColumn(patch.grid, span));
export const dropRow = (patch: Patch, span: number): Patch => withGrid(patch, removeRow(patch.grid, span));
export const dropColumn = (patch: Patch, span: number): Patch => withGrid(patch, removeColumn(patch.grid, span));

const WELD = 1e-6;

/**
 * Control points moved.
 *
 * `weld` also moves any point sitting exactly on one of the named ones, which is what makes a closed patch
 * editable at all: a cylinder's first and last column are the same point written twice, and dragging one of
 * them alone tears the seam open in a way nothing in the editor would ever put back. A cone's tip is nine
 * copies of one point for the same reason.
 */
export function movePoints(patch: Patch, points: PatchPoint[], delta: Vec3, weld = true): Patch {
  const moving = new Set(points.map((p) => `${p.row},${p.column}`));
  const twins = weld ? points.map((p) => pointAt(patch.grid, p)).filter((p): p is Vec3 => !!p) : [];
  const grid = patch.grid.map((line, row) =>
    line.map((at, column) =>
      moving.has(`${row},${column}`) || twins.some((t) => distance(t, at) <= WELD) ? add(at, delta) : at,
    ),
  );
  return withGrid(patch, grid);
}

/** every control point on the grid, which is what a drag with nothing picked in particular moves */
export const movePatch = (patch: Patch, delta: Vec3): Patch =>
  withGrid(patch, patch.grid.map((line) => line.map((p) => add(p, delta))));

export const snapPatch = (patch: Patch, size: number): Patch =>
  withGrid(patch, patch.grid.map((line) => line.map((p): Vec3 => [snap(p[0], size), snap(p[1], size), snap(p[2], size)])));

export const gridError = (patch: Patch, size: number): number =>
  Math.max(0, ...patchPoints(patch.grid).flatMap(({ at }) => at.map((n) => Math.abs(n - snap(n, size)))));

export const isOnGrid = (patch: Patch, size: number): boolean => gridError(patch, size) <= WELD;

// ---------------------------------------------------------------- the sheet, one way in

/**
 * The grid a `patch { row(…) … }` describes, or nothing when it is not one.
 *
 * Ragged and even-sided grids are refused here rather than repaired: the sheet is somebody's file, and a
 * patch the editor could not read stays an entity, is drawn by the runtime, and survives a save untouched.
 */
export function gridFromRows(rows: (Vec3 | undefined)[][]): PatchGrid | undefined {
  const grid: PatchGrid = [];
  for (const row of rows) {
    if (!row.every((p): p is Vec3 => !!p)) return undefined;
    grid.push(row);
  }
  return gridProblems(grid).length ? undefined : grid;
}
