/**
 * Things to walk over.
 *
 * An `entity.pickup` in the sheet is a point and a record — no geometry, nothing to draw — so what spins
 * in the air is made here, from the `kind` the level gave it. That split is the point of entities: a
 * designer places supply, not a mesh, and what supply *looks like* is the game's business and can change
 * without touching the map.
 */
import {
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  TorusGeometry,
  Vector3,
  type Object3D,
} from "three/webgpu";
import { flatDistance } from "./physics.ts";
import type { PickupSpec, Supply } from "./level.ts";

const LOOK: Record<Supply, { colour: number; lift: number }> = {
  health: { colour: 0x5fd98a, lift: 0.55 },
  shells: { colour: 0xffc857, lift: 0.5 },
  cells: { colour: 0x7ab8ff, lift: 0.5 },
};

/** how close is close enough, and how far above or below it still counts */
const REACH = 1.1;
const RISE = 2.2;

export type Pickup = {
  spec: PickupSpec;
  mesh: Group;
  /** true while it is there to be taken */
  ready: boolean;
  /** seconds until it comes back, when the level said it should */
  timer: number;
};

export function spawnPickups(specs: PickupSpec[], parent: Object3D): Pickup[] {
  return specs.map((spec) => {
    const look = LOOK[spec.kind];
    const mesh = new Group();
    const material = new MeshStandardMaterial({
      color: look.colour,
      emissive: look.colour,
      emissiveIntensity: 0.9,
      roughness: 0.4,
      metalness: 0.2,
    });

    const core = new Mesh(new OctahedronGeometry(0.26), material);
    mesh.add(core);
    // a ring around it, because a glowing shape on the floor of a dim room is easy to walk past
    const ring = new Mesh(new TorusGeometry(0.42, 0.03, 6, 20), material);
    ring.rotation.x = Math.PI / 2;
    mesh.add(ring);

    mesh.position.copy(spec.at);
    mesh.position.y += look.lift;
    parent.add(mesh);

    return { spec, mesh, ready: true, timer: 0 };
  });
}

/** what taking one does; the game passes in whatever it wants to happen and gets told to make a noise */
export type Take = (pickup: Pickup) => boolean;

/**
 * Spin, bob, and hand out whatever the player walked over.
 *
 * Frame time rather than step time: none of this decides a fight, so it should be as smooth as the screen
 * is rather than as deterministic as the physics.
 */
export function stepPickups(pickups: Pickup[], feet: Vector3, now: number, dt: number, take: Take): void {
  for (const it of pickups) {
    const look = LOOK[it.spec.kind];

    if (!it.ready) {
      if (it.spec.respawn <= 0) continue;
      it.timer -= dt;
      if (it.timer > 0) continue;
      it.ready = true;
      it.mesh.visible = true;
    }

    it.mesh.rotation.y = now * 1.6;
    it.mesh.position.y = it.spec.at.y + look.lift + Math.sin(now * 2.2) * 0.08;

    if (flatDistance(it.mesh.position, feet) > REACH) continue;
    if (Math.abs(it.mesh.position.y - feet.y) > RISE) continue;
    // the game says whether it was any use: a health pack at full health is left where it is
    if (!take(it)) continue;

    it.ready = false;
    it.timer = it.spec.respawn;
    it.mesh.visible = false;
  }
}
