/**
 * Templates read out of what the project declares, and what selecting one means.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/doc/templates.check.ts
 */
import { strict as assert } from "node:assert";
import { parse } from "tscene";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { report, test } from "../check.ts";
import { catalogueOfSheets } from "./catalogue.ts";
import { brushNode, objectNode, isHidden, layerNode, nodeById, type World } from "./document.ts";
import { newEditor } from "./editor.ts";
import { NOTHING } from "./selection.ts";
import {
  applyTemplate, hasTemplate, hideTemplate, isolateTemplate, key, nodesWithTemplate, removeTemplate,
  renameClass, selectByTemplate, templateByName, templateCounts, templatesFor, templatesOf,
  templatesOfSelection,
} from "./templates.ts";

const sheet = parse(`
--wall: meshStandardMaterial { color: #808080 }
--water: meshPhysicalMaterial { color: #2244aa }

@template mesh.torch { @broom { kind: "point"; color: #ffaa00 } intensity: 1 }
@template .trigger { @broom { kind: "brush" } }
`, "library.tscene");

const catalogue = catalogueOfSheets([sheet]);
const templates = templatesOf(catalogue);

const box = (material?: string) =>
  brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [1, 1, 1] }), material ? { material } : {}));

// ---------------------------------------------------------------- where templates come from

test("a project's @templates are its kinds, with no second file to configure", () => {
  assert.deepEqual(templates.map(key).sort(), ["torch", "trigger"]);
  assert.equal(templateByName(templates, "torch")!.colour, 0xffaa00);
  // a `--var` is a style variable, not a kind of thing: the material browser answers for faces
  assert.equal(templateByName(templates, "water"), undefined);
  assert.equal(templateByName(templates, "wall"), undefined);
});

test("a typed template matches only that type; an untyped one matches anything", () => {
  const torch = templateByName(templates, "torch")!;
  const trigger = templateByName(templates, "trigger")!;

  assert.ok(hasTemplate(objectNode("mesh", { classes: ["torch"] }), torch));
  assert.ok(!hasTemplate(objectNode("pointLight", { classes: ["torch"] }), torch),
    "a light called torch is not a mesh called torch");
  assert.ok(hasTemplate({ ...box(), classes: ["trigger"] }, trigger), "a template of no type applies anywhere");
  assert.ok(!hasTemplate(objectNode("mesh"), torch));
});

// ---------------------------------------------------------------- finding and counting

test("things of a kind are found and counted", () => {
  const torch = objectNode("mesh", { classes: ["torch"] });
  const dry = box();
  const world: World = { layers: [layerNode("Main", [torch, dry])], broom: { grid: -2, scale: 1 } };

  assert.deepEqual(nodesWithTemplate(world, templateByName(templates, "torch")!), [torch.id]);

  const counts = templateCounts(world, templates);
  assert.equal(counts.get("torch"), 1);
  assert.equal(counts.get("trigger"), undefined, "a kind nothing is is not listed");
});

// ---------------------------------------------------------------- selecting and filtering

test("selecting a kind selects the things of it, never their surfaces", () => {
  const torch = objectNode("mesh", { classes: ["torch"] });
  const wet = box("water");
  const world: World = { layers: [layerNode("Main", [torch, wet])], broom: { grid: -2, scale: 1 } };

  const things = selectByTemplate(newEditor(world), templateByName(templates, "torch")!);
  assert.deepEqual(things.selection.nodes, [torch.id]);
  assert.deepEqual(things.selection.faces, []);
});

test("a filter is a kind isolated, so there is only ever one answer to what is showing", () => {
  const torch = objectNode("mesh", { classes: ["torch"] });
  const other = box();
  const world: World = { layers: [layerNode("Main", [torch, other])], broom: { grid: -2, scale: 1 } };
  const e = { ...newEditor(world), selection: NOTHING };

  const only = isolateTemplate(e, templateByName(templates, "torch")!).world;
  assert.ok(!isHidden(only, torch.id));
  assert.ok(isHidden(only, other.id));

  const gone = hideTemplate(e, templateByName(templates, "torch")!).world;
  assert.ok(isHidden(gone, torch.id));
  assert.ok(!isHidden(gone, other.id));
});

// ---------------------------------------------------------------- putting one on

test("applying a kind writes the class the template declared, and never writes it twice", () => {
  const solid = box();
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  const trigger = templateByName(templates, "trigger")!;

  const once = applyTemplate(world, [solid.id], trigger);
  assert.deepEqual(nodeById(once, solid.id)!.classes, ["trigger"]);
  assert.equal(applyTemplate(once, [solid.id], trigger), once, "an unchanged world comes back as the same value");
  assert.deepEqual(nodeById(removeTemplate(once, [solid.id], trigger), solid.id)!.classes, []);
});

test("renaming a kind renames it on the things that are one, and only on those", () => {
  const torch = objectNode("mesh", { classes: ["torch", "trigger"] });
  const light = objectNode("pointLight", { classes: ["torch"] }); // `mesh.torch` never spoke for this one
  const world: World = { layers: [layerNode("Main", [torch, light])], broom: { grid: -2, scale: 1 } };
  const next = renameClass(world, templateByName(templates, "torch")!, "brand");
  assert.deepEqual(nodeById(next, torch.id)!.classes, ["brand", "trigger"]);
  assert.deepEqual(nodeById(next, light.id)!.classes, ["torch"], "a class of the same name on another type");
  // a name the node already carries does not end up on it twice
  const twice = renameClass(world, templateByName(templates, "torch")!, "trigger");
  assert.deepEqual(nodeById(twice, torch.id)!.classes, ["trigger"]);
});

test("the inspector can tell a kind every selected node is from one only some of them are", () => {
  const a = objectNode("mesh", { classes: ["torch", "trigger"] });
  const b = objectNode("mesh", { classes: ["torch"] });
  const world: World = { layers: [layerNode("Main", [a, b])], broom: { grid: -2, scale: 1 } };
  const both = templatesOfSelection(world, { ...NOTHING, nodes: [a.id, b.id] }, templates);
  assert.deepEqual(both.all.map((t) => t.name), ["torch"]);
  assert.deepEqual(both.some.map((t) => t.name), ["trigger"]);
  assert.deepEqual(templatesFor(a, templates).map((t) => t.name).sort(), ["torch", "trigger"]);
  assert.deepEqual(templatesOfSelection(world, NOTHING, templates), { all: [], some: [] });
});

report("templates");
