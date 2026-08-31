/**
 * The settings that are the designer's rather than the map's.
 *
 * The line between this and `@broom` is worth stating: the grid size is in the document because two people
 * opening the same level should be building on the same grid, and the field of view is here because it is a
 * property of the eyes looking at it. Nothing in here is undoable, nothing in here is written to a sheet,
 * and nothing in here changes what a save produces.
 *
 * Stored as one object rather than a key each, so a preference added later arrives at its default for
 * everybody instead of arriving as `null` for everybody who has ever opened the editor before.
 */

const KEY = "three-broom:prefs";

/** every preference, with the value it has until somebody changes it */
export const DEFAULTS = {
  /** vertical field of view of the 3d pane, in degrees */
  fov: 60,
  /** how fast wasd flies, as a multiple of the pane's own sense of scale */
  flySpeed: 1,
  /** the dimension overlay that follows the selection */
  measure: true,
  /** the axis dial in the corner of every pane */
  compass: true,
  /** the grid plane under the map in the 3d pane */
  gridPlane: true,
  /** seconds between autosaves to local storage; zero is off */
  autosave: 20,
};

export type Prefs = typeof DEFAULTS;

/** what a preference is, for the panel that draws it: a range with a step, or a switch */
export type Setting =
  | { key: keyof Prefs; title: string; group: string; kind: "range"; min: number; max: number; step: number; unit?: string }
  | { key: keyof Prefs; title: string; group: string; kind: "switch" };

export const SETTINGS: readonly Setting[] = [
  { key: "fov", title: "field of view", group: "viewport", kind: "range", min: 40, max: 100, step: 5, unit: "°" },
  { key: "flySpeed", title: "fly speed", group: "viewport", kind: "range", min: 0.25, max: 4, step: 0.25, unit: "×" },
  { key: "compass", title: "axis dial", group: "viewport", kind: "switch" },
  { key: "gridPlane", title: "grid plane", group: "viewport", kind: "switch" },
  { key: "measure", title: "dimensions on the selection", group: "overlays", kind: "switch" },
  { key: "autosave", title: "autosave every", group: "files", kind: "range", min: 0, max: 300, step: 10, unit: "s" },
];

/** the stored object, with anything missing or of the wrong shape taken from the defaults */
function load(): Prefs {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const stored = JSON.parse(raw) as Partial<Prefs>;
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof Prefs)[]) {
      const value = stored[key];
      if (typeof value === typeof DEFAULTS[key]) (out[key] as unknown) = value;
    }
    return out;
  } catch {
    // a browser with storage denied is still a browser that can edit a level
    return { ...DEFAULTS };
  }
}

class Preferences {
  #values = $state.raw<Prefs>(load());

  get fov(): number {
    return this.#values.fov;
  }
  get flySpeed(): number {
    return this.#values.flySpeed;
  }
  get measure(): boolean {
    return this.#values.measure;
  }
  get compass(): boolean {
    return this.#values.compass;
  }
  get gridPlane(): boolean {
    return this.#values.gridPlane;
  }
  /** milliseconds, or nothing at all when it is switched off */
  get autosaveEvery(): number {
    return this.#values.autosave * 1000;
  }

  get all(): Prefs {
    return this.#values;
  }

  get changed(): boolean {
    return (Object.keys(DEFAULTS) as (keyof Prefs)[]).some((k) => this.#values[k] !== DEFAULTS[k]);
  }

  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
    if (this.#values[key] === value) return;
    this.#values = { ...this.#values, [key]: value };
    this.#store();
  }

  reset(): void {
    this.#values = { ...DEFAULTS };
    this.#store();
  }

  #store(): void {
    try {
      if (this.changed) localStorage.setItem(KEY, JSON.stringify(this.#values));
      else localStorage.removeItem(KEY);
    } catch {
      // nothing to do and nothing worth saying: the setting still changed
    }
  }
}

export const prefs = new Preferences();
