// node --experimental-strip-types src/raster.test.ts
// The atlas arithmetic: nothing here touches a GPU, and every mistake in it is silent.
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import type { Atlas } from "./atlas.ts";
import { rasterize } from "./raster.ts";
import { areaLights, bakeGeometry, collectScene, nodeKey, type BakeMesh } from "./scene.ts";
import { dilate } from "./filter.ts";
import { decodeFloats, encodeFloats } from "./apply.ts";

/** A 2x2 quad on the XZ plane at y = 0, facing +Y, filling the whole atlas. */
function quad(): { meshes: BakeMesh[]; atlas: Atlas } {
  const positions = new Float32Array([
    // (0,0,0) (2,0,0) (0,0,2)   and   (2,0,0) (2,0,2) (0,0,2)
    0, 0, 0, 2, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0, 2, 0, 0, 2,
  ]);
  const normals = new Float32Array(18);
  for (let i = 0; i < 6; i++) normals[i * 3 + 1] = 1;
  const meshes: BakeMesh[] = [
    { key: "quad", mesh: new THREE.Mesh(), positions, normals, faceMaterial: new Uint32Array([0, 0]) },
  ];
  // uv = position.xz / 2, so a texel's world position is a linear function of its atlas coordinate
  const uv = new Float32Array(12);
  for (let i = 0; i < 6; i++) {
    uv[i * 2] = positions[i * 3] / 2;
    uv[i * 2 + 1] = positions[i * 3 + 2] / 2;
  }
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
    }
  }
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
  hidden.userData.bake = false;
  root.add(hidden);

  const ambient = new THREE.AmbientLight(0xffffff, Math.PI);
  root.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(0, 10, 0);
  root.add(sun);

  const scene = collectScene(root);

  assert.equal(scene.meshes.length, 2, "userData.bake === false keeps a mesh out entirely");
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
  assert.ok(Math.abs(area.totalArea - 1) < 1e-5, "a 1x1 panel has unit area");
  assert.ok(Math.abs(area.data[3] - 0.5) < 1e-5, "the first triangle's cdf entry is its own area");
  assert.equal(area.data[11], scene.meshes[1].faceMaterial[0], "material id travels with the triangle");
  const radiance = scene.materials[area.data[11]].emissive;
  assert.deepEqual(radiance, [3, 3, 3], "emissive is emissive * emissiveIntensity");
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

console.log("raster.test.ts ok");
