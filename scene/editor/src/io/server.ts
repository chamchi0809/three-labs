/**
 * Saving over HTTP: the dev server half.
 *
 * The editor mounted in a game's page opens `/scenes/arena.tscene` with a `fetch` and saves it with a POST,
 * and this is what catches the POST. Fifty lines of middleware, and with them a level editor in a browser
 * tab writes to the repository the way a desktop one writes to disk.
 *
 * Three decisions.
 *
 * **Only `.tscene`, and only inside one directory.** The request names its own paths, which makes this an
 * arbitrary-file-write endpoint unless it refuses. It refuses twice: the name has to end in `.tscene`, and
 * the resolved path has to still be inside the directory the plugin was pointed at. `..` is therefore a 403
 * rather than a rewritten `package.json`.
 *
 * **Only what changed.** Every file of the project is posted, because the editor cannot know which ones the
 * writer will care about. What is on disk is read back and compared first, so a file the designer never
 * touched keeps its modification time — which is what keeps a watcher, and the reload it would trigger,
 * quiet on every save.
 *
 * **Dev only.** A built page is static files with no node process behind it, and there is nothing to write
 * to. The editor falls back to downloading, which is what a browser can honestly offer.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { SHEETS_ROUTE } from "./http.ts";

export type SheetsOptions = {
  /**
   * Where the sheets live, relative to the vite project root. Defaults to the public directory, which is
   * where a level a game fetches at runtime has to be anyway.
   */
  dir?: string;
  /** the route the editor posts to; only worth changing if something else already has it */
  route?: string;
};

/** a body bigger than this is not a level, it is a mistake or an attack */
const LIMIT = 16 * 1024 * 1024;

type SaveRequest = { root?: string; files?: Record<string, string> };

export function sheets(options: SheetsOptions = {}): Plugin {
  let dir = process.cwd();

  return {
    name: "three-broom:sheets",
    // dev only — see the note at the top
    apply: "serve",

    configResolved(config) {
      dir = options.dir ? resolve(config.root, options.dir) : (config.publicDir || config.root);
    },

    configureServer(server) {
      // mounted, so connect strips the prefix and the path below is what is left
      server.middlewares.use(options.route ?? SHEETS_ROUTE, (req, res, next) => {
        if (req.method !== "POST" || (req.url ?? "/").split("?")[0] !== "/save") return next();
        void save(req, res);
      });

      async function save(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
          const { files } = (await body(req)) as SaveRequest;
          if (!files || typeof files !== "object") throw new Error("no files in the request");

          const written: string[] = [];
          for (const [name, text] of Object.entries(files)) {
            if (typeof text !== "string") throw new Error(`${name}: not text`);
            const file = within(name);
            // read first: an unchanged file is left exactly as it is, timestamp included
            if ((await readFile(file, "utf8").catch(() => undefined)) === text) continue;
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, text);
            written.push(relative(dir, file).split(sep).join("/"));
          }

          if (written.length) server.config.logger.info(`  three-broom saved ${written.join(", ")}`);
          json(res, 200, { written });
        } catch (e) {
          // the message is what the editor puts on the screen, so it says which file and why
          json(res, (e as { status?: number }).status ?? 400, { error: (e as Error).message });
        }
      }
    },
  };

  /** the path a posted name means, or a refusal — the only thing standing between a POST and the repo */
  function within(name: string): string {
    if (!name.endsWith(".tscene")) throw refuse(`${name}: only .tscene files can be saved`);
    // the editor's keys are URLs, and `resolve` would read a leading slash as "start from the file system
    // root" — which is exactly the escape this function exists to prevent
    const file = resolve(dir, name.replace(/^\/+/, ""));
    const inside = relative(dir, file);
    if (inside.startsWith("..") || inside === "" || resolve(dir, inside) !== file) {
      throw refuse(`${name}: outside ${dir}`);
    }
    return file;
  }
}

const refuse = (message: string): Error => Object.assign(new Error(message), { status: 403 });

/** the request body as JSON, with a ceiling on it */
function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, no) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > LIMIT) {
        no(new Error("that project is too big to post"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        ok(JSON.parse(text));
      } catch {
        no(new Error("the request was not JSON"));
      }
    });
    req.on("error", no);
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}
