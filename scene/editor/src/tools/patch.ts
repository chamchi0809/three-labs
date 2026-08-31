/**
 * The patch tool: drawing curved surfaces, and dragging the handles that bend them.
 *
 * One tool rather than two, because a patch is the one thing in the editor whose creation and whose editing
 * are the same gesture on the same little squares. Radiant splits them across a menu of primitives and a
 * separate vertex mode, and the split is why so few people ever bend a patch: the tool that made it is not
 * the tool that shapes it. Here a drag on empty space draws one and a drag on a control point bends it.
 *
 * **The handles are not on the surface, and that is not a bug.** A quadratic Bezier passes through the
 * corners of each span and is *pulled* towards the middle one, reaching half way to it at most. So a patch
 * being edited is drawn with its control net — the hull in the line batch — and the designer works on the
 * cage rather than on the cloth. Any editor that hid the cage would leave them dragging a point that is not
 * where the surface is and wondering why it lags behind.
 *
 * **A drag welds.** A cylinder's seam column is one point written twice and a cone's tip is nine copies of
 * one; {@link movePoints} carries the twins along, so a closed patch stays closed and a tip stays a point.
 * That is also why {@link patchHandles} draws one square per *position* rather than per control point: there
 * is no wrong one of a stack to grab, because they all move together anyway.
 */
import { PATCH_SHAPES, type Vec3 } from "tscene";
import type { Bounds } from "../brush/builder.ts";
import {
  freshId, insertNodes, nodeById, patchNode, replaceNode, type NodeId, type PatchNode, type World,
} from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { NOTHING, selectNodes, selectVertices, type SelectMode } from "../doc/selection.ts";
import {
  addColumn, addRow, columnsOf, dropColumn, dropRow, flip, movePoints, patchShape, rowsOf, snapPatch,
  spansOf, type Patch, type PatchPoint, type PatchShape,
} from "../patch/patch.ts";
import { majorAxis, pointOnDragPlane, snapPoint } from "./drag.ts";
import { handleDelta } from "./handleDrag.ts";
import type { InputState } from "./input.ts";
import { boxBetween, drawPlane } from "./shape.ts";
import type { DragTracker, Outcome, Tool } from "./tool.ts";

const ZERO: Vec3 = [0, 0, 0];
const isZero = (v: Vec3): boolean => !v[0] && !v[1] && !v[2];

export const patchAt = (world: World, id: NodeId): PatchNode | undefined => {
  const node = nodeById(world, id);
  return node?.kind === "patch" ? node : undefined;
};

/**
 * What the tool is set to draw, and how deep.
 *
 * Module state for the same reason the shape tool's is: it is the shape of the designer's hand rather than
 * of the level, and a document that recorded it would put an undo entry between them and every change of mind.
 */
export type PatchSettings = { shape: PatchShape; cells: number };

export const patchSettings: PatchSettings = { shape: "plane", cells: 4 };

export const setPatch = (over: Partial<PatchSettings>): PatchSettings => Object.assign(patchSettings, over);

// ---------------------------------------------------------------- control points

/** which control point a handle stands for, given the grid it came from */
export const pointOfPart = (grid: Patch["grid"], part: number): PatchPoint | undefined => {
  const columns = columnsOf(grid);
  const row = Math.floor(part / columns);
  const column = part % columns;
  return row < rowsOf(grid) && column < columns ? { row, column } : undefined;
};

/**
 * The control points a drag moves: the picked ones if the grabbed handle is among them, otherwise just it.
 *
 * The same rule the vertex tool follows, and for the same reason — a designer who has picked a whole row and
 * then takes hold of one of it meant the row. Taking hold of something outside it means they changed their mind.
 */
export function pointsToDrag(editor: Editor, node: PatchNode, part: number): PatchPoint[] {
  const picked = editor.selection.vertices.filter((v) => v.node === node.id).map((v) => v.vertex);
  const parts = picked.includes(part) ? picked : [part];
  return parts.map((p) => pointOfPart(node.patch.grid, p)).filter((p): p is PatchPoint => !!p);
}

// ---------------------------------------------------------------- bending one

function bendDrag(start: InputState, editor: Editor, handle: NonNullable<InputState["hit"]>["handle"]): DragTracker | undefined {
  if (!handle || handle.kind !== "vertex") return undefined;
  const node = patchAt(editor.world, handle.of);
  if (!node) return undefined;
  const points = pointsToDrag(editor, node, handle.part);
  if (!points.length) return undefined;

  const at: Vec3 = [handle.at[0], handle.at[1], handle.at[2]];
  const from = editor.world;
  const grid = gridSize(editor);
  const name = points.length > 1 ? `move ${points.length} control points` : "move control point";
  const collate = "drag:patch";
  let last: Vec3 = ZERO;

  const bend = (world: World, by: Vec3): World => {
    const now = patchAt(world, node.id);
    return now ? replaceNode(world, node.id, { ...now, patch: movePoints(now.patch, points, by) }) : world;
  };

  const step = (input: InputState): Outcome => {
    const by = handleDelta(start, input, at, grid) ?? last;
    last = by;
    if (isZero(by)) return { note: `${name} 0 m` };
    return {
      edit: {
        name,
        collate,
        repeatable: true,
        apply: (e) => ({ ...e, world: bend(from, by) }),
        again: (e) => ({ ...e, world: bend(e.world, by) }),
      },
      note: `${name} ${by.map((v) => (Math.round(v * 1000) / 1000).toString()).join(", ")} m`,
    };
  };

  return {
    move: step,
    end: (input) => ({ ...step(input), note: null }),
    cancel: () => ({ edit: { name, collate, apply: (e) => ({ ...e, world: from }) }, note: null }),
  };
}

// ---------------------------------------------------------------- drawing one

/**
 * A primitive built to stand up along the plane it was drawn on, rather than always along Y.
 *
 * Every builder in the runtime lays its surface out in X and Z and lifts it in Y — which is right, because
 * a cylinder is a thing that stands up, and a runtime has no pane to have drawn it in. An editor does. A
 * dome dragged out in the front view is a dome on the wall, and one that appeared lying on the floor behind
 * the designer would be the tool guessing at what they meant and guessing wrong.
 *
 * The fix is an axis permutation and nothing more: the box is handed to the builder in its own terms, and
 * the control points that come back are read out the other way round. Because the panes are axis-aligned
 * this is exact — the numbers are moved between slots, never multiplied — so a patch drawn on a grid line
 * is still on it afterwards.
 */
export function patchInBox(shape: PatchShape, box: Bounds, normal: Vec3, over: Partial<Patch> = {}): Patch {
  const up = majorAxis(normal);
  const [a, b] = [0, 1, 2].filter((k) => k !== up) as [number, number];
  const local = (v: Vec3): Vec3 => [v[a]!, v[up]!, v[b]!];
  const world = (p: Vec3): Vec3 => {
    const out: Vec3 = [0, 0, 0];
    out[a] = p[0];
    out[up] = p[1];
    out[b] = p[2];
    return out;
  };
  const built = patchShape(shape, local(box.min), local(box.max), over);
  return { ...built, grid: built.grid.map((row) => row.map(world)) };
}

const say = (patch: Patch): string => {
  const { down, across } = spansOf(patch.grid);
  return `${patchSettings.shape} ${across} × ${down} spans`;
};

const tooSmall = (a: Vec3, b: Vec3): boolean =>
  [0, 1, 2].filter((k) => Math.abs(a[k]! - b[k]!) > 1e-6).length < 2;

function drawDrag(start: InputState, editor: Editor): DragTracker | undefined {
  const plane = drawPlane(start);
  const from = editor.world;
  const grid = gridSize(editor);
  const id = freshId();
  const anchor = pointOnDragPlane(start.camera, start.at, start.size, plane);
  if (!anchor) return undefined;
  const corner = snapPoint(anchor, grid);
  const was = editor.selection;
  let note = "drag to draw a patch";

  const build = (input: InputState, e: Editor): Outcome => {
    const to = pointOnDragPlane(input.camera, input.at, input.size, plane);
    if (!to) return { note };
    // a plane is drawn flat in the pane it was dragged in; everything else is a solid of revolution and
    // needs the third dimension the drag never gave it, which is where the depth in cells comes in
    const depth = patchSettings.shape === "plane" ? 0 : patchSettings.cells * grid;
    const box = boxBetween(corner, snapPoint(to, grid), plane.normal, depth);
    if (tooSmall(box.min, box.max)) return { note: (note = "too small") };
    const patch = patchInBox(patchSettings.shape, box, plane.normal, e.material ? { material: e.material } : {});
    note = say(patch);
    return {
      edit: {
        name: `draw ${patchSettings.shape} patch`,
        collate: "drag:patch",
        repeatable: true,
        apply: (x) => {
          const world = insertNodes(from, x.layer, [patchNode(patch, { id })]);
          return { ...x, world, selection: selectNodes(world, NOTHING, [id], "replace", x.open) };
        },
        again: (x) => {
          const made = patchNode(patch);
          const world = insertNodes(x.world, x.layer, [made]);
          return { ...x, world, selection: selectNodes(world, NOTHING, [made.id], "replace", x.open) };
        },
      },
      note,
    };
  };

  return {
    move: build,
    end: build,
    cancel: () => ({
      edit: {
        name: `draw ${patchSettings.shape} patch`,
        collate: "drag:patch",
        apply: (e) => ({ ...e, world: from, selection: was }),
      },
      note: null,
    }),
  };
}

// ---------------------------------------------------------------- keys

/** every selected patch changed the same way, as one undo entry */
function onEach(editor: Editor, name: string, change: (patch: Patch) => Patch): Outcome | undefined {
  const ids = editor.selection.nodes.filter((id) => patchAt(editor.world, id));
  if (!ids.length) return undefined;
  const run = (world: World): World => {
    let out = world;
    for (const id of ids) {
      const node = patchAt(out, id);
      if (node) out = replaceNode(out, id, { ...node, patch: change(node.patch) });
    }
    return out;
  };
  return {
    edit: { name, repeatable: true, apply: (e) => ({ ...e, world: run(e.world) }) },
    // the handles are named by position in the grid, and every one of these moves them about in it
    set: (e) => ({ ...e, selection: { ...e.selection, vertices: [] } }),
    note: `${name} · ${ids.length} patch${ids.length > 1 ? "es" : ""}`,
  };
}

/** the last span of a grid, which is the end a row or column is added at or taken off */
const lastRow = (patch: Patch): number => spansOf(patch.grid).down - 1;
const lastColumn = (patch: Patch): number => spansOf(patch.grid).across - 1;

const cycle = (by: number): PatchShape =>
  PATCH_SHAPES[(PATCH_SHAPES.indexOf(patchSettings.shape) + by + PATCH_SHAPES.length) % PATCH_SHAPES.length]!;

// ---------------------------------------------------------------- the tool

export const patchTool: Tool = {
  id: "patch",
  title: "patch",
  key: "p",
  hint:
    "drag to draw · drag a control point to bend · tab cycles the shape · - and + its depth · " +
    "r and c add a span, shift+r and shift+c take one off · f flips · s snaps to the grid",
  handles: { vertices: true },

  click(input, editor) {
    const handle = input.hit?.handle;
    if (handle?.kind !== "vertex") return undefined;
    const node = patchAt(editor.world, handle.of);
    if (!node) return undefined;
    const point = pointOfPart(node.patch.grid, handle.part);
    if (!point) return undefined;
    const mode: SelectMode = input.mods.shift ? "toggle" : "replace";
    return {
      set: (e) => ({
        ...e,
        selection: selectVertices(e.selection, [{ node: handle.of, vertex: handle.part }], mode),
      }),
      note: `control point ${point.row}, ${point.column} of ${handle.of}`,
    };
  },

  drag(input, editor) {
    // a handle answers first: it is drawn over the map, and a drag on one that started a new patch instead
    // would be the tool refusing to do the thing it is for
    const handle = input.hit?.handle;
    if (handle?.kind === "vertex" && patchAt(editor.world, handle.of)) return bendDrag(input, editor, handle);
    return drawDrag(input, editor);
  },

  // keys arrive lower-cased, so shift is read off the modifiers rather than off the letter — which is also
  // the honest way round: taking a span off is the same operation as putting one on, held the other way
  press(key, input, editor) {
    const off = input?.mods.shift ?? false;
    switch (key) {
      case "tab": return { note: `${setPatch({ shape: cycle(1) }).shape}` };
      case "-": return { note: `${setPatch({ cells: Math.max(1, patchSettings.cells - 1) }).cells} cells deep` };
      case "+":
      case "=": return { note: `${setPatch({ cells: patchSettings.cells + 1 }).cells} cells deep` };
      case "r":
        return off
          ? onEach(editor, "drop a row", (p) => dropRow(p, lastRow(p)))
          : onEach(editor, "add a row", (p) => addRow(p, lastRow(p)));
      case "c":
        return off
          ? onEach(editor, "drop a column", (p) => dropColumn(p, lastColumn(p)))
          : onEach(editor, "add a column", (p) => addColumn(p, lastColumn(p)));
      case "f": return onEach(editor, "flip the patch", flip);
      case "s": return onEach(editor, "snap to the grid", (p) => snapPatch(p, gridSize(editor)));
      default: return undefined;
    }
  },
};
