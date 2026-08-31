/**
 * The half of the bake that cannot run in a browser.
 *
 * `tscene/bakery` path-traces lightmaps on a headless WebGPU device, and every part of that is a node
 * thing: Dawn for the device, xatlas for the unwrap, sharp for the PNGs, worker threads for the
 * rasterizer. None of it will ever run in a tab. But "bake the map" is a thing a level designer asks for
 * from inside the level editor, not from a second terminal window with a file path retyped into it — so
 * the dev server grows four routes and the editor talks to them.
 *
 * Three decisions.
 *
 * **The sheets travel in the request body, not as a path.** The document may never have been saved, and a
 * browser is never told where the file it opened lives. So the map is posted as text and loaded from
 * memory with `base` pointing at where it *would* live — which makes `texture("./brick.png")` resolve
 * exactly as it would have if the file were there, without anything ever being written into the project.
 *
 * **The bake runs in the dev server's own process.** A forked child would survive a driver crash, and a
 * driver crash here takes vite down with it. It also costs a second entry point, a second module graph,
 * and every progress report through IPC. `bake()` already takes an `AbortSignal` and already stops at the
 * next dispatch, which is the part that actually matters — so this is one process, one adapter, and a
 * dev server that has to be restarted on the day Dawn falls over.
 *
 * **The bakery is imported when it is first asked for.** `tscene/bakery/node` pulls in three native
 * modules; a dev server that is never used to bake should not pay for loading them, and a checkout
 * without the optional dependencies should start rather than fail. Which is also why "can this machine
 * bake" is a route: the answer is a property of the server, and the editor has no way to guess it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import { BAKE_ROUTE, type Event, type Ready, type Request, type Settings, type Stage } from "./protocol.ts";
import { sceneRegistry } from "./registry.ts";

export type BakeryOptions = {
  /**
   * Where a posted sheet pretends to live, relative to the project root. Its relative `texture()` and
   * `@import` paths resolve from here.
   */
  dir?: string;
  /** where the atlases are written, relative to the project root */
  out?: string;
};

/** a body bigger than this is not a map, it is a mistake or an attack */
const LIMIT = 32 * 1024 * 1024;

/** how often a progress line goes out, at most. A trace reports per batch, which can be hundreds a second */
const EVERY = 100;

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
  ".exr": "image/x-exr",
};

export function bakery(options: BakeryOptions = {}): Plugin {
  let dir = process.cwd();
  let out = process.cwd();
  let project = process.cwd();
  /** the bake in flight. One at a time: two bakes are two GPU devices and a race for the same output */
  let running: AbortController | undefined;
  /** whether the machine can bake, asked once — `hasWebGPU` holds an adapter open, so this is not free */
  let ready: Promise<Ready> | undefined;

  const load = async () => await import("tscene/bakery/node");

  const probe = async (): Promise<Ready> => {
    try {
      const { hasWebGPU } = await load();
      // named rather than `.`, which is where it is but not what it is — the panel puts this after "from",
      // and "from ." tells a designer looking for a missing texture nothing at all
      const shown = relative(project, dir) || basename(project);
      return (await hasWebGPU())
        ? { ok: true, dir: shown }
        : { ok: false, why: "no WebGPU adapter on this machine", dir: shown };
    } catch (e) {
      // a checkout without the optional dependencies, or a platform Dawn has no binary for. Not an error
      // to log every time the editor loads — the editor says it in one line and moves on
      return { ok: false, why: `the baker will not load: ${message(e)}` };
    }
  };

  return {
    name: "three-broom:bakery",
    // dev only. A built editor is static files, and static files have no node process behind them
    apply: "serve",

    configResolved(config) {
      project = config.root;
      dir = resolve(config.root, options.dir ?? ".");
      out = resolve(config.root, options.out ?? ".bake");
    },

    configureServer(server) {
      // mounted, so connect strips the prefix and the paths below are what is left
      server.middlewares.use(BAKE_ROUTE, (req, res, next) => {
        const path = (req.url ?? "/").split("?")[0] ?? "/";

        if (req.method === "GET" && path === "/ready") {
          if (running) return json(res, { ok: false, why: "a bake is already running" } satisfies Ready);
          return void (ready ??= probe()).then((r) => json(res, r));
        }

        if (req.method === "POST" && path === "/stop") {
          running?.abort(new Error("stopped"));
          return json(res, { stopped: Boolean(running) });
        }

        if (req.method === "POST" && path === "/run") {
          if (running) {
            res.statusCode = 409;
            return json(res, { kind: "failed", text: "a bake is already running" } satisfies Event);
          }
          return void run(req, res);
        }

        if (req.method === "GET" && path.startsWith("/out/")) return void file(path, res);

        next();
      });

      async function run(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const stop = new AbortController();
        running = stop;
        // headers before anything can go wrong, so a failure arrives as a `failed` line on the same
        // stream rather than as a status code the client is no longer in a position to read
        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
          // the one thing that must not happen to a stream of progress is being held until it ends
          "x-accel-buffering": "no",
        });
        const say = (event: Event) => void res.write(`${JSON.stringify(event)}\n`);
        // a client that navigated away is a bake nobody is waiting for
        res.on("close", () => stop.abort(new Error("the editor went away")));

        try {
          say(await bakeOnce(await body(req), say, stop.signal));
        } catch (e) {
          say({ kind: "failed", text: message(e) });
        } finally {
          running = undefined;
          res.end();
        }
      }

      /**
       * One bake, from posted text to files on disk.
       *
       * The scene is loaded here rather than through `bakeSceneFile` because that one takes a path, and
       * the whole point is that there may not be one. Everything else — the validation, the settings
       * merge, the renderer's lifetime — is the same sequence it runs.
       */
      async function bakeOnce(
        request: Request,
        say: (event: Event) => void,
        signal: AbortSignal,
      ): Promise<Event> {
        const began = Date.now();
        const { bake, createHeadlessRenderer, installNodeLoaders, validateBakery, writeBake } = await load();
        const { loadScene } = await import("tscene");
        const registry = await sceneRegistry();

        const root = request.root;
        const text = request.files[root];
        if (text === undefined) throw new Error(`${root} is not among the sheets that were posted`);

        installNodeLoaders();
        const entry = join(dir, root);
        say({ kind: "stage", stage: "load", done: 0 });

        const scene = await loadScene(text, {
          registry,
          base: pathToFileURL(entry).href,
          // the sheet's own `@bakery { lightmap }` is this bake's output; applying it here would zero the
          // lights before they are traced and bake a scene lit by its own previous atlas
          lightmap: false,
          // the posted sheets first, then disk: an `@import` of a library sheet the editor never opened
          // is still part of the map, and it is sitting right there
          load: async (path: string, from?: string) => {
            const owner = from ? fileURLToPath(from) : entry;
            const target = resolve(dirname(owner), path);
            const key = relative(dir, target).split(sep).join("/");
            const held = request.files[key];
            return {
              text: held ?? (await readFile(target, "utf8")),
              file: pathToFileURL(target).href,
            };
          },
        });
        validateBakery(scene, root);

        const settings = request.settings ?? {};
        const name = basename(root, extname(root));
        const renderer = await createHeadlessRenderer();
        let last = 0;
        try {
          const result = await bake(scene, {
            renderer,
            signal,
            // an unset setting stays undefined so the sheet's own `@bakery` block, and then the stage
            // default, still get their say — the same precedence the command line has
            ...only(settings),
            onWarn: (warning: string) => say({ kind: "warn", text: warning }),
            onProgress: (stage: Stage, done: number) => {
              const now = Date.now();
              // the ends of a stage always go out: they are what moves the bar between segments, and
              // dropping one leaves it parked at 97% of a stage that finished a minute ago
              if (now - last < EVERY && done > 0 && done < 1) return;
              last = now;
              say({ kind: "stage", stage, done });
            },
          });
          say({ kind: "stage", stage: "write", done: 0 });
          const written = await writeBake(result, out, name, { exr: settings.exr });
          return {
            kind: "done",
            manifest: `${BAKE_ROUTE}/out/${name}.lightmap.json`,
            files: written.map((f) => basename(f)),
            width: result.width,
            height: result.height,
            utilization: result.utilization,
            exposure: result.exposure,
            ms: Date.now() - began,
          };
        } finally {
          renderer.dispose();
        }
      }

      /** an atlas the bake just wrote, which is the only thing under `out` anybody may ask for */
      async function file(path: string, res: ServerResponse): Promise<void> {
        // `basename`, so the route cannot be walked out of the directory it serves
        const name = basename(decodeURIComponent(path.slice("/out/".length)));
        try {
          const bytes = await readFile(join(out, name));
          res.writeHead(200, {
            "content-type": TYPES[extname(name)] ?? "application/octet-stream",
            // the manifest is rewritten in place by the next bake, and the browser must not keep the old one
            "cache-control": "no-store",
          });
          res.end(bytes);
        } catch {
          res.statusCode = 404;
          res.end(`no ${name} — has this map been baked?`);
        }
      }
    },
  };
}

/** the settings that were actually given, so an absent one does not shadow the sheet's own `@bakery` */
export function only(settings: Partial<Settings>): Record<string, unknown> {
  const { size, samples, bounces, texelsPerUnit, ao, exr } = settings;
  return Object.fromEntries(
    Object.entries({ size, samples, bounces, texelsPerUnit, ao, exr }).filter(([, v]) => v !== undefined),
  );
}

/** the request body, refused rather than buffered once it stops looking like a map */
async function body(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMIT) throw new Error(`the posted map is over ${LIMIT >> 20} MB`);
    chunks.push(chunk as Buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
  if (!parsed?.files || typeof parsed.root !== "string") throw new Error("a bake needs `files` and a `root`");
  return parsed;
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(res.statusCode === 200 ? 200 : res.statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
