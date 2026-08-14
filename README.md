# three-labs

A monorepo of three.js / WebGPU rendering experiments. One project is one top-level directory:
a `lib/` that ships and a `demo/` that exercises it.

## Projects

| Project | Package | What it is | Docs |
| --- | --- | --- | --- |
| [`scene/`](./scene) | [`tscene`](https://www.npmjs.com/package/tscene) | Write three.js scenes in CSS syntax — the `.tscene` format, a type checker reflected out of three's own typings, an autofixer, a runtime loader and a vite plugin | [README](./scene/lib/README.md) · [language](./scene/lib/docs/language.md) · [API](./scene/lib/docs/api/index.md) |
| [`scene/lib/src/bakery/`](./scene/lib/src/bakery) | `tscene/bakery` | GPU path-traced lightmaps for `.tscene` scenes, baked headlessly in Node — full GI, emissive area lights, soft shadows | [bakery](./scene/lib/docs/bakery.md) |
| [`scene/vscode/`](./scene/vscode) | [`chamchi.tscene-vscode`](https://marketplace.visualstudio.com/items?itemName=chamchi.tscene-vscode) | The VS Code extension for `.tscene`: highlighting and snippets of its own, everything else over the LSP server that `tscene` ships | [README](./scene/vscode/README.md) |
| [`rc-25d/`](./rc-25d) | `@rc25d/radiance-cascades` | Turnkey Radiance Cascades lighting: `ScreenSpaceRC` (screen-space HRC, Path of Exile 2 style) and `SplitRC` (world-space 3D GI against a voxelisation) | [README](./rc-25d/README.md) |
| [`sdfgi/`](./sdfgi) | `three-sdfgi` | Godot 4's SDFGI ported to three.js / WebGPU — cascaded SDF probes, one call per frame | [source](./sdfgi/lib/src) |

## Working in the repo

```sh
pnpm install
pnpm dev:scene      # a demo per project: dev:scene, dev:loft, dev:bakery, dev:rc25d, dev:sdfgi
pnpm bake:bakery    # bake the bakery demo's atlas (needs a GPU; :pica and :sponza for the two big ones)
pnpm typecheck
pnpm test           # unit tests
pnpm check          # GPU-free verification, plus the bakery's radiometry check, which skips without a GPU
pnpm build
```

Conventions (layout, package naming, where the shared toolchain lives, what a check has to cover) are in
[CLAUDE.md](./CLAUDE.md).

## Publishing

Both packages publish from a tag through GitHub Actions:

```sh
git tag tscene-v0.1.1        && git push --tags   # npm
git tag scene-vscode-v0.1.1  && git push --tags   # the VS Code marketplace
```

## License

MIT — see [LICENSE](./LICENSE).
