// Every `*.check.ts` under src, run in one process so `pnpm check` never quietly stops covering a file
// somebody forgot to add to a list.
// node --experimental-strip-types --disable-warning=ExperimentalWarning src/checks.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(here, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".check.ts"))
  .sort();

// one at a time: each suite prints its own line, and interleaved failures are unreadable
for (const file of files) await import(pathToFileURL(path.join(here, file)).href);

if (process.exitCode) console.error(`\n${files.length} suite(s) run, some failed`);
