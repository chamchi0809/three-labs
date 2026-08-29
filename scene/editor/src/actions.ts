/**
 * The named commands, in one place.
 *
 * A panel button and a keyboard shortcut that do "the same thing" must be the same thing, or they drift:
 * one of them forgets to settle the links, the other names its undo entry differently, and a designer who
 * learns the button cannot trust the key. So every command that changes the document lives here, named
 * once, and both the header and the inspector call it.
 *
 * One rule holds for all of them: **an edit that changes nothing returns the editor it was given**, which is
 * how the history decides not to push an entry. Putting the link sets back in step is *not* one of the rules
 * here — editing a solid inside one copy of a room is how a designer means to edit all of them, and that
 * happens in the command processor, which the tools reach without passing through this file.
 */
import { IDENTITY, translation, type Mat4 } from "./brush/vec.ts";
import { snap } from "./grid/snap.ts";
import { gridSize, type Editor } from "./doc/editor.ts";
import { nodeById, nodeBounds, type NodeId } from "./doc/document.ts";
import {
  closeGroup, duplicateSelected, groupSelected, isLinked, linkedCopy, linkGroups,
  openGroup, propagateFrom, separateGroup, ungroupSelected,
} from "./doc/groups.ts";
import {
  addLayer, hideSelected, isolateSelected, lockSelected, moveToLayer, removeLayer, renameLayer,
  showAll, toggleHidden, toggleLocked, unlockAll,
} from "./doc/layers.ts";
import { applyFixes, type Context, type Issue } from "./doc/issues.ts";
import { hasTag, selectByTag, tagNodes, untagNodes, type Tag } from "./doc/tags.ts";
import { isolateTag as isolate, hideTag as hide } from "./doc/tags.ts";
import { NOTHING, selectedNodes, type SelectMode } from "./doc/selection.ts";
import { session } from "./session.svelte.ts";

// ---------------------------------------------------------------- the two shapes every command has

/** an edit: one undo entry. The processor settles the link sets and tidies the editor */
export const edit = (name: string, apply: (e: Editor) => Editor): void => session.run(name, apply);

/** a change of view rather than of document — selection, the open group, the current layer */
export const view = (apply: (e: Editor) => Editor): void => session.set(apply);

// ---------------------------------------------------------------- groups

export const group = (name = "group"): void => edit("group", (e) => groupSelected(e, name));
export const ungroup = (): void => edit("ungroup", ungroupSelected);
export const enterGroup = (id: NodeId): void => view((e) => openGroup(e, id));
export const leaveGroup = (): void => view(closeGroup);
export const duplicate = (): void => edit("duplicate", duplicateSelected);

/**
 * A linked copy of the selected group, put down beside the original.
 *
 * Beside rather than on top: two groups at the same place look like one group, and the designer's next
 * gesture would move whichever of them the picker happened to hit. The step is the group's own width,
 * rounded onto the grid, so a row of copies lines up.
 */
export function linkedDuplicate(): void {
  edit("linked copy", (e) => {
    const nodes = selectedNodes(e.world, e.selection).filter((n) => n.kind === "group");
    if (!nodes.length) return e;
    let world = e.world;
    const made: NodeId[] = [];
    for (const node of nodes) {
      const { world: next, copy } = linkedCopy(world, node.id, beside(e, node.id));
      world = next;
      if (copy) made.push(copy.id);
    }
    return made.length ? { ...e, world, selection: { ...NOTHING, nodes: made } } : e;
  });
}

/** the transform that puts a copy of a node one of its own widths along +x, on the grid */
function beside(e: Editor, id: NodeId): Mat4 {
  const node = nodeById(e.world, id);
  const bounds = node && nodeBounds(node);
  if (!bounds) return IDENTITY;
  const step = gridSize(e);
  const width = Math.max(bounds.max[0] - bounds.min[0], step);
  // snapping down to nothing would put the copy back on top of the original, so the grid step is the floor
  return translation([Math.max(snap(width, step), step), 0, 0]);
}

/** two or more selected groups made into one set, so an edit to any of them reaches the others */
export const link = (): void =>
  edit("link groups", (e) => {
    const ids = selectedNodes(e.world, e.selection).filter((n) => n.kind === "group").map((n) => n.id);
    return ids.length < 2 ? e : { ...e, world: linkGroups(e.world, ids) };
  });

export const unlink = (): void =>
  edit("unlink", (e) => {
    const ids = selectedNodes(e.world, e.selection).filter(isLinked).map((n) => n.id);
    return ids.reduce((acc, id) => ({ ...acc, world: separateGroup(acc.world, id) }), e);
  });

/** the other copies made to match this one — the manual form of what every edit does automatically */
export const matchCopies = (): void =>
  edit("match copies", (e) => {
    const ids = selectedNodes(e.world, e.selection).map((n) => n.id);
    const from = ids.length ? ids : e.open ? [e.open] : [];
    return from.reduce((acc, id) => ({ ...acc, world: propagateFrom(acc.world, id) }), e);
  });

// ---------------------------------------------------------------- layers and visibility

export const newLayer = (name?: string): void =>
  edit("new layer", (e) => {
    const { world, layer } = addLayer(e.world, name);
    return { ...e, world, layer: layer.id };
  });

export const deleteLayer = (id: NodeId): void =>
  edit("delete layer", (e) => ({ ...e, world: removeLayer(e.world, id) }));

export const nameLayer = (id: NodeId, name: string): void =>
  edit("rename layer", (e) => ({ ...e, world: renameLayer(e.world, id, name) }));

/** where new solids go; not an edit, because it changes nothing that would be written to the sheet */
export const useLayer = (id: NodeId): void => view((e) => (e.layer === id ? e : { ...e, layer: id }));

export const moveSelectionToLayer = (id: NodeId): void => edit("move to layer", (e) => moveToLayer(e, id));

export const hideNode = (id: NodeId): void =>
  edit("hide", (e) => ({ ...e, world: toggleHidden(e.world, id) }));
export const lockNode = (id: NodeId): void =>
  edit("lock", (e) => ({ ...e, world: toggleLocked(e.world, id) }));

export const hideSelection = (): void => edit("hide selection", hideSelected);
export const lockSelection = (): void => edit("lock selection", lockSelected);
export const isolateSelection = (): void => edit("isolate", isolateSelected);
export const showEverything = (): void => edit("show all", (e) => ({ ...e, world: showAll(e.world) }));
export const unlockEverything = (): void => edit("unlock all", (e) => ({ ...e, world: unlockAll(e.world) }));

// ---------------------------------------------------------------- tags

export const selectTag = (tag: Tag, mode: SelectMode = "replace"): void =>
  view((e) => selectByTag(e, tag, mode));
export const isolateTag = (tag: Tag): void => edit(`isolate ${tag.name}`, (e) => isolate(e, tag));
export const hideTag = (tag: Tag): void => edit(`hide ${tag.name}`, (e) => hide(e, tag));

/**
 * A tag put on the selection, or taken off it.
 *
 * Off when every selected node already has it, on otherwise — the rule a checkbox over a multiple
 * selection needs, and the one that makes clicking twice a round trip.
 */
export const toggleTag = (tag: Tag): void =>
  edit(`tag ${tag.name}`, (e) => {
    const nodes = selectedNodes(e.world, e.selection);
    if (!nodes.length) return e;
    const ids = nodes.map((n) => n.id);
    const all = nodes.every((n) => hasTag(n, tag));
    return { ...e, world: all ? untagNodes(e.world, ids, tag) : tagNodes(e.world, ids, tag) };
  });

// ---------------------------------------------------------------- issues

/** one quick fix, and a list of them as one entry — "fix all" is a thing a designer undoes in one press */
export const fixIssue = (context: Context, issue: Issue): void => fixIssues(context, [issue]);

/**
 * Quick fixes applied, and *said so* when one of them turned out not to apply.
 *
 * A fix can refuse: snapping a door thinner than the grid onto the grid would leave nothing, so the
 * validator's fix hands back the world it was given. A button that looks like it worked and did not is
 * worse than no button, so the status line says which it was.
 */
export const fixIssues = (context: Context, issues: Issue[]): void => {
  const before = session.editor.world;
  edit(issues.length === 1 ? `fix: ${issues[0]!.message}` : `fix ${issues.length} issues`, (e) => {
    const world = applyFixes({ ...context, world: e.world }, issues);
    return world === e.world ? e : { ...e, world, note: `${issues.length} fixed` };
  });
  if (session.editor.world === before) {
    session.set((e) => ({ ...e, note: "nothing changed — that fix does not apply here" }));
  }
};

/** clicking an issue shows the thing it is about */
export const showIssue = (issue: Issue): void =>
  view((e) => {
    const node = nodeById(e.world, issue.node);
    if (!node) return e;
    return issue.face === undefined
      ? { ...e, selection: { ...NOTHING, nodes: [issue.node] } }
      : { ...e, selection: { ...NOTHING, faces: [{ node: issue.node, face: issue.face }] } };
  });
