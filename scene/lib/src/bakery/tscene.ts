// Loading a .tscene sheet in Node. tscene's runtime is written for a browser: it fetches sheets and
// decodes images through the DOM. A handful of small shims is enough to make it work headless.
import { resolveObjectURL } from "node:buffer";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three/webgpu";
import { loadScene, type LoadOptions } from "../index.ts";
import { threeRegistry } from "../three.ts";
import { resolveSheet } from "../tools.ts";
import sharp from "sharp";

let uninstall: (() => void) | undefined;

/** Teaches `fetch` about `file:` urls and swaps three's ImageLoader for sharp. Idempotent. */
export function installNodeLoaders(): void {
  if (uninstall) return;

  // undici has no file: handler, and GLTFLoader/FileLoader both go through fetch
  const upstream = globalThis.fetch;
  const imageLoad = THREE.ImageLoader.prototype.load;
  uninstall = () => {
    globalThis.fetch = upstream;
    THREE.ImageLoader.prototype.load = imageLoad;
    uninstall = undefined;
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("file:")) return upstream(input as RequestInfo, init);
    return new Response(await readFile(fileURLToPath(url)));
  };

  // GLTFLoader reads `self.URL` once per image, embedded or not. Same shim createHeadlessRenderer()
  // installs — three treats `self` as the global object, not as a browser marker, so anything narrower
  // breaks it (the animation loop reads requestAnimationFrame off exactly this).
  (globalThis as Record<string, unknown>).self ??= globalThis;

  // FileLoader dispatches one of these per chunk
  (globalThis as Record<string, unknown>).ProgressEvent ??= class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      super(type);
      Object.assign(this, init);
    }
  };

  // ImageLoader wants an <img>; sharp decodes straight to the RGBA buffer three ends up with anyway
  THREE.ImageLoader.prototype.load = function (
    url: string,
    onLoad?: (image: unknown) => void,
    _onProgress?: unknown,
    onError?: (event: unknown) => void,
  ) {
    bytes(url)
      .then((buffer) => sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }))
      .then(({ data, info }) => onLoad?.({ width: info.width, height: info.height, data: new Uint8Array(data) }))
      .catch(onError ?? (() => {}));
    return {} as HTMLImageElement;
  } as typeof THREE.ImageLoader.prototype.load;
}

/**
 * Puts `fetch` and `ImageLoader` back the way {@link installNodeLoaders} found them — for a process
 * that bakes and then goes on to do something else with a `fetch` it expects to be its own. Idempotent,
 * and a no-op if the shims were never installed.
 *
 * `self` and `ProgressEvent` stay. Both are `??=` additions that nothing can tell apart from the real
 * thing, and a loader still in flight reads them.
 */
export function uninstallNodeLoaders(): void {
  uninstall?.();
}

/** The bytes behind a texture url: off disk, off the network when a sheet points at a CDN, or out of
 * the object url GLTFLoader wraps a .glb's embedded image in. */
async function bytes(url: string): Promise<Buffer> {
  if (/^https?:/.test(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (url.startsWith("blob:")) {
    const blob = resolveObjectURL(url);
    if (!blob) throw new Error(`nothing behind ${url}`);
    return Buffer.from(await blob.arrayBuffer());
  }
  return readFile(fileURLToPath(url));
}

/** Reads a `.tscene` file from disk, `@import`s and all, and returns the built scene. */
export async function loadSceneFile(file: string, opts: LoadOptions = {}): Promise<THREE.Group> {
  installNodeLoaders();
  const entry = resolve(file);
  return loadScene(await readFile(entry, "utf8"), {
    // read off disk, so no bundler ever saw it — the baker needs all of three available by name
    registry: threeRegistry,
    base: pathToFileURL(entry).href,
    // the sheet's own `@bakery { lightmap }` is this bake's output; applying it here would zero the
    // lights before they are traced and bake a scene lit by its own previous atlas
    lightmap: false,
    // resolveSheet, not a plain join: `@import "some-pkg/room.tscene"` is what the vite plugin and the
    // checker both accept, and a bake that could not read the sheet the editor checks is no bake
    load: async (path, from) => {
      const target = resolveSheet(path, from ? fileURLToPath(from) : entry);
      return { text: await readFile(target, "utf8"), file: pathToFileURL(target).href };
    },
    ...opts,
  });
}
