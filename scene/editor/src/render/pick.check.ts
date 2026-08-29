// Picking: the half of it that does not need a GPU. Faces are picked by rendering, which only a renderer
// can answer for, but handles are hit-tested on the CPU and that arithmetic is checkable here.
// Run with: node --experimental-strip-types src/render/pick.check.ts
import assert from "node:assert/strict";
import { OrthographicCamera } from "three/webgpu";
import { report, test } from "../check.ts";
import { newHandles, setHandles, type Handle } from "./handles.ts";
import { handleUnder } from "./pick.ts";

/** twenty metres across four hundred pixels, so one metre is exactly twenty pixels and the sums are legible */
const SIZE = { width: 400, height: 300 };
const camera = new OrthographicCamera(-10, 10, 7.5, -7.5, -1000, 1000);
camera.updateProjectionMatrix();
camera.updateMatrixWorld();

const handle = (at: [number, number, number]): Handle => ({ kind: "vertex", at, of: "a", part: 0, flags: 0 });

const set = newHandles();
setHandles(set, [handle([0, 0, 0]), handle([1, 0, 0])]);

test("a handle is found at the pixel its centre projects to", () => {
  assert.equal(handleUnder(set, camera, 200, 150, SIZE), set.handles[0]);
  assert.equal(handleUnder(set, camera, 220, 150, SIZE), set.handles[1], "a metre to the right is twenty pixels");
});

test("a near miss still counts, and a far one does not", () => {
  assert.equal(handleUnder(set, camera, 225, 150, SIZE), set.handles[1], "five pixels off is still aimed at it");
  assert.equal(handleUnder(set, camera, 220, 155, SIZE), set.handles[1], "and so is five pixels below");
  assert.equal(handleUnder(set, camera, 228, 150, SIZE), undefined, "eight is a click on the wall behind");
});

test("the nearest of a crowd wins, not the first", () => {
  assert.equal(handleUnder(set, camera, 215, 150, SIZE), set.handles[1]);
  assert.equal(handleUnder(set, camera, 205, 150, SIZE), set.handles[0]);
  assert.equal(handleUnder(set, camera, 210, 150, SIZE), undefined, "dead between them is neither");
});

test("a handle outside the frustum was never drawn, so it is never hit", () => {
  const away = newHandles();
  setHandles(away, [handle([0, 0, -2000])]);
  assert.equal(handleUnder(away, camera, 200, 150, SIZE), undefined, "past the far plane");
  setHandles(away, [handle([100, 0, 0])]);
  assert.equal(handleUnder(away, camera, 200, 150, SIZE), undefined, "and off to the side");
});

test("an empty set is asked about without answering", () => {
  assert.equal(handleUnder(newHandles(), camera, 200, 150, SIZE), undefined);
});

report("pick");
