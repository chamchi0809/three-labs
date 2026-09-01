/**
 * The things in the arena that want you dead.
 *
 * They are as simple as an enemy can be and still be worth shooting: wake up when you are close enough,
 * walk at you, swing when they can reach. The walking goes through the same collide-and-slide the player
 * does, so a monster shoulders along a wall and up the ramp instead of through them, and a grunt that has
 * lost sight of you around a pillar will find its way there eventually because it is pushing against the
 * pillar the whole time.
 *
 * What none of them decide is how much they hurt, how fast they are, or how far they can see. That is in
 * the level — `@entity { hp: 120; speed: 2.2 }` on the node the designer dragged — and the loop below only
 * reads it. Balancing the fight is dragging numbers in the entity panel and pressing Play again.
 */
import {
  CapsuleGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
  type Object3D,
} from "three/webgpu";
import type { Capsule } from "three/addons/math/Capsule.js";
import type { Octree } from "three/addons/math/Octree.js";
import { bodyAt, feetOf, flatDistance, move } from "./physics.ts";
import { GRAVITY } from "./player.ts";
import type { Breed, MonsterSpec } from "./level.ts";

/** what a breed looks like and how far it can reach; everything else about it comes from the level */
const BREEDS: Record<Breed, { height: number; radius: number; colour: number; eye: number; reach: number }> = {
  grunt: { height: 1.8, radius: 0.42, colour: 0xbe3a2f, eye: 0xffe066, reach: 2 },
  brute: { height: 2.35, radius: 0.62, colour: 0x7b4fb5, eye: 0x9dffdc, reach: 2.5 },
};

/** how long a monster takes to fall over, and how long between its swings */
const DEATH = 0.75;
const SWING = 1.1;

export type Monster = {
  spec: MonsterSpec;
  /** what it looks like, and where it is on screen */
  mesh: Group;
  skin: MeshStandardMaterial;
  /** what it is, to the world */
  body: Capsule;
  velocity: Vector3;
  hp: number;
  alive: boolean;
  awake: boolean;
  /** seconds until it can swing again */
  swing: number;
  /** seconds of glow left from being shot */
  flinch: number;
  /** seconds into falling over, or -1 while it is still standing */
  dying: number;
};

export function spawnMonsters(specs: MonsterSpec[], parent: Object3D): Monster[] {
  return specs.map((spec) => {
    const breed = BREEDS[spec.breed];
    const mesh = new Group();
    const skin = new MeshStandardMaterial({
      color: breed.colour,
      emissive: breed.colour,
      emissiveIntensity: 0.12,
      roughness: 0.55,
      metalness: 0.1,
    });

    const trunk = new Mesh(
      new CapsuleGeometry(breed.radius, Math.max(0.1, breed.height - breed.radius * 2), 4, 14),
      skin,
    );
    trunk.position.y = breed.height / 2;
    trunk.castShadow = true;
    mesh.add(trunk);

    // Eyes, and the only reason for them: a capsule is the same from every side, so without something on
    // the front there is no telling whether a monster has noticed you.
    const glow = new MeshStandardMaterial({ color: breed.eye, emissive: breed.eye, emissiveIntensity: 3 });
    const pupil = new SphereGeometry(breed.radius * 0.16, 8, 6);
    for (const side of [-1, 1]) {
      const eye = new Mesh(pupil, glow);
      eye.position.set(side * breed.radius * 0.34, breed.height - breed.radius * 0.7, -breed.radius * 0.92);
      mesh.add(eye);
    }

    mesh.position.copy(spec.at);
    parent.add(mesh);

    return {
      spec,
      mesh,
      skin,
      body: bodyAt(spec.at, breed.height, breed.radius),
      velocity: new Vector3(),
      hp: spec.hp,
      alive: true,
      awake: false,
      swing: 0,
      flinch: 0,
      dying: -1,
    };
  });
}

/** what the world needs to know when something lands a hit on the player */
export type Harm = (damage: number) => void;

const to = new Vector3();
const push = new Vector3();

/**
 * One fixed step for every monster: notice, walk, swing, or fall over.
 *
 * `feet` is where the player is standing — monsters chase the feet rather than the eyes, because a brute
 * on the platform aiming at a camera two metres up walks off it.
 */
export function stepMonsters(
  monsters: Monster[],
  feet: Vector3,
  world: Octree,
  dt: number,
  harm: Harm,
): void {
  for (const m of monsters) {
    m.flinch = Math.max(0, m.flinch - dt);
    m.skin.emissiveIntensity = 0.12 + m.flinch * 6;

    if (m.dying >= 0) {
      m.dying += dt;
      // down and out: sinking is what sells it, because there is no ragdoll and no death animation
      const t = Math.min(1, m.dying / DEATH);
      m.mesh.scale.setScalar(Math.max(0.02, 1 - t * 0.75));
      m.mesh.position.y = feetOf(m.body) - t * 0.9;
      m.mesh.rotation.z = t * 1.2;
      if (m.dying >= DEATH) m.mesh.visible = false;
      continue;
    }

    const gap = flatDistance(m.body.start, feet);
    if (!m.awake && gap <= m.spec.sight) m.awake = true;
    m.swing = Math.max(0, m.swing - dt);

    const reach = BREEDS[m.spec.breed].reach;

    if (m.awake) {
      to.set(feet.x - m.body.start.x, 0, feet.z - m.body.start.z);
      if (to.lengthSq() > 1e-6) {
        to.normalize();
        // Nothing in the octree is the player, so a monster that chases until it arrives walks *into* the
        // camera and swings from inside your head, where a shotgun cannot point at it. It stops a swing's
        // length short instead and stands there, which is also how you get to see what is hitting you.
        const chase = Math.min(1, dt * 7);
        const want = gap > reach * 0.7 ? m.spec.speed : 0;
        m.velocity.x += (to.x * want - m.velocity.x) * chase;
        m.velocity.z += (to.z * want - m.velocity.z) * chase;
        // -Z is its front, which is where the eyes are
        m.mesh.rotation.y = Math.atan2(-to.x, -to.z);
      }

      if (gap <= reach && Math.abs(feet.y - feetOf(m.body)) < 2 && m.swing <= 0) {
        harm(m.spec.damage);
        m.swing = SWING;
        // a lunge on the swing, so a hit reads as a hit
        m.velocity.addScaledVector(to, 2);
      }
    }

    m.velocity.y -= GRAVITY * dt;
    const onFloor = move(world, m.body, m.velocity, dt);
    if (onFloor) m.velocity.y = Math.max(0, m.velocity.y);
    if (!m.awake) {
      // asleep is asleep: no drift from the collide-and-slide pushing it off a corner
      m.velocity.x = 0;
      m.velocity.z = 0;
    }
  }

  settle(monsters, feet);
}

/**
 * Where everything actually ends up, after the walking: nothing in the world is a monster, and nothing in it
 * is the player either — the octree is the level and nothing else — so both kinds of overlap are resolved
 * here, by moving bodies rather than by adding them to a structure that would have to be rebuilt every step.
 *
 * - **Monster against monster.** Six of them all walking at the same corner stack into one monster-shaped
 *   column with six health bars. Thirty comparisons a step is cheaper than any structure that would avoid it.
 * - **Monster against the player**, and this one has to come second. Steering alone does not hold the line:
 *   a monster braking from full speed carries half a metre past it, and the pass above happily shoves a
 *   monster the last of the way into you. A hard push-out is what actually keeps a swing at a swing's
 *   length — and a monster you can see is a monster you can shoot.
 */
function settle(monsters: Monster[], feet: Vector3): void {
  for (let i = 0; i < monsters.length; i++) {
    const a = monsters[i]!;
    if (!a.alive || !a.awake) continue;
    for (let j = i + 1; j < monsters.length; j++) {
      const b = monsters[j]!;
      if (!b.alive || !b.awake) continue;
      const want = a.body.radius + b.body.radius;
      const gap = flatDistance(a.body.start, b.body.start);
      if (gap >= want || gap < 1e-4) continue;
      push.set(a.body.start.x - b.body.start.x, 0, a.body.start.z - b.body.start.z)
        .multiplyScalar((want - gap) / gap / 2);
      a.body.translate(push);
      b.body.translate(push.negate());
    }
  }

  for (const m of monsters) {
    if (!m.alive) continue;
    const hold = reachOf(m) * 0.7;
    const gap = flatDistance(m.body.start, feet);
    // a floor apart is not standing on you: a brute under the platform stays where it is
    if (gap < hold && gap > 1e-4 && Math.abs(feet.y - feetOf(m.body)) < 2) {
      push.set(m.body.start.x - feet.x, 0, m.body.start.z - feet.z).multiplyScalar((hold - gap) / gap);
      m.body.translate(push);
    }
    m.mesh.position.set(m.body.start.x, feetOf(m.body), m.body.start.z);
  }
}

/** a hit landing on a monster; the return says whether that was the one that killed it */
export function hurtMonster(m: Monster, damage: number, from: Vector3): boolean {
  if (!m.alive) return false;
  m.hp -= damage;
  m.flinch = 0.12;
  m.awake = true;
  // knocked back along the shot, which is how a shotgun at close range reads as a shotgun
  push.set(m.body.start.x - from.x, 0, m.body.start.z - from.z);
  if (push.lengthSq() > 1e-6) m.velocity.addScaledVector(push.normalize(), damage * 0.1);
  if (m.hp > 0) return false;
  m.alive = false;
  m.dying = 0;
  m.velocity.set(0, 0, 0);
  return true;
}

/** how close this one has to be to swing; the check reads it to see that it stops short of you */
export function reachOf(m: Monster): number {
  return BREEDS[m.spec.breed].reach;
}

/** the vertical segment a shot can hit: shoulders to shins, not the whole capsule, so grazes miss */
export function torsoOf(m: Monster, a: Vector3, b: Vector3): void {
  a.set(m.body.start.x, m.body.start.y, m.body.start.z);
  b.set(m.body.end.x, m.body.end.y, m.body.end.z);
}
