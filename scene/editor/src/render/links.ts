/**
 * The lines between entities that name each other.
 *
 * A door and the button that opens it are one mechanism and two nodes forty metres apart, and the only
 * thing tying them together in the file is a name. TrenchBroom draws that tie as a line in the viewport,
 * and it is the difference between debugging a map by reading it and debugging it by looking at it.
 *
 * Quake says this with `target` and `targetname`, which is a pair of strings and no checking at all.
 * tscene already has a better answer — `ref(#door)` is a reference the parser resolves and the checker
 * complains about — so links here come out of the values themselves rather than out of a naming
 * convention. Anything that refers to a node is a link, whatever the property is called.
 */
import type { Value } from "tscene";
import {
  childrenOf, walk, type Node, type NodeId, type World,
} from "../doc/document.ts";

export type Link = {
  from: NodeId;
  to: NodeId;
  /** the property that made the link, which is what a tooltip shows and what deleting one would edit */
  prop: string;
};

/**
 * Every link in the map.
 *
 * References are by `#id`, which is the designer's name for a node, so this needs a pass to build the
 * name index first. A reference to a name nothing has is dropped rather than reported — the checker
 * already says so, in the file, with a span, which is a better place to hear it than a viewport.
 */
export function linksOf(world: World): Link[] {
  const byName = new Map<string, NodeId>();
  for (const node of walk(world)) if (node.sheetId) byName.set(node.sheetId, node.id);

  const links: Link[] = [];
  for (const node of walk(world)) {
    for (const member of node.props) {
      if (member.kind !== "prop" && member.kind !== "var") continue;
      const name = member.kind === "prop" ? member.name : `--${member.name}`;
      for (const target of refsIn(member.value)) {
        const to = byName.get(target);
        // a node does not link to itself; that is a property with the node's own name in it, not a wire
        if (to && to !== node.id) links.push({ from: node.id, to, prop: name });
      }
    }
  }
  return links;
}

/** every `ref(#name)` inside a value, however deeply it is nested in arrays, records and calls */
export function* refsIn(value: Value): Generator<string> {
  switch (value.kind) {
    case "ref":
      yield value.name;
      return;
    case "array":
      for (const item of value.items) yield* refsIn(item);
      return;
    case "record":
      for (const entry of value.entries) yield* refsIn(entry.value);
      return;
    case "object":
      for (const arg of value.args) yield* refsIn(arg);
      for (const member of value.body) {
        if (member.kind === "prop" || member.kind === "var") yield* refsIn(member.value);
      }
      return;
    case "calc":
      yield* refsIn(value.left);
      yield* refsIn(value.right);
      return;
    case "fn":
      for (const arg of value.args) yield* refsIn(arg);
      return;
    case "each":
      yield* refsIn(value.over);
      yield* refsIn(value.body);
      return;
    case "read":
      yield* refsIn(value.target);
      return;
    case "call":
      yield* refsIn(value.target);
      for (const arg of value.args) yield* refsIn(arg);
      return;
    case "index":
      yield* refsIn(value.target);
      yield* refsIn(value.at);
      return;
    case "var":
      if (value.fallback) yield* refsIn(value.fallback);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------- where a link starts and ends

/**
 * The point a link is drawn to and from: the middle of whatever the node is.
 *
 * A solid has real geometry to take the middle of. An entity usually has a `position`, and one that does
 * not is wherever its children are — which is right for a group of solids acting as one mechanism and
 * harmless for anything else. A node with neither has no place on screen, so it has no link either.
 */
export function centreOf(node: Node, boundsOf: (id: NodeId) => { min: number[]; max: number[] } | undefined):
  [number, number, number] | undefined {
  const box = boundsOf(node.id);
  if (box && Number.isFinite(box.min[0])) {
    return [0, 1, 2].map((i) => (box.min[i]! + box.max[i]!) / 2) as [number, number, number];
  }

  const kids = childrenOf(node);
  if (!kids.length) return undefined;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const kid of kids) {
    const at = centreOf(kid, boundsOf);
    if (!at) continue;
    found = true;
    for (let i = 0; i < 3; i++) {
      if (at[i]! < min[i]!) min[i] = at[i]!;
      if (at[i]! > max[i]!) max[i] = at[i]!;
    }
  }
  return found ? ([0, 1, 2].map((i) => (min[i]! + max[i]!) / 2) as [number, number, number]) : undefined;
}

/**
 * Links as segments, with the ones touching the selection separated out.
 *
 * A map with a hundred links drawn all at once is a bowl of spaghetti nobody reads. Drawing the selected
 * entity's links brightly and the rest faintly is what makes the picture answer "what is this button
 * wired to" instead of "how complicated is this map".
 */
export function linkSegments(
  links: Link[],
  centre: (id: NodeId) => [number, number, number] | undefined,
  selected: ReadonlySet<NodeId> = new Set(),
): { near: Float32Array; far: Float32Array } {
  const near: number[] = [];
  const far: number[] = [];
  for (const link of links) {
    const a = centre(link.from);
    const b = centre(link.to);
    if (!a || !b) continue;
    const into = selected.has(link.from) || selected.has(link.to) ? near : far;
    into.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  return { near: new Float32Array(near), far: new Float32Array(far) };
}
