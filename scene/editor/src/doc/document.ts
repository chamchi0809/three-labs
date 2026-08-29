/**
 * The document: what a map is, in between the sheet on disk and the scene on screen.
 *
 * A world holds layers, layers hold groups, entities and solids, and groups and entities hold more of
 * the same. That is TrenchBroom's tree, and it maps onto tscene without inventing any syntax: a layer is
 * a top-level `group` node, a group is a nested one, an entity is any other node, and a solid is a
 * `brush`. Which of the two a `group` is comes from where it sits, so nothing has to be tagged.
 *
 * The tree is immutable. Every edit returns a new world sharing every subtree it did not touch, which is
 * what makes undo a matter of keeping the old value rather than of writing an inverse for each of forty
 * operations — and writing inverses is where editors get their subtlest bugs, because the inverse of a
 * vertex drag that merged two faces is not another vertex drag.
 *
 * Anything the editor has no opinion about stays as the `Member[]` the parser produced. The editor is
 * not the authority on what a sheet may say; it is one of several tools that edit the same file.
 */
import type { Member, NodeBroom, Value, Vec3 } from "tscene";
import type { Bounds } from "../brush/builder.ts";
import { brushBounds, type Brush } from "../brush/brush.ts";
import type { Origin } from "../io/origin.ts";
import { vec3Of } from "./props.ts";

export type NodeId = string;

let counter = 0;
/** a fresh identity. Ids live in memory only — the sheet identifies a node by its `#id`, or by position */
export const freshId = (): NodeId => `n${++counter}`;

/** shared by every node: who it is, where it was written, and how the editor is currently treating it */
type Base = {
  id: NodeId;
  /** the `@broom { … }` block, which is where `locked` and `hidden` are kept so a session survives saving */
  broom: NodeBroom;
  /** the `#id` the sheet gave it. Names in a sheet are the designer's; `id` above is the session's */
  sheetId?: string;
  /**
   * The `.class` templates written on its head. On every node rather than on entities alone, because
   * `brush.wall { … }` is legal tscene and a solid that lost its template on the way in would lose it on
   * the way out too.
   */
  classes: string[];
  /**
   * Where in which file this node was read from. Carried on the node rather than in a map beside the
   * tree, so that it survives every move, group and undo without anything having to remember to carry it.
   * Absent on a node the editor made, which is exactly how the writer knows to print it out in full.
   */
  origin?: Origin;
};

/** a solid */
export type BrushNode = Base & { kind: "brush"; brush: Brush; props: Member[] };

/**
 * Any node the editor does not model specially: a mesh, a light, an instance of a `@template`. Its body
 * is carried verbatim apart from the child nodes, which are lifted into `children`.
 */
export type EntityNode = Base & {
  kind: "entity";
  /** the node name as the sheet writes it: `mesh`, `pointLight`, or a template's name */
  type: string;
  args: Value[];
  props: Member[];
  children: Node[];
};

/** solids and entities selected and moved as one thing */
export type GroupNode = Base & { kind: "group"; name: string; children: Node[]; props: Member[] };

/** the top level of the tree, and the unit a designer hides a whole floor of a building with */
export type LayerNode = Base & { kind: "layer"; name: string; children: Node[]; props: Member[] };

export type Node = BrushNode | EntityNode | GroupNode | LayerNode;
export type Parent = GroupNode | LayerNode | EntityNode;
export type World = { layers: LayerNode[]; broom: { grid: number; scale: number } };

export const DEFAULT_LAYER = "Default";

export const hasChildren = (node: Node): node is Parent => node.kind !== "brush";
export const childrenOf = (node: Node): Node[] => (hasChildren(node) ? node.children : []);

// ---------------------------------------------------------------- building

export const brushNode = (brush: Brush, over: Partial<BrushNode> = {}): BrushNode => ({
  kind: "brush", id: freshId(), broom: {}, classes: [], props: [], brush, ...over,
});

export const entityNode = (type: string, over: Partial<EntityNode> = {}): EntityNode => ({
  kind: "entity", id: freshId(), broom: {}, classes: [], type, args: [], props: [], children: [], ...over,
});

export const groupNode = (name: string, children: Node[] = [], over: Partial<GroupNode> = {}): GroupNode => ({
  kind: "group", id: freshId(), broom: {}, classes: [], props: [], name, children, ...over,
});

export const layerNode = (name: string, children: Node[] = [], over: Partial<LayerNode> = {}): LayerNode => ({
  kind: "layer", id: freshId(), broom: {}, classes: [], props: [], name, children, ...over,
});

/** a new, empty map: one layer, a 25 cm grid, one metre per texture tile */
export const emptyWorld = (): World => ({ layers: [layerNode(DEFAULT_LAYER)], broom: { grid: -2, scale: 1 } });

// ---------------------------------------------------------------- walking

/** every node in the tree, parents before children */
export function* walk(world: World): Generator<Node> {
  const stack: Node[] = [...world.layers].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    yield node;
    const kids = childrenOf(node);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
}

export function nodeById(world: World, id: NodeId): Node | undefined {
  for (const node of walk(world)) if (node.id === id) return node;
  return undefined;
}

/**
 * Every node's parent, in one pass. Built on demand rather than kept on the nodes, because a parent
 * pointer is a second copy of the tree's shape and the two get out of step exactly once, in the operation
 * nobody thought to update.
 */
export function parents(world: World): Map<NodeId, NodeId | undefined> {
  const map = new Map<NodeId, NodeId | undefined>();
  for (const layer of world.layers) map.set(layer.id, undefined);
  for (const node of walk(world)) for (const kid of childrenOf(node)) map.set(kid.id, node.id);
  return map;
}

/** the chain from the layer down to `id`, inclusive; empty if there is no such node */
export function pathTo(world: World, id: NodeId): Node[] {
  const search = (node: Node, trail: Node[]): Node[] | undefined => {
    const here = [...trail, node];
    if (node.id === id) return here;
    for (const kid of childrenOf(node)) {
      const found = search(kid, here);
      if (found) return found;
    }
    return undefined;
  };
  for (const layer of world.layers) {
    const found = search(layer, []);
    if (found) return found;
  }
  return [];
}

export const layerOf = (world: World, id: NodeId): LayerNode | undefined => {
  const first = pathTo(world, id)[0];
  return first?.kind === "layer" ? first : undefined;
};

/** the outermost group `id` is inside, which is what a click selects unless that group has been opened */
export function groupOf(world: World, id: NodeId, opened?: NodeId): GroupNode | undefined {
  const path = pathTo(world, id);
  const from = opened ? path.findIndex((n) => n.id === opened) + 1 : 0;
  return path.slice(from).find((n): n is GroupNode => n.kind === "group");
}

/** locking and hiding are inherited: a locked layer locks everything on it */
export const isLocked = (world: World, id: NodeId): boolean => pathTo(world, id).some((n) => n.broom.locked === true);
export const isHidden = (world: World, id: NodeId): boolean => pathTo(world, id).some((n) => n.broom.hidden === true);

/** every solid at or under a node — what a material assignment or a CSG operation actually acts on */
export function* brushesUnder(node: Node): Generator<BrushNode> {
  if (node.kind === "brush") yield node;
  else for (const kid of node.children) yield* brushesUnder(kid);
}

// ---------------------------------------------------------------- changing

/**
 * One node replaced, or removed when `to` is undefined. Everything not on the path from the root to it
 * comes back as the very same object, which is what lets the renderer skip whole subtrees by identity
 * and what keeps an undo snapshot cheap.
 */
export function replaceNode(world: World, id: NodeId, to: Node | undefined): World {
  const inList = (list: Node[]): Node[] | undefined => {
    let changed = false;
    const out: Node[] = [];
    for (const node of list) {
      if (node.id === id) {
        changed = true;
        if (to) out.push(to);
        continue;
      }
      const kids = hasChildren(node) ? inList(node.children) : undefined;
      if (kids) {
        changed = true;
        out.push({ ...node, children: kids } as Node);
      } else out.push(node);
    }
    return changed ? out : undefined;
  };
  const layers = inList(world.layers);
  return layers ? { ...world, layers: layers.filter((n): n is LayerNode => n.kind === "layer") } : world;
}

/**
 * A node changed by a function of itself — the shape almost every tool wants.
 *
 * A function that hands back the node it was given means no change, and the world comes back as the same
 * value rather than as an identical copy. Tools rely on that: "add this tag to every selected node" runs
 * over nodes that already have it, and a copy per no-op would defeat the identity checks the renderer and
 * the undo stack are built on.
 */
export function updateNode<T extends Node>(world: World, id: NodeId, fn: (node: T) => Node): World {
  const node = nodeById(world, id) as T | undefined;
  if (!node) return world;
  const to = fn(node);
  return to === node ? world : replaceNode(world, id, to);
}

/** several nodes removed at once, so a multi-selection delete is one pass and one new tree */
export function removeNodes(world: World, ids: Iterable<NodeId>): World {
  const gone = new Set(ids);
  if (!gone.size) return world;
  const inList = (list: Node[]): Node[] =>
    list
      .filter((n) => !gone.has(n.id))
      .map((n) => (hasChildren(n) ? ({ ...n, children: inList(n.children) } as Node) : n));
  return { ...world, layers: inList(world.layers).filter((n): n is LayerNode => n.kind === "layer") };
}

/** children added to a parent, at the end unless a position is given */
export function insertNodes(world: World, parent: NodeId, nodes: Node[], at?: number): World {
  if (!nodes.length) return world;
  return updateNode<Parent>(world, parent, (p) => {
    const kids = [...p.children];
    kids.splice(at ?? kids.length, 0, ...nodes);
    return { ...p, children: kids };
  });
}

/**
 * Nodes moved to another parent. Removing and re-inserting in one step rather than two, because between
 * the two a node belongs to nobody, and every observer of the tree would have to be prepared for that.
 */
export function moveNodes(world: World, ids: NodeId[], parent: NodeId, at?: number): World {
  const moving = ids.map((id) => nodeById(world, id)).filter((n): n is Node => !!n);
  if (!moving.length) return world;
  // a node cannot be moved inside itself, which is the one way this could produce a cycle
  const inside = new Set(moving.flatMap((n) => [...subtreeIds(n)]));
  if (inside.has(parent)) return world;
  return insertNodes(removeNodes(world, ids), parent, moving, at);
}

export function* subtreeIds(node: Node): Generator<NodeId> {
  yield node.id;
  for (const kid of childrenOf(node)) yield* subtreeIds(kid);
}

/**
 * A node and everything under it, as a second node.
 *
 * Fresh ids all the way down, and no `#id`: an id is a name in the level, `ref(#lamp)` names one thing by
 * it, and a copy that took the name with it would leave two nodes answering to it and a sheet that reads
 * back wrong. Everything else is shared rather than cloned, because every part of it is immutable.
 */
export function copyNode(node: Node): Node {
  const { sheetId: _named, ...rest } = node;
  const made = { ...rest, id: freshId() } as Node;
  return hasChildren(made) ? { ...made, children: made.children.map(copyNode) } : made;
}

/** a group made of the given nodes, in the layer the first of them was on */
export function groupNodes(world: World, ids: NodeId[], name: string): { world: World; group?: GroupNode } {
  const nodes = ids.map((id) => nodeById(world, id)).filter((n): n is Node => !!n);
  if (nodes.length < 1) return { world };
  const home = pathTo(world, nodes[0]!.id).at(-2) ?? world.layers[0]!;
  const group = groupNode(name, nodes);
  return { world: insertNodes(removeNodes(world, ids), home.id, [group]), group };
}

/** a group taken apart, its children left where the group was */
export function ungroup(world: World, id: NodeId): { world: World; freed: NodeId[] } {
  const group = nodeById(world, id);
  if (group?.kind !== "group") return { world, freed: [] };
  const home = pathTo(world, id).at(-2);
  if (!home) return { world, freed: [] };
  const at = childrenOf(home).findIndex((n) => n.id === id);
  return {
    world: insertNodes(removeNodes(world, [id]), home.id, group.children, at),
    freed: group.children.map((n) => n.id),
  };
}

// ---------------------------------------------------------------- extent

/** the box an entity draws in when it is not a solid: what its `@broom { size }` says, about its origin */
export function entityBounds(node: EntityNode): Bounds | undefined {
  const at = vec3Of(node.props, "position") ?? [0, 0, 0];
  const size = node.broom.size;
  if (!size || size.length !== 6) {
    // an entity with no stated size is still somewhere, and a point is a box a picker can hit
    return { min: at, max: at };
  }
  return {
    min: [at[0] + size[0]!, at[1] + size[1]!, at[2] + size[2]!],
    max: [at[0] + size[3]!, at[1] + size[4]!, at[2] + size[5]!],
  };
}

/** everything a node encloses, or nothing when it encloses nothing at all */
export function nodeBounds(node: Node): Bounds | undefined {
  if (node.kind === "brush") return brushBounds(node.brush);
  const own = node.kind === "entity" ? entityBounds(node) : undefined;
  return childrenOf(node).reduce<Bounds | undefined>((acc, kid) => union(acc, nodeBounds(kid)), own);
}

export function union(a: Bounds | undefined, b: Bounds | undefined): Bounds | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export const boundsCentre = (b: Bounds): Vec3 => [
  (b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2,
];

export const boundsOverlap = (a: Bounds, b: Bounds): boolean =>
  a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
  a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
  a.min[2] <= b.max[2] && a.max[2] >= b.min[2];

export const boundsContain = (outer: Bounds, inner: Bounds): boolean =>
  outer.min[0] <= inner.min[0] && outer.max[0] >= inner.max[0] &&
  outer.min[1] <= inner.min[1] && outer.max[1] >= inner.max[1] &&
  outer.min[2] <= inner.min[2] && outer.max[2] >= inner.max[2];

export const worldBounds = (world: World): Bounds | undefined =>
  world.layers.reduce<Bounds | undefined>((acc, l) => union(acc, nodeBounds(l)), undefined);
