import {
  Color,
  FloatType,
  HalfFloatType,
  LinearFilter,
  MeshBasicNodeMaterial,
  NearestFilter,
  QuadMesh,
  RGBAFormat,
  RedFormat,
  RGFormat,
  RenderTarget,
  Vector3,
  type ColorRepresentation,
  type Node,
  type Texture,
  type TextureDataType,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  If,
  atan,
  ceil,
  clamp,
  exp2,
  float,
  floor,
  max,
  mix,
  mod,
  outputStruct,
  screenUV,
  select,
  texture,
  textureLevel,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

export interface FieldSpaceRCOptions {
  /**
   * Field extent in pixels. The solve is square and its cascade layout halves
   * the plane count per level, so this must be a power of two.
   */
  size: number;
  /**
   * 2D field volume, sampled by normalized UV (any resolution).
   * rgb = the texel's emissivity, a = its absorption density in [0, 1]
   * (0 = empty space light travels through, 1 = fully opaque). There is no
   * emitter/occluder distinction: every absorbing texel occludes in
   * proportion to its density, and its emissivity is the light it adds.
   * A texel only emits what it also absorbs, so emitters must be solid.
   */
  emission: Texture;
  /**
   * Optical depth of a fully dense texel over one texel of path, in exp2
   * units: transmittance is `exp2(-a * absorption)`. 8 leaves 0.4% of the
   * light through a single solid texel. Default 8.
   */
  absorption?: number;
  /** Radiance for rays that leave the field. Default black. */
  sky?: ColorRepresentation;
}

// Preserve any fractional coverage supplied by a custom emission texture.
const SOLID_THRESHOLD = 0.05;
const FILL_BLUR_RADIUS = 4;
const FILL_BLUR_TAPS = FILL_BLUR_RADIUS * 2 + 1;
// Texel corners, as offsets in texels. Four bilinear taps there average to the
// separable [1, 2, 1] / 4 tent — see `tentAt`.
const TENT_CORNERS = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [-0.5, 0.5],
  [0.5, 0.5],
] as const;
// JFA seed sentinel: real seeds are texel centers, so any negative x is "none".
const NO_SEED = -1;
// A frustum spans 90 degrees, so the fluence of one is (pi/2)·L and the four
// together are 2pi·L for a uniform field radiance L. Dividing by that
// normalizes the sum back to plain radiance.
const FLUENCE_SCALE = 1 / (2 * Math.PI);
// Frustums per stacked target — one per axis direction. See `slabH`.
const SLABS = 4;
// Largest jump the flood starts from, which caps the distance field's reach at
// 2·JFA_MAX_JUMP - 1 texels and drops every pass above it — three of nine at
// size 512. Nothing reads further: the fill chain fades out by 10 texels, and
// the exposed texture is a near-field silhouette distance callers place surface
// samples with. Beyond the reach a texel simply finds no seed and reports the
// same "far away" sentinel an unseeded texel always has.
const JFA_MAX_JUMP = 32;
// Seed coordinates are texel centers, so they are half-integers below the field
// extent — exactly representable as half floats while the extent stays at or
// under this, where a half's ulp is still 0.5. Larger fields keep full floats.
const HALF_FLOAT_EXACT_EXTENT = 1024;

function passMaterial(node: Node): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.fragmentNode = node;
  m.depthTest = false;
  m.depthWrite = false;
  // NodeMaterial forwards an `outputStruct` fragment node to the backend
  // untouched only if nothing wraps it, and fog is the one thing that would.
  m.fog = false;
  return m;
}

/**
 * Texture-space Holographic Radiance Cascades (Kekhal et al. 2025) on WebGPU,
 * after Yaazarai's reference implementation. The caller defines what the 2D
 * field represents; {@link ScreenSpaceRC} supplies a camera-following
 * guard-band G-buffer.
 *
 * HRC replaces vanilla RC's probe lattice with four 90-degree *frustums*, one
 * per axis direction. Within a frustum, probes are planes perpendicular to the
 * frustum axis: cascade n has planes every 2^n texels and 2^n + 1 rays per
 * probe, so probe count halves and ray count doubles exactly as in vanilla RC —
 * but the rays are never traced. Cascade n's rays are *extensions*: each is
 * built from two cascade n-1 rays chained across two planes with their indices
 * flipped so they converge on the extended direction. Every ray therefore costs
 * O(1) and carries log2(size) samples of angular diffusion, which is what makes
 * the result stable under moving lights where a marched ray aliases.
 *
 * Merging is likewise not vanilla RC's. Cascade n's 2^n + 1 rays bound 2^n
 * cones, and each cone's fluence is its two bounding rays — weighted by half
 * the cone's angular span — merged with the two cascade n+1 cones that begin at
 * their endpoints. Odd planes land exactly on a cascade n+1 plane; even planes
 * do not, so their rays are extended to double length, merged against the far
 * plane, and interpolated against the near plane's already-merged fluence.
 * Interpolating *fluence* rather than position is what keeps volumetrics
 * correct.
 *
 * Pipeline: seed cascade 0 from the field volume → extend rays up the cascades
 * → merge cones back down, cascade 0 being per-texel fluence. All four frustums
 * ride through that in one set of passes, stacked along y (see `slabH`). Then:
 * sum the frustums → JFA distance field → push-pull inpaint of absorbing texels
 * → composite → smoothing. Radiance and its irradiance vector share every pass
 * of that tail as two MRT attachments.
 */
export class FieldSpaceRC {
  readonly size: number;
  readonly cascadeCount: number;

  private readonly renderer: WebGPURenderer;
  private readonly quad = new QuadMesh();

  private readonly jfaRT: [RenderTarget, RenderTarget];
  private readonly distRT: RenderTarget;
  // Ray extensions: cascade n's rays, (size + size/2^n) x 4·size. Every level
  // is live at once because the merge walks back down and needs each level's
  // rays.
  private readonly vrayRT: RenderTarget[];
  // Merged cones, size x 4·size at every cascade, so two ping-pong targets
  // cover the whole downward walk.
  private readonly mergeRT: [RenderTarget, RenderTarget];
  // Two attachments throughout the tail: 0 = fluence (rgb) or the pyramid's
  // mask-premultiplied fluence, 1 = the flatland irradiance vector.
  private readonly fluenceRT: RenderTarget;
  private readonly lightRawRT: RenderTarget;
  private readonly lightBlurRT: RenderTarget;
  private readonly lightRT: RenderTarget;
  // Inpaint pyramid (push–pull): pyrRT attachment 0 holds mask-premultiplied
  // fluence (its alpha is the validity weight), attachment 1 holds
  // (dir.xy·w, w, 0). pyrFillRT holds the resolved, hole-filled values.
  private readonly pyrRT: RenderTarget[];
  private readonly pyrFillRT: RenderTarget[];

  private readonly raySeedMat: MeshBasicNodeMaterial;
  private readonly extendMats: MeshBasicNodeMaterial[];
  private readonly mergeMats: MeshBasicNodeMaterial[];
  private readonly fluenceMat: MeshBasicNodeMaterial;

  private readonly seedMat: MeshBasicNodeMaterial;
  private readonly floodMats: [
    { mat: MeshBasicNodeMaterial; uJump: { value: number } },
    { mat: MeshBasicNodeMaterial; uJump: { value: number } },
  ];
  private readonly jumps: number[];
  private readonly distMat: MeshBasicNodeMaterial;
  private readonly compositeMat: MeshBasicNodeMaterial;
  private readonly pyrBaseMat: MeshBasicNodeMaterial;
  private readonly pyrDownMats: MeshBasicNodeMaterial[];
  private readonly pyrUpMats: MeshBasicNodeMaterial[];
  private readonly blurMat: MeshBasicNodeMaterial;
  private readonly fillMat: MeshBasicNodeMaterial;

  private readonly prevClearColor = new Color();

  constructor(renderer: WebGPURenderer, options: FieldSpaceRCOptions) {
    this.renderer = renderer;
    const S = (this.size = options.size);
    const emissionTex = options.emission;
    const absorb = options.absorption ?? 8;

    const N = Math.log2(S);
    if (!Number.isInteger(N) || N < 2) {
      throw new Error(`FieldSpaceRC: size ${S} must be a power of two >= 4`);
    }
    // Cascade N-1's planes are size/2 apart, which already spans the field.
    this.cascadeCount = N;

    const makeRT = (
      type: TextureDataType,
      filter: typeof NearestFilter | typeof LinearFilter,
      format: typeof RGBAFormat | typeof RGFormat | typeof RedFormat = RGBAFormat,
      w = S,
      h = S,
      count = 1,
    ) => {
      const rt = new RenderTarget(w, h, { depthBuffer: false, type, format, count });
      for (const tex of rt.textures) {
        tex.minFilter = filter;
        tex.magFilter = filter;
        tex.generateMipmaps = false;
      }
      return rt;
    };

    // Seed coordinates only: two channels, and a negative x marks "no seed"
    // (real seeds are texel centers in [0, S]), which frees the alpha channel
    // the validity flag used to occupy. The flood reads 9 taps of this target
    // on each of its passes, so halving its footprint is the cheapest bandwidth
    // there is to buy — and half floats halve it again, exactly, because every
    // value the target ever holds is a texel center or the sentinel.
    const seedType = S <= HALF_FLOAT_EXACT_EXTENT ? HalfFloatType : FloatType;
    this.jfaRT = [
      makeRT(seedType, NearestFilter, RGFormat),
      makeRT(seedType, NearestFilter, RGFormat),
    ];
    this.distRT = makeRT(HalfFloatType, LinearFilter, RedFormat);

    // All four frustums live in one target apiece, stacked along y: frustum j
    // owns rows [j·S, (j+1)·S). One pass then solves all four, which is the
    // same fragment work in a quarter of the render passes. That matters
    // because three.js submits one command buffer per `render()` call, and the
    // solve is per-pass-overhead bound long before it is fragment bound: at
    // size 256 it costs the same wall time whether the output is 1080p or 4K.
    // The cost is memory — the ray pyramid is four times as large — which is
    // why the frustum axis is stacked rather than the cascades.
    const slabH = S * SLABS;

    // Absorption here is a scalar, so a ray's whole state — gathered radiance
    // and surviving transmittance — fits one RGBA texel. That halves both the
    // ray pyramid's footprint and its bandwidth against the reference's
    // separate radiance/transmittance attachments.
    //
    // Cascade 0 is the one level that stores fewer entries than it has rays.
    // Its interval is a single texel, so a probe's two rays are both the
    // probe's own texel and the seed would write the same value into both
    // columns; one column per plane holds the same information at half the
    // footprint, half the seed pass, and a denser read for the two passes that
    // consume it. Both of them ask for ray 0 there (see `rayEntry`).
    const raysStored = (n: number) => (n === 0 ? 1 : (1 << n) + 1);
    const rayWidth = (n: number) => (S >> n) * raysStored(n);
    /** Column of ray `index` within its plane's block, at cascade `n`. */
    const rayEntry = (n: number, index: Node<'float'>): Node<'float'> =>
      n === 0 ? float(0) : index;
    this.vrayRT = Array.from({ length: N }, (_, n) =>
      makeRT(HalfFloatType, NearestFilter, RGBAFormat, rayWidth(n), slabH),
    );
    // Cascade 0's merge lands in mergeRT[0]: walking down writes the odd
    // cascades to slot 1 and the even ones to slot 0, so slot 0 is free by then
    // and the sum pass can read the cones straight out of it. A third target of
    // its own would only hold a copy.
    this.mergeRT = [
      makeRT(HalfFloatType, NearestFilter, RGBAFormat, S, slabH),
      makeRT(HalfFloatType, NearestFilter, RGBAFormat, S, slabH),
    ];

    // The tail carries radiance and the flatland irradiance vector through an
    // identical chain of passes, so they ride as two attachments of one target:
    // half the passes, and the mask/distance/emission reads each pass needs are
    // paid once instead of twice.
    this.fluenceRT = makeRT(HalfFloatType, LinearFilter, RGBAFormat, S, S, 2);
    this.lightRawRT = makeRT(HalfFloatType, LinearFilter, RGBAFormat, S, S, 2);
    this.lightBlurRT = makeRT(HalfFloatType, LinearFilter, RGBAFormat, S, S, 2);
    this.lightRT = makeRT(HalfFloatType, LinearFilter, RGBAFormat, S, S, 2);
    // Inpaint pyramid levels: base is the light grid, halving until the
    // coarsest level is a handful of texels — wide enough that any solid
    // interior, however deep, resolves to a weighted average of open fluence.
    const pyrSizes: [number, number][] = [];
    for (let p = S; ; p = Math.ceil(p / 2)) {
      pyrSizes.push([p, p]);
      if (p <= 8) break;
    }
    const makePyr = () =>
      pyrSizes.map(([pw, ph]) =>
        makeRT(HalfFloatType, LinearFilter, RGBAFormat, pw, ph, 2),
      );
    this.pyrRT = makePyr();
    this.pyrFillRT = makePyr();

    const skyColor = new Color(options.sky ?? 0x000000);
    const uSky = uniform(new Vector3(skyColor.r, skyColor.g, skyColor.b));

    const res = vec2(S, S);

    // --- HRC core.

    // Chain two segments of one ray: the near one's surviving transmittance is
    // what the far one's radiance arrives through. Also merges a ray into the
    // cone that starts at its endpoint, which is the same operation.
    const chain = (near: Node<'vec4'>, far: Node<'vec4'>): Node<'vec4'> =>
      vec4(near.rgb.add(far.rgb.mul(near.a)), near.a.mul(far.a));

    /**
     * Reads the entry of `tex` belonging to ray/cone `index` of the plane that
     * contains `probe`, within frustum slab `slab`. Planes are `interval`
     * texels apart and each occupies `lookupWidth` columns; `probe.y` is the
     * row *within* the slab. Anything off the frustum's own S x S region has
     * left the field and reads as `outside`.
     */
    const volumeAt = (
      tex: Texture,
      texWidth: number,
      probe: Node<'vec2'>,
      slab: Node<'float'>,
      index: Node<'float'>,
      interval: number,
      lookupWidth: number,
      // A ray that left the field carries no radiance and is fully
      // transmitting; a cone that left carries none over its whole angular
      // span, which is what its alpha measures. `null` marks a lookup the
      // layout puts in-field for every fragment of the pass, so the bounds
      // test is a constant the shader need not carry — that is the case for
      // roughly a third of the taps in the solve.
      outside: Node<'vec4'> | null = vec4(0, 0, 0, 1),
    ): Node<'vec4'> => {
      const col = floor(probe.x.div(interval)).mul(lookupWidth).add(0.5).add(index);
      const uv = vec2(col.div(texWidth), probe.y.add(slab.mul(S)).div(slabH));
      const sample = textureLevel(tex, uv, float(0));
      if (outside === null) return sample;
      // The row bound is the slab's, not the texture's: a ray leaving the top
      // of its own frustum must read as gone, never as the frustum stacked
      // above it.
      const inside = col
        .greaterThanEqual(0)
        .and(col.lessThan(texWidth))
        .and(probe.y.greaterThanEqual(0))
        .and(probe.y.lessThan(S));
      return select(inside, sample, outside);
    };

    // Each frustum traces toward +x in its own memory space; the scene is read
    // through the rotation that puts the frustum's world direction there.
    // Directions, in field UV space with +y down: +x, -y, -x, +y.
    const rotateUv = (uv: Node<'vec2'>, j: number): Node<'vec2'> => {
      if (j === 1) return vec2(1, 1).sub(uv.yx);
      if (j === 2) return vec2(1, 1).sub(uv);
      if (j === 3) return uv.yx;
      return uv;
    };
    const FRUSTUM_DIR: [number, number][] = [
      [1, 0],
      [0, -1],
      [-1, 0],
      [0, 1],
    ];

    // Slab index of the row being shaded, and the row within that slab.
    const slabOf = (texelY: Node<'float'>) => {
      const slab = floor(texelY.div(S));
      return { slab, row: texelY.sub(slab.mul(S)) };
    };

    // --- Cascade 0 seed. Its interval is one texel, so there is nothing to
    // trace: both of a probe's rays are the emission and transmittance of the
    // probe's own texel. The frustum rotation is the only thing that differs
    // per slab, and it is two transposes/complements rather than four shaders.
    this.raySeedMat = passMaterial(
      Fn(() => {
        const texel = screenUV.mul(vec2(rayWidth(0), slabH));
        const { slab, row } = slabOf(texel.y);
        const plane = floor(texel.x);
        const probe = vec2(plane.add(0.5), row).div(res);
        // `rotateUv`, selected by slab: frustums 1 and 3 transpose, and 1 and 2
        // complement. Compared as ranges rather than equalities so nothing
        // rides on the exactness of a float compare.
        const transposed = mod(slab, 2).greaterThan(0.5);
        const complemented = slab.greaterThan(0.5).and(slab.lessThan(2.5));
        const swapped = select(transposed, probe.yx, probe);
        const rot = select(complemented, vec2(1, 1).sub(swapped), swapped);
        const cell = textureLevel(emissionTex, rot, float(0));
        const transmit = exp2(cell.a.mul(-absorb));
        return vec4(cell.rgb.mul(float(1).sub(transmit)), transmit);
      })(),
    );

    // --- Ray extensions. Cascade n's ray `index` is the average of two chains
    // built from cascade n-1 rays: (lower then upper) and (upper then lower),
    // where lower/upper are the n-1 directions bracketing this one. Swapping
    // the indices across the two planes makes the pair diverge and reconverge
    // on the extended direction; averaging them lands on it. Even indices have
    // lower == upper and the two chains coincide, which is the exact case.
    this.extendMats = Array.from({ length: N }, (_, n) => {
      if (n === 0) return null as unknown as MeshBasicNodeMaterial;
      const intrv = 1 << n;
      const rays = raysStored(n);
      const pIntrv = intrv / 2;
      const pRays = raysStored(n - 1);
      const prev = this.vrayRT[n - 1]!.texture;
      const prevW = rayWidth(n - 1);
      return passMaterial(
        Fn(() => {
          const texel = screenUV.mul(vec2(rayWidth(n), slabH));
          const { slab, row } = slabOf(texel.y);
          const plane = floor(texel.x.div(rays));
          const index = floor(texel.x.sub(plane.mul(rays)));
          const probe = vec2(plane.mul(intrv).add(0.5), row);
          const lower = floor(index.mul(0.5));
          const upper = ceil(index.mul(0.5));
          const extend = (lo: Node<'float'>, hi: Node<'float'>) => {
            const far = vec2(
              probe.x.add(pIntrv),
              probe.y.add(lo.mul(2).sub(pIntrv)),
            );
            const near = rayEntry(n - 1, lo);
            const away = rayEntry(n - 1, hi);
            return chain(
              // The near half starts at this plane, always inside the field.
              volumeAt(prev, prevW, probe, slab, near, pIntrv, pRays, null),
              volumeAt(prev, prevW, far, slab, away, pIntrv, pRays),
            );
          };
          const result = vec4(0).toVar();
          // Plane 0 is dead at every cascade: the only readers of a plane 0 ray
          // are plane 0 of the next extension and plane 0 of this cascade's
          // merge, and merge discards plane 0 because its rays start outside
          // the field. So nothing downstream ever observes it, and it is a
          // whole plane's block of columns — 11% of the extension work overall,
          // half of the top cascade's — that need not be traced.
          If(plane.greaterThanEqual(1), () => {
            result.assign(mix(extend(lower, upper), extend(upper, lower), 0.5));
          });
          return result;
        })(),
      );
    });

    // --- Cone merging, walked from the top cascade down. Cascade n's cone
    // `index` of a plane is bounded by rays `index` and `index + 1`; each of
    // those, weighted by half the cone's angular span, is chained with the
    // cascade n+1 cone that begins at its endpoint.
    this.mergeMats = Array.from({ length: N }, (_, n) => {
      const intrv = 1 << n;
      const rays = raysStored(n);
      const vray = this.vrayRT[n]!.texture;
      const vrayW = rayWidth(n);
      // Cascade n+1's cones, which are always a full size x size grid per
      // frustum. The top cascade has none: its interval is half the field, so
      // it holds exactly two planes — plane 0 has no cone at all (see below)
      // and plane 1 is odd, reaching one interval to a tip a full field width
      // past the end. Every coarse lookup it could make is therefore outside,
      // so the top pass is built from `beyond` alone: no taps into a target
      // that has not been written this frame, and no doubled ray either.
      const top = n === N - 1;
      const coarse = this.mergeRT[((n + 1) % 2) as 0 | 1].texture;
      // Whether a plane sits on a cascade n+1 plane is fixed per plane, and a
      // plane spans `intrv` texels — so from cascade 2 up the two cases are
      // coherent across whole tiles of the pass and splitting them is a real
      // saving: an odd plane reads neither the doubled ray nor the near cone,
      // which is half of the taps. Below that a plane is one or two texels wide
      // and the branch would just diverge, so those cascades keep selecting
      // between both sides instead.
      const branched = !top && intrv >= 4;

      // `even` is a JS constant wherever the case is decided outside the shader
      // — on the branched path, which generates each side separately, and at
      // the top cascade, whose only live plane is odd. Otherwise it is a node
      // and both sides are selected between.
      const coneFor = (
        side: number,
        index: Node<'float'>,
        probe: Node<'vec2'>,
        slab: Node<'float'>,
        even: Node<'bool'> | boolean,
      ) => {
        const coneI = index.mul(2).add(side);
        const rayI = index.add(side);
        // Ray direction, as a rise over one interval of run.
        const rise = rayI.mul(2).sub(intrv);
        // Angular span of cascade n+1's cone `coneI`, whose near interval
        // this ray stands in for. Its run is 2·intrv, so the edge angles
        // are atan of the edge rises over that. The ray bounds the outer
        // edge of that half, so weighting it by the whole half and summing
        // the two sides is the trapezoid rule over this cone's rays —
        // every interior ray ends up carrying half the span on each side
        // of it, and the two frustum-edge rays are completed by the
        // neighbouring frustum, which shares them.
        const spanL = coneI.mul(2).sub(2 * intrv);
        const spanR = coneI.add(1).mul(2).sub(2 * intrv);
        const weight = atan(spanR.div(2 * intrv)).sub(
          atan(spanL.div(2 * intrv)),
        );
        // A cone's alpha is its angular integral of transmittance, not a
        // scalar transmittance: the span is folded in here, so a cone that
        // ran off the field reports its full span as open. That is what
        // lets the sum pass fill exactly the unterminated solid angle with
        // sky, at any cascade.
        const beyond = vec4(0, 0, 0, weight);
        const entry = rayEntry(n, rayI);

        // Odd planes sit exactly on a cascade n+1 plane one interval ahead;
        // even planes fall halfway between two, so they reach twice as far
        // and interpolate the two merged fluences.
        // The near ray starts at this plane and this row, so it is in-field for
        // every fragment of the pass.
        const nearRay = volumeAt(vray, vrayW, probe, slab, entry, intrv, rays, null);
        const doubled = () => {
          const nextPlane = vec2(probe.x.add(intrv), probe.y.add(rise));
          return chain(
            nearRay,
            volumeAt(vray, vrayW, nextPlane, slab, entry, intrv, rays),
          );
        };
        const ray =
          even === true
            ? doubled()
            : even === false
              ? nearRay
              : select(even, doubled(), nearRay);
        const weighted = vec4(ray.rgb.mul(weight), ray.a);
        // Nothing of cascade n+1 is in reach at the top, so the cone ends in
        // open sky over its whole span.
        if (top) return chain(weighted, beyond);

        const reach =
          even === true
            ? float(2)
            : even === false
              ? float(1)
              : select(even, float(2), float(1));
        const tip = vec2(
          probe.x.add(reach.mul(intrv)),
          probe.y.add(reach.mul(rise)),
        );
        const merged = chain(
          weighted,
          volumeAt(coarse, S, tip, slab, coneI, 1, 1, beyond),
        );
        if (even === false) return merged;
        // Even planes only: the same cone at the *near* cascade n+1 plane,
        // which is this plane. Fluence, not position, is what interpolates.
        // An even plane sits on a cascade n+1 plane and this cone's index is
        // within that plane's block, so where the parity is settled outside the
        // shader the lookup is in-field by construction.
        const near = volumeAt(
          coarse,
          S,
          probe,
          slab,
          coneI,
          1,
          1,
          even === true ? null : beyond,
        );
        const interpolated = mix(merged, near, 0.5);
        return even === true ? interpolated : select(even, interpolated, merged);
      };

      return passMaterial(
        Fn(() => {
          const texel = screenUV.mul(vec2(S, slabH));
          const { slab, row } = slabOf(texel.y);
          const plane = floor(texel.x.div(intrv));
          const index = floor(texel.x.sub(plane.mul(intrv)));
          const probe = vec2(plane.mul(intrv).add(0.5), row);
          const sum = (even: Node<'bool'> | boolean) =>
            coneFor(0, index, probe, slab, even).add(
              coneFor(1, index, probe, slab, even),
            );

          if (!branched) {
            // The first plane's rays start outside the field, so it has no cone.
            return select(
              probe.x.lessThan(1),
              vec4(0),
              sum(top ? false : mod(plane, 2).lessThan(0.5)),
            );
          }
          const result = vec4(0).toVar();
          // Plane 0 keeps its zero, and is a whole interval wide here — the
          // widest coherent block of the pass, skipped outright.
          If(probe.x.greaterThanEqual(1), () => {
            If(mod(plane, 2).lessThan(0.5), () => {
              result.assign(sum(true));
            }).Else(() => {
              result.assign(sum(false));
            });
          });
          return result;
        })(),
      );
    });

    // --- Sum the four frustums. Each is stored in its own rotated memory
    // space, and neighbouring frustums share the ray direction on their common
    // edge, so each is read one texel *into* its own direction to keep that
    // shared ray from being counted twice.
    const frustumSamples = (): Node<'vec4'>[] =>
      FRUSTUM_DIR.map(([dx, dy], j) => {
        const uv = screenUV.add(vec2(dx / S, dy / S));
        // Every rotation is its own inverse, so the same one that mapped the
        // scene into this frustum's memory maps a scene UV back to its texel.
        const local = rotateUv(uv, j);
        // That one-texel offset can step outside the field, and clamp-to-edge
        // no longer covers it along y — the texel above slab j's first row
        // belongs to slab j-1. Clamping to the slab's own first/last texel
        // centers reproduces the clamp by hand. x needs no such care: a slab
        // spans the full texture width, so the hardware clamp is still right.
        const y = clamp(local.y, 0.5 / S, 1 - 0.5 / S);
        const f = textureLevel(
          this.mergeRT[0].texture,
          vec2(local.x, y.add(j).div(SLABS)),
          float(0),
        );
        // Alpha is the solid angle of this frustum that never terminated — it
        // saw the sky — already integrated over the cone, so it is exactly the
        // weight the sky enters with.
        return vec4(f.rgb.add(uSky.mul(f.a)), f.a);
      });
    // The four frustums already are a directional decomposition — each is one
    // 90-degree quadrant — so the flatland irradiance vector is just their
    // luminances against their axis directions. In field pixel space, +y down.
    // It comes out of the same pass as the fluence, off the same four taps.
    //
    // Desaturated by cos(45 degrees). A quadrant's whole light collapses onto
    // its axis here, so a lamp beside an axis-aligned wall drives the anisotropy
    // to a full unit vector along that axis — and consumers turn the anisotropy
    // against a surface normal (flatland N·L), where a wall's normal is that
    // same axis negated: an exact -1, an exact zero, a black ring on the wall
    // around every lamp standing close to it. The frustums this replaced were
    // centred on the diagonals, so an axis-aligned normal was never nearer than
    // 45 degrees to a bin and the term bottomed out at 0.146 instead. That floor
    // was the old geometry's, not a choice, and the scale puts it back.
    // ponytail: one scalar, because the reception model is the crude part and
    // fixing that means cosine-weighting the frustums per surface. Revisit if
    // walls need directional reception sharper than a quadrant can resolve.
    const MOMENT_SCALE = Math.SQRT1_2;
    this.fluenceMat = passMaterial(
      (() => {
        const samples = frustumSamples();
        let sum: Node<'vec3'> = vec3(0);
        let moment: Node<'vec2'> = vec2(0);
        samples.forEach((f, j) => {
          const [dx, dy] = FRUSTUM_DIR[j]!;
          sum = sum.add(f.rgb);
          moment = moment.add(vec2(dx, dy).mul(f.rgb.dot(vec3(1 / 3))));
        });
        return outputStruct(
          vec4(sum.mul(FLUENCE_SCALE), 1),
          vec4(moment.mul(FLUENCE_SCALE * MOMENT_SCALE), 0, 1),
        );
      })(),
    );

    // --- JFA distance field. The solve itself no longer marches, but the fill
    // chain still needs to know how far a texel is from the nearest solid, and
    // callers read it back to place surface samples off a silhouette.
    //
    // A lone rasterized boundary texel must not become a seed: when a rotating
    // silhouette toggles that texel, its nearest-seed region can redirect the
    // fill of a whole face. A one-texel cross erosion removes those unstable
    // boundary samples. Emissive pixels bypass it so narrow lights still seed.
    const stableSolidAt = (uv: Node<'vec2'>): Node<'bool'> => {
      let support: Node<'float'> = float(0);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > 1) continue;
          const alpha = textureLevel(
            emissionTex,
            uv.add(vec2(dx, dy).div(res)),
            float(0),
          ).a;
          support = support.add(
            select(alpha.greaterThan(SOLID_THRESHOLD), float(1), float(0)),
          );
        }
      }
      return support.greaterThanEqual(5);
    };

    this.seedMat = passMaterial(
      Fn(() => {
        const sample = textureLevel(emissionTex, screenUV, float(0));
        const emissive = max(sample.r, max(sample.g, sample.b)).greaterThan(1e-4);
        return select(
          stableSolidAt(screenUV).or(emissive),
          vec4(screenUV.mul(res), 0, 1),
          vec4(NO_SEED, NO_SEED, 0, 0),
        );
      })(),
    );

    const makeFlood = (src: RenderTarget, resolution: Node<'vec2'>) => {
      const uJump = uniform(1);
      const node = Fn(() => {
        const texel = screenUV.mul(resolution).toVar();
        const best = vec2(NO_SEED, NO_SEED).toVar();
        // Compared squared: the nearest seed by distance is the nearest by
        // squared distance, and this drops 9 sqrt per texel per flood pass.
        const bestDist = float(1e20).toVar();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sampleUv = screenUV.add(vec2(dx, dy).mul(uJump).div(resolution));
            const s = textureLevel(src.texture, sampleUv, float(0)).xy;
            const delta = s.sub(texel);
            const d = delta.dot(delta);
            If(s.x.greaterThanEqual(0).and(d.lessThan(bestDist)), () => {
              bestDist.assign(d);
              best.assign(s);
            });
          }
        }
        return vec4(best, 0, 1);
      })();
      return { mat: passMaterial(node), uJump };
    };
    this.floodMats = [makeFlood(this.jfaRT[0], res), makeFlood(this.jfaRT[1], res)];
    this.jumps = [];
    const firstJump = Math.min(1 << Math.ceil(Math.log2(S) - 1), JFA_MAX_JUMP);
    for (let j = firstJump; j >= 1; j >>= 1) {
      this.jumps.push(j);
    }
    const finalJfa = this.jfaRT[this.jumps.length % 2]!;

    // Distance in texels, with sub-texel boundary refinement: JFA alone
    // measures to seed texel CENTERS, so the iso-contour is the staircase of
    // the binary mask. The seed's coverage alpha says where the true edge sits
    // inside the seed texel, and offsetting by (coverage − 0.5) turns the
    // staircase into a contour that tracks the silhouette continuously.
    this.distMat = passMaterial(
      (() => {
        const s = textureLevel(finalJfa.texture, screenUV, float(0)).xy;
        const d = s.sub(screenUV.mul(res)).length();
        const cov = clamp(textureLevel(emissionTex, s.div(res), float(0)).a, 0, 1);
        const dAdj = d.sub(cov.sub(0.5));
        return vec4(select(s.x.greaterThanEqual(0), dAdj, float(1e4)), 0, 0, 1);
      })(),
    );

    // --- Solid inpaint pyramid (push–pull). Fluence inside an absorbing mass
    // is meaningless (nothing reaches it), so solid texels must be filled from
    // open ones. Copying the single NEAREST open texel (Voronoi dilation) is
    // discontinuous in both space and time: which boundary texel wins draws
    // hard streak bands across large faces, and the winner flips as
    // silhouettes move. Instead, inpaint: push the open-masked fluence down a
    // weighted mip pyramid, then pull back up filling holes from the coarser
    // level. Every solid texel resolves to a distance-weighted average of ALL
    // nearby open fluence — smooth across faces of any size, and bilinear
    // weights change continuously under sub-texel motion.
    const openAt = (uv: Node<'vec2'>): Node<'float'> =>
      select(
        textureLevel(emissionTex, uv, float(0)).a.greaterThan(SOLID_THRESHOLD),
        float(0),
        float(1),
      );
    // Open texels weigh in proportionally to (1 + luminance·k): a flat
    // average would let large dim floors drown out a small bright pool and
    // its wall glow with it; luminance weighting acts as a soft max, so the
    // fill tracks the pools a surface actually faces while staying a
    // continuous (band-free, motion-stable) average.
    const LUM_WEIGHT = 8;
    this.pyrBaseMat = passMaterial(
      (() => {
        const f = textureLevel(this.fluenceRT.textures[0]!, screenUV, float(0));
        const d = textureLevel(this.fluenceRT.textures[1]!, screenUV, float(0));
        const lum = f.rgb.dot(vec3(1 / 3));
        const w = openAt(screenUV).mul(lum.mul(LUM_WEIGHT).add(1));
        // Attachment 0's alpha carries the weight for free: the fluence's own
        // alpha is 1, so `f · w` already stores it. Attachment 1 keeps its own
        // copy in z, which is what the pull reads.
        return outputStruct(f.mul(w), vec4(d.xy.mul(w), w, 0));
      })(),
    );
    // Push: with exact power-of-two level sizes one bilinear tap at the
    // texel center is precisely the 2×2 average of the finer level.
    // Premultiplied values and weights average through the same tap, which
    // keeps the weighted mean exact after the final division.
    const buildDown = (src: RenderTarget) =>
      passMaterial(
        outputStruct(
          textureLevel(src.textures[0]!, screenUV, float(0)),
          textureLevel(src.textures[1]!, screenUV, float(0)),
        ),
      );
    const L = pyrSizes.length;
    this.pyrDownMats = [];
    for (let k = 1; k < L; k++) {
      this.pyrDownMats.push(buildDown(this.pyrRT[k - 1]!));
    }
    // Pull: where this level has coverage keep its own resolved value; where
    // it has none take the already-filled coarser level; partial coverage
    // blends — no seams at coverage transitions. Coverage saturates at 1/4
    // (one open texel in a 2×2 block is a full local estimate): without the
    // boost, solid texels one step from a boundary would already be mostly
    // coarse-level average and lights would barely glow onto their walls.
    const coverage = (w: Node<'float'>): Node<'float'> => clamp(w.mul(4), 0, 1);
    this.pyrUpMats = [];
    for (let k = 0; k < L; k++) {
      const fine = this.pyrRT[k]!;
      const p = textureLevel(fine.textures[0]!, screenUV, float(0));
      const pd = textureLevel(fine.textures[1]!, screenUV, float(0));
      const w = pd.z;
      const own = p.div(max(w, 1e-4));
      const ownDir = vec4(pd.xy.div(max(w, 1e-4)), 0, 1);
      if (k === L - 1) {
        this.pyrUpMats.push(passMaterial(outputStruct(own, ownDir)));
        continue;
      }
      const coarse = this.pyrFillRT[k + 1]!;
      this.pyrUpMats.push(
        passMaterial(
          outputStruct(
            mix(textureLevel(coarse.textures[0]!, screenUV, float(0)), own, coverage(w)),
            mix(textureLevel(coarse.textures[1]!, screenUV, float(0)), ownDir, coverage(w)),
          ),
        ),
      );
    }

    // --- Composite: open texels read their own fluence exactly; solid
    // texels read the inpainted pyramid.
    this.compositeMat = passMaterial(
      (() => {
        const solid = textureLevel(emissionTex, screenUV, float(0)).a
          .greaterThan(SOLID_THRESHOLD);
        const pick = (src: Texture, fill: Texture) =>
          select(
            solid,
            textureLevel(fill, screenUV, float(0)),
            textureLevel(src, screenUV, float(0)),
          );
        const fill0 = this.pyrFillRT[0]!;
        return outputStruct(
          pick(this.fluenceRT.textures[0]!, fill0.textures[0]!),
          pick(this.fluenceRT.textures[1]!, fill0.textures[1]!),
        );
      })(),
    );

    // --- The lattice's own Nyquist, cancelled. A ray extension steps one texel
    // across the rows for every texel it advances along its frustum axis, so
    // light travels on two interleaved parity sublattices that never fully mix:
    // a texel whose row and column parities agree with the arriving transport
    // reads high, its neighbour reads low, and open field texels come out with a
    // one-texel checkerboard about 50% either side of the true fluence. It is
    // the *only* spurious frequency the solve produces — every other component
    // matches a direct angular integration — so a filter with a zero exactly at
    // Nyquist removes it without touching the light.
    //
    // Averaging the four bilinear taps at a texel's corners is precisely the
    // separable [1, 2, 1] / 4 tent, whose transfer function is zero at Nyquist
    // on both axes: the checkerboard is cancelled rather than attenuated, at the
    // cost of one texel of blur and three extra taps. The box filter below is
    // not a substitute — an odd-length box passes 1/9 of Nyquist, and it only
    // runs near silhouettes, which is exactly why the checkerboard showed on
    // open floor and nowhere else.
    //
    // The hardware filter does half the work here, so the sources must be
    // LinearFilter: sampled nearest, the four corner taps collapse onto four
    // texels and the pass becomes a one-texel diagonal smear with no zero
    // anywhere.
    const tentAt = (src: Texture): Node<'vec4'> => {
      let sum: Node<'vec4'> = vec4(0);
      for (const [dx, dy] of TENT_CORNERS) {
        sum = sum.add(
          textureLevel(src, screenUV.add(vec2(dx, dy).div(res)), float(0)),
        );
      }
      return sum.mul(0.25);
    };

    // --- Fill smoothing. Dilated values inside silhouettes are piecewise
    // constant (Voronoi cells of the boundary texels), which facets large
    // solid areas. A separable 9x9 box filter softens that. Solid texels use
    // it fully, while near-boundary open texels blend toward it by silhouette
    // distance — callers offset surface samples a few texels off the boundary
    // and must land inside the smoothed band.
    const blurAxis = (src: Texture): Node<'vec4'> => {
      let sum: Node<'vec4'> = vec4(0);
      for (let dx = -FILL_BLUR_RADIUS; dx <= FILL_BLUR_RADIUS; dx++) {
        sum = sum.add(
          textureLevel(src, screenUV.add(vec2(dx, 0).div(res)), float(0)),
        );
      }
      return sum.div(FILL_BLUR_TAPS);
    };
    this.blurMat = passMaterial(
      outputStruct(
        blurAxis(this.lightRawRT.textures[0]!),
        blurAxis(this.lightRawRT.textures[1]!),
      ),
    );
    // One `Fn` per attachment: the vertical box is skipped entirely away from
    // silhouettes, and `If` needs a function scope to live in. `outputStruct`
    // itself has to be the material's fragment node, so the branch cannot wrap
    // both attachments at once.
    const fillOne = (raw: Texture, blurred: Texture) =>
      Fn(() => {
        const solid = textureLevel(emissionTex, screenUV, float(0)).a;
        // Tented, not sampled: this is the texel's own value everywhere the
        // box below does not reach, so it is where the lattice checkerboard
        // would otherwise survive to the caller. Taking it off the composite
        // rather than the raw fluence is what keeps the tent safe across a
        // silhouette — solid texels already hold their inpainted light there,
        // so a floor texel beside a wall averages in the wall's fill instead
        // of the dark nothing that reaches the wall's interior.
        const own = tentAt(raw);
        const dist = textureLevel(this.distRT.texture, screenUV, float(0)).r;
        const k = select(
          solid.greaterThan(SOLID_THRESHOLD),
          float(1),
          clamp(float(10).sub(dist).div(4), 0, 1),
        );
        const result = own.toVar();
        If(k.greaterThan(0), () => {
          const sum = vec4(0).toVar();
          for (let dy = -FILL_BLUR_RADIUS; dy <= FILL_BLUR_RADIUS; dy++) {
            const suv = screenUV.add(vec2(0, dy).div(res));
            sum.addAssign(textureLevel(blurred, suv, float(0)));
          }
          result.assign(own.add(sum.div(FILL_BLUR_TAPS).sub(own).mul(k)));
        });
        return result;
      })();
    this.fillMat = passMaterial(
      outputStruct(
        fillOne(this.lightRawRT.textures[0]!, this.lightBlurRT.textures[0]!),
        fillOne(this.lightRawRT.textures[1]!, this.lightBlurRT.textures[1]!),
      ),
    );
  }

  /** Composited direct light in field texture space. */
  get lightTexture(): Texture {
    return this.lightRT.textures[0]!;
  }

  /** Render target backing {@link lightTexture} (e.g. for pixel readback). */
  get lightRenderTarget(): RenderTarget {
    return this.lightRT;
  }

  get directTexture(): Texture {
    return this.fluenceRT.textures[0]!;
  }

  /**
   * Flatland irradiance vector (Σ luminance·direction) matching
   * {@link lightTexture}, in field pixel space with +y down. Dividing its xy
   * by the light's luminance recovers an anisotropy direction bounded by
   * cos(45 degrees), so an axis-aligned surface facing directly away from the
   * net flow still receives a little light rather than none.
   */
  get lightDirectionTexture(): Texture {
    return this.lightRT.textures[1]!;
  }

  get distanceTexture(): Texture {
    return this.distRT.texture;
  }

  /** TSL node sampling the light texture at a normalized field UV. */
  lightNode(uv: Node<'vec2'> = screenUV): Node<'vec3'> {
    return texture(this.lightTexture, uv).rgb;
  }

  /**
   * Runs the full pipeline from the current contents of the emission
   * G-buffer texture. Call once per frame, after rendering the G-buffer and
   * before compositing.
   */
  update(): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.getClearColor(this.prevClearColor);
    const prevClearAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    r.autoClear = true;

    // 1. Solve all four 90-degree frustums at once — they are stacked along y
    //    in every target here. Cascade 0's merge is per-texel fluence and goes
    //    straight into the frustum target.
    const N = this.cascadeCount;
    this.pass(this.vrayRT[0]!, this.raySeedMat);
    for (let n = 1; n < N; n++) {
      this.pass(this.vrayRT[n]!, this.extendMats[n]!);
    }
    for (let n = N - 1; n >= 1; n--) {
      this.pass(this.mergeRT[(n % 2) as 0 | 1], this.mergeMats[n]!);
    }
    this.pass(this.mergeRT[0], this.mergeMats[0]!);

    // 2. Average the four frustums into fluence and its irradiance vector.
    this.pass(this.fluenceRT, this.fluenceMat);

    // 3. Jump flood over the solid mask → distance field, for the fill chain.
    this.pass(this.jfaRT[0], this.seedMat);
    let read = 0;
    for (const jump of this.jumps) {
      const flood = this.floodMats[read as 0 | 1];
      flood.uJump.value = jump;
      this.pass(this.jfaRT[(1 - read) as 0 | 1], flood.mat);
      read = 1 - read;
    }
    this.pass(this.distRT, this.distMat);

    // 4. Inpaint pyramid: push the open-masked fluence down, pull back up
    //    filling holes — solid texels become distance-weighted averages of all
    //    nearby open fluence instead of copies of one arbitrary boundary texel.
    this.pass(this.pyrRT[0]!, this.pyrBaseMat);
    for (let k = 1; k < this.pyrRT.length; k++) {
      this.pass(this.pyrRT[k]!, this.pyrDownMats[k - 1]!);
    }
    for (let k = this.pyrRT.length - 1; k >= 0; k--) {
      this.pass(this.pyrFillRT[k]!, this.pyrUpMats[k]!);
    }

    // 5. Composite and smooth radiance — the irradiance vector rides the second
    //    attachment of the identical chain so the anisotropy ratio stays
    //    consistent.
    this.pass(this.lightRawRT, this.compositeMat);
    this.pass(this.lightBlurRT, this.blurMat);
    this.pass(this.lightRT, this.fillMat);

    r.setRenderTarget(prevTarget);
    r.setClearColor(this.prevClearColor, prevClearAlpha);
    r.autoClear = prevAutoClear;
  }

  private pass(target: RenderTarget, material: MeshBasicNodeMaterial): void {
    this.renderer.setRenderTarget(target);
    this.quad.material = material;
    this.quad.render(this.renderer);
  }

  dispose(): void {
    for (const rt of [
      ...this.jfaRT,
      this.distRT,
      ...this.vrayRT,
      ...this.mergeRT,
      this.fluenceRT,
      this.lightRawRT,
      this.lightBlurRT,
      this.lightRT,
      ...this.pyrRT,
      ...this.pyrFillRT,
    ]) {
      rt.dispose();
    }
    for (const m of [
      this.raySeedMat,
      ...this.extendMats.slice(1),
      ...this.mergeMats,
      this.fluenceMat,
      this.seedMat,
      this.floodMats[0].mat,
      this.floodMats[1].mat,
      this.distMat,
      this.pyrBaseMat,
      ...this.pyrDownMats,
      ...this.pyrUpMats,
      this.compositeMat,
      this.blurMat,
      this.fillMat,
    ]) {
      m.dispose();
    }
  }
}
