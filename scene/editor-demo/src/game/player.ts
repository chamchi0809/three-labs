/**
 * The player: a capsule, a pair of angles, and how fast things happen.
 *
 * Every constant in here is a feel decision rather than a physical one. Gravity is 30 m/s² because 9.8 in a
 * shooter reads as the moon; the top speed is around eleven metres a second because a boomer shooter is a
 * game about moving, and the acceleration is high enough that the speed arrives the frame the key does.
 * Terminal speed is `ACCEL / DAMP` — the two numbers are one decision, and changing one alone changes how
 * quickly the other arrives.
 */
import { Vector3 } from "three/webgpu";
import type { Capsule } from "three/addons/math/Capsule.js";
import type { Octree } from "three/addons/math/Octree.js";
import { bodyAt, move } from "./physics.ts";
import { SLOTS, WEAPONS, type Ammo, type WeaponId } from "./weapons.ts";

export const GRAVITY = 30;
/** metres a second squared, walking and sprinting; the top speed is this over {@link DAMP} */
const ACCEL = 66;
const SPRINT = 108;
/** how much of the acceleration is left in the air — enough to steer a jump, not enough to fly it */
const AIR = 0.22;
const DAMP = 9;
const JUMP = 11;

export const HEIGHT = 1.85;
export const RADIUS = 0.4;
/** eyes are not on top of the head, and a camera that thinks they are looks like a periscope */
export const EYE = 1.62;

export type Input = {
  /** -1 back, +1 forward */
  forward: number;
  /** -1 left, +1 right */
  strafe: number;
  jump: boolean;
  sprint: boolean;
  fire: boolean;
};

export const noInput = (): Input => ({ forward: 0, strafe: 0, jump: false, sprint: false, fire: false });

export type Player = {
  body: Capsule;
  velocity: Vector3;
  /** radians about Y, 0 looking down -Z */
  yaw: number;
  pitch: number;
  onFloor: boolean;
  health: number;
  ammo: Record<Ammo, number>;
  weapon: WeaponId;
  /** seconds until the current gun will fire again */
  cooldown: number;
  /** how far the viewmodel is kicked back, decaying; also drives the muzzle flash */
  recoil: number;
  /** distance walked, for the view bob — a bob on a timer keeps bobbing while standing still */
  travelled: number;
  /** seconds of red left on the screen from the last hit taken */
  hurt: number;
  dead: boolean;
};

export function newPlayer(at: Vector3, yaw: number): Player {
  return {
    body: bodyAt(at, HEIGHT, RADIUS),
    velocity: new Vector3(),
    yaw,
    pitch: 0,
    onFloor: false,
    health: 100,
    // enough shells for the first brute and no cells at all: the plasma is something the arena gives you
    ammo: { shells: 8, cells: 0 },
    weapon: "shotgun",
    cooldown: 0,
    recoil: 0,
    travelled: 0,
    hurt: 0,
    dead: false,
  };
}

/** where the eyes are, which is the camera and also where every shot comes from */
export function eyeOf(player: Player, target: Vector3): Vector3 {
  return target.set(
    player.body.start.x,
    player.body.start.y - player.body.radius + EYE,
    player.body.start.z,
  );
}

/** the direction the player is looking, as a unit vector */
export function aimOf(player: Player, target: Vector3): Vector3 {
  const cos = Math.cos(player.pitch);
  return target
    .set(-Math.sin(player.yaw) * cos, Math.sin(player.pitch), -Math.cos(player.yaw) * cos)
    .normalize();
}

const wish = new Vector3();
const was = new Vector3();

/** one fixed step of movement: what the keys asked for, then gravity, then the world's opinion */
export function stepPlayer(player: Player, input: Input, world: Octree, dt: number): void {
  was.copy(player.body.start);

  if (!player.dead) {
    // ground directions from the yaw: forward is -Z at yaw 0, which is three's own forward
    const sin = Math.sin(player.yaw);
    const cos = Math.cos(player.yaw);
    wish.set(-sin * input.forward + cos * input.strafe, 0, -cos * input.forward - sin * input.strafe);
    if (wish.lengthSq() > 0) {
      const accel = (input.sprint ? SPRINT : ACCEL) * (player.onFloor ? 1 : AIR);
      player.velocity.addScaledVector(wish.normalize(), accel * dt);
    }
    if (input.jump && player.onFloor) player.velocity.y = JUMP;
  }

  // Damping is exponential, so it is the same per second whatever the step is; in the air there is barely
  // any, which is what makes a jump commit to the direction it started in.
  let damping = Math.exp(-DAMP * dt) - 1;
  if (!player.onFloor) {
    player.velocity.y -= GRAVITY * dt;
    damping *= 0.12;
  }
  player.velocity.addScaledVector(player.velocity, damping);

  player.onFloor = move(world, player.body, player.velocity, dt);

  player.travelled += Math.hypot(player.body.start.x - was.x, player.body.start.z - was.z);
  player.recoil = Math.max(0, player.recoil - dt * 7);
  player.hurt = Math.max(0, player.hurt - dt);
  player.cooldown = Math.max(0, player.cooldown - dt);
}

/** the gun in hand, and whether it can go off this instant */
export const weaponOf = (player: Player) => WEAPONS[player.weapon];

export function canFire(player: Player): boolean {
  if (player.dead || player.cooldown > 0) return false;
  return hasAmmo(player);
}

/**
 * Whether the gun in hand has anything left — which is *not* `canFire`, and the difference is a bug that took
 * a while to see: a gun between shots cannot fire either, so "switch away if it cannot fire" switched away
 * after every shot. Running dry is the only thing that should take a gun out of your hands.
 */
export function hasAmmo(player: Player): boolean {
  const weapon = weaponOf(player);
  return !weapon.ammo || player.ammo[weapon.ammo] > 0;
}

/** switch guns by slot number, ignoring a key that names no gun */
export function selectSlot(player: Player, slot: number): boolean {
  const id = SLOTS.find((w) => WEAPONS[w].slot === slot);
  if (!id || id === player.weapon) return false;
  player.weapon = id;
  return true;
}

/** the next gun that has something to fire, for the mouse wheel and for running dry mid-fight */
export function cycleWeapon(player: Player, by: number): void {
  const at = SLOTS.indexOf(player.weapon);
  for (let i = 1; i <= SLOTS.length; i++) {
    const id = SLOTS[(at + by * i + SLOTS.length * SLOTS.length) % SLOTS.length]!;
    const ammo = WEAPONS[id].ammo;
    if (!ammo || player.ammo[ammo] > 0) {
      player.weapon = id;
      return;
    }
  }
}
