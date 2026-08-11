import {
  BoxGeometry,
  type ColorRepresentation,
  CapsuleGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  type Node,
  OctahedronGeometry,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
} from "three/webgpu";
import { color, floor, mix, mod, positionWorld } from "three/tsl";
import type { DemoScene, EmissiveSurface } from "./types.js";

interface SurfaceOptions {
  color?: ColorRepresentation;
  colorNode?: Node<"vec3">;
  emissive?: ColorRepresentation;
  emissiveIntensity?: number;
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

// Axis-aligned level block in the x/y gameplay plane; one-way platforms
// only collide against the player's feet coming down onto their top.
interface LevelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  oneWay?: boolean;
}

interface LampDef {
  x: number;
  y: number;
  color: number;
  intensity: number;
  radius: number;
}

const LEVEL_DEPTH = 3;
const GROUND_TOP = 1;
// Solid terrain. Bottoms sit at y = 0 so every block stays above the shared
// lighting's ground height and registers as an image-plane occluder.
const TERRAIN: LevelBox[] = [
  { x: -19, y: GROUND_TOP / 2, w: 22, h: GROUND_TOP }, // ground, pit at -8..-5
  { x: 1, y: GROUND_TOP / 2, w: 12, h: GROUND_TOP }, // ground, pit at 7..10
  { x: 20, y: GROUND_TOP / 2, w: 20, h: GROUND_TOP },
  { x: -30.5, y: 6, w: 1, h: 12 }, // end walls
  { x: 30.5, y: 6, w: 1, h: 12 },
  { x: 17, y: 3, w: 1.2, h: 4 }, // shadow-casting tower on the right ground
];
// Small props kept out of the lighting field (see FIELD_EXCLUDED_LAYER):
// in image-plane mode a flatland silhouette shadows everything behind it at
// full height, which reads as an abrupt dark rectangle behind a mere crate.
const CRATES: LevelBox[] = [
  { x: -16, y: GROUND_TOP + 0.6, w: 1.2, h: 1.2 },
  { x: -14.7, y: GROUND_TOP + 0.45, w: 0.9, h: 0.9 },
  { x: 24, y: GROUND_TOP + 0.7, w: 1.4, h: 1.4 },
];
const PLATFORMS: LevelBox[] = [
  { x: -6.5, y: 2.75, w: 3, h: 0.5, oneWay: true },
  { x: -2, y: 4.35, w: 2.5, h: 0.5, oneWay: true },
  { x: 2.5, y: 5.75, w: 2.5, h: 0.5, oneWay: true },
  { x: 8.5, y: 2.95, w: 3, h: 0.5, oneWay: true },
  { x: 13, y: 4.95, w: 2.5, h: 0.5, oneWay: true },
  { x: 19, y: 2.95, w: 2.5, h: 0.5, oneWay: true },
  { x: 22, y: 5.05, w: 2.5, h: 0.5, oneWay: true },
  { x: 26.5, y: 6.95, w: 2.5, h: 0.5, oneWay: true },
];
const COLLISION_BOXES: LevelBox[] = [...TERRAIN, ...CRATES, ...PLATFORMS];

// The lighting's field camera only renders the default layer 0, so meshes on
// this extra layer stay visible to the view camera (which enables it) while
// never occluding or emitting in the radiance field.
const FIELD_EXCLUDED_LAYER = 2;

const LAMPS: LampDef[] = [
  { x: -24, y: GROUND_TOP, color: 0xff8830, intensity: 12, radius: 0.4 },
  { x: -12, y: GROUND_TOP, color: 0x22ccff, intensity: 12, radius: 0.4 },
  { x: 5, y: GROUND_TOP, color: 0xee44cc, intensity: 12, radius: 0.4 },
  { x: 20, y: GROUND_TOP, color: 0x88ee33, intensity: 10, radius: 0.4 },
  { x: 28.5, y: GROUND_TOP, color: 0xff3322, intensity: 8, radius: 0.3 },
];
const ORB_LAMPS = [
  { x: -4, y: 6.5, color: 0x3344ff, intensity: 14 },
  { x: 10, y: 7, color: 0xffa31a, intensity: 14 },
] as const;

const PLAYER_START = new Vector2(-27, GROUND_TOP + 0.7);
const PLAYER_HALF_WIDTH = 0.35;
const PLAYER_HALF_HEIGHT = 0.7;
const MOVEMENT_SPEED = 7;
const GRAVITY = 30;
const JUMP_SPEED = 12;
const MAX_FALL_SPEED = 20;
const COYOTE_TIME = 0.1;
const JUMP_BUFFER_TIME = 0.12;
const KILL_PLANE = -6;
const BULLET_RADIUS = 0.15;
const BULLET_SPEED = 30;
const BULLET_MAX_DISTANCE = 36;
const FIRE_INTERVAL = 0.1;
const PARTICLE_GRAVITY = 12;
const CAMERA_DISTANCE = 14;
const CAMERA_LIFT = 2.2;

export function createPlatformerScene(inputElement: HTMLElement): DemoScene {
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 100);
  camera.layers.enable(FIELD_EXCLUDED_LAYER);
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

  // Nudge the checker lattice off integer coordinates: block tops and wall
  // faces sit exactly on them, and floor() at its own knife edge flickers
  // per fragment from interpolation noise (visible as stripes under light).
  const checker = mod(
    floor(positionWorld.x.add(0.01)).add(floor(positionWorld.y.add(0.01))),
    2,
  );
  const terrainMaterial = surfaceMaterial({
    colorNode: mix(color(0x656a72), color(0x757b84), checker),
  });
  for (const box of TERRAIN) {
    const mesh = new Mesh(
      new BoxGeometry(box.w, box.h, LEVEL_DEPTH),
      terrainMaterial,
    );
    mesh.position.set(box.x, box.y, 0);
    addMesh(mesh, true);
  }

  for (const box of CRATES) {
    const mesh = new Mesh(
      new BoxGeometry(box.w, box.h, LEVEL_DEPTH),
      terrainMaterial,
    );
    mesh.position.set(box.x, box.y, 0);
    mesh.layers.set(FIELD_EXCLUDED_LAYER);
    addMesh(mesh, true);
  }

  const platformMaterial = surfaceMaterial({ color: 0x8a8d96 });
  for (const box of PLATFORMS) {
    const mesh = new Mesh(
      new BoxGeometry(box.w, box.h, LEVEL_DEPTH),
      platformMaterial,
    );
    mesh.position.set(box.x, box.y, 0);
    addMesh(mesh, true);
  }

  for (const lamp of LAMPS) {
    const mesh = new Mesh(
      new CylinderGeometry(lamp.radius, lamp.radius, 1.2, 16),
      surfaceMaterial({
        color: 0x000000,
        emissive: lamp.color,
        emissiveIntensity: lamp.intensity,
      }),
    );
    mesh.position.set(lamp.x, lamp.y + 0.6, 0);
    addMesh(mesh, true);
  }

  for (const orb of ORB_LAMPS) {
    const mesh = new Mesh(
      new SphereGeometry(0.3, 16, 12),
      surfaceMaterial({
        color: 0x000000,
        emissive: orb.color,
        emissiveIntensity: orb.intensity,
      }),
    );
    mesh.position.set(orb.x, orb.y, 0);
    addMesh(mesh, true);
  }

  const goalCrystal = new Mesh(
    new OctahedronGeometry(0.6),
    surfaceMaterial({
      color: 0x000000,
      emissive: 0xffd24a,
      emissiveIntensity: 16,
    }),
  );
  goalCrystal.position.set(26.5, 8, 0);
  addMesh(goalCrystal, true);

  const player = PLAYER_START.clone();
  const playerVelocity = new Vector2();
  const playerMesh = new Mesh(
    new CapsuleGeometry(PLAYER_HALF_WIDTH, 0.7, 8, 16),
    surfaceMaterial({ color: 0xd8d2c4 }),
  );
  // Same opt-out as the crates: the capsule must not shadow its own lantern.
  playerMesh.layers.set(FIELD_EXCLUDED_LAYER);
  addMesh(playerMesh);

  const lantern = new Mesh(
    new SphereGeometry(0.12, 12, 8),
    surfaceMaterial({
      color: 0x000000,
      emissive: 0xffc880,
      emissiveIntensity: 8,
    }),
  );
  addMesh(lantern);

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
  const bulletRaycaster = new Raycaster();
  bulletRaycaster.layers.enable(FIELD_EXCLUDED_LAYER);
  let firing = false;
  let fireCooldown = 0;
  let aim = new Vector2(1, 0);
  let grounded = false;
  let coyoteTimer = 0;
  let jumpBufferTimer = 0;
  const cameraFocus = new Vector2(player.x, player.y + CAMERA_LIFT);
  scene.updateMatrixWorld(true);

  function updatePointerNdc(event: PointerEvent): void {
    pointerNdc.set(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1,
    );
  }

  function updateAim(): void {
    pointerRaycaster.setFromCamera(pointerNdc, camera);
    const { origin, direction } = pointerRaycaster.ray;
    if (Math.abs(direction.z) <= 1e-4) return;

    const distance = -origin.z / direction.z;
    const target = new Vector2(
      origin.x + direction.x * distance - player.x,
      origin.y + direction.y * distance - player.y,
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
        direction.x - direction.y * spread,
        direction.y + direction.x * spread,
        0,
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
        1 + Math.sin(angle) * speed,
        0,
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
    const direction = new Vector3(aim.x, aim.y, 0);
    const mesh = new Mesh(bulletGeometry, bulletMaterial);
    mesh.position
      .set(player.x, player.y + 0.2, 0)
      .addScaledVector(direction, PLAYER_HALF_WIDTH + BULLET_RADIUS);
    scene.add(mesh);
    bullets.push({ mesh, direction, distanceTraveled: 0 });
    spawnMuzzleParticles(mesh.position, direction);
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

  function overlap(box: LevelBox): { x: number; y: number } | undefined {
    const overlapX =
      PLAYER_HALF_WIDTH + box.w / 2 - Math.abs(player.x - box.x);
    const overlapY =
      PLAYER_HALF_HEIGHT + box.h / 2 - Math.abs(player.y - box.y);
    if (overlapX <= 0 || overlapY <= 0) return undefined;
    return { x: overlapX, y: overlapY };
  }

  function movePlayer(deltaTime: number): void {
    player.x += playerVelocity.x * deltaTime;
    for (const box of COLLISION_BOXES) {
      if (box.oneWay) continue;
      const penetration = overlap(box);
      if (!penetration) continue;
      player.x += player.x < box.x ? -penetration.x : penetration.x;
    }

    const previousBottom = player.y - PLAYER_HALF_HEIGHT;
    player.y += playerVelocity.y * deltaTime;
    grounded = false;
    for (const box of COLLISION_BOXES) {
      if (!overlap(box)) continue;
      const top = box.y + box.h / 2;
      if (box.oneWay) {
        if (playerVelocity.y <= 0 && previousBottom >= top - 1e-3) {
          player.y = top + PLAYER_HALF_HEIGHT;
          playerVelocity.y = 0;
          grounded = true;
        }
      } else if (player.y > box.y) {
        player.y = top + PLAYER_HALF_HEIGHT;
        if (playerVelocity.y <= 0) {
          playerVelocity.y = 0;
          grounded = true;
        }
      } else {
        player.y = box.y - box.h / 2 - PLAYER_HALF_HEIGHT;
        if (playerVelocity.y > 0) playerVelocity.y = 0;
      }
    }
  }

  function respawn(): void {
    player.copy(PLAYER_START);
    playerVelocity.set(0, 0);
    cameraFocus.set(player.x, player.y + CAMERA_LIFT);
  }

  function update(deltaTime: number): void {
    const movementX =
      (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
      (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
    playerVelocity.x = movementX * MOVEMENT_SPEED;
    playerVelocity.y = Math.max(
      playerVelocity.y - GRAVITY * deltaTime,
      -MAX_FALL_SPEED,
    );

    movePlayer(deltaTime);
    coyoteTimer = grounded ? COYOTE_TIME : coyoteTimer - deltaTime;
    jumpBufferTimer -= deltaTime;
    if (jumpBufferTimer > 0 && coyoteTimer > 0) {
      playerVelocity.y = JUMP_SPEED;
      coyoteTimer = 0;
      jumpBufferTimer = 0;
    }
    if (player.y < KILL_PLANE) respawn();

    updateAim();
    playerMesh.position.set(player.x, player.y, 0);
    lantern.position.set(player.x, player.y + 1, 0);

    updateParticles(deltaTime);
    updateBullets(deltaTime);
    if (firing) {
      fireCooldown -= deltaTime;
      while (fireCooldown <= 0) {
        fireBullet();
        fireCooldown += FIRE_INTERVAL;
      }
    }
    goalCrystal.rotation.y += deltaTime * 0.8;

    // Constant offset keeps the camera pitch well inside image-plane mode.
    const follow = 1 - Math.exp(-deltaTime * 6);
    cameraFocus.x += (player.x - cameraFocus.x) * follow;
    cameraFocus.y +=
      (Math.max(player.y, GROUND_TOP) + CAMERA_LIFT - cameraFocus.y) * follow;
    camera.position.set(cameraFocus.x, cameraFocus.y, CAMERA_DISTANCE);
    camera.lookAt(cameraFocus.x, cameraFocus.y - CAMERA_LIFT, 0);
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
    if (
      event.code === "Space" ||
      event.code === "KeyW" ||
      event.code === "ArrowUp"
    ) {
      jumpBufferTimer = JUMP_BUFFER_TIME;
      event.preventDefault();
    }
  });
  window.addEventListener("keyup", (event) => {
    keys.delete(event.code);
  });

  update(0);
  const initialMeshCount = meshCount;

  return {
    id: "platformer",
    title: "Platformer · RC 2.5D",
    instructions:
      "A/D to move · Space to jump · Mouse to aim · Hold click to fire",
    credit: null,
    // Side-on camera: world height is the image's vertical axis.
    domain: "imagePlane",
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
