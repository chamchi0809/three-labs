/**
 * `@template` declarations, written back into the sheet they came from.
 *
 * The prefab half of the editor. A `@template mesh.button { … }` is what every `.button` in the level
 * follows, so a designer who has one switch looking right wants to say "every switch, then" — and that is
 * an edit to a declaration rather than to a node, which is why it needs its own writer for the same reason
 * `materials.ts` does.
 *
 * The rule is the one materials follow: **only what the editor models is touched.** A template's
 * properties and its `@entity { … }` defaults are the two things the inspector can change, so they are the
 * two things this writes. Its `@broom`, its `@fields`, the child nodes an instance inherits, the comments
 * between them — none of that is in an {@link ObjectDef} and none of it is rewritten.
 *
 * A rename is the one edit that reaches the level as well: the class every instance carries is the
 * template's name, so `doc/templates.ts`'s `renameClass` has to move with the declaration, in the same
 * command. The draft stays filed under the name the *file* has, so this still patches the right block.
 *
 * A template the sheets do not declare is skipped rather than created. Placing an object writes an
 * instance, never a declaration; a project's list of what exists is the project's to write.
 */
import type { Member, Sheet, Template, Value } from "tscene";
import { defKey, type ObjectDef, type PropDef } from "../doc/catalogue.ts";
import { SYNTHETIC } from "../doc/props.ts";
import { printMember } from "./literal.ts";
import {
  deleteAt, indentAt, insertAt, lineRange, newlineOf, replaceAt, withComments, type TextEdit,
} from "./patch.ts";

/** what a session has done to the declarations, by {@link defKey} — `mesh.button` and not just `button` */
export type TemplateDrafts = ReadonlyMap<string, ObjectDef>;

/**
 * A member as the block should read.
 *
 * The printer ends every member with `;`, which is right for `material: var(--trim);` and wrong for a
 * block: no hand-written sheet ends `@entity { … }` with one, and a save is not the place to add
 * punctuation to a line somebody typed.
 */
const printed = (m: Member): string => (m.kind === "at" ? printMember(m).replace(/;$/, "") : printMember(m));

const prop = (name: string, value: Value): Member => ({ ...SYNTHETIC, kind: "prop", name, value });

/** the `@entity { … }` a definition's field defaults come out as — one member, so one edit */
const entityBlock = (fields: PropDef[]): Member => ({
  ...SYNTHETIC,
  kind: "at",
  name: "entity",
  value: {
    ...SYNTHETIC,
    kind: "record",
    entries: fields.map((f) => ({ name: f.name, namePos: SYNTHETIC, value: f.value! })),
  },
});

/** the members a def says its declaration should carry: its properties, then its data defaults */
function ownMembers(def: ObjectDef): Member[] {
  const out = def.props.filter((p) => p.value).map((p) => prop(p.name, p.value!));
  const fields = def.fields.filter((f) => f.value);
  if (fields.length) out.push(entityBlock(fields));
  return out;
}

/** which of a declaration's members this writer owns, and therefore which it may delete */
const key = (m: Member): string | undefined =>
  m.kind === "prop" ? `prop:${m.name}` : m.kind === "at" && m.name === "entity" ? "at:entity" : undefined;

export function templateEdits(sheets: Map<string, Sheet>, drafts: TemplateDrafts): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  for (const [name, def] of drafts) {
    const found = declOf(sheets, name);
    if (!found) continue;
    const edits = patchTemplate(found.sheet.text, found.statement, def);
    if (!edits.length) continue;
    const list = out.get(found.file) ?? [];
    list.push(...edits);
    out.set(found.file, list);
  }
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
      if (defKey({ node: s.node ?? "object3D", name: s.name }) === wanted) found = { file, sheet, statement: s };
    }
  }
  return found;
}

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
  for (const m of ownMembers(def)) {
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
