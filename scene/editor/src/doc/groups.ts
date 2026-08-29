/**
 * Groups, and the linked ones.
 *
 * A plain group is a name over a set of nodes and nothing more: it has no transform of its own, its
 * children are in world coordinates like everything else, and stepping into one only changes what a click
 * resolves to. That is deliberate — a group that carried a transform would be a second place coordinates
 * live, and every tool would have to know which space it was working in.
 *
 * A **linked** group is the interesting one. Copies of a room that stay copies: edit one and the others
 * follow. Since a group has no transform, the way a copy knows where it stands is written down — `@broom
 * { at }`, the 12 numbers of its place in the link set. An edit is carried from one copy to the others by
 * going back through the source's `at` and forward through theirs, which is why `invert` exists.
 *
 * What does *not* travel is what makes two copies two things rather than one: a node's `#id`, because an
 * id names one node in the level and `ref(#lamp)` has to mean something, and whatever the copy lists in
 * `@broom { protect }` — TrenchBroom's protected properties, and the reason linked groups are usable at
 * all, since two copies of a door are the same door except for the one property that makes them two doors.
 */
import type { Vec3 } from "tscene";
import { IDENTITY, invert, multiply, translation, type Mat4 } from "../brush/vec.ts";
import {
  boundsCentre, childrenOf, copyNode, groupNodes, hasChildren, insertNodes, nodeBounds, nodeById,
  pathTo, replaceNode, ungroup, type GroupNode, type Node, type NodeId, type World,
} from "./document.ts";
import type { Editor } from "./editor.ts";
import { removeProp, setProp, valueOf } from "./props.ts";
import { NOTHING, selectedNodes } from "./selection.ts";
import { transformNode } from "./transform.ts";

// ---------------------------------------------------------------- reading a group

export const linkOf = (node: Node): string | undefined => node.broom.link;

/** where a copy stands in its link set; the set's own space when it does not say */
export const atOf = (node: Node): Mat4 =>
  node.broom.at?.length === 12 ? ([...node.broom.at] as Mat4) : IDENTITY;

export const protectedNames = (node: Node): string[] =>
  (node.broom.protect ?? "").split(/\s+/).filter(Boolean);

export const isLinked = (node: Node): node is GroupNode =>
  node.kind === "group" && node.broom.link !== undefined;

/** every group in a link set, in tree order */
export function membersOf(world: World, link: string): GroupNode[] {
  const out: GroupNode[] = [];
  const walk = (node: Node): void => {
    if (node.kind === "group" && node.broom.link === link) out.push(node);
    for (const kid of childrenOf(node)) walk(kid);
  };
  for (const layer of world.layers) walk(layer);
  return out;
}

/** the other copies of this group, or nothing when it is not linked */
export function linkedWith(world: World, id: NodeId): GroupNode[] {
  const group = nodeById(world, id);
  const link = group?.kind === "group" ? group.broom.link : undefined;
  return link ? membersOf(world, link).filter((g) => g.id !== id) : [];
}

/** a link name nobody is using, derived from the group's own name so a diff stays readable */
export function freshLink(world: World, name: string): string {
  const stem = name.trim().replace(/\s+/g, "-").toLowerCase() || "group";
  if (!membersOf(world, stem).length) return stem;
  for (let n = 2; ; n++) if (!membersOf(world, `${stem}-${n}`).length) return `${stem}-${n}`;
}

const centreOf = (node: Node): Vec3 => {
  const box = nodeBounds(node);
  return box ? boundsCentre(box) : [0, 0, 0];
};

// ---------------------------------------------------------------- grouping

/** the selection gathered under one new group, which is then what is selected */
export function groupSelected(e: Editor, name: string): Editor {
  const ids = selectedNodes(e.world, e.selection).map((n) => n.id);
  if (!ids.length) return e;
  const { world, group } = groupNodes(e.world, ids, name);
  if (!group) return e;
  return { ...e, world, selection: { ...NOTHING, nodes: [group.id] } };
}

/** every selected group taken apart, its children left where it was and selected in its place */
export function ungroupSelected(e: Editor): Editor {
  const groups = selectedNodes(e.world, e.selection).filter((n) => n.kind === "group");
  if (!groups.length) return e;
  let world = e.world;
  const freed: NodeId[] = [];
  for (const group of groups) {
    const done = ungroup(world, group.id);
    world = done.world;
    freed.push(...done.freed);
  }
  return { ...e, world, selection: { ...NOTHING, nodes: freed }, open: undefined };
}

/**
 * Stepping into a group.
 *
 * The selection is dropped rather than kept, because what was selected was the group and the designer has
 * just said they mean the things inside it. Stepping out selects the group again, which is the state they
 * were in before — a round trip that leaves the editor where it started.
 */
export const openGroup = (e: Editor, id: NodeId): Editor =>
  nodeById(e.world, id)?.kind === "group" ? { ...e, open: id, selection: NOTHING } : e;

export function closeGroup(e: Editor): Editor {
  if (!e.open) return e;
  const path = pathTo(e.world, e.open);
  const outer = path.slice(0, -1).reverse().find((n) => n.kind === "group");
  return { ...e, open: outer?.id, selection: { ...NOTHING, nodes: [e.open] } };
}

/** the selection copied in place; the copies are what is selected, so a move after a copy moves the copy */
export function duplicateSelected(e: Editor): Editor {
  const nodes = selectedNodes(e.world, e.selection);
  if (!nodes.length) return e;
  let world = e.world;
  const made: NodeId[] = [];
  for (const node of nodes) {
    const home = pathTo(world, node.id).at(-2);
    if (!home) continue;
    const copy = copyNode(node);
    world = insertNodes(world, home.id, [copy]);
    made.push(copy.id);
  }
  return { ...e, world, selection: { ...NOTHING, nodes: made } };
}

// ---------------------------------------------------------------- linking

/**
 * Several groups made into one link set.
 *
 * Each one's place is recorded as the offset from the first, so linking two copies of a room that were
 * duplicated and moved apart leaves them where they are. It is a translation and not a full transform
 * because that is what can be recovered from two groups after the fact — a copy that was also rotated has
 * to be made with {@link linkedCopy}, which knows the transform because it performed it.
 */
export function linkGroups(world: World, ids: NodeId[], name?: string): World {
  const groups = ids.map((id) => nodeById(world, id)).filter((n): n is GroupNode => n?.kind === "group");
  if (groups.length < 2) return world;
  const link = name ?? freshLink(world, groups[0]!.name);
  const home = centreOf(groups[0]!);
  let out = world;
  for (const group of groups) {
    const at = group.id === groups[0]!.id
      ? IDENTITY
      : translation(sub3(centreOf(group), home));
    out = replaceNode(out, group.id, { ...group, broom: { ...group.broom, link, at: [...at] } });
  }
  return out;
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * A copy of a group that stays a copy, placed by `m`.
 *
 * The source joins the link set if it was not in one, which is what makes "duplicate this group as a
 * linked copy" a single action rather than two.
 */
export function linkedCopy(world: World, id: NodeId, m: Mat4): { world: World; copy?: GroupNode } {
  const found = nodeById(world, id);
  if (found?.kind !== "group") return { world };

  const link = found.broom.link ?? freshLink(world, found.name);
  let out = world;
  if (found.broom.link === undefined) {
    out = replaceNode(out, id, { ...found, broom: { ...found.broom, link, at: [...atOf(found)] } });
  }
  const source = nodeById(out, id) as GroupNode;
  const home = pathTo(out, id).at(-2);
  if (!home) return { world };

  const moved = transformNode(copyNode(source), m, true);
  if (!moved.node || moved.node.kind !== "group") return { world };
  const copy: GroupNode = {
    ...moved.node,
    broom: { ...moved.node.broom, link, at: [...multiply(m, atOf(source))] },
  };
  return { world: insertNodes(out, home.id, [copy]), copy };
}

/** a group taken out of its set; the set itself goes when only one copy is left in it */
export function separateGroup(world: World, id: NodeId): World {
  const group = nodeById(world, id);
  if (group?.kind !== "group" || group.broom.link === undefined) return world;
  const link = group.broom.link;
  let out = replaceNode(world, id, { ...group, broom: without(group.broom) });
  const left = membersOf(out, link);
  if (left.length === 1) out = replaceNode(out, left[0]!.id, { ...left[0]!, broom: without(left[0]!.broom) });
  return out;
}

const without = (broom: Node["broom"]): Node["broom"] => {
  const { link: _l, at: _a, ...rest } = broom;
  return rest;
};

// ---------------------------------------------------------------- propagation

/**
 * Every other copy in the set rebuilt from this one.
 *
 * Called after an edit inside a linked group, which is the only time the copies can disagree. The rebuild
 * is positional: the source's nth child becomes the target's nth child, keeping the target's own node id
 * so that a selection and an undo stack pointing at it still mean something.
 */
export function propagate(world: World, sourceId: NodeId): World {
  const source = nodeById(world, sourceId);
  if (source?.kind !== "group" || source.broom.link === undefined) return world;
  const back = invert(atOf(source));
  if (!back) return world;

  let out = world;
  for (const other of membersOf(world, source.broom.link)) {
    if (other.id === sourceId) continue;
    const m = multiply(atOf(other), back);
    const children = replay(source.children, other.children, m);
    out = replaceNode(out, other.id, { ...other, children });
  }
  return out;
}

/** the whole set brought back into step from whichever copy holds the node that changed */
export function propagateFrom(world: World, id: NodeId): World {
  const group = pathTo(world, id).reverse().find(isLinked);
  return group ? propagate(world, group.id) : world;
}

function replay(source: Node[], was: Node[], m: Mat4): Node[] {
  return source.map((child, i) => {
    const moved = transformNode(copyNode(child), m, true);
    // a transform that would destroy a solid leaves the copy's own child alone rather than dropping it —
    // half a room replayed is worse than a room that is briefly out of step
    return moved.node ? reconcile(moved.node, was[i]) : (was[i] ?? child);
  });
}

/** a replayed node wearing what belongs to the copy rather than to the source */
function reconcile(made: Node, was: Node | undefined): Node {
  if (!was) return made;

  let props = made.props;
  for (const name of protectedNames(was)) {
    const mine = valueOf(was.props, name);
    props = mine ? setProp(props, name, mine) : removeProp(props, name);
  }

  const node = {
    ...made,
    id: was.id,
    props,
    // hidden, locked, protect and the copy's own place are the copy's business; everything else came
    // from the source with the geometry
    broom: { ...made.broom, ...local(was.broom) },
    ...(was.sheetId === undefined ? {} : { sheetId: was.sheetId }),
  } as Node;

  return hasChildren(node) && hasChildren(was)
    ? { ...node, children: node.children.map((kid, i) => reconcile(kid, was.children[i])) }
    : node;
}

const local = (broom: Node["broom"]): Node["broom"] => ({
  ...(broom.hidden === undefined ? {} : { hidden: broom.hidden }),
  ...(broom.locked === undefined ? {} : { locked: broom.locked }),
  ...(broom.protect === undefined ? {} : { protect: broom.protect }),
  ...(broom.link === undefined ? {} : { link: broom.link }),
  ...(broom.at === undefined ? {} : { at: broom.at }),
});

/**
 * An edit's two ends, with every link set the edit touched brought back into step.
 *
 * The ids come from both ends deliberately: from before it, because that is where a node that has just
 * been deleted still is, and from after it, because that is where a node that has just been made is. The
 * open group is in the list for the same reason — an edit inside an opened copy is an edit to the whole
 * set, and the thing that changed may not be selected by the time the command ends.
 *
 * This is what makes "edit one copy, all of them follow" a property of the command processor rather than
 * something each of thirty tools has to remember.
 */
export function keepInStep(before: Editor, after: Editor): Editor {
  if (after.world === before.world) return after;
  const touched: NodeId[] = [
    ...before.selection.nodes,
    ...before.selection.faces.map((f) => f.node),
    ...after.selection.nodes,
    ...after.selection.faces.map((f) => f.node),
  ];
  if (before.open) touched.push(before.open);
  if (after.open) touched.push(after.open);
  const world = settleLinks(after.world, touched);
  return world === after.world ? after : { ...after, world };
}

/** what a tool calls after changing anything: the sets holding the changed nodes brought back into step */
export function settleLinks(world: World, changed: Iterable<NodeId>): World {
  const done = new Set<string>();
  let out = world;
  for (const id of changed) {
    const group = pathTo(out, id).reverse().find(isLinked);
    if (!group || done.has(group.broom.link!)) continue;
    done.add(group.broom.link!);
    out = propagate(out, group.id);
  }
  return out;
}
