// Builds the two files the .vsix ships. vsce cannot follow pnpm's symlinked node_modules, and the
// server has to run in workspaces that never installed three-scene, so both are bundled standalone.
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const common = { bundle: true, platform: "node", target: "node20", format: "cjs", logLevel: "info", minify: true };

// the client: vscode is provided by the host, everything else (vscode-languageclient) goes in
await build({ ...common, entryPoints: ["extension.js"], outfile: "dist/extension.js", external: ["vscode"] });

// the server: typescript comes along so the checker works with nothing but `three` in the workspace
await build({ ...common, entryPoints: ["../lib/src/lsp.ts"], outfile: "dist/lsp.js" });
