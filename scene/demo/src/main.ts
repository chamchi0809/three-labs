/// <reference types="tscene/client" />
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { disposeScene, loadScene, onSceneChange, updateScene } from "tscene";
import sheet from "../scenes/main.tscene";

const msg = document.getElementById("msg")!;

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 100);
camera.position.set(4, 3.5, 6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);

let root: THREE.Group | undefined;
let spinner: THREE.Object3D | undefined;

async function build() {
  try {
    // loadScene always reads the sheet's current version, so the imported module stays valid across reloads
    const next = await loadScene(sheet);
    if (root) disposeScene(root);
    scene.add((root = next));
    spinner = next.getObjectByName("spinner");
    msg.textContent = "";
  } catch (e) {
    msg.textContent = String((e as Error).message);
  }
}

await build();
// the vite plugin re-transforms the sheet on save; rebuilding is cheap enough to just do it wholesale
onSceneChange(() => void build());

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let last = 0;
renderer.setAnimationLoop((t) => {
  const dt = last ? (t - last) / 1000 : 0;
  last = t;
  if (spinner) spinner.rotation.y = (t / 1000) * Number(spinner.userData.spin ?? 0.5);
  if (root) updateScene(root, dt); // advances the clips play() started
  controls.update();
  renderer.render(scene, camera);
});
