/**
 * Textures the editor can draw before a project has any.
 *
 * The demo map is a sheet with no directory behind it — nothing on disk to point a `texture("./brick.png")`
 * at — and the shaded look has nothing to show without one. Committing a folder of PNGs to demonstrate a
 * shader is the usual answer and it is a bad one: binaries in a repository that only exist so a demo has
 * something to look at, and a build step to generate them if they are not.
 *
 * So a url of the form `broom:brick/map` is answered here instead, out of arithmetic. Three slots come from
 * one height field — the albedo, the normal map and the height map are all derived from the same brick
 * pattern, which is the thing that makes them line up perfectly and is exactly what a real authoring tool
 * is doing when it exports the set. It costs a few milliseconds at startup and nothing on disk.
 *
 * The moment a real project is opened these disappear: {@link sampleTexture} answers `broom:` and nothing
 * else, and every other url goes to the loader like any other file.
 */
import {
  DataTexture, LinearFilter, LinearMipmapLinearFilter, LinearSRGBColorSpace, RGBAFormat, RepeatWrapping,
  SRGBColorSpace, UnsignedByteType,
} from "three/webgpu";

/** the scheme a generated texture is named with — one word, so it cannot be mistaken for a relative path */
export const SCHEME = "broom:";

const SIZE = 256;

/** the patterns there are. Two is enough to tell a wall from a floor, which is all a demo has to do */
export type Pattern = "brick" | "tile";

/** which of a pattern's three derived images is wanted */
export type Slot = "map" | "normal" | "height";

/**
 * The layout of a pattern: how many cells across and down one tile is, and whether alternate rows are
 * offset by half a cell. Brick bond and a tile grid differ in that one boolean and nothing else.
 */
const PATTERNS: Record<Pattern, { cols: number; rows: number; stagger: boolean; mortar: number }> = {
  brick: { cols: 4, rows: 8, stagger: true, mortar: 0.007 },
  tile: { cols: 4, rows: 4, stagger: false, mortar: 0.005 },
};

/** how much of a cell's width the bevel from mortar up to face takes — a hard edge reads as a printed line */
const BEVEL = 0.006;

// ---------------------------------------------------------------- the field

const fract = (x: number): number => x - Math.floor(x);

/** a stable hash in [0, 1). Deterministic, because a texture that differed between reloads would be a bug */
function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** value noise, for the grain that keeps a face from reading as a flat rectangle of colour */
function grain(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

type Sample = { height: number; cell: number };

/**
 * The pattern at one point of the tile: how high the surface is there, and which cell it belongs to.
 *
 * Height is what everything else is built from, which is the point of doing it this way — the normal map is
 * its slope and the albedo is a colour chosen by where in the height it sits, so the three can no more
 * disagree with each other than a number can disagree with itself.
 */
function sampleAt(pattern: Pattern, u: number, v: number): Sample {
  const { cols, rows, stagger, mortar } = PATTERNS[pattern];
  const fy = v * rows;
  const row = Math.floor(fy);
  const fx = u * cols + (stagger && row % 2 ? 0.5 : 0);
  const col = Math.floor(fx);

  // distance to the nearest cell edge, back in tile units so one mortar width means one width both ways
  const lx = fract(fx);
  const ly = fract(fy);
  const edge = Math.min(Math.min(lx, 1 - lx) / cols, Math.min(ly, 1 - ly) / rows);

  const cell = hash(col, row);
  // the face of the cell, its own thickness, and a little roughness over the whole thing
  const face = smoothstep(mortar, mortar + BEVEL, edge);
  const sits = 1 - cell * 0.12;
  const rough = grain(u * 90, v * 90) * 0.06 + grain(u * 300, v * 300) * 0.03;
  return { height: Math.min(1, Math.max(0, face * sits - (1 - face) * 0.05 + rough * face)), cell };
}

// ---------------------------------------------------------------- the images

const BRICK: [number, number, number][] = [
  [0.55, 0.28, 0.22], [0.48, 0.24, 0.19], [0.6, 0.34, 0.26], [0.42, 0.22, 0.19], [0.52, 0.31, 0.25],
];
const TILE: [number, number, number][] = [
  [0.62, 0.62, 0.6], [0.55, 0.56, 0.56], [0.68, 0.67, 0.63], [0.5, 0.51, 0.52], [0.59, 0.58, 0.55],
];
const MORTAR: [number, number, number] = [0.3, 0.29, 0.27];

/** the albedo: a colour per cell, the mortar between them, and the height's own shading dropped in */
function albedo(pattern: Pattern): Uint8Array {
  const palette = pattern === "brick" ? BRICK : TILE;
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const { height, cell } = sampleAt(pattern, (x + 0.5) / SIZE, (y + 0.5) / SIZE);
      const base = palette[Math.floor(cell * palette.length) % palette.length]!;
      const at = (y * SIZE + x) * 4;
      // the surface's own value is folded in lightly: enough that the grain is visible, not so much that
      // it double-counts the shading the normal map is about to do
      const shade = 0.85 + height * 0.15;
      for (let c = 0; c < 3; c++) {
        data[at + c] = Math.round(255 * Math.min(1, (MORTAR[c]! + (base[c]! - MORTAR[c]!) * height) * shade));
      }
      data[at + 3] = 255;
    }
  }
  return data;
}

/** the height map, straight out of the field: white is the top of the brick, black is the mortar */
function relief(pattern: Pattern): Uint8Array {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const { height } = sampleAt(pattern, (x + 0.5) / SIZE, (y + 0.5) / SIZE);
      const at = (y * SIZE + x) * 4;
      const v = Math.round(height * 255);
      data[at] = v;
      data[at + 1] = v;
      data[at + 2] = v;
      data[at + 3] = 255;
    }
  }
  return data;
}

/**
 * The normal map, as the slope of the same field.
 *
 * Central differences across one texel, in tangent space with +y up — the convention three's `normalMap`
 * expects. The far tier of the height material has nothing but this to work with, so a normal map that
 * came from somewhere other than the height field would be a wall that changed shape as you walked
 * towards it.
 */
function slope(pattern: Pattern): Uint8Array {
  const field = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      field[y * SIZE + x] = sampleAt(pattern, (x + 0.5) / SIZE, (y + 0.5) / SIZE).height;
    }
  }
  const wrap = (n: number) => (n + SIZE) % SIZE;
  const at = (x: number, y: number) => field[wrap(y) * SIZE + wrap(x)]!;

  const data = new Uint8Array(SIZE * SIZE * 4);
  // how tall the relief is relative to one texel; a bigger number is a steeper-looking surface
  const scale = SIZE * 0.06;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * scale;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * scale;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * SIZE + x) * 4;
      data[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((1 / len) * 0.5 * 255 + 127.5);
      data[i + 3] = 255;
    }
  }
  return data;
}

// ---------------------------------------------------------------- handing them out

const made = new Map<string, DataTexture>();

/**
 * The texture a `broom:` url names, or `undefined` for anything else.
 *
 * Cached by url and never disposed. There are six of them at most and they are what the palette rebuilds
 * against every time the look is toggled — regenerating a quarter of a megabyte of brick because a
 * material was rebuilt would be a stutter with nothing to show for it.
 */
export function sampleTexture(url: string): DataTexture | undefined {
  if (!url.startsWith(SCHEME)) return undefined;
  const found = made.get(url);
  if (found) return found;

  const [name, slot = "map"] = url.slice(SCHEME.length).split("/");
  if (!name || !(name in PATTERNS)) return undefined;
  const pattern = name as Pattern;

  const data =
    slot === "normal" ? slope(pattern) : slot === "height" ? relief(pattern) : albedo(pattern);
  const texture = new DataTexture(data, SIZE, SIZE, RGBAFormat, UnsignedByteType);
  // only the albedo carries a colour; a normal or a height read through an sRGB curve is a wrong number
  texture.colorSpace = slot === "map" ? SRGBColorSpace : LinearSRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.name = url;
  texture.needsUpdate = true;
  made.set(url, texture);
  return texture;
}

/** the urls the demo sheet is written against, so a check can assert they all resolve */
export const SAMPLES: string[] = (Object.keys(PATTERNS) as Pattern[]).flatMap((p) =>
  (["map", "normal", "height"] as Slot[]).map((s) => `${SCHEME}${p}/${s}`),
);
