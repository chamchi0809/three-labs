/**
 * Tags: the questions a designer asks a map, answered by what the project already declares.
 *
 * TrenchBroom has "smart tags", configured per game in a JSON file: a name, a colour, a shortcut, and a
 * matcher that tests a brush's content flags or an entity's classname. It is a good feature behind a
 * second configuration file, and this needs neither, because a tscene project has already said what
 * exists. A `@template mesh.torch` declares the tag `torch`; a `--water` material declares the tag
 * `water`, which every face made of it carries. Nothing is configured, and nothing can go stale.
 *
 * A tag matches either **nodes** or **faces**, and which one it is decides what selecting by it selects.
 * That split is not cosmetic: `water` is a property of a surface, `trigger` is a property of a thing, and
 * an editor that conflated them would offer to select six faces of a solid the designer thinks of as one.
 */
import type { NodeId, World } from "./document.ts";
import { childrenOf, nodeById, updateNode, type Node } from "./document.ts";
import { ANY_NODE, type Catalogue } from "./catalogue.ts";
import type { Editor } from "./editor.ts";
import { hideSelected, isolateSelected } from "./layers.ts";
import { selectFaces, selectNodes, type FaceRef, type SelectMode, type Selection } from "./selection.ts";

export type Tag = {
  name: string;
  /** what carrying it means: a thing in the level, or a surface of one */
  on: "node" | "face";
  /** the node type an instance is written as, for a tag that came from a `@template` */
  node?: string;
  colour?: number;
};

/** the tags a project declares, which is its templates and its materials and nothing else */
export function tagsOf(catalogue: Catalogue): Tag[] {
  const out: Tag[] = catalogue.entities.map((d) => ({
    name: d.name,
    on: "node",
    node: d.node,
    ...(d.colour !== undefined ? { colour: d.colour } : {}),
  }));
  for (const m of catalogue.materials) {
    out.push({ name: m.name, on: "face", ...(m.colour !== undefined ? { colour: m.colour } : {}) });
  }
  return out;
}

export const tagByName = (tags: Tag[], name: string, on: Tag["on"]): Tag | undefined =>
  tags.find((t) => t.name === name && t.on === on);

// ---------------------------------------------------------------- matching

/**
 * Whether a node carries a node tag.
 *
 * The class is what is tested, and the node type only narrows it: a `@template mesh.torch` tags meshes
 * called torch, while a template of no type tags anything called torch. It is the same rule
 * {@link defFor} follows, because a tag and a definition are the same declaration read twice.
 */
export function hasTag(node: Node, tag: Tag): boolean {
  if (tag.on !== "node" || !node.classes.includes(tag.name)) return false;
  if (!tag.node || tag.node === ANY_NODE) return true;
  const type = node.kind === "entity" ? node.type : node.kind === "brush" ? "brush" : "group";
  return tag.node === type;
}

/** every tag a node carries, for the row of chips the inspector shows */
export const tagsFor = (node: Node, tags: Tag[]): Tag[] => tags.filter((t) => hasTag(node, t));

/** every tag a face carries, which for now is the one material it is made of */
export const tagsForFace = (world: World, ref: FaceRef, tags: Tag[]): Tag[] => {
  const material = materialAt(world, ref);
  return material ? tags.filter((t) => t.on === "face" && t.name === material) : [];
};

function materialAt(world: World, ref: FaceRef): string | undefined {
  const node = nodeById(world, ref.node);
  return node?.kind === "brush" ? node.brush.faces[ref.face]?.material : undefined;
}

// ---------------------------------------------------------------- finding

export function nodesWithTag(world: World, tag: Tag): NodeId[] {
  const out: NodeId[] = [];
  const walk = (node: Node): void => {
    if (hasTag(node, tag)) out.push(node.id);
    for (const kid of childrenOf(node)) walk(kid);
  };
  for (const layer of world.layers) walk(layer);
  return out;
}

export function facesWithTag(world: World, tag: Tag): FaceRef[] {
  const out: FaceRef[] = [];
  const walk = (node: Node): void => {
    if (node.kind === "brush") {
      node.brush.faces.forEach((f, face) => {
        if (f.material === tag.name) out.push({ node: node.id, face });
      });
    }
    for (const kid of childrenOf(node)) walk(kid);
  };
  for (const layer of world.layers) walk(layer);
  return out;
}

/** how many things carry each tag — the count beside a tag in the list, and the reason to show it at all */
export function tagCounts(world: World, tags: Tag[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const tag of tags) {
    const n = tag.on === "node" ? nodesWithTag(world, tag).length : facesWithTag(world, tag).length;
    if (n) out.set(key(tag), n);
  }
  return out;
}

export const key = (tag: Tag): string => `${tag.on}:${tag.name}`;

// ---------------------------------------------------------------- acting on one

/** everything carrying a tag, selected — nodes or faces, according to what the tag is about */
export function selectByTag(e: Editor, tag: Tag, mode: SelectMode = "replace"): Editor {
  const selection: Selection = tag.on === "node"
    ? selectNodes(e.world, e.selection, nodesWithTag(e.world, tag), mode, e.open)
    : selectFaces(e.world, e.selection, facesWithTag(e.world, tag), mode);
  return { ...e, selection };
}

/**
 * A filter, which is a tag selected and then isolated.
 *
 * Not a separate view state that the renderer, the picker and the outliner would each have to consult —
 * the editor already has one answer to "is this showing", and a second one that disagreed with it would
 * be a bug waiting for a designer to find. Isolating by tag also survives undo, which a view state
 * outside the document would not.
 */
export const isolateTag = (e: Editor, tag: Tag): Editor => isolateSelected(selectByTag(e, tag));

export const hideTag = (e: Editor, tag: Tag): Editor => hideSelected(selectByTag(e, tag));

// ---------------------------------------------------------------- putting one on

/** a node tag written onto nodes, which means writing the class the template declared */
export function tagNodes(world: World, ids: Iterable<NodeId>, tag: Tag): World {
  if (tag.on !== "node") return world;
  let out = world;
  for (const id of ids) {
    out = updateNode(out, id, (n) =>
      n.classes.includes(tag.name) ? n : { ...n, classes: [...n.classes, tag.name] });
  }
  return out;
}

export function untagNodes(world: World, ids: Iterable<NodeId>, tag: Tag): World {
  if (tag.on !== "node") return world;
  let out = world;
  for (const id of ids) {
    out = updateNode(out, id, (n) =>
      n.classes.includes(tag.name) ? { ...n, classes: n.classes.filter((c) => c !== tag.name) } : n);
  }
  return out;
}

/** the tags every selected node carries, and the ones only some of them do */
export function tagsOfSelection(world: World, selection: Selection, tags: Tag[]): { all: Tag[]; some: Tag[] } {
  const nodes = selection.nodes.map((id) => nodeById(world, id)).filter((n): n is Node => !!n);
  if (!nodes.length) return { all: [], some: [] };
  const all: Tag[] = [];
  const some: Tag[] = [];
  for (const tag of tags.filter((t) => t.on === "node")) {
    const n = nodes.filter((node) => hasTag(node, tag)).length;
    if (n === nodes.length) all.push(tag);
    else if (n) some.push(tag);
  }
  return { all, some };
}
