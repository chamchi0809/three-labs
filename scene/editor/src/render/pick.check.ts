// Picking: the half of it that does not need a GPU. Faces are picked by rendering, which only a renderer
// can answer for, but handles are hit-tested on the CPU and that arithmetic is checkable here — and so is
// the thing a real renderer would only ever show as a flicker: when the pass puts the scene back.
// Run with: node --experimental-strip-types src/render/pick.check.ts
import assert from "node:assert/strict";
import { OrthographicCamera, type Renderer } from "three/webgpu";
import { report, settle, test } from "../check.ts";
import { demoMap } from "../doc/demo.ts";
import { newEditor } from "../doc/editor.ts";
import { newHandles, setHandles, type Handle } from "./handles.ts";
import { handleUnder, newPicker, pickAt } from "./pick.ts";
import { newRenderScene, syncScene } from "./scene.ts";

// a label rasterises text, and node has no canvas; the pass does not care what one looks like, only that
// it is hidden while the identities are drawn
(globalThis as { document?: unknown }).document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      font: "", textBaseline: "", fillStyle: "",
      measureText: (text: string) => ({ width: text.length * 7 }),
      beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, fillText() {},
    }),
  }),
};

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

// ---------------------------------------------------------------- the pass, and how long it lasts

/** what the scene is dressed as, in the four things the pass changes and the loop would draw */
const dress = (rs: ReturnType<typeof newRenderScene>, picking: unknown) => ({
  material: rs.faceMesh.material === picking ? "identity" : "colour",
  edges: rs.edgeLines.visible,
  labels: rs.labels.group.visible,
  grid: rs.gridPlane.visible,
});

/**
 * A renderer that records what the scene looked like at each step and hands the pixel back later.
 *
 * "Later" is the whole point: on a real device the readback resolves a frame or more after the draw, and
 * the animation loop draws the shared scene throughout. So this one resolves on a macrotask, and what is
 * asserted is what the scene was dressed as when the wait began.
 */
function spy(rs: ReturnType<typeof newRenderScene>, pixel: [number, number, number, number]) {
  const seen: Record<string, ReturnType<typeof dress> & { target: unknown }> = {};
  const note = (at: string) => { seen[at] = { ...dress(rs, renderer.picking), target: renderer.target }; };
  const renderer = {
    picking: undefined as unknown,
    target: null as unknown,
    getRenderTarget: () => renderer.target,
    getClearColor: (c: { setHex(v: number): unknown }) => (c.setHex(0x101010), c),
    getClearAlpha: () => 1,
    setRenderTarget: (t: unknown) => { renderer.target = t; },
    setClearColor: () => {},
    clear: () => {},
    render: () => note("drawing"),
    readRenderTargetPixelsAsync: async () => {
      note("waiting");
      await new Promise((r) => setTimeout(r, 0));
      note("read");
      return new Uint8Array(pixel);
    },
  };
  return { renderer, seen };
}

const scene = () => {
  const rs = newRenderScene();
  syncScene(rs, newEditor(demoMap()), false);
  return rs;
};

test("the pass draws identities with the map's own lines, labels and grid out of the way", async () => {
  const rs = scene();
  const picker = newPicker();
  const { renderer, seen } = spy(rs, [0, 0, 0, 255]);
  renderer.picking = picker.face;
  await pickAt(renderer as unknown as Renderer, picker, rs, camera, 10, 10, SIZE);
  assert.deepEqual(seen.drawing, {
    material: "identity", edges: false, labels: false, grid: false, target: picker.target,
  });
});

test("and puts every one of them back before it waits for the pixel, not after", () => {
  // A restore after the await is a restore that happens a frame late, and the frames in between draw the
  // map in identity colours with nothing over it — which is exactly what a flickering hover looks like.
  const rs = scene();
  const picker = newPicker();
  const was = dress(rs, picker.face);
  const { renderer, seen } = spy(rs, [0, 0, 0, 255]);
  renderer.picking = picker.face;
  const done = pickAt(renderer as unknown as Renderer, picker, rs, camera, 10, 10, SIZE);
  assert.deepEqual(seen.waiting, { ...was, target: null }, "restored, and the canvas is the target again");
  return done.then(() => assert.deepEqual(dress(rs, picker.face), was, "and still so once it has resolved"));
});

test("a pixel of nothing is nothing, and one with an identity in it is that solid's face", async () => {
  const rs = scene();
  const picker = newPicker();
  assert.deepEqual(
    await pickAt(spy(rs, [0, 0, 0, 255]).renderer as unknown as Renderer, picker, rs, camera, 1, 1, SIZE),
    {}, "black is the background, which is why every identity is one-based",
  );
  assert.deepEqual(
    await pickAt(spy(rs, [3, 0, 5, 255]).renderer as unknown as Renderer, picker, rs, camera, 1, 1, SIZE),
    { ordinal: 3, face: 5 },
  );
});

test("a pane of no size is not picked in at all, so a collapsed pane costs nothing", async () => {
  const rs = scene();
  const { renderer, seen } = spy(rs, [3, 0, 5, 255]);
  assert.deepEqual(await pickAt(renderer as unknown as Renderer, newPicker(), rs, camera, 0, 0, { width: 0, height: 8 }), {});
  assert.deepEqual(seen, {});
});

await settle();
report("pick");
