// A `@template` patched in place: only its properties and its `@entity` defaults, nothing else in the block.
// Run with: node --experimental-strip-types src/io/templates.check.ts
import assert from "node:assert/strict";
import { parse } from "tscene";
import { report, test } from "../check.ts";
import { catalogueOfSheets, defKey } from "../doc/catalogue.ts";
import { clearDefProp, setDefProp } from "../doc/catalogue.ts";
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

const sheets = () => new Map([["a.tscene", parse(SHEET, "a.tscene")]]);
const def = () => {
  const found = catalogueOfSheets([parse(SHEET, "a.tscene")]).objects.find((d) => d.name === "button");
  assert.ok(found, "the sheet declares mesh.button");
  return found;
};

const saved = (next: ReturnType<typeof def>, key = defKey(next)): string => {
  const map = sheets();
  const edits = templateEdits(map, new Map([[key, next]]));
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

test("a draft filed under a name the sheet does not declare patches nothing", () => {
  const renamed = { ...def(), name: "switchPlate" };
  const edits = templateEdits(sheets(), new Map([[defKey(renamed), renamed]]));
  assert.deepEqual([...edits.keys()], [], "the key is the file's name, not the new one");
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

test("a template the sheets do not declare is skipped rather than invented", () => {
  const alien = { ...def(), name: "elsewhere" };
  assert.equal(templateEdits(sheets(), new Map([[defKey(alien), alien]])).size, 0);
});

test("a def that says nothing new asks for no edits at all", () => {
  const same = def();
  assert.equal(templateEdits(sheets(), new Map([[defKey(same), same]])).size, 0);
});

test("a colour is written as the sheet writes colours", () => {
  const text = saved(setDefProp(def(), "props", "color", hex(0xff8000)));
  assert.ok(text.includes("color: #ff8000;"), text);
});

report("templates-io");
