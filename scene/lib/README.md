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
| node and value names | the three class name with a lowercase first letter (`meshStandardMaterial`) |
| values | `vec3(...)` `color(#ff8000)` `euler(45deg, 1rad, 0)` `texture(url)` `gltf(url)` `DoubleSide` `[0, 1]` `{ hp: 3 }` |
| language functions | `var(--x, fallback)` `calc(...)` `ref(#id)` `repeat(n){}` `find(mesh, "name"){}` `play("clip"){}` |
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
transcoder path.

Runtime errors carry their location: `main.tscene:12:5: ...`.

### Bundle size

The runtime never reaches into three by name. The vite plugin reads the classes a sheet mentions and
emits `import { Mesh, BoxGeometry, … } from "three/webgpu"` next to it, so a bundler keeps exactly those
and drops the rest of three — a `import scene from "./room.tscene"` app minifies to ~228 kB rather than
the ~1,067 kB a `three[name]` lookup would pin.

The price is that a sheet which only exists at runtime — `loadScene(text)`, `loadSceneFromURL(url)` —
was never seen by the plugin, so it needs three handed to it:

```ts
import { loadSceneFromURL } from "tscene";
import { threeRegistry } from "tscene/three";   // this one does pull in all of three

const root = await loadSceneFromURL("/scenes/room.tscene", { registry: threeRegistry });
```

Same for `registry: { water: Water }` — a class the plugin cannot know about is still passed by hand,
and is looked up before the sheet's own imports.

## Type checking

The schema is reflected out of the installed `three/webgpu` `.d.ts` with the TypeScript Compiler API:
classes, constructor signatures, property types. Upgrading three upgrades the schema (cached under
`node_modules/.cache/tscene`, keyed by version).

Constant unions such as `type Side = typeof FrontSide | ...` keep their names, so `side: NormalBlending`
is an error (a raw `side: 2` passes, because three accepts it). Completion offers only the members of
that union.

```sh
tscene check scenes/          # a directory, a glob or a file
tscene fix   scenes/          # casing + formatting
tscene check --entry three    # when only core three is used
tscene check --watch          # re-check on every change
tscene check --format json    # for editors and CI
tscene check --module three/addons/objects/Water.js   # expose that module's exports as nodes (repeatable)
tscene check --declare water     # a node injected through the runtime registry — passes on name alone (repeatable)
```

The autofixer only touches **casing and formatting**. Aggressive fixes such as spelling corrections or
value conversions are reported but never applied.

Editors talk to the LSP server: `tscene-lsp --stdio`. It supports:

| Feature | Details |
| --- | --- |
| diagnostics | refreshed while typing, no save needed, following `@import`s |
| completion | position sensitive — properties of the class plus node names and builtins in a body, constructors/constants of the type after `property:`, templates after `.`, the parameter's type inside an argument, the variables visible at that point inside `var(` (before the cursor, enclosing blocks, top level of imported files), sibling paths and the node_modules packages that ship sheets inside `@import "`, the at-rules legal at the cursor after `@`, and the settings of the position inside `@bakery {` (its keys, then that key's values) |
| hover | class signature, base chain and three's own TSDoc; property types (to the end of a dotted path, including the note that a read-only field is assigned through `copy()`); `--var` values; template declarations; three constants; `@bakery` keys |
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
`{ entry, modules, declare, check, hmr }`.

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
