# three-labs

A monorepo of three.js/WebGPU rendering experiments. One project = one top-level directory = `lib/` + `demo/`.

- Do not preserve backward compatibility.
- Choose the simplest implementation that fully meets the current requirements.
- Prefer established, well-maintained libraries over custom implementations.

## Adding a library

Copying `sdfgi/` verbatim is the fastest route (`rc-25d/` is more involved because it carries a dist build).

```
<name>/
  tsconfig.base.json   # copy sdfgi/'s, change only what needs changing
  lib/                 # package.json, tsconfig.json, src/index.ts
  demo/                # package.json, tsconfig.json, index.html, vite.config.ts, src/main.ts
```

Add one line to `pnpm-workspace.yaml` (`<name>/*`) and one `dev:<name>` script to the root `package.json`.

Rules:
- Package names must be unique across the whole workspace (no plain `demo` → `<name>-demo`).
- Demos depend on their library with `"<lib-name>": "workspace:*"`.
- Every package `tsconfig.json` extends `../tsconfig.base.json`.
- The shared toolchain (`three`, `@types/three`, `@webgpu/types`, `typescript`, `vite`, `@types/node`) is declared once, in the root devDependencies. Never redeclare it in a package — resolution walks up.
- A lib declares `three` in `peerDependencies` only. Its own `dependencies` should hold little more than workspace links (`workspace:*`).

A library ships one of two ways:
- **Source export** (the default, `sdfgi/lib`): `main`/`exports` point at `./src/index.ts` and imports carry the `.ts` extension. No build step.
- **dist build** (`rc-25d/lib`): `tsconfig.build.json` plus a `build` script, imports carry the `.js` extension. Only when publishing to npm.

## Checks

Only what runs without a GPU is tested. Arithmetic and bookkeeping outside the shaders (cascade layout,
scroll regions, …) fails silently, so leave a check behind.

- `<pkg>/*.check.ts` or `src/*.test.ts` — run directly with `node --experimental-strip-types`, no framework.
- Hook it up as a `check` or `test` script in `package.json` and `pnpm check` / `pnpm test` will find it.
- Confirm `pnpm typecheck` / `pnpm build` pass from the root.
