/**
 * A project the editor is holding, turned into a level the game can fight in.
 *
 * The important thing here is what is *not* here. There is no export step, no intermediate format, no
 * "compile the map" — `Snapshot` is the text of every sheet in the project exactly as a save would have
 * written it, and this loads it the way the finished game would load it off a server. Which means the
 * arena the player walks around is built by the same code path whether it came from a file or from an
 * editor that has not saved yet, and a level that plays is a level that ships.
 *
 * Three things come out of a sheet:
 *
 * - **the scene**, brushes and lights, which is three's business and already done by the time `loadScene`
 *   returns;
 * - **the collision world**, an `Octree` over every mesh in it — the architecture *is* the collision, so
 *   there is no second set of geometry to keep in step with the first;
 * - **the gameplay**, read off the entities. What a monster has for hit points is what the level says it
 *   has, not what this file says, because the level is where a designer can change it.
 */
import { Vector3 } from "three/webgpu";
import type { Group } from "three/webgpu";
import { Octree } from "three/addons/math/Octree.js";
import { entities, loadScene, type Loader } from "tscene";
import { threeRegistry } from "tscene/three";
import type { Snapshot } from "tscene-editor";

export type Breed = "grunt" | "brute";
export type Supply = "health" | "shells" | "cells";

/** `entity.spawn` — where the player comes in, and looking which way */
export type Spawn = { at: Vector3; yaw: number };

/** `entity.monster` — one enemy as the level described it */
export type MonsterSpec = {
  name: string;
  breed: Breed;
  at: Vector3;
  hp: number;
  speed: number;
  damage: number;
  sight: number;
};

/** `entity.pickup` — one thing to walk over */
export type PickupSpec = {
  name: string;
  kind: Supply;
  at: Vector3;
  amount: number;
  respawn: number;
};

export type Level = {
  /** what the sheet built: brushes and lights, ready to be added to a scene */
  root: Group;
  /** every mesh of it, as something a capsule and a bullet can be asked about */
  world: Octree;
  spawn: Spawn;
  monsters: MonsterSpec[];
  pickups: PickupSpec[];
};

export type LevelOptions = {
  /**
   * What relative `@import`s and asset paths resolve against. Defaults to the root sheet's own path on
   * this page, which is what it is when the project came over the network; a check running in node passes
   * a `file:` URL instead.
   */
  base?: string;
};

/** the same numbers the library sheet declares, for the level that lost a key somewhere */
const DEFAULTS = { hp: 40, speed: 3.6, damage: 9, sight: 28, amount: 25, respawn: 0 };

export async function loadLevel(project: Snapshot, opts: LevelOptions = {}): Promise<Level> {
  const base = opts.base ?? new URL(project.root, document.baseURI).href;
  const source = sheet(project, base);
  if (source === undefined) throw new Error(`the project has no ${project.root}`);

  const root = await loadScene(source, {
    base,
    // A sheet handed over as a string was never seen by the vite plugin, so nothing has told it what
    // `meshStandardMaterial` is. `threeRegistry` is that: three's own classes, by the names a sheet uses.
    registry: threeRegistry,
    // and its @imports come out of the project rather than off the network — the whole point of being
    // handed a snapshot is that the files may not exist on any server yet
    load: loader(project, base),
  });

  const world = new Octree().fromGraphNode(root);

  const spawn = entities<{ facing?: unknown }>(root, "spawn")[0];
  if (!spawn) throw new Error("the level has no entity.spawn — there is nowhere to come in");

  return {
    root,
    world,
    spawn: {
      at: spawn.position.clone(),
      // degrees about Y, 0 looking down -Z: three's own idea of forward, and what library.tscene documents
      yaw: (num(spawn.entity.facing, 0) * Math.PI) / 180,
    },
    monsters: entities<Record<string, unknown>>(root, "monster").map((e, i) => ({
      name: e.name || `monster${i + 1}`,
      breed: e.entity.breed === "brute" ? "brute" : "grunt",
      at: e.position.clone(),
      hp: Math.max(1, Math.round(num(e.entity.hp, DEFAULTS.hp))),
      speed: num(e.entity.speed, DEFAULTS.speed),
      damage: Math.max(1, Math.round(num(e.entity.damage, DEFAULTS.damage))),
      sight: num(e.entity.sight, DEFAULTS.sight),
    })),
    pickups: entities<Record<string, unknown>>(root, "pickup").map((e, i) => ({
      name: e.name || `pickup${i + 1}`,
      kind: supply(e.entity.kind),
      at: e.position.clone(),
      amount: Math.max(1, Math.round(num(e.entity.amount, DEFAULTS.amount))),
      respawn: Math.max(0, num(e.entity.respawn, DEFAULTS.respawn)),
    })),
  };
}

/**
 * A {@link Loader} over the project's own files.
 *
 * Keys are page-absolute paths — `/scenes/library.tscene` — which is what the editor fetched them by, so
 * `new URL` does the whole of the path arithmetic: an `@import "./library.tscene"` inside
 * `/scenes/arena.tscene` resolves against the importer and comes out as the key it was stored under.
 */
const loader = (project: Snapshot, base: string): Loader =>
  async (path, from) => {
    const url = new URL(path, from ?? base);
    const text = sheet(project, url.href);
    if (text === undefined) throw new Error(`${path} is not part of this project`);
    return { text, file: url.href };
  };

/** the text of one file of a project, by URL — with and without the leading slash, because both are used */
function sheet(project: Snapshot, url: string): string | undefined {
  const key = new URL(url, "file:///").pathname;
  return project.files[key] ?? project.files[key.replace(/^\/+/, "")] ?? project.files[url];
}

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const supply = (v: unknown): Supply => (v === "shells" || v === "cells" ? v : "health");
