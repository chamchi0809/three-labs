/**
 * The select tool: a click, and a rubber band.
 *
 * The click half is thin, because the hard part of it already lives in `doc/selection.ts` — a click
 * selects the outermost group a solid is inside unless the designer has stepped in, and locked or hidden
 * things cannot be picked at all. What is decided here is only which *modifier* means what, and the
 * answer is the one every editor has agreed on: plain replaces, shift toggles, alt reaches past the object
 * to the face under the cursor.
 *
 * The band half is where the design decision is. A rubber band asks "is this solid inside this rectangle",
 * and a rectangle is a thing on a screen — so the test is done on the screen, by projecting each
 * candidate's box and comparing rectangles. The alternative is building a frustum from the four corners
 * and clipping boxes against six planes, which is more code, is a second implementation of what the
 * projection already knows, and gets the orthographic case wrong the first time somebody writes it. The
 * price is that "touching" is measured against a projected bounding rectangle rather than the silhouette,
 * so a band can catch a solid whose corner-to-corner diagonal crosses the rectangle while the solid does
 * not. In a level editor that error is on the generous side of the one designers actually want.
 */
import type { Bounds } from "../brush/builder.ts";
import { childrenOf, nodeBounds, nodeById, type Node, type NodeId, type World } from "../doc/document.ts";
import type { Editor } from "../doc/editor.ts";
import { NOTHING, isSelectable, selectFaces, selectNodes, type SelectMode } from "../doc/selection.ts";
import { projectPoint, type Size, type View } from "../viewport/view.ts";
import { rectBetween, type InputState, type Mods, type Rect } from "./input.ts";
import type { DragTracker, Outcome, Tool } from "./tool.ts";

/** plain replaces, shift toggles what it touches, and holding both adds without ever removing */
export function modeOf(mods: Mods): SelectMode {
  if (mods.shift && mods.ctrl) return "add";
  if (mods.shift) return "toggle";
  if (mods.ctrl) return "remove";
  return "replace";
}

// ---------------------------------------------------------------- the band

/**
 * The nodes a click could select, which is also the set a band tests.
 *
 * Not every node in the tree: the ones a click resolves to. Inside an opened group that is its children,
 * and otherwise it is every layer's children — so a band drawn over a group takes the group, and one
 * drawn inside an opened group takes the solids in it.
 */
export function candidates(world: World, open?: NodeId): Node[] {
  const scope = open ? nodeById(world, open) : undefined;
  const top = scope ? childrenOf(scope) : world.layers.flatMap((l) => l.children);
  return top.filter((n) => isSelectable(world, n.id));
}

/** the rectangle a box occupies on screen, or nothing when any of it is behind the eye */
export function projectBounds(view: View, size: Size, box: Bounds): Rect | undefined {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const p = projectPoint(view, [
      corner & 1 ? box.max[0] : box.min[0],
      corner & 2 ? box.max[1] : box.min[1],
      corner & 4 ? box.max[2] : box.min[2],
    ], size);
    // one corner behind the eye makes the whole projected rectangle meaningless, so the node is skipped
    // rather than half-projected — a band should never take something the designer cannot see
    if (!p) return undefined;
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { left, top, right, bottom };
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

const inside = (outer: Rect, inner: Rect): boolean =>
  inner.left >= outer.left && inner.right <= outer.right &&
  inner.top >= outer.top && inner.bottom <= outer.bottom;

/**
 * Everything a band caught.
 *
 * `whole` is the difference between the two things a band can mean: touch what it crosses, or take only
 * what it swallows. Touching is the default because it is what a designer reaches for nine times in ten —
 * "everything along this wall" — and containment is the careful one, so it is the one behind a modifier.
 */
export function nodesInBand(
  world: World, view: View, size: Size, rect: Rect, whole: boolean, open?: NodeId,
): NodeId[] {
  const out: NodeId[] = [];
  for (const node of candidates(world, open)) {
    const box = nodeBounds(node);
    if (!box) continue;
    const on = projectBounds(view, size, box);
    if (!on) continue;
    if (whole ? inside(rect, on) : overlaps(rect, on)) out.push(node.id);
  }
  return out;
}

// ---------------------------------------------------------------- the tool

/** the band tracker: it only ever changes the selection, so there is nothing on the undo stack at all */
function bandDrag(start: InputState): DragTracker {
  const was: { selection?: Editor["selection"] } = {};
  const apply = (input: InputState, editor: Editor): Outcome => {
    was.selection ??= editor.selection;
    const rect = rectBetween(start.at, input.at);
    const found = nodesInBand(
      editor.world, start.camera, start.size, rect, input.mods.alt, editor.open,
    );
    const base = input.mods.shift ? was.selection! : NOTHING;
    const mode: SelectMode = input.mods.shift ? "add" : "replace";
    return {
      set: (e) => ({ ...e, selection: selectNodes(e.world, base, found, mode, e.open) }),
      band: { view: start.view, rect },
      note: `${found.length} in the band${input.mods.alt ? " · whole only" : ""}`,
    };
  };
  return {
    move: apply,
    end: (input, editor) => ({ ...apply(input, editor), band: null, note: null }),
    cancel: () => ({
      set: (e) => (was.selection ? { ...e, selection: was.selection } : e),
      band: null,
      note: null,
    }),
  };
}

export const selectTool: Tool = {
  id: "select",
  title: "select",
  // not `s`: the 3D pane flies on wasd/qe, and a tool letter that also flies is a tool letter that flies
  key: "v",
  hint: "click selects · shift toggles · alt picks a face · drag bands · alt-drag takes only what it holds",

  click(input, _editor) {
    const hit = input.hit;
    const mode = modeOf(input.mods);
    if (!hit?.node) {
      // a click on nothing clears, but only when it was not a modified one — shift-clicking empty space
      // in the middle of building a selection is a slip, not an instruction to throw it away
      return mode === "replace" ? { set: (e) => ({ ...e, selection: NOTHING }), note: null } : undefined;
    }
    const id = hit.node;
    if (input.mods.alt && hit.face !== undefined) {
      const face = hit.face;
      return {
        set: (e) => ({ ...e, selection: selectFaces(e.world, e.selection, [{ node: id, face }], mode) }),
        note: `face ${face} of ${id}`,
      };
    }
    return {
      set: (e) => ({ ...e, selection: selectNodes(e.world, e.selection, [id], mode, e.open) }),
      note: null,
    };
  },

  drag: (input) => bandDrag(input),

  press(key, input, _editor) {
    // ctrl-a rather than a, for the same reason the tool letter is not `s`
    if (key === "a" && input?.mods.ctrl) {
      return { set: (e) => ({ ...e, selection: selectAllIn(e) }), note: "everything selected" };
    }
    if (key === "escape") return { set: (e) => ({ ...e, selection: NOTHING }), note: null };
    return undefined;
  },
};

/** kept here rather than reaching for `selectAll` directly so the key and the click agree about scope */
const selectAllIn = (e: Editor): Editor["selection"] =>
  selectNodes(e.world, NOTHING, candidates(e.world, e.open).map((n) => n.id), "replace", e.open);
