import {
  Box3,
  type Material,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { DemoScene, EmissiveSurface } from './types.js';

const DIORAMA_URL = `${import.meta.env.BASE_URL}assets/pica_pica/mini_diorama_01.glb`;
const DIORAMA_SCALE = 10;

interface EmissivePreset {
  color: number;
  intensity: number;
}

const EMISSIVE_PRESETS = new Map<string, EmissivePreset>([
  ['Glass_Dark_01', { color: 0x63d8ff, intensity: 22 }],
  ['Plastic_Red_Transparent', { color: 0xff294d, intensity: 8 }],
  [
    'Wax_Pastel_Yellow_01',
    { color: 0xffa31a, intensity: 5 },
  ],
]);

export async function createPicaPicaScene(
  inputElement: HTMLElement,
): Promise<DemoScene> {
  const scene = new Scene();
  const gltf = await new GLTFLoader().loadAsync(DIORAMA_URL);
  const diorama = gltf.scene;
  diorama.scale.setScalar(DIORAMA_SCALE);
  scene.add(diorama);
  diorama.updateMatrixWorld(true);

  const emissiveSurfaces: EmissiveSurface[] = [];
  const materialCache = new Map<Material, MeshStandardNodeMaterial>();
  let meshCount = 0;

  function convertMaterial(source: Material): MeshStandardNodeMaterial {
    const cached = materialCache.get(source);
    if (cached) return cached;
    if (!(source instanceof MeshStandardMaterial)) {
      throw new Error(`PICA PICA: unsupported glTF material ${source.type}`);
    }

    const material = new MeshStandardNodeMaterial().copy(source);
    const preset = EMISSIVE_PRESETS.get(source.name);
    if (preset) {
      material.emissive.set(preset.color);
      material.emissiveIntensity = preset.intensity;
      emissiveSurfaces.push({
        material,
        baseIntensity: preset.intensity,
      });
    }
    materialCache.set(source, material);
    return material;
  }

  diorama.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    meshCount++;
    object.material = Array.isArray(object.material)
      ? object.material.map(convertMaterial)
      : convertMaterial(object.material);
    object.castShadow = false;
    object.receiveShadow = false;
  });

  const bounds = new Box3().setFromObject(diorama);
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const camera = new PerspectiveCamera(45, 1, 0.01, 200);
  const cameraDistance = Math.max(size.x, size.z) * 1.05;
  camera.position.set(
    center.x + size.x * 0.08,
    size.y * 0.68,
    center.z + cameraDistance,
  );

  const controls = new OrbitControls(camera, inputElement);
  controls.target.set(center.x, size.y * 0.35, center.z);
  controls.enableDamping = true;
  controls.minDistance = size.length() * 0.18;
  controls.maxDistance = size.length() * 2.5;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.enabled = false;
  controls.update();

  return {
    id: 'picaPica',
    title: 'PICA PICA · Mini Diorama 01',
    instructions: 'Drag to orbit · Wheel to zoom · Right-drag to pan',
    credit:
      'Scene by <a href="https://github.com/SEED-EA/pica-pica-assets" target="_blank" rel="noreferrer">SEED.EA</a>' +
      ' · <a href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noreferrer">CC BY-NC 4.0</a>',
    // Near-horizontal orbit: the flatland is the image plane.
    domain: 'imagePlane',
    scene,
    camera,
    meshCount,
    materialCount: materialCache.size,
    emitterCount: emissiveSurfaces.length,
    emitters: emissiveSurfaces,
    setActive(active): void {
      controls.enabled = active;
    },
    setEmissionScale(scale): void {
      for (const emitter of emissiveSurfaces) {
        emitter.material.emissiveIntensity =
          emitter.baseIntensity * Math.max(scale, 0);
      }
    },
    resize(aspect): void {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },
    update(): void {
      controls.update();
    },
  };
}
