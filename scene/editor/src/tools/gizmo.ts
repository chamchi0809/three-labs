/**
 * Rotate, scale and shear: the three tools that change a selection with a matrix.
 *
 * They are one file because they are one gesture with three answers. Each takes the box around the
 * selection, the two world axes lying in the pane, and a drag on the plane facing the camera, and turns
 * them into a {@link Mat4} that `transformSelection` applies all-or-nothing.
 *
 * **The axes are world axes, not the camera's.** A pane is looked at from somewhere, and a rotation about
 * "whatever the camera happens to be facing" produces a solid whose faces are no longer on any axis and
 * whose corners are no longer on the grid — which is the state a level designer spends their life avoiding.
 * So the pane's directions are rounded to the nearest world axis and the transform is built from those. In
 * an orthographic pane the rounding is exact; in the 3D pane it is the honest reading of what the designer
 * is looking at.
 *
 * **What snaps is where the geometry lands, not the number in the matrix.** A scale snaps the box edge that
 * is moving onto a grid line and derives the factor from it; a shear snaps the corner that is sliding. A
 * factor of exactly 1.25 is of no use to anyone if it leaves the wall a third of a cell off the floor.
 *
 * **A rotation accumulates rather than being re-derived.** The angle is summed from frame to frame, so a
 * drag that goes round twice means two turns instead of wrapping back to nothing halfway.
 */
import type { Vec3 } from "tscene";
import type { Bounds } from "../brush/builder.ts";
import { rotation, scaling, shear, type Mat4 } from "../brush/vec.ts";
import { boundsCentre, type World } from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { selectionBounds } from "../doc/selection.ts";
import { transformSelection } from "../doc/transform.ts";
import { snap, snapDelta } from "../grid/snap.ts";
import { basisOf, projectPoint, type Point, type View } from "../viewport/view.ts";
import { majorAxis, pointOnDragPlane, type DragPlane } from "./drag.ts";
import type { InputState } from "./input.ts";
import type { DragTracker, Outcome, Tool } from "./tool.ts";

type Axis = 0 | 1 | 2;
const AXES: Axis[] = [0, 1, 2];
const NAMES = ["x", "y", "z"];

/** the pane's three directions as world axes, always three different ones */
export function paneAxes(view: View): { across: Axis; up: Axis; along: Axis } {
  const basis = basisOf(view);
  const along = majorAxis(basis.forward);
  // the pane's up with the viewing axis taken out of it, so a camera looking down a diagonal cannot make
  // two of the three come out the same
  const standing: Vec3 = [basis.up[0], basis.up[1], basis.up[2]];
  standing[along] = 0;
  const chosen = majorAxis(standing);
  const up = chosen === along ? AXES.find((k) => k !== along)! : chosen;
  const across = AXES.find((k) => k !== along && k !== up)!;
  return { across, up, along };
}

export type Gizmo = {
  box: Bounds;
  centre: Vec3;
  across: Axis;
  up: Axis;
  along: Axis;
  /** the plane the drag is measured on: through the selection, square to the camera */
  plane: DragPlane;
  /** which way round a screen-counter-clockwise turn goes in the world */
  spin: 1 | -1;
};

export function gizmoOf(input: InputState, editor: Editor): Gizmo | undefined {
  if (!editor.selection.nodes.length) return undefined;
  const box = selectionBounds(editor.world, editor.selection);
  if (!box) return undefined;
  const centre = boundsCentre(box);
  const { across, up, along } = paneAxes(input.camera);
  const { forward } = basisOf(input.camera);
  return {
    box, centre, across, up, along,
    plane: { origin: centre, normal: [-forward[0], -forward[1], -forward[2]] },
    spin: forward[along] >= 0 ? -1 : 1,
  };
}

// ---------------------------------------------------------------- the shared drag

const apply = (world: World, e: Editor, m: Mat4): Editor => {
  const { world: next, problems } = transformSelection(world, e.selection, m);
  return problems.length ? e : { ...e, world: next };
};

/**
 * One frame's answer. `again` is written against whatever is selected when it is repeated, and because the
 * matrix carries its own pivot, repeating a rotation swings the next thing about the same point — which is
 * how a ring of pillars gets built out of one pillar and the repeat key.
 */
const edited = (name: string, from: World, m: Mat4, note: string): Outcome => ({
  edit: {
    name,
    collate: `drag:${name}`,
    repeatable: true,
    apply: (e) => apply(from, e, m),
    again: (e) => apply(e.world, e, m),
  },
  note,
});

function tracker(name: string, from: World, step: (input: InputState) => Outcome): DragTracker {
  return {
    move: step,
    end: (input) => ({ ...step(input), note: null }),
    cancel: () => ({
      edit: { name, collate: `drag:${name}`, apply: (e) => ({ ...e, world: from }) },
      note: null,
    }),
  };
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- rotate

const DEGREE = Math.PI / 180;

/** where the pointer stands around the pivot, as an angle that grows counter-clockwise on screen */
const screenAngle = (pivot: Point, at: Point): number => Math.atan2(pivot.y - at.y, at.x - pivot.x);

/** an angle brought into ±π, which is what makes a running total survive going past the twelve o'clock */
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

function rotateDrag(start: InputState, editor: Editor): DragTracker | undefined {
  const g = gizmoOf(start, editor);
  const pivot = g && projectPoint(start.camera, g.centre, start.size);
  if (!g || !pivot) return undefined;

  const axis: Vec3 = [0, 0, 0];
  axis[g.along] = g.spin;
  const from = editor.world;
  let previous = screenAngle(pivot, start.at);
  let total = 0;

  return tracker("rotate", from, (input) => {
    const now = screenAngle(pivot, input.at);
    total += wrap(now - previous);
    previous = now;
    // fifteen degrees is the increment every level is built on; alt is for the one wall that is not
    const step = (input.mods.alt ? 1 : 15) * DEGREE;
    const angle = Math.round(total / step) * step;
    if (!angle) return { note: "turned 0°" };
    const m = rotation(axis, angle, g.centre);
    return edited("rotate", from, m, `turned ${round(angle / DEGREE)}° about ${NAMES[g.along]}`);
  });
}

// ---------------------------------------------------------------- scale

/** the smallest factor worth applying: below it the solid is flattened onto its own plane and gone */
const MIN_FACTOR = 1e-6;

function scaleDrag(start: InputState, editor: Editor): DragTracker | undefined {
  const g = gizmoOf(start, editor);
  const at = g && pointOnDragPlane(start.camera, start.at, start.size, g.plane);
  if (!g || !at) return undefined;

  // the far side of the box stays put, so dragging a corner grows the solid away from the opposite corner
  // rather than about its middle — which is what makes a floor scaled against a wall stay against it
  const fixed: Vec3 = [...g.centre];
  const moving: Vec3 = [...g.centre];
  for (const k of [g.across, g.up]) {
    const high = at[k] >= g.centre[k];
    fixed[k] = high ? g.box.min[k]! : g.box.max[k]!;
    moving[k] = high ? g.box.max[k]! : g.box.min[k]!;
  }
  const about = start.mods.alt ? g.centre : fixed;
  const from = editor.world;
  const grid = gridSize(editor);

  return tracker("scale", from, (input) => {
    const now = pointOnDragPlane(input.camera, input.at, input.size, g.plane);
    if (!now) return { note: "scaled 1×" };
    const factors: Vec3 = [1, 1, 1];
    for (const k of [g.across, g.up]) {
      const arm = moving[k] - about[k];
      if (Math.abs(arm) < MIN_FACTOR) continue;
      const landing = snap(moving[k] + (now[k] - at[k]), grid);
      const f = (landing - about[k]) / arm;
      if (Math.abs(f) >= MIN_FACTOR) factors[k] = f;
    }
    if (input.mods.shift) {
      // uniform means the axis the designer pushed hardest, applied to all three — including the one they
      // cannot see, because a uniform scale that left the depth alone is not a uniform scale
      const chosen = Math.abs(factors[g.across] - 1) >= Math.abs(factors[g.up] - 1)
        ? factors[g.across]
        : factors[g.up];
      factors[0] = factors[1] = factors[2] = chosen;
    }
    if (factors[0] === 1 && factors[1] === 1 && factors[2] === 1) return { note: "scaled 1×" };
    return edited("scale", from, scaling(factors, about), `scaled ${factors.map(round).join(" × ")}`);
  });
}

// ---------------------------------------------------------------- shear

function shearDrag(start: InputState, editor: Editor): DragTracker | undefined {
  const g = gizmoOf(start, editor);
  const at = g && pointOnDragPlane(start.camera, start.at, start.size, g.plane);
  if (!g || !at) return undefined;

  const by = g.up;
  const slidesAlong = g.across;
  const extent = g.box.max[by]! - g.box.min[by]!;
  if (extent < MIN_FACTOR) return undefined;

  // grabbing the top of the box leans the top over and leaves the bottom where it is, and the other way
  // round — which is the only reading of a shear a designer ever wants
  const high = at[by] >= g.centre[by];
  const about: Vec3 = [...g.centre];
  about[by] = high ? g.box.min[by]! : g.box.max[by]!;
  const arm = (high ? g.box.max[by]! : g.box.min[by]!) - about[by];
  const corner = at[slidesAlong] >= g.centre[slidesAlong] ? g.box.max[slidesAlong]! : g.box.min[slidesAlong]!;
  const from = editor.world;
  const grid = gridSize(editor);

  return tracker("shear", from, (input) => {
    const now = pointOnDragPlane(input.camera, input.at, input.size, g.plane);
    if (!now) return { note: "sheared 0 m" };
    const slide = snapDelta(corner, now[slidesAlong] - at[slidesAlong], grid);
    if (!slide) return { note: "sheared 0 m" };
    const direction: Vec3 = [0, 0, 0];
    direction[slidesAlong] = slide / arm;
    const m = shear(direction, by, about);
    return edited("shear", from, m, `sheared ${round(slide)} m over ${round(extent)} m`);
  });
}

// ---------------------------------------------------------------- the tools

export const rotateTool: Tool = {
  id: "rotate",
  title: "rotate",
  key: "r",
  hint: "drag around the selection · 15° steps · alt for 1°",
  drag: rotateDrag,
};

export const scaleTool: Tool = {
  id: "scale",
  title: "scale",
  key: "t",
  hint: "drag to scale from the far corner · shift keeps it uniform · alt scales about the middle",
  drag: scaleDrag,
};

export const shearTool: Tool = {
  id: "shear",
  title: "shear",
  key: "h",
  hint: "drag the top or the bottom sideways · the far side stays put",
  drag: shearDrag,
};
