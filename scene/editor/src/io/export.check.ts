// Getting a map out to somebody else: OBJ for anything that opens a mesh, glTF for the things OBJ has no
// words for. What is checked here is mostly arithmetic — indices, offsets, chunk lengths — because those
// are the parts that go wrong silently, in a file that opens and looks very nearly right.
// Run with: node --experimental-strip-types src/io/export.check.ts
import assert from "node:assert/strict";
import { report, test } from "../check.ts";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import type { Catalogue } from "../doc/catalogue.ts";
import { brushNode, emptyWorld, entityNode, groupNode, type Node, type World } from "../doc/document.ts";
import { hex, num, setNumber, setProp, setVec3, str } from "../doc/props.ts";
import type { Value } from "tscene";
import { readForExport, toGlb, toObj } from "./export.ts";

const CATALOGUE: Catalogue = {
  entities: [],
  materials: [
    {
      name: "wall", type: "meshStandardMaterial",
      colour: 0x804020, roughness: 0.8, metalness: 0, maps: { map: "walls/brick.png" },
    },
    {
      name: "floor", type: "meshStandardMaterial",
      colour: 0x203040, roughness: 0.4, metalness: 0.25, maps: {},
    },
  ],
};

const box = (material?: string, size = 2): Node =>
  brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [size, size, size] }), material ? { material } : {}));

/** a map with these in its one layer — the shape everything below is exported from */
const worldOf = (...children: Node[]): World => {
  const empty = emptyWorld();
  return { ...empty, layers: [{ ...empty.layers[0]!, children }] };
};

const jsonLengthOf = (glb: ArrayBuffer): number => new DataView(glb).getUint32(12, true);
const jsonOf = (glb: ArrayBuffer): Record<string, any> =>
  JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLengthOf(glb))));

// ---------------------------------------------------------------- what comes off the map

test("a cuboid is twelve triangles under the material its faces named", () => {
  const { surfaces, problems } = readForExport(worldOf(box("wall")));
  assert.deepEqual(problems, []);
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0]!.material, "wall");
  assert.equal(surfaces[0]!.positions.length / 3, 36, "six sides, two triangles each, three corners each");
  assert.equal(surfaces[0]!.normals.length, surfaces[0]!.positions.length);
  assert.equal(surfaces[0]!.uvs.length / 2, 36);
});

test("solids are gathered by material, not by solid, and always in the same order", () => {
  const one = readForExport(worldOf(box("wall"), box("floor"), box("wall")));
  const other = readForExport(worldOf(box("floor"), box("wall"), box("wall")));
  assert.deepEqual(one.surfaces.map((s) => s.material), ["floor", "wall"]);
  assert.deepEqual(other.surfaces.map((s) => s.material), ["floor", "wall"]);
  assert.equal(one.surfaces[1]!.positions.length / 3, 72, "the two walls are one surface between them");
});

test("a face that never named a material still lands somewhere a viewer can read", () => {
  assert.deepEqual(readForExport(worldOf(box())).surfaces.map((s) => s.material), ["default"]);
});

test("hidden is hidden, and inherited, unless the export is asked for it", () => {
  const group = groupNode("Cellar", [box("wall")], { broom: { hidden: true } });
  assert.deepEqual(readForExport(worldOf(group)).surfaces, [], "a hidden group takes its solids with it");
  assert.equal(readForExport(worldOf(group), { hidden: true }).surfaces.length, 1);
});

// ---------------------------------------------------------------- OBJ

test("obj vertices are numbered from one and go on counting across materials", () => {
  const { obj } = toObj(readForExport(worldOf(box("wall"), box("floor"))), CATALOGUE, "map.mtl");
  const lines = obj.split("\n");

  assert.equal(lines.filter((l) => l.startsWith("v ")).length, 72);
  assert.equal(lines.filter((l) => l.startsWith("vn ")).length, 72);
  assert.equal(lines.filter((l) => l.startsWith("f ")).length, 24, "twelve triangles a box");
  assert.deepEqual(obj.match(/^o .*/gm), ["o floor", "o wall"]);

  const faces = lines.filter((l) => l.startsWith("f "));
  assert.equal(faces[0], "f 1/1/1 2/2/2 3/3/3", "one-based, and never zero");
  // the second material's first triangle starts after the first material's thirty-six vertices
  assert.equal(faces[12], "f 37/37/37 38/38/38 39/39/39");
  assert.equal(faces[23], "f 70/70/70 71/71/71 72/72/72", "and the last one lands exactly on the end");
});

test("obj texture coordinates are measured from the bottom, which is not where they were measured from", () => {
  const exported = readForExport(worldOf(box("wall")));
  const { obj } = toObj(exported, CATALOGUE, "map.mtl");
  const first = obj.match(/^vt (\S+) (\S+)$/m)!;
  assert.equal(Number(first[1]), exported.surfaces[0]!.uvs[0]);
  assert.equal(Number(first[2]), 1 - exported.surfaces[0]!.uvs[1]!);
});

test("the mtl says what the sheet said, in the words obj has for it", () => {
  const { obj, mtl } = toObj(readForExport(worldOf(box("wall"))), CATALOGUE, "hall.mtl");
  assert.match(obj, /^mtllib hall\.mtl$/m);
  assert.match(mtl, /^newmtl wall$/m);
  assert.match(mtl, /^Kd 0\.501961 0\.25098 0\.12549$/m);
  assert.match(mtl, /^Ns 181$/m, "rough is not shiny");
  assert.match(mtl, /^map_Kd walls\/brick\.png$/m);
});

test("a material the catalogue never heard of is still written, so the file is not short a name", () => {
  const { mtl } = toObj(readForExport(worldOf(box("mystery"))), CATALOGUE, "hall.mtl");
  assert.match(mtl, /^newmtl mystery$/m);
  assert.match(mtl, /^Kd 1 1 1$/m);
  assert.equal(mtl.includes("map_Kd"), false);
});

// ---------------------------------------------------------------- glTF

test("a glb is a glb: the magic, the version, and a length that is its own", () => {
  const glb = toGlb(readForExport(worldOf(box("wall"))), CATALOGUE);
  const view = new DataView(glb);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(view.getUint32(8, true), glb.byteLength);
  assert.equal(glb.byteLength % 4, 0, "every chunk is padded to four, so the file is a multiple of it");
  assert.equal(view.getUint32(16, true), 0x4e4f534a, "the first chunk is the JSON one");
  assert.equal(jsonLengthOf(glb) % 4, 0);
});

test("the glb's accessors describe the buffer it actually contains", () => {
  const glb = toGlb(readForExport(worldOf(box("wall"), box("floor"))), CATALOGUE);
  const json = jsonOf(glb);
  const view = new DataView(glb);

  assert.equal(json.meshes.length, 1);
  assert.equal(json.meshes[0].primitives.length, 2, "one primitive per material");
  assert.deepEqual(json.materials.map((m: any) => m.name), ["floor", "wall"]);

  for (const primitive of json.meshes[0].primitives) {
    const position = json.accessors[primitive.attributes.POSITION];
    assert.equal(position.type, "VEC3");
    assert.equal(position.componentType, 5126);
    assert.equal(position.count, 36);
    assert.equal(json.accessors[primitive.attributes.NORMAL].count, position.count);
    assert.equal(json.accessors[primitive.attributes.TEXCOORD_0].count, position.count);
    assert.equal(json.accessors[primitive.attributes.TEXCOORD_0].type, "VEC2");
    assert.deepEqual(position.min, [0, 0, 0], "a position accessor without bounds is not valid glTF");
    assert.deepEqual(position.max, [2, 2, 2]);
  }

  for (const v of json.bufferViews) {
    assert.ok(v.byteOffset + v.byteLength <= json.buffers[0].byteLength, "a view reaching past the buffer");
  }
  const binAt = 20 + jsonLengthOf(glb);
  assert.equal(view.getUint32(binAt + 4, true), 0x004e4942, "the second chunk is the binary one");
  assert.equal(view.getUint32(binAt, true), json.buffers[0].byteLength);
  assert.equal(binAt + 8 + json.buffers[0].byteLength, glb.byteLength);
});

test("the numbers in the buffer are the numbers that went in", () => {
  const exported = readForExport(worldOf(box("wall")));
  const glb = toGlb(exported, CATALOGUE);
  const json = jsonOf(glb);
  const bin = 20 + jsonLengthOf(glb) + 8;
  const view = json.bufferViews[json.accessors[json.meshes[0].primitives[0].attributes.POSITION].bufferView];
  const back = new Float32Array(glb, bin + view.byteOffset, view.byteLength / 4);
  assert.deepEqual([...back], [...exported.surfaces[0]!.positions]);
});

test("roughness and metalness survive, which is the whole reason for going out this way", () => {
  const json = jsonOf(toGlb(readForExport(worldOf(box("floor"))), CATALOGUE));
  const pbr = json.materials[0].pbrMetallicRoughness;
  assert.equal(pbr.roughnessFactor, 0.4);
  assert.equal(pbr.metallicFactor, 0.25);
  assert.deepEqual(pbr.baseColorFactor.map((n: number) => Math.round(n * 255)), [32, 48, 64, 255]);
  assert.equal(json.images, undefined, "a material with no map needs no image");
  assert.equal(pbr.baseColorTexture, undefined);
});

test("a material with a map names the file rather than carrying it", () => {
  const json = jsonOf(toGlb(readForExport(worldOf(box("wall"))), CATALOGUE));
  assert.deepEqual(json.images, [{ uri: "walls/brick.png" }]);
  assert.deepEqual(json.textures, [{ source: 0 }]);
  assert.equal(json.materials[0].pbrMetallicRoughness.baseColorTexture.index, 0);
});

test("an empty map is still a valid glb, not a file with a mesh made of nothing", () => {
  const glb = toGlb(readForExport(emptyWorld()), CATALOGUE);
  const json = jsonOf(glb);
  assert.deepEqual(json.scenes, [{ nodes: [] }]);
  assert.equal(json.meshes, undefined);
  assert.equal(json.accessors, undefined);
  assert.equal(json.buffers[0].byteLength, 0);
  assert.equal(glb.byteLength, 20 + jsonLengthOf(glb), "and no binary chunk at all");
});

// ---------------------------------------------------------------- lights

const lamp = (): Node =>
  entityNode("pointLight", { props: setNumber(setVec3([], "position", [1, 2, 3]), "intensity", 5) });

test("a light entity goes out as a light, not as nothing", () => {
  const { lights } = readForExport(worldOf(lamp()));
  assert.equal(lights.length, 1);
  assert.equal(lights[0]!.kind, "point");
  assert.deepEqual(lights[0]!.position, [1, 2, 3]);
  assert.equal(lights[0]!.intensity, 5);

  const json = jsonOf(toGlb(readForExport(worldOf(box("wall"), lamp())), CATALOGUE));
  assert.deepEqual(json.extensionsUsed, ["KHR_lights_punctual"]);
  assert.equal(json.extensions.KHR_lights_punctual.lights[0].type, "point");
  const node = json.nodes.find((n: any) => n.extensions);
  assert.deepEqual(node.translation, [1, 2, 3]);
  assert.equal(node.extensions.KHR_lights_punctual.light, 0);
  assert.deepEqual(json.scenes[0].nodes, [0, 1], "the mesh and the lamp are both in the scene");
});

test("a map with no lights says nothing about an extension it does not use", () => {
  const json = jsonOf(toGlb(readForExport(worldOf(box("wall"))), CATALOGUE));
  assert.equal(json.extensionsUsed, undefined);
  assert.equal(json.extensions, undefined);
});

test("an entity that is not a light is left in the sheet, where a game will look for it", () => {
  const spawn = entityNode("mesh", { props: setVec3([], "position", [1, 2, 3]) });
  const exported = readForExport(worldOf(spawn));
  assert.deepEqual(exported.lights, []);
  assert.deepEqual(exported.surfaces, []);
});

test("a colour reads the same whichever of the three ways the sheet spelled it", () => {
  const ways: Value[] = [hex(0xff8040), num(0xff8040), str("#ff8040")];
  for (const value of ways) {
    const node = entityNode("pointLight", { props: setProp([], "color", value) });
    assert.equal(readForExport(worldOf(node)).lights[0]!.colour, 0xff8040, value.kind);
  }
});

test("a light that is aimed comes out pointing there, which is a rotation and not a target", () => {
  const spot = entityNode("spotLight", {
    props: setVec3(setVec3([], "position", [0, 4, 0]), "target", [0, 0, 0]),
  });
  const json = jsonOf(toGlb(readForExport(worldOf(spot)), CATALOGUE));
  const [x, y, z, w] = json.nodes[0].rotation as [number, number, number, number];

  // turn the axis a glTF light shines down by that quaternion and see where it ends up: straight down
  const v = [0, 0, -1];
  const t = [
    2 * (y * v[2]! - z * v[1]!),
    2 * (z * v[0]! - x * v[2]!),
    2 * (x * v[1]! - y * v[0]!),
  ];
  const aimed = [
    v[0]! + w * t[0]! + (y * t[2]! - z * t[1]!),
    v[1]! + w * t[1]! + (z * t[0]! - x * t[2]!),
    v[2]! + w * t[2]! + (x * t[1]! - y * t[0]!),
  ];
  for (const [i, want] of [0, -1, 0].entries()) {
    assert.ok(Math.abs(aimed[i]! - want) < 1e-6, `axis ${i} came out ${aimed[i]}`);
  }

  const cone = json.extensions.KHR_lights_punctual.lights[0].spot;
  assert.ok(cone, "a spot has a cone");
  assert.ok(cone.innerConeAngle <= cone.outerConeAngle, "the soft edge is inside the hard one");
});

// ---------------------------------------------------------------- twice

test("exporting the same map twice produces the same bytes", () => {
  const world = worldOf(box("wall"), box("floor"), lamp());
  const once = toGlb(readForExport(world), CATALOGUE);
  const twice = toGlb(readForExport(world), CATALOGUE);
  assert.deepEqual([...new Uint8Array(once)], [...new Uint8Array(twice)]);
  const obj = () => toObj(readForExport(world), CATALOGUE, "m.mtl").obj;
  assert.equal(obj(), obj());
});

report("export");
