/**
 * Entities: the data a level places.
 *
 * A brush is geometry and a light is a light, but most of what a level says is neither — this door needs
 * a key, that slime has 30 hit points, this trigger loads the next room. LDtk and TrenchBroom both give
 * that its own machinery: a type with typed fields and defaults, and instances that override a few of
 * them. tscene needs no machinery for it at all, because `@entity { … }` is already an at-rule the
 * runtime merges template-first, node-last onto `object.entity` — which is exactly a definition's
 * defaults under an instance's overrides.
 *
 * `entity` is a node of its own — the lib's `Entity extends Object3D`, drawn by nothing — and this module
 * is only the reading and writing of the block. Any object may carry one, though, and that is on purpose:
 * a switch is a mesh with data on it. Everything else a placed thing needs — being clicked, moved,
 * grouped, hidden, saved — it already has by being an object.
 *
 * The whole block is rewritten on every edit rather than the one entry patched. That is what the save
 * does with `@broom` too: a settings block is short, printed on one line, and a designer who reformatted
 * one by hand did so as a block.
 */
import { FIELD_TYPES, type FieldType, type Member, type RecordValue, type Value } from "tscene";
import { bool, colour, num, str, SYNTHETIC, vec3 } from "./props.ts";

/** one field of an `@entity` block: the name the project chose and whatever it was set to */
export type Field = { name: string; value: Value };

type AtMember = Member & { kind: "at" };

const isEntity = (m: Member): m is AtMember => m.kind === "at" && m.name === "entity";

/** the fields a body writes, in the order it wrote them */
export const fieldsOf = (props: Member[]): Field[] =>
  props.find(isEntity)?.value.entries.map((e) => ({ name: e.name, value: e.value })) ?? [];

export const fieldOf = (props: Member[], name: string): Value | undefined =>
  fieldsOf(props).find((f) => f.name === name)?.value;

/** whether this body places any data at all */
export const isEntityBody = (props: Member[]): boolean => props.some(isEntity);

/**
 * The block rewritten around a new list of fields.
 *
 * An empty list removes it: a node whose last field was cleared is a node that carries no data, and
 * leaving `@entity { }` behind would be leaving the reader to wonder what used to be in it. The block
 * keeps whatever span it had, so a save patches the line it was written on rather than adding a second.
 */
function withFields(props: Member[], fields: Field[]): Member[] {
  const at = props.findIndex(isEntity);
  if (!fields.length) return at < 0 ? props : props.filter((_, i) => i !== at);
  const was = at < 0 ? undefined : props[at]!;
  const value: RecordValue = {
    ...SYNTHETIC,
    kind: "record",
    entries: fields.map((f) => ({ name: f.name, namePos: SYNTHETIC, value: f.value })),
  };
  const block: AtMember = { ...SYNTHETIC, ...(was ? { start: was.start, end: was.end } : {}), kind: "at", name: "entity", value };
  return at < 0 ? [...props, block] : props.map((m, i) => (i === at ? block : m));
}

/** one field set, in place if it was already there and appended if it was not */
export function setField(props: Member[], name: string, value: Value): Member[] {
  const fields = fieldsOf(props);
  return withFields(
    props,
    fields.some((f) => f.name === name)
      ? fields.map((f) => (f.name === name ? { name, value } : f))
      : [...fields, { name, value }],
  );
}

export const removeField = (props: Member[], name: string): Member[] =>
  withFields(props, fieldsOf(props).filter((f) => f.name !== name));

/** a field renamed, keeping its value and losing whatever the new name held — the same rule props follow */
export function renameField(props: Member[], from: string, to: string): Member[] {
  const was = fieldOf(props, from);
  if (!to || from === to || was === undefined) return props;
  return setField(removeField(props, from), to, was);
}

// ---------------------------------------------------------------- what a field *is*

/**
 * One row of `@fields { hp: { type: int; min: 0; max: 99 } }`.
 *
 * The declaration is optional and always has been: `@entity { hp: 30 }` already earns a number box by
 * being a number. What this adds is the half inference cannot reach — that a string is one of five
 * choices, that a number is a whole one in a range, that a line of prose wants a box with room in it.
 */
export type FieldDef = {
  name: string;
  type: FieldType;
  min?: number;
  max?: number;
  /** the choices, written on the field itself */
  options?: string[];
  /** the name of a top-level `--list: ["a", "b"]` the choices come from instead */
  enum?: string;
  localized?: boolean;
  array?: boolean;
  nullable?: boolean;
  doc?: string;
};

const isFields = (m: Member): m is AtMember => m.kind === "at" && m.name === "fields";

const wordIn = (record: RecordValue, name: string): string | undefined => {
  const v = record.entries.find((e) => e.name === name)?.value;
  return v?.kind === "string" ? v.value : v?.kind === "ident" ? v.name : undefined;
};

const numberIn = (record: RecordValue, name: string): number | undefined => {
  const v = record.entries.find((e) => e.name === name)?.value;
  return v?.kind === "number" ? v.value : undefined;
};

const flagIn = (record: RecordValue, name: string): boolean | undefined => {
  const v = record.entries.find((e) => e.name === name)?.value;
  return v?.kind === "ident" ? v.name === "true" : undefined;
};

const stringsIn = (record: RecordValue, name: string): string[] | undefined => {
  const v = record.entries.find((e) => e.name === name)?.value;
  if (v?.kind !== "array") return undefined;
  const words = v.items.filter((i) => i.kind === "string").map((i) => (i as { value: string }).value);
  return words.length === v.items.length ? words : undefined;
};

/**
 * The field declarations a body carries, in the order it wrote them.
 *
 * An entry that is not a record, or one whose `type` is not a type, is dropped rather than guessed at.
 * The checker has already said so in the console; an editor that invented a type for it would be an
 * editor writing values the project never asked for.
 */
export function declaredFieldsOf(props: Member[]): FieldDef[] {
  const block = props.find(isFields)?.value;
  if (!block) return [];
  const out: FieldDef[] = [];
  for (const entry of block.entries) {
    if (entry.value.kind !== "record") continue;
    const record = entry.value;
    const type = wordIn(record, "type");
    if (!type || !(FIELD_TYPES as readonly string[]).includes(type)) continue;
    const def: FieldDef = { name: entry.name, type: type as FieldType };
    const min = numberIn(record, "min");
    if (min !== undefined) def.min = min;
    const max = numberIn(record, "max");
    if (max !== undefined) def.max = max;
    const options = stringsIn(record, "options");
    if (options) def.options = options;
    const from = wordIn(record, "enum");
    if (from !== undefined) def.enum = from;
    const localized = flagIn(record, "localized");
    if (localized !== undefined) def.localized = localized;
    const array = flagIn(record, "array");
    if (array !== undefined) def.array = array;
    const nullable = flagIn(record, "nullable");
    if (nullable !== undefined) def.nullable = nullable;
    const doc = wordIn(record, "doc");
    if (doc !== undefined) def.doc = doc;
    out.push(def);
  }
  return out;
}

/** what a field starts as when nothing — not the declaration, not the template — says otherwise */
export function blankField(def: FieldDef): Value {
  switch (def.type) {
    case "int": case "float": return num(def.min ?? 0);
    case "bool": return bool(false);
    case "color": return colour(0xffffff);
    case "point": return vec3([0, 0, 0]);
    case "enum": return str(def.options?.[0] ?? "");
    default: return str("");
  }
}
