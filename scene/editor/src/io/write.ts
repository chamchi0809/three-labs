/**
 * The world, written back into the files it was read from.
 *
 * The rule is one sentence long: **rewrite only what changed.** A save is a list of text edits against
 * the exact bytes that were read, not a reprint of the tree. A node nobody touched is not in the list at
 * all, so its formatting, its comments, its `calc()` and its hand-aligned columns come through a save the
 * way they came through a `cp`. That is what makes the editor safe to point at a file a person maintains.
 *
 * Everything is diffed by *meaning*, never by text. Both sides go through tscene's printer before they
 * are compared, so `vec3(0,1,0)` and `vec3( 0, 1, 0 )` are the same property and neither one provokes an
 * edit. The comparison is on the property, the face, the head — never on the file, because a whole-file
 * diff can only tell you that something changed, and what a surgical save needs to know is *where*.
 *
 * Three things this deliberately does not do.
 *
 * - **Reordering siblings is not written back.** Sibling order has no meaning at runtime, and expressing
 *   it would mean moving whole blocks of someone's file to record something nobody can see.
 * - **A derived node is never written.** A node the `@template` or `@override` machinery put in the tree
 *   has a range that several nodes are all claiming; see {@link Origin} and `inherit.ts`.
 * - **The implicit layer cannot carry anything of its own.** It is the file, not a `group` in it, so it
 *   has nowhere to put a `@broom` or a name. A save says so rather than dropping it silently.
 */
import type { Member, ObjectValue, Sheet } from "tscene";
import { childrenOf, type Node, type NodeId, type World } from "../doc/document.ts";
import { broomMember, faceMembers, headOf, ownMembers, rowMembers, toObject, worldBroom } from "./emit.ts";
import { printMember, printNode } from "./literal.ts";
import { materialEdits, type MaterialDrafts } from "./materials.ts";
import {
  applyEdits, dedent, deleteAt, indentAt, insertAt, lineRange, newlineOf, reindent, replaceAt, withComments,
  type TextEdit,
} from "./patch.ts";
import type { Origin } from "./origin.ts";

/** every file the world was read from, exactly as it was read */
export type Project = { root: string; sheets: Map<string, Sheet> };

export type WriteResult = {
  /** every file of the project, with the text it should now have — unchanged ones included */
  files: Map<string, string>;
  problems: string[];
};

type Ctx = {
  project: Project;
  edits: Map<string, TextEdit[]>;
  problems: string[];
};

const sink = (ctx: Ctx, file: string): TextEdit[] => {
  let list = ctx.edits.get(file);
  if (!list) ctx.edits.set(file, (list = []));
  return list;
};

const textOf = (ctx: Ctx, file: string): string | undefined => ctx.project.sheets.get(file)?.text;

/** whether this node's own bytes are in `file` and are its to rewrite */
const inPlace = (ctx: Ctx, node: Node, file: string): node is Node & { origin: Origin } =>
  !!node.origin && !node.origin.derived && node.origin.file === file && ctx.project.sheets.has(file);

// ---------------------------------------------------------------- the whole thing

export function writeWorld(world: World, project: Project, materials?: MaterialDrafts): WriteResult {
  const ctx: Ctx = { project, edits: new Map(), problems: [] };

  writeBroom(ctx, world);
  writeTopLevel(ctx, world);
  // the declarations, which are nobody's node: see `materials.ts` for why they are written apart
  if (materials?.size) {
    for (const [file, list] of materialEdits(project.sheets, project.root, materials)) sink(ctx, file).push(...list);
  }

  const files = new Map<string, string>();
  for (const [file, sheet] of project.sheets) {
    const list = ctx.edits.get(file);
    if (!list?.length) {
      files.set(file, sheet.text);
      continue;
    }
    const { text, problems } = applyEdits(sheet.text, list);
    files.set(file, text);
    for (const p of problems) ctx.problems.push(`${file}: ${p}`);
  }
  return { files, problems: ctx.problems };
}

/**
 * The world's `@broom { grid, scale }`. Written only when the file already says something about it or
 * the designer has moved off the defaults — a fresh sheet with a 25 cm grid says nothing, because that
 * is what a sheet with nothing in it means anyway.
 */
function writeBroom(ctx: Ctx, world: World) {
  const root = ctx.project.root;
  const sheet = ctx.project.sheets.get(root);
  if (!sheet) {
    ctx.problems.push(`the root file ${root} is not in the project`);
    return;
  }
  const was = sheet.statements.find(
    (s): s is Member & { kind: "at" } => s.kind === "at" && s.name === "broom",
  );
  const now = worldBroom(world, was);
  if (was) {
    if (printMember(was) !== printMember(now)) {
      sink(ctx, root).push(replaceAt(was.start, was.end, printMember(now), "@broom"));
    }
    return;
  }
  if (world.broom.grid === -2 && world.broom.scale === 1) return;
  const nl = newlineOf(sheet.text);
  sink(ctx, root).push(insertAt(0, printMember(now) + nl + (sheet.text.trim() ? nl : ""), "@broom"));
}

// ---------------------------------------------------------------- the top level

/**
 * Every file's top-level nodes, matched against the layers and the loose nodes the tree now has.
 *
 * The top level is the one place a "parent" spans several files: the implicit layer holds whatever the
 * root sheet and everything it imports wrote outside a `group`. So the diff runs per file, and a node
 * with nowhere to go — new, or moved out of a group — is appended to the file it came from, or to the
 * root when it came from nowhere.
 */
function writeTopLevel(ctx: Ctx, world: World) {
  const tops: Node[] = [];
  for (const layer of world.layers) {
    if (!layer.origin?.isFile) {
      tops.push(layer);
      continue;
    }
    if (broomMember(layer.broom) || layer.props.length) {
      ctx.problems.push(
        `the layer "${layer.name}" is the file itself and has nowhere to write its settings; ` +
          "make it a real group first",
      );
    }
    tops.push(...layer.children);
  }

  const homeless = new Set<NodeId>(tops.filter((n) => !n.origin?.derived).map((n) => n.id));

  for (const [file, sheet] of ctx.project.sheets) {
    const olds = sheet.statements.filter((s): s is Member & { kind: "node" } => s.kind === "node");
    const byStart = new Map(olds.map((m) => [m.object.start, m]));
    const claimed = new Set<number>();

    for (const node of tops) {
      if (!inPlace(ctx, node, file)) continue;
      if (!byStart.has(node.origin.span.start)) continue; // it was in this file, but not at its top level
      claimed.add(node.origin.span.start);
      homeless.delete(node.id);
      writeNode(ctx, node, sink(ctx, file));
    }

    for (const m of olds) {
      if (claimed.has(m.object.start)) continue;
      const cut = lineRange(sheet.text, withComments(sheet.text, m.start), m.end);
      sink(ctx, file).push(deleteAt(cut.start, cut.end, `${m.object.name} left the top level`));
    }
  }

  // whatever nobody claimed gets appended, grouped so that each file is touched once
  const appends = new Map<string, string[]>();
  for (const node of tops) {
    if (!homeless.has(node.id)) continue;
    const file = node.origin && ctx.project.sheets.has(node.origin.file) ? node.origin.file : ctx.project.root;
    (appends.get(file) ?? appends.set(file, []).get(file)!).push(renderNode(ctx, node));
  }
  for (const [file, blocks] of appends) {
    const text = textOf(ctx, file) ?? "";
    const nl = newlineOf(text);
    const at = text.replace(/\s+$/, "").length;
    sink(ctx, file).push(replaceAt(at, text.length, (at ? nl + nl : "") + blocks.join(nl + nl) + nl, "new nodes"));
  }
}

// ---------------------------------------------------------------- one node

/** the head a node would be written with, with no body — the string a save compares to decide */
const printHead = (o: ObjectValue): string => printNode({ ...o, hasBody: true, body: [] }).slice(0, -3);

/** what makes two members the same member: a property is `position`, whichever file it is in */
function keyOf(m: Member): string {
  switch (m.kind) {
    case "prop": return `p:${m.name}`;
    case "var": return `v:${m.name}`;
    case "at": return `a:${m.name}`;
    case "node": return `n:${m.start}`;
  }
}

const same = (a: Member, b: Member): boolean => a === b || printMember(a) === printMember(b);

/**
 * One node's edits, appended to `out`. The node is known to be in place: its bytes are in `out`'s file
 * and nothing else is claiming them.
 */
function writeNode(ctx: Ctx, node: Node & { origin: Origin }, out: TextEdit[]) {
  const origin = node.origin;
  const text = textOf(ctx, origin.file);
  const was = origin.was;
  if (text === undefined || !was) return;
  const nl = newlineOf(text);

  const members = ownMembers(node);
  const kids = childrenOf(node).filter((k) => !k.origin?.derived);
  // a solid and a patch always want a body: their geometry lives in one, and neither has any other place
  // to put it. Everything else wants one only when it has something to say
  const own = node.kind === "brush" || node.kind === "patch";
  const wants = members.length > 0 || kids.length > 0 || own;

  // a node written without braces that now has something to put in them is reprinted whole; there is no
  // range to patch, and inventing one would mean writing the head twice
  if (!origin.body) {
    if (!wants) return;
    const printed = reindent(printNode(toObject(node)), indentAt(text, origin.span.start));
    // the `;` that ended it belongs to the statement, not to the node, and a body does not want one
    let end = origin.span.end;
    while (text[end] === " " || text[end] === "\t") end++;
    if (text[end] === ";") end++;
    else end = origin.span.end;
    out.push(replaceAt(origin.span.start, end, printed, "a body was added"));
    return;
  }

  const nowHead = printHead(headOf(node));
  if (nowHead !== printHead(was)) {
    out.push(replaceAt(origin.span.start, origin.body.open, nowHead + " ", `the head of ${nowHead}`));
  }

  // -------- the node's own members
  const olds = new Map<string, Member>();
  for (const m of was.body) {
    if (isGeometry(node, m)) continue; // part of the shape itself, diffed below
    olds.set(keyOf(m), m);
  }

  /** new settings, which belong above whatever is nested in the body */
  const freshOwn: string[] = [];
  /** new children and faces, which belong at the end of it */
  const fresh: string[] = [];
  for (const m of members) {
    const old = olds.get(keyOf(m));
    if (!old) {
      freshOwn.push(printMember(m));
      continue;
    }
    olds.delete(keyOf(m));
    if (same(old, m)) continue;
    out.push(replaceAt(old.start, old.end, reindent(printMember(m), indentAt(text, old.start)), keyOf(m)));
  }

  let notBefore = 0;
  const drop = (m: Member, why: string) => {
    const cut = lineRange(text, withComments(text, m.start), m.end);
    out.push(deleteAt(cut.start, cut.end, why));
    notBefore = Math.max(notBefore, cut.end);
  };
  for (const left of olds.values()) {
    if (left.kind === "node") continue; // a child, not a setting — the child diff below owns it
    drop(left, `${keyOf(left)} was unset`);
  }

  // -------- the faces of a solid or the rows of a patch, or the children of everything else
  if (own) {
    const what = node.kind === "brush" ? "face" : "row";
    const olderParts = was.body.filter((m) => isGeometry(node, m));
    const nowParts = node.kind === "brush" ? faceMembers(node.brush) : rowMembers(node.patch);
    if (olderParts.length === nowParts.length) {
      for (const [i, old] of olderParts.entries()) {
        const now = nowParts[i]!;
        if (same(old, now)) continue;
        out.push(replaceAt(old.start, old.end, reindent(printMember(now), indentAt(text, old.start)), `${what} ${i}`));
      }
    } else {
      // a different number of parts than it was written with, so part `i` is not part `i` — a solid that
      // grew a side, a patch that had a row inserted. Rewriting the lot is the only honest answer
      for (const old of olderParts) drop(old, node.kind === "brush" ? "the solid was reshaped" : "the grid was resized");
      fresh.push(...nowParts.map(printMember));
    }
  } else {
    const olderKids = was.body.filter((m): m is Member & { kind: "node" } => m.kind === "node");
    const byStart = new Map(olderKids.map((m) => [m.object.start, m]));
    const claimed = new Set<number>();
    for (const kid of kids) {
      if (inPlace(ctx, kid, origin.file) && byStart.has(kid.origin.span.start)) {
        claimed.add(kid.origin.span.start);
        writeNode(ctx, kid, out);
      } else fresh.push(renderNode(ctx, kid));
    }
    for (const m of olderKids) {
      if (!claimed.has(m.object.start)) drop(m, `${m.object.name} left ${nowHead}`);
    }
  }

  // settings go above whatever is nested, which is the order every hand-written sheet is in
  const nested = was.body.find((m) => m.kind === "node");
  const ceiling = nested ? text.lastIndexOf("\n", nested.start - 1) + 1 : undefined;
  if (freshOwn.length) out.push(insertInBody(text, origin, freshOwn, nl, notBefore, ceiling));
  if (fresh.length) out.push(insertInBody(text, origin, fresh, nl, notBefore));
}

/** the members that *are* the shape rather than settings on it: a solid's faces, a patch's rows */
const isGeometry = (node: Node, m: Member): boolean =>
  m.kind === "node" &&
  ((node.kind === "brush" && m.object.name === "face") || (node.kind === "patch" && m.object.name === "row"));

/**
 * New members put inside a body: at the end of it, or — for a node's own settings — on the line the first
 * nested thing starts on, so that what a node *is* still reads before what is inside it.
 *
 * Within each of those two places they go in the order they were given rather than beside their kind,
 * because grouping them would mean deciding where a sheet's author *would* have put them, and a save that
 * shuffles a file is a save nobody trusts twice.
 */
function insertInBody(
  text: string, origin: Origin, blocks: string[], nl: string, notBefore: number, ceiling?: number,
): TextEdit {
  const { open, close } = origin.body!;
  const indent = indentAt(text, open);
  const inner = indent + "  ";

  if (ceiling !== undefined && ceiling > notBefore && ceiling > open) {
    const above = blocks.map((b) => inner + reindent(b, inner) + nl).join("");
    return insertAt(ceiling, above, "new settings");
  }

  const gap = text.slice(open + 1, close);
  const written = blocks.map((b) => nl + inner + reindent(b, inner)).join("");

  // an empty body is opened out onto its own lines; anything else keeps the shape it already had
  if (!notBefore && !gap.trim()) return replaceAt(open + 1, close, written + nl + indent, "new members");

  const after = open + 1 + gap.replace(/\s+$/, "").length;
  return insertAt(Math.min(Math.max(notBefore, after), close), written, "new members");
}

// ---------------------------------------------------------------- moving a node

/**
 * A node as text, for somewhere it has not been before.
 *
 * A node that came from a file is *sliced* out of it and patched, rather than reprinted, so that a solid
 * dragged into a group takes its comments and its formatting with it. Only a node the editor invented
 * has to be printed, and it has nothing to lose.
 */
function renderNode(ctx: Ctx, node: Node): string {
  const origin = node.origin;
  const text = origin ? textOf(ctx, origin.file) : undefined;
  if (!origin || origin.derived || origin.isFile || !origin.was || text === undefined) {
    return printNode(toObject(node));
  }
  const local: TextEdit[] = [];
  writeNode(ctx, node as Node & { origin: Origin }, local);
  // from the comment above it, so that what a designer wrote about this node moves with the node
  const from = withComments(text, origin.span.start);
  const slice = text.slice(from, origin.span.end);
  const shifted = local.map((e) => ({ ...e, start: e.start - from, end: e.end - from }));
  const { text: out, problems } = applyEdits(slice, shifted);
  for (const p of problems) ctx.problems.push(`${origin.file}: moving ${printHead(origin.was)}: ${p}`);
  return dedent(out, indentAt(text, origin.span.start));
}
