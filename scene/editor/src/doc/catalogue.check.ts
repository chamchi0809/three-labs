// The catalogue: that a `@template` becomes an entity definition, a `--var` becomes a material, and a
// value's own shape decides which editor the property grid draws for it.
// Run with: node --experimental-strip-types src/doc/catalogue.check.ts
import assert from "node:assert/strict";
import { parse } from "tscene";
import { report, test } from "../check.ts";
import {
  ANY_NODE, catalogueOfSheets, defFor, defByName, instanceOf, isEditable, materialByName, propType,
} from "./catalogue.ts";
import { DEMO_SHEET, demoCatalogue } from "./demo.ts";
import { brushNode, entityNode } from "./document.ts";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";

const catalogueOfText = (text: string) => catalogueOfSheets([parse(text, "t.tscene")]);

test("the demo sheet parses, which is the only thing that makes it a demo", () => {
  const sheet = parse(DEMO_SHEET, "demo.tscene");
  assert.deepEqual(sheet.errors, []);
});

test("a @template is an entity definition, head and @broom and all", () => {
  const { entities } = demoCatalogue();
  const lamp = defByName(demoCatalogue(), "pointLight", "lamp");
  assert.ok(lamp, "declared as `@template pointLight.lamp`");
  assert.equal(lamp.kind, "point", "nothing said otherwise");
  assert.equal(lamp.icon, "light");
  assert.equal(lamp.colour, 0xffcc66);
  assert.deepEqual(lamp.size, [-0.2, -0.2, -0.2, 0.2, 0.2, 0.2]);
  assert.equal(lamp.file, "demo.tscene", "so the browser can say where it came from");
  assert.equal(entities.length, 5);
  assert.equal(defByName(demoCatalogue(), "group", "trigger")?.kind, "brush", "`kind` is read, not guessed");
});

test("the properties of a definition are the ones it wrote, typed by what it wrote", () => {
  const lamp = defByName(demoCatalogue(), "pointLight", "lamp")!;
  assert.deepEqual(lamp.props.map((p) => [p.name, p.type]), [
    ["color", "colour"],
    ["intensity", "number"],
    ["distance", "number"],
    ["castShadow", "bool"],
  ]);
  const button = defByName(demoCatalogue(), "mesh", "button")!;
  assert.deepEqual(button.props.map((p) => [p.name, p.type]), [
    ["geometry", "expression"],
    ["material", "material"],
  ], "a `boxGeometry(…)` is not a number, and the grid says so rather than guessing");
});

test("a template with no node type is a definition for anything", () => {
  const { entities } = catalogueOfText("@template .glow { intensity: 2; }");
  assert.equal(entities[0]?.node, ANY_NODE);
});

test("every value kind lands on an editor, and the ones that cannot be edited say so", () => {
  const { entities } = catalogueOfText(`@template mesh.k {
    a: 1; b: "s"; c: #ff0000; d: true; e: other; f: ref(#x); g: var(--m);
    h: vec3(1, 2, 3); i: [1, 2, 3]; j: [1, 2]; k: calc(1 + 2); l: var(--p).x;
  }`);
  assert.deepEqual(entities[0]!.props.map((p) => p.type), [
    "number", "text", "colour", "bool", "text", "ref", "material",
    "vec3", "vec3", "expression", "expression", "expression",
  ]);
  assert.equal(isEditable("expression"), false);
  assert.equal(isEditable("vec3"), true);
  assert.equal(propType(undefined), "text", "a property being added is a blank string until it is not");
});

test("a --var declared as a material is one, and anything else is not", () => {
  const cat = catalogueOfText(`
    --wall: meshStandardMaterial { color: #b7a98f; }
    --half: 0.5
    --spot: pointLight { intensity: 3; }
    --sky: meshBasicNodeMaterial { color: 255; }
  `);
  assert.deepEqual(cat.materials.map((m) => m.name), ["wall", "sky"], "a light is not a material");
  assert.equal(materialByName(cat, "wall")?.type, "meshStandardMaterial");
  assert.equal(materialByName(cat, "wall")?.colour, 0xb7a98f, "read for the swatch");
  assert.equal(materialByName(cat, "sky")?.colour, 255, "written as a number, which is still a colour");
});

test("the later declaration wins, because that is what an @import means", () => {
  const cat = catalogueOfText(`
    --wall: meshStandardMaterial { color: #111111; }
    --wall: meshPhysicalMaterial { color: #222222; }
    @template mesh.crate { a: 1; }
    @template mesh.crate { a: 2; }
  `);
  assert.equal(cat.materials.length, 1);
  assert.equal(cat.materials[0]!.type, "meshPhysicalMaterial");
  assert.equal(cat.entities.length, 1);
  assert.equal(cat.entities[0]!.props[0]!.value?.kind === "number" && cat.entities[0]!.props[0]!.value.value, 2);
});

test("a node finds the definition it is an instance of, by class and by node type", () => {
  const cat = demoCatalogue();
  assert.equal(defFor(cat, entityNode("pointLight", { classes: ["lamp"] }))?.name, "lamp");
  assert.equal(defFor(cat, entityNode("mesh", { classes: ["lamp"] })), undefined, "a mesh is not a lamp");
  assert.equal(defFor(cat, entityNode("mesh", {})), undefined, "and a node with no class is nobody's instance");
  assert.equal(defFor(cat, brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [1, 1, 1] })))), undefined);
});

test("a class matches an any-node template when no typed one fits", () => {
  const cat = catalogueOfText("@template .glow { intensity: 2; }\n@template mesh.glow { intensity: 3; }");
  assert.equal(defFor(cat, entityNode("mesh", { classes: ["glow"] }))?.node, "mesh", "the exact one is preferred");
  assert.equal(defFor(cat, entityNode("pointLight", { classes: ["glow"] }))?.node, ANY_NODE);
});

test("the last class written is the one a node is shown as", () => {
  const cat = catalogueOfText("@template mesh.a { x: 1; }\n@template mesh.b { x: 2; }");
  assert.equal(defFor(cat, entityNode("mesh", { classes: ["a", "b"] }))?.name, "b");
});

test("placing one writes the class and the box, and not the definition's body", () => {
  const lamp = defByName(demoCatalogue(), "pointLight", "lamp")!;
  const node = instanceOf(lamp, []);
  assert.equal(node.type, "pointLight");
  assert.deepEqual(node.classes, ["lamp"]);
  assert.deepEqual(node.props, [], "an instance that repeated its template would stop following it");
  assert.deepEqual(node.broom.size, lamp.size);
});

report("catalogue");
