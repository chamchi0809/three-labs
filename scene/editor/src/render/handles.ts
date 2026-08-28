/**
 * The little squares a designer drags: brush vertices, edge midpoints, face centres, the rotation pivot.
 *
 * Handles are not arena-backed, and that is deliberate. The arena earns its keep when a buffer holds
 * thousands of things that change one at a time — that is the map. Handles are the opposite: there are a
 * few hundred at most, they all appear and all vanish the moment the selection changes, and nothing ever
 * edits one in place. Rebuilding the list wholesale is both simpler and faster than tracking spans for it.
 *
 * They are drawn as instanced points expanded in the vertex shader, so a handle stays the same size in
 * pixels however far away it is. A handle that shrinks with distance is a handle that cannot be grabbed,
 * and the whole point of them is being grabbable.
 */
import type { NodeId } from "../doc/document.ts";
import type { Flags } from "./batch.ts";

/** what a handle is for, which is also what it is drawn as */
export type HandleKind = "vertex" | "edge" | "face" | "pivot";

export type Handle = {
  kind: HandleKind;
  at: [number, number, number];
  /** the solid it belongs to, so dragging it knows what to rebuild */
  of: NodeId;
  /**
   * which vertex, edge or face of that solid — the index the tool uses to find it again. A pivot has no
   * part of anything, so it carries -1.
   */
  part: number;
  flags: Flags;
};

export type HandleSet = {
  handles: Handle[];
  /** vec3, one per handle */
  position: Float32Array;
  /** float: 0 vertex, 1 edge, 2 face, 3 pivot — the material picks the shape and the size from it */
  kind: Float32Array;
  /** float, the same bit field the faces and lines use */
  flag: Float32Array;
  /** vec2: the handle's own index plus one, and its kind — a pick reads a handle by index, not by solid */
  pick: Float32Array;
  /** how many of the arrays are real; they are grown but never shrunk */
  count: number;
};

const KINDS: Record<HandleKind, number> = { vertex: 0, edge: 1, face: 2, pivot: 3 };

export const newHandles = (): HandleSet => ({
  handles: [],
  position: new Float32Array(0),
  kind: new Float32Array(0),
  flag: new Float32Array(0),
  pick: new Float32Array(0),
  count: 0,
});

/**
 * The whole set replaced. Handles come and go with the selection, so there is no incremental path here on
 * purpose — one call, one truth, nothing left over from the last selection to go stale.
 */
export function setHandles(set: HandleSet, handles: Handle[]): void {
  set.handles = handles;
  set.count = handles.length;
  if (set.kind.length < handles.length) {
    const size = Math.max(64, 1 << Math.ceil(Math.log2(Math.max(1, handles.length))));
    set.position = new Float32Array(size * 3);
    set.kind = new Float32Array(size);
    set.flag = new Float32Array(size);
    set.pick = new Float32Array(size * 2);
  }

  for (const [i, handle] of handles.entries()) {
    set.position[i * 3] = handle.at[0];
    set.position[i * 3 + 1] = handle.at[1];
    set.position[i * 3 + 2] = handle.at[2];
    set.kind[i] = KINDS[handle.kind];
    set.flag[i] = handle.flags;
    set.pick[i * 2] = i + 1; // one-based, so an empty pick buffer does not read as the first handle
    set.pick[i * 2 + 1] = KINDS[handle.kind];
  }
}

/** the handle a pick buffer's first channel names, or nothing if it named nothing */
export const handleAt = (set: HandleSet, pick: number): Handle | undefined =>
  pick >= 1 && pick <= set.count ? set.handles[pick - 1] : undefined;

/** one handle's flags changed — hovering one of a hundred must not rebuild the other ninety-nine */
export function setHandleFlags(set: HandleSet, index: number, flags: Flags): boolean {
  const handle = set.handles[index];
  if (!handle || handle.flags === flags) return false;
  handle.flags = flags;
  set.flag[index] = flags;
  return true;
}

export const clearHandles = (set: HandleSet): void => setHandles(set, []);

// ---------------------------------------------------------------- where they go

/**
 * The handles for one solid, given its polygons.
 *
 * Vertices are deduplicated across faces the same way edges are: a corner of a cuboid belongs to three
 * faces, and three handles stacked at one point is three chances to grab the wrong one.
 *
 * Edge midpoints and face centres are what TrenchBroom calls the same tool's other two modes — dragging a
 * midpoint splits the edge, dragging a face centre moves the whole face along its normal.
 */
export function brushHandles(
  of: NodeId,
  polygons: (readonly (readonly number[])[] | undefined)[],
  kinds: { vertices?: boolean; edges?: boolean; faces?: boolean } = { vertices: true },
): Handle[] {
  const out: Handle[] = [];
  const seenVertex = new Map<string, number>();
  const seenEdge = new Set<string>();

  for (const [face, poly] of polygons.entries()) {
    if (!poly) continue;

    if (kinds.faces) {
      const centre = [0, 0, 0];
      for (const p of poly) for (let k = 0; k < 3; k++) centre[k]! += p[k]!;
      out.push({ kind: "face", at: centre.map((v) => v / poly.length) as [number, number, number], of, part: face, flags: 0 });
    }

    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;

      if (kinds.vertices) {
        const key = `${a[0]},${a[1]},${a[2]}`;
        if (!seenVertex.has(key)) {
          seenVertex.set(key, seenVertex.size);
          out.push({ kind: "vertex", at: [a[0]!, a[1]!, a[2]!], of, part: seenVertex.get(key)!, flags: 0 });
        }
      }

      if (kinds.edges) {
        const key = edgeKey(a, b);
        if (!seenEdge.has(key)) {
          seenEdge.add(key);
          out.push({
            kind: "edge",
            at: [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, (a[2]! + b[2]!) / 2],
            of,
            part: seenEdge.size - 1,
            flags: 0,
          });
        }
      }
    }
  }
  return out;
}

/** the same ordering trick the edge buffer uses, so an edge met from either face hashes the same */
function edgeKey(a: readonly number[], b: readonly number[]): string {
  const first = a[0]! < b[0]! || (a[0] === b[0] && (a[1]! < b[1]! || (a[1] === b[1] && a[2]! <= b[2]!)));
  const [p, q] = first ? [a, b] : [b, a];
  return `${p[0]},${p[1]},${p[2]}|${q[0]},${q[1]},${q[2]}`;
}
