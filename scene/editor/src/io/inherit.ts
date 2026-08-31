/**
 * `@template` and `@override`: where a node's settings actually come from.
 *
 * A tscene node is not just its own body. A `.wall` on its head pastes a template's body in front, and an
 * `@override .enemy mesh { … }` rule appends a body behind, so what the runtime ends up with is three
 * layers deep and the order decides who wins: **template, then own, then override** — later members
 * overwrite earlier ones for the same name, which is `expand()`'s order and this file mirrors it exactly
 * rather than guessing at it.
 *
 * The editor needs this for two things, and they pull in opposite directions.
 *
 * - The inspector has to *show* the value the scene will have, whichever layer it came from, or a designer
 *   spends an afternoon wondering why a number they typed does nothing.
 * - The writer must only ever rewrite the node's own bytes, because a template's body is one range that a
 *   hundred nodes are reading and an override's body is one range that matched forty.
 *
 * So nothing here is merged into the document. It reports, in {@link Layer}s, where each setting comes
 * from and what it shadows, and it can build the derived children a designer needs to be able to see —
 * marked, through {@link copyOf}, as things the writer must not touch.
 */
import type { Compound, Member, Override, Pos, Template } from "tscene";
import {
  childrenOf, hasChildren, nodeTypeName, type Node, type NodeId, type World, walk,
} from "../doc/document.ts";
import { copyOf, type Derived } from "./origin.ts";
import { readNode, type ReadResult, type Sheets } from "./read.ts";

/** where a member came from, weakest first — the last one for a given name is the one that wins */
export type Layer = {
  from: "template" | "own" | "override";
  member: Member;
  /** what to call it in a sentence: `.wall`, `this node`, or the selector of the rule */
  label: string;
  file: string;
  /** the range to jump to when the designer asks to edit the thing it came from */
  at: Pos;
};

/** a `@template` reached through one of a node's `.class`es */
export type Applied = { name: string; file: string; statement: Template };
/** an `@override` rule whose selector matched */
export type Matched = { file: string; statement: Override };

export type Inheritance = {
  /** the templates each node's classes name, in the order they are applied */
  templates: Map<NodeId, Applied[]>;
  /** the rules that matched, in source order */
  overrides: Map<NodeId, Matched[]>;
  problems: string[];
};

// ---------------------------------------------------------------- selectors

/** what a selector's three parts are matched against — a node head, whatever kind of node it is */
export const headOfNode = (node: Node): { type: string; id?: string; classes: string[] } => ({
  type: nodeTypeName(node),
  id: node.sheetId,
  classes: node.classes,
});

export const fits = (c: Compound, node: Node): boolean => {
  const head = headOfNode(node);
  if (c.type && c.type !== head.type) return false;
  if (c.id && c.id !== head.id) return false;
  return c.classes.every((cls) => head.classes.includes(cls));
};

/** a descendant chain, read right to left: the last compound is the node, the rest are ancestors */
export function selects(selector: Compound[], chain: Node[]): boolean {
  if (!selector.length || !chain.length) return false;
  if (!fits(selector[selector.length - 1]!, chain[chain.length - 1]!)) return false;
  let i = selector.length - 2;
  for (let j = chain.length - 2; j >= 0 && i >= 0; j--) if (fits(selector[i]!, chain[j]!)) i--;
  return i < 0;
}

// ---------------------------------------------------------------- resolving

/**
 * Every node's templates and rules, in one pass.
 *
 * The implicit layer is skipped as an ancestor: it is the file, not a `group` a selector could ever have
 * been written against, so counting it would make `@override group brush` match things nobody nested.
 */
export function resolveInheritance(world: World, read: ReadResult): Inheritance {
  const templates = new Map<NodeId, Applied[]>();
  const overrides = new Map<NodeId, Matched[]>();
  const problems: string[] = [];

  const byName = new Map<string, { file: string; statement: Template }>();
  for (const t of read.templates) byName.set(t.statement.name, t);

  const chains = chainsOf(world);
  for (const [id, chain] of chains) {
    const node = chain[chain.length - 1]!;

    const mine: Applied[] = [];
    for (const cls of node.classes) {
      const found = byName.get(cls);
      if (!found) {
        problems.push(`unknown template .${cls}`);
        continue;
      }
      mine.push({ name: cls, ...found });
    }
    if (mine.length) templates.set(id, mine);

    const hits = read.overrides.filter((o) => selects(o.statement.selector, chain));
    if (hits.length) overrides.set(id, hits);
  }
  return { templates, overrides, problems };
}

/** every node with the ancestors a selector walks — the implicit layer left out, since it is the file */
export function chainsOf(world: World): Map<NodeId, Node[]> {
  const out = new Map<NodeId, Node[]>();
  const visit = (node: Node, chain: Node[]) => {
    const here = [...chain, node];
    out.set(node.id, here);
    for (const kid of childrenOf(node)) visit(kid, here);
  };
  for (const layer of world.layers) {
    if (layer.origin?.isFile) for (const kid of layer.children) visit(kid, []);
    else visit(layer, []);
  }
  return out;
}

// ---------------------------------------------------------------- what a node ends up with

/**
 * Every member that reaches a node, weakest first. Two entries with the same name are not a mistake —
 * they are the whole point, and the inspector shows the loser struck through.
 */
export function layersOf(node: Node, own: Member[], inh: Inheritance): Layer[] {
  const out: Layer[] = [];
  for (const t of inh.templates.get(node.id) ?? []) {
    for (const m of t.statement.body) {
      out.push({ from: "template", member: m, label: `.${t.name}`, file: t.file, at: t.statement });
    }
  }
  for (const m of own) out.push({ from: "own", member: m, label: "this node", file: node.origin?.file ?? "", at: node.origin?.span ?? m });
  for (const o of inh.overrides.get(node.id) ?? []) {
    const label = `@override ${o.statement.selector.map(compoundText).join(" ")}`;
    for (const m of o.statement.body) {
      out.push({ from: "override", member: m, label, file: o.file, at: o.statement });
    }
  }
  return out;
}

const compoundText = (c: Compound): string =>
  (c.type ?? "") + c.classes.map((x) => `.${x}`).join("") + (c.id ? `#${c.id}` : "");

/** the name a member is known by, which is what "the same setting, said twice" means */
export const nameOf = (m: Member): string | undefined =>
  m.kind === "prop" ? m.name : m.kind === "var" ? `--${m.name}` : m.kind === "at" ? `@${m.name}` : undefined;

/**
 * The settings a node actually ends up with, each with everything it shadows.
 *
 * Child nodes are not settings and are not here; several layers may each contribute children and they all
 * survive, which is exactly why a template can add a light to every torch.
 */
export function effective(layers: Layer[]): Map<string, { winner: Layer; shadowed: Layer[] }> {
  const out = new Map<string, { winner: Layer; shadowed: Layer[] }>();
  for (const layer of layers) {
    const name = nameOf(layer.member);
    if (name === undefined) continue;
    const seen = out.get(name);
    if (!seen) out.set(name, { winner: layer, shadowed: [] });
    else out.set(name, { winner: layer, shadowed: [...seen.shadowed, seen.winner] });
  }
  return out;
}

// ---------------------------------------------------------------- where an edit should go

export type Route = {
  /** the thing to change */
  target: "node" | "template" | "override";
  /** the sentence the editor puts in front of the designer */
  why: string;
  file?: string;
  at?: Pos;
  /** whether changing this would actually show, given who currently wins */
  effective: boolean;
};

/**
 * Where to write a change to one setting.
 *
 * Setting it on the node is offered first because it is the one edit that touches only this node — but
 * it is offered honestly: when an `@override` is winning, setting it here changes nothing anybody can
 * see, and saying so is the difference between a tool and a trap.
 */
export function routesFor(node: Node, name: string, layers: Layer[]): Route[] {
  const beats = effective(layers).get(name);
  const winner = beats?.winner;
  const out: Route[] = [
    {
      target: "node",
      why:
        winner?.from === "override"
          ? `set ${name} here — but ${winner.label} is applied after this node and would still win`
          : `set ${name} on this node`,
      file: node.origin?.file,
      at: node.origin?.span,
      effective: winner?.from !== "override",
    },
  ];
  for (const layer of layers) {
    if (layer.from === "own" || nameOf(layer.member) !== name) continue;
    out.push({
      target: layer.from,
      why: `change ${name} in ${layer.label}, which every node it reaches would feel`,
      file: layer.file,
      at: layer.at,
      effective: layer === winner,
    });
  }
  return out;
}

// ---------------------------------------------------------------- derived children

/**
 * The children a node's templates and rules contribute, as nodes a designer can see and click.
 *
 * They are marked derived, which is what stops the writer from touching them: one `@template` body is one
 * range that every node using it is reading, and the first edit written back there would silently change
 * every other node too.
 *
 * Ids are built from the host's, so re-deriving the view does not lose the selection.
 */
export function derivedChildren(node: Node, inh: Inheritance, sheets: Sheets): Node[] {
  const out: Node[] = [];
  const add = (m: Member, file: string, why: Derived, tag: string) => {
    if (m.kind !== "node") return;
    const text = sheets.get(file)?.text ?? "";
    const kid = readNode(m.object, file, text);
    out.push(mark(kid, why, node.id, `${node.id}~${tag}${out.length}`));
  };
  for (const t of inh.templates.get(node.id) ?? []) {
    for (const m of t.statement.body) add(m, t.file, "template", `t`);
  }
  for (const o of inh.overrides.get(node.id) ?? []) {
    for (const m of o.statement.body) add(m, o.file, "override", `o`);
  }
  return out;
}

function mark(node: Node, why: Derived, of: NodeId, id: NodeId): Node {
  const marked = {
    ...node,
    id,
    origin: node.origin ? copyOf(node.origin, why, of) : undefined,
  } as Node;
  if (!hasChildren(marked)) return marked;
  return { ...marked, children: marked.children.map((k, i) => mark(k, why, of, `${id}.${i}`)) };
}

/** every derived node in a world, for the check that none of them ever reaches the writer */
export function derivedIds(world: World): NodeId[] {
  const out: NodeId[] = [];
  for (const node of walk(world)) if (node.origin?.derived) out.push(node.id);
  return out;
}
