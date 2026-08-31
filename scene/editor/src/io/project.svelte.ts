/**
 * The open file, and the four things a designer expects to be able to do to it: new, open, save, save as.
 *
 * The round trip is already written — `read.ts` turns sheets into a world and `write.ts` turns a world
 * back into the exact bytes of the sheets it came from. What was missing is the part that knows *where*
 * the bytes live. That is all this is: file handles, a dirty flag, and an autosave.
 *
 * Three decisions worth stating.
 *
 * **A project is a set of sheets, not a file.** A map that `@import`s is still one document, and saving it
 * has to write every file that changed and leave the rest byte-identical. So `open` takes as many files as
 * the designer selects and `save` walks all of them; the "root" is the one nobody imports.
 *
 * **Save writes only what changed.** `writeWorld` already answers with the text every file *should* have,
 * unchanged ones included, so the filter here is a string comparison against what was read. A file the
 * designer never touched is never opened for writing, which means its modification time does not move and
 * a watcher watching it does not fire.
 *
 * **Autosave is text, not state.** What goes into storage is the same bytes a save would have written,
 * plus the handles' names. Recovering therefore means opening the recovered text, which is a path already
 * covered by a hundred round-trip checks — rather than reviving a serialised world through a second,
 * parallel, untested encoding of the document model.
 */
import { parse, type Sheet } from "tscene";
import { catalogueOfSheets } from "../doc/catalogue.ts";
import { DEMO_SHEET } from "../doc/demo.ts";
import type { World } from "../doc/document.ts";
import { newEditor } from "../doc/editor.ts";
import { library } from "../library.svelte.ts";
import { session } from "../session.svelte.ts";
import { log } from "../ui/log.svelte.ts";
import { prefs } from "../ui/prefs.svelte.ts";
import { readForExport, toGlb, toObj } from "./export.ts";
import { readWorld, type Sheets } from "./read.ts";
import { nameOf, rootOf } from "./root.ts";
import { writeWorld, type Project } from "./write.ts";
import type { MaterialDrafts } from "./materials.ts";

/**
 * The file system access API, which the DOM types this workspace builds against do not carry.
 *
 * Declared narrowly rather than pulled in as a dependency: three functions and the option bags they take
 * is the whole of the surface used here, and every one of them is checked for at the call site anyway,
 * because a browser without them is a browser this still has to open a file in.
 */
type PickerTypes = { description?: string; accept: Record<string, string[]> }[];

declare global {
  interface Window {
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      types?: PickerTypes;
    }) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: PickerTypes;
    }) => Promise<FileSystemFileHandle>;
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }
}

/**
 * What one file of the open project is, and what it takes to write it back.
 *
 * The two strings are not the same string and the difference is the whole reason a save can be run twice.
 * Every node in the tree remembers the byte range it was parsed from, so a save's edits are offsets into
 * the text those origins were taken from — `text`, which therefore never moves for as long as the document
 * is open. `onDisk` is what was last written there, and it is only ever compared, never patched.
 *
 * Updating `text` after a save instead would leave a tree full of ranges pointing into bytes that are no
 * longer at those offsets, and the second save would cut the file to pieces.
 */
type Held = {
  /** the bytes the world's origins were parsed from: the baseline every save diffs against */
  text: string;
  /** what is on disk now, when a save has moved it on from `text` */
  onDisk?: string;
  /** absent when the file arrived through an `<input>`, which gives bytes and no way back to them */
  handle?: FileSystemFileHandle;
};

/** what is on disk for a file, which is what it was read from until something writes it */
const onDisk = (held: Held): string => held.onDisk ?? held.text;

const AUTOSAVE_KEY = "three-broom:autosave";

export type Recovery = { name: string; at: number; files: Record<string, string> };

class ProjectStore {
  /** the sheets as they were read, which is the only thing a surgical save may diff against */
  #held = new Map<string, Held>();
  #root = $state("untitled.tscene");
  /**
   * The world the file on disk holds; anything else means unsaved changes.
   *
   * `raw` because the comparison against it is by identity — a proxy of a world is not that world, and a
   * document that is dirty the moment it is opened is a marker nobody reads twice.
   */
  #saved = $state.raw<World | undefined>(undefined);
  /** the declarations as the file has them: `library`'s drafts as they stood at the last save */
  #savedDrafts = $state.raw<MaterialDrafts>(new Map());
  #problems = $state.raw<string[]>([]);
  #diagnostics = $state.raw<string[]>([]);
  /** how many times this session has written to disk; the first one makes any recovery offer stale */
  #saves = $state(0);
  #timer: ReturnType<typeof setInterval> | undefined;
  /** whether the autosave is already following the preference, so booting twice is not two timers */
  #watching = false;

  /**
   * The name in the title bar.
   *
   * The handle's name rather than the key, because a save-as gives a file a new home without giving the
   * tree new origins — the key stays what the origins say and only the destination moves.
   */
  get name(): string {
    const held = this.#held.get(this.#root);
    return nameOf(held?.handle?.name ?? this.#root);
  }

  /** every file of the project, root first — what the file line shows when a map spans several sheets */
  get files(): string[] {
    const shown = (key: string) => this.#held.get(key)?.handle?.name ?? key;
    return [shown(this.#root), ...[...this.#held.keys()].filter((f) => f !== this.#root).map(shown)];
  }

  get dirty(): boolean {
    // materials are not part of the world and so are not part of the world comparison; an edited
    // declaration is unsaved work like any other and has to light the save button
    return session.editor.world !== this.#saved || library.drafts !== this.#savedDrafts;
  }

  /** whether this browser can write back to the file it opened, or can only offer a download */
  get writable(): boolean {
    return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
  }

  /** what the last save could not express, and what the last open could not understand */
  get problems(): string[] {
    return this.#problems;
  }

  get diagnostics(): string[] {
    return this.#diagnostics;
  }

  get saves(): number {
    return this.#saves;
  }

  // ---------------------------------------------------------------- new

  /**
   * The document the app starts with: the demo map, which is not a file and never was.
   *
   * It is taken as the baseline rather than left dirty, because otherwise the first autosave fills local
   * storage with a map the designer did not write and offers it back to them on the next load. The moment
   * they change anything it is unsaved work like any other, and ⌘S asks where to put it.
   */
  boot(): void {
    // the demo's own definitions are held as the root sheet's text, not just as a catalogue in memory. The
    // world's five materials and five templates were parsed out of `DEMO_SHEET`, and a document whose
    // baseline does not contain them writes brushes that say `var(--floor)` with nothing behind it — which
    // is a broken save, a broken export and a bake that refuses to load. Holding the sheet is what makes
    // the demo a document rather than a picture of one.
    this.#held.set(this.#root, { text: DEMO_SHEET });
    this.#saved = session.editor.world;
    this.#savedDrafts = library.drafts;
    this.startAutosave();
    log.say(`three-broom · ${this.name}, which is not a file yet`);
  }

  /**
   * An empty map, with the demo's own definitions dropped: a new file declares its own.
   *
   * Opened rather than invented. A new document *is* an empty sheet, and going through the same path an
   * opened one goes through is what gives its layer the file's own origin — so the first save writes the
   * brushes at the top level of the sheet, the way a hand-written one is, instead of wrapping the whole
   * map in a `group #Default` nobody asked for.
   */
  newMap(): void {
    this.adopt(new Map([["untitled.tscene", { text: "" }]]));
  }

  // ---------------------------------------------------------------- open

  /**
   * Open one or more sheets.
   *
   * Several at once because an `@import`ed file is part of the same document, and a browser hands out no
   * way to reach a file's siblings from the file itself — selecting them together is the one path that
   * does not require handing over a whole directory.
   */
  async open(): Promise<void> {
    if (typeof window.showOpenFilePicker !== "function") return this.openViaInput();
    const handles = await window
      .showOpenFilePicker({
        multiple: true,
        types: [{ description: "tscene", accept: { "text/plain": [".tscene"] } }],
      })
      .catch(() => undefined);
    if (!handles?.length) return;

    const held = new Map<string, Held>();
    for (const handle of handles) {
      held.set(handle.name, { text: await (await handle.getFile()).text(), handle });
    }
    this.adopt(held);
  }

  /**
   * Open a whole directory, which is what a map with imports in subfolders needs.
   *
   * Bounded: only `.tscene` is read, and only four levels down, because a designer who aims this at their
   * home folder should get a map rather than a stall.
   */
  async openFolder(): Promise<void> {
    const pick = window.showDirectoryPicker;
    if (typeof pick !== "function") return this.openViaInput();
    const dir = await pick({ mode: "readwrite" }).catch(() => undefined);
    if (!dir) return;

    const held = new Map<string, Held>();
    await collect(dir, "", held, 4);
    if (!held.size) {
      this.#diagnostics = ["no .tscene files in that folder"];
      return;
    }
    this.adopt(held);
  }

  /** the fallback for a browser with no file system access: bytes in, downloads out */
  private openViaInput(): Promise<void> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ".tscene";
      input.onchange = async () => {
        const files = [...(input.files ?? [])];
        if (!files.length) return resolve();
        const held = new Map<string, Held>();
        for (const file of files) held.set(file.name, { text: await file.text() });
        this.adopt(held);
        resolve();
      };
      input.oncancel = () => resolve();
      input.click();
    });
  }

  /** the sheets are in hand; parse them, pick the root, and hand the world to the session */
  private adopt(held: Map<string, Held>): void {
    const sheets: Sheets = new Map();
    for (const [file, { text }] of held) sheets.set(file, parse(text, file));

    const root = rootOf(sheets);
    const { world, diagnostics } = readWorld(root, sheets);

    this.#held = held;
    this.#root = root;
    this.#problems = [];
    this.#diagnostics = diagnostics.map((d) => `${d.file ?? root}: ${d.message}`);
    session.load(newEditor(world));
    this.#saved = world;
    library.load(catalogueOfSheets(sheets.values()));
    this.#savedDrafts = library.drafts;

    log.say(`opened ${root}${held.size > 1 ? ` and ${held.size - 1} more` : ""}`);
    log.all("warn", this.#diagnostics);
  }

  // ---------------------------------------------------------------- save

  /**
   * Write the changed files back where they came from.
   *
   * A project with no handles — opened through an `<input>`, or never opened at all — has nowhere to write
   * to, so it becomes a save-as. That is a redirection rather than a failure: the designer asked for their
   * work to be on disk and it will be, one dialogue later.
   */
  async save(): Promise<boolean> {
    const out = this.written();
    if (!out) return false;

    const missing = [...out.files.keys()].some((f) => !this.#held.get(f)?.handle);
    if (missing) return this.saveAs();

    for (const [file, text] of out.files) {
      const held = this.#held.get(file);
      if (!held || onDisk(held) === text) continue;
      await writeTo(held.handle!, text);
      held.onDisk = text;
    }
    this.settle();
    return true;
  }

  /**
   * Write the root somewhere new.
   *
   * Only the root: the imported sheets keep their own homes, because "save a copy of this map" and "fork
   * every file this map has ever imported" are different requests and the second one is not this one. A
   * project that has imports says so rather than leaving the designer to find out on their next save.
   *
   * The sheet is re-homed, not re-keyed. Every origin in the tree names the file it was parsed from, so
   * moving the key would orphan all of them at once and the next save would append the whole map to the
   * end of itself. The new name is a destination; the key stays what the tree already believes.
   */
  async saveAs(): Promise<boolean> {
    const out = this.written();
    if (!out) return false;
    const text = out.files.get(this.#root) ?? "";
    const root = this.#held.get(this.#root);

    if (typeof window.showSaveFilePicker !== "function") {
      download(this.name, text);
      if (root) root.onDisk = text;
      this.settle();
      return true;
    }

    const handle = await window
      .showSaveFilePicker({
        suggestedName: this.name,
        types: [{ description: "tscene", accept: { "text/plain": [".tscene"] } }],
      })
      .catch(() => undefined);
    if (!handle) return false;

    await writeTo(handle, text);
    if (root) {
      root.handle = handle;
      root.onDisk = text;
    }

    // and the imports, which were not re-homed and are now relative to somewhere else
    for (const [file, h] of this.#held) {
      if (file === this.#root || !h.handle) continue;
      const now = out.files.get(file);
      if (now === undefined || onDisk(h) === now) continue;
      await writeTo(h.handle, now);
      h.onDisk = now;
    }
    this.settle();
    return true;
  }

  /** the files as they are on disk, with everything since thrown away */
  revert(): void {
    if (!this.#held.size) return;
    const held = new Map<string, Held>();
    for (const [file, h] of this.#held) held.set(file, { text: onDisk(h), handle: h.handle });
    this.adopt(held);
  }

  /**
   * The project as text, as it stands.
   *
   * What a save would write rather than what the last one did, because a designer who moves a wall and
   * presses bake means the wall where it is now. It is the same text either way for a clean document,
   * and for a dirty one this is the only reading that is not a lie.
   */
  snapshot(): { root: string; files: Record<string, string> } | undefined {
    const out = this.written();
    return out && { root: this.#root, files: Object.fromEntries(out.files) };
  }

  /** the text every file should now have, or nothing when the world cannot be written at all */
  private written(): { files: Map<string, string> } | undefined {
    const sheets: Sheets = new Map();
    for (const [file, { text }] of this.#held) sheets.set(file, parse(text, file));
    if (!sheets.size) {
      sheets.set(this.#root, parse("", this.#root));
      this.#held.set(this.#root, { text: "" });
    }
    const project: Project = { root: this.#root, sheets };
    const out = writeWorld(session.editor.world, project, library.drafts);
    this.#problems = out.problems;
    return out;
  }

  private settle(): void {
    this.#saved = session.editor.world;
    this.#savedDrafts = library.drafts;
    this.#saves++;
    localStorage.removeItem(AUTOSAVE_KEY);
    log.say(`saved ${this.name}`);
    log.all("warn", this.#problems);
  }

  // ---------------------------------------------------------------- autosave

  /**
   * A copy of the unsaved work, every so often, in local storage.
   *
   * Not a substitute for saving and not offered as one — it is what is there after a tab crash, a GPU
   * reset, or a closed laptop. It is dropped the moment a real save succeeds, so a recovery offer always
   * means there is genuinely something the file does not have.
   *
   * How often is a preference, and it can be none at all; the timer is rebuilt rather than tuned, because
   * a `setInterval` has no way to be told its period has changed.
   */
  startAutosave(): void {
    if (this.#watching) return;
    this.#watching = true;
    $effect.root(() => {
      $effect(() => {
        const every = prefs.autosaveEvery;
        if (this.#timer !== undefined) clearInterval(this.#timer);
        this.#timer = every > 0 ? setInterval(() => this.autosave(), every) : undefined;
      });
    });
  }

  autosave(): void {
    if (!this.dirty) return;
    const out = this.written();
    if (!out) return;
    const snapshot: Recovery = {
      name: this.#root,
      at: Date.now(),
      files: Object.fromEntries(out.files),
    };
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(snapshot));
    } catch {
      // a map too big for the quota is not a reason to interrupt the person drawing it
    }
  }

  /** what a crash left behind, if anything */
  recovery(): Recovery | undefined {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return undefined;
      const value = JSON.parse(raw) as Recovery;
      return value?.files && value.name ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Open the recovered text.
   *
   * The handles are gone — a page reload cannot keep them — so this comes back as an unsaved document with
   * the recovered name, and the first ⌘S asks where it should live.
   */
  recover(snapshot: Recovery): void {
    const held = new Map<string, Held>();
    for (const [file, text] of Object.entries(snapshot.files)) held.set(file, { text });
    this.adopt(held);
    this.#root = snapshot.name in snapshot.files ? snapshot.name : this.#root;
    // the recovered text is what was *not* saved, so the document is dirty the moment it is back
    this.#saved = undefined;
    this.discardRecovery();
  }

  discardRecovery(): void {
    localStorage.removeItem(AUTOSAVE_KEY);
  }

  // ---------------------------------------------------------------- export

  /**
   * The map as a mesh, for something that is not this editor.
   *
   * Downloaded rather than written through a handle, and it never becomes the open file: an export is a
   * copy going out, and a designer who exported once should not find their next ⌘S aimed at a `.glb`. The
   * name is borrowed from the sheet so the two sit next to each other in a folder and read as the same map.
   *
   * Whatever the brushes could not answer — a solid with no volume, say — lands in `problems`, which is the
   * same place a save's complaints go and therefore already on screen.
   */
  exportObj(): void {
    const exported = readForExport(session.editor.world);
    const stem = base(this.name);
    const { obj, mtl } = toObj(exported, library.catalogue, `${stem}.mtl`);
    this.#problems = exported.problems;
    download(`${stem}.obj`, obj);
    download(`${stem}.mtl`, mtl);
    this.#exported(`${stem}.obj`, exported);
  }

  exportGlb(): void {
    const exported = readForExport(session.editor.world);
    const stem = base(this.name);
    this.#problems = exported.problems;
    download(`${stem}.glb`, toGlb(exported, library.catalogue), "model/gltf-binary");
    this.#exported(`${stem}.glb`, exported);
  }

  #exported(name: string, exported: { surfaces: { positions: Float32Array }[]; problems: string[] }): void {
    const triangles = exported.surfaces.reduce((n, s) => n + s.positions.length / 9, 0);
    log.say(`exported ${name}: ${triangles} triangles in ${exported.surfaces.length} material(s)`);
    log.all("warn", exported.problems);
  }
}

// ---------------------------------------------------------------- helpers

/** every `.tscene` under a directory, keyed by its path relative to the one that was picked */
async function collect(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  into: Map<string, Held>,
  depth: number,
): Promise<void> {
  if (depth < 0) return;
  for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      if (name.startsWith(".") || name === "node_modules") continue;
      await collect(handle as FileSystemDirectoryHandle, path, into, depth - 1);
    } else if (name.endsWith(".tscene")) {
      const file = handle as FileSystemFileHandle;
      into.set(path, { text: await (await file.getFile()).text(), handle: file });
    }
  }
}

async function writeTo(handle: FileSystemFileHandle, text: string): Promise<void> {
  const stream = await handle.createWritable();
  await stream.write(text);
  await stream.close();
}

/** a file name with its extension taken off, so an export can put its own on */
const base = (name: string): string => name.replace(/\.[^./\\]*$/, "") || name;

/** the last resort, for a browser that will not hand out a file handle — and the only way an export goes */
export function download(name: string, body: BlobPart, type = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // revoked on the next turn, because a click that has not been dispatched yet cannot read a dead url
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const project = new ProjectStore();

/** what a `Sheet` is here, re-exported so a panel can name the type without reaching into tscene */
export type { Sheet };
