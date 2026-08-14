/// <reference types="tscene/client" />
// three's `webgpu_geometry_loft` example, driven from a `.tscene` sheet.
//
// The sheet (`scenes/loft.tscene`) owns the exhibition: every `loftGeometry()` in it is the addon class,
// which the vite plugin imports from `three/addons/geometries/LoftGeometry.js` by name. What a declarative
// sheet cannot express — the cross sections, the TSL shader graphs, one procedurally placed subtree — is
// handed to it through `registry`, and named in `declared.ts` so the checker knows those names are real.
//
// Left here, because all three need the renderer: the room environment, the vignette behind the scene, and
// the inspector panel. Plus the wireframe of rings, which is rebuilt out of the sheet's own meshes —
// every loft remembers what it was skinned through in `geometry.parameters`.
import * as THREE from "three/webgpu";
import { screenUV, color } from "three/tsl";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mountScene } from "tscene";
import { registry } from "./registry.ts";
import sheet from "../scenes/loft.tscene";

const msg = document.getElementById("msg")!;

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const inspector = new Inspector();
renderer.inspector = inspector;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.4;
// a vignette in the background
scene.backgroundNode = screenUV.distance(0.5).mix(color(0x5d5d84), color(0x2e2e44));

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 1000);
camera.position.set(0, 15, 40);

const controls = new OrbitControls(camera, renderer.domElement);
controls.minDistance = 15;
controls.maxDistance = 50; // stay inside the curtain
controls.target.set(0, -3, 0);
controls.update();

/** what the inspector's two switches are showing right now; a hot reload re-applies them */
const view = { sections: false, wireframe: false };

let turntable: THREE.Object3D | undefined;
let skeleton: THREE.Group | undefined;
let lofts: THREE.Mesh[] = [];

/** what a `LoftGeometry` remembers of how it was made */
type LoftParameters = { sections: THREE.Vector3[][]; closed: boolean };

/**
 * A skeleton of rings, rebuilt from the meshes the sheet built: a loft keeps the sections it was skinned
 * through in `geometry.parameters`, so nothing but the scene graph is needed to draw them.
 *
 * The material is per build, not shared: the skeleton hangs inside the root, and `mountScene` disposes
 * the old root wholesale on every hot update.
 */
function buildSkeleton(root: THREE.Object3D): THREE.Group {
  const group = new THREE.Group();
  const lineMaterial = new THREE.LineBasicMaterial({ color: 0xaaccee });
  group.visible = false;
  root.updateMatrixWorld(true);

  for (const mesh of lofts) {
    const { sections, closed } = (mesh.geometry as unknown as { parameters: LoftParameters }).parameters;
    const step = Math.max(1, Math.round(sections.length / 20)); // ~20 rings per loft, however many it has
    const positions: number[] = [];
    const addRing = (ring: THREE.Vector3[]) => {
      const segments = closed ? ring.length : ring.length - 1;
      for (let j = 0; j < segments; j++) {
        const a = ring[j]!;
        const b = ring[(j + 1) % ring.length]!;
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    };
    for (let i = 0; i < sections.length; i += step) addRing(sections[i]!);
    if ((sections.length - 1) % step !== 0) addRing(sections[sections.length - 1]!);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const lines = new THREE.LineSegments(geometry, lineMaterial);
    lines.applyMatrix4(mesh.matrixWorld);
    group.add(lines);
  }
  return group;
}

/** the two switches, applied to whatever the current root is — a hot reload lands here too */
function apply(root: THREE.Group) {
  if (skeleton) skeleton.visible = view.sections;
  for (const mesh of lofts) mesh.visible = !view.sections;
  const liquid = root.getObjectByName("liquid");
  if (liquid) liquid.visible = !view.sections;

  root.traverse((child) => {
    // `wireframe` is on every material three draws a surface with, but not on the abstract base
    for (const material of ([] as THREE.Material[]).concat((child as THREE.Mesh).material ?? [])) {
      (material as THREE.MeshStandardMaterial).wireframe = view.wireframe;
      material.needsUpdate = true;
    }
  });
}

const mount = await mountScene(scene, sheet, {
  registry,
  onLoad: (root) => {
    turntable = root.getObjectByName("turntable");
    lofts = [];
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry.type === "LoftGeometry") lofts.push(mesh);
    });
    // the skeleton is not part of the sheet, so it is parented to the group that spins
    (turntable ?? root).add((skeleton = buildSkeleton(root)));
    apply(root);
    msg.textContent = "";
  },
  onError: (e) => (msg.textContent = String((e as Error).message)),
});

const parameters = inspector.createParameters("Parameters");
parameters.add(view, "sections").onChange(() => mount.root && apply(mount.root));
parameters.add(view, "wireframe").onChange(() => mount.root && apply(mount.root));

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  if (turntable) turntable.rotation.y += 0.001;
  controls.update();
  renderer.render(scene, camera);
});
