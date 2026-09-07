/**
 * Collide and slide, for everything in the level that has a body.
 *
 * The whole of the physics: a capsule is moved by its velocity, asked how far it now overlaps the world,
 * and pushed back out along the overlap's normal. three's own `Octree` answers the overlap question
 * against triangles — the same triangles the brushes are drawn from, so there is no collision geometry to
 * author or to keep in step. This is the shape of three's `games_fps` example, and it is here rather than
 * copied twice because monsters walk the same way the player does.
 *
 * A ramp works and a step does not, which is worth knowing before drawing either. Walking into a vertical
 * face pushes the body straight back out; walking into a slope pushes it up and along, so it climbs. The
 * bottom cap of a capsule turns a *short* step into a slope — it touches the edge, and the normal there
 * points up and back — but only while the step is shorter than the capsule's radius. Anything taller is a
 * wall, which is why the arena has a ramp up to its platform.
 */
import { Vector3 } from "three/webgpu";
import { Capsule } from "three/addons/math/Capsule.js";
import type { Octree } from "three/addons/math/Octree.js";

/** a body standing at a point on the ground: `at` is where its feet are, not where its middle is */
export const bodyAt = (at: Vector3, height: number, radius: number): Capsule =>
  new Capsule(
    new Vector3(at.x, at.y + radius, at.z),
    new Vector3(at.x, at.y + Math.max(height - radius, radius + 0.01), at.z),
    radius,
  );

/** where a body's feet are */
export const feetOf = (body: Capsule): number => body.start.y - body.radius;

const step = new Vector3();

/**
 * One step of movement for one body: travel, then resolve.
 *
 * Returns whether the body ended up standing on something, which is what the caller needs to know before
 * deciding about gravity, jumping, or whether a monster has anywhere to walk.
 */
export function move(world: Octree, body: Capsule, velocity: Vector3, dt: number): boolean {
  body.translate(step.copy(velocity).multiplyScalar(dt));

  const hit = world.capsuleIntersect(body);
  if (!hit) return false;

  const onFloor = hit.normal.y > 0;
  // Into a wall: take away the part of the velocity that was going into it and keep the rest, which is
  // what makes a corner something to scrape along instead of something to stop dead against. On the floor
  // the velocity is left alone — gravity is re-applied next step regardless, and zeroing it here is what
  // produces the classic sticky-slope jitter.
  if (!onFloor) velocity.addScaledVector(hit.normal, -hit.normal.dot(velocity));
  if (hit.depth >= 1e-6) body.translate(hit.normal.multiplyScalar(hit.depth));
  return onFloor;
}

/** how far apart two bodies are on the ground, ignoring the fact that one may be above the other */
export function flatDistance(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}
