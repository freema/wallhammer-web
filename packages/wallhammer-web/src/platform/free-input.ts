// Controls of a freely moving view by keyboard and pointer: held keys move it, dragging (or the locked pointer) turns
// it, the wheel changes its speed. Only events and the view, no on-screen elements; what the view does with a turn or
// a move is the rig's business (see `FreeRig` in camera).

import { trackHeldKeys } from './keys.ts';

/** What the free controls drive: a view that is turned by pointer pixels and moved along its own axes. */
export interface FreeControl {
  /** Physical pixels per CSS pixel. */
  readonly dpr: number;
  /** Pointer movement in physical pixels: right turns the view right, down turns it down. */
  turnPixels(dx: number, dy: number): void;
  /** Multiplies the speed (above 1 is faster). */
  scaleSpeed(factor: number): void;
  /** Moves for `dtSeconds`; the inputs are −1…1 (forward, right, up). Returns whether the view is still moving. */
  move(forward: number, right: number, up: number, dtSeconds: number, boost: boolean): boolean;
}

/** Keys of each movement as `KeyboardEvent.code` values; any of the listed keys counts. */
export interface FreeKeys {
  forward: readonly string[];
  back: readonly string[];
  left: readonly string[];
  right: readonly string[];
  up: readonly string[];
  down: readonly string[];
  boost: readonly string[];
}

export const DEFAULT_FREE_KEYS: FreeKeys = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['KeyE', 'Space'],
  down: ['KeyQ', 'KeyC'],
  boost: ['ShiftLeft', 'ShiftRight'],
};

export interface FreeInputOptions {
  /** Called after every view change and while a movement key is held or the view still moves: request a frame here. */
  onChange: () => void;
  /** Replaces the keys of single movements; the rest keep `DEFAULT_FREE_KEYS`. */
  keys?: Partial<FreeKeys>;
  /** Speed factor per 100 wheel units (wheel up is faster). */
  wheelFactor?: number;
  /** `true`: a press locks the pointer to the canvas and its movement turns the view until Escape. Default: drag turns. */
  pointerLock?: boolean;
  /** `true`: a drag pulls the image along with the pointer instead of turning the view toward it. */
  grab?: boolean;
  /** Class the canvas gets for the duration of a drag (for the cursor). */
  draggingClass?: string;
}

export interface FreeInput {
  /**
   * Applies the held keys to the view once per frame, before rendering. Without an argument the step is the real time
   * since the previous call (at most 0.1 s; the first call after a rest steps by 0). Returns whether a movement key is
   * held or the view still moves.
   */
  step(dtSeconds?: number): boolean;
  /** Detaches the listeners and releases a locked pointer. */
  dispose(): void;
}

/**
 * Attaches free controls: W A S D or the arrows move, E / Space and Q / C move up and down, Shift boosts, a drag (or
 * the locked pointer) turns, the wheel changes the speed. Call `step` of the result every frame.
 */
export function bindFreeInput(canvas: HTMLCanvasElement, view: FreeControl, options: FreeInputOptions): FreeInput {
  const { onChange, wheelFactor = 1.15, pointerLock = false, draggingClass = 'dragging' } = options;
  const keys: FreeKeys = { ...DEFAULT_FREE_KEYS, ...options.keys };
  const sign = options.grab ? -1 : 1;
  const abort = new AbortController();
  const signal = abort.signal;
  const held = trackHeldKeys(onChange);
  const locked = (): boolean => document.pointerLockElement === canvas;

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (pointerLock) {
        if (!locked()) {
          // Older browsers return nothing, newer ones a promise that rejects when the lock is refused.
          const asked: unknown = canvas.requestPointerLock();
          if (asked instanceof Promise) asked.catch(() => {});
        }
        return;
      }
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add(draggingClass);
    },
    { signal },
  );
  canvas.addEventListener(
    'pointermove',
    (e) => {
      if (pointerLock) {
        if (!locked()) return;
        view.turnPixels(e.movementX * view.dpr, e.movementY * view.dpr);
        onChange();
        return;
      }
      if (!dragging) return;
      view.turnPixels((e.clientX - lastX) * view.dpr * sign, (e.clientY - lastY) * view.dpr * sign);
      lastX = e.clientX;
      lastY = e.clientY;
      onChange();
    },
    { signal },
  );
  const stop = (): void => {
    dragging = false;
    canvas.classList.remove(draggingClass);
  };
  canvas.addEventListener('pointerup', stop, { signal });
  canvas.addEventListener('pointercancel', stop, { signal });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      view.scaleSpeed(Math.pow(wheelFactor, -e.deltaY / 100));
      onChange();
    },
    { passive: false, signal },
  );

  const axis = (plus: readonly string[], minus: readonly string[]): number => (plus.some((c) => held.has(c)) ? 1 : 0) - (minus.some((c) => held.has(c)) ? 1 : 0);
  let last = 0;
  return {
    step(dtSeconds?: number): boolean {
      let dt = dtSeconds;
      if (dt === undefined) {
        const now = performance.now();
        dt = last > 0 ? Math.min(0.1, (now - last) / 1000) : 0;
        last = now;
      }
      const forward = axis(keys.forward, keys.back);
      const right = axis(keys.right, keys.left);
      const up = axis(keys.up, keys.down);
      const moving = view.move(forward, right, up, dt, keys.boost.some((c) => held.has(c)));
      const active = moving || forward !== 0 || right !== 0 || up !== 0;
      // While active every frame asks for the next one; at rest the real-time step starts over.
      if (active) onChange();
      else last = 0;
      return active;
    },
    dispose(): void {
      abort.abort();
      held.dispose();
      if (locked()) document.exitPointerLock();
    },
  };
}
