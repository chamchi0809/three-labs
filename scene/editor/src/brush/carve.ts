/**
 * CSG on *brushes* rather than on bare solids.
 *
 * The kernel in `csg.ts` works in half-spaces and knows nothing about materials. It carries one number per
 * face — `source` — and leaves it to the caller to say what that number means. This file is what says it:
 * the operands' faces are laid end to end into one numbering, the kernel is run over solids renumbered to
 * match, and `settle` reads the attributes back off the far end. That is how a doorway carved with a
 * textured brush comes out with the doorway's material on the inside of the hole and the wall's on the
 * outside — the two operands' faces never share a number, so neither can be mistaken for the other.
 *
 * Every operation reports "nothing happened" as `undefined`, distinct from "everything went away", which
 * is an empty list. A brush swallowed whole by its cutter *has* been changed; a brush the cutter missed has
 * not, and the difference is an undo entry that should not exist.
 */
import { faceAttributes, settle, type Brush, type FaceAttributes } from "./brush.ts";
import {
  hollow as hollowPoly, intersect as intersectPolys, keepSolid, merge as mergePolys,
  subtract as subtractPolys,
} from "./csg.ts";
import type { PolyFace, Polyhedron } from "./polyhedron.ts";

/** solids that came out of an operation, and the reasons any fragment was thrown away */
export type Carved = { brushes: Brush[]; dropped: string[] };

/**
 * The operands' faces in one numbering, as something `settle` can inherit from.
 *
 * `settle` wants a brush: it looks attributes up by `source`, and falls back to the face whose normal is
 * closest for anything the kernel invented. Both of those need `poly.faces[i]` and `faces[i]` to be the
 * same face, so the palette is a brush with no vertices — a list of planes and a list of attributes, which
 * is the whole of what is read. `base[k]` is where operand `k`'s faces start in it.
 *
 * Every brush in the document is canonical, so `poly.faces[i].source === i`; that is what lets an operand
 * be renumbered by adding a single offset rather than being rewritten face by face.
 */
type Palette = { brush: Brush; base: number[] };

function paletteOf(parts: Brush[]): Palette {
  const faces: FaceAttributes[] = [];
  const planes: PolyFace[] = [];
  const base: number[] = [];
  for (const part of parts) {
    base.push(faces.length);
    for (const [i, face] of part.poly.faces.entries()) {
      planes.push({ plane: face.plane, loop: [], source: planes.length });
      faces.push(part.faces[i] ?? faceAttributes());
    }
  }
  return { brush: { poly: { vertices: [], faces: planes }, faces }, base };
}

/** a solid whose faces answer to the palette's numbering; the same object back when there is nothing to do */
const renumbered = (poly: Polyhedron, by: number): Polyhedron =>
  by === 0 ? poly : { ...poly, faces: poly.faces.map((f) => ({ ...f, source: f.source + by })) };

/**
 * `target` with `cutter` taken out of it, or `undefined` if the cutter missed.
 *
 * The kernel hands the target straight back when the two do not overlap, and it is the *same object*, which
 * is what "missed" is read off here — cheaper and more honest than comparing volumes.
 */
export function carve(target: Brush, cutter: Brush): Carved | undefined {
  const { brush: palette, base } = paletteOf([target, cutter]);
  const from = renumbered(target.poly, base[0]!);
  const parts = subtractPolys(from, renumbered(cutter.poly, base[1]!));
  if (parts.length === 1 && parts[0] === from) return undefined;
  const { kept, dropped } = keepSolid(parts);
  return { brushes: kept.map((p) => settle(palette, p)), dropped };
}

/**
 * The solid every one of these encloses, or the reason there is not one.
 *
 * Folded pairwise rather than built from all the planes at once, because a fold gives up as soon as two of
 * them miss and reports it, where one big `build` would only ever say "empty".
 */
export function common(brushes: Brush[]): { brush?: Brush; problem?: string } {
  if (brushes.length < 2) return { problem: "an intersection needs two solids or more" };
  const { brush: palette, base } = paletteOf(brushes);
  let poly: Polyhedron | undefined = renumbered(brushes[0]!.poly, base[0]!);
  for (let i = 1; i < brushes.length && poly; i++) {
    poly = intersectPolys(poly, renumbered(brushes[i]!.poly, base[i]!), 0);
  }
  return poly ? { brush: settle(palette, poly) } : { problem: "those solids share no volume" };
}

/**
 * The convex hull of several brushes. `exact` is false when the hull enclosed volume nobody drew — two
 * boxes meeting at a corner come back with the corner filled in, and a designer has to be told.
 */
export function hull(brushes: Brush[]): { brush?: Brush; exact: boolean } {
  if (brushes.length < 2) return { exact: false };
  const { brush: palette, base } = paletteOf(brushes);
  const { poly, exact } = mergePolys(brushes.map((b, i) => renumbered(b.poly, base[i]!)), 0);
  return poly ? { brush: settle(palette, poly), exact } : { exact: false };
}

/**
 * A brush turned into a shell `thickness` metres thick, or `undefined` when it is too small to have a
 * cavity — a wall thicker than the room is a wall, not an error.
 *
 * No palette here: the cavity is the brush's own faces pushed inward, so it carries the brush's own
 * numbering, and every wall of the shell comes out with the material of the face it was cut from. That is
 * the answer a designer wants — hollowing a stone box gives a stone room, inside and out.
 */
export function shell(brush: Brush, thickness: number): Carved | undefined {
  const parts = hollowPoly(brush.poly, thickness);
  if (parts.length === 1 && parts[0] === brush.poly) return undefined;
  const { kept, dropped } = keepSolid(parts);
  return { brushes: kept.map((p) => settle(brush, p)), dropped };
}
