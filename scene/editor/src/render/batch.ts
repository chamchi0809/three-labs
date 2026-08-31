/**
 * Every solid in the map, in one set of attribute arrays.
 *
 * A map is thousands of solids and one draw call. The arena decides where each one's vertices live; this
 * fills them in, and — the part that matters — keeps *what a solid looks like* separate from *where its
 * corners are*, in two attributes that are written independently.
 *
 * That split is the whole design. Selecting a face has to be free: a designer sweeping a selection across
 * a wall is doing it sixty times a second, and rebuilding geometry for it would make the editor feel like
 * mud. So selection, hover, lock and hide live in a one-float `flag` attribute, and changing them writes
 * one float per vertex of one face and uploads a few hundred bytes. Nothing is rebuilt, nothing is
 * reallocated, and the vertex positions are not even read.
 *
 * The `pick` attribute is the same idea pointed at the mouse: each vertex carries which solid and which
 * face it belongs to, so a pick is one small render target read rather than a ray cast through every
 * brush in the map. The ordinal in it is the batch's own numbering, not a NodeId — `idOf` turns it back.
 */
import type { BrushMesh } from "tscene";
import type { NodeId } from "../doc/document.ts";
import {
  clear as clearArena, flush as flushArena, markDirty, newArena, release, reserve, type Arena, type Span,
  type Upload,
} from "./arena.ts";

// ---------------------------------------------------------------- flags

/** the solid this face belongs to is selected */
export const SELECTED = 1;
/** this face in particular is selected, which is a different thing a designer can be doing */
export const FACE_SELECTED = 2;
/** in a locked layer: drawn, dimmed, and not pickable */
export const LOCKED = 4;
/** the mouse is over it */
export const HOVERED = 8;
/** part of the group the designer has stepped out of — drawn, but not theirs to touch right now */
export const OUTSIDE = 16;

/** what to draw a face as, per vertex; the material reads it as a bit field out of one float */
export type Flags = number;

// ---------------------------------------------------------------- the batch

/**
 * Where one face's vertices ended up, in the batch's own numbering rather than the mesh's.
 *
 * `slot` is which material the face draws with — an index into the palette, not a name. A number because
 * that is what `geometry.groups` takes, and because the whole point of assigning it once is that changing
 * how the map is *shaded* never has to walk the geometry again.
 */
export type FaceSpan = { face: number; start: number; count: number; slot: number };

type Entry = {
  span: Span;
  /** this solid's number in the batch, which is what the pick buffer carries */
  ordinal: number;
  faces: FaceSpan[];
  /** the axis-aligned box, kept so culling and framing never have to touch the vertex arrays */
  bounds: { min: [number, number, number]; max: [number, number, number] };
};

export type BrushBatch = {
  arena: Arena;
  /** vec3 */
  position: Float32Array;
  /** vec3 */
  normal: Float32Array;
  /** vec2, in metres of world per tile — the material divides by the material's own size */
  uv: Float32Array;
  /** float, a bit field of the constants above */
  flag: Float32Array;
  /** vec2: the solid's ordinal and the face's index */
  pick: Float32Array;
  entries: Map<NodeId, Entry>;
  byOrdinal: Map<number, NodeId>;
  /** ordinals given back, so a map edited all afternoon does not run its numbering into the millions */
  spare: number[];
  nextOrdinal: number;
  /**
   * Whether the draw groups have to be worked out again.
   *
   * A separate flag rather than a read of the arena's dirty ranges, because those are marked by
   * {@link setFlags} on every mouse move and rebuilding a sorted, merged group list at that rate would cost
   * more than the shading it pays for. Only geometry moving — a solid added, dropped, or written with
   * different materials — can change which vertices belong to which material.
   */
  groupsDirty: boolean;
};

export const newBatch = (): BrushBatch => ({
  arena: newArena(),
  position: new Float32Array(0),
  normal: new Float32Array(0),
  uv: new Float32Array(0),
  flag: new Float32Array(0),
  pick: new Float32Array(0),
  entries: new Map(),
  byOrdinal: new Map(),
  spare: [],
  nextOrdinal: 1, // 0 is "nothing", which is what an empty pick buffer reads as
  groupsDirty: false,
});

export const entryOf = (batch: BrushBatch, id: NodeId): Entry | undefined => batch.entries.get(id);
export const idOf = (batch: BrushBatch, ordinal: number): NodeId | undefined => batch.byOrdinal.get(ordinal);

// ---------------------------------------------------------------- putting a solid in

/**
 * One solid's geometry written into the batch.
 *
 * `flags` is asked per face rather than taken as one value, because a solid with one face selected is the
 * ordinary case in a brush editor and the alternative is two passes over the same vertices. `slots` is
 * asked the same way and for the same reason — the six sides of a room are routinely six materials.
 */
export function setBrush(
  batch: BrushBatch,
  id: NodeId,
  mesh: BrushMesh,
  flags: (face: number) => Flags = () => 0,
  slots: (face: number) => number = () => 0,
): void {
  const count = mesh.positions.length / 3;
  // where it was before the arena is asked: a solid whose vertex count changed is handed a *different*
  // span, and the one it gave up is a hole holding the triangles it was last drawn with
  const before = batch.entries.get(id)?.span;
  const span = reserve(batch.arena, id, count);
  fit(batch);
  // blanked before the new vertices go in, so a solid that shrank in place keeps what it is about to write
  if (before && (before.start !== span.start || before.count !== span.count)) blank(batch, before);

  const ordinal = batch.entries.get(id)?.ordinal ?? nextOrdinal(batch, id);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  batch.position.set(mesh.positions, span.start * 3);
  batch.normal.set(mesh.normals, span.start * 3);
  batch.uv.set(mesh.uvs, span.start * 2);

  for (let i = 0; i < count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const v = mesh.positions[i * 3 + axis]!;
      if (v < min[axis]!) min[axis] = v;
      if (v > max[axis]!) max[axis] = v;
    }
  }

  const faces: FaceSpan[] = [];
  for (const group of mesh.groups) {
    const start = span.start + group.start;
    faces.push({ face: group.face, start, count: group.count, slot: slots(group.face) });
    const flag = flags(group.face);
    for (let i = start; i < start + group.count; i++) {
      batch.flag[i] = flag;
      batch.pick[i * 2] = ordinal;
      batch.pick[i * 2 + 1] = group.face;
    }
  }

  batch.entries.set(id, { span, ordinal, faces, bounds: { min, max } });
  batch.groupsDirty = true;
}

/** a solid taken out: its space goes back and its ordinal is available again */
export function dropBrush(batch: BrushBatch, id: NodeId): void {
  const entry = batch.entries.get(id);
  if (!entry) return;
  batch.entries.delete(id);
  batch.byOrdinal.delete(entry.ordinal);
  batch.spare.push(entry.ordinal);
  batch.groupsDirty = true;

  // released first, because that is what pulls the high-water mark back over a span at the tail — and a
  // span above the mark is one `blank` then knows it has no work to do
  release(batch.arena, id);
  blank(batch, entry.span);
}

/**
 * Vertices a solid has stopped using, collapsed to the origin.
 *
 * A hole in the middle is still inside the draw range, and the vertices in it are the ones the solid left
 * behind — so a deleted wall would go on being drawn until something else claimed its space. Collapsing
 * every vertex to the origin makes each triangle zero-area, which rasterises nothing. Only the part still
 * below the high-water mark is worth touching: above it the draw range simply stops short.
 */
function blank(batch: BrushBatch, at: Span): void {
  const end = Math.min(at.start + at.count, batch.arena.used);
  if (end <= at.start) return;
  batch.position.fill(0, at.start * 3, end * 3);
  markDirty(batch.arena, { start: at.start, count: end - at.start });
}

/**
 * Where a ray meets one solid's own triangles — the nearest hit, in world metres.
 *
 * The pick buffer says *what* is under the cursor and the tools want to know *where*, and for a flat face
 * that second question is answered by meeting the face's plane: exact, and free. A patch has no plane. Its
 * surface is curved, so the only honest answer is the triangles it was actually drawn as — which the batch
 * is already holding, in the span this solid was written into. Nothing is rebuilt or tessellated again, and
 * only the one solid the pick already named is walked.
 */
export function meetSolid(
  batch: BrushBatch,
  id: NodeId,
  ray: { origin: readonly number[]; direction: readonly number[] },
): [number, number, number] | undefined {
  const entry = batch.entries.get(id);
  if (!entry) return undefined;
  const [ox, oy, oz] = [ray.origin[0]!, ray.origin[1]!, ray.origin[2]!];
  const [dx, dy, dz] = [ray.direction[0]!, ray.direction[1]!, ray.direction[2]!];
  const p = batch.position;
  let nearest = Infinity;
  const end = entry.span.start + entry.span.count;
  for (let v = entry.span.start; v + 2 < end; v += 3) {
    const t = meetTriangle(p, v, ox, oy, oz, dx, dy, dz);
    if (t !== undefined && t < nearest) nearest = t;
  }
  return nearest === Infinity ? undefined : [ox + dx * nearest, oy + dy * nearest, oz + dz * nearest];
}

/**
 * Möller–Trumbore, written out over the flat attribute array rather than over vectors.
 *
 * Both faces of the triangle count. A patch is a surface with an inside, a designer routinely stands in the
 * hollow of a cylinder they are building, and a hit test that only saw the front would leave them clicking
 * on nothing in exactly the place they meant.
 */
function meetTriangle(
  p: Float32Array, v: number,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
): number | undefined {
  const a = v * 3, b = (v + 1) * 3, c = (v + 2) * 3;
  const e1x = p[b]! - p[a]!, e1y = p[b + 1]! - p[a + 1]!, e1z = p[b + 2]! - p[a + 2]!;
  const e2x = p[c]! - p[a]!, e2y = p[c + 1]! - p[a + 1]!, e2z = p[c + 2]! - p[a + 2]!;
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-12) return undefined; // edge on: it covers no pixels, so it was not clicked
  const inv = 1 / det;
  const sx = ox - p[a]!, sy = oy - p[a + 1]!, sz = oz - p[a + 2]!;
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return undefined;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const w = (dx * qx + dy * qy + dz * qz) * inv;
  if (w < 0 || u + w > 1) return undefined;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-9 ? t : undefined;
}

export function clearBatch(batch: BrushBatch): void {
  clearArena(batch.arena);
  batch.entries.clear();
  batch.byOrdinal.clear();
  batch.spare.length = 0;
  batch.nextOrdinal = 1;
  batch.groupsDirty = true;
}

function nextOrdinal(batch: BrushBatch, id: NodeId): number {
  const ordinal = batch.spare.pop() ?? batch.nextOrdinal++;
  batch.byOrdinal.set(ordinal, id);
  return ordinal;
}

// ---------------------------------------------------------------- changing how it looks

/**
 * A solid's flags rewritten, and nothing else.
 *
 * This is the hot path — it runs on every mouse move that changes what is under the cursor — so it writes
 * one float per vertex and marks exactly the faces that changed. A face whose flags are already right is
 * not written at all, which is what keeps sweeping a selection across a wall from re-uploading the wall.
 */
export function setFlags(batch: BrushBatch, id: NodeId, flags: (face: number) => Flags): boolean {
  const entry = batch.entries.get(id);
  if (!entry) return false;
  let changed = false;
  for (const face of entry.faces) {
    const flag = flags(face.face);
    if (batch.flag[face.start] === flag) continue;
    batch.flag.fill(flag, face.start, face.start + face.count);
    markDirty(batch.arena, face);
    changed = true;
  }
  return changed;
}

/**
 * The draw groups the batch's faces make up: one run of vertices per material, in vertex order.
 *
 * three draws one group at a time, so the count here is the map's draw call count — which is why adjacent
 * runs of the same slot are merged rather than emitted per face. A solid's six sides land next to each
 * other in the arena and are usually one material, so the merge typically turns six groups into one, and a
 * map with two materials in it draws in nearly two calls rather than in thousands.
 *
 * Sorted by start because the arena hands out space in whatever order solids arrived and three walks the
 * index buffer forwards; an unsorted group list would draw the same map with the vertices in it visited out
 * of order, which is slower for no reason at all.
 */
export function materialGroups(batch: BrushBatch): { start: number; count: number; materialIndex: number }[] {
  const spans: FaceSpan[] = [];
  for (const entry of batch.entries.values()) spans.push(...entry.faces);
  spans.sort((a, b) => a.start - b.start);

  const groups: { start: number; count: number; materialIndex: number }[] = [];
  for (const span of spans) {
    const last = groups[groups.length - 1];
    if (last && last.materialIndex === span.slot && last.start + last.count === span.start) {
      last.count += span.count;
      continue;
    }
    groups.push({ start: span.start, count: span.count, materialIndex: span.slot });
  }
  batch.groupsDirty = false;
  return groups;
}

/** the flags one face is currently drawn with — what the renderer's own checks compare against */
export const flagsOf = (batch: BrushBatch, id: NodeId, face: number): Flags | undefined => {
  const at = batch.entries.get(id)?.faces.find((f) => f.face === face);
  return at ? batch.flag[at.start] : undefined;
};

// ---------------------------------------------------------------- uploading

/**
 * Attribute arrays grown to the arena's capacity, keeping what is already in them.
 *
 * Called after every reserve rather than before, because the arena is the thing that knows whether it had
 * to grow — and asking it after means the answer is about the allocation that just happened rather than a
 * guess about the one about to.
 */
function fit(batch: BrushBatch) {
  const want = batch.arena.capacity;
  if (batch.flag.length >= want) return;
  batch.position = grown(batch.position, want * 3);
  batch.normal = grown(batch.normal, want * 3);
  batch.uv = grown(batch.uv, want * 2);
  batch.flag = grown(batch.flag, want);
  batch.pick = grown(batch.pick, want * 2);
}

const grown = (was: Float32Array, size: number): Float32Array => {
  const next = new Float32Array(size);
  next.set(was);
  return next;
};

/**
 * What to send to the GPU, in *vertices*. Every attribute is uploaded over the same ranges, because a
 * vertex is written as a whole and splitting the bookkeeping five ways would buy nothing back.
 */
export const flushBatch = (batch: BrushBatch): Upload => flushArena(batch.arena);

/** the box around everything in the batch — what "frame all" and the far plane are worked out from */
export function batchBounds(batch: BrushBatch): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const entry of batch.entries.values()) {
    for (let axis = 0; axis < 3; axis++) {
      if (entry.bounds.min[axis]! < min[axis]!) min[axis] = entry.bounds.min[axis]!;
      if (entry.bounds.max[axis]! > max[axis]!) max[axis] = entry.bounds.max[axis]!;
    }
  }
  return { min, max };
}
