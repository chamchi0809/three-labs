/**
 * Three guns, as a table.
 *
 * All hitscan, because that is what a boomer shooter is: the shot lands the instant the trigger is pulled,
 * along a ray, and the interesting part is the spread and the cadence rather than the flight. A shotgun is
 * nine rays at once with a wide cone and a long wait; a blaster is one ray, tight, and no wait to speak of.
 * Nothing here is a class — a weapon is numbers, and the code that fires one is the same either way.
 */
export type WeaponId = "blaster" | "shotgun" | "plasma";

/** what a shot spends: the blaster spends nothing, which is what keeps a player who ran dry in the fight */
export type Ammo = "shells" | "cells";

export type Weapon = {
  id: WeaponId;
  name: string;
  /** the number key that selects it */
  slot: number;
  ammo?: Ammo;
  /** rays per shot */
  pellets: number;
  /** the cone they go into, in radians — half-angle at the edge of the spread */
  spread: number;
  damage: number;
  /** seconds between shots */
  cooldown: number;
  /** how far a ray reaches before it is a miss */
  range: number;
  /** how hard the view kicks, in the units the viewmodel's recoil is measured in */
  kick: number;
  /** the tracer's colour, which is most of what tells one gun from another mid-fight */
  colour: number;
};

export const WEAPONS: Record<WeaponId, Weapon> = {
  blaster: {
    id: "blaster",
    name: "blaster",
    slot: 1,
    pellets: 1,
    spread: 0.004,
    damage: 14,
    cooldown: 0.18,
    range: 120,
    kick: 0.5,
    colour: 0x9fe8ff,
  },
  shotgun: {
    id: "shotgun",
    name: "shotgun",
    slot: 2,
    ammo: "shells",
    pellets: 9,
    spread: 0.055,
    damage: 11,
    cooldown: 0.85,
    range: 60,
    kick: 2.4,
    colour: 0xffd08a,
  },
  plasma: {
    id: "plasma",
    name: "plasma",
    slot: 3,
    ammo: "cells",
    pellets: 1,
    spread: 0.013,
    damage: 13,
    cooldown: 0.1,
    range: 120,
    kick: 0.7,
    colour: 0xc39bff,
  },
};

/** in slot order, which is the order the HUD lists them and the number keys select them */
export const SLOTS: WeaponId[] = ["blaster", "shotgun", "plasma"];
