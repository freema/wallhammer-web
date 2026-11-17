// Animation clock. The single source of time for everything that moves in the scene: it runs, stops, can be sped up,
// set to an exact value and advanced by a fixed step. Real time is fed in only by the frame loop
// (loop.ts), so the same clock value always gives the same image and a frame of a specific moment can be reproduced.

export interface ClockOptions {
  /** Initial value. */
  time?: number;
  /** How many clock units pass per second of real time. */
  rate?: number;
  playing?: boolean;
  /** When given, the value is kept in the range 0 to wrap (hour of day: 24). */
  wrap?: number;
}

export class Clock {
  private value: number;
  private speed: number;
  private running: boolean;
  private readonly wrap: number;
  private readonly listeners = new Set<() => void>();

  constructor(options: ClockOptions = {}) {
    this.wrap = options.wrap ?? 0;
    this.value = this.fold(options.time ?? 0);
    this.speed = options.rate ?? 1;
    this.running = options.playing ?? false;
  }

  private fold(t: number): number {
    if (this.wrap <= 0) return t;
    return ((t % this.wrap) + this.wrap) % this.wrap;
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  /** Current clock value. */
  get time(): number {
    return this.value;
  }

  get rate(): number {
    return this.speed;
  }

  get playing(): boolean {
    return this.running;
  }

  /** Does the value change on its own? Only then is continuous drawing needed. */
  get animating(): boolean {
    return this.running && this.speed !== 0;
  }

  play(): void {
    if (this.running) return;
    this.running = true;
    this.changed();
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.changed();
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.play();
  }

  setRate(rate: number): void {
    if (rate === this.speed) return;
    this.speed = rate;
    this.changed();
  }

  /** Sets an exact value. Does not change running or speed. */
  set(time: number): void {
    const t = this.fold(time);
    if (t === this.value) return;
    this.value = t;
    this.changed();
  }

  /** Advances the clock by a fixed step in its units, even when stopped. */
  step(delta: number): void {
    this.set(this.value + delta);
  }

  /** Feeds a piece of real time into the clock. Called by the frame loop. Returns true when the value changed. */
  advance(realSeconds: number): boolean {
    if (!this.animating || realSeconds <= 0) return false;
    this.value = this.fold(this.value + realSeconds * this.speed);
    return true;
  }

  /** Reports every change from outside (setting, start, stop, speed). Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
