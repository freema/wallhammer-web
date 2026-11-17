// Control of a stepped view (typically a camera rig) by mouse, touch and keyboard. Only events and the view, no on-screen elements:
// the app draws its own buttons and panels and calls the same view methods.

/** What the controls drive: a view with stepped zoom and rotation that can be panned by screen pixels. */
export interface ViewControl {
  /** Physical pixels per CSS pixel. */
  readonly dpr: number;
  readonly zoom: number;
  readonly rotation: number;
  panPixels(dx: number, dy: number): void;
  setZoom(level: number): void;
  setRotation(step: number): void;
}

/** Kind of view change: smooth movement (drag), or a jump (rotation, zoom, arrow step, reset). */
export type ViewChangeKind = 'pan' | 'step';

export interface CameraInputOptions {
  /** Called after every view change. During 'pan' it fires often, so it is enough to request another frame. */
  onChange: (kind: ViewChangeKind) => void;
  /** Key 0: return to the default view. The app sets the view, `onChange` is called afterwards. */
  onHome?: () => void;
  /** Class the canvas gets for the duration of a drag (for the cursor). */
  draggingClass?: string;
  /** Arrow-key pan step in CSS pixels. */
  keyPanPx?: number;
  /** How many wheel units make one zoom level. Fine touchpad movements are accumulated. */
  wheelStep?: number;
  /** Where key listeners are attached, the default is the window. */
  keyTarget?: Window | HTMLElement;
  /** A press that does not start a drag (e.g. Alt+click, which the app uses for something else). */
  ignorePointer?: (e: PointerEvent) => boolean;
}

/**
 * Attaches the controls: drag pans, wheel and +/− step the zoom, Q/E rotate by a quarter turn,
 * arrows pan, 0 resets to home. Returns a function that detaches the controls again.
 */
export function bindCameraInput(canvas: HTMLCanvasElement, view: ViewControl, options: CameraInputOptions): () => void {
  const { onChange, onHome, draggingClass = 'dragging', keyPanPx = 80, wheelStep = 80 } = options;
  const keyTarget = options.keyTarget ?? window;
  const abort = new AbortController();
  const signal = abort.signal;

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (options.ignorePointer?.(e)) return;
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
      if (!dragging) return;
      view.panPixels((e.clientX - lastX) * view.dpr, (e.clientY - lastY) * view.dpr);
      lastX = e.clientX;
      lastY = e.clientY;
      onChange('pan');
    },
    { signal },
  );
  const stop = (): void => {
    dragging = false;
    canvas.classList.remove(draggingClass);
  };
  canvas.addEventListener('pointerup', stop, { signal });
  canvas.addEventListener('pointercancel', stop, { signal });

  let wheelAcc = 0;
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      wheelAcc += e.deltaY;
      if (Math.abs(wheelAcc) >= wheelStep) {
        view.setZoom(view.zoom - Math.sign(wheelAcc));
        wheelAcc = 0;
        onChange('step');
      }
    },
    { passive: false, signal },
  );

  keyTarget.addEventListener(
    'keydown',
    (ev) => {
      const e = ev as KeyboardEvent;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Typing into fields and adjusting sliders with arrows does not move the view.
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      const pan = keyPanPx * view.dpr;
      if (e.key === '+' || e.key === '=') view.setZoom(view.zoom + 1);
      else if (e.key === '-' || e.key === '_') view.setZoom(view.zoom - 1);
      else if (e.key === 'q' || e.key === 'Q') view.setRotation(view.rotation + 1);
      else if (e.key === 'e' || e.key === 'E') view.setRotation(view.rotation - 1);
      else if (e.key === '0' && onHome) onHome();
      else if (e.key === 'ArrowLeft') view.panPixels(pan, 0);
      else if (e.key === 'ArrowRight') view.panPixels(-pan, 0);
      else if (e.key === 'ArrowUp') view.panPixels(0, pan);
      else if (e.key === 'ArrowDown') view.panPixels(0, -pan);
      else return;
      e.preventDefault();
      onChange('step');
    },
    { signal },
  );

  return () => abort.abort();
}

/** What orbit controls drive: a view turned by dragging and zoomed by a factor. */
export interface OrbitControl {
  readonly dpr: number;
  orbitPixels(dx: number, dy: number): void;
  zoomBy(factor: number): void;
}

export interface OrbitInputOptions {
  /** Called after every view change. */
  onChange: () => void;
  /** Distance factor per 100 wheel units. */
  wheelFactor?: number;
  draggingClass?: string;
}

/** Attaches orbit controls: drag turns and tilts, the wheel zooms. Returns a function that detaches them. */
export function bindOrbitInput(canvas: HTMLCanvasElement, view: OrbitControl, options: OrbitInputOptions): () => void {
  const { onChange, wheelFactor = 1.15, draggingClass = 'dragging' } = options;
  const abort = new AbortController();
  const signal = abort.signal;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener(
    'pointerdown',
    (e) => {
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
      if (!dragging) return;
      view.orbitPixels((e.clientX - lastX) * view.dpr, (e.clientY - lastY) * view.dpr);
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
      view.zoomBy(Math.pow(wheelFactor, e.deltaY / 100));
      onChange();
    },
    { passive: false, signal },
  );
  return () => abort.abort();
}
