/**
 * The check harness. No test framework: the editor's checks are plain scripts run with
 * `node --experimental-strip-types`, which is the same thing `tscene` does one directory over.
 *
 * A check reports every failure rather than stopping at the first, because the brush kernel's checks
 * come in families — when clipping breaks, twenty of them break together and the shape of the wreckage
 * is the diagnosis.
 */
let failed = 0;

export function test(name: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n  ${(e as Error).message.split("\n").slice(0, 4).join("\n  ")}`);
  }
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
