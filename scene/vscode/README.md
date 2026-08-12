# tscene VS Code extension

For `.tscene` files. Highlighting and snippets are the extension's own; everything else (diagnostics,
completion, hover, signature help, go to definition, references/rename, outline, formatting, quick fixes)
comes from the `tscene` package's LSP server, spawned over stdio.

## Running it

No build step (`extension.js` is plain CommonJS). Open the repo root in VS Code and hit F5 —
**tscene: Extension Host** in `.vscode/launch.json` starts an extension development host with
`scene/demo` as its workspace. To debug the LSP server too, use the **tscene: Extension + server**
compound (the debug profile starts the server with `--inspect=6009`).

From the CLI:

```sh
code scene/demo --extensionDevelopmentPath=scene/vscode
```

The server is looked up in the workspace's `node_modules/tscene` (`dist/lsp.js`, falling back to
`src/lsp.ts`), then in `../lib`. The `three` used for the schema is resolved from the workspace root
first, then from the server process's cwd.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `tscene.entry` | `three/webgpu` | where the types come from |
| `tscene.modules` | `[]` | extra modules to expose as nodes/values (e.g. `three/addons/objects/Water.js`) |
| `tscene.nodePath` | (empty) | node binary to run the server with. Empty uses VS Code's own node through `ELECTRON_RUN_AS_NODE` |
| `tscene.serverPath` | (empty) | path to the server entry, set explicitly |
| `tscene.trace.server` | `off` | log LSP traffic |

Commands: `tscene: Check all .tscene files` / `Fix all .tscene files` (which run `npx tscene` in
a terminal), and `Restart language server`.

`[scene]` defaults to tabSize 2 with formatOnSave enabled.

## Checks

```sh
pnpm --filter tscene-vscode check   # tokenises with the real TextMate engine and asserts the scopes + manifest paths
pnpm --filter tscene test           # the server side (lsp.check.ts)
```

## Packaging and publishing

`.github/workflows/vscode-extension.yml` does it:

```sh
git tag scene-vscode-v0.1.1 && git push --tags   # sets package.json to the tag version, packages, publishes to the marketplace
```

A manual run (workflow_dispatch) only uploads the `.vsix` artifact by default. The PAT comes from the
`VSCE_PAT` repository secret
([issued in Azure DevOps](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token),
Marketplace: Manage scope; the `publisher` is `three-labs`).

To verify a package locally, follow the same order as the workflow — vsce cannot read pnpm's symlinks:

```sh
cd scene/vscode && rm -rf node_modules && npm install --omit=dev --no-package-lock && npx @vscode/vsce package
pnpm install   # restore the pnpm node_modules
```
