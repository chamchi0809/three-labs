/// <reference types="tscene/client" />
// Two scenes, each shown twice over: lit by its baked atlas, or by the realtime lights the sheet
// declares. [G] swaps between the two, [S] cycles the scene, and three's own inspector carries the
// same switches plus the knobs that decide how a bake reads: lightmap gain, exposure, tone mapping.
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { loadScene, type SceneModule } from "tscene";
import { applyLightmap, type Lightmap } from "tscene/bakery";
import room from "../scenes/room.tscene";
import sponza from "../scenes/sponza.tscene";

/** how a scene wants to be shown. The atlas carries irradiance, not a look, so this is per scene. */
type View = { lightmap: number; exposure: number; toneMapping: THREE.ToneMapping };

// Khronos PBR Neutral, not ACES. three's ACES is the Narkowicz curve, whose toe is ~0.21x near black,
// and a bake's whole subject is what sits down there — the toe pushes the indirect term under a byte.
const DEFAULT_VIEW: View = { lightmap: 1, exposure: 1, toneMapping: THREE.NeutralToneMapping };

type Entry = {
  name: string;
  sheet: SceneModule;
  eye: [number, number, number];
  target: [number, number, number];
  maxDistance: number;
  /** what to run when there is no lightmap on disk yet */
  bake: string;
  note?: string;
  view?: Partial<View>;
};

const SCENES: Entry[] = [
  { name: "room", sheet: room, eye: [0.4, 1.7, 6.4], target: [0, 1.35, 0], maxDistance: 12, bake: "pnpm bake:bakery" },
  // the model is fetched from a CDN, so the first switch to it sits on ~50 MB of glTF. Sponza is a sunlit
  // exterior seen from a shaded interior, so its 99th-percentile exposure sits far above what the arcades
  // read: it wants the gain and the headroom back, and a curve that keeps rolling instead of clamping.
  {
    name: "sponza",
    sheet: sponza,
    eye: [9.5, 2.4, 1.4],
    target: [0, 3.2, 0],
    maxDistance: 60,
    bake: "pnpm bake:bakery:sponza",
    note: "downloading ~50 MB of Sponza…",
    view: { lightmap: 4, exposure: 3, toneMapping: THREE.ReinhardToneMapping },
  },
];

const msg = document.getElementById("msg")!;
const hud = document.getElementById("hud")!;

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = DEFAULT_VIEW.toneMapping;
const inspector = new Inspector();
renderer.inspector = inspector;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 200);

const controls = new OrbitControls(camera, renderer.domElement);

/** a scene, plus its bake if one has been run — the handle owns the atlas/lights bookkeeping */
type Loaded = { root: THREE.Group; lightmap: Lightmap | undefined };

// kept around rather than disposed: re-entering sponza would otherwise re-download the whole model
const loaded = new Map<string, Loaded>();

async function load(entry: Entry): Promise<Loaded> {
  const root = await loadScene(entry.sheet);
  // nothing baked yet, or a bake that no longer matches the sheet — either way `entry.bake` is the fix
  const lightmap = await applyLightmap(root, `lightmaps/${entry.name}.lightmap.json`).catch((e: Error) =>
    void console.warn(e.message),
  );
  return { root, lightmap };
}

let index = 0;
let current: Loaded | undefined;
let baked = true;

// `lightmap` multiplies the manifest's exposure, `sun`/`sky` the intensity the sheet declares, so 1 is
// "as authored" for all three. The light gains only bite in the realtime pass — a bake already froze
// its lights in — which makes them the way to pick a value worth spending a rebake on.
const tune = { lightmap: DEFAULT_VIEW.lightmap, sun: 1, sky: 1 };
const view: { scene: number; baked: boolean; exposure: number; toneMapping: THREE.ToneMapping } = {
  scene: 0,
  baked: true,
  exposure: renderer.toneMappingExposure,
  toneMapping: renderer.toneMapping,
};
// annotated so the select overload has a concrete `T[K]` to match instead of inferring one per value
const TONE_MAPPING: Record<string, THREE.ToneMapping> = {
  ACES: THREE.ACESFilmicToneMapping,
  Neutral: THREE.NeutralToneMapping,
  AgX: THREE.AgXToneMapping,
  Reinhard: THREE.ReinhardToneMapping,
  Linear: THREE.LinearToneMapping,
  none: THREE.NoToneMapping,
};

function setToneMapping(next: THREE.ToneMapping) {
  view.toneMapping = next;
  if (renderer.toneMapping === next) return;
  renderer.toneMapping = next;
  // tone mapping lives in the node graph, so the materials have to be rebuilt to pick it up
  current?.root.traverse((o) => {
    for (const m of ([] as THREE.Material[]).concat((o as THREE.Mesh).material ?? [])) m.needsUpdate = true;
  });
}

function applyView(entry: Entry) {
  const wanted = { ...DEFAULT_VIEW, ...entry.view };
  tune.lightmap = wanted.lightmap;
  view.exposure = renderer.toneMappingExposure = wanted.exposure;
  setToneMapping(wanted.toneMapping);
}

function gain(light: THREE.Light): number {
  if ((light as THREE.DirectionalLight).isDirectionalLight) return tune.sun;
  if ((light as THREE.HemisphereLight).isHemisphereLight || (light as THREE.AmbientLight).isAmbientLight) return tune.sky;
  return 1;
}

function setBaked(on: boolean) {
  if (!current) return;
  const { lightmap } = current;
  baked = on && Boolean(lightmap);
  view.baked = baked;
  if (lightmap) {
    lightmap.intensity = tune.lightmap;
    // the handle zeroes the atlas and hands the lights their intensity back — a bake already contains
    // every light it was baked from, so leaving them on counts them twice
    lightmap.enabled = baked;
    // …at the intensity the sheet declared, which the realtime gains then scale
    if (!baked) for (const [light, intensity] of lightmap.lights) light.intensity = intensity * gain(light);
  }

  const entry = SCENES[index]!;
  hud.textContent = lightmap
    ? `[S] ${entry.name}   [G] ${baked ? "baked GI" : "realtime direct only"}\n${lightmap.width}px atlas, ${lightmap.meshes} meshes`
    : `[S] ${entry.name}   realtime only`;
}

let pending = Promise.resolve();
function show(next: number) {
  index = (next + SCENES.length) % SCENES.length;
  view.scene = index;
  const entry = SCENES[index]!;

  camera.position.set(...entry.eye);
  controls.target.set(...entry.target);
  controls.maxDistance = entry.maxDistance;
  controls.update();

  // a click during the sponza download would otherwise queue two loads of the same 50 MB
  pending = pending.then(async () => {
    if (SCENES[index] !== entry) return;
    if (current) scene.remove(current.root);
    current = loaded.get(entry.name);
    if (!current) {
      hud.hidden = true;
      msg.textContent = entry.note ?? "loading…";
      loaded.set(entry.name, (current = await load(entry)));
    }
    scene.add(current.root);
    msg.textContent = current.lightmap ? "" : `no lightmap for ${entry.name} yet.\nrun \`${entry.bake}\` from the repo root, then reload.`;
    hud.hidden = false;
    // after the root is in: a tone mapping change has to reach materials that exist
    applyView(entry);
    setBaked(true);
  });
}

show(0);

// the same two keys, plus what the keys cannot reach. `listen()` keeps the widgets honest when [G]
// or [S] is what moved them.
const sceneGroup = inspector.createParameters("scene");
sceneGroup.add(view, "scene", Object.fromEntries(SCENES.map((s, i) => [s.name, i]))).onChange((v) => show(v)).listen();
sceneGroup.add(view, "baked").name("baked GI").onChange((v) => setBaked(v)).listen();

const lightGroup = inspector.createParameters("lighting");
lightGroup.add(tune, "lightmap", 0, 8, 0.05).name("lightmap ×").onChange(() => setBaked(baked)).listen();
lightGroup.add(tune, "sun", 0, 4, 0.05).name("sun × (realtime)").onChange(() => setBaked(baked));
lightGroup.add(tune, "sky", 0, 8, 0.05).name("sky × (realtime)").onChange(() => setBaked(baked));

const outputGroup = inspector.createParameters("output");
outputGroup.add(view, "exposure", 0, 6, 0.05).onChange((v) => (renderer.toneMappingExposure = v)).listen();
outputGroup.add(view, "toneMapping", TONE_MAPPING).onChange(setToneMapping).listen();

addEventListener("keydown", (e) => {
  if (e.key === "g" || e.key === "G") setBaked(!baked);
  if (e.key === "s" || e.key === "S") show(index + 1);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
