// The runtime half: what a bake writes out, and how a loaded scene picks it up. Browser safe — no
// node imports in this file.
import * as THREE from "three/webgpu";
import { bakeEnabled, bakeGeometry, nodeKey } from "./scene.ts";

export type LightmapManifest = {
  version: 1;
  width: number;
  height: number;
  /** `lightMapIntensity` that undoes the exposure baked into an 8-bit texture */
  intensity: number;
  /** texture file name, relative to the manifest */
  texture: string;
  /** the float EXR next to it, when one was written — loaded instead of the PNG where support exists */
  hdr?: string;
  meshes: {
    /** `nodeKey()` path from the bake root */
    key: string;
    /** vertex count, checked against the runtime geometry before the uvs are trusted */
    vertices: number;
    /** base64 of a Float32Array of uv1, 2 per vertex */
    uv: string;
  }[];
};

/** A bake that is on a scene. Handed back by {@link applyLightmap}; there is nothing to construct. */
export type Lightmap = {
  /** how many meshes the atlas reached */
  readonly meshes: number;
  readonly width: number;
  readonly height: number;
  /**
   * Gain on the exposure the bake wrote into the manifest, so 1 is "as baked". An 8-bit atlas of a
   * scene whose bright end sits far above what matters wants this above 1.
   */
  intensity: number;
  /**
   * `false` puts the scene back on its own lights: the atlas goes to zero and every light the bake
   * accounted for gets the intensity it had when this handle was made.
   */
  enabled: boolean;
  /**
   * The lights the bake already contains → the intensity each had when the atlas was applied. A
   * realtime pass scales these instead of snapshotting its own.
   */
  readonly lights: ReadonlyMap<THREE.Light, number>;
  readonly manifest: LightmapManifest;
  readonly texture: THREE.Texture;
  /** Drops the atlas off the materials, restores the lights, and disposes a texture this call loaded. */
  dispose(): void;
};

/**
 * Puts a bake on a scene: de-indexes every baked mesh, attaches its `uv1`, points the materials at the
 * atlas, and zeroes the lights the bake already contains (leaving them on counts every direct
 * contribution twice).
 *
 * `source` is either a manifest url — the texture is resolved next to it — or an already loaded pair
 * from {@link loadLightmap}, which is how two roots share one atlas.
 *
 * ```ts
 * const lightmap = await applyLightmap(root, "lightmaps/room.lightmap.json");
 * lightmap.enabled = false;   // back to the sheet's own lights
 * lightmap.intensity = 4;     // brighter than baked
 * ```
 *
 * The uvs are per triangle corner, which is why the geometry has to be non-indexed — two triangles
 * sharing a vertex almost never share a lightmap texel. `bakeGeometry()` produced the same layout
 * during the bake, and `toNonIndexed()` is deterministic, so the vertex counts lining up is a real
 * check that the manifest belongs to this scene.
 */
export async function applyLightmap(
  root: THREE.Object3D,
  source: string | { manifest: LightmapManifest; texture: THREE.Texture },
  opts: { manager?: THREE.LoadingManager; hdr?: boolean } = {},
): Promise<Lightmap> {
  // a texture we loaded ourselves is ours to dispose; one handed in may be shared with another root
  const owned = typeof source === "string";
  const { manifest, texture } = owned ? await loadLightmap(source, opts) : source;

  const { meshes, materials, restore } = attach(root, manifest, texture);

  const lights = new Map<THREE.Light, number>();
  root.traverse((o) => {
    const light = o as THREE.Light;
    // `@bakery { enabled: false }` means "stays live at runtime", so it is not one of the lights the atlas
    // contains. Same rule as collectScene's, or the two disagree about which lights the bake already holds.
    if (light.isLight && bakeEnabled(o) !== false) lights.set(light, light.intensity);
  });

  let gain = 1;
  let on = false;
  // intensity, not `lightMap = null`: dropping the texture changes the node graph, and the rebuild does
  // not come back when it is put back. Zero reads the same and costs one uniform.
  const writeAtlas = () => {
    for (const m of materials) m.lightMapIntensity = on ? manifest.intensity * gain : 0;
  };
  // only on a switch, never on a gain change — a realtime gain the caller applied is theirs to keep
  const writeLights = () => {
    for (const [light, intensity] of lights) light.intensity = on ? 0 : intensity;
  };

  const lightmap: Lightmap = {
    meshes,
    width: manifest.width,
    height: manifest.height,
    get intensity() {
      return gain;
    },
    set intensity(next: number) {
      gain = next;
      writeAtlas();
    },
    get enabled() {
      return on;
    },
    set enabled(next: boolean) {
      on = next;
      writeAtlas();
      writeLights();
    },
    lights,
    manifest,
    texture,
    dispose() {
      on = false;
      writeAtlas();
      writeLights();
      for (const m of materials) {
        m.lightMap = null;
        m.needsUpdate = true;
      }
      restore();
      if (owned) texture.dispose();
    },
  };

  lightmap.enabled = true;
  return lightmap;
}

/** The mesh half: geometry, uv1, texture slot. */
function attach(
  root: THREE.Object3D,
  manifest: LightmapManifest,
  texture: THREE.Texture,
): { meshes: number; materials: Set<THREE.MeshStandardMaterial>; restore: () => void } {
  const byKey = new Map(manifest.meshes.map((m) => [m.key, m]));
  // three reads the lightmap from the uv1 attribute only when the texture says so. `flipY` is left
  // alone on purpose: the atlas is stored bottom up, which is the default for both a loaded image
  // (flipY true) and a DataTexture (flipY false).
  texture.channel = 1;

  const all: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) all.push(o as THREE.Mesh);
  });
  const users = new Map<THREE.Material, THREE.Mesh[]>();
  for (const mesh of all) {
    for (const m of ([] as THREE.Material[]).concat(mesh.material)) users.set(m, [...(users.get(m) ?? []), mesh]);
  }

  // everything is checked before anything is touched: a half-applied atlas is worse than none
  const targets = all.flatMap((mesh) => {
    const entry = byKey.get(nodeKey(root, mesh));
    if (!entry) return [];
    const geometry = bakeGeometry(mesh);
    const count = geometry.getAttribute("position").count;
    if (count !== entry.vertices) {
      throw new Error(
        `tscene/bakery: "${entry.key}" has ${count} vertices but the lightmap was baked from ${entry.vertices} — rebake`,
      );
    }
    return [{ mesh, entry, geometry }];
  });
  const baked = new Set(targets.map((t) => t.mesh));

  const materials = new Set<THREE.MeshStandardMaterial>();
  const undo: (() => void)[] = [];
  const clones = new Map<THREE.Material, THREE.MeshStandardMaterial>();

  /**
   * A material some *unbaked* mesh also uses cannot take the atlas — that mesh has no uv1 and would
   * read a stranger's texels — so the baked meshes get a copy of it. Only meshes under this root are
   * counted; one shared with a second scene is beyond what a traversal can see.
   */
  const litMaterial = (material: THREE.Material): THREE.MeshStandardMaterial => {
    if ((users.get(material) ?? []).every((m) => baked.has(m))) return material as THREE.MeshStandardMaterial;
    let clone = clones.get(material);
    if (!clone) {
      clone = material.clone() as THREE.MeshStandardMaterial;
      clones.set(material, clone);
      undo.push(() => clone!.dispose());
    }
    return clone;
  };

  for (const { mesh, entry, geometry } of targets) {
    if (geometry !== mesh.geometry) {
      // toNonIndexed() made a new geometry; the mesh's own is left intact and put back on dispose()
      const original = mesh.geometry;
      undo.push(() => {
        mesh.geometry = original;
        geometry.dispose();
      });
    }
    geometry.setAttribute("uv1", new THREE.BufferAttribute(decodeFloats(entry.uv), 2));
    mesh.geometry = geometry;

    const list = ([] as THREE.Material[]).concat(mesh.material);
    const lit = list.map(litMaterial);
    if (lit.some((m, i) => m !== list[i])) {
      const original = mesh.material;
      undo.push(() => (mesh.material = original));
      mesh.material = Array.isArray(mesh.material) ? lit : lit[0]!;
    }
    for (const m of lit) {
      m.lightMap = texture;
      m.needsUpdate = true;
      materials.add(m);
    }
  }
  // the intensity is left to the handle's `write()`, which owns it from here on
  return { meshes: targets.length, materials, restore: () => undo.forEach((f) => f()) };
}

/**
 * Fetches a manifest plus its texture. `url` is the manifest; the texture is resolved next to it.
 * Browser-side convenience — the baker writes both files with matching names.
 */
export async function loadLightmap(
  url: string,
  opts: { manager?: THREE.LoadingManager; hdr?: boolean } = {},
): Promise<{ manifest: LightmapManifest; texture: THREE.Texture }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`tscene/bakery: ${response.status} loading ${url}`);
  const manifest = (await response.json()) as LightmapManifest;
  const base = new URL(url, globalThis.location?.href);

  // the EXR is the irradiance as baked, so it needs no exposure undone — and no clipping either.
  // The loader is imported on demand: a bake without `--exr` must not pull it into the bundle.
  const hdr = (opts.hdr ?? true) && manifest.hdr;
  const texture = hdr
    ? await new (await import("three/addons/loaders/EXRLoader.js")).EXRLoader(opts.manager).loadAsync(
        new URL(manifest.hdr!, base).href,
      )
    : await new THREE.TextureLoader(opts.manager).loadAsync(new URL(manifest.texture, base).href);
  // the PNG holds exposure-scaled irradiance encoded as sRGB, and neither must bleed across charts
  if (!hdr) texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return { manifest: hdr ? { ...manifest, intensity: 1 } : manifest, texture };
}

export function encodeFloats(data: Float32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let text = "";
  // one fromCharCode per byte blows the stack on a big atlas, so go a chunk at a time
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(text);
}

export function decodeFloats(base64: string): Float32Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
