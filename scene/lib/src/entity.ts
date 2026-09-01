/**
 * `entity` — a node that is data rather than geometry.
 *
 * Every other node in a sheet says what three should draw. An entity says what the *game* should know:
 * this door needs a key, that slime has 30 hit points, the next room loads here. LDtk and TrenchBroom
 * both give that its own kind of thing, and so does this — an Object3D with no geometry, no material and
 * nothing to render, whose whole content is a record of values sitting at a point in the level.
 *
 * ```scene
 * @template entity.spawner {
 *   @broom { color: #6fd08c; size: [-.3, 0, -.3, .3, 1.8, .3]; category: "gameplay"; }
 *   @fields { hp: { type: int; min: 1; max: 999 } }
 *   @entity { hp: 30; }
 * }
 *
 * entity.spawner#ogre { position: vec3(4, 0, -2); @entity { hp: 60; } }
 * ```
 *
 * The data arrives through the `@entity { … }` at-rule the runtime already merges template-first,
 * node-last — a definition's defaults under an instance's overrides — so `root.getObjectByName("ogre")`
 * comes back with `entity.hp === 60`, and `@fields` says what each key *is* for the editor that draws
 * a box for it.
 *
 * The template the node was written with comes through too, as {@link Entity.kinds} — `@entity` says what
 * an entity *holds*, and a game also has to know what it *is*: `entities(root, "monster")`.
 */
import { Object3D } from "three/webgpu";

export class Entity<F = Record<string, unknown>> extends Object3D {
  readonly isEntity = true;
  /** the level's own data: `@entity { … }` on the template, with the node's own written over it */
  entity: F = {} as F;
  /**
   * The templates the node was written with, in order: `entity.monster.boss` arrives as
   * `["monster", "boss"]`.
   *
   * A level's monsters, its pickups and its spawn points are all entities, and until this was here the
   * only way a game could tell them apart was by guessing from their keys — "it has `hp`, so it must be a
   * monster". The class is what the level actually said, so it is what the game reads. `@fields` and
   * `@entity` are erased into plain data by the time a sheet is built, but the template *name* survives
   * because it is the type.
   */
  kinds: string[] = [];
  // three reads `type` back in its own serialiser and in `getObjectByProperty`, and the base declares it
  // readonly — so it is set the way three's own subclasses set it, by declaring the narrower literal
  override readonly type: string = "Entity";
}
