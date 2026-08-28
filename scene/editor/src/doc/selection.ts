/**
 * What is selected, and the rules about what may be.
 *
 * Two of those rules are worth stating outright, because everything else follows from them:
 *
 * - **Objects and faces are exclusive.** Selecting a face drops the object selection and vice versa.
 *   A material assignment means "this face" or "every face of these solids" and there is no useful third
 *   thing it could mean, so the mode is carried by what is selected rather than by a hidden switch.
 * - **A click selects the outermost group.** Solids inside a group are not individually selectable until
 *   that group is opened, which is what makes a group a thing rather than a label. `open` is how far in
 *   the designer has stepped.
 *
 * Locked and hidden nodes cannot be selected at all, and — the part that is easy to get wrong — a node
 * already selected when its layer is locked is dropped rather than left selected and unmovable.
 */
import type { Vec3 } from "tscene";
import type { Bounds } from "../brush/builder.ts";
import {
  boundsContain, boundsOverlap, brushesUnder, childrenOf, groupOf, isHidden, isLocked, nodeBounds,
  nodeById, pathTo, union, walk, type BrushNode, type Node, type NodeId, type World,
} from "./document.ts";
import type { Item, Octree } from "./octree.ts";
import { queryBounds } from "./octree.ts";

export type FaceRef = { node: NodeId; face: number };
export type VertexRef = { node: NodeId; vertex: number };
export type EdgeRef = { node: NodeId; a: number; b: number };

export type Selection = {
  nodes: NodeId[];
  faces: FaceRef[];
  /** the vertex tool's handles; scoped to the selected solids, and cleared whenever they change */
  vertices: VertexRef[];
  edges: EdgeRef[];
};

/** how a click combines with what was already selected */
export type SelectMode = "replace" | "add" | "toggle" | "remove";

export const NOTHING: Selection = { nodes: [], faces: [], vertices: [], edges: [] };

export const isEmpty = (s: Selection): boolean =>
  !s.nodes.length && !s.faces.length && !s.vertices.length && !s.edges.length;

const faceKey = (f: FaceRef) => `${f.node}:${f.face}`;
const vertexKey = (v: VertexRef) => `${v.node}:${v.vertex}`;
const edgeKey = (e: EdgeRef) => `${e.node}:${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`;

/** the general shape of every selection change: a set combined with a set, four ways */
function combine<T>(was: T[], now: T[], mode: SelectMode, key: (t: T) => string): T[] {
  if (mode === "replace") return dedupe(now, key);
  const have = new Map(was.map((t) => [key(t), t]));
  for (const t of now) {
    const k = key(t);
    if (mode === "add") have.set(k, t);
    else if (mode === "remove") have.delete(k);
    else if (have.has(k)) have.delete(k);
    else have.set(k, t);
  }
  return [...have.values()];
}

const dedupe = <T>(list: T[], key: (t: T) => string): T[] => [...new Map(list.map((t) => [key(t), t])).values()];
const same = (id: NodeId) => id;

// ---------------------------------------------------------------- what may be selected

/** locked, hidden, or gone — three reasons a node cannot be picked, and one answer */
export const isSelectable = (world: World, id: NodeId): boolean =>
  !!nodeById(world, id) && !isLocked(world, id) && !isHidden(world, id);

/**
 * What clicking a node actually selects: the outermost group it is inside, unless the designer has
 * stepped into that group, in which case the node itself.
 */
export function resolve(world: World, id: NodeId, open?: NodeId): NodeId | undefined {
  if (!isSelectable(world, id)) return undefined;
  return groupOf(world, id, open)?.id ?? id;
}

// ---------------------------------------------------------------- objects

export function selectNodes(world: World, s: Selection, ids: NodeId[], mode: SelectMode = "replace", open?: NodeId): Selection {
  const wanted = ids.map((id) => resolve(world, id, open)).filter((id): id is NodeId => !!id);
  // adding nothing to a selection is not the same as clearing it — only "replace" means "instead of"
  if (!wanted.length && mode !== "replace") return s;
  const nodes = combine(s.nodes, wanted, mode, same);
  // faces and objects do not coexist, and handles belong to solids that may no longer be selected
  return nodes.length ? { nodes, faces: [], vertices: [], edges: [] } : { ...NOTHING, nodes };
}

/** everything selectable, within the open group if there is one */
export function selectAll(world: World, open?: NodeId): Selection {
  const scope = open ? nodeById(world, open) : undefined;
  const top = scope ? childrenOf(scope) : world.layers.flatMap((l) => l.children);
  return { ...NOTHING, nodes: top.filter((n) => isSelectable(world, n.id)).map((n) => n.id) };
}

/** the other children of the selection's parents — TrenchBroom's "select siblings" */
export function selectSiblings(world: World, s: Selection): Selection {
  const out = new Set<NodeId>();
  for (const id of s.nodes) {
    const parent = pathTo(world, id).at(-2);
    // a node with no parent is a layer, and the other layers are its siblings
    const siblings = parent ? childrenOf(parent) : world.layers;
    for (const kid of siblings) if (isSelectable(world, kid.id)) out.add(kid.id);
  }
  return { ...NOTHING, nodes: [...out] };
}

/** everything a box touches, or everything it swallows — the two halves of a rubber band */
export function selectInBox(world: World, tree: Octree, box: Bounds, whole: boolean, open?: NodeId): Selection {
  const hits = queryBounds(tree, box).filter((i: Item) => !whole || boundsContain(box, i.bounds));
  return selectNodes(world, NOTHING, hits.map((i) => i.id), "replace", open);
}

/** everything the selection's own boxes touch — "select touching", without needing a drag */
export function selectTouching(world: World, s: Selection, tree: Octree, open?: NodeId): Selection {
  const boxes = s.nodes.map((id) => nodeById(world, id)).filter((n): n is Node => !!n).map(nodeBounds);
  const chosen = new Set<NodeId>();
  for (const box of boxes) {
    if (!box) continue;
    for (const hit of queryBounds(tree, box)) if (!s.nodes.includes(hit.id) && boundsOverlap(hit.bounds, box)) chosen.add(hit.id);
  }
  return selectNodes(world, NOTHING, [...chosen], "replace", open);
}

// ---------------------------------------------------------------- faces and handles

export function selectFaces(world: World, s: Selection, refs: FaceRef[], mode: SelectMode = "replace"): Selection {
  const wanted = refs.filter((f) => isSelectable(world, f.node) && nodeById(world, f.node)?.kind === "brush");
  return { ...NOTHING, faces: combine(s.faces, wanted, mode, faceKey) };
}

/** every face of the selected solids — what "select all faces of this brush" resolves to */
export function selectAllFaces(world: World, s: Selection): Selection {
  const faces: FaceRef[] = [];
  for (const id of s.nodes) {
    const node = nodeById(world, id);
    if (!node) continue;
    for (const b of brushesUnder(node)) b.brush.poly.faces.forEach((_, face) => faces.push({ node: b.id, face }));
  }
  return { ...NOTHING, faces };
}

export const selectVertices = (s: Selection, refs: VertexRef[], mode: SelectMode = "replace"): Selection => ({
  ...s,
  vertices: combine(s.vertices, refs, mode, vertexKey),
  faces: [],
});

export const selectEdges = (s: Selection, refs: EdgeRef[], mode: SelectMode = "replace"): Selection => ({
  ...s,
  edges: combine(s.edges, refs, mode, edgeKey),
  faces: [],
});

// ---------------------------------------------------------------- reading it back

export const isSelected = (s: Selection, id: NodeId): boolean => s.nodes.includes(id);
export const isFaceSelected = (s: Selection, f: FaceRef): boolean => s.faces.some((x) => faceKey(x) === faceKey(f));

/** the selected nodes, in tree order rather than click order, so an operation is reproducible */
export function selectedNodes(world: World, s: Selection): Node[] {
  const want = new Set(s.nodes);
  return [...walk(world)].filter((n) => want.has(n.id));
}

/** every solid the selection reaches, whether it was picked directly or through a group */
export function selectedBrushes(world: World, s: Selection): BrushNode[] {
  const out: BrushNode[] = [];
  for (const node of selectedNodes(world, s)) out.push(...brushesUnder(node));
  if (!out.length) for (const f of s.faces) {
    const node = nodeById(world, f.node);
    if (node?.kind === "brush" && !out.some((b) => b.id === node.id)) out.push(node);
  }
  return out;
}

/** the box the transform tools work in: everything selected, objects or faces */
export function selectionBounds(world: World, s: Selection): Bounds | undefined {
  let box = selectedNodes(world, s).reduce<Bounds | undefined>((acc, n) => union(acc, nodeBounds(n)), undefined);
  for (const f of s.faces) {
    const node = nodeById(world, f.node);
    if (node?.kind !== "brush") continue;
    const loop = node.brush.poly.faces[f.face]?.loop ?? [];
    for (const c of loop) {
      const v = node.brush.poly.vertices[c]!;
      box = union(box, { min: v, max: v });
    }
  }
  return box;
}

export const selectionCentre = (world: World, s: Selection): Vec3 | undefined => {
  const b = selectionBounds(world, s);
  return b && [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
};

/**
 * The selection with everything that no longer exists — or is no longer selectable — taken out. Run
 * after any edit, because a locked layer or a deleted solid must not leave a selection pointing at it.
 */
export function prune(world: World, s: Selection): Selection {
  const nodes = s.nodes.filter((id) => isSelectable(world, id));
  const faces = s.faces.filter((f) => {
    const node = nodeById(world, f.node);
    return isSelectable(world, f.node) && node?.kind === "brush" && f.face < node.brush.poly.faces.length;
  });
  const corners = (id: NodeId) => {
    const node = nodeById(world, id);
    return node?.kind === "brush" ? node.brush.poly.vertices.length : 0;
  };
  const vertices = s.vertices.filter((v) => v.vertex < corners(v.node) && isSelectable(world, v.node));
  const edges = s.edges.filter((e) => Math.max(e.a, e.b) < corners(e.node) && isSelectable(world, e.node));
  const unchanged =
    nodes.length === s.nodes.length && faces.length === s.faces.length &&
    vertices.length === s.vertices.length && edges.length === s.edges.length;
  return unchanged ? s : { nodes, faces, vertices, edges };
}
