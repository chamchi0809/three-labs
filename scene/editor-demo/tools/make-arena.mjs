// The seed for public/scenes/arena.tscene: a table of solids and entities, printed as brushes.
//
// node tools/make-arena.mjs
//
// A brush is its faces, and a face is three points counter-clockwise seen from *outside* — which is a fine
// thing to hold in a file and a terrible thing to type. Six faces of three points each is eighteen numbers
// whose only invariant is a winding nobody can see, and getting one of them backwards produces a solid that
// bounds no volume and renders as nothing. So the boxes and ramps of the arena are written here as two
// corners, and the winding is derived once, here, by arithmetic that `arena.check.ts` then verifies by
// loading the sheet and measuring what came out.
//
// This is a seed, not a source. The editor owns the sheet from the first save — it rewrites the exact bytes
// of the file it read, and running this again would throw away everything drawn since. It is checked in so
// that "how were these numbers arrived at" has an answer, and so a wrecked arena can be started again.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- the arena

/** height of the walls, and of everything that wants to reach the top of them */
const H = 8;

/**
 * Solids, as two opposite corners.
 *
 * `up` makes one a ramp instead of a box: the solid rises along +x from the low corner's height to the high
 * corner's, which is what the arena has instead of steps. A step is only climbable by a capsule when it is
 * shorter than the capsule's radius, so a staircase built out of boxes at any readable scale is a wall.
 */
const SOLIDS = [
  { name: "floor", box: [[-20, -1, -20], [20, 0, 20]], material: "floor", top: "floor" },

  { name: "wallNorth", box: [[-21, 0, -21], [21, H, -20]], material: "wall" },
  { name: "wallSouth", box: [[-21, 0, 20], [21, H, 21]], material: "wall" },
  { name: "wallWest", box: [[-21, 0, -20], [-20, H, 20]], material: "wall" },
  { name: "wallEast", box: [[20, 0, -20], [21, H, 20]], material: "wall" },

  { name: "pillarNW", box: [[-11, 0, -11], [-9, H, -9]], material: "metal" },
  { name: "pillarNE", box: [[9, 0, -11], [11, H, -9]], material: "metal" },
  { name: "pillarSW", box: [[-11, 0, 9], [-9, H, 11]], material: "metal" },
  { name: "pillarSE", box: [[9, 0, 9], [11, H, 11]], material: "metal" },

  // the high ground, and the one way up onto it
  { name: "platform", box: [[5, 0, -18], [18, 2.4, -5]], material: "stone", top: "floor" },
  { name: "ramp", box: [[2, 0, -12], [5, 2.4, -8]], up: true, material: "stone" },
  { name: "parapet", box: [[5, 2.4, -6], [18, 3.2, -5]], material: "trim" },

  // waist-high cover, so the middle of the room is not a shooting gallery
  { name: "coverWest", box: [[-16, 0, -2], [-4, 1.4, -1]], material: "stone", top: "trim" },
  { name: "coverEast", box: [[4, 0, 1], [16, 1.4, 2]], material: "stone", top: "trim" },

  { name: "crateA", box: [[-9, 0, 7], [-7.5, 1.5, 8.5]], material: "crate" },
  { name: "crateB", box: [[-7.5, 0, 7], [-6, 1.5, 8.5]], material: "crate" },
  { name: "crateC", box: [[-9, 1.5, 7], [-7.5, 3, 8.5]], material: "crate" },
  { name: "crateD", box: [[12, 0, 13], [13.5, 1.5, 14.5]], material: "crate" },
];

/** where the player comes in: `facing` is degrees about Y, and 0 looks down -Z the way three does */
const SPAWN = { at: [-16, 0, 16], facing: -45 };

const MONSTERS = [
  { name: "grunt1", at: [0, 0, -6], breed: "grunt" },
  { name: "grunt2", at: [-13, 0, -13], breed: "grunt" },
  { name: "grunt3", at: [13, 0, 8], breed: "grunt" },
  { name: "grunt4", at: [6, 0, 16], breed: "grunt" },
  { name: "brute1", at: [11, 2.4, -12], breed: "brute", hp: 120, speed: 2.2, damage: 18 },
  { name: "brute2", at: [-17, 0, -4], breed: "brute", hp: 120, speed: 2.2, damage: 18 },
];

const PICKUPS = [
  { name: "shells1", at: [-16, 0, 12], kind: "shells", amount: 16 },
  { name: "shells2", at: [8, 2.4, -16], kind: "shells", amount: 16 },
  { name: "cells1", at: [16, 0, -1], kind: "cells", amount: 40 },
  { name: "health1", at: [-8, 0, 4], kind: "health", amount: 25 },
  { name: "health2", at: [15, 0, 17], kind: "health", amount: 25 },
];

const LAMPS = [[-10, 6.5, -10], [10, 6.5, -10], [-10, 6.5, 10], [10, 6.5, 10]];

// ---------------------------------------------------------------- brush arithmetic

/** a number as a sheet should read it: no exponent, no trailing zeroes, no `-0` */
const n = (v) => {
  const r = Math.round(v * 1e4) / 1e4;
  return String(r === 0 ? 0 : r);
};

const vec3 = ([x, y, z]) => `vec3(${n(x)}, ${n(y)}, ${n(z)})`;

/**
 * The six planes of an axis-aligned box, each wound counter-clockwise seen from outside.
 *
 * Derived rather than remembered: for a face on `x = x1` the outward normal is +x, and three points wound
 * so that `(p1 - p0) × (p2 - p0)` comes out along +x are the ones below. The same reasoning, six times.
 */
function boxFaces([x0, y0, z0], [x1, y1, z1]) {
  return {
    "+x": [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
    "-x": [[x0, y0, z0], [x0, y1, z1], [x0, y1, z0]],
    "+y": [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],
    "-y": [[x0, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    "+z": [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1]],
    "-z": [[x0, y0, z0], [x1, y1, z0], [x1, y0, z0]],
  };
}

/**
 * A ramp: the box, with its top face replaced by a plane through the low edge and the high one.
 *
 * Four faces, not six. The top is the slope, and the low end goes with it — where the wedge tapers to a
 * line the box's own `-x` plane touches the solid without cutting anything off it, and tscene calls that
 * out ("this face bounds nothing") rather than letting a redundant plane sit in the file. The faces that
 * stay keep the box's planes: a plane is a plane whether or not the three points picked on it survive the
 * intersection, and the winding is the only thing that has to be right.
 */
function rampFaces([x0, y0, z0], [x1, y1, z1]) {
  const faces = boxFaces([x0, y0, z0], [x1, y1, z1]);
  delete faces["+y"];
  delete faces["-x"];
  // through (x0, y0) and (x1, y1): wound so the normal comes out up and back, which is out of a ramp
  faces.slope = [[x0, y0, z0], [x0, y0, z1], [x1, y1, z1]];
  return faces;
}

// ---------------------------------------------------------------- printing

function brush(solid) {
  const faces = solid.up ? rampFaces(...solid.box) : boxFaces(...solid.box);
  const lines = Object.entries(faces).map(([which, points]) => {
    // the top of a floor is what the player sees most of, and it is the one face worth naming separately
    const material = (which === "+y" || which === "slope") && solid.top ? solid.top : solid.material;
    return `    face(${points.map(vec3).join(", ")}) { material: var(--${material}); }`;
  });
  // the level says its solids take part in the lighting, so both the editor's view and the game's get
  // the same room; a game switching shadows on by itself would be the game deciding what the level looks like
  return `  brush #${solid.name} {\n    castShadow: true;\n    receiveShadow: true;\n${lines.join("\n")}\n  }`;
}

const monster = (m) =>
  `  entity.monster #${m.name} {\n` +
  `    position: ${vec3(m.at)};\n` +
  `    @entity { breed: "${m.breed}";${m.hp ? ` hp: ${m.hp}; speed: ${m.speed}; damage: ${m.damage};` : ""} }\n` +
  `  }`;

const pickup = (p) =>
  `  entity.pickup #${p.name} {\n` +
  `    position: ${vec3(p.at)};\n` +
  `    @entity { kind: "${p.kind}"; amount: ${p.amount}; }\n` +
  `  }`;

const lamp = (at, i) => `  pointLight.lamp #lamp${i + 1} { position: ${vec3(at)}; }`;

const sheet = `// The arena: one room, four pillars, a platform with a ramp up to it, and the six monsters that
// live there. Seeded by tools/make-arena.mjs and owned by the editor from the first save — the numbers came
// from a table, and everything after that comes from dragging.
//
// Nothing in here is about the game's rules. The architecture is brushes, the lights are three's own, and
// every gameplay decision — where the player starts, what a brute has for hit points — is an \`@entity\`
// block whose shape \`library.tscene\` declares. Which is the arrangement worth having: this file is a level,
// and it is the same level whether it is being walked through or dragged around.
@import "./library.tscene";

group #Architecture {
${SOLIDS.map(brush).join("\n")}
}

group #Lighting {
  ambientLight(#3b4a63, 0.9)
  // the sun, and the only shadow caster: a room with five shadow maps in it is a room that runs at 30fps
  directionalLight #sun(#ffe6c4, 2.4) {
    position: vec3(14, 22, 18);
    castShadow: true;
    shadow.mapSize: vec2(2048, 2048);
    shadow.camera.left: -28;
    shadow.camera.right: 28;
    shadow.camera.top: 28;
    shadow.camera.bottom: -28;
    shadow.camera.far: 80;
    shadow.bias: -0.0008;
  }
${LAMPS.map(lamp).join("\n")}
}

group #Gameplay {
  entity.spawn #start {
    position: ${vec3(SPAWN.at)};
    @entity { facing: ${SPAWN.facing}; }
  }
${MONSTERS.map(monster).join("\n")}
${PICKUPS.map(pickup).join("\n")}
}
`;

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "scenes", "arena.tscene");
writeFileSync(out, sheet);
console.log(`wrote ${out}: ${SOLIDS.length} solids, ${MONSTERS.length} monsters, ${PICKUPS.length} pickups`);
