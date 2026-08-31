/**
 * Baking, from the editor's side.
 *
 * One store because a bake is one thing at a time and everything about it is shared: the panel draws the
 * progress, the console logs the warnings, the viewport shows the result. Two of these would be two
 * answers to "is a bake running", and the second one would be wrong.
 *
 * The interesting decision is that progress is not a promise. A bake takes minutes and reports through
 * eight stages; what the panel needs is the *current* stage and the *current* fraction, which is state,
 * not a value that arrives at the end. So `run()` returns nothing worth having and everything is read off
 * the store — which is also what lets the panel be closed and reopened mid-bake without losing anything.
 */
import { log } from "../ui/log.svelte.ts";
import { project } from "../io/project.svelte.ts";
import { inlineAll } from "./samples.ts";
import { buildPreview, disposePreview, type Preview } from "./preview.ts";
import {
  BAKE_ROUTE, DEFAULT_SETTINGS, clock, progressOf, readEvents,
  type Event, type Ready, type Settings, type Stage,
} from "./protocol.ts";

const KEY = "three-broom:bake";

/** what a finished bake left behind, which is what the preview is built from */
export type Baked = {
  manifest: string;
  files: string[];
  width: number;
  height: number;
  utilization: number;
  ms: number;
  /** the sheets that were baked, kept so the preview loads exactly what the atlas was made for */
  sheets: Record<string, string>;
  root: string;
};

/** the stored settings, with anything missing or of the wrong shape taken from the defaults */
function load(): Settings {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const stored = JSON.parse(raw) as Partial<Settings>;
    const out = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const value = stored[key];
      if (typeof value === typeof DEFAULT_SETTINGS[key]) (out[key] as unknown) = value;
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

class Bakery {
  // the panel's own open flag lives here rather than in the component, because a key press and a menu item
  // both open it and neither of them is inside `Bake.svelte`
  #open = $state(false);
  #settings = $state.raw<Settings>(load());
  #ready = $state.raw<Ready | undefined>(undefined);
  #asking = false;
  #running = $state(false);
  #at = $state.raw<{ stage: Stage; done: number } | undefined>(undefined);
  #began = 0;
  #elapsed = $state(0);
  #ticker: ReturnType<typeof setInterval> | undefined;
  #baked = $state.raw<Baked | undefined>(undefined);
  #failed = $state("");
  #preview = $state.raw<Preview | undefined>(undefined);
  #showing = $state(false);
  #busy = $state(false);

  /** whether the panel is up */
  get open(): boolean {
    return this.#open;
  }

  set open(value: boolean) {
    this.#open = value;
  }

  togglePanel(): void {
    this.#open = !this.#open;
  }

  get settings(): Settings {
    return this.#settings;
  }

  /** whether the machine behind the dev server can bake — `undefined` until it has been asked */
  get ready(): Ready | undefined {
    return this.#ready;
  }

  get running(): boolean {
    return this.#running;
  }

  get stage(): Stage | undefined {
    return this.#at?.stage;
  }

  /** the whole bake as one fraction, weighted by stage so the bar does not restart eight times */
  get progress(): number {
    return this.#at ? progressOf(this.#at.stage, this.#at.done) : 0;
  }

  /** how long the bake in flight has been going, as `4m03s` */
  get elapsed(): string {
    return clock(this.#elapsed);
  }

  get baked(): Baked | undefined {
    return this.#baked;
  }

  get failed(): string {
    return this.#failed;
  }

  /** the lit scene, when it is built and switched on — what the viewport draws instead of the map */
  get preview(): Preview | undefined {
    return this.#showing ? this.#preview : undefined;
  }

  get showing(): boolean {
    return this.#showing;
  }

  /** the preview is being built or taken down, which is the window in which the button must not work */
  get busy(): boolean {
    return this.#busy;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.#settings[key] === value) return;
    this.#settings = { ...this.#settings, [key]: value };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.#settings));
    } catch {
      // a browser with storage denied still bakes; it just forgets the samples count next time
    }
  }

  reset(): void {
    this.#settings = { ...DEFAULT_SETTINGS };
    try {
      localStorage.removeItem(KEY);
    } catch {
      // as above
    }
  }

  /**
   * Whether this machine can bake, asked once and remembered.
   *
   * Once, because the answer holds a GPU adapter open on the other side and it cannot change while the
   * dev server is up. A refusal is not an error either — a checkout without the optional native modules
   * is a perfectly good editor that cannot bake — so it is said in the panel and nowhere else.
   */
  async probe(): Promise<Ready> {
    if (this.#ready) return this.#ready;
    if (this.#asking) return { ok: false, why: "asking…" };
    this.#asking = true;
    try {
      const res = await fetch(`${BAKE_ROUTE}/ready`);
      this.#ready = res.ok
        ? ((await res.json()) as Ready)
        : { ok: false, why: `the dev server said ${res.status}` };
    } catch (e) {
      // the built editor is static files with no server behind it, and that is the usual way to get here
      this.#ready = { ok: false, why: `no baker behind this page: ${message(e)}` };
    } finally {
      this.#asking = false;
    }
    return this.#ready;
  }

  /**
   * Bake the map as it stands.
   *
   * The document goes over as text — see `server.ts` for why — with the editor's generated textures
   * inlined first, because `broom:brick/map` is a url only this program has ever understood.
   */
  async run(): Promise<void> {
    if (this.#running) return;
    const snapshot = project.snapshot();
    if (!snapshot) {
      this.#failed = "there is nothing to bake";
      return;
    }

    this.#running = true;
    this.#failed = "";
    this.#at = { stage: "load", done: 0 };
    this.#began = Date.now();
    this.#elapsed = 0;
    this.#ticker = setInterval(() => (this.#elapsed = Date.now() - this.#began), 500);
    log.say(`baking ${snapshot.root} at ${this.#settings.size}² · ${this.#settings.samples} samples`);

    try {
      const files = await inlineAll(snapshot.files);
      const res = await fetch(`${BAKE_ROUTE}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files, root: snapshot.root, settings: this.#settings }),
      });
      if (!res.body) throw new Error(`the dev server said ${res.status} with nothing in it`);
      for await (const event of readEvents(res.body)) this.#took(event, snapshot.root, files);
    } catch (e) {
      this.#failed = message(e);
      log.bad(`bake failed: ${this.#failed}`);
    } finally {
      clearInterval(this.#ticker);
      this.#running = false;
      this.#at = undefined;
    }
  }

  /** stop at the next dispatch. Nothing is written, and the last bake's atlas is still where it was */
  async stop(): Promise<void> {
    if (!this.#running) return;
    await fetch(`${BAKE_ROUTE}/stop`, { method: "POST" }).catch(() => undefined);
  }

  #took(event: Event, root: string, files: Record<string, string>): void {
    if (event.kind === "stage") {
      this.#at = { stage: event.stage, done: event.done };
    } else if (event.kind === "warn") {
      log.warn(`bake: ${event.text}`);
    } else if (event.kind === "failed") {
      this.#failed = event.text;
      log.bad(`bake failed: ${event.text}`);
    } else {
      const { manifest, files: written, width, height, utilization, ms } = event;
      this.#baked = { manifest, files: written, width, height, utilization, ms, sheets: files, root };
      log.say(
        `baked ${event.width}×${event.height} in ${clock(event.ms)} · ` +
          `${Math.round(event.utilization * 100)}% of the atlas used · ${event.files.join(", ")}`,
      );
      // a preview of the previous bake is a picture of the thing that was just replaced
      void this.#drop();
    }
  }

  // ---------------------------------------------------------------- the preview

  /**
   * Show the bake on the map, or take it off again.
   *
   * Built on demand rather than kept: the preview is a whole second copy of the level, and one that would
   * go stale the moment a wall moved. Switching it off disposes it, so switching it back on reloads — a
   * second of work in exchange for never showing a picture of a level that is no longer the level.
   */
  async toggle(): Promise<void> {
    if (this.#busy) return;
    if (this.#showing) {
      this.#showing = false;
      await this.#drop();
      return;
    }
    const baked = this.#baked;
    if (!baked) {
      this.#failed = "nothing has been baked yet";
      return;
    }
    this.#busy = true;
    try {
      this.#preview = await buildPreview(baked.sheets, baked.root, baked.manifest);
      this.#showing = true;
      log.say(`preview: the atlas reached ${this.#preview.meshes} mesh(es)`);
    } catch (e) {
      this.#failed = message(e);
      log.bad(`preview failed: ${this.#failed}`);
    } finally {
      this.#busy = false;
    }
  }

  /** the gain on the atlas, for an 8-bit bake of a scene whose bright end sits above what matters */
  get intensity(): number {
    return this.#preview?.lightmap.intensity ?? 1;
  }

  set intensity(value: number) {
    if (this.#preview) this.#preview.lightmap.intensity = value;
  }

  async #drop(): Promise<void> {
    const preview = this.#preview;
    if (!preview) return;
    this.#preview = undefined;
    this.#showing = false;
    disposePreview(preview);
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const bakery = new Bakery();
