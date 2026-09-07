import {
  Camera,
  Color,
  FloatType,
  HalfFloatType,
  type Layers,
  LinearFilter,
  Matrix4,
  NearestFilter,
  MeshBasicNodeMaterial,
  type MRTNode,
  QuadMesh,
  RedFormat,
  RenderTarget,
  type Scene,
  type ColorRepresentation,
  type Node,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
  type WebGPURenderer,
} from "three/webgpu";
import {
  abs,
  clamp,
  diffuseColor,
  emissive,
  float,
  floor,
  max,
  mix,
  mrt,
  normalWorld,
  outputStruct,
  positionView,
  positionWorld,
  screenUV,
  select,
  texture,
  textureLevel,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { FieldSpaceRC } from "./FieldSpaceRC.js";

/**
 * Which 2D domain the flatland RC solve runs in.
 *
 * - `footprint`: geometry is collapsed onto its ground footprint before the
 *   field renders, so the field is a top-down map of the world. Contact
 *   shadowing and directional reception apply. Correct for top-down and
 *   isometric cameras.
 * - `imagePlane`: raw on-screen silhouettes are the 2D domain. Correct for
 *   side-on cameras, where world height *is* the image's vertical axis.
 *
 * This is a property of the application's projection, not of the current
 * camera pose: it stays fixed while the camera moves, so the lighting does
 * not change when the camera pitches or orbits.
 */
export type FlatlandDomain = "footprint" | "imagePlane";

export interface ScreenSpaceRCOptions {
  /**
   * Extra view fraction rendered beyond every frustum edge of the guard-band
   * G-buffer, so emitters and occluders somewhat outside the visible frame
   * still light and shadow it. 0.25 widens the frustum to 1.5x. Default 0.25.
   */
  padding?: number;
  /** Flatland domain of the solve. Default `footprint`. */
  domain?: FlatlandDomain;
  /**
   * RC field extent in pixels. The HRC solve is square and halves its probe
   * plane count per cascade, so this must be a power of two. Defaults to the
   * power of two at or below half the drawing buffer's longer side, clamped
   * to [256, 512].
   */
  resolution?: number;
  /**
   * Fallback floor height, used where the field sees no geometry at all and
   * as the pivot of the footprint flattening. Occlusion itself is measured
   * against the *local* floor (see {@link floorRadius}), so scenes with
   * multiple floor levels and ramps need no global ground plane. Default 0.
   */
  groundHeight?: number;
  /**
   * Radius, in world units, of the neighborhood the local floor height is
   * estimated over. It should be a little larger than the footprint of the
   * smallest thing that must occlude (a crate, a wall's thickness), and below
   * half the extent of the smallest floor level that is raised above its
   * surroundings, or that level reads solid. It is also how thick the solid rim
   * of a mass too wide to read solid throughout comes out. Default 1.5.
   */
  floorRadius?: number;
  /**
   * Rise above the local floor at which a surface becomes a full occluder in
   * `footprint` domain; half of it is still fully open. Because the floor
   * estimate is a linear-preserving low pass, a constant slope reads as floor
   * no matter how high it climbs — only local elevation occludes. Keep it
   * above `0.5 * floorRadius * steepestRampSlope`, which is how far the
   * estimate dips below the floor where a ramp meets a level. Default 0.7.
   *
   * Also the contact shadow's scale in both directions: geometry rising this far
   * casts it at full strength, and a surface standing this far above its own
   * local floor stops receiving it, because it is a raised mass rather than a
   * floor something stands on.
   */
  stepHeight?: number;
  /**
   * Strength of the contact shadow in `footprint` domain, in [0, 1]. Standing
   * geometry darkens the up-facing surfaces around its base by at most this
   * fraction, which multiplies solved light and ambient alike. 0 disables the
   * term. Default 0.6.
   *
   * A Gaussian over a silhouette is 0.5 at the silhouette's own edge and only
   * approaches 1 well inside a mass wider than a couple of
   * {@link ScreenSpaceRCOptions.contactRadius}, so this is the darkening under a
   * crate, and the contact line beside it gets about half of it.
   *
   * The flatland solve cannot ground geometry by itself. Its occlusion is a
   * property of the top-down silhouette, so light reaching a floor texel from
   * beyond a mass is already blocked, but light reaching it from every open
   * direction is not — a crate's own footprint stays as bright as the floor it
   * sits on and reads as a decal. This term is that missing near-field
   * occlusion, and being an occlusion factor rather than a light rejection it
   * cannot black a surface out.
   *
   * It grounds every silhouette equally, whether or not the geometry casting it
   * rests on what it darkens. A hovering prop reads the same as a column standing
   * on the floor, because a top-down field holds only the nearest surface per
   * texel and from above the two are the same silhouette.
   */
  contactStrength?: number;
  /**
   * How far the contact shadow softens outward from the geometry casting it, in
   * world units. The occlusion is a separable Gaussian over the local silhouette
   * and this is its standard deviation, so the shadow is half strength at the
   * silhouette's edge, faint by twice this outside it, and cut off at two and a
   * half times. Keep it near the size of the gap a prop should darken — much
   * wider and every wall grounds itself with a soft halo instead of an edge.
   * Default 0.05, which is a tight contact line rather than a soft pool — at
   * that size the tap spacing sits near its per-texel floor, so the reach is
   * whatever the field resolution can resolve and raising this is what buys
   * softness.
   */
  contactRadius?: number;
  /** Radiance for rays that leave the field. Default black. */
  sky?: ColorRepresentation;
  /**
   * Temporal accumulation factor in [0, 1): each field update the light is
   * `mix(current, history, temporalBlend)`, with the history reprojected per
   * texel through the previous field camera using the field G-buffer's world
   * positions (correct under camera translation and rotation). Damps
   * frame-to-frame flicker under motion at the cost of a short trail on
   * moving lights. Default 0.
   */
  temporalBlend?: number;
  /** Ambient color added when compositing. */
  ambient?: ColorRepresentation;
  /** Ambient color multiplier. Default 1. */
  ambientIntensity?: number;
  /** Surface sample offset along the world normal, in field texels. Default 2.5. */
  normalOffsetTexels?: number;
  /**
   * Resolves the composite through FXAA instead of writing it straight out.
   * A deferred pipeline cannot multisample its composite — one G-buffer texel
   * holds one surface — and this lighting model puts hard, high-contrast
   * transitions right on geometric creases: a floor inside a silhouette reads
   * inpainted light and contact shadow while the side face beside it is fully
   * lit. Unresolved, every crease and silhouette in the frame serrates. Costs
   * one fullscreen pass plus one viewport-sized target. Default true.
   */
  antialias?: boolean;
}

// "depth" is reserved: NodeMaterial.setupDepth routes an MRT output of that
// name to frag_depth as well, which would clobber the depth test.
const VIEW_GBUFFER_NAMES = ["output", "albedo", "viewDepth"] as const;
const FIELD_GBUFFER_NAMES = ["output", "position"] as const;
const DEFAULT_AMBIENT = new Color().setRGB(0.035, 0.04, 0.05);
const SOLID_HEIGHT_EPSILON = 0.01;
// Stand-in view depth for texels the view pass never drew. Their emissive and
// albedo are both zero so the composite reads black there whatever position it
// reconstructs, but zero depth would place them at the camera itself — which in
// `imagePlane` domain is exactly where the field camera sits, and the
// reprojection would divide zero by zero. Far down the ray keeps it finite.
const BACKGROUND_VIEW_DEPTH = 1e4;
// Default field extent bounds. HRC's cost grows as O(size^2 * log size) in both
// memory and passes — 512 costs ~150 MB and ~47 solve passes, 1024 four times
// that — so the default caps well below the drawing buffer. Applications that
// want a finer field pass `resolution` explicitly.
const FIELD_EXTENT_MIN = 256;
const FIELD_EXTENT_MAX = 512;
// Fully flattened geometry keeps this sliver of height so higher surfaces
// still win the depth test over the floor and the view matrix stays
// invertible.
const MIN_HEIGHT_SCALE = 0.01;
// The RC solve's sub-texel silhouette handling expects antialiased coverage
// in the solid mask; without it a moving camera re-quantizes every staircase
// each frame (temporal shimmer).
const FIELD_GBUFFER_SAMPLES = 4;
// The local floor reference is built on a quarter-resolution height pyramid
// level, so its box filter is properly prefiltered instead of combing over
// widely spaced taps.
const FLOOR_LEVEL_SCALE = 4;
const FLOOR_BLUR_RADIUS = 8;
const FLOOR_BLUR_TAPS = FLOOR_BLUR_RADIUS * 2 + 1;
// Shallowest downward view component the ground distance is estimated with,
// so a camera looking at or above the horizon still yields a finite reach.
const FIELD_MIN_DESCENT = 0.1;
// How far the parallel projection covers along a frustum corner, in multiples
// of the distance to the ground point the camera looks at. Corner rays climbing
// toward the horizon meet the ground arbitrarily far away or never, and a box
// sized to reach them would be coarse everywhere; past this the far ground is
// dropped instead, which a perspective field resolved at a few texels anyway.
const FIELD_HORIZON_REACH = 2;
// Quantization of the parallel projection's world extents, as a fraction of an
// octave. Coarser steps hold the field still longer at the cost of overdraw.
const FIELD_SCALE_OCTAVE = 1 / 8;
// Tap spacing bounds, in texels of the quarter-resolution level. Sub-texel
// spacing just oversamples the bilinear source; the upper bound caps how far
// a single comb reaches before it starts to alias.
const FLOOR_TAP_STEP_MIN = 0.25;
const FLOOR_TAP_STEP_MAX = 6;
// Below this average coverage a neighborhood holds no geometry worth
// averaging and the floor falls back to groundHeight.
const FLOOR_COVERAGE_EPSILON = 0.01;
// Field-camera depth slack of the image-plane visibility test, in field
// texels of world size. Wide enough to absorb the field's half resolution and
// the depth gradient across one texel of a grazing surface.
const DEPTH_TEST_TEXELS = 6;
// Horizontal component of a surface normal at which the surface counts as fully
// side-facing in footprint domain, so it reads its own footprint's light and is
// exempt from the contact shadow, which is meant for the floors a mass stands
// on. Half means anything tilted 30 degrees or more off level, which keeps the
// top bevels and rounded shoulders of a wall reading with the wall.
const HORIZONTALITY_KNEE = 0.5;
// Half-width of the contact shadow's separable Gaussian blur, in taps. The world
// radius comes from the tap spacing, so this only sets how finely the falloff is
// sampled — enough taps that the field's own texels do not show through it.
const CONTACT_BLUR_RADIUS = 6;
// Standard deviation of that Gaussian, in taps. The kernel is truncated at
// CONTACT_BLUR_RADIUS, so this trades where it cuts off against how much of the
// tap budget carries weight: 2.4 puts the cut at 2.5 sigma, past which under 2%
// of the mass is left to renormalize away.
const CONTACT_BLUR_SIGMA = 2.4;
const CONTACT_BLUR_WEIGHTS = ((): readonly number[] => {
  const weights: number[] = [];
  let total = 0;
  for (let i = -CONTACT_BLUR_RADIUS; i <= CONTACT_BLUR_RADIUS; i++) {
    const weight = Math.exp(-0.5 * (i / CONTACT_BLUR_SIGMA) ** 2);
    weights.push(weight);
    total += weight;
  }
  return weights.map((weight) => weight / total);
})();
// Tap spacing bounds for that blur, in field texels. Sub-texel spacing only
// oversamples the source. Tap density per standard deviation is fixed by
// CONTACT_BLUR_SIGMA no matter how the taps are spaced, so the upper bound is
// there to cap absolute reach — at 4 the kernel spans 24 texels either way,
// which is as wide as a two-pass separable blur stays cheap.
const CONTACT_TAP_STEP_MIN = 0.5;
const CONTACT_TAP_STEP_MAX = 4;
/** Rounds up to the next fixed geometric step, so the value only ever steps. */
function quantizeFieldScale(value: number): number {
  return (
    2 ** (Math.ceil(Math.log2(value) / FIELD_SCALE_OCTAVE) * FIELD_SCALE_OCTAVE)
  );
}

function resolveResolution(
  renderer: WebGPURenderer,
  resolution: number | undefined,
): number {
  if (resolution === undefined) {
    const size = renderer.getDrawingBufferSize(new Vector2());
    const half = Math.max(size.x, size.y) / 2;
    return Math.min(
      FIELD_EXTENT_MAX,
      Math.max(FIELD_EXTENT_MIN, 2 ** Math.floor(Math.log2(half))),
    );
  }
  if (!Number.isInteger(Math.log2(resolution)) || resolution < 4) {
    throw new Error(
      `ScreenSpaceRC: resolution must be a power of two >= 4, got ${resolution}`,
    );
  }
  return resolution;
}

/**
 * Guard-band camera whose projection is copied from the view camera on every
 * field update. The renderer calls updateProjectionMatrix when it adapts a
 * camera to its coordinate system; the copied matrix is already adapted, so
 * the call must not rebuild anything.
 */
class GuardBandCamera extends Camera {
  updateProjectionMatrix(): void {}
}

function createGBuffer(
  names: readonly string[],
  width: number,
  height: number,
  samples = 0,
): RenderTarget {
  const target = new RenderTarget(width, height, {
    count: names.length,
    type: HalfFloatType,
    samples,
  });
  names.forEach((name, index) => {
    target.textures[index]!.name = name;
  });
  return target;
}

function createFilteredTarget(
  width: number,
  height: number,
  count = 1,
): RenderTarget {
  const target = new RenderTarget(width, height, {
    type: HalfFloatType,
    depthBuffer: false,
    count,
  });
  for (const tex of target.textures) {
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
  }
  return target;
}

function passMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  // NodeMaterial forwards an `outputStruct` fragment node to the backend
  // untouched only if nothing wraps it, and fog is the one thing that would.
  material.fog = false;
  return material;
}

/**
 * ±1 per component, never 0 — the sign the octahedral fold needs. GLSL's own
 * `sign` returns 0 at 0, which would collapse a normal lying exactly on an
 * octant boundary to the origin.
 */
function signNonZero(value: Node<"float">): Node<"float"> {
  return select(value.greaterThanEqual(0), float(1), float(-1));
}

function signNonZero2(value: Node<"vec2">): Node<"vec2"> {
  return vec2(signNonZero(value.x), signNonZero(value.y));
}

/**
 * Octahedral normal encoding: a unit vector as two values in [-1, 1], accurate
 * to a few hundredths of a degree at half-float precision — the same accuracy
 * three raw half-float components carry, in two channels instead of three.
 * Branchless, because both directions run inside MRT node graphs that have no
 * function scope to open an `If` in.
 */
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
  // Unfolding the lower hemisphere is `xy = (1 - |yx|) * sign(xy)`, which for
  // z < 0 is exactly this subtraction: |x| + |y| - 1 is -z, and
  // x - sign(x)(|x| + |y| - 1) = sign(x)(1 - |y|).
  const fold = max(z.negate(), float(0));
  return vec3(encoded.sub(signNonZero2(encoded).mul(fold)), z).normalize();
}

/**
 * Turnkey screen-space Radiance Cascades renderer in the style of
 * Path of Exile 2: one flatland RC field lives in the camera's image plane
 * and follows the camera every frame.
 *
 * The field G-buffer (emissive radiance + world position) is rendered through
 * a guard-band camera — the view camera with its frustum symmetrically
 * widened by {@link ScreenSpaceRCOptions.padding} — so off-screen emitters
 * and occluders near the frame keep contributing light and shadow. A local
 * floor height is estimated from that G-buffer's heights and turned into the
 * occluder mask and the contact shadow's averaged rise; {@link FieldSpaceRC}
 * then solves the field (JFA distance field, penumbra ray march, cascade merge,
 * solid inpaint), and the composite
 * pass reprojects each view pixel's stored world position through the
 * guard-band camera used for the most recent field update, so the final image
 * stays exact even on frames that reuse the previous field.
 *
 * Occlusion is measured against the *local* floor rather than a global ground
 * plane, so ramps and stacked floor levels stay open while walls, steps, and
 * props occlude. The flatland domain is declared by the application
 * ({@link FlatlandDomain}) instead of derived from the camera pose, so the
 * lighting does not morph as the camera pitches.
 *
 * Motion stability rests on three mechanisms:
 * - the field G-buffer is multisampled, so silhouettes carry fractional
 *   coverage the RC solve can track continuously between texels;
 * - the guard-band projection is offset each update so a fixed world anchor
 *   always lands on the same sub-texel phase, keeping rasterization and the
 *   world-anchored probe lattice phase-locked under camera translation;
 * - the temporal history is reprojected per texel through the previous
 *   field camera using the stored world positions, which stays valid under
 *   rotation and perspective parallax.
 */
export class ScreenSpaceRC {
  readonly padding: number;
  readonly groundHeight: number;
  readonly floorRadius: number;
  readonly stepHeight: number;
  readonly ambientColor: Color;
  readonly normalOffsetTexels: number;
  /**
   * Runtime-tweakable contact shadow softening radius (see the option doc). Read
   * when the field camera is synced, so it takes effect on the next update.
   */
  contactRadius: number;

  private readonly renderer: WebGPURenderer;
  private readonly rc: FieldSpaceRC;
  private readonly fieldGBuffer: RenderTarget;
  private readonly viewGBuffer: RenderTarget;
  private readonly fieldPassMrt: MRTNode;
  private readonly viewPassMrt: MRTNode;
  private readonly fieldCamera: Camera;
  private readonly floorSrcTarget: RenderTarget;
  private readonly floorBlurTarget: RenderTarget;
  private readonly floorTarget: RenderTarget;
  private readonly maskTarget: RenderTarget;
  private readonly contactBlurTarget: RenderTarget;
  private readonly contactTarget: RenderTarget;
  private readonly floorDownMaterial: MeshBasicNodeMaterial;
  private readonly floorBlurMaterial: MeshBasicNodeMaterial;
  private readonly floorResolveMaterial: MeshBasicNodeMaterial;
  private readonly maskMaterial: MeshBasicNodeMaterial;
  private readonly contactBlurMaterial: MeshBasicNodeMaterial;
  private readonly contactResolveMaterial: MeshBasicNodeMaterial;
  /** One specialized composite per domain; see `compositeMaterialFor`. */
  private readonly compositeMaterials: Record<
    FlatlandDomain,
    MeshBasicNodeMaterial
  >;
  private readonly compositeQuad: QuadMesh;
  /** Composite destination and resolve quad when antialiasing is on. */
  private readonly resolveTarget: RenderTarget | null;
  private readonly resolveQuad: QuadMesh | null;
  private readonly quad = new QuadMesh();
  private readonly lightAccumTarget: RenderTarget;
  private readonly lightHistoryTarget: RenderTarget;
  private readonly temporalMaterial: MeshBasicNodeMaterial;
  private readonly historyCopyMaterial: MeshBasicNodeMaterial;
  private readonly uFieldViewProjection: { value: Matrix4 };
  private readonly uFieldView: { value: Matrix4 };
  private readonly uPreviousFieldViewProjection: { value: Matrix4 };
  private readonly uTemporalBlend: { value: number };
  private readonly uNormalOffset: { value: number };
  private readonly uViewRay: { value: Vector4 };
  private readonly uViewOrtho: { value: number };
  private readonly uViewCameraWorld: { value: Matrix4 };
  private readonly uAmbientIntensity: { value: number };
  private readonly uFootprint: { value: number };
  private readonly uFloorTapStep: { value: number };
  private readonly uContactTapStep: { value: number };
  private readonly uContactStrength: { value: number };
  private readonly uDepthSlack: { value: number };
  private temporalBlendValue: number;
  private domainValue: FlatlandDomain;
  private readonly flattenMatrix = new Matrix4();
  private historyValid = false;
  private readonly drawingBufferSize = new Vector2();
  private readonly previousClearColor = new Color();
  private readonly cameraPosition = new Vector3();
  private readonly viewDirection = new Vector3();
  private readonly anchorPoint = new Vector3();
  private readonly frustumCorner = new Vector3();
  private readonly snapMatrix = new Matrix4();
  private readonly snapViewProjection = new Matrix4();

  constructor(renderer: WebGPURenderer, options: ScreenSpaceRCOptions = {}) {
    const width = resolveResolution(renderer, options.resolution);
    const height = width;
    const drawingBufferSize = renderer.getDrawingBufferSize(new Vector2());

    this.renderer = renderer;
    this.padding = Math.max(options.padding ?? 0.25, 0);
    this.domainValue = options.domain ?? "footprint";
    this.groundHeight = options.groundHeight ?? 0;
    this.floorRadius = Math.max(options.floorRadius ?? 1.5, 1e-3);
    this.stepHeight = Math.max(options.stepHeight ?? 0.7, 1e-3);
    this.normalOffsetTexels = options.normalOffsetTexels ?? 2.5;
    this.contactRadius = Math.max(options.contactRadius ?? 0.05, 1e-3);
    this.temporalBlendValue = Math.min(
      Math.max(options.temporalBlend ?? 0, 0),
      0.99,
    );
    this.ambientColor =
      options.ambient !== undefined
        ? new Color(options.ambient)
        : DEFAULT_AMBIENT.clone();
    this.fieldGBuffer = createGBuffer(
      FIELD_GBUFFER_NAMES,
      width,
      height,
      FIELD_GBUFFER_SAMPLES,
    );
    this.viewGBuffer = createGBuffer(
      VIEW_GBUFFER_NAMES,
      drawingBufferSize.x,
      drawingBufferSize.y,
    );
    // The view G-buffer costs 20 bytes per pixel: two half-float colour
    // attachments and one f32 view depth. Every byte of it is read straight back
    // by the composite, so at 4K that pair of passes moves ~330 MB a frame and
    // is bandwidth-bound — which is why the third attachment holds depth rather
    // than the world position it used to. A fragment's own position lies on its
    // own view ray, so the composite reconstructs it exactly from depth, and the
    // world normal moves into the two spare alpha halves, octahedrally encoded.
    //
    // Depth needs full f32, but linearly: r32float keeps 24 bits of *relative*
    // precision at every distance, so the reconstructed position is good to
    // around a millionth of its own magnitude. A half float's ulp reaches 1/64
    // world unit by |coordinate| 16 — a sizable fraction of a light texel — and
    // the quantization staircased the composite's field UV, banding wherever the
    // light had a gradient. Nonlinear window depth would trade the same problem
    // for one that depends on the near plane. Nearest filtering because the
    // composite reads it 1:1 (and 32-bit floats are not filterable everywhere).
    const viewDepthTexture = this.viewGBuffer.textures[2]!;
    viewDepthTexture.type = FloatType;
    viewDepthTexture.format = RedFormat;
    viewDepthTexture.minFilter = NearestFilter;
    viewDepthTexture.magFilter = NearestFilter;
    // The field's surface heights, recovered from the field G-buffer (the
    // multisample resolve stores position × coverage, 1 − coverage). Nearest
    // because every consumer wants the height of one surface, not a blend
    // across a silhouette: filtering it would smear a wall's height out over
    // the floor beside it and darken a rim there in the visibility test.
    const fieldPositionTexture = this.fieldGBuffer.textures[1]!;
    fieldPositionTexture.minFilter = NearestFilter;
    fieldPositionTexture.magFilter = NearestFilter;

    const floorWidth = width / FLOOR_LEVEL_SCALE;
    const floorHeight = height / FLOOR_LEVEL_SCALE;
    this.floorSrcTarget = createFilteredTarget(floorWidth, floorHeight);
    this.floorBlurTarget = createFilteredTarget(floorWidth, floorHeight);
    this.floorTarget = createFilteredTarget(floorWidth, floorHeight);
    // Attachment 1 is the contact shadow's occluder presence, written by the
    // same pass off the same height sample.
    this.maskTarget = createFilteredTarget(width, height, 2);
    this.contactBlurTarget = createFilteredTarget(width, height);
    this.contactTarget = createFilteredTarget(width, height);

    const uFootprint = uniform(this.domainValue === "footprint" ? 1 : 0);
    const uFloorTapStep = uniform(1);
    const uContactTapStep = uniform(1);
    const uContactStrength = uniform(
      Math.min(Math.max(options.contactStrength ?? 0.8, 0), 1),
    );
    const uDepthSlack = uniform(0.05);
    this.uFootprint = uFootprint;
    this.uFloorTapStep = uFloorTapStep;
    this.uContactTapStep = uContactTapStep;
    this.uContactStrength = uContactStrength;
    this.uDepthSlack = uDepthSlack;

    const fieldResolution = vec2(width, height);
    const floorResolution = vec2(floorWidth, floorHeight);
    // Surface position at a field texel, and the coverage it was resolved
    // from. The multisample resolve stores position × coverage, so dividing
    // by (1 - w) recovers the average world position of the covered samples.
    const heightSampleAt = (uv: Node<"vec2">) => {
      const sample = textureLevel(fieldPositionTexture, uv, float(0));
      const coverage = float(1).sub(sample.w);
      const position = sample.xyz.div(max(coverage, 1e-3));
      return {
        coverage,
        position,
        height: position.y,
      };
    };
    const floorAt = (uv: Node<"vec2">): Node<"float"> =>
      textureLevel(this.floorTarget.texture, uv, float(0)).r;

    // --- Local floor height. A global ground plane cannot describe a scene
    // with ramps or stacked floor levels: thresholding absolute height makes
    // every raised floor solid and every ramp a wall. Instead the floor is
    // estimated per texel as a wide, coverage-weighted low pass of the height
    // field, and only the local *rise* above it occludes. A box filter
    // reproduces any linear height field exactly, so a constant slope reads
    // as floor however high it climbs, a plateau reads as floor in its
    // interior, and genuinely local elevation (walls, steps, crates) stands
    // out.
    //
    // Inside a mass wider than twice the radius every tap sits on the mass's
    // own top, so its core reads as a floor level and stops occluding. Only
    // the core does: the rim within one radius of every edge still sees the
    // drop and stays solid, which is a closed ring far thicker than a ray's
    // march step, so no light crosses the mass either way. Its top is then an
    // enclosed open floor that whatever stands on it lights directly, which is
    // both prettier and far steadier than widening the radius to force the top
    // solid — that only moves the mass to a half-solid estimate whose value
    // swings with the neighborhood.
    //
    // The pass chain is a 4x4 box downsample, then a separable box blur, with
    // tap spacing set from the world size of a field texel so the radius stays
    // a fixed world distance as the camera moves.
    this.floorDownMaterial = passMaterial();
    {
      const base = floor(screenUV.mul(floorResolution)).mul(FLOOR_LEVEL_SCALE);
      let sumHeight: Node<"float"> = float(0);
      let sumCoverage: Node<"float"> = float(0);
      for (let dy = 0; dy < FLOOR_LEVEL_SCALE; dy++) {
        for (let dx = 0; dx < FLOOR_LEVEL_SCALE; dx++) {
          const sample = textureLevel(
            fieldPositionTexture,
            base.add(vec2(dx + 0.5, dy + 0.5)).div(fieldResolution),
            float(0),
          );
          // position.y is already premultiplied by coverage, so summing y and
          // (1 - w) directly accumulates the coverage-weighted height.
          sumHeight = sumHeight.add(sample.y);
          sumCoverage = sumCoverage.add(float(1).sub(sample.w));
        }
      }
      const taps = FLOOR_LEVEL_SCALE * FLOOR_LEVEL_SCALE;
      this.floorDownMaterial.fragmentNode = vec4(
        sumHeight.div(taps),
        sumCoverage.div(taps),
        0,
        1,
      );
    }

    const blurSum = (source: Texture, axis: "x" | "y") => {
      let sumHeight: Node<"float"> = float(0);
      let sumCoverage: Node<"float"> = float(0);
      for (let i = -FLOOR_BLUR_RADIUS; i <= FLOOR_BLUR_RADIUS; i++) {
        const shift = uFloorTapStep.mul(i);
        const offset = axis === "x" ? vec2(shift, 0) : vec2(0, shift);
        const sample = textureLevel(
          source,
          screenUV.add(offset.div(floorResolution)),
          float(0),
        );
        sumHeight = sumHeight.add(sample.r);
        sumCoverage = sumCoverage.add(sample.g);
      }
      return vec4(
        sumHeight.div(FLOOR_BLUR_TAPS),
        sumCoverage.div(FLOOR_BLUR_TAPS),
        0,
        1,
      );
    };
    this.floorBlurMaterial = passMaterial();
    this.floorBlurMaterial.fragmentNode = blurSum(
      this.floorSrcTarget.texture,
      "x",
    );
    this.floorResolveMaterial = passMaterial();
    {
      const sums = blurSum(this.floorBlurTarget.texture, "y");
      // Where a neighborhood holds no geometry at all there is no floor to
      // estimate and the fallback stands in.
      this.floorResolveMaterial.fragmentNode = vec4(
        select(
          sums.g.greaterThan(FLOOR_COVERAGE_EPSILON),
          sums.r.div(max(sums.g, FLOOR_COVERAGE_EPSILON)),
          float(this.groundHeight),
        ),
        0,
        0,
        1,
      );
    }

    // --- Occluder mask consumed by the solve, and alongside it the contact
    // shadow's occluder presence. In `footprint` domain a texel occludes in
    // proportion to how far its surface rises above the local floor; the ramp
    // between half and full stepHeight keeps the mask a continuous function of
    // height, which is what lets the RC solve track silhouettes between texels.
    // In `imagePlane` domain world height is the image's vertical axis rather
    // than an off-plane dimension, so the raw above-ground silhouette from the
    // field pass is the mask.
    //
    // Both outputs are the same texel's rise over the same local floor, so they
    // ride as two attachments of one pass: the height sample and the floor
    // lookup are paid once instead of twice, and the contact source costs no
    // pass of its own.
    this.maskMaterial = passMaterial();
    {
      const source = textureLevel(
        this.fieldGBuffer.textures[0]!,
        screenUV,
        float(0),
      );
      const { coverage, height } = heightSampleAt(screenUV);
      const localFloor = floorAt(screenUV);
      const rise = height.sub(localFloor);
      const footprintMask = clamp(
        rise.div(this.stepHeight).mul(2).sub(1),
        float(0),
        float(1),
      ).mul(coverage);
      // A ray has to stop on an emitter for its radiance to be gathered, so
      // emissive texels are solid whatever their height. Without this a light
      // lying on the floor — a decal, a settling spark — would be invisible
      // to the solve. Scaling by coverage keeps a partially covered edge texel
      // from occluding more than the emitter actually fills, which would fatten
      // every emitter's silhouette by a texel.
      const emissivePresence = clamp(
        source.rgb.dot(vec3(1 / 3)).mul(64),
        float(0),
        float(1),
      ).mul(coverage);
      // Coverage weights the contact texel rather than gating it, so a
      // silhouette enters the blur with the fractional edge the multisampled
      // field resolved — the same treatment the occluder mask gives it.
      // Thresholded instead, every edge would quantize to whole field texels
      // and the blur would spread that staircase rather than remove it.
      const present = clamp(
        max(rise, float(0)).div(this.stepHeight),
        float(0),
        float(1),
      ).mul(coverage);
      this.maskMaterial.fragmentNode = outputStruct(
        vec4(
          source.rgb,
          max(mix(source.a, footprintMask, uFootprint), emissivePresence),
        ),
        vec4(present, 0, 0, 1),
      );
    }

    // --- Contact shadow source: how much this field texel occludes what lies
    // around its base, in [0, 1]. What this replaces was a per-texel column
    // height driving a binary "something stands over this pixel, give it no
    // light" rejection in the composite. Two things were wrong with that. Its
    // shape was the mass's top-down silhouette, so the answer was a drop shadow
    // pinned under the mass with no light direction and no falloff, and its
    // magnitude saturated instantly, so the shadow was a hard patch of pure
    // ambient. Grounding is a near-field effect and belongs in an occlusion
    // factor, not in a visibility test.
    //
    // Everything the blur carries is bounded and already weighted here, so the
    // composite only scales what it reads. An earlier pass sent world-unit
    // heights through the blur instead and reconstructed occlusion downstream by
    // subtracting the lit surface's own rise and dividing two blurred channels
    // by each other. Both operations are unbounded functions of interpolated
    // data: near a wall the wide floor estimate rises above the floor itself, the
    // subtraction went negative and *added* occlusion, and the quotient of two
    // near-zero channels resolved to whatever the clamp caught. Blotches, with
    // edges wherever one of the two saturated. A blur is only safe to read
    // linearly if what went into it was linear.
    //
    // Presence is all it carries. A vertical falloff used to ride alongside it,
    // weighting each occluder by how far its underside cleared the surface below
    // so a hovering prop grounded less than a resting one. That needed a
    // back-face-only render of the whole scene per field update to find the
    // undersides — a top-down field holds only the nearest surface per texel, so
    // a floating shape and a column read as the same silhouette — plus a second
    // blurred channel and a knob whose useful value depended on how far a given
    // scene's props happened to float. Every silhouette grounds equally now.
    // It is written as the mask pass's second attachment (see above), so what
    // follows is only the blur that softens it.

    // Gaussian rather than box, which is what the previous pass got wrong. A box
    // average of a silhouette is a linear ramp, so its ends are creases the eye
    // reads as edges, and every tap crossing the silhouette steps the result by
    // a full 1/taps — with taps spaced more than a texel apart to reach
    // `contactRadius`, those steps are wide flat bands, and two separable passes
    // make them a grid of them. Gaussian weights taper, so no single tap can
    // step the result and the reach costs no banding. Same filter three.js's
    // Horizontal/VerticalBlurShader pair uses for the same job.
    const contactBlurSum = (source: Texture, axis: "x" | "y") => {
      let sum: Node<"float"> = float(0);
      for (let i = -CONTACT_BLUR_RADIUS; i <= CONTACT_BLUR_RADIUS; i++) {
        const shift = uContactTapStep.mul(i);
        const offset = axis === "x" ? vec2(shift, 0) : vec2(0, shift);
        sum = sum.add(
          textureLevel(
            source,
            screenUV.add(offset.div(fieldResolution)),
            float(0),
          ).r.mul(CONTACT_BLUR_WEIGHTS[i + CONTACT_BLUR_RADIUS]!),
        );
      }
      return vec4(sum, 0, 0, 1);
    };
    this.contactBlurMaterial = passMaterial();
    this.contactBlurMaterial.fragmentNode = contactBlurSum(
      this.maskTarget.textures[1]!,
      "x",
    );
    this.contactResolveMaterial = passMaterial();
    this.contactResolveMaterial.fragmentNode = contactBlurSum(
      this.contactBlurTarget.texture,
      "y",
    );

    this.rc = new FieldSpaceRC(renderer, {
      size: width,
      emission: this.maskTarget.texture,
      sky: options.sky,
    });

    const uFieldViewProjection = uniform(new Matrix4());
    const uFieldView = uniform(new Matrix4());
    const uPreviousFieldViewProjection = uniform(new Matrix4());
    const uTemporalBlend = uniform(0);
    const uNormalOffset = uniform(0);
    const uAmbientIntensity = uniform(
      Math.max(options.ambientIntensity ?? 1, 0),
    );
    // The view camera's own unprojection, for the composite's position rebuild.
    // uViewRay holds the two scales and two offsets that turn NDC into view x/y
    // at unit depth; uViewOrtho selects whether those scale with depth (a
    // perspective frustum's rays diverge) or not (an orthographic one's are
    // parallel).
    const uViewRay = uniform(new Vector4());
    const uViewOrtho = uniform(0);
    const uViewCameraWorld = uniform(new Matrix4());
    this.uFieldViewProjection = uFieldViewProjection;
    this.uFieldView = uFieldView;
    this.uPreviousFieldViewProjection = uPreviousFieldViewProjection;
    this.uTemporalBlend = uTemporalBlend;
    this.uNormalOffset = uNormalOffset;
    this.uAmbientIntensity = uAmbientIntensity;
    this.uViewRay = uViewRay;
    this.uViewOrtho = uViewOrtho;
    this.uViewCameraWorld = uViewCameraWorld;

    // The field pass records emissive radiance, the above-ground silhouette
    // the image-plane mask is built from, and true (unflattened) world
    // positions the local floor, the elevations, and the visibility test all
    // read back.
    const aboveGround = select(
      positionWorld.y.greaterThan(this.groundHeight + SOLID_HEIGHT_EPSILON),
      float(1),
      float(0),
    );
    this.fieldPassMrt = mrt({
      output: vec4(emissive, aboveGround),
      // WebGPU clears secondary MRT attachments to (0, 0, 0, 1).
      // Store uncovered fraction so the clear represents no geometry. MSAA
      // resolves this to (position * coverage, 1 - coverage).
      position: vec4(positionWorld, 0),
    });

    const shade = abs(normalWorld.y).mul(0.3).add(0.7);
    // The world normal rides octahedrally encoded in the two spare alpha
    // channels, avoiding a third channel of its own; the composite uses it for
    // directional reception and for the normal offset it applies itself.
    const encodedNormal = encodeOctahedral(normalWorld);
    this.viewPassMrt = mrt({
      output: vec4(emissive, encodedNormal.x),
      albedo: vec4(diffuseColor.rgb.mul(shade), encodedNormal.y),
      // Distance along the view axis, which is what makes the world position
      // recoverable: the fragment's position projects to its own pixel centre,
      // so it is the one point at this depth on the ray that pixel unprojects
      // to. Written as a vec4 into a single-channel attachment, which WebGPU
      // allows — the extra components are discarded.
      viewDepth: vec4(positionView.z.negate(), 0, 0, 1),
    });

    this.fieldCamera = new GuardBandCamera();
    this.fieldCamera.matrixAutoUpdate = false;
    this.fieldCamera.matrixWorldAutoUpdate = false;

    // Temporal accumulation over the solved light, in field space. Each
    // texel's history is offset by a per-texel motion vector — the world
    // position rendered into the field G-buffer projected through the
    // previous minus the current field camera — so the accumulation survives
    // camera translation, rotation, and perspective parallax. The delta
    // formulation is exactly zero for a static camera no matter how the
    // filtered position blends surfaces at silhouette edges; sampling the
    // absolute reprojected UV instead creates a feedback loop there that
    // drags interior light onto silhouettes as stationary bright dots.
    // Texels without geometry (background) take the current light unblended.
    //
    // The irradiance vector accumulates through an identical chain, so the
    // anisotropy ratio (vector / luminance) the composite derives stays
    // consistent with the accumulated light — and it rides the second
    // attachment of these same two targets rather than a pair of its own. The
    // reprojection is the expensive part here (two matrix products and the
    // field position behind them) and one pass pays it once for both.
    const lightSize = this.rc.lightRenderTarget;
    this.lightAccumTarget = createFilteredTarget(
      lightSize.width,
      lightSize.height,
      2,
    );
    this.lightHistoryTarget = createFilteredTarget(
      lightSize.width,
      lightSize.height,
      2,
    );
    const current = texture(this.rc.lightTexture, screenUV);
    const fieldPosition = texture(fieldPositionTexture, screenUV);
    // The multisample resolve coverage-weights the attachment, so silhouette
    // edge texels hold (position * coverage, 1 - coverage); dividing by coverage
    // recovers the average world position of the covered samples.
    const coverage = float(1).sub(fieldPosition.w);
    const fieldWorldPosition = vec4(
      fieldPosition.xyz.div(max(coverage, 1e-3)),
      1,
    );
    const toUv = (clip: Node<"vec4">) => {
      const ndc = clip.xy.div(clip.w);
      return vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
    };
    const previousClip = uPreviousFieldViewProjection.mul(fieldWorldPosition);
    const currentClip = uFieldViewProjection.mul(fieldWorldPosition);
    const historyUv = screenUV.add(toUv(previousClip).sub(toUv(currentClip)));
    const history = texture(this.lightHistoryTarget.textures[0]!, historyUv);
    const historyUsable = coverage
      .greaterThan(0.25)
      .and(previousClip.w.greaterThan(0))
      .and(currentClip.w.greaterThan(0))
      .and(historyUv.x.greaterThanEqual(0))
      .and(historyUv.x.lessThanEqual(1))
      .and(historyUv.y.greaterThanEqual(0))
      .and(historyUv.y.lessThanEqual(1));
    const blendAmount = select(historyUsable, uTemporalBlend, float(0));
    this.temporalMaterial = passMaterial();
    this.temporalMaterial.fragmentNode = outputStruct(
      mix(current, history, blendAmount),
      mix(
        texture(this.rc.lightDirectionTexture, screenUV),
        texture(this.lightHistoryTarget.textures[1]!, historyUv),
        blendAmount,
      ),
    );
    this.historyCopyMaterial = passMaterial();
    this.historyCopyMaterial.fragmentNode = outputStruct(
      texture(this.lightAccumTarget.textures[0]!, screenUV),
      texture(this.lightAccumTarget.textures[1]!, screenUV),
    );

    const ambient = uniform(this.ambientColor);
    const emissionSample = texture(this.viewGBuffer.textures[0]!, screenUV);
    const albedoSample = texture(this.viewGBuffer.textures[1]!, screenUV);
    const normal = decodeOctahedral(vec2(emissionSample.a, albedoSample.a));
    // --- The pixel's world position, rebuilt from its view depth. Exact for the
    // surface that was rendered: an interpolated position projects to its own
    // pixel centre, so it is the point at this depth on this pixel's view ray.
    // Render-target v runs opposite to NDC y, here and in every reprojection
    // below.
    const depthSample = texture(this.viewGBuffer.textures[2]!, screenUV).r;
    const viewDepth = select(
      depthSample.greaterThan(0),
      depthSample,
      float(BACKGROUND_VIEW_DEPTH),
    );
    const lateralScale = mix(viewDepth, float(1), uViewOrtho);
    const viewPosition = vec3(
      screenUV.x
        .mul(2)
        .sub(1)
        .mul(uViewRay.x)
        .add(uViewRay.z)
        .mul(lateralScale),
      float(1)
        .sub(screenUV.y.mul(2))
        .mul(uViewRay.y)
        .add(uViewRay.w)
        .mul(lateralScale),
      viewDepth.negate(),
    );
    const surfacePosition = uViewCameraWorld.mul(vec4(viewPosition, 1)).xyz;
    // Offset along the normal so the field is sampled just off the surface's own
    // solid silhouette. Applied here rather than baked into the G-buffer because
    // the offset leaves the view ray, and only points on the ray survive a
    // depth round trip.
    const positionSample = surfacePosition.add(normal.mul(uNormalOffset));
    // Reproject the pixel's world position through the guard-band camera of
    // the most recent field update.
    const clip = uFieldViewProjection.mul(vec4(positionSample, 1));
    const ndc = clip.xy.div(clip.w);
    const fieldUv = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
    // Directional reception. The solve's flatland irradiance vector divided
    // by the light's luminance is a bounded anisotropy direction; weighting
    // by its alignment with the surface normal's field-plane projection is
    // flatland N·L: faces turned toward the light's net flow receive it,
    // back faces fall to zero. Normals without a field-plane footprint —
    // floors and ceilings, which flatten to nothing — have no defined facing
    // there and keep full omnidirectional reception, blending in smoothly as
    // horizontality grows.
    const filledLight = texture(this.lightAccumTarget.textures[0]!, fieldUv);
    // The inpaint fills occluders from both sides. Where the normal offset
    // projects outside scene coverage, there is no surface to inpaint: use
    // transported light rather than extending the wall's interior glow there.
    let openLight: Node<"vec4"> = vec4(0);
    for (const x of [-0.5, 0.5]) {
      for (const y of [-0.5, 0.5]) {
        openLight = openLight.add(
          texture(this.rc.directTexture, fieldUv.add(vec2(x, y).div(this.rc.size))),
        );
      }
    }
    const fieldPixel = fieldUv.mul(fieldResolution).sub(0.5);
    const fieldBase = floor(fieldPixel);
    const fieldFraction = fieldPixel.sub(fieldBase);
    let surfaceCoverage: Node<"float"> = float(0);
    for (let y = 0; y <= 1; y++) {
      for (let x = 0; x <= 1; x++) {
        const uv = fieldBase.add(vec2(x, y)).add(0.5).div(fieldResolution);
        const weight = (x === 0 ? float(1).sub(fieldFraction.x) : fieldFraction.x)
          .mul(y === 0 ? float(1).sub(fieldFraction.y) : fieldFraction.y);
        surfaceCoverage = surfaceCoverage.add(heightSampleAt(uv).coverage.mul(weight));
      }
    }
    const outside = float(1).sub(surfaceCoverage)
      .mul(clamp(vec2(normal.x, normal.z).length(), 0, 1))
      .mul(uFootprint);
    const lightSample = mix(filledLight, openLight.mul(0.25), outside);
    const lightDir = texture(this.lightAccumTarget.textures[1]!, fieldUv).xy;
    const lum = lightSample.rgb.dot(vec3(1 / 3));
    const anisotropy = lightDir.div(max(lum, 1e-4));
    // Field pixel space: project through the field camera, +y down.
    const normalClip = uFieldViewProjection.mul(vec4(normal, 0));
    const normalUv = vec2(normalClip.x, normalClip.y.negate());
    const normalLen = normalUv.length();
    // How much the surface faces sideways *in the flatland plane* — a property
    // of the surface, not of the projection. Taking it from the projected
    // normal's magnitude instead ties it to the field projection's scale: under
    // the parallel projection of footprint domain a unit normal lands a few
    // hundredths of clip space long, so every side face would read as up-facing.
    // The contact term below would then darken wall bases in a per-texel comb,
    // because a side face reads its own footprint strip, whose rasterization
    // staircases from texel to texel. Only the projected *direction* is used,
    // which is scale-free.
    const horizontality = clamp(
      vec2(normal.x, normal.z).length().div(HORIZONTALITY_KNEE),
      float(0),
      float(1),
    );
    const normalDir = normalUv.div(max(normalLen, 1e-4));
    const directional = clamp(
      anisotropy.dot(normalDir).mul(0.5).add(0.5),
      float(0),
      float(1),
    );
    // Reception blends over the whole quarter turn, on |n.xz| raw — the sine of
    // the surface's tilt off level. The tight HORIZONTALITY_KNEE belongs to the
    // occlusion gates, where a wall's bevel has to read as the wall; used here
    // it makes the up-facing cap of every rounded prop a patch of full
    // omnidirectional reception ringed, 30 degrees away, by surface that only
    // gets flatland N·L — a bright speck, the mirror image of the dark one the
    // height fade used to leave there.
    // Reception, the depth gate and the contact term are each live in exactly
    // one domain, and the composite runs at full output resolution — so the
    // domain is a compile-time literal here rather than the `uFootprint`
    // uniform the field-resolution passes use. Branching in JS leaves the dead
    // side's nodes unreferenced, and an unreferenced node generates nothing:
    // `imagePlane` never fetches the irradiance vector, the floor or the
    // contact field, and `footprint` never reprojects a depth. Same arithmetic
    // as multiplying by a 0/1 uniform, minus the multiply and the fetches.
    const receiveFor = (footprint: boolean) =>
      footprint
        ? mix(float(1), directional, vec2(normal.x, normal.z).length())
        : float(1);

    // --- Visibility validation. The light at `fieldUv` was solved for
    // whatever surface the field camera saw there, which is not always this
    // pixel's surface: the field holds one surface per texel, so anything it
    // could not see reads a stranger's light.
    const fieldFloor = floorAt(fieldUv);
    const fieldSurface = heightSampleAt(fieldUv);
    // Image-plane domain: a plain reprojection depth test against the field
    // camera. Exact while the field is current (same camera, same visibility)
    // and the disocclusion test for frames that reuse an older field. Footprint
    // domain has no equivalent — flattened, the field sees every surface a
    // top-down map can hold — so it keeps all of its light and grounds geometry
    // with the contact term below instead.
    const pixelDepth = uFieldView.mul(vec4(positionSample, 1)).z;
    const fieldDepth = uFieldView.mul(vec4(fieldSurface.position, 1)).z;
    const buriedByDepth = clamp(
      fieldDepth.sub(pixelDepth).div(uDepthSlack).sub(1),
      float(0),
      float(1),
    );
    // With no surface at the texel there is no depth to compare against.
    const hiddenFor = (footprint: boolean) =>
      footprint
        ? float(0)
        : select(
            fieldSurface.coverage.greaterThan(0.5),
            buriedByDepth,
            float(0),
          );

    // --- Contact shadow. How much occluder stands in the neighborhood around
    // this pixel, softened over `contactRadius`, and how far above the pixel its
    // underside sits. Read through hardware bilinear so both vary continuously
    // across the field grid rather than in field-resolution squares.
    const contactSample = texture(this.contactTarget.texture, fieldUv);
    // Squared, which is what turns a blur into a contact shadow. A Gaussian over
    // a silhouette is an erf: 0.5 at the silhouette's own edge with a long, flat
    // shoulder outside it. Read straight, a reach wide enough to see under a prop
    // also lays a broad half-strength wash along the foot of every wall — a halo,
    // and the only radius without one is a radius too small to soften anything,
    // which is a hard silhouette decal again. Squaring leaves the interior alone
    // (1² is 1) and collapses the shoulder, so the darkness stays under the mass
    // and the tail outside it is short. `contactRadius` still sets the reach; the
    // exponent decides how much of it is shadow rather than wash.
    const contactOcclusion = contactSample.r.mul(contactSample.r);
    // Which surfaces are floors to begin with. A mass reads the same occlusion
    // its own base does — nothing in a top-down neighborhood distinguishes them
    // — so the receiver decides, by its own rise above its own local floor: at
    // floor level it takes the term in full, a step up it takes none. Both
    // factors are separately bounded, unlike the height difference this replaces,
    // which drove the term past 1 wherever the floor estimate sat above the
    // floor.
    //
    // The unoffset position, not the one the field is sampled through: the normal
    // offset is not part of where the surface stands, and on an up-facing surface
    // it is entirely height, so counted in, open floor reads as standing that far
    // above its own floor and exempts itself everywhere.
    const surfaceHeight = surfacePosition.y;
    const receiving = float(1).sub(
      clamp(
        surfaceHeight.sub(fieldFloor).div(this.stepHeight),
        float(0),
        float(1),
      ),
    );
    // Side faces are exempt too: a wall's own face sits inside the neighborhood
    // that its own height dominates, so the term would darken every wall from
    // its base up. The surfaces that need grounding are the up-facing ones a
    // mass stands on.
    const contactFor = (footprint: boolean) =>
      footprint
        ? float(1).sub(
            contactOcclusion
              .mul(receiving)
              .mul(float(1).sub(horizontality))
              .mul(uContactStrength),
          )
        : null;

    // No height reception fade. The old solve carried each texel's
    // luminance-weighted source height in the light's alpha and up-facing
    // surfaces faded out one step above it, so a wall top standing over the
    // lights that reached it stayed unlit. A holographic cone merge has no
    // channel to carry that: the alpha is the frustum's unterminated solid
    // angle, and a fifth channel means a second target per cascade, doubling
    // the solve. Wall tops above their lights now read the same light their
    // footprint does. ponytail: the fade goes rather than being faked from an
    // assumed light-volume height, which is the assumption the whole
    // per-texel source height existed to avoid. Bring it back with a second
    // cascade target if flat tops need to fall dark again.
    // The contact term multiplies ambient along with the solved light. Applied
    // to the light alone it would leave the shadow a flat plateau of pure
    // ambient — exactly what made the old rejection read as a decal pasted
    // under the mass rather than as an absence of light.
    const compositeMaterialFor = (footprint: boolean) => {
      const receive = receiveFor(footprint);
      const hidden = hiddenFor(footprint);
      const contact = contactFor(footprint);
      const attenuated = footprint
        ? lightSample.rgb.mul(receive)
        : lightSample.rgb.mul(float(1).sub(hidden));
      const lit = attenuated.add(ambient.mul(uAmbientIntensity));
      const material = new MeshBasicNodeMaterial();
      material.colorNode = emissionSample.rgb.add(
        albedoSample.rgb.mul(contact === null ? lit : lit.mul(contact)),
      );
      material.depthTest = false;
      material.depthWrite = false;
      return material;
    };
    this.compositeMaterials = {
      footprint: compositeMaterialFor(true),
      imagePlane: compositeMaterialFor(false),
    };
    this.compositeQuad = new QuadMesh(
      this.compositeMaterials[this.domainValue],
    );

    if (options.antialias ?? true) {
      // The resolve target keeps the composite in linear HDR, so tone mapping
      // and output encoding still happen once, in the pass that reaches the
      // output. FXAA therefore detects edges on linear radiance, which its
      // relative contrast threshold handles; the absolute one is dead weight
      // there and only ever makes it resolve an edge it could have skipped.
      this.resolveTarget = createFilteredTarget(1, 1);
      const resolveMaterial = passMaterial();
      // three declares its addon nodes as plain nodes, without TSL's fluent
      // extensions, so the result needs a cast to be assigned as a color node.
      // Sampled through screenUV like every other pass here. Left to itself the
      // node falls back to the quad's own uv attribute, whose v may run the
      // other way, and the resolve would land the frame upside down. Its edge
      // search is symmetric, so which way v runs does not otherwise matter.
      resolveMaterial.colorNode = fxaa(
        texture(this.resolveTarget.texture, screenUV),
      ) as unknown as Node<"vec4">;
      this.resolveQuad = new QuadMesh(resolveMaterial);
    } else {
      this.resolveTarget = null;
      this.resolveQuad = null;
    }
  }

  /**
   * Layers the radiance field renders (default: layer 0 only). A mesh on a
   * layer outside this mask is view-only — it neither occludes nor emits in
   * the lighting solve. Flatland occlusion shadows everything behind a
   * silhouette at full strength, so small dynamic props (characters, crates)
   * that should not cast a full-height shadow behind them belong on an excluded
   * layer that only the view camera additionally enables. They lose their
   * contact shadow along with it — the term is driven by the field's heights,
   * which an excluded mesh never reaches.
   */
  get fieldLayers(): Layers {
    return this.fieldCamera.layers;
  }

  /** RC field width in pixels. The field is square. */
  get fieldWidth(): number {
    return this.rc.size;
  }

  /** RC field height in pixels. The field is square. */
  get fieldHeight(): number {
    return this.rc.size;
  }

  /** Temporally accumulated light in guard-band field space. */
  get lightTexture(): Texture {
    return this.lightAccumTarget.texture;
  }

  get directTexture(): Texture {
    return this.rc.directTexture;
  }

  get distanceTexture(): Texture {
    return this.rc.distanceTexture;
  }

  /** Estimated local floor height, in guard-band field space. */
  get floorTexture(): Texture {
    return this.floorTarget.texture;
  }

  /** Occluder mask and radiance the solve runs on. */
  get maskTexture(): Texture {
    return this.maskTarget.texture;
  }

  /**
   * Contact shadow occluder presence in guard-band field space, in red, softened
   * over `contactRadius`. The composite squares it and scales it by the receiving
   * surface and `contactStrength`, so this is the term before all of that rather
   * than the shadow itself.
   */
  get contactTexture(): Texture {
    return this.contactTarget.texture;
  }

  /** Runtime-tweakable temporal accumulation factor (see the option doc). */
  set temporalBlend(value: number) {
    this.temporalBlendValue = Math.min(Math.max(value, 0), 0.99);
  }

  get temporalBlend(): number {
    return this.temporalBlendValue;
  }

  set ambientIntensity(value: number) {
    this.uAmbientIntensity.value = Math.max(value, 0);
  }

  get ambientIntensity(): number {
    return this.uAmbientIntensity.value;
  }

  /** Runtime-tweakable contact shadow strength (see the option doc). */
  set contactStrength(value: number) {
    this.uContactStrength.value = Math.min(Math.max(value, 0), 1);
  }

  get contactStrength(): number {
    return this.uContactStrength.value;
  }

  /**
   * Flatland domain of the solve (see {@link FlatlandDomain}). Applications
   * that swap between projections — a top-down level and a side-scrolling one
   * sharing a renderer — set it when they swap; the temporal history should be
   * reset alongside, since the light field changes meaning.
   */
  set domain(value: FlatlandDomain) {
    if (value === this.domainValue) return;
    this.domainValue = value;
    const footprint = value === "footprint" ? 1 : 0;
    this.uFootprint.value = footprint;
    this.compositeQuad.material = this.compositeMaterials[value];
    this.historyValid = false;
  }

  get domain(): FlatlandDomain {
    return this.domainValue;
  }

  /**
   * Renders the camera view and final composite. Set `updateFields` to false
   * to reuse the previous RC field for this frame; the composite reprojects
   * against the field's own camera pose, so camera motion in between stays
   * correct up to the guard band.
   */
  render(scene: Scene, camera: Camera, updateFields = true): void {
    const outputTarget = this.renderer.getRenderTarget();
    const previousMrt = this.renderer.getMRT();
    const previousAutoClear = this.renderer.autoClear;
    this.renderer.getClearColor(this.previousClearColor);
    const previousClearAlpha = this.renderer.getClearAlpha();
    this.resizeViewGBuffer(outputTarget);

    try {
      this.renderer.autoClear = true;
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setMRT(this.viewPassMrt);
      this.renderer.setRenderTarget(this.viewGBuffer);
      this.renderer.render(scene, camera);
      // Synced after the view render, like the field camera below, so the
      // projection the composite unprojects with is the adapted one the pass
      // actually used.
      this.syncViewUnprojection(camera);
      if (updateFields) {
        // Synced after the view render, so the copied projection matrix is
        // already adapted to the renderer's coordinate system.
        this.syncFieldCamera(camera);
        this.renderer.setMRT(this.fieldPassMrt);
        this.renderer.setRenderTarget(this.fieldGBuffer);
        this.renderer.render(scene, this.fieldCamera);
        this.renderer.setMRT(null);
        this.pass(this.floorSrcTarget, this.floorDownMaterial);
        this.pass(this.floorBlurTarget, this.floorBlurMaterial);
        this.pass(this.floorTarget, this.floorResolveMaterial);
        this.pass(this.maskTarget, this.maskMaterial);
        this.pass(this.contactBlurTarget, this.contactBlurMaterial);
        this.pass(this.contactTarget, this.contactResolveMaterial);
        this.rc.update();
        this.uTemporalBlend.value = this.historyValid
          ? this.temporalBlendValue
          : 0;
        this.pass(this.lightAccumTarget, this.temporalMaterial);
        this.pass(this.lightHistoryTarget, this.historyCopyMaterial);
        this.uPreviousFieldViewProjection.value.copy(
          this.uFieldViewProjection.value,
        );
        this.historyValid = true;
      }
      this.renderer.setMRT(previousMrt);
      if (this.resolveQuad && this.resolveTarget) {
        this.renderer.setRenderTarget(this.resolveTarget);
        this.compositeQuad.render(this.renderer);
        this.renderer.setRenderTarget(outputTarget);
        this.resolveQuad.render(this.renderer);
      } else {
        this.renderer.setRenderTarget(outputTarget);
        this.compositeQuad.render(this.renderer);
      }
    } finally {
      this.renderer.setRenderTarget(outputTarget);
      this.renderer.setMRT(previousMrt);
      this.renderer.setClearColor(this.previousClearColor, previousClearAlpha);
      this.renderer.autoClear = previousAutoClear;
    }
  }

  dispose(): void {
    this.rc.dispose();
    this.fieldGBuffer.dispose();
    this.viewGBuffer.dispose();
    this.floorSrcTarget.dispose();
    this.floorBlurTarget.dispose();
    this.floorTarget.dispose();
    this.maskTarget.dispose();
    this.contactBlurTarget.dispose();
    this.contactTarget.dispose();
    this.lightAccumTarget.dispose();
    this.lightHistoryTarget.dispose();
    this.floorDownMaterial.dispose();
    this.floorBlurMaterial.dispose();
    this.floorResolveMaterial.dispose();
    this.maskMaterial.dispose();
    this.contactBlurMaterial.dispose();
    this.contactResolveMaterial.dispose();
    this.temporalMaterial.dispose();
    this.historyCopyMaterial.dispose();
    this.compositeMaterials.footprint.dispose();
    this.compositeMaterials.imagePlane.dispose();
    this.resolveTarget?.dispose();
    (
      this.resolveQuad?.material as MeshBasicNodeMaterial | undefined
    )?.dispose();
  }

  private pass(target: RenderTarget, material: MeshBasicNodeMaterial): void {
    this.renderer.setRenderTarget(target);
    this.quad.material = material;
    this.quad.render(this.renderer);
  }

  /**
   * Publishes the inverse of the view camera's projection to the composite,
   * which rebuilds each pixel's world position from the view depth in the
   * G-buffer. Only the x and y rows are needed — the depth stored is linear, so
   * the projection's depth row, the one the renderer rewrites when it adapts a
   * camera to its clip-space convention, never enters the reconstruction.
   */
  private syncViewUnprojection(camera: Camera): void {
    const e = camera.projectionMatrix.elements;
    const orthographic = e[15] !== 0;
    // Perspective carries its lateral offset in the projection's third column,
    // scaled by view depth along with everything else; orthographic carries it
    // in the fourth, negated and depth-independent.
    this.uViewRay.value.set(
      1 / e[0]!,
      1 / e[5]!,
      (orthographic ? -e[12]! : e[8]!) / e[0]!,
      (orthographic ? -e[13]! : e[9]!) / e[5]!,
    );
    this.uViewOrtho.value = orthographic ? 1 : 0;
    this.uViewCameraWorld.value.copy(camera.matrixWorld);
  }

  /**
   * Mirrors the view camera and symmetrically widens its frustum by the
   * padding factor. Scaling the projection's diagonal terms widens both
   * perspective and orthographic projections.
   *
   * In `footprint` domain a mirrored *perspective* projection is replaced by an
   * orthographic one covering the same ground, because only then is the field's
   * world-to-texel map affine and the anchor snap actually able to lock it. A
   * perspective camera images a tilted ground plane through a homography, so
   * translating it moves near ground faster than far ground: no single
   * post-projection offset can hold every texel's phase, the whole solve
   * re-quantizes every frame, and every shadow and light pool crawls. Under a
   * parallel projection any camera translation is an exact image translation
   * and the field goes perfectly world-locked. Side-on `imagePlane` scenes are
   * unaffected: their geometry lies near a plane parallel to the image, which is
   * already stable, and their perspective is the look the domain exists for.
   */
  private syncFieldCamera(camera: Camera): void {
    camera.updateMatrixWorld();
    const field = this.fieldCamera;
    const scale = 1 + 2 * this.padding;
    field.matrixWorld.copy(camera.matrixWorld);
    field.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const footprint = this.domainValue === "footprint";
    const heightScale = footprint ? MIN_HEIGHT_SCALE : 1;
    if (heightScale < 1) {
      // Squash world height toward the ground plane for everything the
      // field sees. Folding the affine squash into the view matrix flattens
      // rasterization, the anchor snap, the composite lookup, and the
      // temporal reprojection identically, while positionWorld (and with it
      // the stored G-buffer positions the floor and the elevations come
      // from) keeps true heights.
      const flatten = this.flattenMatrix.makeScale(1, heightScale, 1);
      flatten.elements[13] = this.groundHeight * (1 - heightScale);
      field.matrixWorldInverse.multiply(flatten);
      field.matrixWorld.copy(field.matrixWorldInverse).invert();
    }
    const perspective = camera.projectionMatrix.elements[15] === 0;
    if (footprint && perspective) {
      this.setGroundOrthoProjection(camera, field, scale);
    } else {
      const e = field.projectionMatrix.copy(camera.projectionMatrix).elements;
      // The field is square, so matching the view's aspect would make its
      // texels anisotropic and HRC's 45-degree rays no longer 45 degrees in
      // world space. Widening the narrower axis to match the wider one keeps
      // texels square and still covers the whole view, at the cost of
      // resolution along that axis.
      const isotropic = Math.min(e[0]!, e[5]!) / scale;
      e[0] = isotropic;
      e[5] = isotropic;
    }
    this.snapProjectionToAnchor(field);
    field.projectionMatrixInverse.copy(field.projectionMatrix).invert();
    this.uFieldView.value.copy(field.matrixWorldInverse);
    this.uFieldViewProjection.value.multiplyMatrices(
      field.projectionMatrix,
      field.matrixWorldInverse,
    );
    const texelWorldSize = this.fieldTexelWorldSize(camera);
    this.uNormalOffset.value = this.normalOffsetTexels * texelWorldSize;
    this.uDepthSlack.value = Math.max(DEPTH_TEST_TEXELS * texelWorldSize, 1e-3);
    // Keep the floor estimate's world radius constant as the camera moves.
    // The taps live on the quarter-resolution level, and spacing below one
    // texel just oversamples; the upper clamp bounds how far a single blur
    // can reach before its comb starts to alias.
    this.uFloorTapStep.value = Math.min(
      Math.max(
        this.floorRadius /
          (FLOOR_LEVEL_SCALE * texelWorldSize * FLOOR_BLUR_RADIUS),
        FLOOR_TAP_STEP_MIN,
      ),
      FLOOR_TAP_STEP_MAX,
    );
    // Same for the contact shadow's reach, whose taps live on the full-
    // resolution field rather than the quarter-resolution floor level. Spacing
    // the taps is what scales a fixed Gaussian, and `contactRadius` is that
    // Gaussian's standard deviation in world units, so the step is how many
    // texels one tap of standard deviation spans.
    //
    // Dividing by CONTACT_BLUR_RADIUS instead — putting `contactRadius` at the
    // truncation point rather than at one sigma — is what made this invisible.
    // The kernel cuts off at RADIUS/SIGMA = 2.5 sigma, so a radius of 0.6 was
    // really a sigma of 0.24, and a Gaussian blur of a silhouette is only 0.5 at
    // the silhouette's own edge. Under a tenth of a world unit of penumbra at
    // half strength is nothing to see.
    this.uContactTapStep.value = Math.min(
      Math.max(
        this.contactRadius / (texelWorldSize * CONTACT_BLUR_SIGMA),
        CONTACT_TAP_STEP_MIN,
      ),
      CONTACT_TAP_STEP_MAX,
    );
  }

  /**
   * Builds the parallel projection that covers the ground the widened view
   * frustum sees, keeping the view camera's orientation so the box still hugs
   * the visible region instead of an axis-aligned bound of it.
   *
   * The extents are quantized to fixed geometric steps rather than tracking the
   * coverage exactly. Their *scale* is the one part of the map the anchor snap
   * cannot absorb — a continuously breathing box re-quantizes the solve exactly
   * like a perspective one — so it is held still and only steps when the
   * coverage outgrows it, at the cost of up to one step of overdraw.
   */
  private setGroundOrthoProjection(
    camera: Camera,
    field: Camera,
    scale: number,
  ): void {
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.viewDirection.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const descent = Math.min(this.viewDirection.y, -FIELD_MIN_DESCENT);
    const centerDistance = Math.max(
      (this.groundHeight - this.cameraPosition.y) / descent,
      0.5,
    );
    // Corner rays that climb toward the horizon meet the ground arbitrarily
    // far away, or never; past this reach the ground is not worth resolving.
    const reach = FIELD_HORIZON_REACH * centerDistance;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let corner = 0; corner < 4; corner++) {
      const ray = this.frustumCorner
        .set(corner & 1 ? scale : -scale, corner & 2 ? scale : -scale, 0.5)
        .applyMatrix4(camera.projectionMatrixInverse)
        .applyMatrix4(camera.matrixWorld)
        .sub(this.cameraPosition);
      ray.divideScalar(ray.length() || 1);
      const distance =
        ray.y < -1e-4
          ? Math.min((this.groundHeight - this.cameraPosition.y) / ray.y, reach)
          : reach;
      const point = ray
        .multiplyScalar(distance)
        .add(this.cameraPosition)
        .applyMatrix4(field.matrixWorldInverse);
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    // One quantized extent drives both axes; the field is square, so this is
    // also what keeps its texels square.
    const halfY = quantizeFieldScale(
      Math.max((maxY - minY) / 2, (maxX - minX) / 2, 1e-3),
    );
    const halfX = halfY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    // The flattened scene sits on the ground plane, whose corners bracket the
    // depth range. The quantized box reaches past them, and the plane recedes as
    // it does, so the margin has to cover that overshoot too — the squash keeps
    // every real height difference at a hundredth of its size, which even a
    // generously wide range resolves.
    const margin = halfX + halfY;
    // The mirrored path inherits the view camera's clip conventions with its
    // projection matrix; a hand-built one has to be told. Matrix4 defaults to
    // WebGL's z range, which under WebGPU throws away half the depth range —
    // most of the scene clips out of the field and stops emitting entirely.
    field.projectionMatrix.makeOrthographic(
      centerX - halfX,
      centerX + halfX,
      centerY + halfY,
      centerY - halfY,
      -maxZ - margin,
      -minZ + margin,
      this.renderer.coordinateSystem,
      this.renderer.reversedDepthBuffer,
    );
  }

  /**
   * Offsets the guard-band projection by the sub-texel amount that puts the
   * world anchor on an exact texel center, the shadow-map stabilization
   * trick generalized to a post-projection translation. Rasterization and
   * the world-anchored probe lattice then keep a constant sub-texel phase
   * at the anchor's depth while the camera translates, instead of
   * re-quantizing every silhouette each field update.
   *
   * The snap is to a multiple of the floor pyramid's downsample factor, not to
   * a single texel. A one-texel shift moves the field content by a quarter of a
   * floor texel, which re-straddles every 4x4 downsample box: near a height
   * discontinuity the floor estimate then wobbles by a fraction of the step the
   * occluder mask thresholds against, and every silhouette in the scene
   * shimmers as the camera translates.
   */
  private snapProjectionToAnchor(field: Camera): void {
    this.snapViewProjection.multiplyMatrices(
      field.projectionMatrix,
      field.matrixWorldInverse,
    );
    const e = this.snapViewProjection.elements;
    const w = e[7]! * this.groundHeight + e[15]!;
    if (w <= 1e-4) return;
    this.anchorPoint
      .set(0, this.groundHeight, 0)
      .applyMatrix4(this.snapViewProjection);
    const px = (0.5 + 0.5 * this.anchorPoint.x) * this.rc.size;
    const py = (0.5 - 0.5 * this.anchorPoint.y) * this.rc.size;
    const grid = FLOOR_LEVEL_SCALE;
    const snappedX = grid * Math.round(px / grid);
    const snappedY = grid * Math.round(py / grid);
    this.snapMatrix.makeTranslation(
      (2 * (snappedX - px)) / this.rc.size,
      (-2 * (snappedY - py)) / this.rc.size,
      0,
    );
    field.projectionMatrix.premultiply(this.snapMatrix);
  }

  /**
   * World size of one field texel, used to scale the surface normal offset, the
   * floor radius, and the depth test slack. Under the parallel projection of
   * `footprint` domain this is exact and uniform over the whole field; a
   * perspective field only has one such size, at the ground point the camera
   * looks at, and everything nearer or farther is off by its depth ratio.
   */
  private fieldTexelWorldSize(camera: Camera): number {
    const field = this.fieldCamera.projectionMatrix.elements;
    if (field[15] !== 0) {
      return 2 / field[5]! / this.rc.size;
    }
    const projScaleY = field[5]!;
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.viewDirection.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const descent = Math.min(this.viewDirection.y, -FIELD_MIN_DESCENT);
    const distance = Math.max(
      (this.groundHeight - this.cameraPosition.y) / descent,
      0.5,
    );
    return (2 * distance) / projScaleY / this.rc.size;
  }

  private resizeViewGBuffer(outputTarget: RenderTarget | null): void {
    if (outputTarget) {
      this.drawingBufferSize.set(outputTarget.width, outputTarget.height);
    } else {
      this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    }
    // setSize only reallocates when the size actually changed, so both targets
    // can be told every frame — which also sizes the resolve target the first
    // time, without depending on the constructor having guessed it.
    this.viewGBuffer.setSize(
      this.drawingBufferSize.x,
      this.drawingBufferSize.y,
    );
    this.resolveTarget?.setSize(
      this.drawingBufferSize.x,
      this.drawingBufferSize.y,
    );
  }
}
