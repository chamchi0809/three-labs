/**
 * Tags read out of what the project declares, and what selecting one means.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/doc/tags.check.ts
 */
import { strict as assert } from "node:assert";
import { parse } from "tscene";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { report, test } from "../check.ts";
import { catalogueOfSheets } from "./catalogue.ts";
import { brushNode, entityNode, isHidden, layerNode, nodeById, type World } from "./document.ts";
import { newEditor } from "./editor.ts";
import { NOTHING } from "./selection.ts";
import {
  facesWithTag, hasTag, hideTag, isolateTag, key, nodesWithTag, selectByTag, tagByName, tagCounts,
  tagNodes, tagsFor, tagsForFace, tagsOf, tagsOfSelection, untagNodes,
} from "./tags.ts";

const sheet = parse(`
--wall: meshStandardMaterial { color: #808080 }
--water: meshPhysicalMaterial { color: #2244aa }

@template mesh.torch { @broom { kind: "point"; color: #ffaa00 } intensity: 1 }
@template .trigger { @broom { kind: "brush" } }
`, "library.tscene");

const catalogue = catalogueOfSheets([sheet]);
const tags = tagsOf(catalogue);

const box = (material?: string) =>
  brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [1, 1, 1] }), material ? { material } : {}));

// ---------------------------------------------------------------- where tags come from

test("a project's templates and materials are its tags, with no second file to configure", () => {
  assert.deepEqual(tags.map(key).sort(), ["face:wall", "face:water", "node:torch", "node:trigger"].sort());
  assert.equal(tagByName(tags, "torch", "node")!.colour, 0xffaa00);
  assert.equal(tagByName(tags, "water", "face")!.colour, 0x2244aa);
  assert.equal(tagByName(tags, "water", "node"), undefined, "a material is a surface, not a thing");
});

test("a typed template tags only that type; an untyped one tags anything", () => {
  const torch = tagByName(tags, "torch", "node")!;
  const trigger = tagByName(tags, "trigger", "node")!;

  assert.ok(hasTag(entityNode("mesh", { classes: ["torch"] }), torch));
  assert.ok(!hasTag(entityNode("pointLight", { classes: ["torch"] }), torch),
    "a light called torch is not a mesh called torch");
  assert.ok(hasTag({ ...box(), classes: ["trigger"] }, trigger), "a template of no type applies anywhere");
  assert.ok(!hasTag(entityNode("mesh"), torch));
});

test("a face carries the tag of the material it is made of", () => {
  const solid = box("water");
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  assert.deepEqual(tagsForFace(world, { node: solid.id, face: 0 }, tags).map((t) => t.name), ["water"]);
  const bare = box();
  const plain: World = { layers: [layerNode("Main", [bare])], broom: { grid: -2, scale: 1 } };
  assert.deepEqual(tagsForFace(plain, { node: bare.id, face: 0 }, tags), []);
});

// ---------------------------------------------------------------- finding and counting

test("things and surfaces are found separately, and counted the same way", () => {
  const torch = entityNode("mesh", { classes: ["torch"] });
  const wet = box("water");
  const dry = box();
  const world: World = { layers: [layerNode("Main", [torch, wet, dry])], broom: { grid: -2, scale: 1 } };

  assert.deepEqual(nodesWithTag(world, tagByName(tags, "torch", "node")!), [torch.id]);
  assert.equal(facesWithTag(world, tagByName(tags, "water", "face")!).length, 6, "a cube has six faces");

  const counts = tagCounts(world, tags);
  assert.equal(counts.get("node:torch"), 1);
  assert.equal(counts.get("face:water"), 6);
  assert.equal(counts.get("node:trigger"), undefined, "a tag nothing carries is not listed");
});

// ---------------------------------------------------------------- selecting and filtering

test("selecting a node tag selects things; selecting a face tag selects surfaces", () => {
  const torch = entityNode("mesh", { classes: ["torch"] });
  const wet = box("water");
  const world: World = { layers: [layerNode("Main", [torch, wet])], broom: { grid: -2, scale: 1 } };
  const e = newEditor(world);

  const things = selectByTag(e, tagByName(tags, "torch", "node")!);
  assert.deepEqual(things.selection.nodes, [torch.id]);
  assert.deepEqual(things.selection.faces, []);

  const surfaces = selectByTag(e, tagByName(tags, "water", "face")!);
  assert.equal(surfaces.selection.faces.length, 6);
  assert.deepEqual(surfaces.selection.nodes, [], "six faces of one solid is not the solid");
});

test("a filter is a tag isolated, so there is only ever one answer to what is showing", () => {
  const torch = entityNode("mesh", { classes: ["torch"] });
  const other = box();
  const world: World = { layers: [layerNode("Main", [torch, other])], broom: { grid: -2, scale: 1 } };
  const e = { ...newEditor(world), selection: NOTHING };

  const only = isolateTag(e, tagByName(tags, "torch", "node")!).world;
  assert.ok(!isHidden(only, torch.id));
  assert.ok(isHidden(only, other.id));

  const gone = hideTag(e, tagByName(tags, "torch", "node")!).world;
  assert.ok(isHidden(gone, torch.id));
  assert.ok(!isHidden(gone, other.id));
});

// ---------------------------------------------------------------- putting one on

test("tagging writes the class the template declared, and never writes it twice", () => {
  const solid = box();
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  const trigger = tagByName(tags, "trigger", "node")!;

  const once = tagNodes(world, [solid.id], trigger);
  assert.deepEqual(nodeById(once, solid.id)!.classes, ["trigger"]);
  assert.equal(tagNodes(once, [solid.id], trigger), once, "an unchanged world comes back as the same value");
  assert.deepEqual(nodeById(untagNodes(once, [solid.id], trigger), solid.id)!.classes, []);
});

test("a face tag cannot be written onto a node, because a node is not made of anything", () => {
  const solid = box();
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  assert.equal(tagNodes(world, [solid.id], tagByName(tags, "water", "face")!), world);
});

test("the inspector can tell a tag every selected node has from one only some of them do", () => {
  const a = entityNode("mesh", { classes: ["torch", "trigger"] });
  const b = entityNode("mesh", { classes: ["torch"] });
  const world: World = { layers: [layerNode("Main", [a, b])], broom: { grid: -2, scale: 1 } };
  const both = tagsOfSelection(world, { ...NOTHING, nodes: [a.id, b.id] }, tags);
  assert.deepEqual(both.all.map((t) => t.name), ["torch"]);
  assert.deepEqual(both.some.map((t) => t.name), ["trigger"]);
  assert.deepEqual(tagsFor(a, tags).map((t) => t.name).sort(), ["torch", "trigger"]);
  assert.deepEqual(tagsOfSelection(world, NOTHING, tags), { all: [], some: [] });
});

report("tags");
