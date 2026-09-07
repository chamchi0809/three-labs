/**
 * Tracers and sparks: what a hitscan weapon has instead of a projectile.
 *
 * A shot that lands the instant it is fired has nothing on screen to show for itself, and a shotgun with
 * nothing on screen feels like a mouse click. So every ray leaves a line behind for a twelfth of a second
 * and every hit leaves a spark where it landed, and between them the player can see the spread, tell which
 * gun is firing, and — the part that matters in a fight — tell a hit from a miss.
 *
 * Both are pools. A plasma gun at ten shots a second would otherwise allocate a mesh, a geometry and a
 * material thirty times a second and hand the collector the lot.
 */
import {
  AdditiveBlending,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
  type Object3D,
} from "three/webgpu";
import { disposeTree } from "./junk.ts";

/** how long a tracer and a spark last, in seconds — long enough to see, short enough not to clutter */
const TRACER = 0.075;
const SPARK = 0.18;

/** as many as a shotgun blast needs at once, twice over */
const POOL = 24;

const UP = new Vector3(0, 1, 0);
const spin = new Quaternion();
const along = new Vector3();

type Flash = { mesh: Mesh; material: MeshBasicMaterial; life: number; span: number };

export class Effects {
  readonly #root = new Group();
  readonly #tracers: Flash[] = [];
  readonly #sparks: Flash[] = [];
  #nextTracer = 0;
  #nextSpark = 0;

  constructor(parent: Object3D) {
    // the effects are their own subtree, so the whole lot is freed in one go on the way out
    this.#root.name = "effects";
    parent.add(this.#root);

    const line = new CylinderGeometry(0.012, 0.012, 1, 5, 1, true);
    const shard = new OctahedronGeometry(0.09);
    for (let i = 0; i < POOL; i++) {
      this.#tracers.push(this.#make(line));
      this.#sparks.push(this.#make(shard));
    }
  }

  #make(geometry: CylinderGeometry | OctahedronGeometry): Flash {
    const material = new MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new Mesh(geometry, material);
    mesh.visible = false;
    // a tracer is not a shadow caster and not something a shadow lands on
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.#root.add(mesh);
    return { mesh, material, life: 0, span: TRACER };
  }

  /** a line from the muzzle to wherever the ray stopped */
  tracer(from: Vector3, to: Vector3, colour: number): void {
    const it = this.#tracers[this.#nextTracer++ % POOL]!;
    along.subVectors(to, from);
    const length = along.length();
    if (length < 1e-3) return;

    // the cylinder is drawn along Y, so it is turned to point along the shot and stretched to reach
    spin.setFromUnitVectors(UP, along.multiplyScalar(1 / length));
    it.mesh.quaternion.copy(spin);
    it.mesh.scale.set(1, length, 1);
    it.mesh.position.copy(from).addScaledVector(along, length / 2);
    it.material.color.setHex(colour);
    it.mesh.visible = true;
    it.life = TRACER;
    it.span = TRACER;
  }

  /** where a ray ended, whether that was a wall or a monster */
  spark(at: Vector3, colour: number): void {
    const it = this.#sparks[this.#nextSpark++ % POOL]!;
    it.mesh.position.copy(at);
    it.mesh.scale.setScalar(1);
    it.material.color.setHex(colour);
    it.mesh.visible = true;
    it.life = SPARK;
    it.span = SPARK;
  }

  /** frame time, not step time: these are decoration and should be smooth rather than deterministic */
  step(dt: number): void {
    for (const list of [this.#tracers, this.#sparks]) {
      for (const it of list) {
        if (it.life <= 0) continue;
        it.life -= dt;
        if (it.life <= 0) {
          it.mesh.visible = false;
          it.material.opacity = 0;
          continue;
        }
        const t = it.life / it.span;
        it.material.opacity = t;
        // a spark grows as it fades; a tracer only fades, and its orientation is a quaternion pointing
        // along the shot that nothing here may touch
        if (list === this.#sparks) it.mesh.scale.setScalar(1 + (1 - t) * 1.6);
      }
    }
  }

  dispose(): void {
    disposeTree(this.#root);
  }
}
