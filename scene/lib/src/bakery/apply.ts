// The runtime half: what a bake writes out, and how a loaded scene picks it up. Browser safe — no
// node imports in this file.
import * as THREE from "three/webgpu";
import { bakeGeometry, nodeKey } from "./scene.ts";

export type LightmapManifest = {
  version: 1;
  width: number;
  height: number;
  /** `lightMapIntensity` that undoes the exposure baked into an 8-bit texture */
  intensity: number;
  /** texture file name, relative to the manifest */
  texture: string;
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
  opts: { manager?: THREE.LoadingManager } = {},
): Promise<Lightmap> {
  // a texture we loaded ourselves is ours to dispose; one handed in may be shared with another root
  const owned = typeof source === "string";
  const { manifest, texture } = owned ? await loadLightmap(source, opts.manager) : source;

  const { meshes, materials } = attach(root, manifest, texture);

  const lights = new Map<THREE.Light, number>();
  root.traverse((o) => {
    const light = o as THREE.Light;
    // `bake: false` means "stays live at runtime", so it is not one of the lights the atlas contains
    if (light.isLight && o.userData?.bake !== false) lights.set(light, light.intensity);
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
): { meshes: number; materials: Set<THREE.MeshStandardMaterial> } {
  const byKey = new Map(manifest.meshes.map((m) => [m.key, m]));
  // three reads the lightmap from the uv1 attribute only when the texture says so. `flipY` is left
  // alone on purpose: the atlas is stored bottom up, which is the default for both a loaded image
  // (flipY true) and a DataTexture (flipY false).
  texture.channel = 1;

  let applied = 0;
  const materials = new Set<THREE.MeshStandardMaterial>();
  const all: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) all.push(o as THREE.Mesh);
  });

  for (const mesh of all) {
    const entry = byKey.get(nodeKey(root, mesh));
    if (!entry) continue;

    const geometry = bakeGeometry(mesh);
    const count = geometry.getAttribute("position").count;
    if (count !== entry.vertices) {
      throw new Error(
        `tscene/bakery: "${entry.key}" has ${count} vertices but the lightmap was baked from ${entry.vertices} — rebake`,
      );
    }

    geometry.setAttribute("uv1", new THREE.BufferAttribute(decodeFloats(entry.uv), 2));
    mesh.geometry = geometry;
    for (const material of ([] as THREE.Material[]).concat(mesh.material)) {
      const m = material as THREE.MeshStandardMaterial;
      m.lightMap = texture;
      m.needsUpdate = true;
      materials.add(m);
    }
    applied++;
  }
  // the intensity is left to the handle's `write()`, which owns it from here on
  return { meshes: applied, materials };
}

/**
 * Fetches a manifest plus its texture. `url` is the manifest; the texture is resolved next to it.
 * Browser-side convenience — the baker writes both files with matching names.
 */
export async function loadLightmap(
  url: string,
  manager?: THREE.LoadingManager,
): Promise<{ manifest: LightmapManifest; texture: THREE.Texture }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`tscene/bakery: ${response.status} loading ${url}`);
  const manifest = (await response.json()) as LightmapManifest;
  const base = new URL(url, globalThis.location?.href);
  const texture = await new THREE.TextureLoader(manager).loadAsync(new URL(manifest.texture, base).href);
  // the atlas holds exposure-scaled irradiance encoded as sRGB, and must not bleed across charts
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return { manifest, texture };
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
