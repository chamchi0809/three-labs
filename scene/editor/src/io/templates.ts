/**
 * `@template` declarations, written back into the sheet they came from.
 *
 * The prefab half of the editor. A `@template mesh.button { … }` is what every `.button` in the level
 * follows, so a designer who has one switch looking right wants to say "every switch, then" — and that is
 * an edit to a declaration rather than to a node, which is why it needs its own writer for the same reason
 * `materials.ts` does. The entity browser leans on the same writer for the other direction: an entity
 * *type* is a `@template entity.spawn { … }`, so adding, deleting and editing one is this file's business
 * and not the world writer's.
 *
 * The rule is the one materials follow: **only what the editor models is touched.** A template's
 * `@broom`, its properties, its `@entity` defaults and its `@fields` declarations are what an
 * {@link ObjectDef} carries, so they are what this writes. Child nodes an instance inherits, and the
 * comments between the members, are not in a def and are not rewritten — and `@broom` keeps any knob the
 * def has no field for (`layer`, `link`, `protect`, …) rather than losing it to a round trip.
 *
 * A rename is the one edit that reaches the level as well: the class every instance carries is the
 * template's name, so `doc/templates.ts`'s `renameClass` has to move with the declaration, in the same
 * command. The draft stays filed under the name the *file* has, so this still patches the right block.
 */
import type { Member, RecordValue, Sheet, Statement, Template, Value } from "tscene";
import { ANY_NODE, defKey, type ObjectDef, type PropDef } from "../doc/catalogue.ts";
import type { FieldDef } from "../doc/entity.ts";
import { SYNTHETIC, bool, hex, ident, list, num, record, str } from "../doc/props.ts";
import { printMember, printStatement } from "./literal.ts";
import {
  deleteAt, indentAt, insertAt, lineRange, newlineOf, replaceAt, withComments, type TextEdit,
} from "./patch.ts";

/**
 * What a session has done to the declarations, by {@link defKey} — `mesh.button` and not just `button`.
 * `null` is one that was deleted, the same signal a material draft uses.
 */
export type TemplateDrafts = ReadonlyMap<string, ObjectDef | null>;

/**
 * A member as the block should read.
 *
 * The printer ends every member with `;`, which is right for `material: var(--trim);` and wrong for a
 * block: no hand-written sheet ends `@entity { … }` with one, and a save is not the place to add
 * punctuation to a line somebody typed.
 */
const printed = (m: Member): string => (m.kind === "at" ? printMember(m).replace(/;$/, "") : printMember(m));

const prop = (name: string, value: Value): Member => ({ ...SYNTHETIC, kind: "prop", name, value });

const at = (name: string, entries: [string, Value][]): Member => ({
  ...SYNTHETIC,
  kind: "at",
  name,
  value: record(entries) as RecordValue,
});

/** the `@entity { … }` a definition's field defaults come out as — one member, so one edit */
const entityBlock = (fields: PropDef[]): Member =>
  at("entity", fields.filter((f) => f.value).map((f) => [f.name, f.value!]));

/** one `@fields` row: what the key *is*, in the order the language documents the knobs */
function knobsOf(f: FieldDef): [string, Value][] {
  const out: [string, Value][] = [["type", ident(f.type)]];
  if (f.min !== undefined) out.push(["min", num(f.min)]);
  if (f.max !== undefined) out.push(["max", num(f.max)]);
  if (f.options) out.push(["options", list(f.options.map(str))]);
  if (f.enum !== undefined) out.push(["enum", str(f.enum)]);
  if (f.localized !== undefined) out.push(["localized", bool(f.localized)]);
  if (f.array !== undefined) out.push(["array", bool(f.array)]);
  if (f.nullable !== undefined) out.push(["nullable", bool(f.nullable)]);
  if (f.doc !== undefined) out.push(["doc", str(f.doc)]);
  return out;
}

const fieldsBlock = (declared: FieldDef[]): Member =>
  at("fields", declared.map((f) => [f.name, record(knobsOf(f))]));

/** the `@broom` knobs a def speaks for; anything else in the block is the sheet's and is left alone */
function broomKnobs(def: ObjectDef, had: (name: string) => boolean): Map<string, Value | undefined> {
  return new Map<string, Value | undefined>([
    // a template that says nothing is a point one, so `kind: point` is only written where it was written
    ["kind", def.kind === "brush" || had("kind") ? ident(def.kind) : undefined],
    ["icon", def.icon !== undefined ? str(def.icon) : undefined],
    ["category", def.category !== undefined ? str(def.category) : undefined],
    ["doc", def.doc !== undefined ? str(def.doc) : undefined],
    // a bare hex: `@broom` is settings for a tool, and a number is what it is read back as
    ["color", def.colour !== undefined ? hex(def.colour) : undefined],
    ["size", def.size ? list(def.size.map((n) => num(n))) : undefined],
  ]);
}

/**
 * The `@broom { … }` a definition should carry: the block as the sheet wrote it, with the knobs the
 * editor owns brought into line. An entry the def has no value for goes; one it has and the block never
 * had joins the end; everything else keeps its place and its spelling.
 */
function broomBlock(def: ObjectDef, was?: RecordValue): Member | undefined {
  const owned = broomKnobs(def, (name) => !!was?.entries.some((e) => e.name === name));
  const entries: [string, Value][] = [];
  for (const e of was?.entries ?? []) {
    if (!owned.has(e.name)) {
      entries.push([e.name, e.value]);
      continue;
    }
    const now = owned.get(e.name);
    owned.delete(e.name);
    if (now) entries.push([e.name, now]);
  }
  for (const [name, now] of owned) if (now) entries.push([name, now]);
  return entries.length ? at("broom", entries) : undefined;
}

/** the members a def says its declaration should carry, in the order a new one is written in */
function ownMembers(def: ObjectDef, was?: Template): Member[] {
  const out: Member[] = [];
  const broom = broomBlock(def, recordOf(was, "broom"));
  if (broom) out.push(broom);
  out.push(...def.props.filter((p) => p.value).map((p) => prop(p.name, p.value!)));
  if (def.fields.some((f) => f.value)) out.push(entityBlock(def.fields));
  if (def.declared.length) out.push(fieldsBlock(def.declared));
  return out;
}

const recordOf = (was: Template | undefined, name: string): RecordValue | undefined =>
  was?.body.find((m): m is Member & { kind: "at" } => m.kind === "at" && m.name === name)?.value;

/** which of a declaration's members this writer owns, and therefore which it may delete */
const key = (m: Member): string | undefined =>
  m.kind === "prop" ? `prop:${m.name}`
  : m.kind === "at" && (m.name === "broom" || m.name === "entity" || m.name === "fields") ? `at:${m.name}`
  : undefined;

/** the whole declaration as a sheet would write it — for a type that is not in any file yet */
export const printTemplate = (def: ObjectDef): string =>
  printStatement({
    ...SYNTHETIC,
    kind: "template",
    ...(def.node === ANY_NODE ? {} : { node: def.node }),
    name: def.name,
    namePos: SYNTHETIC,
    body: ownMembers(def),
  });

export function templateEdits(
  sheets: Map<string, Sheet>,
  root: string,
  drafts: TemplateDrafts,
): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  const sink = (file: string): TextEdit[] => {
    let into = out.get(file);
    if (!into) out.set(file, (into = []));
    return into;
  };

  const fresh: ObjectDef[] = [];
  for (const [name, def] of drafts) {
    const found = declOf(sheets, name);
    if (!found) {
      if (def) fresh.push(def);
      continue;
    }
    const { file, sheet, statement } = found;
    if (!def) {
      const cut = lineRange(sheet.text, withComments(sheet.text, statement.start), statement.end);
      sink(file).push(deleteAt(cut.start, cut.end, `@template ${name} was deleted`));
      continue;
    }
    const edits = patchTemplate(sheet.text, statement, def);
    if (edits.length) sink(file).push(...edits);
  }

  if (fresh.length) {
    const sheet = sheets.get(root);
    if (sheet) sink(root).push(addDecls(sheet, fresh));
  }
  for (const [file, list] of out) if (!list.length) out.delete(file);
  return out;
}

/** the `@template` with this key, wherever it is; the last one wins, as the catalogue reads them */
function declOf(
  sheets: Map<string, Sheet>,
  wanted: string,
): { file: string; sheet: Sheet; statement: Template } | undefined {
  let found: { file: string; sheet: Sheet; statement: Template } | undefined;
  for (const [file, sheet] of sheets) {
    for (const s of sheet.statements) {
      if (s.kind !== "template") continue;
      if (defKey({ node: s.node ?? ANY_NODE, name: s.name }) === wanted) found = { file, sheet, statement: s };
    }
  }
  return found;
}

/**
 * New declarations, under the last thing the sheet already declares.
 *
 * The same place a new material goes, and for the same reason: what a level *places* goes at the end of
 * the file, and what it *declares* belongs above that, next to the other declarations.
 */
function addDecls(sheet: Sheet, defs: ObjectDef[]): TextEdit {
  const text = sheet.text;
  const nl = newlineOf(text);
  const blocks = defs.map(printTemplate);

  let last = -1;
  for (const s of sheet.statements) {
    if (declaration(s)) last = Math.max(last, s.end);
  }
  if (last < 0) {
    return insertAt(0, blocks.join(nl + nl) + nl + (text.trim() ? nl : ""), "new entity types");
  }
  const eol = text.indexOf("\n", last);
  return insertAt(eol < 0 ? text.length : eol, blocks.map((b) => nl + nl + b).join(""), "new entity types");
}

const declaration = (s: Statement): boolean =>
  s.kind === "var" || s.kind === "at" || s.kind === "import" || s.kind === "template";

/** one declaration brought into line with a def, one member at a time */
function patchTemplate(text: string, was: Template, def: ObjectDef): TextEdit[] {
  const edits: TextEdit[] = [];
  const open = text.indexOf("{", was.start);
  const close = text.lastIndexOf("}", was.end);
  if (open < 0 || close < open) return edits;

  // the name in the header, which a rename moved. `namePos` is `.button` — dot included, so the
  // replacement carries one too, and the node type before it is left alone
  if (def.name !== was.name) {
    edits.push(replaceAt(was.namePos.start, was.namePos.end, `.${def.name}`, `renamed to ${def.name}`));
  }

  const olds = new Map<string, Member>();
  for (const m of was.body) {
    const k = key(m);
    if (k) olds.set(k, m);
  }

  const fresh: string[] = [];
  for (const m of ownMembers(def, was)) {
    const old = olds.get(key(m)!);
    if (!old) {
      fresh.push(printed(m));
      continue;
    }
    olds.delete(key(m)!);
    if (printed(old) !== printed(m)) {
      edits.push(replaceAt(old.start, old.end, printed(m), `${def.name}.${key(m)!.split(":")[1]}`));
    }
  }

  let notBefore = 0;
  for (const left of olds.values()) {
    const cut = lineRange(text, withComments(text, left.start), left.end);
    edits.push(deleteAt(cut.start, cut.end, `${def.name} lost ${key(left)!.split(":")[1]}`));
    notBefore = Math.max(notBefore, cut.end);
  }

  if (fresh.length) {
    const nl = newlineOf(text);
    const indent = indentAt(text, was.start);
    const inner = indent + "  ";
    const gap = text.slice(open + 1, close);
    const written = fresh.map((b) => nl + inner + b).join("");
    if (!notBefore && !gap.trim()) {
      edits.push(replaceAt(open + 1, close, written + nl + indent, "new settings"));
    } else {
      const after = open + 1 + gap.replace(/\s+$/, "").length;
      edits.push(insertAt(Math.min(Math.max(notBefore, after), close), written, "new settings"));
    }
  }
  return edits;
}
