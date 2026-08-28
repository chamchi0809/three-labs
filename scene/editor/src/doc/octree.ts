/**
 * The spatial index behind picking, rubber-band selection and culling.
 *
 * A loose octree: a node's items are the ones whose boxes fit inside it, and anything straddling a split
 * stays with the parent rather than being duplicated into both halves. That gives every item exactly one
 * home, so removing one is a matter of finding it once, and a query never has to remember which items it
 * has already seen.
 *
 * It indexes boxes, not solids. A ray query returns the nodes whose boxes it crosses, nearest first, and
 * the caller decides what a real hit is — for a brush that means testing the faces, which is the
 * viewport's job and costs far too much to do for every solid in a map.
 */
import type { Vec3 } from "tscene";
import type { Bounds } from "../brush/builder.ts";
import { boundsContain, boundsOverlap, type NodeId } from "./document.ts";

/** how deep to split before giving up, and how many items a cell holds before it tries to */
const MAX_DEPTH = 8;
const SPLIT_AT = 8;

export type Item = { id: NodeId; bounds: Bounds };

type Cell = {
  bounds: Bounds;
  items: Item[];
  /** the eight octants, or nothing while this cell is still a leaf */
  children?: Cell[];
};

export type Octree = { root: Cell; count: number };

const cell = (bounds: Bounds): Cell => ({ bounds, items: [] });

/**
 * The box everything must fit inside. An octree cannot grow, so it is built for the extent it is given,
 * padded so that a solid sitting exactly on the boundary is inside rather than nowhere.
 */
export function octree(within: Bounds, items: Item[] = []): Octree {
  const pad = Math.max(1, ...within.max.map((v, i) => (v - within.min[i]!) * 0.01));
  const bounds: Bounds = {
    min: [within.min[0] - pad, within.min[1] - pad, within.min[2] - pad],
    max: [within.max[0] + pad, within.max[1] + pad, within.max[2] + pad],
  };
  const tree: Octree = { root: cell(bounds), count: 0 };
  for (const item of items) insert(tree, item);
  return tree;
}

/** the tree for a set of items, sized to hold them all */
export function octreeOf(items: Item[]): Octree {
  const within = items.reduce<Bounds | undefined>(
    (acc, i) =>
      acc
        ? {
            min: [Math.min(acc.min[0], i.bounds.min[0]), Math.min(acc.min[1], i.bounds.min[1]), Math.min(acc.min[2], i.bounds.min[2])],
            max: [Math.max(acc.max[0], i.bounds.max[0]), Math.max(acc.max[1], i.bounds.max[1]), Math.max(acc.max[2], i.bounds.max[2])],
          }
        : i.bounds,
    undefined,
  );
  return octree(within ?? { min: [0, 0, 0], max: [0, 0, 0] }, items);
}

function split(c: Cell): void {
  const [x0, y0, z0] = c.bounds.min;
  const [x1, y1, z1] = c.bounds.max;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const mz = (z0 + z1) / 2;
  c.children = [];
  for (const [ax, bx] of [[x0, mx], [mx, x1]] as const)
    for (const [ay, by] of [[y0, my], [my, y1]] as const)
      for (const [az, bz] of [[z0, mz], [mz, z1]] as const)
        c.children.push(cell({ min: [ax, ay, az], max: [bx, by, bz] }));
}

export function insert(tree: Octree, item: Item): void {
  tree.count++;
  let c = tree.root;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (!c.children) {
      if (c.items.length < SPLIT_AT) break;
      split(c);
      // the items already here get a chance to sink now that there is somewhere to sink to
      const staying: Item[] = [];
      for (const held of c.items) {
        const into = c.children!.find((k) => boundsContain(k.bounds, held.bounds));
        if (into) into.items.push(held);
        else staying.push(held);
      }
      c.items = staying;
    }
    const into = c.children!.find((k) => boundsContain(k.bounds, item.bounds));
    if (!into) break; // it straddles a split, so this is as far down as it goes
    c = into;
  }
  c.items.push(item);
}

export function remove(tree: Octree, id: NodeId): boolean {
  const from = (c: Cell): boolean => {
    const at = c.items.findIndex((i) => i.id === id);
    if (at >= 0) {
      c.items.splice(at, 1);
      return true;
    }
    return (c.children ?? []).some(from);
  };
  const found = from(tree.root);
  if (found) tree.count--;
  return found;
}

// ---------------------------------------------------------------- queries

/** everything whose box meets `box` — the rubber-band select, before the exact test */
export function queryBounds(tree: Octree, box: Bounds): Item[] {
  const out: Item[] = [];
  // The root is the one cell that is never culled. Every other cell holds only items it contains, so
  // missing the cell means missing nothing; the root also holds whatever fell outside the extent the tree
  // was built for, and those items are somewhere else entirely.
  const visit = (c: Cell, cull: boolean) => {
    if (cull && !boundsOverlap(c.bounds, box)) return;
    for (const item of c.items) if (boundsOverlap(item.bounds, box)) out.push(item);
    for (const kid of c.children ?? []) visit(kid, true);
  };
  visit(tree.root, false);
  return out;
}

/** everything wholly inside `box` — the other half of the rubber band, and the stricter one */
export const queryInside = (tree: Octree, box: Bounds): Item[] =>
  queryBounds(tree, box).filter((i) => boundsContain(box, i.bounds));

/**
 * Where a ray enters and leaves a box, or nothing if it misses. The slab test: clip the ray against each
 * pair of parallel planes in turn and see whether an interval survives.
 */
export function rayBounds(origin: Vec3, direction: Vec3, box: Bounds): { near: number; far: number } | undefined {
  let near = -Infinity;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const d = direction[axis]!;
    const o = origin[axis]!;
    if (Math.abs(d) < 1e-12) {
      // parallel to this pair of faces: either always between them or never
      if (o < box.min[axis]! || o > box.max[axis]!) return undefined;
      continue;
    }
    const a = (box.min[axis]! - o) / d;
    const b = (box.max[axis]! - o) / d;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return undefined;
  }
  return far < 0 ? undefined : { near, far };
}

/** everything a ray crosses, nearest first — the candidates a click has to test properly */
export function queryRay(tree: Octree, origin: Vec3, direction: Vec3): { item: Item; near: number }[] {
  const out: { item: Item; near: number }[] = [];
  const visit = (c: Cell, cull: boolean) => {
    if (cull && !rayBounds(origin, direction, c.bounds)) return;
    for (const item of c.items) {
      const hit = rayBounds(origin, direction, item.bounds);
      if (hit) out.push({ item, near: hit.near });
    }
    for (const kid of c.children ?? []) visit(kid, true);
  };
  visit(tree.root, false);
  return out.sort((a, b) => a.near - b.near);
}

/** every item, in no particular order — for the checks, and for a rebuild */
export function items(tree: Octree): Item[] {
  const out: Item[] = [];
  const visit = (c: Cell) => {
    out.push(...c.items);
    for (const kid of c.children ?? []) visit(kid);
  };
  visit(tree.root);
  return out;
}

/** how deep the tree actually went — worth knowing when a query is slower than it should be */
export function depth(tree: Octree): number {
  const at = (c: Cell): number => 1 + Math.max(0, ...(c.children ?? []).map(at));
  return at(tree.root);
}
