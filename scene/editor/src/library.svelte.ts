/**
 * The definitions the open project declares, as the panels see them.
 *
 * A sibling of {@link session} rather than part of it, because the catalogue is not a thing anyone edits
 * and so is not a thing anyone undoes. It comes from the sheet's `@template`s and `--var`s, it changes
 * when the sheet is opened or reloaded, and putting it on the undo stack would mean a designer could
 * press ⌘Z until the object browser was empty.
 *
 * Materials are the exception, and the exception is only half an exception: what the *sheet* declares is
 * read here like everything else, but what this session has changed about a declaration lives on the
 * editor, because ⌘Z has to reach it. So the methods below are the material half of the command set —
 * they read `#loaded`, and they write through {@link session}. `io/materials.ts` turns the drafts into
 * text edits when the project is saved, the same way `write.ts` turns the world into them.
 *
 * Relief depth is a third thing again — not a draft but a *try*: a slider that overrides the sheet's
 * number for as long as the session is open, so a designer can find the number that looks right before
 * deciding to keep it. It is never written, which is why it is a separate map.
 */
import { demoCatalogue } from "./doc/demo.ts";
import { defKey, type Catalogue, type ObjectDef, type MaterialDef } from "./doc/catalogue.ts";
import { freeName, newMaterial, type MaterialDrafts } from "./io/materials.ts";
import type { TemplateDrafts } from "./io/templates.ts";
import { session } from "./session.svelte.ts";

class Library {
  #loaded = $state<Catalogue>(demoCatalogue());
  /** material name → metres of relief, replacing what the sheet declared. Empty until someone drags */
  #depths = $state<Map<string, number>>(new Map());
  // the identity of this object is what `syncLook` watches to decide whether to rebuild the palette, so
  // an unchanged catalogue with no overrides has to come back as the *same* object, not an equal one
  #catalogue = $derived.by((): Catalogue => {
    const depths = this.#depths;
    const drafts = session.editor.materials;
    const templates = session.editor.templates;
    if (!depths.size && !drafts.size && !templates.size) return this.#loaded;
    const materials: MaterialDef[] = [];
    for (const m of this.#loaded.materials) {
      const draft = drafts.has(m.name) ? drafts.get(m.name) : m;
      if (draft) materials.push(draft);
    }
    for (const [name, draft] of drafts) {
      if (draft && !this.#loaded.materials.some((m) => m.name === name)) materials.push(draft);
    }
    return {
      ...this.#loaded,
      objects: templates.size
        ? this.#loaded.objects.map((d) => templates.get(defKey(d)) ?? d)
        : this.#loaded.objects,
      materials: materials.map((m) => {
        const depth = depths.get(m.name);
        return depth === undefined ? m : { ...m, depth };
      }),
    };
  });

  get catalogue(): Catalogue {
    return this.#catalogue;
  }

  get objects(): ObjectDef[] {
    return this.#catalogue.objects;
  }

  get materials(): MaterialDef[] {
    return this.#catalogue.materials;
  }

  /** what a save has to write: the declarations this session changed, by their name in the sheet */
  get drafts(): MaterialDrafts {
    return session.editor.materials;
  }

  /** the same, for the `@template`s — see `io/templates.ts` */
  get templateDrafts(): TemplateDrafts {
    return session.editor.templates;
  }

  /**
   * The key a def's declaration is filed under: the name the *file* has, which a rename has moved away
   * from. The same trick {@link keyFor} plays for materials, and for the same reason — a save has to
   * patch the block that is there rather than append a second one.
   */
  keyOfTemplate(def: ObjectDef): string {
    for (const [key, draft] of session.editor.templates) if (defKey(draft) === defKey(def)) return key;
    return defKey(def);
  }

  /**
   * A `@template` changed: the whole definition as it should now read.
   *
   * Renaming through this would be half a rename — a template's name is the `.class` every instance of it
   * carries, so the level has to move with the declaration, in the same command. That is
   * `renameTemplate` in `actions.ts`, which does both halves at once.
   */
  editTemplate(def: ObjectDef, name = `edit ${def.name}`): void {
    const key = this.keyOfTemplate(def);
    session.run(name, (e) => ({ ...e, templates: new Map(e.templates).set(key, def) }));
  }

  /**
   * The name a material is declared under, which a rename in this session has moved away from.
   *
   * The panels see a material by the name it now has; a draft is filed under the name the *file* has, so
   * that the save patches the declaration that is there rather than appending a second one.
   */
  keyFor(name: string): string {
    for (const [key, draft] of session.editor.materials) if (draft?.name === name) return key;
    return name;
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

  /**
   * A declaration changed: `was` is the name it has in the sheet, `def` is how it should now read.
   *
   * Renaming through this is renaming the declaration only. Faces that name the old material are the
   * caller's business, because they have to change in the *same* command — see the material browser,
   * which does both in one, so that one ⌘Z is one rename.
   */
  edit(was: string, def: MaterialDef, name = `edit ${def.name}`): void {
    session.run(name, (e) => ({ ...e, materials: drafted(e.materials, was, def) }));
  }

  /** a material this project did not have; returns it, named so as not to collide with anything */
  add(): MaterialDef {
    const def = newMaterial(freeName(this.materials.map((m) => m.name)));
    session.run("new material", (e) => ({
      ...e,
      materials: drafted(e.materials, def.name, def),
      material: def.name,
      note: `${def.name} — a new material`,
    }));
    return def;
  }

  /** a declaration deleted. One that was never in a file just goes away; the rest are deleted on save */
  remove(name: string, note: string): void {
    const declared = this.#loaded.materials.some((m) => m.name === name);
    session.run(`delete ${name}`, (e) => {
      const next = new Map(e.materials);
      if (declared) next.set(name, null);
      else next.delete(name);
      return { ...e, materials: next, note };
    });
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

const drafted = (drafts: MaterialDrafts, was: string, def: MaterialDef): MaterialDrafts =>
  new Map(drafts).set(was, def);
