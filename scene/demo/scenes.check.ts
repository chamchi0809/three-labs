// Two checks over this demo's sheets, both without a GPU:
//   1. `tscene check`, told about the names loft.tscene gets from the registry
//   2. loft.tscene actually builds — the addon geometry, the registry materials and `barrier()` included
//      (main.tscene is left to the checker: building it would fetch a glTF)
// node --experimental-strip-types scenes.check.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DECLARED } from "./src/loft/declared.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sheet = path.join(here, "scenes", "loft.tscene");

const { status } = spawnSync(
  process.execPath,
  [path.join(here, "node_modules", "tscene", "dist", "cli.js"), "check", "scenes", ...DECLARED.flatMap((name) => ["--declare", name])],
  { cwd: here, stdio: "inherit" },
);
if (status) process.exit(status);

// ---------------------------------------------------------------- the sheet builds

// A sheet read off disk was never seen by the vite plugin, so it is handed three by hand. `tscene/addons`
// would cover the addon half, but its barrel reaches two jsdelivr URLs that node's loader refuses — so the
// one addon this sheet names is passed the same way a hand-picked class always is.
const { loadScene } = await import("tscene");
const { threeRegistry } = await import("tscene/three");
const { LoftGeometry } = await import("three/addons/geometries/LoftGeometry.js");
const { registry } = await import("./src/loft/registry.ts");

const root = await loadScene(fs.readFileSync(sheet, "utf8"), {
  base: pathToFileURL(sheet).href,
  registry: { ...threeRegistry, LoftGeometry, ...registry },
});

const named = (name: string) => {
  const found = root.getObjectByName(name);
  assert.ok(found, `the sheet should have built #${name}`);
  return found;
};

type Loft = { name: string; geometry: { type: string; parameters: { sections: unknown[]; closed: boolean } } };
const lofts: Loft[] = [];
root.traverse((o: any) => {
  if (o.isMesh && o.geometry?.type === "LoftGeometry") lofts.push(o);
});

// the sheet's own 23 lofts — 9 plinths, the curtain and 13 exhibits — plus the 28 the barrier builds
assert.equal(lofts.length, 51, `expected 51 lofts, got ${lofts.length}`);
assert.equal(lofts.filter((m) => m.name).length, 23);
assert.ok(lofts.every((m) => m.geometry.parameters.sections.length >= 2), "every loft keeps the sections it was skinned through");
// the options bag has to reach the geometry, or the ribbon is a tube and the cup has no bottom
assert.equal((named("ribbon") as any).geometry.parameters.closed, false);
assert.equal((named("shell") as any).geometry.parameters.closed, true);
assert.equal((named("cup") as any).geometry.parameters.capStart, true);

// the light only rotates if it is a sibling of the turntable, not a child
assert.deepEqual(root.children.map((o) => o.name), ["sun", "turntable"]);
assert.equal(named("turntable").children.length, 23);
// the pedestal template's calc() over the --x/--z each node declares: -10.5 * 0.7 + -10.5 * 1.3
assert.equal(named("vasePlinth").rotation.y, -21);
// a dotted path four segments deep, and a Vector2 assigned through copy()
assert.equal((named("sun") as any).shadow.camera.far, 110);
assert.equal((named("sun") as any).shadow.mapSize.x, 4096);

// a method call in a value body: `circleGeometry(58, 64) { rotateX(-90deg); }` lays the disc flat
const floor = (named("floor") as any).geometry.attributes.position;
assert.ok(
  Array.from({ length: floor.count }, (_, i) => Math.abs(floor.getY(i))).every((y) => y < 1e-6),
  "the floor disc should have been rotated into the xz plane",
);

// a node out of the registry, expanded by the host rather than by the language
assert.equal(named("turntable").children.filter((o) => o.type === "Group" && o.children.length === 28).length, 1);

// the two flat discs are the only meshes that do not cast
const dark: string[] = [];
root.traverse((o: any) => {
  if (o.isMesh && !o.castShadow) dark.push(o.name || "(anonymous)");
});
assert.deepEqual(dark.sort(), ["floor", "liquid"]);

console.log(`ok   scenes/loft.tscene builds: ${lofts.length} lofts, ${DECLARED.length} names out of the registry`);
