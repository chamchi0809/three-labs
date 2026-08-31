/**
 * Twenty validators, each found and each fixed.
 *
 * Every case here is written the same way: build a map with exactly one thing wrong with it, check that
 * the checker says so, apply the quick fix, and check that the same map now has nothing wrong with it.
 * The last half of that is the part worth having — a fix that leaves the issue behind is worse than no
 * fix, because a designer clicks it twice and then stops trusting the browser.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/doc/issues.check.ts
 */
import { strict as assert } from "node:assert";
import { parse, type Vec3 } from "tscene";
import { brushOf as solidOf } from "../brush/brush.ts";
import { withFace } from "../brush/uv.ts";
import { cuboid } from "../brush/builder.ts";
import { report, test } from "../check.ts";
import { catalogueOfSheets, EMPTY } from "./catalogue.ts";
import {
  brushNode, entityNode, groupNode, layerNode, nodeById, patchNode, type Node, type World,
} from "./document.ts";
import { patchOf, patchShape } from "../patch/patch.ts";
import { linkedCopy } from "./groups.ts";
import {
  applyFix, applyFixes, describeIssues, EXTENT, issueCounts, issuesOf, VALIDATORS, validatorById,
  type Context, type Issue,
} from "./issues.ts";
import { num, ref, setVec3, SYNTHETIC } from "./props.ts";
import { translation } from "../brush/vec.ts";

const sheet = parse(`
--wall: meshStandardMaterial { color: #808080 }
@template mesh.torch { @broom { kind: "point" } intensity: 1 }
@template mesh.door { @broom { kind: "brush" } }
`, "library.tscene");

const catalogue = catalogueOfSheets([sheet]);

const box = (min: Vec3 = [0, 0, 0], max: Vec3 = [1, 1, 1], material = "wall") =>
  brushNode(solidOf(cuboid({ min, max }), { material }));

/** a flat patch, which is the one shape whose control points land on the grid a designer drew it on */
const curve = (min: Vec3 = [0, 0, 0], max: Vec3 = [2, 0, 2], material?: string) =>
  patchNode(patchShape("plane", min, max, material ? { material } : {}));

const world = (...children: Node[]): World =>
  ({ layers: [layerNode("Ground", children)], broom: { grid: -2, scale: 1 } });

const context = (w: World, over: Partial<Context> = {}): Context =>
  ({ world: w, catalogue, grid: 0.25, material: "wall", ...over });

/** the whole promise of a validator in one line: it finds the thing, and the fix makes it stop finding it */
function findsAndFixes(c: Context, id: string, expect = 1): Issue[] {
  const found = issuesOf(c).filter((i) => i.validator === id);
  assert.equal(found.length, expect, `${id} found ${found.length} of an expected ${expect}`);
  const world = applyFixes(c, found);
  assert.notEqual(world, c.world, `${id}'s fix did nothing`);
  const left = issuesOf({ ...c, world }).filter((i) => i.validator === id);
  assert.equal(left.length, 0, `${id} is still there after its own fix`);
  return found;
}

// ---------------------------------------------------------------- solids

test("a solid that is not solid is found and deleted", () => {
  const broken = brushNode({ poly: { vertices: [], faces: [] }, faces: [] });
  findsAndFixes(context(world(broken)), "invalid-solid");
});

test("a sliver with no volume is found and deleted", () => {
  findsAndFixes(context(world(box([0, 0, 0], [1, 1e-5, 1]))), "tiny-solid");
});

test("a solid beyond the world is found and deleted", () => {
  const far = box([EXTENT + 10, 0, 0], [EXTENT + 11, 1, 1]);
  findsAndFixes(context(world(far)), "out-of-bounds");
});

test("a corner off the grid is found and snapped onto it", () => {
  findsAndFixes(context(world(box([0.13, 0, 0], [1, 1, 1])), { grid: 0.25 }), "off-grid");
});

test("a solid on the grid is not reported, whatever the grid is", () => {
  const c = context(world(box([0, 0, 0], [2, 2, 2])), { grid: 1 });
  assert.deepEqual(issuesOf(c).filter((i) => i.validator === "off-grid"), []);
});

// ---------------------------------------------------------------- faces

test("a face scaled to nothing is found and reset", () => {
  const solid = box();
  solid.brush = withFace(solid.brush, 0, { scale: [0, 1] }) as typeof solid.brush;
  findsAndFixes(context(world(solid)), "uv-scale-zero");
});

test("a face with absurd material numbers is found and reset", () => {
  const solid = box();
  solid.brush = withFace(solid.brush, 2, { offset: [1e9, 0] }) as typeof solid.brush;
  findsAndFixes(context(world(solid)), "uv-out-of-range");
});

test("a face made of nothing is given the material in hand", () => {
  const bare = brushNode(solidOf(cuboid({ min: [0, 0, 0], max: [1, 1, 1] })));
  const found = findsAndFixes(context(world(bare)), "no-material", 6);
  assert.ok(found.every((i) => i.face !== undefined), "a face issue says which face");
});

test("a face made of something undeclared is found, and is silent when nothing is declared", () => {
  const solid = box([0, 0, 0], [1, 1, 1], "granite");
  findsAndFixes(context(world(solid)), "unknown-material", 6);
  const blind = context(world(solid), { catalogue: EMPTY, material: undefined });
  assert.deepEqual(issuesOf(blind).filter((i) => i.validator === "unknown-material"), [],
    "a project that declares no materials cannot say a name is wrong");
});

// ---------------------------------------------------------------- patches

test("a grid that is not a grid is found and deleted", () => {
  const ragged = patchNode(patchOf([[[0, 0, 0], [1, 0, 0], [2, 0, 0]], [[0, 0, 1], [1, 0, 1]]]));
  findsAndFixes(context(world(ragged)), "invalid-solid");
});

test("a control point off the grid is found and snapped onto it", () => {
  const c = context(world(curve([0.13, 0, 0], [1, 0, 1])), { grid: 0.25 });
  findsAndFixes(c, "off-grid");

  const square = context(world(curve([0, 0, 0], [2, 0, 2])), { grid: 1 });
  assert.deepEqual(issuesOf(square).filter((i) => i.validator === "off-grid"), []);
});

test("a surface with no thickness is not a sliver, because it was never meant to have any", () => {
  const c = context(world(curve([0, 0, 0], [2, 0, 2])), { grid: 1 });
  assert.deepEqual(issuesOf(c).filter((i) => i.validator === "tiny-solid"), [],
    "a patch has no volume to be too small");
});

test("a patch beyond the world is found and deleted", () => {
  findsAndFixes(context(world(curve([EXTENT + 10, 0, 0], [EXTENT + 11, 0, 1]))), "out-of-bounds");
});

test("a patch made of nothing is given the material in hand, on the one surface it has", () => {
  const found = findsAndFixes(context(world(curve())), "no-material", 1);
  assert.equal(found[0]!.face, 0, "a patch's surface is face 0, and the issue says so");
});

test("a patch made of something undeclared is found once, not six times", () => {
  findsAndFixes(context(world(curve([0, 0, 0], [2, 0, 2], "granite"))), "unknown-material", 1);
});

test("a patch scaled to nothing is found and reset", () => {
  const flat = patchNode(patchShape("plane", [0, 0, 0], [2, 0, 2], {
    material: "wall", uv: { offset: [0, 0], scale: [0, 1], rotation: 0 },
  }));
  findsAndFixes(context(world(flat)), "uv-scale-zero");
});

test("a brush entity wrapped around a patch is written around geometry, and is left alone", () => {
  const door = entityNode("mesh", { classes: ["door"], children: [curve([0, 0, 0], [2, 0, 2], "wall")] });
  const c = context(world(door));
  assert.deepEqual(issuesOf(c).filter((i) => i.validator === "empty-brush-entity"), [],
    "deleting this would delete a working part of the level");
});

test("a point entity holding a patch is found, and the patch is moved out to the layer", () => {
  const inner = curve([0, 0, 0], [2, 0, 2], "wall");
  const torch = entityNode("mesh", {
    classes: ["torch"], props: setVec3([], "position", [0, 0, 0]), children: [inner],
  });
  const c = context(world(torch));
  findsAndFixes(c, "point-with-solids");
  const fixed = applyFixes(c, issuesOf(c).filter((i) => i.validator === "point-with-solids"));
  assert.ok(nodeById(fixed, inner.id), "the patch survived being moved out");
});

// ---------------------------------------------------------------- entities

test("a class with no template is found and taken off", () => {
  const node = entityNode("mesh", { classes: ["lantern"], props: setVec3([], "position", [0, 0, 0]) });
  const found = findsAndFixes(context(world(node)), "missing-definition");
  assert.equal(found[0]!.prop, "lantern");
});

test("a class is not reported when the project declares no templates at all", () => {
  const node = entityNode("mesh", { classes: ["lantern"] });
  const blind = context(world(node), { catalogue: EMPTY });
  assert.deepEqual(issuesOf(blind).filter((i) => i.validator === "missing-definition"), []);
});

test("a point entity holding solids is found, and the solids are moved out to the layer", () => {
  const inner = box();
  const torch = entityNode("mesh", {
    classes: ["torch"], props: setVec3([], "position", [0, 0, 0]), children: [inner],
  });
  const c = context(world(torch));
  findsAndFixes(c, "point-with-solids");
  const fixed = applyFixes(c, issuesOf(c).filter((i) => i.validator === "point-with-solids"));
  assert.ok(nodeById(fixed, inner.id), "the solid survived being moved out");
  assert.deepEqual((nodeById(fixed, torch.id) as { children: Node[] }).children, []);
});

test("a brush entity with no solids is found and deleted", () => {
  const door = entityNode("mesh", { classes: ["door"] });
  findsAndFixes(context(world(door)), "empty-brush-entity");
});

test("a point entity that was never placed is found and put at the origin", () => {
  const torch = entityNode("mesh", { classes: ["torch"] });
  findsAndFixes(context(world(torch)), "no-position");
});

test("a reference to a name nothing has is found and removed", () => {
  const node = entityNode("mesh", {
    props: [{ ...SYNTHETIC, kind: "prop", name: "target", value: ref("gate") }],
  });
  const found = findsAndFixes(context(world(node)), "broken-ref");
  assert.equal(found[0]!.prop, "target");
});

test("a reference that resolves is left alone", () => {
  const gate = { ...box(), sheetId: "gate" };
  const node = entityNode("mesh", {
    props: [{ ...SYNTHETIC, kind: "prop", name: "target", value: ref("gate") }],
  });
  const c = context(world(gate, node));
  assert.deepEqual(issuesOf(c).filter((i) => i.validator === "broken-ref"), []);
});

test("two nodes answering to one name are found, and the second gets a name of its own", () => {
  const a = { ...box(), sheetId: "crate" };
  const b = { ...box([2, 0, 0], [3, 1, 1]), sheetId: "crate" };
  const c = context(world(a, b));
  findsAndFixes(c, "duplicate-id");
  const fixed = applyFixes(c, issuesOf(c).filter((i) => i.validator === "duplicate-id"));
  assert.equal(nodeById(fixed, a.id)!.sheetId, "crate");
  assert.equal(nodeById(fixed, b.id)!.sheetId, "crate-2");
});

test("a property written without a name is found and removed", () => {
  const node = entityNode("mesh", {
    props: [{ ...SYNTHETIC, kind: "prop", name: "  ", value: num(1) }],
  });
  findsAndFixes(context(world(node)), "empty-property-name");
});

// ---------------------------------------------------------------- structure

test("a group holding nothing is found and deleted", () => {
  findsAndFixes(context(world(groupNode("room"))), "empty-group");
});

test("a group or layer with no name is found and named", () => {
  const group = groupNode("  ", [box()]);
  findsAndFixes(context(world(group)), "unnamed");

  const nameless: World = { layers: [layerNode("")], broom: { grid: -2, scale: 1 } };
  findsAndFixes(context(nameless), "unnamed");
});

test("two layers with one name are found and one is renamed", () => {
  const twice: World = {
    layers: [layerNode("Ground"), layerNode("Ground")],
    broom: { grid: -2, scale: 1 },
  };
  const c = context(twice);
  findsAndFixes(c, "duplicate-layer-name");
});

test("a link set of one is found and unlinked", () => {
  const alone = groupNode("room", [box()], { broom: { link: "room" } });
  findsAndFixes(context(world(alone)), "link-of-one");
});

test("copies that stopped matching are found, and the fix brings them back into step", () => {
  const source = groupNode("room", [box(), box([2, 0, 0], [3, 1, 1])]);
  const { world: made, copy } = linkedCopy(world(source), source.id, translation([10, 0, 0]));
  // one copy loses a solid the other still has, which is exactly the state propagation exists to end
  const broken: World = {
    ...made,
    layers: made.layers.map((l) => ({
      ...l,
      children: l.children.map((n) => (n.id === copy!.id ? { ...copy!, children: [copy!.children[0]!] } : n)),
    })),
  };
  const c = context(broken);
  findsAndFixes(c, "link-out-of-step");
});

// ---------------------------------------------------------------- the browser's own needs

test("every validator is declared once, and every issue it makes names it", () => {
  assert.equal(VALIDATORS.length, 20);
  assert.equal(new Set(VALIDATORS.map((v) => v.id)).size, 20);
  for (const v of VALIDATORS) {
    assert.equal(validatorById(v.id), v);
    assert.ok(v.fix, `${v.id} has no quick fix, and every issue here has one`);
  }
});

test("errors are listed before warnings, and counted for the list beside them", () => {
  const bad = box([0.13, 0, 0], [1, 1, 1], "granite");
  const c = context(world(bad));
  const issues = issuesOf(c);
  const firstWarning = issues.findIndex((i) => i.severity === "warning");
  assert.ok(firstWarning === -1 || issues.slice(firstWarning).every((i) => i.severity === "warning"));

  const counts = issueCounts(issues);
  assert.equal(counts.get("unknown-material"), 6);
  assert.equal(counts.get("off-grid"), 1);
  assert.ok(describeIssues(issues).includes("error"));
  assert.equal(describeIssues([]), "no issues");
});

test("a validator can be turned off, and then it finds nothing", () => {
  const c = context(world(box([0.13, 0, 0], [1, 1, 1])));
  assert.ok(issuesOf(c).some((i) => i.validator === "off-grid"));
  assert.ok(!issuesOf(c, ["off-grid"]).some((i) => i.validator === "off-grid"));
});

test("fixing an issue whose node has already gone is skipped rather than guessed at", () => {
  const gone = groupNode("room");
  const c = context(world(gone));
  const issues = issuesOf(c).filter((i) => i.validator === "empty-group");
  const once = applyFixes(c, issues);
  // the same list applied to the world it already emptied leaves that world alone
  assert.equal(applyFixes({ ...c, world: once }, issues), once);
  assert.equal(applyFix({ ...c, world: once }, { ...issues[0]!, validator: "nonsense" }), once);
});

test("a clean map has nothing to say", () => {
  const clean = groupNode("room", [box([0, 0, 0], [2, 2, 2])]);
  const c = context(world(clean), { grid: 1 });
  assert.deepEqual(issuesOf(c).map((i) => `${i.validator}: ${i.message}`), []);
});

report("issues");
