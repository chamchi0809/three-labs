// Scene -> flat bake input: world-space triangle soup, materials, lights, sky.
import * as THREE from "three/webgpu";
import type { MaterialBakery, NodeBakery, SceneBakery } from "../names.ts";

/** One bakeable mesh, de-indexed so every triangle corner owns its own vertex (and its own lightmap uv). */
export type BakeMesh = {
  /** stable path from the bake root — the key both the manifest and applyLightmap() use */
  key: string;
  mesh: THREE.Mesh;
  /** world-space, 3 floats per vertex, vertexCount = triCount * 3 */
  positions: Float32Array;
  normals: Float32Array;
  /** per-triangle material index into BakeScene.materials */
  faceMaterial: Uint32Array;
};

export type BakeMaterial = {
  /** linear diffuse reflectance, what bounced light is multiplied by */
  albedo: [number, number, number];
  /** linear radiance emitted by this surface (W/sr/m²) — becomes an area light */
  emissive: [number, number, number];
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

/** Ambient + hemisphere lights collapse into a two-colour gradient that rays see when they escape. */
export type BakeSky = {
  /** radiance looking along +axis */
  up: [number, number, number];
  down: [number, number, number];
  axis: [number, number, number];
};

export type BakeScene = {
  meshes: BakeMesh[];
  materials: BakeMaterial[];
  lights: BakeLight[];
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

/** Path from `root` to `o`, using node names where there are any. Stable across reloads of the same sheet. */
export function nodeKey(root: THREE.Object3D, o: THREE.Object3D): string {
  const parts: string[] = [];
  for (let n: THREE.Object3D | null = o; n && n !== root; n = n.parent) {
    parts.unshift(n.name || `@${n.parent ? n.parent.children.indexOf(n) : 0}`);
  }
  return parts.join("/");
}

/** What a sheet's `@bakery { … }` block left on the object it was written in. */
export const bakerySettings = <T extends NodeBakery | MaterialBakery | SceneBakery>(o: object | undefined): T | undefined =>
  (o as { bakery?: T } | undefined)?.bakery;

/**
 * Whether `o` is in the bake: its own `@bakery { enabled }`, or the nearest ancestor that states one.
 * `undefined` means nobody said, and the sheet's `include` decides.
 */
export function bakeEnabled(o: THREE.Object3D): boolean | undefined {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) {
    const enabled = bakerySettings<NodeBakery>(n)?.enabled;
    if (enabled !== undefined) return enabled;
  }
  return undefined;
}

export type CollectOptions = {
  /** default albedo for materials without a `color` (linear grey) */
  defaultAlbedo?: number;
  /**
   * `all` (the default) bakes every visible mesh except the ones that turn themselves off; `none`
   * bakes only the ones that opt in. Defaults to the root's own `@bakery { include }`.
   */
  include?: "all" | "none";
};

/** Walks the scene once and flattens everything the path tracer needs. Does not mutate `root`. */
export function collectScene(root: THREE.Object3D, opts: CollectOptions = {}): BakeScene {
  root.updateMatrixWorld(true);

  const meshes: BakeMesh[] = [];
  const materials: BakeMaterial[] = [];
  const lights: BakeLight[] = [];
  const bounds = new THREE.Box3();
  const matIds = new Map<THREE.Material, number>();
  const sky: BakeSky = { up: [0, 0, 0], down: [0, 0, 0], axis: [0, 1, 0] };

  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const lightDir = new THREE.Vector3();

  const byDefault = (opts.include ?? bakerySettings<SceneBakery>(root)?.include ?? "all") === "all";

  root.traverse((o) => {
    if (!o.visible) return;
    const enabled = bakeEnabled(o);
    // a light is an input, not a receiver: `include: none` picks the meshes to bake, and only an
    // explicit `@bakery { enabled: false }` takes a light out (it stays live at runtime instead)
    if ((o as THREE.Light).isLight) return enabled === false ? undefined : collectLight(o as THREE.Light, lights, sky);
    if (!(enabled ?? byDefault)) return;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;

    const geometry = bakeGeometry(mesh);
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    if (!position || position.count % 3 !== 0) return;

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

    meshes.push({
      key: nodeKey(root, mesh),
      mesh,
      positions,
      normals,
      faceMaterial: faceMaterials(mesh, geometry, count / 3, materials, matIds, opts.defaultAlbedo ?? 0.8),
    });
  });

  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  // a scene with no ambient at all still needs an axis for the sky gradient
  lightDir.set(sky.axis[0], sky.axis[1], sky.axis[2]);
  if (lightDir.lengthSq() < 1e-12) sky.axis = [0, 1, 0];

  return { meshes, materials, lights, sky, bounds };
}

/**
 * The scene as three-mesh-bvh wants it: one Mesh per bake mesh, already in world space so every
 * transform in the TLAS is the identity. The per-triangle material id rides along in `normal.w`,
 * which saves a parallel buffer — BVHComputeData interpolates and uploads normals anyway.
 */
export function bvhProxy(scene: BakeScene): THREE.Group {
  const group = new THREE.Group();
  for (const m of scene.meshes) {
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
    group.add(new THREE.Mesh(geometry));
  }
  group.updateMatrixWorld(true);
  return group;
}

/** Emissive triangles, flattened into an area-light list the tracer can importance-sample. */
export type AreaLights = {
  /** 3 vec4 per triangle: (a.xyz, cumulativeArea) (b.xyz, area) (c.xyz, materialId) */
  data: Float32Array;
  count: number;
  totalArea: number;
};

export function areaLights(scene: BakeScene): AreaLights {
  const tris: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let totalArea = 0;
  let count = 0;

  for (const m of scene.meshes) {
    for (let t = 0; t < m.faceMaterial.length; t++) {
      const emissive = scene.materials[m.faceMaterial[t]]?.emissive;
      if (!emissive || emissive[0] + emissive[1] + emissive[2] <= 0) continue;
      const o = t * 9;
      a.set(m.positions[o], m.positions[o + 1], m.positions[o + 2]);
      b.set(m.positions[o + 3], m.positions[o + 4], m.positions[o + 5]);
      c.set(m.positions[o + 6], m.positions[o + 7], m.positions[o + 8]);
      const area = b.clone().sub(a).cross(c.clone().sub(a)).length() * 0.5;
      if (!(area > 0)) continue;
      totalArea += area;
      count++;
      tris.push(a.x, a.y, a.z, totalArea, b.x, b.y, b.z, area, c.x, c.y, c.z, m.faceMaterial[t]);
    }
  }
  return { data: new Float32Array(tris), count, totalArea };
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
  const list = ([] as THREE.Material[]).concat(mesh.material as THREE.Material | THREE.Material[]);
  const id = (m: THREE.Material | undefined) => {
    if (!m) return intern(materials, matIds, list[0]!, defaultAlbedo);
    return intern(materials, matIds, m, defaultAlbedo);
  };
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
  const emissive: [number, number, number] = m.emissive
    ? [m.emissive.r * intensity, m.emissive.g * intensity, m.emissive.b * intensity]
    : [0, 0, 0];
  return { albedo: albedo.map((c) => Math.min(1, Math.max(0, c))) as [number, number, number], emissive };
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

/**
 * Mean linear reflectance of an albedo map.
 * ponytail: one colour per texture, not per-texel — colour bleeding gets the map's hue but not its
 * pattern. Sampling the real texture means an albedo atlas on the GPU; set `@bakery { albedo }` until then.
 */
function meanColor(texture: THREE.Texture): [number, number, number] | undefined {
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
  const px = Math.floor(data.length / 4);
  for (let i = 0; i < px; i++) {
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
  }
  return [r / px, g / px, b / px];
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
