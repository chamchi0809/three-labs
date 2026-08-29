/**
 * Moving things.
 *
 * Every transform tool — move now, rotate and scale and shear in M9 — comes down to one matrix applied to
 * a set of nodes, so that is what this file is: one matrix, one set, and the three different meanings
 * "apply a matrix" has depending on what it lands on.
 *
 * A **solid** is transformed through the brush kernel, so that a mirroring matrix reverses the winding
 * rather than turning the solid inside out, and so that UV lock gets its chance to keep the material still
 * on the wall while the wall moves.
 *
 * An **entity** has no geometry to transform — it has a `position`, and that is what moves. Its children,
 * if it has any, move with it.
 *
 * A **group or layer** is not a thing at all, only a name over its children, so it passes the matrix down.
 *
 * The whole thing is all-or-nothing: if any solid in the set would be destroyed by the transform, none of
 * them move and the reasons come back instead. Half a selection moved is the state a designer cannot undo
 * their way out of in one step, and it is trivially avoided by not doing it.
 */
import type { Vec3 } from "tscene";
import { transformBrush, type Brush } from "../brush/brush.ts";
import { transformLocked } from "../brush/uv.ts";
import { IDENTITY, multiply, transformPoint, translation, type Mat4 } from "../brush/vec.ts";
import {
  childrenOf, hasChildren, replaceNode, type Node, type NodeId, type World,
} from "./document.ts";
import { setVec3, vec3Of } from "./props.ts";
import type { Selection } from "./selection.ts";

export type Transformed = { world: World; problems: string[] };

/** where a linked group stands after being moved: its old place in the set, then the move */
const placed = (m: Mat4, at: number[] | undefined): Mat4 =>
  multiply(m, at?.length === 12 ? (at as Mat4) : IDENTITY);

/** one solid moved, with the material either riding along or staying put on the wall */
export function transformBrushLocked(brush: Brush, m: Mat4, lockUv: boolean) {
  return lockUv ? transformLocked(brush, m) : transformBrush(brush, m);
}

/**
 * One node and everything under it. Returns nothing when the transform would destroy a solid, which the
 * caller turns into "the whole gesture is refused".
 */
export function transformNode(node: Node, m: Mat4, lockUv: boolean): { node?: Node; problems: string[] } {
  if (node.kind === "brush") {
    const edit = transformBrushLocked(node.brush, m, lockUv);
    return edit.brush ? { node: { ...node, brush: edit.brush }, problems: [] } : { problems: edit.problems };
  }

  const problems: string[] = [];
  const children: Node[] = [];
  for (const kid of childrenOf(node)) {
    const moved = transformNode(kid, m, lockUv);
    problems.push(...moved.problems);
    if (moved.node) children.push(moved.node);
  }
  if (problems.length) return { problems };

  if (node.kind !== "entity") {
    // a linked group that moves as a whole has moved *within its set*, and `at` is the record of where it
    // stands. Left behind, the next propagation would snap the copy back to where it was made
    const broom = node.broom.link === undefined ? node.broom : { ...node.broom, at: [...placed(m, node.broom.at)] };
    return { node: { ...node, broom, children }, problems: [] };
  }
  // an entity with no position is one that has never been placed; giving it one here would invent a
  // property the sheet never had, so it moves only its children and stays where it was written
  const at = vec3Of(node.props, "position");
  const props = at ? setVec3(node.props, "position", transformPoint(m, at)) : node.props;
  return { node: { ...node, props, children }, problems: [] };
}

/**
 * A set of nodes transformed together.
 *
 * The set is taken as given rather than expanded: the caller has already decided what "the selection"
 * means, and a node listed inside another node that is also listed would otherwise be moved twice.
 */
export function transformNodes(
  world: World, ids: Iterable<NodeId>, m: Mat4, lockUv = true,
): Transformed {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return { world, problems: [] };

  // everything is computed before anything is replaced, so a failure late in the set cannot leave the
  // ones before it already moved
  const moved: { id: NodeId; node: Node }[] = [];
  const problems: string[] = [];
  for (const id of wanted) {
    const node = find(world, id);
    if (!node) continue;
    const result = transformNode(node, m, lockUv);
    if (result.node) moved.push({ id, node: result.node });
    else problems.push(...result.problems);
  }
  if (problems.length) return { world, problems };

  let out = world;
  for (const { id, node } of moved) out = replaceNode(out, id, node);
  return { world: out, problems: [] };
}

/** the same, for the shape every tool actually holds */
export const transformSelection = (world: World, selection: Selection, m: Mat4, lockUv = true): Transformed =>
  transformNodes(world, selection.nodes, m, lockUv);

export const translateSelection = (world: World, selection: Selection, by: Vec3, lockUv = true): Transformed =>
  transformSelection(world, selection, translation(by), lockUv);

/**
 * A node by id, without walking the whole tree twice.
 *
 * `nodeById` exists and does this; it is repeated here only because a transform of fifty nodes would walk
 * the tree fifty times, and the set being transformed is almost always shallow and near the top.
 */
function find(world: World, id: NodeId): Node | undefined {
  const stack: Node[] = [...world.layers];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.id === id) return node;
    if (hasChildren(node)) stack.push(...node.children);
  }
  return undefined;
}
