// Two checks over this demo's sheets, both without a GPU:
//   1. `tscene check`, told about the names loft.tscene gets from the registry
//   2. loft.tscene actually builds, and its cross sections come out where the example's JavaScript put
//      them — `each()`, `calc()` and `splineCurve(…).getPoints(n)` do the whole geometry
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

type Loft = { name: string; geometry: { type: string; parameters: { sections: unknown[]; closed: boolean } } };
const lofts: Loft[] = [];
const geometries = new Set<unknown>();
let points = 0;
root.traverse((o: any) => {
  if (!o.isMesh || o.geometry?.type !== "LoftGeometry") return;
  lofts.push(o);
  geometries.add(o.geometry);
  points += o.geometry.parameters.sections.length * o.geometry.parameters.sections[0].length;
});

// 23 lofts the sheet writes out, plus the barrier's 14 posts and 14 cords
assert.equal(lofts.length, 51, `expected 51 lofts, got ${lofts.length}`);
// …but only 25 geometries: `--stanchionGeometry` and `--ropeGeometry` are one AST node each, so one instance each
assert.equal(geometries.size, 25);
assert.ok(points > 100_000, `expected six figures of cross-section points, got ${points}`);
assert.ok(lofts.every((m) => m.geometry.parameters.sections.length >= 2), "every loft keeps the sections it was skinned through");

// each() and calc() against what the example's JavaScript produced
const named = (name: string) => {
  const found = root.getObjectByName(name);
  assert.ok(found, `the sheet should have built #${name}`);
  return found;
};
const rings = (name: string) => (named(name) as any).geometry.parameters.sections as { x: number; y: number; z: number }[][];
const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} !== ${b}`);

// the lathe: `splineCurve(--profile).getPoints(120)` is 121 rings of `--segments` points
assert.equal(rings("cup").length, 121);
assert.equal(rings("cup")[0]!.length, 64);
// …and the ring itself is sin/cos of j/count, at the profile point's radius
close(rings("cup")[0]![16]!.x, 0.2, "cup ring quarter turn");
close(rings("cup")[0]![16]!.z, 0, "cup ring quarter turn");
// the curtain's 480 points a ring, at radius 55 plus the folds
assert.equal(rings("curtain").length, 31);
assert.equal(rings("curtain")[0]!.length, 480);
close(rings("curtain")[0]![0]!.y, -5, "curtain hem");
// two-point sections, two units apart
assert.equal(rings("ribbon")[0]!.length, 2);
close(rings("ribbon")[7]![1]!.y - rings("ribbon")[7]![0]!.y, 2, "ribbon width");
// the star's rosette: (2.4 + 0.7 cos 5a) at a = 0, scaled by 1 - 0.35 sin(t pi)
close(rings("star")[0]![0]!.z, 3.1, "star lobe at the base");

// the options bag has to reach the geometry, or the ribbon is a tube and the cup has no bottom
assert.equal((named("ribbon") as any).geometry.parameters.closed, false);
assert.equal((named("shell") as any).geometry.parameters.closed, true);
assert.equal((named("cup") as any).geometry.parameters.capStart, true);
// `var(--capEnd, false)` — the vase asks for one cap and gets exactly one
assert.equal((named("vase") as any).geometry.parameters.capStart, true);
assert.equal((named("vase") as any).geometry.parameters.capEnd, false);

// the light only rotates if it is a sibling of the turntable, not a child
assert.deepEqual(root.children.map((o) => o.name), ["sun", "turntable"]);
assert.equal(named("turntable").children.length, 50);
// the pedestal template's calc() over the --x/--z each node declares: -10.5 * 0.7 + -10.5 * 1.3
assert.equal(named("vasePlinth").rotation.y, -21);
// a dotted path four segments deep, and a Vector2 assigned through copy()
assert.equal((named("sun") as any).shadow.camera.far, 110);
assert.equal((named("sun") as any).shadow.mapSize.x, 4096);

// repeat() + calc(): fourteen posts on a circle of radius 20, the first half a step round
const posts = named("turntable").children.filter((o) => o.name === "post");
assert.equal(posts.length, 14);
close(Math.hypot(posts[0]!.position.x, posts[0]!.position.z), 20, "the post ring's radius");
close(posts[0]!.position.x, Math.sin((0.5 / 14) * Math.PI * 2) * 20, "the first post's angle");
assert.ok(posts.every((o) => (o as any).geometry === (posts[0] as any).geometry), "the fourteen posts share one geometry");

// a method call in a value body: `circleGeometry(58, 64) { rotateX(-90deg); }` lays the disc flat
const floor = (named("floor") as any).geometry.attributes.position;
assert.ok(
  Array.from({ length: floor.count }, (_, i) => Math.abs(floor.getY(i))).every((y) => y < 1e-6),
  "the floor disc should have been rotated into the xz plane",
);

// the two flat discs are the only meshes that do not cast
const dark: string[] = [];
root.traverse((o: any) => {
  if (o.isMesh && !o.castShadow) dark.push(o.name || "(anonymous)");
});
assert.deepEqual(dark.sort(), ["floor", "liquid"]);

console.log(`ok   scenes/loft.tscene builds: ${lofts.length} lofts over ${points.toLocaleString("en")} section points, all of it from the sheet`);
