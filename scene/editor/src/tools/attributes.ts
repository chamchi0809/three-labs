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
 *
 * **A patch is a face here too.** It has one surface, numbered 0, carrying the same material and the same
 * three uv numbers in the same units — so it goes in the same selection, takes the same keys and the same
 * alt-click, and a wall and the curve that meets it can be lined up in one gesture. Three of the operations
 * are brush-only, and each of them for the same reason: sliding, `fit` and the choice of axes all need a
 * face's plane, and a patch's surface has none. Those say so rather than doing nothing quietly.
 */
import type { Vec2, Vec3 } from "tscene";
import { faceAttributes, faceNormal, type Brush, type FaceAttributes } from "../brush/brush.ts";
import {
  fitUv, flipUv, nudgeUv, resetUv, rotateUv, scaleUv, setUvAt, uvOf, withFace,
} from "../brush/uv.ts";
import {
  nodeById, replaceNode, type BrushNode, type NodeId, type PatchNode, type World,
} from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { selectFaces, type FaceRef } from "../doc/selection.ts";
import { snap } from "../grid/snap.ts";
import type { Patch } from "../patch/patch.ts";
import {
  flipPatchUv, nudgePatchUv, resetPatchUv, rotatePatchUv, scalePatchUv, withPatchMaterial,
} from "../patch/uv.ts";
import { pointOnDragPlane } from "./drag.ts";
import type { InputState } from "./input.ts";
import type { DragTracker, Outcome, Tool } from "./tool.ts";

const brushAt = (world: World, id: NodeId): BrushNode | undefined => {
  const node = nodeById(world, id);
  return node?.kind === "brush" ? node : undefined;
};

const patchAt = (world: World, id: NodeId): PatchNode | undefined => {
  const node = nodeById(world, id);
  return node?.kind === "patch" ? node : undefined;
};

const attributesOf = (brush: Brush, face: number): FaceAttributes => brush.faces[face] ?? faceAttributes();

// ---------------------------------------------------------------- applying a change to a set of faces

/** what any of the keys below does to one face of one solid */
export type Change = (brush: Brush, face: number) => Brush;

/**
 * The same change as it applies to a patch, which has one surface and no face number.
 *
 * Passed alongside the face version rather than derived from it, because most of these operations are
 * genuinely two implementations of one idea: a brush face has no origin of its own and has to pin a world
 * point to turn about, while a patch's uv starts at its own corner and simply adds. See `patch/uv.ts`.
 *
 * Left off for the operations that a patch has no answer to — the choice of axes, `fit` and `justify`, all
 * of which need a face's outline in tile coordinates. Those pass nothing and patches keep what they had.
 */
export type PatchChange = (patch: Patch) => Patch;

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
 * The world with `change` applied to every named face, and `onPatch` to every named patch.
 *
 * Unlike the geometric edits this never fails: an attribute change cannot destroy a solid, so there is
 * nothing to be all-or-nothing about. A patch named by a face number it has not got — anything but 0 — is
 * left alone for the same reason a brush's missing face is.
 */
export function changeFaces(world: World, faces: FaceRef[], change: Change, onPatch?: PatchChange): World {
  let out = world;
  for (const [id, indices] of byNode(faces)) {
    const patch = patchAt(world, id);
    if (patch) {
      if (onPatch && indices.includes(0)) out = replaceNode(out, id, { ...patch, patch: onPatch(patch.patch) });
      continue;
    }
    const node = brushAt(world, id);
    if (!node) continue;
    let brush = node.brush;
    for (const face of indices) if (brush.poly.faces[face]) brush = change(brush, face);
    out = replaceNode(out, id, { ...node, brush });
  }
  return out;
}

/** a key's answer: the change as an undo entry, or a refusal when nothing is picked */
function edited(name: string, editor: Editor, change: Change, note: string, onPatch?: PatchChange): Outcome {
  const faces = editor.selection.faces;
  if (!faces.length) return { note: "no faces picked" };
  return {
    edit: {
      name,
      repeatable: true,
      apply: (e) => ({ ...e, world: changeFaces(e.world, faces, change, onPatch) }),
      // repeated it runs on whatever is picked then, which is how one adjustment gets carried to the next wall
      again: (e) => ({ ...e, world: changeFaces(e.world, e.selection.faces, change, onPatch) }),
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

/**
 * Sliding, on a brush face only.
 *
 * The gesture is "the point of the wall under the cursor stays under the cursor", and answering it needs a
 * plane to meet and a `uvOf` to invert. A patch is a curved surface with neither: the point the ray met is
 * known, but which tile coordinate is there depends on the arc-length ruler the tessellator builds, and
 * there is no inverse of it to solve. So a drag on a patch declines and the arrows do the sliding — which
 * is stated in the hint, rather than left for a designer to discover by dragging and seeing nothing move.
 */
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

/**
 * The same copy onto a patch — everything but the axes, which is everything a patch has.
 *
 * Dropping the axes is not a loss of fidelity, it is the axes not applying: a patch's material runs along
 * the surface, so `paraxial` and `parallel` name nothing about it. The three numbers are in the same units
 * on both, so copying a wall onto the curve that meets it lines the two up, which is the point of the
 * gesture.
 */
const pastePatch = (source: FaceAttributes): PatchChange => (patch) => ({
  ...withPatchMaterial(patch, source.material),
  uv: {
    offset: [source.offset[0], source.offset[1]],
    scale: [source.scale[0], source.scale[1]],
    rotation: source.rotation,
  },
});

/**
 * What was clicked, as face attributes, whichever kind of solid it was.
 *
 * A patch reads as its one surface with the default axes filled in, so everything downstream — the note,
 * the copy, the current material — has one shape to work with rather than a branch each.
 */
function attributesUnder(world: World, id: NodeId, face: number): FaceAttributes | undefined {
  const patch = patchAt(world, id);
  if (patch) {
    if (face !== 0) return undefined;
    const { material, uv } = patch.patch;
    return { ...faceAttributes(), ...(material ? { material } : {}), ...uv };
  }
  const brush = brushAt(world, id)?.brush;
  return brush?.poly.faces[face] ? attributesOf(brush, face) : undefined;
}

function pick(input: InputState, editor: Editor): Outcome | undefined {
  const node = input.hit?.node;
  const face = input.hit?.face;
  if (!node || face === undefined) return undefined;
  const a = attributesUnder(editor.world, node, face);

  if (input.mods.alt) {
    if (!a) return undefined;
    const what = patchAt(editor.world, node) ? "patch" : `face ${face} of`;
    return edited("copy material", editor, paste(a), `copied ${what} ${node}`, pastePatch(a));
  }

  return {
    set: (e) => ({
      ...e,
      selection: selectFaces(e.world, e.selection, [{ node, face }], input.mods.shift ? "toggle" : "replace"),
      // picking a face makes its material the current one, so the next solid drawn matches what was clicked
      material: a?.material ?? e.material,
    }),
    note: a ? describe(a) : `face ${face}`,
  };
}

const describe = (a: FaceAttributes): string =>
  `${a.material ?? "default"} · offset ${round(a.offset[0])}, ${round(a.offset[1])} · scale ${round(a.scale[0])}, ${round(a.scale[1])} · ${round(a.rotation / DEGREE)}°`;

export const attributesTool: Tool = {
  id: "attributes",
  title: "material",
  key: "m",
  hint:
    "drag to slide a face · click picks · alt+click copies the material · arrows move it · , . rotate · - = resize · 0 reset · 9 fit · j l flip",
  handles: { faces: true },

  click: pick,
  drag: slideDrag,

  press(key, input, editor) {
    const grid = gridSize(editor);
    const fine = input?.mods.alt ?? false;
    const turn = (fine ? 1 : 15) * DEGREE;

    const slide = (by: Vec2, say: string) =>
      edited("move material", editor, (b, i) => nudgeUv(b, i, by), say, (p) => nudgePatchUv(p, by));

    if (key === "arrowleft") return slide([-grid, 0], `moved -${grid} u`);
    if (key === "arrowright") return slide([grid, 0], `moved +${grid} u`);
    if (key === "arrowdown") return slide([0, -grid], `moved -${grid} v`);
    if (key === "arrowup") return slide([0, grid], `moved +${grid} v`);
    if (key === ",") return edited("rotate material", editor, (b, i) => rotateUv(b, i, -turn), `rotated -${round(turn / DEGREE)}°`, (p) => rotatePatchUv(p, -turn));
    if (key === ".") return edited("rotate material", editor, (b, i) => rotateUv(b, i, turn), `rotated +${round(turn / DEGREE)}°`, (p) => rotatePatchUv(p, turn));
    if (key === "-") return edited("resize material", editor, (b, i) => scaleUv(b, i, [0.5, 0.5]), "halved", (p) => scalePatchUv(p, [0.5, 0.5]));
    if (key === "=") return edited("resize material", editor, (b, i) => scaleUv(b, i, [2, 2]), "doubled", (p) => scalePatchUv(p, [2, 2]));
    if (key === "0") return edited("reset material", editor, (b, i) => resetUv(b, i), "reset", resetPatchUv);
    // fit needs the face's outline in tile coordinates and a patch has none, so it is a brush-only key
    if (key === "9") return edited("fit material", editor, (b, i) => fitUv(b, i), "fitted to the face");
    if (key === "j") return edited("flip material", editor, (b, i) => flipUv(b, i, "u"), "flipped across u", (p) => flipPatchUv(p, "u"));
    if (key === "l") return edited("flip material", editor, (b, i) => flipUv(b, i, "v"), "flipped across v", (p) => flipPatchUv(p, "v"));
    if (key === "enter") {
      const material = editor.material;
      return edited("set material", editor, (b, i) => withFace(b, i, { material }), `set to ${material ?? "default"}`,
        (p) => withPatchMaterial(p, material));
    }
    return undefined;
  },
};
