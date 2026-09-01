/**
 * What the document commands actually do.
 *
 * The half of the keymap that belongs to the map rather than to a pane: files, undo, structure, the grid.
 * Kept out of the shell component because a command is not a key press — the same list is what a menu or a
 * palette would run, and none of it needs to know a window exists.
 *
 * A command may **decline**, and that is not a failure. `escape` means "leave the group" only once there is
 * no selection left to drop; while there is one it belongs to the tool, and declining is how the press gets
 * back out to the viewport instead of being swallowed here.
 */
import {
  deleteSelection, duplicate, group, hideSelection, hollowBrushes, intersectBrushes, isolateSelection,
  leaveGroup, lockSelection, mergeBrushes, showEverything, subtractBrushes, ungroup, unlockEverything,
} from "../actions.ts";
import { bakery } from "../bake/bake.svelte.ts";
import { withGrid } from "../doc/editor.ts";
import { isEmpty } from "../doc/selection.ts";
import { host } from "../host.svelte.ts";
import { clampExponent } from "../grid/snap.ts";
import { project } from "../io/project.svelte.ts";
import { session } from "../session.svelte.ts";
import { drawer } from "../ui/drawer.svelte.ts";

const step = (by: number) =>
  session.set((editor) => withGrid(editor, clampExponent(editor.world.broom.grid + by)));

/** every document command, by id. Anything that returns `false` is a command that declined the press. */
const RUN: Record<string, () => boolean | void> = {
  // the promises are deliberately dropped: the file dialogue owns the rest of the gesture, and there is
  // nothing to do afterwards that the store does not already do to itself
  "file.new": () => project.newMap(),
  "file.open": () => void project.open(),
  "file.save": () => void project.save(),
  "file.saveAs": () => void project.saveAs(),
  "file.revert": () => project.revert(),
  // declines when the page has no game to play, so F5 stays the browser's reload in a plain editor
  "file.play": () => host.play(),

  "edit.undo": () => session.undo(),
  "edit.redo": () => session.redo(),
  "edit.repeat": () => session.repeat(),
  "edit.duplicate": () => duplicate(),
  "edit.delete": () => deleteSelection(),

  "structure.group": () => group(),
  "structure.ungroup": () => ungroup(),
  "structure.leave": () => {
    if (!session.editor.open || !isEmpty(session.editor.selection)) return false;
    leaveGroup();
  },
  "structure.hide": () => hideSelection(),
  "structure.isolate": () => isolateSelection(),
  "structure.showAll": () => showEverything(),
  "structure.lock": () => lockSelection(),
  "structure.unlockAll": () => unlockEverything(),

  "csg.subtract": () => subtractBrushes(),
  "csg.intersect": () => intersectBrushes(),
  "csg.merge": () => mergeBrushes(),
  "csg.hollow": () => hollowBrushes(),

  "grid.finer": () => step(-1),
  "grid.coarser": () => step(1),

  "window.log": () => drawer.toggle("log"),
  "window.performance": () => drawer.toggle("performance"),
  // opens the panel and nothing more: a bake is minutes of GPU work, and no key press should be able to
  // start one without the settings it will run at being on the screen first
  "window.bake": () => bakery.togglePanel(),
};

/** run a document command; `false` means it was not this half's to run, or it declined */
export function runCommand(id: string): boolean {
  const run = RUN[id];
  if (!run) return false;
  return run() !== false;
}
