/**
 * What the project says exists: the object definitions and the materials.
 *
 * A Quake editor reads its object list out of a `.fgd` — a second file, in a second language, that says
 * what a `light` is and which of its keys are numbers. tscene needs no such file, because the project
 * already declares both things in the sheet itself: a `@template mesh.torch { … }` *is* the definition of
 * a torch, and a top-level `--wall: meshStandardMaterial { … }` *is* the material named `wall`. This turns
 * those two declarations into the lists the browsers and the property grid read.
 *
 * Two consequences are worth stating, because they are the reason this is not an `.fgd` reader:
 *
 * - **A definition is a class, not a type.** `@template mesh.torch` says "a mesh with `.torch` on it", so
 *   placing one writes `mesh.torch { … }` and the template's own body supplies the defaults. Nothing has
 *   to be copied into the instance for it to look right, and a change to the template reaches every torch
 *   already placed — which is what a designer expects of something they think of as a prefab.
 * - **A property's editor comes from its value.** The definition says `intensity: 1`, so the grid knows to
 *   draw a number box; it says `color: #ffddaa`, so the grid knows to draw a swatch. There is no separate
 *   type declaration to fall out of step with the value beside it, and a property the definition never
 *   mentioned is still editable — it is simply typed by whatever the node itself wrote.
 */
import type { Member, NodeBroom, Sheet, Statement, Template, Value } from "tscene";
import { readBroom } from "../io/read.ts";
import { declaredFieldsOf, fieldsOf, type FieldDef } from "./entity.ts";
import { objectNode, nodeTypeName, type ObjectNode, type Node } from "./document.ts";
import { asColour } from "./props.ts";

/** which of the smart editors a value gets. `expression` is the one that is shown but not edited */
export type PropType = "number" | "vec3" | "colour" | "bool" | "ref" | "material" | "text" | "expression";

export type PropDef = {
  name: string;
  type: PropType;
  /** what the definition wrote, which is both the placeholder and the value a reset goes back to */
  value?: Value;
};

export type ObjectDef = {
  /** the `.class` the template declares — what an instance writes on its head */
  name: string;
  /** the node an instance is written as: `mesh`, `pointLight`, or `object3D` for a template of no type */
  node: string;
  /** whether it is placed as a point or wrapped around solids, the same split TrenchBroom draws */
  kind: "point" | "brush";
  icon?: string;
  /** the group the browser files it under */
  category?: string;
  /** one line about what it is */
  doc?: string;
  colour?: number;
  /** the box an instance is drawn and picked in, in metres about its origin */
  size?: number[];
  props: PropDef[];
  /**
   * The `@entity { … }` the template declares: the data an instance of it carries, and the defaults it
   * carries when it says nothing. The editor's half of `object.entity` — the grid lists these greyed
   * until somebody overrides one, exactly as it does the properties above.
   */
  fields: PropDef[];
  /**
   * The `@fields { … }` the template declares: what those keys *are*, where the project said so. A key
   * with no declaration is still editable — typed by whatever value it holds — so this is only the half
   * inference cannot reach: a range, a set of choices, a line of prose that wants room.
   */
  declared: FieldDef[];
  file?: string;
};

/**
 * The texture slots the editor draws with.
 *
 * A short list on purpose. A sheet may hang anything three understands off a material, and the runtime
 * will honour all of it; these seven are the ones the *viewport* knows what to do with, and a slot the
 * editor cannot draw is better left to the runtime than approximated in the preview.
 */
export const MAP_SLOTS = [
  "map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "heightMap",
] as const;

export type MapSlot = (typeof MAP_SLOTS)[number];

export type MaterialDef = {
  /** the `--var`'s name, without the dashes — what a face's `material:` names */
  name: string;
  /** the node it is declared as: `meshStandardMaterial`, `heightMaterial`, … */
  type: string;
  /** its `color`, when it wrote a literal one — the swatch the browser shows */
  colour?: number;
  /**
   * The url each slot's `texture(…)` names, exactly as the sheet wrote it.
   *
   * As written rather than resolved, because resolving is the loader's business and it needs to know
   * which file the declaration came from — which is what {@link MaterialDef.file} is for.
   */
  maps: Partial<Record<MapSlot, string>>;
  /** the literal scalars it wrote; anything computed is left standing for the runtime to fold */
  roughness?: number;
  metalness?: number;
  /**
   * Metres of relief, from a `heightMaterial`'s `depth`.
   *
   * The one knob the height material gives a level designer. Everything else about the three tiers —
   * whether a pixel is normal-mapped, marched, or writing its own depth — follows from how far away the
   * camera is, and a designer who had to choose that per material would be choosing wrong at every
   * distance but one.
   */
  depth?: number;
  file?: string;
};

/** a material declared with a `heightMap`, whatever it calls itself — the tier machinery follows the map */
export const hasRelief = (def: MaterialDef): boolean => def.maps.heightMap !== undefined;

export type Catalogue = {
  objects: ObjectDef[];
  materials: MaterialDef[];
  /**
   * The choice lists a field's `enum` names, by name without the dashes.
   *
   * A top-level `--damage: ["fire", "ice"]` is one. Nothing marks it as an enum — a `--var` holding a list
   * of strings is the only shape a list of choices can have, and a project that wants one somewhere else
   * has written it as `options` on the field instead.
   */
  enums: Record<string, string[]>;
};

export const EMPTY: Catalogue = { objects: [], materials: [], enums: {} };

/** a template with no node type applies to any Object3D, and an instance of one is written as this */
export const ANY_NODE = "object3D";

/**
 * The node an entity definition is written as.
 *
 * `@template entity.spawner { … }` is an entity type, and nothing else has to say so: the node it applies
 * to is tscene's own `entity` class, which has no geometry and no material and exists to hold the record
 * a level places at a point. So the entity browser is the catalogue filtered on this one name, and the
 * object browser is the catalogue with it taken out.
 */
export const ENTITY_NODE = "entity";

export const isEntityDef = (def: ObjectDef): boolean => def.node === ENTITY_NODE;

export const entityDefs = (catalogue: Catalogue): ObjectDef[] => catalogue.objects.filter(isEntityDef);

/**
 * An entity type with nothing on it yet — what "add type" in the entity browser starts from.
 *
 * A colour and no fields. The colour is not decoration: an entity draws as nothing, so the gizmo's
 * swatch is the only way one type is told from another in a viewport, and a type with no colour would be
 * a type nobody can see.
 */
export const newEntityDef = (name: string): ObjectDef => ({
  name,
  node: ENTITY_NODE,
  kind: "point",
  colour: 0x66ccff,
  props: [],
  fields: [],
  declared: [],
});

// ---------------------------------------------------------------- typing a value

/**
 * The editor a value gets.
 *
 * By the shape of what is written rather than by a declared type, so that `position: vec3(0, 1, 0)` and
 * `position: [0, 1, 0]` both get three number boxes and `position: calc(var(--a) + 1)` gets neither. The
 * last case is the important one: `expression` is not a failure, it is the grid saying that this value
 * belongs to the sheet and the editor is only showing it.
 */
export function propType(v: Value | undefined): PropType {
  if (!v) return "text";
  switch (v.kind) {
    case "number": return "number";
    case "hex": return "colour";
    case "string": return "text";
    case "ref": return "ref";
    case "var": return "material";
    case "ident": return v.name === "true" || v.name === "false" ? "bool" : "text";
    case "array": return isTriple(v.items) ? "vec3" : "expression";
    case "object":
      if (v.name === "vec3" && isTriple(v.args)) return "vec3";
      // `color(#ff8000)` is how a colour has to be written for the runtime to make a `Color` of it, so it
      // is the form the grid meets most often — a swatch, not the greyed source of an expression
      if (asColour(v) !== undefined) return "colour";
      return "expression";
    default: return "expression";
  }
}

const isTriple = (items: Value[]): boolean => items.length === 3 && items.every((i) => i.kind === "number");

/** whether a type is one the grid can edit, as against one it can only show */
export const isEditable = (t: PropType): boolean => t !== "expression";

// ---------------------------------------------------------------- object definitions

/**
 * The definition a `@template` declares.
 *
 * Child nodes in the body are skipped rather than listed: `mesh.torch { pointLight { … } }` says a torch
 * carries a light, which is a fact about the instance's contents, not a property anyone edits in a grid.
 */
export function defOf(statement: Template, file?: string): ObjectDef {
  const broom = broomOf(statement.body);
  return {
    name: statement.name,
    node: statement.node ?? ANY_NODE,
    kind: broom.kind ?? "point",
    ...(broom.icon !== undefined ? { icon: broom.icon } : {}),
    ...(broom.category !== undefined ? { category: broom.category } : {}),
    ...(broom.doc !== undefined ? { doc: broom.doc } : {}),
    ...(broom.color !== undefined ? { colour: broom.color } : {}),
    ...(broom.size ? { size: broom.size } : {}),
    props: propsOf(statement.body),
    fields: fieldsOf(statement.body).map((f) => ({ name: f.name, type: propType(f.value), value: f.value })),
    declared: declaredFieldsOf(statement.body),
    ...(file !== undefined ? { file } : {}),
  };
}

const broomOf = (body: Member[]): NodeBroom => {
  const at = body.find((m) => m.kind === "at" && m.name === "broom");
  return at?.kind === "at" ? readBroom(at.value) : {};
};

const propsOf = (body: Member[]): PropDef[] =>
  body
    .filter((m): m is Extract<Member, { kind: "prop" }> => m.kind === "prop")
    .map((m) => ({ name: m.name, type: propType(m.value), value: m.value }));

// ---------------------------------------------------------------- materials

/** the node names a `--var` has to be declared as for the browser to call it a material */
const MATERIAL = /material$/i;

export function materialOf(member: Extract<Member, { kind: "var" }>, file?: string): MaterialDef | undefined {
  const v = member.value;
  if (v.kind !== "object" || !MATERIAL.test(v.name)) return undefined;
  const colour = colourOf(v.body);
  const maps: Partial<Record<MapSlot, string>> = {};
  for (const slot of MAP_SLOTS) {
    const url = urlOf(v.body, slot);
    if (url !== undefined) maps[slot] = url;
  }
  return {
    name: member.name,
    type: v.name,
    ...(colour !== undefined ? { colour } : {}),
    maps,
    ...literal(v.body, "roughness"),
    ...literal(v.body, "metalness"),
    ...literal(v.body, "depth"),
    ...(file !== undefined ? { file } : {}),
  };
}

const propIn = (body: Member[], name: string): Value | undefined =>
  body.find((m): m is Extract<Member, { kind: "prop" }> => m.kind === "prop" && m.name === name)?.value;

/** a material's `color`, when it wrote a literal one — a swatch is worth more than a name in a list */
function colourOf(body: Member[]): number | undefined {
  for (const m of body) {
    if (m.kind !== "prop" || (m.name !== "color" && m.name !== "colour")) continue;
    const found = asColour(m.value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The file a slot's `texture("…")` names.
 *
 * Only the literal form is read. `map: var(--atlas)` and `map: texture(calc(…))` are perfectly good
 * tscene and the runtime resolves both, but the editor cannot know what they come out as without running
 * the sheet — and a preview that guessed would be a preview that showed the wrong wall.
 */
function urlOf(body: Member[], name: string): string | undefined {
  const v = propIn(body, name);
  if (v?.kind !== "object" || v.name !== "texture") return undefined;
  const first = v.args[0];
  return first?.kind === "string" ? first.value : undefined;
}

/** a scalar the declaration wrote as a plain number, as a spreadable fragment so undefined stays absent */
function literal(body: Member[], name: "roughness" | "metalness" | "depth"): { [k in typeof name]?: number } {
  const v = propIn(body, name);
  return v?.kind === "number" ? { [name]: v.value } : {};
}

// ---------------------------------------------------------------- assembling

/** a statement, and which file wrote it — the same pair {@link readWorld} carries its templates in */
export type Placed = { file?: string; statement: Statement };

/**
 * The catalogue of a flattened list of statements.
 *
 * Later declarations win on name, because that is what `@import` means: a project sheet that imports a
 * library and then redeclares `--wall` has overridden it, and a browser that offered both would be
 * offering one that no longer exists.
 */
export function catalogueOf(statements: Placed[]): Catalogue {
  const objects = new Map<string, ObjectDef>();
  const materials = new Map<string, MaterialDef>();
  const enums: Record<string, string[]> = {};
  for (const { file, statement } of statements) {
    if (statement.kind === "template") {
      const def = defOf(statement, file);
      objects.set(`${def.node}.${def.name}`, def);
    } else if (statement.kind === "var") {
      const material = materialOf(statement, file);
      if (material) materials.set(material.name, material);
      const words = wordListOf(statement.value);
      if (words) enums[statement.name] = words;
    }
  }
  return { objects: [...objects.values()], materials: [...materials.values()], enums };
}

/** a `--var` holding nothing but strings — a list of choices, and not a list of anything else */
function wordListOf(v: Value): string[] | undefined {
  if (v.kind !== "array" || !v.items.length) return undefined;
  const words = v.items.filter((i) => i.kind === "string").map((i) => (i as { value: string }).value);
  return words.length === v.items.length ? words : undefined;
}

/** the catalogue of parsed sheets, for the demo document and for anything read without following imports */
export const catalogueOfSheets = (sheets: Iterable<Sheet>): Catalogue =>
  catalogueOf([...sheets].flatMap((s) => s.statements.map((statement) => ({ file: s.file, statement }))));

// ---------------------------------------------------------------- reading it back

/** the definition a node is an instance of, if it is an instance of one */
export function defFor(catalogue: Catalogue, node: Node): ObjectDef | undefined {
  if (!node.classes.length) return undefined;
  const type = nodeTypeName(node);
  // the last class written wins, the same way the last `@template` declared does — a node with two
  // templates on it is displayed as the more specific one, and the more specific one is written last
  for (let i = node.classes.length - 1; i >= 0; i--) {
    const name = node.classes[i]!;
    const found =
      catalogue.objects.find((d) => d.name === name && d.node === type) ??
      catalogue.objects.find((d) => d.name === name && d.node === ANY_NODE);
    if (found) return found;
  }
  return undefined;
}

export const defByName = (catalogue: Catalogue, node: string, name: string): ObjectDef | undefined =>
  catalogue.objects.find((d) => d.node === node && d.name === name);

export const materialByName = (catalogue: Catalogue, name: string): MaterialDef | undefined =>
  catalogue.materials.find((m) => m.name === name);

// ---------------------------------------------------------------- placing one

/**
 * A new instance of a definition.
 *
 * The template's own properties are deliberately *not* copied in. An instance that repeated its
 * definition would be an instance that stopped following it, and the whole reason a definition is a
 * `@template` rather than a text macro is that editing the template edits everything placed from it. What
 * the instance gets is its class, its position, and the box the definition says it occupies.
 */
export function instanceOf(def: ObjectDef, props: Member[]): ObjectNode {
  return objectNode(def.node === ANY_NODE ? "object3D" : def.node, {
    classes: [def.name],
    props,
    broom: def.size ? { size: def.size } : {},
  });
}

/** the choices a declared field offers: written on the field, or taken from the `--list` it names */
export const optionsFor = (catalogue: Catalogue, field: FieldDef): string[] =>
  field.options ?? (field.enum !== undefined ? catalogue.enums[field.enum] ?? [] : []);

// ---------------------------------------------------------------- editing a definition

/**
 * The name a template answers to: `mesh.button`, `entity.spawn`, `object3D.wide`.
 *
 * Both halves, because `.trigger` on a group and `.trigger` on a mesh are two declarations and a designer
 * editing one has not edited the other.
 */
export const defKey = (def: { node: string; name: string }): string => `${def.node}.${def.name}`;

/** which half of a definition an edit is against: three's properties, or the `@entity { … }` defaults */
export type DefHalf = "props" | "fields";

/** one property of a definition set, in place if it was already declared and appended if it was not */
export function setDefProp(def: ObjectDef, half: DefHalf, name: string, value: Value): ObjectDef {
  const was = def[half];
  const now: PropDef = { name, type: propType(value), value };
  return {
    ...def,
    [half]: was.some((p) => p.name === name) ? was.map((p) => (p.name === name ? now : p)) : [...was, now],
  };
}

export const clearDefProp = (def: ObjectDef, half: DefHalf, name: string): ObjectDef =>
  ({ ...def, [half]: def[half].filter((p) => p.name !== name) });

/** the same rule a node's properties follow: the new name wins whatever it was already holding */
export function renameDefProp(def: ObjectDef, half: DefHalf, from: string, to: string): ObjectDef {
  const was = def[half].find((p) => p.name === from);
  if (!to || from === to || !was?.value) return def;
  return setDefProp(clearDefProp(def, half, from), half, to, was.value);
}
