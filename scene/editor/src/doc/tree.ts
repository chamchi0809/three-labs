/**
 * The hierarchy as a flat list, and what a drag over it means.
 *
 * The panel draws rows, not a tree: one array in document order, each row carrying its depth and which
 * parent it belongs to. That is what makes hit-testing a drag arithmetic rather than a walk — the row
 * under the pointer is `floor(y / rowHeight)`, and everything the drop needs is on it.
 *
 * The one piece of real arithmetic is {@link dropAt}. `moveNodes` removes the moving nodes first and then
 * inserts, so the index it takes counts the siblings that are *left*; an index read off the visible list
 * counts the ones still there. Dragging a node down two places inside its own parent is exactly where the
 * difference shows, and getting it wrong is the classic outliner bug where the thing lands one short.
 */
import {
  childrenOf, hasChildren, nodeById, subtreeIds, type Node, type NodeId, type World,
} from "./document.ts";

export type TreeRow = {
  node: Node;
  depth: number;
  /** the node it is a child of, or nothing for a root — a root belongs to the world, not to a node */
  parent?: NodeId;
  /** its place among its siblings, as the document has them */
  index: number;
  kids: number;
  /** whether its children are showing; false for a leaf */
  open: boolean;
  /** its own flags, which are the ones a click on its eye or its lock turns over */
  hidden: boolean;
  locked: boolean;
  /** hidden or locked because something above it is, which is not something it can turn off itself */
  byParent: { hidden: boolean; locked: boolean };
};

/** the visible rows, top to bottom: the tree with the collapsed subtrees left out */
export function rowsOf(world: World, collapsed: ReadonlySet<NodeId> = new Set()): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (
    node: Node,
    depth: number,
    index: number,
    parent: NodeId | undefined,
    over: { hidden: boolean; locked: boolean },
  ): void => {
    const kids = childrenOf(node);
    const open = kids.length > 0 && !collapsed.has(node.id);
    out.push({
      node, depth, index, kids: kids.length, open,
      hidden: node.broom.hidden === true,
      locked: node.broom.locked === true,
      byParent: over,
      ...(parent !== undefined ? { parent } : {}),
    });
    if (!open) return;
    const under = {
      hidden: over.hidden || node.broom.hidden === true,
      locked: over.locked || node.broom.locked === true,
    };
    kids.forEach((kid, i) => walk(kid, depth + 1, i, node.id, under));
  };
  world.layers.forEach((layer, i) => walk(layer, 0, i, undefined, { hidden: false, locked: false }));
  return out;
}

// ---------------------------------------------------------------- what a drag means

/** the three things a pointer over a row can mean */
export type Where = "before" | "after" | "inside";

export type Drop = {
  where: Where;
  /** the row the marker is drawn against */
  row: NodeId;
  /** where the nodes end up; undefined is the world's root layer list */
  parent: NodeId | undefined;
  /** the index in the parent's children or root layers, counted before the moving nodes are taken out */
  index: number;
  /** how far in to draw the insertion line, so a gap between siblings reads as belonging to them */
  depth: number;
};

/**
 * Which third of a row the pointer is in.
 *
 * A quarter at each end rather than a half, because dropping *into* a group is the common gesture and
 * halves would leave it no room at all. A row that cannot hold children has no middle to speak of, so it
 * splits down the middle instead.
 */
export const zoneOf = (t: number, canHold: boolean): Where =>
  canHold ? (t < 0.25 ? "before" : t > 0.75 ? "after" : "inside") : t < 0.5 ? "before" : "after";

/** the last visible row belonging to the subtree that starts at `i` */
function subtreeEnd(rows: TreeRow[], i: number): number {
  const depth = rows[i]?.depth;
  if (depth === undefined) return i;
  let end = i;
  while (rows[end + 1]?.depth > depth) end++;
  return end;
}

/**
 * The drop a pointer at `t` down row `i` and horizontal `depth` means, or nothing when it means something
 * impossible. Pulling an after-drop into an ancestor's indentation band outdents it to that ancestor's
 * sibling level, provided the visible boundary is really the end of that ancestor's subtree.
 *
 * A group can cross depth zero because a top-level group is a layer. Brushes, patches and objects stop at
 * depth one because the world root can only contain those layers. Cycles, locked parents and leaf targets
 * are rejected here so what the marker promises and what the drop does are the same answer.
 */
export function dropOn(
  world: World,
  rows: TreeRow[],
  i: number,
  t: number,
  depth: number,
  moving: readonly NodeId[],
): Drop | undefined {
  const row = rows[i];
  if (!row) return undefined;
  const nodes = moving.map((id) => nodeById(world, id)).filter((node): node is Node => node !== undefined);
  const inside = new Set(nodes.flatMap((node) => [...subtreeIds(node)]));
  const canRoot =
    nodes.length === moving.length && nodes.every((node) => node.kind === "group" || node.kind === "layer");
  const dropDepth = Math.max(canRoot ? 0 : 1, depth);

  const canHold = hasChildren(row.node) && !inside.has(row.node.id);
  let where: Where | undefined;
  if (row.parent === undefined) {
    if (dropDepth === 0) where = t < 0.5 ? "before" : "after";
    else if (canHold) where = "inside";
  } else if (dropDepth <= row.depth) where = t < 0.5 ? "before" : "after";
  else where = zoneOf(t, canHold);
  if (!where) return undefined;

  if (where === "inside") {
    if (!canHold || locked(world, row.node.id)) return undefined;
    // the end of the list, which is where a drop onto a folder puts things everywhere else
    return { where, row: row.node.id, parent: row.node.id, index: childrenOf(row.node).length, depth: row.depth + 1 };
  }

  let target = row;
  if (where === "after") {
    const rootDepth = canRoot ? 0 : 1;
    const nextDepth = rows[subtreeEnd(rows, i) + 1]?.depth ?? rootDepth;
    const targetDepth = Math.min(row.depth, Math.max(rootDepth, dropDepth, nextDepth));
    while (target.depth > targetDepth) {
      const parent = target.parent && rows.find((candidate) => candidate.node.id === target.parent);
      if (!parent) break;
      target = parent;
    }
  }

  const parent = target.parent;
  if (parent !== undefined && (inside.has(parent) || locked(world, parent))) return undefined;
  let marker = row;
  if (where === "after") {
    const targetIndex = rows.findIndex((candidate) => candidate.node.id === target.node.id);
    marker = rows[subtreeEnd(rows, targetIndex)]!;
  }

  return {
    where,
    row: marker.node.id,
    parent,
    index: target.index + (where === "after" ? 1 : 0),
    depth: target.depth,
  };
}

const locked = (world: World, id: NodeId): boolean => {
  const node = nodeById(world, id);
  return node?.broom.locked === true;
};

/**
 * The index `moveNodes` wants: the drop index with the moving siblings that sat before it discounted.
 *
 * Dragging the second of three children to the end reads as index 3 off the visible list, but by the time
 * the insert happens there are only two children left and the answer is 2. Without this, a node dragged
 * down inside its own parent lands one place short of where the line was drawn.
 */
export function dropAt(world: World, parent: NodeId | undefined, moving: readonly NodeId[], index: number): number {
  const node = parent === undefined ? undefined : nodeById(world, parent);
  const kids: readonly Node[] = parent === undefined ? world.layers : node ? childrenOf(node) : [];
  const set = new Set(moving);
  return index - kids.slice(0, index).filter((k) => set.has(k.id)).length;
}
