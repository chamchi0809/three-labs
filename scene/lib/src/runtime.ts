// Runtime loader: .tscene source -> live three objects. Browser-safe.
//
// Nothing here reaches into three by name at runtime: the four values below are the only ones this
// module imports, and every class a sheet mentions arrives through a registry the vite plugin built
// at compile time. That is what lets a bundler tree-shake three down to what the scene actually uses.
import { AnimationClip, AnimationMixer, Group, TextureLoader } from "three/webgpu";
import type { LoadingManager, Object3D } from "three/webgpu";
import { expand, lineCol, parse, SceneSyntaxError, type Diagnostic, type Loader, type Member, type ObjectValue, type Pos, type Value } from "./parse.ts";
import { className } from "./names.ts";

/** What the vite plugin's `import scene from "./main.tscene"` gives you: one sheet, one module. */
export type SceneModule = {
  source: string;
  file: string;
  /** @import path → the imported sheet's file, looked up in the sheet registry */
  imports?: Record<string, string>;
  /** `texture("./t.png")` → the url the bundler resolved it to */
  assets?: Record<string, string>;
  /** the three exports this sheet names, imported by the plugin so the bundler sees them one by one */
  registry?: Record<string, unknown>;
};

/** every .tscene module registers itself here, so a hot-replaced sheet is picked up by whoever imported it */
const sheets = new Map<string, SceneModule>();

/** @internal — called at the top of every module the vite plugin emits. */
export function __sceneRegister(mod: SceneModule): SceneModule {
  sheets.set(mod.file, mod);
  return mod;
}

/** the module object you imported goes stale on reload; the registry always has the current one */
const latest = (mod: SceneModule) => sheets.get(mod.file) ?? mod;

export type LoadOptions = {
  /** base url/path for @import and texture()/gltf() (defaults to the module's file, then the document url) */
  base?: string;
  /**
   * Constructors and constants by name, e.g. `{ water: Water }` — looked up before the sheet's own
   * build-time imports. A sheet loaded from a string has none of those, so it needs the whole set:
   * `import { threeRegistry } from "tscene/three"`.
   */
  registry?: Record<string, any>;
  /** resolves @import paths; defaults to the module's own imports, or fetch */
  load?: Loader;
  /** shared LoadingManager — its onProgress/onLoad see every texture() and gltf() */
  manager?: LoadingManager;
  /** path to three's draco decoder, for gltf() files that use it */
  draco?: string;
  /** transcoder path + the renderer whose support is probed, for gltf() files with ktx2 textures */
  ktx2?: { path: string; renderer: unknown };
};

const documentBase = () => (typeof document !== "undefined" ? document.baseURI : "file:///");

function resolveUrl(url: string, base: string | undefined): string {
  if (/^(\w+:|\/|data:)/.test(url)) return url;
  // `base` may be a plain fs path (a bundled sheet's file) — that is not a usable URL base
  try {
    return new URL(url, base ?? documentBase()).href;
  } catch {
    return new URL(url, documentBase()).href;
  }
}

const fetchLoader: Loader = async (path, from) => {
  const file = resolveUrl(path, from);
  const res = await fetch(file);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return { text: await res.text(), file };
};

/** @imports served straight out of the bundled module graph — no fetches, and every sheet keeps its own file */
function moduleLoader(root: SceneModule): Loader {
  return async (path, from) => {
    const owner = from === undefined || from === root.file ? root : sheets.get(from);
    const file = owner?.imports?.[path];
    const dep = file === undefined ? undefined : sheets.get(file);
    if (!dep) throw new Error(`${path} is not bundled with ${from ?? root.file}`);
    return { text: dep.source, file: dep.file };
  };
}

type Ctx = {
  opts: LoadOptions;
  /** the entry sheet, for turning offsets in error messages into line:col */
  sheet: { text: string; file?: string };
  /** mixers created by play(), handed to the caller through root.userData */
  mixers: AnimationMixer[];
  /** one AST node = one instance, so a material held in a --var is shared, not rebuilt per user */
  made: WeakMap<ObjectValue, Promise<any>>;
  /** #id → instance, for ref(#id) */
  ids: Map<string, any>;
  /** props whose ref(#id) target is not built yet — replayed once the whole tree exists */
  deferred: (() => Promise<void>)[];
  /** name → constructor/constant: the sheet's build-time three imports, with opts.registry on top */
  registry: Record<string, any>;
  /** after the tree is built an unknown #id is a real error, not a forward reference */
  settled?: boolean;
};

/** Parses `src` and builds the scene graph. Top-level nodes become children of the returned group. */
export async function loadScene(src: string | SceneModule, opts: LoadOptions = {}): Promise<Group> {
  // the imported module object goes stale on every hot reload, so always take the registered one
  const mod = typeof src === "string" ? undefined : latest(src);
  const base = opts.base ?? mod?.file;
  const sheet = parse(mod ? mod.source : (src as string), base);
  const { nodes, diagnostics } = await expand(sheet, opts.load ?? (mod ? moduleLoader(mod) : fetchLoader));
  // warnings (dead vars, duplicate ids, …) are the checker's business; only errors stop the build
  const errors = [...sheet.errors, ...diagnostics].filter((d) => d.severity === "error");
  if (errors.length) throw new SceneSyntaxError(errors.map((d) => `${where(d, sheet)}: ${d.message}`).join("\n"), errors[0]!);

  const ctx: Ctx = {
    opts: { ...opts, base }, sheet: { text: sheet.text, file: sheet.file }, mixers: [],
    made: new WeakMap(), ids: new Map(), deferred: [],
    // the caller's registry wins, so `{ water: Water }` can also shadow a three export
    registry: { ...moduleRegistry(mod), ...opts.registry },
  };
  const root = new Group();
  root.name = "scene";
  for (const m of nodes) {
    // a top-level `@bakery { … }` is the sheet's own settings, so it lands on the root
    if (m.kind === "at") settings(root, m, ctx);
    else if (m.kind === "node") root.add((await construct(m.object, ctx)) as Object3D);
  }
  ctx.settled = true;
  for (const replay of ctx.deferred) await replay();
  if (ctx.mixers.length) root.userData.mixers = ctx.mixers;
  return root;
}

/** `file:line:col` for a diagnostic — an offset alone is useless in a browser console */
function where(pos: Pos, sheet: { text: string; file?: string }): string {
  const text = pos.file === undefined || pos.file === sheet.file ? sheet.text : sheets.get(pos.file)?.source;
  const file = pos.file ?? sheet.file ?? "<scene>";
  if (!text) return file;
  const { line, col } = lineCol(text, pos.start);
  return `${file}:${line}:${col}`;
}

function fail(message: string, pos: Pos, ctx: Ctx): never {
  throw new SceneSyntaxError(`${where(pos, ctx.sheet)}: ${message}`, pos);
}

/** Advances every clip play() started. Call it once per frame with the frame time in seconds. */
export function updateScene(root: Object3D, delta: number): void {
  for (const mixer of (root.userData.mixers ?? []) as AnimationMixer[]) mixer.update(delta);
}

/**
 * Everything the module-level asset cache owns. A `gltf()` node is a `clone()` of the cached scene
 * and shares its geometries, materials and textures with it, so disposing one used to take the cache
 * down with it: the next reload rebuilt from freed buffers.
 * @internal
 */
const cached = new WeakSet<object>();

/**
 * Marks a freshly loaded asset's resources as the cache's, so {@link disposeScene} walks past them.
 * @internal
 */
export function shareAssets(root: Object3D): void {
  root.traverse((o: any) => {
    if (o.geometry) cached.add(o.geometry);
    for (const material of [o.material].flat().filter(Boolean)) {
      cached.add(material as object);
      for (const v of Object.values(material as object)) if ((v as any)?.isTexture) cached.add(v as object);
    }
  });
}

/**
 * Frees the GPU resources of a scene built by loadScene — call it before dropping a root,
 * otherwise every hot reload leaks its geometries, materials and textures. What came out of the
 * asset cache is left alone: it is shared with every other use of the same url.
 */
export function disposeScene(root: Object3D): void {
  root.traverse((o: any) => {
    if (!cached.has(o.geometry)) o.geometry?.dispose?.();
    for (const material of [o.material].flat().filter(Boolean)) {
      if (cached.has(material as object)) continue;
      for (const v of Object.values(material as object)) if ((v as any)?.isTexture && !cached.has(v as object)) (v as any).dispose();
      (material as any).dispose?.();
    }
  });
  root.removeFromParent();
}

// ---------------------------------------------------------------- mount

/** A sheet that is on screen. Handed back by {@link mountScene}. */
export type Mount = {
  /** what is in the parent right now — `undefined` only if the very first build failed */
  readonly root: Group | undefined;
  /**
   * Advances the clips `play()` started. Call it once per frame; without an argument the mount times
   * the frames itself.
   */
  update(delta?: number): void;
  /** Rebuilds from the sheet's current source. A hot update does this for you. */
  reload(): Promise<void>;
  /** Stops listening for hot updates and disposes the current root. */
  dispose(): void;
};

export type MountOptions = LoadOptions & {
  /** rebuild whenever the vite plugin hot-replaces a sheet (default true) */
  hmr?: boolean;
  /** after every successful build, hot updates included — where to grab nodes or apply a lightmap */
  onLoad?: (root: Group) => void;
  /**
   * Where a failed build goes. With this set nothing throws and the previous root stays up, which is
   * what an on-screen error message wants; without it the first build rejects and a failed reload
   * lands on the console.
   */
  onError?: (error: unknown) => void;
};

/**
 * Builds a sheet into `parent` and keeps it there: hot updates rebuild it, the old root is disposed
 * once the new one is up, and `update()` drives the clips.
 *
 * ```ts
 * const mount = await mountScene(scene, sheet, { onError: (e) => (msg.textContent = String(e)) });
 * renderer.setAnimationLoop(() => { mount.update(); renderer.render(scene, camera); });
 * ```
 */
export async function mountScene(parent: Object3D, src: string | SceneModule, opts: MountOptions = {}): Promise<Mount> {
  let current: Group | undefined;
  let last = 0;
  // a hot update during a load — or a slow gltf — would otherwise leave two roots racing to be added
  let pending = Promise.resolve();

  const build = async () => {
    const next = await loadScene(src, opts);
    if (current) disposeScene(current);
    parent.add((current = next));
    opts.onLoad?.(next);
  };
  // `catch` first: one failed build must not poison every rebuild queued behind it
  const run = () => (pending = pending.catch(() => {}).then(build));
  const rebuild = () => run().catch((e: unknown) => (opts.onError ? opts.onError(e) : console.error(e)));

  const stop = opts.hmr === false ? undefined : onSceneChange(() => void rebuild());

  // the first build is the one whose failure the caller can still see, so it only swallows with onError
  if (opts.onError) await rebuild();
  else await run();

  return {
    get root() {
      return current;
    },
    update(delta?: number) {
      const now = performance.now() / 1000;
      const dt = delta ?? (last ? now - last : 0);
      last = now;
      if (current) updateScene(current, dt);
    },
    reload: () => rebuild(),
    dispose() {
      stop?.();
      if (current) disposeScene(current);
      current = undefined;
    },
  };
}

// ---------------------------------------------------------------- hot reload

export type HotListener = (mod: SceneModule) => void;
const listeners = new Set<HotListener>();

/** Called when the vite plugin hot-replaces a `.tscene` file. Returns an unsubscribe. */
export function onSceneChange(fn: HotListener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** @internal — the hot-reload shim the vite plugin appends to every .tscene module calls this. */
export function __sceneChanged(mod: SceneModule): void {
  for (const fn of listeners) fn(mod);
}

/** Convenience: fetch a .tscene file and build it. */
export async function loadSceneFromURL(url: string, opts: LoadOptions = {}): Promise<Group> {
  const file = resolveUrl(url, opts.base);
  const res = await fetch(file);
  if (!res.ok) throw new Error(`cannot load ${file}: ${res.status}`);
  return loadScene(await res.text(), { ...opts, base: file });
}

/**
 * Every three export a sheet and its @imports name, collected from the modules the vite plugin emitted.
 * Merging the whole closure matters because a @template defined in one sheet is instantiated in another.
 */
function moduleRegistry(root: SceneModule | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  const seen = new Set<string>();
  const walk = (mod: SceneModule | undefined) => {
    if (!mod || seen.has(mod.file)) return;
    seen.add(mod.file);
    Object.assign(out, mod.registry);
    for (const file of Object.values(mod.imports ?? {})) walk(sheets.get(file));
  };
  walk(root);
  return out;
}

/** `meshStandardMaterial` and `MeshStandardMaterial` are the same entry; so are `vec3` and `Vector3`. */
const lookup = (name: string, ctx: Ctx) => ctx.registry[name] ?? ctx.registry[className(name)];

// a sheet parsed from a string was never seen by the plugin, so nothing imported three on its behalf
const HINT = ' — a sheet loaded from a string has no build-time registry: import { threeRegistry } from "tscene/three" and pass it as `registry`';

// module-level: a reloaded scene reuses the bytes it already downloaded
// ponytail: keyed by url only — two loadScene calls with different draco/ktx2 options share the first result
const assets = new Map<string, Promise<any>>();
/** gltf() root → the clips that came with it, for play() */
const clipsOf = new WeakMap<object, AnimationClip[]>();
/** clip owner → its mixer, so several play() calls on one gltf share one mixer */
const mixerOf = new WeakMap<object, AnimationMixer>();
function asset<T>(url: string, load: () => Promise<T>): Promise<T> {
  let pending = assets.get(url) as Promise<T> | undefined;
  if (!pending) assets.set(url, (pending = load()));
  return pending;
}

/** GLTFLoader plus whatever compressed-format decoders the caller configured */
async function gltfLoader(ctx: Ctx) {
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const loader = new GLTFLoader(ctx.opts.manager);
  if (ctx.opts.draco) {
    const { DRACOLoader } = await import("three/addons/loaders/DRACOLoader.js");
    loader.setDRACOLoader(new DRACOLoader(ctx.opts.manager).setDecoderPath(ctx.opts.draco));
  }
  if (ctx.opts.ktx2) {
    const { KTX2Loader } = await import("three/addons/loaders/KTX2Loader.js");
    const ktx2 = new KTX2Loader(ctx.opts.manager).setTranscoderPath(ctx.opts.ktx2.path);
    loader.setKTX2Loader(ktx2.detectSupport(ctx.opts.ktx2.renderer as any));
  }
  return loader;
}

function construct(o: ObjectValue, ctx: Ctx): Promise<any> {
  let made = ctx.made.get(o);
  if (!made) ctx.made.set(o, (made = build(o, ctx)));
  return made;
}

async function build(o: ObjectValue, ctx: Ctx): Promise<any> {
  const args: unknown[] = [];
  for (const a of o.args) {
    // constructor arguments are needed before the node exists, so they cannot wait for a later ref()
    if (!ctx.settled && forwardRef(a, ctx)) fail("ref() in a constructor argument only sees nodes built before it", a, ctx);
    args.push(await evaluate(a, ctx));
  }
  // an asset is relative to the sheet it was written in — the bundler already resolved those for us
  const url = () => {
    const raw = String(args[0]);
    const from = o.args[0]?.file;
    return (from && sheets.get(from)?.assets?.[raw]) || resolveUrl(raw, ctx.opts.base);
  };

  let target: any;
  if (o.name === "texture") {
    // a texture clone owns its own GPU upload and shares only the decoded image, so it stays disposable
    const source = await asset(url(), () => new TextureLoader(ctx.opts.manager).loadAsync(url()));
    target = source.clone(); // shares the decoded image, but each use gets its own wrap/repeat state
    target.needsUpdate = true;
  } else if (o.name === "gltf") {
    // ponytail: a cached gltf is cloned per use; skinned meshes need SkeletonUtils.clone if that ever comes up
    const gltf = await asset(url(), async () => {
      const loaded = await gltfLoader(ctx).then((l) => l.loadAsync(url()));
      shareAssets(loaded.scene);
      return loaded;
    });
    target = gltf.scene.clone(true);
    if (gltf.animations?.length) clipsOf.set(target, gltf.animations);
  } else {
    const cls = lookup(o.name, ctx);
    if (typeof cls !== "function") fail(`unknown three class ${JSON.stringify(className(o.name))}${cls === undefined ? HINT : ""}`, o, ctx);
    target = new cls(...args);
  }

  if (o.id) {
    target.name = o.id;
    ctx.ids.set(o.id, target);
  }
  for (const m of o.body) await apply(target, m, ctx);
  return target;
}

async function apply(target: any, m: Member, ctx: Ctx): Promise<void> {
  if (m.kind === "var") return;
  if (m.kind === "at") return settings(target, m, ctx);
  if (m.kind === "node") {
    const o = m.object;
    if (o.name === "find") return applyFind(target, o, ctx);
    if (o.name === "play") return applyPlay(target, o, ctx);
    const known = lookup(o.name, ctx);
    // `lookAt(0, 1, 0);` — a name that is a method here and not a class of its own is a call
    if (!known && !o.hasBody && typeof target[o.name] === "function") {
      const args: unknown[] = [];
      for (const a of o.args) args.push(await evaluate(a, ctx));
      target[o.name](...args);
      return;
    }
    target.add(await construct(o, ctx));
    return;
  }

  // `target: ref(#ground)` may name a node further down the sheet — set it after everything exists
  if (!ctx.settled && forwardRef(m.value, ctx)) {
    ctx.deferred.push(() => apply(target, m, ctx));
    return;
  }

  const value = await evaluate(m.value, ctx);
  const path = m.name.split(".");
  let owner = target;
  for (const seg of path.slice(0, -1)) {
    owner = owner?.[seg];
    if (owner == null) fail(`cannot set ${m.name}: ${seg} is not set`, m, ctx);
  }
  const leaf = path.at(-1)!;
  // the checker catches this at build time; at runtime a typo would otherwise just sit on the object
  if (!(leaf in owner)) console.warn(`tscene: ${where(m, ctx.sheet)}: ${owner.constructor?.name ?? "object"} has no property ${JSON.stringify(leaf)}`);
  const current = owner[leaf];
  // read-only three fields (position, rotation, scale, …) are set through copy()
  if (current && typeof current === "object" && typeof current.copy === "function" && value && typeof value === "object" && value.constructor === current.constructor) {
    current.copy(value);
    return;
  }
  try {
    owner[leaf] = value;
  } catch (e) {
    // a getter-only property (a registry class the checker cannot see) throws in strict mode
    fail(`cannot set ${m.name}: ${(e as Error).message}`, m, ctx);
  }
}

/**
 * `@bakery { … }` — settings for a tool, not for three, so they land on `target.bakery` instead of
 * being assigned property by property. Merged key by key: a template's block and the node's own block
 * combine, and the later one wins per key.
 */
function settings(target: any, m: Member & { kind: "at" }, ctx: Ctx): void {
  target[m.name] = { ...target[m.name], ...(literal(m.value, ctx) as object) };
}

/**
 * A settings value: numbers, strings, booleans, arrays and records, and nothing else. Deliberately not
 * {@link evaluate} — a bare word in here is a plain string (`include: none`), not a three constant.
 */
function literal(v: Value, ctx: Ctx): unknown {
  switch (v.kind) {
    case "number": return v.unit === "deg" ? (v.value * Math.PI) / 180 : v.value;
    case "hex": return v.value;
    case "string": return v.value;
    case "array": return v.items.map((i) => literal(i, ctx));
    case "record": return Object.fromEntries(v.entries.map((e) => [e.name, literal(e.value, ctx)]));
    case "ident":
      if (v.name === "true") return true;
      if (v.name === "false") return false;
      if (v.name === "null") return null;
      return v.name;
    default: return fail(`a setting cannot be ${v.kind === "object" ? `a ${v.name}()` : `a ${v.kind}`}`, v, ctx);
  }
}

/** does this value reference an #id that has not been built yet? */
function forwardRef(v: Value, ctx: Ctx): boolean {
  switch (v.kind) {
    case "ref": return !ctx.ids.has(v.name);
    case "array": return v.items.some((i) => forwardRef(i, ctx));
    case "record": return v.entries.some((e) => forwardRef(e.value, ctx));
    case "object": return v.args.some((a) => forwardRef(a, ctx));
    default: return false;
  }
}

/** `find(mesh, "Body") { … }` — settings for a node that already exists inside this subtree */
async function applyFind(target: any, o: ObjectValue, ctx: Ctx): Promise<void> {
  const name = String(await evaluate(o.args.at(-1)!, ctx));
  const found = target.getObjectByName?.(name);
  if (!found) fail(`no descendant named ${JSON.stringify(name)}`, o, ctx);
  const first = o.args.length === 2 ? o.args[0] : undefined;
  const cls = first?.kind === "ident" ? className(first.name) : undefined;
  // three brands its own classes (isMesh, isLight, …); ponytail: a class without a brand cannot be asserted
  if (cls && cls !== "Object3D" && found[`is${cls}`] !== true) fail(`${JSON.stringify(name)} is not a ${cls}`, o, ctx);
  // the id names the found node for ref(), but does not rename it — later find()s still see the original
  if (o.id) ctx.ids.set(o.id, found);
  for (const inner of o.body) await apply(found, inner, ctx);
}

/** `play("Idle") { timeScale: 2; }` — a clip of the gltf this node sits in */
async function applyPlay(target: any, o: ObjectValue, ctx: Ctx): Promise<void> {
  let owner = target;
  while (owner && !clipsOf.has(owner)) owner = owner.parent;
  const clips: AnimationClip[] | undefined = owner && clipsOf.get(owner);
  if (!clips) fail("play() needs a gltf() node with animations to sit in", o, ctx);
  const name = String(await evaluate(o.args[0]!, ctx));
  const clip = AnimationClip.findByName(clips, name);
  if (!clip) fail(`no clip named ${JSON.stringify(name)} — this gltf has ${clips.map((c) => c.name).join(", ") || "none"}`, o, ctx);
  let mixer = mixerOf.get(owner);
  if (!mixer) mixerOf.set(owner, (mixer = new AnimationMixer(owner)));
  const action = mixer.clipAction(clip);
  for (const inner of o.body) await apply(action, inner, ctx);
  action.play();
  if (!ctx.mixers.includes(mixer)) ctx.mixers.push(mixer);
}

async function evaluate(v: Value, ctx: Ctx): Promise<unknown> {
  switch (v.kind) {
    case "number": return v.unit === "deg" ? (v.value * Math.PI) / 180 : v.value;
    case "hex": return v.value;
    case "string": return v.value;
    case "object": return construct(v, ctx);
    case "ref": {
      if (!ctx.ids.has(v.name)) fail(`unknown node #${v.name}`, v, ctx);
      return ctx.ids.get(v.name);
    }
    case "array": {
      const out = [];
      for (const item of v.items) out.push(await evaluate(item, ctx));
      return out;
    }
    case "record": {
      const out: Record<string, unknown> = {};
      for (const e of v.entries) out[e.name] = await evaluate(e.value, ctx);
      return out;
    }
    case "calc": return fail("unfolded calc()", v, ctx);
    case "var": return fail(`unresolved variable --${v.name}`, v, ctx);
    case "ident":
      if (v.name === "true") return true;
      if (v.name === "false") return false;
      if (v.name === "null") return null;
      const constant = lookup(v.name, ctx);
      if (constant !== undefined) return constant;
      return fail(`unknown constant ${JSON.stringify(v.name)}${HINT}`, v, ctx);
  }
}
