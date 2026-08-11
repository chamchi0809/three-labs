// Sanity check for the generated level geometry: `pnpm --filter demo check`.
// The rooms and corridors are derived from a height grid, so a bad constant shows
// up as a cliff in a ramp, a prop standing over the void or inside a wall, or a
// doorway that never got cut. ponytail: one script, no test runner.
import {
  CRATES,
  FLOOR_REGIONS,
  LAMPS,
  PILLARS,
  PLAYER_START,
  SHAPE_SPOTS,
  WALLS,
  floorHeightAt,
  // Extension is literal because node runs this file directly, unbundled.
} from './src/level.ts';

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const SPACING = 16;
const AXIS = [-SPACING, 0, SPACING];
const ROOM_CENTERS = AXIS.flatMap((z) => AXIS.map((x) => ({ x, z })));

// 9 room plates and the 12 corridors joining them.
check(FLOOR_REGIONS.length === 21, `expected 21 regions, got ${FLOOR_REGIONS.length}`);
check(
  floorHeightAt(PLAYER_START.x, PLAYER_START.z) ===
    Math.max(...FLOOR_REGIONS.map((region) => region.height)),
  'player does not start on the highest floor',
);

// Walking between neighbours is continuous: each corridor meets both rooms at
// their own height with no step at either plate seam.
for (const room of ROOM_CENTERS) {
  for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
    const to = { x: room.x + dx * SPACING, z: room.z + dz * SPACING };
    if (!ROOM_CENTERS.some((other) => other.x === to.x && other.z === to.z)) continue;
    let previous = floorHeightAt(room.x, room.z);
    for (let step = 1; step <= 64; step++) {
      const t = step / 64;
      const height = floorHeightAt(room.x + (to.x - room.x) * t, room.z + (to.z - room.z) * t);
      check(
        Math.abs(height - previous) < 0.35,
        `cliff on the ${room.x},${room.z} -> ${to.x},${to.z} ramp: ${previous} -> ${height}`,
      );
      previous = height;
    }
    check(previous === floorHeightAt(to.x, to.z), `ramp to ${to.x},${to.z} misses the room`);
  }
}

// Horizontal reach of the largest spinning shape, whatever angle it is at.
const SHAPE_REACH = 1.4;
const PROPS = [
  ...CRATES.map((crate) => ({ x: crate.x, z: crate.z, r: crate.s / 2 })),
  ...PILLARS.map((pillar) => ({ x: pillar.x, z: pillar.z, r: pillar.r })),
  ...LAMPS.map((lamp) => ({ x: lamp.x, z: lamp.z, r: lamp.radius })),
  ...SHAPE_SPOTS.map((spot) => ({ x: spot.x, z: spot.z, r: SHAPE_REACH })),
];
for (const prop of PROPS) {
  check(
    FLOOR_REGIONS.some(
      (region) =>
        prop.x >= region.x0 && prop.x <= region.x1 && prop.z >= region.z0 && prop.z <= region.z1,
    ),
    `prop at ${prop.x},${prop.z} stands over the void`,
  );
  for (const wall of WALLS) {
    const dx = Math.max(wall.x - wall.w / 2 - prop.x, 0, prop.x - (wall.x + wall.w / 2));
    const dz = Math.max(wall.z - wall.d / 2 - prop.z, 0, prop.z - (wall.z + wall.d / 2));
    check(dx * dx + dz * dz >= prop.r * prop.r, `prop at ${prop.x},${prop.z} is inside a wall`);
  }
  // Props are placed off their room's center lines, which are the doorway routes,
  // and must leave the player room to walk past on either side of them.
  const lane = (value: number) => Math.abs(value - Math.round(value / SPACING) * SPACING);
  check(
    Math.min(lane(prop.x), lane(prop.z)) - prop.r >= 0.8,
    `prop at ${prop.x},${prop.z} narrows a doorway lane`,
  );
}

// Every room's center lines run out through a doorway where it has a neighbour,
// and into solid wall where it does not.
for (const room of ROOM_CENTERS) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const hasNeighbour = ROOM_CENTERS.some(
      (other) => other.x === room.x + dx * SPACING && other.z === room.z + dz * SPACING,
    );
    let blocked = false;
    for (let distance = 0; distance <= 6.5; distance += 0.25) {
      const x = room.x + dx * distance;
      const z = room.z + dz * distance;
      blocked ||= WALLS.some(
        (wall) =>
          Math.abs(x - wall.x) < wall.w / 2 - 0.01 && Math.abs(z - wall.z) < wall.d / 2 - 0.01,
      );
    }
    check(
      blocked === !hasNeighbour,
      `lane out of ${room.x},${room.z} toward ${dx},${dz}: blocked=${blocked}, neighbour=${hasNeighbour}`,
    );
  }
}

const steepest = Math.max(
  ...FLOOR_REGIONS.map((region) => Math.max(Math.abs(region.slopeX), Math.abs(region.slopeZ))),
);
check(steepest <= 0.55, `ramp too steep to walk: ${steepest}`);

console.log(
  `ok - ${FLOOR_REGIONS.length} regions, ${WALLS.length} walls, ${PROPS.length} props, ` +
    `steepest ramp ${(Math.atan(steepest) * 180) / Math.PI | 0} degrees`,
);
