// Frame loop. Draws continuously only while some clock is running, otherwise only on request
// (view change, clock setting). Reads real time only here and passes it to the clocks.

/** A clock the loop drives (see `Clock` in core). */
export interface LoopClock {
  readonly animating: boolean;
  /** Advances by real time in seconds. Returns true when the value changed. */
  advance(dt: number): boolean;
  onChange(listener: () => void): unknown;
}

export interface FrameLoopOptions {
  /** Renders one frame. */
  render: () => void;
  /** Clocks the loop drives and uses to tell whether it should run. */
  clocks: readonly LoopClock[];
  /** Called after every loop frame (not after `renderNow`), e.g. for a status line. */
  onFrame?: () => void;
  /** Longest real-time step per frame in seconds. After returning to the tab the clocks do not jump. */
  maxStep?: number;
}

export class FrameLoop {
  private readonly options: FrameLoopOptions;
  private handle = 0;
  private last = 0;
  private dirty = false;
  private started = false;
  private fpsFrames = 0;
  private fpsSince = 0;
  /** Frames per second measured over the last half second, 0 when the loop is stopped. */
  fps = 0;

  constructor(options: FrameLoopOptions) {
    this.options = options;
    for (const c of options.clocks) c.onChange(() => this.invalidate());
  }

  /** Is continuous drawing running now? */
  get animating(): boolean {
    for (const c of this.options.clocks) if (c.animating) return true;
    return false;
  }

  start(): void {
    this.started = true;
    this.invalidate();
  }

  stop(): void {
    this.started = false;
    if (this.handle) cancelAnimationFrame(this.handle);
    this.handle = 0;
  }

  /** Requests one frame at the browser's next tick. */
  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  /** Renders immediately, synchronously. Does not advance the clocks. */
  renderNow(): void {
    this.dirty = false;
    this.options.render();
  }

  private schedule(): void {
    if (!this.started || this.handle) return;
    this.handle = requestAnimationFrame(this.onTick);
  }

  /** The browser's callback, made once, so scheduling a frame allocates nothing. */
  private readonly onTick = (now: number): void => this.frame(now);

  private frame(now: number): void {
    this.handle = 0;
    const maxStep = this.options.maxStep ?? 0.1;
    // After a pause the time is not counted from the last frame before it.
    const dt = this.last > 0 ? Math.min(maxStep, (now - this.last) / 1000) : 0;
    let moved = false;
    for (const c of this.options.clocks) moved = c.advance(dt) || moved;
    if (moved || this.dirty) {
      this.dirty = false;
      this.options.render();
    }
    if (this.animating) {
      this.last = now;
      this.fpsFrames++;
      if (this.fpsSince === 0) this.fpsSince = now;
      else if (now - this.fpsSince >= 500) {
        this.fps = (this.fpsFrames * 1000) / (now - this.fpsSince);
        this.fpsFrames = 0;
        this.fpsSince = now;
      }
      this.schedule();
    } else {
      this.last = 0;
      this.fps = 0;
      this.fpsFrames = 0;
      this.fpsSince = 0;
    }
    this.options.onFrame?.();
  }
}
