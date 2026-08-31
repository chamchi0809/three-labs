// What the editor writes has to be a sheet tscene accepts — not merely one it can re-read.
//
// The editor is its own reader, and for a long time that was the only reader anything was tested against:
// the round-trip checks prove that a save comes back as the same document, and the renderer draws from the
// editor's own palette rather than from tscene's runtime. Both are blind in the same direction. A sheet can
// round-trip perfectly, draw perfectly, and still be wrong the moment somebody loads it with `loadScene` —
// which is what a game does, what the lightmap baker does, and what the bake preview does.
//
// Four spellings were wrong at once and nothing said so. `color: #cfcabc` is a *number*, so the runtime
// assigned 13618364 to `material.color` and every colour in the demo became NaN — the baker traced the room
// and wrote a black atlas. `geometry: box(…)` named a class three does not have. `@broom { kind: "brush" }`
// quoted an enumerated knob the checker wants bare. `target: ref(#lamp)` set a property `Mesh` has not got.
//
// So this suite runs tscene's own checker over what the editor produces, which is the only reader whose
// opinion counts. Warnings are allowed through — "`.crate` is never applied" is a catalogue doing its job.
//
// Run with: node --experimental-strip-types src/io/valid.check.ts
import assert from "node:assert/strict";
import { parse, type Diagnostic } from "tscene";
import { checkSource, loadSchema, type Schema } from "tscene/tools";
import { report, settle, test } from "../check.ts";
import { DEMO_SHEET, demoMap } from "../doc/demo.ts";
import { writeWorld } from "./write.ts";

const ROOT = "untitled.tscene";

/**
 * The schema the editor's own maps are written against.
 *
 * `tscene/height` is in it because the demo's walls are `heightMaterial`, which is not part of three —
 * the same reason `src/bake/registry.ts` exists and passes the class to the runtime. Built once: the
 * reflection walks three's declaration files and takes a couple of seconds cold, and the whole point of
 * `cache` is that it is a file on disk the second time.
 */
let schema: Schema | undefined;
const schemaOf = (): Schema => (schema ??= loadSchema({ modules: ["tscene/height"], cache: true }));

/** the errors in a sheet, in the order they were found; warnings are not errors and are not failures */
async function errorsIn(text: string, file = ROOT): Promise<string[]> {
  const found: Diagnostic[] = await checkSource(text, file, schemaOf(), async (path) => {
    throw new Error(`nothing here should @import, and this one asked for ${path}`);
  });
  return found.filter((d) => d.severity === "error").map((d) => d.message);
}

/** the demo as the editor would save it: the catalogue's own text, with the map written into it */
const demoSheet = (): string => {
  const out = writeWorld(demoMap(), { root: ROOT, sheets: new Map([[ROOT, parse(DEMO_SHEET, ROOT)]]) });
  assert.deepEqual(out.problems, [], "writing the demo reported problems");
  return out.files.get(ROOT)!;
};

// ---------------------------------------------------------------- the demo

test("the demo catalogue is a sheet tscene accepts", async () => {
  assert.deepEqual(await errorsIn(DEMO_SHEET, "demo.tscene"), []);
});

test("the demo map, written the way a save writes it, is a sheet tscene accepts", async () => {
  assert.deepEqual(await errorsIn(demoSheet()), []);
});

// ---------------------------------------------------------------- the spellings that were wrong

test("a colour is written as color(#rrggbb), which is the only spelling that makes a Color", async () => {
  const text = demoSheet();
  assert.ok(text.includes("color: color(#fff2dd)"), "the sun's colour is not a call");
  assert.ok(
    !/(?<!@broom \{[^}\n]{0,200})\bcolor: #/.test(text),
    "a bare hex outside @broom assigns a number to material.color and bakes black",
  );
});

test("a bare hex in a colour slot is caught rather than assigned", async () => {
  const errors = await errorsIn(`mesh #a { material: meshStandardMaterial { color: #cfcabc; } }\n`);
  assert.ok(errors.some((e) => e.includes("expects Color")), errors.join("; ") || "no error at all");
});

test("@broom kind is written as a bare word, which is what an enumerated knob takes", async () => {
  assert.deepEqual(await errorsIn(`@template group.trigger {\n  @broom { kind: brush; }\n}\n`), []);
  const quoted = await errorsIn(`@template group.trigger {\n  @broom { kind: "brush"; }\n}\n`);
  assert.ok(quoted.some((e) => e.includes("point | brush")), quoted.join("; ") || "no error at all");
});

test("the switch points at the lamp through userData, which a Mesh actually has", async () => {
  const text = demoSheet();
  assert.ok(/userData: \{ target: ref\(#lamp\) \}/.test(text), text.slice(text.indexOf("#switch")));
  assert.deepEqual(await errorsIn(`mesh #a { target: ref(#a); }\n`).then((e) => e.length > 0), true);
});

// `@entity` is the level's own data, and the checker holds it to plain values — the entity grid writes a
// point as a list and a colour as a bare hex for exactly this reason. See `plain` in inspect/PropertyRow.
test("an entity's data is data: a point is a list and a colour a bare hex, never a call", async () => {
  const ok = `@template entity.m {
  @fields { p: { type: point }; c: { type: color } };
  @entity { p: [1, 2, 3]; c: #d0607a; };
}
entity.m #x { }
`;
  assert.deepEqual(await errorsIn(ok), []);
  for (const spelling of ["p: vec3(1, 2, 3)", "c: color(#d0607a)"]) {
    const errors = await errorsIn(ok.replace(/@entity \{[^}]*\}/, `@entity { ${spelling} }`));
    assert.ok(errors.some((e) => e.includes("must be a plain value")), `${spelling}: ${errors.join("; ") || "no error at all"}`);
  }
});

await settle();
report("valid");
