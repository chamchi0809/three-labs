// The inspectors' arithmetic: what a grid shows for a selection that disagrees with itself, what a
// material assignment actually lands on, and that editing one property leaves the rest of the body alone.
// Run with: node --experimental-strip-types src/doc/inspect.check.ts
import assert from "node:assert/strict";
import { report, test } from "../check.ts";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { withFace } from "../brush/uv.ts";
import { demoCatalogue } from "./demo.ts";
import { defByName } from "./catalogue.ts";
import {
  brushNode, entityNode, groupNode, layerNode, nodeById, type Node, type World,
} from "./document.ts";
import {
  commonDef, describeNodes, faceInfo, facesInScope, mapStats, removeNodesProp, renameNode,
  renameNodesProp, rowsFor, setClasses, setNodesProp, setSheetId, sheetIds, uvPolygon,
} from "./inspect.ts";
import { num, setNumber, setString } from "./props.ts";
import { NOTHING } from "./selection.ts";

const lamp = (intensity: number) =>
  entityNode("pointLight", { classes: ["lamp"], props: setNumber([], "intensity", intensity) });

const cube = (material?: string) => brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [2, 2, 2] }), material ? { material } : {}));

const worldOf = (children: Node[]): World => ({ layers: [layerNode("Default", children)], broom: { grid: -2, scale: 1 } });

// ---------------------------------------------------------------- the property grid

test("one node's rows are its own properties, typed by what it wrote", () => {
  const rows = rowsFor([lamp(4)]);
  assert.deepEqual(rows.map((r) => [r.name, r.type, r.written, r.mixed, r.inherited]), [
    ["intensity", "number", 1, false, false],
  ]);
  assert.equal(rows[0]!.value?.kind === "number" && rows[0]!.value.value, 4);
});

test("nodes that agree show the value; nodes that disagree show that they do", () => {
  const [a, b] = [rowsFor([lamp(4), lamp(4)])[0]!, rowsFor([lamp(4), lamp(9)])[0]!];
  assert.equal(a.mixed, false);
  assert.equal(a.value?.kind === "number" && a.value.value, 4);
  assert.equal(b.mixed, true);
  assert.equal(b.value, undefined, "showing the first one's value would make it everybody's");
  assert.equal(b.type, "number", "a mixed row still needs a box to type into");
  assert.equal(b.written, 2);
});

test("a property only some of them wrote is neither agreed nor inherited", () => {
  const row = rowsFor([lamp(4), entityNode("pointLight", { classes: ["lamp"] })])[0]!;
  assert.equal(row.written, 1);
  assert.equal(row.mixed, true, "one wrote 4 and one did not write it at all");
});

test("the definition's properties are listed first, greyed, at its own values", () => {
  const def = defByName(demoCatalogue(), "pointLight", "lamp")!;
  const rows = rowsFor([entityNode("pointLight", { classes: ["lamp"], props: setString([], "name", "torch") })], def);
  assert.deepEqual(rows.map((r) => r.name), ["color", "intensity", "distance", "castShadow", "name"]);
  const intensity = rows.find((r) => r.name === "intensity")!;
  assert.equal(intensity.inherited, true);
  assert.equal(intensity.written, 0);
  assert.equal(intensity.value?.kind === "number" && intensity.value.value, 12, "the template speaks for it");
  assert.equal(rows.at(-1)!.inherited, false, "and the node's own extra follows");
});

test("writing over an inherited property stops it being inherited", () => {
  const def = defByName(demoCatalogue(), "pointLight", "lamp")!;
  const row = rowsFor([lamp(4)], def).find((r) => r.name === "intensity")!;
  assert.equal(row.inherited, false);
  assert.equal(row.value?.kind === "number" && row.value.value, 4);
});

test("a definition is common only when every one of them is an instance of it", () => {
  const cat = demoCatalogue();
  assert.equal(commonDef(cat, [lamp(1), lamp(2)])?.name, "lamp");
  assert.equal(commonDef(cat, [lamp(1), entityNode("mesh", { classes: ["crate"] })]), undefined);
  assert.equal(commonDef(cat, [entityNode("mesh")]), undefined);
});

test("the header names what is selected without pretending it is one thing", () => {
  assert.equal(describeNodes([]), "nothing selected");
  assert.equal(describeNodes([lamp(1)]), "pointLight");
  assert.equal(describeNodes([lamp(1), lamp(2)]), "2 × pointLight");
  assert.equal(describeNodes([lamp(1), cube()]), "2 nodes");
  assert.equal(describeNodes([cube()]), "brush");
  assert.equal(describeNodes([groupNode("g")]), "group");
});

// ---------------------------------------------------------------- writing

test("one property set across a selection, and every other byte left alone", () => {
  const a = lamp(4);
  const b = entityNode("pointLight", { props: [...setNumber([], "intensity", 9), ...setString([], "name", "b")] });
  const world = setNodesProp(worldOf([a, b]), [a.id, b.id], "intensity", num(2));
  assert.equal(rowsFor([nodeById(world, a.id)!, nodeById(world, b.id)!])[0]!.mixed, false);
  const after = nodeById(world, b.id)!;
  assert.equal(after.props.length, 2, "its `name` is still there");
  assert.equal(after.props[1]!.kind === "prop" && after.props[1]!.name, "name", "and still in the order it was written");
});

test("a property removed comes back to whatever the definition said", () => {
  const def = defByName(demoCatalogue(), "pointLight", "lamp")!;
  const a = lamp(4);
  const world = removeNodesProp(worldOf([a]), [a.id], "intensity");
  const row = rowsFor([nodeById(world, a.id)!], def).find((r) => r.name === "intensity")!;
  assert.equal(row.inherited, true);
  assert.equal(row.value?.kind === "number" && row.value.value, 12);
});

test("renaming a property keeps its value and does not leave two of it behind", () => {
  const a = entityNode("mesh", { props: [...setString([], "targetname", "door"), ...setString([], "target", "old")] });
  const world = renameNodesProp(worldOf([a]), [a.id], "targetname", "target");
  const after = nodeById(world, a.id)!;
  assert.equal(after.props.length, 1);
  assert.equal(after.props[0]!.kind === "prop" && after.props[0]!.value.kind === "string" && after.props[0]!.value.value, "door");
  assert.equal(after.props[0]!.kind === "prop" && after.props[0]!.name, "target");
});

test("renaming a property nobody has changes nobody", () => {
  const a = lamp(4);
  const world = worldOf([a]);
  assert.deepEqual(nodeById(renameNodesProp(world, [a.id], "nope", "x"), a.id)!.props, a.props);
});

test("renaming to nothing, or to itself, is not a change", () => {
  const a = lamp(4);
  const world = worldOf([a]);
  assert.equal(renameNodesProp(world, [a.id], "intensity", ""), world);
  assert.equal(renameNodesProp(world, [a.id], "intensity", "intensity"), world);
});

test("a group's name is its own field, and only a group has one", () => {
  const g = groupNode("door switch");
  const world = renameNode(worldOf([g]), g.id, "lift");
  assert.equal((nodeById(world, g.id) as { name: string }).name, "lift");
  const c = cube();
  assert.equal(nodeById(renameNode(worldOf([c]), c.id, "x"), c.id)!.kind, "brush", "a solid has no name to change");
});

test("the #id and the classes are the head of the node, not its body", () => {
  const a = entityNode("mesh");
  let world = setSheetId(worldOf([a]), a.id, "door");
  assert.equal(nodeById(world, a.id)!.sheetId, "door");
  assert.deepEqual(sheetIds(world), ["door"]);
  world = setClasses(world, [a.id], ["crate", "heavy"]);
  assert.deepEqual(nodeById(world, a.id)!.classes, ["crate", "heavy"]);
  assert.deepEqual(nodeById(world, a.id)!.props, [], "and neither of them touched a property");
  world = setSheetId(world, a.id, "");
  assert.equal(nodeById(world, a.id)!.sheetId, undefined);
  assert.deepEqual(sheetIds(world), []);
});

test("every #id in the map is offered, however deep it is", () => {
  const inner = entityNode("mesh", { sheetId: "lamp" });
  const world = worldOf([groupNode("g", [inner]), entityNode("mesh", { sheetId: "door" })]);
  assert.deepEqual(sheetIds(world), ["lamp", "door"]);
});

// ---------------------------------------------------------------- faces

test("picked faces are the scope; with none picked it is every face of the picked solids", () => {
  const a = cube();
  const b = cube();
  const world = worldOf([a, b]);
  assert.equal(facesInScope(world, { ...NOTHING, nodes: [a.id, b.id] }).length, 12, "two cuboids, six faces each");
  assert.deepEqual(facesInScope(world, { ...NOTHING, faces: [{ node: a.id, face: 2 }] }), [{ node: a.id, face: 2 }]);
  assert.deepEqual(facesInScope(world, NOTHING), []);
});

test("a group's solids are in scope through the group", () => {
  const a = cube();
  const g = groupNode("g", [a]);
  assert.equal(facesInScope(worldOf([g]), { ...NOTHING, nodes: [g.id] }).length, 6);
});

test("the face inspector says what the faces agree on and where they do not", () => {
  const a = cube("wall");
  const world = worldOf([a]);
  const all = facesInScope(world, { ...NOTHING, nodes: [a.id] });
  const info = faceInfo(world, all)!;
  assert.equal(info.count, 6);
  assert.equal(info.material.value, "wall");
  assert.equal(info.material.mixed, false);
  assert.equal(info.rotation.mixed, false);
  assert.equal(info.only, undefined, "six faces is not one face to draw");

  const b = brushNode(withFace(a.brush, 0, { material: "stone", rotation: 0.5 }));
  const mixed = faceInfo(worldOf([b]), facesInScope(worldOf([b]), { ...NOTHING, nodes: [b.id] }))!;
  assert.equal(mixed.material.mixed, true);
  assert.equal(mixed.rotation.mixed, true);
  assert.equal(mixed.scale.mixed, false, "they still agree about the scale");
});

test("one face picked is the one the UV editor draws", () => {
  const a = cube();
  const world = worldOf([a]);
  const info = faceInfo(world, [{ node: a.id, face: 1 }])!;
  assert.equal(info.count, 1);
  assert.equal(info.only?.face, 1);
  assert.equal(uvPolygon(info.only!.brush, 1).length, 4, "a cuboid's face is a quadrilateral in tiles too");
});

test("a face that is not there is not asked about", () => {
  const a = cube();
  const world = worldOf([a]);
  assert.equal(faceInfo(world, [{ node: a.id, face: 99 }]), undefined);
  assert.equal(faceInfo(world, []), undefined);
});

// ---------------------------------------------------------------- the map

test("the map inspector counts what is there", () => {
  const world = worldOf([cube(), cube(), entityNode("pointLight"), groupNode("g", [cube()])]);
  assert.deepEqual(mapStats(world), { brushes: 3, entities: 1, groups: 1, layers: 1, faces: 18 });
});

report("inspect");
