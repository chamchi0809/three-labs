// Material declarations written back into a sheet: added, edited, renamed, deleted — and everything the
// editor has no box for left exactly as it was typed.
// Run with: node --experimental-strip-types src/io/materials.check.ts
import assert from "node:assert/strict";
import { parse, type Sheet } from "tscene";
import { report, test } from "../check.ts";
import { catalogueOfSheets, materialByName } from "../doc/catalogue.ts";
import { cleanName, freeName, materialEdits, newMaterial, type MaterialDraft } from "./materials.ts";
import { applyEdits } from "./patch.ts";

const SHEET = `@broom { grid: -2; }

--floor: heightMaterial {
  map: texture("./floor.png");
  heightMap: texture("./floor-h.png");
  depth: 0.02;
  // the sheet's own business, and none of the editor's
  side: DoubleSide;
}
--plaster: meshStandardMaterial {
  color: color(#d8d3c8);
  roughness: 0.9;
}

mesh #wall {}
`;

/** the sheet with a set of drafts written into it, and what it says afterwards */
function written(text: string, drafts: Record<string, MaterialDraft>): { text: string; sheet: Sheet } {
  const sheets = new Map([["map.tscene", parse(text, "map.tscene")]]);
  const edits = materialEdits(sheets, "map.tscene", new Map(Object.entries(drafts)));
  const out = applyEdits(text, edits.get("map.tscene") ?? []);
  assert.deepEqual(out.problems, [], "the edits must not overlap");
  const sheet = parse(out.text, "map.tscene");
  assert.deepEqual(sheet.errors, [], "what a save writes has to parse");
  return { text: out.text, sheet };
}

const read = (sheet: Sheet, name: string) => materialByName(catalogueOfSheets([sheet]), name);

// ---------------------------------------------------------------- editing

test("a changed number rewrites its line and nothing else", () => {
  const was = read(parse(SHEET, "map.tscene"), "plaster")!;
  const { text, sheet } = written(SHEET, { plaster: { ...was, roughness: 0.4 } });
  assert.equal(read(sheet, "plaster")!.roughness, 0.4);
  // one line moved; the rest of the file is the file
  assert.equal(text.replace("roughness: 0.4", "roughness: 0.9"), SHEET);
});

test("a property the editor has no box for survives an edit", () => {
  const was = read(parse(SHEET, "map.tscene"), "floor")!;
  const { text } = written(SHEET, { floor: { ...was, depth: 0.05 } });
  assert.ok(text.includes("side: DoubleSide;"), "the sheet's own settings are not the editor's to drop");
  assert.ok(text.includes("// the sheet's own business"), "and neither are its comments");
  assert.equal(read(parse(text, "map.tscene"), "floor")!.depth, 0.05);
});

test("a property that was not there is added to the body it belongs in", () => {
  const was = read(parse(SHEET, "map.tscene"), "plaster")!;
  const { sheet } = written(SHEET, { plaster: { ...was, metalness: 0.5, maps: { map: "./p.png" } } });
  const now = read(sheet, "plaster")!;
  assert.equal(now.metalness, 0.5);
  assert.equal(now.maps.map, "./p.png");
  assert.equal(now.roughness, 0.9, "and what was already there stays");
});

test("a property cleared is taken out of the declaration", () => {
  const was = read(parse(SHEET, "map.tscene"), "plaster")!;
  const { text, sheet } = written(SHEET, { plaster: { ...was, colour: undefined } });
  assert.equal(read(sheet, "plaster")!.colour, undefined);
  assert.ok(!text.includes("#d8d3c8"));
});

test("a material type changed rewrites the head and keeps the body", () => {
  const was = read(parse(SHEET, "map.tscene"), "plaster")!;
  const { sheet } = written(SHEET, { plaster: { ...was, type: "meshPhysicalMaterial" } });
  const now = read(sheet, "plaster")!;
  assert.equal(now.type, "meshPhysicalMaterial");
  assert.equal(now.roughness, 0.9);
});

// ---------------------------------------------------------------- renaming, adding, deleting

test("a rename moves the declaration rather than making a second one", () => {
  const was = read(parse(SHEET, "map.tscene"), "plaster")!;
  const { text, sheet } = written(SHEET, { plaster: { ...was, name: "stucco" } });
  assert.ok(read(sheet, "stucco"));
  assert.equal(read(sheet, "plaster"), undefined);
  assert.equal(sheet.statements.filter((s) => s.kind === "var").length, 2);
  assert.ok(text.includes("roughness: 0.9"), "a rename is not a reprint");
});

test("a new material is declared beside the others, not after the map", () => {
  const { text, sheet } = written(SHEET, { brick: { ...newMaterial("brick"), colour: 0x804020 } });
  const now = read(sheet, "brick")!;
  assert.equal(now.type, "meshStandardMaterial");
  assert.equal(now.colour, 0x804020);
  assert.ok(text.indexOf("--brick") < text.indexOf("mesh #wall"), "declarations belong above the map");
});

test("a material added to an empty sheet is the whole of it", () => {
  const { sheet } = written("", { brick: newMaterial("brick") });
  assert.ok(read(sheet, "brick"));
});

test("a deleted material takes its comment and its line with it", () => {
  const { text, sheet } = written(SHEET, { floor: null });
  assert.equal(read(sheet, "floor"), undefined);
  assert.ok(read(sheet, "plaster"), "and leaves its neighbour alone");
  assert.ok(!text.includes("DoubleSide"));
  assert.ok(!text.includes("\n\n\n"), "no hole where it was");
});

test("deleting one and editing another in the same save is one clean patch", () => {
  const was = read(parse(SHEET, "map.tscene"), "plaster")!;
  const { sheet } = written(SHEET, { floor: null, plaster: { ...was, roughness: 0.1 } });
  assert.equal(read(sheet, "floor"), undefined);
  assert.equal(read(sheet, "plaster")!.roughness, 0.1);
});

test("a draft for a declaration that is not there and is deleted writes nothing", () => {
  const { text } = written(SHEET, { ghost: null });
  assert.equal(text, SHEET);
});

// ---------------------------------------------------------------- names

test("a name is a --var name, whatever was typed", () => {
  assert.equal(cleanName("  red brick "), "red-brick");
  assert.equal(cleanName("wall#2"), "wall-2");
  assert.equal(freeName(["material1", "material2"]), "material3");
});

report("materials");
