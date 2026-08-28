/**
 * The extrude tool: a face pulled along its own normal.
 *
 * This is how a level is actually shaped once it exists. A box is drawn once and then pulled — a wall
 * thickened, a floor dropped, a doorway deepened — so the gesture has to be exactly as cheap as it sounds:
 * put the pointer on a face, drag, and only that face moves.
 *
 * A face has one degree of freedom and a pointer has two, so the drag is the closest-approach solve in
 * `drag.ts` rather than a plane meet. That is what makes the face follow the pointer from a shallow angle
 * instead of shooting off to the horizon.
 *
 * The snap is outwards rather than to nearest, and the reason is worth stating because getting it wrong
 * feels like a broken tool rather than a wrong number: rounding to nearest means the first half-cell of a
 * pull rounds back to zero, so the face sits still and then jumps. `snapExtrude` rounds in the direction
 * of travel, so the face leaves on the first pixel and still lands on a grid line.
 *
 * There is no separate "move face" mode. On a convex solid, pulling a face out grows it and pushing it in
 * shrinks it, and both are the same operation with the same sign — which is why every brush editor's
 * extrude and face-move turn out to be the same tool once written.
 */
import type { Vec3 } from "tscene";
import { faceCentre, faceNormal, moveFaces, type Brush } from "../brush/brush.ts";
import { lockUvToPlanes } from "../brush/uv.ts";
import { nodeById, replaceNode, type BrushNode, type NodeId, type World } from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { selectFaces, type FaceRef } from "../doc/selection.ts";
import { snapTowards } from "../grid/snap.ts";
import { axisDelta, type DragPlane } from "./drag.ts";
import type { InputState } from "./input.ts";
import type { DragTracker, Outcome, Tool } from "./tool.ts";

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const brushAt = (world: World, id: NodeId): BrushNode | undefined => {
  const node = nodeById(world, id);
  return node?.kind === "brush" ? node : undefined;
};

/**
 * Which faces a drag on this one moves.
 *
 * The face under the pointer, unless it is part of a face selection — in which case the whole selection
 * goes, which is how a designer raises four walls of a room at once. Pressing on a face outside the
 * selection means they have changed their mind about which face they meant, so it takes over.
 */
export function facesToPull(editor: Editor, hit: FaceRef): FaceRef[] {
  const chosen = editor.selection.faces;
  const inside = chosen.some((f) => f.node === hit.node && f.face === hit.face);
  return inside ? chosen : [hit];
}

/** every face of one solid that is being pulled, grouped so the kernel rebuilds the solid once */
const byNode = (faces: FaceRef[]): Map<NodeId, number[]> => {
  const out = new Map<NodeId, number[]>();
  for (const f of faces) out.set(f.node, [...(out.get(f.node) ?? []), f.face]);
  return out;
};

/** one solid with some of its faces pushed `distance` along their normals, materials staying on the wall */
export function pullFaces(brush: Brush, faces: number[], distance: number): Brush | undefined {
  const edit = lockUvToPlanes(brush, moveFaces(brush, faces, distance));
  return edit.brush;
}

/**
 * The whole world with a pull applied, or nothing when any solid in it would be destroyed.
 *
 * All-or-nothing for the same reason a transform is: half a room raised is a state the designer cannot
 * undo their way out of in one step.
 */
export function pullWorld(world: World, faces: FaceRef[], distance: number): World | undefined {
  let out = world;
  for (const [id, indices] of byNode(faces)) {
    const node = brushAt(world, id);
    if (!node) continue;
    const brush = pullFaces(node.brush, indices, distance);
    if (!brush) return undefined;
    out = replaceNode(out, id, { ...node, brush });
  }
  return out;
};

/** the axis a pull runs along: the face's own normal, through its centre */
export function pullAxis(world: World, hit: FaceRef): DragPlane | undefined {
  const node = brushAt(world, hit.node);
  if (!node || !node.brush.poly.faces[hit.face]) return undefined;
  return { origin: faceCentre(node.brush, hit.face), normal: faceNormal(node.brush, hit.face) };
}

// ---------------------------------------------------------------- the drag

function extrudeDrag(start: InputState, editor: Editor): DragTracker | undefined {
  const node = start.hit?.node;
  const face = start.hit?.face;
  if (!node || face === undefined) return undefined;
  const hit: FaceRef = { node, face };
  const axis = pullAxis(editor.world, hit);
  if (!axis) return undefined;

  const faces = facesToPull(editor, hit);
  const from = editor.world;
  const grid = gridSize(editor);
  // where the face's plane sits along its own normal, so the snap puts the *face* on a grid line rather
  // than making the distance a whole number of cells
  const at = dot(axis.origin, axis.normal);
  let last = 0;

  const step = (input: InputState): Outcome => {
    const raw = axisDelta(input.camera, input.size, start.at, input.at, axis.origin, axis.normal);
    if (raw === undefined) return { note: `pulled ${last} m` };
    const by = snapTowards(at + raw, grid, raw) - at;
    last = by;
    if (!by) return { note: "pulled 0 m" };
    return {
      edit: {
        name: faces.length > 1 ? `pull ${faces.length} faces` : "pull face",
        collate: "drag:extrude",
        repeatable: true,
        apply: (e) => {
          const world = pullWorld(from, faces, by);
          return world ? { ...e, world } : e;
        },
        // repeated, it pulls whatever faces are selected now — the same distance, on the next wall
        again: (e) => {
          const world = e.selection.faces.length ? pullWorld(e.world, e.selection.faces, by) : undefined;
          return world ? { ...e, world } : e;
        },
      },
      note: `pulled ${Math.round(by * 1000) / 1000} m`,
    };
  };

  return {
    move: step,
    end: (input) => ({ ...step(input), note: null }),
    cancel: () => ({
      edit: { name: "pull face", collate: "drag:extrude", apply: (e) => ({ ...e, world: from }) },
      note: null,
    }),
  };
}

export const extrudeTool: Tool = {
  id: "extrude",
  title: "extrude",
  key: "x",
  hint: "drag a face along its normal · click picks a face · shift adds one",
  handles: { faces: true },

  click(input) {
    const node = input.hit?.node;
    const face = input.hit?.face;
    if (!node || face === undefined) return undefined;
    return {
      set: (e) => ({
        ...e,
        selection: selectFaces(e.world, e.selection, [{ node, face }], input.mods.shift ? "toggle" : "replace"),
      }),
      note: `face ${face} of ${node}`,
    };
  },

  drag: (input, editor) => extrudeDrag(input, editor),
};
