// A `@template` patched in place: only its properties and its `@entity` defaults, nothing else in the block.
// Run with: node --experimental-strip-types src/io/templates.check.ts
import assert from "node:assert/strict";
import { parse } from "tscene";
import { report, test } from "../check.ts";
import { catalogueOfSheets, defKey } from "../doc/catalogue.ts";
import { clearDefProp, newEntityDef, setDefProp } from "../doc/catalogue.ts";
import { addSchemaField, setSchemaKnob, setSchemaType } from "../doc/schema.ts";
import { hex, num, read, str } from "../doc/props.ts";
import { applyEdits } from "./patch.ts";
import { templateEdits } from "./templates.ts";

const SHEET = `--trim: meshStandardMaterial { color: #303030; }

@template mesh.button {
  @broom { icon: "switch"; color: #6fd08c; }
  geometry: boxGeometry(0.05, 0.2, 0.2);
  material: var(--trim);
  @entity { target: ""; once: true; }
}

mesh.button#switch { position: vec3(1, 2, 3); }
`;

const BROOM = `@template entity.spawn {
  @broom { kind: point; layer: "spawns"; category: "story" }
}
`;

const sheets = () => new Map([["a.tscene", parse(SHEET, "a.tscene")]]);
const def = () => {
  const found = catalogueOfSheets([parse(SHEET, "a.tscene")]).objects.find((d) => d.name === "button");
  assert.ok(found, "the sheet declares mesh.button");
  return found;
};

const saved = (next: ReturnType<typeof def>, key = defKey(next)): string => {
  const map = sheets();
  const edits = templateEdits(map, "a.tscene", new Map([[key, next]]));
  const list = edits.get("a.tscene") ?? [];
  const { text, problems } = applyEdits(SHEET, list);
  assert.deepEqual(problems, [], "the edits do not overlap");
  return text;
};

test("a property changed patches its own line and leaves the rest of the block alone", () => {
  const text = saved(setDefProp(def(), "props", "material", read("wall")));
  assert.ok(text.includes("material: var(--wall);"), text);
  assert.ok(text.includes('@broom { icon: "switch"; color: #6fd08c; }'), "the broom block is untouched");
  assert.ok(text.includes("geometry: boxGeometry(0.05, 0.2, 0.2);"), "the other property is untouched");
  assert.ok(text.includes("mesh.button#switch { position: vec3(1, 2, 3); }"), "the instance is untouched");
});

test("a rename moves the header and leaves the body where it was", () => {
  const was = def();
  // filed under the name the *file* has, which is what `library.keyOfTemplate` is for
  const text = saved({ ...was, name: "switchPlate" }, defKey(was));
  assert.match(text, /@template mesh\.switchPlate \{/, text);
  assert.ok(text.includes("geometry: boxGeometry(0.05, 0.2, 0.2);"), "the body is untouched");
  assert.ok(text.includes('@broom { icon: "switch"; color: #6fd08c; }'), "and so is @broom");
  // the class on the instance is the node writer's half — `renameClass` moves it in the world
  assert.ok(text.includes("mesh.button#switch"), text);
});

test("a draft filed under its new name declares a second template, which is why keyOfTemplate exists", () => {
  const renamed = { ...def(), name: "switchPlate" };
  const { text } = applyEdits(SHEET, templateEdits(sheets(), "a.tscene", new Map([[defKey(renamed), renamed]])).get("a.tscene")!);
  assert.match(text, /@template mesh\.switchPlate \{/, "filed under the wrong key, it reads as a new type");
  assert.ok(text.includes("@template mesh.button {"), "and the block it meant to rename is untouched");
});

test("a property the template never had is written into the block", () => {
  const text = saved(setDefProp(def(), "props", "castShadow", num(1)));
  assert.match(text, /@entity \{ target: ""; once: true; \}\n  castShadow: 1;\n\}/, text);
});

test("a property cleared takes its line with it", () => {
  const text = saved(clearDefProp(def(), "props", "geometry"));
  assert.ok(!text.includes("geometry:"), text);
  assert.ok(text.includes("material: var(--trim);"), "and only its line");
});

test("the data defaults are one member, so a changed field is one edit to the @entity block", () => {
  const text = saved(setDefProp(def(), "fields", "target", str("lamp")));
  // the printer's own spelling of a record, which is what every other write in the editor produces
  assert.ok(text.includes('@entity { target: "lamp"; once: true }'), text);
});

test("a template no sheet declares is written into the root, and nowhere else", () => {
  const alien = { ...def(), name: "elsewhere" };
  assert.equal(templateEdits(sheets(), "b.tscene", new Map([[defKey(alien), alien]])).size, 0);
});

test("a def that says nothing new asks for no edits at all", () => {
  const same = def();
  assert.equal(templateEdits(sheets(), "a.tscene", new Map([[defKey(same), same]])).size, 0);
});

test("a colour is written as the sheet writes colours", () => {
  const text = saved(setDefProp(def(), "props", "color", hex(0xff8000)));
  assert.ok(text.includes("color: #ff8000;"), text);
});

// ---------------------------------------------------------------- entity types: add, delete, schema

test("a @broom knob changed patches the block and keeps the knobs the editor has no field for", () => {
  const map = new Map([["a.tscene", parse(BROOM, "a.tscene")]]);
  const was = catalogueOfSheets([parse(BROOM, "a.tscene")]).objects.find((d) => d.name === "spawn")!;
  const next = { ...was, category: "gameplay", colour: 0xff0000 };
  const { text, problems } = applyEdits(BROOM, templateEdits(map, "a.tscene", new Map([[defKey(next), next]])).get("a.tscene")!);
  assert.deepEqual(problems, []);
  assert.match(text, /@broom \{ kind: point; layer: "spawns"; category: "gameplay"; color: #ff0000 \}/, text);
});

test("a field declared is written as an @fields row, defaults and all", () => {
  const map = new Map([["a.tscene", parse(BROOM, "a.tscene")]]);
  const was = catalogueOfSheets([parse(BROOM, "a.tscene")]).objects.find((d) => d.name === "spawn")!;
  const next = setSchemaKnob(setSchemaType(addSchemaField(was), "field1", "int"), "field1", "max", 9);
  const { text } = applyEdits(BROOM, templateEdits(map, "a.tscene", new Map([[defKey(next), next]])).get("a.tscene")!);
  assert.match(text, /@fields \{ field1: \{ type: int; max: 9 \} \}/, text);
  assert.match(text, /@entity \{ field1: 0 \}/, text);
});

test("an entity type nothing declares yet is written whole, under the declarations", () => {
  const map = new Map([["a.tscene", parse(SHEET, "a.tscene")]]);
  const fresh = setSchemaType(addSchemaField(newEntityDef("spawn")), "field1", "bool");
  const { text, problems } = applyEdits(SHEET, templateEdits(map, "a.tscene", new Map([[defKey(fresh), fresh]])).get("a.tscene")!);
  assert.deepEqual(problems, []);
  assert.match(text, /@template entity\.spawn \{/, text);
  assert.match(text, /@broom \{ color: #66ccff \}/, text);
  assert.match(text, /@entity \{ field1: false \}/, text);
  assert.match(text, /@fields \{ field1: \{ type: bool \} \}/, text);
  // above the level, not after the last brush — the same place a new material goes
  assert.ok(text.indexOf("@template entity.spawn") < text.indexOf("mesh.button#switch"), text);
  // and the sheet still parses as one sheet
  assert.deepEqual(parse(text, "a.tscene").errors, []);
});

test("a draft of null takes the whole declaration out", () => {
  const map = new Map([["a.tscene", parse(SHEET, "a.tscene")]]);
  const { text } = applyEdits(SHEET, templateEdits(map, "a.tscene", new Map([["mesh.button", null]])).get("a.tscene")!);
  assert.ok(!text.includes("@template"), text);
  assert.ok(text.includes("--trim:"), "and only that declaration");
  // the instances are the caller's half: `deleteTemplate` removes them in the same command
  assert.ok(text.includes("mesh.button#switch"), text);
});

report("templates-io");
