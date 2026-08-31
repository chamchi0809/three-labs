/**
 * Material declarations, written back into the sheet they came from.
 *
 * A material is a top-level `--wall: meshStandardMaterial { … }`, which is why the editor could read them
 * from the first day and could not change one: every other edit the editor makes is a change to a *node*,
 * and the whole save path is written in terms of nodes. This is the same idea one level over — the same
 * rule, the same `TextEdit`s, the same refusal to reprint a file — for the handful of declarations a
 * designer actually wants a colour picker for.
 *
 * The rule that matters: **only the properties the editor models are touched.** A material may say
 * `side: DoubleSide`, `emissive: color(#220000)`, `alphaTest: calc(…)`; none of that is in a
 * {@link MaterialDef} and none of it is rewritten. Changing the roughness of such a material edits the
 * roughness line and leaves the rest of the block exactly as it was typed.
 */
import type { Member, Sheet, Value } from "tscene";
import { MAP_SLOTS, type MaterialDef } from "../doc/catalogue.ts";
import { SYNTHETIC, call, colour as colourOf, num, str } from "../doc/props.ts";
import { printMember } from "./literal.ts";
import {
  deleteAt, indentAt, insertAt, lineRange, newlineOf, reindent, replaceAt, withComments, type TextEdit,
} from "./patch.ts";

/** what a session has done to a declaration: the way it should read, or `null` for one that is gone */
export type MaterialDraft = MaterialDef | null;

/** drafts by the name the declaration has *in the sheet*, so a rename is still one declaration */
export type MaterialDrafts = ReadonlyMap<string, MaterialDraft>;

type VarMember = Extract<Member, { kind: "var" }>;

/** a material with nothing on it but a colour — what "new material" starts from */
export const newMaterial = (name: string): MaterialDef => ({
  name,
  type: "meshStandardMaterial",
  colour: 0xcccccc,
  maps: {},
  roughness: 1,
});

/** a name that is free, for a material the designer has not named yet */
export function freeName(taken: Iterable<string>, stem = "material"): string {
  const used = new Set(taken);
  for (let i = 1; ; i++) if (!used.has(`${stem}${i}`)) return `${stem}${i}`;
}

/** the name the editor writes a material under: a `--var` name, so no spaces and no punctuation */
export const cleanName = (raw: string): string => raw.trim().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");

// ---------------------------------------------------------------- the properties the editor owns

/** every property this file will write, and therefore every property it may delete */
const OWNED = new Set<string>(["color", "colour", ...MAP_SLOTS, "roughness", "metalness", "depth"]);

/** the values a def says its declaration should carry, in the order a new one is written in */
function ownProps(def: MaterialDef): [string, Value][] {
  const out: [string, Value][] = [];
  if (def.colour !== undefined) out.push(["color", colourOf(def.colour)]);
  for (const slot of MAP_SLOTS) {
    const url = def.maps[slot];
    if (url) out.push([slot, call("texture", [str(url)])]);
  }
  if (def.roughness !== undefined) out.push(["roughness", num(def.roughness)]);
  if (def.metalness !== undefined) out.push(["metalness", num(def.metalness)]);
  if (def.depth !== undefined) out.push(["depth", num(def.depth)]);
  return out;
}

const prop = (name: string, value: Value): Member => ({ ...SYNTHETIC, kind: "prop", name, value });

/**
 * The whole declaration as a sheet would write it — for a material that is not in any file yet.
 *
 * The printer's trailing `;` is dropped: a declaration with a body does not need one, no hand-written
 * sheet has one, and a new material should not be the odd line out in a file somebody maintains.
 */
export function printMaterial(def: MaterialDef): string {
  return printMember({
    ...SYNTHETIC,
    kind: "var",
    name: def.name,
    namePos: SYNTHETIC,
    value: {
      ...SYNTHETIC,
      kind: "object",
      name: def.type,
      classes: [],
      classSpans: [],
      args: [],
      body: ownProps(def).map(([n, v]) => prop(n, v)),
      hasBody: true,
    },
  }).replace(/;$/, "");
}

// ---------------------------------------------------------------- the edits

/**
 * Every file's edits for a set of drafts.
 *
 * A draft names a declaration by the name it has in the sheet; a def whose `name` differs from that key
 * is a rename, and the head is rewritten. Anything the sheets have no declaration for is new, and is
 * written into the root beside the other declarations rather than appended to the end of the file — the
 * end of the file is where the *nodes* go, and two writers appending to the same byte is an overlap.
 */
export function materialEdits(
  sheets: Map<string, Sheet>,
  root: string,
  drafts: MaterialDrafts,
): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  const sink = (file: string): TextEdit[] => {
    let list = out.get(file);
    if (!list) out.set(file, (list = []));
    return list;
  };

  const fresh: MaterialDef[] = [];
  for (const [name, draft] of drafts) {
    const found = declOf(sheets, name);
    if (!found) {
      if (draft) fresh.push(draft);
      continue;
    }
    const { file, sheet, member } = found;
    if (!draft) {
      const cut = lineRange(sheet.text, withComments(sheet.text, member.start), member.end);
      sink(file).push(deleteAt(cut.start, cut.end, `--${name} was deleted`));
      continue;
    }
    sink(file).push(...patchDecl(sheet.text, member, draft));
  }

  if (fresh.length) {
    const sheet = sheets.get(root);
    if (sheet) sink(root).push(addDecls(sheet, fresh));
  }
  return out;
}

/** the `--name` declaration, wherever it is; the last one wins, the same way the catalogue reads them */
function declOf(
  sheets: Map<string, Sheet>,
  name: string,
): { file: string; sheet: Sheet; member: VarMember } | undefined {
  let found: { file: string; sheet: Sheet; member: VarMember } | undefined;
  for (const [file, sheet] of sheets) {
    for (const s of sheet.statements) {
      if (s.kind === "var" && s.name === name) found = { file, sheet, member: s };
    }
  }
  return found;
}

/** one declaration brought into line with a def, one property at a time */
function patchDecl(text: string, was: VarMember, def: MaterialDef): TextEdit[] {
  const v = was.value;
  // a material written with no body — `--wall: meshStandardMaterial;` — has nothing worth preserving
  if (v.kind !== "object" || !v.hasBody) {
    return [replaceAt(was.start, was.end, reindent(printMaterial(def), indentAt(text, was.start)), `--${def.name}`)];
  }

  const edits: TextEdit[] = [];
  const open = text.indexOf("{", was.start);
  const close = text.lastIndexOf("}", was.end);
  if (open < 0 || close < open) return edits;

  const head = `--${def.name}: ${def.type} `;
  if (text.slice(was.start, open) !== head) {
    edits.push(replaceAt(was.start, open, head, `the head of --${def.name}`));
  }

  const wanted = ownProps(def);
  // `colour` is as good a spelling as `color` and the sheet's author picked one; a save is not the place
  // to have that argument
  const spelled = (name: string): string =>
    name === "color" && v.body.some((m) => m.kind === "prop" && m.name === "colour") ? "colour" : name;
  const keys = new Set(wanted.map(([name]) => spelled(name)));

  const fresh: string[] = [];
  for (const [name, value] of wanted) {
    const key = spelled(name);
    const old = v.body.find((m): m is Extract<Member, { kind: "prop" }> => m.kind === "prop" && m.name === key);
    const now = prop(key, value);
    if (!old) {
      fresh.push(printMember(now));
      continue;
    }
    if (printMember(old) !== printMember(now)) {
      edits.push(replaceAt(old.start, old.end, printMember(now), `${def.name}.${key}`));
    }
  }

  let notBefore = 0;
  for (const m of v.body) {
    if (m.kind !== "prop" || !OWNED.has(m.name) || keys.has(m.name)) continue;
    const cut = lineRange(text, withComments(text, m.start), m.end);
    edits.push(deleteAt(cut.start, cut.end, `${def.name}.${m.name} was unset`));
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

/**
 * New declarations, under the last thing the sheet already declares.
 *
 * Declarations belong above the map in a hand-written sheet — a face cannot name a material that is
 * declared below it and still read like a sheet somebody wrote — so a new one joins the others rather
 * than landing after the last brush.
 */
function addDecls(sheet: Sheet, defs: MaterialDef[]): TextEdit {
  const text = sheet.text;
  const nl = newlineOf(text);
  const blocks = defs.map(printMaterial);

  let last = -1;
  for (const s of sheet.statements) {
    if (s.kind === "var" || s.kind === "at" || s.kind === "import") last = Math.max(last, s.end);
  }
  if (last < 0) {
    return insertAt(0, blocks.join(nl + nl) + nl + (text.trim() ? nl : ""), "new materials");
  }
  const eol = text.indexOf("\n", last);
  return insertAt(eol < 0 ? text.length : eol, blocks.map((b) => nl + b).join(""), "new materials");
}
