import {
  Box3,
  CapsuleGeometry,
  type Material,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { DemoScene, EmissiveSurface } from './types.js';

const DUNGEON_URL = `${import.meta.env.BASE_URL}assets/dungeon/dungeon_warkarma.glb`;
const FLAME_MATERIAL = 'Torch_Flame';
const FLAME_INTENSITY = 30;
/**
 * The glTF albedos are authored near-black for an HDR-environment look; this
 * scene is lit by torches alone, so lift them into a range that bounces light.
 */
const ALBEDO_BOOST = 6;

/** Cycled over the 21 torches so the dungeon is lit by mixed-colour flames. */
const FLAME_COLORS: readonly number[] = [
  0xff7a1a, // ember orange
  0x36d1ff, // arcane cyan
  0xff2f5e, // blood red
  0x8cff3a, // witchfire green
  0xb04dff, // violet
  0xffd34d, // gold
];

const PLAYER_RADIUS = 0.28;
const PLAYER_HEIGHT = 0.95;
const MOVEMENT_SPEED = 4.5;
/** Tallest rise the character walks up; the dungeon's steps are well under it. */
const STEP_HEIGHT = 0.45;
// Steeper than a 1:1:1 isometric offset on purpose: the dungeon's walls are
// tall enough that a 35° view spends half its time hiding the character.
const CAMERA_OFFSET = new Vector3(8, 14, 8);
// Screen-space axes of the fixed camera, so W is "up the screen".
const FORWARD = new Vector2(-Math.SQRT1_2, -Math.SQRT1_2);
const RIGHT = new Vector2(Math.SQRT1_2, -Math.SQRT1_2);

export async function createDungeonScene(): Promise<DemoScene> {
  const scene = new Scene();
  const gltf = await new GLTFLoader().loadAsync(DUNGEON_URL);
  const dungeon = gltf.scene;
  scene.add(dungeon);
  dungeon.updateMatrixWorld(true);

  const emissiveSurfaces: EmissiveSurface[] = [];
  const materialCache = new Map<Material, MeshStandardNodeMaterial>();
  let meshCount = 0;
  let flameCount = 0;

  function convertMaterial(source: Material): MeshStandardNodeMaterial {
    if (!(source instanceof MeshStandardMaterial)) {
      throw new Error(`Dungeon: unsupported glTF material ${source.type}`);
    }
    // Flames are one shared glTF material; each gets its own clone so the
    // colours can differ per torch.
    if (source.name === FLAME_MATERIAL) {
      const flame = new MeshStandardNodeMaterial().copy(source);
      flame.color.set(0x101010);
      const index = flameCount++ % FLAME_COLORS.length;
      flame.emissive.set(FLAME_COLORS[index] as number);
      flame.emissiveIntensity = FLAME_INTENSITY;
      emissiveSurfaces.push({
        material: flame,
        baseIntensity: FLAME_INTENSITY,
      });
      return flame;
    }

    const cached = materialCache.get(source);
    if (cached) return cached;
    const material = new MeshStandardNodeMaterial().copy(source);
    material.color.multiplyScalar(ALBEDO_BOOST);
    materialCache.set(source, material);
    return material;
  }

  dungeon.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    meshCount++;
    object.static = true;
    object.castShadow = false;
    object.receiveShadow = false;
    object.material = Array.isArray(object.material)
      ? object.material.map(convertMaterial)
      : convertMaterial(object.material);
  });

  const bounds = new Box3().setFromObject(dungeon);
  const center = bounds.getCenter(new Vector3());

  // --- Level collision. The dungeon is one baked mesh soup with no collision
  // volumes, so the walkable set is probed with rays instead: a step is allowed
  // when there is floor under it at a reachable height and head clearance above
  // it. Both matter — glTF `doubleSided` means a downward ray started inside a
  // wall still reports the wall's underside as "floor", and only the up-ray
  // rejects that.
  const ray = new Raycaster();
  const rayOrigin = new Vector3();
  const DOWN = new Vector3(0, -1, 0);
  const UP = new Vector3(0, 1, 0);

  /** Height of the surface under (x, z) starting from `fromY`, or null. */
  function floorBelow(x: number, z: number, fromY: number): number | null {
    ray.set(rayOrigin.set(x, fromY, z), DOWN);
    ray.far = fromY - bounds.min.y + 1;
    const hit = ray.intersectObject(dungeon, true)[0];
    return hit ? hit.point.y : null;
  }

  function hasHeadroom(x: number, y: number, z: number): boolean {
    ray.set(rayOrigin.set(x, y + 0.05, z), UP);
    ray.far = PLAYER_HEIGHT;
    return ray.intersectObject(dungeon, true).length === 0;
  }

  /** Floor height the character would stand at, or null if the step is blocked. */
  function standableAt(x: number, z: number, fromFloor: number): number | null {
    const floor = floorBelow(x, z, fromFloor + STEP_HEIGHT);
    if (floor === null || floor < fromFloor - STEP_HEIGHT * 2) return null;
    return hasHeadroom(x, floor, z) ? floor : null;
  }

  /**
   * Spawn: coarse grid of the ground-floor cells the character fits in, then the
   * one with the most walkable neighbours — an open room floor rather than the
   * geometric centre of the level, which lands against a pillar. Scored off the
   * grid so it costs no extra rays.
   *
   * 1813 cells x 2 rays against an 800-mesh soup with no BVH is ~690ms, so for
   * the shipped asset the answer is baked in below and this only runs if that
   * point stops being standable.
   */
  function findSpawn(): Vector3 {
    const CELL = 0.75;
    const groundLimit = bounds.min.y + 1.5;
    const columns = Math.floor((bounds.max.x - bounds.min.x) / CELL);
    const rows = Math.floor((bounds.max.z - bounds.min.z) / CELL);
    const cellX = (column: number): number => bounds.min.x + column * CELL;
    const cellZ = (row: number): number => bounds.min.z + row * CELL;

    const floors: Array<number | null> = [];
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = cellX(column);
        const z = cellZ(row);
        const floor = floorBelow(x, z, bounds.max.y + 1);
        const open =
          floor !== null && floor <= groundLimit && hasHeadroom(x, floor, z);
        floors.push(open ? floor : null);
      }
    }

    let best: Vector3 | null = null;
    let bestScore = -1;
    for (let row = 1; row < rows - 1; row++) {
      for (let column = 1; column < columns - 1; column++) {
        const floor = floors[row * columns + column];
        if (floor === null || floor === undefined) continue;
        let neighbours = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (floors[(row + dz) * columns + column + dx] != null) neighbours++;
          }
        }
        // Nearest the middle only breaks ties between equally open cells.
        const distance = Math.hypot(
          cellX(column) - center.x,
          cellZ(row) - center.z,
        );
        const score = neighbours * 1000 - distance;
        if (score > bestScore) {
          bestScore = score;
          best = new Vector3(cellX(column), floor, cellZ(row));
        }
      }
    }
    if (!best) throw new Error('Dungeon: no walkable spawn found');
    return best;
  }

  // `findSpawn` on this fixed asset, kept as a constant: the floor height is
  // re-probed rather than trusted, and the search runs again if the point is no
  // longer standable (a different dungeon.glb).
  const BAKED_SPAWN = new Vector3(-1.7014957810158648, 0.69, -3.3839197480022953);
  const bakedFloor = standableAt(BAKED_SPAWN.x, BAKED_SPAWN.z, BAKED_SPAWN.y);
  const spawn = bakedFloor === null ? findSpawn() : BAKED_SPAWN.setY(bakedFloor);
  const player = new Vector3().copy(spawn);
  let playerFloor = spawn.y;

  const playerMesh = new Mesh(
    new CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 6, 12),
    new MeshStandardNodeMaterial({ color: 0xd8d2c4, roughness: 0.7 }),
  );
  scene.add(playerMesh);
  meshCount++;

  const camera = new PerspectiveCamera(45, 1, 0.1, 200);
  const keys = new Set<string>();
  let active = false;

  function placeCharacter(): void {
    playerMesh.position.set(player.x, playerFloor + PLAYER_HEIGHT / 2, player.z);
    camera.position.set(player.x, playerFloor, player.z).add(CAMERA_OFFSET);
    camera.lookAt(player.x, playerFloor + PLAYER_HEIGHT / 2, player.z);
  }

  window.addEventListener('keydown', (event) => {
    if (!active) return;
    keys.add(event.code);
  });
  window.addEventListener('keyup', (event) => {
    keys.delete(event.code);
  });
  window.addEventListener('blur', () => {
    keys.clear();
  });

  placeCharacter();

  return {
    id: 'dungeon',
    title: 'Dungeon · Low Poly Game Level',
    instructions: 'WASD / arrows to move',
    credit:
      'Scene by <a href="https://sketchfab.com/warkarma" target="_blank" rel="noreferrer">Warkarma</a>' +
      ' · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>',
    // Fixed isometric camera over a floor-based level, same as Rooms.
    domain: 'footprint',
    scene,
    camera,
    meshCount,
    materialCount: materialCache.size + emissiveSurfaces.length + 1,
    emitterCount: emissiveSurfaces.length,
    emitters: emissiveSurfaces,
    setActive(value): void {
      active = value;
      if (!value) keys.clear();
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
    update(deltaTime): void {
      const movementX =
        (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
        (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      const movementZ =
        (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
        (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);

      if (movementX !== 0 || movementZ !== 0) {
        const direction = new Vector2(
          FORWARD.x * movementZ + RIGHT.x * movementX,
          FORWARD.y * movementZ + RIGHT.y * movementX,
        ).normalize();
        const step = MOVEMENT_SPEED * deltaTime;
        // Axes resolved one at a time so a blocked direction slides along the
        // wall instead of stopping the character dead.
        const stepX = direction.x * step;
        const stepZ = direction.y * step;
        if (stepX !== 0) {
          const probe = player.x + stepX + Math.sign(stepX) * PLAYER_RADIUS;
          const floor = standableAt(probe, player.z, playerFloor);
          if (floor !== null) {
            player.x += stepX;
            playerFloor = floor;
          }
        }
        if (stepZ !== 0) {
          const probe = player.z + stepZ + Math.sign(stepZ) * PLAYER_RADIUS;
          const floor = standableAt(player.x, probe, playerFloor);
          if (floor !== null) {
            player.z += stepZ;
            playerFloor = floor;
          }
        }
      }

      placeCharacter();
    },
  };
}
