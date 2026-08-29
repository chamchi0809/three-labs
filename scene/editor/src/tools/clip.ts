/**
 * The clip tool: a plane placed by hand, and every selected solid cut along it.
 *
 * Clipping is how a brush editor makes anything that is not a box. A ramp is a box clipped once, a corner
 * is a box clipped twice, and a whole cathedral is a handful of boxes clipped a dozen times between them —
 * which is why this tool, and not the vertex tool, is the one that gets used every day.
 *
 * **Two points in an orthographic pane, three anywhere.** Two points and a pane give a plane, because the
 * pane supplies the third direction: a line drawn in the top view means a wall standing straight up. That
 * is the gesture designers actually make, and requiring three points for it would mean placing one that
 * only ever goes in the same place. In the 3D pane there is no such direction — the camera's forward is
 * different at every pixel — so three points it is.
 *
 * **The points are placed by clicking, not by dragging.** A clip is aimed, often across two panes and often
 * after a look around, and a gesture that ends when the button comes up cannot survive that.
 *
 * **The cut is previewed as the cross-section it will actually leave.** Splitting every selected solid each
 * time a point moves costs a handful of half-space intersections, which is nothing, and it answers the only
 * question the designer has: is this the shape I meant? A plane drawn as an infinite grey square does not.
 */
import type { Plane, Vec3 } from "tscene";
import { settle } from "../brush/brush.ts";
import { split } from "../brush/csg.ts";
import {
  brushNode, insertNodes, nodeById, parents, replaceNode, type NodeId, type World,
} from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { prune, selectNodes } from "../doc/selection.ts";
import { basisOf, type View } from "../viewport/view.ts";
import { snapPoint } from "./drag.ts";
import { planePointOf, type InputState } from "./input.ts";
import type { Outcome, Tool } from "./tool.ts";

/** which half of the cut survives; "both" keeps them as two separate solids */
export type Keep = "front" | "back" | "both";

export const KEEPS: Keep[] = ["front", "back", "both"];

/**
 * The clip being aimed.
 *
 * Module state for the same reason the shape settings are: it is the gesture in the designer's hand, not
 * anything about the level, and an undo entry per placed point would bury the entry that matters.
 *
 * The camera is kept alongside the points because a two-point plane is only a plane *with* the pane it was
 * drawn in — and by the time enter is pressed the pointer may be somewhere else entirely.
 */
export type ClipState = { points: Vec3[]; camera?: View; keep: Keep };

export const clipState: ClipState = { points: [], keep: "front" };

export function resetClip(): void {
  clipState.points = [];
  clipState.camera = undefined;
}

// ---------------------------------------------------------------- the plane

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];

function planeThrough(a: Vec3, b: Vec3, c: Vec3): Plane | undefined {
  const n = cross(sub(b, a), sub(c, a));
  const length = Math.hypot(n[0], n[1], n[2]);
  // three points on a line describe every plane through that line, which is no plane at all
  if (length < 1e-9) return undefined;
  const unit: Vec3 = [n[0] / length, n[1] / length, n[2] / length];
  return { n: unit, d: dot(unit, a) };
}

/**
 * The plane the placed points describe, or nothing while they do not describe one yet.
 *
 * With two points the third comes from the pane: the plane contains the direction the pane is looking, so
 * a line drawn across the top view is a wall seen from above.
 */
export function clipPlane(points: Vec3[], camera?: View): Plane | undefined {
  const [a, b, c] = points;
  if (a && b && c) return planeThrough(a, b, c);
  if (!a || !b || !camera || camera.kind === "3d") return undefined;
  const { forward } = basisOf(camera);
  return planeThrough(a, b, [a[0] + forward[0], a[1] + forward[1], a[2] + forward[2]]);
}

// ---------------------------------------------------------------- the cut

/** the face the cut invents, marked so the preview can find it and `settle` can give it a material */
const CUT = -1;

export type Clipped = { world: World; made: NodeId[] };

/**
 * Every solid in `ids` cut, or nothing when the plane misses all of them.
 *
 * A solid entirely on the discarded side goes away — that is not a failure, it is what "keep the front"
 * means when a solid is wholly behind. Nothing at all being touched *is* worth refusing, because it would
 * put an undo entry on the stack that changed nothing.
 */
export function clipWorld(world: World, ids: NodeId[], plane: Plane, keep: Keep): Clipped | undefined {
  const owners = parents(world);
  const made: NodeId[] = [];
  let out = world;
  let touched = 0;

  for (const id of ids) {
    const node = nodeById(world, id);
    if (node?.kind !== "brush") continue;
    const { front, back } = split(node.brush.poly, plane, CUT);
    const kept = keep === "back" ? back : front;
    if (!kept) {
      out = replaceNode(out, id, undefined);
      touched++;
      continue;
    }
    if (!front || !back) continue; // wholly on the kept side: left exactly as it was
    touched++;
    out = replaceNode(out, id, { ...node, brush: settle(node.brush, kept) });
    if (keep === "both") {
      const other = brushNode(settle(node.brush, back), { props: node.props });
      out = insertNodes(out, owners.get(id) ?? out.layers[0]!.id, [other]);
      made.push(other.id);
    }
  }

  return touched ? { world: out, made } : undefined;
}

function applyClip(e: Editor, plane: Plane, keep: Keep): Editor {
  const result = clipWorld(e.world, e.selection.nodes, plane, keep);
  if (!result) return e;
  const grown = result.made.length
    ? selectNodes(result.world, e.selection, result.made, "add", e.open)
    : e.selection;
  return { ...e, world: result.world, selection: prune(result.world, grown) };
}

// ---------------------------------------------------------------- what it looks like

const CROSS = 0.5; // in grid cells, so a placed point is legible at every zoom

/** the placed points as small crosses, joined up, plus the cross-section the cut would leave */
export function clipDecor(editor: Editor): Record<string, Float32Array | undefined> {
  const points = clipState.points;
  const reach = gridSize(editor) * CROSS;
  const marks: number[] = [];

  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      const a = [...p];
      const b = [...p];
      a[k]! -= reach;
      b[k]! += reach;
      marks.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
    }
  }
  // the loop closes only once there are three, because two points joined twice is one line drawn twice
  for (let i = 0; i + 1 < points.length; i++) push(marks, points[i]!, points[i + 1]!);
  if (points.length === 3) push(marks, points[2]!, points[0]!);

  return { "clip:points": new Float32Array(marks), "clip:cut": cutOutline(editor) };
}

function cutOutline(editor: Editor): Float32Array {
  const plane = clipPlane(clipState.points, clipState.camera);
  const out: number[] = [];
  if (!plane) return new Float32Array(out);

  for (const id of editor.selection.nodes) {
    const node = nodeById(editor.world, id);
    if (node?.kind !== "brush") continue;
    const { front, back } = split(node.brush.poly, plane, CUT);
    // only a solid the plane actually passes through has a cross-section to draw
    if (!front || !back) continue;
    const face = front.faces.find((f) => f.source === CUT);
    if (!face) continue;
    for (let i = 0; i < face.loop.length; i++) {
      const a = front.vertices[face.loop[i]!]!;
      const b = front.vertices[face.loop[(i + 1) % face.loop.length]!]!;
      push(out, a, b);
    }
  }
  return new Float32Array(out);
}

const push = (out: number[], a: Vec3, b: Vec3): void => {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
};

const GONE = { "clip:points": undefined, "clip:cut": undefined };

const say = (): string => {
  const n = clipState.points.length;
  const ready = clipPlane(clipState.points, clipState.camera) !== undefined;
  const where = n === 0 ? "click to place the first point" : ready ? "enter clips" : "one more point";
  return `${n} point${n === 1 ? "" : "s"} · keep ${clipState.keep} · ${where}`;
};

// ---------------------------------------------------------------- the tool

/** where a click puts a point: on the face under it if there is one, otherwise on the pane's own plane */
const pointAt = (input: InputState, editor: Editor): Vec3 =>
  snapPoint(input.hit?.point ?? planePointOf(input), gridSize(editor));

function place(input: InputState, editor: Editor): Outcome {
  const restart = clipState.camera !== undefined && clipState.camera.kind !== input.view;
  const at = pointAt(input, editor);
  // a fourth point starts a new plane rather than being ignored, because a designer who clicks again has
  // decided the last plane was wrong, and a tool that stops responding reads as broken
  clipState.points = restart || clipState.points.length >= 3 ? [at] : [...clipState.points, at];
  clipState.camera = input.camera;
  return { decor: clipDecor(editor), note: say() };
}

function cut(editor: Editor): Outcome {
  const plane = clipPlane(clipState.points, clipState.camera);
  if (!plane) return { note: "a clip plane needs three points, or two in an orthographic pane" };
  if (!editor.selection.nodes.length) return { note: "nothing selected to clip" };
  if (!clipWorld(editor.world, editor.selection.nodes, plane, clipState.keep)) {
    return { note: "the plane misses everything selected" };
  }
  const keep = clipState.keep;
  resetClip();
  return {
    edit: {
      name: "clip",
      repeatable: true,
      apply: (e) => applyClip(e, plane, keep),
      // repeated, it cuts whatever is selected now along the same plane — how a row of columns gets the
      // same chamfer without aiming the plane again
      again: (e) => applyClip(e, plane, keep),
    },
    decor: GONE,
    note: `clipped, keeping the ${keep}`,
  };
}

export const clipTool: Tool = {
  id: "clip",
  title: "clip",
  key: "c",
  hint: "click to place points · tab keeps the other half · enter clips · backspace takes one back",

  click: (input, editor) => place(input, editor),

  press(key, _input, editor) {
    if (key === "tab") {
      clipState.keep = KEEPS[(KEEPS.indexOf(clipState.keep) + 1) % KEEPS.length]!;
      return { decor: clipDecor(editor), note: say() };
    }
    if (key === "backspace") {
      if (!clipState.points.length) return { note: say() };
      clipState.points = clipState.points.slice(0, -1);
      if (!clipState.points.length) clipState.camera = undefined;
      return { decor: clipDecor(editor), note: say() };
    }
    if (key === "escape") {
      resetClip();
      return { decor: GONE, note: say() };
    }
    if (key === "enter") return cut(editor);
    return undefined;
  },

  leave() {
    resetClip();
    return { decor: GONE };
  },
};
