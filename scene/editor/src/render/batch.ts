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
  const span = reserve(batch.arena, id, count);
  fit(batch);

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

  // A hole in the middle is still inside the draw range, and the vertices in it are the ones this solid
  // left behind — so a deleted wall would go on being drawn until something else claimed its space.
  // Collapsing every vertex to the origin makes each triangle zero-area, which rasterises nothing.
  // A span at the tail needs none of this: the draw range simply stops short of it.
  const { start, count } = entry.span;
  if (start + count !== batch.arena.used) {
    batch.position.fill(0, start * 3, (start + count) * 3);
    markDirty(batch.arena, entry.span);
  }
  release(batch.arena, id);
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
