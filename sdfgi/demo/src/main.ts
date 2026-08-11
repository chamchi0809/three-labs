import * as THREE from "three";
import { WebGPURenderer, InspectorBase } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { SDFGI, type DebugView } from "three-sdfgi";
import { Post } from "./post.ts";
import { createRoomsScene } from "./rooms.ts";

const msg = document.getElementById("msg")!;
/** per-scene control hint; empty for the two orbit-camera scenes */
const hint = document.createElement("div");
hint.style.cssText =
  "position:fixed;left:8px;bottom:8px;padding:6px 10px;border-radius:6px;" +
  "font:12px/1.4 ui-monospace,monospace;color:#cde;background:#000a;pointer-events:none";
document.body.appendChild(hint);

const fail = (e: unknown) => {
  msg.textContent = String(e);
  throw e;
};

if (!navigator.gpu) fail("WebGPU is not available in this browser.");

const renderer = new WebGPURenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// the post chain owns tone mapping and the sRGB encode; three.js renders into a
// linear HDR target and must not touch either
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// `renderer.inspector` is typed as the InspectorBase no-op, so keep the concrete
// one around for createParameters()
const inspector = new Inspector();
// swapped in by state.liveProfiling: the base class is the renderer's own no-op
const idleInspector = new InspectorBase();
renderer.inspector = inspector;
document.body.appendChild(renderer.domElement);
await renderer.init().catch(fail);

// ponytail: three.js internals, same bargain SDFGI makes for the swapchain.
const backend = (
  renderer as unknown as {
    backend: {
      device: GPUDevice;
      context: GPUCanvasContext;
      get(o: object): { texture?: GPUTexture };
    };
  }
).backend;
const device = backend.device;

const camera = new THREE.PerspectiveCamera(
  60,
  innerWidth / innerHeight,
  0.1,
  200,
);
const controls = new OrbitControls(camera, renderer.domElement);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- scenes
//
// Both models stream straight from a CDN at runtime -- there is no asset step
// to run before `pnpm dev`. Each URL is pinned to a commit so a checkout built
// a year from now still renders the same thing upstream reorganising a repo
// would otherwise silently change the demo.

const SPONZA_URL =
  "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets" +
  "@2bac6f8c57bf471df0d2a1e8a8ec023c7801dddf/Models/Sponza/glTF/Sponza.gltf";

// PICA PICA assets by SEED-EA, CC BY-NC 4.0 (non-commercial). This is the scene
// Bevy's `solari` raytracing example uses, at the commit Bevy itself pins.
const DIORAMA_URL =
  "https://cdn.jsdelivr.net/gh/bevyengine/bevy_asset_files" +
  "@2a5950295a8b6d9d051d59c0df69e87abcda58c3/pica_pica/mini_diorama_01.glb";

type SceneName = "sponza" | "diorama" | "rooms";

/** everything activate() needs to swap one scene out for another */
interface SceneSetup {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  /** how far up the az/el arc the sun sits, in world units */
  sunDist: number;
  /** structural SDFGI options -- these only take effect on construction */
  gi: {
    cascades: number;
    minCellSize: number;
    skyColor: number;
    skyEnergy: number;
  };
  volumetric: Partial<typeof volumetric>;
  bloom: Partial<typeof bloom>;
  /** an interactive scene: it drives the camera itself, so OrbitControls is off */
  update?: (deltaTime: number) => void;
  /** release the window listeners an interactive scene registered */
  dispose?: () => void;
  /** shown bottom-left while the scene is up */
  instructions?: string;
}

const loader = new GLTFLoader();
const mb = (n: number): string => (n / 1048576).toFixed(1);

async function loadGltf(url: string, label: string): Promise<THREE.Group> {
  msg.style.display = "grid";
  msg.textContent = `loading ${label}…`;
  const gltf = await loader.loadAsync(url, (e) => {
    // Sponza is ~30 separate requests and only some report a total; the .glb is
    // one, so this reads as a real progress bar exactly where it matters.
    msg.textContent = e.total
      ? `loading ${label}… ${mb(e.loaded)} / ${mb(e.total)} MB`
      : `loading ${label}… ${mb(e.loaded)} MB`;
  }).catch((e: unknown) => {
    fail(`could not load ${label} — ${String(e)}`);
    throw e;
  });
  msg.style.display = "none";
  return gltf.scene;
}

function shadowFrustum(
  light: THREE.DirectionalLight,
  extent: number,
  near: number,
  far: number,
): void {
  const c = light.shadow.camera;
  c.left = -extent;
  c.right = extent;
  c.top = extent;
  c.bottom = -extent;
  c.near = near;
  c.far = far;
}

/** position the sun on the az/el arc; autoUpdate is off, so flag the shadow */
function placeSun(light: THREE.DirectionalLight, dist: number): void {
  const az = THREE.MathUtils.degToRad(state.sunAzimuth);
  const el = THREE.MathUtils.degToRad(state.sunElevation);
  const c = Math.cos(el) * dist;
  light.position.set(c * Math.sin(az), Math.sin(el) * dist, c * Math.cos(az));
  light.shadow.needsUpdate = true;
}

async function sponza(): Promise<SceneSetup> {
  const scene = new THREE.Scene();
  const root = await loadGltf(SPONZA_URL, "sponza");
  root.scale.setScalar(4); // the Khronos model ships at 1/100 scale
  root.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  scene.add(root);

  const sun = new THREE.DirectionalLight(0xfff0dd, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  shadowFrustum(sun, 45, 10, 180);
  sun.shadow.bias = -0.001;
  sun.shadow.autoUpdate = false;
  scene.add(sun);

  camera.position.set(12, 20, 0);
  controls.target.set(0, 15, 0);
  return {
    scene,
    sun,
    sunDist: 96,
    // cascade 0 spans 128 * minCellSize = 32 units, the width of the arcade
    gi: { cascades: 4, minCellSize: 0.25, skyColor: 0x304a6a, skyEnergy: 2 },
    volumetric: { enabled: true, density: 0.03, intensity: 1.5, maxDistance: 120 },
    // nothing here clears 1.0, so the threshold has to sit under the diffuse peak
    bloom: { threshold: 0.5, knee: 0.4, strength: 0.5 },
  };
}

async function diorama(): Promise<SceneSetup> {
  const scene = new THREE.Scene();
  const root = await loadGltf(DIORAMA_URL, "diorama");
  root.scale.setScalar(10); // the same factor Bevy's solari example applies
  root.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  scene.add(root);

  const sun = new THREE.DirectionalLight(0xfff2e0, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  shadowFrustum(sun, 14, 4, 80);
  sun.shadow.bias = -0.0004; // a tenth of Sponza's scale wants a tighter bias
  sun.shadow.autoUpdate = false;
  scene.add(sun);

  camera.position.set(6, 4, 9);
  controls.target.set(0, 1.2, 0);
  return {
    scene,
    sun,
    sunDist: 40,
    // an order of magnitude smaller than Sponza, so the cascades follow it down
    gi: { cascades: 4, minCellSize: 0.06, skyColor: 0x6f8db8, skyEnergy: 2 },
    // a prop-sized scene: at this scale the shafts read as haze over the whole
    // model rather than light through it, so the pass stays off here
    volumetric: { enabled: false, density: 0.09, intensity: 2.0, maxDistance: 40 },
    // Unlike Sponza this scene has emissive panels and bright metal that do
    // clear 1.0, so it can keep a real HDR threshold -- reusing Sponza's 0.5
    // dragged the whole midtone range into the mip chain and hazed it over.
    bloom: { threshold: 1.0, knee: 0.5, strength: 0.18 },
  };
}

// The rooms level from three-rc-25d: nine walled rooms at four floor heights on
// a dark plain, joined by sloping corridors and lit only by the emissive lamps
// standing in them. SDFGI voxelizes the level once, so the lamps light it
// through the doorways and down the ramps; the actor, its beam, the bullets and
// the sparks move, so they are raster and bloom only.
function rooms(): SceneSetup {
  const level = createRoomsScene(camera, renderer.domElement);
  return {
    scene: level.scene,
    sun: level.sun,
    sunDist: 110,
    // cascade 0 spans 128 * 0.25 = 32 units, about two rooms plus the corridor
    // between them; four cascades reach past the whole 44-unit level.
    gi: { cascades: 4, minCellSize: 0.25, skyColor: 0x0a1020, skyEnergy: 0.4 },
    // Lamp-lit rooms open to the sky: the shafts read as the light spilling out
    // of a doorway, which is the whole point of the level.
    volumetric: { enabled: true, density: 0.02, intensity: 1.2, maxDistance: 80 },
    // The lamps and tracers are genuinely HDR here, so a real 1.0 threshold
    // picks them out and leaves the grey walls alone -- and with a dozen of
    // them in frame at once the glow adds up, so it stays weaker than the two
    // sunlit scenes'.
    bloom: { threshold: 1.0, knee: 0.5, strength: 0.15 },
    update: level.update,
    dispose: level.dispose,
    instructions: "WASD move · mouse aim · hold click to fire · F toggles laser",
  };
}

const BUILDERS: Record<SceneName, () => SceneSetup | Promise<SceneSetup>> = {
  sponza,
  diorama,
  rooms,
};

// ---------------------------------------------------------------- run

const state = {
  // the inspector assigns straight to the property, so a setter is the whole
  // "onChange" story
  //
  // the single biggest fps lever: 2 on a retina display means 4x the pixels
  get pixelRatio(): number {
    return renderer.getPixelRatio();
  },
  set pixelRatio(v: number) {
    renderer.setPixelRatio(v);
    renderer.setSize(innerWidth, innerHeight);
  },
  // The inspector timestamps every pass and rebuilds its tables each frame, so
  // it shifts the number it is reporting. Detaching it leaves the panel on
  // screen (and its controls live) with none of the per-frame cost.
  _liveProfiling: true,
  get liveProfiling(): boolean {
    return this._liveProfiling;
  },
  set liveProfiling(v: boolean) {
    this._liveProfiling = v;
    if (v) {
      renderer.inspector = inspector;
      return;
    }
    // one frame late on purpose: the inspector resolves its timestamps in a
    // rAF callback that dereferences the renderer the setter is about to null
    requestAnimationFrame(() => {
      if (this._liveProfiling) return; // toggled back on in the meantime
      renderer.inspector = idleInspector;
      (
        renderer as unknown as { backend: { trackTimestamp: boolean } }
      ).backend.trackTimestamp = false;
    });
  },
  debug: "none" as DebugView,
  giOnly: false,
  ambient: 0,
  hud: false,
  _scene: "sponza" as SceneName,
  get scene(): SceneName {
    return this._scene;
  },
  set scene(v: SceneName) {
    if (v === this._scene) return;
    this._scene = v;
    void activate(v);
  },
  _sunAzimuth: 63,
  get sunAzimuth(): number {
    return this._sunAzimuth;
  },
  set sunAzimuth(v: number) {
    this._sunAzimuth = v;
    placeSun(sun, sunDist);
  },
  _sunElevation: 69,
  get sunElevation(): number {
    return this._sunElevation;
  },
  set sunElevation(v: number) {
    this._sunElevation = v;
    placeSun(sun, sunDist);
  },
  // No backing field: the light is the state, and every consumer (SDFGI's light
  // packing, the volumetric sun colour) already reads it per frame. The colour
  // picker hands back "#rrggbb", so .set() rather than .setHex(). Each scene
  // starts from its own sun colour, which the getter picks up on its own.
  get sunColor(): number {
    return sun.color.getHex();
  },
  set sunColor(v: number | string) {
    sun.color.set(v);
  },
  get sunIntensity(): number {
    return sun.intensity;
  },
  set sunIntensity(v: number) {
    sun.intensity = v;
  },
};

// Linear HDR target: three.js draws the scene into it, SDFGI composites into it
// (linearOutput), and the post chain reads it. Nothing is sRGB-encoded or
// clipped to [0,1] until the final pass.
const hdrTarget = new THREE.RenderTarget(1, 1, {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  depthBuffer: true,
});
hdrTarget.texture.name = "hdr";
hdrTarget.texture.minFilter = THREE.LinearFilter;
hdrTarget.texture.magFilter = THREE.LinearFilter;
hdrTarget.texture.generateMipmaps = false;

const post = new Post(device, navigator.gpu.getPreferredCanvasFormat());

// Live scene state. cascades/minCellSize are structural, so switching scenes
// throws the whole SDFGI away rather than retuning it in place.
let scene: THREE.Scene;
let ambient: THREE.AmbientLight;
let sun: THREE.DirectionalLight;
let sunDist = 96;
let gi: SDFGI;
/** set by an interactive scene; when it is, OrbitControls is off and this owns the camera */
let sceneUpdate: ((deltaTime: number) => void) | undefined;
let sceneDispose: (() => void) | undefined;
/** the render loop sits out the swap; nothing below is valid mid-activate */
let loading = true;

/** free the GPU-side of a scene three.js will never draw again */
function disposeScene(s: THREE.Scene | undefined): void {
  s?.traverse((o) => {
    const m = o as Partial<THREE.Mesh>;
    m.geometry?.dispose();
    for (const mat of [m.material].flat()) {
      if (!mat) continue;
      for (const val of Object.values(mat)) {
        const tex = val as THREE.Texture | null;
        if (tex?.isTexture) tex.dispose();
      }
      mat.dispose();
    }
  });
}

async function activate(name: SceneName): Promise<void> {
  loading = true;
  try {
    // built before anything is torn down: a failed download leaves the scene
    // that is already on screen alone
    const setup = await BUILDERS[name]();

    gi?.dispose();
    sceneDispose?.();
    disposeScene(scene);

    scene = setup.scene;
    sun = setup.sun;
    sunDist = setup.sunDist;
    sceneUpdate = setup.update;
    sceneDispose = setup.dispose;
    controls.enabled = !setup.update;
    placeSun(sun, sunDist);
    hint.textContent = setup.instructions ?? "";
    hint.style.display = setup.instructions ? "block" : "none";
    ambient = new THREE.AmbientLight(0xffffff, state.ambient);
    scene.add(ambient);

    Object.assign(volumetric, setup.volumetric);
    Object.assign(bloom, setup.bloom);

    gi = new SDFGI(renderer, {
      ...setup.gi,
      canvasFormat: "rgba16float",
      linearOutput: true,
    });
    gi.setScene(scene);
    controls.update();
  } finally {
    loading = false;
  }
}

// Bound to a plain object rather than gi.options, so the controllers survive a
// scene switch (which builds a whole new SDFGI).
const tweak = {
  cascade: 0,
  energy: 1,
  bounceFeedback: 0.5,
  normalBias: 1.1,
  probeBias: 1.1,
  rayCount: 3,
  probeSlices: 4,
  scrollInterval: 4,
  framesToUpdateLight: 2,
  halfResolution: true,
};

const volumetric = {
  enabled: true,
  steps: 48,
  density: 0.03,
  scattering: 0.65,
  intensity: 1.5,
  maxDistance: 120,
  shadowBias: 0.0015,
};

// Both scenes top out around 0.7 in linear light -- diffuse albedo under a
// 4-intensity sun, no specular highlights and no sun disc in frame. A
// physically-tidy 1.0 threshold never fires; thresholding below the diffuse
// peak is what makes the sunlit surfaces actually glow.
const bloom = {
  enabled: true,
  threshold: 0.5,
  knee: 0.4,
  strength: 0.5,
  radius: 1.0,
};

const grade = {
  exposure: 1.0,
  toneMapping: "aces" as "none" | "aces",
};

// first paint: the per-scene volumetric/bloom overrides land on the objects above
await activate(state.scene);

// debug hooks for the CDP harness
Object.assign(globalThis, {
  __cam: camera,
  __controls: controls,
  __r: renderer,
  __tweak: tweak,
  __state: state,
  __vol: volumetric,
  __bloom: bloom,
  __grade: grade,
  __sc: () => scene,
});
Object.defineProperty(globalThis, "__gi", { get: () => gi });

const p = inspector.createParameters("demo");
p.add(state, "scene", ["sponza", "diorama", "rooms"]);
p.add(state, "debug", ["none", "sdf", "probes", "visibility"]);
p.add(state, "giOnly").name("GI only (hide direct)");
p.add(state, "ambient", 0, 4, 0.05).name("ambient light");
p.addColor(state, "sunColor").name("sun color");
p.add(state, "sunIntensity", 0, 10, 0.1).name("sun intensity");
p.add(state, "sunAzimuth", 0, 360, 1).name("sun azimuth");
p.add(state, "sunElevation", 0, 90, 1).name("sun elevation");
p.add(state, "pixelRatio", 0.5, 2, 0.25);
p.add(state, "hud").name("perf HUD");
p.add(state, "liveProfiling").name("live profiling (inspector)");

const f = inspector.createParameters("sdfgi");
f.add(tweak, "cascade", 0, 3, 1);
f.add(tweak, "energy", 0, 4, 0.05);
f.add(tweak, "bounceFeedback", 0, 1, 0.05);
f.add(tweak, "normalBias", 0, 4, 0.1);
f.add(tweak, "probeBias", 0, 4, 0.1);
f.add(tweak, "rayCount", 0, 6, 1).name("rayCount (idx)");
f.add(tweak, "probeSlices", 1, 8, 1).name("probe slices/frame");
f.add(tweak, "scrollInterval", 1, 12, 1).name("frames between scrolls");
f.add(tweak, "framesToUpdateLight", 0, 4, 1).name("light update (idx)");
f.add(tweak, "halfResolution").name("half-res GI");

const v = inspector.createParameters("volumetric");
v.add(volumetric, "enabled");
v.add(volumetric, "steps", 8, 128, 1);
v.add(volumetric, "density", 0, 0.15, 0.002);
v.add(volumetric, "scattering", 0, 0.95, 0.01).name("forward scattering (g)");
v.add(volumetric, "intensity", 0, 6, 0.05);
v.add(volumetric, "maxDistance", 10, 200, 5).name("max distance");
v.add(volumetric, "shadowBias", 0, 0.02, 0.0005).name("shadow bias");

const b = inspector.createParameters("bloom");
b.add(bloom, "enabled");
b.add(bloom, "threshold", 0, 3, 0.05);
b.add(bloom, "knee", 0, 2, 0.05);
b.add(bloom, "strength", 0, 1.5, 0.01);
b.add(bloom, "radius", 0.5, 4, 0.1).name("upsample radius");

const t = inspector.createParameters("tone mapping");
t.add(grade, "exposure", 0.1, 4, 0.05);
t.add(grade, "toneMapping", ["none", "aces"]);

// ---------------------------------------------------------------- perf HUD
// The inspector's timeline only sees three.js' own passes; SDFGI runs on raw
// WebGPU underneath it, so its per-pass GPU times come from gi.profiler.
const hud = document.createElement("pre");
hud.style.cssText =
  "position:fixed;left:8px;top:8px;margin:0;padding:6px 10px;border-radius:6px;" +
  "font:11px/1.5 ui-monospace,monospace;color:#9fe;background:#000a;pointer-events:none";
document.body.appendChild(hud);

const bufSize = new THREE.Vector2();
let hudAcc = 0;
let hudFrames = 0;
let hudLast = performance.now();

function updateHud(): void {
  hud.style.display = state.hud ? "block" : "none";
  gi.profiler.enabled = state.hud;
  const now = performance.now();
  const dt = now - hudLast;
  hudLast = now;
  if (!state.hud) return;
  hudAcc += dt;
  if (++hudFrames < 30) return;
  const ms = hudAcc / hudFrames;
  hudAcc = 0;
  hudFrames = 0;
  renderer.getDrawingBufferSize(bufSize);
  const passes = Object.entries(gi.profiler.ms)
    // 'composite' writes to the swapchain and swallows the present stall
    .filter(([k]) => k !== "composite")
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${k.padEnd(8)} ${v.toFixed(2)}`);
  hud.textContent = [
    `${bufSize.x}x${bufSize.y} @${renderer.getPixelRatio()}`,
    `${ms.toFixed(2)} ms  ${(1000 / ms).toFixed(0)} fps`,
    ...passes,
  ].join("\n");
}

// ---------------------------------------------------------------- post inputs

const size = new THREE.Vector2();
const mProj = new THREE.Matrix4();
const invProjection = new Float32Array(16);
const cameraWorld = new Float32Array(16);
const shadowMatrix = new Float32Array(16);
const sunDir = new THREE.Vector3();
let frameIndex = 0;

/** the camera projection SDFGI and the prepass depth actually use */
function webgpuInverseProjection(): THREE.Matrix4 {
  const p = mProj.copy(camera.projectionMatrix);
  if (camera.coordinateSystem === THREE.WebGLCoordinateSystem) {
    // same [-1,1] -> [0,1] depth remap SDFGI's projection() applies
    const e = p.elements;
    e[2] = 0.5 * (e[2] + e[3]);
    e[6] = 0.5 * (e[6] + e[7]);
    e[10] = 0.5 * (e[10] + e[11]);
    e[14] = 0.5 * (e[14] + e[15]);
  }
  return p.invert();
}

let lastFrame = performance.now();

renderer.setAnimationLoop(() => {
  const now = performance.now();
  // clamped: a tab that was in the background must not teleport the player
  // through a wall on its first frame back
  const deltaTime = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (loading) return; // mid-swap: scene, sun and gi are not all the same age
  if (sceneUpdate) sceneUpdate(deltaTime);
  else controls.update();
  updateHud();
  ambient.intensity = state.ambient;
  gi.debug = state.debug;
  gi.debugCascade = tweak.cascade;
  Object.assign(gi.options, tweak);

  renderer.getDrawingBufferSize(size);
  const w = Math.max(1, Math.floor(size.x));
  const h = Math.max(1, Math.floor(size.y));
  if (hdrTarget.width !== w || hdrTarget.height !== h) hdrTarget.setSize(w, h);

  // Everything must land in one JS task: gi.render() writes into the same HDR
  // target three.js just rendered into, and post reads it back.
  renderer.setRenderTarget(hdrTarget);
  if (state.giOnly) renderer.clear();
  else renderer.render(scene, camera);

  const hdr = backend.get(hdrTarget.texture).texture;
  if (!hdr) return; // nothing has been rendered into the target yet
  gi.output = hdr;
  gi.render(camera);

  invProjection.set(webgpuInverseProjection().elements);
  cameraWorld.set(camera.matrixWorld.elements);
  shadowMatrix.set(sun.shadow.matrix.elements);
  // the light travels from the sun towards its target, which sits at the origin
  sunDir.copy(sun.position).negate().normalize();

  const shadowMap = sun.shadow.map?.depthTexture;
  const enc = device.createCommandEncoder({ label: "post" });
  post.render(
    enc,
    {
      hdr,
      depth: gi.depthTexture,
      shadow: (shadowMap && backend.get(shadowMap).texture) ?? null,
      invProjection,
      cameraWorld,
      shadowMatrix,
      cameraPosition: [camera.position.x, camera.position.y, camera.position.z],
      sunDirection: [sunDir.x, sunDir.y, sunDir.z],
      sunColor: [
        sun.color.r * sun.intensity,
        sun.color.g * sun.intensity,
        sun.color.b * sun.intensity,
      ],
      frame: frameIndex++,
    },
    volumetric,
    bloom,
    grade,
    backend.context.getCurrentTexture().createView(),
    w,
    h,
  );
  device.queue.submit([enc.finish()]);
});
