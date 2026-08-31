# three-broom — roadmap

A TrenchBroom-like brush editor that reads and writes `.tscene`. Browser app, three.js/WebGPU,
`scene/editor` in this workspace.

The feature list below is derived from a full scan of the TrenchBroom source (`lib/TbMdlLib` 557 files,
`lib/TbUiLib` 390, `lib/TbAppLib` 161 including all 25 tools, `lib/TbRenderLib` 87 with 28 renderers)
and its 3,083-line manual.

---

## Locked decisions

These were settled before any code was written; every milestone below assumes them.

| # | Question | Decision |
| --- | --- | --- |
| 1 | Where it ships | Browser app at `scene/editor` in three-labs; I/O in tscene; extend the tscene spec where it falls short |
| 2 | Map format | **tscene** — no second format, no sidecar |
| 3 | Rendering | Classic **and** modern PBR, toggleable |
| 4 | Process | Feature list → milestone approval → sequential implementation |
| 5 | Source handling | **Full round-trip, surgical editing** — comments, formatting, `repeat()`, `each()` all preserved |
| 6 | Brush representation | **`brush` syntax in tscene core**, not a `--module` class |
| 7 | Coordinates | **Y-up metres**, power-of-two grid ladder |
| 8 | Entity definitions | **`@template` is the entity definition** — no FGD-equivalent file format |
| 9 | Face planes | **Three points**, not normal + distance |
| 10 | Brush → three | **One `Mesh` per brush**, material array + geometry groups |
| 11 | Material palette | **Both** a directory scan and an `@template` scan |
| 12 | Default layout | **3-pane** |
| 13 | Quake importers (`.map`, FGD, WAD) | **No** |
| 14 | Bezier patches | Excluded from the main line, deferred to M14 — **built there**, as one surface numbered face 0 rather than a parallel kernel |

## Milestones

### M0 — scaffold and specs ✅

`tscene-editor` package (Svelte 5, Vite, `WebGPURenderer` with an automatic WebGL fallback), the grid
ladder and its snapping arithmetic with checks, a booting viewport, and the two specifications that drive
the hardest milestones: [`docs/spec-brush.md`](docs/spec-brush.md) and
[`docs/spec-roundtrip.md`](docs/spec-roundtrip.md).

### M1 — `brush` syntax in tscene core

Parser, checker, runtime, LSP, tmLanguage, snippets and the language reference, plus the `@broom`
at-rule for entity and editor metadata. `docs.check.ts` is the gate. See the brush spec.

### M2 — brush geometry kernel

A port of TrenchBroom's `Polyhedron` half-edge kernel: convex hull from half-spaces, plane clipping, CSG
(merge / subtract / hollow / intersect), the face matcher that carries UVs across a topology change,
`BrushBuilder`, vertex snapping, degenerate rejection, and the integrity checks that make all of the
above trustworthy.

### M3 — UV coordinate systems

`ParaxialUvCoordSystem` and `ParallelUvCoordSystem`; align, justify, fit, flip, reset, rotate; UV lock
across every transform; the face attribute set. Scale is **world metres per texture tile**.

### M4 — round-trip engine

Surgical text patching with per-node provenance, the derived-node policy, `@override` inheritance display
and edit routing, multi-file `@import` handling. See the round-trip spec.

### M5 — document model and undo

World / Layer / Group / Entity / Brush tree, octree, `EditorContext`, selection; `CommandProcessor`,
transactions, undo collation, the repeat stack.

### M6 — renderers

Incremental brush batching with allocation tracking, face and edge renderers, point handles, the grid
(screen-derivative, drawn on faces), 2D and 3D compasses, selection bounds / guides / spikes, text,
entity links.

### M7 — viewports

`MapView3D` plus three `MapView2D`s, the 3-pane default and the 1 / 2 / 4 / cycling layouts, camera
linking, fly mode, picking.

### M8 — tools, first group

Tool infrastructure (`ToolBox` / `ToolChain` / `ToolController` / `InputState` / drag trackers), then
selection and lasso, move, draw shape (cuboid, cylinder, cone, sphere, icosphere), create entity, extrude.

### M9 — tools, second group

Clip, vertex, edge, face, rotate, scale, shear, sweep, and the face-attribute tool.

### M10 — inspectors

Map / Entity / Face inspectors, entity browser off `@template`, property grid with the five smart
editors, material browser (directory **and** `@template`), and the UV editor with its six UV tools.

### M11 — organisation and validation

Groups, linked groups with protected properties, layers, tags and filters, hide / isolate / lock, and the
issue browser with all 20 validators and their quick fixes.

### M12 — rendering, advanced ✅

The classic/PBR toggle, and the **Height Material** with automatic LOD.

The level designer sets `Depth` and nothing else; the renderer picks the technique from distance and
grazing angle — normal map only beyond ~30 m, cheap POM to ~15 m, then full POM, then silhouette POM /
SSDM up close — with step count interpolated by grazing angle and a coarse-search-plus-binary-refinement
march (~8 coarse + 4 refine) rather than naive linear marching. Height is channel-packed into the
existing PBR textures.

The division of labour this implies runs through the whole editor: **brush geometry carries gameplay
silhouette, collision, navigation and large shapes; the height material carries brick, stone, cracks,
panels, wood, damage and small silhouette.** Also in this milestone: integrating the existing lightmap
bakery so a map can be baked without leaving the editor.

The bake runs in-process behind a dev-server route and comes back as an atlas the preview puts straight
onto the map. Getting it to come back *lit* meant fixing what the editor was writing: a colour has to be
`color(#rrggbb)`, because a bare `#rrggbb` is a number in tscene and assigning one leaves `material.color`
as `13618364` rather than a `Color` — which the editor never noticed, since it draws from its own palette
and never asks the runtime for a material. `src/io/valid.check.ts` now runs tscene's own checker over
what a save produces, which is the only reader whose opinion counts.

### M13 — finish ✅

Keyboard shortcuts and a keymap editor, preferences, autosave, glTF/OBJ export, performance profiling,
console.

### M14 — Bezier patches ✅

Quadratic Bezier patch primitives with their own editing tools and tessellation. Held out of the main line
until the brush path was finished, and then built on top of it rather than beside it.

The kernel is tscene's — `buildPatch`, `patchBounds`, `subdivisionsFor` — so the runtime and the editor
agree about where a curve goes down to the last vertex. The editor adds what the runtime has no use for:
the material by `--var` name, the handles a tool drags, and the operations that keep a grid a grid.

`patch:` is a first-class node in the sheet, read and written by the surgical writer, so a patch survives a
round trip with the rest of the map. `patchToBrushMesh` hands a patch to the solid batch in the shape a
brush's mesh has, which is what buys it selection, hover, the pick buffer, material slots and frame-selection
without a second code path — one group, numbered face 0.

**A patch is one selectable surface, numbered 0**, and that is what makes it reach the rest of the editor:
the face inspector, the material browser, the material tool, tags, the map checker and the counts panel all
treat `{node, face: 0}` as that surface. Its uv is a strict subset of a face's — the same offset, scale and
rotation in the same units, minus the paraxial/parallel axis choice, which names nothing about a curve.
Four operations stay brush-only because they need a plane or an outline in tile coordinates and a patch has
neither: **slide, fit, justify, and the axes choice**. The inspector says so rather than offering buttons
that would quietly do nothing.

The patch tool draws the five primitive shapes, bends control points with welding at the seams, and keeps
add/drop row and column, flip and snap on its keys. The same operations are in the inspector as buttons, so
they are reachable with any tool in hand.
