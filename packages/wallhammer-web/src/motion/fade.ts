// An eased weight: a number that moves to a goal over a given time with a smooth start and end, advanced by the
// game's time step. The post steps of the module (reach, aim, socket blends) take their weight from one; a game can
// use it for any weight of its own. Pure state: the same calls give the same values.

/** A weight 0–1 (or any number) eased toward a goal over a set number of seconds. */
export class WeightFade {
  /** The weight now. */
  value: number;
  private from: number;
  private target: number;
  private seconds = 0;
  private t = 1;

  constructor(value = 0) {
    this.value = value;
    this.from = value;
    this.target = value;
  }

  /** The value the fade is moving to. */
  get goal(): number {
    return this.target;
  }

  /** True when the value has reached the goal. */
  get done(): boolean {
    return this.t >= 1;
  }

  /**
   * Starts moving from the value now to `goal` over `seconds` (eased: smooth start and end). 0 seconds jumps. Asking
   * for the goal it already moves to changes nothing.
   */
  to(goal: number, seconds: number): void {
    if (goal === this.target && this.t < 1) return;
    this.from = this.value;
    this.target = goal;
    this.seconds = seconds;
    if (!(seconds > 0) || goal === this.value) {
      this.value = goal;
      this.t = 1;
    } else {
      this.t = 0;
    }
  }

  /** Sets the value at once (no fade). */
  set(value: number): void {
    this.value = value;
    this.from = value;
    this.target = value;
    this.t = 1;
  }

  /** Advances by `dt` seconds; returns the value. */
  update(dt: number): number {
    if (this.t < 1 && dt > 0) {
      this.t = Math.min(1, this.t + dt / this.seconds);
      const s = this.t * this.t * (3 - 2 * this.t);
      this.value = this.t >= 1 ? this.target : this.from + (this.target - this.from) * s;
    }
    return this.value;
  }
}
