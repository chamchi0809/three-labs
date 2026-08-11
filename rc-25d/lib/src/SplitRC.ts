import {
  Camera,
  Color,
  FloatType,
  HalfFloatType,
  MeshBasicNodeMaterial,
  type MRTNode,
  NearestFilter,
  type Node,
  QuadMesh,
  RenderTarget,
  type Scene,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  atan,
  clamp,
  compute,
  cos,
  diffuseColor,
  dot,
  emissive,
  float,
  floor,
  fract,
  instanceIndex,
  instancedArray,
  int,
  length,
  log2,
  max,
  mix,
  mrt,
  normalWorld,
  positionWorld,
  screenUV,
  select,
  sin,
  sqrt,
  storage,
  texture,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
  atomicAdd,
  atomicLoad,
  atomicStore,
  workgroupArray,
  workgroupBarrier,
} from "three/tsl";
import { VoxelScene, type VoxelSceneOptions } from "./VoxelScene.js";

const uintArray = (count: number) => instancedArray(count, "uint");
const vec2Array = (count: number) => instancedArray(count, "vec2");
const vecArray = (count: number) => instancedArray(count, "vec4");
type UintArray = ReturnType<typeof uintArray>;
type Vec2Array = ReturnType<typeof vec2Array>;
type VecArray = ReturnType<typeof vecArray>;

/**
 * A second, read-only view of an existing buffer. Fragment stages may bind
 * neither atomic nor writable storage, so the composite pass reads the hashmap
 * through views like these; both nodes reference the same attribute, so they
 * resolve to the same GPU buffer.
 */
const readOnlyView = (source: UintArray, count: number): UintArray =>
  storage(source.value, "uint", count).toReadOnly();
type ComputeKernel = ReturnType<typeof compute>;

const TAU = Math.PI * 2;

/** Cascade count `N`; paper §7. */
const CASCADES = 4;

/**
 * Angular resolution `Θ₀`, giving `|Ω_I0| = 2Θ₀² = 32` base directions.
 * `Θₙ = Θ₀·2ⁿ`, so `|Ω_In| = 32·4ⁿ` — the branching factor `K = 4`.
 */
const THETA_0 = 4;

/**
 * Base ray length as a multiple of `Δs₀`. Paper §7 gives `t₀ ≈ 1.6Δs₀`, which is
 * `1/Δω₀` — the distance at which one of cascade 0's `2Θ₀²` cones is as wide as
 * a probe cell, so `Δωₙ = Δsₙ` falls out of it together with `K = 4`, `l = 4`.
 *
 * 1.6 is the answer to the *far* end of each interval, and cascade 1's near end
 * is what actually shows. Interval `n` begins at `tₙ₋₁·t₀` and its probes are
 * `SPACING_SCALE ⁿ·Δs₀` apart, so the ratio of the two is 0.8, 2.1, 4.2 — every
 * cascade but the first starts further out than its own probes are spaced, and
 * cascade 1 starts *closer*. A cascade whose interval begins inside its own
 * spacing cannot represent what it is holding: two adjacent probes see the same
 * light tens of degrees apart, more than one of their cones, so interpolating
 * between them is not a blur of the right answer but a mix of two different
 * ones. The c0/c1 bound is where a light crosses into that, and it is a sphere
 * of constant distance from the light — the ring, and the only ring, since the
 * bounds above it clear their spacing comfortably.
 *
 * 2.4 is 1.2 times cascade 1's spacing, the same margin that got the ring out of
 * `CASCADE_OVERLAP`. What it costs is at cascade 0's far end, where a cone is
 * now 1.5 cells across instead of 1: the near field is softer than `Δω₀ = Δs₀`
 * asks for. Softer, and smoothly so — it does not put an edge anywhere, which is
 * more than the alternative did. The other way to buy the same margin is
 * `THETA_0 = 6`, which keeps the calibration exact and costs 2.25× the cones.
 */
const T0_OVER_DS0 = 2.4;

/** Length scaling `l`; interval `n` is `l` times longer than interval `n−1`. */
const LENGTH_SCALE = 4;

/**
 * Probe spacing doubles per cascade. §3.2 fixes this: with `K = 4` and `l = 4`
 * the angular error `Δωₙ` scales as `2ⁿ`, and matching spatial to angular error
 * (`Δωₙ = Δsₙ`) requires the same scaling for `Δsₙ`. It is also what makes probe
 * count fall 4× per cascade on the effectively two-dimensional surfaces scenes
 * are made of, which is the balance §5.1 relies on.
 */
const SPACING_SCALE = 2;

/** Slots per probe in the hashmap. §6 runs the map at very low occupancy. */
const HASH_LOAD = 4;

/**
 * Linear-probing rounds per insertion stage. Each round is one dispatch: a
 * candidate either claims a free slot, recognises its own key (a duplicate, so
 * it adopts the existing probe), waits one round for the winner to publish, or
 * advances one slot. At `1/HASH_LOAD` occupancy the probe sequence is almost
 * always length one, and the extra rounds cover duplicate resolution.
 */
const INSERT_ROUNDS = 6;

/** Probe grid coordinates per axis, as a signed range. See {@link packKey}. */
const COORD_BITS = 9;
const COORD_BIAS = 1 << (COORD_BITS - 1);
const COORD_MASK = (1 << COORD_BITS) - 1;
const LOD_BITS = 4;

/** `hashProbe` sentinels. A slot is claimed before its probe index is published. */
const PROBE_PENDING = 0xffffffff;
const PROBE_OVERFLOW = 0xfffffffe;

/** Bit 31 of a probe key; see `packKey`. Unsigned, so it survives `uint()`. */
const KEY_OCCUPIED = 0x80000000;

/**
 * Fixed-point scale for the atomic deposit. WebGPU has no float atomics, so
 * radiance and transmittance accumulate as `u32`.
 *
 * ponytail: radiance is clamped to {@link RADIANCE_CEILING} before scaling, so
 * an emitter brighter than that deposits as if it were exactly that bright. The
 * headroom is `2³² / (CEILING · SCALE)` ≈ 16k rays into one direction before a
 * sum could wrap, which no single frame approaches. Upgrade path: swap the five
 * `u32` lanes for `f32` atomics once WebGPU exposes them.
 */
const DEPOSIT_SCALE = 1024;
const RADIANCE_CEILING = 256;

/** Lanes per (probe, direction): `J.rgb`, `β`, and the ray count §5 divides by. */
const DEPOSIT_LANES = 5;

/** Octahedral irradiance field per c0 probe: 6×6 interior plus a 1-texel border (§6). */
const IRRADIANCE_INNER = 6;
const IRRADIANCE_SIZE = IRRADIANCE_INNER + 2;
const IRRADIANCE_TEXELS = IRRADIANCE_SIZE * IRRADIANCE_SIZE;

/**
 * §4.1: each LOD starts at this fraction of where a hard switch would put it,
 * so consecutive LODs overlap and the seam between them can be blended away.
 * The band is `−log₂` of it, in log₂ distance: 0.5 is a full octave, so every
 * point is somewhere in a band and no LOD ever answers alone.
 *
 * It has to be that wide, and 0.9 was not. A narrow band makes the *seam*
 * continuous and leaves the two sides at different average brightness, which is
 * the part that actually reads as banding — the shells are flat, so the eye
 * finds the step between two flat regions however smoothly they are joined.
 * And the two sides genuinely differ: {@link GATHER_RADIUS} is 1.5 *cells*, so
 * the reconstruction low-passes over twice the world distance at each coarser
 * LOD, and no amount of fixing the probe values changes the filter width.
 * Spreading the difference over the whole octave is the only thing that turns a
 * step into a gradient.
 *
 * Cost is a second gather on every pixel instead of a seventh of them, and a
 * coarse lattice seeded throughout each shell — which is a quarter of the
 * probes of the fine one, not another whole set, since it is a quarter as
 * dense. Watch c0 in the probe readout; if it pins at capacity, raise
 * `probeCapacity` before narrowing this.
 */
const LOD_OVERLAP = 0.5;

/**
 * Weight a probe keeps for itself in the probe-space filter, against 1 for each
 * of its six lattice neighbours.
 *
 * Tent-splatting rays into probes and tent-interpolating them back out is a
 * matched pair, so the reconstruction is continuous — but only C⁰. Its second
 * derivative jumps at every cell face, and a jump in curvature at a regular
 * spacing is exactly what the eye reads as a grid: one soft blob per cell,
 * locked to the lattice, identical from frame to frame. It survives every fix
 * aimed at the probe *values* — a complete stencil, backface weighting, more
 * effective samples per direction — because the values are not what is wrong.
 *
 * Convolving the field with its own lattice neighbours raises it to the
 * next-smoother basis: the curvature discontinuity is spread over two cells
 * instead of landing on one face, and the periodic term goes with it. It is safe
 * to do on irradiance and not on radiance — irradiance is already a cosine
 * integral over the whole hemisphere, so it holds nothing at the lattice's
 * frequency that is worth keeping.
 *
 * A missing neighbour simply drops out of the sum, which widens or narrows the
 * kernel without introducing an edge of its own.
 *
 * The weight is 6 — equal to the six neighbours put together — rather than 0.
 * Dropping the centre entirely looks like the most filtering per pass, but it is
 * the one weight that does not damp the checkerboard: that mode has every
 * neighbour equal and opposite to the centre, so a centre-less average returns
 * it negated instead of shrinking it, and the pass cannot be repeated. At 6 the
 * checkerboard's factor is exactly zero and every other mode shrinks, so passes
 * compose — which is what {@link PROBE_FILTER_PASSES} spends.
 */
const PROBE_FILTER_CENTRE = 6;

/**
 * Times the probe filter runs, ping-ponging between the two irradiance buffers.
 *
 * One. Repeating the pass does not converge on a smoother field, it stripes:
 * the filter renormalises over the neighbours that exist, so its kernel is
 * whatever the local occupancy allows, and occupancy on a surface that crosses
 * the lattice at an angle is a staircase with a period. One pass blurs along
 * that staircase; each further pass feeds the previous pass's own periodicity
 * back in, and the stripe sharpens rather than dissolving.
 *
 * That is the ceiling on filtering in probe space, and the reason the grid is
 * attacked at reconstruction instead — {@link GATHER_RADIUS}, whose kernel is a
 * fixed shape in world space and cannot pick up the lattice's period. What
 * remains here is one pass of denoising, which is all this was ever good for.
 *
 * Odd, so the last pass lands in `irradianceSmooth`, which is what shading and
 * the history read; the raw `irradiance` buffer is scratch for the even ones.
 */
const PROBE_FILTER_PASSES = 1;

/**
 * Where a cascade starts handing a hit up to the one above, as a fraction of its
 * far bound.
 *
 * §5 partitions the ray at the interval bounds: a hit belongs to exactly one
 * cascade, whole. That is exact for the radiance and wrong for the picture,
 * because the cascades do not store it at the same resolution — the same hit,
 * one unit further out, is suddenly recorded on a probe lattice twice as coarse
 * and over a cone four times as wide. Nothing about the *value* jumps, but its
 * representation does, and the boundary is a surface of constant distance from
 * the receiver: a soft shell around whatever is lighting the scene, not aligned
 * to any grid, which is what makes it read as a cascade seam rather than as
 * aliasing.
 *
 * So the bound becomes a band. Across it the lower cascade keeps a fraction `a`
 * of the hit and turns partly transparent (`J = a·L, β = 1 − a`) while the upper
 * one takes the hit whole (`J = L, β = 0`), and the merge composites them back
 * to `a·L + (1 − a)·L = L` — exactly the same radiance as before, for any `a`,
 * with the storage sliding from one lattice to the other instead of switching.
 *
 * A constant fraction and not a constant distance, since intervals grow by `l`
 * per cascade: the shell it dissolves is a constant fraction of the way out too.
 *
 * The floor is `max(tₙ₋₁/tₙ) = 21/85 ≈ 0.247`, and it is a hard one. Below it a
 * cascade's band reaches under its own near bound, so at that bound the hit goes
 * from being held whole (borrowed from below, `β = 0`) to being partly handed up
 * — a step in *where* it is stored, at a fixed distance from the light, which is
 * the ring this constant exists to remove, moved rather than removed.
 *
 * 0.35 is as wide as that floor allows with margin, and it needs to be: the
 * bounds scale with the probe spacing, so at LOD 2 the c0/c1 shell sits four
 * times further out than the constant was first tuned against, at a radius that
 * covers a wall rather than hugging the light. The cost of a wide band is that
 * more of each interval is stored partly on the coarser lattice, so the
 * near-field is slightly softer; nothing is lost, since the merge composites the
 * two parts back to the same radiance for any split.
 */
const CASCADE_OVERLAP = 0.35;

/**
 * Radius of the reconstruction kernel in c0 probe cells; see
 * {@link SplitRC#gatherIrradiance}.
 *
 * 1.5 is the widest a 3×3×3 stencil supports, and the width is the point, so it
 * is the value. The kernel has to reach zero by the edge of the stencil or the
 * reconstruction tears: the stencil is centred on the nearest cell, so it jumps
 * by one cell as the position crosses a half-cell boundary, and any probe still
 * carrying weight as it falls out of the stencil takes its contribution with it.
 * A position sits at most half a cell from the nearest centre, which puts the
 * cells just outside the stencil at least 1.5 cells away — no closer, so nothing
 * with weight is ever dropped, and no further, so 1.5 wastes none of the reach.
 *
 * Going wider means a 4³ stencil and 64 lookups a pixel, for a kernel only a
 * third wider again.
 */
const GATHER_RADIUS = 1.5;

/**
 * Falloff of that kernel, over distance already divided by the radius.
 *
 * `fade(1 − d)`: one at the centre, zero from the radius outward, and flat to
 * second order at both ends. The flatness at the outer end is what makes the
 * stencil switch invisible — the weight does not merely reach zero there, it
 * arrives with no slope — and the flatness at the centre is what stops a probe
 * from announcing itself as a bright point at its own cell centre.
 */
const GATHER_KERNEL = (d: Node<"float">): Node<"float"> =>
  fade(clamp(float(1).sub(d), float(0), float(1)));

/**
 * What a probe directly behind the shading plane keeps of its gather weight,
 * against 1 for one directly in front.
 *
 * A probe sits in air, not on a surface, so a wall has probes on both sides of
 * it and the near side reads the far side's irradiance as its own. How far the
 * gather reaches through the wall is set by the probe spacing — and the probe
 * spacing is exactly what the LOD doubles. So the leak is a fixed multiple of
 * the LOD: every coarser shell is brighter than the one inside it by roughly
 * the same factor, everywhere at once. That is not a seam and blending the
 * seam does not touch it; it reads as the shells being at different exposures.
 *
 * ponytail: a plane test, not a visibility test. DDGI pairs this weight with a
 * per-probe Chebyshev depth test, which needs a depth-moment field this solver
 * does not keep; the floor here is what stops a surface whose whole
 * neighbourhood happens to be behind it from renormalising to nothing. Upgrade
 * path: an 8×8 depth-moment field beside the irradiance one, tested the same
 * way `sampleIrradiance` reads this one.
 */
const GATHER_BACKFACE = 0.02;

/**
 * How far along the normal, in c0 probe cells, the plane test pretends the
 * shaded point is — the surface's own probes are not in front of it, and this is
 * what stops {@link GATHER_BACKFACE} from throwing them all away.
 *
 * §4 seeds one probe per cell a surface falls in, so a floor's probes are a
 * single lattice plane, and where in its cell that plane lands is the floor's
 * height modulo the spacing: anywhere from half a cell above to half a cell
 * below. Half below and the probe directly under the shaded point reads
 * `cos = −1` — the whole layer culls at once, and it is the only layer the floor
 * has. Measured over the offset, unbiased: the surviving weight ranges 50:1 and
 * bottoms out at a single probe, which is the "one far probe amplified to stand
 * for the neighbourhood" failure {@link SplitRC#gatherIrradiance} describes,
 * arriving here by a different road. Since the offset is the height modulo a
 * spacing the LOD doubles, whole regions share one offset and the dark ones are
 * laid out by the LOD.
 *
 * Half a cell is the worst case, so half a cell is the value: the layer reads
 * `cos ≥ 0` whichever way the floor fell, and the range closes to 5:1 with never
 * fewer than three probes. It is applied to the cosine only, not to the stencil
 * or the kernel distance — biasing those moves the stencil off the one layer
 * that holds probes, which is worse than the disease.
 *
 * ponytail: it buys the near field with the far. A probe a full cell behind now
 * reads `cos = −0.5` rather than −1, so through-wall leak goes from ~0 to ~17%
 * of the weight where both sides of a wall are seeded. Same upgrade path as
 * {@link GATHER_BACKFACE}: a depth-moment field answers "behind a wall" directly
 * and neither the bias nor the floor would be needed.
 */
const GATHER_BIAS = 0.5;

/**
 * Weight below which a probe is not looked up at all.
 *
 * Above {@link GATHER_BACKFACE} rather than equal to it, because the bias lifts
 * every probe's cosine and the floor no longer separates back from front on its
 * own. Measured over the same offsets: 4.9 cells consulted per pixel against 7.9
 * at the floor, with no offset losing its third probe. A skipped cell skips a
 * hashmap walk and four irradiance taps, which is what a cell here costs.
 */
const GATHER_CULL = 0.05;

/**
 * Pixel budget for the gather pass, which runs at the largest integer divisor of
 * the output that fits inside it.
 *
 * The gather is the expensive half of shading — up to 27 hashmap probes and 27
 * bilinear field taps per pixel, and twice that inside a LOD overlap band — and
 * it is also the half that carries no detail: it reconstructs a field whose
 * finest feature is a probe cell, which is many pixels across at any distance
 * worth looking at. Letting the hardware bilinear-upsample it costs nothing
 * visible. Albedo and emissive stay at full resolution, so edges stay sharp —
 * only the light crossing them is interpolated.
 *
 * A budget rather than a fixed divisor because the cost is per gathered pixel,
 * not per output pixel: at 4K a divisor tuned for 1080p is four times the work
 * for the same picture. 1280×720 is the divisor-2 cost of a 1080p window, which
 * is where this was tuned.
 *
 * ponytail: a plain bilinear upsample, not a bilateral one. It bleeds irradiance
 * about a pixel across a silhouette. Upgrade path if that shows: weight the four
 * taps by the g-buffer normal and position the composite already reads.
 */
const GI_PIXELS = 1280 * 720;

/** R2 low-discrepancy sequence (§5.1), as `u32` fixed point so large indices stay exact. */
const R2_A1 = 3242174889; // round(2³² / φ₂)
const R2_A2 = 2447445413; // round(2³² / φ₂²)
/** Three more axes, from the 3D plastic constant, for samples that must not track direction. */
const R2_A3 = 3518319155; // round(2³² / φ₃)
const R2_A4 = 2882110345; // round(2³² / φ₃²)
const R2_A5 = 2360945575; // round(2³² / φ₃³)

const GBUFFER_NAMES = ["output", "albedo", "worldPosition"] as const;
/**
 * Alpha a fragment writes into the world-position attachment. Not 1: the extra
 * MRT attachments clear to opaque whatever the renderer's clear alpha is, so
 * only a value the clear cannot produce separates surface from background.
 */
const GBUFFER_HIT = 2;

export interface SplitRCOptions {
  /** Base probe spacing `Δs₀`, in world units. Defaults to 4 voxels. */
  probeSpacing?: number;
  /** Probe capacity for cascade 0. Higher cascades hold a quarter each. */
  probeCapacity?: number;
  /** Rays cast per frame, as a fraction of the screen's pixels. */
  rayDensity?: number;
  /** Radiance returned by rays that leave the scene without hitting anything. */
  skyColor?: Color;
  skyIntensity?: number;
  /**
   * Fraction of a probe direction's previous value kept when new rays arrive
   * (§5.2). Directions with no rays this frame keep their history untouched.
   */
  temporalBlend?: number;
  /** Number of LOD levels (§4.1). Each doubles `Δs₀` and `t₀`. */
  lodCount?: number;
  /** Chebyshev distance from the camera at which LOD 1 begins. Defaults to `16 Δs₀`. */
  lodDistance?: number;
  voxel?: VoxelSceneOptions;
}

/**
 * What the composite pass writes. Everything but `composite` is a debug output
 * of one input the solve depends on, so a wrong picture can be traced to the
 * stage that produced it rather than guessed at.
 */
export const SPLIT_DEBUG_VIEWS = [
  /** The lit frame. */
  "composite",
  /** Incident irradiance alone, without albedo — the cascade's own output. */
  "light",
  /** The emissive g-buffer: what the cascades treat as light sources. */
  "emissive",
  /** The albedo g-buffer. */
  "albedo",
  /** World normals, the direction the irradiance field is sampled in. */
  "normal",
  /** LOD assignment (§4.1), blended across the overlap band as the solve blends it. */
  "lod",
  /** The voxel grid at the visible surface — what the rays actually hit. */
  "voxel",
  /**
   * Highest cascade whose probe over the pixel was actually allocated — the
   * depth of the sparse chain rather than a property of the position. Every
   * cascade is seeded from the one below it, so anything short of the top
   * cascade is a cascade that ran out of capacity.
   */
  "cascadeIndex",
  /**
   * Probe index in the cascade {@link SplitRC#debugCascade} selects, hashed to a
   * colour. One probe is one flat patch, so the sparse lattice reads as a
   * tessellation and a cell with no probe reads as a hole.
   */
  "probeIndex",
] as const;

export type SplitDebugView = (typeof SPLIT_DEBUG_VIEWS)[number];

/** Cascade count `N` (§7), so a caller can range over {@link SplitRC#debugCascade}. */
export const SPLIT_CASCADES = CASCADES;

/** Default of {@link SplitRC#t0Scale}, so a control can start where the solver does. */
export const SPLIT_T0_OVER_DS0 = T0_OVER_DS0;

/** One cascade's row in a {@link SplitRC#inspectPixel} report. */
export interface SplitProbeEntry {
  cascade: number;
  /** LOD the lookup resolved at: the base LOD unless only the one above held a probe. */
  lod: number;
  /** `Δsₙ` at that LOD, in world units. */
  spacing: number;
  /** Grid coordinate `⌊x/Δsₙ⌋` the position quantises to. */
  coord: [number, number, number];
  /** Centre of that cell, `Δsₙ(coord + ½)` — where the probe sits. */
  center: [number, number, number];
  /** The packed hashmap key; see `packKey`. */
  key: number;
  /** Slot the key hashes to before linear probing. */
  homeSlot: number;
  /** Slot that ended up holding the key, or null when it is absent. */
  slot: number | null;
  /** Probe index within the cascade — what its per-probe arrays are indexed by. */
  probe: number | null;
  probeCapacity: number;
  /** `full` is a probe the insert dropped because the cascade was at capacity. */
  status: "found" | "missing" | "full";
}

/** What {@link SplitRC#inspectPixel} reports for one pixel. */
export interface SplitProbeReport {
  /** Device pixel inspected, y measured from the top. */
  pixel: [number, number];
  /** False when the pixel holds no surface, in which case nothing below it means anything. */
  hit: boolean;
  position: [number, number, number];
  /** LOD the position falls in, the LOD above it, and the blend between them (§4.1). */
  lod: number;
  nextLod: number;
  lodWeight: number;
  /** `Δs₀` at LOD 0. */
  spacing0: number;
  cascades: SplitProbeEntry[];
}

/** Per-cascade sizes, all fixed at construction so they constant-fold into the kernels. */
interface CascadeLayout {
  /** `Θₙ`. */
  theta: number;
  /** `|Ω_In| = 2Θₙ²`. */
  directions: number;
  probeCapacity: number;
  hashCapacity: number;
  hashBase: number;
  probeBase: number;
  /** Offset into the per-(probe, direction) arrays. */
  slotBase: number;
  /** `Δsₙ / Δs₀`. */
  spacing: number;
  /** `t_{n−1} / t₀`. */
  nearDistance: number;
  /** `tₙ / t₀`. */
  farDistance: number;
}

function buildLayout(probeCapacity0: number): CascadeLayout[] {
  const layout: CascadeLayout[] = [];
  let hashBase = 0;
  let probeBase = 0;
  let slotBase = 0;
  // tₙ = t₀(l^{n+1} − 1)/(l − 1): interval n has length t₀·lⁿ, and tₙ is the sum
  // of every interval up to it. t₋₁ = 0.
  let near = 0;
  let length = 1;
  for (let n = 0; n < CASCADES; n++) {
    const theta = THETA_0 * 2 ** n;
    const directions = 2 * theta * theta;
    const probes = Math.max(1, probeCapacity0 >> (2 * n));
    const hashCapacity = probes * HASH_LOAD;
    const far = near + length;
    layout.push({
      theta,
      directions,
      probeCapacity: probes,
      hashCapacity,
      hashBase,
      probeBase,
      slotBase,
      spacing: SPACING_SCALE ** n,
      nearDistance: near,
      farDistance: far,
    });
    hashBase += hashCapacity;
    probeBase += probes;
    slotBase += probes * directions;
    near = far;
    length *= LENGTH_SCALE;
  }
  return layout;
}

function passMaterial(node: Node): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  material.fragmentNode = node;
  return material;
}

function signNonZero(value: Node<"float">): Node<"float"> {
  return select(value.greaterThanEqual(0), float(1), float(-1));
}

function signNonZero2(value: Node<"vec2">): Node<"vec2"> {
  return vec2(signNonZero(value.x), signNonZero(value.y));
}

function encodeOctahedral(normal: Node<"vec3">): Node<"vec2"> {
  const projected = normal.xy.div(
    max(abs(normal.x).add(abs(normal.y)).add(abs(normal.z)), 1e-6),
  );
  const folded = vec2(
    float(1).sub(abs(projected.y)),
    float(1).sub(abs(projected.x)),
  ).mul(signNonZero2(projected));
  return select(normal.z.greaterThanEqual(0), projected, folded);
}

function decodeOctahedral(encoded: Node<"vec2">): Node<"vec3"> {
  const z = float(1).sub(abs(encoded.x)).sub(abs(encoded.y));
  const fold = max(z.negate(), float(0));
  return vec3(encoded.sub(signNonZero2(encoded).mul(fold)), z).normalize();
}

/** One colour per LOD for the `lod` debug view; LOD 3 and up share the last. */
function lodColor(level: Node<"uint">): Node<"vec3"> {
  return select(
    level.equal(uint(0)),
    vec3(1, 0.3, 0.25),
    select(
      level.equal(uint(1)),
      vec3(0.35, 1, 0.4),
      select(level.equal(uint(2)), vec3(0.35, 0.55, 1), vec3(1, 0.95, 0.4)),
    ),
  );
}

/**
 * One colour per cascade for the `cascadeIndex` view, and black for a pixel no
 * cascade covers. Deliberately not {@link lodColor}: the two views answer
 * different questions and a shared palette would invite reading one as the other.
 */
function cascadeColor(index: Node<"int">): Node<"vec3"> {
  return select(
    index.equal(int(0)),
    vec3(0.95, 0.35, 0.5),
    select(
      index.equal(int(1)),
      vec3(0.95, 0.7, 0.25),
      select(
        index.equal(int(2)),
        vec3(0.4, 0.85, 0.6),
        select(index.equal(int(3)), vec3(0.45, 0.65, 0.95), vec3(0)),
      ),
    ),
  );
}

/**
 * Floor on every channel of {@link probeColor}, which leaves the saturated
 * markers the `probeIndex` view uses for "no probe" unreachable by a real index.
 */
const PROBE_FLOOR = 0.28;

/**
 * Algorithm 2, forward direction: an equal-area map from the unit sphere to the
 * unit square. §4 notes that octahedral and Clarberg schemes gave worse quality
 * here despite distributing more uniformly.
 */
const encodeDir = Fn(([w]: [Node<"vec3">]) => {
  const phi = atan(w.y, w.x);
  return vec2(fract(phi.div(TAU)), w.z.add(1).mul(0.5));
});

/** Algorithm 2, inverse direction. */
const decodeDir = Fn(([uv]: [Node<"vec2">]) => {
  const phi = uv.x.mul(TAU);
  const z = uv.y.mul(2).sub(1);
  const r = sqrt(max(float(0), float(1).sub(z.mul(z))));
  return vec3(r.mul(cos(phi)), r.mul(sin(phi)), z);
});

/**
 * Probe key: grid coordinates plus the LOD, in a single `u32`.
 *
 * ponytail: the paper packs 18 bits per axis and 10 for the LOD into 64 bits.
 * A single 32-bit word is used instead because the hashmap publishes keys
 * through relaxed atomics — a two-word key could be read half-updated, and a
 * torn key matches neither the reader's own key nor "empty", which would send
 * the reader off to claim a second slot for a probe that already exists. 9 bits
 * per axis covers ±256 probes per cascade per LOD, an order of magnitude beyond
 * what the voxel grid's extent can reach. Upgrade path if the grid ever grows:
 * two atomic words with a published-flag word to order them.
 */
const packKey = Fn(([coord, lod]: [Node<"vec3">, Node<"uint">]) => {
  const biased = clamp(coord.add(COORD_BIAS), vec3(0), vec3(COORD_MASK));
  const x = uint(biased.x);
  const y = uint(biased.y);
  const z = uint(biased.z);
  // Bit 31 marks the key as occupied, so a valid key is never zero and zero can
  // stand for an empty slot.
  //
  // Written as the unsigned literal, not `1 << 31`: JavaScript's shift is signed,
  // so that expression is −2147483648, and the negative reaches `uint()` as a
  // constant it cannot represent. The bit then never got set on the GPU, and the
  // CPU mirror below — which does set it — matched nothing, which is what made
  // inspectPixel report every cell missing.
  return x
    .add(y.shiftLeft(uint(COORD_BITS)))
    .add(z.shiftLeft(uint(COORD_BITS * 2)))
    .add(lod.shiftLeft(uint(COORD_BITS * 3)))
    .bitOr(uint(KEY_OCCUPIED));
});

/**
 * CPU mirrors of {@link packKey} and {@link hashKeyToSlot}, for
 * {@link SplitRC#inspectPixel}.
 *
 * ponytail: mirrored rather than shared, because the originals are TSL node
 * graphs that only exist inside a shader. Keep each pair in step — a mirror that
 * drifts makes the inspector report a plausible probe belonging to another cell,
 * which is worse than reporting nothing. `splitrc.check.ts` derives both
 * independently and checks them.
 */
function packKeyCpu(coord: readonly [number, number, number], lod: number): number {
  const biased = (v: number) => Math.min(COORD_MASK, Math.max(0, v + COORD_BIAS));
  return (
    ((biased(coord[0]) +
      (biased(coord[1]) << COORD_BITS) +
      (biased(coord[2]) << (COORD_BITS * 2)) +
      (lod << (COORD_BITS * 3))) |
      KEY_OCCUPIED) >>>
    0
  );
}

function hashSlotCpu(key: number): number {
  let h = Math.imul(key, 2654435761) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 2246822519) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * Perlin's quintic fade `6f⁵ − 15f⁴ + 10f³`, applied to an interpolation
 * fraction before it is used.
 *
 * A tent weight is C⁰ in the fraction, so its first derivative jumps as the
 * fraction wraps at a cell face and its second derivative is a delta there.
 * Filtering the probe *values* ({@link PROBE_FILTER_CENTRE}) cannot remove that,
 * because it is the reconstruction that is kinked, not the data. The fade is
 * flat to second order at both ends, so consecutive cells meet with matching
 * slope and curvature and the face stops being locatable — the same reason
 * Perlin noise uses it, and the same lattice it hides.
 *
 * Only for fractions read per pixel. The cascade-to-cascade weights in
 * {@link SplitRC#writeNeighbours} are sampled at fixed positions on the parent
 * lattice, where a fade would push each weight toward its nearest node and make
 * the transfer blockier rather than smoother.
 */
function fade(f: Node<"float">): Node<"float">;
function fade(f: Node<"vec3">): Node<"vec3">;
// ponytail: overloaded rather than generic. The node operators are typed per
// component count, so a type parameter makes `mul` resolve against a union and
// the arithmetic stops checking at all.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fade(f: any): any {
  return f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
}

/** Fibonacci-style 32-bit avalanche; only needs to spread, not to be secure. */
const hashKeyToSlot = Fn(([key]: [Node<"uint">]) => {
  const h = key.mul(uint(2654435761)).toVar();
  h.assign(h.bitXor(h.shiftRight(uint(15))));
  h.assign(h.mul(uint(2246822519)));
  h.assign(h.bitXor(h.shiftRight(uint(13))));
  return h;
});

/**
 * A stable colour per probe index, for the `probeIndex` view. The point is that
 * consecutive indices land on unrelated colours: a probe's cell then reads as
 * one flat patch against its neighbours rather than as a gradient across them.
 */
const probeColor = Fn(([index]: [Node<"uint">]) => {
  // The same avalanche the hashmap uses, offset so probe 0 is not a fixed point.
  const h = hashKeyToSlot(index.add(uint(0x9e3779b9))).toVar();
  const channel = (shift: number) =>
    float(h.shiftRight(uint(shift)).bitAnd(uint(255)))
      .div(255)
      .mul(1 - PROBE_FLOOR)
      .add(PROBE_FLOOR);
  return vec3(channel(0), channel(8), channel(16));
});

/**
 * Real-time diffuse global illumination by Split Radiance Cascades
 * (Freeman & Sannikov), applied in full 3D world space.
 *
 * The structure is the paper's: a sparse world-space radiance-probe hierarchy,
 * one lockless hashmap per cascade rebuilt every frame, rays spawned from
 * on-screen surfaces and *split* across cascades by their hit distance, a merge
 * from the top cascade down, and a per-probe octahedral irradiance field the
 * final shading pass interpolates.
 *
 * Two things differ from the paper, both forced by the platform and both marked
 * at their definition: rays are cast against a voxel grid rather than hardware
 * ray tracing ({@link VoxelScene}), and the deposit accumulates in `u32` fixed
 * point because WebGPU has no float atomics.
 *
 * The paper's Morton ordering of directional data and its pre-averaging of
 * `I_n` are not reproduced. Both are memory-layout optimisations from §6 that
 * leave the computed result identical; the neighbour table this class builds
 * once per frame plays the same role as the shared-memory probe lookups they
 * describe.
 */
export class SplitRC {
  readonly voxels: VoxelScene;

  private readonly renderer: WebGPURenderer;
  private readonly layout: CascadeLayout[];
  private readonly totalHash: number;
  private readonly totalProbes: number;
  private readonly totalSlots: number;
  private readonly rayCapacity: number;

  private readonly gbuffer: RenderTarget;
  private readonly gbufferMrt: MRTNode;
  private readonly quad = new QuadMesh();
  /** Gathered irradiance within the {@link GI_PIXELS} budget; the composite upsamples it. */
  private readonly giTarget: RenderTarget;
  private readonly giMaterial: MeshBasicNodeMaterial;
  private readonly compositeMaterial: MeshBasicNodeMaterial;

  private readonly hashKey: UintArray;
  private readonly hashClaim: UintArray;
  private readonly hashProbe: UintArray;
  private readonly hashKeyRead: UintArray;
  private readonly hashProbeRead: UintArray;
  private readonly hashKeyHistory: UintArray;
  private readonly hashProbeHistory: UintArray;
  private readonly probeKey: UintArray;
  /**
   * Each probe's index in the *previous* frame's map, resolved once per probe
   * instead of once per direction inside the merge.
   *
   * The merge is the one kernel dispatched per (probe, direction), so anything
   * it does that only depends on the probe is done `|Ω|` times over — at the top
   * cascade that is 2048 linear-probe hashmap walks for one answer.
   */
  private readonly historyProbe: UintArray;
  /** The six c0 lattice neighbours of each c0 probe; see {@link buildProbeNeighbours}. */
  private readonly probeNeighbour: UintArray;
  private readonly parentIndex: UintArray;
  private readonly counters: UintArray;
  private readonly numRays: UintArray;
  private readonly cursor: UintArray;
  private readonly deposit: UintArray;
  private readonly merged: VecArray;
  private readonly history: VecArray;
  /**
   * `mₙ⁻¹(ω)` pre-averaged (§6): for every cascade n+1 probe and every cascade
   * n direction, the mean of the four cascade n+1 cones that map to it.
   *
   * Without it the merge reads four cones from each of eight trilinear
   * neighbours — 32 reads of {@link merged} per thread, and it is the widest
   * read in the solve. The four cones are the same for every neighbour, so
   * averaging them once per parent probe turns those 32 into 8.
   */
  private readonly averaged: VecArray;
  /** Base of cascade n's block in {@link averaged}; the top cascade has none. */
  private readonly averageBase: number[] = [];
  private readonly neighbour: Vec2Array;
  private readonly candidate: UintArray;
  private readonly irradiance: VecArray;
  /** {@link irradiance} convolved with the probe lattice; what shading reads. */
  private readonly irradianceSmooth: VecArray;
  private readonly irradianceHistory: VecArray;

  private readonly uSpacing0 = uniform(1);
  private readonly uOffset = uniform(0.01);
  private readonly uCamera = uniform(new Vector3());
  private readonly uLodDistance = uniform(1);
  private readonly uT0 = uniform(T0_OVER_DS0);
  private readonly lodCount: number;
  private readonly uJitter = uniform(new Vector2());
  private readonly uRayCount = uniform(0, "uint");
  private readonly uRayGrid = uniform(new Vector2());
  private readonly uSky = uniform(new Vector3());
  private readonly uBlend = uniform(0);
  private readonly uDebug = uniform(0, "int");
  /** Which cascade the `probeIndex` view reads; see {@link debugCascade}. */
  private readonly uDebugCascade = uniform(0, "int");
  /** Sky colour at intensity 1, so the intensity stays adjustable. */
  private readonly skyBase = new Vector3();

  private readonly kernels: {
    clearHash: ComputeKernel;
    clearDeposit: ComputeKernel;
    insert: ComputeKernel[][];
    neighbours: ComputeKernel[];
    historyProbe: ComputeKernel[];
    probeNeighbours: ComputeKernel;
    countPixels: ComputeKernel;
    countCascade: ComputeKernel[];
    offsetTop: ComputeKernel;
    offsetCascade: ComputeKernel[];
    trace: ComputeKernel;
    merge: ComputeKernel[];
    irradiance: ComputeKernel;
    probeFilter: ComputeKernel[];
    border: ComputeKernel;
    saveHistory: ComputeKernel;
  };

  private readonly drawingBufferSize = new Vector2();
  private readonly previousClearColor = new Color();
  private builtScene: Scene | null = null;
  private frame = 0;

  constructor(renderer: WebGPURenderer, options: SplitRCOptions = {}) {
    this.renderer = renderer;
    this.voxels = new VoxelScene(renderer, options.voxel);
    this.layout = buildLayout(options.probeCapacity ?? 8192);

    const last = this.layout[CASCADES - 1]!;
    this.totalHash = last.hashBase + last.hashCapacity;
    this.totalProbes = last.probeBase + last.probeCapacity;
    this.totalSlots = last.slotBase + last.probeCapacity * last.directions;

    // Rays are the frame's dominant cost, and §5.2's temporal accumulation is
    // what lets the per-frame count sit well below the number of directions.
    const density = options.rayDensity ?? 0.0625;
    this.rayCapacity = 1 << Math.round(Math.log2(Math.max(1024, 1920 * 1080 * density)));

    this.skyBase.set(
      options.skyColor?.r ?? 0.02,
      options.skyColor?.g ?? 0.025,
      options.skyColor?.b ?? 0.035,
    );
    this.uSky.value.copy(this.skyBase).multiplyScalar(options.skyIntensity ?? 1);
    this.uBlend.value = options.temporalBlend ?? 0.85;
    this.lodCount = Math.max(1, Math.min(1 << LOD_BITS, options.lodCount ?? 4));

    this.hashKey = uintArray(this.totalHash).toAtomic();
    this.hashClaim = uintArray(this.totalHash).toAtomic();
    this.hashProbe = uintArray(this.totalHash).toAtomic();
    this.hashKeyRead = readOnlyView(this.hashKey, this.totalHash);
    this.hashProbeRead = readOnlyView(this.hashProbe, this.totalHash);
    this.hashKeyHistory = uintArray(this.totalHash);
    this.hashProbeHistory = uintArray(this.totalHash);
    this.probeKey = uintArray(this.totalProbes);
    this.historyProbe = uintArray(this.totalProbes);
    this.probeNeighbour = uintArray(this.layout[0]!.probeCapacity * 6);
    this.parentIndex = uintArray(this.totalProbes);
    this.counters = uintArray(8).toAtomic();
    this.numRays = uintArray(this.totalProbes).toAtomic();
    this.cursor = uintArray(this.totalProbes).toAtomic();
    this.deposit = uintArray(this.totalSlots * DEPOSIT_LANES).toAtomic();
    this.merged = vecArray(this.totalSlots);
    this.history = vecArray(this.totalSlots);
    let averagedSize = 0;
    for (let n = 0; n < CASCADES - 1; n++) {
      this.averageBase.push(averagedSize);
      averagedSize += this.layout[n + 1]!.probeCapacity * this.layout[n]!.directions;
    }
    this.averaged = vecArray(averagedSize);
    // Index and weight share one buffer: the merge kernel is at WebGPU's
    // eight-storage-buffers-per-stage limit, and a probe index is small enough
    // to survive the round trip through an f32 exactly.
    this.neighbour = vec2Array(this.totalProbes * 8);
    this.candidate = uintArray(Math.max(this.rayCapacity, this.layout[0]!.probeCapacity) * 2);
    this.irradiance = vecArray(this.layout[0]!.probeCapacity * IRRADIANCE_TEXELS);
    this.irradianceSmooth = vecArray(this.layout[0]!.probeCapacity * IRRADIANCE_TEXELS);
    this.irradianceHistory = vecArray(this.layout[0]!.probeCapacity * IRRADIANCE_TEXELS);

    this.gbuffer = new RenderTarget(1, 1, {
      count: GBUFFER_NAMES.length,
      type: HalfFloatType,
    });
    GBUFFER_NAMES.forEach((name, i) => {
      const tex = this.gbuffer.textures[i]!;
      tex.name = name;
      tex.minFilter = NearestFilter;
      tex.magFilter = NearestFilter;
    });
    // World position needs more range and precision than a half float carries
    // once a scene is more than a few dozen units across.
    this.gbuffer.textures[2]!.type = FloatType;

    const encodedNormal = encodeOctahedral(normalWorld);
    this.gbufferMrt = mrt({
      output: vec4(emissive, encodedNormal.x),
      albedo: vec4(diffuseColor.rgb, encodedNormal.y),
      worldPosition: vec4(positionWorld, GBUFFER_HIT),
    });

    // Left on the default linear filtering, which is the upsample.
    this.giTarget = new RenderTarget(1, 1, { type: HalfFloatType });
    this.giTarget.texture.name = "irradiance";

    this.kernels = this.buildKernels();
    this.giMaterial = passMaterial(this.buildGather());
    this.compositeMaterial = passMaterial(this.buildComposite());

    const spacing = options.probeSpacing ?? 0;
    if (spacing > 0) this.uSpacing0.value = spacing;
    this.uLodDistance.value = options.lodDistance ?? 0;
  }

  /**
   * `t₀` in units of `Δs₀`; see {@link T0_OVER_DS0}, which is the default.
   *
   * A uniform and not a constant because it is the one knob that moves the
   * cascade bounds without moving anything else: every artifact at a fixed
   * distance from a light is a bound, and every artifact that stays put while
   * this is dragged is not. Nothing else in the solver can tell those apart.
   */
  get t0Scale(): number {
    return this.uT0.value;
  }

  set t0Scale(value: number) {
    this.uT0.value = Math.max(value, 0.1);
  }

  /** §5.2 history kept when new rays arrive. */
  get temporalBlend(): number {
    return this.uBlend.value;
  }

  set temporalBlend(value: number) {
    this.uBlend.value = Math.min(Math.max(value, 0), 0.99);
  }

  /** Scales the radiance returned by rays that leave the scene. */
  get skyIntensity(): number {
    return this.skyBase.length() > 0 ? this.uSky.value.length() / this.skyBase.length() : 0;
  }

  set skyIntensity(value: number) {
    this.uSky.value.copy(this.skyBase).multiplyScalar(Math.max(value, 0));
  }

  /** Which of {@link SPLIT_DEBUG_VIEWS} the composite pass writes. */
  get debugView(): SplitDebugView {
    return SPLIT_DEBUG_VIEWS[this.uDebug.value] ?? "composite";
  }

  set debugView(view: SplitDebugView) {
    this.uDebug.value = Math.max(SPLIT_DEBUG_VIEWS.indexOf(view), 0);
  }

  /**
   * Cascade the `probeIndex` debug view reads, in `[0, SPLIT_CASCADES)`. Probe
   * spacing doubles per cascade, so stepping this is what shows the hierarchy:
   * the same surface retiles into cells twice as wide at every step.
   */
  get debugCascade(): number {
    return this.uDebugCascade.value;
  }

  set debugCascade(cascade: number) {
    this.uDebugCascade.value = Math.min(Math.max(Math.trunc(cascade), 0), CASCADES - 1);
  }

  /**
   * Rebuilds the voxel grid and rescales the cascade to it. Called
   * automatically the first time a scene is rendered, and whenever the scene
   * object changes; call it directly after editing geometry in place.
   */
  build(scene: Scene): void {
    this.voxels.build(scene);
    this.builtScene = scene;
    // Δs₀ defaults to four voxels: fine enough that c0's t₀ ≈ 6.4 voxels still
    // resolves contact-scale shadowing, coarse enough that a room's visible
    // surfaces fit the c0 probe budget.
    if (this.uSpacing0.value <= 1e-6 || !Number.isFinite(this.uSpacing0.value)) {
      this.uSpacing0.value = this.voxels.voxelSize * 4;
    }
    this.uOffset.value = this.voxels.voxelSize * 1.5;
    if (this.uLodDistance.value <= 0) {
      this.uLodDistance.value = this.uSpacing0.value * 16;
    }
  }

  render(scene: Scene, camera: Camera): void {
    const outputTarget = this.renderer.getRenderTarget();
    const previousMrt = this.renderer.getMRT();
    const previousAutoClear = this.renderer.autoClear;
    this.renderer.getClearColor(this.previousClearColor);
    const previousClearAlpha = this.renderer.getClearAlpha();

    if (this.builtScene !== scene) this.build(scene);
    this.resize(outputTarget);

    try {
      this.renderer.autoClear = true;
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setMRT(this.gbufferMrt);
      this.renderer.setRenderTarget(this.gbuffer);
      this.renderer.render(scene, camera);
      this.renderer.setMRT(null);

      camera.getWorldPosition(this.uCamera.value);
      this.voxels.update(scene);
      this.solve();

      this.renderer.setRenderTarget(this.giTarget);
      this.quad.material = this.giMaterial;
      this.quad.render(this.renderer);

      this.renderer.setRenderTarget(outputTarget);
      this.quad.material = this.compositeMaterial;
      this.quad.render(this.renderer);
    } finally {
      this.renderer.setRenderTarget(outputTarget);
      this.renderer.setMRT(previousMrt);
      this.renderer.setClearColor(this.previousClearColor, previousClearAlpha);
      this.renderer.autoClear = previousAutoClear;
    }
  }

  /**
   * Probes allocated per cascade last frame against their capacity, plus the
   * rays handed out. A cascade at capacity is silently dropping probes, which
   * shows up as unlit patches; raise `probeCapacity` or `probeSpacing`.
   */
  async stats(): Promise<{ probes: number[]; capacity: number[]; rays: number }> {
    const raw = await this.renderer.getArrayBufferAsync(this.counters.value);
    const counts = new Uint32Array(raw);
    return {
      probes: Array.from(counts.slice(0, CASCADES)),
      capacity: this.layout.map((info) => info.probeCapacity),
      rays: counts[4] ?? 0,
    };
  }

  /**
   * The probe hierarchy over one pixel: its surface position, the LOD it falls
   * in, and the cell, key, hash slot and probe index of every cascade above it.
   * The numbers behind the `cascadeIndex` and `probeIndex` debug views — which
   * show where probes are missing, while this says which ones.
   *
   * `x` and `y` are device pixels of the drawing buffer with `y` measured from
   * the top, matching a pointer event's coordinates times the pixel ratio. The
   * position comes from the same g-buffer texel the composite shades, so a
   * report and the colour under the cursor always agree.
   *
   * Debug only: it reads both hashmaps back in full, which stalls the queue.
   * Call it from an interaction, not from the frame loop.
   */
  async inspectPixel(x: number, y: number): Promise<SplitProbeReport> {
    const px = Math.min(Math.max(Math.round(x), 0), this.gbuffer.width - 1);
    const py = Math.min(Math.max(Math.round(y), 0), this.gbuffer.height - 1);
    const empty: SplitProbeReport = {
      pixel: [px, py],
      hit: false,
      position: [0, 0, 0],
      lod: 0,
      nextLod: 0,
      lodWeight: 0,
      spacing0: this.uSpacing0.value,
      cascades: [],
    };
    if (!this.builtScene) return empty;

    // Attachment 2 is worldPosition, the one attachment kept at full float
    // precision; its alpha is GBUFFER_HIT wherever a surface wrote.
    const texel = await this.renderer.readRenderTargetPixelsAsync(this.gbuffer, px, py, 1, 1, 2);
    if (!texel || texel.length < 4 || (texel[3] ?? 0) <= GBUFFER_HIT * 0.5) return empty;
    const position: [number, number, number] = [texel[0]!, texel[1]!, texel[2]!];

    const { lod, next, weight } = this.lodBlendCpu(position);
    const [keys, probes] = await Promise.all([
      this.renderer.getArrayBufferAsync(this.hashKey.value),
      this.renderer.getArrayBufferAsync(this.hashProbe.value),
    ]);
    const keyWords = new Uint32Array(keys);
    const probeWords = new Uint32Array(probes);

    const cascades = this.layout.map((info, cascade) => {
      const at = (level: number) => this.entryFor(info, cascade, position, level, keyWords, probeWords);
      const entry = at(lod);
      // The same fallback the debug views make, and for the same reason: within
      // the overlap band a cell may only have been seeded at the LOD above.
      return entry.status === "missing" && next !== lod ? at(next) : entry;
    });

    return {
      pixel: [px, py],
      hit: true,
      position,
      lod,
      nextLod: next,
      lodWeight: weight,
      spacing0: this.uSpacing0.value,
      cascades,
    };
  }

  /**
   * One cascade's row of an {@link inspectPixel} report, resolved at one LOD.
   *
   * CPU mirror of {@link stencilProbe}: the heaviest trilinear neighbour that
   * exists, or the containing cell when none of the eight do, so a `missing` row
   * still names a cell. Reporting the containing cell unconditionally would
   * disagree with the view beside it — see {@link stencilProbe} for why.
   */
  private entryFor(
    info: CascadeLayout,
    cascade: number,
    position: readonly [number, number, number],
    lod: number,
    keys: Uint32Array,
    probes: Uint32Array,
  ): SplitProbeEntry {
    const spacing = this.uSpacing0.value * info.spacing * 2 ** lod;
    const grid = position.map((v) => v / spacing - 0.5);
    const corner = grid.map(Math.floor);
    const frac = grid.map((v, i) => v - corner[i]!);

    let best: SplitProbeEntry | null = null;
    let bestWeight = -1;
    for (let i = 0; i < 8; i++) {
      const bits = [i & 1, (i >> 1) & 1, (i >> 2) & 1];
      const weight = bits.reduce((p, b, d) => p * (b ? frac[d]! : 1 - frac[d]!), 1);
      const at: [number, number, number] = [
        corner[0]! + bits[0]!,
        corner[1]! + bits[1]!,
        corner[2]! + bits[2]!,
      ];
      const entry = this.entryAt(info, cascade, at, lod, spacing, keys, probes);
      // `full` is kept only as a last resort, matching stencilProbe: a cascade at
      // capacity should not mask a neighbour that did get a probe.
      const rank = entry.status === "found" ? weight : entry.status === "full" ? -0.5 : -1;
      if (rank > bestWeight) {
        bestWeight = rank;
        best = entry;
      }
    }
    if (best && bestWeight > -1) return best;

    const containing: [number, number, number] = [
      Math.floor(position[0] / spacing),
      Math.floor(position[1] / spacing),
      Math.floor(position[2] / spacing),
    ];
    return this.entryAt(info, cascade, containing, lod, spacing, keys, probes);
  }

  /** The row for one specific cell: the reader's half of the insertion. */
  private entryAt(
    info: CascadeLayout,
    cascade: number,
    coord: [number, number, number],
    lod: number,
    spacing: number,
    keys: Uint32Array,
    probes: Uint32Array,
  ): SplitProbeEntry {
    const key = packKeyCpu(coord, lod);
    const mask = info.hashCapacity - 1;
    const homeSlot = hashSlotCpu(key) & mask;

    // The reader's half of §6's insertion: walk the probe sequence until the key
    // turns up or an empty slot proves it was never inserted. Mirrors `lookup`,
    // including its round count — a key beyond that is unreachable to the solve
    // too, so reporting it found would be a lie.
    let slot: number | null = null;
    let stored = PROBE_PENDING;
    for (let round = 0, at = homeSlot; round < INSERT_ROUNDS; round++, at = (at + 1) & mask) {
      const word = keys[info.hashBase + at];
      if (word === key) {
        slot = at;
        stored = probes[info.hashBase + at] ?? PROBE_PENDING;
        break;
      }
      if (word === 0) break;
    }

    const found = slot !== null && stored < PROBE_OVERFLOW;
    return {
      cascade,
      lod,
      spacing,
      coord,
      center: [
        (coord[0] + 0.5) * spacing,
        (coord[1] + 0.5) * spacing,
        (coord[2] + 0.5) * spacing,
      ],
      key,
      homeSlot,
      slot,
      probe: found ? stored - info.probeBase : null,
      probeCapacity: info.probeCapacity,
      status: found ? "found" : stored === PROBE_OVERFLOW ? "full" : "missing",
    };
  }

  /** CPU mirror of {@link lodBlend}, for {@link inspectPixel}. */
  private lodBlendCpu(position: readonly [number, number, number]): {
    lod: number;
    next: number;
    weight: number;
  } {
    const camera = this.uCamera.value;
    const chebyshev = Math.max(
      Math.abs(position[0] - camera.x),
      Math.abs(position[1] - camera.y),
      Math.abs(position[2] - camera.z),
    );
    const level = Math.log2(Math.max(chebyshev / this.uLodDistance.value, 1));
    const base = Math.min(Math.max(Math.floor(level), 0), this.lodCount - 1);
    const next = Math.min(base + 1, this.lodCount - 1);
    const band = -Math.log2(LOD_OVERLAP);
    const weight = Math.min(Math.max((level - base - (1 - band)) / band, 0), 1);
    return { lod: base, next, weight: next === base ? 0 : weight };
  }

  dispose(): void {
    this.voxels.dispose();
    this.gbuffer.dispose();
    this.giTarget.dispose();
    this.giMaterial.dispose();
    this.compositeMaterial.dispose();
  }

  /** Algorithm 1, one frame. */
  private solve(): void {
    const k = this.kernels;
    this.frame++;
    // The R2 sequence is jittered every frame so the directions a probe misses
    // this frame are covered by the next one (§5.1).
    this.uJitter.value.set(fractional(this.frame * 0.7548776662), fractional(this.frame * 0.5698402910));

    this.renderer.compute(k.clearHash);
    this.renderer.compute(k.clearDeposit);

    // Initialize probes: screen pixels seed c0, then each cascade seeds the next.
    for (const round of k.insert) {
      for (const kernel of round) this.renderer.compute(kernel);
    }
    for (const kernel of k.neighbours) this.renderer.compute(kernel);
    for (const kernel of k.historyProbe) this.renderer.compute(kernel);
    this.renderer.compute(k.probeNeighbours);

    // Generate rays (Algorithm 3): count per probe bottom-up, then hand out
    // contiguous segments of the sequence top-down.
    this.renderer.compute(k.countPixels);
    for (const kernel of k.countCascade) this.renderer.compute(kernel);
    this.renderer.compute(k.offsetTop);
    for (const kernel of k.offsetCascade) this.renderer.compute(kernel);

    // Trace rays and split them across the cascades they carry information for.
    this.renderer.compute(k.trace);

    // Merge cascades, top down.
    for (const kernel of k.merge) this.renderer.compute(kernel);

    this.renderer.compute(k.irradiance);
    this.renderer.compute(k.border);
    for (const kernel of k.probeFilter) this.renderer.compute(kernel);
    this.renderer.compute(k.saveHistory);
  }

  private resize(outputTarget: RenderTarget | null): void {
    if (outputTarget) {
      this.drawingBufferSize.set(outputTarget.width, outputTarget.height);
    } else {
      this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    }
    this.gbuffer.setSize(this.drawingBufferSize.x, this.drawingBufferSize.y);
    const giScale = Math.max(
      1,
      Math.ceil(Math.sqrt((this.drawingBufferSize.x * this.drawingBufferSize.y) / GI_PIXELS)),
    );
    this.giTarget.setSize(
      Math.max(1, Math.ceil(this.drawingBufferSize.x / giScale)),
      Math.max(1, Math.ceil(this.drawingBufferSize.y / giScale)),
    );

    // Rays are spawned from a regular lattice over the G-buffer rather than one
    // per pixel: §5.1 only needs a constant number per probe, and the lattice
    // keeps that constant while the window resizes.
    const aspect = this.drawingBufferSize.x / Math.max(1, this.drawingBufferSize.y);
    const height = Math.max(1, Math.floor(Math.sqrt(this.rayCapacity / aspect)));
    const width = Math.max(1, Math.floor(this.rayCapacity / height));
    this.uRayGrid.value.set(width, height);
    this.uRayCount.value = width * height;
  }

  // ---------------------------------------------------------------- geometry

  /** `Δsₙ` at a LOD: the base spacing scaled by both the cascade and the LOD. */
  private spacingOf(cascade: number, lod: Node<"uint">): Node<"float"> {
    return this.uSpacing0
      .mul(this.layout[cascade]!.spacing)
      .mul(float(uint(1).shiftLeft(lod)));
  }

  /**
   * `Nearestₙ(x) = Δsₙ(⌊x/Δsₙ⌋ + ½)`, as the grid coordinate `⌊x/Δsₙ⌋`.
   *
   * The quantization commutes with the cascade step — `Nearestₙ(Nearest_{n−1}(x))`
   * is `Nearestₙ(x)`, because spacing doubles — so a ray can address its probe in
   * any cascade directly instead of walking the parent chain.
   */
  private nearestCoord(position: Node<"vec3">, cascade: number, lod: Node<"uint">): Node<"vec3"> {
    return floor(position.div(this.spacingOf(cascade, lod)));
  }

  private probePosition(coord: Node<"vec3">, cascade: number, lod: Node<"uint">): Node<"vec3"> {
    return coord.add(0.5).mul(this.spacingOf(cascade, lod));
  }

  /**
   * LOD from the binary logarithm of the Chebyshev distance to the camera
   * (§4.1) — Chebyshev rather than Euclidean because it aligns with the probe
   * grid and so produces fewer artifacts — together with the overlap band.
   *
   * Each LOD starts at {@link LOD_OVERLAP} of the distance a hard switch would
   * put it at, so consecutive LODs overlap; `weight` runs 0 → 1 across that band
   * and is what hides the seam.
   */
  private lodBlend(position: Node<"vec3">): {
    lod: Node<"uint">;
    next: Node<"uint">;
    weight: Node<"float">;
  } {
    const delta = abs(position.sub(this.uCamera));
    const chebyshev = max(max(delta.x, delta.y), delta.z);
    const level = log2(max(chebyshev.div(this.uLodDistance), 1));
    const base = clamp(floor(level), float(0), float(this.lodCount - 1));
    const lod = uint(base);
    const next = uint(clamp(base.add(1), float(0), float(this.lodCount - 1)));
    const band = -Math.log2(LOD_OVERLAP);
    // Faded for the same reason the trilinear fraction is: a linear ramp still
    // corners at both ends of the band, and the corner is a visible shell around
    // the camera at the distance the LOD changes.
    const weight = fade(clamp(level.sub(base).sub(1 - band).div(band), float(0), float(1)));
    return { lod, next, weight: select(next.equal(lod), float(0), weight) };
  }

  /**
   * A single LOD for one ray or probe. The overlap band is resolved
   * stochastically rather than by inserting into both LODs: probes and rays are
   * numerous enough per band that both grids fill, and the composite still
   * blends smoothly because it samples both.
   */
  private lodFor(position: Node<"vec3">, dither: Node<"float">): Node<"uint"> {
    const { lod, next, weight } = this.lodBlend(position);
    return select(dither.lessThan(weight), next, lod);
  }

  /**
   * Per-index dither in `[0, 1)`, stable within a frame so that the probe a ray
   * is counted against is the probe it deposits into, and decorrelated between
   * frames so the overlap band averages out.
   */
  private dither(index: Node<"uint">): Node<"float"> {
    return fract(this.r2(index).y.add(this.uJitter.y));
  }

  // ---------------------------------------------------------------- hashmap

  /** Looks a key up, returning the probe index or {@link PROBE_PENDING} for absent. */
  private lookup(key: Node<"uint">, cascade: number, plain = false): Node<"uint"> {
    const info = this.layout[cascade]!;
    const mask = info.hashCapacity - 1;
    const home = hashKeyToSlot(key).bitAnd(uint(mask));
    const result = uint(PROBE_PENDING).toVar();
    const slot = home.toVar();
    Loop({ start: 0, end: INSERT_ROUNDS, type: "int", condition: "<" }, () => {
      const index = slot.add(uint(info.hashBase));
      const stored = plain
        ? this.hashKeyRead.element(index)
        : atomicLoad(this.hashKey.element(index));
      If(stored.equal(key), () => {
        result.assign(
          plain ? this.hashProbeRead.element(index) : atomicLoad(this.hashProbe.element(index)),
        );
        Break();
      });
      If(stored.equal(uint(0)), () => {
        Break();
      });
      slot.assign(slot.add(1).bitAnd(uint(mask)));
    });
    return result;
  }

  /** The same lookup against the previous frame's map, for temporal accumulation. */
  private lookupHistory(key: Node<"uint">, cascade: number): Node<"uint"> {
    const info = this.layout[cascade]!;
    const mask = info.hashCapacity - 1;
    const result = uint(PROBE_PENDING).toVar();
    const slot = hashKeyToSlot(key).bitAnd(uint(mask)).toVar();
    Loop({ start: 0, end: INSERT_ROUNDS, type: "int", condition: "<" }, () => {
      const stored = this.hashKeyHistory.element(slot.add(uint(info.hashBase)));
      If(stored.equal(key), () => {
        result.assign(this.hashProbeHistory.element(slot.add(uint(info.hashBase))));
        Break();
      });
      If(stored.equal(uint(0)), () => {
        Break();
      });
      slot.assign(slot.add(1).bitAnd(uint(mask)));
    });
    return result;
  }

  private buildKernels(): SplitRC["kernels"] {
    return {
      clearHash: this.buildClearHash(),
      clearDeposit: this.buildClearDeposit(),
      insert: this.buildInsert(),
      neighbours: this.buildNeighbours(),
      historyProbe: this.buildHistoryProbe(),
      probeNeighbours: this.buildProbeNeighbours(),
      countPixels: this.buildCountPixels(),
      countCascade: this.buildCountCascade(),
      offsetTop: this.buildOffsetTop(),
      offsetCascade: this.buildOffsetCascade(),
      trace: this.buildTrace(),
      merge: this.buildMerge(),
      irradiance: this.buildIrradiance(),
      border: this.buildBorder(),
      probeFilter: this.buildProbeFilter(),
      saveHistory: this.buildSaveHistory(),
    };
  }

  private buildClearHash(): ComputeKernel {
    const count = Math.max(this.totalHash, this.totalProbes);
    return compute(
      Fn(() => {
        If(instanceIndex.lessThan(uint(this.totalHash)), () => {
          atomicStore(this.hashKey.element(instanceIndex), uint(0));
          atomicStore(this.hashClaim.element(instanceIndex), uint(0));
          atomicStore(this.hashProbe.element(instanceIndex), uint(PROBE_PENDING));
        });
        If(instanceIndex.lessThan(uint(this.totalProbes)), () => {
          atomicStore(this.numRays.element(instanceIndex), uint(0));
          atomicStore(this.cursor.element(instanceIndex), uint(0));
        });
        If(instanceIndex.lessThan(uint(8)), () => {
          atomicStore(this.counters.element(instanceIndex), uint(0));
        });
      })(),
      count,
    );
  }

  private buildClearDeposit(): ComputeKernel {
    const count = this.totalSlots * DEPOSIT_LANES;
    return compute(
      Fn(() => {
        atomicStore(this.deposit.element(instanceIndex), uint(0));
      })(),
      count,
    );
  }

  /**
   * One insertion round. A candidate is a key waiting for a probe; `candidate`
   * holds its key and its position in the probe sequence, so the state survives
   * the dispatch boundaries that give the map its memory ordering.
   *
   * The paper inserts with atomic compare-exchange, which TSL does not expose.
   * `atomicAdd` on a separate claim word gives the same exclusivity in one
   * operation — the thread that observes zero owns the slot — at the cost of
   * needing a later round for duplicates to notice the winner's published key.
   */
  private buildInsert(): ComputeKernel[][] {
    const rounds: ComputeKernel[][] = [];
    for (let round = 0; round < INSERT_ROUNDS; round++) {
      const stage: ComputeKernel[] = [];
      for (let n = 0; n < CASCADES; n++) {
        stage.push(this.buildInsertStage(n, round));
      }
      rounds.push(stage);
    }
    // Cascade n's candidates are cascade n−1's probes, so a cascade cannot start
    // until the one below it has finished every round.
    const ordered: ComputeKernel[][] = [];
    for (let n = 0; n < CASCADES; n++) {
      ordered.push(rounds.map((stage) => stage[n]!));
    }
    return ordered;
  }

  private buildInsertStage(cascade: number, round: number): ComputeKernel {
    const info = this.layout[cascade]!;
    const mask = info.hashCapacity - 1;
    const dispatch = cascade === 0 ? this.rayCapacity : this.layout[cascade - 1]!.probeCapacity;

    return compute(
      Fn(() => {
        const keySlot = instanceIndex.mul(2);
        const stepSlot = keySlot.add(1);
        const key = uint(0).toVar();
        const live = uint(0).toVar();

        if (round === 0) {
          // Seed the candidate. c0 comes from the surfaces on screen; every
          // higher cascade comes from the cascade below it, exactly as
          // Algorithm 1 initializes probes.
          if (cascade === 0) {
            If(instanceIndex.lessThan(this.uRayCount), () => {
              const uv = this.rayUv(instanceIndex);
              const world = texture(this.gbuffer.textures[2]!, uv);
              If(world.w.greaterThan(GBUFFER_HIT * 0.5), () => {
                const lod = this.lodFor(world.xyz, this.dither(instanceIndex));
                key.assign(packKey(this.nearestCoord(world.xyz, 0, lod), lod));
                live.assign(uint(1));
              });
            });
          } else {
            const child = this.layout[cascade - 1]!;
            If(instanceIndex.lessThan(atomicLoad(this.counters.element(uint(cascade - 1)))), () => {
              const childKey = this.probeKey.element(instanceIndex.add(uint(child.probeBase)));
              const lod = childKey.shiftRight(uint(COORD_BITS * 3)).bitAnd(uint((1 << LOD_BITS) - 1));
              const coord = this.unpackCoord(childKey);
              const position = this.probePosition(coord, cascade - 1, lod);
              key.assign(packKey(this.nearestCoord(position, cascade, lod), lod));
              live.assign(uint(1));
            });
          }
          this.candidate.element(keySlot).assign(key);
          this.candidate.element(stepSlot).assign(select(live.equal(uint(1)), uint(0), uint(PROBE_PENDING)));
        } else {
          key.assign(this.candidate.element(keySlot));
          const step = this.candidate.element(stepSlot);
          live.assign(select(step.notEqual(uint(PROBE_PENDING)).and(key.notEqual(uint(0))), uint(1), uint(0)));
        }

        If(live.equal(uint(1)), () => {
          const step = round === 0 ? uint(0) : this.candidate.element(stepSlot);
          const slot = hashKeyToSlot(key).add(step).bitAnd(uint(mask)).add(uint(info.hashBase)).toVar();
          const stored = atomicLoad(this.hashKey.element(slot));

          If(stored.equal(key), () => {
            // Either a duplicate of an earlier winner, or this thread's own
            // successful claim from a previous round. Resolved either way.
            this.candidate.element(stepSlot).assign(uint(PROBE_PENDING));
          }).ElseIf(stored.notEqual(uint(0)), () => {
            // Occupied by a different key: advance one slot in the sequence.
            this.candidate.element(stepSlot).assign(this.candidate.element(stepSlot).add(1));
          }).Else(() => {
            const claimed = atomicAdd(this.hashClaim.element(slot), uint(1));
            If(claimed.equal(uint(0)), () => {
              const allocated = atomicAdd(this.counters.element(uint(cascade)), uint(1));
              const overflowed = allocated.greaterThanEqual(uint(info.probeCapacity));
              const probe = select(
                overflowed,
                uint(PROBE_OVERFLOW),
                allocated.add(uint(info.probeBase)),
              );
              If(overflowed.not(), () => {
                this.probeKey.element(probe).assign(key);
              });
              // Published after the probe index so a reader that sees the key in
              // a later dispatch also sees a resolved index.
              atomicStore(this.hashProbe.element(slot), probe);
              atomicStore(this.hashKey.element(slot), key);
              this.candidate.element(stepSlot).assign(uint(PROBE_PENDING));
            });
            // A losing thread leaves its step alone and re-reads the same slot
            // next round, which is what lets duplicates find the winner's key.
          });
        });

      })(),
      dispatch,
    );
  }

  private unpackCoord(key: Node<"uint">): Node<"vec3"> {
    return vec3(
      float(key.bitAnd(uint(COORD_MASK))).sub(COORD_BIAS),
      float(key.shiftRight(uint(COORD_BITS)).bitAnd(uint(COORD_MASK))).sub(COORD_BIAS),
      float(key.shiftRight(uint(COORD_BITS * 2)).bitAnd(uint(COORD_MASK))).sub(COORD_BIAS),
    );
  }

  private lodOf(key: Node<"uint">): Node<"uint"> {
    return key.shiftRight(uint(COORD_BITS * 3)).bitAnd(uint((1 << LOD_BITS) - 1));
  }

  /**
   * Sparse trilinear neighbours (§4): the eight probes of `cascade` surrounding
   * a position, with their trilinear weights renormalised over whichever of
   * them exist. Precomputing them per probe replaces the paper's shared-memory
   * probe lookups — the eight are shared by every direction of the probe, which
   * is the reuse §6 is after.
   */
  private writeNeighbours(
    position: Node<"vec3">,
    cascade: number,
    lod: Node<"uint">,
    base: Node<"uint">,
  ): void {
    const spacing = this.spacingOf(cascade, lod);
    const grid = position.div(spacing).sub(0.5);
    const corner = floor(grid);
    const frac = grid.sub(corner);
    const total = float(0).toVar();

    for (let i = 0; i < 8; i++) {
      const dx = i & 1;
      const dy = (i >> 1) & 1;
      const dz = (i >> 2) & 1;
      const coord = corner.add(vec3(dx, dy, dz));
      const weight = mix(float(1).sub(frac.x), frac.x, float(dx))
        .mul(mix(float(1).sub(frac.y), frac.y, float(dy)))
        .mul(mix(float(1).sub(frac.z), frac.z, float(dz)));
      const probe = this.lookup(packKey(coord, lod), cascade);
      const exists = probe.lessThan(uint(PROBE_OVERFLOW));
      const kept = select(exists, weight, float(0));
      // A missing neighbour stores index 0, never the sentinel: the sentinel
      // does not survive the f32 round trip, and a zero weight already skips it.
      this.neighbour
        .element(base.add(uint(i)))
        .assign(vec2(select(exists, float(probe), float(0)), kept));
      total.addAssign(kept);
    }

    // Renormalise over the probes that exist, which is what makes the
    // interpolation sparse rather than a hole where a neighbour is missing.
    const inv = select(total.greaterThan(1e-6), float(1).div(total), float(0));
    for (let i = 0; i < 8; i++) {
      const slot = base.add(uint(i));
      this.neighbour.element(slot).y.assign(this.neighbour.element(slot).y.mul(inv));
    }
  }

  private buildNeighbours(): ComputeKernel[] {
    const kernels: ComputeKernel[] = [];
    // Cascade N−1 merges against the sky, so it has no parent to interpolate.
    for (let n = 0; n < CASCADES - 1; n++) {
      const info = this.layout[n]!;
      kernels.push(
        compute(
          Fn(() => {
            If(instanceIndex.lessThan(atomicLoad(this.counters.element(uint(n)))), () => {
              const probe = instanceIndex.add(uint(info.probeBase));
              const key = this.probeKey.element(probe);
              const lod = this.lodOf(key);
              const position = this.probePosition(this.unpackCoord(key), n, lod);
              this.writeNeighbours(position, n + 1, lod, probe.mul(8));
              // The containing probe one cascade up, which Algorithm 3 routes
              // ray counts and offsets through. Resolved here rather than during
              // insertion because only now is cascade n+1's map complete.
              this.parentIndex
                .element(probe)
                .assign(this.lookup(packKey(this.nearestCoord(position, n + 1, lod), lod), n + 1));
            });
          })(),
          info.probeCapacity,
        ),
      );
    }
    return kernels;
  }

  // ------------------------------------------------------- Algorithm 3

  /** The G-buffer uv a ray index spawns from. */
  private rayUv(index: Node<"uint">): Node<"vec2"> {
    const width = uint(this.uRayGrid.x);
    const x = float(index.mod(width));
    const y = float(index.div(width));
    return vec2(x.add(0.5).div(this.uRayGrid.x), y.add(0.5).div(this.uRayGrid.y));
  }

  private buildCountPixels(): ComputeKernel {
    return compute(
      Fn(() => {
        If(instanceIndex.lessThan(this.uRayCount), () => {
          const world = texture(this.gbuffer.textures[2]!, this.rayUv(instanceIndex));
          If(world.w.greaterThan(GBUFFER_HIT * 0.5), () => {
            const lod = this.lodFor(world.xyz, this.dither(instanceIndex));
            const probe = this.lookup(packKey(this.nearestCoord(world.xyz, 0, lod), lod), 0);
            If(probe.lessThan(uint(PROBE_OVERFLOW)), () => {
              atomicAdd(this.numRays.element(probe), uint(1));
            });
          });
        });
      })(),
      this.rayCapacity,
    );
  }

  private buildCountCascade(): ComputeKernel[] {
    const kernels: ComputeKernel[] = [];
    for (let n = 1; n < CASCADES; n++) {
      const child = this.layout[n - 1]!;
      kernels.push(
        compute(
          Fn(() => {
            If(instanceIndex.lessThan(atomicLoad(this.counters.element(uint(n - 1)))), () => {
              const probe = instanceIndex.add(uint(child.probeBase));
              const parent = this.parentIndex.element(probe);
              If(parent.lessThan(uint(PROBE_OVERFLOW)), () => {
                atomicAdd(this.numRays.element(parent), atomicLoad(this.numRays.element(probe)));
              });
            });
          })(),
          child.probeCapacity,
        ),
      );
    }
    return kernels;
  }

  private buildOffsetTop(): ComputeKernel {
    const info = this.layout[CASCADES - 1]!;
    return compute(
      Fn(() => {
        If(instanceIndex.lessThan(atomicLoad(this.counters.element(uint(CASCADES - 1)))), () => {
          const probe = instanceIndex.add(uint(info.probeBase));
          // Algorithm 3 walks the top cascade in order; the offsets only have to
          // be disjoint and contiguous, so an atomic bump gives the same result
          // without serialising.
          const offset = atomicAdd(this.counters.element(uint(4)), atomicLoad(this.numRays.element(probe)));
          atomicStore(this.cursor.element(probe), offset);
        });
      })(),
      info.probeCapacity,
    );
  }

  private buildOffsetCascade(): ComputeKernel[] {
    const kernels: ComputeKernel[] = [];
    // Cascade N−2 down to 0: each probe takes a contiguous segment out of its
    // parent's, so a parent's rays stay contiguous and stay evenly spread.
    for (let n = CASCADES - 2; n >= 0; n--) {
      const info = this.layout[n]!;
      kernels.push(
        compute(
          Fn(() => {
            If(instanceIndex.lessThan(atomicLoad(this.counters.element(uint(n)))), () => {
              const probe = instanceIndex.add(uint(info.probeBase));
              const parent = this.parentIndex.element(probe);
              If(parent.lessThan(uint(PROBE_OVERFLOW)), () => {
                const offset = atomicAdd(
                  this.cursor.element(parent),
                  atomicLoad(this.numRays.element(probe)),
                );
                atomicStore(this.cursor.element(probe), offset);
              });
            });
          })(),
          info.probeCapacity,
        ),
      );
    }
    return kernels;
  }

  /** `R₂(i)`, evaluated in `u32` fixed point so a large `i` stays exact. */
  private r2(index: Node<"uint">): Node<"vec2"> {
    const scale = 1 / 4294967296;
    return vec2(
      float(index.mul(uint(R2_A1))).mul(scale),
      float(index.mul(uint(R2_A2))).mul(scale),
    );
  }

  /**
   * Three more R2 axes for the ray at `index`. The two axes of {@link SplitRC#r2}
   * are its direction, so anything decided per ray that must not correlate with
   * where the ray points needs its own generator.
   */
  private r3(index: Node<"uint">): Node<"vec3"> {
    const scale = 1 / 4294967296;
    return fract(
      vec3(
        float(index.mul(uint(R2_A3))).mul(scale),
        float(index.mul(uint(R2_A4))).mul(scale),
        float(index.mul(uint(R2_A5))).mul(scale),
      ).add(this.uJitter.x),
    );
  }

  /**
   * Direction index within `Ω_In` for a direction, i.e. `mₙ(ω)`, with `jitter` a
   * sub-bin offset in `[−0.5, 0.5)²`.
   *
   * The jitter is the whole point of this signature. Floor alone quantises the
   * direction, and quantising it is what draws circles around a light: cascade 0
   * has 32 bins over the sphere, so a bin is ~0.6rad across, and the irradiance
   * integral weights a bin by `cos(n·ω)` at the bin's *centre*. A small light
   * lands in exactly one bin, so it is reconstructed as if it sat at that bin's
   * centre, and the moment a receiver moves far enough that the light crosses
   * into the next bin the cosine weight jumps. The locus of receivers seeing a
   * light at a fixed elevation is a circle centred under it — and since a flat
   * floor's cosine depends on elevation only, the azimuth bounds are invisible
   * and *only* the circles show. Nothing about that depends on `t₀`, the LOD or
   * the cascade bounds, which is why moving all three left it alone.
   *
   * Offsetting by a uniform sub-bin amount before flooring puts the ray in the
   * lower bin with probability `1 − frac` and the upper one with `frac`, which
   * is bilinear splatting into the bin grid in expectation — the light's energy
   * now divides between the two adjacent centres in proportion to where it
   * really sits, so the reconstruction moves continuously instead of stepping.
   * Cost is one `fract` and two adds; the variance it trades in is per ray, and
   * lands in the bin average, the temporal blend and the 27-probe gather.
   */
  private directionIndex(
    dir: Node<"vec3">,
    cascade: number,
    jitter: Node<"vec2">,
  ): Node<"uint"> {
    const info = this.layout[cascade]!;
    const wide = info.theta * 2;
    const uv = encodeDir(dir);
    // Azimuth wraps, so the offset is folded rather than clamped; `+wide` keeps
    // the value positive for the unsigned modulo.
    const u = uint(floor(uv.x.mul(wide).add(jitter.x).add(wide))).mod(uint(wide));
    // Elevation does not — the poles are the ends of the range, not a seam.
    const v = uint(
      clamp(floor(uv.y.mul(info.theta).add(jitter.y)), float(0), float(info.theta - 1)),
    );
    return v.mul(uint(wide)).add(u);
  }

  /**
   * Ray splitting (§5). One ray per lane, traced once over its whole length,
   * then deposited into every cascade it carries information about: the
   * cascades it passed straight through get `J = 0, β = 1`, the cascade
   * containing the hit gets the hit radiance and `β = 0`, and the cascades
   * beyond it get nothing — extending the ray to them would bias the average,
   * as §5 notes.
   */
  private buildTrace(): ComputeKernel {
    return compute(
      Fn(() => {
        const uv = this.rayUv(instanceIndex);
        const world = texture(this.gbuffer.textures[2]!, uv);
        If(world.w.greaterThan(GBUFFER_HIT * 0.5).and(instanceIndex.lessThan(this.uRayCount)), () => {
          const origin = world.xyz;
          const normal = decodeOctahedral(
            vec2(
              texture(this.gbuffer.textures[0]!, uv).w,
              texture(this.gbuffer.textures[1]!, uv).w,
            ),
          );
          const lod = this.lodFor(origin, this.dither(instanceIndex));
          const probe0 = this.lookup(packKey(this.nearestCoord(origin, 0, lod), lod), 0);

          If(probe0.lessThan(uint(PROBE_OVERFLOW)), () => {
            const index = atomicAdd(this.cursor.element(probe0), uint(1));
            const jittered = fract(this.r2(index).add(this.uJitter));
            const raw = decodeDir(jittered);
            // Directions pointing into the surface are flipped rather than
            // discarded, so every ray lands in the hemisphere that can be read.
            const dir = raw.mul(signNonZero(dot(raw, normal))).toVar();

            // `t₀ = 1.6Δs₀` (§7), and at a LOD the base spacing *is* the LOD's
            // spacing. A fixed `t₀` leaves a LOD 2 probe — 4Δs₀ across —
            // partitioning its own cell as if it were Δs₀ wide, so nearly every
            // hit inside that cell is handed two cascades higher than it
            // belongs. Those are the cascades holding 1/16 and 1/64 the probes,
            // which is where capacity runs out, and an overflowed parent reads
            // as sky. Coarse shells came out brighter for that reason alone.
            const t0 = this.spacingOf(0, lod).mul(this.uT0);
            const tMax = t0.mul(this.layout[CASCADES - 1]!.farDistance);
            // Offset along the normal so the ray does not immediately re-enter
            // the voxel its own surface occupies.
            const start = origin.add(normal.mul(this.uOffset));
            const hit = this.voxels.trace(start, dir, float(0), tMax).toVar();

            const radiance = vec3(0).toVar();
            If(hit.w.greaterThanEqual(0), () => {
              radiance.assign(this.voxels.radianceAt(hit.xyz));
              // Multibounce (§6): what the hit surface itself received last
              // frame, read out of the previous frame's irradiance field.
              //
              // ponytail: the paper keeps a second probe cache two LODs coarser
              // so that hits on off-screen geometry also bounce; this reuses the
              // primary c0 field instead, which means a hit with no probe of its
              // own contributes its first bounce only. Upgrade path: a second
              // hashmap seeded from the previous frame's hit points.
              const hitPos = this.voxels.positionAt(hit.xyz);
              const hitLod = this.lodFor(hitPos, this.dither(instanceIndex));
              const cached = this.lookupHistory(
                packKey(this.nearestCoord(hitPos, 0, hitLod), hitLod),
                0,
              );
              If(cached.lessThan(uint(PROBE_OVERFLOW)), () => {
                const incident = this.sampleIrradiance(
                  this.irradianceHistory,
                  cached.sub(uint(this.layout[0]!.probeBase)),
                  this.octahedralTexel(dir.negate()),
                );
                radiance.addAssign(this.voxels.albedoAt(hit.xyz).mul(incident).div(Math.PI));
              });
            });

            // Which side of the handoff band this ray fell on, drawn once and
            // reused by every cascade — the bands are disjoint in `t`, since
            // `far_n < CASCADE_OVERLAP · far_{n+1}`, so a ray is in at most one.
            const stream = this.r3(index);
            const pick = stream.x;
            /** Sub-bin offset for the deposit; see {@link SplitRC#directionIndex}. */
            const binJitter = stream.yz.sub(0.5);
            /** Whether cascade `n` keeps a hit in its own interval, per cascade. */
            const keeps: (Node<"bool"> | null)[] = [];

            for (let n = 0; n < CASCADES; n++) {
              const info = this.layout[n]!;
              const near = t0.mul(info.nearDistance);
              const far = t0.mul(info.farDistance);
              const inThis = hit.w.greaterThan(near).and(hit.w.lessThanEqual(far));
              const passedThrough = hit.w.lessThan(0).or(hit.w.greaterThan(far));
              // Probability that a hit in this interval stays here rather than
              // being handed up; 1 until the handoff band and 0 at the far bound.
              // The top cascade has nowhere to hand to, so `null` reads as always.
              //
              // A probability and not a fraction. Splitting one hit across two
              // cascades is exact per ray — `a·L + (1−a)·L = L` — but a bin does
              // not store rays, it stores `mean(J)` and `mean(β)` and composes
              // them as `J + β·I`. A half-handed hit therefore lends its `β` to
              // every *other* ray in the bin as well, so the bin comes out
              // `mean(J) + mean(β)·I` instead of `mean(J + β·I)`. The gap is
              // `a(1−a)` times the contrast between the hit and the far field:
              // zero at both ends of the band and worst in the middle, i.e. a
              // shell at mid-band — brighter than its surroundings around a
              // light, darker around a dark occluder. That is the ring, and
              // widening the band only widens the ring. Whole rays chosen with
              // probability `a` have the same mean and no cross term; the
              // variance lands in the bin average, the temporal blend and the
              // 27-probe gather, all of which were already averaging.
              const keep =
                n + 1 < CASCADES
                  ? fade(
                      clamp(
                        far.sub(hit.w).div(far.mul(1 - CASCADE_OVERLAP)),
                        float(0),
                        float(1),
                      ),
                    ).greaterThan(pick)
                  : null;
              keeps.push(keep);
              // The other side of that band: a hit in the cascade below's
              // interval that the cascade below let go. `near` is the interval
              // below's far bound, so the two bands are the same interval of `t`.
              // When the cascade below kept it, this one hears nothing about the
              // ray at all — which is right, the ray ended before this interval.
              const borrowed =
                n > 0
                  ? hit.w
                      .greaterThan(near.mul(CASCADE_OVERLAP))
                      .and(hit.w.lessThanEqual(near))
                      .and(keeps[n - 1]!.not())
                  : null;
              const absorbed = keep ? inThis.and(keep) : inThis;

              If(borrowed ? inThis.or(passedThrough).or(borrowed) : inThis.or(passedThrough), () => {
                const probe = this.lookup(packKey(this.nearestCoord(origin, n, lod), lod), n);
                If(probe.lessThan(uint(PROBE_OVERFLOW)), () => {
                  const local = probe.sub(uint(info.probeBase));
                  const slot = uint(info.slotBase)
                    .add(local.mul(uint(info.directions)))
                    .add(this.directionIndex(dir, n, binJitter))
                    .mul(uint(DEPOSIT_LANES));
                  // Default is the pass-through case: nothing emitted, fully
                  // transparent, so the cone from above comes through untouched.
                  const emit = vec3(0).toVar();
                  const beta = float(1).toVar();
                  If(borrowed ? absorbed.or(borrowed) : absorbed, () => {
                    emit.assign(radiance);
                    beta.assign(float(0));
                  });
                  const quantised = clamp(emit, vec3(0), vec3(RADIANCE_CEILING)).mul(DEPOSIT_SCALE);
                  atomicAdd(this.deposit.element(slot), uint(quantised.x));
                  atomicAdd(this.deposit.element(slot.add(1)), uint(quantised.y));
                  atomicAdd(this.deposit.element(slot.add(2)), uint(quantised.z));
                  atomicAdd(this.deposit.element(slot.add(3)), uint(beta.mul(DEPOSIT_SCALE)));
                  atomicAdd(this.deposit.element(slot.add(4)), uint(1));
                });
              });
            }
          });
        });
      })(),
      this.rayCapacity,
    );
  }

  // ------------------------------------------------------------ merging

  /**
   * `Iₙ(p, ω) = merge(Jₙ, βₙ, mean of the four I_{n+1} cones in mₙ⁻¹(ω))`,
   * with `merge(J, β, I) = J + β·I` (Eq. 6, premultiplied-alpha compositing).
   */
  /**
   * Resolves every probe's previous-frame index, once. Splitting this out of
   * the merge also takes the two history hashmap buffers off that kernel, which
   * was at WebGPU's eight-storage-buffers-per-stage limit and needed room for
   * {@link averaged}.
   */
  private buildHistoryProbe(): ComputeKernel[] {
    // Runs over the whole capacity rather than the live count: a dead probe's
    // stale key resolves to a stale answer that the merge never reads.
    return this.layout.map((info, n) =>
      compute(
        Fn(() => {
          const probe = instanceIndex.add(uint(info.probeBase));
          this.historyProbe
            .element(probe)
            .assign(this.lookupHistory(this.probeKey.element(probe), n));
        })(),
        info.probeCapacity,
      ),
    );
  }

  /** Fills cascade n's block of {@link averaged} from cascade n+1's merged cones. */
  private buildAverage(n: number): ComputeKernel {
    const info = this.layout[n]!;
    const upper = this.layout[n + 1]!;
    const base = this.averageBase[n]!;
    return compute(
      Fn(() => {
        const local = instanceIndex.div(uint(info.directions));
        const dir = instanceIndex.mod(uint(info.directions));
        If(local.lessThan(atomicLoad(this.counters.element(uint(n + 1)))), () => {
          const u = dir.mod(uint(info.theta * 2));
          const v = dir.div(uint(info.theta * 2));
          const upperBase = uint(upper.slotBase).add(local.mul(uint(upper.directions)));
          const sum = vec3(0).toVar();
          for (let child = 0; child < 4; child++) {
            const cu = u.mul(2).add(uint(child & 1));
            const cv = v.mul(2).add(uint((child >> 1) & 1));
            sum.addAssign(
              this.merged.element(upperBase.add(cv.mul(uint(upper.theta * 2)).add(cu))).xyz,
            );
          }
          this.averaged.element(uint(base).add(instanceIndex)).assign(vec4(sum.mul(0.25), 1));
        });
      })(),
      upper.probeCapacity * info.directions,
    );
  }

  private buildMerge(): ComputeKernel[] {
    const kernels: ComputeKernel[] = [];
    for (let n = CASCADES - 1; n >= 0; n--) {
      const info = this.layout[n]!;
      const upper = n + 1 < CASCADES ? this.layout[n + 1]! : null;
      // Cascade n+1 is merged by the time this runs, so its cones can be
      // pre-averaged into the shape cascade n reads them in.
      if (upper) kernels.push(this.buildAverage(n));
      kernels.push(
        compute(
          Fn(() => {
            const local = instanceIndex.div(uint(info.directions));
            const dir = instanceIndex.mod(uint(info.directions));
            If(local.lessThan(atomicLoad(this.counters.element(uint(n)))), () => {
              const probe = local.add(uint(info.probeBase));
              const slot = uint(info.slotBase).add(instanceIndex);
              const depositSlot = slot.mul(uint(DEPOSIT_LANES));

              const count = atomicLoad(this.deposit.element(depositSlot.add(4)));
              const inv = select(count.greaterThan(uint(0)), float(1).div(float(count)), float(0));
              const j = vec3(
                float(atomicLoad(this.deposit.element(depositSlot))),
                float(atomicLoad(this.deposit.element(depositSlot.add(1)))),
                float(atomicLoad(this.deposit.element(depositSlot.add(2)))),
              )
                .mul(inv)
                .div(DEPOSIT_SCALE);
              const beta = float(atomicLoad(this.deposit.element(depositSlot.add(3))))
                .mul(inv)
                .div(DEPOSIT_SCALE);

              // The cone from the cascade above, averaged over the four
              // directions that map to this one (`mₙ⁻¹`), and interpolated to
              // this probe's position through the sparse trilinear neighbours.
              const above = vec3(0).toVar();
              if (upper) {
                const neighbourBase = probe.mul(8);
                const covered = float(0).toVar();
                for (let i = 0; i < 8; i++) {
                  const entry = this.neighbour.element(neighbourBase.add(uint(i)));
                  const weight = entry.y;
                  If(weight.greaterThan(0), () => {
                    covered.addAssign(weight);
                    const parent = uint(entry.x).sub(uint(upper.probeBase));
                    above.addAssign(
                      this.averaged
                        .element(
                          uint(this.averageBase[n]!)
                            .add(parent.mul(uint(info.directions)))
                            .add(dir),
                        )
                        .xyz.mul(weight),
                    );
                  });
                }
                // No parent at all means cascade n+1 ran out of probe capacity,
                // not that there is nothing above. Leaving `above` at zero
                // blacks the probe out and — because capacity runs out over a
                // region, not a cell — the edge of that region reads as a soft
                // boundary between cascades. The sky is the same prior the top
                // cascade merges against, and is wrong by far less.
                If(covered.lessThanEqual(0), () => {
                  above.assign(this.uSky);
                });
              } else {
                above.assign(this.uSky);
              }

              const fresh = j.add(above.mul(beta));

              // Temporal accumulation (§5.2). World-space probes need no
              // reprojection, so history is found by looking this probe's key up
              // in the previous frame's map. A direction with no rays this frame
              // keeps its history untouched rather than collapsing to zero.
              const previous = this.historyProbe.element(probe);
              const hasHistory = previous.lessThan(uint(PROBE_OVERFLOW));
              const historyValue = vec3(0).toVar();
              If(hasHistory, () => {
                historyValue.assign(
                  this.history
                    .element(
                      uint(info.slotBase)
                        .add(previous.sub(uint(info.probeBase)).mul(uint(info.directions)))
                        .add(dir),
                    )
                    .xyz,
                );
              });

              const blended = select(
                count.equal(uint(0)),
                // No information this frame: keep history, or fall back to the
                // "fully transparent" prior, which is exactly the cone above.
                select(hasHistory, historyValue, above),
                select(hasHistory, mix(fresh, historyValue, this.uBlend), fresh),
              );
              this.merged.element(slot).assign(vec4(blended, 1));
            });
          })(),
          info.probeCapacity * info.directions,
        ),
      );
    }
    return kernels;
  }

  // ----------------------------------------------------------- shading

  /**
   * Directional irradiance per c0 probe (§6): the rendering equation evaluated
   * once per octahedral texel assuming a Lambertian BRDF, so shading a pixel
   * costs eight filtered samples instead of up to 256 unfiltered ones.
   */
  private buildIrradiance(): ComputeKernel {
    const info = this.layout[0]!;
    const solidAngle = (4 * Math.PI) / info.directions;
    // One workgroup per probe. Every one of a probe's texels integrates over the
    // same `directions` cones, so read them once into workgroup memory instead
    // of once per texel — the same 32 values were being pulled out of `merged`
    // 36 times over, which made this the widest read left in the solve.
    // `element` is missing from @types/three 0.185's WorkgroupInfoNode; the node
    // has it, and it is the only way to address a workgroup array.
    const cone = workgroupArray("vec3", info.directions) as unknown as {
      element(index: Node<"uint">): Node<"vec3">;
    };
    return compute(
      Fn(() => {
        const local = instanceIndex.div(uint(IRRADIANCE_TEXELS));
        const texel = instanceIndex.mod(uint(IRRADIANCE_TEXELS));
        const live = local.lessThan(atomicLoad(this.counters.element(uint(0))));
        const base = uint(info.slotBase).add(local.mul(uint(info.directions)));
        If(live.and(texel.lessThan(uint(info.directions))), () => {
          cone.element(texel).assign(this.merged.element(base.add(texel)).xyz);
        });
        // At the top level, so every invocation in the workgroup reaches it —
        // `local` is the same for all of them, `texel` is not.
        workgroupBarrier();
        If(live, () => {
          const tx = texel.mod(uint(IRRADIANCE_SIZE));
          const ty = texel.div(uint(IRRADIANCE_SIZE));
          const inside = tx
            .greaterThanEqual(uint(1))
            .and(tx.lessThanEqual(uint(IRRADIANCE_INNER)))
            .and(ty.greaterThanEqual(uint(1)))
            .and(ty.lessThanEqual(uint(IRRADIANCE_INNER)));
          If(inside, () => {
            const octUv = vec2(
              float(tx.sub(uint(1))).add(0.5).div(IRRADIANCE_INNER),
              float(ty.sub(uint(1))).add(0.5).div(IRRADIANCE_INNER),
            );
            const normal = decodeOctahedral(octUv.mul(2).sub(1));
            const sum = vec3(0).toVar();
            Loop({ start: 0, end: info.directions, type: "int", condition: "<" }, ({ i }) => {
              const index = uint(i);
              const u = float(index.mod(uint(info.theta * 2))).add(0.5).div(info.theta * 2);
              const v = float(index.div(uint(info.theta * 2))).add(0.5).div(info.theta);
              const omega = decodeDir(vec2(u, v));
              const cosine = max(dot(omega, normal), 0);
              sum.addAssign(cone.element(index).mul(cosine));
            });
            this.irradiance
              .element(local.mul(uint(IRRADIANCE_TEXELS)).add(texel))
              .assign(vec4(sum.mul(solidAngle), 1));
          });
        });
      })(),
      info.probeCapacity * IRRADIANCE_TEXELS,
      // Explicit, because the workgroup cache above is only a probe's worth of
      // cones if a workgroup is exactly a probe's worth of texels.
      [IRRADIANCE_TEXELS],
    );
  }

  /**
   * The border pass §6 describes: one texel of margin around the 6×6 field so
   * bilinear taps at the edge read the octahedral map's true neighbour instead
   * of clamping.
   */
  private buildBorder(): ComputeKernel {
    const info = this.layout[0]!;
    return compute(
      Fn(() => {
        const local = instanceIndex.div(uint(IRRADIANCE_TEXELS));
        const texel = instanceIndex.mod(uint(IRRADIANCE_TEXELS));
        If(local.lessThan(atomicLoad(this.counters.element(uint(0)))), () => {
          const tx = int(texel.mod(uint(IRRADIANCE_SIZE)));
          const ty = int(texel.div(uint(IRRADIANCE_SIZE)));
          const onBorder = tx
            .equal(int(0))
            .or(ty.equal(int(0)))
            .or(tx.equal(int(IRRADIANCE_SIZE - 1)))
            .or(ty.equal(int(IRRADIANCE_SIZE - 1)));
          If(onBorder, () => {
            // Octahedral wrapping: stepping off an edge lands on the opposite
            // edge, mirrored along the other axis.
            const edge = float(IRRADIANCE_INNER - 1);
            const ix = clamp(float(tx).sub(1), float(0), edge).toVar();
            const iy = clamp(float(ty).sub(1), float(0), edge).toVar();
            If(tx.equal(int(0)).or(tx.equal(int(IRRADIANCE_SIZE - 1))), () => {
              iy.assign(edge.sub(iy));
            });
            If(ty.equal(int(0)).or(ty.equal(int(IRRADIANCE_SIZE - 1))), () => {
              ix.assign(edge.sub(ix));
            });
            const source = uint(iy.add(1).mul(IRRADIANCE_SIZE).add(ix.add(1)));
            this.irradiance
              .element(local.mul(uint(IRRADIANCE_TEXELS)).add(texel))
              .assign(this.irradiance.element(local.mul(uint(IRRADIANCE_TEXELS)).add(source)));
          });
        });
      })(),
      info.probeCapacity * IRRADIANCE_TEXELS,
    );
  }

  /**
   * The probe-space filter: each probe's field averaged with the same texel of
   * its six lattice neighbours. See {@link PROBE_FILTER_CENTRE} for why the grid
   * needs this and not another pass at the probe values.
   *
   * Run after the border pass, and over all 64 texels rather than the 36 interior
   * ones, which needs no second border fill: a border texel is a copy of an
   * interior one, and copying commutes with averaging, so the filtered field's
   * border is already the border of the filtered field.
   *
   * One kernel per pass, alternating source and destination; see
   * {@link PROBE_FILTER_PASSES}.
   */
  private buildProbeFilter(): ComputeKernel[] {
    return Array.from({ length: PROBE_FILTER_PASSES }, (_, pass) =>
      pass % 2 === 0
        ? this.buildProbeFilterPass(this.irradiance, this.irradianceSmooth)
        : this.buildProbeFilterPass(this.irradianceSmooth, this.irradiance),
    );
  }

  /**
   * The six lattice neighbours of every c0 probe. Resolved once per probe
   * because the filter runs per texel: the same six hashmap walks were being
   * repeated for all 64 texels of a probe, and then again for every pass.
   */
  private buildProbeNeighbours(): ComputeKernel {
    const info = this.layout[0]!;
    return compute(
      Fn(() => {
        If(instanceIndex.lessThan(atomicLoad(this.counters.element(uint(0)))), () => {
          const key = this.probeKey.element(instanceIndex.add(uint(info.probeBase)));
          const lod = this.lodOf(key);
          const coord = this.unpackCoord(key);
          let i = 0;
          for (let axis = 0; axis < 3; axis++) {
            for (const delta of [-1, 1]) {
              const offset = vec3(
                axis === 0 ? delta : 0,
                axis === 1 ? delta : 0,
                axis === 2 ? delta : 0,
              );
              // Same LOD as this probe: a neighbour at another LOD is a cell of a
              // different lattice, not the cell next door.
              this.probeNeighbour
                .element(instanceIndex.mul(6).add(uint(i++)))
                .assign(this.lookup(packKey(coord.add(offset), lod), 0, true));
            }
          }
        });
      })(),
      info.probeCapacity,
    );
  }

  private buildProbeFilterPass(source: VecArray, target: VecArray): ComputeKernel {
    const info = this.layout[0]!;
    return compute(
      Fn(() => {
        const local = instanceIndex.div(uint(IRRADIANCE_TEXELS));
        const texel = instanceIndex.mod(uint(IRRADIANCE_TEXELS));
        If(local.lessThan(atomicLoad(this.counters.element(uint(0)))), () => {
          const sum = source.element(instanceIndex).xyz.mul(PROBE_FILTER_CENTRE).toVar();
          const total = float(PROBE_FILTER_CENTRE).toVar();
          for (let i = 0; i < 6; i++) {
            const found = this.probeNeighbour.element(local.mul(6).add(uint(i)));
            If(found.lessThan(uint(PROBE_OVERFLOW)), () => {
              const neighbour = found.sub(uint(info.probeBase));
              sum.addAssign(source.element(neighbour.mul(uint(IRRADIANCE_TEXELS)).add(texel)).xyz);
              total.addAssign(1);
            });
          }
          target.element(instanceIndex).assign(vec4(sum.div(total), 1));
        });
      })(),
      info.probeCapacity * IRRADIANCE_TEXELS,
    );
  }

  private buildSaveHistory(): ComputeKernel {
    const fieldSize = this.layout[0]!.probeCapacity * IRRADIANCE_TEXELS;
    const count = Math.max(this.totalHash, this.totalSlots, fieldSize);
    return compute(
      Fn(() => {
        If(instanceIndex.lessThan(uint(fieldSize)), () => {
          this.irradianceHistory.element(instanceIndex).assign(
            this.irradianceSmooth.element(instanceIndex),
          );
        });
        If(instanceIndex.lessThan(uint(this.totalHash)), () => {
          this.hashKeyHistory
            .element(instanceIndex)
            .assign(atomicLoad(this.hashKey.element(instanceIndex)));
          this.hashProbeHistory
            .element(instanceIndex)
            .assign(atomicLoad(this.hashProbe.element(instanceIndex)));
        });
        If(instanceIndex.lessThan(uint(this.totalSlots)), () => {
          this.history.element(instanceIndex).assign(this.merged.element(instanceIndex));
        });
      })(),
      count,
    );
  }

  /**
   * The gather pass: irradiance at each surface, reconstructed from the c0 probe
   * field in the direction of the surface normal. Runs at 1/{@link GI_SCALE}
   * resolution into {@link giTarget}, which the composite reads back.
   */
  private buildGather(): Node {
    return Fn(() => {
      const uv = screenUV;
      const emissiveTexel = texture(this.gbuffer.textures[0]!, uv);
      const albedoTexel = texture(this.gbuffer.textures[1]!, uv);
      const world = texture(this.gbuffer.textures[2]!, uv);

      const result = vec3(0).toVar();
      If(world.w.greaterThan(GBUFFER_HIT * 0.5), () => {
        const normal = decodeOctahedral(vec2(emissiveTexel.w, albedoTexel.w));
        const { lod, next, weight } = this.lodBlend(world.xyz);
        const texelPos = this.octahedralTexel(normal);

        // One weighted sum over both LODs rather than two normalised answers
        // mixed: a LOD that holds no probe here contributes a zero sum *and* a
        // zero weight, so it drops out instead of pulling the result to black.
        // That is what makes the wide band in LOD_OVERLAP affordable — the band
        // no longer has to be narrow enough that both grids are guaranteed full.
        const gathered = this.gatherIrradiance(world.xyz, normal, lod, texelPos)
          .mul(float(1).sub(weight))
          .toVar();
        If(weight.greaterThan(0), () => {
          gathered.addAssign(
            this.gatherIrradiance(world.xyz, normal, next, texelPos).mul(weight),
          );
        });
        result.assign(select(gathered.w.greaterThan(1e-6), gathered.xyz.div(gathered.w), vec3(0)));
      });
      return vec4(result, 1);
    })();
  }

  /**
   * Final shading: the gathered irradiance, upsampled, against the full
   * resolution albedo and emissive.
   */
  private buildComposite(): Node {
    return Fn(() => {
      const uv = screenUV;
      const emissiveTexel = texture(this.gbuffer.textures[0]!, uv);
      const albedoTexel = texture(this.gbuffer.textures[1]!, uv);
      const world = texture(this.gbuffer.textures[2]!, uv);

      const result = vec3(0).toVar();
      If(world.w.greaterThan(GBUFFER_HIT * 0.5), () => {
        const normal = decodeOctahedral(vec2(emissiveTexel.w, albedoTexel.w));
        const { lod, next, weight } = this.lodBlend(world.xyz);

        const irradianceValue = texture(this.giTarget.texture, uv).xyz.toVar();
        // Lambertian outgoing radiance: ρ/π times the cosine-weighted incident
        // radiance the irradiance field already integrated.
        const lit = emissiveTexel.xyz.add(albedoTexel.xyz.mul(irradianceValue).div(Math.PI));

        // Debug outputs branch on a uniform, so they cost a comparison rather
        // than a second material and its pipeline.
        const mode = this.uDebug;
        If(mode.equal(int(1)), () => {
          result.assign(irradianceValue.div(Math.PI));
        })
          .ElseIf(mode.equal(int(2)), () => {
            result.assign(emissiveTexel.xyz);
          })
          .ElseIf(mode.equal(int(3)), () => {
            result.assign(albedoTexel.xyz);
          })
          .ElseIf(mode.equal(int(4)), () => {
            result.assign(normal.mul(0.5).add(0.5));
          })
          .ElseIf(mode.equal(int(5)), () => {
            // The overlap band shows up as the gradient between two LOD colours,
            // which is exactly where a seam would appear if the blend were wrong.
            result.assign(mix(lodColor(lod), lodColor(next), weight));
          })
          .ElseIf(mode.equal(int(6)), () => {
            const cell = this.voxels.cellAt(world.xyz);
            result.assign(
              this.voxels.albedoAt(cell).add(this.voxels.radianceAt(cell)),
            );
          })
          .ElseIf(mode.equal(int(7)), () => {
            result.assign(this.cascadeDepthColor(world.xyz, lod, next));
          })
          .ElseIf(mode.equal(int(8)), () => {
            result.assign(this.probeIndexColor(world.xyz, lod, next));
          })
          .Else(() => {
            result.assign(lit);
          });
      });
      return vec4(result, 1);
    })();
  }

  /**
   * The probe covering a position in one cascade, at the base LOD or — when only
   * the LOD above it holds one — at that LOD.
   *
   * The fallback is not cosmetic. Probes commit to a single LOD stochastically
   * ({@link lodFor}), so across the overlap band a cell is seeded at whichever
   * LOD its dither landed on while the composite samples both. Looking at one
   * LOD alone paints holes into a band the solve covers fine.
   *
   * `plain` lookups throughout: a fragment stage may bind neither atomic nor
   * writable storage.
   */
  private debugProbe(
    position: Node<"vec3">,
    cascade: number,
    lod: Node<"uint">,
    next: Node<"uint">,
  ): Node<"uint"> {
    const found = this.stencilProbe(position, cascade, lod).toVar();
    If(found.greaterThanEqual(uint(PROBE_OVERFLOW)).and(next.notEqual(lod)), () => {
      found.assign(this.stencilProbe(position, cascade, next));
    });
    return found;
  }

  /**
   * The probe a position leans on hardest: the heaviest of the eight trilinear
   * neighbours that actually exists.
   *
   * Reporting the *containing* cell instead would paint the views with holes the
   * solve does not have. §4 seeds only the cells surfaces fall in, so most of a
   * position's eight trilinear neighbours are missing — while the gather reads
   * whichever exist and renormalises, and so is perfectly happy. Naming the
   * heaviest survivor is what makes the view say what the shading actually used.
   *
   * {@link PROBE_OVERFLOW} still comes through, and still loses to any real
   * probe, so a cascade that hit capacity reads as full only where nothing else
   * covers the pixel.
   */
  private stencilProbe(position: Node<"vec3">, cascade: number, lod: Node<"uint">): Node<"uint"> {
    const grid = position.div(this.spacingOf(cascade, lod)).sub(0.5);
    const corner = floor(grid);
    const frac = grid.sub(corner);
    const best = uint(PROBE_PENDING).toVar();
    // Below every trilinear weight, so the first probe found wins outright.
    const bestWeight = float(-1).toVar();
    for (let i = 0; i < 8; i++) {
      const dx = i & 1;
      const dy = (i >> 1) & 1;
      const dz = (i >> 2) & 1;
      const weight = mix(float(1).sub(frac.x), frac.x, float(dx))
        .mul(mix(float(1).sub(frac.y), frac.y, float(dy)))
        .mul(mix(float(1).sub(frac.z), frac.z, float(dz)));
      const probe = this.lookup(packKey(corner.add(vec3(dx, dy, dz)), lod), cascade, true);
      If(probe.lessThan(uint(PROBE_OVERFLOW)).and(weight.greaterThan(bestWeight)), () => {
        best.assign(probe);
        bestWeight.assign(weight);
      }).ElseIf(probe.equal(uint(PROBE_OVERFLOW)).and(bestWeight.lessThan(0)), () => {
        best.assign(uint(PROBE_OVERFLOW));
      });
    }
    return best;
  }

  /**
   * `cascadeIndex` view: the highest cascade that actually has a probe over the
   * position. Cascade `n+1` is seeded from cascade `n`'s probes, so a chain that
   * stops short of the top is a cascade that hit its capacity and dropped the
   * insert — the same failure {@link stats} counts, located on screen.
   */
  private cascadeDepthColor(
    position: Node<"vec3">,
    lod: Node<"uint">,
    next: Node<"uint">,
  ): Node<"vec3"> {
    const depth = int(-1).toVar();
    for (let n = 0; n < CASCADES; n++) {
      If(this.debugProbe(position, n, lod, next).lessThan(uint(PROBE_OVERFLOW)), () => {
        depth.assign(int(n));
      });
    }
    return cascadeColor(depth);
  }

  /**
   * `probeIndex` view: the probe index of one cascade, hashed to a colour.
   *
   * The cascade is a uniform but every constant a lookup needs — hash base,
   * capacity, probe base — is fixed per cascade, so the branch is unrolled and
   * the uniform only picks which arm runs.
   */
  private probeIndexColor(
    position: Node<"vec3">,
    lod: Node<"uint">,
    next: Node<"uint">,
  ): Node<"vec3"> {
    const result = vec3(0).toVar();
    for (let n = 0; n < CASCADES; n++) {
      If(this.uDebugCascade.equal(int(n)), () => {
        const info = this.layout[n]!;
        const probe = this.debugProbe(position, n, lod, next).toVar();
        If(probe.lessThan(uint(PROBE_OVERFLOW)), () => {
          // Local rather than global, so cascade 2's first probe reads as 0 and
          // the colour matches what inspectPixel reports.
          result.assign(probeColor(probe.sub(uint(info.probeBase))));
        })
          .ElseIf(probe.equal(uint(PROBE_OVERFLOW)), () => {
            // The cascade was at capacity when this cell asked for a probe.
            result.assign(vec3(1, 0, 0));
          })
          .Else(() => {
            // No probe: nothing on screen seeded this cell. Dark, not black, so
            // it still separates from the background.
            result.assign(vec3(0.06, 0.06, 0.09));
          });
      });
    }
    return result;
  }

  /** Texel coordinates of a direction inside a probe's 8×8 octahedral field. */
  private octahedralTexel(dir: Node<"vec3">): Node<"vec2"> {
    return encodeOctahedral(dir).mul(0.5).add(0.5).mul(IRRADIANCE_INNER).add(0.5);
  }

  /**
   * Irradiance at a position for one LOD: the c0 probes within
   * {@link GATHER_RADIUS} cells of it, each sampled in the same direction and
   * weighted by {@link GATHER_KERNEL}.
   *
   * A radial kernel rather than the trilinear tent this replaces. The tent is
   * the cheaper reconstruction and the wrong one here for two reasons, both of
   * which put a square on screen:
   *
   * Its support *is* a cube. A tent weight is a product of three per-axis
   * factors, so its level sets are axis-aligned boxes and every probe's
   * influence ends on three pairs of planes of the lattice. Smoothing the
   * profile along each axis — which is what a fade on the fraction does — moves
   * where the falloff happens without making it round, so the cell keeps its
   * corners and the eye keeps finding them. A weight in the distance alone has
   * no axes to align to.
   *
   * And its stencil is too small to survive the sparsity. Only the eight cells
   * around the position are consulted, most of which hold no probe (§4 seeds
   * only cells a surface falls in), so the renormalisation below can end up
   * dividing by a total of a few hundredths — one far corner probe, amplified
   * to stand for the whole neighbourhood. Which corner that is changes from cell
   * to cell, and *that* is the colour jump: not a gradient that is too steep but
   * a different probe answering the question. Reaching a cell further in every
   * direction puts enough probes in the sum that no single one can carry it.
   */
  private gatherIrradiance(
    position: Node<"vec3">,
    normal: Node<"vec3">,
    lod: Node<"uint">,
    texelPos: Node<"vec2">,
  ): Node<"vec4"> {
    const info = this.layout[0]!;
    // In cells, with probe centres on the integers.
    const grid = position.div(this.spacingOf(0, lod)).sub(0.5);
    const nearest = floor(grid.add(0.5));
    const sum = vec3(0).toVar();
    const total = float(0).toVar();
    for (let i = 0; i < 27; i++) {
      const offset = vec3((i % 3) - 1, (Math.floor(i / 3) % 3) - 1, Math.floor(i / 9) - 1);
      const cell = nearest.add(offset);
      // Cell space is world space scaled, so the vector the kernel already needs
      // is the vector to the probe — the plane test costs the dot and the
      // reciprocal of a length that was going to be taken anyway. The epsilon is
      // only for a probe centre landing on the shaded point, which then reads as
      // cos 0 and is kept.
      const delta = cell.sub(grid);
      const distance = length(delta);
      // The cosine is taken from {@link GATHER_BIAS} cells in front of the
      // surface, against the distance from the surface itself — one add, no
      // second length, and the sign is all the bias has to change.
      const facing = dot(delta, normal)
        .add(GATHER_BIAS)
        .div(distance.add(1e-4))
        .clamp(-1, 1)
        .add(1)
        .mul(0.5);
      // Squared, so a probe near the plane is already well down rather than at
      // half weight.
      const weight = GATHER_KERNEL(distance.div(GATHER_RADIUS))
        .mul(facing.mul(facing).add(GATHER_BACKFACE))
        .toVar();
      // Culled before the hashmap walk and the four irradiance taps — those, not
      // the arithmetic, are what a cell in this loop costs.
      If(weight.greaterThan(GATHER_CULL), () => {
        const probe = this.lookup(packKey(cell, lod), 0, true);
        If(probe.lessThan(uint(PROBE_OVERFLOW)), () => {
          const local = probe.sub(uint(info.probeBase));
          sum.addAssign(this.sampleIrradiance(this.irradianceSmooth, local, texelPos).mul(weight));
          total.addAssign(weight);
        });
      });
    }
    // Unnormalised, with the weight it stands on in `w`. The caller renormalises
    // across both LODs at once, which is what lets it blend toward a LOD that
    // holds no probe here without blending toward black.
    return vec4(sum, total);
  }

  /** Bilinear tap into one probe's 8×8 octahedral irradiance field. */
  private sampleIrradiance(
    field: VecArray,
    local: Node<"uint">,
    texelPos: Node<"vec2">,
  ): Node<"vec3"> {
    const clamped = clamp(texelPos, vec2(0.5), vec2(IRRADIANCE_SIZE - 0.5));
    const base = clamped.sub(0.5);
    const corner = floor(base);
    const frac = base.sub(corner);
    const probeBase = local.mul(uint(IRRADIANCE_TEXELS));
    const result = vec3(0).toVar();
    for (let i = 0; i < 4; i++) {
      const dx = i & 1;
      const dy = (i >> 1) & 1;
      const weight = mix(float(1).sub(frac.x), frac.x, float(dx)).mul(
        mix(float(1).sub(frac.y), frac.y, float(dy)),
      );
      const x = clamp(corner.x.add(dx), float(0), float(IRRADIANCE_SIZE - 1));
      const y = clamp(corner.y.add(dy), float(0), float(IRRADIANCE_SIZE - 1));
      const index = probeBase.add(uint(y.mul(IRRADIANCE_SIZE).add(x)));
      result.addAssign(field.element(index).xyz.mul(weight));
    }
    return result;
  }
}

function fractional(value: number): number {
  return value - Math.floor(value);
}
