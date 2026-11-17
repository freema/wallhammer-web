// Controls of a walking body seen through a turnable view: keys and a gamepad stick give the wanted movement in the
// view's frame, a drag (or the locked pointer, or the right stick) turns the view, the wheel changes the view's
// distance. Only events, the gamepad and the view, no on-screen elements. What the movement does is the caller's
// business: it reads the state once per frame and turns it into world movement with the view's heading.
//
// Touch is not built yet: a touch drag turns the view like a mouse drag, but there is no on-screen stick to walk with.

import { trackHeldKeys } from './keys.ts';
import type { Canvas } from './canvas.ts';

/** What the walk controls drive: a view turned by pointer pixels whose distance is changed by a factor. */
export interface WalkView {
  /** Physical pixels per CSS pixel. */
  readonly dpr: number;
  /** Pointer movement in physical pixels: right turns the view right, down turns it down. */
  turnPixels(dx: number, dy: number): void;
  /** Multiplies the view's distance (above 1 is farther). */
  zoomBy(factor: number): void;
}

/** What the controls ask for in one frame. */
export interface WalkInputState {
  /** Wanted movement in the view's frame: forward and to the right, each −1 to 1. */
  forward: number;
  right: number;
  run: boolean;
  /** True once per press. */
  jump: boolean;
}

/** Keys of each action as `KeyboardEvent.code` values; any of the listed keys counts. */
export interface WalkKeys {
  forward: readonly string[];
  back: readonly string[];
  left: readonly string[];
  right: readonly string[];
  run: readonly string[];
  jump: readonly string[];
}

export const DEFAULT_WALK_KEYS: WalkKeys = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
};

export interface WalkInputOptions {
  /** Called on every key change and view turn, and from `read` while the controls ask for movement: request a frame here. */
  onChange?: () => void;
  /** Replaces the keys of single actions; the rest keep `DEFAULT_WALK_KEYS`. */
  keys?: Partial<WalkKeys>;
  /** Distance factor per 100 wheel units (wheel down is farther). Default 1.15. */
  wheelFactor?: number;
  /** `true`: a press locks the pointer to the canvas and its movement turns the view until Escape. Default: drag turns. */
  pointerLock?: boolean;
  /** Class the canvas gets for the duration of a drag (for the cursor). Default 'dragging'. */
  draggingClass?: string;
  /** Read a gamepad with the standard layout. Default true. */
  gamepad?: boolean;
  /** Radial dead zone of the gamepad sticks, 0–1. Default 0.15. */
  deadZone?: number;
  /** CSS pixels of turn per second at the full deflection of the right stick. Default 600. */
  stickTurnPx?: number;
}

export interface WalkInput {
  /**
   * Reads keys and the gamepad into `out` and passes pointer turns and wheel zoom to the view. Call once per frame.
   * The right stick turns the view by the real time since the previous call (at most 0.1 s), or by `dtSeconds`.
   */
  read(out: WalkInputState, dtSeconds?: number): WalkInputState;
  /**
   * `false` hands the view and the body to someone else: held keys are released, a drag ends, a locked pointer is let
   * go, and nothing touches the view any more; `read` gives no movement. `true` takes them back.
   */
  enabled: boolean;
  /** Is the pointer locked to the canvas now? */
  readonly pointerLocked: boolean;
  /**
   * Is a gamepad connected now? A gamepad sends no events for its sticks: while one is connected keep frames coming
   * (for example `Engine.animateWhile(() => input.gamepadConnected)`), or `read` never sees it move.
   */
  readonly gamepadConnected: boolean;
  /** Detaches the listeners and releases a locked pointer. */
  dispose(): void;
}

/** Standard gamepad layout: buttons and axes used here. */
const PAD_A = 0;
const PAD_RT = 7;
const PAD_L3 = 10;
const PAD_LX = 0;
const PAD_LY = 1;
const PAD_RX = 2;
const PAD_RY = 3;

/** Radial dead zone: inside it nothing, outside it the stick's deflection rescaled to start at 0. Written to `out`. */
function deadZoned(x: number, y: number, zone: number, out: [number, number]): [number, number] {
  const len = Math.hypot(x, y);
  if (len <= zone || len === 0) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  const scaled = Math.min(1, (len - zone) / (1 - zone)) / len;
  out[0] = x * scaled;
  out[1] = y * scaled;
  return out;
}

/**
 * Attaches walk controls: W A S D or the arrows move, Shift runs, Space jumps, a drag (or the locked pointer) turns the
 * view, the wheel changes its distance. A gamepad with the standard layout: left stick moves, right stick turns, A
 * jumps, pressing the left stick or RT runs. Call `read` of the result every frame.
 */
export function bindWalkInput(canvas: Canvas, view: WalkView, options: WalkInputOptions = {}): WalkInput {
  const { onChange, wheelFactor = 1.15, pointerLock = false, draggingClass = 'dragging', gamepad = true, deadZone = 0.15, stickTurnPx = 600 } = options;
  const keys: WalkKeys = { ...DEFAULT_WALK_KEYS, ...options.keys };
  const changed = (): void => onChange?.();
  const abort = new AbortController();
  const signal = abort.signal;
  const held = trackHeldKeys(changed);
  const locked = (): boolean => document.pointerLockElement === canvas;
  const typing = (t: EventTarget | null): boolean =>
    t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
  const owns = (code: string): boolean => {
    for (const list of [keys.forward, keys.back, keys.left, keys.right, keys.jump]) if (list.includes(code)) return true;
    return false;
  };

  let enabled = true;
  let jumpQueued = false;
  let padJumpHeld = false;
  let pads = 0;

  window.addEventListener(
    'keydown',
    (e) => {
      if (!enabled || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (keys.jump.includes(e.code) && !e.repeat) jumpQueued = true;
      // The page must not scroll under the movement keys.
      if (owns(e.code)) e.preventDefault();
    },
    { signal },
  );

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const stopDrag = (): void => {
    dragging = false;
    canvas.classList.remove(draggingClass);
  };
  canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (!enabled) return;
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
      if (!enabled) return;
      if (pointerLock) {
        if (!locked()) return;
        view.turnPixels(e.movementX * view.dpr, e.movementY * view.dpr);
        changed();
        return;
      }
      if (!dragging) return;
      view.turnPixels((e.clientX - lastX) * view.dpr, (e.clientY - lastY) * view.dpr);
      lastX = e.clientX;
      lastY = e.clientY;
      changed();
    },
    { signal },
  );
  canvas.addEventListener('pointerup', stopDrag, { signal });
  canvas.addEventListener('pointercancel', stopDrag, { signal });
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!enabled) return;
      e.preventDefault();
      view.zoomBy(Math.pow(wheelFactor, e.deltaY / 100));
      changed();
    },
    { passive: false, signal },
  );

  const canPad = gamepad && typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
  if (canPad) {
    window.addEventListener(
      'gamepadconnected',
      () => {
        pads++;
        changed();
      },
      { signal },
    );
    window.addEventListener('gamepaddisconnected', () => (pads = Math.max(0, pads - 1)), { signal });
  }

  const anyHeld = (codes: readonly string[]): boolean => {
    for (const c of codes) if (held.has(c)) return true;
    return false;
  };
  const stick: [number, number] = [0, 0];
  let last = 0;

  return {
    read(out: WalkInputState, dtSeconds?: number): WalkInputState {
      let dt = dtSeconds;
      if (dt === undefined) {
        const now = performance.now();
        dt = last > 0 ? Math.min(0.1, (now - last) / 1000) : 0;
        last = now;
      }
      out.forward = 0;
      out.right = 0;
      out.run = false;
      out.jump = false;
      if (!enabled) {
        last = 0;
        return out;
      }
      let forward = (anyHeld(keys.forward) ? 1 : 0) - (anyHeld(keys.back) ? 1 : 0);
      let right = (anyHeld(keys.right) ? 1 : 0) - (anyHeld(keys.left) ? 1 : 0);
      let run = anyHeld(keys.run);
      let jump = jumpQueued;
      jumpQueued = false;
      let padActive = false;
      if (canPad && pads > 0) {
        // getGamepads hands out a fresh list each call in some browsers; it is read only while a pad is connected.
        const list = navigator.getGamepads();
        for (const pad of list) {
          if (!pad || !pad.connected || pad.mapping !== 'standard') continue;
          const ax = pad.axes;
          const b = pad.buttons;
          deadZoned(ax[PAD_LX] ?? 0, ax[PAD_LY] ?? 0, deadZone, stick);
          forward -= stick[1];
          right += stick[0];
          deadZoned(ax[PAD_RX] ?? 0, ax[PAD_RY] ?? 0, deadZone, stick);
          if ((stick[0] !== 0 || stick[1] !== 0) && dt > 0) {
            const px = stickTurnPx * dt * view.dpr;
            view.turnPixels(stick[0] * px, stick[1] * px);
          }
          const a = b[PAD_A]?.pressed ?? false;
          if (a && !padJumpHeld) jump = true;
          padJumpHeld = a;
          if ((b[PAD_L3]?.pressed ?? false) || (b[PAD_RT]?.value ?? 0) > 0.5) run = true;
          padActive = padActive || stick[0] !== 0 || stick[1] !== 0 || forward !== 0 || right !== 0 || a;
          break;
        }
      }
      out.forward = Math.max(-1, Math.min(1, forward));
      out.right = Math.max(-1, Math.min(1, right));
      out.run = run;
      out.jump = jump;
      // While asked to move (or a gamepad is in use) every frame asks for the next one; at rest the real-time step starts over.
      if (out.forward !== 0 || out.right !== 0 || jump || padActive) changed();
      else last = 0;
      return out;
    },
    get enabled(): boolean {
      return enabled;
    },
    set enabled(on: boolean) {
      if (on === enabled) return;
      enabled = on;
      held.clear();
      jumpQueued = false;
      padJumpHeld = true; // a button held across the hand-over does not count as a new press
      last = 0;
      stopDrag();
      if (!on && locked()) document.exitPointerLock();
      changed();
    },
    get pointerLocked(): boolean {
      return locked();
    },
    get gamepadConnected(): boolean {
      return pads > 0;
    },
    dispose(): void {
      abort.abort();
      held.dispose();
      stopDrag();
      if (locked()) document.exitPointerLock();
    },
  };
}
