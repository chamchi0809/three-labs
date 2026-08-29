/**
 * What the vertex, edge and face tools all are underneath: a handle grabbed, and some of a solid's corners
 * carried along with it.
 *
 * The three tools differ in one thing only — which corners a handle stands for. A vertex handle is one
 * corner, an edge handle is two, a face handle is the whole loop. Everything after that is the same drag
 * and the same kernel call, so it is written once here and the tools are three short files that say what
 * they show and what they are called.
 *
 * **A handle is found by where it is, not by its index.** `brushHandles` deduplicates corners across the
 * faces that share them, so a handle's `part` counts positions in that deduplicated order and has nothing
 * to do with `brush.poly.vertices`. Looking the corner back up by position is exact — the handle was placed
 * at a vertex, so it is *at* a vertex — and it survives the renumbering every kernel edit does.
 *
 * **The whole selection moves if the grabbed handle is in it.** Same rule as extrude's, and for the same
 * reason: a designer who has picked four corners and then grabs one of them meant all four. Grabbing one
 * that is not in the selection means they have changed their mind.
 */
import type { Vec3 } from "tscene";
import { moveVertices, type Brush } from "../brush/brush.ts";
import { lockUvToPlanes } from "../brush/uv.ts";
import { nodeById, replaceNode, type BrushNode, type NodeId, type World } from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import type { Handle, HandleKind } from "../render/handles.ts";
import { majorAxis, movePlane, onlyAxis, planeDelta, snapMove } from "./drag.ts";
import type { InputState } from "./input.ts";
import type { DragTracker, Outcome } from "./tool.ts";

const ZERO: Vec3 = [0, 0, 0];
const isZero = (v: Vec3): boolean => !v[0] && !v[1] && !v[2];

/** the grid is never finer than a micrometre, so anything closer than this is the same corner */
const NEAR = 1e-6;

const same = (a: readonly number[], b: readonly number[]): boolean =>
  Math.abs(a[0]! - b[0]!) < NEAR && Math.abs(a[1]! - b[1]!) < NEAR && Math.abs(a[2]! - b[2]!) < NEAR;

export const brushAt = (world: World, id: NodeId): BrushNode | undefined => {
  const node = nodeById(world, id);
  return node?.kind === "brush" ? node : undefined;
};

// ---------------------------------------------------------------- handles back to corners

/** which corner of the solid a point is, or nothing if it is not one of them */
export function vertexAt(brush: Brush, at: Vec3): number | undefined {
  const found = brush.poly.vertices.findIndex((v) => same(v, at));
  return found < 0 ? undefined : found;
}

/** the two corners whose midpoint is `at` — how an edge handle names its edge */
export function edgeAt(brush: Brush, at: Vec3): [number, number] | undefined {
  for (const face of brush.poly.faces) {
    for (let i = 0; i < face.loop.length; i++) {
      const a = face.loop[i]!;
      const b = face.loop[(i + 1) % face.loop.length]!;
      const p = brush.poly.vertices[a]!;
      const q = brush.poly.vertices[b]!;
      if (same([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2], at)) return [a, b];
    }
  }
  return undefined;
}

/** the corners a handle stands for */
export function cornersOf(brush: Brush, handle: Handle): number[] | undefined {
  if (handle.kind === "vertex") {
    const found = vertexAt(brush, handle.at);
    return found === undefined ? undefined : [found];
  }
  if (handle.kind === "edge") return edgeAt(brush, handle.at);
  if (handle.kind === "face") return brush.poly.faces[handle.part]?.loop;
  return undefined;
}

/** every corner the current selection of this kind names, by solid */
export function selectedCorners(editor: Editor, kind: HandleKind): Map<NodeId, number[]> {
  const out = new Map<NodeId, number[]>();
  const add = (node: NodeId, indices: readonly number[]): void => {
    const was = out.get(node) ?? [];
    out.set(node, [...was, ...indices.filter((i) => !was.includes(i))]);
  };

  if (kind === "vertex") for (const r of editor.selection.vertices) add(r.node, [r.vertex]);
  if (kind === "edge") for (const r of editor.selection.edges) add(r.node, [r.a, r.b]);
  if (kind === "face") {
    for (const r of editor.selection.faces) {
      const loop = brushAt(editor.world, r.node)?.brush.poly.faces[r.face]?.loop;
      if (loop) add(r.node, loop);
    }
  }
  return out;
}

/** the corners a drag on this handle moves: the selection if the handle is in it, otherwise just it */
export function cornersToDrag(editor: Editor, handle: Handle, own: number[]): Map<NodeId, number[]> {
  const chosen = selectedCorners(editor, handle.kind);
  const mine = chosen.get(handle.of) ?? [];
  const inside = own.length > 0 && own.every((i) => mine.includes(i));
  return inside ? chosen : new Map([[handle.of, own]]);
}

// ---------------------------------------------------------------- the drag

/**
 * The world with some corners moved, or nothing when any solid would be destroyed.
 *
 * All-or-nothing across the solids, because a vertex drag that took one wall with it and left the other
 * behind is a hole in a room that the designer then has to find.
 */
export function dragCorners(world: World, corners: Map<NodeId, number[]>, by: Vec3): World | undefined {
  let out = world;
  for (const [id, indices] of corners) {
    const node = brushAt(world, id);
    if (!node) continue;
    const edit = lockUvToPlanes(node.brush, moveVertices(node.brush, indices, by));
    if (!edit.brush) return undefined;
    out = replaceNode(out, id, { ...node, brush: edit.brush });
  }
  return out;
}

/**
 * How far a handle has been dragged, snapped so the handle itself lands on the grid.
 *
 * Anchoring on the handle rather than on the selection's box is the difference between a corner that can be
 * put exactly on a grid line and one that keeps whatever fraction of a cell it started with.
 */
export function handleDelta(start: InputState, now: InputState, at: Vec3, grid: number): Vec3 | undefined {
  const plane = movePlane(start.camera, at, now.mods.alt);
  const raw = planeDelta(start.camera, start.size, start.at, now.at, plane);
  if (!raw) return undefined;
  const held = now.mods.shift ? onlyAxis(raw, majorAxis(raw)) : raw;
  return snapMove(at, held, grid);
}

const say = (by: Vec3): string => by.map((v) => (Math.round(v * 1000) / 1000).toString()).join(", ");

/** the whole gesture the three handle tools share; `name` is what the undo entry is called */
export function handleDrag(
  start: InputState,
  editor: Editor,
  kind: HandleKind,
  name: string,
): DragTracker | undefined {
  const handle = start.hit?.handle;
  if (!handle || handle.kind !== kind) return undefined;
  const node = brushAt(editor.world, handle.of);
  const own = node && cornersOf(node.brush, handle);
  if (!own?.length) return undefined;

  const corners = cornersToDrag(editor, handle, own);
  const at: Vec3 = [handle.at[0], handle.at[1], handle.at[2]];
  const from = editor.world;
  const grid = gridSize(editor);
  const collate = `drag:${kind}`;
  let last: Vec3 = ZERO;

  const step = (input: InputState): Outcome => {
    const by = handleDelta(start, input, at, grid) ?? last;
    last = by;
    if (isZero(by)) return { note: `${name} 0 m` };
    return {
      edit: {
        name,
        collate,
        repeatable: true,
        apply: (e) => {
          const world = dragCorners(from, corners, by);
          return world ? { ...e, world } : e;
        },
        // repeated it moves the same corners of the same solids again, which is how a ramp gets a second
        // step of exactly the height of the first
        again: (e) => {
          const world = dragCorners(e.world, corners, by);
          return world ? { ...e, world } : e;
        },
      },
      note: `${name} ${say(by)} m`,
    };
  };

  return {
    move: step,
    end: (input) => ({ ...step(input), note: null }),
    cancel: () => ({
      edit: { name, collate, apply: (e) => ({ ...e, world: from }) },
      note: null,
    }),
  };
}
