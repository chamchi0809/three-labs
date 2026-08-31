// `@template` and `@override`: that the editor agrees with `expand()` about who wins, says so honestly
// when an edit would be shadowed, and never hands a derived node to the writer.
// Run with: node --experimental-strip-types src/io/inherit.check.ts
import assert from "node:assert/strict";
import { parse, type Compound, type Member, type Override } from "tscene";
import { report, test } from "../check.ts";
import { childrenOf, type Node, type World } from "../doc/document.ts";
import {
  chainsOf, derivedChildren, derivedIds, effective, layersOf, nameOf, resolveInheritance, routesFor,
  selects, type Inheritance,
} from "./inherit.ts";
import { readWorld, type Sheets } from "./read.ts";
import { writeWorld } from "./write.ts";

const ROOT = "map.tscene";

const opened = (text: string): { world: World; inh: Inheritance; sheets: Sheets } => {
  const sheets: Sheets = new Map([[ROOT, parse(text, ROOT)]]);
  const read = readWorld(ROOT, sheets);
  return { world: read.world, inh: resolveInheritance(read.world, read), sheets };
};

const find = (world: World, sheetId: string): Node => {
  const search = (node: Node): Node | undefined => {
    if (node.sheetId === sheetId) return node;
    for (const kid of childrenOf(node)) {
      const hit = search(kid);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const layer of world.layers) {
    const hit = search(layer);
    if (hit) return hit;
  }
  throw new Error(`no node #${sheetId}`);
};

/** the members a node contributes itself — what `layersOf` wants in the middle */
const own = (node: Node): Member[] => node.props;

/** the selector of an `@override`, parsed rather than hand-built, so the checks test what the parser makes */
function rule(text: string): Compound[] {
  const first = parse(text, ROOT).statements[0]!;
  assert.equal(first.kind, "override", text);
  return (first as Override).selector;
}

// ---------------------------------------------------------------- selectors

test("a selector matches on type, class and id the way the parser wrote them", () => {
  const { world } = opened(`mesh.lit #a (boxGeometry(1, 1, 1));\n`);
  const chain = [find(world, "a")];
  assert.ok(selects(rule(`@override mesh { x: 1; }`), chain), "by type");
  assert.ok(selects(rule(`@override .lit { x: 1; }`), chain), "by class");
  assert.ok(selects(rule(`@override #a { x: 1; }`), chain), "by id");
  assert.ok(!selects(rule(`@override .dark { x: 1; }`), chain), "a class it lacks");
  assert.ok(!selects(rule(`@override pointLight { x: 1; }`), chain), "another type");
});

test("a descendant selector skips generations, and an ancestor it never had does not match", () => {
  const { world } = opened(
    `group #Outer {\n  group #Inner {\n    mesh #a (boxGeometry(1, 1, 1));\n  }\n}\n\nmesh #b (boxGeometry(1, 1, 1));\n`,
  );
  const chains = chainsOf(world);
  const deep = chains.get(find(world, "a").id)!;
  assert.deepEqual(deep.map((n) => n.sheetId), ["Outer", "Inner", "a"]);
  assert.ok(selects(rule(`@override #Outer mesh { x: 1; }`), deep), "a grandparent still selects");
  assert.ok(selects(rule(`@override #Outer #Inner mesh { x: 1; }`), deep), "every step named");
  assert.ok(!selects(rule(`@override #Inner #Outer mesh { x: 1; }`), deep), "and in the wrong order it does not");
  assert.ok(!selects(rule(`@override #Outer mesh { x: 1; }`), chains.get(find(world, "b").id)!), "no such ancestor");
});

test("the implicit layer is the file rather than a group, so nothing nests inside it", () => {
  const { world } = opened(`mesh #a (boxGeometry(1, 1, 1));\n`);
  assert.ok(world.layers[0]!.origin?.isFile);
  assert.deepEqual(chainsOf(world).get(find(world, "a").id)!.map((n) => n.sheetId), ["a"]);
});

// ---------------------------------------------------------------- precedence

const LAYERED = `@template .wall {
  castShadow: true;
  receiveShadow: true;
}

@override mesh.wall {
  castShadow: false;
}

mesh.wall #a (boxGeometry(1, 1, 1)) {
  castShadow: true;
  frustumCulled: false;
}
`;

test("an @override beats the node, which beats its @template", () => {
  const { world, inh } = opened(LAYERED);
  const a = find(world, "a");
  const layers = layersOf(a, own(a), inh);
  assert.deepEqual(layers.map((l) => l.from), ["template", "template", "own", "own", "override"]);

  const now = effective(layers);
  assert.equal(now.get("castShadow")!.winner.from, "override", "the rule is applied last and wins");
  assert.deepEqual(now.get("castShadow")!.shadowed.map((l) => l.from), ["template", "own"]);
  assert.equal(now.get("receiveShadow")!.winner.from, "template", "nobody said it twice");
  assert.equal(now.get("frustumCulled")!.winner.from, "own");
});

test("a template a node names but nobody wrote is reported rather than ignored", () => {
  const { inh } = opened(`mesh.ghost #a (boxGeometry(1, 1, 1));\n`);
  assert.deepEqual(inh.problems, ["unknown template .ghost"]);
});

test("two templates are applied in the order the classes are written in", () => {
  const { world, inh } = opened(
    `@template .a { renderOrder: 1; }\n@template .b { renderOrder: 2; }\n\nmesh.a.b #m (boxGeometry(1, 1, 1));\n`,
  );
  const m = find(world, "m");
  assert.deepEqual(inh.templates.get(m.id)!.map((t) => t.name), ["a", "b"]);
  const winner = effective(layersOf(m, own(m), inh)).get("renderOrder")!.winner;
  assert.equal(nameOf(winner.member), "renderOrder");
  assert.equal(winner.label, ".b", "the last class written is the one that stands");
});

test("a --var and an @broom are settings too, and are named apart from properties", () => {
  const { world, inh } = opened(`group #G {\n  @broom { locked: true };\n  --tint: #ff0000;\n}\n`);
  const g = find(world, "G");
  const now = effective(layersOf(g, own(g), inh));
  assert.ok(now.has("--tint"), [...now.keys()].join(", "));
  // `@broom` is the editor's own annotation and is lifted out of `props` when the sheet is read
  assert.equal(g.broom.locked, true);
});

// ---------------------------------------------------------------- where an edit should go

test("a route says plainly when setting it on the node would change nothing", () => {
  const { world, inh } = opened(LAYERED);
  const a = find(world, "a");
  const routes = routesFor(a, "castShadow", layersOf(a, own(a), inh));

  assert.equal(routes[0]!.target, "node");
  assert.equal(routes[0]!.effective, false, "an @override is applied after it");
  assert.match(routes[0]!.why, /would still win/);

  const rule = routes.find((r) => r.target === "override")!;
  assert.equal(rule.effective, true);
  assert.match(rule.why, /every node it reaches/);

  const template = routes.find((r) => r.target === "template")!;
  assert.equal(template.effective, false, "it lost to both of the others");
});

test("with nothing shadowing it, the node is the honest place to write it", () => {
  const { world, inh } = opened(`mesh #a (boxGeometry(1, 1, 1)) {\n  castShadow: true;\n}\n`);
  const a = find(world, "a");
  const routes = routesFor(a, "castShadow", layersOf(a, own(a), inh));
  assert.deepEqual(routes.map((r) => r.target), ["node"]);
  assert.equal(routes[0]!.effective, true);
});

test("a setting only a template has is still offered on the node", () => {
  const { world, inh } = opened(`@template .wall { castShadow: true; }\n\nmesh.wall #a (boxGeometry(1, 1, 1));\n`);
  const a = find(world, "a");
  const routes = routesFor(a, "castShadow", layersOf(a, own(a), inh));
  assert.equal(routes[0]!.target, "node");
  assert.equal(routes[0]!.effective, true, "a template loses to the node, so writing it there shows");
  assert.equal(routes[1]!.target, "template");
  assert.equal(routes[1]!.file, ROOT);
});

// ---------------------------------------------------------------- derived children

const TORCH = `@template .torch {
  pointLight(#ffaa44, 3) {
    position: vec3(0, 1.4, 0);
  }
}

@override mesh.torch {
  sphere #halo (sphereGeometry(0.3));
}

mesh.torch #sconce (boxGeometry(0.2, 0.6, 0.2));
`;

test("the children a template and a rule contribute are visible, and marked as not ours", () => {
  const { world, inh, sheets } = opened(TORCH);
  const sconce = find(world, "sconce");
  const kids = derivedChildren(sconce, inh, sheets);
  assert.deepEqual(kids.map((k) => (k.kind === "entity" ? k.type : k.kind)), ["pointLight", "sphere"]);
  assert.deepEqual(kids.map((k) => k.origin?.derived), ["template", "override"]);
  assert.deepEqual(kids.map((k) => k.origin?.of), [sconce.id, sconce.id]);
  assert.ok(kids.every((k) => k.id.startsWith(`${sconce.id}~`)), "ids hang off the host, so selection survives");
});

test("a derived node put in the tree is never written back", () => {
  const sheets: Sheets = new Map([[ROOT, parse(TORCH, ROOT)]]);
  const read = readWorld(ROOT, sheets);
  const inh = resolveInheritance(read.world, read);
  const sconce = find(read.world, "sconce");
  const kids = derivedChildren(sconce, inh, sheets);

  // the tree the outliner shows: the host with its derived children hung underneath
  const shown: World = {
    ...read.world,
    layers: read.world.layers.map((l) => ({
      ...l,
      children: l.children.map((k) => (k.id === sconce.id && k.kind === "entity" ? { ...k, children: kids } : k)),
    })),
  };
  assert.equal(derivedIds(shown).length, 2, "both of them are in the tree");

  const out = writeWorld(shown, { root: ROOT, sheets });
  assert.deepEqual(out.problems, []);
  assert.equal(out.files.get(ROOT), TORCH, "showing them did not write them into the file");
});

report("inherit");
