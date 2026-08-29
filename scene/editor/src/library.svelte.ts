/**
 * The definitions the open project declares, as the panels see them.
 *
 * A sibling of {@link session} rather than part of it, because the catalogue is not a thing anyone edits
 * and so is not a thing anyone undoes. It comes from the sheet's `@template`s and `--var`s, it changes
 * when the sheet is opened or reloaded, and putting it on the undo stack would mean a designer could
 * press ⌘Z until the entity browser was empty.
 */
import { demoCatalogue } from "./doc/demo.ts";
import type { Catalogue, EntityDef, MaterialDef } from "./doc/catalogue.ts";

class Library {
  #catalogue = $state<Catalogue>(demoCatalogue());

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
    this.#catalogue = catalogue;
  }
}

export const library = new Library();
