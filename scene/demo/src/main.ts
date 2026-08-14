/// <reference types="tscene/client" />
// Two sheets, switched from three's inspector.
//
//   stage — the language's own surface: nesting, `@template`, `var()`/`calc()`, `gltf()` with `find()` and
//           `play()` reaching into it, a `texture()` the vite plugin turned into a hashed `?url` import.
//   loft  — three's `webgpu_geometry_loft` example. Every surface is `loftGeometry()`, the addon class,
//           which the plugin imports from `three/addons/geometries/LoftGeometry.js` by name. What a
//           declarative sheet cannot say — the cross sections, the TSL shader graphs, a subtree whose
//           fourteen copies need trigonometry — comes through `registry` (see `src/loft/`).
//
// Each sheet mounts into a container of its own, lazily and then for good, so switching is a `visible`
// flag and both keep hot-reloading. What is left here is what needs the renderer: the room environment,
// the vignette behind the loft, the inspector, and the wireframe of rings, which is rebuilt out of the
// sheet's own meshes — a loft remembers what it was skinned through in `geometry.parameters`.
import * as THREE from "three/webgpu";
import { color, screenUV } from "three/tsl";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mountScene, type Mount, type SceneModule } from "tscene";
import { registry as loftRegistry } from "./loft/registry.ts";
import stage from "../scenes/main.tscene";
import loft from "../scenes/loft.tscene";

const msg = document.getElementById("msg")!;
const about = document.getElementById("about")!;

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
const inspector = new Inspector();
renderer.inspector = inspector;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 100);
const controls = new OrbitControls(camera, renderer.domElement);

/** the loft stands in a room; generated once, and only if that sheet is ever shown */
let room: THREE.Texture | undefined;
const roomEnvironment = () => (room ??= new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture);

type Entry = {
  name: string;
  sheet: SceneModule;
  /** what three cannot supply: materials, data tables, a node the host builds itself */
  registry?: Record<string, unknown>;
  note: string;
  /** fov, near, far */
  lens: [number, number, number];
  eye: [number, number, number];
  target: [number, number, number];
  minDistance?: number;
  maxDistance?: number;
  toneMapping?: THREE.ToneMapping;
  /** the sky this sheet stands under. Whatever the last one set is cleared first */
  sky?: () => void;
  /** after every build of this sheet, hot updates included */
  load?: (root: THREE.Group) => void;
  /** once per frame, while this sheet is the one on screen */
  frame?: (elapsed: number) => void;
};

// ---------------------------------------------------------------- stage

let spinner: THREE.Object3D | undefined;

// ---------------------------------------------------------------- loft

/** what a `LoftGeometry` remembers of how it was made */
type LoftParameters = { sections: THREE.Vector3[][]; closed: boolean };

const loftView = { sections: false, wireframe: false };
let turntable: THREE.Object3D | undefined;
let skeleton: THREE.Group | undefined;
let lofts: THREE.Mesh[] = [];

/**
 * A skeleton of rings, rebuilt from the meshes the sheet built — nothing but the scene graph is needed.
 * The material is per build, not shared: the skeleton hangs inside the root, and `mountScene` disposes the
 * old root wholesale on every hot update.
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

/** the loft's two switches, applied to whatever its current root is — a hot reload lands here too */
function applyLoftView() {
  const root = shown.get("loft")?.mount.root;
  if (!root) return;
  if (skeleton) skeleton.visible = loftView.sections;
  for (const mesh of lofts) mesh.visible = !loftView.sections;
  const liquid = root.getObjectByName("liquid");
  if (liquid) liquid.visible = !loftView.sections;

  root.traverse((child) => {
    // `wireframe` is on every material three draws a surface with, but not on the abstract base
    for (const material of ([] as THREE.Material[]).concat((child as THREE.Mesh).material ?? [])) {
      (material as THREE.MeshStandardMaterial).wireframe = loftView.wireframe;
      material.needsUpdate = true;
    }
  });
}

// ---------------------------------------------------------------- the two of them

const SCENES: Entry[] = [
  {
    name: "stage",
    sheet: stage,
    note: "The language's own surface: templates, variables, a loaded glTF with a clip playing, a hashed texture.",
    lens: [55, 0.1, 100],
    eye: [4, 3.5, 6],
    target: [0, 1, 0],
    sky: () => (scene.background = new THREE.Color(0x0b0d10)),
    load: (root) => (spinner = root.getObjectByName("spinner")),
    frame: (elapsed) => {
      if (spinner) spinner.rotation.y = elapsed * Number(spinner.userData.spin ?? 0.5);
    },
  },
  {
    name: "loft",
    sheet: loft,
    registry: loftRegistry,
    note: "Surfaces skinned through cross sections — loftGeometry() from three/addons. After three's loft geometry example.",
    lens: [45, 1, 1000],
    eye: [0, 15, 40],
    target: [0, -3, 0],
    minDistance: 15,
    maxDistance: 50, // stay inside the curtain
    toneMapping: THREE.NeutralToneMapping,
    sky: () => {
      scene.backgroundNode = screenUV.distance(0.5).mix(color(0x5d5d84), color(0x2e2e44)); // a vignette
      scene.environment = roomEnvironment();
      scene.environmentIntensity = 0.4;
    },
    load: (root) => {
      turntable = root.getObjectByName("turntable");
      lofts = [];
      root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry.type === "LoftGeometry") lofts.push(mesh);
      });
      // the skeleton is not part of the sheet, so it is parented to the group that spins
      (turntable ?? root).add((skeleton = buildSkeleton(root)));
      applyLoftView();
    },
    frame: () => {
      if (turntable) turntable.rotation.y += 0.001;
    },
  },
];

type Shown = { container: THREE.Group; mount: Mount };
/** every sheet that has been shown once, kept mounted so switching back is free and hot reload keeps working */
const shown = new Map<string, Shown>();

const view = { scene: 0 };
let current = SCENES[0]!;
let pending = Promise.resolve();

function show(index: number) {
  const entry = (current = SCENES[(index + SCENES.length) % SCENES.length]!);
  view.scene = SCENES.indexOf(entry);
  about.textContent = `[S] ${entry.name} · ${entry.note}`;
  loftParameters[entry.name === "loft" ? "show" : "hide"]();

  // the sky is the shared Scene's, so each entry starts from nothing rather than from the last one's
  scene.background = null;
  scene.backgroundNode = null;
  scene.environment = null;
  scene.environmentIntensity = 1;
  renderer.toneMapping = entry.toneMapping ?? THREE.NoToneMapping;
  entry.sky?.();

  [camera.fov, camera.near, camera.far] = entry.lens;
  camera.updateProjectionMatrix();
  camera.position.set(...entry.eye);
  controls.minDistance = entry.minDistance ?? 0;
  controls.maxDistance = entry.maxDistance ?? Infinity;
  controls.target.set(...entry.target);
  controls.update();

  // a second switch during the first sheet's gltf download would otherwise mount it twice
  pending = pending.then(async () => {
    if (current !== entry) return;
    if (!shown.has(entry.name)) {
      const container = new THREE.Group();
      scene.add(container);
      msg.textContent = "loading…";
      const mount = await mountScene(container, entry.sheet, {
        registry: entry.registry,
        onLoad: (root) => {
          entry.load?.(root);
          if (current === entry) msg.textContent = "";
        },
        onError: (e) => (msg.textContent = String((e as Error).message)),
      });
      shown.set(entry.name, { container, mount });
    } else if (current === entry) {
      msg.textContent = "";
    }
    for (const [name, s] of shown) s.container.visible = name === current.name;
  });
}

const parameters = inspector.createParameters("scene");
parameters.add(view, "scene", Object.fromEntries(SCENES.map((s, i) => [s.name, i]))).onChange(show).listen();

const loftParameters = inspector.createParameters("loft");
loftParameters.add(loftView, "sections").onChange(applyLoftView);
loftParameters.add(loftView, "wireframe").onChange(applyLoftView);

show(0);

// the inspector is not always open, so the switch has a key of its own
addEventListener("keydown", (e) => {
  if (e.key === "s" || e.key === "S") show(view.scene + 1);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop((time) => {
  // every mount, not just the visible one: a paused mixer would jump the moment it came back
  for (const { mount } of shown.values()) mount.update();
  current.frame?.(time / 1000);
  controls.update();
  renderer.render(scene, camera);
});
