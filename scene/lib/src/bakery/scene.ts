// Scene -> flat bake input: world-space triangle soup, materials, lights, sky.
import * as THREE from "three/webgpu";
import { BAKERY, type MaterialBakery, type NodeBakery, type SceneBakery } from "../names.ts";

/** Triangle soup in world space. What the BVH and the area-light list need, and nothing else. */
export type BakeEmitter = {
  /** world-space, 3 floats per vertex, vertexCount = triCount * 3 */
  positions: Float32Array;
  normals: Float32Array;
  /** per-triangle material index into BakeScene.materials */
  faceMaterial: Uint32Array;
  /** the mesh's own uv0, 2 floats per vertex — what an albedo or emissive map is sampled with. */
  uv?: Float32Array;
};

/** One bakeable mesh, de-indexed so every triangle corner owns its own vertex (and its own lightmap uv). */
export type BakeMesh = BakeEmitter & {
  /** stable path from the bake root — the key both the manifest and applyLightmap() use */
  key: string;
  mesh: THREE.Mesh;
  /** `@bakery { density }` — texel density relative to the rest of the scene. 1 (or absent) is the default. */
  density?: number;
};

export type BakeMaterial = {
  /** linear diffuse reflectance, what bounced light is multiplied by */
  albedo: [number, number, number];
  /** linear radiance emitted by this surface (W/sr/m²) — becomes an area light */
  emissive: [number, number, number];
  /** emits from the +normal side only (a RectAreaLight quad). A mesh material emits both ways. */
  oneSided?: boolean;
  /** the albedo map, sampled per texel when the bake builds an albedo atlas */
  map?: THREE.Texture;
  /** what one texel of {@link map} is multiplied by — colour × (1 - metalness). `albedo` is its mean. */
  mapScale?: [number, number, number];
  /**
   * the tangent-space normal map, sampled per texel so the trace sees the bumps the shader does.
   * Object-space maps are left out — a texel knows no object it belongs to by the time this is read.
   */
  normalMap?: THREE.Texture;
  /** `normalScale`, what the map's x and y are multiplied by before the frame is rebuilt */
  normalScale?: [number, number];
  /** the emissive map, sampled per triangle so a textured panel is not one flat colour */
  emissiveMap?: THREE.Texture;
  /** what one texel of {@link emissiveMap} is multiplied by. `emissive` already holds its mean. */
  emissiveScale?: [number, number, number];
  /**
   * how much of a shadow ray this surface stops: 1 opaque, 0 invisible to light. Read from
   * `opacity`/`transparent` and from the mean alpha of an `alphaMap`/cutout `map`.
   */
  coverage?: number;
};

/** 0 = directional, 1 = point, 2 = spot. Matches the `kind` the shader switches on. */
export type BakeLight = {
  kind: 0 | 1 | 2;
  /** color * intensity, linear */
  color: [number, number, number];
  position: [number, number, number];
  /** light -> target, normalized (directional + spot) */
  direction: [number, number, number];
  /** three's PointLight/SpotLight.distance cutoff, 0 = none */
  distance: number;
  decay: number;
  cosOuter: number;
  cosInner: number;
  /** world radius the light is jittered inside — 0 gives hard shadows */
  radius: number;
};

/** `@bakery { probe }` on a node — a point the bake captures the radiance around. */
export type BakeProbe = {
  /** `nodeKey()` of the node that declared it */
  key: string;
  position: [number, number, number];
  /** equirect width in texels; the height is half of it */
  size: number;
  /** world-space radius the probe reaches; 0 is "everywhere". See `probeWeights()`. */
  influence: number;
};

/** Ambient + hemisphere lights collapse into a two-colour gradient that rays see when they escape. */
export type BakeSky = {
  /** radiance looking along +axis */
  up: [number, number, number];
  down: [number, number, number];
  axis: [number, number, number];
};

export type BakeScene = {
  meshes: BakeMesh[];
  /** geometry that lights the bake without receiving any — a RectAreaLight, turned into a quad */
  emitters: BakeEmitter[];
  materials: BakeMaterial[];
  lights: BakeLight[];
  /** the reflection probes the sheet placed, in the order they were walked */
  probes: BakeProbe[];
  sky: BakeSky;
  /** world-space bounds of everything collected, for picking a default ray bias */
  bounds: THREE.Box3;
};

/**
 * The geometry the baker unwraps and the runtime must end up with — de-indexed, so a lightmap uv
 * can differ between two triangles that share a vertex. Deterministic: bake and runtime agree.
 */
export function bakeGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  return mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
}

/**
 * Path from `root` to `o`, using node names where there are any. Stable across reloads of the same
 * sheet. Two siblings sharing a name are told apart by their index, so a key is always unique —
 * `find()` and a loaded glTF both hand out repeated names.
 */
export function nodeKey(root: THREE.Object3D, o: THREE.Object3D): string {
  const parts: string[] = [];
  for (let n: THREE.Object3D | null = o; n && n !== root; n = n.parent) {
    const siblings = n.parent?.children;
    const at = siblings ? siblings.indexOf(n) : 0;
    const twin = !!n.name && !!siblings?.some((c, i) => i !== at && c.name === n!.name);
    parts.unshift(n.name && !twin ? n.name : `${n.name}@${at}`);
  }
  return parts.join("/");
}

/** What a sheet's `@bakery { … }` block left on the object it was written in. */
export const bakerySettings = <T extends NodeBakery | MaterialBakery | SceneBakery>(o: object | undefined): T | undefined =>
  (o as { bakery?: T } | undefined)?.bakery;

/**
 * Whether `o` is in the bake: its own `@bakery { enabled }`, or the nearest ancestor that states one.
 * `undefined` means nobody said, and the sheet's `include` decides. `"occluder"` is in the ray tracing
 * but gets no lightmap.
 */
export function bakeEnabled(o: THREE.Object3D): boolean | "occluder" | undefined {
  return inherited(o, "enabled");
}

/** `@bakery { density }` — the nearest one at or above `o`, or `undefined` for the scene's own scale. */
export function bakeDensity(o: THREE.Object3D): number | undefined {
  const density = inherited(o, "density");
  return density !== undefined && density > 0 ? density : undefined;
}

function inherited<K extends keyof NodeBakery>(o: THREE.Object3D, key: K): NodeBakery[K] {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) {
    const value = bakerySettings<NodeBakery>(n)?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * `@bakery { … }` is settings for a tool, so three drops nothing and a typo bakes silently wrong.
 * The checker catches it in an editor; this is for a bake that loaded the sheet itself. `where` only
 * names the source in the message.
 */
export function validateBakery(root: THREE.Object3D, where: string): void {
  const wrong: string[] = [];
  const known = (position: keyof typeof BAKERY, o: object | undefined, at: string) => {
    for (const key of Object.keys(bakerySettings(o) ?? {})) {
      if (!BAKERY[position][key]) wrong.push(`${at}: @bakery has no ${position} setting "${key}"`);
    }
  };

  known("scene", root, where);
  root.traverse((o) => {
    if (o !== root) known("node", o, nodeKey(root, o));
    for (const m of ([] as unknown[]).concat((o as THREE.Mesh).material ?? [])) {
      known("material", m as object, `${nodeKey(root, o)}'s material`);
    }
  });
  if (wrong.length) throw new Error(`tscene/bakery: ${wrong.join("\n  ")}`);
}

export type CollectOptions = {
  /** default albedo for materials without a `color` (linear grey) */
  defaultAlbedo?: number;
  /**
   * `all` (the default) bakes every visible mesh except the ones that turn themselves off; `none`
   * bakes only the ones that opt in. Defaults to the root's own `@bakery { include }`.
   */
  include?: "all" | "none";
  /** where "this mesh cannot be baked" goes. Defaults to `console.warn`. */
  onWarn?: (message: string) => void;
};

/** Walks the scene once and flattens everything the path tracer needs. Does not mutate `root`. */
export function collectScene(root: THREE.Object3D, opts: CollectOptions = {}): BakeScene {
  root.updateMatrixWorld(true);

  const meshes: BakeMesh[] = [];
  const emitters: BakeEmitter[] = [];
  const materials: BakeMaterial[] = [];
  const lights: BakeLight[] = [];
  const probes: BakeProbe[] = [];
  const bounds = new THREE.Box3();
  const matIds = new Map<THREE.Material, number>();
  const sky: BakeSky = { up: [0, 0, 0], down: [0, 0, 0], axis: [0, 1, 0] };

  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const lightDir = new THREE.Vector3();

  const byDefault = (opts.include ?? bakerySettings<SceneBakery>(root)?.include ?? "all") === "all";
  const warn = opts.onWarn ?? ((message: string) => console.warn(`tscene/bakery: ${message}`));
  /** materials the atlas will be written for and then thrown away by — see the warning below */
  const metals = new Set<string>();

  // traverseVisible, not traverse: `traverse` ignores what the callback returns, so an invisible
  // group used to hide only itself and bake its children anyway
  root.traverseVisible((o) => {
    // a probe is a place, not a thing: its own `@bakery { probe }` only, never inherited, and whatever
    // else the node is (a group, an empty, a mesh) it still gets baked as itself
    const settings = bakerySettings<NodeBakery>(o);
    const size = settings?.probe;
    if (size !== undefined && size >= 4) {
      v.setFromMatrixPosition(o.matrixWorld);
      const influence = settings?.influence ?? 0;
      probes.push({ key: nodeKey(root, o), position: [v.x, v.y, v.z], size: Math.floor(size), influence });
    } else if (size !== undefined) {
      warn(`"${nodeKey(root, o)}" asks for a ${size}-texel probe, which is smaller than a mip — skipped`);
    }

    const enabled = bakeEnabled(o);
    // a light is an input, not a receiver: `include: none` picks the meshes to bake, and only an
    // explicit `@bakery { enabled: false }` takes a light out (it stays live at runtime instead)
    if ((o as THREE.Light).isLight) {
      if (enabled === false) return;
      const rect = o as THREE.RectAreaLight;
      if (rect.isRectAreaLight) emitters.push(rectAreaEmitter(rect, materials, bounds));
      else collectLight(o as THREE.Light, lights, sky);
      return;
    }
    if (enabled === false || (enabled === undefined && !byDefault)) return;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;

    // a lightmap is one uv1 per vertex of one geometry, which none of these has: an instance has many
    // transforms behind that geometry, a skinned mesh a pose the bake never sees, a batched mesh both.
    // Silence here used to look like a bake that worked.
    const brand = mesh as unknown as Record<string, boolean | undefined>;
    const unbakeable = brand.isSkinnedMesh ? "skinned" : brand.isBatchedMesh ? "batched" : undefined;
    if (unbakeable) {
      warn(`"${nodeKey(root, mesh)}" is ${unbakeable} and cannot carry a lightmap — left out of the bake`);
      return;
    }
    // …but an instance's transform *is* known, so a forest of trees can shade the ground it stands on
    // even though no atlas can reach the trees themselves. One occluder per instance, same geometry.
    if (brand.isInstancedMesh) {
      const instanced = mesh as THREE.InstancedMesh;
      const made = instanceEmitters(instanced, emitters, materials, matIds, opts.defaultAlbedo ?? 0.8, bounds);
      warn(
        made
          ? `"${nodeKey(root, mesh)}" is instanced, so it cannot carry a lightmap — its ${made} instance(s) ` +
            `are in the bake as occluders and emitters only`
          : `"${nodeKey(root, mesh)}" is instanced and has no usable geometry — left out of the bake`,
      );
      return;
    }
    // `material: []` draws nothing, so as far as the renderer is concerned the mesh is not in the room.
    // Baking it would cast the shadow of something nobody can see, and it used to crash the bake instead.
    if (Array.isArray(mesh.material) && !mesh.material.length) {
      warn(`"${nodeKey(root, mesh)}" has an empty material list and draws nothing — left out of the bake`);
      return;
    }

    const geometry = bakeGeometry(mesh);
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    // the skinned/instanced skip above says why it skipped; this one used to just leave the mesh out,
    // and an unlit model with no message is the hardest kind of bake result to explain
    if (!position) {
      warn(`"${nodeKey(root, mesh)}" has no position attribute — left out of the bake`);
      return;
    }
    if (position.count % 3 !== 0) {
      warn(`"${nodeKey(root, mesh)}" has ${position.count} vertices, which is not whole triangles — left out of the bake`);
      return;
    }

    const count = position.count;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
      bounds.expandByPoint(v);
      if (normal) v.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      else v.set(0, 0, 0);
      normals[i * 3] = v.x;
      normals[i * 3 + 1] = v.y;
      normals[i * 3 + 2] = v.z;
    }
    if (!normal) faceNormals(positions, normals);

    const uv0 = geometry.getAttribute("uv");
    let uv: Float32Array | undefined;
    if (uv0 && uv0.count === count) {
      uv = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        uv[i * 2] = uv0.getX(i);
        uv[i * 2 + 1] = uv0.getY(i);
      }
    }

    for (const m of ([] as THREE.Material[]).concat(mesh.material)) {
      if (((m as THREE.MeshStandardMaterial).metalness ?? 0) >= 0.9) metals.add(m.name || nodeKey(root, mesh));
    }

    const faceMaterial = faceMaterials(mesh, geometry, count / 3, materials, matIds, opts.defaultAlbedo ?? 0.8);
    // `enabled: occluder` is exactly an emitter: in the BVH, in the area-light list if it glows, and
    // out of the atlas — so it needs no key, no unwrap and no uv1 at runtime
    if (enabled === "occluder") emitters.push({ positions, normals, uv, faceMaterial });
    else meshes.push({ key: nodeKey(root, mesh), mesh, positions, normals, uv, faceMaterial, density: bakeDensity(mesh) });
  });

  // three's diffuse colour is `albedo * (1 - metalness)`, and the lightmap only ever multiplies that:
  // a metal renders the atlas' irradiance as black however well the trace went. A probe is the fix —
  // a metal reflects, and reflections are what a diffuse lightmap is not.
  if (metals.size && !probes.length) {
    const names = [...metals].slice(0, 3).join(", ");
    warn(
      `${metals.size} material(s) are metalness >= 0.9 (${names}${metals.size > 3 ? ", …" : ""}) — three throws a ` +
        `lightmap away on a metal, so place a reflection probe (\`@bakery { probe: 256 }\`) for them to reflect`,
    );
  }

  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  // a scene with no ambient at all still needs an axis for the sky gradient
  lightDir.set(sky.axis[0], sky.axis[1], sky.axis[2]);
  if (lightDir.lengthSq() < 1e-12) sky.axis = [0, 1, 0];

  return { meshes, emitters, materials, lights, probes, sky, bounds };
}

/**
 * An InstancedMesh as one emitter: a world-space copy of its geometry per instance, concatenated. No
 * atlas can reach them — a lightmap is one uv1 per vertex of one geometry, and an instance has many
 * transforms behind it — but every instance still blocks light and bounces its own colour onto what
 * can. One emitter rather than one per instance keeps the BVH proxy at a single geometry.
 */
function instanceEmitters(
  mesh: THREE.InstancedMesh,
  emitters: BakeEmitter[],
  materials: BakeMaterial[],
  matIds: Map<THREE.Material, number>,
  defaultAlbedo: number,
  bounds: THREE.Box3,
): number {
  const geometry = bakeGeometry(mesh);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (!position || position.count % 3 !== 0) return 0;
  // `count` is how many instances are drawn, which is what the buffer holds at most and often less
  const instances = Math.max(0, Math.min(mesh.count, mesh.instanceMatrix.count));
  if (!instances) return 0;

  const count = position.count;
  const positions = new Float32Array(count * instances * 3);
  const normals = new Float32Array(count * instances * 3);
  const uv0 = geometry.getAttribute("uv");
  const uv = uv0 && uv0.count === count ? new Float32Array(count * instances * 2) : undefined;
  // every instance draws the same triangles with the same materials, so the mapping is made once
  const face = faceMaterials(mesh, geometry, count / 3, materials, matIds, defaultAlbedo);
  const faceMaterial = new Uint32Array(face.length * instances);

  const matrix = new THREE.Matrix4();
  const normals3 = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (let n = 0; n < instances; n++) {
    mesh.getMatrixAt(n, matrix);
    matrix.premultiply(mesh.matrixWorld);
    normals3.getNormalMatrix(matrix);
    const base = n * count;
    for (let i = 0; i < count; i++) {
      const o = (base + i) * 3;
      v.fromBufferAttribute(position, i).applyMatrix4(matrix);
      positions[o] = v.x;
      positions[o + 1] = v.y;
      positions[o + 2] = v.z;
      bounds.expandByPoint(v);
      if (normal) v.fromBufferAttribute(normal, i).applyMatrix3(normals3).normalize();
      else v.set(0, 0, 0);
      normals[o] = v.x;
      normals[o + 1] = v.y;
      normals[o + 2] = v.z;
      if (uv && uv0) {
        uv[(base + i) * 2] = uv0.getX(i);
        uv[(base + i) * 2 + 1] = uv0.getY(i);
      }
    }
    faceMaterial.set(face, n * face.length);
  }
  // a mirrored instance winds the other way, so a geometric normal is a per-instance thing — taken
  // over the whole concatenated run at once, after every transform has been applied
  if (!normal) faceNormals(positions, normals);

  emitters.push({ positions, normals, uv, faceMaterial });
  return instances;
}

/**
 * three's RectAreaLight is a one-sided emitting quad whose intensity is already a radiance (nits), so
 * it drops straight into the area-light path as two emissive triangles. It shines along local -Z,
 * and the winding here puts the geometric normal on that side.
 */
function rectAreaEmitter(light: THREE.RectAreaLight, materials: BakeMaterial[], bounds: THREE.Box3): BakeEmitter {
  light.updateMatrixWorld(true);
  const w = light.width / 2;
  const h = light.height / 2;
  const corners = [
    new THREE.Vector3(-w, -h, 0),
    new THREE.Vector3(-w, h, 0),
    new THREE.Vector3(w, h, 0),
    new THREE.Vector3(w, -h, 0),
  ].map((c) => c.applyMatrix4(light.matrixWorld));
  for (const c of corners) bounds.expandByPoint(c);

  const id = materials.length;
  materials.push({
    albedo: [0, 0, 0],
    emissive: [light.color.r * light.intensity, light.color.g * light.intensity, light.color.b * light.intensity],
    oneSided: true,
  });

  const normal = new THREE.Vector3(0, 0, -1).transformDirection(light.matrixWorld);
  const positions = new Float32Array(18);
  const normals = new Float32Array(18);
  [0, 1, 2, 0, 2, 3].forEach((c, i) => {
    corners[c]!.toArray(positions, i * 3);
    normal.toArray(normals, i * 3);
  });
  return { positions, normals, faceMaterial: Uint32Array.from([id, id]) };
}

/**
 * The scene as three-mesh-bvh wants it: one Mesh per bake mesh, already in world space so every
 * transform in the TLAS is the identity. The per-triangle material id rides along in `normal.w`,
 * which saves a parallel buffer — BVHComputeData interpolates and uploads normals anyway.
 */
export function bvhProxy(scene: BakeScene, lightmapUV?: Float32Array[]): THREE.Group {
  const group = new THREE.Group();
  const parts: BakeEmitter[] = [...scene.meshes, ...scene.emitters];
  for (let p = 0; p < parts.length; p++) {
    const m = parts[p]!;
    const count = m.positions.length / 3;
    const normal = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      normal[i * 4] = m.normals[i * 3];
      normal[i * 4 + 1] = m.normals[i * 3 + 1];
      normal[i * 4 + 2] = m.normals[i * 3 + 2];
      normal[i * 4 + 3] = m.faceMaterial[(i / 3) | 0];
    }
    const geometry = new THREE.BufferGeometry();
    // position stays itemSize 3 (what MeshBVH expects); the packer pads it to vec4f itself
    geometry.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 4));
    if (lightmapUV) {
      // where a bounce landed in the atlas, so the tracer can read that texel's own albedo.
      // negative = not in the atlas (an emitter quad): fall back to the material's mean.
      const uv = new Float32Array(count * 4).fill(-1);
      const source = lightmapUV[p];
      if (source) {
        for (let i = 0; i < count; i++) {
          uv[i * 4] = source[i * 2]!;
          uv[i * 4 + 1] = source[i * 2 + 1]!;
        }
      }
      geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 4));
    }
    group.add(new THREE.Mesh(geometry));
  }
  group.updateMatrixWorld(true);
  return group;
}

/** Emissive triangles, flattened into an area-light list the tracer can importance-sample. */
export type AreaLights = {
  /**
   * 4 vec4 per triangle: (a.xyz, aliasProbability) (b.xyz, aliasIndex) (c.xyz, oneSided)
   * (radiance.xyz, 1/pdf). The first two slots are Vose's alias table, so the shader picks an emitter
   * in two reads; the last is what the estimator divides that pick's probability out by.
   */
  data: Float32Array;
  count: number;
  /** the emitters' total surface area. Nothing on the GPU reads it — it is the set's size in one number. */
  totalArea: number;
};

/** how many floats one triangle of {@link AreaLights.data} takes. The shader indexes with this too. */
export const AREA_STRIDE = 16;

/**
 * Emissive triangles, ready to importance-sample: the geometry, the radiance, and an alias table over
 * the set weighted by **power** — area times luminance, not area alone. A dim emitter the same size as
 * a bright one used to be picked as often and contribute a fraction as much, which is variance the
 * bake paid for in samples.
 */
export function areaLights(scene: BakeScene): AreaLights {
  const tris: number[] = [];
  /** area * luminance per triangle: how much of the scene's light it is, which is how often it is picked */
  const weights: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let totalArea = 0;
  let count = 0;

  for (const m of [...scene.meshes, ...scene.emitters]) {
    for (let t = 0; t < m.faceMaterial.length; t++) {
      const material = scene.materials[m.faceMaterial[t]!];
      if (!material) continue;
      // the radiance is baked into the record, not looked up per sample: a textured emissive panel
      // is a different light per triangle, and the table has to weigh it that way
      const radiance = triangleRadiance(material, m, t);
      // Rec. 709, the same weights the exposure percentile uses. Any positive radiance has a positive
      // luminance, so this is the old "emits anything at all" test as well.
      const luminance = 0.2126 * radiance[0] + 0.7152 * radiance[1] + 0.0722 * radiance[2];
      if (!(luminance > 0)) continue;
      const o = t * 9;
      a.set(m.positions[o]!, m.positions[o + 1]!, m.positions[o + 2]!);
      b.set(m.positions[o + 3]!, m.positions[o + 4]!, m.positions[o + 5]!);
      c.set(m.positions[o + 6]!, m.positions[o + 7]!, m.positions[o + 8]!);
      const area = b.clone().sub(a).cross(c.clone().sub(a)).length() * 0.5;
      if (!(area > 0)) continue;
      totalArea += area;
      weights.push(area * luminance);
      count++;
      tris.push(
        a.x, a.y, a.z, 0,
        b.x, b.y, b.z, 0,
        c.x, c.y, c.z, material.oneSided ? 1 : 0,
        // the luminance is parked in the last slot until the total is known and it can become 1/pdf
        radiance[0]!, radiance[1]!, radiance[2]!, luminance,
      );
    }
  }

  const data = new Float32Array(tris);
  const { probability, alias } = aliasTable(weights);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  for (let i = 0; i < count; i++) {
    data[i * AREA_STRIDE + 3] = probability[i]!;
    data[i * AREA_STRIDE + 7] = alias[i]!;
    // p(triangle) is weight/totalWeight and the point on it is uniform over its area, so the pdf in
    // area measure is luminance/totalWeight. With one radiance across the whole set that reciprocal is
    // exactly the total area the old area-proportional pick divided by — same estimator, better weights.
    data[i * AREA_STRIDE + 15] = totalWeight / data[i * AREA_STRIDE + 15]!;
  }
  return { data, count, totalArea };
}

/**
 * Vose's alias table: bin `i` returns `i` with probability `probability[i]` and `alias[i]` otherwise,
 * which draws from `weights` in constant time. It replaces a linear walk down a cumulative-area list —
 * on a scene with a few thousand emissive triangles that walk was two thirds of the trace.
 */
function aliasTable(weights: number[]): { probability: Float64Array; alias: Uint32Array } {
  const n = weights.length;
  // 1 is the identity entry: a bin that always returns itself never reads its alias
  const probability = new Float64Array(n).fill(1);
  const alias = new Uint32Array(n);
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) return { probability, alias };

  // in units of one bin's worth, so the table is built around 1 rather than around 1/n
  const scaled = weights.map((w) => (w * n) / total);
  const small: number[] = [];
  const large: number[] = [];
  for (let i = 0; i < n; i++) (scaled[i]! < 1 ? small : large).push(i);

  while (small.length && large.length) {
    const s = small.pop()!;
    const l = large.pop()!;
    probability[s] = scaled[s]!;
    alias[s] = l;
    scaled[l] = scaled[l]! - (1 - scaled[s]!);
    (scaled[l]! < 1 ? small : large).push(l);
  }
  // whatever is left over is a full bin to within rounding, and starts out as one
  return { probability, alias };
}

/** `emissive` is the map's mean; one triangle of a textured panel gets its own texel instead. */
function triangleRadiance(material: BakeMaterial, m: BakeEmitter, t: number): [number, number, number] {
  const { emissiveMap, emissiveScale, emissive } = material;
  if (!emissiveMap || !emissiveScale || !m.uv) return emissive;
  const o = t * 6;
  const texel = sampleTexture(
    emissiveMap,
    (m.uv[o]! + m.uv[o + 2]! + m.uv[o + 4]!) / 3,
    (m.uv[o + 1]! + m.uv[o + 3]! + m.uv[o + 5]!) / 3,
  );
  return texel ? [texel[0] * emissiveScale[0], texel[1] * emissiveScale[1], texel[2] * emissiveScale[2]] : emissive;
}

/** Geometry with no normal attribute at all — flat-shade it rather than bake pitch black. */
function faceNormals(positions: Float32Array, normals: Float32Array): void {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < positions.length / 9; t++) {
    const o = t * 9;
    a.set(positions[o]!, positions[o + 1]!, positions[o + 2]!);
    b.set(positions[o + 3]!, positions[o + 4]!, positions[o + 5]!);
    c.set(positions[o + 6]!, positions[o + 7]!, positions[o + 8]!);
    b.sub(a).cross(c.sub(a)).normalize();
    for (let k = 0; k < 3; k++) {
      normals[o + k * 3] = b.x;
      normals[o + k * 3 + 1] = b.y;
      normals[o + k * 3 + 2] = b.z;
    }
  }
}

function faceMaterials(
  mesh: THREE.Mesh,
  geometry: THREE.BufferGeometry,
  triCount: number,
  materials: BakeMaterial[],
  matIds: Map<THREE.Material, number>,
  defaultAlbedo: number,
): Uint32Array {
  // collectScene() drops a mesh with an empty material list before it gets here, so `list[0]` exists —
  // a group naming a material index the list does not have is what the fallback is for
  const list = ([] as THREE.Material[]).concat(mesh.material as THREE.Material | THREE.Material[]);
  const id = (m: THREE.Material | undefined) => intern(materials, matIds, m ?? list[0]!, defaultAlbedo);
  const out = new Uint32Array(triCount).fill(id(list[0]));
  // groups survive toNonIndexed(), so a multi-material mesh keeps a material per triangle range
  if (list.length > 1) {
    for (const g of geometry.groups) {
      const from = Math.floor(g.start / 3);
      const to = Math.min(triCount, from + Math.floor(g.count / 3));
      for (let t = from; t < to; t++) out[t] = id(list[g.materialIndex ?? 0]);
    }
  }
  return out;
}

function intern(
  materials: BakeMaterial[],
  matIds: Map<THREE.Material, number>,
  material: THREE.Material,
  defaultAlbedo: number,
): number {
  const hit = matIds.get(material);
  if (hit !== undefined) return hit;
  const id = materials.length;
  matIds.set(material, id);
  materials.push(materialOf(material, defaultAlbedo));
  return id;
}

function materialOf(material: THREE.Material, defaultAlbedo: number): BakeMaterial {
  const m = material as THREE.MeshStandardMaterial;
  // `@bakery { albedo: [r, g, b] }` is the escape hatch for anything the reflectance guess gets wrong
  const override = bakerySettings<MaterialBakery>(m)?.albedo;
  let albedo: [number, number, number] = override
    ? [...override]
    : m.color
      ? [m.color.r, m.color.g, m.color.b]
      : [defaultAlbedo, defaultAlbedo, defaultAlbedo];
  // what one texel of the map is multiplied by, kept aside so an albedo atlas can use the real texel
  // where `albedo` (the map's mean) is only the fallback
  const base: [number, number, number] = [...albedo];
  if (!override && m.map) {
    const mean = meanColor(m.map);
    if (mean) albedo = [albedo[0] * mean[0], albedo[1] * mean[1], albedo[2] * mean[2]];
  }
  // a metal reflects specularly; a lambertian bake would over-brighten the room, so darken by metalness.
  // glTF writes metalness as factor × the map's blue channel and leaves the factor at 1, so reading the
  // scalar alone calls every textured material a mirror and kills the bounce entirely.
  const scale = m.metalnessMap ? (meanColor(m.metalnessMap)?.[2] ?? 1) : 1;
  const diffuse = 1 - Math.min(1, Math.max(0, (m.metalness ?? 0) * scale));
  // an override is the final reflectance, not an input to the guess -- darkening it too would make
  // `albedo: [1, 1, 1]` unreachable on any metal, and a furnace test impossible to write.
  if (!override && m.metalness !== undefined) albedo = [albedo[0] * diffuse, albedo[1] * diffuse, albedo[2] * diffuse];

  const intensity = m.emissiveIntensity ?? 1;
  // what one texel of the emissive map is multiplied by; with no map it is the radiance itself
  const emissiveScale: [number, number, number] = m.emissive
    ? [m.emissive.r * intensity, m.emissive.g * intensity, m.emissive.b * intensity]
    : [0, 0, 0];
  let emissive = emissiveScale;
  if (m.emissiveMap) {
    const mean = meanColor(m.emissiveMap);
    if (mean) emissive = [emissiveScale[0] * mean[0], emissiveScale[1] * mean[1], emissiveScale[2] * mean[2]];
  }

  // three defaults `normalMapType` to tangent space, and an object-space map would need the mesh's
  // normal matrix — which a texel, being a point in an atlas shared by every mesh, no longer has
  const normalMap = m.normalMap && (m.normalMapType ?? THREE.TangentSpaceNormalMap) === THREE.TangentSpaceNormalMap;
  const normalScale: [number, number] = [m.normalScale?.x ?? 1, m.normalScale?.y ?? 1];

  const coverage = coverageOf(m);
  return {
    albedo: albedo.map((c) => Math.min(1, Math.max(0, c))) as [number, number, number],
    emissive,
    ...(normalMap ? { normalMap: m.normalMap!, normalScale } : {}),
    ...(m.emissiveMap ? { emissiveMap: m.emissiveMap, emissiveScale } : {}),
    ...(coverage < 1 ? { coverage } : {}),
    ...(override || !m.map ? {} : { map: m.map, mapScale: base.map((c) => c * diffuse) as [number, number, number] }),
  };
}

/**
 * How much of a shadow ray this material stops. A glass pane, a fence texture and a scrim all used to
 * cast the shadow of a solid wall.
 * ponytail: one number per material, from `opacity` and the map's mean alpha — no per-texel cutout in
 * the shadow ray. A leaf card reads as uniform haze; sample the alpha map in `lm_visibility` if that
 * ever shows.
 */
function coverageOf(m: THREE.MeshStandardMaterial): number {
  let coverage = m.transparent ? Math.min(1, Math.max(0, m.opacity ?? 1)) : 1;
  // glTF glass (KHR_materials_transmission) states `transmission` and leaves `transparent` false: an
  // opaque-looking pane that light goes straight through
  const transmission = (m as THREE.MeshPhysicalMaterial).transmission ?? 0;
  coverage *= 1 - Math.min(1, Math.max(0, transmission));
  // three reads alphaMap's green channel and map's alpha; a cutout leaves `transparent` false and
  // states an alphaTest instead
  if (m.alphaMap) coverage *= meanColor(m.alphaMap)?.[1] ?? 1;
  else if ((m.transparent || (m.alphaTest ?? 0) > 0) && m.map) coverage *= meanColor(m.map)?.[3] ?? 1;
  return coverage;
}

/**
 * One texel of a texture, linear, nearest neighbour, wrapping. The albedo atlas is built on the CPU
 * from whatever the loader put in `image.data` — a browser `ImageBitmap` has none, so there it stays
 * on the per-material mean.
 * ponytail: nearest and no uv transform. Both matter far less than the fact that it is per texel now.
 */
export function sampleTexture(texture: THREE.Texture, u: number, v: number): [number, number, number] | undefined {
  const image = texture.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
  const data = image?.data;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (!data || !width || !height || data.length < width * height * 4) return undefined;
  const wrap = (x: number, n: number) => ((Math.floor(x * n) % n) + n) % n;
  const o = (wrap(1 - v, height) * width + wrap(u, width)) * 4;
  if (data instanceof Float32Array) return [data[o]!, data[o + 1]!, data[o + 2]!];
  const srgb = texture.colorSpace === THREE.SRGBColorSpace;
  const channel = (k: number) => (srgb ? SRGB_TO_LINEAR[data[o + k]! & 255]! : data[o + k]! / 255);
  return [channel(0), channel(1), channel(2)];
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

/** at most this many texels are read for a mean — a 4K map is 16M of them and this is one average. */
const MEAN_SAMPLES = 4096;

/**
 * Mean linear value of a texture, rgb + alpha — the fallback for a texel the albedo atlas could not
 * cover (no uv0, no decoded image), and what metalness and coverage are read out of.
 * ponytail: strides to {@link MEAN_SAMPLES} texels. A stride that lands on the same column of every
 * tile of a repeating texture would read one stripe; make the step coprime with the width if that
 * ever shows up.
 */
export function meanColor(texture: THREE.Texture): [number, number, number, number] | undefined {
  const image = texture.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
  const data = image?.data;
  if (!data || data.length < 4) return undefined;
  // only an explicitly sRGB texture gets decoded. glTF leaves a metalnessMap on NoColorSpace, and
  // decoding that raw channel as sRGB used to under-read metalness by a factor of three.
  const srgb = texture.colorSpace === THREE.SRGBColorSpace;
  const byte = !(data instanceof Float32Array);
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let n = 0;
  const px = Math.floor(data.length / 4);
  const stride = Math.max(1, Math.floor(px / MEAN_SAMPLES));
  for (let i = 0; i < px; i += stride) {
    const o = i * 4;
    if (byte && srgb) {
      r += SRGB_TO_LINEAR[data[o]! & 255]!;
      g += SRGB_TO_LINEAR[data[o + 1]! & 255]!;
      b += SRGB_TO_LINEAR[data[o + 2]! & 255]!;
    } else if (byte) {
      r += data[o]! / 255;
      g += data[o + 1]! / 255;
      b += data[o + 2]! / 255;
    } else {
      r += data[o]!;
      g += data[o + 1]!;
      b += data[o + 2]!;
    }
    // alpha is never colour-encoded, so it is the raw channel either way
    a += byte ? data[o + 3]! / 255 : data[o + 3]!;
    n++;
  }
  return [r / n, g / n, b / n, a / n];
}

function collectLight(light: THREE.Light, lights: BakeLight[], sky: BakeSky): void {
  const color: [number, number, number] = [
    light.color.r * light.intensity,
    light.color.g * light.intensity,
    light.color.b * light.intensity,
  ];
  const l = light as THREE.SpotLight & THREE.HemisphereLight & { target?: THREE.Object3D };

  // three adds ambient/hemisphere straight to irradiance, so the equivalent sky radiance is E / PI
  if ((light as THREE.AmbientLight).isAmbientLight) {
    for (let i = 0; i < 3; i++) {
      sky.up[i]! += color[i]! / Math.PI;
      sky.down[i]! += color[i]! / Math.PI;
    }
    return;
  }
  if ((light as THREE.HemisphereLight).isHemisphereLight) {
    const g = l.groundColor;
    for (let i = 0; i < 3; i++) {
      sky.up[i]! += color[i]! / Math.PI;
      sky.down[i]! += (([g.r, g.g, g.b][i] as number) * light.intensity) / Math.PI;
    }
    light.updateMatrixWorld(true);
    const p = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld).normalize();
    if (p.lengthSq() > 1e-12) sky.axis = [p.x, p.y, p.z];
    return;
  }

  const isDirectional = (light as THREE.DirectionalLight).isDirectionalLight === true;
  const isSpot = (light as THREE.SpotLight).isSpotLight === true;
  const isPoint = (light as THREE.PointLight).isPointLight === true;
  if (!isDirectional && !isSpot && !isPoint) return; // RectAreaLight and friends: use an emissive mesh instead

  light.updateMatrixWorld(true);
  const position = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
  const direction = new THREE.Vector3(0, -1, 0);
  if (isDirectional || isSpot) {
    const target = l.target ?? new THREE.Object3D();
    target.updateMatrixWorld(true);
    direction.setFromMatrixPosition(target.matrixWorld).sub(position);
    if (direction.lengthSq() < 1e-12) direction.set(0, -1, 0);
    direction.normalize();
  }
  const angle = isSpot ? l.angle : 0;
  const penumbra = isSpot ? l.penumbra : 0;

  lights.push({
    kind: isDirectional ? 0 : isSpot ? 2 : 1,
    color,
    position: [position.x, position.y, position.z],
    direction: [direction.x, direction.y, direction.z],
    distance: isDirectional ? 0 : ((light as THREE.PointLight).distance ?? 0),
    decay: isDirectional ? 2 : ((light as THREE.PointLight).decay ?? 2),
    cosOuter: Math.cos(angle),
    cosInner: Math.cos(angle * (1 - penumbra)),
    // `@bakery { radius }` turns a delta light into a sphere light — the only way to get soft baked shadows
    radius: Math.max(0, bakerySettings<NodeBakery>(light)?.radius ?? 0),
  });
}
