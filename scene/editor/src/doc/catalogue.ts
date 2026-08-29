/**
 * What the project says exists: the entity definitions and the materials.
 *
 * A Quake editor reads its entity list out of a `.fgd` — a second file, in a second language, that says
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
import { entityNode, type EntityNode, type Node } from "./document.ts";

/** which of the smart editors a value gets. `expression` is the one that is shown but not edited */
export type PropType = "number" | "vec3" | "colour" | "bool" | "ref" | "material" | "text" | "expression";

export type PropDef = {
  name: string;
  type: PropType;
  /** what the definition wrote, which is both the placeholder and the value a reset goes back to */
  value?: Value;
};

export type EntityDef = {
  /** the `.class` the template declares — what an instance writes on its head */
  name: string;
  /** the node an instance is written as: `mesh`, `pointLight`, or `object3D` for a template of no type */
  node: string;
  /** whether it is placed as a point or wrapped around solids, the same split TrenchBroom draws */
  kind: "point" | "brush";
  icon?: string;
  colour?: number;
  /** the box an instance is drawn and picked in, in metres about its origin */
  size?: number[];
  props: PropDef[];
  file?: string;
};

export type MaterialDef = {
  /** the `--var`'s name, without the dashes — what a face's `material:` names */
  name: string;
  /** the node it is declared as: `meshStandardMaterial`, `meshPhysicalMaterial`, … */
  type: string;
  /** its `color`, when it wrote a literal one — the swatch the browser shows */
  colour?: number;
  file?: string;
};

export type Catalogue = { entities: EntityDef[]; materials: MaterialDef[] };

export const EMPTY: Catalogue = { entities: [], materials: [] };

/** a template with no node type applies to any Object3D, and an instance of one is written as this */
export const ANY_NODE = "object3D";

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
    case "object": return v.name === "vec3" && isTriple(v.args) ? "vec3" : "expression";
    default: return "expression";
  }
}

const isTriple = (items: Value[]): boolean => items.length === 3 && items.every((i) => i.kind === "number");

/** whether a type is one the grid can edit, as against one it can only show */
export const isEditable = (t: PropType): boolean => t !== "expression";

// ---------------------------------------------------------------- entity definitions

/**
 * The definition a `@template` declares.
 *
 * Child nodes in the body are skipped rather than listed: `mesh.torch { pointLight { … } }` says a torch
 * carries a light, which is a fact about the instance's contents, not a property anyone edits in a grid.
 */
export function defOf(statement: Template, file?: string): EntityDef {
  const broom = broomOf(statement.body);
  return {
    name: statement.name,
    node: statement.node ?? ANY_NODE,
    kind: broom.kind ?? "point",
    ...(broom.icon !== undefined ? { icon: broom.icon } : {}),
    ...(broom.color !== undefined ? { colour: broom.color } : {}),
    ...(broom.size ? { size: broom.size } : {}),
    props: propsOf(statement.body),
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
  return {
    name: member.name,
    type: v.name,
    ...(colour !== undefined ? { colour } : {}),
    ...(file !== undefined ? { file } : {}),
  };
}

/** a material's `color`, when it wrote a literal one — a swatch is worth more than a name in a list */
function colourOf(body: Member[]): number | undefined {
  for (const m of body) {
    if (m.kind !== "prop" || (m.name !== "color" && m.name !== "colour")) continue;
    if (m.value.kind === "hex") return m.value.value;
    if (m.value.kind === "number") return m.value.value;
  }
  return undefined;
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
  const entities = new Map<string, EntityDef>();
  const materials = new Map<string, MaterialDef>();
  for (const { file, statement } of statements) {
    if (statement.kind === "template") {
      const def = defOf(statement, file);
      entities.set(`${def.node}.${def.name}`, def);
    } else if (statement.kind === "var") {
      const material = materialOf(statement, file);
      if (material) materials.set(material.name, material);
    }
  }
  return { entities: [...entities.values()], materials: [...materials.values()] };
}

/** the catalogue of parsed sheets, for the demo document and for anything read without following imports */
export const catalogueOfSheets = (sheets: Iterable<Sheet>): Catalogue =>
  catalogueOf([...sheets].flatMap((s) => s.statements.map((statement) => ({ file: s.file, statement }))));

// ---------------------------------------------------------------- reading it back

/** the definition a node is an instance of, if it is an instance of one */
export function defFor(catalogue: Catalogue, node: Node): EntityDef | undefined {
  if (!node.classes.length) return undefined;
  const type = node.kind === "entity" ? node.type : node.kind === "brush" ? "brush" : "group";
  // the last class written wins, the same way the last `@template` declared does — a node with two
  // templates on it is displayed as the more specific one, and the more specific one is written last
  for (let i = node.classes.length - 1; i >= 0; i--) {
    const name = node.classes[i]!;
    const found =
      catalogue.entities.find((d) => d.name === name && d.node === type) ??
      catalogue.entities.find((d) => d.name === name && d.node === ANY_NODE);
    if (found) return found;
  }
  return undefined;
}

export const defByName = (catalogue: Catalogue, node: string, name: string): EntityDef | undefined =>
  catalogue.entities.find((d) => d.node === node && d.name === name);

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
export function instanceOf(def: EntityDef, props: Member[]): EntityNode {
  return entityNode(def.node === ANY_NODE ? "object3D" : def.node, {
    classes: [def.name],
    props,
    broom: def.size ? { size: def.size } : {},
  });
}
