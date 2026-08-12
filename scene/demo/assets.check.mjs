// The sheets name things inside the binary assets by string — gltf("…/robot.glb"), find("Head"),
// play("Idle") — and nothing else notices when a regenerated asset stops containing them.
// node assets.check.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenes = path.join(here, "scenes");

// GLB: 12-byte header, then chunks of (uint32 length, 4-byte type, data). The first one is the JSON.
const glbJson = (file) => {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString("ascii", 0, 4), "glTF", `${file} is not a glb`);
  return JSON.parse(buf.toString("utf8", 20, 20 + buf.readUInt32LE(12)));
};

let checked = 0;
for (const name of fs.readdirSync(scenes).filter((f) => f.endsWith(".tscene"))) {
  const text = fs.readFileSync(path.join(scenes, name), "utf8");
  const at = (spec) => path.resolve(scenes, spec);

  for (const [, spec] of text.matchAll(/\btexture\(\s*"([^"]+)"/g)) {
    assert.ok(fs.existsSync(at(spec)), `${name}: texture("${spec}") does not exist`);
    assert.equal(fs.readFileSync(at(spec)).toString("ascii", 1, 4), "PNG", `${spec} is not a png`);
    checked++;
  }

  for (const [, spec] of text.matchAll(/\bgltf[^("]*\(\s*"([^"]+)"/g)) {
    assert.ok(fs.existsSync(at(spec)), `${name}: gltf("${spec}") does not exist`);
    const json = glbJson(at(spec));
    const nodes = json.nodes.map((n) => n.name);
    const clips = (json.animations ?? []).map((a) => a.name);
    // every find()/play() in this sheet has to hit something in the model it sits in
    for (const [, want] of text.matchAll(/\bfind[^("]*\(\s*(?:\w+\s*,\s*)?"([^"]+)"/g)) {
      assert.ok(nodes.includes(want), `${spec} has no node "${want}" (has ${nodes.join(", ")})`);
    }
    for (const [, want] of text.matchAll(/\bplay\(\s*"([^"]+)"/g)) {
      assert.ok(clips.includes(want), `${spec} has no clip "${want}" (has ${clips.join(", ")})`);
    }
    checked++;
  }
}

assert.ok(checked > 0, "no assets referenced by any sheet — the regexes stopped matching");
console.log(`ok — ${checked} asset references`);
