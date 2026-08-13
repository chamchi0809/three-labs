// node --experimental-strip-types src/raster.test.ts
// The atlas arithmetic: nothing here touches a GPU, and every mistake in it is silent.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three/webgpu";
import { unwrap, type Atlas } from "./atlas.ts";
import { albedoAtlas, reuseAtlas, subset } from "./bake.ts";
import { rasterize, rasterizeParallel } from "./raster.ts";
import {
  areaLights,
  AREA_STRIDE,
  bakeGeometry,
  collectScene,
  meanColor,
  nodeKey,
  validateBakery,
  type BakeMesh,
  type BakeScene,
} from "./scene.ts";
import { dilate } from "./filter.ts";
import { nearestProbe, probeDirection, probeDirections } from "./probe.ts";
import { applyLightmap, decodeFloats, encodeFloats, MANIFEST_VERSION, type LightmapManifest } from "./apply.ts";
import { readEXR, writeBake } from "./io.ts";
import type { MaterialBakery, NodeBakery, SceneBakery } from "../names.ts";

/** what `@bakery { … }` leaves behind, written by hand — three's own types know nothing about it */
const bakery = <T extends object>(o: T, settings: NodeBakery | SceneBakery | MaterialBakery): T =>
  Object.assign(o, { bakery: settings });

/** A 2x2 quad on the XZ plane at y = 0, facing +Y, filling the whole atlas. */
function quad(): { meshes: BakeMesh[]; atlas: Atlas } {
  const positions = new Float32Array([
    // (0,0,0) (2,0,0) (0,0,2)   and   (2,0,0) (2,0,2) (0,0,2)
    0, 0, 0, 2, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0, 2, 0, 0, 2,
  ]);
  const normals = new Float32Array(18);
  for (let i = 0; i < 6; i++) normals[i * 3 + 1] = 1;
  // uv = position.xz / 2, so a texel's world position is a linear function of its atlas coordinate
  const uv = new Float32Array(12);
  for (let i = 0; i < 6; i++) {
    uv[i * 2] = positions[i * 3] / 2;
    uv[i * 2 + 1] = positions[i * 3 + 2] / 2;
  }
  const meshes: BakeMesh[] = [
    { key: "quad", mesh: new THREE.Mesh(), positions, normals, uv, faceMaterial: new Uint32Array([0, 0]) },
  ];
  return { meshes, atlas: { width: 8, height: 8, uv: [uv], utilization: 1 } };
}

// --- rasterization covers the atlas and lands on the surface -------------------------------------
{
  const { meshes, atlas } = quad();
  const texels = rasterize(meshes, atlas);

  assert.equal(texels.index.length, 64, "a quad over the whole atlas covers every texel");
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const at = (y * 8 + x) * 4;
      // texel centre (x+0.5)/8 in uv -> (x+0.5)/4 in world
      assert.ok(Math.abs(texels.position[at] - (x + 0.5) / 4) < 1e-5, `x at ${x},${y}`);
      assert.equal(texels.position[at + 1], 0, "the quad is flat at y = 0");
      assert.ok(Math.abs(texels.position[at + 2] - (y + 0.5) / 4) < 1e-5, `z at ${x},${y}`);
      assert.ok(Math.abs(texels.normal[at + 1] - 1) < 1e-6, "normals point +Y");
      assert.equal(texels.normal[at + 3], 0, "material id rides in normal.w");
      // uv0 comes along for the albedo atlas, and every texel remembers whose it is
      assert.ok(Math.abs(texels.uv[(y * 8 + x) * 2] - (x + 0.5) / 8) < 1e-5, `u at ${x},${y}`);
      assert.ok(Math.abs(texels.uv[(y * 8 + x) * 2 + 1] - (y + 0.5) / 8) < 1e-5, `v at ${x},${y}`);
      assert.equal(texels.mesh[y * 8 + x], 0, `owner at ${x},${y}`);
    }
  }
  assert.equal(rasterize([{ ...meshes[0]!, uv: undefined }], atlas).uv[0], 0, "no uv0 leaves the uv at zero");
}

// --- a triangle smaller than a texel still gets one sample ---------------------------------------
{
  const positions = new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0, 0.01]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const meshes: BakeMesh[] = [
    { key: "speck", mesh: new THREE.Mesh(), positions, normals, faceMaterial: new Uint32Array([3]) },
  ];
  const uv = new Float32Array([0.5, 0.5, 0.502, 0.5, 0.5, 0.502]);
  const texels = rasterize(meshes, { width: 8, height: 8, uv: [uv], utilization: 1 });
  assert.equal(texels.index.length, 1, "a sub-texel triangle must not bake black");
  assert.equal(texels.normal[texels.index[0] * 4 + 3], 3, "and it keeps its material");
  assert.equal(texels.mesh[0], -1, "an uncovered texel belongs to nobody");
}

// --- dilation grows the lit region without touching what was already lit -------------------------
{
  const width = 5;
  const height = 5;
  const mask = new Uint8Array(width * height);
  const image = new Float32Array(width * height * 4);
  const centre = 2 * width + 2;
  mask[centre] = 1;
  image.set([4, 4, 4, 1], centre * 4);

  const grown = dilate(image, mask, width, height, 1);
  assert.equal(grown.reduce((a, b) => a + b, 0), 9, "one pass grows a texel into its 3x3 ring");
  assert.equal(image[centre * 4], 4, "the lit texel is left alone");
  assert.equal(image[(2 * width + 1) * 4], 4, "its neighbour picks up its value");
  assert.equal(image[0], 0, "two rings away is still dark after one pass");
}

// --- collectScene: three's light conventions, materials, and the emissive area list --------------
{
  const root = new THREE.Group();
  root.name = "root";

  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshStandardMaterial({ color: 0xff0000, metalness: 0 }),
  );
  wall.name = "wall";
  root.add(wall);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 3 }),
  );
  panel.name = "panel";
  panel.position.set(0, 2, 0);
  root.add(panel);

  const hidden = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
  bakery(hidden, { enabled: false });
  root.add(hidden);

  const ambient = new THREE.AmbientLight(0xffffff, Math.PI);
  root.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(0, 10, 0);
  root.add(sun);

  const scene = collectScene(root);

  assert.equal(scene.meshes.length, 2, "@bakery { enabled: false } keeps a mesh out entirely");
  assert.deepEqual(
    scene.meshes.map((m) => m.key),
    ["wall", "panel"],
  );
  assert.equal(nodeKey(root, wall), "wall");
  assert.equal(scene.meshes[0].positions.length / 3, 6, "geometry arrives de-indexed");

  const albedo = scene.materials[scene.meshes[0].faceMaterial[0]].albedo;
  assert.ok(albedo[0] > 0.9 && albedo[1] < 1e-6, "sRGB red survives as linear red");

  // ambient adds straight to irradiance in three, so the equivalent sky radiance is E / PI
  assert.ok(Math.abs(scene.sky.up[0] - 1) < 1e-6, "AmbientLight(PI) is a unit-radiance sky");
  assert.equal(scene.lights.length, 1, "ambient is folded into the sky, not the light list");
  assert.equal(scene.lights[0].kind, 0);
  assert.deepEqual(scene.lights[0].color, [2, 2, 2], "colour is color * intensity, with no 4PI");
  assert.deepEqual(scene.lights[0].direction, [0, -1, 0], "an untargeted DirectionalLight aims at the origin");

  const area = areaLights(scene);
  assert.equal(area.count, 2, "the emissive panel contributes both of its triangles");
  assert.equal(area.data.length, area.count * AREA_STRIDE);
  assert.ok(Math.abs(area.totalArea - 1) < 1e-5, "a 1x1 panel has unit area");
  assert.ok(Math.abs(area.data[3] - 0.5) < 1e-5, "the first triangle's cdf entry is its own area");
  assert.ok(Math.abs(area.data[7] - 0.5) < 1e-5, "and slot 1 carries the area itself, not the running sum");
  assert.equal(area.data[11], 0, "a mesh emits both ways; only a RectAreaLight is one-sided");
  // the radiance rides along per triangle, so an emissiveMap can differ across one mesh
  assert.deepEqual(Array.from(area.data.subarray(12, 15)), [3, 3, 3], "emissive is emissive * emissiveIntensity");
}

// --- bakeGeometry is deterministic, which is what lets the manifest be just uvs -------------------
{
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const a = bakeGeometry(new THREE.Mesh(geometry));
  const b = bakeGeometry(new THREE.Mesh(geometry));
  assert.equal(a.getAttribute("position").count, 36);
  assert.deepEqual(
    Array.from(a.getAttribute("position").array),
    Array.from(b.getAttribute("position").array),
    "toNonIndexed() must produce the same vertex order every time",
  );
}

// --- the manifest round trips ---------------------------------------------------------------------
{
  const uv = new Float32Array([0, 0.25, 0.5, 1, 0.125, 0.875]);
  assert.deepEqual(Array.from(decodeFloats(encodeFloats(uv))), Array.from(uv));
}

// --- the lightmap handle owns the atlas/lights trade -----------------------------------------------
{
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
  mesh.name = "floor";
  const baked = new THREE.PointLight(0xffffff, 7);
  const live = new THREE.PointLight(0xffffff, 3);
  bakery(live, { enabled: false }); // "stays live at runtime": not one of the lights the atlas contains
  root.add(mesh, baked, live);

  const vertices = bakeGeometry(mesh).getAttribute("position").count;
  const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const manifest: LightmapManifest = {
    version: 1,
    width: 64,
    height: 32,
    intensity: 2,
    texture: "atlas.png",
    meshes: [{ key: nodeKey(root, mesh), vertices, uv: encodeFloats(new Float32Array(vertices * 2)) }],
  };

  const lightmap = await applyLightmap(root, { manifest, texture });
  const material = mesh.material as THREE.MeshStandardMaterial;
  assert.equal(lightmap.meshes, 1);
  assert.equal(lightmap.width, 64);
  assert.equal(material.lightMap, texture);
  assert.equal(material.lightMapIntensity, 2, "gain 1 is the exposure the manifest carries");
  assert.equal(baked.intensity, 0, "a bake contains its lights; leaving them on counts them twice");
  assert.equal(live.intensity, 3);
  assert.equal(lightmap.lights.get(baked), 7);
  assert.equal(lightmap.lights.has(live), false);

  lightmap.intensity = 4;
  assert.equal(material.lightMapIntensity, 8);

  lightmap.enabled = false;
  assert.equal(material.lightMapIntensity, 0);
  assert.equal(material.lightMap, texture, "zeroed, never unassigned — the node graph does not come back");
  assert.equal(baked.intensity, 7, "the realtime pass gets the intensity the sheet declared");

  lightmap.enabled = true;
  assert.equal(material.lightMapIntensity, 8, "the gain survives a round trip");
  assert.equal(baked.intensity, 0);

  lightmap.dispose();
  assert.equal(material.lightMap, null);
  assert.equal(baked.intensity, 7);

  // vertex counts are the check that a manifest belongs to this scene
  await assert.rejects(
    applyLightmap(root, { manifest: { ...manifest, meshes: [{ ...manifest.meshes[0]!, vertices: 3 }] }, texture }),
    /baked from 3 vertices|has \d+ vertices/,
  );
}

// --- `@bakery { include }` and the subtree it applies to --------------------------------------------
{
  const build = () => {
    const root = new THREE.Group();
    const plain = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
    plain.name = "plain";
    const group = new THREE.Group();
    group.name = "group";
    const child = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
    child.name = "child";
    const override = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
    override.name = "override";
    group.add(child, override);
    root.add(plain, group, new THREE.PointLight(0xffffff, 1));
    return { root, plain, group, child, override };
  };
  const keys = (root: THREE.Object3D, opts?: Parameters<typeof collectScene>[1]) =>
    collectScene(root, opts).meshes.map((m) => m.key);

  // include: all — everything but what turns itself off, and the subtree under it
  const a = build();
  bakery(a.group, { enabled: false });
  bakery(a.override, { enabled: true });
  assert.deepEqual(keys(a.root), ["plain", "group/override"], "enabled is inherited, and a child can opt back in");

  // include: none — only what opts in, and the subtree under it
  const b = build();
  bakery(b.group, { enabled: true });
  bakery(b.override, { enabled: false });
  assert.deepEqual(keys(b.root, { include: "none" }), ["group/child"], "include: none bakes only the opted-in subtree");
  assert.equal(collectScene(b.root, { include: "none" }).lights.length, 1, "include: none does not mute lights");

  // the sheet's own block is the default, and an explicit option beats it
  const c = build();
  bakery(c.root, { include: "none" } satisfies SceneBakery);
  assert.deepEqual(keys(c.root), [], "a sheet's include: none is picked up off the root");
  assert.deepEqual(keys(c.root, { include: "all" }), ["plain", "group/child", "group/override"], "the caller wins");
}

// --- visibility prunes the subtree, not just the node -----------------------------------------------
{
  const root = new THREE.Group();
  const group = new THREE.Group();
  group.name = "group";
  group.visible = false;
  const child = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
  child.name = "child";
  group.add(child);
  const seen = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
  seen.name = "seen";
  root.add(group, seen);

  assert.deepEqual(
    collectScene(root).meshes.map((m) => m.key),
    ["seen"],
    "an invisible group hides what is under it, not only itself",
  );
}

// --- nodeKey tells same-named siblings apart ---------------------------------------------------------
{
  const root = new THREE.Group();
  const make = (name: string) => Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(1, 1)), { name });
  const a = make("wall");
  const b = make("wall");
  const alone = make("door");
  root.add(a, b, alone);

  assert.equal(nodeKey(root, alone), "door");
  assert.equal(nodeKey(root, a), "wall@0");
  assert.equal(nodeKey(root, b), "wall@1", "a repeated name is not a key — glTF hands them out freely");
  assert.notEqual(nodeKey(root, a), nodeKey(root, b));
}

// --- a RectAreaLight bakes as the quad it is ---------------------------------------------------------
{
  const root = new THREE.Group();
  const light = new THREE.RectAreaLight(0xffffff, 2, 2, 1);
  light.name = "panel";
  light.position.set(0, 3, 0);
  light.rotation.x = -Math.PI / 2; // local -Z now points down
  root.add(light);

  const scene = collectScene(root);
  assert.equal(scene.meshes.length, 0, "an emitter quad is lit from, never lit onto — it takes no texels");
  assert.equal(scene.lights.length, 0, "and it is not a delta light either");
  assert.equal(scene.emitters.length, 1);

  const material = scene.materials[scene.emitters[0]!.faceMaterial[0]!]!;
  assert.deepEqual(material.emissive, [2, 2, 2], "three's RectAreaLight intensity is already a radiance");
  assert.deepEqual(material.albedo, [0, 0, 0]);
  assert.equal(material.oneSided, true, "it emits along local -Z only");

  const area = areaLights(scene);
  assert.equal(area.count, 2, "two triangles");
  assert.ok(Math.abs(area.totalArea - 2) < 1e-5, "2 x 1 is an area of 2");
  // the winding has to put the geometric normal on the emitting side, or the shader lights the ceiling
  const p = scene.emitters[0]!.positions;
  const edge = (i: number, j: number) => new THREE.Vector3(p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!);
  const geometric = edge(0, 3).cross(edge(0, 6)).normalize();
  assert.ok(geometric.y < -0.99, `the quad must face down, got ${geometric.toArray().join(",")}`);
  assert.ok(Math.abs(scene.emitters[0]!.normals[1]! + 1) < 1e-5, "and the shading normal agrees with it");

  // it is still a light: only an explicit `enabled: false` takes it out of the bake
  const off = new THREE.Group();
  off.add(bakery(new THREE.RectAreaLight(0xffffff, 2, 2, 1), { enabled: false }));
  assert.equal(collectScene(off).emitters.length, 0);
}

// --- more charts than fit in one atlas: the sheets stack, so the uvs stay in [0,1] --------------------
{
  const meshes: BakeMesh[] = [0, 10].map((x, i) => {
    const positions = new Float32Array([x, 0, 0, x + 2, 0, 0, x, 0, 2, x + 2, 0, 0, x + 2, 0, 2, x, 0, 2]);
    const normals = new Float32Array(18);
    for (let k = 0; k < 6; k++) normals[k * 3 + 1] = 1;
    return { key: `q${i}`, mesh: new THREE.Mesh(), positions, normals, faceMaterial: new Uint32Array([0, 0]) };
  });
  // 32px of atlas cannot hold two 2x2 quads at 16 texels per unit, so xatlas packs a second sheet
  const atlas = await unwrap(meshes, { size: 32, texelsPerUnit: 16, padding: 1 });
  assert.ok(atlas.height > atlas.width, `expected stacked sheets, got ${atlas.width}x${atlas.height}`);
  assert.equal(atlas.height % atlas.width, 0, "sheets stack whole");

  const range = (uv: Float32Array) => [Math.min(...uv.filter((_, i) => i % 2)), Math.max(...uv.filter((_, i) => i % 2))];
  for (const uv of atlas.uv) {
    assert.ok(
      uv.every((c) => c >= 0 && c <= 1),
      "a second sheet must be folded into the one tall texture, not left outside it",
    );
  }
  const [aLow, aHigh] = range(atlas.uv[0]!);
  const [bLow, bHigh] = range(atlas.uv[1]!);
  assert.ok(aLow! > bHigh! || bLow! > aHigh!, "the two sheets must not overlap in v");
  assert.ok(atlas.utilization > 0 && atlas.utilization <= 1, `utilization ${atlas.utilization}`);
}

/** A BakeScene around hand-made meshes — everything the CPU stages read, and nothing else. */
function sceneOf(meshes: BakeMesh[], materials: BakeScene["materials"]): BakeScene {
  return {
    meshes,
    emitters: [],
    materials,
    lights: [],
    probes: [],
    sky: { up: [0, 0, 0], down: [0, 0, 0], axis: [0, 1, 0] },
    bounds: new THREE.Box3(),
  };
}

// --- the albedo atlas: one texel of the map per texel of the lightmap --------------------------------
{
  const { meshes, atlas } = quad();
  const texels = rasterize(meshes, atlas);

  // 2x2, red on the left column and green on the right, so only u decides the colour
  const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
  const map = new THREE.DataTexture(pixels, 2, 2);
  map.colorSpace = THREE.SRGBColorSpace;

  const scene = sceneOf(meshes, [{ albedo: [0.5, 0.25, 0], emissive: [0, 0, 0], map, mapScale: [1, 0.5, 1] }]);
  const packed = albedoAtlas(scene, texels);
  assert.ok(packed, "a material with a decodable map gets an atlas");
  const rgba = (at: number) => [0, 8, 16, 24].map((s) => (packed![at]! >>> s) & 255);

  assert.deepEqual(rgba(0), [255, 0, 0, 255], "the left half reads the red texel, alpha marks it sampled");
  assert.deepEqual(rgba(7), [0, 128, 0, 255], "the right half reads green, scaled by the material's colour");
  assert.deepEqual(rgba(8 * 7), [255, 0, 0, 255], "and v does not change the answer for a column-only map");

  assert.equal(
    albedoAtlas(sceneOf(meshes, [{ albedo: [1, 1, 1], emissive: [0, 0, 0] }]), texels),
    undefined,
    "no map anywhere: the tracer stays on the per-material mean and the buffer is never built",
  );
}

// --- partial rebake: the uv layout is reused and only the named meshes are dispatched ------------------
{
  const { meshes, atlas } = quad();
  const shift = (uv: Float32Array, u0: number) => Float32Array.from(uv, (c, i) => (i % 2 ? c : u0 + c / 2));
  const pair: BakeMesh[] = [
    { ...meshes[0]!, key: "left" },
    { ...meshes[0]!, key: "right" },
  ];
  const uvs = [shift(atlas.uv[0]!, 0), shift(atlas.uv[0]!, 0.5)];
  const texels = rasterize(pair, { ...atlas, uv: uvs });
  const scene = sceneOf(pair, [{ albedo: [1, 1, 1], emissive: [0, 0, 0] }]);

  const only = subset(texels, scene, ["right"]);
  assert.equal(only.length, 32, "half the atlas");
  assert.ok(
    [...only].every((at) => texels.mesh[at] === 1 && at % 8 >= 4),
    "a partial rebake dispatches over the named mesh's texels and nothing else",
  );
  assert.throws(() => subset(texels, scene, ["nope"]), /no mesh named/);

  const manifest: LightmapManifest = {
    version: 1,
    width: 8,
    height: 8,
    intensity: 1,
    texture: "atlas.png",
    meshes: pair.map((m, i) => ({ key: m.key, vertices: 6, uv: encodeFloats(uvs[i]!) })),
  };
  const reused = reuseAtlas(manifest, scene);
  assert.equal(reused.width, 8);
  assert.deepEqual(Array.from(reused.uv[1]!), Array.from(uvs[1]!), "a rebake lands on the texels already written");
  assert.throws(
    () => reuseAtlas({ ...manifest, meshes: [manifest.meshes[0]!] }, scene),
    /is not in the lightmap/,
    "a mesh the atlas has never seen cannot be patched into it",
  );
  assert.throws(
    () => reuseAtlas({ ...manifest, meshes: manifest.meshes.map((m) => ({ ...m, vertices: 9 })) }, scene),
    /changed shape/,
  );
}

// --- a material shared with an unbaked mesh is copied, and put back on dispose ------------------------
{
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial();
  const baked = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  baked.name = "baked";
  const shared = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  shared.name = "shared";
  root.add(baked, shared);
  const geometry = baked.geometry;

  const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const manifest: LightmapManifest = {
    version: 1,
    width: 8,
    height: 8,
    intensity: 1,
    texture: "atlas.png",
    meshes: [{ key: "baked", vertices: 6, uv: encodeFloats(new Float32Array(12)) }],
  };

  const lightmap = await applyLightmap(root, { manifest, texture });
  assert.notEqual(baked.material, material, "the unbaked mesh has no uv1, so it must not inherit the atlas");
  assert.equal((baked.material as THREE.MeshStandardMaterial).lightMap, texture);
  assert.equal(shared.material, material);
  assert.equal(material.lightMap, null, "the shared original is left exactly as it was");
  assert.ok(baked.geometry.getAttribute("uv1"), "the baked mesh carries the atlas uvs");

  lightmap.dispose();
  assert.equal(baked.material, material, "dispose puts the scene back");
  assert.equal(baked.geometry, geometry);

  // and nothing is touched at all when any mesh in the manifest does not check out
  await assert.rejects(
    applyLightmap(root, {
      manifest: { ...manifest, meshes: [manifest.meshes[0]!, { key: "shared", vertices: 3, uv: "" }] },
      texture,
    }),
    /vertices/,
  );
  assert.equal(baked.material, material, "a half-applied atlas is worse than none");
  assert.equal(baked.geometry, geometry);
}

// --- @bakery typos are settings for a tool, so nothing else would ever catch them ---------------------
{
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
  mesh.name = "floor";
  root.add(mesh);
  bakery(root, { include: "none" } satisfies SceneBakery);
  bakery(mesh, { enabled: true, radius: 0.5 } satisfies NodeBakery);
  bakery(mesh.material as THREE.Material, { albedo: [1, 1, 1] } satisfies MaterialBakery);
  validateBakery(root, "room.tscene");

  bakery(mesh, { enabld: true } as unknown as NodeBakery);
  assert.throws(() => validateBakery(root, "room.tscene"), /floor: @bakery has no node setting "enabld"/);
}

// --- the mean is strided, so the only thing that can go wrong is the divisor ---------------------------
{
  const flat = (w: number, h: number, rgba: number[]) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
    return new THREE.DataTexture(data, w, h);
  };
  // 4096 texels is exactly the sample budget (stride 1), 65536 is 16x over it (stride 16)
  for (const [w, h] of [[64, 64], [256, 256]] as const) {
    const mean = meanColor(flat(w, h, [128, 64, 0, 51]))!;
    assert.ok(Math.abs(mean[0] - 128 / 255) < 1e-6, `${w}x${h} mean r`);
    assert.ok(Math.abs(mean[1] - 64 / 255) < 1e-6, `${w}x${h} mean g`);
    assert.ok(Math.abs(mean[3] - 51 / 255) < 1e-6, `${w}x${h} mean alpha — never sRGB-decoded`);
  }
  const srgb = flat(8, 8, [188, 188, 188, 255]);
  srgb.colorSpace = THREE.SRGBColorSpace;
  assert.ok(Math.abs(meanColor(srgb)![0] - 0.5) < 0.01, "an sRGB map is averaged in linear");
}

// --- coverage: a transparent material stops less of a shadow ray ---------------------------------------
{
  const root = new THREE.Group();
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.25 }),
  );
  glass.name = "glass";
  const solid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
  solid.name = "solid";
  // a cutout: alphaTest, not transparent, and the alpha lives in the map
  const pixels = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 0]);
  const fence = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ map: new THREE.DataTexture(pixels, 2, 2), alphaTest: 0.5 }),
  );
  fence.name = "fence";
  // glTF glass: transmission, and nothing else says it is see-through
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshPhysicalMaterial({ transmission: 0.9 }));
  pane.name = "pane";
  root.add(glass, solid, fence, pane);

  const scene = collectScene(root);
  // absent means 1: the tracer only builds its layered shadow ray when some material states one
  const coverage = (mesh: number) => scene.materials[scene.meshes[mesh]!.faceMaterial[0]!]!.coverage ?? 1;
  assert.equal(coverage(0), 0.25, "opacity is how much of the ray gets through");
  assert.equal(coverage(1), 1, "an opaque material stops all of it");
  assert.ok(Math.abs(coverage(2)! - 0.5) < 1e-6, "a half-cut alpha map halves it");
  assert.ok(Math.abs(coverage(3)! - 0.1) < 1e-6, "transmission alone is enough to make it see-through");
}

// --- occluder, density and the meshes a bake cannot carry ----------------------------------------------
{
  const root = new THREE.Group();
  const mesh = (name: string) => Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial()), { name });
  const proxy = bakery(mesh("proxy"), { enabled: "occluder" } satisfies NodeBakery);
  const group = new THREE.Group();
  group.name = "detail";
  bakery(group, { density: 2 } satisfies NodeBakery);
  const child = mesh("child");
  const coarse = bakery(mesh("coarse"), { density: 0.5 } satisfies NodeBakery);
  group.add(child, coarse);
  const skinned = Object.assign(new THREE.SkinnedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial()), { name: "rig" });
  root.add(proxy, group, skinned);

  const warnings: string[] = [];
  const scene = collectScene(root, { onWarn: (m) => warnings.push(m) });

  assert.deepEqual(scene.meshes.map((m) => m.key), ["detail/child", "detail/coarse"], "an occluder takes no texels");
  assert.equal(scene.emitters.length, 1, "but it is still in the BVH");
  assert.equal(scene.emitters[0]!.positions.length, proxy.geometry.toNonIndexed().getAttribute("position").count * 3);
  assert.equal(scene.meshes[0]!.density, 2, "density is inherited from the group");
  assert.equal(scene.meshes[1]!.density, 0.5, "and a child overrides it");
  assert.equal(warnings.length, 1, `expected one warning, got ${warnings.join(" / ")}`);
  assert.match(warnings[0]!, /"rig" is skinned and cannot carry a lightmap/);
}

// --- a metal is baked and then thrown away, so it has to say so -----------------------------------------
{
  const root = new THREE.Group();
  const chrome = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ metalness: 1 }));
  chrome.material.name = "Metal_Blue";
  const painted = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ metalness: 0.4 }));
  root.add(chrome, painted);

  const warnings: string[] = [];
  collectScene(root, { onWarn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1, `expected one warning, got ${warnings.join(" / ")}`);
  assert.match(warnings[0]!, /1 material\(s\) are metalness >= 0\.9 \(Metal_Blue\)/);

  // …unless the sheet placed something for it to reflect
  const probe = bakery(new THREE.Object3D(), { probe: 64 } satisfies NodeBakery);
  root.add(probe);
  const quiet: string[] = [];
  collectScene(root, { onWarn: (m) => quiet.push(m) });
  assert.deepEqual(quiet, [], "a probe is the answer to the metal warning, so it stops asking");
}

// --- probes: where the sheet put them, and which direction each texel of one looks --------------------
{
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
  mesh.name = "floor";
  const here = bakery(new THREE.Object3D(), { probe: 64.7 } satisfies NodeBakery);
  here.name = "here";
  here.position.set(1, 2, 3);
  const tiny = bakery(new THREE.Object3D(), { probe: 2 } satisfies NodeBakery);
  tiny.name = "tiny";
  root.add(mesh, here, tiny);
  root.position.set(10, 0, 0);
  root.updateMatrixWorld(true);

  const warnings: string[] = [];
  const scene = collectScene(root, { onWarn: (m) => warnings.push(m) });
  assert.equal(scene.probes.length, 1, "one probe placed, one too small to be a mip");
  assert.equal(scene.probes[0]!.key, "here");
  assert.deepEqual(scene.probes[0]!.position, [11, 2, 3], "world space, not local — a probe is a place");
  assert.equal(scene.probes[0]!.size, 64, "a fractional texel count is floored");
  assert.match(warnings[0]!, /"tiny" asks for a 2-texel probe/);
  assert.equal(scene.meshes.length, 1, "an empty carrying a probe is not a mesh to bake");

  // the mapping has to be the exact inverse of three's `equirectUV`, or the reflection is rotated
  const [width, height] = [16, 8];
  const equirectUV = (d: readonly number[]) => [
    Math.atan2(d[2]!, d[0]!) / (Math.PI * 2) + 0.5,
    Math.asin(d[1]!) / Math.PI + 0.5,
  ];
  for (const [x, y] of [
    [0, 0],
    [5, 3],
    [15, 7],
  ] as const) {
    const [u, v] = equirectUV(probeDirection(x, y, width, height));
    assert.ok(Math.abs(u! * width - (x + 0.5)) < 1e-6, `u of texel ${x},${y} is ${u! * width}, want ${x + 0.5}`);
    assert.ok(Math.abs(v! * height - (y + 0.5)) < 1e-6, `v of texel ${x},${y} is ${v! * height}, want ${y + 0.5}`);
  }
  assert.ok(probeDirection(0, 0, width, height)[1] < -0.9, "row 0 looks down, which is what the file's last row is");
  assert.ok(probeDirection(0, height - 1, width, height)[1] > 0.9, "and the last row up");

  const buffer = probeDirections(width, height);
  assert.equal(buffer.length, width * height * 4, "four floats a texel, row major from the bottom");
  const third = probeDirection(3, 0, width, height);
  assert.ok(
    third.every((c, k) => Math.abs(c - buffer[4 * 3 + k]!) < 1e-6),
    `texel 3 of row 0 is ${[...buffer.subarray(12, 15)]}, want ${third}`,
  );

  // the runtime's half: nearest centre wins, and no probes means no reflection
  const probes = [{ position: [0, 0, 0] }, { position: [10, 0, 0] }];
  assert.equal(nearestProbe([1, 0, 0], probes), 0);
  assert.equal(nearestProbe([9, 5, 0], probes), 1);
  assert.equal(nearestProbe([5, 0, 0], probes), 0, "a tie goes to the first, deterministically");
  assert.equal(nearestProbe([0, 0, 0], []), -1);
}

// --- a probe lands on the envMap of the metals in its cell, and comes back off on dispose -------------
{
  const root = new THREE.Group();
  const chrome = new THREE.MeshStandardMaterial({ metalness: 1 });
  const paint = new THREE.MeshStandardMaterial({ metalness: 0 });
  const near = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), chrome);
  near.name = "near";
  const far = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), chrome);
  far.name = "far";
  far.position.set(100, 0, 0);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), paint);
  wall.name = "wall";
  root.add(near, far, wall);
  root.updateMatrixWorld(true);

  const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const probes = [new THREE.DataTexture(new Uint8Array(4), 1, 1), new THREE.DataTexture(new Uint8Array(4), 1, 1)];
  const uv = encodeFloats(new Float32Array(12));
  const manifest: LightmapManifest = {
    version: MANIFEST_VERSION,
    width: 8,
    height: 8,
    intensity: 1,
    texture: "atlas.png",
    meshes: ["near", "far", "wall"].map((key) => ({ key, vertices: 6, uv })),
    probes: [
      { key: "a", position: [0, 0, 0], texture: "a.exr" },
      { key: "b", position: [100, 0, 0], texture: "b.exr" },
    ],
  };

  const lightmap = await applyLightmap(root, { manifest, texture, probes });
  assert.equal((wall.material as THREE.MeshStandardMaterial).envMap, null, "a dielectric's diffuse is in the atlas");
  const a = near.material as THREE.MeshStandardMaterial;
  const b = far.material as THREE.MeshStandardMaterial;
  assert.notEqual(a, b, "one material, two cells: envMap is a per-material slot, so it has to be cloned");
  assert.equal(a.envMap, probes[0]);
  assert.equal(b.envMap, probes[1]);
  assert.equal(a.envMapIntensity, 1, "metalness scales the gain, so a full metal reflects it all");

  lightmap.environment = 0.25;
  assert.equal(a.envMapIntensity, 0.25);
  lightmap.enabled = false;
  assert.equal(a.envMapIntensity, 0.25, "a metal reflects whether or not the diffuse atlas is showing");

  lightmap.dispose();
  assert.equal(near.material, chrome, "and the originals are handed back untouched");
  assert.equal(chrome.envMap, null);
}

// --- the parallel rasterizer is the same rasterizer -----------------------------------------------------
{
  const { meshes, atlas } = quad();
  const pair: BakeMesh[] = [
    { ...meshes[0]!, key: "left" },
    { ...meshes[0]!, key: "right" },
  ];
  const shift = (uv: Float32Array, u0: number) => Float32Array.from(uv, (c, i) => (i % 2 ? c : u0 + c / 2));
  const uvs = [shift(atlas.uv[0]!, 0), shift(atlas.uv[0]!, 0.5)];
  const one = rasterize(pair, { ...atlas, uv: uvs });
  const many = await rasterizeParallel(pair, { ...atlas, uv: uvs }, { jobs: 2 });

  assert.deepEqual(Array.from(many.index), Array.from(one.index), "workers cover the same texels");
  assert.deepEqual(Array.from(many.mesh), Array.from(one.mesh), "and each texel keeps its owner");
  assert.deepEqual(Array.from(many.position), Array.from(one.position));
  assert.deepEqual(Array.from(many.normal), Array.from(one.normal));
  assert.deepEqual(Array.from(many.uv), Array.from(one.uv));

  let seen = 0;
  await rasterizeParallel(pair, { ...atlas, uv: uvs }, { jobs: 2, onProgress: () => seen++ });
  assert.equal(seen, 2, "one progress tick per mesh, wherever it was rasterized");
}

// --- a manifest from another build is refused, not read -------------------------------------------------
{
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
  mesh.name = "floor";
  root.add(mesh);
  const manifest: LightmapManifest = {
    version: MANIFEST_VERSION + 1,
    width: 8,
    height: 8,
    intensity: 1,
    texture: "atlas.png",
    meshes: [{ key: "floor", vertices: 6, uv: encodeFloats(new Float32Array(12)) }],
  };
  await assert.rejects(
    applyLightmap(root, { manifest, texture: new THREE.DataTexture(new Uint8Array(4), 1, 1) }),
    /manifest version 2, this build reads 1 — rebake/,
  );
}

// --- an EXR keeps the row order the bake produced ------------------------------------------------------
// The one thing a probe cannot be checked for in memory: three samples an equirect `envMap` with
// `flipY: false`, so v = 0 — straight down — has to be row 0 of the file too. A flip here turns the
// floor into the sky and nothing else notices.
{
  const dir = await mkdtemp(join(tmpdir(), "tscene-io-"));
  const row = (marker: number, width: number) => Array.from({ length: width * 4 }, (_, i) => (i % 4 === 3 ? 1 : marker));
  const image = Float32Array.from([...row(0.25, 2), ...row(0.75, 2)]);
  const probe = Float32Array.from([...row(1, 4), ...row(2, 4)]);
  const files = await writeBake(
    {
      width: 2,
      height: 2,
      image,
      probes: [{ key: "probe", position: [0, 1, 0], width: 4, height: 2, image: probe }],
      exposure: 1,
      utilization: 1,
      manifest: { version: MANIFEST_VERSION, width: 2, height: 2, intensity: 1, meshes: [] },
    },
    dir,
    "rows",
    { exr: true },
  );
  assert.ok(files.some((f) => f.endsWith("rows.probe0.exr")), "one EXR per probe");

  const back = await readEXR(join(dir, "rows.exr"));
  assert.deepEqual(Array.from(back.image), Array.from(image), "the atlas EXR round trips row for row");

  const { EXRLoader } = await import("three/addons/loaders/EXRLoader.js");
  const buffer = await readFile(join(dir, "rows.probe0.exr"));
  const decoded = new EXRLoader()
    .setDataType(THREE.FloatType)
    .parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)) as { data: Float32Array };
  assert.equal(decoded.data[0], 1, "row 0 of the file is v = 0, which equirectUV reads as straight down");
  assert.equal(decoded.data[4 * 4], 2, "and the row above it is the one above it");
  await rm(dir, { recursive: true, force: true });
}

console.log("raster.test.ts ok");
