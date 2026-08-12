// Loading a .tscene sheet in Node. tscene's runtime is written for a browser: it fetches sheets and
// decodes images through the DOM. Three small shims are enough to make it work headless.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three/webgpu";
import { loadScene, type LoadOptions } from "tscene";
import sharp from "sharp";

let shimmed = false;

/** Teaches `fetch` about `file:` urls and swaps three's ImageLoader for sharp. Idempotent. */
export function installNodeLoaders(): void {
  if (shimmed) return;
  shimmed = true;

  // undici has no file: handler, and GLTFLoader/FileLoader both go through fetch
  const upstream = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("file:")) return upstream(input as RequestInfo, init);
    return new Response(await readFile(fileURLToPath(url)));
  };

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
    sharp(fileURLToPath(url))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(({ data, info }) => onLoad?.({ width: info.width, height: info.height, data: new Uint8Array(data) }))
      .catch(onError ?? (() => {}));
    return {} as HTMLImageElement;
  } as typeof THREE.ImageLoader.prototype.load;
}

/** Reads a `.tscene` file from disk, `@import`s and all, and returns the built scene. */
export async function loadSceneFile(file: string, opts: LoadOptions = {}): Promise<THREE.Group> {
  installNodeLoaders();
  const entry = resolve(file);
  return loadScene(await readFile(entry, "utf8"), {
    base: pathToFileURL(entry).href,
    load: async (path, from) => {
      const target = resolve(from ? dirname(fileURLToPath(from)) : dirname(entry), path);
      return { text: await readFile(target, "utf8"), file: pathToFileURL(target).href };
    },
    ...opts,
  });
}
