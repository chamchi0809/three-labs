// The runtime half: what a bake writes out, and how a loaded scene picks it up. Browser safe — no
// node imports in this file.
import * as THREE from "three/webgpu";
import { nearestProbe } from "./probe.ts";
import { bakeEnabled, bakeGeometry, nodeKey } from "./scene.ts";

export type LightmapManifest = {
  /** manifest format. This build writes and reads {@link MANIFEST_VERSION}. */
  version: number;
  width: number;
  height: number;
  /** `lightMapIntensity` that undoes the exposure baked into an 8-bit texture */
  intensity: number;
  /** texture file name, relative to the manifest */
  texture: string;
  /** the float EXR next to it, when one was written — loaded instead of the PNG where support exists */
  hdr?: string;
  /** the ambient-occlusion PNG next to it, when the bake made one. Goes on `aoMap`. */
  ao?: string;
  /**
   * The reflection probes, in the order the bake walked them: an equirect EXR each, plus the world
   * position it was captured at, which is what picks the one a mesh reflects.
   */
  probes?: {
    /** `nodeKey()` of the node that declared it */
    key: string;
    position: [number, number, number];
    /** equirect EXR file name, relative to the manifest */
    texture: string;
  }[];
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
 * The manifest format this build produces. A stale `*.lightmap.json` on disk is the most likely thing
 * a project has lying around, and it used to be read as if it were current.
 */
export const MANIFEST_VERSION = 1;

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
   * Gain on the reflection probes, independent of {@link Lightmap.enabled} — a metal reflects whether
   * or not the diffuse atlas is showing. 1 is "as baked", 0 takes the probes off visually.
   */
  environment: number;
  /**
   * The lights the bake already contains → the intensity each had when the atlas was applied. A
   * realtime pass scales these instead of snapshotting its own.
   */
  readonly lights: ReadonlyMap<THREE.Light, number>;
  readonly manifest: LightmapManifest;
  readonly texture: THREE.Texture;
  /** the occlusion atlas, when the bake wrote one and it is on the materials' `aoMap` */
  readonly ao?: THREE.Texture;
  /** the baked probes, in manifest order — on the `envMap` of every metallic material they reach */
  readonly probes: readonly THREE.Texture[];
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
  source: string | { manifest: LightmapManifest; texture: THREE.Texture; ao?: THREE.Texture; probes?: THREE.Texture[] },
  opts: { manager?: THREE.LoadingManager; hdr?: boolean } = {},
): Promise<Lightmap> {
  // a texture we loaded ourselves is ours to dispose; one handed in may be shared with another root
  const owned = typeof source === "string";
  const { manifest, texture, ao, probes = [] } = owned ? await loadLightmap(source, opts) : source;
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(
      `tscene/bakery: lightmap manifest version ${manifest.version}, this build reads ${MANIFEST_VERSION} — rebake`,
    );
  }

  const { meshes, materials, envs, restore } = attach(root, manifest, texture, ao, probes);

  const lights = new Map<THREE.Light, number>();
  root.traverse((o) => {
    const light = o as THREE.Light;
    // `@bakery { enabled: false }` means "stays live at runtime", so it is not one of the lights the atlas
    // contains. Same rule as collectScene's, or the two disagree about which lights the bake already holds.
    if (light.isLight && bakeEnabled(o) !== false) lights.set(light, light.intensity);
  });

  let gain = 1;
  let env = 1;
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
  const writeEnv = () => {
    for (const [material, base] of envs) material.envMapIntensity = base * env;
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
    get environment() {
      return env;
    },
    set environment(next: number) {
      env = next;
      writeEnv();
    },
    lights,
    manifest,
    texture,
    ao,
    probes,
    dispose() {
      on = false;
      writeAtlas();
      writeLights();
      for (const m of materials) {
        m.lightMap = null;
        if (ao && m.aoMap === ao) m.aoMap = null;
        m.needsUpdate = true;
      }
      // `restore()` puts back the envMap and its intensity, so a probe leaves no trace either
      restore();
      if (owned) {
        texture.dispose();
        ao?.dispose();
        for (const probe of probes) probe.dispose();
      }
    },
  };

  lightmap.enabled = true;
  writeEnv();
  return lightmap;
}

/** The mesh half: geometry, uv1, texture slots. */
function attach(
  root: THREE.Object3D,
  manifest: LightmapManifest,
  texture: THREE.Texture,
  ao: THREE.Texture | undefined,
  probes: readonly THREE.Texture[],
): {
  meshes: number;
  materials: Set<THREE.MeshStandardMaterial>;
  /** material → the `envMapIntensity` the handle's gain multiplies */
  envs: Map<THREE.MeshStandardMaterial, number>;
  restore: () => void;
} {
  const byKey = new Map(manifest.meshes.map((m) => [m.key, m]));
  // three reads the lightmap from the uv1 attribute only when the texture says so. `flipY` is left
  // alone on purpose: the atlas is stored bottom up, which is the default for both a loaded image
  // (flipY true) and a DataTexture (flipY false).
  texture.channel = 1;
  if (ao) ao.channel = 1;

  const all: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) all.push(o as THREE.Mesh);
  });
  const users = new Map<THREE.Material, THREE.Mesh[]>();
  for (const mesh of all) {
    for (const m of ([] as THREE.Material[]).concat(mesh.material)) users.set(m, [...(users.get(m) ?? []), mesh]);
  }

  // Which probe each mesh reflects, decided before any material is touched: `envMap` is a per-material
  // slot, so a material used on both sides of a Voronoi boundary has to be cloned per probe the same way
  // an unbaked user forces a clone.
  const placed = probes.length ? (manifest.probes ?? []) : [];
  if (placed.length) root.updateMatrixWorld(true);
  const probeOf = new Map<THREE.Mesh, number>(
    all.map((mesh) => [mesh, placed.length ? nearestProbe(centre(mesh), placed) : -1]),
  );

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
  const envs = new Map<THREE.MeshStandardMaterial, number>();
  const undo: (() => void)[] = [];
  const clones = new Map<string, THREE.MeshStandardMaterial>();

  /**
   * A material some *unbaked* mesh also uses cannot take the atlas — that mesh has no uv1 and would
   * read a stranger's texels — so the baked meshes get a copy of it. Same for one whose meshes reflect
   * different probes. Only meshes under this root are counted; one shared with a second scene is beyond
   * what a traversal can see.
   */
  const litMaterial = (material: THREE.Material, probe: number): THREE.MeshStandardMaterial => {
    const shared = users.get(material) ?? [];
    const split = shared.some((m) => baked.has(m) && probeOf.get(m) !== probe);
    if (shared.every((m) => baked.has(m)) && !split) return material as THREE.MeshStandardMaterial;
    const id = `${material.uuid}:${probe}`;
    let clone = clones.get(id);
    if (!clone) {
      clone = material.clone() as THREE.MeshStandardMaterial;
      clones.set(id, clone);
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

    const probe = probeOf.get(mesh) ?? -1;
    const list = ([] as THREE.Material[]).concat(mesh.material);
    const lit = list.map((m) => litMaterial(m, probe));
    if (lit.some((m, i) => m !== list[i])) {
      const original = mesh.material;
      undo.push(() => (mesh.material = original));
      mesh.material = Array.isArray(mesh.material) ? lit : lit[0]!;
    }
    for (const m of lit) {
      // a MeshNormalMaterial or a hand-written ShaderMaterial has no lightMap slot, so the assignment
      // lands on a property three never reads and the mesh silently keeps its unbaked look
      // `as Material`: the list is typed as standard materials, and this is the check that they are
      if (!("lightMap" in (m as THREE.Material))) {
        console.warn(`tscene/bakery: "${entry.key}" uses a ${m.type}, which has no lightMap — the atlas cannot show`);
        continue;
      }
      m.lightMap = texture;
      if (ao && "aoMap" in m) m.aoMap = ao;

      // The specular half of the bake. Only a metal needs it: a dielectric's diffuse response to the
      // same light is already in the atlas, and an env map would add it a second time — so the gain is
      // scaled by metalness, which leaves a partial metal double counting that fraction of it.
      if (probe >= 0 && "envMap" in m && m.metalness > 0 && !envs.has(m)) {
        const before = { envMap: m.envMap, envMapIntensity: m.envMapIntensity };
        undo.push(() => Object.assign(m, before));
        envs.set(m, m.metalness * (m.envMapIntensity ?? 1));
        m.envMap = probes[probe]!;
      }

      m.needsUpdate = true;
      materials.add(m);
    }
  }
  // the intensities are left to the handle's writers, which own them from here on
  return { meshes: targets.length, materials, envs, restore: () => undo.forEach((f) => f()) };
}

/** The world-space middle of a mesh — what decides which probe's cell it is in. */
function centre(mesh: THREE.Mesh): [number, number, number] {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const v = mesh.geometry.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
  return [v.x, v.y, v.z];
}

/**
 * Fetches a manifest plus its texture. `url` is the manifest; the texture is resolved next to it.
 * Browser-side convenience — the baker writes both files with matching names.
 */
export async function loadLightmap(
  url: string,
  opts: { manager?: THREE.LoadingManager; hdr?: boolean } = {},
): Promise<{ manifest: LightmapManifest; texture: THREE.Texture; ao?: THREE.Texture; probes: THREE.Texture[] }> {
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
  atlasFilter(texture);

  // the occlusion atlas is a linear multiplier, so it keeps NoColorSpace
  let ao: THREE.Texture | undefined;
  if (manifest.ao) {
    ao = await new THREE.TextureLoader(opts.manager).loadAsync(new URL(manifest.ao, base).href);
    atlasFilter(ao);
  }
  // a probe is always a float EXR — a reflection of a lamp is the one thing an 8-bit range cannot hold.
  // `EquirectangularReflectionMapping` is what makes three run it through PMREM on first use, which is
  // where the roughness mips come from; the loader's row order already agrees with `equirectUV`.
  const probes: THREE.Texture[] = [];
  for (const probe of manifest.probes ?? []) {
    const map = await new (await import("three/addons/loaders/EXRLoader.js")).EXRLoader(opts.manager).loadAsync(
      new URL(probe.texture, base).href,
    );
    map.mapping = THREE.EquirectangularReflectionMapping;
    probes.push(map);
  }

  return { manifest: hdr ? { ...manifest, intensity: 1 } : manifest, texture, ao, probes };
}

/** No mipmaps and clamped: a mip would average two charts, and wrapping would sample the far edge. */
function atlasFilter(texture: THREE.Texture): void {
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
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
