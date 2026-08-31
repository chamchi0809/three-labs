/**
 * A definition's fields, as one list to edit.
 *
 * An entity type says two things about a key and says them in two places: `@entity { hp: 30 }` is what an
 * instance starts with, `@fields { hp: { type: int; min: 0 } }` is what the key *is*. That split is right
 * for a sheet — the default is the common case and the declaration is the exception — and wrong for a
 * table with one row per field, which is how anyone who has used LDtk or TrenchBroom expects to edit a
 * type. So this joins the two halves into rows, and puts each edit back into whichever half owns it.
 *
 * The type of a row with no declaration is *inferred*, exactly as the property grid infers an editor from
 * a value, and inferring is not the same as declaring: the row shows `float` for `hp: 30` and writes
 * nothing, until somebody picks a type and means it.
 */
import { FIELD_TYPES, type FieldType, type Value } from "tscene";
import {
  clearDefProp, propType, setDefProp, type ObjectDef, type PropType,
} from "./catalogue.ts";
import { blankField, type FieldDef } from "./entity.ts";

export type SchemaRow = {
  name: string;
  /** the `@fields` type where the project declared one, and the value's own where it did not */
  type: FieldType;
  /** whether that type is the project's word or this module's guess */
  declared: boolean;
  /** what an instance of the type starts with — the `@entity` default */
  value?: Value;
  field?: FieldDef;
};

/** the editor a value would get anyway, said as a field type — see {@link propType} for the other half */
const FROM_VALUE: Record<PropType, FieldType> = {
  number: "float", colour: "color", bool: "bool", vec3: "point",
  text: "text", ref: "text", material: "text", expression: "text",
};

export const typeOfValue = (v: Value | undefined): FieldType =>
  v === undefined ? "text" : FROM_VALUE[propType(v)];

/** the fields of a definition, `@entity` order first and declarations the block never defaulted after */
export function schemaOf(def: ObjectDef): SchemaRow[] {
  const decls = new Map(def.declared.map((f) => [f.name, f]));
  const out: SchemaRow[] = [];
  const seen = new Set<string>();
  for (const p of def.fields) {
    const field = decls.get(p.name);
    seen.add(p.name);
    out.push({
      name: p.name,
      type: field?.type ?? typeOfValue(p.value),
      declared: !!field,
      ...(p.value ? { value: p.value } : {}),
      ...(field ? { field } : {}),
    });
  }
  for (const field of def.declared) {
    if (!seen.has(field.name)) out.push({ name: field.name, type: field.type, declared: true, field });
  }
  return out;
}

/** one declaration set or, with `undefined`, dropped — the `@fields` half of a row */
const withDeclared = (def: ObjectDef, name: string, next: FieldDef | undefined): ObjectDef => ({
  ...def,
  declared: next
    ? def.declared.some((f) => f.name === name)
      ? def.declared.map((f) => (f.name === name ? next : f))
      : [...def.declared, next]
    : def.declared.filter((f) => f.name !== name),
});

const freeField = (def: ObjectDef): string => {
  const taken = new Set(schemaOf(def).map((r) => r.name));
  for (let i = 1; ; i++) if (!taken.has(`field${i}`)) return `field${i}`;
};

/**
 * A field added: a name nothing else has, a declared type, and the default that type starts at.
 *
 * Both halves are written, because a field added in this table is a field somebody is declaring — the
 * inference path is for keys that arrived from a sheet, not for keys this dialog is inventing.
 */
export function addSchemaField(def: ObjectDef, type: FieldType = "text"): ObjectDef {
  const name = freeField(def);
  const field: FieldDef = { name, type };
  return setDefProp(withDeclared(def, name, field), "fields", name, blankField(field));
}

export const removeSchemaField = (def: ObjectDef, name: string): ObjectDef =>
  withDeclared(clearDefProp(def, "fields", name), name, undefined);

/** a field renamed in both halves at once, so its type does not come adrift from its default */
export function renameSchemaField(def: ObjectDef, from: string, to: string): ObjectDef {
  const clean = to.trim();
  if (!clean || clean === from || schemaOf(def).some((r) => r.name === clean)) return def;
  const was = def.declared.find((f) => f.name === from);
  const moved = withDeclared(withDeclared(def, from, undefined), clean, was ? { ...was, name: clean } : undefined);
  const value = def.fields.find((p) => p.name === from)?.value;
  return value ? setDefProp(clearDefProp(moved, "fields", from), "fields", clean, value) : moved;
}

/**
 * A type picked, which is also the moment the default has to follow.
 *
 * A `hp` that was a number and is now an `enum` has `30` sitting under it, and a grid that drew a choice
 * list over that number would be drawing a value the project cannot mean. So the default goes back to
 * what the type starts at, the way pixi-vania's editor does it, unless the value already fits.
 */
export function setSchemaType(def: ObjectDef, name: string, type: FieldType): ObjectDef {
  const row = schemaOf(def).find((r) => r.name === name);
  if (!row) return def;
  const field: FieldDef = { ...(row.field ?? {}), name, type };
  // the knobs that only mean something for the type they came from
  if (type !== "int" && type !== "float") { delete field.min; delete field.max; }
  if (type !== "enum") { delete field.options; delete field.enum; }
  if (type !== "text" && type !== "lines") delete field.localized;
  const next = withDeclared(def, name, field);
  return row.value && typeOfValue(row.value) === type
    ? next
    : setDefProp(next, "fields", name, blankField(field));
}

export const setSchemaDefault = (def: ObjectDef, name: string, value: Value): ObjectDef =>
  setDefProp(def, "fields", name, value);

/** one knob of a declaration — a range, a choice list, a line of prose. `undefined` unsets it */
export function setSchemaKnob<K extends keyof FieldDef>(
  def: ObjectDef, name: string, knob: K, value: FieldDef[K] | undefined,
): ObjectDef {
  const row = schemaOf(def).find((r) => r.name === name);
  if (!row) return def;
  const field: FieldDef = { ...(row.field ?? {}), name, type: row.type };
  if (value === undefined) delete field[knob];
  else field[knob] = value;
  return withDeclared(def, name, field);
}

export { FIELD_TYPES };
