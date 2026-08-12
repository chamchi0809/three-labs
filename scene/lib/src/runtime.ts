// Runtime loader: .tscene source -> live three objects. Browser-safe.
import * as THREE from "three/webgpu";
import { expand, lineCol, parse, SceneSyntaxError, type Diagnostic, type Loader, type Member, type ObjectValue, type Pos, type Value } from "./parse.ts";
import { ALIASES, className } from "./check.ts";

/** What the vite plugin's `import scene from "./main.tscene"` gives you: one sheet, one module. */
export type SceneModule = {
  source: string;
  file: string;
  /** @import path → the imported sheet's file, looked up in the sheet registry */
  imports?: Record<string, string>;
  /** `texture("./t.png")` → the url the bundler resolved it to */
  assets?: Record<string, string>;
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
  /** extra constructors, e.g. { water: Water }. Looked up before three's exports. */
  registry?: Record<string, new (...args: any[]) => any>;
  /** resolves @import paths; defaults to the module's own imports, or fetch */
  load?: Loader;
  /** shared LoadingManager — its onProgress/onLoad see every texture() and gltf() */
  manager?: THREE.LoadingManager;
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
  mixers: THREE.AnimationMixer[];
  /** one AST node = one instance, so a material held in a --var is shared, not rebuilt per user */
  made: WeakMap<ObjectValue, Promise<any>>;
  /** #id → instance, for ref(#id) */
  ids: Map<string, any>;
  /** props whose ref(#id) target is not built yet — replayed once the whole tree exists */
  deferred: (() => Promise<void>)[];
  /** after the tree is built an unknown #id is a real error, not a forward reference */
  settled?: boolean;
};

/** Parses `src` and builds the scene graph. Top-level nodes become children of the returned group. */
export async function loadScene(src: string | SceneModule, opts: LoadOptions = {}): Promise<THREE.Group> {
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
  };
  const root = new THREE.Group();
  root.name = "scene";
  for (const m of nodes) {
    if (m.kind !== "node") continue;
    root.add((await construct(m.object, ctx)) as THREE.Object3D);
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
export function updateScene(root: THREE.Object3D, delta: number): void {
  for (const mixer of (root.userData.mixers ?? []) as THREE.AnimationMixer[]) mixer.update(delta);
}

/**
 * Frees the GPU resources of a scene built by loadScene — call it before dropping a root,
 * otherwise every hot reload leaks its geometries, materials and textures.
 */
export function disposeScene(root: THREE.Object3D): void {
  root.traverse((o: any) => {
    o.geometry?.dispose?.();
    for (const material of [o.material].flat().filter(Boolean)) {
      for (const v of Object.values(material as object)) if ((v as any)?.isTexture) (v as any).dispose();
      (material as any).dispose?.();
    }
  });
  root.removeFromParent();
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
export async function loadSceneFromURL(url: string, opts: LoadOptions = {}): Promise<THREE.Group> {
  const file = resolveUrl(url, opts.base);
  const res = await fetch(file);
  if (!res.ok) throw new Error(`cannot load ${file}: ${res.status}`);
  return loadScene(await res.text(), { ...opts, base: file });
}

const three = THREE as unknown as Record<string, any>;

// module-level: a reloaded scene reuses the bytes it already downloaded
// ponytail: keyed by url only — two loadScene calls with different draco/ktx2 options share the first result
const assets = new Map<string, Promise<any>>();
/** gltf() root → the clips that came with it, for play() */
const clipsOf = new WeakMap<object, THREE.AnimationClip[]>();
/** clip owner → its mixer, so several play() calls on one gltf share one mixer */
const mixerOf = new WeakMap<object, THREE.AnimationMixer>();
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
    const source = await asset(url(), () => new THREE.TextureLoader(ctx.opts.manager).loadAsync(url()));
    target = source.clone(); // shares the decoded image, but each use gets its own wrap/repeat state
    target.needsUpdate = true;
  } else if (o.name === "gltf") {
    // ponytail: a cached gltf is cloned per use; skinned meshes need SkeletonUtils.clone if that ever comes up
    const gltf = await asset(url(), () => gltfLoader(ctx).then((l) => l.loadAsync(url())));
    target = gltf.scene.clone(true);
    if (gltf.animations?.length) clipsOf.set(target, gltf.animations);
  } else {
    const cls = ctx.opts.registry?.[o.name] ?? three[className(o.name)];
    if (typeof cls !== "function") fail(`unknown three class ${JSON.stringify(className(o.name))}`, o, ctx);
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
  if (m.kind === "node") {
    const o = m.object;
    if (o.name === "find") return applyFind(target, o, ctx);
    if (o.name === "play") return applyPlay(target, o, ctx);
    const known = ctx.opts.registry?.[o.name] ?? three[className(o.name)];
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
  if (!(leaf in owner)) console.warn(`three-scene: ${where(m, ctx.sheet)}: ${owner.constructor?.name ?? "object"} has no property ${JSON.stringify(leaf)}`);
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
  const clips: THREE.AnimationClip[] | undefined = owner && clipsOf.get(owner);
  if (!clips) fail("play() needs a gltf() node with animations to sit in", o, ctx);
  const name = String(await evaluate(o.args[0]!, ctx));
  const clip = THREE.AnimationClip.findByName(clips, name);
  if (!clip) fail(`no clip named ${JSON.stringify(name)} — this gltf has ${clips.map((c) => c.name).join(", ") || "none"}`, o, ctx);
  let mixer = mixerOf.get(owner);
  if (!mixer) mixerOf.set(owner, (mixer = new THREE.AnimationMixer(owner)));
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
      if (v.name in (ctx.opts.registry ?? {})) return ctx.opts.registry![v.name];
      if (v.name in three) return three[v.name];
      if (ALIASES[v.name]) return three[ALIASES[v.name]!];
      return fail(`unknown constant ${JSON.stringify(v.name)}`, v, ctx);
  }
}
