// Serve through the demo Vite server and call checkWallSurfaces() in Chrome.
// This checks the final 3D composite, including field coverage and wall shading.
import {
  BoxGeometry,
  FloatType,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { ScreenSpaceRC } from './src/ScreenSpaceRC.js';

export async function checkWallSurfaces(): Promise<{ outside: number; inside: number }> {
  const renderer = new WebGPURenderer();
  await renderer.init();
  const target = new RenderTarget(256, 256, { type: FloatType });
  const scene = new Scene();
  const wallMaterial = new MeshStandardNodeMaterial({ color: 0xffffff });
  const lightMaterial = new MeshStandardNodeMaterial({ emissive: 0xff3300, emissiveIntensity: 8 });
  const wallGeometry = new BoxGeometry(12, 3, 0.6);
  const floorGeometry = new BoxGeometry(12, 0.2, 6);
  const lightGeometry = new BoxGeometry(0.5, 1, 0.5);
  const wall = new Mesh(wallGeometry, wallMaterial);
  wall.position.set(0, 1.5, 0);
  const floor = new Mesh(floorGeometry, wallMaterial);
  floor.position.set(0, -0.1, -3);
  const lamp = new Mesh(lightGeometry, lightMaterial);
  lamp.position.set(0, 0.5, -2);
  scene.add(wall, floor, lamp);
  const lighting = new ScreenSpaceRC(renderer, {
    resolution: 256,
    ambientIntensity: 0,
    temporalBlend: 0,
    contactStrength: 0,
    antialias: false,
  });
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  try {
    renderer.setRenderTarget(target);
    async function sampleWall(side: number): Promise<number> {
      camera.position.set(0, 6, side * 10);
      camera.lookAt(0, 1.5, 0);
      lighting.render(scene, camera);
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256);
      let peak = 0;
      for (const x of [-2, -1, 0, 1, 2]) {
        const point = new Vector3(x, 2, side * 0.3).project(camera);
        const px = Math.floor((point.x * 0.5 + 0.5) * 256);
        const py = Math.floor((-point.y * 0.5 + 0.5) * 256);
        peak = Math.max(peak, pixels[(py * 256 + px) * 4]!);
      }
      return peak;
    }
    const outside = await sampleWall(1);
    const inside = await sampleWall(-1);
    if (!(inside > 0.01 && outside < 0.001)) {
      throw new Error(`Final wall composite: outside=${outside}, inside=${inside}`);
    }
    return { outside, inside };
  } finally {
    renderer.setRenderTarget(null);
    lighting.dispose();
    target.dispose();
    wallGeometry.dispose();
    floorGeometry.dispose();
    lightGeometry.dispose();
    wallMaterial.dispose();
    lightMaterial.dispose();
    renderer.dispose();
  }
}
