/**
 * A session: one renderer, one level, one fight.
 *
 * Started with the project the editor is holding and torn down completely when it stops, because the thing
 * on the other side of Play is the editor and it wants its GPU back. Everything the session made — the
 * renderer, the scene the sheet built, the monsters, the pooled effects, the HUD, the audio context — is
 * freed by `stop()`, so pressing Play thirty times in a row costs what pressing it once costs.
 *
 * Two clocks, which is the only structural decision in here worth arguing about:
 *
 * - **Fixed steps** for anything that decides a fight. Movement, gravity, monsters. A player who jumps a
 *   gap on a 165 Hz monitor has to make the same jump on a 60 Hz one, and the only way to get that is to
 *   run the physics at a rate the monitor has no say in. {@link fixedStepSchedule} is the accountant.
 * - **Frame time** for everything else: tracers fading, pickups spinning, the gun bobbing, the HUD. None
 *   of it can decide anything, and all of it looks better at the rate the screen actually refreshes.
 *
 * The hitscan lives here rather than in `weapons.ts` because it is the one piece that needs all of it at
 * once: the octree for walls, the monsters for targets, the effects for the tracer, and the audio for the
 * noise. `weapons.ts` stays a table of numbers, which is what makes it something to tune.
 */
import {
  Color,
  Fog,
  Group,
  PerspectiveCamera,
  Ray,
  Scene,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import { disposeScene, updateScene } from "tscene";
import type { Snapshot } from "tscene-editor";
import { Sfx } from "./audio.ts";
import { Effects } from "./effects.ts";
import { Hud, hudState } from "./hud.ts";
import { disposeTree } from "./junk.ts";
import { loadLevel, type Level } from "./level.ts";
import { hurtMonster, spawnMonsters, stepMonsters, torsoOf, type Monster } from "./monsters.ts";
import { feetOf } from "./physics.ts";
import { spawnPickups, stepPickups, type Pickup } from "./pickups.ts";
import {
  aimOf,
  canFire,
  cycleWeapon,
  eyeOf,
  hasAmmo,
  newPlayer,
  noInput,
  selectSlot,
  stepPlayer,
  weaponOf,
  type Player,
} from "./player.ts";
import { fixedStepSchedule } from "./step.ts";
import { ViewModel } from "./viewmodel.ts";
import type { Weapon } from "./weapons.ts";

/** the step everything that matters runs at */
const FIXED = 1 / 60;

/** how far the mouse turns the view, in radians a pixel */
const LOOK = 0.0022;

/** as high and as low as the view goes; short of straight up, which is where the maths stops being nice */
const PITCH = Math.PI / 2 - 0.02;

export type GameOptions = {
  /** Esc, with the pointer already unlocked: hand the screen back to the editor */
  onExit: () => void;
  /** where relative paths in the project resolve from, for a page that is not serving it at its own path */
  base?: string;
};

export type GameHandle = {
  stop(): void;
};

/** what the fight is doing, which is most of what the banner says */
type Phase = "fight" | "paused" | "won" | "lost";

export async function startGame(host: HTMLElement, project: Snapshot, opts: GameOptions): Promise<GameHandle> {
  const level = await loadLevel(project, { base: opts.base });

  // WebGL is the fallback rather than a failure: a browser without WebGPU should still get the demo, and
  // nothing in here needs a compute pass.
  const renderer = new WebGPURenderer({ antialias: true, forceWebGL: !("gpu" in navigator) });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  const canvas = renderer.domElement;
  canvas.style.cssText = "display:block;width:100%;height:100%";
  host.append(canvas);

  const scene = new Scene();
  // the arena is indoors and unlit beyond its own lamps, so the distance goes to the same near-black the
  // sheet's ambient light assumes
  scene.background = new Color(0x0a0d13);
  scene.fog = new Fog(0x0a0d13, 26, 78);
  scene.add(level.root);

  const camera = new PerspectiveCamera(90, 1, 0.05, 220);
  // yaw then pitch, which is what a first-person camera means by "look"; the default order rolls the view
  camera.rotation.order = "YXZ";

  const hud = new Hud(host);
  const sfx = new Sfx();
  const effects = new Effects(scene);
  const view = new ViewModel(camera);
  // the camera is not in the scene graph's way, but the viewmodel hangs off it and has to be drawn
  scene.add(camera);

  const input = noInput();
  const held = new Set<string>();
  let player: Player = newPlayer(level.spawn.at, level.spawn.yaw);
  let actors = spawn(level);
  let monsters: Monster[] = actors.monsters;
  let pickups: Pickup[] = actors.pickups;
  let kills = 0;
  let phase: Phase = "paused";
  let dying = 0;

  scene.add(actors.root);
  view.show(player.weapon);
  hud.set(hudState(player, kills, monsters.length));
  hud.banner("click to play", "mouse look, WASD to move. Esc gives the screen back to the editor.", "hold");

  // ---------------------------------------------------------------- the fight

  const harm = (damage: number): void => {
    if (player.dead || phase !== "fight") return;
    player.health -= damage;
    player.hurt = 0.3;
    hud.damage();
    sfx.hurt();
    if (player.health > 0) return;
    player.health = 0;
    player.dead = true;
    phase = "lost";
    dying = 0;
    sfx.die();
    hud.banner("you died", "R to try again, Esc to go back and make it easier.", "lose");
  };

  const take = (pickup: Pickup): boolean => {
    const { kind, amount } = pickup.spec;
    if (kind === "health") {
      if (player.health >= 100) return false;
      player.health = Math.min(100, player.health + amount);
    } else {
      // the first cells in the level are also the plasma gun: there is no gun to find, only ammunition,
      // and a player who has never fired it will not think to press 3
      const armed = player.ammo[kind] > 0;
      player.ammo[kind] += amount;
      if (!armed && kind === "cells" && selectSlot(player, 3)) view.show(player.weapon);
    }
    sfx.pickup();
    return true;
  };

  const eye = new Vector3();
  const aim = new Vector3();
  const muzzle = new Vector3();
  const pellet = new Vector3();

  function fire(): void {
    if (phase !== "fight" || !canFire(player)) return;
    const weapon = weaponOf(player);
    player.cooldown = weapon.cooldown;
    player.recoil = Math.min(4, player.recoil + weapon.kick);
    if (weapon.ammo) player.ammo[weapon.ammo] -= 1;
    // the kick walks the aim up, which is what makes the plasma gun's cadence something to control
    player.pitch = Math.min(PITCH, player.pitch + weapon.kick * 0.0045);
    view.fired();
    sfx.fire(weapon.id);

    eyeOf(player, eye);
    aimOf(player, aim);
    // tracers come out of the gun in the corner, not out of the middle of the forehead
    muzzle.copy(eye).addScaledVector(aim, 0.45);
    muzzle.y -= 0.12;

    let landed = false;
    for (let i = 0; i < weapon.pellets; i++) {
      cone(aim, weapon.spread, i, pellet);
      if (shoot(weapon)) landed = true;
    }
    if (landed) hud.hit();
    // out of ammunition with the trigger still down: switch to something that will fire rather than click
    if (!hasAmmo(player) && !player.dead) {
      cycleWeapon(player, 1);
      view.show(player.weapon);
    }
  }

  const ray = new Ray();
  const segA = new Vector3();
  const segB = new Vector3();
  const onRay = new Vector3();
  const onSeg = new Vector3();
  const at = new Vector3();

  /** one ray: whichever of the level and the monsters it reaches first, or nothing */
  function shoot(weapon: Weapon): boolean {
    ray.set(eye, pellet);
    const wall = wallAhead(weapon.range);

    let reach = wall ?? weapon.range;
    let target: Monster | null = null;
    for (const m of monsters) {
      if (!m.alive) continue;
      torsoOf(m, segA, segB);
      // the torso is a segment and the shot is a ray, so the closest approach between the two is the whole
      // test: within the monster's own radius of its spine counts as a hit
      const miss = ray.distanceSqToSegment(segA, segB, onRay, onSeg);
      if (miss > (m.body.radius * 0.92) ** 2) continue;
      const along = onRay.distanceTo(eye);
      if (along >= reach) continue;
      reach = along;
      target = m;
      at.copy(onRay);
    }

    if (!target) at.copy(eye).addScaledVector(pellet, reach);
    effects.tracer(muzzle, at, weapon.colour);

    if (target) {
      effects.spark(at, 0xff6a4a);
      if (hurtMonster(target, weapon.damage, eye)) {
        kills += 1;
        sfx.kill();
        if (kills >= monsters.length) win();
      } else {
        sfx.hit();
      }
      return true;
    }

    if (wall !== null) effects.spark(at, 0xffd8a0);
    return false;
  }

  /** how far the level is along the current ray, or null if it is further than the gun reaches */
  function wallAhead(range: number): number | null {
    const hit = level.world.rayIntersect(ray);
    if (!hit || hit.distance > range) return null;
    return hit.distance;
  }

  function win(): void {
    phase = "won";
    sfx.win();
    hud.banner("area clear", "Esc goes back to the editor — move something, press Play, fight it again.", "win");
  }

  function restart(): void {
    disposeTree(actors.root);
    actors = spawn(level);
    monsters = actors.monsters;
    pickups = actors.pickups;
    scene.add(actors.root);
    player = newPlayer(level.spawn.at, level.spawn.yaw);
    kills = 0;
    dying = 0;
    accumulator = 0;
    phase = locked() ? "fight" : "paused";
    view.show(player.weapon);
    hud.clearBanner();
    if (phase === "paused") hud.banner("click to play", "R restarted the level. Click to take the mouse.", "hold");
  }

  // ---------------------------------------------------------------- keys, mouse, pointer lock

  // One controller for every listener the session takes out, on the window and on the document as well as
  // on the canvas: `stop()` aborting it is the whole of the teardown, and there is no list to forget an
  // entry from. A stale keydown handler on the window is the bug this arrangement exists to prevent — it
  // would move a player that is no longer on screen, in a level that has been freed.
  const gone = new AbortController();
  type Events = WindowEventMap & DocumentEventMap;
  const on = <K extends keyof Events>(
    target: Window | Document | HTMLElement,
    kind: K,
    handler: (e: Events[K]) => void,
  ): void =>
    target.addEventListener(kind as string, handler as EventListener, { signal: gone.signal });

  const locked = (): boolean => document.pointerLockElement === canvas;

  on(window, "keydown", (e) => {
    if (e.repeat) return;
    // Escape while the pointer is locked never gets here — the browser eats it to unlock, which turns into
    // a pause below. Escape once more, now that nothing is holding the mouse, is what leaves.
    if (e.code === "Escape") {
      opts.onExit();
      return;
    }
    if (e.code === "KeyR") {
      restart();
      return;
    }
    held.add(e.code);
    const slot = Number(e.code.startsWith("Digit") ? e.code.slice(5) : NaN);
    if (slot && selectSlot(player, slot)) view.show(player.weapon);
    if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(e.code)) e.preventDefault();
  });

  on(window, "keyup", (e) => void held.delete(e.code));
  // a window that loses focus mid-strafe should not keep strafing
  on(window, "blur", () => held.clear());

  on(canvas, "mousedown", (e) => {
    if (!locked()) {
      // the click that takes the mouse is not also a shot
      void canvas.requestPointerLock();
      return;
    }
    if (e.button === 0) input.fire = true;
  });
  on(window, "mouseup", (e) => void (e.button === 0 && (input.fire = false)));

  on(window, "mousemove", (e) => {
    if (!locked() || player.dead) return;
    player.yaw -= e.movementX * LOOK;
    player.pitch = Math.max(-PITCH, Math.min(PITCH, player.pitch - e.movementY * LOOK));
  });

  on(window, "wheel", (e) => {
    if (!locked()) return;
    cycleWeapon(player, e.deltaY > 0 ? 1 : -1);
    view.show(player.weapon);
  });

  on(document, "pointerlockchange", () => {
    if (locked()) {
      if (phase !== "paused") return;
      phase = "fight";
      accumulator = 0;
      hud.clearBanner();
      return;
    }
    input.fire = false;
    held.clear();
    if (phase !== "fight") return;
    phase = "paused";
    hud.banner("paused", "click to carry on, Esc to go back to the editor.", "hold");
  });

  const resize = (): void => {
    const width = host.clientWidth || window.innerWidth;
    const height = host.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  on(window, "resize", resize);
  resize();

  // ---------------------------------------------------------------- the loop

  let accumulator = 0;
  let last = 0;
  let clock = 0;
  const feet = new Vector3();

  renderer.setAnimationLoop((now) => {
    const deltaMs = last ? now - last : 0;
    last = now;
    const dt = Math.min(deltaMs / 1000, 0.1);
    clock += dt;

    if (phase === "fight" || phase === "won" || phase === "lost") {
      const plan = fixedStepSchedule(accumulator, deltaMs, FIXED);
      accumulator = plan.accumulator;
      for (let i = 0; i < plan.steps; i++) {
        input.forward = (held.has("KeyW") ? 1 : 0) - (held.has("KeyS") ? 1 : 0);
        input.strafe = (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0);
        input.jump = held.has("Space");
        input.sprint = held.has("ShiftLeft") || held.has("ShiftRight");
        // a fight that is over is still a world: monsters keep walking, the body keeps falling
        stepPlayer(player, phase === "fight" ? input : noInput(), level.world, FIXED);
        feet.set(player.body.start.x, feetOf(player.body), player.body.start.z);
        stepMonsters(monsters, feet, level.world, FIXED, harm);
        if (input.fire) fire();
      }
    }

    feet.set(player.body.start.x, feetOf(player.body), player.body.start.z);
    if (phase === "fight") stepPickups(pickups, feet, clock, dt, take);
    effects.step(dt);
    view.step(player, dt);
    hud.step(dt);
    hud.set(hudState(player, kills, monsters.length));
    // whatever the sheet is animating: a level with a clip on a door is the level's business, not the game's
    updateScene(level.root, dt);

    eyeOf(player, eye);
    if (player.dead) {
      // face down on the floor, over three quarters of a second
      dying = Math.min(1, dying + dt / 0.75);
      eye.y -= dying * 1.0;
    }
    camera.position.copy(eye);
    camera.rotation.set(player.pitch, player.yaw, player.dead ? dying * 0.8 : 0);

    renderer.render(scene, camera);
  });

  // The same development-only handle the editor opens on its viewport, for the same reason: "what hit me"
  // and "why did that shot miss" are questions a console with the session in it answers in one line, and a
  // screenshot does not answer at all. Getters, because everything it names is reassigned by a restart.
  if (import.meta.env.DEV) {
    Object.assign(globalThis, {
      broomGame: {
        get phase() {
          return phase;
        },
        get player() {
          return player;
        },
        get monsters() {
          return monsters;
        },
        get pickups() {
          return pickups;
        },
        level,
        scene,
        camera,
        renderer,
      },
    });
  }

  return {
    stop(): void {
      gone.abort();
      renderer.setAnimationLoop(null);
      if (locked()) document.exitPointerLock();
      view.dispose();
      effects.dispose();
      disposeTree(actors.root);
      hud.dispose();
      sfx.dispose();
      // the sheet's own geometry, materials and textures, which nothing else on the page shares
      disposeScene(level.root);
      renderer.dispose();
      canvas.remove();
      // a handle on a session that no longer exists answers questions about a game that is not running
      if (import.meta.env.DEV) delete (globalThis as { broomGame?: unknown }).broomGame;
    },
  };
}

/** everything the level said to put in it, in one subtree so a restart is one dispose and one rebuild */
function spawn(level: Level): { root: Group; monsters: Monster[]; pickups: Pickup[] } {
  const root = new Group();
  root.name = "actors";
  return {
    root,
    monsters: spawnMonsters(level.monsters, root),
    pickups: spawnPickups(level.pickups, root),
  };
}

/**
 * One pellet's direction: the aim, turned by a little, in a pattern rather than at random.
 *
 * A shotgun with nine randomly scattered pellets is nine different guns from one shot to the next — some
 * blasts gut a grunt and some tickle it, and the player cannot tell why. A fixed rosette around the aim is
 * the same gun every time and still reads as a spread.
 */
const side = new Vector3();
const up = new Vector3();

function cone(aim: Vector3, spread: number, i: number, out: Vector3): Vector3 {
  out.copy(aim);
  if (spread <= 0 || i === 0) return out.normalize();
  // a spiral: each pellet a turn and a bit further out, which fills a disc without clumping
  const angle = i * 2.399963;
  const radius = spread * Math.sqrt(i / 8);
  // any two axes across the aim will do, and the aim is never straight up in a game with a pitch clamp
  side.set(-aim.z, 0, aim.x).normalize();
  up.crossVectors(side, aim).normalize();
  return out
    .addScaledVector(side, Math.cos(angle) * radius)
    .addScaledVector(up, Math.sin(angle) * radius)
    .normalize();
}

