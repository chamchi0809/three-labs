// three-scene VS Code client. Plain JS on purpose — the repo ships TS sources with no build step,
// and VS Code loads this file directly.
const path = require("node:path");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let client;

// a published three-scene ships dist/; a checkout may only have the TS sources (node strips the types)
const ENTRIES = ["dist/lsp.js", "src/lsp.ts"];
const pick = (dir) => ENTRIES.map((e) => path.join(dir, e)).find(fs.existsSync);

/** the server bundled into the .vsix, next to this file — the fallback when the workspace has no three-scene */
const bundled = () => [path.join(__dirname, "lsp.js"), path.join(__dirname, "dist", "lsp.js")].find(fs.existsSync);

/** Find three-scene's language server in the workspace, falling back to this extension's own deps. */
function resolveServer(folder) {
  const configured = vscode.workspace.getConfiguration("three-scene").get("serverPath");
  if (configured) return configured;
  const roots = [folder?.uri.fsPath, __dirname, path.join(__dirname, "..", "lib")].filter(Boolean);
  for (const root of roots) {
    try {
      const req = createRequire(path.join(root, "noop.js"));
      const found = pick(path.dirname(req.resolve("three-scene/package.json")));
      if (found) return found;
    } catch {}
  }
  return pick(path.join(__dirname, "..", "lib")) ?? bundled();
}

async function start(context) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const server = resolveServer(folder);
  if (!server || !fs.existsSync(server)) {
    vscode.window.showErrorMessage("three-scene: cannot find the language server. Install three-scene in this workspace or set three-scene.serverPath.");
    return;
  }

  const config = vscode.workspace.getConfiguration("three-scene");
  const node = config.get("nodePath") || process.execPath;
  // the bundled server is plain JS; only a source checkout needs the type stripper
  const strip = server.endsWith(".ts") ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] : [];
  const run = {
    command: node,
    args: [...strip, server, "--stdio"],
    transport: TransportKind.stdio,
    options: { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, cwd: folder?.uri.fsPath },
  };

  // the debug profile adds --inspect so the attach configuration in .vscode/launch.json can connect
  const debug = { ...run, args: ["--inspect=6009", ...run.args] };

  client = new LanguageClient("three-scene", "three-scene", { run, debug }, {
    documentSelector: [{ scheme: "file", language: "scene" }],
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/*.tscene") },
    initializationOptions: { entry: config.get("entry"), modules: config.get("modules"), declare: config.get("declare") },
    outputChannelName: "three-scene",
  });
  context.subscriptions.push(client);
  await client.start();
}

/** check/fix over the whole workspace, in a terminal so the output is browsable */
function runCli(command) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const terminal = vscode.window.createTerminal({ name: "three-scene", cwd: folder.uri.fsPath });
  terminal.show();
  terminal.sendText(`npx three-scene ${command}`);
}

async function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("three-scene.format", () => vscode.commands.executeCommand("editor.action.formatDocument")),
    vscode.commands.registerCommand("three-scene.checkWorkspace", () => runCli("check")),
    vscode.commands.registerCommand("three-scene.fixWorkspace", () => runCli("fix")),
    vscode.commands.registerCommand("three-scene.restart", async () => {
      await client?.stop();
      await start(context);
    }),
  );

  vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration("three-scene")) return;
    await client?.stop();
    await start(context);
  }, null, context.subscriptions);

  await start(context);
}

const deactivate = () => client?.stop();

module.exports = { activate, deactivate };
