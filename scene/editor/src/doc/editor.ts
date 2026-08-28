/**
 * Everything an edit can change, in one value.
 *
 * Undo restores this whole object, not just the tree — because a designer who undoes a delete expects
 * the things that came back to be selected, and one who undoes a group expects to be standing outside it
 * again. Keeping selection and the open group here rather than beside the history is what makes that
 * fall out instead of having to be arranged.
 *
 * It is a plain value with no methods. The command processor turns functions of it into an undo stack,
 * and the UI reads it; nothing mutates it in place.
 */
import type { NodeId, World } from "./document.ts";
import { DEFAULT_LAYER, emptyWorld, nodeById } from "./document.ts";
import { NOTHING, prune, type Selection } from "./selection.ts";

export type Editor = {
  world: World;
  selection: Selection;
  /** the group the designer has stepped into, if any; everything outside it is picked as a whole */
  open?: NodeId;
  /** where a newly created solid goes */
  layer: NodeId;
  /** the material a new face is given, as the name of a `--var` */
  material?: string;
  /** the last thing that happened, for the status line */
  note?: string;
};

export function newEditor(world = emptyWorld()): Editor {
  return { world, selection: NOTHING, layer: world.layers[0]?.id ?? DEFAULT_LAYER };
}

/** the grid size in metres — the sheet stores the exponent, because that is the thing that is stepped */
export const gridSize = (e: Editor): number => 2 ** e.world.broom.grid;

export const withGrid = (e: Editor, exponent: number): Editor => ({
  ...e,
  world: { ...e.world, broom: { ...e.world.broom, grid: Math.max(-6, Math.min(3, Math.round(exponent))) } },
});

/**
 * The editor put back into a consistent state after a change to the tree: a selection that still points
 * at things that exist, an open group that still exists, and a current layer that does too.
 *
 * Every command ends here rather than each one remembering to tidy up after itself, because the command
 * that forgets is always the one that ships.
 */
export function settleEditor(e: Editor): Editor {
  const selection = prune(e.world, e.selection);
  const open = e.open && nodeById(e.world, e.open)?.kind === "group" ? e.open : undefined;
  const layer = nodeById(e.world, e.layer)?.kind === "layer" ? e.layer : (e.world.layers[0]?.id ?? e.layer);
  return selection === e.selection && open === e.open && layer === e.layer ? e : { ...e, selection, open, layer };
}
