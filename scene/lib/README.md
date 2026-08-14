# tscene

Write three.js scenes in CSS syntax: the `.tscene` format, plus a type checker, an autofixer and a
runtime loader.

```css
@import "./materials.tscene";
--height: 1.5;

@template mesh.glow {
  material: meshStandardMaterial { color: color(#ff8a3d); roughness: 0.35; };
  castShadow: true;
}

group #stage {
  mesh.glow #spinner {
    geometry: torusKnotGeometry(0.7, 0.24, 160, 32);
    position: vec3(0, var(--height), 0);
    rotation: euler(20deg, 0, 0);
  }
  pointLight #lamp(#ffd9a0, 30, 20) {
    position: vec3(2.5, 3, 2);
  }
}
```

## Documentation

| | |
|---|---|
| [docs/language.md](./docs/language.md) | `.tscene` language reference — nodes, properties, values, variables, templates, imports, builtins, diagnostics |
| [docs/api](./docs/api/index.md) | runtime and tooling API reference, generated from the source by typedoc |
| [docs/bakery.md](./docs/bakery.md) | `tscene/bakery` — path-traced lightmaps, baked on a headless WebGPU device in Node |

## Syntax at a glance

| | |
|---|---|
| nesting | parenting (`parent.add(child)`) |
| `#id` | `object.name = "id"` |
| `.cls` | lays down the body of `@template <node>.cls`, then the node's own body overrides it |
| `name(...)` | constructor arguments (positional) |
| `{ ... }` | **instance properties only**. Constructor-only settings like `BoxGeometry.widthSegments` go in `boxGeometry(1,1,1,2,2,2)` |
| property names | three's own camelCase (`castShadow`), plus dotted paths (`material.opacity`) and method calls (`lookAt(0,1,0);`) |
| node and value names | the three class name with a lowercase first letter (`meshStandardMaterial`) — `three/addons` included (`loftGeometry`, `roomEnvironment`) |
| values | `vec3(...)` `color(#ff8000)` `euler(45deg, 1rad, 0)` `texture(url)` `gltf(url)` `DoubleSide` `[0, 1]` `{ capStart: true }` |
| value chains | `.name` and `.name(...)` after a value that is already closed, `[i]` to index a list — `splineCurve(pts).getPoints(120)` |
| language functions | `var(--x, fallback)` `calc(...)` `each(--i, n, value)` `ref(#id)` `repeat(n){}` `find(mesh, "name"){}` `play("clip"){}` |
| `calc()` | `+ - * /` and parens, plus `sin` `cos` `tan` `asin` `acos` `atan` `atan2` `sqrt` `exp` `log` `pow` `abs` `sign` `min` `max` `mod` `clamp` `smoothstep` `floor` `ceil` `round` `pi` |
| `@bakery { ... }` | settings for a tool rather than for three — the [lightmap baker](./docs/bakery.md)'s, on the sheet, a node or a material |

## Runtime

```ts
import { mountScene } from "tscene";
import sheet from "./main.tscene";     // a SceneModule, courtesy of the vite plugin

const mount = await mountScene(scene, sheet);

mount.update();            // advances the clips play() started — every frame
```

`mountScene` owns the whole lifecycle: it builds the sheet into `scene`, rebuilds it on every hot
update (disposing the old root once the new one is up), and times the frames for you. `onLoad` runs
after every build, hot updates included, and `onError` is where a failed rebuild goes instead of
throwing — with it set, the previous root stays on screen.

```ts
const mount = await mountScene(scene, sheet, {
  onLoad: (root) => (spinner = root.getObjectByName("spinner")),
  onError: (e) => (msg.textContent = String(e)),
});
mount.reload();            // rebuild by hand
mount.dispose();           // stop listening, dispose the root
```

The pieces underneath are still exported, for a scene whose lifecycle is yours:

```ts
import { loadScene, loadSceneFromURL, updateScene, disposeScene } from "tscene";

const root = await loadScene(sheet, { registry: { water: Water } });
scene.add(root);           // a Group holding the top-level nodes
updateScene(root, dt);     // advances the clips play() started — every frame
disposeScene(root);        // disposes geometries/materials/textures and unparents
```

`loadScene` takes either a `SceneModule` or a raw source string. A string resolves `@import` with `fetch`
(swap it out with the `load` option); a module reads the sheets bundled alongside it — no runtime fetch.
`loadSceneFromURL(url)` fetches the file and uses that URL as the base.

Loader options: `{ manager, draco, ktx2 }` — a shared `LoadingManager`, the draco decoder path, the ktx2
transcoder path. A sheet that names a baked lightmap in `@bakery { lightmap }` gets it applied on load,
with the handle on `root.userData.lightmap`; `{ lightmap: false }` skips that.

Runtime errors carry their location: `main.tscene:12:5: ...`.

### Geometry in the sheet

`each()` is a list — the value once per index, or once per item of another list — and `calc()` has the
arithmetic to fill one in. Together with `.name(...)` on a value, that is enough to write a parametric
surface without leaving the sheet:

```css
/* a lathe: one ring per point of a smoothed profile, 64 points around each */
--profile: splineCurve([vec2(0.2, 0), vec2(1.2, 0.4), vec2(0.7, 1.6), vec2(0.2, 1.7)]);

mesh #pot {
  geometry: loftGeometry(
    each(--p, var(--profile).getPoints(120), each(--j, 64, vec3(
      calc(sin(var(--j) / var(--count) * 2 * pi) * var(--p).x),
      var(--p).y,
      calc(cos(var(--j) / var(--count) * 2 * pi) * var(--p).x)
    ))),
    { capStart: true; capEnd: true }
  );
}
```

Unlike `repeat()`, `each()` is a loop and not an unrolling: the body is checked once and evaluated once
per iteration, so a hundred thousand points cost a hundred thousand evaluations rather than a hundred
thousand lines of AST. `--p` is typed as whatever the list holds, so `var(--p).z` on a list of `Vector2`
is an error the same way a misspelled property is.

The demo's second sheet is three's `webgpu_geometry_loft` example this way: fifteen shapes, 51 lofts and
113,000 cross-section points, none of them from JavaScript.

### three/addons

`three/addons` is reflected alongside the entry point, so an addon is a node like any other:

```css
mesh #crate {
  geometry: roundedBoxGeometry(1, 1, 1, 4, 0.08);
  material: meshStandardMaterial { roughness: 0.5; };
}
mesh #shell {
  /* an options bag, checked field by field against the interface the addon declares */
  geometry: loftGeometry([], { capStart: true; capEnd: true });
}
```

The barrel re-exports 270 modules, so importing it for one class would pin all of them. The schema
records which file every name is *declared* in instead, and the vite plugin emits that:
`import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"`. A sheet that names
one addon bundles one addon.

Turn it off with `threeScene({ addons: false })`, `tscene check --no-addons`, or `"tscene.addons": false`
in VS Code.

### Bundle size

The runtime never reaches into three by name. The vite plugin reads the classes a sheet mentions and
emits `import { Mesh, BoxGeometry, … } from "three/webgpu"` next to it, so a bundler keeps exactly those
and drops the rest of three — a `import scene from "./room.tscene"` app minifies to ~228 kB rather than
the ~1,067 kB a `three[name]` lookup would pin.

The price is that a sheet which only exists at runtime — `loadScene(text)`, `loadSceneFromURL(url)` —
was never seen by the plugin, so it needs three handed to it:

```ts
import { loadSceneFromURL } from "tscene";
import { threeRegistry } from "tscene/three";     // this one does pull in all of three
import { addonRegistry } from "tscene/addons";    // …and this one all of three/addons

const root = await loadSceneFromURL("/scenes/loft.tscene", { registry: { ...threeRegistry, ...addonRegistry } });
```

`tscene/addons` is the barrel, with everything that implies: ~2 MB of addons, and the two loaders that
`import` from jsdelivr come along as external URLs (which also means node's own loader refuses it — in
Node, hand over the classes you need instead). Reach for it when a sheet is only known at runtime;
otherwise let the plugin do it.

Same for `registry: { water: Water }` — a class the plugin cannot know about is still passed by hand,
and is looked up before the sheet's own imports. That is also how a value three has no class for gets in:
a TSL node material, a table of `Vector3`s, or a `Group` subclass that builds its own subtree, with the
names listed in `declare` so the checker takes them on faith.

## Type checking

The schema is reflected out of the installed `three/webgpu` and `three/addons` `.d.ts` with the TypeScript
Compiler API: classes, constructor signatures, property types. Upgrading three upgrades the schema (cached
under `node_modules/.cache/tscene`, keyed by version).

Constant unions such as `type Side = typeof FrontSide | ...` keep their names, so `side: NormalBlending`
is an error (a raw `side: 2` passes, because three accepts it). Completion offers only the members of
that union.

Interfaces of plain data are reflected as records, so an options bag is checked key by key —
`loftGeometry([], { capStrat: true })` names a setting `LoftGeometryOptions` does not have, and a required
field left out is an error. An interface with methods on it is a live object, not settings, and stays an
opaque class.

```sh
tscene check scenes/          # a directory, a glob or a file
tscene fix   scenes/          # casing + formatting
tscene check --entry three    # when only core three is used
tscene check --watch          # re-check on every change
tscene check --format json    # for editors and CI
tscene check --no-addons      # do not reflect three/addons (on by default)
tscene check --module my-water   # expose that module's exports as nodes too (repeatable)
tscene check --declare water     # a node injected through the runtime registry — passes on name alone (repeatable)
```

The autofixer only touches **casing and formatting**. Aggressive fixes such as spelling corrections or
value conversions are reported but never applied.

Editors talk to the LSP server: `tscene-lsp --stdio`. It supports:

| Feature | Details |
| --- | --- |
| diagnostics | refreshed while typing, no save needed, following `@import`s |
| completion | position sensitive — properties of the class plus node names and builtins in a body, constructors/constants of the type after `property:`, templates after `.`, the parameter's type inside an argument, the variables visible at that point inside `var(` (before the cursor, enclosing blocks, top level of imported files), sibling paths and the node_modules packages that ship sheets inside `@import "`, the at-rules legal at the cursor after `@`, the settings of the position inside `@bakery {`, and the fields of the options bag inside a `{ }` whose slot has a type (each of the last two: its keys, then that key's values) |
| hover | class signature, base chain and three's own TSDoc; property types (to the end of a dotted path, including the note that a read-only field is assigned through `copy()`); `--var` values; template declarations; three constants; `@bakery` keys; options-bag fields |
| signature help | highlights the current argument inside `boxGeometry(` |
| go to definition | templates (`.glow`), variables (`var(--x)`), `#id` (`ref(#a)`), `@import` paths (also ctrl-clickable as document links) |
| find references / rename | `--var`, `#id`, `.template` — across every `.tscene` in the workspace, multi-root included. Rename validates the cursor position and the new name first (prepareRename). It follows the declaration↔use pairs `expand()` actually resolved, so a shadowed variable of the same name is left alone and a `var()` passed in as a template parameter is renamed along with it |
| symbol outline | the scene graph as-is |
| formatting | reprints the whole document (casing included) |
| quick fixes | casing typos |
| colour swatches | hex literals (`color(#ff8000)`), edited back as `#rrggbb[aa]` — an `#id` is left alone |
| semantic tokens | classified from the token stream, so a half-typed sheet still highlights |
| folding | every `{ }` block and every `/* */` comment |

VS Code picks this server up through the `scene/vscode/` extension (which adds highlighting, snippets and
workspace check/fix commands).

```ts
// from a program
import { loadSchema, checkSource, fixSource } from "tscene/tools";
```

## Vite

```ts
import threeScene from "tscene/vite";
export default defineConfig({ plugins: [threeScene()] });
```

One sheet is one module (`SceneModule`). An `@import` becomes an import of that module, and the relative
paths a `texture()`/`gltf()` can be handed — a literal or a `var(--x)` this sheet declares — become `?url` imports, so the bundler handles hashing and copying. Every
build and hot update runs the checker; failures show up in the overlay. Options:
`{ entry, modules, addons, declare, check, hmr }`.

Saving rebuilds the scene and nothing else. `mountScene` already listens; `onSceneChange` is the raw
signal behind it (passing the module object you imported is fine, the current source is looked up for
you):

```ts
import { loadScene, disposeScene, onSceneChange } from "tscene";
import sheet from "./main.tscene";

let root = await loadScene(sheet);
onSceneChange(async () => { disposeScene(root); scene.add(root = await loadScene(sheet)); });
```

One line types `import sheet from "./main.tscene"`: `/// <reference types="tscene/client" />`.

## Why the docs cannot rot

`pnpm --filter tscene check` verifies three things (`src/docs.check.ts`):

1. Every example in this README and in `docs/language.md` is **compiled by the real parser and checker**.
   A block tagged ` ```css error ` has to fail instead.
2. Every name in the tables the implementation itself dispatches on (`BUILTINS`, `ALIASES`, `LOADERS`)
   must appear in the language reference — adding a builtin without documenting it fails CI.
3. `docs/api` must match, byte for byte, what typedoc generates from the current source
   (`pnpm --filter tscene docs` refreshes it).

## Releasing

`.github/workflows/npm-publish.yml` runs typecheck, tests and checks, sets the version from the tag and
publishes:

```sh
git tag tscene-v0.1.1 && git push --tags
```

A manual run (workflow_dispatch) only uploads the packed tarball unless `publish=true`. The token comes
from the `NPM_PAT` repository secret (an npm automation token with publish rights).

## Not included

- Selector-based overrides (post-hoc rules like `.enemy { ... }`) — the nesting tree covers enough.
- Loaders other than GLTF; colour swatches on anything but a hex literal.
