/// <reference types="tscene/client" />
// The room, twice: once lit by the baked atlas, once by the realtime point light. Press G to swap.
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadScene } from "tscene";
import { applyLightmap, loadLightmap, muteBakedLights } from "scene-lightmapper";
import sheet from "../scenes/room.tscene";

const msg = document.getElementById("msg")!;
const hud = document.getElementById("hud")!;

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0.4, 1.7, 6.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.35, 0);
controls.maxDistance = 12;

const root = await loadScene(sheet);
scene.add(root);

// what the realtime pass uses, so the toggle can put it back after muteBakedLights()
const intensities = new Map<THREE.Light, number>();
root.traverse((o) => {
  const light = o as THREE.Light;
  if (light.isLight) intensities.set(light, light.intensity);
});

const bake = await loadLightmap("lightmaps/room.lightmap.json").catch(() => undefined);
let applied = 0;
if (bake) applied = applyLightmap(root, bake.manifest, bake.texture);

const lightMapped: THREE.MeshStandardMaterial[] = [];
root.traverse((o) => {
  for (const m of ([] as THREE.Material[]).concat((o as THREE.Mesh).material ?? [])) {
    if ((m as THREE.MeshStandardMaterial).lightMap) lightMapped.push(m as THREE.MeshStandardMaterial);
  }
});

let baked = Boolean(bake);
function setBaked(on: boolean) {
  baked = on && Boolean(bake);
  // intensity, not `lightMap = null`: dropping the texture changes the node graph, and the rebuild does
  // not come back when it is put back. Zero reads the same and costs one uniform.
  for (const m of lightMapped) m.lightMapIntensity = baked ? bake!.manifest.intensity : 0;
  // a lightmap already contains every light it was baked from; leaving them on counts them twice
  if (baked) muteBakedLights(root);
  else for (const [light, intensity] of intensities) light.intensity = intensity;

  hud.textContent = bake
    ? `[G] ${baked ? "baked GI" : "realtime direct only"}\n${bake.manifest.width}px atlas, ${applied} meshes`
    : "";
}

msg.textContent = bake
  ? ""
  : "no lightmap yet.\nrun `pnpm bake:lightmapper` from the repo root, then reload.";
hud.hidden = !bake;
setBaked(true);

addEventListener("keydown", (e) => {
  if (e.key === "g" || e.key === "G") setBaked(!baked);
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
