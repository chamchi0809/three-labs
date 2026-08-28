/**
 * The shader graphs the editor draws itself with.
 *
 * Three ideas run through all of them.
 *
 * **Appearance comes out of an attribute, not out of a material.** Every batch carries a one-float `flag`
 * per vertex, and these graphs read it as a bit field. That is what lets the whole map be one draw call
 * while every face is separately selectable: highlighting is a buffer write, never a material swap.
 *
 * **The grid is drawn on the faces, in the fragment shader.** TrenchBroom does this and it is the single
 * biggest reason its viewports read as *space* rather than as floating polygons — a line that lies on the
 * floor tells you where the floor is, and a line drawn in front of it does not. Screen derivatives keep it
 * one pixel wide whether the camera is a metre away or a hundred, which is the only way a grid stays
 * legible in a perspective view.
 *
 * **Picking is a render, not a ray cast.** The pick graph writes the solid's ordinal and the face index
 * into a colour buffer, and a click reads one pixel. It costs the same with ten solids as with ten
 * thousand, and — the part that matters more — it agrees with the picture exactly, because it *is* the
 * picture. A ray cast can disagree with what the eye sees; a pixel read cannot.
 */
import {
  LineBasicNodeMaterial, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PointsNodeMaterial,
} from "three/webgpu";
import type { Node } from "three/webgpu";
import {
  attribute, bitAnd, cameraPosition, color, float, floor, fwidth, int, max, mix, mod, normalWorld,
  positionWorld, select, smoothstep, uniform, vec3, vec4,
} from "three/tsl";
import { FACE_SELECTED, HOVERED, LOCKED, OUTSIDE, SELECTED } from "./batch.ts";

// ---------------------------------------------------------------- the palette

/**
 * The editor's own colours, which are not the map's.
 *
 * Selection is a warm red because that is what every brush editor since Worldcraft has used and a level
 * designer's hands already know it. Everything else is chosen to stay legible against both a lit map and
 * an unlit one.
 */
export const COLOURS = {
  face: 0x9a9a9e,
  edge: 0x24242a,
  selected: 0xd0402f,
  faceSelected: 0xff6a3d,
  hovered: 0xffc14d,
  locked: 0x5c6470,
  outside: 0x6a6a72,
  grid: 0x14141a,
  axisX: 0xd0402f,
  axisY: 0x4caf50,
  axisZ: 0x3f7fd0,
  handle: 0xf0f0f4,
  link: 0x62c2a8,
  guide: 0xffc14d,
} as const;

// ---------------------------------------------------------------- reading the flags

const flag = /*@__PURE__*/ attribute<"float">("flag", "float");
const pick = /*@__PURE__*/ attribute<"vec2">("pick", "vec2");

/**
 * How much of one flag bit is set, as 0 or 1.
 *
 * The bit field arrives as a float because a vertex attribute is the cheapest thing there is and floats
 * are what every backend agrees on; `int()` is where it becomes a number with bits in it again.
 */
const has = (bit: number) => select(bitAnd(int(flag), int(bit)).greaterThan(int(0)), float(1), float(0));

/**
 * A base colour put through everything the flags say about it, in the order a designer expects to see:
 * lock and out-of-group first because they are about what is *reachable*, then selection, then hover on
 * top because hover is feedback about right now and must never be hidden by state.
 */
function tinted(base: Node<"color">) {
  let out = mix(base, color(COLOURS.outside), has(OUTSIDE).mul(0.55));
  out = mix(out, color(COLOURS.locked), has(LOCKED).mul(0.7));
  out = mix(out, color(COLOURS.selected), has(SELECTED).mul(0.55));
  out = mix(out, color(COLOURS.faceSelected), has(FACE_SELECTED).mul(0.75));
  out = mix(out, color(COLOURS.hovered), has(HOVERED).mul(0.35));
  return out;
}

// ---------------------------------------------------------------- the grid

export const newGridUniforms = (size = 1) => ({
  /** metres between lines; the editor's `[` and `]` step it by powers of two */
  size: uniform(size),
  /** how strongly the lines are drawn, so a designer can turn them down without turning them off */
  strength: uniform(0.4),
  /** metres at which lines have faded out entirely — kept in step with the far plane */
  reach: uniform(400),
});

export type GridUniforms = ReturnType<typeof newGridUniforms>;

/** the three components of a vec3 node, so the axis loops below can be written once */
const axes = <T extends { x: unknown; y: unknown; z: unknown }>(node: T): [T["x"], T["y"], T["z"]] => [
  node.x, node.y, node.z,
];

/**
 * How much of this pixel is grid line, for a plane of any orientation.
 *
 * The trick is `fwidth`: dividing the distance-to-the-nearest-line by how fast that distance changes
 * across one pixel converts metres into pixels, and a line thresholded in pixels is a line that is one
 * pixel wide at every distance. Without it a grid either disappears into the distance or moirés into a
 * grey smear, and both make a viewport unreadable.
 *
 * All three axes are computed and the one the face is facing is weighted out — its planes are parallel to
 * the face and would paint the whole surface. Weighting rather than branching keeps a face that is nearly
 * axis-aligned from popping as it turns.
 */
function gridCoverage(size: Node<"float">) {
  const cells = positionWorld.div(size);
  // distance to the nearest line, in cells, then in pixels
  const away = axes(cells.sub(0.5).fract().sub(0.5).abs().div(fwidth(cells).max(1e-6)));
  const facing = axes(normalWorld.abs());

  const lines = away.map((d, i) =>
    // a unit normal can only be near 1 on one axis, so this drops exactly the useless one
    smoothstep(1.4, 0.4, d).mul(smoothstep(1.0, 0.7, facing[i]!)),
  );
  return max(max(lines[0]!, lines[1]!), lines[2]!);
}

/** the world axis lines, which answer "which way is north" without a compass being looked at */
function axisInk() {
  const p = axes(positionWorld);
  const facing = axes(normalWorld.abs());
  return p.map((coord, i) =>
    smoothstep(1.6, 0.4, coord.abs().div(fwidth(coord).max(1e-6))).mul(smoothstep(1.0, 0.7, facing[i]!)),
  );
}

/**
 * The grid as it is actually drawn: the working size, a heavier line every eighth cell, and the world axes
 * in their own colours over both. The subdivision is what makes a size legible without counting — eight
 * cells is a glance.
 */
function gridInk(grid: GridUniforms) {
  const fine = gridCoverage(grid.size).mul(0.45);
  const major = gridCoverage(grid.size.mul(8)).mul(0.9);
  const [ax, ay, az] = axisInk();

  const axis = max(max(ax, ay), az);
  const tint = mix(
    color(COLOURS.grid),
    mix(mix(color(COLOURS.axisX), color(COLOURS.axisY), ay), color(COLOURS.axisZ), az),
    axis,
  );

  // lines fade out with distance rather than aliasing into noise at the horizon
  const eye = positionWorld.sub(cameraPosition).length();
  const near = float(1).sub(smoothstep(grid.reach.mul(0.4), grid.reach, eye));
  return { amount: max(max(fine, major), axis).mul(grid.strength).mul(near), tint };
}

// ---------------------------------------------------------------- the materials

/**
 * The brush faces.
 *
 * Standard rather than basic even in the "classic" look, because a map with no shading at all reads as one
 * flat blue-grey mass and a designer cannot tell a wall from a floor. M12 replaces the colour node with
 * real PBR and the Height Material; the flag and grid parts of this graph survive that unchanged, which is
 * why they are written as separate pieces here.
 */
export function faceMaterial(grid: GridUniforms): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  const { amount, tint } = gridInk(grid);
  material.colorNode = mix(tinted(color(COLOURS.face)), tint, amount);
  material.name = "broom:face";
  return material;
}

/** the wireframe, pushed a hair toward the camera so an edge is never buried inside its own face */
export function edgeMaterial(): LineBasicNodeMaterial {
  const material = new LineBasicNodeMaterial({ toneMapped: false });
  material.colorNode = tinted(color(COLOURS.edge));
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;
  material.name = "broom:edge";
  return material;
}

/**
 * The point handles.
 *
 * `sizeAttenuation` off is the whole point: a handle is a target for the mouse, and a target that shrinks
 * with distance is one that cannot be hit. Vertices are drawn a little larger than the midpoints and
 * centres, so a stack of them near one another is told apart before it is clicked.
 */
export function handleMaterial(): PointsNodeMaterial {
  const material = new PointsNodeMaterial({ sizeAttenuation: false, toneMapped: false, depthTest: false });
  const kind = attribute<"float">("kind", "float");
  material.sizeNode = select(kind.greaterThan(float(0)), float(7), float(9));
  material.colorNode = tinted(color(COLOURS.handle));
  material.name = "broom:handle";
  return material;
}

// ---------------------------------------------------------------- picking

/**
 * What the pick pass writes: the solid's ordinal in the red and green channels and the face index in the
 * blue, each byte written as `n / 255` so an unsigned-byte target round-trips it exactly.
 *
 * Sixteen bits of ordinal is 65535 solids in one map, an order of magnitude past what anyone has built.
 * The face index gets eight, which is 255 faces on one solid — a brush past that has problems the pick
 * buffer is not the first of.
 */
export function pickMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ toneMapped: false });
  // a locked face still draws, so it occludes what is behind it, but writes zero: it is there to be seen,
  // not to be grabbed
  const live = float(1).sub(has(LOCKED));
  material.fragmentNode = vec4(encode(), 1).mul(vec4(vec3(live), 1));
  material.name = "broom:pick";
  return material;
}

/** handles pick into their own buffer, one-based, so zero keeps meaning "nothing was under the mouse" */
export function handlePickMaterial(): PointsNodeMaterial {
  const material = new PointsNodeMaterial({ sizeAttenuation: false, toneMapped: false, depthTest: false });
  material.sizeNode = float(11); // a touch larger than it is drawn, because a near miss should still hit
  material.fragmentNode = vec4(encode(), 1);
  material.name = "broom:handle-pick";
  return material;
}

/** the pick attribute as a colour: sixteen bits across red and green, eight more in blue */
const encode = () =>
  vec3(mod(pick.x, 256).div(255), floor(pick.x.div(256)).div(255), pick.y.div(255));

/** the ordinal and face a pick pixel was written with — the exact inverse of {@link encode} */
export const decodePick = (rgba: Uint8Array | Uint8ClampedArray, at = 0): { ordinal: number; face: number } => ({
  ordinal: rgba[at]! + rgba[at + 1]! * 256,
  face: rgba[at + 2]!,
});
