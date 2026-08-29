// The generated textures: that every url the demo sheet writes resolves, that a url the editor does not own
// is left for the loader, and that the three images really are three views of one height field — a normal
// map that disagreed with its height map is a wall that changes shape as you walk towards it.
// Run with: node --experimental-strip-types src/render/sample.check.ts
import assert from "node:assert/strict";
import { LinearSRGBColorSpace, SRGBColorSpace } from "three/webgpu";
import { report, test } from "../check.ts";
import { DEMO_SHEET } from "../doc/demo.ts";
import { SAMPLES, SCHEME, sampleTexture } from "./sample.ts";

const bytes = (url: string): Uint8Array => sampleTexture(url)!.image.data as Uint8Array;

test("every url the scheme names comes back as an image", () => {
  assert.equal(SAMPLES.length, 6, "two patterns, three slots each");
  for (const url of SAMPLES) {
    const texture = sampleTexture(url);
    assert.ok(texture, url);
    assert.equal(texture.image.width, texture.image.height, "square, so a tile is a tile either way");
  }
});

test("the sheet's own urls are among them, so the demo is never a grey room", () => {
  for (const [, url] of DEMO_SHEET.matchAll(/texture\("([^"]+)"\)/g)) {
    if (!url!.startsWith(SCHEME)) continue;
    assert.ok(SAMPLES.includes(url!), `${url} is written but not generated`);
  }
});

test("anything that is not ours is left for the loader", () => {
  assert.equal(sampleTexture("./brick.png"), undefined);
  assert.equal(sampleTexture("https://example.com/brick.png"), undefined);
  assert.equal(sampleTexture(`${SCHEME}granite/map`), undefined, "a pattern there is no arithmetic for");
});

test("a url asked for twice is the same texture, because rebuilding one is a stutter", () => {
  assert.equal(sampleTexture(`${SCHEME}brick/map`), sampleTexture(`${SCHEME}brick/map`));
});

test("only the albedo is a colour; a height read through an sRGB curve is a wrong number", () => {
  assert.equal(sampleTexture(`${SCHEME}brick/map`)!.colorSpace, SRGBColorSpace);
  assert.equal(sampleTexture(`${SCHEME}brick/height`)!.colorSpace, LinearSRGBColorSpace);
  assert.equal(sampleTexture(`${SCHEME}brick/normal`)!.colorSpace, LinearSRGBColorSpace);
});

test("the height map is grey, and it has both a mortar line and a brick face in it", () => {
  const data = bytes(`${SCHEME}brick/height`);
  let low = 0;
  let high = 0;
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(data[i], data[i + 1]);
    assert.equal(data[i], data[i + 2]);
    if (data[i]! < 40) low++;
    if (data[i]! > 180) high++;
  }
  assert.ok(low > 0, "there is mortar");
  assert.ok(high > 0, "and there is brick standing above it");
});

test("the normal map points out of the surface everywhere, which is what tangent space means", () => {
  const data = bytes(`${SCHEME}brick/normal`);
  let sloped = 0;
  for (let i = 0; i < data.length; i += 4) {
    assert.ok(data[i + 2]! >= 127, `z is never negative (texel ${i / 4})`);
    if (Math.abs(data[i]! - 128) > 12 || Math.abs(data[i + 1]! - 128) > 12) sloped++;
  }
  assert.ok(sloped > 0, "and the cell edges are sloped rather than flat");
});

test("the normal map's slope is the height map's slope, because both are the one field", () => {
  const height = bytes(`${SCHEME}tile/height`);
  const normal = bytes(`${SCHEME}tile/normal`);
  const size = sampleTexture(`${SCHEME}tile/height`)!.image.width;
  const at = (x: number, y: number) => height[(((y + size) % size) * size + ((x + size) % size)) * 4]!;

  // the two only have to agree on which way is downhill; how steep the map calls it is a scale factor
  let checked = 0;
  for (let y = 0; y < size; y += 7) {
    for (let x = 0; x < size; x += 7) {
      const dx = at(x + 1, y) - at(x - 1, y);
      if (Math.abs(dx) < 20) continue; // flat enough that the sign says nothing
      const nx = normal[(y * size + x) * 4]! - 128;
      assert.ok(nx * dx <= 0, `uphill in x is -x in the normal at ${x},${y}`);
      checked++;
    }
  }
  assert.ok(checked > 4, "and there were edges to check");
});

report("sample");
