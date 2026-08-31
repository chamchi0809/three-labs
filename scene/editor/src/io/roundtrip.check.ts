// The round trip. The property everything else rests on is the first one below: read a file, change
// nothing, write it, and get the same bytes — including the comments, the hand formatting, the `calc()`
// the editor has no model for, and the `@import`ed files it never looked at twice.
// Run with: node --experimental-strip-types src/io/roundtrip.check.ts
import assert from "node:assert/strict";
import { parse } from "tscene";
import { report, test } from "../check.ts";
import { cuboid } from "../brush/builder.ts";
import { brushOf } from "../brush/brush.ts";
import {
  brushNode, childrenOf, entityNode, moveNodes, patchNode, removeNodes, updateNode, type BrushNode,
  type EntityNode, type GroupNode, type Node, type PatchNode, type World,
} from "../doc/document.ts";
import { addRow, movePoints, patchShape, patchUv, rowsOf } from "../patch/patch.ts";
import { setNumber, setString } from "../doc/props.ts";
import { readWorld, type Sheets } from "./read.ts";
import { writeWorld, type Project } from "./write.ts";

const ROOT = "map.tscene";

const project = (files: Record<string, string>, root = ROOT): { project: Project; world: World } => {
  const sheets: Sheets = new Map();
  for (const [file, text] of Object.entries(files)) sheets.set(file, parse(text, file));
  const { world } = readWorld(root, sheets);
  return { project: { root, sheets }, world };
};

/** what a save produces for one file */
const saved = (world: World, p: Project, file = ROOT): string => {
  const out = writeWorld(world, p);
  assert.deepEqual(out.problems, [], "a save reported problems");
  return out.files.get(file)!;
};

const find = (world: World, sheetId: string): Node => {
  for (const layer of world.layers) {
    const hit = search(layer, sheetId);
    if (hit) return hit;
  }
  throw new Error(`no node #${sheetId}`);
};
const search = (node: Node, sheetId: string): Node | undefined => {
  if (node.sheetId === sheetId) return node;
  for (const kid of childrenOf(node)) {
    const hit = search(kid, sheetId);
    if (hit) return hit;
  }
  return undefined;
};

// ---------------------------------------------------------------- identity

const HAND_WRITTEN = `// the west wing, rebuilt after the fire
@broom { grid: -2; scale: 1 };

--wall: standardMaterial({ color: #8899aa });

@template .torch {
  pointLight(#ffaa44, 3) {
    position: vec3(0, 1.4, 0);
  }
}

@override .lit mesh {
  castShadow: true;
}

group #Hall {
  @broom { locked: false };

  /* the floor is one solid so the lightmap has one chart */
  brush {
    face(vec3(4, -1, 0), vec3(4, 0, 0), vec3(4, -1, 4))
    face(vec3(0, -1, 0), vec3(0, -1, 4), vec3(0, 0, 0))
    face(vec3(0, 0, 0), vec3(0, 0, 4), vec3(4, 0, 0)) { material: var(--wall); }
    face(vec3(0, -1, 0), vec3(4, -1, 0), vec3(0, -1, 4))
    face(vec3(0, -1, 4), vec3(4, -1, 4), vec3(0, 0, 4))
    face(vec3(0, -1, 0), vec3(0, 0, 0), vec3(4, -1, 0))
  }

  mesh.torch.lit #sconce (boxGeometry(0.2, 0.6, 0.2), var(--wall)) {
    position: vec3(calc(4 / 2), 2, 0);
    rotation.y: 90deg;
  }
}

pointLight #sun (#ffffff, 1.5) {
  position: vec3(0, 8, 0);
}
`;

test("a file read and written unchanged is the same file, byte for byte", () => {
  const { project: p, world } = project({ [ROOT]: HAND_WRITTEN });
  assert.equal(saved(world, p), HAND_WRITTEN);
});

test("an @import is followed without the imported file being rewritten", () => {
  const files = {
    [ROOT]: `@import "./props.tscene";\n\ngroup #Hall {\n  mesh #a (boxGeometry(1, 1, 1));\n}\n`,
    "props.tscene": `// shared props\n--wall: standardMaterial({ color: #445566 });\n\nmesh #crate (boxGeometry(1, 1, 1));\n`,
  };
  const { project: p, world } = project(files);
  const out = writeWorld(world, p);
  assert.deepEqual(out.problems, []);
  assert.equal(out.files.get(ROOT), files[ROOT]);
  assert.equal(out.files.get("props.tscene"), files["props.tscene"]);
  assert.ok(find(world, "crate"), "the imported node is in the tree");
});

test("a file with nothing the editor understands still comes back whole", () => {
  const odd = `--n: 3;\n\nrepeat(var(--n)) {\n  mesh (boxGeometry(1, 1, 1)) {\n    position: vec3(calc(var(--index) * 2), 0, 0);\n  }\n}\n\nline (splineCurve([vec3(0, 0, 0), vec3(1, 2, 3)]).getPoints(120));\n`;
  const { project: p, world } = project({ [ROOT]: odd });
  assert.equal(saved(world, p), odd);
});

test("a brush the editor could not read stays an entity and survives untouched", () => {
  const weird = `brush #odd {\n  face(var(--a), vec3(1, 0, 0), vec3(0, 0, 1));\n  face(vec3(0, -1, 0), vec3(0, -1, 1), vec3(1, -1, 0));\n}\n`;
  const { project: p, world } = project({ [ROOT]: weird });
  assert.equal(find(world, "odd").kind, "entity", "an unreadable solid is not a solid");
  assert.equal(saved(world, p), weird);
});

// ---------------------------------------------------------------- surgical edits

test("one property changed touches one line", () => {
  const before = `group #Hall {\n  // do not move this\n  mesh #a (boxGeometry(1, 1, 1)) {\n    position: vec3(0, 0, 0);\n    castShadow: true;\n  }\n}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const a = find(world, "a") as EntityNode;
  const next = updateNode<EntityNode>(world, a.id, (n) => ({ ...n, props: setNumber(n.props, "position", 4) }));
  assert.equal(
    saved(next, p),
    `group #Hall {\n  // do not move this\n  mesh #a (boxGeometry(1, 1, 1)) {\n    position: 4;\n    castShadow: true;\n  }\n}\n`,
  );
});

test("a property the editor never touched is not reformatted", () => {
  const before = `mesh #a (boxGeometry(1, 1, 1)) {\n  position:   vec3( 0,0 , 0 );\n  castShadow: true;\n}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const a = find(world, "a") as EntityNode;
  const next = updateNode<EntityNode>(world, a.id, (n) => ({ ...n, props: setString(n.props, "userData", "x") }));
  const text = saved(next, p);
  assert.ok(text.includes("position:   vec3( 0,0 , 0 );"), "the untouched line kept its spacing");
  assert.ok(text.includes('userData: "x";'), "the new one was appended");
});

test("a property removed takes its whole line with it", () => {
  const before = `mesh #a (boxGeometry(1, 1, 1)) {\n  position: vec3(0, 0, 0);\n  castShadow: true;\n}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const a = find(world, "a") as EntityNode;
  const next = updateNode<EntityNode>(world, a.id, (n) => ({ ...n, props: n.props.filter((m) => m.kind !== "prop" || m.name !== "position") }));
  assert.equal(saved(next, p), `mesh #a (boxGeometry(1, 1, 1)) {\n  castShadow: true;\n}\n`);
});

test("a node deleted leaves no blank line behind", () => {
  const before = `group #Hall {\n  mesh #a (boxGeometry(1, 1, 1));\n  mesh #b (boxGeometry(1, 1, 1));\n}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const next = removeNodes(world, [find(world, "a").id]);
  assert.equal(saved(next, p), `group #Hall {\n  mesh #b (boxGeometry(1, 1, 1));\n}\n`);
});

test("a new node is printed into the body it was dropped into", () => {
  const before = `group #Hall {\n  mesh #a (boxGeometry(1, 1, 1));\n}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const hall = find(world, "Hall") as GroupNode;
  const fresh = brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [1, 1, 1] })));
  const next = updateNode<GroupNode>(world, hall.id, (n) => ({ ...n, children: [...n.children, fresh] }));
  const text = saved(next, p);
  assert.ok(text.startsWith(`group #Hall {\n  mesh #a (boxGeometry(1, 1, 1));\n  brush {\n`), text);
  assert.equal(text.match(/face\(/g)?.length, 6, "six faces");
  assert.ok(text.endsWith("}\n"), text.slice(-40));
});

test("a node moved between groups takes its comments with it", () => {
  const before = `group #A {\n  // the one that matters\n  mesh #a (boxGeometry(1, 1, 1)) {\n    castShadow: true;\n  }\n}\n\ngroup #B {\n}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const next = moveNodes(world, [find(world, "a").id], find(world, "B").id);
  const text = saved(next, p);
  assert.equal(text.indexOf("mesh #a"), text.lastIndexOf("mesh #a"), "it exists exactly once");
  assert.ok(
    text.includes(
      `group #B {\n  // the one that matters\n  mesh #a (boxGeometry(1, 1, 1)) {\n    castShadow: true;\n  }\n}`,
    ),
    text,
  );
  assert.ok(text.startsWith("group #A {\n}"), text);
});

test("an empty body is opened out when something is put in it", () => {
  const before = `group #A {}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const fresh = entityNode("pointLight", { sheetId: "sun" });
  const next = updateNode<GroupNode>(world, find(world, "A").id, (n) => ({ ...n, children: [fresh] }));
  assert.equal(saved(next, p), `group #A {\n  pointLight #sun\n}\n`);
});

// ---------------------------------------------------------------- solids

test("a face's material is rewritten and its neighbours are not", () => {
  const before =
    `brush #b {\n` +
    `  face(vec3(1, 0, 0), vec3(1, 1, 0), vec3(1, 0, 1)) { material: var(--wall); }\n` +
    `  face(vec3(0, 0, 0), vec3(0, 0, 1), vec3(0, 1, 0))\n` +
    `  face(vec3(0, 1, 0), vec3(0, 1, 1), vec3(1, 1, 0))\n` +
    `  face(vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 0, 1))\n` +
    `  face(vec3(0, 0, 1), vec3(1, 0, 1), vec3(0, 1, 1))\n` +
    `  face(vec3(0, 0, 0), vec3(0, 1, 0), vec3(1, 0, 0))\n` +
    `}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const b = find(world, "b") as BrushNode;
  assert.equal(b.kind, "brush");
  const painted = updateNode<BrushNode>(world, b.id, (n) => ({
    ...n,
    brush: { ...n.brush, faces: n.brush.faces.map((f, i) => (i === 0 ? { ...f, material: "floor" } : f)) },
  }));
  const text = saved(painted, p);
  assert.equal(text.match(/material: var\(--floor\)/g)?.length, 1, text);
  assert.equal(text.match(/material:/g)?.length, 1, "only one face names a material");
  // every other line is untouched
  for (const line of before.split("\n").slice(2, -2)) assert.ok(text.includes(line), line);
});

test("a solid with a different number of sides is rewritten as a block", () => {
  const { project: p, world } = project({ [ROOT]: `group #A {\n  brush {\n  }\n}\n` });
  // the sheet's brush has no faces at all, so it read as an entity; a real one replaces it
  const solid = brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [2, 2, 2] })));
  const next = updateNode<GroupNode>(world, find(world, "A").id, (n) => ({ ...n, children: [solid] }));
  const text = saved(next, p);
  assert.equal(text.match(/face\(/g)?.length, 6, text);
  assert.equal(text.match(/brush/g)?.length, 1, "the old one is gone");
});

// ---------------------------------------------------------------- the file as a layer

test("a sheet with no group in it opens on a layer that is the file", () => {
  const before = `mesh #a (boxGeometry(1, 1, 1));\n\npointLight #sun (#ffffff, 1);\n`;
  const { project: p, world } = project({ [ROOT]: before });
  assert.equal(world.layers.length, 1);
  assert.ok(world.layers[0]!.origin?.isFile);
  assert.equal(world.layers[0]!.children.length, 2);
  assert.equal(saved(world, p), before);
});

test("a node added at the top level goes to the end of the file", () => {
  const before = `mesh #a (boxGeometry(1, 1, 1));\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const next = updateNode(world, world.layers[0]!.id, (n) => ({
    ...(n as GroupNode),
    children: [...(n as GroupNode).children, entityNode("pointLight", { sheetId: "sun" })],
  }));
  assert.equal(saved(next, p), `mesh #a (boxGeometry(1, 1, 1));\n\npointLight #sun\n`);
});

test("the implicit layer says so rather than losing a setting it cannot write", () => {
  const { project: p, world } = project({ [ROOT]: `mesh #a (boxGeometry(1, 1, 1));\n` });
  const layer = world.layers[0]!;
  const next: World = { ...world, layers: [{ ...layer, broom: { hidden: true } }] };
  const out = writeWorld(next, p);
  assert.equal(out.problems.length, 1, out.problems.join("; "));
  assert.ok(out.problems[0]!.includes("make it a real group"), out.problems[0]);
});

// ---------------------------------------------------------------- @broom

test("the grid is written where the sheet already keeps it", () => {
  const before = `@broom { grid: -2; scale: 1 };\n\nmesh #a (boxGeometry(1, 1, 1));\n`;
  const { project: p, world } = project({ [ROOT]: before });
  assert.equal(world.broom.grid, -2);
  const next: World = { ...world, broom: { grid: 0, scale: 2 } };
  assert.equal(saved(next, p), `@broom { grid: 0; scale: 2 };\n\nmesh #a (boxGeometry(1, 1, 1));\n`);
});

test("a sheet that never mentioned the grid gets one only when it stops being the default", () => {
  const before = `mesh #a (boxGeometry(1, 1, 1));\n`;
  const { project: p, world } = project({ [ROOT]: before });
  assert.equal(saved(world, p), before, "the default says nothing");
  const next: World = { ...world, broom: { grid: 1, scale: 1 } };
  // and only the grid: `scale` is at its default too, and a sheet that never said it does not start now
  assert.equal(saved(next, p), `@broom { grid: 1 };\n\nmesh #a (boxGeometry(1, 1, 1));\n`);

  const scaled: World = { ...world, broom: { grid: 1, scale: 100 } };
  assert.equal(saved(scaled, p), `@broom { grid: 1; scale: 100 };\n\nmesh #a (boxGeometry(1, 1, 1));\n`);
});

// ---------------------------------------------------------------- names and heads

test("a group named with a #id keeps saying it that way", () => {
  const { project: p, world } = project({ [ROOT]: `group #Hall {\n  mesh #a (boxGeometry(1, 1, 1));\n}\n` });
  const next = updateNode<GroupNode>(world, find(world, "Hall").id, (n) => ({ ...n, name: "Vault" }));
  assert.equal(saved(next, p), `group #Vault {\n  mesh #a (boxGeometry(1, 1, 1));\n}\n`);
});

test("a group named with a property keeps saying it that way", () => {
  const before = `group {\n  name: "Hall";\n  mesh #a (boxGeometry(1, 1, 1));\n}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const hall = world.layers[0]!;
  assert.equal(hall.name, "Hall");
  assert.equal(saved(world, p), before, "reading it did not move the name");
  const next = updateNode<GroupNode>(world, hall.id, (n) => ({ ...n, name: "Vault" }));
  assert.equal(saved(next, p), `group {\n  name: "Vault";\n  mesh #a (boxGeometry(1, 1, 1));\n}\n`);
});

test("a name with a space in it has to be a string, whatever the sheet did", () => {
  const { project: p, world } = project({ [ROOT]: `group #Hall {\n  mesh #a (boxGeometry(1, 1, 1));\n}\n` });
  const next = updateNode<GroupNode>(world, find(world, "Hall").id, (n) => ({ ...n, name: "West Wing" }));
  const text = saved(next, p);
  assert.ok(text.includes('name: "West Wing";'), text);
  assert.ok(text.startsWith("group #Hall {"), "the #id it already had is not the editor's to drop");
});

test("a class added to a head rewrites the head and nothing else", () => {
  const before = `mesh #a (boxGeometry(1, 1, 1)) {\n  castShadow: true;\n}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const next = updateNode<EntityNode>(world, find(world, "a").id, (n) => ({ ...n, classes: ["lit"] }));
  // the head is the one thing that was reprinted, so it comes back in the printer's own spacing
  assert.equal(saved(next, p), `mesh.lit #a(boxGeometry(1, 1, 1)) {\n  castShadow: true;\n}\n`);
});

test("a node written without a body is reprinted whole when it needs one", () => {
  const { project: p, world } = project({ [ROOT]: `pointLight #sun (#ffffff, 1);\n` });
  const next = updateNode<EntityNode>(world, find(world, "sun").id, (n) => ({ ...n, props: setNumber(n.props, "intensity", 3) }));
  assert.equal(saved(next, p), `pointLight #sun(#ffffff, 1) {\n  intensity: 3;\n}\n`);
});

// ---------------------------------------------------------------- @broom on a node

test("hiding a node is written into the sheet so the session survives a save", () => {
  const { project: p, world } = project({ [ROOT]: `group #Hall {\n  mesh #a (boxGeometry(1, 1, 1));\n}\n` });
  const next = updateNode(world, find(world, "Hall").id, (n) => ({ ...n, broom: { hidden: true } }) as Node);
  assert.equal(saved(next, p), `group #Hall {\n  @broom { hidden: true };\n  mesh #a (boxGeometry(1, 1, 1));\n}\n`);
});

test("unhiding a node takes the @broom line away again", () => {
  const before = `group #Hall {\n  @broom { hidden: true };\n  mesh #a (boxGeometry(1, 1, 1));\n}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  assert.equal(find(world, "Hall").broom.hidden, true);
  const next = updateNode(world, find(world, "Hall").id, (n) => ({ ...n, broom: {} }) as Node);
  assert.equal(saved(next, p), `group #Hall {\n  mesh #a (boxGeometry(1, 1, 1));\n}\n`);
});

// ---------------------------------------------------------------- the writer's own limits

test("reordering siblings is deliberately not written back", () => {
  const before = `group #Hall {\n  mesh #a (boxGeometry(1, 1, 1));\n  mesh #b (boxGeometry(1, 1, 1));\n}\n`;
  const { project: p, world } = project({ [ROOT]: before });
  const next = updateNode<GroupNode>(world, find(world, "Hall").id, (n) => ({ ...n, children: [...n.children].reverse() }));
  assert.equal(saved(next, p), before, "order has no meaning at runtime and costs the author's file");
});

test("two saves in a row produce the same thing", () => {
  const { project: p, world } = project({ [ROOT]: HAND_WRITTEN });
  const once = saved(world, p);
  const twice = project({ [ROOT]: once });
  assert.equal(saved(twice.world, twice.project), once);
});

// ---------------------------------------------------------------- patches

const SHEET_PATCH = `group #Hall {
  // one surface, so there is no seam down the middle of the vault to light twice
  patch #roof {
    material: var(--wall);
    uv: { scale: vec2(2, 2) };
    row(vec3(0, 0, 0), vec3(2, 0, 0), vec3(4, 0, 0))
    row(vec3(0, 2, 2), vec3(2, 3, 2), vec3(4, 2, 2))
    row(vec3(0, 0, 4), vec3(2, 0, 4), vec3(4, 0, 4))
  }
}
`;

test("a hand-written patch is read as one and written back byte for byte", () => {
  const { project: p, world } = project({ [ROOT]: SHEET_PATCH });
  const roof = find(world, "roof") as PatchNode;
  assert.equal(roof.kind, "patch");
  assert.equal(roof.patch.material, "wall");
  assert.deepEqual(roof.patch.uv.scale, [2, 2]);
  assert.equal(rowsOf(roof.patch.grid), 3);
  assert.equal(saved(world, p), SHEET_PATCH);
});

test("a control point dragged rewrites the row it is in, and only that row", () => {
  const { project: p, world } = project({ [ROOT]: SHEET_PATCH });
  const roof = find(world, "roof") as PatchNode;
  const next = updateNode<PatchNode>(world, roof.id, (n) => ({
    ...n,
    patch: movePoints(n.patch, [{ row: 1, column: 1 }], [0, 1, 0]),
  }));
  const text = saved(next, p);
  assert.ok(text.includes("row(vec3(0, 2, 2), vec3(2, 4, 2), vec3(4, 2, 2))"), text);
  // the comment, the material, the layout and the two rows nobody touched are all where they were
  for (const line of ["  // one surface", "    material: var(--wall);", "    uv: { scale: vec2(2, 2) };",
    "    row(vec3(0, 0, 0), vec3(2, 0, 0), vec3(4, 0, 0))",
    "    row(vec3(0, 0, 4), vec3(2, 0, 4), vec3(4, 0, 4))"]) {
    assert.ok(text.includes(line), line);
  }
});

test("a grid that gained a span is rewritten whole, because row 1 is no longer row 1", () => {
  const { project: p, world } = project({ [ROOT]: SHEET_PATCH });
  const roof = find(world, "roof") as PatchNode;
  const next = updateNode<PatchNode>(world, roof.id, (n) => ({ ...n, patch: addRow(n.patch, 0) }));
  const text = saved(next, p);
  assert.equal(text.match(/row\(/g)?.length, 5, text);
  assert.ok(text.includes("material: var(--wall);"), "the settings are not geometry and did not move");
  assert.ok(text.includes("// one surface"), "nor is the comment above the node");
});

test("a layout back at its default is dropped rather than written out blank", () => {
  const { project: p, world } = project({ [ROOT]: SHEET_PATCH });
  const roof = find(world, "roof") as PatchNode;
  const next = updateNode<PatchNode>(world, roof.id, (n) => ({ ...n, patch: { ...n.patch, uv: patchUv() } }));
  const text = saved(next, p);
  assert.ok(!text.includes("uv:"), text);
  assert.ok(text.includes("material: var(--wall);"), "and the material beside it stayed");
});

test("a material painted onto a patch is one line changed", () => {
  const { project: p, world } = project({ [ROOT]: SHEET_PATCH });
  const roof = find(world, "roof") as PatchNode;
  const next = updateNode<PatchNode>(world, roof.id, (n) => ({ ...n, patch: { ...n.patch, material: "stone" } }));
  assert.equal(saved(next, p), SHEET_PATCH.replace("var(--wall)", "var(--stone)"));
});

test("a new patch is printed with its rows one per line", () => {
  const { project: p, world } = project({ [ROOT]: `group #Hall {\n}\n` });
  const fresh = patchNode(patchShape("plane", [0, 0, 0], [4, 0, 4]));
  const next = updateNode<GroupNode>(world, find(world, "Hall").id, (n) => ({ ...n, children: [fresh] }));
  assert.equal(
    saved(next, p),
    `group #Hall {\n` +
      `  patch {\n` +
      `    row(vec3(0, 0, 0), vec3(2, 0, 0), vec3(4, 0, 0))\n` +
      `    row(vec3(0, 0, 2), vec3(2, 0, 2), vec3(4, 0, 2))\n` +
      `    row(vec3(0, 0, 4), vec3(2, 0, 4), vec3(4, 0, 4))\n` +
      `  }\n` +
      `}\n`,
  );
});

test("a patch the editor could not read stays an entity and survives untouched", () => {
  // two rows: the runtime would refuse it too, and neither of us is going to guess at a third
  const weird = `patch #odd {\n  row(vec3(0, 0, 0), vec3(1, 0, 0), vec3(2, 0, 0))\n  row(vec3(0, 0, 1), vec3(1, 0, 1), vec3(2, 0, 1))\n}\n`;
  const { project: p, world } = project({ [ROOT]: weird });
  assert.equal(find(world, "odd").kind, "entity", "an unreadable patch is not a patch");
  assert.equal(saved(world, p), weird);
});

report("roundtrip");
