/**
 * CSG as a document edit.
 *
 * `brush/carve.ts` knows how to cut one solid with another. This is the part that knows what a *selection*
 * means: which solids are the knife and which are the wood, where the fragments go in the tree, what keeps
 * its identity and what gets a new one.
 *
 * The rule about identity is the one that matters for round-tripping. A carved solid **keeps its node** —
 * its id, its `#id`, and the place in the file it was read from — so the writer patches the faces it
 * already wrote instead of deleting a solid and adding a stranger. The extra fragments are new solids and
 * are written as such: fresh ids, no `#id` (two nodes answering to `#door` is a sheet that reads back
 * wrong) and no origin, but the layer, group, `.classes` and properties of the solid they came out of,
 * because a wall cut into three pieces is three pieces of the same wall.
 *
 * Every operation either edits or **declines with a reason**. Declining returns the string rather than an
 * editor, so the caller can say why in the status line without putting an undo entry on the stack for an
 * edit that never happened.
 */
import { carve, common, hull, shell } from "../brush/carve.ts";
import type { Brush } from "../brush/brush.ts";
import { gridSize, type Editor } from "./editor.ts";
import {
  boundsOverlap, brushNode, insertNodes, isHidden, isLocked, nodeBounds, parents, removeNodes,
  replaceNode, walk, type BrushNode, type NodeId, type World,
} from "./document.ts";
import { NOTHING, selectedBrushes } from "./selection.ts";

/** an edit, or the reason there was none — a refusal a designer can read rather than a silent no-op */
export type Attempt = Editor | string;

// ---------------------------------------------------------------- putting fragments back in the tree

/** where each node lives, so a fragment lands in the group its parent was in rather than at the top */
type Owners = ReturnType<typeof parents>;

/**
 * One solid replaced by the pieces it became.
 *
 * The first piece keeps the node — see the note about identity above. Nothing left means the solid was
 * swallowed, which is a legitimate result of a subtraction and not a failure.
 */
function rebuild(world: World, owners: Owners, node: BrushNode, pieces: Brush[], made: NodeId[]): World {
  const [first, ...rest] = pieces;
  if (!first) return replaceNode(world, node.id, undefined);
  let out = replaceNode(world, node.id, { ...node, brush: first });
  made.push(node.id);
  if (!rest.length) return out;
  const extra = rest.map((brush) =>
    brushNode(brush, { props: node.props, classes: node.classes, broom: node.broom }),
  );
  out = insertNodes(out, owners.get(node.id) ?? out.layers[0]!.id, extra);
  made.push(...extra.map((n) => n.id));
  return out;
}

/** what the status line says about fragments the kernel produced and then refused to vouch for */
const withDropped = (note: string, dropped: string[]): string =>
  dropped.length ? `${note} — ${dropped.length} fragment(s) dropped` : note;

// ---------------------------------------------------------------- subtract

/**
 * The selected solids cut out of every other solid they overlap, and then deleted.
 *
 * The selection is the knife: that is TrenchBroom's reading and it is the one that matches how the gesture
 * is made — a designer draws a box across a doorway, sees it, and wants the wall to have a hole in it, not
 * to have to select the wall as well and remember which of the two is which.
 *
 * Locked and hidden solids are not cut. A brush you cannot see is a brush you did not mean to reshape, and
 * one that is locked has been said so about explicitly.
 */
export function subtractSelection(e: Editor): Attempt {
  const cutters = selectedBrushes(e.world, e.selection);
  if (!cutters.length) return "select the solids to cut with";
  const cutting = new Set(cutters.map((n) => n.id));
  const owners = parents(e.world);
  const dropped: string[] = [];
  const made: NodeId[] = [];
  let world = e.world;
  let carved = 0;

  for (const node of walk(e.world)) {
    if (node.kind !== "brush" || cutting.has(node.id)) continue;
    if (isLocked(e.world, node.id) || isHidden(e.world, node.id)) continue;
    const box = nodeBounds(node);

    let pieces: Brush[] = [node.brush];
    let touched = false;
    for (const cutter of cutters) {
      // the boxes are the cheap half of the test, and a map is mostly solids nowhere near the cutter
      const cutBox = nodeBounds(cutter);
      if (box && cutBox && !boundsOverlap(box, cutBox)) continue;
      const next: Brush[] = [];
      for (const piece of pieces) {
        const result = carve(piece, cutter.brush);
        if (!result) {
          next.push(piece);
          continue;
        }
        touched = true;
        next.push(...result.brushes);
        dropped.push(...result.dropped);
      }
      pieces = next;
      if (!pieces.length) break;
    }

    if (!touched) continue;
    carved++;
    world = rebuild(world, owners, node, pieces, made);
  }

  if (!carved) return "the selection overlaps nothing to cut";
  world = removeNodes(world, cutting);
  return { ...e, world, selection: { ...NOTHING, nodes: made }, note: withDropped(`carved ${carved}`, dropped) };
}

// ---------------------------------------------------------------- intersect

/** the selection replaced by the one solid all of them share */
export function intersectSelection(e: Editor): Attempt {
  const nodes = selectedBrushes(e.world, e.selection);
  if (nodes.length < 2) return "select two solids or more to intersect";
  const { brush, problem } = common(nodes.map((n) => n.brush));
  if (!brush) return problem ?? "those solids share no volume";
  return replaceAll(e, nodes, brush, `intersected ${nodes.length}`);
}

// ---------------------------------------------------------------- merge

/**
 * The selection replaced by its convex hull.
 *
 * Only a convex solid is a brush, so this is the one operation that can hand back more than it was given.
 * When it does, the note says so — silently adding solid to a level is how a designer ends up wondering
 * why the corridor they built has a wall across it.
 */
export function mergeSelection(e: Editor): Attempt {
  const nodes = selectedBrushes(e.world, e.selection);
  if (nodes.length < 2) return "select two solids or more to merge";
  const { brush, exact } = hull(nodes.map((n) => n.brush));
  if (!brush) return "those solids do not make a solid together";
  const note = exact ? `merged ${nodes.length}` : `merged ${nodes.length} — the hull filled in space between them`;
  return replaceAll(e, nodes, brush, note);
}

/** several solids collapsed into one, which keeps the first one's node and drops the rest */
function replaceAll(e: Editor, nodes: BrushNode[], brush: Brush, note: string): Editor {
  const first = nodes[0]!;
  const world = removeNodes(replaceNode(e.world, first.id, { ...first, brush }), nodes.slice(1).map((n) => n.id));
  return { ...e, world, selection: { ...NOTHING, nodes: [first.id] }, note };
}

// ---------------------------------------------------------------- hollow

/**
 * Every selected solid turned into a shell one grid cell thick.
 *
 * The grid is the thickness because the grid is the size a designer is already working in — a room
 * hollowed at 25 cm has 25 cm walls, and the next thing they do is snap something to those walls.
 */
export function hollowSelection(e: Editor): Attempt {
  const nodes = selectedBrushes(e.world, e.selection);
  if (!nodes.length) return "select the solids to hollow";
  const owners = parents(e.world);
  const dropped: string[] = [];
  const made: NodeId[] = [];
  let world = e.world;
  let done = 0;

  for (const node of nodes) {
    const result = shell(node.brush, gridSize(e));
    if (!result) continue;
    done++;
    dropped.push(...result.dropped);
    world = rebuild(world, owners, node, result.brushes, made);
  }

  if (!done) return "nothing selected is thick enough to hollow at this grid size";
  return { ...e, world, selection: { ...NOTHING, nodes: made }, note: withDropped(`hollowed ${done}`, dropped) };
}
