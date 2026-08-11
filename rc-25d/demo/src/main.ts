import {
  ACESFilmicToneMapping,
  InspectorBase,
  MeshBasicNodeMaterial,
  QuadMesh,
  RenderTarget,
  TimestampQuery,
  type Texture,
  WebGPURenderer,
} from "three/webgpu";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { screenUV, texture, vec3 } from "three/tsl";
import {
  ScreenSpaceRC,
  SPLIT_CASCADES,
  SPLIT_T0_OVER_DS0,
  type SplitDebugView,
  type SplitProbeReport,
  SplitRC,
} from "@rc25d/radiance-cascades";
import { createDungeonScene } from "./scenes/dungeon.js";
import { createPicaPicaScene } from "./scenes/picaPica.js";
import { createPlatformerScene } from "./scenes/platformer.js";
import { createRoomsScene } from "./scenes/rooms.js";
import type { DemoScene, DemoSceneId } from "./scenes/types.js";

const FIELD_PADDING = 0.25;
const FIELD_UPDATE_HZ = 60;
const FIELD_UPDATE_INTERVAL = 1 / FIELD_UPDATE_HZ;
const BENCHMARK_WIDTH = 3840;
const BENCHMARK_HEIGHT = 2160;
const BENCHMARK_WARMUP_FRAMES = 60;
const BENCHMARK_FRAMES = 30;
const BENCHMARK_TARGET_FPS = 300;
/**
 * Split RC solves in world space against a voxel scene, so it is nowhere near
 * the screen-space solver's budget and passing it at 300 was never the goal.
 */
const BENCHMARK_SPLIT_TARGET_FPS = 120;
const BENCHMARK_FIELD_INTERVAL = Math.round(
  BENCHMARK_TARGET_FPS / FIELD_UPDATE_HZ,
);

if (!navigator.gpu) {
  document.body.innerHTML =
    '<p class="error">WebGPU is not available in this browser.</p>';
  throw new Error("WebGPU not available");
}

const renderer = new WebGPURenderer({ trackTimestamp: true });
const inspector = new Inspector();
renderer.inspector = inspector;
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
await renderer.init();

interface WebGpuBenchmarkBackend {
  trackTimestamp: boolean;
  device: {
    queue: {
      onSubmittedWorkDone(): Promise<void>;
    };
  };
}

interface TimestampInspector {
  resolveTimestamp(): Promise<void>;
}

const backend = renderer.backend as typeof renderer.backend &
  WebGpuBenchmarkBackend;
backend.trackTimestamp = true;

// 0 means the library's own default: the power of two at or below half the
// drawing buffer's longer side, clamped to [256, 512].
const AUTO_RESOLUTION = 0;
let fieldResolution = AUTO_RESOLUTION;

function createLighting(resolution: number): ScreenSpaceRC {
  return new ScreenSpaceRC(renderer, {
    padding: FIELD_PADDING,
    groundHeight: 0,
    ambientIntensity: 0.9,
    temporalBlend: 0.8,
    resolution: resolution === AUTO_RESOLUTION ? undefined : resolution,
  });
}

let lighting = createLighting(fieldResolution);

// Split Radiance Cascades solves in world space, so it costs a voxelisation of
// the scene and a probe hierarchy that neither exist until it is first picked.
let splitLighting: SplitRC | null = null;
let solver: "screen" | "split" = "screen";

function activeSplitLighting(): SplitRC {
  // Query overrides make the solver tunable from a headless CDP run, e.g.
  // `?probeSpacing=2&rayDensity=0.25`.
  const query = new URLSearchParams(location.search);
  const override = (name: string): number | undefined => {
    const value = Number(query.get(name));
    return query.has(name) && Number.isFinite(value) ? value : undefined;
  };
  if (!splitLighting) {
    splitLighting = new SplitRC(renderer, {
      skyIntensity: override("skyIntensity") ?? 1,
      temporalBlend: override("temporalBlend") ?? 0.9,
      probeSpacing: override("probeSpacing"),
      rayDensity: override("rayDensity"),
      lodDistance: override("lodDistance"),
      probeCapacity: override("probeCapacity"),
    });
    // The panel outlives the solver's first build, so a value picked before the
    // solver existed still has to land on it.
    splitLighting.temporalBlend = debugControls.temporal;
    splitLighting.skyIntensity = debugControls.sky;
    splitLighting.t0Scale = debugControls.t0;
    splitLighting.debugView = debugControls.splitView;
    splitLighting.debugCascade = debugControls.debugCascade;
  }
  return splitLighting;
}

const builders: Record<DemoSceneId, () => DemoScene | Promise<DemoScene>> = {
  rooms: () => createRoomsScene(renderer.domElement),
  platformer: () => createPlatformerScene(renderer.domElement),
  picaPica: () => createPicaPicaScene(renderer.domElement),
  dungeon: () => createDungeonScene(),
};

// Only the scene on screen is built before the first frame; the glTF ones cost
// ~300ms of parsing between them, which is most of the startup budget.
const rooms = createRoomsScene(renderer.domElement);
const scenes: Partial<Record<DemoSceneId, DemoScene>> = { rooms };

async function loadScene(id: DemoSceneId): Promise<DemoScene> {
  const cached = scenes[id];
  if (cached) return cached;
  const built = await builders[id]();
  built.resize(window.innerWidth / window.innerHeight);
  built.setEmissionScale(debugControls.emission);
  scenes[id] = built;
  return built;
}

let activeScene: DemoScene = rooms;
activeScene.setActive(true);
lighting.domain = activeScene.domain;

// Mesh types its material as one-or-many; a quad has exactly the one it was
// built with, which is what lets a view be disposed when it is replaced.
type TextureView = QuadMesh & { material: MeshBasicNodeMaterial };

/** Fullscreen view of one field-space texture; `channel` shows it as gray. */
function textureView(
  source: Texture,
  scale = 1,
  channel?: "r" | "a",
): TextureView {
  const material = new MeshBasicNodeMaterial();
  const sample = texture(source, screenUV);
  const scalar = channel === "a" ? sample.a : sample.r;
  material.colorNode = channel
    ? vec3(scalar.mul(scale))
    : sample.rgb.mul(scale);
  material.depthTest = false;
  material.depthWrite = false;
  return new QuadMesh(material) as TextureView;
}

// Rebuilt whenever the field resolution changes: each view binds one of the
// lighting's textures, and a new solve owns new targets.
function createDebugViews() {
  return {
    light: textureView(lighting.lightTexture),
    direct: textureView(lighting.directTexture),
    distance: textureView(lighting.distanceTexture, 1 / 64, "r"),
    // The two inputs the footprint solve is built from: what it treats as
    // solid, and the local floor those heights are measured against.
    mask: textureView(lighting.maskTexture, 1, "a"),
    floor: textureView(lighting.floorTexture, 1 / 8, "r"),
    contact: textureView(lighting.contactTexture, 1, "r"),
  };
}
let debugViews = createDebugViews();
type DebugView = keyof ReturnType<typeof createDebugViews> | "composite";

interface DebugControls {
  scene: DemoSceneId;
  view: DebugView;
  splitView: SplitDebugView;
  /** Cascade the `probeIndex` view and the inspector's highlight refer to. */
  debugCascade: number;
  probeInspector: boolean;
  resolution: number;
  solver: string;
  fieldSize: string;
  temporal: number;
  ambient: number;
  sky: number;
  t0: number;
  emission: number;
  contact: number;
  contactRadius: number;
  liveProfiler: boolean;
  benchmarkStatus: string;
  benchmark4K(): void;
}

let debugView: DebugView = "composite";
let resetTemporalHistory = true;
let sceneFrames = 0;
const debugControls: DebugControls = {
  solver,
  scene: "rooms",
  view: debugView,
  splitView: "composite",
  debugCascade: 0,
  probeInspector: false,
  resolution: fieldResolution,
  fieldSize: `${lighting.fieldWidth}x${lighting.fieldHeight}`,
  temporal: lighting.temporalBlend,
  ambient: lighting.ambientIntensity,
  sky: 1,
  t0: SPLIT_T0_OVER_DS0,
  emission: 1,
  contact: lighting.contactStrength,
  contactRadius: lighting.contactRadius,
  liveProfiler: true,
  benchmarkStatus: "Not run",
  benchmark4K() {
    void run4KBenchmark();
  },
};

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Demo element is missing: ${selector}`);
  return element;
}

const hudTitle = requiredElement("#hud-title");
const hudInstructions = requiredElement("#hud-instructions");
const credit = requiredElement("#credit");
const probeReadout = requiredElement("#probe");

// ------------------------------------------------------------ probe inspector

/**
 * The sparse cascade hierarchy over the pixel under the cursor: which cell of
 * each cascade covers it, and which probe — if any — was allocated for that
 * cell. The `cascadeIndex` and `probeIndex` views show where probes are missing;
 * this says which ones, so a hole on screen can be read as a key and a slot.
 *
 * Sampled on a timer rather than per frame: each report reads both hashmaps back
 * off the GPU, which stalls the queue.
 */
const PROBE_SAMPLE_INTERVAL = 0.15;
const pointerPixel = { x: -1, y: -1 };
let probeSampleTime = 0;
let probePending = false;
let probeReport: SplitProbeReport | null = null;
/**
 * Probes used per cascade. A cascade at capacity drops probes, and the ones
 * below it lose the cone they merge against over whatever region that happened
 * in — which reads as a soft boundary rather than as missing probes.
 */
let probeStats: Awaited<ReturnType<SplitRC["stats"]>> | null = null;

renderer.domElement.addEventListener("pointermove", (event) => {
  pointerPixel.x = event.clientX;
  pointerPixel.y = event.clientY;
});

/** Palette of SplitRC's `cascadeIndex` view, for the readout's legend. */
const CASCADE_SWATCHES = ["#f2596f", "#f2b23f", "#5fd995", "#6ea5f2"];

function swatch(color: string): string {
  return `<span class="swatch" style="background:${color}"></span>`;
}

function probeLegend(): string {
  if (debugControls.splitView === "cascadeIndex") {
    const entries = CASCADE_SWATCHES.map(
      (color, cascade) => `${swatch(color)}c${cascade}`,
    ).join(" ");
    return `<span class="key">deepest cascade with a probe: ${entries} ${swatch("#000")}none</span>`;
  }
  if (debugControls.splitView === "probeIndex") {
    return (
      `<span class="key">cascade ${debugControls.debugCascade}: one flat colour per probe · ` +
      `${swatch("#f00")}cascade full ${swatch("#0f0f17")}no probe</span>`
    );
  }
  return '<span class="key">pick the Cascade index or Probe index view to see this on screen</span>';
}

function formatVector(v: readonly [number, number, number], digits = 2): string {
  return v.map((n) => n.toFixed(digits).padStart(digits + 4)).join(" ");
}

function probeReadoutText(report: SplitProbeReport): string {
  const rows = report.cascades.map((entry) => {
    const cell = entry.coord.map((n) => String(n).padStart(4)).join(",");
    const where =
      entry.probe === null
        ? `<span class="missing">${entry.status === "full" ? "CASCADE FULL" : "no probe"}</span>`
        : `probe ${entry.probe}/${entry.probeCapacity}  slot ${entry.slot}`;
    // The LOD is per entry because a cell inside the overlap band may only have
    // been seeded at the LOD above the one the pixel sits in.
    const lod = entry.lod === report.lod ? "   " : ` L${entry.lod}`;
    return `c${entry.cascade}${lod} Δs ${entry.spacing.toFixed(2).padStart(6)}  cell ${cell}  ${where}`;
  });
  return [
    `<b>probe inspector</b>  px ${report.pixel[0]},${report.pixel[1]}`,
    `world ${formatVector(report.position)}`,
    `LOD ${report.lod}→${report.nextLod} blend ${report.lodWeight.toFixed(2)}` +
      `   Δs₀ ${report.spacing0.toFixed(3)}`,
    ...(probeStats
      ? [
          "used " +
            probeStats.probes
              .map((used, n) => {
                const cap = probeStats!.capacity[n] ?? 0;
                const text = `c${n} ${used}/${cap}`;
                return used >= cap ? `<span class="missing">${text}</span>` : text;
              })
              .join("  ") +
            `  rays ${probeStats.rays}`,
        ]
      : []),
    ...rows,
  ].join("\n");
}

function updateProbeReadout(): void {
  const on = debugControls.probeInspector && solver === "split";
  probeReadout.hidden = !on;
  if (!on) return;
  probeReadout.innerHTML =
    (probeReport?.hit
      ? probeReadoutText(probeReport)
      : "<b>probe inspector</b>\nno surface under the cursor") + probeLegend();
}

function setProbeInspector(enabled: boolean): void {
  debugControls.probeInspector = enabled;
  if (!enabled) probeReport = null;
  updateProbeReadout();
}

function sampleProbe(deltaTime: number): void {
  if (!debugControls.probeInspector || solver !== "split" || !splitLighting) return;
  probeSampleTime += deltaTime;
  if (probePending || probeSampleTime < PROBE_SAMPLE_INTERVAL) return;
  if (pointerPixel.x < 0) return;
  probeSampleTime = 0;
  probePending = true;
  const ratio = renderer.getPixelRatio();
  const lighting = splitLighting;
  Promise.all([
    lighting.inspectPixel(pointerPixel.x * ratio, pointerPixel.y * ratio),
    lighting.stats(),
  ])
    .then(([report, counts]) => {
      probeReport = report;
      probeStats = counts;
      updateProbeReadout();
    })
    .catch((error: unknown) => {
      console.error("[probe inspector]", error);
      setProbeInspector(false);
    })
    .finally(() => {
      probePending = false;
    });
}

function updateHud(): void {
  hudTitle.textContent = activeScene.title;
  hudInstructions.textContent = activeScene.instructions;
  credit.innerHTML = activeScene.credit ?? "";
  credit.hidden = activeScene.credit === null;
}

function blurInspectorSelect(): void {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

let requestedScene: DemoSceneId = "rooms";

async function setScene(value: string): Promise<void> {
  if (!(value in builders)) return;
  const id = value as DemoSceneId;
  if (id === activeScene.id) return;

  // A first visit builds the scene here, with the loop still drawing the old
  // one; if another scene is picked during that wait, the later pick wins.
  requestedScene = id;
  const nextScene = await loadScene(id);
  if (requestedScene !== id) return;

  activeScene.setActive(false);
  activeScene = nextScene;
  activeScene.setActive(true);
  lighting.domain = activeScene.domain;
  debugControls.scene = activeScene.id;
  resetTemporalHistory = true;
  sceneFrames = 0;
  updateHud();
  blurInspectorSelect();
}

// Field extent is fixed at construction — the cascade count, every ray target
// and the whole pass chain are sized from it — so changing it means a new solve.
// The old one is disposed only after the new one stands, and the first frame
// through it compiles its passes, so expect one hitch.
function setResolution(value: number): void {
  if (value === fieldResolution) return;
  fieldResolution = value;
  debugControls.resolution = value;

  const previous = lighting;
  lighting = createLighting(value);
  lighting.temporalBlend = debugControls.temporal;
  lighting.ambientIntensity = debugControls.ambient;
  lighting.contactStrength = debugControls.contact;
  lighting.contactRadius = debugControls.contactRadius;
  lighting.domain = activeScene.domain;
  for (const view of Object.values(debugViews)) view.material.dispose();
  debugViews = createDebugViews();
  previous.dispose();

  debugControls.fieldSize = `${lighting.fieldWidth}x${lighting.fieldHeight}`;
  (window as unknown as Record<string, unknown>).__lighting = lighting;
  resetTemporalHistory = true;
  blurInspectorSelect();
}

function setDebugView(value: string): void {
  if (value === "composite" || value in debugViews) {
    debugView = value as DebugView;
  } else {
    debugView = "composite";
  }
  debugControls.view = debugView;
  blurInspectorSelect();
}

function setSplitView(value: string): void {
  debugControls.splitView = value as SplitDebugView;
  if (splitLighting) splitLighting.debugView = debugControls.splitView;
  updateProbeReadout();
  blurInspectorSelect();
}

function setDebugCascade(value: number): void {
  debugControls.debugCascade = value;
  if (splitLighting) splitLighting.debugCascade = value;
  updateProbeReadout();
  blurInspectorSelect();
}

// The two solvers expose different knobs — the 2.5D field has no sky and the
// split cascades have no contact pass — so the panel swaps rows instead of
// showing controls that quietly do nothing.
function applySolverVisibility(): void {
  const split = solver === "split";
  for (const row of screenOnly) split ? row.hide() : row.show();
  for (const row of splitOnly) split ? row.show() : row.hide();
}

function setSolver(value: string): void {
  solver = value === "split" ? "split" : "screen";
  debugControls.solver = solver;
  if (solver === "split") activeSplitLighting();
  applySolverVisibility();
  updateProbeReadout();
  resetTemporalHistory = true;
  sceneFrames = 0;
  blurInspectorSelect();
}

const parameters = inspector.createParameters("Radiance Cascades 2.5D");
parameters
  .add(debugControls, "solver", {
    "2.5D screen space": "screen",
    "3D split cascades": "split",
  })
  .name("Solver")
  .onChange(setSolver)
  .listen();
parameters
  .add(debugControls, "scene", {
    Rooms: "rooms",
    Platformer: "platformer",
    "PICA PICA": "picaPica",
    Dungeon: "dungeon",
  })
  .name("Scene")
  .onChange(setScene)
  .listen();
const viewRow = parameters
  .add(debugControls, "view", {
    Composite: "composite",
    Light: "light",
    Direct: "direct",
    Distance: "distance",
    Mask: "mask",
    Floor: "floor",
    Contact: "contact",
  })
  .name("View")
  .onChange(setDebugView)
  .listen();
// The split solver has no intermediate render targets to blit — its stages are
// branches inside the composite shader — so this is a separate control.
const splitViewRow = parameters
  .add(debugControls, "splitView", {
    Composite: "composite",
    Light: "light",
    Emissive: "emissive",
    Albedo: "albedo",
    Normal: "normal",
    "LOD blend": "lod",
    "Voxel grid": "voxel",
    "Cascade index": "cascadeIndex",
    "Probe index": "probeIndex",
  })
  .name("View")
  .onChange(setSplitView)
  .listen();
// Probe spacing doubles per cascade, so stepping this over the `probeIndex` view
// is what makes the hierarchy visible: the same surface retiles into cells twice
// as wide at every step, and where a cascade has no probe the cell goes dark.
const debugCascadeRow = parameters
  .add(
    debugControls,
    "debugCascade",
    Object.fromEntries(
      Array.from({ length: SPLIT_CASCADES }, (_, n) => [`Cascade ${n}`, n]),
    ),
  )
  .name("Probe cascade")
  .onChange(setDebugCascade)
  .listen();
const probeInspectorRow = parameters
  .add(debugControls, "probeInspector")
  .name("Probe inspector")
  .onChange(setProbeInspector)
  .listen();
// Cost is O(size^2 · log size) in both memory and pass count, so a step down
// here is the one control that buys several times the solve throughput.
const resolutionRow = parameters
  .add(debugControls, "resolution", {
    Auto: AUTO_RESOLUTION,
    128: 128,
    256: 256,
    512: 512,
    1024: 1024,
  })
  .name("Field resolution")
  .onChange(setResolution)
  .listen();
const fieldSizeRow = parameters
  .add(debugControls, "fieldSize")
  .name("Field size")
  .listen();
// Both solvers accumulate over time, so this one stays on screen and drives
// whichever is running.
parameters
  .add(debugControls, "temporal", 0, 0.95, 0.05)
  .name("Temporal")
  .onChange((value) => {
    lighting.temporalBlend = value;
    if (splitLighting) splitLighting.temporalBlend = value;
  });
const ambientRow = parameters
  .add(debugControls, "ambient", 0, 4, 0.05)
  .name("Ambient")
  .onChange((value) => {
    lighting.ambientIntensity = value;
  });
const skyRow = parameters
  .add(debugControls, "sky", 0, 4, 0.05)
  .name("Sky")
  .onChange((value) => {
    if (splitLighting) splitLighting.skyIntensity = value;
  });
// The cascade bounds sit at t₀·{1, 5, 21, 85}, and nothing else in the solver
// is a fixed distance from a light. Dragging this is how you tell a bound from
// anything else that happens to be round: a bound moves with it.
const t0Row = parameters
  .add(debugControls, "t0", 0.8, 8, 0.1)
  .name("t0 / spacing")
  .onChange((value) => {
    if (splitLighting) splitLighting.t0Scale = value;
  });
const contactRow = parameters
  .add(debugControls, "contact", 0, 1, 0.05)
  .name("Contact shadow")
  .onChange((value) => {
    lighting.contactStrength = value;
  });
const contactRadiusRow = parameters
  .add(debugControls, "contactRadius", 0.05, 1.5, 0.05)
  .name("Contact radius")
  .onChange((value) => {
    lighting.contactRadius = value;
  });
parameters
  .add(debugControls, "emission", 0, 3, 0.05)
  .name("Emission")
  .onChange((value) => {
    for (const demoScene of Object.values(scenes)) {
      demoScene?.setEmissionScale(value);
    }
  });
parameters
  .add(debugControls, "liveProfiler")
  .name("Live profiler (slow)")
  .onChange(setLiveProfiler)
  .listen();
parameters.add(debugControls, "benchmark4K").name("Benchmark 4K");
parameters.add(debugControls, "benchmarkStatus").name("Benchmark").listen();

// three's inspector typings omit Value.show()/hide(); both exist at runtime and
// are what the Parameters tab listens to for hiding a row.
const toggle = (row: unknown) => row as { show(): void; hide(): void };
const screenOnly = [
  viewRow,
  resolutionRow,
  fieldSizeRow,
  ambientRow,
  contactRow,
  contactRadiusRow,
].map(toggle);
const splitOnly = [
  splitViewRow,
  debugCascadeRow,
  probeInspectorRow,
  skyRow,
  t0Row,
].map(toggle);
applySolverVisibility();

function resize(): void {
  const aspect = window.innerWidth / window.innerHeight;
  for (const demoScene of Object.values(scenes)) {
    demoScene?.resize(aspect);
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);
resize();
updateHud();

let lastFrameTime = performance.now();
let fieldUpdateTime = FIELD_UPDATE_INTERVAL;
function tick(time: number): void {
  const deltaTime = Math.min((time - lastFrameTime) / 1000, 0.05);
  lastFrameTime = time;
  activeScene.update(deltaTime);

  fieldUpdateTime += deltaTime;
  const updateFields =
    resetTemporalHistory || fieldUpdateTime >= FIELD_UPDATE_INTERVAL;
  const temporalBlend = lighting.temporalBlend;
  if (resetTemporalHistory && updateFields) lighting.temporalBlend = 0;
  renderer.setRenderTarget(null);
  if (solver === "split") {
    activeSplitLighting().render(activeScene.scene, activeScene.camera);
    resetTemporalHistory = false;
    sampleProbe(deltaTime);
  } else {
    lighting.render(activeScene.scene, activeScene.camera, updateFields);
    if (resetTemporalHistory && updateFields) {
      lighting.temporalBlend = temporalBlend;
      resetTemporalHistory = false;
    }
    if (debugView !== "composite") debugViews[debugView].render(renderer);
  }
  if (updateFields) fieldUpdateTime %= FIELD_UPDATE_INTERVAL;

  sceneFrames++;
  if (sceneFrames === 20) {
    const state = {
      scene: activeScene.id,
      solver,
      meshes: activeScene.meshCount,
      materials: activeScene.materialCount,
      emitters: activeScene.emitterCount,
      field: {
        width: lighting.fieldWidth,
        height: lighting.fieldHeight,
        padding: lighting.padding,
      },
      voxels: splitLighting
        ? {
            resolution: splitLighting.voxels.resolution,
            voxelSize: splitLighting.voxels.voxelSize,
            points: splitLighting.voxels.pointCount,
          }
        : null,
    };
    (window as unknown as Record<string, unknown>).__demoReady = state;
    console.log("[demo-ready]", JSON.stringify(state));
  }
}
await renderer.setAnimationLoop(tick);

// Built behind the first frames so picking them from the dropdown is still
// instant, without their parse cost landing before anything is on screen.
void loadScene("picaPica").then(() => loadScene("dungeon"));

let benchmarkRunning = false;

function setLiveProfiler(enabled: boolean): void {
  debugControls.liveProfiler = enabled;
  if (enabled) {
    renderer.inspector = inspector;
  } else {
    renderer.inspector = new InspectorBase();
    backend.trackTimestamp = false;
  }
}

// The benchmark has to run whatever is on screen. It used to always call
// `lighting`, so picking the split solver and hitting the button measured the
// screen-space one instead — 200-plus fps reported over a frame that was
// actually crawling.
function renderBenchmarkFrame(frame: number): void {
  if (solver === "split") {
    activeSplitLighting().render(activeScene.scene, activeScene.camera);
  } else {
    lighting.render(
      activeScene.scene,
      activeScene.camera,
      frame % BENCHMARK_FIELD_INTERVAL === 0,
    );
  }
}

async function measureGpuActiveMs(): Promise<number | undefined> {
  if (!renderer.hasFeature("timestamp-query")) return undefined;

  backend.trackTimestamp = true;
  try {
    let total = 0;
    for (let frame = 0; frame < BENCHMARK_FIELD_INTERVAL; frame++) {
      renderBenchmarkFrame(frame);
      // SplitRC is almost entirely compute, so RENDER alone reported a
      // fraction of the frame as the whole of it.
      total +=
        ((await renderer.resolveTimestampsAsync(TimestampQuery.RENDER)) ?? 0) +
        ((await renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE)) ?? 0);
    }
    return total / BENCHMARK_FIELD_INTERVAL;
  } finally {
    backend.trackTimestamp = false;
  }
}

async function run4KBenchmark(): Promise<void> {
  if (benchmarkRunning) return;
  benchmarkRunning = true;
  debugControls.benchmarkStatus = "Running...";
  const restoreLiveProfiler = debugControls.liveProfiler;
  const target = new RenderTarget(BENCHMARK_WIDTH, BENCHMARK_HEIGHT, {
    depthBuffer: false,
  });

  try {
    await renderer.setAnimationLoop(null);
    if (restoreLiveProfiler) {
      await (inspector as Inspector & TimestampInspector).resolveTimestamp();
    }
    setLiveProfiler(false);
    renderer.setRenderTarget(target);
    activeScene.resize(BENCHMARK_WIDTH / BENCHMARK_HEIGHT);

    backend.trackTimestamp = false;
    for (let frame = 0; frame < BENCHMARK_WARMUP_FRAMES; frame++) {
      renderBenchmarkFrame(frame);
    }
    await backend.device.queue.onSubmittedWorkDone();

    const start = performance.now();
    for (let frame = 0; frame < BENCHMARK_FRAMES; frame++) {
      renderBenchmarkFrame(frame);
    }
    const submitEnd = performance.now();
    await backend.device.queue.onSubmittedWorkDone();
    const end = performance.now();

    const gpuActiveMs = await measureGpuActiveMs();

    const cpuSubmitMs = (submitEnd - start) / BENCHMARK_FRAMES;
    const endToEndMs = (end - start) / BENCHMARK_FRAMES;
    const fps = 1000 / endToEndMs;
    const targetFps =
      solver === "split" ? BENCHMARK_SPLIT_TARGET_FPS : BENCHMARK_TARGET_FPS;
    const passed = endToEndMs <= 1000 / targetFps;
    debugControls.benchmarkStatus =
      `${passed ? "PASS" : "FAIL"} ${solver} ${fps.toFixed(0)}/${targetFps} fps | ` +
      `CPU ${cpuSubmitMs.toFixed(2)} ms | ` +
      `GPU active ${gpuActiveMs?.toFixed(2) ?? "n/a"} ms | ` +
      `E2E ${endToEndMs.toFixed(2)} ms`;
    console.table({
      resolution: `${BENCHMARK_WIDTH}x${BENCHMARK_HEIGHT}`,
      outputFps: Number(fps.toFixed(2)),
      cpuSubmitMs: Number(cpuSubmitMs.toFixed(3)),
      gpuActiveMs:
        gpuActiveMs === undefined
          ? "unsupported"
          : Number(gpuActiveMs.toFixed(3)),
      endToEndMs: Number(endToEndMs.toFixed(3)),
      solver,
      fieldUpdateHz: FIELD_UPDATE_HZ,
      [`target${targetFps}Fps`]: passed ? "PASS" : "FAIL",
    });
  } catch (error) {
    debugControls.benchmarkStatus = "ERROR (see console)";
    console.error("[4K benchmark]", error);
  } finally {
    backend.trackTimestamp = false;
    renderer.setRenderTarget(null);
    target.dispose();
    activeScene.resize(window.innerWidth / window.innerHeight);
    resetTemporalHistory = true;
    fieldUpdateTime = FIELD_UPDATE_INTERVAL;
    lastFrameTime = performance.now();
    if (restoreLiveProfiler) setLiveProfiler(true);
    benchmarkRunning = false;
    await renderer.setAnimationLoop(tick);
  }
}

const globals = window as unknown as Record<string, unknown>;
globals.__lighting = lighting;
globals.__renderer = renderer;
globals.__scenes = scenes;
globals.__split = () => splitLighting;
globals.__ui = {
  setScene,
  setDebugView,
  setSplitView,
  setDebugCascade,
  setProbeInspector,
  setResolution,
  setSolver,
};
// Reachable from a headless CDP run, where there is no cursor to hover with:
// `await __probe(x, y)` returns the same report the inspector panel formats.
globals.__probe = (x: number, y: number) =>
  splitLighting?.inspectPixel(x * renderer.getPixelRatio(), y * renderer.getPixelRatio());
globals.__benchmark4K = run4KBenchmark;
