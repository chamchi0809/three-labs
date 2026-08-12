/// <reference types="tscene/client" />
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mountScene } from "tscene";
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

let spinner: THREE.Object3D | undefined;

// the vite plugin re-transforms the sheet on save, and the mount rebuilds it wholesale — cheap enough,
// and `onLoad` runs again so anything held out of the tree is picked up from the new root
const mount = await mountScene(scene, sheet, {
  onLoad: (root) => {
    spinner = root.getObjectByName("spinner");
    msg.textContent = "";
  },
  onError: (e) => (msg.textContent = String((e as Error).message)),
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop((t) => {
  if (spinner) spinner.rotation.y = (t / 1000) * Number(spinner.userData.spin ?? 0.5);
  mount.update(); // advances the clips play() started
  controls.update();
  renderer.render(scene, camera);
});
