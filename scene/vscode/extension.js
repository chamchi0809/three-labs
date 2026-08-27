// tscene VS Code client. Plain JS on purpose — the repo ships TS sources with no build step,
// and VS Code loads this file directly.
const path = require("node:path");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let client;
let watcher;

// a published tscene ships dist/; a checkout may only have the TS sources (node strips the types)
const ENTRIES = ["dist/lsp.js", "src/lsp.ts"];
const pick = (dir) => ENTRIES.map((e) => path.join(dir, e)).find(fs.existsSync);

/** the server bundled into the .vsix, next to this file — the fallback when the workspace has no tscene */
const bundled = () => [path.join(__dirname, "lsp.js"), path.join(__dirname, "dist", "lsp.js")].find(fs.existsSync);

/**
 * The folder a workspace command belongs to: the one holding the active editor, and only then the
 * first of them. In a multi-root workspace the first folder is rarely the one being looked at.
 */
const activeFolder = () => {
  const doc = vscode.window.activeTextEditor?.document;
  return (doc && vscode.workspace.getWorkspaceFolder(doc.uri)) || vscode.workspace.workspaceFolders?.[0];
};

/** Find tscene's language server in the workspace, falling back to this extension's own deps. */
function resolveServer() {
  const configured = vscode.workspace.getConfiguration("tscene").get("serverPath");
  if (configured) return configured;
  // every folder, not just the first: a multi-root workspace installs tscene wherever it likes
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  for (const root of [...folders, __dirname, path.join(__dirname, "..", "lib")]) {
    try {
      const req = createRequire(path.join(root, "noop.js"));
      const found = pick(path.dirname(req.resolve("tscene/package.json")));
      if (found) return found;
    } catch {}
  }
  return pick(path.join(__dirname, "..", "lib")) ?? bundled();
}

async function start() {
  const folder = activeFolder();
  const server = resolveServer();
  if (!server || !fs.existsSync(server)) {
    vscode.window.showErrorMessage("tscene: cannot find the language server. Install tscene in this workspace or set tscene.serverPath.");
    return;
  }

  const config = vscode.workspace.getConfiguration("tscene");
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

  client = new LanguageClient("tscene", "tscene", { run, debug }, {
    documentSelector: [{ scheme: "file", language: "scene" }],
    synchronize: { fileEvents: watcher },
    initializationOptions: {
      entry: config.get("entry"),
      modules: config.get("modules"),
      addons: config.get("addons"),
      declare: config.get("declare"),
    },
    outputChannelName: "tscene",
  });
  await client.start();
}

/**
 * Stop and dispose whatever server is running. Disposed, not merely stopped: a restart builds a new
 * client, and every one of those brings its own output channel and its own listeners — the old code
 * pushed each into `context.subscriptions`, so nothing was released until the window closed and the
 * output dropdown grew a "tscene" per restart.
 */
async function stop() {
  const running = client;
  client = undefined;
  if (running) await running.dispose().catch(() => {});
}

/** check/fix over the whole workspace, in a terminal so the output is browsable */
function runCli(command) {
  const folder = activeFolder();
  if (!folder) return;
  const terminal = vscode.window.createTerminal({ name: "tscene", cwd: folder.uri.fsPath });
  terminal.show();
  terminal.sendText(`npx tscene ${command}`);
}

/** the settings the server is launched with. `tscene.trace.server` is the client's own, and it reads it live */
const RESTART_ON = ["entry", "modules", "addons", "declare", "nodePath", "serverPath"];

async function activate(context) {
  // one watcher for the extension's lifetime; a client built for a restart borrows this one
  watcher = vscode.workspace.createFileSystemWatcher("**/*.tscene");
  const restart = async () => {
    await stop();
    await start();
  };

  context.subscriptions.push(
    watcher,
    { dispose: stop },
    vscode.commands.registerCommand("tscene.format", () => vscode.commands.executeCommand("editor.action.formatDocument")),
    vscode.commands.registerCommand("tscene.checkWorkspace", () => runCli("check")),
    vscode.commands.registerCommand("tscene.fixWorkspace", () => runCli("fix")),
    vscode.commands.registerCommand("tscene.restart", restart),
  );

  vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (RESTART_ON.some((key) => e.affectsConfiguration(`tscene.${key}`))) await restart();
  }, null, context.subscriptions);

  // the server reflects the typings of the folders it was handed at initialize, so a folder added to
  // the workspace is a folder whose three it has never seen
  vscode.workspace.onDidChangeWorkspaceFolders(restart, null, context.subscriptions);

  await start(context);
}

const deactivate = () => stop();

module.exports = { activate, deactivate };
