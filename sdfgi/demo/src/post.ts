/**
 * HDR post chain for the demo, in raw WebGPU on the renderer's own device.
 *
 * three.js renders the scene into a linear rgba16float target and SDFGI
 * composites into the same target (see `linearOutput` / `output`), which leaves
 * a real HDR buffer to work with:
 *
 *   volumetric  half res, raymarched against the sun's shadow map -> volTex
 *   blur        3x3 tent, hides the marching dither          volTex -> volBlur
 *   add         volBlur upsampled additively back into the HDR target
 *   bloom       threshold -> mip chain down -> tent upsample additively
 *   final       hdr + bloom, tone map, sRGB encode -> swapchain
 *
 * The volumetric pass is added before bloom on purpose, so the shafts glow too.
 */

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const MAX_BLOOM_MIPS = 6;

export interface VolumetricParams {
  enabled: boolean;
  /** raymarch samples per pixel */
  steps: number;
  /** extinction per world unit — the medium's thickness */
  density: number;
  /** Henyey-Greenstein g: 0 isotropic, ->1 forward scattering (sun halo) */
  scattering: number;
  intensity: number;
  /** stop marching here; sky pixels have no depth to stop them */
  maxDistance: number;
  shadowBias: number;
}

export interface BloomParams {
  enabled: boolean;
  threshold: number;
  knee: number;
  strength: number;
  /** upsample tent radius in texels */
  radius: number;
}

export interface FinalParams {
  exposure: number;
  toneMapping: 'none' | 'aces';
}

export interface Frame {
  /** the linear HDR target three.js + SDFGI rendered into */
  hdr: GPUTexture;
  /** full-res scene depth, depth32float, standard [0,1] range */
  depth: GPUTexture;
  /** the sun's shadow map, or null to skip the volumetric pass */
  shadow: GPUTexture | null;
  /** inverse of the camera's WebGPU-range projection matrix, column major */
  invProjection: Float32Array;
  /** camera.matrixWorld, column major */
  cameraWorld: Float32Array;
  /** light.shadow.matrix (world -> shadow clip), column major */
  shadowMatrix: Float32Array;
  cameraPosition: [number, number, number];
  /** direction the sunlight travels, normalized */
  sunDirection: [number, number, number];
  /** sun colour premultiplied by intensity */
  sunColor: [number, number, number];
  /** frame counter, drives the temporal half of the raymarch dither */
  frame: number;
}

// ---------------------------------------------------------------- shaders

const VS = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  // WebGPU framebuffer space: v = 0 is the top row, ndc y = +1 is the top row
  o.uv = vec2f(p[vi].x, -p[vi].y) * 0.5 + vec2f(0.5);
  return o;
}
`;

const VOLUMETRIC = /* wgsl */ `
${VS}

struct Vol {
  inv_proj: mat4x4f,
  cam_world: mat4x4f,
  shadow_mat: mat4x4f,
  sun_dir: vec3f,
  density: f32,
  sun_color: vec3f,
  g: f32,
  cam_pos: vec3f,
  intensity: f32,
  max_dist: f32,
  shadow_bias: f32,
  steps: f32,
  frame: f32,
};

@group(0) @binding(0) var depth_tex: texture_depth_2d;
@group(0) @binding(1) var shadow_tex: texture_depth_2d;
@group(0) @binding(2) var shadow_samp: sampler_comparison;
@group(0) @binding(3) var<uniform> u: Vol;

const PI = 3.14159265359;

/** Henyey-Greenstein, cos_t measured between the incoming and outgoing light */
fn hg(cos_t: f32, g: f32) -> f32 {
  let g2 = g * g;
  let d = max(1.0 + g2 - 2.0 * g * cos_t, 1e-4);
  return (1.0 - g2) / (4.0 * PI * d * sqrt(d));
}

fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn fs(v: VSOut) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(depth_tex));
  let px = vec2i(clamp(v.uv * dim, vec2f(0.0), dim - vec2f(1.0)));
  let d = textureLoad(depth_tex, px, 0);

  let ndc = vec2f(v.uv.x * 2.0 - 1.0, 1.0 - v.uv.y * 2.0);
  let far = u.inv_proj * vec4f(ndc, 1.0, 1.0);
  let dir = normalize((u.cam_world * vec4f(normalize(far.xyz / far.w), 0.0)).xyz);

  // the prepass clears depth to 1, so sky pixels march the full distance
  var march = u.max_dist;
  if (d < 1.0) {
    let hit = u.inv_proj * vec4f(ndc, d, 1.0);
    march = min(length(hit.xyz / hit.w), u.max_dist);
  }

  let steps = max(i32(u.steps), 1);
  let step_len = march / f32(steps);
  // interleave the sample offsets in space and time; the blur pass and the
  // 30-frame probe history both help hide what is left
  var t = step_len * hash12(v.pos.xy + vec2f(u.frame * 13.7, u.frame * 7.3));

  let phase = hg(-dot(dir, u.sun_dir), u.g);
  var transmittance = 1.0;
  var scatter = 0.0;

  for (var i = 0; i < steps; i += 1) {
    let world = u.cam_pos + dir * t;
    var vis = 1.0;
    let sc4 = u.shadow_mat * vec4f(world, 1.0);
    let sc = sc4.xyz / sc4.w;
    let suv = vec2f(sc.x, 1.0 - sc.y);
    if (all(suv >= vec2f(0.0)) && all(suv <= vec2f(1.0)) && sc.z >= 0.0 && sc.z <= 1.0) {
      vis = textureSampleCompareLevel(shadow_tex, shadow_samp, suv, sc.z - u.shadow_bias);
    }
    // single-scattering albedo 1: what leaves the segment is what it absorbed
    let a = exp(-u.density * step_len);
    scatter += transmittance * (1.0 - a) * vis;
    transmittance *= a;
    t += step_len;
  }

  return vec4f(scatter * phase * u.intensity * u.sun_color, 1.0);
}
`;

/** 3x3 tent, four bilinear taps */
const TENT = /* wgsl */ `
${VS}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs(v: VSOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var s = textureSampleLevel(src, samp, v.uv + vec2f(-t.x, -t.y), 0.0).rgb;
  s += textureSampleLevel(src, samp, v.uv + vec2f(t.x, -t.y), 0.0).rgb;
  s += textureSampleLevel(src, samp, v.uv + vec2f(-t.x, t.y), 0.0).rgb;
  s += textureSampleLevel(src, samp, v.uv + vec2f(t.x, t.y), 0.0).rgb;
  return vec4f(s * 0.25, 1.0);
}
`;

/** bilinear magnify, used to add the half-res volumetrics back at full res */
const UPSCALE_ADD = /* wgsl */ `
${VS}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs(v: VSOut) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(src, samp, v.uv, 0.0).rgb, 1.0);
}
`;

/**
 * COD "Next Generation Post Processing" 13-tap downsample. `prefilter` adds the
 * soft-knee threshold and the Karis group average, which is what stops a single
 * blown-out texel from strobing across the whole mip chain.
 */
const DOWNSAMPLE = (prefilter: boolean) => /* wgsl */ `
${VS}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
${
  prefilter
    ? `
struct Filt { threshold: f32, knee: f32 };
@group(0) @binding(2) var<uniform> u: Filt;

fn karis(c: vec3f) -> f32 {
  return 1.0 / (1.0 + dot(c, vec3f(0.2126, 0.7152, 0.0722)));
}

fn prefilter(c: vec3f) -> vec3f {
  let br = max(c.r, max(c.g, c.b));
  let knee = max(u.knee, 1e-4);
  let soft = clamp(br - u.threshold + knee, 0.0, 2.0 * knee);
  let contrib = max(soft * soft / (4.0 * knee), br - u.threshold);
  return c * (contrib / max(br, 1e-4));
}
`
    : ''
}

fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(src, samp, uv, 0.0).rgb;
}

@fragment
fn fs(v: VSOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let uv = v.uv;

  let a = tap(uv + vec2f(-2.0 * t.x,  2.0 * t.y));
  let b = tap(uv + vec2f( 0.0,        2.0 * t.y));
  let c = tap(uv + vec2f( 2.0 * t.x,  2.0 * t.y));
  let d = tap(uv + vec2f(-2.0 * t.x,  0.0));
  let e = tap(uv);
  let f = tap(uv + vec2f( 2.0 * t.x,  0.0));
  let g = tap(uv + vec2f(-2.0 * t.x, -2.0 * t.y));
  let h = tap(uv + vec2f( 0.0,       -2.0 * t.y));
  let i = tap(uv + vec2f( 2.0 * t.x, -2.0 * t.y));
  let j = tap(uv + vec2f(-t.x,  t.y));
  let k = tap(uv + vec2f( t.x,  t.y));
  let l = tap(uv + vec2f(-t.x, -t.y));
  let m = tap(uv + vec2f( t.x, -t.y));

  let g0 = (j + k + l + m) * 0.25;
  let g1 = (a + b + d + e) * 0.25;
  let g2 = (b + c + e + f) * 0.25;
  let g3 = (d + e + g + h) * 0.25;
  let g4 = (e + f + h + i) * 0.25;

${
  prefilter
    ? `  let w0 = karis(g0) * 0.5;
  let w1 = karis(g1) * 0.125;
  let w2 = karis(g2) * 0.125;
  let w3 = karis(g3) * 0.125;
  let w4 = karis(g4) * 0.125;
  let sum = g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4;
  let result = prefilter(sum / max(w0 + w1 + w2 + w3 + w4, 1e-4));`
    : `  let result = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;`
}
  return vec4f(max(result, vec3f(0.0)), 1.0);
}
`;

/** 3x3 tent upsample, blended additively onto the next larger mip */
const UPSAMPLE = /* wgsl */ `
${VS}

struct Up { radius: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: Up;

fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(src, samp, uv, 0.0).rgb;
}

@fragment
fn fs(v: VSOut) -> @location(0) vec4f {
  let o = u.radius / vec2f(textureDimensions(src));
  let uv = v.uv;
  var s = tap(uv + vec2f(-o.x,  o.y)) + tap(uv + vec2f(o.x,  o.y));
  s += tap(uv + vec2f(-o.x, -o.y)) + tap(uv + vec2f(o.x, -o.y));
  s += (tap(uv + vec2f(0.0, o.y)) + tap(uv + vec2f(0.0, -o.y))
      + tap(uv + vec2f(-o.x, 0.0)) + tap(uv + vec2f(o.x, 0.0))) * 2.0;
  s += tap(uv) * 4.0;
  return vec4f(s * (1.0 / 16.0), 1.0);
}
`;

const FINAL = /* wgsl */ `
${VS}

struct Fin { exposure: f32, bloom: f32, tonemap: f32 };
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: Fin;

/** Narkowicz's ACES fit — cheap, and close enough for a demo */
fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs(v: VSOut) -> @location(0) vec4f {
  var c = textureLoad(hdr, vec2i(v.pos.xy), 0).rgb;
  c += textureSampleLevel(bloom, samp, v.uv, 0.0).rgb * u.bloom;
  c = max(c * u.exposure, vec3f(0.0));
  if (u.tonemap > 0.5) {
    c = aces(c);
  } else {
    c = clamp(c, vec3f(0.0), vec3f(1.0));
  }
  let a = vec3f(0.055);
  let srgb = select((vec3f(1.0) + a) * pow(c, vec3f(1.0 / 2.4)) - a, 12.92 * c, c < vec3f(0.0031308));
  return vec4f(srgb, 1.0);
}
`;

// ---------------------------------------------------------------- pipeline

const ADD: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

export class Post {
  private device: GPUDevice;
  private samp: GPUSampler;
  private shadowSamp: GPUSampler;

  private pVol: GPURenderPipeline;
  private pTent: GPURenderPipeline;
  private pVolAdd: GPURenderPipeline;
  private pPrefilter: GPURenderPipeline;
  private pDown: GPURenderPipeline;
  private pUp: GPURenderPipeline;
  private pFinal: GPURenderPipeline;

  private volUbo: GPUBuffer;
  private filterUbo: GPUBuffer;
  private upUbo: GPUBuffer;
  private finalUbo: GPUBuffer;
  private volData = new Float32Array(64);

  private width = 0;
  private height = 0;
  private volTex: GPUTexture | null = null;
  private volBlurTex: GPUTexture | null = null;
  private mips: GPUTexture[] = [];

  private bgTent!: GPUBindGroup;
  private bgVolAdd!: GPUBindGroup;
  private bgDown: GPUBindGroup[] = [];
  private bgUp: GPUBindGroup[] = [];

  // rebuilt whenever three.js or SDFGI hands us a different texture object
  private lastHdr: GPUTexture | null = null;
  private lastDepth: GPUTexture | null = null;
  private lastShadow: GPUTexture | null = null;
  private bgVol: GPUBindGroup | null = null;
  private bgPrefilter: GPUBindGroup | null = null;
  private bgFinal: GPUBindGroup | null = null;

  constructor(device: GPUDevice, outputFormat: GPUTextureFormat) {
    this.device = device;
    this.samp = device.createSampler({
      label: 'post linear',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.shadowSamp = device.createSampler({
      label: 'post shadow compare',
      magFilter: 'linear',
      minFilter: 'linear',
      compare: 'less-equal',
    });

    const quad = (label: string, code: string, format: GPUTextureFormat, blend?: GPUBlendState) => {
      const module = device.createShaderModule({ label, code });
      return device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: { module },
        fragment: { module, targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    };

    this.pVol = quad('post volumetric', VOLUMETRIC, HDR_FORMAT);
    this.pTent = quad('post tent blur', TENT, HDR_FORMAT);
    this.pVolAdd = quad('post volumetric add', UPSCALE_ADD, HDR_FORMAT, ADD);
    this.pPrefilter = quad('post bloom prefilter', DOWNSAMPLE(true), HDR_FORMAT);
    this.pDown = quad('post bloom downsample', DOWNSAMPLE(false), HDR_FORMAT);
    this.pUp = quad('post bloom upsample', UPSAMPLE, HDR_FORMAT, ADD);
    this.pFinal = quad('post final', FINAL, outputFormat);

    const ubo = (label: string, size: number) =>
      device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.volUbo = ubo('post volumetric ubo', 256);
    this.filterUbo = ubo('post bloom filter ubo', 16);
    this.upUbo = ubo('post bloom upsample ubo', 16);
    this.finalUbo = ubo('post final ubo', 16);
  }

  private bg(p: GPURenderPipeline, entries: Record<number, GPUBindingResource>): GPUBindGroup {
    return this.device.createBindGroup({
      label: `${p.label} @group(0)`,
      layout: p.getBindGroupLayout(0),
      entries: Object.entries(entries).map(([binding, resource]) => ({ binding: Number(binding), resource })),
    });
  }

  private resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.destroyTextures();

    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const half: [number, number] = [Math.max(1, width >> 1), Math.max(1, height >> 1)];
    this.volTex = this.device.createTexture({ label: 'post volumetric', size: half, format: HDR_FORMAT, usage });
    this.volBlurTex = this.device.createTexture({ label: 'post volumetric blur', size: half, format: HDR_FORMAT, usage });

    // mip 0 is half res; stop before anything degenerates to a single texel
    const levels = Math.max(1, Math.min(MAX_BLOOM_MIPS, Math.floor(Math.log2(Math.min(width, height))) - 2));
    for (let i = 0; i < levels; i++) {
      const size: [number, number] = [Math.max(1, width >> (i + 1)), Math.max(1, height >> (i + 1))];
      this.mips.push(this.device.createTexture({ label: `post bloom ${i}`, size, format: HDR_FORMAT, usage }));
    }

    this.bgTent = this.bg(this.pTent, { 0: this.volTex.createView(), 1: this.samp });
    this.bgVolAdd = this.bg(this.pVolAdd, { 0: this.volBlurTex.createView(), 1: this.samp });
    this.bgDown = this.mips.map((_, i) =>
      i === 0
        ? undefined!
        : this.bg(this.pDown, { 0: this.mips[i - 1].createView(), 1: this.samp }),
    );
    this.bgUp = this.mips.map((m) => this.bg(this.pUp, { 0: m.createView(), 1: this.samp, 2: { buffer: this.upUbo } }));

    // anything pointing at the old textures is stale
    this.lastHdr = null;
  }

  private bindExternal(frame: Frame): void {
    if (frame.hdr !== this.lastHdr) {
      this.lastHdr = frame.hdr;
      const hdrView = frame.hdr.createView();
      this.bgPrefilter = this.bg(this.pPrefilter, {
        0: hdrView,
        1: this.samp,
        2: { buffer: this.filterUbo },
      });
      this.bgFinal = this.bg(this.pFinal, {
        0: hdrView,
        1: this.mips[0].createView(),
        2: this.samp,
        3: { buffer: this.finalUbo },
      });
    }
    if (frame.shadow && (frame.depth !== this.lastDepth || frame.shadow !== this.lastShadow)) {
      this.lastDepth = frame.depth;
      this.lastShadow = frame.shadow;
      this.bgVol = this.bg(this.pVol, {
        0: frame.depth.createView(),
        1: frame.shadow.createView({ aspect: 'depth-only' }),
        2: this.shadowSamp,
        3: { buffer: this.volUbo },
      });
    }
  }

  private pass(
    enc: GPUCommandEncoder,
    label: string,
    view: GPUTextureView,
    pipeline: GPURenderPipeline,
    group: GPUBindGroup,
    load: boolean,
  ): void {
    const p = enc.beginRenderPass({
      label,
      colorAttachments: [
        {
          view,
          loadOp: load ? 'load' : 'clear',
          clearValue: [0, 0, 0, 1],
          storeOp: 'store',
        },
      ],
    });
    p.setPipeline(pipeline);
    p.setBindGroup(0, group);
    p.draw(3);
    p.end();
  }

  /**
   * Records the whole chain and writes the result to `output`. `width`/`height`
   * must match `frame.hdr`.
   */
  render(
    enc: GPUCommandEncoder,
    frame: Frame,
    volumetric: VolumetricParams,
    bloom: BloomParams,
    final: FinalParams,
    output: GPUTextureView,
    width: number,
    height: number,
  ): void {
    this.resize(width, height);
    this.bindExternal(frame);
    const q = this.device.queue;

    if (volumetric.enabled && frame.shadow && this.bgVol) {
      const v = this.volData;
      v.set(frame.invProjection, 0);
      v.set(frame.cameraWorld, 16);
      v.set(frame.shadowMatrix, 32);
      v.set(frame.sunDirection, 48);
      v[51] = volumetric.density;
      v.set(frame.sunColor, 52);
      v[55] = volumetric.scattering;
      v.set(frame.cameraPosition, 56);
      v[59] = volumetric.intensity;
      v[60] = volumetric.maxDistance;
      v[61] = volumetric.shadowBias;
      v[62] = Math.round(volumetric.steps);
      v[63] = frame.frame % 64;
      q.writeBuffer(this.volUbo, 0, v);

      this.pass(enc, 'post volumetric', this.volTex!.createView(), this.pVol, this.bgVol, false);
      this.pass(enc, 'post volumetric blur', this.volBlurTex!.createView(), this.pTent, this.bgTent, false);
      this.pass(enc, 'post volumetric add', frame.hdr.createView(), this.pVolAdd, this.bgVolAdd, true);
    }

    if (bloom.enabled) {
      q.writeBuffer(this.filterUbo, 0, new Float32Array([bloom.threshold, bloom.knee]));
      q.writeBuffer(this.upUbo, 0, new Float32Array([bloom.radius]));

      this.pass(enc, 'post bloom prefilter', this.mips[0].createView(), this.pPrefilter, this.bgPrefilter!, false);
      for (let i = 1; i < this.mips.length; i++) {
        this.pass(enc, `post bloom down ${i}`, this.mips[i].createView(), this.pDown, this.bgDown[i], false);
      }
      for (let i = this.mips.length - 1; i > 0; i--) {
        this.pass(enc, `post bloom up ${i}`, this.mips[i - 1].createView(), this.pUp, this.bgUp[i], true);
      }
    }

    q.writeBuffer(
      this.finalUbo,
      0,
      new Float32Array([final.exposure, bloom.enabled ? bloom.strength : 0, final.toneMapping === 'aces' ? 1 : 0]),
    );
    this.pass(enc, 'post final', output, this.pFinal, this.bgFinal!, false);
  }

  private destroyTextures(): void {
    this.volTex?.destroy();
    this.volBlurTex?.destroy();
    for (const m of this.mips) m.destroy();
    this.volTex = null;
    this.volBlurTex = null;
    this.mips = [];
  }

  dispose(): void {
    this.destroyTextures();
    for (const b of [this.volUbo, this.filterUbo, this.upUbo, this.finalUbo]) b.destroy();
  }
}
