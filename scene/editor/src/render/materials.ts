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
  DoubleSide, LineBasicNodeMaterial, MeshBasicNodeMaterial, MeshStandardNodeMaterial,
} from "three/webgpu";
import type { Node } from "three/webgpu";
import {
  attribute, bitAnd, cameraPosition, cameraProjectionMatrix, color, float, floor, fwidth, int, max, mix,
  mod, modelViewMatrix, normalWorld, oneMinus, positionGeometry, positionWorld, round, screenDPR,
  select, smoothstep, uniform, vec3, vec4, viewportSize,
} from "three/tsl";
import { FACE_SELECTED, HOVERED, LOCKED, OUTSIDE, SELECTED } from "./batch.ts";
import { HANDLE_PIXELS } from "./handles.ts";

// ---------------------------------------------------------------- the palette

/**
 * The editor's own colours, which are not the map's.
 *
 * The same ramp the panels are on — Lospec "PurpleMorning8" — so that a viewport is part of the window
 * rather than a rectangle of somebody else's editor set into it. Selection is a warm red because that is
 * what every brush editor since Worldcraft has used and a level designer's hands already know it, and the
 * ramp's accent happens to be exactly that hue.
 *
 * Two things deliberately leave the palette. The axes stay red/green/blue, because they are read as a
 * convention rather than as decoration and there is no green or blue in the ramp to read them as. And the
 * hover is the pale end of the ramp rather than another warm tone, because hover and selection have to be
 * told apart at a glance and two reds cannot be.
 */
export const COLOURS = {
  /** what a viewport clears to, and what the 2D grid is drawn onto */
  background: 0x171426,
  face: 0xa6a0ae,
  edge: 0x211d38,
  selected: 0xc7584c,
  faceSelected: 0xe0836b,
  hovered: 0xcdd4a5,
  locked: 0x60556e,
  outside: 0x6b6379,
  grid: 0x0d0b18,
  axisX: 0xc7584c,
  axisY: 0x8fae62,
  axisZ: 0x6a7fc0,
  handle: 0xe9edd2,
  link: 0x6fb39c,
  guide: 0xcfa98a,
} as const;

// ---------------------------------------------------------------- reading the flags

const flag = /*@__PURE__*/ attribute<"float">("flag", "float");
const pick = /*@__PURE__*/ attribute<"vec2">("pick", "vec2");

/**
 * The bit field as an integer again, rounded rather than truncated.
 *
 * The rounding is not a nicety. A vertex attribute is *interpolated*, and the barycentric weights a
 * rasteriser interpolates with do not sum to exactly one at every pixel — so a face whose six vertices all
 * carry `8` arrives as `7.9999995` at some of them, and `int()`, which truncates, reads `7`. Seven has the
 * lock bit in it. That is a whole face flickering between hovered and locked as the cursor moves a pixel,
 * and in the pick pass — where locked means "writes no identity" — it is a hover that switches itself off,
 * which is precisely the bug this line existed to cause.
 *
 * Rounding is enough because the value is always a small integer at the vertices, so the interpolated
 * value is always within a hair of it.
 */
const flags = /*@__PURE__*/ int(/*@__PURE__*/ round(flag));

/** how much of one flag bit is set, as 0 or 1 */
const has = (bit: number) => select(bitAnd(flags, int(bit)).greaterThan(int(0)), float(1), float(0));

/**
 * Everything the flags say about a surface, in the order a designer expects to see: lock and out-of-group
 * first because they are about what is *reachable*, then selection, then hover on top because hover is
 * feedback about right now and must never be hidden by state.
 */
const FLAG_LAYERS: { colour: number; amount: number; bit: number }[] = [
  { bit: OUTSIDE, colour: COLOURS.outside, amount: 0.55 },
  { bit: LOCKED, colour: COLOURS.locked, amount: 0.7 },
  { bit: SELECTED, colour: COLOURS.selected, amount: 0.55 },
  { bit: FACE_SELECTED, colour: COLOURS.faceSelected, amount: 0.75 },
  { bit: HOVERED, colour: COLOURS.hovered, amount: 0.35 },
];

/**
 * One layer of the editor's marks: a colour, and how much of it to lay over what is underneath.
 *
 * Untyped nodes, deliberately. The TSL typings separate `color` from `vec3` and the arithmetic below —
 * multiply, add, divide — is the same operation on both; typing it either way turns this fold into a
 * chain of conversions that generate no code and say nothing.
 */
type AnyNode = any;
type Ink = { tint: AnyNode; amount: AnyNode };

/**
 * Every mark the editor makes on a surface, collapsed into one colour and one amount.
 *
 * A chain of `mix`es is the obvious way to write this and it is what the unshaded look used, but it needs
 * the base colour to chain *onto* — and the height material's base colour does not exist until after the
 * parallax march has run, inside a graph this file has no business rebuilding. So the layers are folded
 * from the top down instead: the amount is what is left after each layer has taken its bite, and the tint
 * is the layers' colours weighted by the bite each one actually got. Applying it is one `mix`, which is
 * exactly the hook `HeightMaterial.tint` takes, and the result is identical to the chain it replaces.
 *
 * Passing the grid in draws it here too, so a brick wall gets the same lines a grey one does. That is the
 * point of an on-face grid: it says where the floor is, and a floor with a material on it is still a floor.
 */
export function editorInk(grid?: GridUniforms): Ink {
  const layers: Ink[] = FLAG_LAYERS.map((l) => ({
    tint: color(l.colour),
    amount: has(l.bit).mul(l.amount),
  }));
  if (grid) layers.push(gridInk(grid));

  // `keep` is how much of the base survives everything after this layer, which is the weight this layer's
  // colour is actually seen at — walking backwards is what makes that available before it is needed
  let keep: AnyNode = float(1);
  let weighted: AnyNode = vec3(0);
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    weighted = weighted.add(vec3(layer.tint).mul(layer.amount).mul(keep));
    keep = keep.mul(oneMinus(layer.amount));
  }
  const amount = oneMinus(keep);
  // nothing marked means nothing to divide by; the amount is zero there, so what the colour is cannot
  // be seen — but a NaN in an unseen colour is still a NaN, and some drivers propagate it
  return { tint: color(weighted.div(max(amount, float(1e-4)))), amount };
}

/** a base colour with the editor's marks over it — the graph both looks copy */
const tinted = (base: AnyNode, grid?: GridUniforms): AnyNode => {
  const { tint, amount } = editorInk(grid);
  return mix(base, tint, amount);
};

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
function gridInk(grid: GridUniforms, fade = true) {
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
  const near = fade ? float(1).sub(smoothstep(grid.reach.mul(0.4), grid.reach, eye)) : float(1);
  return { amount: max(max(fine, major), axis).mul(grid.strength).mul(near), tint };
}

// ---------------------------------------------------------------- the materials

/**
 * The unshaded brush faces: one unlit material for the whole map, with no textures or lighting.
 *
 * Selection and the on-face grid remain part of the colour graph, so switching looks changes the surface
 * treatment without moving the editor's marks.
 */
export function unshadedMaterial(grid: GridUniforms): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ toneMapped: false });
  material.colorNode = tinted(color(COLOURS.face), grid);
  material.name = "broom:face/unshaded";
  return material;
}

/** the physical grey fallback used by shaded faces whose material declaration is missing */
export function shadedFallbackMaterial(grid: GridUniforms): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  material.colorNode = tinted(color(COLOURS.face), grid);
  material.name = "broom:face/shaded-fallback";
  return material;
}

/**
 * The grid an orthographic pane stands on.
 *
 * The face grid alone is not enough in a 2D view: a designer laying a corridor out is looking mostly at
 * empty space, and empty space with no grid in it has no scale and no origin. So the 2D panes draw a plane
 * through their own centre, behind everything, with the same lines and the same world axes on it — which
 * is exactly what TrenchBroom's 2D views show and the reason they can be built in at all.
 *
 * No depth test and no depth write: it is a backdrop, painted first and then covered by whatever is in
 * front of it, rather than a surface competing with the map for the depth buffer.
 */
export function gridPlaneMaterial(grid: GridUniforms): MeshBasicNodeMaterial {
  // opaque, not transparent: three draws every transparent object *after* every opaque one, so a
  // transparent backdrop with no depth test would end up painted over the map instead of under it. An
  // opaque quad that writes no depth and is ordered first is a backdrop in the only way that works.
  const material = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, toneMapped: false });
  const { amount, tint } = gridInk(grid, false);
  material.colorNode = mix(color(COLOURS.background), tint, amount.mul(1.6).clamp(0, 1));
  material.name = "broom:grid-plane";
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
 * A handle's centre blown up into a screen-space square, `pixels` across.
 *
 * A handle is a target for the mouse, so it has to stay the same size however far away it is — a handle
 * that shrinks with distance is one that cannot be hit. That has to be done here, by hand, because a
 * `Points` object gets no size at all under WebGPU: the format has no `gl_PointSize`, `PointsNodeMaterial`
 * only expands to a sprite when the object is *not* points, and the result is a one-pixel dot that is both
 * invisible and unclickable. So a handle is an instanced quad and this is the expansion.
 *
 * The sizes come from `handles.ts` because the hit test reads them too — the square a designer aims at and
 * the square they hit have to be the same square, and this is the only place that draws it.
 */
function handleQuad(pixels: Node<"float">) {
  const centre = attribute<"vec3">("handleAt", "vec3");
  const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(centre, 1)));
  // the corner is ±½, so multiplying by the size gives a square that many pixels across; the perspective
  // divide is still to come, so the offset is pre-multiplied by w to survive it
  const offset = positionGeometry.xy.mul(pixels).div(viewportSize.div(2)).mul(clip.w);
  return clip.add(vec4(offset, 0, 0));
}

const HANDLE_SIZE = /*@__PURE__*/ select(
  attribute<"float">("kind", "float").greaterThan(float(0)),
  float(HANDLE_PIXELS.other),
  float(HANDLE_PIXELS.vertex),
);

export function handleMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ toneMapped: false, depthTest: false, side: DoubleSide });
  material.vertexNode = handleQuad(HANDLE_SIZE.mul(screenDPR));
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

/**
 * The pick attribute as a colour: sixteen bits across red and green, eight more in blue.
 *
 * Rounded first, for the same reason {@link flags} is: the identity is an integer at every vertex of the
 * face, but it arrives here interpolated, and `floor` on `255.99999` is `255` where `floor` on `256` is
 * `256` — one ordinal in every 256 would otherwise lose its high byte at some pixels and not others.
 */
const encode = () => {
  const id = round(pick);
  return vec3(mod(id.x, 256).div(255), floor(id.x.div(256)).div(255), id.y.div(255));
};

/** the ordinal and face a pick pixel was written with — the exact inverse of {@link encode} */
export const decodePick = (rgba: Uint8Array | Uint8ClampedArray, at = 0): { ordinal: number; face: number } => ({
  ordinal: rgba[at]! + rgba[at + 1]! * 256,
  face: rgba[at + 2]!,
});
