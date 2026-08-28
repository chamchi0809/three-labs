/**
 * The draw-shape tool: the one that puts geometry in an empty level.
 *
 * A drag is a rectangle, and a rectangle is two of the three dimensions a solid needs. Editors answer the
 * missing third in one of two ways — drag once for the footprint and again for the height, or take the
 * height from somewhere else. This takes it from somewhere else, in **grid cells**, adjustable while the
 * drag is running. Two-stage drawing costs a gesture every single time in exchange for a number the
 * designer usually wanted to be the same as last time, and level geometry is built out of walls that are
 * all one storey and floors that are all one slab.
 *
 * The other decision is that the shape is really inserted on every frame rather than drawn as a preview.
 * It costs one hull per frame, which is nothing next to what the renderer is already doing, and it buys
 * the thing a preview can never have: what you are looking at while you drag is the actual solid, with its
 * actual materials, lit the actual way, so a cylinder that came out with eight sides looks like it has
 * eight sides before the mouse comes up rather than after.
 */
import type { Vec3 } from "tscene";
import { brushOf } from "../brush/brush.ts";
import {
  clampSides, cone, cuboid, cylinder, icoSphere, uvSphere, wedge, type Bounds,
} from "../brush/builder.ts";
import type { Polyhedron } from "../brush/polyhedron.ts";
import { brushNode, freshId, insertNodes } from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { NOTHING, selectNodes } from "../doc/selection.ts";
import { formatSize } from "../grid/snap.ts";
import { majorAxis, movePlane, planeThrough, pointOnDragPlane, snapPoint, type DragPlane } from "./drag.ts";
import { planePointOf, type InputState } from "./input.ts";
import type { DragTracker, Outcome, Tool } from "./tool.ts";

export type ShapeKind = "cuboid" | "wedge" | "cylinder" | "cone" | "sphere" | "icosphere";

export const SHAPE_KINDS: ShapeKind[] = ["cuboid", "wedge", "cylinder", "cone", "sphere", "icosphere"];

/**
 * What the tool is set to draw.
 *
 * Deliberately module state rather than part of the document: it is the shape of the designer's hand, not
 * of the level, and putting it in the editor would mean every change to it was an undo entry.
 */
export type ShapeSettings = { kind: ShapeKind; sides: number; rings: number; cells: number };

export const shapeSettings: ShapeSettings = { kind: "cuboid", sides: 8, rings: 4, cells: 4 };

export const setShape = (over: Partial<ShapeSettings>): ShapeSettings => Object.assign(shapeSettings, over);

/** the solid a set of settings makes inside a box, standing up in Y */
export function shapePolyhedron(box: Bounds, s: ShapeSettings): Polyhedron | undefined {
  switch (s.kind) {
    case "cuboid": return cuboid(box);
    case "wedge": return wedge(box, 1);
    case "cylinder": return cylinder(box, s.sides, 1);
    case "cone": return cone(box, s.sides, 1);
    case "sphere": return uvSphere(box, s.sides, s.rings, 1);
    case "icosphere": return icoSphere(box, Math.max(0, Math.min(2, Math.round(s.rings / 2))));
  }
}

// ---------------------------------------------------------------- the box a drag makes

/**
 * The plane a new solid is drawn on.
 *
 * In an orthographic pane it is the pane's own plane, so a rectangle drawn in the top view is a footprint
 * on the ground. In the 3D pane it is the ground — at the height of whatever the pointer is over, which is
 * what makes drawing a block on top of another block work without touching anything first.
 */
export function drawPlane(input: InputState): DragPlane {
  if (input.view !== "3d") return movePlane(input.camera, planePointOf(input));
  const on = input.hit?.point;
  return planeThrough([0, on ? on[1] : 0, 0], [0, 1, 0]);
}

/**
 * A box from two corners on a plane, given depth along the plane's normal.
 *
 * The depth goes towards the viewer — up, from the ground — because a solid drawn away from the designer
 * is one they immediately have to go and look for.
 */
export function boxBetween(a: Vec3, b: Vec3, normal: Vec3, depth: number): Bounds {
  const axis = majorAxis(normal);
  const away = (normal[axis] ?? 0) >= 0 ? depth : -depth;
  const min: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const max: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  const base = min[axis]!;
  min[axis] = Math.min(base, base + away);
  max[axis] = Math.max(base, base + away);
  return { min, max };
}

const flat = (box: Bounds): boolean =>
  box.max[0] - box.min[0] < 1e-6 || box.max[1] - box.min[1] < 1e-6 || box.max[2] - box.min[2] < 1e-6;

const say = (box: Bounds, s: ShapeSettings): string => {
  // the sizes come off a snapped box, so rounding here is only cleaning up the last bit of float noise
  const d = [0, 1, 2].map((k) => formatSize(Math.round((box.max[k]! - box.min[k]!) * 1e6) / 1e6));
  return `${s.kind} ${d.join(" × ")}`;
};

// ---------------------------------------------------------------- the drag

function shapeDrag(start: InputState, editor: Editor): DragTracker | undefined {
  const plane = drawPlane(start);
  const from = editor.world;
  const grid = gridSize(editor);
  // one identity for the whole gesture, so the sixty solids a drag builds are sixty versions of one node
  // rather than sixty nodes — which is what lets the selection and the renderer follow it while it grows
  const id = freshId();
  const anchor = pointOnDragPlane(start.camera, start.at, start.size, plane);
  if (!anchor) return undefined;
  const corner = snapPoint(anchor, grid);
  // what was selected before the drag, so cancelling puts back the selection and not merely the geometry
  const was = editor.selection;
  let note = "drag to draw";

  const build = (input: InputState, e: Editor): Outcome => {
    const at = pointOnDragPlane(input.camera, input.at, input.size, plane);
    if (!at) return { note };
    const box = boxBetween(corner, snapPoint(at, grid), plane.normal, shapeSettings.cells * grid);
    if (flat(box)) return { note: (note = "too small") };
    const poly = shapePolyhedron(box, shapeSettings);
    if (!poly) return { note: (note = `a ${shapeSettings.kind} that size has no inside`) };
    const brush = brushOf(poly, e.material ? { material: e.material } : {});
    note = say(box, shapeSettings);
    return {
      edit: {
        name: `draw ${shapeSettings.kind}`,
        collate: "drag:shape",
        repeatable: true,
        apply: (x) => {
          const world = insertNodes(from, x.layer, [brushNode(brush, { id })]);
          return { ...x, world, selection: selectNodes(world, NOTHING, [id], "replace", x.open) };
        },
        // repeating a draw makes another one, so it gets its own identity rather than the gesture's
        again: (x) => {
          const made = brushNode(brush);
          const world = insertNodes(x.world, x.layer, [made]);
          return { ...x, world, selection: selectNodes(world, NOTHING, [made.id], "replace", x.open) };
        },
      },
      note,
    };
  };

  return {
    move: build,
    end: (input, e) => build(input, e),
    // nothing was ever staged outside the collated entry, so the world the drag started with is the undo
    cancel: () => ({
      edit: {
        name: `draw ${shapeSettings.kind}`,
        collate: "drag:shape",
        apply: (e) => ({ ...e, world: from, selection: was }),
      },
      note: null,
    }),
  };
}

// ---------------------------------------------------------------- the tool

const cycle = (by: number): ShapeKind =>
  SHAPE_KINDS[(SHAPE_KINDS.indexOf(shapeSettings.kind) + by + SHAPE_KINDS.length) % SHAPE_KINDS.length]!;

/** every setting key changes module state and reports it, because there is nowhere else it could show */
const settingKeys: Record<string, () => string> = {
  tab: () => `${setShape({ kind: cycle(1) }).kind}`,
  // not `[` and `]`: those step the grid everywhere else in the editor, and a key that means two things
  // depending on which tool is up is a key nobody trusts
  ",": () => `${setShape({ sides: clampSides(shapeSettings.sides - 1) }).sides} sides`,
  ".": () => `${setShape({ sides: clampSides(shapeSettings.sides + 1) }).sides} sides`,
  "-": () => `${setShape({ cells: Math.max(1, shapeSettings.cells - 1) }).cells} cells deep`,
  "+": () => `${setShape({ cells: shapeSettings.cells + 1 }).cells} cells deep`,
  "=": () => `${setShape({ cells: shapeSettings.cells + 1 }).cells} cells deep`,
};

export const shapeTool: Tool = {
  id: "shape",
  title: "shape",
  key: "b",
  hint: "drag to draw a solid · tab cycles the shape · , and . set its sides · - and + its depth",

  drag: (input, editor) => shapeDrag(input, editor),

  press(key) {
    const change = settingKeys[key];
    return change ? { note: change() } : undefined;
  },
};
