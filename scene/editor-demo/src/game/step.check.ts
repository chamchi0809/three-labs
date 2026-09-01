// The fixed-step schedule, which is arithmetic and therefore checkable without a GPU:
//   1. ten seconds of frames is ten seconds of steps, at any refresh rate
//   2. a frame that took forever is not paid out forever
// node --experimental-strip-types src/game/step.check.ts
import assert from "node:assert/strict";
import { fixedStepSchedule } from "./step.ts";

/** ten seconds at one refresh rate: how many 60 Hz steps came out */
function over(hz: number, seconds = 10): number {
  const frame = 1000 / hz;
  let accumulator = 0;
  let steps = 0;
  for (let i = 0; i < hz * seconds; i++) {
    const out = fixedStepSchedule(accumulator, frame);
    accumulator = out.accumulator;
    steps += out.steps;
  }
  return steps;
}

for (const hz of [30, 60, 120, 144, 165, 240]) {
  const steps = over(hz);
  // 600 steps is ten seconds at 60 Hz; one step of rounding either way is the accumulator's remainder
  assert.ok(Math.abs(steps - 600) <= 1, `${hz} Hz produced ${steps} steps over ten seconds, not ~600`);
}

// a frame nobody was there for: half a second offered, five steps paid
assert.deepEqual(fixedStepSchedule(0, 500).steps, 5);
// …and a minute in a background tab is the same five, not 3600 of them
assert.deepEqual(fixedStepSchedule(0, 60_000).steps, 5);
// the debt does not carry over either, or the next frame would owe five again forever
assert.ok(fixedStepSchedule(0, 60_000).accumulator < 1 / 60);

// a frame shorter than a step banks it instead of dropping it
const short = fixedStepSchedule(0, 8);
assert.equal(short.steps, 0);
assert.ok(Math.abs(short.accumulator - 0.008) < 1e-9);
// …and three of them add up to one, 24 ms being the first multiple of 8 past a 16.67 ms step
assert.equal(fixedStepSchedule(short.accumulator, 8).steps, 0);
assert.equal(fixedStepSchedule(fixedStepSchedule(short.accumulator, 8).accumulator, 8).steps, 1);

// time never runs backwards, whatever the clock says
assert.deepEqual(fixedStepSchedule(0, -1000), { accumulator: 0, steps: 0 });

console.log("ok   the fixed step keeps 60 Hz at every refresh rate");
