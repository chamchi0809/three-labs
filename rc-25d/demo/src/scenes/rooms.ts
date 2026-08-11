import {
  BoxGeometry,
  CapsuleGeometry,
  type ColorRepresentation,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  type Node,
  OctahedronGeometry,
  PlaneGeometry,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  TetrahedronGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  Vector2,
  Vector3,
} from "three/webgpu";
import { color, floor, mix, mod, positionWorld } from "three/tsl";
import {
  CRATES,
  FLOOR_REGIONS,
  FLOOR_THICKNESS,
  type FloorRegion,
  LAMPS,
  PILLARS,
  PILLAR_HEIGHT,
  PLAYER_START,
  SHAPE_HEIGHT,
  SHAPE_SPOTS,
  WALLS,
  type WallBox,
  floorHeightAt,
} from "../level.js";
import type { DemoScene, EmissiveSurface } from "./types.js";

interface SurfaceOptions {
  color?: ColorRepresentation;
  colorNode?: Node<"vec3">;
  emissive?: ColorRepresentation;
  emissiveIntensity?: number;
}

/** Axis-aligned 2D obstacle the player is pushed out of. */
interface Footprint {
  x: number;
  z: number;
  w: number;
  d: number;
}

interface Bullet {
  mesh: Mesh;
  direction: Vector3;
  distanceTraveled: number;
}

interface EmissiveParticle {
  mesh: Mesh;
  velocity: Vector3;
  lifetime: number;
  remainingLifetime: number;
  initialScale: number;
}

const PLAYER_RADIUS = 0.4;
// The lamps' light rides at their 1.4 tall tops, and height-aware occlusion
// only lets light over an occluder standing at least HEIGHT_PASS_SOFTNESS (0.5)
// below its source. Keeping the beam, the bullets and the sparks under 0.9
// leaves them emitting without casting room-wide shadows of their own, while
// crates, pillars and the player still stand high enough to shadow fully.
const EMITTER_HEIGHT = 0.6;
const PLAYER_CENTER_HEIGHT = 0.9;
const LASER_MAX_LENGTH = 10;
const LASER_WIDTH = 0.12;
const BULLET_RADIUS = 0.15;
const BULLET_SPEED = 36;
const BULLET_MAX_DISTANCE = 40;
const FIRE_INTERVAL = 0.1;
const PARTICLE_GRAVITY = 12;
const MOVEMENT_SPEED = 6;
const CAMERA_OFFSET = new Vector3(18, 18, 18);
const FORWARD = new Vector2(-Math.SQRT1_2, -Math.SQRT1_2);
const RIGHT = new Vector2(Math.SQRT1_2, -Math.SQRT1_2);
const COLLISION_BOXES: Footprint[] = [
  ...WALLS.map((wall) => ({ x: wall.x, z: wall.z, w: wall.w, d: wall.d })),
  ...CRATES.map((crate) => ({
    x: crate.x,
    z: crate.z,
    w: crate.s,
    d: crate.s,
  })),
];

/**
 * Floor plate for one region. A sloped region is a box put through a pure
 * shear (y += slopeX·x + slopeZ·z), which keeps it a closed prism whose top
 * face is the slope and lets applyMatrix4 derive the tilted normals.
 */
function floorPlateGeometry(region: FloorRegion): BoxGeometry {
  const width = region.x1 - region.x0;
  const depth = region.z1 - region.z0;
  const geometry = new BoxGeometry(width, FLOOR_THICKNESS, depth);
  if (region.slopeX !== 0 || region.slopeZ !== 0) {
    const shear = new Matrix4();
    shear.elements[1] = region.slopeX;
    shear.elements[9] = region.slopeZ;
    geometry.applyMatrix4(shear);
  }
  return geometry;
}

/**
 * Solid block, with the four corners of its top and of its base placed
 * independently, both taken from the walkable floor beneath that corner, so the
 * wall runs down a corridor's slope and ends flush with the plate it stands on
 * instead of hanging into the void. Both rings shift by the same amount
 * at any (x, z), so every vertical edge stays vertical and every side face stays
 * planar — a side face holds x or z constant, and the shift varies only with
 * those.
 */
function wallMesh(wall: WallBox, material: MeshStandardNodeMaterial): Mesh {
  const spanAt = (x: number, z: number): { base: number; top: number } => {
    const floorY = floorHeightAt(x, z);
    return { base: floorY - FLOOR_THICKNESS, top: floorY + wall.rise };
  };
  const corners: Array<[number, number]> = [
    [wall.x - wall.w / 2, wall.z - wall.d / 2],
    [wall.x + wall.w / 2, wall.z - wall.d / 2],
    [wall.x - wall.w / 2, wall.z + wall.d / 2],
    [wall.x + wall.w / 2, wall.z + wall.d / 2],
  ];
  const spans = corners.map(([x, z]) => spanAt(x, z));
  const lowest = Math.min(...spans.map((span) => span.base));
  const highest = Math.max(...spans.map((span) => span.top));
  const centerY = (lowest + highest) / 2;
  const geometry = new BoxGeometry(wall.w, highest - lowest, wall.d);
  const position = geometry.attributes.position!;
  for (let index = 0; index < position.count; index++) {
    const span = spanAt(
      wall.x + position.getX(index),
      wall.z + position.getZ(index),
    );
    position.setY(
      index,
      (position.getY(index) > 0 ? span.top : span.base) - centerY,
    );
  }
  // Box faces do not share vertices, so this only re-derives each face's own
  // normal — flat sides stay flat and the top and base pick up their tilt.
  geometry.computeVertexNormals();
  const mesh = new Mesh(geometry, material);
  mesh.position.set(wall.x, centerY, wall.z);
  return mesh;
}

export function createRoomsScene(inputElement: HTMLElement): DemoScene {
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 100);
  const materials: MeshStandardNodeMaterial[] = [];
  const emissiveSurfaces: EmissiveSurface[] = [];
  const occluders: Mesh[] = [];
  let meshCount = 0;
  let active = false;

  function surfaceMaterial(options: SurfaceOptions): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    if (options.color !== undefined) material.color.set(options.color);
    if (options.emissive !== undefined) material.emissive.set(options.emissive);
    material.emissiveIntensity = options.emissiveIntensity ?? 1;
    if (options.colorNode) material.colorNode = options.colorNode;
    materials.push(material);

    if (options.emissive !== undefined) {
      emissiveSurfaces.push({
        material,
        baseIntensity: material.emissiveIntensity,
      });
    }
    return material;
  }

  function addMesh(mesh: Mesh, occluder = false): void {
    scene.add(mesh);
    meshCount++;
    if (occluder) occluders.push(mesh);
  }

  // Checkering off world x/z reads correctly in the corridors too, where it
  // stretches slightly along the slope.
  const checker = mod(floor(positionWorld.x).add(floor(positionWorld.z)), 2);
  const floorMaterial = surfaceMaterial({
    colorNode: mix(color(0x656a72), color(0x757b84), checker),
  });
  for (const region of FLOOR_REGIONS) {
    const width = region.x1 - region.x0;
    const depth = region.z1 - region.z0;
    const centerHeight =
      region.height +
      (region.slopeX * width) / 2 +
      (region.slopeZ * depth) / 2;
    const mesh = new Mesh(floorPlateGeometry(region), floorMaterial);
    mesh.position.set(
      (region.x0 + region.x1) / 2,
      centerHeight - FLOOR_THICKNESS / 2,
      (region.z0 + region.z1) / 2,
    );
    // Corridors block the laser and bullets where they rise past emitter height.
    addMesh(mesh, true);
  }

  const wallMaterial = surfaceMaterial({ color: 0x8a8d96 });
  for (const wall of WALLS) {
    addMesh(wallMesh(wall, wallMaterial), true);
  }

  for (const crate of CRATES) {
    const mesh = new Mesh(
      new BoxGeometry(crate.s, crate.s, crate.s),
      surfaceMaterial({ color: 0xa07040 }),
    );
    mesh.position.set(
      crate.x,
      floorHeightAt(crate.x, crate.z) + crate.s / 2,
      crate.z,
    );
    addMesh(mesh, true);
  }

  const pillarMaterial = surfaceMaterial({ color: 0x9aa0a8 });
  for (const pillar of PILLARS) {
    const mesh = new Mesh(
      new CylinderGeometry(pillar.r, pillar.r, PILLAR_HEIGHT, 24),
      pillarMaterial,
    );
    mesh.position.set(
      pillar.x,
      floorHeightAt(pillar.x, pillar.z) + PILLAR_HEIGHT / 2,
      pillar.z,
    );
    addMesh(mesh, true);
  }

  for (const lamp of LAMPS) {
    const height = lamp.height ?? 1.4;
    const center = lamp.y ?? height / 2;
    const mesh = new Mesh(
      new CylinderGeometry(lamp.radius, lamp.radius, height, 16),
      surfaceMaterial({
        color: 0x000000,
        emissive: lamp.color,
        emissiveIntensity: lamp.intensity,
      }),
    );
    mesh.position.set(lamp.x, floorHeightAt(lamp.x, lamp.z) + center, lamp.z);
    // A floor lamp stands in the laser's way; a wall sconce rides above it.
    addMesh(mesh, center - height / 2 < EMITTER_HEIGHT);
  }

  // One spinning shape per room, so every room has a moving occluder with edges
  // of its own for the cascades to trace around. Geometries are used in order and
  // there is one per spot, so no two rooms get the same shape.
  const shapeMaterial = surfaceMaterial({ color: 0xc0b8a8 });
  const shapeGeometries = [
    new TorusKnotGeometry(0.9, 0.28, 96, 16),
    new IcosahedronGeometry(1.1),
    new TorusGeometry(0.85, 0.3, 20, 40),
    new OctahedronGeometry(1.2),
    new ConeGeometry(0.9, 1.9, 6),
    new DodecahedronGeometry(1.1),
    new BoxGeometry(1.4, 1.4, 1.4),
    new TetrahedronGeometry(1.3),
    new SphereGeometry(1.1, 8, 5),
  ];
  const shapes = SHAPE_SPOTS.map((spot, index) => {
    const geometry = shapeGeometries[index % shapeGeometries.length]!;
    const mesh = new Mesh(geometry, shapeMaterial);
    mesh.position.set(
      spot.x,
      floorHeightAt(spot.x, spot.z) + SHAPE_HEIGHT,
      spot.z,
    );
    mesh.rotation.set(index * 0.7, index * 1.1, 0);
    addMesh(mesh, true);
    // Distinct rates so the shapes never fall into step with each other, and a
    // tumble on x for every third one.
    return { mesh, spinY: 0.25 + index * 0.08, spinX: index % 3 === 0 ? 0.2 : 0 };
  });

  const player = new Vector3(PLAYER_START.x, 0, PLAYER_START.z);
  let playerFloor = floorHeightAt(player.x, player.z);
  const playerMesh = new Mesh(
    new CapsuleGeometry(0.35, 0.7, 8, 16),
    surfaceMaterial({ color: 0xd8d2c4 }),
  );
  playerMesh.position.set(player.x, playerFloor + PLAYER_CENTER_HEIGHT, player.z);
  addMesh(playerMesh);

  const laserGeometry = new PlaneGeometry(1, LASER_WIDTH);
  laserGeometry.rotateX(-Math.PI / 2);
  const laser = new Mesh(
    laserGeometry,
    surfaceMaterial({
      color: 0x000000,
      emissive: 0xff2038,
      emissiveIntensity: 5,
    }),
  );
  laser.position.y = playerFloor + EMITTER_HEIGHT;
  addMesh(laser);

  const bulletGeometry = new SphereGeometry(BULLET_RADIUS, 12, 8);
  const bulletMaterial = surfaceMaterial({
    color: 0x000000,
    emissive: 0xff5a30,
    emissiveIntensity: 16,
  });
  const particleGeometry = new SphereGeometry(0.08, 8, 6);
  const particleMaterial = surfaceMaterial({
    color: 0x000000,
    emissive: 0xff7a30,
    emissiveIntensity: 24,
  });
  const bullets: Bullet[] = [];
  const particles: EmissiveParticle[] = [];
  const keys = new Set<string>();
  const pointerNdc = new Vector2();
  const pointerRaycaster = new Raycaster();
  const laserRaycaster = new Raycaster();
  const bulletRaycaster = new Raycaster();
  const laserRayOrigin = new Vector3();
  const laserRayDirection = new Vector3();
  let laserOn = true;
  let firing = false;
  let fireCooldown = 0;
  let aim = new Vector2(1, 0);
  laserRaycaster.far = LASER_MAX_LENGTH;
  scene.updateMatrixWorld(true);

  function updatePointerNdc(event: PointerEvent): void {
    pointerNdc.set(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1,
    );
  }

  function emitterHeight(): number {
    return playerFloor + EMITTER_HEIGHT;
  }

  function updateAim(): void {
    pointerRaycaster.setFromCamera(pointerNdc, camera);
    const { origin, direction } = pointerRaycaster.ray;
    if (Math.abs(direction.y) <= 1e-4) return;

    // Aim on the plane the laser lives in, which rises with the player's
    // floor level, so the cursor keeps pointing where it looks.
    const distance = (emitterHeight() - origin.y) / direction.y;
    const target = new Vector2(
      origin.x + direction.x * distance - player.x,
      origin.z + direction.z * distance - player.z,
    );
    if (target.lengthSq() > 0.01) aim = target.normalize();
  }

  function createParticle(
    position: Vector3,
    velocity: Vector3,
    lifetime: number,
    scale: number,
  ): void {
    const mesh = new Mesh(particleGeometry, particleMaterial);
    mesh.position.copy(position);
    mesh.scale.setScalar(scale);
    scene.add(mesh);
    particles.push({
      mesh,
      velocity,
      lifetime,
      remainingLifetime: lifetime,
      initialScale: scale,
    });
  }

  function spawnMuzzleParticles(position: Vector3, direction: Vector3): void {
    createParticle(position, new Vector3(), 0.1, 1.8);
    for (let index = 0; index < 7; index++) {
      const spread = (Math.random() - 0.5) * 0.8;
      const velocity = new Vector3(
        direction.x - direction.z * spread,
        Math.random() * 0.35,
        direction.z + direction.x * spread,
      )
        .normalize()
        .multiplyScalar(5 + Math.random() * 4);
      createParticle(
        position,
        velocity,
        0.12 + Math.random() * 0.12,
        0.6 + Math.random() * 0.7,
      );
    }
  }

  function spawnImpactParticles(position: Vector3): void {
    createParticle(position, new Vector3(), 0.14, 2.2);
    for (let index = 0; index < 14; index++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 6;
      const velocity = new Vector3(
        Math.cos(angle) * speed,
        0.5 + Math.random() * 1.5,
        Math.sin(angle) * speed,
      );
      createParticle(
        position,
        velocity,
        0.25 + Math.random() * 0.2,
        0.7 + Math.random() * 0.8,
      );
    }
  }

  function fireBullet(): void {
    const direction = new Vector3(aim.x, 0, aim.y);
    const mesh = new Mesh(bulletGeometry, bulletMaterial);
    mesh.position
      .set(player.x, emitterHeight(), player.z)
      .addScaledVector(direction, PLAYER_RADIUS + BULLET_RADIUS);
    scene.add(mesh);
    bullets.push({ mesh, direction, distanceTraveled: 0 });
    spawnMuzzleParticles(mesh.position, direction);
  }

  function getLaserLength(): number {
    laserRayOrigin.set(
      player.x + aim.x * PLAYER_RADIUS,
      emitterHeight(),
      player.z + aim.y * PLAYER_RADIUS,
    );
    laserRayDirection.set(aim.x, 0, aim.y);
    laserRaycaster.set(laserRayOrigin, laserRayDirection);
    const hit = laserRaycaster.intersectObjects(occluders, false)[0];
    return hit?.distance ?? LASER_MAX_LENGTH;
  }

  function updateBullets(deltaTime: number): void {
    const travelDistance = BULLET_SPEED * deltaTime;
    bulletRaycaster.far = travelDistance + BULLET_RADIUS;

    for (let index = bullets.length - 1; index >= 0; index--) {
      const bullet = bullets[index]!;
      bulletRaycaster.set(bullet.mesh.position, bullet.direction);
      const hit = bulletRaycaster.intersectObjects(occluders, false)[0];
      if (hit) {
        const impactPosition = hit.point.addScaledVector(
          bullet.direction,
          -BULLET_RADIUS,
        );
        spawnImpactParticles(impactPosition);
      }
      if (
        hit ||
        bullet.distanceTraveled + travelDistance >= BULLET_MAX_DISTANCE
      ) {
        scene.remove(bullet.mesh);
        bullets.splice(index, 1);
        continue;
      }

      bullet.mesh.position.addScaledVector(bullet.direction, travelDistance);
      bullet.distanceTraveled += travelDistance;
    }
  }

  function updateParticles(deltaTime: number): void {
    for (let index = particles.length - 1; index >= 0; index--) {
      const particle = particles[index]!;
      particle.remainingLifetime -= deltaTime;
      if (particle.remainingLifetime <= 0) {
        scene.remove(particle.mesh);
        particles.splice(index, 1);
        continue;
      }

      particle.mesh.position.addScaledVector(particle.velocity, deltaTime);
      particle.velocity.y -= PARTICLE_GRAVITY * deltaTime;
      const lifeRatio = particle.remainingLifetime / particle.lifetime;
      particle.mesh.scale.setScalar(particle.initialScale * lifeRatio);
    }
  }

  function collide(position: Vector3, radius: number): void {
    for (const box of COLLISION_BOXES) {
      const nearestX = Math.max(
        box.x - box.w / 2,
        Math.min(position.x, box.x + box.w / 2),
      );
      const nearestZ = Math.max(
        box.z - box.d / 2,
        Math.min(position.z, box.z + box.d / 2),
      );
      const deltaX = position.x - nearestX;
      const deltaZ = position.z - nearestZ;
      const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
      if (distanceSquared > 0 && distanceSquared < radius * radius) {
        const distance = Math.sqrt(distanceSquared);
        position.x = nearestX + (deltaX / distance) * radius;
        position.z = nearestZ + (deltaZ / distance) * radius;
      }
    }

    for (const pillar of PILLARS) {
      const deltaX = position.x - pillar.x;
      const deltaZ = position.z - pillar.z;
      const minimumDistance = radius + pillar.r;
      const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
      if (
        distanceSquared > 0 &&
        distanceSquared < minimumDistance * minimumDistance
      ) {
        const distance = Math.sqrt(distanceSquared);
        position.x = pillar.x + (deltaX / distance) * minimumDistance;
        position.z = pillar.z + (deltaZ / distance) * minimumDistance;
      }
    }
  }

  function update(deltaTime: number): void {
    const movementX = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
    const movementZ = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
    if (movementX !== 0 || movementZ !== 0) {
      const direction = new Vector2(
        FORWARD.x * movementZ + RIGHT.x * movementX,
        FORWARD.y * movementZ + RIGHT.y * movementX,
      ).normalize();
      player.x += direction.x * MOVEMENT_SPEED * deltaTime;
      player.z += direction.y * MOVEMENT_SPEED * deltaTime;
      collide(player, PLAYER_RADIUS);
    }
    playerFloor = floorHeightAt(player.x, player.z);

    updateAim();
    playerMesh.position.set(
      player.x,
      playerFloor + PLAYER_CENTER_HEIGHT,
      player.z,
    );
    laser.visible = laserOn;
    const laserLength = getLaserLength();
    const laserCenterOffset = PLAYER_RADIUS + laserLength / 2;
    laser.scale.x = laserLength;
    laser.position.set(
      player.x + aim.x * laserCenterOffset,
      emitterHeight(),
      player.z + aim.y * laserCenterOffset,
    );
    laser.rotation.y = -Math.atan2(aim.y, aim.x);

    updateParticles(deltaTime);
    updateBullets(deltaTime);
    if (firing) {
      fireCooldown -= deltaTime;
      while (fireCooldown <= 0) {
        fireBullet();
        fireCooldown += FIRE_INTERVAL;
      }
    }
    for (const shape of shapes) {
      shape.mesh.rotation.y += deltaTime * shape.spinY;
      shape.mesh.rotation.x += deltaTime * shape.spinX;
    }
    camera.position.set(player.x, playerFloor, player.z).add(CAMERA_OFFSET);
    camera.lookAt(player.x, playerFloor, player.z);
  }

  inputElement.addEventListener("pointermove", (event) => {
    if (active) updatePointerNdc(event);
  });
  inputElement.addEventListener("pointerdown", (event) => {
    if (!active || event.button !== 0) return;
    updatePointerNdc(event);
    updateAim();
    if (!firing) {
      firing = true;
      fireCooldown = FIRE_INTERVAL;
      fireBullet();
    }
  });
  window.addEventListener("pointerup", (event) => {
    if (event.button === 0) firing = false;
  });
  inputElement.addEventListener("pointercancel", () => {
    firing = false;
  });
  window.addEventListener("blur", () => {
    firing = false;
  });
  window.addEventListener("keydown", (event) => {
    if (!active) return;
    keys.add(event.code);
    if (event.code === "KeyF") laserOn = !laserOn;
  });
  window.addEventListener("keyup", (event) => {
    keys.delete(event.code);
  });

  update(0);
  const initialMeshCount = meshCount;

  return {
    id: "rooms",
    title: "Rooms · RC 2.5D",
    instructions:
      "WASD to move · Mouse to aim · Hold click to fire · F toggles laser",
    credit: null,
    // Isometric top-down: the flatland is the ground footprint.
    domain: "footprint",
    scene,
    camera,
    meshCount: initialMeshCount,
    materialCount: materials.length,
    emitterCount: emissiveSurfaces.length,
    emitters: emissiveSurfaces,
    setActive(value): void {
      active = value;
      if (!active) {
        keys.clear();
        firing = false;
      }
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
    update,
  };
}
