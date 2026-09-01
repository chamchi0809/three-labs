/**
 * How many simulation steps a frame is worth.
 *
 * A shooter's movement cannot be scaled by the frame time and stay the same shooter. Gravity, air control
 * and the collide-and-slide that resolves a capsule against the world all compound per step, so a 165 Hz
 * machine and a 60 Hz one that integrate "whatever time has passed" produce different jump heights and
 * different distances off a ramp. The simulation therefore runs at a fixed 60 Hz and the frame only decides
 * how many of those steps it owes.
 *
 * Two guards, both learned the hard way:
 *
 * - **A frame is at most 250 ms.** Come back to a tab that was in the background for a minute and the
 *   accumulator would hold sixty seconds of arrears, which is either a hang or a teleport through a wall.
 *   Time the page did not see is time the game did not happen in.
 * - **At most five steps a frame**, and the accumulator is clamped to that many as it goes in. Without the
 *   clamp, a machine that cannot manage five steps inside one frame accumulates faster than it drains and
 *   the debt grows until the tab dies.
 */
export type FixedStepResult = {
  /** what is left over, to be passed back in next frame */
  accumulator: number;
  /** how many fixed steps to run now */
  steps: number;
};

export function fixedStepSchedule(
  accumulator: number,
  deltaMs: number,
  fixedDt = 1 / 60,
  maxSteps = 5,
): FixedStepResult {
  let next = Math.min(fixedDt * maxSteps, accumulator + Math.min(Math.max(0, deltaMs), 250) / 1000);
  let steps = 0;
  // EPSILON, because 1/60 in binary floating point does not add up to 1/60 — a hundred frames of exactly
  // one step each would otherwise drop one, and a game that runs 1% slow on a good machine is a bug
  // nobody can see and everybody can feel
  while (next + Number.EPSILON >= fixedDt && steps < maxSteps) {
    next -= fixedDt;
    steps++;
  }
  return { accumulator: Math.max(0, next), steps };
}
