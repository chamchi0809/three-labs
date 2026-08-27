// Runtime loader: .tscene source -> live three objects. Browser-safe.
//
// Nothing here reaches into three by name at runtime: the handful of values below are the only ones
// this module imports, and every class a sheet mentions arrives through a registry the vite plugin
// built at compile time. That is what lets a bundler tree-shake three down to what the scene uses.
import { AnimationClip, AnimationMixer, EquirectangularReflectionMapping, Group, SRGBColorSpace, TextureLoader } from "three/webgpu";
import type { LoadingManager, Object3D } from "three/webgpu";
import { expand, lineCol, parse, SceneSyntaxError, type Diagnostic, type Loader, type Member, type ObjectValue, type Pos, type Value } from "./parse.ts";
import { className, LOADERS, math } from "./names.ts";

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
  /** transcoder path + the renderer whose support is probed — required by `ktx2()` and by gltf() files with ktx2 textures */
  ktx2?: { path: string; renderer: unknown };
  /**
   * `false` ignores the sheet's own `@bakery { lightmap }`. What the baker passes — it is the thing
   * producing the atlas, and applying one mid-bake would zero the lights it is about to trace.
   */
  lightmap?: boolean;
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
  /** what the enclosing `each()` calls bind right now — the only variables left by the time we get here */
  loop: Map<string, unknown>;
  /** node name → what the registry resolved it to, so a name is only spelled out once */
  classes: Map<string, unknown>;
  /** after the tree is built an unknown #id is a real error, not a forward reference */
  settled?: boolean;
};

/** Parses `src` and builds the scene graph. Top-level nodes become children of the returned group. */
export async function loadScene(src: string | SceneModule, opts: LoadOptions = {}): Promise<Group> {
  // the imported module object goes stale on every hot reload, so always take the registered one
  const mod = typeof src === "string" ? undefined : latest(src);
  const base = opts.base ?? mod?.file;
  // `base` resolves assets; a sheet's own file is its identity, and `moduleLoader` finds the owner of an
  // `@import` by it. Handing `parse()` the caller's base instead made every import of a bundled sheet
  // look itself up under a name nothing was registered as — so `base` broke the option it documents.
  const sheet = parse(mod ? mod.source : (src as string), mod?.file ?? opts.base);
  const { nodes, diagnostics } = await expand(sheet, opts.load ?? (mod ? moduleLoader(mod) : fetchLoader));
  // warnings (dead vars, duplicate ids, …) are the checker's business; only errors stop the build
  const errors = [...sheet.errors, ...diagnostics].filter((d) => d.severity === "error");
  if (errors.length) throw new SceneSyntaxError(errors.map((d) => `${where(d, sheet)}: ${d.message}`).join("\n"), errors[0]!);

  const ctx: Ctx = {
    opts: { ...opts, base }, sheet: { text: sheet.text, file: sheet.file }, mixers: [],
    made: new WeakMap(), ids: new Map(), deferred: [], loop: new Map(), classes: new Map(),
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
  await applySheetLightmap(root, ctx);
  return root;
}

/**
 * `@bakery { lightmap: "…/room.lightmap.json" }` — the bake this sheet was made for, applied as soon as
 * the tree exists so a scene ships lit without the demo wiring it up. The handle lands on
 * `root.userData.lightmap` (that is where you reach for `.intensity` / `.enabled`), and
 * {@link disposeScene} disposes it.
 *
 * The import is dynamic on purpose: a sheet with no lightmap must not pull the bakery into the bundle.
 */
async function applySheetLightmap(root: Group, ctx: Ctx): Promise<void> {
  const url = (root as { bakery?: { lightmap?: unknown } }).bakery?.lightmap;
  if (ctx.opts.lightmap === false || typeof url !== "string") return;
  const { applyLightmap } = await import("./bakery/apply.ts");
  root.userData.lightmap = await applyLightmap(root, resolveUrl(url, ctx.opts.base), { manager: ctx.opts.manager });
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
      for (const t of textures(material as object)) cached.add(t);
    }
  });
}

/**
 * The textures a material holds. `.flat()` because a slot may be a list — `MeshPhysicalNodeMaterial`
 * and anything hand-written can keep an array of maps, and those used to be walked past and leaked.
 */
function textures(material: object): object[] {
  return Object.values(material)
    .flat()
    .filter((v) => (v as any)?.isTexture) as object[];
}

/**
 * Frees the GPU resources of a scene built by loadScene — call it before dropping a root,
 * otherwise every hot reload leaks its geometries, materials and textures. What came out of the
 * asset cache is left alone: it is shared with every other use of the same url.
 */
export function disposeScene(root: Object3D): void {
  // the atlas this sheet loaded itself is the scene's too, and it holds the materials it patched
  (root.userData.lightmap as { dispose?: () => void } | undefined)?.dispose?.();
  root.traverse((o: any) => {
    if (!cached.has(o.geometry)) o.geometry?.dispose?.();
    // a scene() node owns its background/environment, and neither is a material slot — the two most
    // expensive textures a sheet can hold used to be the two nothing freed
    for (const slot of [o.background, o.environment]) {
      if (slot?.isTexture && !cached.has(slot)) slot.dispose();
    }
    for (const material of [o.material].flat().filter(Boolean)) {
      if (cached.has(material as object)) continue;
      for (const t of textures(material as object)) if (!cached.has(t)) (t as any).dispose();
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

  let gone = false;

  const build = async () => {
    const next = await loadScene(src, opts);
    // dispose() may have landed while this build was still loading its gltfs — adding the root now
    // would put a scene nobody holds back on screen, and leak it
    if (gone) return disposeScene(next);
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
      gone = true;
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

/**
 * `meshStandardMaterial` and `MeshStandardMaterial` are the same entry; so are `vec3` and `Vector3`.
 * Memoised per load: an `each()` looks the same class up once per point otherwise.
 */
function lookup(name: string, ctx: Ctx): any {
  let found = ctx.classes.get(name);
  if (found === undefined) ctx.classes.set(name, (found = ctx.registry[name] ?? ctx.registry[className(name)]));
  return found;
}

// a sheet parsed from a string was never seen by the plugin, so nothing imported three on its behalf
const HINT =
  ' — a sheet loaded from a string has no build-time registry: import { threeRegistry } from "tscene/three"' +
  ' (and { addonRegistry } from "tscene/addons" for three/addons classes) and pass it as `registry`';

// module-level: a reloaded scene reuses the bytes it already downloaded
// ponytail: keyed by url only — two loadScene calls with different draco/ktx2 options share the first result
const assets = new Map<string, Promise<any>>();

/**
 * Forgets what `texture()` and `gltf()` downloaded, so the next sheet that asks for a url fetches it
 * again. Pass a resolved absolute url to drop one entry, or nothing to drop them all.
 *
 * The cache is keyed by url and lives as long as the module does, which is what makes a hot reload
 * instant — and also means an asset edited on disk keeps serving its old bytes, and a long-lived page
 * that walks through a lot of scenes never gives the decoded images back. This is the way out of both.
 *
 * It only forgets. Whatever is already on screen keeps working: a `gltf()` node is a clone that shares
 * the cached geometries and materials, and those are freed by {@link disposeScene} on the last scene
 * holding them. Clearing while a load is in flight is safe too — that load finishes and hands its
 * result to the caller that started it, and only the caching of it is dropped.
 */
export function clearAssetCache(url?: string): void {
  if (url === undefined) assets.clear();
  else assets.delete(url);
}
/** gltf() root → the clips that came with it, for play() */
const clipsOf = new WeakMap<object, AnimationClip[]>();
/** clip owner → its mixer, so several play() calls on one gltf share one mixer */
const mixerOf = new WeakMap<object, AnimationMixer>();
function asset<T>(url: string, load: () => Promise<T>): Promise<T> {
  let pending = assets.get(url) as Promise<T> | undefined;
  if (!pending) {
    // a rejection must not be cached: one offline moment would otherwise fail every later reload,
    // which is exactly when a hot-reloading editor asks again
    pending = load().catch((e: unknown) => {
      assets.delete(url);
      throw e;
    });
    assets.set(url, pending);
  }
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
  if (ctx.opts.ktx2) loader.setKTX2Loader(await ktx2Loader(ctx));
  return loader;
}

/** the transcoder is configured, not bundled: it has to be served, and it has to probe the renderer */
async function ktx2Loader(ctx: Ctx) {
  const { KTX2Loader } = await import("three/addons/loaders/KTX2Loader.js");
  const { path, renderer } = ctx.opts.ktx2!;
  return new KTX2Loader(ctx.opts.manager).setTranscoderPath(path).detectSupport(renderer as any);
}

/**
 * The texture loaders that are three/addons modules rather than three's own — imported when a sheet
 * asks for one, so a scene with no `.hdr` in it never downloads the parser for one.
 */
const TEXTURE_LOADERS: Record<string, (ctx: Ctx) => Promise<{ loadAsync(url: string): Promise<any> }>> = {
  texture: async (ctx) => new TextureLoader(ctx.opts.manager),
  hdr: async (ctx) => new (await import("three/addons/loaders/HDRLoader.js")).HDRLoader(ctx.opts.manager),
  exr: async (ctx) => new (await import("three/addons/loaders/EXRLoader.js")).EXRLoader(ctx.opts.manager),
  ktx2: (ctx) => ktx2Loader(ctx),
};

function construct(o: ObjectValue, ctx: Ctx): Promise<any> {
  // one AST node is one instance — except inside an each(), where expand() marked the nodes that read
  // the loop binding and every iteration owes a fresh one
  if (o.dynamic) return build(o, ctx);
  let made = ctx.made.get(o);
  if (!made) ctx.made.set(o, (made = build(o, ctx)));
  return made;
}

async function build(o: ObjectValue, ctx: Ctx): Promise<any> {
  const args: unknown[] = [];
  for (const a of o.args) {
    // constructor arguments are needed before the node exists, so they cannot wait for a later ref()
    if (!ctx.settled && forwardRef(a, ctx)) fail("ref() in a constructor argument only sees nodes built before it", a, ctx);
    const fast = quick(a, ctx);
    args.push(fast === PENDING ? await evaluate(a, ctx) : fast);
  }
  // an asset is relative to the sheet it was written in — the bundler already resolved those for us
  const url = () => {
    const raw = String(args[0]);
    const from = o.args[0]?.file;
    return (from && sheets.get(from)?.assets?.[raw]) || resolveUrl(raw, ctx.opts.base);
  };

  let target: any;
  const loader = TEXTURE_LOADERS[o.name];
  if (loader) {
    if (o.name === "ktx2" && !ctx.opts.ktx2) fail("ktx2() needs loadScene's `ktx2` option — the transcoder has to be served and the renderer probed", o, ctx);
    // a texture clone owns its own GPU upload and shares only the decoded image, so it stays disposable
    const source = await asset(url(), async () => (await loader(ctx)).loadAsync(url()));
    target = source.clone(); // shares the decoded image, but each use gets its own wrap/repeat state
    target.needsUpdate = true;
    // which slot this ends up in is not known yet, so the ones the sheet left alone are remembered.
    // Only for texture(): float radiance is linear by definition, and a .ktx2 carries its own colour
    // space in the container, so neither has a guess to make.
    if (o.name === "texture" && !o.body.some((m) => m.kind === "prop" && m.name === "colorSpace")) untagged.add(target);
    // an .hdr or .exr is an environment map often enough that UVMapping is never what was meant
    if ((o.name === "hdr" || o.name === "exr") && !o.body.some((m) => m.kind === "prop" && m.name === "mapping")) {
      target.mapping = EquirectangularReflectionMapping;
    }
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

/** textures from a `texture()` whose body did not state a `colorSpace`, so this module may pick one */
const untagged = new WeakSet<object>();

/**
 * The texture slots three reads as colour. Everything left out (roughness, metalness, normals, ao,
 * displacement, alpha, …) is data and has to stay linear.
 * ponytail: three has no such table to import, so this one is by hand — add the slot if one is missing.
 */
const COLOR_SLOTS = new Set([
  "map", "emissiveMap", "specularMap", "specularColorMap", "sheenColorMap", "matcap",
  "background", "environment", "envMap", "lightMap",
]);

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
  // a path that walked into a primitive — `position.x.y: 2` reached `0`, and `"y" in 0` throws a raw
  // TypeError with no sheet position on it. The checker catches this; `vite({ check: false })` does not.
  if (typeof owner !== "object" && typeof owner !== "function") {
    fail(`cannot set ${m.name}: ${path.slice(0, -1).join(".")} is a ${typeof owner}, not an object`, m, ctx);
  }
  // `map: texture("./wall.png")` is a colour, and TextureLoader hands every file back as raw data —
  // so an untagged texture in a colour slot renders washed out until somebody types `colorSpace: srgb`
  if (COLOR_SLOTS.has(leaf) && untagged.delete(value as object)) (value as { colorSpace: string }).colorSpace = SRGBColorSpace;
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
  // `find() { }` used to index past the end of an empty argument list and throw a bare TypeError
  if (!o.args.length || o.args.length > 2) fail('find() takes an optional node type and a name: find(mesh, "Body")', o, ctx);
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
/**
 * A value the synchronous path could not finish. Almost nothing an `each()` body is made of has to wait —
 * numbers, loop bindings, arithmetic, property reads, the `vec3()`s built out of them — and a sheet that
 * writes its own geometry evaluates millions of them, where one promise each *is* the build time. So the
 * evaluator runs synchronously and hands over only when it meets something that genuinely blocks: a
 * loader, a node with a body, an instance another node shares.
 */
const PENDING: unique symbol = Symbol("pending");

/** the three links of a value chain, so the two paths cannot disagree about what they mean */
const readOf = (target: unknown, v: Value & { kind: "read" }, ctx: Ctx): unknown => {
  if (target == null) fail(`cannot read ${v.name} of ${String(target)}`, v, ctx);
  return (target as Record<string, unknown>)[v.name];
};
const indexOf = (target: unknown, at: unknown, v: Value & { kind: "index" }, ctx: Ctx): unknown => {
  if (!Array.isArray(target)) fail(`cannot index a ${typeof target}`, v, ctx);
  return (target as unknown[])[Number(at)];
};
const callOf = (target: unknown, args: unknown[], v: Value & { kind: "call" }, ctx: Ctx): unknown => {
  const method = (target as Record<string, unknown> | null)?.[v.name];
  if (typeof method !== "function") fail(`${v.name} is not a method of this value`, v, ctx);
  return (method as (...a: unknown[]) => unknown).apply(target, args);
};

const constant = (v: Value & { kind: "ident" }, ctx: Ctx): unknown => {
  if (v.name === "true") return true;
  if (v.name === "false") return false;
  if (v.name === "null") return null;
  const found = lookup(v.name, ctx);
  if (found !== undefined) return found;
  return fail(`unknown constant ${JSON.stringify(v.name)}${HINT}`, v, ctx);
};

/**
 * Can this node be built without awaiting anything? A loader has a file to fetch, a body may hold one, and
 * a memoised node hands its instance out through a promise — none of which the synchronous path owns. The
 * node inside an `each()` that reads the binding is the case that matters, and it is exactly the one that
 * is `dynamic`, bodyless and unnamed.
 */
const plainNode = (o: ObjectValue) => o.dynamic === true && !o.hasBody && !o.body.length && !o.id && !LOADERS[o.name];

/** {@link evaluate} minus the promises. {@link PENDING} when a value has to go the asynchronous way. */
function quick(v: Value, ctx: Ctx): unknown {
  switch (v.kind) {
    case "number": return v.unit === "deg" ? (v.value * Math.PI) / 180 : v.value;
    case "hex": return v.value;
    case "string": return v.value;
    case "ident": return constant(v, ctx);
    case "ref": {
      if (!ctx.ids.has(v.name)) fail(`unknown node #${v.name}`, v, ctx);
      return ctx.ids.get(v.name);
    }
    case "var": return ctx.loop.has(v.name) ? ctx.loop.get(v.name) : fail(`unresolved variable --${v.name}`, v, ctx);
    case "calc": case "fn": {
      const value = arith(v, ctx);
      return typeof value === "number" ? value : PENDING;
    }
    case "read": {
      const target = quick(v.target, ctx);
      return target === PENDING ? PENDING : readOf(target, v, ctx);
    }
    case "index": {
      const target = quick(v.target, ctx);
      if (target === PENDING) return PENDING;
      const at = quick(v.at, ctx);
      return at === PENDING ? PENDING : indexOf(target, at, v, ctx);
    }
    case "call": {
      const target = quick(v.target, ctx);
      if (target === PENDING) return PENDING;
      const args = quickAll(v.args, ctx);
      return args === PENDING ? PENDING : callOf(target, args, v, ctx);
    }
    case "array": return quickAll(v.items, ctx);
    case "record": {
      const out: Record<string, unknown> = {};
      for (const e of v.entries) {
        const value = quick(e.value, ctx);
        if (value === PENDING) return PENDING;
        out[e.name] = value;
      }
      return out;
    }
    case "each": return iterate(v, ctx);
    case "object": {
      if (!plainNode(v)) return PENDING;
      const args = quickAll(v.args, ctx);
      if (args === PENDING) return PENDING;
      const cls = lookup(v.name, ctx);
      if (typeof cls !== "function") return PENDING; // let the asynchronous path report it
      return new (cls as new (...a: unknown[]) => unknown)(...args);
    }
  }
  // every kind above returns or fails; a new one lands here and takes the asynchronous path until it
  // decides it can be built without awaiting
  return PENDING;
}

/** every one of them, or PENDING if any single one has to wait */
function quickAll(values: Value[], ctx: Ctx): unknown[] | typeof PENDING {
  const out: unknown[] = [];
  for (const v of values) {
    const value = quick(v, ctx);
    if (value === PENDING) return PENDING;
    out.push(value);
  }
  return out;
}

async function evaluate(v: Value, ctx: Ctx): Promise<unknown> {
  const fast = quick(v, ctx);
  if (fast !== PENDING) return fast;
  switch (v.kind) {
    case "object": return construct(v, ctx);
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
    // expand() folds the arithmetic it can; what is left reads an each() binding, so it lands here
    case "calc": case "fn": return arith(v, ctx);
    case "each": return slowly(v, ctx);
    case "read": return readOf(await evaluate(v.target, ctx), v, ctx);
    case "index": return indexOf(await evaluate(v.target, ctx), await evaluate(v.at, ctx), v, ctx);
    case "call": {
      const target = await evaluate(v.target, ctx);
      const args: unknown[] = [];
      for (const a of v.args) args.push(await evaluate(a, ctx));
      return callOf(target, args, v, ctx);
    }
    // quick() settles or fails on every other kind, so reaching this is a gap and not a slow path
    default: return fail(`cannot evaluate a ${v.kind}`, v, ctx);
  }
}

/** the bindings an `each()` puts in scope, and the undo that hands a shadowed outer one back */
function bindings(v: Value & { kind: "each" }, ctx: Ctx, over: unknown) {
  const items = Array.isArray(over) ? over : undefined;
  const count = items ? items.length : Number(over);
  if (!Number.isInteger(count) || count < 0) fail(`each() counts to a whole number or walks a list, got ${String(over)}`, v.over, ctx);
  const saved = [v.name, "index", "count"].map((name) => [name, ctx.loop.has(name), ctx.loop.get(name)] as const);
  ctx.loop.set("count", count);
  return {
    count,
    bind: (i: number) => {
      ctx.loop.set(v.name, items ? items[i] : i);
      ctx.loop.set("index", i);
    },
    restore: () => { for (const [name, had, was] of saved) had ? ctx.loop.set(name, was) : ctx.loop.delete(name); },
  };
}

/**
 * `each(--j, 48, expr)` — the body once per index, or once per item of a list, without awaiting anything.
 * PENDING if any iteration has to wait, which {@link slowly} then redoes: one wasted iteration on the
 * bodies that need it, and none at all on the geometry this is here for.
 */
function iterate(v: Value & { kind: "each" }, ctx: Ctx): unknown[] | typeof PENDING {
  const over = quick(v.over, ctx);
  if (over === PENDING) return PENDING;
  const { count, bind, restore } = bindings(v, ctx, over);
  const out: unknown[] = [];
  try {
    for (let i = 0; i < count; i++) {
      bind(i);
      const value = quick(v.body, ctx);
      if (value === PENDING) return PENDING;
      out.push(value);
    }
  } finally {
    restore();
  }
  return out;
}

/** the same loop, for a body that builds something it has to wait for */
async function slowly(v: Value & { kind: "each" }, ctx: Ctx): Promise<unknown[]> {
  const { count, bind, restore } = bindings(v, ctx, await evaluate(v.over, ctx));
  const out: unknown[] = [];
  try {
    for (let i = 0; i < count; i++) {
      bind(i);
      out.push(await evaluate(v.body, ctx));
    }
  } finally {
    restore();
  }
  return out;
}

/**
 * The arithmetic expand() could not fold, over the loop bindings it was waiting for. Synchronous while it
 * can be, which is nearly always — a promise per operator would cost more than everything else together.
 */
function arith(v: Value, ctx: Ctx): number | Promise<number> {
  if (v.kind === "calc") {
    const left = arith(v.left, ctx);
    const right = arith(v.right, ctx);
    if (typeof left === "number" && typeof right === "number") return operate(v, left, right, ctx);
    return Promise.all([left, right]).then(([l, r]) => operate(v, l, r, ctx));
  }
  if (v.kind === "fn") {
    // MATH tops out at three arguments, so the sync path can name them and allocate nothing
    const a = v.args[0] === undefined ? 0 : arith(v.args[0], ctx);
    const b = v.args[1] === undefined ? 0 : arith(v.args[1], ctx);
    const c = v.args[2] === undefined ? 0 : arith(v.args[2], ctx);
    if (typeof a === "number" && typeof b === "number" && typeof c === "number") return math(v.name, a, b, c);
    return Promise.all([a, b, c]).then(([x, y, z]) => math(v.name, x, y, z));
  }
  const value = quick(v, ctx);
  return value === PENDING ? evaluate(v, ctx).then((x) => number(x, v, ctx)) : number(value, v, ctx);
}

function operate(v: Value & { kind: "calc" }, left: number, right: number, ctx: Ctx): number {
  switch (v.op) {
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/": return right === 0 ? fail("calc() divides by zero", v, ctx) : left / right;
  }
}

function number(value: unknown, v: Value, ctx: Ctx): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`calc() works on numbers, got ${JSON.stringify(value)}`, v, ctx);
  return value as number;
}
