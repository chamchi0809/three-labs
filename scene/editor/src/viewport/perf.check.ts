// The frame meter. Worth checking because every number it reports is an average, and an average taken over
// the wrong denominator is the kind of wrong that looks plausible for months.
// Run with: node --experimental-strip-types src/viewport/perf.check.ts
import assert from "node:assert/strict";
import { report, test } from "../check.ts";
import { perf, SPANS } from "./perf.ts";

/** the meter is a singleton, as the editor has one render loop — so each test starts from nothing */
const fresh = () => perf.reset();

test("a steady sixteen milliseconds a frame is sixty frames a second", () => {
  fresh();
  for (let i = 1; i <= 120; i++) perf.frame(i * 16.667);
  const reading = perf.read();
  assert.ok(Math.abs(reading.fps - 60) < 0.1, `${reading.fps} fps`);
  assert.ok(Math.abs(reading.ms - 16.667) < 0.01);
});

test("the worst frame is reported next to the mean, because the mean hides it", () => {
  fresh();
  let at = 0;
  for (let i = 0; i < 119; i++) perf.frame((at += 8));
  perf.frame((at += 90));
  const reading = perf.read();
  assert.ok(reading.ms < 9, `a single stutter should barely move the mean, got ${reading.ms}`);
  assert.equal(reading.worst, 90);
});

test("the window is a window: what happened two seconds ago is gone", () => {
  fresh();
  let at = 0;
  perf.frame((at += 500)); // one appalling frame
  for (let i = 0; i < 130; i++) perf.frame((at += 10));
  const reading = perf.read();
  assert.equal(reading.worst, 10, "the 500 ms frame has been overwritten");
  assert.equal(reading.frames, 120);
});

test("the very first frame is not a gap, because there is nothing before it", () => {
  fresh();
  assert.deepEqual(
    { frames: perf.read().frames, fps: perf.read().fps },
    { frames: 0, fps: 0 },
    "a meter with no frames in it reports nothing rather than dividing by zero",
  );

  perf.frame(1000);
  assert.equal(perf.read().frames, 0, "one timestamp is not yet an interval");
  perf.frame(1016);
  assert.equal(perf.read().frames, 1);
});

test("a rebuilt renderer starts the window over rather than carrying the gap across", () => {
  fresh();
  let at = 0;
  for (let i = 0; i < 30; i++) perf.frame((at += 8));
  perf.span("draw", 5);
  perf.counted({ drawCalls: 9, triangles: 1, geometries: 1, textures: 1 });

  perf.reset();
  const reading = perf.read();
  assert.equal(reading.frames, 0);
  assert.equal(reading.worst, 0);
  assert.equal(reading.spans.draw, 0);
  assert.equal(reading.counts.drawCalls, 0);
});

test("a span is a mean over the times it ran, not over the frames that went past", () => {
  fresh();
  perf.span("pick", 30);
  perf.span("pick", 10);
  // `draw` ran sixty times this window and `pick` twice; averaging both over sixty would report the pick
  // as a millisecond, and a pick that costs twenty is the thing worth finding
  for (let i = 0; i < 60; i++) perf.span("draw", 2);
  const reading = perf.read();
  assert.equal(reading.spans.pick, 20);
  assert.equal(reading.spans.draw, 2);
});

test("reading a span empties it, so a still editor does not report yesterday's costs", () => {
  fresh();
  perf.span("sync", 40);
  assert.equal(perf.read().spans.sync, 40);
  assert.equal(perf.read().spans.sync, 0, "nothing has synced since");
});

test("timing something returns what it returned, and times it even when it throws", () => {
  fresh();
  assert.equal(perf.time("draw", () => 7), 7);
  assert.throws(() => perf.time("draw", () => { throw new Error("boom"); }), /boom/);
  assert.equal(perf.read().spans.draw >= 0, true, "both runs were counted");
});

test("every span has a place, so the panel never shows a blank row", () => {
  fresh();
  const reading = perf.read();
  for (const span of SPANS) assert.equal(typeof reading.spans[span], "number", span);
});

test("what the renderer drew is reported as the renderer last said it", () => {
  fresh();
  perf.counted({ drawCalls: 12, triangles: 34_000, geometries: 5, textures: 2 });
  assert.deepEqual(perf.read().counts, { drawCalls: 12, triangles: 34_000, geometries: 5, textures: 2 });
  // and it survives a read, unlike a span: it is a snapshot of now rather than a total since last time
  assert.equal(perf.read().counts.drawCalls, 12);
});

report("perf");
