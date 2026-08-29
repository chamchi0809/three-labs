/**
 * Layers, and the two flags that decide what a designer can see and touch.
 *
 * A layer is the top of the tree and the unit a whole floor of a building gets hidden by. It is also the
 * only node that cannot be nested, which is what makes "which layer is this on" answerable by looking at
 * the first name in the path rather than by searching.
 *
 * `hidden` and `locked` live on every node, not just on layers, and they are **inherited**: a node inside
 * a hidden group is hidden whether or not it says so itself. That is why hiding is written here as a flag
 * on the outermost thing rather than as a set of ids — a set would have to be recomputed every time
 * something moved, and the flag simply travels with the node that carries it.
 */
import {
  childrenOf, DEFAULT_LAYER, hasChildren, isHidden, layerNode, moveNodes, nodeById,
  updateNode, type LayerNode, type Node, type NodeId, type World,
} from "./document.ts";
import { settleEditor, type Editor } from "./editor.ts";
import { NOTHING, selectedNodes } from "./selection.ts";

// ---------------------------------------------------------------- the layer list

/** a layer name nobody is using; two layers called "Ground" would make the sheet ambiguous to read */
export function freshLayerName(world: World, stem = "Layer"): string {
  const taken = new Set(world.layers.map((l) => l.name));
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}`)) return `${stem} ${n}`;
}

export function addLayer(world: World, name?: string): { world: World; layer: LayerNode } {
  const layer = layerNode(name ?? freshLayerName(world));
  return { world: { ...world, layers: [...world.layers, layer] }, layer };
}

/**
 * A layer removed, and its contents kept.
 *
 * Deleting a layer deletes what a designer would call a floor, and the mistake is unrecoverable in the
 * one case they meant to keep the geometry — so the children go to the layer below rather than away. The
 * last layer cannot go at all: a world with no layer has nowhere to put the next solid.
 */
export function removeLayer(world: World, id: NodeId): World {
  if (world.layers.length < 2) return world;
  const at = world.layers.findIndex((l) => l.id === id);
  if (at < 0) return world;
  const going = world.layers[at]!;
  const home = world.layers[at === 0 ? 1 : at - 1]!;
  const layers = world.layers
    .filter((l) => l.id !== id)
    .map((l) => (l.id === home.id ? { ...l, children: [...l.children, ...going.children] } : l));
  return { ...world, layers };
}

export const renameLayer = (world: World, id: NodeId, name: string): World =>
  updateNode<LayerNode>(world, id, (l) => ({ ...l, name: name.trim() || l.name }));

/** the layers in the order they are drawn and listed; the first one is where a lost node goes */
export const defaultLayer = (world: World): LayerNode =>
  world.layers.find((l) => l.name === DEFAULT_LAYER) ?? world.layers[0]!;

/** the selection moved onto a layer, which is how a designer sorts a level after building it */
export function moveToLayer(e: Editor, layer: NodeId): Editor {
  const ids = selectedNodes(e.world, e.selection).map((n) => n.id);
  if (!ids.length || nodeById(e.world, layer)?.kind !== "layer") return e;
  return settleEditor({ ...e, world: moveNodes(e.world, ids, layer) });
}

// ---------------------------------------------------------------- seeing and touching

const setFlag = (world: World, id: NodeId, key: "hidden" | "locked", to: boolean): World =>
  updateNode(world, id, (n) => ({
    ...n,
    broom: to ? { ...n.broom, [key]: true } : without(n.broom, key),
  }));

const without = (broom: Node["broom"], key: "hidden" | "locked"): Node["broom"] => {
  const out = { ...broom };
  delete out[key];
  return out;
};

export const setHidden = (world: World, id: NodeId, to: boolean): World => setFlag(world, id, "hidden", to);
export const setLocked = (world: World, id: NodeId, to: boolean): World => setFlag(world, id, "locked", to);

export const toggleHidden = (world: World, id: NodeId): World =>
  setHidden(world, id, nodeById(world, id)?.broom.hidden !== true);

export const toggleLocked = (world: World, id: NodeId): World =>
  setLocked(world, id, nodeById(world, id)?.broom.locked !== true);

/** every node under and including `from`, flag cleared — how "show all" and "unlock all" are one function */
function clearAll(world: World, key: "hidden" | "locked"): World {
  const strip = (node: Node): Node => {
    const broom = node.broom[key] === undefined ? node.broom : without(node.broom, key);
    const kids = childrenOf(node).map(strip);
    const same = broom === node.broom && kids.every((k, i) => k === childrenOf(node)[i]);
    if (same) return node;
    return hasChildren(node) ? ({ ...node, broom, children: kids } as Node) : ({ ...node, broom } as Node);
  };
  return { ...world, layers: world.layers.map((l) => strip(l) as LayerNode) };
}

export const showAll = (world: World): World => clearAll(world, "hidden");
export const unlockAll = (world: World): World => clearAll(world, "locked");

/** the selection hidden, which also means it stops being the selection — you cannot edit what you cannot see */
export function hideSelected(e: Editor): Editor {
  const ids = selectedNodes(e.world, e.selection).map((n) => n.id);
  if (!ids.length) return e;
  let world = e.world;
  for (const id of ids) world = setHidden(world, id, true);
  return { ...e, world, selection: NOTHING };
}

export function lockSelected(e: Editor): Editor {
  const ids = selectedNodes(e.world, e.selection).map((n) => n.id);
  if (!ids.length) return e;
  let world = e.world;
  for (const id of ids) world = setLocked(world, id, true);
  return { ...e, world, selection: NOTHING };
}

/**
 * Everything except the selection hidden.
 *
 * The flag goes on the outermost node that holds nothing selected, so isolating one solid in a large map
 * writes a handful of flags rather than one per node — and unhiding that one group brings its whole
 * subtree back at once, which is what a designer expects when they click the eye again.
 *
 * It starts from a clean slate rather than adding to what is already hidden, because isolate is a view
 * rather than an accumulating edit, and two isolates in a row should show the second thing.
 */
export function isolateSelected(e: Editor): Editor {
  const wanted = new Set(selectedNodes(e.world, e.selection).map((n) => n.id));
  if (!wanted.size) return e;

  const keeps = (node: Node): boolean => wanted.has(node.id) || childrenOf(node).some(keeps);
  const walk = (node: Node): Node => {
    if (wanted.has(node.id)) return node;
    if (!keeps(node)) return { ...node, broom: { ...node.broom, hidden: true } } as Node;
    return hasChildren(node) ? ({ ...node, children: node.children.map(walk) } as Node) : node;
  };

  const clean = showAll(e.world);
  return { ...e, world: { ...clean, layers: clean.layers.map((l) => walk(l) as LayerNode) } };
}

/** what the outliner needs: whether a node is off because of its own flag or because of one above it */
export const hiddenBecause = (world: World, id: NodeId): "self" | "parent" | undefined =>
  nodeById(world, id)?.broom.hidden === true ? "self" : isHidden(world, id) ? "parent" : undefined;
