/**
 * The definitions the open project declares, as the panels see them.
 *
 * A sibling of {@link session} rather than part of it, because the catalogue is not a thing anyone edits
 * and so is not a thing anyone undoes. It comes from the sheet's `@template`s and `--var`s, it changes
 * when the sheet is opened or reloaded, and putting it on the undo stack would mean a designer could
 * press ⌘Z until the entity browser was empty.
 *
 * The one exception is relief depth, and it is an exception on purpose. `depth` is a property of a
 * *material* — one line inside a `--wall: heightMaterial { … }` — and the editor has no path to write a
 * `--var` declaration back into a sheet, so it cannot be edited the way a face's offset is. What it can be
 * is *tried*: a slider that overrides the sheet's number for as long as the session is open, so a designer
 * can find the number that looks right and then type it into the sheet. Held here rather than in the
 * document because a thing that never reaches a file is not a thing to undo.
 */
import { demoCatalogue } from "./doc/demo.ts";
import type { Catalogue, EntityDef, MaterialDef } from "./doc/catalogue.ts";

class Library {
  #loaded = $state<Catalogue>(demoCatalogue());
  /** material name → metres of relief, replacing what the sheet declared. Empty until someone drags */
  #depths = $state<Map<string, number>>(new Map());

  // the identity of this object is what `syncLook` watches to decide whether to rebuild the palette, so
  // an unchanged catalogue with no overrides has to come back as the *same* object, not an equal one
  #catalogue = $derived.by((): Catalogue => {
    const depths = this.#depths;
    if (!depths.size) return this.#loaded;
    return {
      entities: this.#loaded.entities,
      materials: this.#loaded.materials.map((m) => {
        const depth = depths.get(m.name);
        return depth === undefined ? m : { ...m, depth };
      }),
    };
  });

  get catalogue(): Catalogue {
    return this.#catalogue;
  }

  get entities(): EntityDef[] {
    return this.#catalogue.entities;
  }

  get materials(): MaterialDef[] {
    return this.#catalogue.materials;
  }

  /** what opening a sheet does; the panels re-read themselves from it */
  load(catalogue: Catalogue): void {
    this.#loaded = catalogue;
    // the overrides named materials in the sheet that was open, and the one being opened is a different
    // set of materials — carrying a depth across would be applying one wall's number to another's
    this.#depths = new Map();
  }

  /** whether this material's depth is the sheet's own, or one the session is trying out */
  overridden(name: string): boolean {
    return this.#depths.has(name);
  }

  /** metres of relief this material draws with now, sheet value included */
  depthOf(name: string): number | undefined {
    return this.#depths.get(name) ?? this.#loaded.materials.find((m) => m.name === name)?.depth;
  }

  /** try a depth; `undefined` puts the sheet's own number back */
  setDepth(name: string, metres: number | undefined): void {
    const next = new Map(this.#depths);
    if (metres === undefined) next.delete(name);
    else next.set(name, metres);
    this.#depths = next;
  }
}

export const library = new Library();
