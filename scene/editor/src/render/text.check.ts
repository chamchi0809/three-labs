// Words in the viewport, sized without a GPU.
//
// Every label is drawn once onto a canvas and then scaled per frame so it occupies a fixed number of screen
// pixels, and those two numbers used to disagree: pills drawn 23 pixels tall were shown at 13, so all the
// text in the editor came out at a bit over half the size it was designed at and soft with it. Nothing about
// that is visible to a type-checker and all of it is arithmetic, so it is checked here.
// Run with: node --experimental-strip-types src/render/text.check.ts
import assert from "node:assert/strict";
import { Group, OrthographicCamera, PerspectiveCamera } from "three/webgpu";
import { report, test } from "../check.ts";
import { newCompass, updateCompass } from "./compass.ts";
import { hideLabels, layoutLabels, newLabels, setLabel } from "./text.ts";

// A label rasterises text, and node has no canvas. The stub measures a glyph as seven wide, which is close
// enough to a monospace font that the aspect ratios below mean something.
(globalThis as { document?: unknown }).document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      font: "",
      textBaseline: "",
      fillStyle: "",
      measureText: (text: string) => ({ width: text.length * 7 }),
      beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, fillText() {},
    }),
  }),
};

/** the canvas a label was drawn on, which is the only way in to what it was drawn *at* */
function drawn(labels: ReturnType<typeof newLabels>, text: string) {
  // a cache key is the text, the colour and the background joined by NULs
  for (const [key, entry] of labels.cache) if (key.startsWith(`${text}\u0000`)) return entry;
  throw new Error(`no canvas for ${text}`);
}

// ---------------------------------------------------------------- the pill and the text in it

test("a label is drawn at a whole multiple of the size it is shown at", () => {
  const labels = newLabels(new Group());
  const label = setLabel(labels, "a", "12.5 m", [0, 0, 0]);
  const canvas = drawn(labels, "12.5 m");

  const supersample = canvas.height / label.pixels;
  assert.equal(supersample, Math.round(supersample), "the canvas is a whole-number supersample of the pill");
  assert.ok(supersample >= 2, `text wants at least two texels a pixel, got ${supersample}`);
});

test("the pill keeps its shape on screen", () => {
  const labels = newLabels(new Group());
  const camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
  const label = setLabel(labels, "a", "12.5 m", [0, 0, 0]);
  const canvas = drawn(labels, "12.5 m");
  layoutLabels(labels, camera, 200);

  assert.ok(
    Math.abs(label.sprite.scale.x / label.sprite.scale.y - canvas.width / canvas.height) < 1e-9,
    "a sprite as wide as its canvas: text stretched sideways is the other way to make it illegible",
  );
});

// ---------------------------------------------------------------- the same pixels at any distance

test("a label is the size it asked for, wherever it is", () => {
  const labels = newLabels(new Group());
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  const near = setLabel(labels, "near", "5 m", [0, 0, -4]);
  const far = setLabel(labels, "far", "5 m", [0, 0, -8]);
  layoutLabels(labels, camera, 400);

  // twice as far away is twice as big in the world, which is the same size on the screen
  assert.ok(
    Math.abs(far.sprite.scale.y / near.sprite.scale.y - 2) < 1e-6,
    `expected a doubling, got ${far.sprite.scale.y / near.sprite.scale.y}`,
  );
  // and half the viewport height is twice the world size for the same pixels
  const was = near.sprite.scale.y;
  layoutLabels(labels, camera, 200);
  assert.ok(Math.abs(near.sprite.scale.y / was - 2) < 1e-6, "pixels are a fraction of the viewport");
});

test("an orthographic label does not care how far away it is, only about the zoom", () => {
  const labels = newLabels(new Group());
  const camera = new OrthographicCamera(-2, 2, 2, -2, -100, 100);
  const near = setLabel(labels, "near", "5 m", [0, 0, -4]);
  const far = setLabel(labels, "far", "5 m", [0, 0, -40]);
  layoutLabels(labels, camera, 400);
  assert.ok(Math.abs(far.sprite.scale.y - near.sprite.scale.y) < 1e-9, "no perspective, no distance term");

  const was = near.sprite.scale.y;
  camera.zoom = 2;
  layoutLabels(labels, camera, 400);
  assert.ok(Math.abs(near.sprite.scale.y / was - 0.5) < 1e-6, "zooming in makes a world unit worth more pixels");
});

test("a hidden label is not laid out", () => {
  const labels = newLabels(new Group());
  const camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
  const label = setLabel(labels, "a", "5 m", [0, 0, 0]);
  layoutLabels(labels, camera, 200);
  const was = label.sprite.scale.y;
  hideLabels(labels);
  layoutLabels(labels, camera, 1);
  assert.equal(label.sprite.scale.y, was, "the scale of something invisible is nobody's arithmetic");
});

// ---------------------------------------------------------------- the axis dial

// The compass camera's box is solved for the letters: they sit at the end of the arms and need half their
// own height beyond that, and a box sized for the arms alone shaves the tops off X, Y and Z. The dial is
// drawn between 44 and 96 pixels depending on how the viewports are split, and because a letter is a
// fraction of the dial rather than a pixel count, both ends have to fit.
for (const size of [44, 64, 96]) {
  test(`the axis letters fit a ${size}px dial`, () => {
    const compass = newCompass();
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(6, 5, 7);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    updateCompass(compass, camera, size);

    const box = compass.camera.top;
    for (const [letter, label] of compass.labels.live) {
      if (!label.sprite.visible) continue;
      const half = Math.max(label.sprite.scale.x, label.sprite.scale.y) / 2;
      const reach = Math.max(
        Math.abs(label.sprite.position.x) + half,
        Math.abs(label.sprite.position.y) + half,
      );
      assert.ok(reach <= box + 1e-9, `${letter} reaches ${reach.toFixed(3)} of a ${box.toFixed(3)} box`);
    }
  });
}

test("the axis letters grow with the dial", () => {
  const compass = newCompass();
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(6, 5, 7);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  updateCompass(compass, camera, 44);
  const small = compass.labels.live.get("X")!.pixels;
  updateCompass(compass, camera, 96);
  const large = compass.labels.live.get("X")!.pixels;

  assert.ok(small >= 8, `a letter in the smallest dial is ${small}px, which is a smudge`);
  assert.ok(Math.abs(large / small - 96 / 44) < 1e-6, "the letter is a fixed fraction of the dial");
});

report("text");
