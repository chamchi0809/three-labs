import type { FlatlandDomain } from '@rc25d/radiance-cascades';
import type {
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
} from 'three/webgpu';

export type DemoSceneId = 'rooms' | 'platformer' | 'picaPica' | 'dungeon';

export interface EmissiveSurface {
  material: MeshStandardNodeMaterial;
  baseIntensity: number;
}

export interface DemoScene {
  readonly id: DemoSceneId;
  readonly title: string;
  readonly instructions: string;
  /** Attribution HTML for the scene's asset, or null when there is none. */
  readonly credit: string | null;
  /** 2D domain the RC solve should run in for this scene's projection. */
  readonly domain: FlatlandDomain;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly meshCount: number;
  readonly materialCount: number;
  readonly emitterCount: number;
  readonly emitters: readonly EmissiveSurface[];
  setActive(active: boolean): void;
  setEmissionScale(scale: number): void;
  resize(aspect: number): void;
  update(deltaTime: number): void;
}
