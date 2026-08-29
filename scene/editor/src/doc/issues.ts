/**
 * The map checker: twenty things that are wrong with a level, and how to put each one right.
 *
 * TrenchBroom's issue browser is one of the reasons its maps compile. This is the same idea against a
 * different set of failures, because tscene fails differently from a `.map`: there is no `classname` to be
 * missing, but there is a `.class` with no `@template`; there are no content flags to be mixed, but there
 * is a face naming a `--var` nobody declared.
 *
 * Two rules hold for every validator here.
 *
 * **A quick fix is a normal edit.** It returns a new `World` and goes through the same undo stack as a
 * drag, so a designer can fix forty off-grid solids and take it back with one keystroke.
 *
 * **A validator that cannot be sure says nothing.** Every check is against something the project itself
 * declares — a template, a material, an `#id` — so an empty catalogue silences the checks that would
 * otherwise call every class in the map undefined. A checker that cries wolf is one people turn off, and
 * a checker that is off finds nothing.
 */
import { brushBounds, brushProblems, brushVolume, isOnGrid, snapBrush } from "../brush/brush.ts";
import { resetUv, withFace } from "../brush/uv.ts";
import { changeFaces } from "../tools/attributes.ts";
import { defFor, type Catalogue } from "./catalogue.ts";
import {
  brushesUnder, childrenOf, layerOf, moveNodes, nodeById, removeNodes, replaceNode,
  updateNode, walk, type Node, type NodeId, type World,
} from "./document.ts";
import { membersOf, propagate, separateGroup } from "./groups.ts";
import { freshLayerName, renameLayer } from "./layers.ts";
import { removeProp, setVec3 } from "./props.ts";

export type Severity = "error" | "warning";

export type Issue = {
  /** which validator found it — also what a designer turns off when they do not care about it */
  validator: string;
  severity: Severity;
  message: string;
  node: NodeId;
  /** the face it is about, for the ones that are about a surface */
  face?: number;
  /** the property it is about, for the ones that are about a value */
  prop?: string;
  /** what the quick fix is called, when there is one */
  fix?: string;
};

/** what the checker needs to know beyond the tree: what the project declares, and what the editor is set to */
export type Context = {
  world: World;
  catalogue: Catalogue;
  /** the grid size in metres — off-grid is a question about the grid the designer is working on */
  grid: number;
  /** the material a fix assigns when a face has none */
  material?: string;
};

export type Validator = {
  id: string;
  title: string;
  severity: Severity;
  find: (c: Context) => Issue[];
  /** the world with this issue put right; the same world back means the fix no longer applies */
  fix?: (c: Context, issue: Issue) => World;
};

/** how far from the origin a level may reach, in metres, before a coordinate stops being trustworthy */
export const EXTENT = 4096;

const nodes = (world: World): Node[] => [...walk(world)];
const brushOf = (world: World, id: NodeId) => {
  const n = nodeById(world, id);
  return n?.kind === "brush" ? n : undefined;
};

const at = (node: Node, validator: string, severity: Severity, message: string, over: Partial<Issue> = {}): Issue =>
  ({ validator, severity, message, node: node.id, ...over });

// ---------------------------------------------------------------- solids

const invalidSolid: Validator = {
  id: "invalid-solid",
  title: "solids that are not solid",
  severity: "error",
  find: (c) => nodes(c.world).flatMap((n) =>
    n.kind === "brush" && brushProblems(n.brush).length
      ? [at(n, "invalid-solid", "error", brushProblems(n.brush)[0]!, { fix: "delete it" })]
      : []),
  fix: (c, i) => removeNodes(c.world, [i.node]),
};

/** a tenth of a millimetre: below this a solid is a sliver left by a clip, and it will z-fight forever */
const SLIVER = 1e-4;

const tinySolid: Validator = {
  id: "tiny-solid",
  title: "solids too thin to see",
  severity: "warning",
  find: (c) => nodes(c.world).flatMap((n) => {
    if (n.kind !== "brush" || brushProblems(n.brush).length) return [];
    const box = brushBounds(n.brush);
    const thin = box && box.min.some((v, k) => box.max[k]! - v < SLIVER);
    return thin || brushVolume(n.brush) < SLIVER ** 3
      ? [at(n, "tiny-solid", "warning", "a solid too thin to see", { fix: "delete it" })]
      : [];
  }),
  fix: (c, i) => removeNodes(c.world, [i.node]),
};

const outOfBounds: Validator = {
  id: "out-of-bounds",
  title: "geometry outside the world",
  severity: "error",
  find: (c) => nodes(c.world).flatMap((n) => {
    if (n.kind !== "brush") return [];
    const box = brushBounds(n.brush);
    const far = box && [...box.min, ...box.max].some((v) => Math.abs(v) > EXTENT);
    return far
      ? [at(n, "out-of-bounds", "error", `a solid more than ${EXTENT} m from the origin`, { fix: "delete it" })]
      : [];
  }),
  fix: (c, i) => removeNodes(c.world, [i.node]),
};

const offGrid: Validator = {
  id: "off-grid",
  title: "corners off the grid",
  severity: "warning",
  find: (c) => nodes(c.world).flatMap((n) =>
    n.kind === "brush" && !brushProblems(n.brush).length && !isOnGrid(n.brush, c.grid)
      ? [at(n, "off-grid", "warning", "a corner is not on the grid", { fix: "snap to the grid" })]
      : []),
  fix: (c, i) => {
    const node = brushOf(c.world, i.node);
    const snapped = node && snapBrush(node.brush, c.grid);
    return snapped?.brush ? replaceNode(c.world, i.node, { ...node!, brush: snapped.brush }) : c.world;
  },
};

// ---------------------------------------------------------------- faces

/** every face of every solid, as the pair the face validators are written against */
function* faces(world: World): Generator<{ node: Node; face: number }> {
  for (const n of nodes(world)) {
    if (n.kind !== "brush") continue;
    for (let face = 0; face < n.brush.faces.length; face++) yield { node: n, face };
  }
}

const uvScaleZero: Validator = {
  id: "uv-scale-zero",
  title: "faces with no material size",
  severity: "error",
  find: (c) => [...faces(c.world)].flatMap(({ node, face }) => {
    const a = node.kind === "brush" ? node.brush.faces[face]! : undefined;
    return a && (a.scale[0] === 0 || a.scale[1] === 0)
      ? [at(node, "uv-scale-zero", "error", "a face whose material is scaled to nothing", { face, fix: "reset it" })]
      : [];
  }),
  fix: (c, i) => changeFaces(c.world, [{ node: i.node, face: i.face ?? 0 }], resetUv),
};

const uvOutOfRange: Validator = {
  id: "uv-out-of-range",
  title: "faces with runaway material numbers",
  severity: "warning",
  find: (c) => [...faces(c.world)].flatMap(({ node, face }) => {
    const a = node.kind === "brush" ? node.brush.faces[face]! : undefined;
    const wild = a && [...a.offset, ...a.scale].some((v) => !Number.isFinite(v) || Math.abs(v) > 1e5);
    return wild
      ? [at(node, "uv-out-of-range", "warning", "a face whose material numbers are absurd", { face, fix: "reset it" })]
      : [];
  }),
  fix: (c, i) => changeFaces(c.world, [{ node: i.node, face: i.face ?? 0 }], resetUv),
};

const noMaterial: Validator = {
  id: "no-material",
  title: "faces made of nothing",
  severity: "warning",
  find: (c) => [...faces(c.world)].flatMap(({ node, face }) => {
    const a = node.kind === "brush" ? node.brush.faces[face]! : undefined;
    return a && a.material === undefined
      ? [at(node, "no-material", "warning", "a face with no material", { face, fix: "give it a material" })]
      : [];
  }),
  fix: (c, i) => assign(c, i),
};

const unknownMaterial: Validator = {
  id: "unknown-material",
  title: "faces made of something undeclared",
  severity: "error",
  find: (c) => {
    // with nothing declared, every name is unknown and the answer is useless
    if (!c.catalogue.materials.length) return [];
    const known = new Set(c.catalogue.materials.map((m) => m.name));
    return [...faces(c.world)].flatMap(({ node, face }) => {
      const a = node.kind === "brush" ? node.brush.faces[face]! : undefined;
      return a?.material !== undefined && !known.has(a.material)
        ? [at(node, "unknown-material", "error", `no material called --${a.material}`, { face, fix: "give it a material" })]
        : [];
    });
  },
  fix: (c, i) => assign(c, i),
};

/** the fix both material validators share: the editor's current material, or the first the project has */
function assign(c: Context, i: Issue): World {
  const material = c.material ?? c.catalogue.materials[0]?.name;
  if (!material) return c.world;
  return changeFaces(c.world, [{ node: i.node, face: i.face ?? 0 }], (b, f) => withFace(b, f, { material }));
}

// ---------------------------------------------------------------- entities

const missingDefinition: Validator = {
  id: "missing-definition",
  title: "classes with no template",
  severity: "warning",
  find: (c) => {
    if (!c.catalogue.entities.length) return [];
    const known = new Set(c.catalogue.entities.map((d) => d.name));
    return nodes(c.world).flatMap((n) =>
      n.classes.filter((cls) => !known.has(cls)).map((cls) =>
        at(n, "missing-definition", "warning", `no @template declares .${cls}`, { prop: cls, fix: "remove the class" })));
  },
  fix: (c, i) => updateNode(c.world, i.node, (n) => ({ ...n, classes: n.classes.filter((cls) => cls !== i.prop) })),
};

const pointWithSolids: Validator = {
  id: "point-with-solids",
  title: "point entities holding solids",
  severity: "warning",
  find: (c) => nodes(c.world).flatMap((n) => {
    const def = defFor(c.catalogue, n);
    const holds = def?.kind === "point" && [...brushesUnder(n)].length > 0;
    return holds
      ? [at(n, "point-with-solids", "warning", `.${def!.name} is placed as a point but holds solids`,
          { fix: "move the solids out" })]
      : [];
  }),
  fix: (c, i) => {
    const node = nodeById(c.world, i.node);
    const home = layerOf(c.world, i.node);
    const kids = node ? childrenOf(node).map((k) => k.id) : [];
    return home && kids.length ? moveNodes(c.world, kids, home.id) : c.world;
  },
};

const emptyBrushEntity: Validator = {
  id: "empty-brush-entity",
  title: "brush entities with no solids",
  severity: "error",
  find: (c) => nodes(c.world).flatMap((n) => {
    const def = defFor(c.catalogue, n);
    const empty = def?.kind === "brush" && ![...brushesUnder(n)].length;
    return empty
      ? [at(n, "empty-brush-entity", "error", `.${def!.name} is written around solids and has none`,
          { fix: "delete it" })]
      : [];
  }),
  fix: (c, i) => removeNodes(c.world, [i.node]),
};

const noPosition: Validator = {
  id: "no-position",
  title: "point entities that were never placed",
  severity: "warning",
  find: (c) => nodes(c.world).flatMap((n) => {
    const def = defFor(c.catalogue, n);
    const placed = n.props.some((m) => m.kind === "prop" && m.name === "position");
    return def?.kind === "point" && n.kind === "entity" && !placed
      ? [at(n, "no-position", "warning", `.${def.name} has no position, so it sits at the origin`,
          { fix: "place it at the origin" })]
      : [];
  }),
  fix: (c, i) => updateNode(c.world, i.node, (n) => ({ ...n, props: setVec3(n.props, "position", [0, 0, 0]) })),
};

const brokenRef: Validator = {
  id: "broken-ref",
  title: "references to nothing",
  severity: "error",
  find: (c) => {
    const known = new Set(nodes(c.world).map((n) => n.sheetId).filter((id): id is string => !!id));
    return nodes(c.world).flatMap((n) =>
      n.props.flatMap((m) =>
        m.kind === "prop" && m.value.kind === "ref" && !known.has(m.value.name)
          ? [at(n, "broken-ref", "error", `${m.name} points at #${m.value.name}, which nothing is called`,
              { prop: m.name, fix: "remove the property" })]
          : []));
  },
  fix: (c, i) => updateNode(c.world, i.node, (n) => ({ ...n, props: removeProp(n.props, i.prop ?? "") })),
};

const duplicateId: Validator = {
  id: "duplicate-id",
  title: "two things with one name",
  severity: "error",
  find: (c) => {
    const seen = new Set<string>();
    return nodes(c.world).flatMap((n) => {
      if (!n.sheetId) return [];
      if (!seen.has(n.sheetId)) {
        seen.add(n.sheetId);
        return [];
      }
      return [at(n, "duplicate-id", "error", `#${n.sheetId} is the name of more than one node`,
        { fix: "give it its own name" })];
    });
  },
  fix: (c, i) => {
    const node = nodeById(c.world, i.node);
    if (!node?.sheetId) return c.world;
    const taken = new Set(nodes(c.world).map((n) => n.sheetId));
    let name = node.sheetId;
    for (let n = 2; taken.has(name); n++) name = `${node.sheetId}-${n}`;
    return replaceNode(c.world, node.id, { ...node, sheetId: name });
  },
};

const emptyPropertyName: Validator = {
  id: "empty-property-name",
  title: "properties with no name",
  severity: "error",
  find: (c) => nodes(c.world).flatMap((n) =>
    n.props.some((m) => m.kind === "prop" && !m.name.trim())
      ? [at(n, "empty-property-name", "error", "a property written without a name", { fix: "remove it" })]
      : []),
  fix: (c, i) => updateNode(c.world, i.node, (n) => ({
    ...n, props: n.props.filter((m) => !(m.kind === "prop" && !m.name.trim())),
  })),
};

// ---------------------------------------------------------------- structure

const emptyGroup: Validator = {
  id: "empty-group",
  title: "groups holding nothing",
  severity: "warning",
  find: (c) => nodes(c.world).flatMap((n) =>
    n.kind === "group" && !n.children.length
      ? [at(n, "empty-group", "warning", `the group "${n.name}" holds nothing`, { fix: "delete it" })]
      : []),
  fix: (c, i) => removeNodes(c.world, [i.node]),
};

const unnamed: Validator = {
  id: "unnamed",
  title: "groups and layers with no name",
  severity: "warning",
  find: (c) => nodes(c.world).flatMap((n) =>
    (n.kind === "group" || n.kind === "layer") && !n.name.trim()
      ? [at(n, "unnamed", "warning", `a ${n.kind} with no name`, { fix: "name it" })]
      : []),
  fix: (c, i) => {
    const node = nodeById(c.world, i.node);
    if (node?.kind === "layer") return renameLayer(c.world, node.id, freshLayerName(c.world));
    return node?.kind === "group" ? replaceNode(c.world, node.id, { ...node, name: "Group" }) : c.world;
  },
};

const duplicateLayerName: Validator = {
  id: "duplicate-layer-name",
  title: "two layers with one name",
  severity: "warning",
  find: (c) => {
    const seen = new Set<string>();
    return c.world.layers.flatMap((l) => {
      if (!seen.has(l.name)) {
        seen.add(l.name);
        return [];
      }
      return [at(l, "duplicate-layer-name", "warning", `more than one layer is called "${l.name}"`,
        { fix: "rename it" })];
    });
  },
  fix: (c, i) => renameLayer(c.world, i.node, freshLayerName(c.world)),
};

const linkOfOne: Validator = {
  id: "link-of-one",
  title: "linked groups with nothing to link to",
  severity: "warning",
  find: (c) => nodes(c.world).flatMap((n) => {
    const link = n.kind === "group" ? n.broom.link : undefined;
    return link && membersOf(c.world, link).length < 2
      ? [at(n, "link-of-one", "warning", `"${link}" is a link set of one`, { fix: "unlink it" })]
      : [];
  }),
  fix: (c, i) => separateGroup(c.world, i.node),
};

const linkOutOfStep: Validator = {
  id: "link-out-of-step",
  title: "linked copies that stopped matching",
  severity: "error",
  find: (c) => {
    const out: Issue[] = [];
    const done = new Set<string>();
    for (const n of nodes(c.world)) {
      const link = n.kind === "group" ? n.broom.link : undefined;
      if (!link || done.has(link)) continue;
      done.add(link);
      const members = membersOf(c.world, link);
      if (members.length < 2) continue;
      const first = shapeOf(members[0]!);
      for (const other of members.slice(1)) {
        if (shapeOf(other) === first) continue;
        out.push(at(other, "link-out-of-step", "error",
          `this copy of "${link}" no longer matches the others`, { fix: "match the first copy" }));
      }
    }
    return out;
  },
  fix: (c, i) => {
    const node = nodeById(c.world, i.node);
    const link = node?.kind === "group" ? node.broom.link : undefined;
    const first = link ? membersOf(c.world, link)[0] : undefined;
    return first ? propagate(c.world, first.id) : c.world;
  },
};

/** what two copies have to agree about: how many of what, all the way down */
const shapeOf = (node: Node): string =>
  `${node.kind}(${childrenOf(node).map(shapeOf).join(",")})`;

// ---------------------------------------------------------------- the set

export const VALIDATORS: Validator[] = [
  invalidSolid, tinySolid, outOfBounds, offGrid,
  uvScaleZero, uvOutOfRange, noMaterial, unknownMaterial,
  missingDefinition, pointWithSolids, emptyBrushEntity, noPosition,
  brokenRef, duplicateId, emptyPropertyName,
  emptyGroup, unnamed, duplicateLayerName, linkOfOne, linkOutOfStep,
];

export const validatorById = (id: string): Validator | undefined => VALIDATORS.find((v) => v.id === id);

/** every issue in a map, errors before warnings, in the order the validators are declared */
export function issuesOf(c: Context, off: Iterable<string> = []): Issue[] {
  const skip = new Set(off);
  const found = VALIDATORS.filter((v) => !skip.has(v.id)).flatMap((v) => v.find(c));
  return [...found].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}

export const applyFix = (c: Context, issue: Issue): World => {
  const world = validatorById(issue.validator)?.fix?.(c, issue) ?? c.world;
  return world;
};

/**
 * A whole list of issues fixed in one edit.
 *
 * Each fix runs against the world the one before it left, and one whose node has since gone — deleted by
 * an earlier fix, or carried off by it — is skipped rather than applied to a node that is not there. That
 * is why this exists instead of a loop at the call site: fixing forty issues is one undo step, and the
 * order things disappear in is not the caller's business.
 */
export function applyFixes(c: Context, issues: Issue[]): World {
  let world = c.world;
  for (const issue of issues) {
    if (!nodeById(world, issue.node)) continue;
    world = applyFix({ ...c, world }, issue);
  }
  return world;
}

/** the count beside each validator in the browser, which is what makes turning one off worth offering */
export function issueCounts(issues: Issue[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of issues) out.set(i.validator, (out.get(i.validator) ?? 0) + 1);
  return out;
}

/** a one-line summary for the status bar: what a designer sees without opening the browser */
export function describeIssues(issues: Issue[]): string {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  if (!issues.length) return "no issues";
  return [errors && `${errors} error${errors > 1 ? "s" : ""}`,
    warnings && `${warnings} warning${warnings > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
}
