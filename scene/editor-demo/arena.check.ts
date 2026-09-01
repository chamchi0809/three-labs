// The arena, checked without a GPU:
//   1. `tscene check` over both sheets — templates, @fields, materials, and whether every face bounds
//      something
//   2. the sheets load through the game's own `loadLevel`, and what comes out is the level the generator
//      described: 18 brushes, one spawn, six monsters, five pickups, entity values and all
//   3. the *geometry* holds up, which is the part nothing else would notice: a capsule dropped at the spawn
//      lands on the floor rather than through it, a wall stops it, and the ramp is climbable. The map's
//      collision is its brushes, so a ramp drawn at the wrong angle is a ramp nobody can walk up and there
//      is no error anywhere to say so.
// node --experimental-strip-types arena.check.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Group, Ray, Vector3 } from "three/webgpu";
import type { Snapshot } from "tscene-editor";
import { loadLevel } from "./src/game/level.ts";
import { feetOf, flatDistance } from "./src/game/physics.ts";
import { newPlayer, noInput, stepPlayer } from "./src/game/player.ts";
import { reachOf, spawnMonsters, stepMonsters } from "./src/game/monsters.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenes = path.join(here, "public", "scenes");

// ---------------------------------------------------------------- 1. the checker

const { status } = spawnSync(
  process.execPath,
  [path.join(here, "node_modules", "tscene", "dist", "cli.js"), "check", "public/scenes"],
  { cwd: here, stdio: "inherit" },
);
if (status) process.exit(status);

// ---------------------------------------------------------------- 2. the level loads

// The snapshot the editor hands to Play, made by hand: page-absolute keys, exactly as the editor stores
// them, and a `file:` base with the same path so the URL arithmetic in `level.ts` is the arithmetic the
// browser does. Nothing is read off disk again — the loader serves the project, which is the whole point of
// being handed one.
const project: Snapshot = {
  root: "/scenes/arena.tscene",
  files: {
    "/scenes/arena.tscene": fs.readFileSync(path.join(scenes, "arena.tscene"), "utf8"),
    "/scenes/library.tscene": fs.readFileSync(path.join(scenes, "library.tscene"), "utf8"),
  },
};

const level = await loadLevel(project, { base: "file:///scenes/arena.tscene" });

assert.deepEqual(
  level.root.children.map((o) => o.name),
  ["Architecture", "Lighting", "Gameplay"],
  "the three groups the generator writes, in order",
);

const meshes: any[] = [];
level.root.traverse((o: any) => void (o.isMesh && meshes.push(o)));
assert.equal(meshes.length, 18, `18 brushes: floor, four walls, four pillars, platform, ramp, parapet, two covers, four crates — got ${meshes.length}`);
// shadows belong to the level rather than to the game: a brush the designer drew casts and receives
assert.ok(meshes.every((m) => m.castShadow && m.receiveShadow), "every brush casts and receives");
assert.ok(
  meshes.every((m) => m.geometry.attributes.position.count > 0),
  "every brush came out with geometry",
);

// the spawn, and the facing the sheet gave it in degrees
assert.deepEqual(
  [level.spawn.at.x, level.spawn.at.y, level.spawn.at.z],
  [-16, 0, 16],
  "the spawn is in the far corner",
);
assert.ok(Math.abs(level.spawn.yaw - (-45 * Math.PI) / 180) < 1e-9, "facing: -45 arrives as radians");

// the monsters, which is where `entities(root, "monster")` earns its keep: a pickup is an entity too, and
// nothing but the template it was written with tells the two apart
assert.equal(level.monsters.length, 6);
const brutes = level.monsters.filter((m) => m.breed === "brute");
assert.equal(brutes.length, 2, "two brutes among the grunts");
assert.ok(brutes.every((m) => m.hp === 120 && m.damage === 18), "a brute's own @entity values, not the template's");
assert.ok(brutes.every((m) => Math.abs(m.speed - 2.2) < 1e-9), "a brute is slower than a grunt");
assert.ok(brutes.every((m) => m.sight === 18), "and sees further, which the arena says rather than the template");
const grunts = level.monsters.filter((m) => m.breed === "grunt");
assert.equal(grunts.length, 4);
// the template's defaults, inherited rather than repeated on every node
assert.ok(grunts.every((m) => m.hp === 40 && m.damage === 9 && m.sight === 14), "grunts take the template's numbers");

// the pickups, by kind
assert.equal(level.pickups.length, 5);
assert.deepEqual(
  level.pickups.map((p) => p.kind).sort(),
  ["cells", "health", "health", "shells", "shells"],
  "two of shells, two of health, one of cells",
);
assert.equal(level.pickups.find((p) => p.kind === "cells")!.amount, 40, "the cells are worth a plasma magazine");
assert.ok(level.pickups.every((p) => p.respawn === 0), "nothing respawns in a single-room arena");

// ---------------------------------------------------------------- 3. the geometry is walkable

// the floor is where the sheet put it: straight down from head height is five metres of nothing
const down = level.world.rayIntersect(new Ray(new Vector3(0, 5, 0), new Vector3(0, -1, 0)));
assert.ok(down, "the octree should see the floor from above it");
assert.ok(Math.abs(down.distance - 5) < 0.01, `the floor's top is at y = 0, so the drop is 5 — got ${down.distance}`);

const FIXED = 1 / 60;

/** hold a direction for a while and report where the body ended up */
function walk(from: Vector3, yaw: number, seconds: number, forward = 1) {
  const player = newPlayer(from, yaw);
  const input = { ...noInput(), forward };
  for (let i = 0; i < Math.round(seconds / FIXED); i++) stepPlayer(player, input, level.world, FIXED);
  return { x: player.body.start.x, z: player.body.start.z, feet: feetOf(player.body), onFloor: player.onFloor };
}

// dropped at the spawn and left alone: it lands, and it lands on the floor rather than in it
const stood = walk(level.spawn.at, level.spawn.yaw, 1, 0);
assert.ok(stood.onFloor, "a body dropped at the spawn should end up standing on something");
assert.ok(Math.abs(stood.feet) < 0.05, `standing on the floor means feet at y = 0 — got ${stood.feet}`);

// into the north wall at a run: it stops at the wall's face, and no further
const wall = walk(new Vector3(0, 0.2, -17), 0, 2);
assert.ok(wall.z > -20, `the wall is at z = -20 and a capsule has a radius — got z = ${wall.z}`);
assert.ok(wall.z < -18.5, `it should have travelled to the wall, not stalled at the spawn — got z = ${wall.z}`);

// up the ramp, which is the check that would catch a slope drawn as a step: forward is +x at yaw -90°
const climbed = walk(new Vector3(2.2, 0.4, -10), -Math.PI / 2, 2.5);
assert.ok(climbed.x > 5, `it should have made the platform at x = 5 — got x = ${climbed.x}`);
assert.ok(climbed.feet > 2, `the platform's top is at y = 2.4 — got feet at ${climbed.feet}`);

// ---------------------------------------------------------------- 4. the fight happens, at arm's length

/** stand somewhere for a while and report what the monsters made of it */
function fight(from: Vector3, seconds: number) {
  const monsters = spawnMonsters(level.monsters, new Group());
  const player = newPlayer(from, 0);
  const feet = new Vector3();
  let damage = 0;
  let hits = 0;
  let closest = Infinity;

  for (let i = 0; i < Math.round(seconds / FIXED); i++) {
    stepPlayer(player, noInput(), level.world, FIXED);
    feet.set(player.body.start.x, feetOf(player.body), player.body.start.z);
    stepMonsters(monsters, feet, level.world, FIXED, (d) => {
      damage += d;
      hits++;
    });
    // in units of its own reach, so a grunt and a brute are the same measurement
    for (const m of monsters) closest = Math.min(closest, flatDistance(m.body.start, feet) / reachOf(m));
  }

  return { damage, hits, closest, awake: monsters.filter((m) => m.awake).length };
}

// The spawn is a corner nothing can see into, and that is `sight` doing it rather than the game: with the
// template's 28 metres every monster in a 40-metre room woke up at once and three of them killed a player who
// had not finished reading the banner. Nobody notices you until you go and find them.
const corner = fight(level.spawn.at, 5);
assert.equal(corner.awake, 0, `the spawn should be out of everyone's sight — ${corner.awake} woke up`);
assert.equal(corner.damage, 0, "and nothing should be able to hit you there");

// Out in the room, four metres from the grunt at the middle: it comes, and it hits. A monster that never
// arrives is a level with no fight in it.
const open = fight(new Vector3(0, 0.4, -2), 10);
assert.ok(open.hits > 0, "ten seconds four metres from a grunt should get you hit");
// SWING is 1.1s, so ten seconds is nine swings from whoever is on you; more than that is a swing timer that
// is not counting down
assert.ok(open.hits <= 9 * level.monsters.length, `at most a swing a second each — got ${open.hits} hits`);
// and it may not arrive *all the way*. The octree is the level, so the player is not in it, and a monster
// that chases until it touches you ends up inside the camera, swinging from a place no shot can point at.
assert.ok(
  open.closest > 0.5,
  `a monster should hold at a swing's length, not walk into the camera — closest was ${open.closest.toFixed(2)} of its reach`,
);
assert.ok(
  open.closest < 1,
  `and it should still get close enough to swing — closest was ${open.closest.toFixed(2)} of its reach`,
);

console.log(
  `ok   arena.tscene builds and plays: ${meshes.length} brushes, ${level.monsters.length} monsters, ` +
    `${level.pickups.length} pickups, the ramp goes up, the spawn is quiet, and the middle of the room ` +
    `costs ${open.damage} health in ten seconds`,
);
