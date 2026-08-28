/**
 * The move tool.
 *
 * Three decisions make the difference between a move that feels like moving something and one that feels
 * like solving for it.
 *
 * **The drag is measured against the start, never against the last frame.** Sixty incremental deltas a
 * second accumulate rounding, and worse, snapping each step means the result is the sum of snapped steps
 * rather than a snapped result — so a slow drag and a fast one over the same distance end up in different
 * places. Every frame re-applies one total translation to the world the drag began with.
 *
 * **The snap anchors on the selection's box, not on the translation.** The corner is what lands on the grid
 * line — which is what makes dragging a box up against a wall work, and what lets a designer fix a solid
 * that was placed off-grid by nudging it once. Snapping the translation instead would move everything by
 * whole cells and carry every misalignment along with it.
 *
 * **A press on something not selected selects it first.** The alternative is a tool that does nothing at
 * all until the designer switches to select, clicks, and switches back — which is how a tool gets a
 * reputation for being broken.
 */
import type { Vec3 } from "tscene";
import { boundsCentre } from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { selectNodes, selectionBounds } from "../doc/selection.ts";
import { translateSelection } from "../doc/transform.ts";
import { basisOf } from "../viewport/view.ts";
import { majorAxis, movePlane, onlyAxis, planeDelta, snapMove } from "./drag.ts";
import type { InputState } from "./input.ts";
import type { DragTracker, Outcome, Tool } from "./tool.ts";

const ZERO: Vec3 = [0, 0, 0];
const isZero = (v: Vec3) => !v[0] && !v[1] && !v[2];

/** the translation a gesture has come to, in metres, snapped and optionally held to one axis */
export function moveDelta(start: InputState, now: InputState, anchor: Vec3, centre: Vec3, grid: number): Vec3 | undefined {
  const plane = movePlane(start.camera, centre, now.mods.alt);
  const raw = planeDelta(start.camera, start.size, start.at, now.at, plane);
  if (!raw) return undefined;
  const held = now.mods.shift ? onlyAxis(raw, majorAxis(raw)) : raw;
  return snapMove(anchor, held, grid);
}

const say = (by: Vec3): string =>
  `moved ${by.map((v) => (Math.round(v * 1000) / 1000).toString()).join(", ")} m`;

/**
 * A move in progress.
 *
 * The tracker holds the world as it was when the drag started and rebuilds from it every frame. That also
 * gives cancel for free — there is nothing staged to unwind, only an edit to stop reapplying.
 */
function moveDrag(start: InputState, editor: Editor): DragTracker | undefined {
  const box = selectionBounds(editor.world, editor.selection);
  if (!box || !editor.selection.nodes.length) return undefined;
  const anchor = box.min;
  const centre = boundsCentre(box);
  const from = editor.world;
  const grid = gridSize(editor);
  let last: Vec3 = ZERO;

  const step = (input: InputState): Outcome | undefined => {
    const by = moveDelta(start, input, anchor, centre, grid) ?? last;
    last = by;
    if (isZero(by)) return { note: "moved 0 m" };
    return {
      edit: {
        name: "move",
        collate: "drag:move",
        repeatable: true,
        apply: (e) => {
          const { world, problems } = translateSelection(from, e.selection, by);
          return problems.length ? e : { ...e, world };
        },
        // repeated later it means "move whatever is selected now by that much", which is how a designer
        // spaces a row of pillars: place one, drag it, then press repeat
        again: (e) => {
          const { world, problems } = translateSelection(e.world, e.selection, by);
          return problems.length ? e : { ...e, world };
        },
      },
      note: say(by),
    };
  };

  return {
    move: step,
    end: (input) => ({ ...step(input), note: isZero(last) ? null : say(last) }),
    // the frames of a drag are one collated entry, so putting the starting world back is the whole of undo
    cancel: () => ({
      edit: { name: "move", collate: "drag:move", apply: (e) => ({ ...e, world: from }) },
      note: null,
    }),
  };
}

/** one grid step along a pane's own axes, which is what makes an arrow key mean what the designer sees */
function nudge(input: InputState, editor: Editor, right: number, up: number): Outcome | undefined {
  if (!editor.selection.nodes.length) return undefined;
  const box = selectionBounds(editor.world, editor.selection);
  if (!box) return undefined;
  const grid = gridSize(editor);
  const axes = basisOf(input.camera);
  const raw: Vec3 = [
    (axes.right[0] * right + axes.up[0] * up) * grid,
    (axes.right[1] * right + axes.up[1] * up) * grid,
    (axes.right[2] * right + axes.up[2] * up) * grid,
  ];
  // a 3D pane's axes point wherever the camera does, so the nudge is taken along the world axis it is
  // most nearly along — a nudge that moved a wall by 0.9 of a cell in x and 0.4 in z would be useless
  const by = onlyAxis(raw, majorAxis(raw));
  const on = snapMove(box.min, by, grid);
  const step: Vec3 = isZero(on) ? by : on;
  return {
    edit: {
      name: "nudge",
      collate: "nudge",
      repeatable: true,
      apply: (e) => {
        const { world, problems } = translateSelection(e.world, e.selection, step);
        return problems.length ? e : { ...e, world };
      },
    },
    note: say(step),
  };
}

const ARROWS: Record<string, [number, number]> = {
  arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, 1], arrowdown: [0, -1],
};

export const moveTool: Tool = {
  id: "move",
  title: "move",
  key: "g",
  hint: "drag to move · alt lifts · shift holds one axis · arrows nudge by a cell",

  click(input) {
    const id = input.hit?.node;
    if (!id) return undefined;
    return {
      set: (e) => ({
        ...e,
        selection: selectNodes(e.world, e.selection, [id], input.mods.shift ? "toggle" : "replace", e.open),
      }),
    };
  },

  drag(input, editor) {
    const id = input.hit?.node;
    // pressing something that is not selected selects it, and the drag then moves what was just picked
    const ready =
      id && !editor.selection.nodes.length
        ? { ...editor, selection: selectNodes(editor.world, editor.selection, [id], "replace", editor.open) }
        : editor;
    const tracker = moveDrag(input, ready);
    if (!tracker || ready === editor) return tracker;
    const selection = ready.selection;
    return {
      ...tracker,
      move: (now, e) => {
        const first = tracker.move(now, { ...e, selection });
        return first && { ...first, set: (x) => ({ ...x, selection }) };
      },
    };
  },

  press(key, input, editor) {
    const arrow = ARROWS[key];
    if (!arrow || !input) return undefined;
    return nudge(input, editor, arrow[0], arrow[1]);
  },
};
