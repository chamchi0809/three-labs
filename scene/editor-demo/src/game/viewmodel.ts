/**
 * The gun in the corner of the screen.
 *
 * Not because a shooter needs one to work, but because it is where three quarters of the feedback lives: it
 * bobs when you walk, so speed is visible; it kicks when you fire, so the cadence is visible; it flashes at
 * the muzzle, so a shot that hit nothing still happened; and it changes shape when you switch, so the
 * number keys have an effect you can see without reading the HUD.
 *
 * Attached to the camera rather than placed in the world, which is what makes it a viewmodel: it is drawn
 * where the camera is looking, always, and never occluded by anything except the near plane.
 */
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from "three/webgpu";
import { disposeTree } from "./junk.ts";
import { SLOTS, WEAPONS, type WeaponId } from "./weapons.ts";
import type { Player } from "./player.ts";

/** where the gun sits relative to the eye: right, down, and far enough forward to clear the near plane */
const HOLD = { x: 0.22, y: -0.19, z: -0.42 };

export class ViewModel {
  readonly #root = new Group();
  readonly #guns = new Map<WeaponId, Group>();
  readonly #flash: Mesh;
  readonly #flashSkin: MeshStandardMaterial;
  #flashing = 0;

  constructor(camera: Object3D) {
    this.#root.position.set(HOLD.x, HOLD.y, HOLD.z);
    // a viewmodel is drawn after everything and lit like everything, but it is not part of the level: no
    // shadow of a gun on the floor of the arena
    this.#root.renderOrder = 2;
    camera.add(this.#root);

    for (const id of SLOTS) {
      const gun = build(id);
      gun.visible = false;
      this.#root.add(gun);
      this.#guns.set(id, gun);
    }

    this.#flashSkin = new MeshStandardMaterial({
      color: 0xfff2c0,
      emissive: 0xffdd88,
      emissiveIntensity: 6,
      transparent: true,
    });
    this.#flash = new Mesh(new CylinderGeometry(0.001, 0.05, 0.14, 8, 1, true), this.#flashSkin);
    this.#flash.rotation.x = -Math.PI / 2;
    this.#flash.position.set(0, 0.005, -0.34);
    this.#flash.visible = false;
    this.#root.add(this.#flash);
  }

  show(id: WeaponId): void {
    for (const [which, gun] of this.#guns) gun.visible = which === id;
    this.#flashSkin.color.setHex(WEAPONS[id].colour);
  }

  /** a shot was fired: light the muzzle for a frame or two */
  fired(): void {
    this.#flashing = 0.045;
  }

  step(player: Player, dt: number): void {
    // bob on distance walked, not on a timer: standing still should be still
    const bob = Math.sin(player.travelled * 3.1) * 0.012;
    const sway = Math.cos(player.travelled * 1.55) * 0.01;
    const kick = player.recoil * 0.02;

    this.#root.position.set(HOLD.x + sway, HOLD.y + bob - kick * 0.4, HOLD.z + kick);
    this.#root.rotation.set(-player.recoil * 0.09, 0, sway * 0.6);

    this.#flashing = Math.max(0, this.#flashing - dt);
    this.#flash.visible = this.#flashing > 0;
  }

  dispose(): void {
    disposeTree(this.#root);
  }
}

/** three silhouettes, from boxes: a stubby pistol, a wide double barrel, a slab with a glowing coil */
function build(id: WeaponId): Group {
  const gun = new Group();
  const steel = new MeshStandardMaterial({ color: 0x2f333c, roughness: 0.45, metalness: 0.8 });
  const grip = new MeshStandardMaterial({ color: 0x4a3428, roughness: 0.8 });
  const hot = new MeshStandardMaterial({
    color: WEAPONS[id].colour,
    emissive: WEAPONS[id].colour,
    emissiveIntensity: 1.4,
    roughness: 0.3,
  });

  const add = (geometry: BoxGeometry | CylinderGeometry, material: MeshStandardMaterial, x: number, y: number, z: number) => {
    const part = new Mesh(geometry, material);
    part.position.set(x, y, z);
    gun.add(part);
    return part;
  };

  add(new BoxGeometry(0.05, 0.11, 0.06), grip, 0, -0.05, 0.02);

  if (id === "blaster") {
    add(new BoxGeometry(0.055, 0.055, 0.2), steel, 0, 0.01, -0.09);
    add(new CylinderGeometry(0.012, 0.012, 0.06, 8), hot, 0, 0.01, -0.2).rotation.x = Math.PI / 2;
  } else if (id === "shotgun") {
    add(new BoxGeometry(0.09, 0.06, 0.26), steel, 0, 0.01, -0.11);
    for (const side of [-0.022, 0.022]) {
      add(new CylinderGeometry(0.019, 0.019, 0.3, 10), steel, side, 0.015, -0.2).rotation.x = Math.PI / 2;
    }
    add(new BoxGeometry(0.05, 0.04, 0.1), grip, 0, -0.025, -0.14);
  } else {
    add(new BoxGeometry(0.075, 0.075, 0.24), steel, 0, 0.015, -0.1);
    // the coil, which is the only part of a plasma gun that says what it is
    for (const at of [-0.13, -0.18, -0.23]) {
      add(new CylinderGeometry(0.032, 0.032, 0.012, 12), hot, 0, 0.015, at).rotation.x = Math.PI / 2;
    }
  }

  return gun;
}
