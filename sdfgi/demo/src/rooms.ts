import * as THREE from "three";
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
} from "./level.ts";

/** Axis-aligned 2D obstacle the player is pushed out of. */
interface Footprint {
  x: number;
  z: number;
  w: number;
  d: number;
}

interface Bullet {
  mesh: THREE.Mesh;
  direction: THREE.Vector3;
  distanceTraveled: number;
}

interface Particle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  lifetime: number;
  remainingLifetime: number;
  initialScale: number;
}

const PLAYER_RADIUS = 0.4;
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
// A 60-degree fov sees more than the 45 the original ran at, so the rig sits
// closer in than its 18-unit isometric offset.
const CAMERA_OFFSET = new THREE.Vector3(14, 14, 14);
const FORWARD = new THREE.Vector2(-Math.SQRT1_2, -Math.SQRT1_2);
const RIGHT = new THREE.Vector2(Math.SQRT1_2, -Math.SQRT1_2);
const COLLISION_BOXES: Footprint[] = [
  ...WALLS.map((w) => ({ x: w.x, z: w.z, w: w.w, d: w.d })),
  ...CRATES.map((c) => ({ x: c.x, z: c.z, w: c.s, d: c.s })),
];

/**
 * Floor plate for one region. A sloped region is a box put through a pure
 * shear (y += slopeX·x + slopeZ·z), which keeps it a closed prism whose top
 * face is the slope and lets applyMatrix4 derive the tilted normals.
 */
function floorPlateGeometry(region: FloorRegion): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(
    region.x1 - region.x0,
    FLOOR_THICKNESS,
    region.z1 - region.z0,
  );
  if (region.slopeX !== 0 || region.slopeZ !== 0) {
    const shear = new THREE.Matrix4();
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
 * instead of hanging into the void. Both rings shift by the same amount at any
 * (x, z), so every vertical edge stays vertical and every side face stays
 * planar.
 */
function wallMesh(wall: WallBox, material: THREE.Material): THREE.Mesh {
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
  const lowest = Math.min(...spans.map((s) => s.base));
  const highest = Math.max(...spans.map((s) => s.top));
  const centerY = (lowest + highest) / 2;
  const geometry = new THREE.BoxGeometry(wall.w, highest - lowest, wall.d);
  const position = geometry.attributes.position!;
  for (let i = 0; i < position.count; i++) {
    const span = spanAt(wall.x + position.getX(i), wall.z + position.getZ(i));
    position.setY(i, (position.getY(i) > 0 ? span.top : span.base) - centerY);
  }
  // Box faces do not share vertices, so this only re-derives each face's own
  // normal — flat sides stay flat and the top and base pick up their tilt.
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(wall.x, centerY, wall.z);
  return mesh;
}

export interface RoomsScene {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  update(deltaTime: number): void;
  dispose(): void;
}

/**
 * The rc-25d rooms level, driven by the shared demo camera. SDFGI snapshots the
 * scene once, so only the level itself (plates, walls, props, lamps) feeds the
 * GI; the player, laser, bullets and sparks are raster-and-bloom only.
 */
export function createRoomsScene(
  camera: THREE.PerspectiveCamera,
  inputElement: HTMLElement,
): RoomsScene {
  const scene = new THREE.Scene();
  const listeners = new AbortController();
  const { signal } = listeners;
  const occluders: THREE.Mesh[] = [];

  function material(
    color: number,
    emissive?: number,
    emissiveIntensity = 1,
  ): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color,
      emissive: emissive ?? 0x000000,
      emissiveIntensity,
      roughness: 0.85,
      metalness: 0,
    });
  }

  function addMesh(mesh: THREE.Mesh, occluder = false): void {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (occluder) occluders.push(mesh);
  }

  // ponytail: flat floor colour. The original checkers in TSL; SDFGI voxelizes
  // from mat.color, so a node-only pattern would light differently than it
  // looks. Bake it into a texture if the tiling is ever missed.
  const floorMaterial = material(0x6d727a);
  for (const region of FLOOR_REGIONS) {
    const width = region.x1 - region.x0;
    const depth = region.z1 - region.z0;
    const centerHeight =
      region.height + (region.slopeX * width) / 2 + (region.slopeZ * depth) / 2;
    const mesh = new THREE.Mesh(floorPlateGeometry(region), floorMaterial);
    mesh.position.set(
      (region.x0 + region.x1) / 2,
      centerHeight - FLOOR_THICKNESS / 2,
      (region.z0 + region.z1) / 2,
    );
    // Corridors block the laser and bullets where they rise past emitter height.
    addMesh(mesh, true);
  }

  const wallMaterial = material(0x8a8d96);
  for (const wall of WALLS) addMesh(wallMesh(wall, wallMaterial), true);

  const crateMaterial = material(0xa07040);
  for (const crate of CRATES) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(crate.s, crate.s, crate.s),
      crateMaterial,
    );
    mesh.position.set(
      crate.x,
      floorHeightAt(crate.x, crate.z) + crate.s / 2,
      crate.z,
    );
    addMesh(mesh, true);
  }

  const pillarMaterial = material(0x9aa0a8);
  for (const pillar of PILLARS) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(pillar.r, pillar.r, PILLAR_HEIGHT, 24),
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
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(lamp.radius, lamp.radius, height, 16),
      material(0x000000, lamp.color, lamp.intensity),
    );
    mesh.position.set(lamp.x, floorHeightAt(lamp.x, lamp.z) + center, lamp.z);
    mesh.castShadow = false;
    // A floor lamp stands in the laser's way; a wall sconce rides above it.
    scene.add(mesh);
    if (center - height / 2 < EMITTER_HEIGHT) occluders.push(mesh);
  }

  // One spinning shape per room, so every room has a moving occluder with edges
  // of its own. Geometries are used in order and there is one per spot, so no
  // two rooms get the same shape.
  const shapeMaterial = material(0xc0b8a8);
  const shapeGeometries = [
    new THREE.TorusKnotGeometry(0.9, 0.28, 96, 16),
    new THREE.IcosahedronGeometry(1.1),
    new THREE.TorusGeometry(0.85, 0.3, 20, 40),
    new THREE.OctahedronGeometry(1.2),
    new THREE.ConeGeometry(0.9, 1.9, 6),
    new THREE.DodecahedronGeometry(1.1),
    new THREE.BoxGeometry(1.4, 1.4, 1.4),
    new THREE.TetrahedronGeometry(1.3),
    new THREE.SphereGeometry(1.1, 8, 5),
  ];
  const shapes = SHAPE_SPOTS.map((spot, index) => {
    const mesh = new THREE.Mesh(
      shapeGeometries[index % shapeGeometries.length]!,
      shapeMaterial,
    );
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

  const player = new THREE.Vector3(PLAYER_START.x, 0, PLAYER_START.z);
  let playerFloor = floorHeightAt(player.x, player.z);
  const playerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 0.7, 8, 16),
    material(0xd8d2c4),
  );
  playerMesh.castShadow = true;
  scene.add(playerMesh);

  const laserGeometry = new THREE.PlaneGeometry(1, LASER_WIDTH);
  laserGeometry.rotateX(-Math.PI / 2);
  const laser = new THREE.Mesh(
    laserGeometry,
    material(0x000000, 0xff2038, 5),
  );
  scene.add(laser);

  // SDFGI takes its snapshot right after construction. The actor and its beam
  // move, so they must not be in it — a frozen capsule and streak would sit in
  // the voxel grid for the whole run.
  playerMesh.visible = false;
  laser.visible = false;
  let snapshotTaken = false;

  const bulletGeometry = new THREE.SphereGeometry(BULLET_RADIUS, 12, 8);
  const bulletMaterial = material(0x000000, 0xff5a30, 16);
  const particleGeometry = new THREE.SphereGeometry(0.08, 8, 6);
  const particleMaterial = material(0x000000, 0xff7a30, 24);
  const bullets: Bullet[] = [];
  const particles: Particle[] = [];
  const keys = new Set<string>();
  const pointerNdc = new THREE.Vector2();
  const pointerRaycaster = new THREE.Raycaster();
  const laserRaycaster = new THREE.Raycaster();
  const bulletRaycaster = new THREE.Raycaster();
  const laserRayOrigin = new THREE.Vector3();
  const laserRayDirection = new THREE.Vector3();
  let laserOn = true;
  let firing = false;
  let fireCooldown = 0;
  let aim = new THREE.Vector2(1, 0);
  laserRaycaster.far = LASER_MAX_LENGTH;
  scene.updateMatrixWorld(true);

  function updatePointerNdc(event: PointerEvent): void {
    pointerNdc.set(
      (event.clientX / innerWidth) * 2 - 1,
      -(event.clientY / innerHeight) * 2 + 1,
    );
  }

  const emitterHeight = (): number => playerFloor + EMITTER_HEIGHT;

  function updateAim(): void {
    pointerRaycaster.setFromCamera(pointerNdc, camera);
    const { origin, direction } = pointerRaycaster.ray;
    if (Math.abs(direction.y) <= 1e-4) return;

    // Aim on the plane the laser lives in, which rises with the player's floor
    // level, so the cursor keeps pointing where it looks.
    const distance = (emitterHeight() - origin.y) / direction.y;
    const target = new THREE.Vector2(
      origin.x + direction.x * distance - player.x,
      origin.z + direction.z * distance - player.z,
    );
    if (target.lengthSq() > 0.01) aim = target.normalize();
  }

  function createParticle(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    lifetime: number,
    scale: number,
  ): void {
    const mesh = new THREE.Mesh(particleGeometry, particleMaterial);
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

  function spawnMuzzleParticles(
    position: THREE.Vector3,
    direction: THREE.Vector3,
  ): void {
    createParticle(position, new THREE.Vector3(), 0.1, 1.8);
    for (let i = 0; i < 7; i++) {
      const spread = (Math.random() - 0.5) * 0.8;
      const velocity = new THREE.Vector3(
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

  function spawnImpactParticles(position: THREE.Vector3): void {
    createParticle(position, new THREE.Vector3(), 0.14, 2.2);
    for (let i = 0; i < 14; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 6;
      createParticle(
        position,
        new THREE.Vector3(
          Math.cos(angle) * speed,
          0.5 + Math.random() * 1.5,
          Math.sin(angle) * speed,
        ),
        0.25 + Math.random() * 0.2,
        0.7 + Math.random() * 0.8,
      );
    }
  }

  function fireBullet(): void {
    const direction = new THREE.Vector3(aim.x, 0, aim.y);
    const mesh = new THREE.Mesh(bulletGeometry, bulletMaterial);
    mesh.position
      .set(player.x, emitterHeight(), player.z)
      .addScaledVector(direction, PLAYER_RADIUS + BULLET_RADIUS);
    scene.add(mesh);
    bullets.push({ mesh, direction, distanceTraveled: 0 });
    spawnMuzzleParticles(mesh.position, direction);
  }

  function laserLength(): number {
    laserRayOrigin.set(
      player.x + aim.x * PLAYER_RADIUS,
      emitterHeight(),
      player.z + aim.y * PLAYER_RADIUS,
    );
    laserRayDirection.set(aim.x, 0, aim.y);
    laserRaycaster.set(laserRayOrigin, laserRayDirection);
    return (
      laserRaycaster.intersectObjects(occluders, false)[0]?.distance ??
      LASER_MAX_LENGTH
    );
  }

  function updateBullets(deltaTime: number): void {
    const travel = BULLET_SPEED * deltaTime;
    bulletRaycaster.far = travel + BULLET_RADIUS;

    for (let i = bullets.length - 1; i >= 0; i--) {
      const bullet = bullets[i]!;
      bulletRaycaster.set(bullet.mesh.position, bullet.direction);
      const hit = bulletRaycaster.intersectObjects(occluders, false)[0];
      if (hit) {
        spawnImpactParticles(
          hit.point.addScaledVector(bullet.direction, -BULLET_RADIUS),
        );
      }
      if (hit || bullet.distanceTraveled + travel >= BULLET_MAX_DISTANCE) {
        scene.remove(bullet.mesh);
        bullets.splice(i, 1);
        continue;
      }
      bullet.mesh.position.addScaledVector(bullet.direction, travel);
      bullet.distanceTraveled += travel;
    }
  }

  function updateParticles(deltaTime: number): void {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.remainingLifetime -= deltaTime;
      if (p.remainingLifetime <= 0) {
        scene.remove(p.mesh);
        particles.splice(i, 1);
        continue;
      }
      p.mesh.position.addScaledVector(p.velocity, deltaTime);
      p.velocity.y -= PARTICLE_GRAVITY * deltaTime;
      p.mesh.scale.setScalar(
        p.initialScale * (p.remainingLifetime / p.lifetime),
      );
    }
  }

  function collide(position: THREE.Vector3, radius: number): void {
    for (const box of COLLISION_BOXES) {
      const nearestX = Math.max(
        box.x - box.w / 2,
        Math.min(position.x, box.x + box.w / 2),
      );
      const nearestZ = Math.max(
        box.z - box.d / 2,
        Math.min(position.z, box.z + box.d / 2),
      );
      const dx = position.x - nearestX;
      const dz = position.z - nearestZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > 0 && d2 < radius * radius) {
        const d = Math.sqrt(d2);
        position.x = nearestX + (dx / d) * radius;
        position.z = nearestZ + (dz / d) * radius;
      }
    }

    for (const pillar of PILLARS) {
      const dx = position.x - pillar.x;
      const dz = position.z - pillar.z;
      const minimum = radius + pillar.r;
      const d2 = dx * dx + dz * dz;
      if (d2 > 0 && d2 < minimum * minimum) {
        const d = Math.sqrt(d2);
        position.x = pillar.x + (dx / d) * minimum;
        position.z = pillar.z + (dz / d) * minimum;
      }
    }
  }

  function update(deltaTime: number): void {
    if (!snapshotTaken) {
      snapshotTaken = true;
      playerMesh.visible = true;
    }

    const moveX = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
    const moveZ = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
    if (moveX !== 0 || moveZ !== 0) {
      const direction = new THREE.Vector2(
        FORWARD.x * moveZ + RIGHT.x * moveX,
        FORWARD.y * moveZ + RIGHT.y * moveX,
      ).normalize();
      player.x += direction.x * MOVEMENT_SPEED * deltaTime;
      player.z += direction.y * MOVEMENT_SPEED * deltaTime;
      collide(player, PLAYER_RADIUS);
    }
    playerFloor = floorHeightAt(player.x, player.z);

    updateAim();
    playerMesh.position.set(player.x, playerFloor + PLAYER_CENTER_HEIGHT, player.z);

    laser.visible = laserOn;
    const length = laserLength();
    const offset = PLAYER_RADIUS + length / 2;
    laser.scale.x = length;
    laser.position.set(
      player.x + aim.x * offset,
      emitterHeight(),
      player.z + aim.y * offset,
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

  inputElement.addEventListener("pointermove", updatePointerNdc, { signal });
  inputElement.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return;
      updatePointerNdc(event);
      updateAim();
      if (!firing) {
        firing = true;
        fireCooldown = FIRE_INTERVAL;
        fireBullet();
      }
    },
    { signal },
  );
  addEventListener("pointerup", (e) => {
    if (e.button === 0) firing = false;
  }, { signal });
  inputElement.addEventListener("pointercancel", () => {
    firing = false;
  }, { signal });
  addEventListener("blur", () => {
    firing = false;
    keys.clear();
  }, { signal });
  addEventListener("keydown", (event) => {
    // The inspector's own inputs are text fields; only steal bare keys.
    if (event.target !== document.body) return;
    keys.add(event.code);
    if (event.code === "KeyF") laserOn = !laserOn;
  }, { signal });
  addEventListener("keyup", (event) => keys.delete(event.code), { signal });

  // Places everything for the very first frame, and for SDFGI's snapshot of it.
  update(0);
  snapshotTaken = false;
  playerMesh.visible = false;
  laser.visible = false;

  // Straight down would flatten the level's four floor heights into each other;
  // the demo's az/el sliders move it from here.
  const sun = new THREE.DirectionalLight(0xdfe6ff, 1.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera;
  c.left = -34;
  c.right = 34;
  c.top = 34;
  c.bottom = -34;
  c.near = 20;
  c.far = 200;
  sun.shadow.bias = -0.0015;
  // The shapes spin and the player walks, so this one scene pays for a shadow
  // pass every frame rather than freezing the map like the two static ones.
  scene.add(sun);

  return {
    scene,
    sun,
    update,
    dispose: () => listeners.abort(),
  };
}
