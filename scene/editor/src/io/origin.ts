/**
 * Where a node in the tree came from, and whether the editor is allowed to write back to it.
 *
 * This is the whole basis of surgical editing. The editor does not own the file: a `.tscene` sheet is
 * hand-written as often as it is generated, and a save that reprinted the whole thing would throw away
 * the author's line breaks, their comments' placement, and every part of the language the editor has no
 * model for. So each node remembers the byte range it was parsed from and the members that range said,
 * and a save rewrites only the ranges whose meaning actually changed.
 *
 * Not everything in the tree is a thing in a file. A `@template` body and an `@override` rule are each
 * written once and reach many nodes; the children they contribute are in the tree because a designer has
 * to be able to see and click them, and they carry a {@link Derived} reason, which is what stops an edit
 * from being written to a range that several nodes are all claiming.
 *
 * `repeat(3) { … }` and `each()` are deliberately *not* on that list. The tree holds what the text holds —
 * one `repeat` node with its literal children — and multiplying it is the renderer's job. That keeps the
 * one thing a designer can select and the one thing a save can write back the same thing.
 */
import type { ObjectValue, Pos } from "tscene";
import type { NodeId } from "../doc/document.ts";

/**
 * Why a node is a copy rather than a thing in the text.
 *
 * - `template` — it is the body of a `@template`, reached through a `.class` on some node.
 * - `override` — it is the body of an `@override` rule, which matched this node among others.
 */
export type Derived = "template" | "override";

export type Origin = {
  /** the file it was written in — an `@import`ed node belongs to the file that wrote it, not the root */
  file: string;
  /** the node's whole range, from the first character of its head to its closing brace */
  span: Pos;
  /**
   * The braces of its body, when it has one. `open` is the `{` and `close` is the `}`, so an inserted
   * child goes at `close` and a body that was never opened has to be given one.
   */
  body?: { open: number; close: number };
  /**
   * The node exactly as the parser produced it — the baseline a save diffs against, head and body both.
   * Keeping it here rather than re-parsing at save time means the diff is against what was read, so two
   * saves in a row cannot fight over formatting the first one settled.
   *
   * Absent on the implicit layer, whose body is the file and whose members are the sheet's statements.
   */
  was?: ObjectValue;
  /**
   * This "node" is the file itself: the implicit layer a sheet's top-level nodes live on, so that a
   * plain three.js scene with no `group` in it still opens in an editor whose tree starts at a layer.
   * It has no head and no braces of its own — its body is the file — and a save writes its children at
   * the top level rather than inside anything.
   */
  isFile?: true;
  /** why the editor may not write here, if it may not */
  derived?: Derived;
  /** the node this one was copied from, when it is a copy of a node that is in the text */
  of?: NodeId;
};

/** whether an edit to this node can be written back at all */
export const isWritable = (origin: Origin | undefined): boolean => !origin?.derived;

/** the sentence to put in front of a designer who edited a copy */
export function whyReadOnly(origin: Origin | undefined): string | undefined {
  switch (origin?.derived) {
    case "template": return "this comes from a @template; edit the template, or override it here";
    case "override": return "this comes from an @override rule; edit the rule, or set it on the node";
    default: return undefined;
  }
}

/** a range with nothing in it, for a node that has never been in a file */
export const NO_SPAN: Pos = { start: 0, end: 0 };

export const originOf = (file: string, span: Pos, was: ObjectValue, over: Partial<Origin> = {}): Origin => ({
  file, span, was, ...over,
});

/** the same origin marked as a copy — what an expansion hands to every instance after the first */
export const copyOf = (origin: Origin, derived: Derived, of?: NodeId): Origin => ({ ...origin, derived, of });

/** the origin of the implicit layer: the whole file, with the file's own end as its insertion point */
export const fileOrigin = (file: string, text: string): Origin => ({
  file,
  span: { start: 0, end: text.length, file },
  body: { open: 0, close: text.length },
  isFile: true,
});
