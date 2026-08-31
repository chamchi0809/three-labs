// Which sheet a set of files is the document of, and the one path the round-trip checks never covered:
// a map that was never read from a file at all, written into an empty sheet and read back.
// Run with: node --experimental-strip-types src/io/root.check.ts
import assert from "node:assert/strict";
import { parse } from "tscene";
import { report, test } from "../check.ts";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { brushNode, emptyWorld, entityNode, type World } from "../doc/document.ts";
import { setVec3 } from "../doc/props.ts";
import { readWorld, type Sheets } from "./read.ts";
import { importTarget, nameOf, rootOf } from "./root.ts";
import { writeWorld } from "./write.ts";

const sheetsOf = (files: Record<string, string>): Sheets => {
  const sheets: Sheets = new Map();
  for (const [file, text] of Object.entries(files)) sheets.set(file, parse(text, file));
  return sheets;
};

// ---------------------------------------------------------------- picking the root

test("one file is its own root", () => {
  assert.equal(rootOf(sheetsOf({ "hall.tscene": "" })), "hall.tscene");
});

test("the root is the sheet nobody imports, whichever order they were handed over in", () => {
  const files = {
    "props.tscene": "mesh #crate {}",
    "map.tscene": '@import "props.tscene";\ngroup #Hall {}',
  };
  assert.equal(rootOf(sheetsOf(files)), "map.tscene");

  // and the same set with the imported file listed first, because a file dialogue sorts alphabetically
  // and the answer must not depend on that
  assert.equal(
    rootOf(sheetsOf({ "props.tscene": files["props.tscene"], "map.tscene": files["map.tscene"] })),
    "map.tscene",
  );
});

test("an import that names a folder still points at the file that was opened", () => {
  const root = rootOf(
    sheetsOf({
      "parts/props.tscene": "mesh #crate {}",
      "map.tscene": '@import "parts/props.tscene";',
    }),
  );
  assert.equal(root, "map.tscene");
});

test("an import written relative to its own file still finds it, by name", () => {
  // the keys are relative to the folder that was opened; the `@import` is relative to the file it is in
  const root = rootOf(
    sheetsOf({
      "parts/props.tscene": "mesh #crate {}",
      "parts/map.tscene": '@import "props.tscene";',
    }),
  );
  assert.equal(root, "parts/map.tscene");
});

test("a cycle has no unimported sheet, and still has to answer", () => {
  const root = rootOf(
    sheetsOf({ "a.tscene": '@import "b.tscene";', "map.tscene": '@import "a.tscene";' }),
  );
  assert.equal(root, "map.tscene", "nothing is unimported, so the conventional name wins");
});

test("nothing at all is an untitled document rather than a crash", () => {
  assert.equal(rootOf(new Map()), "untitled.tscene");
});

test("a file name is the last segment, either way a path can be spelled", () => {
  assert.equal(nameOf("parts/props.tscene"), "props.tscene");
  assert.equal(nameOf("C:\\maps\\hall.tscene"), "hall.tscene");
  assert.equal(nameOf("hall.tscene"), "hall.tscene");
});

test("only an @import is an import", () => {
  const sheet = parse('@import "props.tscene";\n@broom { grid: -2 };\nmesh #crate {}', "map.tscene");
  const targets = sheet.statements.map(importTarget).filter(Boolean);
  assert.deepEqual(targets, ["props.tscene"]);
});

// ---------------------------------------------------------------- a map that came from nowhere

/** what `newMap` does: a document read from an empty sheet, so its layer is the file itself */
const freshWorld = (): World => readWorld("untitled.tscene", sheetsOf({ "untitled.tscene": "" })).world;

/** and what `save as` then does to it */
const savedFresh = (world: World): string => {
  const sheets = sheetsOf({ "untitled.tscene": "" });
  const out = writeWorld(world, { root: "untitled.tscene", sheets });
  assert.deepEqual(out.problems, [], "writing a fresh map reported problems");
  return out.files.get("untitled.tscene")!;
};

test("an empty map saves to an empty file, because a file with nothing in it means the defaults", () => {
  assert.equal(savedFresh(freshWorld()).trim(), "");
});

test("a new map's layer is the sheet, not a group written around everything in it", () => {
  // `emptyWorld()` is the document model's empty world and its layer is a real, origin-less one; the
  // difference is the whole reason `newMap` opens an empty sheet rather than calling it
  assert.equal(freshWorld().layers[0]!.origin?.isFile, true);
  assert.equal(emptyWorld().layers[0]!.origin, undefined);
  assert.match(savedFresh(emptyWorld()).trim(), /^group #Default/);
});

test("a map built from nothing writes a file that reads back as the same map", () => {
  const brush = brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [4, 2, 6] }), { material: "wall" }));
  const lamp = entityNode("pointLight", { props: setVec3([], "position", [2, 1.5, 3]) });
  const fresh = freshWorld();
  const world: World = {
    layers: [{ ...fresh.layers[0]!, children: [brush, lamp] }],
    broom: { grid: -3, scale: 1 },
  };

  const text = savedFresh(world);
  assert.match(text, /@broom/, "a grid off the default is written down");
  assert.match(text, /brush/);
  assert.match(text, /pointLight/);

  const back = readWorld("untitled.tscene", sheetsOf({ "untitled.tscene": text })).world;
  assert.equal(back.broom.grid, -3, "the grid survived the trip");

  const kinds = back.layers.flatMap((l) => l.children.map((c) => c.kind));
  assert.deepEqual(kinds.sort(), ["brush", "entity"]);

  const solid = back.layers[0]!.children.find((c) => c.kind === "brush")!;
  assert.equal(solid.kind, "brush");
  const verts = solid.brush.poly.vertices;
  const xs = verts.map((v) => v[0]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 4], "and so did the geometry");
});

test("saving twice in a row is idempotent, which is what makes a save safe to hit twice", () => {
  const brush = brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [1, 1, 1] })));
  const fresh = freshWorld();
  const world: World = {
    layers: [{ ...fresh.layers[0]!, children: [brush] }],
    broom: { grid: -2, scale: 1 },
  };

  const once = savedFresh(world);
  const back = readWorld("untitled.tscene", sheetsOf({ "untitled.tscene": once }));
  const twice = writeWorld(back.world, {
    root: "untitled.tscene",
    sheets: sheetsOf({ "untitled.tscene": once }),
  });
  assert.deepEqual(twice.problems, []);
  assert.equal(twice.files.get("untitled.tscene"), once, "the second save changed nothing");
});

// ---------------------------------------------------------------- saving the same map twice

test("a save is a patch of the bytes the tree was read from, and stays one however often it is run", () => {
  // the rule `Held.text` exists to keep. A save's edits are offsets into the text the origins were taken
  // from, so the baseline is the bytes that were *read* — never the bytes the last save wrote. A store
  // that moves its baseline forward patches the new text at the old offsets and shreds the file; here that
  // would show up as the second answer differing from the first.
  const src = '// the hall\n@broom { grid: -3 };\n\ngroup #Hall {\n  mesh #crate {\n    position: vec3(1, 0, 0);\n  }\n}\n';
  const baseline = () => sheetsOf({ "map.tscene": src });

  const read = readWorld("map.tscene", baseline());
  // a top-level `group` is the sheet's own layer, so the crate is a child of it rather than of a group
  const hall = read.world.layers[0]!;
  const crate = hall.children[0]!;
  assert.equal(crate.kind, "entity");
  const moved = {
    ...read.world,
    layers: [{ ...hall, children: [{ ...crate, props: setVec3(crate.props, "position", [2, 0, 0]) }] }],
  };

  const once = writeWorld(moved, { root: "map.tscene", sheets: baseline() });
  const twice = writeWorld(moved, { root: "map.tscene", sheets: baseline() });
  assert.deepEqual(once.problems, []);
  assert.equal(twice.files.get("map.tscene"), once.files.get("map.tscene"));

  const text = once.files.get("map.tscene")!;
  assert.match(text, /^\/\/ the hall/, "the comment above the map is not the editor's to remove");
  assert.match(text, /position: vec3\(2, 0, 0\)/, "and the edit is in there");
  assert.equal(text.match(/;;/), null, "nothing was patched twice");
});

test("a @broom the sheet already has is left alone when nothing in it changed", () => {
  // `scale` defaults to one, and a save that helpfully writes it down is a save that touches every map
  const src = "@broom { grid: -3 };\n\nmesh #crate {}\n";
  const sheets = sheetsOf({ "map.tscene": src });
  const out = writeWorld(readWorld("map.tscene", sheetsOf({ "map.tscene": src })).world, {
    root: "map.tscene",
    sheets,
  });
  assert.equal(out.files.get("map.tscene"), src, "an untouched map is not a map to rewrite");
});

report("project");
