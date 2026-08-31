/**
 * The map, on its way out to something that is not an editor.
 *
 * Two formats, for two different reasons. **OBJ** is the format every tool on earth will open, and what it
 * carries is the shape — triangles, normals, texture coordinates, and which material each face wanted.
 * **glTF** carries the same geometry plus the things OBJ has no words for: a material's roughness and
 * metalness, and the map's lights.
 *
 * Neither is a save. A tscene sheet is what this editor reads back; an export is a copy for somebody else,
 * and the round-trip stops here on purpose — an exported mesh has already forgotten which planes its solids
 * were made of, and reading one back in would turn a brush map into a soup of triangles.
 *
 * Geometry goes out in the document's own units. `@broom { scale }` says how many of them are in a metre
 * but nothing in the editor multiplies by it, and an exporter that quietly did would be the only thing in
 * the program that disagreed about where a wall is.
 */
import { brushToMesh, type Brush } from "../brush/brush.ts";
import type { Catalogue, MaterialDef } from "../doc/catalogue.ts";
import { childrenOf, type Node, type World } from "../doc/document.ts";
import { patchToMesh } from "../patch/patch.ts";
import { asColour, numberOf, valueOf, vec3Of } from "../doc/props.ts";

/** the default material name, for a face that never named one */
const UNNAMED = "default";

/** one material's worth of triangles, in the order they came off the solids */
export type Surface = {
  material: string;
  /** triangle soup: three vertices per triangle, no index buffer, because brush faces share nothing */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
};

/** a light the map has, in the terms both three.js and glTF happen to agree on */
export type ExportLight = {
  kind: "point" | "spot" | "directional";
  name: string;
  position: [number, number, number];
  /** what a spot or a directional is pointed at; nothing for a point light */
  target?: [number, number, number];
  colour: number;
  intensity: number;
  /** metres a point or spot light reaches; zero for no limit, which is glTF's "absent" */
  range: number;
  /** the cone's outer half-angle in radians, for a spot */
  angle?: number;
  penumbra?: number;
};

export type Exported = { surfaces: Surface[]; lights: ExportLight[]; problems: string[] };

export type ExportOptions = {
  /** whether nodes a designer has hidden go out too; they do not, by default */
  hidden?: boolean;
};

// ---------------------------------------------------------------- reading the map

/** a face's material, falling back to the one name a viewer will not choke on */
const materialOf = (brush: Brush, face: number): string => brush.faces[face]?.material || UNNAMED;

/**
 * A colour as the sheet may have written it: `color(#ff8040)`, `0xff8040`, `#ff8040`, or a quoted one.
 *
 * Not `numberOf`, because the spellings are the same colour and a light that came out black in an export
 * because its sheet used one of them would be a bug nobody could see the cause of.
 */
function colourProp(node: Node, name: string): number | undefined {
  const value = valueOf(node.props, name);
  if (!value) return undefined;
  const literal = asColour(value);
  if (literal !== undefined) return literal;
  if (value.kind === "string") {
    const parsed = Number.parseInt(value.value.replace("#", ""), 16);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** which of the three punctual lights an entity is, if it is one at all */
const LIGHT_KINDS: Record<string, ExportLight["kind"]> = {
  pointLight: "point",
  spotLight: "spot",
  directionalLight: "directional",
};

/**
 * Everything an exporter needs, in one walk.
 *
 * Hiding is inherited, so it is carried down rather than asked per node — the same reason the renderer's
 * own walk carries it. A hidden wall is a wall the designer took out of the picture, and putting it in the
 * file anyway would make "hide" mean nothing the moment anyone exported.
 */
export function readForExport(world: World, options: ExportOptions = {}): Exported {
  const bins = new Map<string, { positions: number[]; normals: number[]; uvs: number[] }>();
  const lights: ExportLight[] = [];
  const problems: string[] = [];

  const visit = (node: Node, hidden: boolean): void => {
    const out = hidden || node.broom.hidden === true;
    if (out && !options.hidden) return;

    if (node.kind === "brush") {
      const { mesh, problems: bad } = brushToMesh(node.brush);
      if (!mesh) {
        problems.push(...bad.map((p) => `${node.id}: ${p}`));
        return;
      }
      for (const group of mesh.groups) {
        const name = materialOf(node.brush, group.face);
        const bin = bins.get(name) ?? bins.set(name, { positions: [], normals: [], uvs: [] }).get(name)!;
        for (let i = group.start; i < group.start + group.count; i++) {
          bin.positions.push(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
          bin.normals.push(mesh.normals[i * 3]!, mesh.normals[i * 3 + 1]!, mesh.normals[i * 3 + 2]!);
          bin.uvs.push(mesh.uvs[i * 2]!, mesh.uvs[i * 2 + 1]!);
        }
      }
      return;
    }

    // a patch's mesh is indexed and a brush's is not, so the shared vertices are written out per corner
    // here. The bins are loose triples on purpose — an exporter that takes an index buffer can rebuild one,
    // and merging two meshes that each number their own vertices is the bug this avoids having
    if (node.kind === "patch") {
      const { mesh, problems: bad } = patchToMesh(node.patch);
      if (!mesh) {
        problems.push(...bad.map((p) => `${node.id}: ${p}`));
        return;
      }
      const name = node.patch.material || UNNAMED;
      const bin = bins.get(name) ?? bins.set(name, { positions: [], normals: [], uvs: [] }).get(name)!;
      for (const i of mesh.indices) {
        bin.positions.push(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
        bin.normals.push(mesh.normals[i * 3]!, mesh.normals[i * 3 + 1]!, mesh.normals[i * 3 + 2]!);
        bin.uvs.push(mesh.uvs[i * 2]!, mesh.uvs[i * 2 + 1]!);
      }
      return;
    }

    if (node.kind === "entity") {
      const kind = LIGHT_KINDS[node.type];
      if (kind) {
        lights.push({
          kind,
          name: node.id,
          position: vec3Of(node.props, "position") ?? [0, 0, 0],
          target: vec3Of(node.props, "target"),
          colour: colourProp(node, "color") ?? 0xffffff,
          intensity: numberOf(node.props, "intensity") ?? 1,
          range: numberOf(node.props, "distance") ?? 0,
          angle: kind === "spot" ? (numberOf(node.props, "angle") ?? Math.PI / 6) : undefined,
          penumbra: kind === "spot" ? (numberOf(node.props, "penumbra") ?? 0) : undefined,
        });
      }
      // every other entity is a marker for a game to read out of the sheet, and a mesh format has no
      // word for one. It stays in the tscene, which is where anything that reads it will be looking.
      return;
    }

    for (const kid of childrenOf(node)) visit(kid, out);
  };

  for (const layer of world.layers) visit(layer, false);

  const surfaces = [...bins]
    .map(([material, bin]) => ({
      material,
      positions: new Float32Array(bin.positions),
      normals: new Float32Array(bin.normals),
      uvs: new Float32Array(bin.uvs),
    }))
    .filter((s) => s.positions.length > 0)
    // by name, so exporting the same map twice produces the same file — a diff of two exports should be a
    // diff of the map, not of whichever solid happened to be walked first
    .sort((a, b) => (a.material < b.material ? -1 : a.material > b.material ? 1 : 0));

  return { surfaces, lights, problems };
}

// ---------------------------------------------------------------- OBJ

const defOf = (catalogue: Catalogue, name: string): MaterialDef | undefined =>
  catalogue.materials.find((m) => m.name === name);

/** a colour as OBJ and glTF both want it: three numbers from zero to one, sRGB as the sheet wrote it */
const rgb = (colour: number): [number, number, number] => [
  ((colour >> 16) & 255) / 255,
  ((colour >> 8) & 255) / 255,
  (colour & 255) / 255,
];

const round = (n: number): string => (Object.is(n, -0) ? "0" : String(Math.round(n * 1e6) / 1e6));

/**
 * The map as an OBJ, and the MTL beside it.
 *
 * One `o` per material rather than one per solid: a solid is an editing idea and an OBJ group is a drawing
 * idea, and everything that opens an OBJ wants the second. Vertices are written flat with no reuse — brush
 * faces meet at hard edges with different normals and different texture coordinates, so there is nothing
 * for two of them to share, and searching for shares that do not exist would only make exporting slow.
 */
export function toObj(
  exported: Exported,
  catalogue: Catalogue,
  mtlName: string,
): { obj: string; mtl: string } {
  const obj: string[] = ["# three-broom", `mtllib ${mtlName}`, ""];
  let written = 0;

  for (const surface of exported.surfaces) {
    const count = surface.positions.length / 3;
    obj.push(`o ${surface.material}`);
    for (let i = 0; i < count; i++) {
      obj.push(`v ${round(surface.positions[i * 3]!)} ${round(surface.positions[i * 3 + 1]!)} ${round(surface.positions[i * 3 + 2]!)}`);
    }
    for (let i = 0; i < count; i++) {
      obj.push(`vn ${round(surface.normals[i * 3]!)} ${round(surface.normals[i * 3 + 1]!)} ${round(surface.normals[i * 3 + 2]!)}`);
    }
    // OBJ measures a texture from the bottom left and everything else here measures from the top, which is
    // one subtraction and a decade of people wondering why their walls are upside down
    for (let i = 0; i < count; i++) {
      obj.push(`vt ${round(surface.uvs[i * 2]!)} ${round(1 - surface.uvs[i * 2 + 1]!)}`);
    }
    obj.push(`usemtl ${surface.material}`);
    for (let i = 0; i < count; i += 3) {
      const a = written + i + 1;
      obj.push(`f ${a}/${a}/${a} ${a + 1}/${a + 1}/${a + 1} ${a + 2}/${a + 2}/${a + 2}`);
    }
    obj.push("");
    written += count;
  }

  const mtl: string[] = ["# three-broom", ""];
  for (const surface of exported.surfaces) {
    const def = defOf(catalogue, surface.material);
    const [r, g, b] = rgb(def?.colour ?? 0xffffff);
    mtl.push(`newmtl ${surface.material}`);
    mtl.push(`Kd ${round(r)} ${round(g)} ${round(b)}`);
    // OBJ has no roughness, so the nearest true thing is said instead: a rough surface is not shiny
    mtl.push(`Ns ${round((1 - (def?.roughness ?? 1)) * 900 + 1)}`);
    mtl.push("illum 2");
    if (def?.maps.map) mtl.push(`map_Kd ${def.maps.map}`);
    mtl.push("");
  }

  return { obj: obj.join("\n"), mtl: mtl.join("\n") };
}

// ---------------------------------------------------------------- glTF

type Json = Record<string, unknown>;

const align4 = (n: number): number => (n + 3) & ~3;

/**
 * The map as a binary glTF.
 *
 * `.glb` rather than `.gltf` because a glTF is three files that have to stay together and a glb is one
 * file that cannot be separated. The only thing left outside it is a texture: the sheet names them by url
 * and those urls are the project's, so they go out as written rather than as bytes nobody asked to copy.
 *
 * The axes need no conversion. glTF is right-handed, Y up, and metres; so is this editor, on purpose.
 */
export function toGlb(exported: Exported, catalogue: Catalogue): ArrayBuffer {
  const bufferViews: Json[] = [];
  const accessors: Json[] = [];
  const chunks: Float32Array[] = [];
  let offset = 0;

  const put = (data: Float32Array, kind: "VEC3" | "VEC2", bounds: boolean): number => {
    const byteLength = data.byteLength;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength, target: 34962 });
    chunks.push(data);
    offset = align4(offset + byteLength);

    const size = kind === "VEC3" ? 3 : 2;
    const accessor: Json = {
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: data.length / size,
      type: kind,
    };
    if (bounds) {
      // glTF requires min/max on a position accessor: it is what a viewer frames the scene from
      const min = Array.from({ length: size }, () => Infinity);
      const max = Array.from({ length: size }, () => -Infinity);
      for (let i = 0; i < data.length; i++) {
        const axis = i % size;
        if (data[i]! < min[axis]!) min[axis] = data[i]!;
        if (data[i]! > max[axis]!) max[axis] = data[i]!;
      }
      accessor.min = min;
      accessor.max = max;
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };

  const images: Json[] = [];
  const textures: Json[] = [];
  const materials: Json[] = [];
  const primitives: Json[] = [];

  for (const surface of exported.surfaces) {
    const position = put(surface.positions, "VEC3", true);
    const normal = put(surface.normals, "VEC3", false);
    const uv = put(surface.uvs, "VEC2", false);

    const def = defOf(catalogue, surface.material);
    const [r, g, b] = rgb(def?.colour ?? 0xffffff);
    const pbr: Json = {
      baseColorFactor: [r, g, b, 1],
      metallicFactor: def?.metalness ?? 0,
      roughnessFactor: def?.roughness ?? 1,
    };
    if (def?.maps.map) {
      images.push({ uri: def.maps.map });
      textures.push({ source: images.length - 1 });
      pbr.baseColorTexture = { index: textures.length - 1 };
    }
    materials.push({ name: surface.material, pbrMetallicRoughness: pbr, doubleSided: false });

    primitives.push({
      attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv },
      material: materials.length - 1,
      mode: 4,
    });
  }

  const nodes: Json[] = [];
  const roots: number[] = [];
  const meshes: Json[] = [];
  if (primitives.length) {
    meshes.push({ name: "map", primitives });
    nodes.push({ name: "map", mesh: 0 });
    roots.push(nodes.length - 1);
  }

  const punctual: Json[] = [];
  for (const light of exported.lights) {
    const entry: Json = {
      type: light.kind,
      name: light.name,
      color: rgb(light.colour),
      intensity: light.intensity,
    };
    if (light.kind !== "directional" && light.range > 0) entry.range = light.range;
    if (light.kind === "spot") {
      entry.spot = {
        innerConeAngle: (light.angle ?? 0) * (1 - (light.penumbra ?? 0)),
        outerConeAngle: light.angle ?? Math.PI / 4,
      };
    }
    punctual.push(entry);

    const node: Json = {
      name: light.name,
      translation: light.position,
      extensions: { KHR_lights_punctual: { light: punctual.length - 1 } },
    };
    // a glTF light points down its own -Z, so where it is aimed has to become a rotation
    if (light.target) node.rotation = aimedAt(light.position, light.target);
    nodes.push(node);
    roots.push(nodes.length - 1);
  }

  const json: Json = {
    asset: { version: "2.0", generator: "three-broom" },
    scene: 0,
    scenes: [{ nodes: roots }],
    nodes,
    buffers: [{ byteLength: offset }],
  };
  if (meshes.length) {
    json.meshes = meshes;
    json.materials = materials;
    json.accessors = accessors;
    json.bufferViews = bufferViews;
  }
  if (images.length) {
    json.images = images;
    json.textures = textures;
  }
  if (punctual.length) {
    json.extensionsUsed = ["KHR_lights_punctual"];
    json.extensions = { KHR_lights_punctual: { lights: punctual } };
  }

  return glb(json, chunks, offset);
}

/**
 * The quaternion that turns -Z towards a target.
 *
 * Written out rather than borrowed from three because this file has no scene in it and does not want one:
 * an exporter that had to build an `Object3D` to work out an angle would be an exporter that could not run
 * without a GPU.
 */
function aimedAt(
  from: [number, number, number],
  to: [number, number, number],
): [number, number, number, number] {
  const d: [number, number, number] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(...d);
  if (!length) return [0, 0, 0, 1];
  // the rotation taking (0, 0, -1) to the unit direction, as an axis-angle turned into a quaternion
  const f: [number, number, number] = [-d[0] / length, -d[1] / length, -d[2] / length];
  const dot = f[2]; // (0, 0, 1) · f
  if (dot > 0.999999) return [0, 0, 0, 1];
  if (dot < -0.999999) return [0, 1, 0, 0]; // half a turn, about any perpendicular axis
  const axis: [number, number, number] = [-f[1], f[0], 0]; // (0, 0, 1) × f
  const axisLength = Math.hypot(...axis);
  const angle = Math.acos(dot);
  const s = Math.sin(angle / 2) / axisLength;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** the container: a header, the JSON, and the bytes, each padded to four */
function glb(json: Json, chunks: Float32Array[], binLength: number): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(text.length);
  const total = 12 + 8 + jsonLength + (binLength ? 8 + binLength : 0);

  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);

  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  bytes.set(text, 20);
  // JSON is padded with spaces and the binary chunk with zeros, which is the spec's own distinction
  bytes.fill(0x20, 20 + text.length, 20 + jsonLength);

  if (binLength) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, 0x004e4942, true); // "BIN\0"
    let cursor = at + 8;
    for (const chunk of chunks) {
      bytes.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), cursor);
      cursor = at + 8 + align4(cursor - at - 8 + chunk.byteLength);
    }
  }

  return out;
}
