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
import { IDOBJECT, translation, type Mat4 } from "./brush/vec.ts";
import { snap } from "./grid/snap.ts";
import { gridSize, type Editor } from "./doc/editor.ts";
import {
  moveNodes, nodeById, nodeBounds, removeNodes, replaceNode, type NodeId,
} from "./doc/document.ts";
import { renameNode, setSheetId, sheetIds } from "./doc/inspect.ts";
import {
  addColumn, addRow, dropColumn, dropRow, flip as flipGrid, snapPatch, spansOf, type Patch,
} from "./patch/patch.ts";
import {
  closeGroup, duplicateSelected, groupSelected, isLinked, linkedCopy, linkGroups,
  openGroup, propagateFrom, separateGroup, ungroupSelected,
} from "./doc/groups.ts";
import {
  hideSelected, isolateSelected, lockSelected, showAll, toggleHidden, toggleLocked, unlockAll,
} from "./doc/layers.ts";
import { applyFixes, type Context, type Issue } from "./doc/issues.ts";
import {
  hollowSelection, intersectSelection, mergeSelection, subtractSelection, type Attempt,
} from "./doc/csg.ts";
import {
  applyTemplate, hasTemplate, removeTemplate, renameClass, selectByTemplate, type Template,
} from "./doc/templates.ts";
import type { ObjectDef } from "./doc/catalogue.ts";
import { cleanName } from "./io/materials.ts";
import { library } from "./library.svelte.ts";
import { NOTHING, selectExactly, selectedNodes, type SelectMode } from "./doc/selection.ts";
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
 * The selection, gone — every solid, patch, object and group of it.
 *
 * A root is not in the selection and so cannot be deleted here — a sheet's own top level is not a thing in
 * the level, it is where the level is kept. Nothing clears the selection afterwards either: an edit settles through `prune`, so pointing at what no longer exists is
 * already impossible.
 */
export const deleteSelection = (): void =>
  edit("delete", (e) => (e.selection.nodes.length ? { ...e, world: removeNodes(e.world, e.selection.nodes) } : e));

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
  if (!bounds) return IDOBJECT;
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

// ---------------------------------------------------------------- the tree

/**
 * Nodes moved under a parent, at an index — the hierarchy panel's drag and drop.
 *
 * `at` counts the children the parent has *after* the moving ones are taken out of it, which is what
 * `moveNodes` is written to take; the panel works that index out with `dropAt` in doc/tree.ts.
 */
export const reparent = (ids: NodeId[], parent: NodeId, at?: number): void =>
  edit("move", (e) => ({ ...e, world: moveNodes(e.world, ids, parent, at) }));

/** the hierarchy's own click: a row names a node, so that node is what is picked, group or no group */
export const pickNodes = (ids: NodeId[], mode: SelectMode = "replace"): void =>
  view((e) => ({ ...e, selection: selectExactly(e.world, e.selection, ids, mode) }));

/** a group's or a root's name — what F2 in the hierarchy edits */
export const renameTo = (id: NodeId, name: string): void =>
  edit("rename", (e) => ({ ...e, world: renameNode(e.world, id, name) }));

/**
 * The `#id` a node answers to, which is the name everything that is not a group goes by.
 *
 * Refused when it is taken: two nodes answering to `#lamp` means `ref(#lamp)` no longer names one thing,
 * and a sheet that reads back wrong is worse than a rename that did not happen.
 */
export const setId = (id: NodeId, to: string): void =>
  edit("set id", (e) => {
    const name = to.trim();
    if (name && sheetIds(e.world).includes(name)) return e;
    return { ...e, world: setSheetId(e.world, id, name) };
  });

// ---------------------------------------------------------------- visibility

export const hideNode = (id: NodeId): void =>
  edit("hide", (e) => ({ ...e, world: toggleHidden(e.world, id) }));
export const lockNode = (id: NodeId): void =>
  edit("lock", (e) => ({ ...e, world: toggleLocked(e.world, id) }));

export const hideSelection = (): void => edit("hide selection", hideSelected);
export const lockSelection = (): void => edit("lock selection", lockSelected);
export const isolateSelection = (): void => edit("isolate", isolateSelected);
export const showEverything = (): void => edit("show all", (e) => ({ ...e, world: showAll(e.world) }));
export const unlockEverything = (): void => edit("unlock all", (e) => ({ ...e, world: unlockAll(e.world) }));

// ---------------------------------------------------------------- templates

export const selectTemplate = (t: Template, mode: SelectMode = "replace"): void =>
  view((e) => selectByTemplate(e, t, mode));

/**
 * A template put on the selection, or taken off it.
 *
 * Off when every selected node already has it, on otherwise — the rule a checkbox over a multiple
 * selection needs, and the one that makes clicking twice a round trip.
 */
export const toggleTemplate = (t: Template): void =>
  edit(`template ${t.name}`, (e) => {
    const nodes = selectedNodes(e.world, e.selection);
    if (!nodes.length) return e;
    const ids = nodes.map((n) => n.id);
    const all = nodes.every((n) => hasTemplate(n, t));
    return { ...e, world: all ? removeTemplate(e.world, ids, t) : applyTemplate(e.world, ids, t) };
  });

/**
 * A kind renamed: the declaration and every instance of it, in one command.
 *
 * The two halves cannot be separated — a `@template` renamed while the level still says `.button` is a
 * delete with extra steps — and one ⌘Z has to be one rename, which is the same argument the material
 * browser makes for doing a material's rename this way.
 *
 * A name another template of the same node type already answers to is refused: two declarations under one
 * name is a level that reads back as something else.
 */
export function renameTemplate(def: ObjectDef, raw: string): void {
  const to = cleanName(raw);
  if (!to || to === def.name) return;
  if (library.objects.some((d) => d.name === to && d.node === def.node)) {
    return session.set((e) => ({ ...e, note: `.${to} is taken` }));
  }
  const was: Template = { name: def.name, node: def.node };
  const key = library.keyOfTemplate(def);
  session.run(`rename ${def.name}`, (e) => ({
    ...e,
    world: renameClass(e.world, was, to),
    templates: new Map(e.templates).set(key, { ...def, name: to }),
  }));
}

// ---------------------------------------------------------------- constructive solid geometry

/**
 * A CSG operation, or the reason it did not happen said out loud.
 *
 * These are the commands most likely to decline — a subtraction whose cutter overlaps nothing, an
 * intersection of two solids that miss each other — and a button that looks like it worked and did not is
 * the worst thing an editor can do to a designer's confidence. So the reason is carried out of the
 * document layer as a string and put in the status line here, *outside* the edit, where it cannot leave an
 * undo entry behind for a change that was never made.
 */
const csg = (name: string, attempt: (e: Editor) => Attempt): void => {
  let refused: string | undefined;
  edit(name, (e) => {
    const result = attempt(e);
    refused = typeof result === "string" ? result : undefined;
    return typeof result === "string" ? e : result;
  });
  if (refused) session.set((e) => ({ ...e, note: refused }));
};

export const subtractBrushes = (): void => csg("subtract", subtractSelection);
export const intersectBrushes = (): void => csg("intersect", intersectSelection);
export const mergeBrushes = (): void => csg("merge", mergeSelection);
export const hollowBrushes = (): void => csg("hollow", hollowSelection);

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

// ---------------------------------------------------------------- patches

/**
 * Every selected patch changed the same way, as one undo entry.
 *
 * The same operations the patch tool keeps on its keys, reachable with any tool in hand. A designer who
 * drew a dome an hour ago and now wants another row in it should not have to remember which tool put it
 * there — the patch is selected, and that is the whole of what these need to know.
 */
const onPatches = (name: string, change: (patch: Patch, e: Editor) => Patch): void =>
  edit(name, (e) => {
    let world = e.world;
    for (const id of e.selection.nodes) {
      const node = nodeById(world, id);
      if (node?.kind === "patch") world = replaceNode(world, id, { ...node, patch: change(node.patch, e) });
    }
    // the handles are named by where they sit in the grid, and every one of these moves them about in it
    return world === e.world ? e : { ...e, world, selection: { ...e.selection, vertices: [] } };
  });

/** the last span, which is the end a row or column is added at and taken off */
const lastRow = (p: Patch): number => spansOf(p.grid).down - 1;
const lastColumn = (p: Patch): number => spansOf(p.grid).across - 1;

export const addPatchRow = (): void => onPatches("add a row", (p) => addRow(p, lastRow(p)));
export const dropPatchRow = (): void => onPatches("drop a row", (p) => dropRow(p, lastRow(p)));
export const addPatchColumn = (): void => onPatches("add a column", (p) => addColumn(p, lastColumn(p)));
export const dropPatchColumn = (): void => onPatches("drop a column", (p) => dropColumn(p, lastColumn(p)));
export const flipPatches = (): void => onPatches("flip the patch", flipGrid);
export const snapPatches = (): void =>
  onPatches("snap to the grid", (p, e) => snapPatch(p, gridSize(e)));

/** how finely the surface is tessellated, or undefined to let the curvature decide */
export const setPatchDetail = (subdivisions: number | undefined): void =>
  onPatches("patch detail", (p) => {
    if (subdivisions === undefined) {
      const { subdivisions: _auto, ...rest } = p;
      return rest;
    }
    return { ...p, subdivisions: Math.max(1, Math.round(subdivisions)) };
  });

/** clicking an issue shows the thing it is about */
export const showIssue = (issue: Issue): void =>
  view((e) => {
    const node = nodeById(e.world, issue.node);
    if (!node) return e;
    return issue.face === undefined
      ? { ...e, selection: { ...NOTHING, nodes: [issue.node] } }
      : { ...e, selection: { ...NOTHING, faces: [{ node: issue.node, face: issue.face }] } };
  });
