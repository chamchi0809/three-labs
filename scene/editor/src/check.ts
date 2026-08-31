/**
 * The check harness. No test framework: the editor's checks are plain scripts run with
 * `node --experimental-strip-types`, which is the same thing `tscene` does one directory over.
 *
 * A check reports every failure rather than stopping at the first, because the brush kernel's checks
 * come in families — when clipping breaks, twenty of them break together and the shape of the wreckage
 * is the diagnosis.
 */
let failed = 0;

/** the asynchronous checks still running, which {@link settle} is how a suite waits for */
const pending: Promise<void>[] = [];

export function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const running = fn();
    if (running) pending.push(running.catch((e) => blame(name, e)));
  } catch (e) {
    blame(name, e);
  }
}

function blame(name: string, e: unknown): void {
  failed++;
  console.error(`✗ ${name}\n  ${(e as Error).message.split("\n").slice(0, 4).join("\n  ")}`);
}

/**
 * Waits for every check that returned a promise.
 *
 * A suite with asynchronous checks must `await settle()` before {@link report}, or it reports before its
 * own failures have happened. Top-level await is what makes that safe: `checks.ts` imports each suite with
 * `await import(...)`, so a suite that has not settled has not finished loading and the next one waits.
 */
export function settle(): Promise<void> {
  return Promise.all(pending.splice(0)).then(() => undefined);
}

/**
 * Exits non-zero if anything failed; `label` names the suite in the one line a passing run prints.
 * The count resets, so `checks.ts` can run every suite in one process and still report them separately —
 * `process.exitCode` is the part that stays set.
 */
export function report(label: string): void {
  if (failed > 0) {
    console.error(`${label}: ${failed} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`${label}: ok`);
  }
  failed = 0;
}
