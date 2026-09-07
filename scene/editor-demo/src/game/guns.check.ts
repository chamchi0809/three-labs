// What holding a gun means, checked without a renderer.
//
// All of it is bookkeeping — a weapon is a row in a table and firing one spends a number — and every bit of
// it lives behind a pointer lock, so the only way any of it is ever seen is by playing. Which is how a gun
// that changed itself after every single shot got as far as it did: the switch that catches a player who ran
// dry mid-fight asked `canFire`, and a gun is not fireable during its own cooldown either.
// node --experimental-strip-types src/game/guns.check.ts
import assert from "node:assert/strict";
import { Vector3 } from "three/webgpu";
import { canFire, cycleWeapon, hasAmmo, newPlayer, selectSlot, weaponOf } from "./player.ts";
import { SLOTS, WEAPONS } from "./weapons.ts";

const fresh = () => newPlayer(new Vector3(0, 0, 0), 0);

// ---------------------------------------------------------------- what you start with

const start = fresh();
assert.equal(start.weapon, "shotgun", "you come in with the shotgun, and shells for it");
assert.ok(start.ammo.shells > 0);
assert.ok(canFire(start), "and it can go off immediately");
assert.equal(WEAPONS.blaster.ammo, undefined, "the blaster spends nothing, which is what keeps it in reserve");

// ---------------------------------------------------------------- firing does not change the gun

// One shot's worth of bookkeeping, done the way `fire()` does it: spend the ammunition, start the cooldown.
const firing = fresh();
firing.ammo.shells -= 1;
firing.cooldown = WEAPONS.shotgun.cooldown;

assert.equal(canFire(firing), false, "a gun cannot go off again inside its own cooldown");
assert.equal(hasAmmo(firing), true, "but it has not run out — and that is the difference the switch reads");
assert.equal(firing.weapon, "shotgun", "one shot from a shotgun leaves a shotgun in your hands");

// the cooldown runs out and the same gun is ready again, still the same gun
firing.cooldown = 0;
assert.ok(canFire(firing), "and once the cooldown is up it fires again");
assert.equal(firing.weapon, "shotgun");

// ---------------------------------------------------------------- running dry does change it

const dry = fresh();
dry.ammo.shells = 1;
dry.ammo.shells -= 1;
dry.cooldown = WEAPONS.shotgun.cooldown;
assert.equal(hasAmmo(dry), false, "the last shell is spent");
cycleWeapon(dry, 1);
assert.equal(dry.weapon, "blaster", "the trigger is still down, so it comes up with something that fires");

// a gun with no ammunition anywhere is never what a cycle lands on
const empty = fresh();
empty.ammo.shells = 0;
empty.ammo.cells = 0;
for (let i = 0; i < SLOTS.length + 1; i++) {
  cycleWeapon(empty, 1);
  assert.equal(empty.weapon, "blaster", "with nothing to spend there is one gun left and it is the blaster");
}

// ---------------------------------------------------------------- the number keys

const keys = fresh();
assert.equal(selectSlot(keys, 3), true, "3 is the plasma gun");
assert.equal(keys.weapon, "plasma");
assert.equal(selectSlot(keys, 3), false, "pressing it again is not a change, and the viewmodel is not redrawn");
assert.equal(selectSlot(keys, 9), false, "a key that names no gun leaves the gun alone");
assert.equal(keys.weapon, "plasma");
// selecting an empty gun is allowed: a player who presses 3 with no cells gets a click and knows why
assert.equal(keys.ammo.cells, 0, "you arrive with no cells");
assert.equal(canFire(keys), false, "so the plasma gun clicks");
assert.equal(weaponOf(keys).id, "plasma", "and stays in your hands until you find some");

console.log("ok   a gun stays in your hands until it runs dry");
