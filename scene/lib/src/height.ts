/**
 * The height material: brick, stone, panelling, cracks and damage carried by a texture rather than by
 * geometry — and carried at whatever fidelity the pixel in front of you is worth.
 *
 * A brush editor draws a wall as six planes because that is what a wall *is* for everything that matters
 * to a game: the silhouette a player reads at range, the surface a capsule slides along, the polygon a
 * navigation mesh is built from. What a wall is *not* is flat, and the two facts have to be reconciled
 * somewhere. Modelling every brick would ruin all three of those properties and cost a hundred times the
 * triangles; so the bricks live in a height map and this material puts them back.
 *
 * **The tiers.** The honest way to read a height field costs more the closer you are to it, so the shading
 * walks down three of them by distance:
 *
 * - **normal** — far away. The height map's companion normal map does all of it. A relief a centimetre
 *   deep seen from twenty metres is smaller than the pixel it is drawn in, and marching a ray for it is
 *   paying forty texture reads to move nothing.
 * - **pom** — the middle. A ray is marched through the height field and every other map is sampled where
 *   it came out, so the bricks slide against each other as the camera moves and the mortar goes properly
 *   dark at the bottom. This is the tier a player spends nearly all their time in.
 * - **ssdm** — close up. Same march, and the fragment additionally writes the depth it *appears* to have
 *   rather than the depth of the plane it was drawn on. That is the whole difference between relief that
 *   is painted on and relief that is there: a crate pushed against the wall sinks into the mortar line, a
 *   shadow crossing the bricks bends over them, and the wall's contact with the floor stops being a
 *   suspiciously straight line.
 *
 * The tiers are not a switch and there is nothing to toggle. `detail` falls smoothly from one to zero
 * between {@link HeightTuning.full} and {@link HeightTuning.fade}, and it scales the relief itself — so
 * the transition into plain normal mapping happens by the relief shrinking to nothing, which is invisible,
 * rather than by a branch, which pops. The step count rides the same number, plus the grazing angle,
 * because a ray that enters the slab nearly sideways crosses far more of it and needs more samples to not
 * miss the brick it should have hit.
 *
 * **One knob.** A level designer sets `depth` and nothing else. Everything above is derived from it and
 * from where the camera happens to be, which is the point: the tuning that decides whether this pixel is
 * worth forty texture reads is a renderer's job, and a wall that needed a technical decision per instance
 * would be a wall nobody could place quickly.
 *
 * `depth` is in **metres**, and it means metres. The conversion from metres of relief to the uv offset a
 * march actually needs would normally require knowing how large the tile is on the wall — a number that
 * lives on the face, not on the material — so it is read off the geometry instead, from the ratio of
 * `dFdx(positionView)` to `dFdx(uv)`. Four centimetres of brick is four centimetres on a one-metre tile
 * and four centimetres on a four-metre one, and no face has to tell the material anything.
 */
import { MeshStandardNodeMaterial, type Texture } from "three/webgpu";
import {
  Break, If, Loop, cameraFar, cameraNear, cameraProjectionMatrix, clamp, dFdx, dFdy, dot, float, int,
  length, log2, max, min, mix, normalMap, normalize, oneMinus, parallaxDirection, positionView, saturate,
  select, smoothstep, texture, textureLevel, textureSize, transformedNormalView, uniform, uv, vec2, vec3, vec4,
  viewZToOrthographicDepth, viewZToPerspectiveDepth,
} from "three/tsl";

/** what TSL hands back; the typings call every node the same thing and there is nothing to gain by naming it */
type Node = any;

/** the fixed bound on the march. A loop three can unroll is a loop that compiles on every backend */
export const MAX_STEPS = 96;

/** divisions that would blow up at a grazing angle or on a degenerate uv are floored by these */
const EPS = 1e-5;
const GRAZE = 0.1; // cos 84°: past this the ray is along the wall and the sweep is meaningless anyway

/**
 * Where the tiers change hands, in metres from the camera.
 *
 * These are renderer's numbers, not a designer's — the defaults are chosen so that a relief of a few
 * centimetres stops being marched at about the distance it stops being visible, and they are exposed only
 * because a project whose walls are all two hundred metres away has a different idea of "close".
 */
export type HeightTuning = {
  /** metres within which the relief is at full strength and the march gets its full step count */
  full: number;
  /** metres beyond which there is no march at all and the normal map carries the surface alone */
  fade: number;
  /** metres within which the fragment writes the depth it looks like it has */
  solid: number;
  /** the step count at the far end of the march, and at the near one */
  least: number;
  most: number;
};

export const TUNING: HeightTuning = { full: 4, fade: 24, solid: 3, least: 8, most: 48 };

/** the three ways a pixel of a height material can be shaded, cheapest first */
export type Tier = "normal" | "pom" | "ssdm";

// ---------------------------------------------------------------- the tier maths, as numbers

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** the smoothstep the shader uses, so a check of these functions is a check of what runs */
const smooth = (x: number): number => x * x * (3 - 2 * x);

/**
 * How much of the relief this distance deserves: 1 up close, 0 far away, and a smooth ramp between.
 *
 * It scales the relief rather than selecting a branch, which is why nothing pops as a camera walks back
 * from a wall — the bricks flatten over several metres instead of switching off in one frame.
 */
export function detailAt(metres: number, tuning: HeightTuning = TUNING): number {
  if (!(metres > tuning.full)) return 1;
  if (metres >= tuning.fade) return 0;
  return smooth(1 - (metres - tuning.full) / (tuning.fade - tuning.full));
}

/**
 * Which tier a distance lands in.
 *
 * Nothing in the shader branches on this — the shader has `detail` and a depth write that fades in, and
 * the two together *are* the tiers. This exists because "which tier is that wall in" is a question a
 * profiler, a check and a designer all ask, and answering it by reading the shader is not an answer.
 */
export function tierAt(metres: number, tuning: HeightTuning = TUNING): Tier {
  if (detailAt(metres, tuning) <= 0) return "normal";
  return metres <= tuning.solid ? "ssdm" : "pom";
}

/**
 * How many steps the march gets, from the detail and from how square-on the surface is.
 *
 * Both terms matter and they are not the same term. Distance decides how much relief there is left to
 * find; the angle decides how far the ray travels to cross what is there. A wall seen edge-on at two
 * metres is the expensive case, and it is also the one where a ray that skips will visibly cut a brick
 * in half — so it gets double.
 */
export function stepsAt(detail: number, facing: number, quality = 1, tuning: HeightTuning = TUNING): number {
  if (detail <= 0) return 0;
  const base = tuning.least + (tuning.most - tuning.least) * clamp01(detail);
  const oblique = 2 - clamp01(facing); // 1 square-on, 2 edge-on
  return Math.max(tuning.least, Math.min(MAX_STEPS, Math.round(base * oblique * quality)));
}

// ---------------------------------------------------------------- the shading graph

export type HeightInput = {
  heightMap: Texture;
  /** metres of relief, as a number or as a uniform node so it can be changed without a recompile */
  depth: number | Node;
  /** a multiplier on the step count, for a project that would rather spend or save */
  quality?: number | Node;
  tuning?: Partial<HeightTuning>;
  /** the coordinate to start from; the default is the geometry's own */
  uvNode?: Node;
};

/**
 * What one marched pixel knows about itself.
 *
 * Handed back rather than used, because the material this file exports is not the only thing that wants
 * it: the editor shades the same wall with the same march and its own selection tint over the top, and
 * two implementations of a parallax that had to agree to the pixel is exactly the bug this avoids.
 */
export type HeightSurface = {
  /** the parallaxed coordinate — where every other map should be sampled */
  uv: Node;
  /** how far below the surface the eye's ray came out, as a fraction of the relief */
  below: Node;
  /** how much relief this pixel got: 1 close up, 0 out at the fade distance */
  detail: Node;
  /** the derivatives of the *unparallaxed* coordinate, which every map sample should be graded by */
  grad: [Node, Node];
  /** the view-space z of the point the eye actually sees, rather than of the plane it was drawn on */
  viewZ: Node;
};

/**
 * The march.
 *
 * Linear steps down through the height field until one lands under the surface, then one secant step
 * between the last two samples. The refinement is not a nicety: without it the hit is quantised to the
 * step size, and the quantisation is *along the ray*, so it shows up as the bricks visibly jittering
 * along the wall as the camera moves rather than as a bit of softness.
 *
 * The height field is read at an explicit mip level. Derivatives are undefined inside non-uniform control
 * flow — WGSL refuses to compile the implicit form outright — and a march that picked a different level
 * per step would be marching through a different wall each step.
 */
export function heightSurface(input: HeightInput): HeightSurface {
  const tuning = { ...TUNING, ...input.tuning };
  const base = (input.uvNode ?? uv()).toVar();
  const gx = dFdx(base).toVar();
  const gy = dFdy(base).toVar();

  // metres of wall per uv unit, read off the geometry rather than declared. This is what lets `depth`
  // be a length instead of a fraction of a tile nobody can picture.
  const perUv = length(dFdx(positionView)).div(max(length(gx), EPS)).toVar();

  const away = length(positionView).toVar();
  const detail = oneMinus(smoothstep(tuning.full, tuning.fade, away)).toVar();

  const normal = normalize(transformedNormalView).toVar();
  const toEyeView = normalize(positionView.negate()).toVar();
  const facing = saturate(dot(normal, toEyeView)).toVar();

  const quality = float(input.quality ?? 1);
  const steps = clamp(
    mix(float(tuning.least), float(tuning.most), detail).mul(float(2).sub(facing)).mul(quality),
    float(tuning.least),
    float(MAX_STEPS),
  ).toVar();

  // metres of relief this pixel gets, and the same thing in uv units, which is what a march moves in
  const metres = float(input.depth).mul(detail).toVar();
  const relief = metres.div(max(perUv, EPS)).toVar();

  // the uv the ray sweeps out crossing the whole slab. `parallaxDirection` is the view direction in
  // tangent space and points at the eye, so the offset is subtracted as the ray descends.
  const toEye: Node = normalize(vec3(parallaxDirection as never)).toVar();
  const sweep = toEye.xy.div(max(toEye.z, GRAZE)).mul(relief).toVar();

  const texel = vec2(textureSize(texture(input.heightMap), int(0)) as never);
  const lod = max(log2(max(length(gx.mul(texel)), length(gy.mul(texel)))), float(0)).toVar();

  const stepSize = float(1).div(steps).toVar();
  const layer = float(0).toVar();
  const lastLayer = float(0).toVar();
  // "below" is depth beneath the surface, so white is the top of the brick and black is the mortar —
  // the same way every height map anybody ships is authored
  const below = float(0).toVar();
  const lastBelow = float(0).toVar();
  const done = float(0).toVar();

  Loop(MAX_STEPS, () => {
    If(done.greaterThan(0.5), () => {
      Break();
    });
    lastLayer.assign(layer);
    lastBelow.assign(below);
    layer.assign(min(layer.add(stepSize), float(1)));
    below.assign(oneMinus(textureLevel(input.heightMap, base.sub(sweep.mul(layer)), lod).r));
    If(below.lessThanEqual(layer).or(layer.greaterThanEqual(float(1))), () => {
      done.assign(float(1));
    });
  });

  // where the straight line `layer` crosses the sampled height between the last two steps. A ray that
  // never went under simply reports the far side, which is what a hole in the wall looks like anyway.
  const a = lastBelow.sub(lastLayer);
  const b = below.sub(layer);
  const hit = clamp(mix(lastLayer, layer, saturate(a.div(max(a.sub(b), EPS)))), float(0), float(1)).toVar();

  // the point the eye sees is `hit * metres` below the plane, along a ray that is `1 / facing` longer
  // than that for having come in at an angle
  const along = hit.mul(metres).div(max(facing, GRAZE));

  return {
    uv: base.sub(sweep.mul(hit)),
    below: hit,
    detail,
    grad: [gx, gy],
    viewZ: positionView.z.sub(toEyeView.z.mul(along)),
  };
}

/**
 * The depth a marched pixel should write.
 *
 * Both projections are computed and one is chosen by a uniform, rather than by asking the builder which
 * camera it is compiling for. One material is drawn through several cameras in the same frame in any
 * editor and in most games, and a graph specialised to the first camera that happened to build it is a
 * wall that renders correctly in the perspective pane and floats in the orthographic ones.
 *
 * Which one it is, is read out of the projection matrix by putting a direction through it: the row that
 * makes a projection perspective is the one that copies `-z` into `w`, so a straight-ahead direction
 * comes back with `w` of 1 through a perspective matrix and 0 through an orthographic one.
 */
export function heightDepth(surface: HeightSurface): Node {
  const orthographic = cameraProjectionMatrix.mul(vec4(0, 0, -1, 0)).w.abs().lessThan(float(0.5));
  return select(
    orthographic,
    viewZToOrthographicDepth(surface.viewZ, cameraNear, cameraFar),
    viewZToPerspectiveDepth(surface.viewZ, cameraNear, cameraFar),
  );
}

/** every other map, sampled where the ray came out and graded by the derivatives of where it went in */
export const sampleAt = (map: Texture, surface: HeightSurface): Node =>
  texture(map, surface.uv).grad(surface.grad[0], surface.grad[1]);

// ---------------------------------------------------------------- the material

/**
 * A standard material whose surface is a height field.
 *
 * Everything `meshStandardMaterial` takes is still taken — `color`, `map`, `roughnessMap`, `aoMap` and
 * the rest all behave as they do anywhere else, except that they are sampled where the ray came out
 * instead of where the triangle is. What is added is `heightMap` and `depth`.
 *
 * ```tscene
 * --brick: heightMaterial {
 *   map: texture("./brick.png");
 *   normalMap: texture("./brick_n.png");
 *   heightMap: texture("./brick_h.png");
 *   depth: 0.03;
 * }
 * ```
 *
 * A material with no `heightMap` on it is a plain standard material and costs what one costs, which is
 * what makes this safe to reach for by default: the map is what turns the machinery on.
 */
export class HeightMaterial extends MeshStandardNodeMaterial {
  readonly isHeightMaterial = true;

  #heightMap: Texture | null = null;
  #depth = uniform(0.03);
  #quality = uniform(1);
  #solid = true;
  #tuning: HeightTuning = { ...TUNING };
  #tint: Node | null = null;

  constructor(parameters?: Record<string, unknown>) {
    super();
    this.type = "HeightMaterial";
    if (parameters) this.setValues(parameters as never);
  }

  /** the relief, read from the red channel: white is the top of the surface and black is the deepest */
  get heightMap(): Texture | null {
    return this.#heightMap;
  }
  set heightMap(map: Texture | null) {
    if (map === this.#heightMap) return;
    this.#heightMap = map;
    // the graph is a different graph with a height map in it, so this one is not a uniform change
    this.needsUpdate = true;
  }

  /** metres of relief. The one number a level designer sets */
  get depth(): number {
    return this.#depth.value;
  }
  set depth(metres: number) {
    this.#depth.value = metres;
  }

  /** a multiplier on the step count — a project's quality setting, not a per-wall decision */
  get quality(): number {
    return this.#quality.value;
  }
  set quality(q: number) {
    this.#quality.value = q;
  }

  /**
   * Whether the near tier writes the depth it appears to have.
   *
   * On by default, and off is for the cases where a depth write is the wrong trade rather than a matter
   * of taste: a pane drawing thousands of walls where early-z is worth more than contact, or a pass that
   * is reading this material's depth for something else.
   */
  get silhouette(): boolean {
    return this.#solid;
  }
  set silhouette(on: boolean) {
    if (on === this.#solid) return;
    this.#solid = on;
    this.needsUpdate = true;
  }

  /** where the tiers change hands. Merged over the defaults, so setting one of them sets one of them */
  get tuning(): HeightTuning {
    return this.#tuning;
  }
  set tuning(t: Partial<HeightTuning>) {
    this.#tuning = { ...TUNING, ...t };
    this.needsUpdate = true;
  }

  /**
   * A colour mixed over the shaded result, as `vec4(rgb, amount)`.
   *
   * This is the seam the editor needs and the reason the march is not private to this class. A level
   * editor has to draw a selected wall differently from an unselected one while drawing *the same wall*;
   * a second material for the tinted case would be a second parallax implementation, and the day the two
   * disagreed would be the day a designer aligned a trim against a brick that was not where it looked.
   */
  get tint(): Node | null {
    return this.#tint;
  }
  set tint(node: Node | null) {
    if (node === this.#tint) return;
    this.#tint = node;
    this.needsUpdate = true;
  }

  setup(builder: unknown): unknown {
    this.#compose();
    return (super.setup as (b: unknown) => unknown).call(this, builder);
  }

  /**
   * The nodes the march produces, hung on the slots the standard material reads.
   *
   * Done here rather than in the constructor because it depends on which maps are set, and a sheet sets
   * those after construction — `heightMaterial { heightMap: texture(…) }` builds the material first and
   * assigns second, like every other node in the language.
   */
  #compose(): void {
    const map = this.map;
    if (!this.#heightMap) {
      // no relief: leave every slot alone and be a standard material, apart from the tint the editor
      // may still have asked for
      this.colorNode = this.#tinted(null);
      return;
    }
    const surface = heightSurface({
      heightMap: this.#heightMap,
      depth: this.#depth,
      quality: this.#quality,
      tuning: this.#tuning,
    });

    this.colorNode = this.#tinted(map ? sampleAt(map, surface) : null);
    if (this.normalMap) {
      this.normalNode = normalMap(sampleAt(this.normalMap, surface).xyz, vec2(this.normalScale.x, this.normalScale.y));
    }
    if (this.roughnessMap) this.roughnessNode = float(this.roughness).mul(sampleAt(this.roughnessMap, surface).g);
    if (this.metalnessMap) this.metalnessNode = float(this.metalness).mul(sampleAt(this.metalnessMap, surface).b);
    if (this.aoMap) this.aoNode = sampleAt(this.aoMap, surface).r;
    // the deepest parts of the relief see least of the room, and a march that has already found how deep
    // it went can say so for free — without it the mortar is lit exactly like the brick and the whole
    // effect reads as a printed pattern
    const occlusion = oneMinus(surface.below.mul(0.6));
    this.aoNode = this.aoNode ? (this.aoNode as Node).mul(occlusion) : occlusion;

    this.depthNode = this.#solid ? heightDepth(surface) : null;
  }

  /** the material's own colour and map, with the editor's tint over it when there is one */
  #tinted(sampled: Node | null): Node {
    const base = sampled ? vec4(this.color.r, this.color.g, this.color.b, 1).mul(sampled) : vec4(this.color.r, this.color.g, this.color.b, 1);
    if (!this.#tint) return base;
    const tint = this.#tint;
    return vec4(mix(base.rgb, tint.rgb, tint.a), base.a);
  }
}
