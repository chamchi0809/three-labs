/**
 * The face-attribute tool: what a wall is made of, and where the material sits on it.
 *
 * Everything here already exists in `brush/uv.ts` — sliding, turning, scaling, fitting, flipping, copying.
 * This file is the hand on it: which faces a key applies to, and what a drag means.
 *
 * **A drag slides the material under the pointer.** Not "the offset increases by the mouse delta in pixels"
 * — the point of the wall the gesture started on stays under the cursor for the whole drag, which is the
 * only version that works when the face is seen at an angle or the material is scaled or turned. It falls
 * out of `setUvAt`, and the resulting change in offset is then applied to every selected face, so a whole
 * room's worth of walls slides together and stays aligned.
 *
 * **Alt-click copies.** The face under the pointer is the source, everything selected is the destination,
 * and the whole of it goes across — material, axes, offset, scale, rotation. This is the gesture that gets
 * used more than every key below put together, because the common job is not "set a number", it is "make
 * these forty faces look like that one".
 *
 * **The keys act on the selection, not on what is hovered.** A key that acted on the pointer would mean the
 * designer has to hold the mouse still to press it, and the whole point of picking a set of faces first is
 * that they can then stop aiming.
 */
import type { Vec2, Vec3 } from "tscene";
import { faceAttributes, faceNormal, type Brush, type FaceAttributes } from "../brush/brush.ts";
import {
  fitUv, flipUv, nudgeUv, resetUv, rotateUv, scaleUv, setUvAt, uvOf, withFace,
} from "../brush/uv.ts";
import { nodeById, replaceNode, type BrushNode, type NodeId, type World } from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { selectFaces, type FaceRef } from "../doc/selection.ts";
import { snap } from "../grid/snap.ts";
import { pointOnDragPlane } from "./drag.ts";
import type { InputState } from "./input.ts";
import type { DragTracker, Outcome, Tool } from "./tool.ts";

const brushAt = (world: World, id: NodeId): BrushNode | undefined => {
  const node = nodeById(world, id);
  return node?.kind === "brush" ? node : undefined;
};

const attributesOf = (brush: Brush, face: number): FaceAttributes => brush.faces[face] ?? faceAttributes();

// ---------------------------------------------------------------- applying a change to a set of faces

/** what any of the keys below does to one face of one solid */
export type Change = (brush: Brush, face: number) => Brush;

const byNode = (faces: FaceRef[]): Map<NodeId, number[]> => {
  const out = new Map<NodeId, number[]>();
  for (const f of faces) {
    const was = out.get(f.node) ?? [];
    if (!was.includes(f.face)) out.set(f.node, [...was, f.face]);
    else out.set(f.node, was);
  }
  return out;
};

/**
 * The world with `change` applied to every named face.
 *
 * Unlike the geometric edits this never fails: an attribute change cannot destroy a solid, so there is
 * nothing to be all-or-nothing about.
 */
export function changeFaces(world: World, faces: FaceRef[], change: Change): World {
  let out = world;
  for (const [id, indices] of byNode(faces)) {
    const node = brushAt(world, id);
    if (!node) continue;
    let brush = node.brush;
    for (const face of indices) if (brush.poly.faces[face]) brush = change(brush, face);
    out = replaceNode(out, id, { ...node, brush });
  }
  return out;
}

/** a key's answer: the change as an undo entry, or a refusal when nothing is picked */
function edited(name: string, editor: Editor, change: Change, note: string): Outcome {
  const faces = editor.selection.faces;
  if (!faces.length) return { note: "no faces picked" };
  return {
    edit: {
      name,
      repeatable: true,
      apply: (e) => ({ ...e, world: changeFaces(e.world, faces, change) }),
      // repeated it runs on whatever is picked then, which is how one adjustment gets carried to the next wall
      again: (e) => ({ ...e, world: changeFaces(e.world, e.selection.faces, change) }),
    },
    note,
  };
}

// ---------------------------------------------------------------- the drag

const DEGREE = Math.PI / 180;

/** the faces a drag moves: the one under the pointer, unless it is part of a picked set */
const facesToSlide = (editor: Editor, hit: FaceRef): FaceRef[] => {
  const chosen = editor.selection.faces;
  return chosen.some((f) => f.node === hit.node && f.face === hit.face) ? chosen : [hit];
};

function slideDrag(start: InputState, editor: Editor): DragTracker | undefined {
  const id = start.hit?.node;
  const face = start.hit?.face;
  const grabbed = start.hit?.point;
  if (!id || face === undefined || !grabbed) return undefined;
  const node = brushAt(editor.world, id);
  if (!node?.brush.poly.faces[face]) return undefined;

  const hit: FaceRef = { node: id, face };
  const faces = facesToSlide(editor, hit);
  const plane = { origin: grabbed, normal: faceNormal(node.brush, face) };
  // the tile coordinate that has to stay under the cursor for the whole drag
  const pinned = uvOf(node.brush, face, grabbed);
  const was = attributesOf(node.brush, face).offset;
  const from = editor.world;
  const grid = gridSize(editor);
  let last: Vec2 = [0, 0];

  const step = (input: InputState): Outcome => {
    const now = pointOnDragPlane(input.camera, input.at, input.size, plane);
    const by = now ? offsetDelta(node.brush, face, now, pinned, was, grid, input.mods.alt) : last;
    last = by;
    if (!by[0] && !by[1]) return { note: "slid 0 m" };
    const change: Change = (brush, i) => nudgeUv(brush, i, by);
    return {
      edit: {
        name: "slide material",
        collate: "drag:attributes",
        repeatable: true,
        apply: (e) => ({ ...e, world: changeFaces(from, faces, change) }),
        again: (e) => ({ ...e, world: changeFaces(e.world, e.selection.faces, change) }),
      },
      note: `slid ${round(by[0])}, ${round(by[1])} m`,
    };
  };

  return {
    move: step,
    end: (input) => ({ ...step(input), note: null }),
    cancel: () => ({
      edit: { name: "slide material", collate: "drag:attributes", apply: (e) => ({ ...e, world: from }) },
      note: null,
    }),
  };
}

/**
 * How far the offset has to move for the pinned tile coordinate to sit under `now`.
 *
 * It is read back out of `setUvAt` rather than derived, because the offset lives along the face's own axes
 * and those depend on the rotation and scale the face already has. Asking the thing that knows is shorter
 * than re-deriving it, and cannot drift from it.
 */
function offsetDelta(
  brush: Brush,
  face: number,
  now: Vec3,
  pinned: Vec2,
  was: Vec2,
  grid: number,
  fine: boolean,
): Vec2 {
  const after = attributesOf(setUvAt(brush, face, now, pinned), face).offset;
  // the offset itself lands on the grid, so a material slid along a wall keeps its seams on grid lines
  const landed: Vec2 = fine ? [after[0], after[1]] : [snap(after[0], grid), snap(after[1], grid)];
  return [landed[0] - was[0], landed[1] - was[1]];
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- the tool

const paste = (source: FaceAttributes): Change => (brush, face) =>
  withFace(brush, face, {
    material: source.material,
    uv: source.uv,
    offset: [source.offset[0], source.offset[1]],
    scale: [source.scale[0], source.scale[1]],
    rotation: source.rotation,
  });

function pick(input: InputState, editor: Editor): Outcome | undefined {
  const node = input.hit?.node;
  const face = input.hit?.face;
  if (!node || face === undefined) return undefined;

  if (input.mods.alt) {
    const brush = brushAt(editor.world, node)?.brush;
    if (!brush?.poly.faces[face]) return undefined;
    const source = attributesOf(brush, face);
    return edited("copy material", editor, paste(source), `copied face ${face} of ${node}`);
  }

  const a = brushAt(editor.world, node)?.brush;
  const say = a ? describe(a, face) : `face ${face}`;
  return {
    set: (e) => ({
      ...e,
      selection: selectFaces(e.world, e.selection, [{ node, face }], input.mods.shift ? "toggle" : "replace"),
      // picking a face makes its material the current one, so the next solid drawn matches what was clicked
      material: a ? attributesOf(a, face).material ?? e.material : e.material,
    }),
    note: say,
  };
}

const describe = (brush: Brush, face: number): string => {
  const a = attributesOf(brush, face);
  return `${a.material ?? "default"} · offset ${round(a.offset[0])}, ${round(a.offset[1])} · scale ${round(a.scale[0])}, ${round(a.scale[1])} · ${round(a.rotation / DEGREE)}°`;
};

export const attributesTool: Tool = {
  id: "attributes",
  title: "material",
  key: "m",
  hint:
    "drag to slide · click picks · alt+click copies onto the picked faces · arrows nudge · , . turn · - = size · 0 reset · 9 fit · j l flip",
  handles: { faces: true },

  click: pick,
  drag: slideDrag,

  press(key, input, editor) {
    const grid = gridSize(editor);
    const fine = input?.mods.alt ?? false;
    const turn = (fine ? 1 : 15) * DEGREE;

    if (key === "arrowleft") return edited("nudge material", editor, (b, i) => nudgeUv(b, i, [-grid, 0]), `nudged -${grid} u`);
    if (key === "arrowright") return edited("nudge material", editor, (b, i) => nudgeUv(b, i, [grid, 0]), `nudged +${grid} u`);
    if (key === "arrowdown") return edited("nudge material", editor, (b, i) => nudgeUv(b, i, [0, -grid]), `nudged -${grid} v`);
    if (key === "arrowup") return edited("nudge material", editor, (b, i) => nudgeUv(b, i, [0, grid]), `nudged +${grid} v`);
    if (key === ",") return edited("turn material", editor, (b, i) => rotateUv(b, i, -turn), `turned -${round(turn / DEGREE)}°`);
    if (key === ".") return edited("turn material", editor, (b, i) => rotateUv(b, i, turn), `turned +${round(turn / DEGREE)}°`);
    if (key === "-") return edited("size material", editor, (b, i) => scaleUv(b, i, [0.5, 0.5]), "halved");
    if (key === "=") return edited("size material", editor, (b, i) => scaleUv(b, i, [2, 2]), "doubled");
    if (key === "0") return edited("reset material", editor, (b, i) => resetUv(b, i), "reset");
    if (key === "9") return edited("fit material", editor, (b, i) => fitUv(b, i), "fitted to the face");
    if (key === "j") return edited("flip material", editor, (b, i) => flipUv(b, i, "u"), "flipped across u");
    if (key === "l") return edited("flip material", editor, (b, i) => flipUv(b, i, "v"), "flipped across v");
    if (key === "enter") {
      const material = editor.material;
      return edited("set material", editor, (b, i) => withFace(b, i, { material }), `set to ${material ?? "default"}`);
    }
    return undefined;
  },
};
