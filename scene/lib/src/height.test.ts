// node --experimental-strip-types src/height.test.ts
//
// The shader is not testable here and the arithmetic that decides what the shader does is, so this
// checks that arithmetic — which is the part with an opinion in it. Everything below is a property a
// designer would notice being broken: the relief does not pop, it does not survive past the fade, the
// march never runs longer than the loop it is compiled into, and edge-on costs more than square-on.
import assert from "node:assert/strict";
import { MAX_STEPS, TUNING, detailAt, stepsAt, tierAt, type HeightTuning } from "./height.ts";

const tests: [string, () => unknown][] = [];
const test = (name: string, fn: () => unknown) => tests.push([name, fn]);

const near = (a: number, b: number, slack = 1e-9) =>
  assert.ok(Math.abs(a - b) <= slack, `${a} is not within ${slack} of ${b}`);

test("everything closer than `full` gets the whole relief", () => {
  assert.equal(detailAt(0), 1);
  assert.equal(detailAt(TUNING.full / 2), 1);
  assert.equal(detailAt(TUNING.full), 1);
});

test("nothing past `fade` gets any of it", () => {
  assert.equal(detailAt(TUNING.fade), 0);
  assert.equal(detailAt(TUNING.fade * 10), 0);
});

test("detail only ever falls as the camera walks away", () => {
  let last = detailAt(0);
  for (let m = 0; m <= 40; m += 0.25) {
    const now = detailAt(m);
    assert.ok(now <= last + 1e-12, `detail rose from ${last} to ${now} at ${m} m`);
    last = now;
  }
});

// the whole reason for a smoothstep rather than a straight line: a linear ramp has a corner at each end,
// and a corner in the relief depth is a visible crease sliding across a wall as the camera moves
test("the ramp arrives and leaves flat, so there is no crease at either end", () => {
  const slope = (m: number) => (detailAt(m + 1e-4) - detailAt(m - 1e-4)) / 2e-4;
  near(slope(TUNING.full + 1e-3), 0, 1e-3);
  near(slope(TUNING.fade - 1e-3), 0, 1e-3);
  assert.ok(slope((TUNING.full + TUNING.fade) / 2) < -0.05, "the middle of the ramp should be falling");
});

test("the tiers hand over where they say they do", () => {
  assert.equal(tierAt(0), "ssdm");
  assert.equal(tierAt(TUNING.solid), "ssdm");
  assert.equal(tierAt(TUNING.solid + 0.01), "pom");
  assert.equal(tierAt(TUNING.fade - 0.01), "pom");
  assert.equal(tierAt(TUNING.fade), "normal");
  assert.equal(tierAt(1e6), "normal");
});

test("a project can move the boundaries without moving their order", () => {
  const far: HeightTuning = { full: 20, fade: 200, solid: 12, least: 4, most: 32 };
  assert.equal(tierAt(10, far), "ssdm");
  assert.equal(tierAt(50, far), "pom");
  assert.equal(tierAt(500, far), "normal");
});

test("no relief means no march at all", () => {
  assert.equal(stepsAt(0, 1), 0);
  assert.equal(stepsAt(detailAt(TUNING.fade + 1), 1), 0);
});

test("the march never outruns the loop it is compiled into", () => {
  for (const detail of [0.01, 0.5, 1]) {
    for (const facing of [0, 0.5, 1]) {
      for (const quality of [0.5, 1, 4, 100]) {
        const steps = stepsAt(detail, facing, quality);
        assert.ok(steps >= TUNING.least, `${steps} is below the floor`);
        assert.ok(steps <= MAX_STEPS, `${steps} is above the loop bound`);
      }
    }
  }
});

test("edge-on costs about twice what square-on costs", () => {
  const square = stepsAt(0.5, 1);
  const edge = stepsAt(0.5, 0);
  near(edge / square, 2, 0.06);
});

test("closer costs more, at any angle", () => {
  for (const facing of [0, 0.5, 1]) {
    assert.ok(stepsAt(1, facing) > stepsAt(0.25, facing), `detail did not raise the step count at ${facing}`);
  }
});

test("quality scales the march and is bounded by the same loop", () => {
  assert.ok(stepsAt(0.5, 1, 2) > stepsAt(0.5, 1, 1));
  assert.equal(stepsAt(1, 0, 8), MAX_STEPS);
  assert.equal(stepsAt(1, 1, 0.01), TUNING.least);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${(e as Error).message.split("\n").join("\n      ")}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} height`);
if (failed) process.exit(1);
