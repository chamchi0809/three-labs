// The bake wire: how far along a bake is, how long it took, what a stream of lines turns back into, and
// which settings actually travel. Nothing here touches a GPU — the parts that do are a machine's to answer,
// and the parts that do not are exactly the parts that break silently.
// Run with: node --experimental-strip-types src/bake/bake.check.ts
import assert from "node:assert/strict";
import { report, settle, test } from "../check.ts";
import { only } from "./server.ts";
import {
  DEFAULT_SETTINGS, STAGES, WEIGHTS, clock, progressOf, readEvents, type Event, type Stage,
} from "./protocol.ts";

// ---------------------------------------------------------------- progress

test("the bar only ever goes forwards, over every stage in order", () => {
  let last = -1;
  for (const stage of STAGES) {
    for (const done of [0, 0.25, 0.5, 0.75, 1]) {
      const now = progressOf(stage, done);
      assert.ok(now >= last, `${stage} at ${done} went backwards: ${now} < ${last}`);
      last = now;
    }
  }
});

test("it starts at nothing and ends at everything", () => {
  assert.equal(progressOf("load", 0), 0);
  assert.equal(progressOf("write", 1), 1);
});

test("a stage's fraction is clamped, so a baker that overshoots does not overrun the bar", () => {
  assert.equal(progressOf("trace", 2), progressOf("trace", 1));
  assert.equal(progressOf("trace", -1), progressOf("trace", 0));
});

test("the trace is most of a bake, which is the whole reason the weights are not equal", () => {
  const total = STAGES.reduce((sum, s) => sum + WEIGHTS[s], 0);
  assert.ok(WEIGHTS.trace / total > 0.5, "a bar weighted evenly would sit at 55% for four minutes");
  for (const stage of STAGES) assert.ok(WEIGHTS[stage] > 0, `${stage} has no weight`);
});

test("every stage has a weight and every weight has a stage", () => {
  assert.deepEqual(Object.keys(WEIGHTS).sort(), [...STAGES].sort());
});

// ---------------------------------------------------------------- the clock

test("a bake's length reads the way a person would say it", () => {
  assert.equal(clock(0), "0s");
  assert.equal(clock(1400), "1s");
  assert.equal(clock(59_400), "59s");
  assert.equal(clock(60_000), "1m00s");
  assert.equal(clock(243_200), "4m03s", "the seconds are padded or 4m3s reads as 4m30s at a glance");
  assert.equal(clock(3_600_000), "60m00s");
  assert.equal(clock(-5), "0s", "a clock that has gone backwards says nothing rather than `-1s`");
});

// ---------------------------------------------------------------- the stream

/** a body that hands over exactly the chunks given, split wherever they were split */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= chunks.length) return controller.close();
      controller.enqueue(encoder.encode(chunks[at++]!));
    },
  });
}

const drain = async (chunks: string[]): Promise<Event[]> => {
  const out: Event[] = [];
  for await (const event of readEvents(streamOf(chunks))) out.push(event);
  return out;
};

const stage = (s: Stage, done: number) => JSON.stringify({ kind: "stage", stage: s, done });
const finish = JSON.stringify({
  kind: "done", manifest: "/@bake/out/map.lightmap.json", files: ["map.lightmap.json", "map.lightmap.png"],
  width: 1024, height: 1024, utilization: 0.62, exposure: 1, ms: 243_200,
});

test("a bake's lines come back as events, in order", async () => {
  const got = await drain([`${stage("load", 1)}\n${stage("trace", 0.5)}\n${finish}`]);
  assert.deepEqual(got.map((e) => e.kind), ["stage", "stage", "done"]);
  assert.equal(got[1]!.kind === "stage" && got[1].stage, "trace");
});

test("a line split across two chunks is still one line", async () => {
  const line = stage("unwrap", 0.25);
  const got = await drain([line.slice(0, 9), line.slice(9), "\n"]);
  assert.deepEqual(got, [{ kind: "stage", stage: "unwrap", done: 0.25 }]);
});

test("the last line arrives even though nothing follows it — and it is the one that matters", async () => {
  // the failure this exists to catch: a splitter that only yields on `\n` drops the `done` event, and the
  // bake looks like it stopped at 99% having written every file
  const got = await drain([`${stage("write", 1)}\n`, finish]);
  assert.equal(got.at(-1)?.kind, "done");
});

test("a multibyte character split down the middle is not two broken characters", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ kind: "warn", text: "1024² is too small" }));
  const half = bytes.indexOf(0xc2); // the first byte of `²`
  assert.ok(half > 0, "the fixture has to actually straddle a character");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, half + 1));
      controller.enqueue(bytes.subarray(half + 1));
      controller.close();
    },
  });
  const out: Event[] = [];
  for await (const event of readEvents(stream)) out.push(event);
  assert.equal(out[0]!.kind === "warn" && out[0].text, "1024² is too small");
});

test("blank lines are nothing, so a keep-alive newline is not a parse error", async () => {
  assert.deepEqual(await drain(["\n\n", `${stage("probe", 1)}\n`, "\n"]), [
    { kind: "stage", stage: "probe", done: 1 },
  ]);
});

test("an empty body is an empty bake rather than a throw", async () => {
  assert.deepEqual(await drain([]), []);
});

// ---------------------------------------------------------------- the settings

test("only what was set travels, so an unset one cannot shadow the sheet's own @bakery", () => {
  assert.deepEqual(only({ size: 2048 }), { size: 2048 });
  assert.deepEqual(only({}), {});
  assert.deepEqual(only({ samples: undefined, bounces: 4 }), { bounces: 4 });
});

test("a switch that is off still travels, because off is a thing a designer chose", () => {
  assert.deepEqual(only({ ao: false, exr: false }), { ao: false, exr: false });
});

test("`fit` is a real value and not an absent one", () => {
  // 0 is xatlas's own "work the density out", which is the panel's `fit` — dropping it as falsy would
  // silently hand the sheet's texelsPerUnit back
  assert.deepEqual(only({ texelsPerUnit: 0 }), { texelsPerUnit: 0 });
});

test("nothing outside the six settings can be posted through", () => {
  const smuggled = { size: 512, out: "../../etc", onProgress: "no" } as never;
  assert.deepEqual(only(smuggled), { size: 512 });
});

test("the defaults are a bake a person would wait for", () => {
  assert.deepEqual(Object.keys(only(DEFAULT_SETTINGS)).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  assert.ok(Number.isInteger(Math.log2(DEFAULT_SETTINGS.size)), "an atlas is a power of two");
});

await settle();
report("bake");
