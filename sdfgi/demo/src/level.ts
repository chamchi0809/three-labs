// A 3x3 grid of separate square rooms, each at its own floor height and walled
// in on its own, joined to its neighbours by short sloping corridors. There is no
// outer enclosure: everything outside a room or a corridor is void, so the level
// reads as nine buildings on a dark plain rather than one partitioned hall.
//
//        x-        x0        x+
//   z-  [4.2] === [2.4] === [3.6]
//          |         |         |
//   z0  [3.0] === [1.2] === [2.0]
//          |         |         |
//   z+  [1.2] === [1.8] === [0.0]
//
// A room is a 10x10 interior inside a 1-thick wall ring, standing on a 12x12
// plate so the ring has plate under it. Its only openings are the doorways its
// corridors pierce. A corridor is a 4-wide walkway with its own 1-thick walls,
// spanning the 4 units of void between two rooms' plates and meeting each at that
// room's own height, so the whole walkable surface is one connected set and every
// step between neighbours is a visible climb or drop.
//
// Walls take both their top and their base from the floor beneath each of their
// corners: a fixed rise above it and a plate thickness below it. A corridor's
// walls therefore run down the corridor's slope with it, and no wall ever floats
// over the void beside its plate.
//
// The RC solve estimates the floor locally, so the corridors and all four levels
// read as open ground while walls, crates and pillars occlude. Every wall is 1
// unit thick, so its solid rim closes over its whole footprint and no wall top
// reads as a floor level of its own.

/** Walkable floor plate: an axis-aligned rect with a constant gradient. */
export interface FloorRegion {
  /** Rect bounds. Regions abut exactly and never overlap. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Floor height at the (x0, z0) corner. */
  height: number;
  /** Gradient in world units of rise per unit of x / z. */
  slopeX: number;
  slopeZ: number;
}

/** Half-thickness of a floor plate, so plates read as platforms edge-on. */
export const FLOOR_THICKNESS = 1.2;

/** Thickness of every wall, thin enough that the RC mask reads it solid through. */
const WALL_T = 1;
/** Half-extent of a room's walkable interior, and of its plate. */
const ROOM_HALF = 5;
const PLATE_HALF = ROOM_HALF + WALL_T;
/** Half-width of a corridor's walkway, and of the plate carrying its walls. */
const DOOR_HALF = 2;
const LANE_HALF = DOOR_HALF + WALL_T;
/** Void a corridor crosses between two neighbouring plates. */
const VOID_SPAN = 4;
/** Distance between neighbouring room centers, on both axes. */
const SPACING = 2 * PLATE_HALF + VOID_SPAN;

/** Rooms per axis. */
const GRID = 3;
/**
 * Floor height per room, in row-major order from (x-, z-). Neighbours differ by
 * at most 2, which a VOID_SPAN-long corridor takes at 27 degrees — steep enough
 * to read as a ramp, shallow enough that its far wall does not hide it.
 */
const HEIGHTS = [
  4.2, 2.4, 3.6,
  3.0, 1.2, 2.0,
  1.2, 1.8, 0.0,
];

interface RoomDef {
  /** Center of the room, which every corridor into it runs along. */
  x: number;
  z: number;
  height: number;
}

const ROOMS: RoomDef[] = HEIGHTS.map((height, index) => ({
  x: ((index % GRID) - (GRID - 1) / 2) * SPACING,
  z: (Math.floor(index / GRID) - (GRID - 1) / 2) * SPACING,
  height,
}));

interface CorridorDef {
  /** Axis of travel. `from` is always the room lower on that axis. */
  axis: 'x' | 'z';
  from: number;
  to: number;
}

/** One corridor to each room's higher-x and higher-z neighbour, where it has one. */
const CORRIDORS: CorridorDef[] = ROOMS.flatMap((_, index) => {
  const corridors: CorridorDef[] = [];
  if (index % GRID < GRID - 1) {
    corridors.push({ axis: 'x', from: index, to: index + 1 });
  }
  if (index + GRID < ROOMS.length) {
    corridors.push({ axis: 'z', from: index, to: index + GRID });
  }
  return corridors;
});

/** The void span a corridor crosses: between the two rooms' plate edges. */
function corridorRun(corridor: CorridorDef): { lo: number; hi: number } {
  return {
    lo: ROOMS[corridor.from]![corridor.axis] + PLATE_HALF,
    hi: ROOMS[corridor.to]![corridor.axis] - PLATE_HALF,
  };
}

/** The coordinate a corridor runs along, which is its rooms' shared center. */
function corridorLane(corridor: CorridorDef): number {
  const room = ROOMS[corridor.from]!;
  return corridor.axis === 'x' ? room.z : room.x;
}

function buildFloorRegions(): FloorRegion[] {
  const regions: FloorRegion[] = [];
  for (const room of ROOMS) {
    regions.push({
      x0: room.x - PLATE_HALF,
      x1: room.x + PLATE_HALF,
      z0: room.z - PLATE_HALF,
      z1: room.z + PLATE_HALF,
      height: room.height,
      slopeX: 0,
      slopeZ: 0,
    });
  }
  for (const corridor of CORRIDORS) {
    const { lo, hi } = corridorRun(corridor);
    const lane = corridorLane(corridor);
    // Both rooms' plates already reach their own wall rings, so the corridor
    // plate only has to cross the void, and its ends meet those plates at
    // exactly the rooms' heights.
    const from = ROOMS[corridor.from]!.height;
    const slope = (ROOMS[corridor.to]!.height - from) / (hi - lo);
    regions.push(
      corridor.axis === 'x'
        ? {
            x0: lo, x1: hi, z0: lane - LANE_HALF, z1: lane + LANE_HALF,
            height: from, slopeX: slope, slopeZ: 0,
          }
        : {
            x0: lane - LANE_HALF, x1: lane + LANE_HALF, z0: lo, z1: hi,
            height: from, slopeX: 0, slopeZ: slope,
          },
    );
  }
  return regions;
}

export const FLOOR_REGIONS: FloorRegion[] = buildFloorRegions();

/**
 * Walkable floor height at a world point. Points off the walkable set — inside a
 * wall, out in the void where stray bullets and laser rays end up — resolve
 * against the nearest plate, so props and effects never fall through the level
 * and a wall reads the level it stands on.
 */
export function floorHeightAt(x: number, z: number): number {
  let bestRegion = FLOOR_REGIONS[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const region of FLOOR_REGIONS) {
    const dx = Math.max(region.x0 - x, 0, x - region.x1);
    const dz = Math.max(region.z0 - z, 0, z - region.z1);
    const distance = dx * dx + dz * dz;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRegion = region;
      if (distance === 0) break;
    }
  }
  const clampedX = Math.min(Math.max(x, bestRegion.x0), bestRegion.x1);
  const clampedZ = Math.min(Math.max(z, bestRegion.z0), bestRegion.z1);
  return (
    bestRegion.height +
    bestRegion.slopeX * (clampedX - bestRegion.x0) +
    bestRegion.slopeZ * (clampedZ - bestRegion.z0)
  );
}

/**
 * Solid block, impassable at every floor level. It stands on the floor under it:
 * its top a fixed `rise` above that floor and its base a plate thickness below
 * it, taken at each of its four corners. A wall along a corridor therefore runs
 * down the corridor's slope, and one beside a plate edge ends flush with that
 * plate instead of hanging into the void.
 */
export interface WallBox {
  x: number;
  z: number;
  w: number;
  d: number;
  rise: number;
}

/** Height of a pillar above the floor it stands on. */
export const PILLAR_HEIGHT = 3;
/**
 * Rise of a wall above the floor at its foot. The camera looks down at about 35
 * degrees, where a wall hides some 1.4 times its own height behind it, so much
 * taller than this and a corridor's far wall would cover the corridor's floor.
 */
const WALL_RISE = 2.6;

function footprint(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
): Omit<WallBox, 'rise'> {
  return {
    x: (x0 + x1) / 2,
    z: (z0 + z1) / 2,
    w: x1 - x0,
    d: z1 - z0,
  };
}

/** What is left of `[lo, hi]` after the doorways are taken out of it. */
function gapless(
  lo: number,
  hi: number,
  gaps: Array<[number, number]>,
): Array<[number, number]> {
  const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
  const segments: Array<[number, number]> = [];
  let cursor = lo;
  for (const [gapLo, gapHi] of sorted) {
    if (gapLo > cursor) segments.push([cursor, gapLo]);
    cursor = Math.max(cursor, gapHi);
  }
  if (cursor < hi) segments.push([cursor, hi]);
  return segments;
}

function buildWalls(): WallBox[] {
  const walls: WallBox[] = [];
  for (const [index, room] of ROOMS.entries()) {
    const x0 = room.x - PLATE_HALF;
    const x1 = room.x + PLATE_HALF;
    const z0 = room.z - PLATE_HALF;
    const z1 = room.z + PLATE_HALF;
    // Doorway spans, gathered per face. A corridor running in x pierces the
    // room's x-facing wall on the side its other room lies, leaving a gap along
    // z centered on the corridor's lane.
    const doors: Record<'xLow' | 'xHigh' | 'zLow' | 'zHigh', Array<[number, number]>> =
      { xLow: [], xHigh: [], zLow: [], zHigh: [] };
    for (const corridor of CORRIDORS) {
      if (corridor.from !== index && corridor.to !== index) continue;
      const other =
        ROOMS[corridor.from === index ? corridor.to : corridor.from]!;
      const face = other[corridor.axis] > room[corridor.axis] ? 'High' : 'Low';
      const lane = corridorLane(corridor);
      doors[`${corridor.axis}${face}`].push([lane - DOOR_HALF, lane + DOOR_HALF]);
    }
    // The x-facing walls run the plate's full depth and the z-facing walls its
    // full width, so each corner is covered twice rather than left open.
    for (const [lo, hi] of gapless(z0, z1, doors.xLow)) {
      walls.push({ ...footprint(x0, x0 + WALL_T, lo, hi), rise: WALL_RISE });
    }
    for (const [lo, hi] of gapless(z0, z1, doors.xHigh)) {
      walls.push({ ...footprint(x1 - WALL_T, x1, lo, hi), rise: WALL_RISE });
    }
    for (const [lo, hi] of gapless(x0, x1, doors.zLow)) {
      walls.push({ ...footprint(lo, hi, z0, z0 + WALL_T), rise: WALL_RISE });
    }
    for (const [lo, hi] of gapless(x0, x1, doors.zHigh)) {
      walls.push({ ...footprint(lo, hi, z1 - WALL_T, z1), rise: WALL_RISE });
    }
  }
  // Each corridor's two walls, on the outer strip of its own plate, so they end
  // flush with it and the walkway between them is DOOR_HALF * 2 wide.
  for (const corridor of CORRIDORS) {
    const { lo, hi } = corridorRun(corridor);
    const lane = corridorLane(corridor);
    for (const side of [-1, 1]) {
      const a = lane + side * DOOR_HALF;
      const b = lane + side * LANE_HALF;
      walls.push({
        ...(corridor.axis === 'x'
          ? footprint(lo, hi, Math.min(a, b), Math.max(a, b))
          : footprint(Math.min(a, b), Math.max(a, b), lo, hi)),
        rise: WALL_RISE,
      });
    }
  }
  return walls;
}

export const WALLS: WallBox[] = buildWalls();

export interface CrateDef {
  x: number;
  z: number;
  s: number;
}

// Props sit in the room corners, clear of the doorway bands that run along each
// room's center lines, so every route through stays open. Crates and pillars
// alternate room by room to keep neighbouring rooms reading differently.
export const CRATES: CrateDef[] = ROOMS.flatMap((room, index) =>
  index % 2 === 0
    ? [
        { x: room.x - 3.4, z: room.z + 3.4, s: 1.5 },
        { x: room.x - 1.9, z: room.z + 3.3, s: 1.4 },
        { x: room.x - 3.1, z: room.z + 1.9, s: 1.1 },
      ]
    : [],
);

export interface PillarDef {
  x: number;
  z: number;
  r: number;
}

export const PILLARS: PillarDef[] = ROOMS.flatMap((room, index) =>
  index % 2 === 1
    ? [
        { x: room.x + 3.3, z: room.z + 3.3, r: 0.6 },
        { x: room.x + 3.3, z: room.z - 3.3, r: 0.5 },
      ]
    : [],
);

export interface LampDef {
  x: number;
  z: number;
  color: number;
  intensity: number;
  radius: number;
  /** Length of the lamp along y. Defaults to a floor lamp's 1.4. */
  height?: number;
  /** Center of the lamp above the floor. Defaults to standing on it. */
  y?: number;
}

/** One color per room, so a room is recognisable by the light it throws. */
const LAMP_COLORS = [
  0xff8830, 0x22ccff, 0xee44cc,
  0x88ee33, 0xffdd44, 0xff3322,
  0x44ffcc, 0x3344ff, 0xff5aa0,
];

// One lamp per room, in the corner the room's props leave free, so each room is
// lit from inside and the drop to its neighbours is visible from within it.
const ROOM_LAMPS: LampDef[] = ROOMS.map((room, index) => ({
  x: room.x + (index % 2 === 0 ? 1 : -1) * (ROOM_HALF - 1.2),
  z: room.z - (ROOM_HALF - 1.2),
  color: LAMP_COLORS[index]!,
  intensity: 11,
  radius: 0.6,
}));

/** A hue wheel, one step per corridor, distinct from the rooms' own colors. */
const CORRIDOR_COLORS = [
  0xff4444, 0xff9933, 0xffdd33, 0xaaff33, 0x44ff66, 0x33ffcc,
  0x33ddff, 0x3388ff, 0x7755ff, 0xbb55ff, 0xff55dd, 0xff5588,
];

/** Offset of a sconce from its corridor's lane: all but touching the wall face. */
const SCONCE_OFFSET = DOOR_HALF - 0.2;
/**
 * Height of a sconce's center above the corridor floor. Above the walkway and
 * above the laser, below the WALL_RISE top of the wall it hangs on, so its light
 * still stops at that wall instead of washing over the void beside it.
 */
const SCONCE_Y = 1.6;

/**
 * A tiny light on each of a corridor's two walls, level with a walker's head.
 * They sit at the middle of the run, where the ramp is halfway between its rooms,
 * so the slope is lit from the side and reads as a slope. Both walls of a corridor
 * share one color, so a corridor is identifiable by its light alone.
 */
const CORRIDOR_SCONCES: LampDef[] = CORRIDORS.flatMap((corridor, index) => {
  const { lo, hi } = corridorRun(corridor);
  const middle = (lo + hi) / 2;
  const lane = corridorLane(corridor);
  return [-1, 1].map((side) => ({
    ...(corridor.axis === 'x'
      ? { x: middle, z: lane + side * SCONCE_OFFSET }
      : { x: lane + side * SCONCE_OFFSET, z: middle }),
    color: CORRIDOR_COLORS[index % CORRIDOR_COLORS.length]!,
    intensity: 6,
    radius: 0.16,
    height: 0.34,
    y: SCONCE_Y,
  }));
});

export const LAMPS: LampDef[] = [...ROOM_LAMPS, ...CORRIDOR_SCONCES];

/**
 * Where the demo's spinning shapes stand: the corner each room's crates, pillars
 * and lamp leave free, on the diagonal so the doorway lanes stay open. Rooms with
 * two free corners alternate between them, so the shapes are not all on one side
 * of the level.
 */
export const SHAPE_SPOTS: Array<{ x: number; z: number }> = ROOMS.map(
  (room, index) => {
    // A crate room keeps its z+ side; a pillar room keeps its x+ side.
    const corner =
      index % 2 === 1
        ? { x: -1, z: 1 }
        : index % 4 === 0
          ? { x: 1, z: 1 }
          : { x: -1, z: -1 };
    return { x: room.x + corner.x * 3.4, z: room.z + corner.z * 3.4 };
  },
);

/** Height of a shape's center above the floor: clear of the walkway, low enough
 * that its own shadow lands beside it rather than off in the void. */
export const SHAPE_HEIGHT = 1.5;

/** Center of the highest room. */
export const PLAYER_START = ROOMS.reduce((highest, room) =>
  room.height > highest.height ? room : highest,
);
