// The `@entity { … }` block: reading a level's data off a node, editing it, and getting it back out of a
// save as the same block it was written as.
// Run with: node --experimental-strip-types src/doc/entity.check.ts
import assert from "node:assert/strict";
import { parse } from "tscene";
import { report, test } from "../check.ts";
import { catalogueOfSheets, defFor, entityDefs, optionsFor } from "./catalogue.ts";
import { DEMO_SHEET, demoCatalogue, demoMap } from "./demo.ts";
import { entityNode } from "../tools/entity.ts";
import { childrenOf, type Node, type World } from "./document.ts";
import { entityRowsFor, removeNodesField, setNodesField, typeOfField } from "./inspect.ts";
import { num, str } from "./props.ts";
import { fieldOf, fieldsOf, removeField, renameField, setField } from "./entity.ts";
import { readWorld, type Sheets } from "../io/read.ts";
import { writeWorld, type Project } from "../io/write.ts";

const ROOT = "map.tscene";

const SHEET = `@template mesh.slime {
  @entity { hp: 30; speed: 2; boss: false };
}

mesh.slime #boss {
  position: vec3(4, 0, 2);
  @entity { hp: 300; boss: true };
}

mesh.slime #runt {
  position: vec3(1, 0, 1);
}
`;

const project = (text: string): { project: Project; world: World } => {
  const sheets: Sheets = new Map([[ROOT, parse(text, ROOT)]]);
  const { world } = readWorld(ROOT, sheets);
  return { project: { root: ROOT, sheets }, world };
};

const all = (node: Node): Node[] => [node, ...childrenOf(node).flatMap(all)];

const find = (world: World, sheetId: string): Node => {
  const hit = world.layers.flatMap(all).find((n) => n.sheetId === sheetId);
  if (!hit) throw new Error(`no node #${sheetId}`);
  return hit;
};

const saved = (world: World, p: Project): string => {
  const out = writeWorld(world, p);
  assert.deepEqual(out.problems, [], "a save reported problems");
  return out.files.get(ROOT)!;
};

// ---------------------------------------------------------------- the block itself

test("fields are read in the order the block wrote them", () => {
  const { world } = project(SHEET);
  assert.deepEqual(fieldsOf(find(world, "boss").props).map((f) => f.name), ["hp", "boss"]);
  assert.deepEqual(fieldsOf(find(world, "runt").props), [], "a node with no block carries no data");
});

test("setting, clearing and renaming a field leaves everything else in the body alone", () => {
  const { world } = project(SHEET);
  const boss = find(world, "boss");
  const set = setField(boss.props, "speed", num(0.5));
  assert.deepEqual(fieldsOf(set).map((f) => f.name), ["hp", "boss", "speed"], "a new field is appended");
  const again = setField(set, "hp", num(9));
  const hp = fieldOf(again, "hp");
  assert.equal(hp?.kind === "number" ? hp.value : undefined, 9);
  assert.deepEqual(fieldsOf(again).map((f) => f.name), ["hp", "boss", "speed"], "an old one keeps its place");
  assert.deepEqual(fieldsOf(renameField(set, "hp", "health")).map((f) => f.name), ["boss", "speed", "health"]);
  // the block goes away with its last field: `@entity { }` would leave a reader wondering
  const empty = ["hp", "boss"].reduce(removeField, boss.props);
  assert.deepEqual(fieldsOf(empty), []);
  assert.equal(empty.some((m) => m.kind === "at" && m.name === "entity"), false);
  assert.equal(empty.some((m) => m.kind === "prop" && m.name === "position"), true, "the rest of the body survived");
});

// ---------------------------------------------------------------- the grid

test("the definition's fields are shown greyed until an instance overrides one", () => {
  const { world } = project(SHEET);
  const catalogue = catalogueOfSheets([parse(SHEET, ROOT)]);
  const runt = find(world, "runt");
  const def = defFor(catalogue, runt);
  assert.ok(def, "the class names a template");
  assert.deepEqual(def.fields.map((f) => f.name), ["hp", "speed", "boss"]);

  assert.deepEqual(entityRowsFor([runt], def).map((r) => [r.name, r.written, r.inherited, r.type]), [
    ["hp", 0, true, "number"], ["speed", 0, true, "number"], ["boss", 0, true, "bool"],
  ]);

  assert.deepEqual(entityRowsFor([find(world, "boss")], def).map((r) => [r.name, r.written, r.inherited]), [
    ["hp", 1, false], ["speed", 0, true], ["boss", 1, false],
  ]);

  // two nodes that disagree show nothing rather than showing the first one's number
  const both = entityRowsFor([find(world, "boss"), runt], def);
  assert.deepEqual(both.find((r) => r.name === "hp"), {
    name: "hp", type: "number", written: 1, mixed: true, inherited: false, differs: true,
  });
});

// ---------------------------------------------------------------- the round trip

test("a save writes the block back and touches nothing else", () => {
  const { world, project: p } = project(SHEET);
  assert.equal(saved(world, p), SHEET, "reading and writing changed the file");

  const boss = find(world, "boss").id;
  const edited = removeNodesField(setNodesField(world, [boss], "drop", str("key")), [boss], "boss");
  const out = saved(edited, p);
  assert.match(out, /@entity \{ hp: 300; drop: "key" \};/);
  assert.match(out, /position: vec3\(4, 0, 2\);/, "the rest of the node is untouched");
  assert.equal(out.split("\n").length, SHEET.split("\n").length, "the block was patched, not appended to");
});

test("a node that had no block gets one", () => {
  const { world, project: p } = project(SHEET);
  const runt = find(world, "runt").id;
  assert.match(saved(setNodesField(world, [runt], "hp", num(5)), p), /#runt \{\n  position: vec3\(1, 0, 1\);\n  @entity \{ hp: 5 \};\n\}/);
});

// ---------------------------------------------------------------- an entity type and its declared fields

test("the demo sheet declares entity types, and a type's @fields drive the grid", () => {
  assert.deepEqual(parse(DEMO_SHEET, "demo.tscene").errors, [], "the demo sheet no longer parses");
  const catalogue = demoCatalogue();
  assert.deepEqual(catalogue.enums.damage, ["none", "fire", "ice", "holy"], "a --list of words is a set of choices");

  const defs = entityDefs(catalogue);
  assert.deepEqual(defs.map((d) => d.name), ["spawn", "monster", "sign"]);
  assert.deepEqual([...new Set(defs.map((d) => d.category))], ["gameplay", "story"], "the browser groups by these");
  for (const def of defs) assert.equal(def.node, "entity", `${def.name} is a mesh, not data`);

  const monster = defs.find((d) => d.name === "monster")!;
  assert.deepEqual(monster.declared.map((f) => f.type), ["int", "enum", "point", "color", "bool", "script"]);
  const hp = monster.declared.find((f) => f.name === "hp")!;
  assert.deepEqual([hp.min, hp.max], [1, 999]);
  // the choices come from the `--damage` list the field names, not from the field
  assert.deepEqual(optionsFor(catalogue, monster.declared.find((f) => f.name === "weakness")!), catalogue.enums.damage);
  assert.deepEqual(optionsFor(catalogue, hp), [], "a field with no choices offers none");
  assert.equal(demoCatalogue().objects.find((d) => d.name === "sign")!.declared.find((f) => f.name === "say")!.localized, true);
});

test("a declared field earns its editor even when the node has never been given a value", () => {
  const catalogue = demoCatalogue();
  const monster = entityDefs(catalogue).find((d) => d.name === "monster")!;
  const ogre = find(demoMap(), "ogre");
  assert.equal(ogre.kind === "object" && ogre.type, "entity", "the demo places data, not a mesh");
  const rows = entityRowsFor([ogre], monster, catalogue.enums);

  // `brain` has no default and no value on the node, and is a row anyway: the type says it exists
  assert.deepEqual(rows.map((r) => r.name), ["hp", "weakness", "patrol", "tint", "asleep", "brain"]);
  assert.deepEqual(rows.map((r) => r.type), ["number", "text", "vec3", "colour", "bool", "text"]);
  assert.deepEqual(rows.find((r) => r.name === "weakness")!.field?.options, catalogue.enums.damage);
  assert.deepEqual(rows.find((r) => r.name === "hp")!.field?.max, 999);
  assert.deepEqual(rows.find((r) => r.name === "brain")!.field?.type, "script");
  // the instance writes one of the six; the four with defaults are greyed, and `brain` is simply empty
  assert.deepEqual(rows.filter((r) => r.written).map((r) => r.name), ["hp"]);
  assert.deepEqual(rows.filter((r) => r.inherited).map((r) => r.name), ["weakness", "patrol", "tint", "asleep"]);
  assert.deepEqual(typeOfField({ name: "x", type: "float" }), "number");
});

test("a placed entity is a point with a box the size of nothing much", () => {
  const monster = entityDefs(demoCatalogue()).find((d) => d.name === "monster")!;
  const placed = entityNode([2, 0, -4], monster);
  assert.equal(placed.type, "entity");
  assert.deepEqual(placed.classes, ["monster"]);
  assert.deepEqual(placed.broom.size, [-0.2, -0.2, -0.2, 0.2, 0.2, 0.2], "a type with no size still gets clicked on");
  // one that declares a size keeps it — the editor only fills in what the definition left out
  const spawn = entityDefs(demoCatalogue()).find((d) => d.name === "spawn")!;
  assert.deepEqual(entityNode([0, 0, 0], spawn).broom.size, [-0.3, 0, -0.3, 0.3, 1.8, 0.3]);
});

report("entity");
