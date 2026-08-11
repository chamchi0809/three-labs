import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import {
  CASCADE_SIZE,
  FRAMES_TO_UPDATE_LIGHT,
  HISTORY_FRAMES_TO_CONVERGE,
  LIGHTPROBE_OCT_SIZE,
  LIGHT_TYPE_DIRECTIONAL,
  LIGHT_TYPE_OMNI,
  LIGHT_TYPE_SPOT,
  MAX_CASCADES,
  MAX_DYNAMIC_LIGHTS,
  MAX_STATIC_LIGHTS,
  PROBE_AXIS_COUNT,
  PROBE_CELLS,
  SH_SIZE,
  SKY_FLAGS_MODE_COLOR,
  SKY_FLAGS_MODE_SKY,
  SKY_FLAGS_ORIENTATION_SIGN,
  Y_SCALE,
} from './constants.ts';
import {
  ParamPool,
  W,
  Zeroer,
  computePipeline,
  storageBuffer,
  texture2DArray,
  texture3D,
  type Pipelineish,
} from './gpu.ts';
import { Profiler } from './profiler.ts';
import { DRAW_STRIDE, VERTEX_LAYOUT, extractScene, type ExtractedScene } from './scene.ts';
import * as APPLY from './shaders/apply.ts';
import * as DEBUG from './shaders/debug.ts';
import * as DIRECT from './shaders/directLight.ts';
import * as INTEGRATE from './shaders/integrate.ts';
import * as PRE from './shaders/preprocess.ts';
import * as VOXELIZE from './shaders/voxelize.ts';

/**
 * Port of GI::SDFGI (godot/servers/rendering/renderer_rd/environment/gi.cpp):
 * update() / get_pending_region_data() / render_region() / render_static_lights()
 * / update_cascades() / pre_process_gi() / update_light() / update_probes() /
 * store_probes() / debug_draw() / debug_probes().
 *
 * Deviations from Godot, all forced by the host engine rather than by WebGPU:
 *  - LIGHT_TYPE_AREA (LTC) is not ported.
 *  - Godot time-slices region rendering over frames through its scene culler.
 *    We render every pending region in one frame (see renderPendingRegions).
 *  - "static" lights are opt-in via `light.userData.sdfgiStatic`, instead of
 *    Godot's baked-vs-realtime light mode.
 *  - MODE_SKY needs an octahedral irradiance map; we accept one from the caller
 *    (options.skyIrradiance) but never generate it. MODE_COLOR is complete.
 */

const G = CASCADE_SIZE;
const OCT = LIGHTPROBE_OCT_SIZE;
const PA = PROBE_AXIS_COUNT;
const CELLS = G * G * G;
const SOLID_CELL_RATIO = 0.25;
const SOLID_CELLS = Math.floor(CELLS * SOLID_CELL_RATIO);
const RAY_COUNTS = [4, 8, 16, 32, 64, 96, 128];
const PROBE_IMAGE_W = PA * PA;
const PROBE_IMAGE_H = PA;
/** debug_probes(): band_points 16, band_power 4, sections_in_band 7 */
const PROBE_VERTS = 112;

export interface SDFGIOptions {
  /** number of cascades, 1..8 (Godot default 4) */
  cascades?: number;
  /** cell size of cascade 0 in world units (Godot default 0.2) */
  minCellSize?: number;
  useOcclusion?: boolean;
  /** index into Y_SCALE: 0 = disabled(2.0), 1 = 75%(1.5), 2 = 50%(1.0) */
  yScale?: number;
  /** index into HISTORY_FRAMES_TO_CONVERGE */
  framesToConverge?: number;
  /** index into FRAMES_TO_UPDATE_LIGHT */
  framesToUpdateLight?: number;
  /** index into RAY_COUNTS */
  rayCount?: number;
  /** Refresh 1/probeSlices of the probe grid per frame (Godot always does all of
   *  it, i.e. 1). The integrate pass is ~70% of GPU time and scales inversely
   *  with this; the cost is that lighting changes take this many frames to reach
   *  every probe, so raising it trades response latency for frame time. */
  probeSlices?: number;
  /** Minimum frames between two cascade scrolls. A scroll rebuilds a whole
   *  cascade volume, so letting them land on consecutive frames is what drops
   *  the frame rate while the camera moves; the cost is that far cascades
   *  re-centre later. 1 = Godot's behaviour. */
  scrollInterval?: number;
  bounceFeedback?: number;
  energy?: number;
  normalBias?: number;
  probeBias?: number;
  /** MODE_COLOR ambient. Set skyIrradiance for MODE_SKY instead. */
  skyColor?: THREE.ColorRepresentation | null;
  skyEnergy?: number;
  /** octahedral sky irradiance, 2D, mipmapped, with a 1-texel border */
  skyIrradiance?: GPUTexture | null;
  skyIrradianceBorder?: [number, number];
  /** Godot's `rendering/global_illumination/gi/use_half_resolution`: run the GI
   *  compute at half res and bilinear-upsample. ~4x cheaper on the apply pass. */
  halfResolution?: boolean;
  /** Composite in linear light instead of sRGB-encoding first. Set this when
   *  `output` is an HDR render target rather than the swapchain. */
  linearOutput?: boolean;
  canvasFormat?: GPUTextureFormat;
  /** Where present() draws. Defaults to the renderer's swapchain texture; point
   *  it at an HDR target (with `canvasFormat`/`linearOutput` to match) to run
   *  post-processing after the composite. */
  output?: GPUTexture | null;
}

const DEFAULTS = {
  cascades: 4,
  minCellSize: 0.2,
  useOcclusion: true,
  yScale: 1,
  framesToConverge: 5, // 30 frames, like Godot: fewer probe rays in the average shows up as blotches
  framesToUpdateLight: 2, // 4 frames
  rayCount: 3, // 32
  probeSlices: 4,
  scrollInterval: 4,
  bounceFeedback: 0.5,
  energy: 1.0,
  normalBias: 1.1,
  probeBias: 1.1,
  skyColor: 0x000000 as THREE.ColorRepresentation | null,
  skyEnergy: 1.0,
  skyIrradiance: null as GPUTexture | null,
  skyIrradianceBorder: [0, 0] as [number, number],
  halfResolution: false,
  linearOutput: false,
};

export type DebugView = 'none' | 'sdf' | 'probes' | 'visibility';

interface Region {
  cascade: number;
  from: THREE.Vector3;
  size: THREE.Vector3;
  boundsMin: THREE.Vector3;
  boundsSize: THREE.Vector3;
}

interface Cascade {
  cellSize: number;
  position: THREE.Vector3; // integer cell offset
  dirty: THREE.Vector3;
  dirtyAll: boolean;
  /** scroll waiting for this cascade's turn (see dequeueCascade) */
  queued: boolean;
  queuedPos: THREE.Vector3;
  queuedDirty: THREE.Vector3;
  queuedDirtyAll: boolean;
  allDynamicLightsDirty: boolean;
  solidCells: GPUBuffer;
  dispatchStorage: GPUBuffer;
  dispatchCall: GPUBuffer;
  lightsDynamic: GPUBuffer;
  lightsStatic: GPUBuffer;
  history: GPUBuffer;
  average: GPUBuffer;
  averageFiltered: GPUBuffer;
  bgScroll: GPUBindGroup;
  bgStore: GPUBindGroup;
  bgDirectDynamic: GPUBindGroup;
  bgDirectStatic: GPUBindGroup;
  bgIntegrate: GPUBindGroup;
  bgIntegrateFilter: GPUBindGroup;
  bgIntegrateStore: GPUBindGroup;
  bgIntegrateScroll: GPUBindGroup;
  bgIntegrateScrollStore: GPUBindGroup;
}

type Res = Record<number, GPUBindingResource>;

export class SDFGI {
  readonly device: GPUDevice;
  private renderer: WebGPURenderer;
  /** Live tweakables. Structural fields (cascades, minCellSize, yScale, framesToConverge, linearOutput) only take effect on construction. */
  readonly options: Required<Omit<SDFGIOptions, 'canvasFormat' | 'output'>>;
  private canvasFormat: GPUTextureFormat;

  /** live knobs — read every frame */
  debug: DebugView = 'none';
  /** see SDFGIOptions.output — null draws to the swapchain */
  output: GPUTexture | null;
  debugCascade = 0;
  debugProbeIndex = 0;

  /** per-pass GPU times in ms. Set `profiler.enabled = true` to start sampling. */
  readonly profiler: Profiler;

  /**
   * The prepass depth buffer (depth32float, full res, standard [0,1] range),
   * valid after the first render(). Handy for post effects that need to
   * reconstruct world positions; the handle is replaced on resize.
   */
  get depthTexture(): GPUTexture {
    return this.depthTex;
  }

  private yMult: number;
  private numCascades: number;
  private historySize: number;
  private cascades: Cascade[] = [];
  private frame = 0;
  private firstFrame = true;
  private serveCursor = 0;
  private lastScrollFrame = -1e9;

  private pool: ParamPool;
  private zero: Zeroer;
  private extracted: ExtractedScene | null = null;
  private scene: THREE.Object3D | null = null;

  // ---- volumes (all cascades packed along z) ----
  private sdfTex: GPUTexture;
  private lightTex: GPUTexture;
  private aniso0Tex: GPUTexture;
  private aniso1Tex: GPUTexture;
  private occlusionTex: GPUTexture;
  private lightprobeTex: GPUTexture;
  private ambientTex: GPUTexture;
  private renderSdf: [GPUTexture, GPUTexture];
  private renderSdfHalf: [GPUTexture, GPUTexture];
  private skyTex: GPUTexture;
  private ownsSkyTex: boolean;

  private renderAlbedo: GPUBuffer;
  private renderFacing: GPUBuffer;
  private renderEmission: GPUBuffer;
  private renderEmissionAniso: GPUBuffer;
  private renderOcclusion: GPUBuffer;
  private historyScroll: GPUBuffer;
  private averageScroll: GPUBuffer;
  private rayLight: GPUBuffer;
  private cascadesUbo: GPUBuffer;
  private sdfgiUbo: GPUBuffer;
  private probeVpUbo: GPUBuffer;

  private sampLinear: GPUSampler;
  private sampMip: GPUSampler;
  private sampRepeat: GPUSampler;

  // ---- screen sized ----
  private width = 0;
  private height = 0;
  private giScale = 1;
  private albedoTex!: GPUTexture;
  private normalTex!: GPUTexture;
  private depthTex!: GPUTexture;
  // createView() allocates, and these three are re-attached every frame
  private albedoView!: GPUTextureView;
  private normalView!: GPUTextureView;
  private depthView!: GPUTextureView;
  private ambientBuf!: GPUTexture;
  private reflectionBuf!: GPUTexture;
  private debugTex!: GPUTexture;
  private bgGi!: GPUBindGroup;
  private bgComposite!: GPUBindGroup;
  private bgDebugSdf!: GPUBindGroup;
  private bgBlit!: GPUBindGroup;

  // ---- pipelines ----
  private pScroll: GPUComputePipeline;
  private pScrollOcc: GPUComputePipeline;
  private pJfaInitHalf: GPUComputePipeline;
  private pJfa: GPUComputePipeline;
  private pJfaOpt: GPUComputePipeline;
  private jfaOptimized = false;
  private pJfaUpscale: GPUComputePipeline;
  private pOcclusion: GPUComputePipeline;
  private pStore: GPUComputePipeline;
  private pDirectDyn: GPUComputePipeline;
  private pDirectStat: GPUComputePipeline;
  private pIntegrateRays: GPUComputePipeline;
  private pIntegrate: GPUComputePipeline;
  private pIntegrateFilter: GPUComputePipeline;
  private pIntegrateStore: GPUComputePipeline;
  private pIntegrateScroll: GPUComputePipeline;
  private pIntegrateScrollStore: GPUComputePipeline;
  private pGi: GPUComputePipeline;
  private pDebugSdf: GPUComputePipeline;
  private pVoxelize: GPURenderPipeline;
  private pPrepass: GPURenderPipeline;
  private pComposite: GPURenderPipeline;
  private pBlit: GPURenderPipeline;
  private pProbes: GPURenderPipeline;
  private pProbeVis: GPURenderPipeline;

  // ---- static bind groups ----
  private bgJfaInitHalf: GPUBindGroup;
  private bgJfaHalf: [GPUBindGroup, GPUBindGroup];
  private bgJfaOptHalf: [GPUBindGroup, GPUBindGroup];
  private bgJfaUpscale: [GPUBindGroup, GPUBindGroup];
  private bgJfaFull: GPUBindGroup;
  private bgIntegrateRays: GPUBindGroup;
  private bgOcclusion: GPUBindGroup;
  private bgScrollOcc: GPUBindGroup;
  private bgVoxelize: GPUBindGroup;
  private bgProbes: GPUBindGroup;
  private bgProbeVis: GPUBindGroup;
  private drawBgs: GPUBindGroup[][] = []; // [pipeline slot][draw slot]
  private texBgs: GPUBindGroup[][] = [];
  private voxelDummy: GPUTexture;
  private voxelDummyView: GPUTextureView;

  // scratch
  private mProj = new THREE.Matrix4();
  private mTmp = new THREE.Matrix4();
  private mTmp2 = new THREE.Matrix4();
  private vTmp = new THREE.Vector3();
  private vTmp2 = new THREE.Vector3();
  private vSize = new THREE.Vector2();
  private camPos = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private bTmp = new THREE.Box3();
  private scratch = new ArrayBuffer(MAX_STATIC_LIGHTS * 64);
  private scratchU32 = new Uint32Array(this.scratch);
  private lTmp = new THREE.Vector3();
  private lDir = new THREE.Vector3();
  /** every cascade packs the same light records, so they are built once a frame */
  private lightData = new ArrayBuffer(MAX_STATIC_LIGHTS * 64);
  private lightU32 = new Uint32Array(this.lightData);
  private lightW = new W(new DataView(this.lightData));
  /** per prepared light: x, y, z, radius. radius < 0 marks a directional. */
  private lightCull = new Float32Array(MAX_STATIC_LIGHTS * 4);
  private lightPrepared = 0;
  private cascadesUboData = new ArrayBuffer(48 * MAX_CASCADES);
  private cascadesUboW = new W(new DataView(this.cascadesUboData));
  private sdfgiUboData = new ArrayBuffer(112 + 48 * MAX_CASCADES);
  private sdfgiUboW = new W(new DataView(this.sdfgiUboData));

  constructor(renderer: WebGPURenderer, options: SDFGIOptions = {}) {
    const backend = (renderer as unknown as { backend?: { device?: GPUDevice } }).backend;
    if (!backend?.device) {
      throw new Error('sdfgi: renderer has no WebGPU device — await renderer.init() first');
    }
    this.renderer = renderer;
    this.device = backend.device;
    const device = this.device;
    this.profiler = new Profiler(device);
    this.options = { ...DEFAULTS, ...options } as Required<Omit<SDFGIOptions, 'canvasFormat' | 'output'>>;
    this.canvasFormat = options.canvasFormat ?? navigator.gpu.getPreferredCanvasFormat();
    this.output = options.output ?? null;

    this.numCascades = Math.max(1, Math.min(MAX_CASCADES, this.options.cascades));
    this.yMult = Y_SCALE[this.options.yScale] ?? 1.5;
    this.historySize = HISTORY_FRAMES_TO_CONVERGE[this.options.framesToConverge] ?? 10;

    this.pool = new ParamPool(device, 2048);
    this.zero = new Zeroer(device);

    const N = this.numCascades;
    this.sdfTex = texture3D(device, { label: 'sdfgi sdf', format: 'rgba8unorm', size: [G, G, G * N] });
    this.lightTex = texture3D(device, { label: 'sdfgi light', format: 'rgba16float', size: [G, G, G * N] });
    this.aniso0Tex = texture3D(device, { label: 'sdfgi aniso0', format: 'rgba8unorm', size: [G, G, G * N] });
    this.aniso1Tex = texture3D(device, { label: 'sdfgi aniso1', format: 'rgba8unorm', size: [G, G, G * N] });
    this.occlusionTex = texture3D(device, {
      label: 'sdfgi occlusion',
      format: 'rgba8unorm',
      size: [G * 2, G, G * N],
    });
    this.renderSdf = [
      texture3D(device, { label: 'sdfgi jfa 0', format: 'rgba8uint', size: [G, G, G] }),
      texture3D(device, { label: 'sdfgi jfa 1', format: 'rgba8uint', size: [G, G, G] }),
    ];
    this.renderSdfHalf = [
      texture3D(device, { label: 'sdfgi jfa half 0', format: 'rgba8uint', size: [G / 2, G / 2, G / 2] }),
      texture3D(device, { label: 'sdfgi jfa half 1', format: 'rgba8uint', size: [G / 2, G / 2, G / 2] }),
    ];
    // two layer sets: [0,N) irradiance, [N,2N) radiance (see integrate STORE)
    this.lightprobeTex = texture2DArray(
      device,
      'sdfgi lightprobe',
      'rgba16float',
      PA * PA * (OCT + 2),
      PA * (OCT + 2),
      N * 2, // [0,N) irradiance, [N,2N) radiance
    );
    this.ambientTex = texture2DArray(device, 'sdfgi ambient', 'rgba16float', PROBE_IMAGE_W, PROBE_IMAGE_H, N);

    if (this.options.skyIrradiance) {
      this.skyTex = this.options.skyIrradiance;
      this.ownsSkyTex = false;
    } else {
      this.skyTex = device.createTexture({
        label: 'sdfgi sky placeholder',
        size: [1, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.ownsSkyTex = true;
    }

    this.renderAlbedo = storageBuffer(device, 'sdfgi render albedo', CELLS * 4);
    this.renderFacing = storageBuffer(device, 'sdfgi render facing', CELLS * 4);
    this.renderEmission = storageBuffer(device, 'sdfgi render emission', CELLS * 4);
    this.renderEmissionAniso = storageBuffer(device, 'sdfgi render emission aniso', CELLS * 4);
    this.renderOcclusion = storageBuffer(device, 'sdfgi render occlusion', CELLS * 8);

    const historyBytes = PROBE_IMAGE_W * (PROBE_IMAGE_H * SH_SIZE) * this.historySize * 8;
    const averageBytes = PROBE_IMAGE_W * (PROBE_IMAGE_H * SH_SIZE) * 16;
    this.historyScroll = storageBuffer(device, 'sdfgi history scroll', historyBytes);
    this.averageScroll = storageBuffer(device, 'sdfgi average scroll', averageBytes);
    // one vec4f of hit radiance per (probe, ray) handed from the ray pass to the
    // accumulate pass. rayCount and probeSlices are live knobs, so size it for
    // the worst case -- which is still small next to the probe history above.
    this.rayLight = storageBuffer(
      device,
      'sdfgi probe rays',
      PROBE_IMAGE_W * PROBE_IMAGE_H * RAY_COUNTS[RAY_COUNTS.length - 1] * 16,
    );

    this.cascadesUbo = device.createBuffer({
      label: 'sdfgi cascades ubo',
      size: 48 * MAX_CASCADES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sdfgiUbo = device.createBuffer({
      label: 'sdfgi ubo',
      size: 112 + 48 * MAX_CASCADES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.probeVpUbo = device.createBuffer({
      label: 'sdfgi probe vp',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.sampLinear = device.createSampler({
      label: 'sdfgi linear',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    this.sampMip = device.createSampler({
      label: 'sdfgi linear mip',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.sampRepeat = device.createSampler({
      label: 'sdfgi repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    this.voxelDummy = device.createTexture({
      label: 'sdfgi voxelize dummy target',
      size: [G, G],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.voxelDummyView = this.voxelDummy.createView();

    // ---- pipelines ----
    const cp = (l: string, c: string) => computePipeline(device, l, c);
    this.pScroll = cp('sdfgi scroll', PRE.SCROLL);
    this.pScrollOcc = cp('sdfgi scroll occlusion', PRE.SCROLL_OCCLUSION);
    this.pJfaInitHalf = cp('sdfgi jfa init half', PRE.JUMP_FLOOD_INITIALIZE_HALF);
    this.pJfa = cp('sdfgi jfa', PRE.JUMP_FLOOD);
    // Godot's optimized JFA is an 8^3 = 512-invocation shared-memory variant.
    // The WebGPU default cap is 256, so on such devices fall back to the plain
    // 4^3 pass — same output, one texture read per neighbour instead of LDS.
    this.jfaOptimized = device.limits.maxComputeInvocationsPerWorkgroup >= 512;
    this.pJfaOpt = this.jfaOptimized
      ? cp('sdfgi jfa optimized', PRE.JUMP_FLOOD_OPTIMIZED)
      : this.pJfa;
    this.pJfaUpscale = cp('sdfgi jfa upscale', PRE.JUMP_FLOOD_UPSCALE);
    this.pOcclusion = cp('sdfgi occlusion', PRE.OCCLUSION);
    this.pStore = cp('sdfgi store', PRE.STORE);
    this.pDirectDyn = cp('sdfgi direct dynamic', DIRECT.PROCESS_DYNAMIC);
    this.pDirectStat = cp('sdfgi direct static', DIRECT.PROCESS_STATIC);
    this.pIntegrateRays = cp('sdfgi integrate rays', INTEGRATE.RAYS);
    this.pIntegrate = cp('sdfgi integrate', INTEGRATE.PROCESS);
    this.pIntegrateFilter = cp('sdfgi integrate filter', INTEGRATE.FILTER);
    this.pIntegrateStore = cp('sdfgi integrate store', INTEGRATE.STORE);
    this.pIntegrateScroll = cp('sdfgi integrate scroll', INTEGRATE.SCROLL);
    this.pIntegrateScrollStore = cp('sdfgi integrate scroll store', INTEGRATE.SCROLL_STORE);
    this.pGi = cp('sdfgi apply', APPLY.GI);
    this.pDebugSdf = cp('sdfgi debug sdf', DEBUG.DEBUG);

    const voxModule = device.createShaderModule({ label: 'sdfgi voxelize', code: VOXELIZE.VOXELIZE });
    this.pVoxelize = device.createRenderPipeline({
      label: 'sdfgi voxelize',
      layout: 'auto',
      vertex: { module: voxModule, buffers: [VERTEX_LAYOUT] },
      fragment: {
        module: voxModule,
        // no color is written; the attachment only exists because WebGPU render
        // passes need one. Godot uses a real (unwritten) 3-axis framebuffer too.
        targets: [{ format: 'rgba8unorm', writeMask: 0 }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    const preModule = device.createShaderModule({ label: 'sdfgi prepass', code: APPLY.PREPASS });
    this.pPrepass = device.createRenderPipeline({
      label: 'sdfgi prepass',
      layout: 'auto',
      vertex: { module: preModule, buffers: [VERTEX_LAYOUT] },
      fragment: {
        module: preModule,
        targets: [{ format: 'rgba8unorm' }, { format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });

    const compModule = device.createShaderModule({
      label: 'sdfgi composite',
      code: APPLY.composite(this.options.linearOutput),
    });
    this.pComposite = device.createRenderPipeline({
      label: 'sdfgi composite',
      layout: 'auto',
      vertex: { module: compModule },
      fragment: {
        module: compModule,
        targets: [
          {
            format: this.canvasFormat,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
    });

    const blitModule = device.createShaderModule({ label: 'sdfgi blit', code: BLIT });
    this.pBlit = device.createRenderPipeline({
      label: 'sdfgi blit',
      layout: 'auto',
      vertex: { module: blitModule },
      fragment: { module: blitModule, targets: [{ format: this.canvasFormat }] },
    });

    const probeModule = device.createShaderModule({ label: 'sdfgi debug probes', code: DEBUG.DEBUG_PROBES });
    this.pProbes = device.createRenderPipeline({
      label: 'sdfgi debug probes',
      layout: 'auto',
      vertex: { module: probeModule },
      fragment: { module: probeModule, targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-strip', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });

    const visModule = device.createShaderModule({
      label: 'sdfgi debug probe visibility',
      code: DEBUG.DEBUG_PROBE_VISIBILITY,
    });
    this.pProbeVis = device.createRenderPipeline({
      label: 'sdfgi debug probe visibility',
      layout: 'auto',
      vertex: { module: visModule },
      fragment: { module: visModule, targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-strip', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });

    // ---- cascade resources (gi.cpp SDFGI::create) ----
    let baseCellSize = this.options.minCellSize;
    for (let i = 0; i < N; i++) {
      this.cascades.push(this.createCascade(baseCellSize, historyBytes, averageBytes));
      baseCellSize *= 2;
    }

    // ---- shared bind groups ----
    const jfa0 = this.renderSdf[0].createView();
    const jfa1 = this.renderSdf[1].createView();
    const half0 = this.renderSdfHalf[0].createView();
    const half1 = this.renderSdfHalf[1].createView();

    this.bgJfaInitHalf = this.bg(this.pJfaInitHalf, 0, {
      1: { buffer: this.renderAlbedo },
      2: half0,
    });
    // layout:'auto' layouts are per-pipeline, so the plain and optimized JFA
    // passes each need their own groups over the same two textures.
    this.bgJfaHalf = [
      this.bg(this.pJfa, 0, { 1: half0, 2: half1 }),
      this.bg(this.pJfa, 0, { 1: half1, 2: half0 }),
    ];
    this.bgJfaOptHalf = [
      this.bg(this.pJfaOpt, 0, { 1: half0, 2: half1 }),
      this.bg(this.pJfaOpt, 0, { 1: half1, 2: half0 }),
    ];
    this.bgJfaUpscale = [
      this.bg(this.pJfaUpscale, 0, { 1: { buffer: this.renderAlbedo }, 2: half0, 3: jfa0 }),
      this.bg(this.pJfaUpscale, 0, { 1: { buffer: this.renderAlbedo }, 2: half1, 3: jfa0 }),
    ];
    this.bgJfaFull = this.bg(this.pJfaOpt, 0, { 1: jfa0, 2: jfa1 });
    // every binding of the ray pass is cascade-independent (the cascade index
    // rides in the params slot), so one group serves all of them
    this.bgIntegrateRays = this.bg(this.pIntegrateRays, 0, {
      1: this.sdfTex.createView(),
      2: this.lightTex.createView(),
      3: this.aniso0Tex.createView(),
      4: this.aniso1Tex.createView(),
      6: this.sampLinear,
      7: { buffer: this.cascadesUbo },
      15: this.skyTex.createView(),
      16: this.sampMip,
      18: { buffer: this.rayLight },
    });
    this.bgOcclusion = this.bg(this.pOcclusion, 0, {
      2: { buffer: this.renderOcclusion },
      3: { buffer: this.renderFacing },
    });
    this.bgScrollOcc = this.bg(this.pScrollOcc, 0, {
      1: { buffer: this.renderOcclusion },
      2: this.occlusionTex.createView(),
    });
    this.bgVoxelize = this.bg(this.pVoxelize, 0, {
      0: { buffer: this.renderAlbedo },
      1: { buffer: this.renderFacing },
      2: { buffer: this.renderEmission },
      3: { buffer: this.renderEmissionAniso },
    });
    this.bgProbes = this.bg(this.pProbes, 0, {
      1: { buffer: this.cascadesUbo },
      2: this.lightprobeTex.createView(),
      3: this.sampLinear,
      5: { buffer: this.probeVpUbo },
    });
    this.bgProbeVis = this.bg(this.pProbeVis, 0, {
      1: { buffer: this.cascadesUbo },
      4: this.occlusionTex.createView(),
      5: { buffer: this.probeVpUbo },
    });

    this.resize();
  }

  // ------------------------------------------------------------------
  // resources
  // ------------------------------------------------------------------

  private bg(p: Pipelineish, group: number, entries: Res): GPUBindGroup {
    return this.device.createBindGroup({
      label: `${(p as Partial<GPUObjectBase>).label || 'bg'} @group(${group})`,
      layout: p.getBindGroupLayout(group),
      entries: Object.entries(entries).map(([binding, resource]) => ({
        binding: Number(binding),
        resource,
      })),
    });
  }

  private createCascade(cellSize: number, historyBytes: number, averageBytes: number): Cascade {
    const device = this.device;
    const solidCells = storageBuffer(device, 'sdfgi solid cells', SOLID_CELLS * 16);
    const dispatchStorage = storageBuffer(device, 'sdfgi dispatch storage', 16);
    const dispatchCall = device.createBuffer({
      label: 'sdfgi dispatch call',
      size: 16,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
    const lightsDynamic = storageBuffer(device, 'sdfgi dynamic lights', MAX_DYNAMIC_LIGHTS * 64);
    const lightsStatic = storageBuffer(device, 'sdfgi static lights', MAX_STATIC_LIGHTS * 64);
    const history = storageBuffer(device, 'sdfgi probe history', historyBytes);
    const average = storageBuffer(device, 'sdfgi probe average', averageBytes);
    const averageFiltered = storageBuffer(device, 'sdfgi probe average filtered', averageBytes);

    const c: Cascade = {
      cellSize,
      position: new THREE.Vector3(),
      dirty: new THREE.Vector3(),
      dirtyAll: true,
      queued: false,
      queuedPos: new THREE.Vector3(),
      queuedDirty: new THREE.Vector3(),
      queuedDirtyAll: false,
      allDynamicLightsDirty: true,
      solidCells,
      dispatchStorage,
      dispatchCall,
      lightsDynamic,
      lightsStatic,
      history,
      average,
      averageFiltered,
      bgScroll: undefined!,
      bgStore: undefined!,
      bgDirectDynamic: undefined!,
      bgDirectStatic: undefined!,
      bgIntegrate: undefined!,
      bgIntegrateFilter: undefined!,
      bgIntegrateStore: undefined!,
      bgIntegrateScroll: undefined!,
      bgIntegrateScrollStore: undefined!,
    };

    c.bgScroll = this.bg(this.pScroll, 0, {
      1: { buffer: this.renderAlbedo },
      2: { buffer: this.renderFacing },
      3: { buffer: this.renderEmission },
      4: { buffer: this.renderEmissionAniso },
      5: { buffer: dispatchStorage },
      6: { buffer: solidCells },
    });
    c.bgStore = this.bg(this.pStore, 0, {
      1: this.renderSdf[1].createView(),
      2: { buffer: this.renderAlbedo },
      3: { buffer: this.renderOcclusion },
      4: { buffer: this.renderEmission },
      5: { buffer: this.renderEmissionAniso },
      6: { buffer: this.renderFacing },
      7: this.sdfTex.createView(),
      8: this.occlusionTex.createView(),
      10: { buffer: dispatchStorage },
      11: { buffer: solidCells },
    });
    c.bgDirectDynamic = this.bg(this.pDirectDyn, 0, {
      1: this.sdfTex.createView(),
      2: this.sampLinear,
      4: { buffer: dispatchStorage },
      5: { buffer: solidCells },
      6: this.lightTex.createView(),
      7: this.aniso0Tex.createView(),
      8: this.aniso1Tex.createView(),
      9: { buffer: this.cascadesUbo },
      10: { buffer: lightsDynamic },
      11: this.lightprobeTex.createView(),
      12: this.occlusionTex.createView(),
    });
    // static drops the bounce-feedback probe reads, so its auto layout has no 11/12
    c.bgDirectStatic = this.bg(this.pDirectStat, 0, {
      1: this.sdfTex.createView(),
      2: this.sampLinear,
      4: { buffer: dispatchStorage },
      5: { buffer: solidCells },
      9: { buffer: this.cascadesUbo },
      10: { buffer: lightsStatic },
    });
    c.bgIntegrate = this.bg(this.pIntegrate, 0, {
      9: { buffer: history },
      10: { buffer: average },
      14: this.ambientTex.createView(),
      18: { buffer: this.rayLight },
    });
    c.bgIntegrateFilter = this.bg(this.pIntegrateFilter, 0, {
      10: { buffer: average },
      17: { buffer: averageFiltered },
    });
    c.bgIntegrateStore = this.bg(this.pIntegrateStore, 0, {
      8: this.lightprobeTex.createView(),
      10: { buffer: averageFiltered },
    });
    c.bgIntegrateScrollStore = this.bg(this.pIntegrateScrollStore, 0, {
      9: { buffer: history },
      10: { buffer: average },
      11: { buffer: this.historyScroll },
      12: { buffer: this.averageScroll },
    });
    return c;
  }

  /** SCROLL needs the *parent* cascade's average, so it is wired after all exist. */
  private wireScrollGroups(): void {
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      const parent = this.cascades[Math.min(i + 1, this.cascades.length - 1)];
      c.bgIntegrateScroll = this.bg(this.pIntegrateScroll, 0, {
        7: { buffer: this.cascadesUbo },
        9: { buffer: c.history },
        10: { buffer: c.average },
        11: { buffer: this.historyScroll },
        12: { buffer: this.averageScroll },
        13: { buffer: parent.average },
      });
    }
  }

  private resize(): void {
    const size = this.renderer.getDrawingBufferSize(this.vSize);
    const w = Math.max(1, Math.floor(size.x));
    const h = Math.max(1, Math.floor(size.y));
    const scale = this.options.halfResolution ? 2 : 1;
    if (w === this.width && h === this.height && scale === this.giScale) return;
    this.width = w;
    this.height = h;
    this.giScale = scale;
    // gi.cpp: only the ambient/reflection buffers shrink; depth/normal stay full res
    const gw = Math.max(1, w >> (scale - 1));
    const gh = Math.max(1, h >> (scale - 1));

    this.albedoTex?.destroy();
    this.normalTex?.destroy();
    this.depthTex?.destroy();
    this.ambientBuf?.destroy();
    this.reflectionBuf?.destroy();
    this.debugTex?.destroy();

    const device = this.device;
    const att = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.albedoTex = device.createTexture({ label: 'sdfgi albedo', size: [w, h], format: 'rgba8unorm', usage: att });
    this.normalTex = device.createTexture({ label: 'sdfgi normal', size: [w, h], format: 'rgba8unorm', usage: att });
    this.depthTex = device.createTexture({ label: 'sdfgi depth', size: [w, h], format: 'depth32float', usage: att });
    this.albedoView = this.albedoTex.createView();
    this.normalView = this.normalTex.createView();
    this.depthView = this.depthTex.createView();
    const st = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this.ambientBuf = device.createTexture({ label: 'sdfgi ambient', size: [gw, gh], format: 'rgba16float', usage: st });
    this.reflectionBuf = device.createTexture({
      label: 'sdfgi reflection',
      size: [gw, gh],
      format: 'rgba16float',
      usage: st,
    });
    this.debugTex = device.createTexture({ label: 'sdfgi debug', size: [w, h], format: 'rgba16float', usage: st });

    this.bgGi = this.bg(this.pGi, 0, {
      1: this.sdfTex.createView(),
      2: this.lightTex.createView(),
      5: this.occlusionTex.createView(),
      6: this.sampLinear,
      9: this.ambientBuf.createView(),
      10: this.reflectionBuf.createView(),
      11: this.lightprobeTex.createView(),
      12: this.depthView,
      13: this.normalView,
      15: { buffer: this.sdfgiUbo },
    });
    this.bgComposite = this.bg(this.pComposite, 0, {
      0: this.albedoView,
      1: this.ambientBuf.createView(),
      2: this.reflectionBuf.createView(),
      3: this.normalView,
      4: this.sampLinear,
    });
    this.bgDebugSdf = this.bg(this.pDebugSdf, 0, {
      1: this.sdfTex.createView(),
      2: this.lightTex.createView(),
      3: this.aniso0Tex.createView(),
      4: this.aniso1Tex.createView(),
      8: this.sampLinear,
      9: { buffer: this.cascadesUbo },
      10: this.debugTex.createView(),
    });
    this.bgBlit = this.bg(this.pBlit, 0, { 0: this.debugTex.createView() });
  }

  /**
   * Snapshot the scene geometry the voxelizer and the G-buffer prepass draw.
   * Call again when meshes are added, removed or moved.
   */
  setScene(scene: THREE.Object3D): void {
    this.extracted?.dispose();
    this.scene = scene;
    const ex = extractScene(this.device, scene);
    this.extracted = ex;

    this.drawBgs = [[], []];
    this.texBgs = [[], []];
    const pipes = [this.pVoxelize, this.pPrepass];
    for (let p = 0; p < 2; p++) {
      for (const d of ex.draws) {
        this.drawBgs[p][d.slot] = this.bg(pipes[p], 2, {
          0: { buffer: ex.drawBuffer, offset: d.slot * DRAW_STRIDE, size: DRAW_STRIDE },
        });
        this.texBgs[p][d.slot] = this.bg(pipes[p], 3, {
          0: d.texture.createView(),
          1: this.sampRepeat,
        });
      }
    }
    // everything voxelized before is stale
    for (const c of this.cascades) {
      c.dirtyAll = true;
      c.dirty.set(0, 0, 0);
    }
    this.firstFrame = true;
    this.wireScrollGroups();
  }

  // ------------------------------------------------------------------
  // GI::SDFGI::update()
  // ------------------------------------------------------------------

  private update(worldPosition: THREE.Vector3): void {
    // Godot uses PROBE_CELLS/2 == 4. The rebuild a scroll triggers costs the
    // same whatever the scroll distance is (the jump flood is whole-volume), so
    // doubling the margin halves the rebuild rate for nothing but a thicker
    // voxelize slab -- and the scroll stays a whole number of probes either way.
    const dragMargin = PROBE_CELLS;
    const wy = worldPosition.y * this.yMult;

    for (const c of this.cascades) {
      // A queued cascade keeps its old position on purpose: the cascades UBO is
      // written every frame, so moving it before the volume has scrolled would
      // sample the light/SDF volume at coordinates its contents are not at yet.
      if (c.queued) continue;

      const posInCascade = [
        Math.trunc(worldPosition.x / c.cellSize),
        Math.trunc(wy / c.cellSize),
        Math.trunc(worldPosition.z / c.cellSize),
      ];
      const pos = [c.position.x, c.position.y, c.position.z];
      const dirty = [0, 0, 0];
      let dirtyAll = false;

      for (let j = 0; j < 3; j++) {
        if (posInCascade[j] < pos[j]) {
          while (posInCascade[j] < pos[j] - dragMargin) {
            pos[j] -= dragMargin * 2;
            dirty[j] += dragMargin * 2;
          }
        } else if (posInCascade[j] > pos[j]) {
          while (posInCascade[j] > pos[j] + dragMargin) {
            pos[j] += dragMargin * 2;
            dirty[j] -= dragMargin * 2;
          }
        }
        if (dirty[j] === 0) continue;
        if (Math.abs(dirty[j]) >= G) {
          dirtyAll = true;
          break;
        }
      }

      if (!dirtyAll && dirty[0] === 0 && dirty[1] === 0 && dirty[2] === 0) continue;

      if (!dirtyAll) {
        let safe = 1;
        for (let j = 0; j < 3; j++) safe *= G - Math.abs(dirty[j]);
        if (CELLS - safe > safe / 2) dirtyAll = true;
      }

      c.queued = true;
      c.queuedPos.set(pos[0], pos[1], pos[2]);
      c.queuedDirtyAll = dirtyAll;
      c.queuedDirty.set(dirty[0], dirty[1], dirty[2]);
      if (dirtyAll) c.queuedDirty.set(0, 0, 0);
    }
  }

  /**
   * Commit at most one queued cascade, at most every `scrollInterval` frames.
   *
   * A cascade that scrolls pays a whole-volume rebuild in preprocessCascade()
   * (128^3 jump flood + occlusion + store + three 128^3 clears), so four of them
   * landing on the same frame is the camera-move stall. Round-robin, because
   * cascade 0 scrolls often enough to starve the coarse ones; and spaced out,
   * because back-to-back rebuild frames are what halves the frame rate while
   * the camera keeps moving. A held-back cascade just stays off-centre for a
   * few more frames -- it has PROBE_CELLS*2 cells of slack before it has to.
   */
  private dequeueCascade(): void {
    if (this.frame - this.lastScrollFrame < this.options.scrollInterval) return;
    const n = this.cascades.length;
    for (let k = 0; k < n; k++) {
      const i = (this.serveCursor + k) % n;
      const c = this.cascades[i];
      if (!c.queued) continue;
      c.position.copy(c.queuedPos);
      c.dirty.copy(c.queuedDirty);
      c.dirtyAll = c.queuedDirtyAll;
      c.queued = false;
      this.serveCursor = (i + 1) % n;
      this.lastScrollFrame = this.frame;
      return;
    }
  }

  /**
   * create()'s initial cascade placement: snap to the probe grid around the camera.
   *
   * Only cascade 0 builds on this frame; the rest queue and are served one per
   * frame by dequeueCascade(), same as a scroll. Building all N at once is a
   * multi-hundred-ms stall on the first frame after create/setScene. The cost is
   * N-1 frames of missing GI in the coarse cascades, which the probe history
   * would have needed anyway.
   */
  private placeCascades(worldPosition: THREE.Vector3): void {
    const wy = worldPosition.y * this.yMult;
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      const probeSize = c.cellSize * PROBE_CELLS;
      c.position.set(
        Math.floor(worldPosition.x / probeSize + 0.5) * PROBE_CELLS,
        Math.floor(wy / probeSize + 0.5) * PROBE_CELLS,
        Math.floor(worldPosition.z / probeSize + 0.5) * PROBE_CELLS,
      );
      c.dirty.set(0, 0, 0);
      c.dirtyAll = i === 0;
      c.queued = i !== 0;
      c.queuedPos.copy(c.position);
      c.queuedDirty.set(0, 0, 0);
      c.queuedDirtyAll = i !== 0;
    }
    this.serveCursor = 1 % this.cascades.length;
  }

  // ------------------------------------------------------------------
  // GI::SDFGI::get_pending_region_data()
  // ------------------------------------------------------------------

  private pendingRegion(index: number): Region | null {
    if (index < 0) return null;
    let count = 0;
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      if (c.dirtyAll) {
        if (count === index) return this.makeRegion(i, [0, 0, 0], [G, G, G]);
        count++;
        continue;
      }
      const d = [c.dirty.x, c.dirty.y, c.dirty.z];
      for (let j = 0; j < 3; j++) {
        if (d[j] === 0) continue;
        if (count === index) {
          const from = [0, 0, 0];
          const to = [G, G, G];
          if (d[j] > 0) to[j] = d[j];
          else from[j] = to[j] + d[j];
          for (let k = 0; k < j; k++) {
            // "chip away" already-covered slabs so nothing is voxelized twice
            if (d[k] > 0) from[k] += d[k];
            else if (d[k] < 0) to[k] += d[k];
          }
          return this.makeRegion(i, from, [to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
        }
        count++;
      }
    }
    return null;
  }

  private pendingRegionCount(): number {
    let count = 0;
    for (const c of this.cascades) {
      if (c.dirtyAll) count++;
      else count += (c.dirty.x !== 0 ? 1 : 0) + (c.dirty.y !== 0 ? 1 : 0) + (c.dirty.z !== 0 ? 1 : 0);
    }
    return count;
  }

  private makeRegion(cascade: number, from: number[], size: number[]): Region {
    const c = this.cascades[cascade];
    const half = G >> 1;
    const inv = 1 / this.yMult;
    return {
      cascade,
      from: new THREE.Vector3(from[0], from[1], from[2]),
      size: new THREE.Vector3(size[0], size[1], size[2]),
      boundsMin: new THREE.Vector3(
        (from[0] - half + c.position.x) * c.cellSize,
        (from[1] - half + c.position.y) * c.cellSize * inv,
        (from[2] - half + c.position.z) * c.cellSize,
      ),
      boundsSize: new THREE.Vector3(
        size[0] * c.cellSize,
        size[1] * c.cellSize * inv,
        size[2] * c.cellSize,
      ),
    };
  }

  // ------------------------------------------------------------------
  // per-frame entry point
  // ------------------------------------------------------------------

  /**
   * Records and submits the whole SDFGI frame, then composites onto the canvas.
   * Call after `renderer.renderAsync(scene, camera)`.
   */
  render(camera: THREE.Camera): void {
    if (!this.extracted || !this.scene) throw new Error('sdfgi: call setScene() first');
    // Before anything reads the draw buffer: a mesh that moved since the
    // snapshot would otherwise be voxelized and G-buffered at its old pose.
    // The refresh is our own rather than three's, because a caller that skips
    // renderer.render() for a frame still has to get the right answer.
    this.scene.updateMatrixWorld();
    this.extracted.syncTransforms();
    this.resize();
    camera.updateMatrixWorld();
    const camPos = this.camPos.setFromMatrixPosition(camera.matrixWorld);

    if (this.firstFrame) {
      this.placeCascades(camPos);
      this.firstFrame = false;
    } else {
      this.update(camPos);
      this.dequeueCascade();
    }

    this.pool.begin();
    const enc = this.device.createCommandEncoder({ label: 'sdfgi' });

    this.writeCascadesUbo();
    this.renderPendingRegions(enc);
    for (const c of this.cascades) {
      c.dirtyAll = false;
      c.dirty.set(0, 0, 0);
    }

    this.writeSdfgiUbo(camPos);
    this.updateLight(enc);
    this.updateProbes(enc);
    this.storeProbes(enc);

    this.prepass(enc, camera);
    this.applyGi(enc, camera);
    this.present(enc, camera);

    this.profiler.finish(enc);
    // one upload for every push-constant slot this frame, instead of one each
    this.pool.flush();
    this.device.queue.submit([enc.finish()]);
    this.frame++;
  }

  // ------------------------------------------------------------------
  // region rendering (GI::SDFGI::render_region)
  // ------------------------------------------------------------------

  private renderPendingRegions(enc: GPUCommandEncoder): void {
    const total = this.pendingRegionCount();
    if (total === 0) return;
    // dequeueCascade() serves one cascade per frame, so `total` is that
    // cascade's 1..3 slabs -- except on the first frame after create/setScene,
    // where every cascade is dirtyAll and the whole build lands at once.
    let staticLights = false;
    for (let r = 0; r < total; r++) {
      const cur = this.pendingRegion(r);
      if (!cur) break;
      const prev = this.pendingRegion(r - 1);
      const next = this.pendingRegion(r + 1);

      if (!prev || prev.cascade !== cur.cascade) {
        enc.clearBuffer(this.renderAlbedo);
        enc.clearBuffer(this.renderFacing);
        enc.clearBuffer(this.renderEmission);
        enc.clearBuffer(this.renderEmissionAniso);
      }

      this.voxelize(enc, cur);

      if (!next || next.cascade !== cur.cascade) {
        this.preprocessCascade(enc, cur.cascade);
        staticLights = true;
      }
    }
    if (staticLights) this.renderStaticLights(enc);
  }

  private voxelize(enc: GPUCommandEncoder, region: Region): void {
    const draws = this.extracted!.draws;
    const bmin = region.boundsMin;
    const bsize = region.boundsSize;
    const bmax = this.vTmp2.copy(bmin).add(bsize);
    const view = this.mTmp;
    const proj = this.mTmp2;
    const dummy = this.voxelDummyView;

    // world -> [0,1]^3 inside the region bounds
    const sdfToBounds = new THREE.Matrix4()
      .makeScale(1 / bsize.x, 1 / bsize.y, 1 / bsize.z)
      .multiply(new THREE.Matrix4().makeTranslation(-bmin.x, -bmin.y, -bmin.z));

    const axes = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
    ];
    const sizeArr = [bsize.x, bsize.y, bsize.z];
    const regionSize = [region.size.x, region.size.y, region.size.z];

    for (let axis = 0; axis < 3; axis++) {
      const right = (axis + 1) % 3;
      const up = (axis + 2) % 3;
      const w = regionSize[right];
      const h = regionSize[up];
      if (w <= 0 || h <= 0 || sizeArr[axis] <= 0) continue;

      const origin = bmin.clone().addScaledVector(bsize, 0.5);
      origin.setComponent(axis, origin.getComponent(axis) + sizeArr[axis] * 0.5);
      view
        .makeBasis(axes[right], axes[up], axes[axis])
        .setPosition(origin)
        .invert();

      // ortho, WebGPU depth [0,1], near 0 far = extent along `axis`
      proj.set(
        2 / sizeArr[right], 0, 0, 0,
        0, 2 / sizeArr[up], 0, 0,
        0, 0, -1 / sizeArr[axis], 0,
        0, 0, 0, 1,
      );
      proj.multiply(view);

      const params = this.pool.push(this.pVoxelize, (wr) => {
        for (const e of proj.elements) wr.f32(e);
        for (const e of sdfToBounds.elements) wr.f32(e);
        wr.i3(region.from.x, region.from.y, region.from.z).pad();
        wr.i3(region.size.x, region.size.y, region.size.z).pad();
      });

      const pass = enc.beginRenderPass({
        label: `sdfgi voxelize axis ${axis}`,
        colorAttachments: [{ view: dummy, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'discard' }],
      });
      pass.setViewport(0, 0, w, h, 0, 1);
      pass.setPipeline(this.pVoxelize);
      pass.setBindGroup(0, this.bgVoxelize);
      pass.setBindGroup(1, params);
      for (const d of draws) {
        if (d.max.x < bmin.x || d.min.x > bmax.x) continue;
        if (d.max.y < bmin.y || d.min.y > bmax.y) continue;
        if (d.max.z < bmin.z || d.min.z > bmax.z) continue;
        pass.setBindGroup(2, this.drawBgs[0][d.slot]);
        pass.setBindGroup(3, this.texBgs[0][d.slot]);
        pass.setVertexBuffer(0, d.vertices);
        if (d.indices) {
          pass.setIndexBuffer(d.indices, 'uint32');
          pass.drawIndexed(d.count);
        } else {
          pass.draw(d.count);
        }
      }
      pass.end();
    }
  }

  /** the scroll + JFA + occlusion + store chain at the tail of render_region() */
  private preprocessCascade(enc: GPUCommandEncoder, cascade: number): void {
    const c = this.cascades[cascade];
    const scroll = c.dirtyAll ? [0, 0, 0] : [c.dirty.x, c.dirty.y, c.dirty.z];
    // `grid` mirrors gi.cpp's `push_constant.grid_size >>= 1` around the half-res
    // jump flood passes; `half` is push_constant.half_size (set one pass later).
    const pre = (
      w: W,
      o: Partial<{ step: number; half: number; grid: number; occIndex: number; probe: number[] }> = {},
    ) => {
      w.i3(scroll[0], scroll[1], scroll[2]).i32(o.grid ?? G);
      const p = o.probe ?? [0, 0, 0];
      w.i3(p[0], p[1], p[2]).i32(o.step ?? 0);
      w.u32(o.half ?? 0).u32(o.occIndex ?? 0).i32(cascade).pad();
    };

    c.allDynamicLightsDirty = true;

    if (!c.dirtyAll) {
      enc.copyBufferToBuffer(c.dispatchStorage, 0, c.dispatchCall, 0, 16);
      const p = enc.beginComputePass({ label: 'sdfgi scroll' });
      p.setPipeline(this.pScroll);
      p.setBindGroup(0, c.bgScroll);
      p.setBindGroup(1, this.pool.push(this.pScroll, (w) => pre(w)));
      p.dispatchWorkgroupsIndirect(c.dispatchCall, 0);

      if (this.options.useOcclusion) {
        p.setPipeline(this.pScrollOcc);
        p.setBindGroup(0, this.bgScrollOcc);
        p.setBindGroup(1, this.pool.push(this.pScrollOcc, (w) => pre(w)));
        p.dispatchWorkgroups(
          Math.ceil((G - Math.abs(scroll[0])) / 64),
          G - Math.abs(scroll[1]),
          G - Math.abs(scroll[2]),
        );
      }

      // probe history scroll (integrate MODE_SCROLL / MODE_SCROLL_STORE)
      const probeScroll = scroll.map((v) => v / PROBE_CELLS);
      const gx = Math.ceil(PROBE_IMAGE_W / 8);
      const gy = Math.ceil(PROBE_IMAGE_H / 8);
      const fill = (imgW: number, imgH: number) => (w: W) =>
        this.integrateParams(w, {
          cascade,
          imageSize: [imgW, imgH],
          scroll: probeScroll,
          historyIndex: 0,
          rayCount: 0,
          skyFlags: 0,
        });
      p.setPipeline(this.pIntegrateScroll);
      p.setBindGroup(0, c.bgIntegrateScroll);
      p.setBindGroup(1, this.pool.push(this.pIntegrateScroll, fill(PROBE_IMAGE_W, PROBE_IMAGE_H)));
      p.dispatchWorkgroups(gx, gy, 1);

      p.setPipeline(this.pIntegrateScrollStore);
      p.setBindGroup(0, c.bgIntegrateScrollStore);
      p.setBindGroup(1, this.pool.push(this.pIntegrateScrollStore, fill(PROBE_IMAGE_W, PROBE_IMAGE_H)));
      p.dispatchWorkgroups(gx, gy, 1);

      if (this.options.bounceFeedback > 0) {
        p.setPipeline(this.pIntegrateStore);
        p.setBindGroup(0, c.bgIntegrateStore);
        p.setBindGroup(1, this.pool.push(this.pIntegrateStore, fill(PROBE_IMAGE_W * OCT, PROBE_IMAGE_H * OCT)));
        p.dispatchWorkgroups(Math.ceil((PROBE_IMAGE_W * OCT) / 8), Math.ceil((PROBE_IMAGE_H * OCT) / 8), 1);
      }
      p.end();
    }

    enc.clearBuffer(c.dispatchStorage, 0, 16);

    // the scroll spike lives here: jfa + occlusion + store, once per scroll
    const p = enc.beginComputePass({ label: 'sdfgi jfa', ...this.profiler.pass('rebuild') });

    // half-resolution seed
    p.setPipeline(this.pJfaInitHalf);
    p.setBindGroup(0, this.bgJfaInitHalf);
    const half = G / 2;
    p.setBindGroup(1, this.pool.push(this.pJfaInitHalf, (w) => pre(w, { grid: half })));
    p.dispatchWorkgroups(G / 8, G / 8, G / 8); // 64^3 threads, 4^3 group

    let s = half;
    let jf = 0;
    p.setPipeline(this.pJfa);
    while (s > 1) {
      s >>= 1;
      p.setBindGroup(0, this.bgJfaHalf[jf]);
      p.setBindGroup(1, this.pool.push(this.pJfa, (w) => pre(w, { step: s, half: 1, grid: half })));
      p.dispatchWorkgroups(half / 4, half / 4, half / 4);
      jf ^= 1;
      if (s <= 1 || Math.floor(half / (s >> 1)) >= 8) break;
    }
    const optDiv = this.jfaOptimized ? 8 : 4;
    p.setPipeline(this.pJfaOpt);
    while (s > 1) {
      s >>= 1;
      p.setBindGroup(0, this.bgJfaOptHalf[jf]);
      p.setBindGroup(1, this.pool.push(this.pJfaOpt, (w) => pre(w, { step: s, half: 1, grid: half })));
      p.dispatchWorkgroups(half / optDiv, half / optDiv, half / optDiv);
      jf ^= 1;
    }

    // upscale to full res, then one optimized fixup pass at step 1
    p.setPipeline(this.pJfaUpscale);
    p.setBindGroup(0, this.bgJfaUpscale[jf]);
    p.setBindGroup(1, this.pool.push(this.pJfaUpscale, (w) => pre(w)));
    p.dispatchWorkgroups(G / 4, G / 4, G / 4);

    p.setPipeline(this.pJfaOpt);
    p.setBindGroup(0, this.bgJfaFull);
    p.setBindGroup(1, this.pool.push(this.pJfaOpt, (w) => pre(w, { step: 1, half: 0 })));
    p.dispatchWorkgroups(G / optDiv, G / optDiv, G / optDiv);

    if (this.options.useOcclusion) {
      // gi.cpp: probe_size = cascade_size / PROBE_DIVISOR (== PROBE_CELLS == 8),
      // one workgroup per 2x2x2 occlusion region, hence probe_size + 1 groups.
      const probeSize = PROBE_CELLS;
      const gp = [
        Math.trunc(c.position.x / probeSize),
        Math.trunc(c.position.y / probeSize),
        Math.trunc(c.position.z / probeSize),
      ];
      p.setPipeline(this.pOcclusion);
      p.setBindGroup(0, this.bgOcclusion);
      for (let i = 0; i < 8; i++) {
        const offset = [i & 1, (i >> 1) & 1, (i >> 2) & 1];
        for (let j = 0; j < 3; j++) if (gp[j] & 1) offset[j] = 1 - offset[j];
        p.setBindGroup(
          1,
          this.pool.push(this.pOcclusion, (w) => pre(w, { occIndex: i, probe: offset })),
        );
        p.dispatchWorkgroups(probeSize + 1 - offset[0], probeSize + 1 - offset[1], probeSize + 1 - offset[2]);
      }
    }

    p.setPipeline(this.pStore);
    p.setBindGroup(0, c.bgStore);
    p.setBindGroup(1, this.pool.push(this.pStore, (w) => pre(w)));
    p.dispatchWorkgroups(G / 4, G / 4, G / 4);
    p.end();

    // light for this cascade is invalid until the direct pass reruns
    const z = cascade * G;
    this.zero.clearTexture3D(enc, this.lightTex, 8, { z }, [G, G, G]);
    this.zero.clearTexture3D(enc, this.aniso0Tex, 4, { z }, [G, G, G]);
    this.zero.clearTexture3D(enc, this.aniso1Tex, 4, { z }, [G, G, G]);
  }

  // ------------------------------------------------------------------
  // lights
  // ------------------------------------------------------------------

  /** ponytail: one reusable array -- the caller must be done before calling again. */
  private lightList: THREE.Light[] = [];

  private collectLights(isStatic: boolean): THREE.Light[] {
    const out = this.lightList;
    out.length = 0;
    this.scene!.traverse((o) => {
      const l = o as THREE.Light;
      if (!l.isLight || !l.visible) return;
      if (!((l as THREE.DirectionalLight).isDirectionalLight ||
        (l as THREE.PointLight).isPointLight ||
        (l as THREE.SpotLight).isSpotLight)) return;
      if (!!l.userData.sdfgiStatic === isStatic) out.push(l);
    });
    return out;
  }

  /**
   * pre_process_gi()'s light packing. The 64-byte record is the same for every
   * cascade -- only which lights survive the AABB cull differs -- so it is built
   * once here and the per-cascade pass below just compacts it. getWorldPosition()
   * re-walks the light's ancestor chain, which is what made doing this per
   * cascade expensive.
   */
  private prepareLights(lights: THREE.Light[]): void {
    const w = this.lightW;
    const pos = this.lTmp;
    const dir = this.lDir;
    let count = 0;

    for (const l of lights) {
      if (count >= MAX_STATIC_LIGHTS) break;
      const type = (l as THREE.DirectionalLight).isDirectionalLight
        ? LIGHT_TYPE_DIRECTIONAL
        : (l as THREE.SpotLight).isSpotLight
          ? LIGHT_TYPE_SPOT
          : LIGHT_TYPE_OMNI;
      const dl = l as THREE.DirectionalLight & THREE.SpotLight & THREE.PointLight;
      l.getWorldPosition(pos);
      const radius = dl.distance > 0 ? dl.distance : 10;

      if (type === LIGHT_TYPE_DIRECTIONAL) {
        dl.target.getWorldPosition(dir).sub(pos).normalize();
        dir.y *= this.yMult;
        dir.normalize();
        this.lightCull[count * 4 + 3] = -1; // never culled
      } else {
        // positional direction stays unscaled; only the position is y-scaled
        if (type === LIGHT_TYPE_SPOT) dl.target.getWorldPosition(dir).sub(pos).normalize();
        else dir.set(0, 0, -1);
        pos.y *= this.yMult;
        this.lightCull[count * 4 + 0] = pos.x;
        this.lightCull[count * 4 + 1] = pos.y;
        this.lightCull[count * 4 + 2] = pos.z;
        this.lightCull[count * 4 + 3] = radius;
      }

      w.seek(count * 64);
      w.f3(l.color.r, l.color.g, l.color.b).f32(l.intensity);
      w.f3(dir.x, dir.y, dir.z).u32(0); // has_shadow: SDFGI raymarches its own SDF
      w.f3(pos.x, pos.y, pos.z).f32(dl.decay ?? 2);
      w.u32(type);
      // ponytail: three.js penumbra is not mapped; Godot's inv_spot_attenuation
      // comes from spot_angle_attenuation. 1.0 == linear rim falloff.
      w.f32(type === LIGHT_TYPE_SPOT ? Math.cos(dl.angle) : 0);
      w.f32(1.0);
      w.f32(radius);
      count++;
    }
    this.lightPrepared = count;
  }

  /** Cull the prepared records against one cascade's AABB and upload them. */
  private writeLights(buf: GPUBuffer, cascade: number, max: number): number {
    const c = this.cascades[cascade];
    const half = G >> 1;
    const minX = (-half + c.position.x) * c.cellSize;
    const minY = (-half + c.position.y) * c.cellSize;
    const minZ = (-half + c.position.z) * c.cellSize;
    const extent = G * c.cellSize;
    const cull = this.lightCull;
    let count = 0;

    for (let i = 0; i < this.lightPrepared && count < max; i++) {
      const radius = cull[i * 4 + 3];
      if (radius >= 0) {
        const x = cull[i * 4 + 0];
        const y = cull[i * 4 + 1];
        const z = cull[i * 4 + 2];
        if (x + radius < minX || x - radius > minX + extent) continue;
        if (y + radius < minY || y - radius > minY + extent) continue;
        if (z + radius < minZ || z - radius > minZ + extent) continue;
      }
      const src = i * 16;
      const dst = count * 16;
      for (let k = 0; k < 16; k++) this.scratchU32[dst + k] = this.lightU32[src + k];
      count++;
    }
    if (count > 0) this.device.queue.writeBuffer(buf, 0, this.scratch, 0, count * 64);
    return count;
  }

  private directParams(cascade: number, lightCount: number, offset: number, increment: number, bounce: number) {
    return (w: W) => {
      w.f3(G, G, G).u32(this.numCascades);
      w.u32(cascade).u32(lightCount).u32(offset).u32(increment);
      w.i32(PA).f32(bounce).f32(this.yMult).b32(this.options.useOcclusion);
    };
  }

  /** GI::SDFGI::render_static_lights() */
  private renderStaticLights(enc: GPUCommandEncoder): void {
    const lights = this.collectLights(true);
    if (lights.length === 0) return;
    this.prepareLights(lights);
    const counts = this.cascades.map((_c, i) => this.writeLights(this.cascades[i].lightsStatic, i, MAX_STATIC_LIGHTS));
    if (counts.every((n) => n === 0)) return;

    for (let i = 0; i < this.cascades.length; i++) {
      if (counts[i] > 0) {
        enc.copyBufferToBuffer(this.cascades[i].dispatchStorage, 0, this.cascades[i].dispatchCall, 0, 16);
      }
    }
    const p = enc.beginComputePass({ label: 'sdfgi static lights' });
    p.setPipeline(this.pDirectStat);
    for (let i = 0; i < this.cascades.length; i++) {
      if (counts[i] === 0) continue;
      p.setBindGroup(0, this.cascades[i].bgDirectStatic);
      p.setBindGroup(1, this.pool.push(this.pDirectStat, this.directParams(i, counts[i], 0, 1, 0)));
      p.dispatchWorkgroupsIndirect(this.cascades[i].dispatchCall, 0);
    }
    p.end();
  }

  /** GI::SDFGI::update_light() */
  private updateLight(enc: GPUCommandEncoder): void {
    const lights = this.collectLights(false);
    this.prepareLights(lights);
    const counts = this.cascades.map((_c, i) => this.writeLights(this.cascades[i].lightsDynamic, i, MAX_DYNAMIC_LIGHTS));
    for (const c of this.cascades) {
      enc.copyBufferToBuffer(c.dispatchStorage, 0, c.dispatchCall, 0, 16);
    }
    const framesToUpdate = FRAMES_TO_UPDATE_LIGHT[this.options.framesToUpdateLight] ?? 4;

    const p = enc.beginComputePass({ label: 'sdfgi direct light', ...this.profiler.pass('light') });
    p.setPipeline(this.pDirectDyn);
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      let offset = this.frame % framesToUpdate;
      let increment = framesToUpdate;
      if (c.allDynamicLightsDirty || framesToUpdate === 1) {
        offset = 0;
        increment = 1;
      }
      c.allDynamicLightsDirty = false;
      p.setBindGroup(0, c.bgDirectDynamic);
      p.setBindGroup(
        1,
        this.pool.push(this.pDirectDyn, this.directParams(i, counts[i], offset, increment, this.options.bounceFeedback)),
      );
      p.dispatchWorkgroupsIndirect(c.dispatchCall, 0);
    }
    p.end();
  }

  // ------------------------------------------------------------------
  // probes
  // ------------------------------------------------------------------

  private integrateParams(
    w: W,
    a: {
      cascade: number;
      imageSize: [number, number];
      scroll?: number[];
      historyIndex: number;
      rayCount: number;
      skyFlags: number;
      skyVec?: [number, number, number];
      probePhase?: number;
      probeSlices?: number;
    },
  ): void {
    const c = this.cascades[a.cascade];
    const s = a.scroll ?? [0, 0, 0];
    const sky = a.skyVec ?? [0, 0, 0];
    w.f3(G, G, G).u32(this.numCascades);
    w.u32(PA).u32(a.cascade).u32(a.historyIndex).u32(this.historySize);
    w.u32(a.rayCount).f32(this.options.probeBias);
    w.i32(a.imageSize[0]).i32(a.imageSize[1]);
    w.i3(
      Math.trunc(c.position.x / PROBE_CELLS),
      Math.trunc(c.position.y / PROBE_CELLS),
      Math.trunc(c.position.z / PROBE_CELLS),
    ).u32(a.skyFlags);
    w.i3(s[0], s[1], s[2]).f32(this.options.skyEnergy);
    w.f3(sky[0], sky[1], sky[2]).f32(this.yMult);
    w.f32(this.options.skyIrradianceBorder[0]).f32(this.options.skyIrradianceBorder[1]);
    // store_ambient_texture (volumetric fog only), probe_phase, probe_slices, pad
    w.u32(0).u32(a.probePhase ?? 0).u32(a.probeSlices ?? 1).pad();
  }

  private skyState(): { flags: number; vec: [number, number, number] } {
    if (this.options.skyIrradiance) {
      // orientation identity -> quaternion (0,0,0,1), sign bit set
      return { flags: SKY_FLAGS_MODE_SKY | SKY_FLAGS_ORIENTATION_SIGN, vec: [0, 0, 0] };
    }
    if (this.options.skyColor === null) return { flags: 0, vec: [0, 0, 0] };
    const c = new THREE.Color(this.options.skyColor);
    return { flags: SKY_FLAGS_MODE_COLOR, vec: [c.r, c.g, c.b] };
  }

  /**
   * GI::SDFGI::update_probes(), one interleaved 1/probeSlices of the grid per frame.
   *
   * Godot integrates every probe of every cascade every frame; at 32 rays x 4913
   * probes that is ~70% of this library's GPU time, and every other pass is
   * rounding error next to it. Refreshing an interleaved slice keeps the same
   * per-probe ray budget at 1/probeSlices the cost, and because the slice is
   * spread across the whole grid rather than being a whole cascade, a change in
   * lighting dithers in instead of arriving as one visible step. A probe's
   * `historySize` slots each still get a fresh ray set; a full round just takes
   * probeSlices frames, landing inside Godot's own default of 30 to converge.
   */
  private updateProbes(enc: GPUCommandEncoder): void {
    const n = Math.max(1, Math.trunc(this.options.probeSlices));
    const probePhase = this.frame % n;
    // advance the history slot once per completed round, not once per frame, so
    // every probe in a round writes the same slot regardless of its phase
    const historyIndex = Math.floor(this.frame / n) % this.historySize;
    const rayCount = RAY_COUNTS[this.options.rayCount] ?? 32;
    const sky = this.skyState();
    const slots = Math.ceil((PROBE_IMAGE_W * PROBE_IMAGE_H) / n);
    const p = enc.beginComputePass({ label: 'sdfgi integrate', ...this.profiler.pass('probes') });
    for (let i = 0; i < this.cascades.length; i++) {
      const fill = (w: W) =>
        this.integrateParams(w, {
          cascade: i,
          imageSize: [PROBE_IMAGE_W, PROBE_IMAGE_H],
          historyIndex,
          rayCount,
          skyFlags: sky.flags,
          skyVec: sky.vec,
          probePhase,
          probeSlices: n,
        });
      // both passes are @workgroup_size(64, 1, 1); the ray pass runs one thread
      // per (probe, ray), the accumulate pass one per probe. WebGPU orders
      // dispatches within a pass, so the second sees the first's writes.
      p.setPipeline(this.pIntegrateRays);
      p.setBindGroup(0, this.bgIntegrateRays);
      p.setBindGroup(1, this.pool.push(this.pIntegrateRays, fill));
      p.dispatchWorkgroups(Math.ceil((slots * rayCount) / 64), 1, 1);

      p.setPipeline(this.pIntegrate);
      p.setBindGroup(0, this.cascades[i].bgIntegrate);
      p.setBindGroup(1, this.pool.push(this.pIntegrate, fill));
      p.dispatchWorkgroups(Math.ceil(slots / 64), 1, 1);
    }
    p.end();
  }

  /** GI::SDFGI::store_probes() */
  private storeProbes(enc: GPUCommandEncoder): void {
    const iw = PROBE_IMAGE_W * OCT;
    const ih = PROBE_IMAGE_H * OCT;
    const p = enc.beginComputePass({ label: 'sdfgi store probes', ...this.profiler.pass('store') });
    p.setPipeline(this.pIntegrateFilter);
    for (let i = 0; i < this.cascades.length; i++) {
      p.setBindGroup(0, this.cascades[i].bgIntegrateFilter);
      p.setBindGroup(
        1,
        this.pool.push(this.pIntegrateFilter, (w) =>
          this.integrateParams(w, {
            cascade: i,
            imageSize: [PROBE_IMAGE_W, PROBE_IMAGE_H],
            historyIndex: 0,
            rayCount: 0,
            skyFlags: 0,
          }),
        ),
      );
      p.dispatchWorkgroups(Math.ceil(PROBE_IMAGE_W / 8), Math.ceil(PROBE_IMAGE_H / 8), 1);
    }
    p.setPipeline(this.pIntegrateStore);
    for (let i = 0; i < this.cascades.length; i++) {
      p.setBindGroup(0, this.cascades[i].bgIntegrateStore);
      p.setBindGroup(
        1,
        this.pool.push(this.pIntegrateStore, (w) =>
          this.integrateParams(w, {
            cascade: i,
            imageSize: [iw, ih],
            historyIndex: 0,
            rayCount: 0,
            skyFlags: 0,
          }),
        ),
      );
      p.dispatchWorkgroups(Math.ceil(iw / 8), Math.ceil(ih / 8), 1);
    }
    p.end();
  }

  // ------------------------------------------------------------------
  // uniform buffers
  // ------------------------------------------------------------------

  private writeCascadesUbo(): void {
    const buf = this.cascadesUboData;
    const w = this.cascadesUboW;
    const half = G >> 1;
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      w.seek(i * 48);
      w.f3(
        (-half + c.position.x) * c.cellSize,
        (-half + c.position.y) * c.cellSize,
        (-half + c.position.z) * c.cellSize,
      ).f32(1 / c.cellSize);
      w.i3(
        Math.trunc(c.position.x / PROBE_CELLS),
        Math.trunc(c.position.y / PROBE_CELLS),
        Math.trunc(c.position.z / PROBE_CELLS),
      ).u32(0);
    }
    this.device.queue.writeBuffer(this.cascadesUbo, 0, buf);
  }

  /** the SDFGIData half of pre_process_gi() */
  private writeSdfgiUbo(camPos: THREE.Vector3): void {
    const buf = this.sdfgiUboData;
    const w = this.sdfgiUboW.seek(0);
    const probeSizeF = PA - 1;
    const cascadeVoxelSize = G / probeSizeF;
    const occlusionClamp = (cascadeVoxelSize - 0.5) / cascadeVoxelSize;
    const px = 1 / ((OCT + 2) * PA * PA);
    const py = 1 / ((OCT + 2) * PA);

    w.f3(G, G, G).u32(this.numCascades);
    w.b32(this.options.useOcclusion).i32(PA).f32(1 / probeSizeF).f32((this.options.normalBias / G) * probeSizeF);
    w.f3(px, py, 1).f32(this.options.energy);
    w.f3((OCT + 2) * px, (OCT + 2) * py, (OCT + 2) * PA * px).f32(this.yMult);
    w.f3(occlusionClamp, occlusionClamp, occlusionClamp).pad();
    w.f3(0.5, 1.0, 1 / this.numCascades).pad();
    w.f3(probeSizeF, probeSizeF, probeSizeF).pad();

    const half = G >> 1;
    const camY = camPos.y * this.yMult;
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      w.seek(112 + i * 48);
      w.f3(
        (-half + c.position.x) * c.cellSize - camPos.x,
        (-half + c.position.y) * c.cellSize - camY,
        (-half + c.position.z) * c.cellSize - camPos.z,
      ).f32(1 / ((G * c.cellSize) / probeSizeF));
      w.i3(
        Math.trunc(c.position.x / PROBE_CELLS),
        Math.trunc(c.position.y / PROBE_CELLS),
        Math.trunc(c.position.z / PROBE_CELLS),
      ).f32(1 / c.cellSize);
      w.pad(3).f32(1.0); // pad, exposure_normalization
    }
    this.device.queue.writeBuffer(this.sdfgiUbo, 0, buf);
  }

  // ------------------------------------------------------------------
  // screen space
  // ------------------------------------------------------------------

  /** WebGPU clip space is z in [0,1]; three.js may still hand us a GL matrix. */
  private projection(camera: THREE.Camera): THREE.Matrix4 {
    const p = this.mProj.copy(camera.projectionMatrix);
    if (camera.coordinateSystem === THREE.WebGLCoordinateSystem) {
      const e = p.elements;
      e[2] = 0.5 * (e[2] + e[3]);
      e[6] = 0.5 * (e[6] + e[7]);
      e[10] = 0.5 * (e[10] + e[11]);
      e[14] = 0.5 * (e[14] + e[15]);
    }
    return p;
  }

  private prepass(enc: GPUCommandEncoder, camera: THREE.Camera): void {
    const vp = this.mTmp.copy(this.projection(camera)).multiply(camera.matrixWorldInverse);
    const params = this.pool.push(this.pPrepass, (w) => {
      for (const e of vp.elements) w.f32(e);
      for (const e of camera.matrixWorldInverse.elements) w.f32(e);
    });

    const pass = enc.beginRenderPass({
      label: 'sdfgi prepass',
      ...this.profiler.pass('prepass'),
      colorAttachments: [
        { view: this.albedoView, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' },
        // 0.5 decodes to a zero-length normal, which the GI pass treats as sky
        { view: this.normalView, loadOp: 'clear', clearValue: [0.5, 0.5, 0.5, 0], storeOp: 'store' },
      ],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.pPrepass);
    pass.setBindGroup(1, params);
    // vp always has WebGPU depth range by the time projection() is done with it
    this.frustum.setFromProjectionMatrix(vp, THREE.WebGPUCoordinateSystem);
    for (const d of this.extracted!.draws) {
      this.bTmp.min.copy(d.min);
      this.bTmp.max.copy(d.max);
      if (!this.frustum.intersectsBox(this.bTmp)) continue;
      pass.setBindGroup(2, this.drawBgs[1][d.slot]);
      pass.setBindGroup(3, this.texBgs[1][d.slot]);
      pass.setVertexBuffer(0, d.vertices);
      if (d.indices) {
        pass.setIndexBuffer(d.indices, 'uint32');
        pass.drawIndexed(d.count);
      } else {
        pass.draw(d.count);
      }
    }
    pass.end();
  }

  private applyGi(enc: GPUCommandEncoder, camera: THREE.Camera): void {
    const inv = this.mTmp.copy(this.projection(camera)).invert();
    const params = this.pool.push(this.pGi, (w) => {
      for (const e of inv.elements) w.f32(e);
      for (const e of camera.matrixWorld.elements) w.f32(e);
      w.i32(this.width).i32(this.height).i32(this.giScale).u32(0);
    });
    const p = enc.beginComputePass({ label: 'sdfgi apply', ...this.profiler.pass('apply') });
    p.setPipeline(this.pGi);
    p.setBindGroup(0, this.bgGi);
    p.setBindGroup(1, params);
    const s = this.giScale;
    p.dispatchWorkgroups(Math.ceil(this.width / s / 8), Math.ceil(this.height / s / 8), 1);
    p.end();
  }

  private canvasView(): GPUTextureView {
    if (this.output) return this.output.createView();
    const ctx = (this.renderer as unknown as { backend: { context: GPUCanvasContext } }).backend.context;
    // ponytail: three.js internals. There is no public way to get the swapchain
    // texture; if this breaks, render three.js to a RenderTarget instead.
    return ctx.getCurrentTexture().createView();
  }

  private present(enc: GPUCommandEncoder, camera: THREE.Camera): void {
    const view = this.canvasView();

    if (this.debug === 'sdf') {
      const inv = this.mTmp.copy(this.projection(camera)).invert();
      const pc = enc.beginComputePass({ label: 'sdfgi debug sdf' });
      pc.setPipeline(this.pDebugSdf);
      pc.setBindGroup(0, this.bgDebugSdf);
      pc.setBindGroup(
        1,
        this.pool.push(this.pDebugSdf, (w) => {
          const near = (camera as THREE.PerspectiveCamera).near ?? 0.1;
          w.f3(G, G, G).u32(this.numCascades);
          w.i32(this.width).i32(this.height).f32(this.yMult).f32(near);
          w.seek(32);
          for (const e of inv.elements) w.f32(e);
          for (const e of camera.matrixWorld.elements) w.f32(e);
          const o = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
          w.f3(o.x, o.y, o.z).pad();
        }),
      );
      pc.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8), 1);
      pc.end();

      const pass = enc.beginRenderPass({
        label: 'sdfgi blit',
        colorAttachments: [{ view, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
      });
      pass.setPipeline(this.pBlit);
      pass.setBindGroup(0, this.bgBlit);
      pass.draw(3);
      pass.end();
      return;
    }

    const pass = enc.beginRenderPass({
      label: 'sdfgi composite',
      ...this.profiler.pass('composite'),
      colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment:
        this.debug === 'none'
          ? undefined
          : { view: this.depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
    });

    if (this.debug === 'none') {
      pass.setPipeline(this.pComposite);
      pass.setBindGroup(0, this.bgComposite);
      pass.draw(3);
    } else {
      const vp = this.mTmp.copy(this.projection(camera)).multiply(camera.matrixWorldInverse);
      this.device.queue.writeBuffer(this.probeVpUbo, 0, new Float32Array(vp.elements));
      const cascade = Math.min(this.debugCascade, this.numCascades - 1);
      const probes = this.debug === 'probes';
      const pipe = probes ? this.pProbes : this.pProbeVis;
      pass.setPipeline(pipe);
      pass.setBindGroup(0, probes ? this.bgProbes : this.bgProbeVis);
      pass.setBindGroup(
        1,
        this.pool.push(pipe, (w) => {
          // debug_probes(): band_points 16 -> band_power 4, sections_in_band 7
          w.u32(4).u32(7).u32(14).f32((Math.PI * 2) / 7);
          w.f3(G, G, G).u32(cascade);
          w.u32(0).f32(this.yMult).u32(this.debugProbeIndex).i32(PA);
        }),
      );
      pass.draw(PROBE_VERTS, probes ? PA * PA * PA : (PROBE_CELLS * 2) ** 3);
    }
    pass.end();
  }

  // ------------------------------------------------------------------

  dispose(): void {
    this.profiler.dispose();
    this.extracted?.dispose();
    this.pool.destroy();
    this.zero.destroy();
    for (const t of [
      this.sdfTex, this.lightTex, this.aniso0Tex, this.aniso1Tex, this.occlusionTex,
      this.lightprobeTex, this.ambientTex, ...this.renderSdf, ...this.renderSdfHalf,
      this.albedoTex, this.normalTex, this.depthTex, this.ambientBuf, this.reflectionBuf,
      this.debugTex, this.voxelDummy,
    ]) t.destroy();
    if (this.ownsSkyTex) this.skyTex.destroy();
    for (const b of [
      this.renderAlbedo, this.renderFacing, this.renderEmission, this.renderEmissionAniso,
      this.renderOcclusion, this.historyScroll, this.averageScroll, this.rayLight, this.cascadesUbo,
      this.sdfgiUbo, this.probeVpUbo,
    ]) b.destroy();
    for (const c of this.cascades) {
      for (const b of [c.solidCells, c.dispatchStorage, c.dispatchCall, c.lightsDynamic,
        c.lightsStatic, c.history, c.average, c.averageFiltered]) b.destroy();
    }
    this.cascades = [];
  }
}

const BLIT = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(src, vec2i(frag.xy), 0).rgb, 1.0);
}
`;

