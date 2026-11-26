// Fixed steps out of frame times: the accumulator every fixed-rate body uses. Frame seconds are added up and as many
// whole steps as are due are run; the rest carries to the next call, so one call of 1/30 s and two of 1/60 s run the
// same steps. At most `maxSteps` run in one call and the rest of a longer pause is dropped (no catching up after a
// stall). `alpha` is the share of the way from the last step to the next one, to draw between the two. Pure state: the
// same calls give the same steps, and nothing allocates.

/** Steps of a fixed length run from frame times, the leftover carried over. */
export class FixedSteps {
  /** Seconds of one step. */
  readonly stepSeconds: number;
  /** Most steps one `advance` runs (unless the call names its own limit). */
  maxSteps: number;
  /** Seconds carried over from the last `advance`, less than a step; part of a saved state. */
  leftover = 0;

  constructor(stepSeconds: number, maxSteps = 15) {
    if (!(stepSeconds > 0)) throw new Error('FixedSteps: stepSeconds must be positive');
    this.stepSeconds = stepSeconds;
    this.maxSteps = maxSteps;
  }

  /** Share of the way from the last step to the next one, 0–1. */
  get alpha(): number {
    const a = this.leftover / this.stepSeconds;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  /** Drops the leftover (after a teleport: the next step is a whole step away). */
  reset(): void {
    this.leftover = 0;
  }

  /**
   * Adds `dt` seconds and calls `step` once for every step due, at most `maxSteps` times (the rest of the time is then
   * dropped). Returns the number of steps run. `step` may call `reset` (a teleport inside a step): the loop then stops
   * after that step.
   */
  advance(dt: number, step: () => void, maxSteps = this.maxSteps): number {
    if (!(dt > 0)) return 0;
    this.leftover += dt;
    const h = this.stepSeconds;
    let n = 0;
    // The tolerance keeps a sum of equal frame times from falling a rounding short of a whole step.
    while (this.leftover + 1e-9 * h >= h) {
      if (n >= maxSteps) {
        this.leftover = 0;
        break;
      }
      step();
      this.leftover -= h;
      n++;
    }
    if (this.leftover < 0) this.leftover = 0;
    return n;
  }
}
