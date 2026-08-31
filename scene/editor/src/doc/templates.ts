/**
 * Templates: the level read by kind rather than by place.
 *
 * TrenchBroom has "smart tags", configured per game in a JSON file: a name, a colour, a shortcut, and a
 * matcher that tests a brush's content flags or an object's classname. It is a good feature behind a
 * second configuration file, and this needs neither, because a tscene project has already said what
 * exists: `@template mesh.torch` declares the kind `torch`, and every node whose classes say `torch` is
 * one. Nothing is configured, and nothing can go stale.
 *
 * A template is about *things*, never about surfaces. An earlier version of this also read a `--water`
 * material as a kind that every face made of it carried, and that was two features wearing one word: a
 * style variable is not a template, "hiding" a face meant hiding the solid it belonged to, and the
 * material browser already answers "which faces are made of this" (see `facesUsing` in doc/inspect.ts).
 */
import type { NodeId, World } from "./document.ts";
import { childrenOf, nodeById, nodeTypeName, updateNode, type Node } from "./document.ts";
import { ANY_NODE, type Catalogue } from "./catalogue.ts";
import type { Editor } from "./editor.ts";
import { hideSelected, isolateSelected } from "./layers.ts";
import { selectNodes, type SelectMode, type Selection } from "./selection.ts";

export type Template = {
  name: string;
  /** the node type an instance is written as — `mesh` for `@template mesh.torch` */
  node?: string;
  colour?: number;
};

/** the kinds a project declares, which is its `@template`s and nothing else */
export const templatesOf = (catalogue: Catalogue): Template[] =>
  catalogue.objects.map((d) => ({
    name: d.name,
    node: d.node,
    ...(d.colour !== undefined ? { colour: d.colour } : {}),
  }));

export const templateByName = (templates: Template[], name: string): Template | undefined =>
  templates.find((t) => t.name === name);

/** a template's identity in a keyed list, which is its name */
export const key = (template: Template): string => template.name;

// ---------------------------------------------------------------- matching

/**
 * Whether a node is one of a kind.
 *
 * The class is what is tested, and the node type only narrows it: a `@template mesh.torch` matches meshes
 * called torch, while a template of no type matches anything called torch. It is the same rule
 * {@link defFor} follows, because a template and a definition are the same declaration read twice.
 */
export function hasTemplate(node: Node, template: Template): boolean {
  if (!node.classes.includes(template.name)) return false;
  if (!template.node || template.node === ANY_NODE) return true;
  return template.node === nodeTypeName(node);
}

/** every kind a node is, for the row of chips the inspector shows */
export const templatesFor = (node: Node, templates: Template[]): Template[] =>
  templates.filter((t) => hasTemplate(node, t));

// ---------------------------------------------------------------- finding

export function nodesWithTemplate(world: World, template: Template): NodeId[] {
  const out: NodeId[] = [];
  const walk = (node: Node): void => {
    if (hasTemplate(node, template)) out.push(node.id);
    for (const kid of childrenOf(node)) walk(kid);
  };
  for (const layer of world.layers) walk(layer);
  return out;
}

/** how many things are of each kind — the count beside a row, and the reason to show it at all */
export function templateCounts(world: World, templates: Template[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const template of templates) {
    const n = nodesWithTemplate(world, template).length;
    if (n) out.set(key(template), n);
  }
  return out;
}

// ---------------------------------------------------------------- acting on one

/** everything of a kind, selected */
export const selectByTemplate = (e: Editor, template: Template, mode: SelectMode = "replace"): Editor => ({
  ...e,
  selection: selectNodes(e.world, e.selection, nodesWithTemplate(e.world, template), mode, e.open),
});

/**
 * A filter, which is a kind selected and then isolated.
 *
 * Not a separate view state that the renderer, the picker and the outliner would each have to consult —
 * the editor already has one answer to "is this showing", and a second one that disagreed with it would
 * be a bug waiting for a designer to find. Isolating by kind also survives undo, which a view state
 * outside the document would not.
 */
export const isolateTemplate = (e: Editor, template: Template): Editor =>
  isolateSelected(selectByTemplate(e, template));

export const hideTemplate = (e: Editor, template: Template): Editor =>
  hideSelected(selectByTemplate(e, template));

// ---------------------------------------------------------------- putting one on

/** a kind written onto nodes, which means writing the class the template declared */
export function applyTemplate(world: World, ids: Iterable<NodeId>, template: Template): World {
  let out = world;
  for (const id of ids) {
    out = updateNode(out, id, (n) =>
      n.classes.includes(template.name) ? n : { ...n, classes: [...n.classes, template.name] });
  }
  return out;
}

/**
 * A kind renamed: everything that is one now says the new class.
 *
 * The declaration is the caller's other half — a `@template` renamed while the level still says `.button`
 * is a delete with extra steps — so the two go in one command. Matching is {@link hasTemplate}'s, which
 * is why a `.button` on a group is left alone by a rename of `mesh.button`: it was never an instance.
 */
export function renameClass(world: World, template: Template, to: string): World {
  let out = world;
  for (const id of nodesWithTemplate(world, template)) {
    out = updateNode(out, id, (n) => ({
      ...n,
      classes: [...new Set(n.classes.map((c) => (c === template.name ? to : c)))],
    }));
  }
  return out;
}

export function removeTemplate(world: World, ids: Iterable<NodeId>, template: Template): World {
  let out = world;
  for (const id of ids) {
    out = updateNode(out, id, (n) =>
      n.classes.includes(template.name) ? { ...n, classes: n.classes.filter((c) => c !== template.name) } : n);
  }
  return out;
}

/** the kinds every selected node is, and the ones only some of them are */
export function templatesOfSelection(
  world: World,
  selection: Selection,
  templates: Template[],
): { all: Template[]; some: Template[] } {
  const nodes = selection.nodes.map((id) => nodeById(world, id)).filter((n): n is Node => !!n);
  if (!nodes.length) return { all: [], some: [] };
  const all: Template[] = [];
  const some: Template[] = [];
  for (const template of templates) {
    const n = nodes.filter((node) => hasTemplate(node, template)).length;
    if (n === nodes.length) all.push(template);
    else if (n) some.push(template);
  }
  return { all, some };
}
