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

/**
 * De-indexes every baked mesh, attaches its `uv1`, and points the materials at the lightmap.
 *
 * The uvs are per triangle corner, which is why the geometry has to be non-indexed — two triangles
 * sharing a vertex almost never share a lightmap texel. `bakeGeometry()` produced the same layout
 * during the bake, and `toNonIndexed()` is deterministic, so the vertex counts lining up is a real
 * check that the manifest belongs to this scene.
 *
 * @returns the number of meshes that got a lightmap.
 */
export function applyLightmap(root: THREE.Object3D, manifest: LightmapManifest, texture: THREE.Texture): number {
  const byKey = new Map(manifest.meshes.map((m) => [m.key, m]));
  // three reads the lightmap from the uv1 attribute only when the texture says so. `flipY` is left
  // alone on purpose: the atlas is stored bottom up, which is the default for both a loaded image
  // (flipY true) and a DataTexture (flipY false).
  texture.channel = 1;

  let applied = 0;
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });

  for (const mesh of meshes) {
    const entry = byKey.get(nodeKey(root, mesh));
    if (!entry) continue;

    const geometry = bakeGeometry(mesh);
    const count = geometry.getAttribute("position").count;
    if (count !== entry.vertices) {
      throw new Error(
        `scene-lightmapper: "${entry.key}" has ${count} vertices but the lightmap was baked from ${entry.vertices} — rebake`,
      );
    }

    geometry.setAttribute("uv1", new THREE.BufferAttribute(decodeFloats(entry.uv), 2));
    mesh.geometry = geometry;
    for (const material of ([] as THREE.Material[]).concat(mesh.material)) {
      const m = material as THREE.MeshStandardMaterial;
      m.lightMap = texture;
      m.lightMapIntensity = manifest.intensity;
      m.needsUpdate = true;
    }
    applied++;
  }
  return applied;
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
  if (!response.ok) throw new Error(`scene-lightmapper: ${response.status} loading ${url}`);
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

/**
 * Zeroes the lights a bake already accounted for. Leaving them on double counts every direct
 * contribution; call this right after `applyLightmap`.
 */
export function muteBakedLights(root: THREE.Object3D): void {
  root.traverse((o) => {
    const light = o as THREE.Light;
    if (light.isLight && o.userData?.bake !== false) light.intensity = 0;
  });
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
