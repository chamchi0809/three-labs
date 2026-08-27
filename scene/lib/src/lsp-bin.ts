#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
// The `tscene-lsp` bin. `vscode-languageserver` is an optional peer dependency — an editor needs it,
// an app that imports `tscene` for loadScene() or the vite plugin does not, and it used to be a hard
// dependency every one of them installed. Missing, it is worth a sentence rather than the module
// resolution stack trace a client would swallow along with the rest of stderr.
const NEEDS = ["vscode-languageserver", "vscode-languageserver-textdocument"];

for (const dep of NEEDS) {
  try {
    import.meta.resolve(dep);
  } catch {
    process.stderr.write(
      `tscene-lsp: ${dep} is not installed.\n` +
        `  The language server needs it: npm i -D ${NEEDS.join(" ")}\n`,
    );
    process.exit(1);
  }
}

await import("./lsp.ts");
