// Canvas size in physical pixels. Taken directly from the browser (devicePixelContentBoxSize),
// otherwise the image gets resampled and moire appears on fine patterns.

/** The drawing surface as modules above platform see it (they must not name browser DOM types). */
export type Canvas = HTMLCanvasElement;

/** Whatever follows the drawing-buffer size, typically a target rig. */
export interface CanvasSizeTarget {
  width: number;
  height: number;
  /** Physical pixels per CSS pixel. */
  dpr: number;
}

/**
 * Pixels of the drawing buffer per CSS pixel: the browser's `devicePixelRatio`, at most `maxPixelRatio` when that is
 * given. Below the device's ratio the canvas is drawn at fewer pixels and the browser scales it up to its CSS size.
 */
export function canvasPixelRatio(maxPixelRatio?: number): number {
  const dpr = window.devicePixelRatio || 1;
  return maxPixelRatio !== undefined && maxPixelRatio > 0 ? Math.min(dpr, maxPixelRatio) : dpr;
}

/**
 * Sets the canvas and target size in physical pixels. Returns true when the size changed. `target.dpr` becomes the
 * device's pixel ratio, or `pixelRatio` when given (the ratio the size was computed with).
 */
export function resizeCanvas(canvas: HTMLCanvasElement, target: CanvasSizeTarget, width: number, height: number, pixelRatio?: number): boolean {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const changed = canvas.width !== w || canvas.height !== h;
  if (changed) {
    canvas.width = w;
    canvas.height = h;
  }
  target.width = w;
  target.height = h;
  target.dpr = pixelRatio ?? (window.devicePixelRatio || 1);
  return changed;
}

/**
 * Syncs the size right now according to the page layout. Useful before a frame outside the browser's timer.
 * `maxPixelRatio` caps the pixels per CSS pixel (`canvasPixelRatio`); default: no cap.
 */
export function syncCanvasSize(canvas: HTMLCanvasElement, target: CanvasSizeTarget, maxPixelRatio?: number): boolean {
  const r = canvas.getBoundingClientRect();
  if (maxPixelRatio === undefined) {
    const dpr = window.devicePixelRatio || 1;
    return resizeCanvas(canvas, target, r.width * dpr, r.height * dpr);
  }
  const ratio = canvasPixelRatio(maxPixelRatio);
  return resizeCanvas(canvas, target, r.width * ratio, r.height * ratio, ratio);
}

/**
 * Watches the canvas size and keeps it in physical pixels. `onResize` is called only on a real change.
 * `maxPixelRatio` caps the pixels per CSS pixel (`canvasPixelRatio`); default: no cap, the device's own pixels.
 */
export function observeCanvasSize(canvas: HTMLCanvasElement, target: CanvasSizeTarget, onResize?: () => void, maxPixelRatio?: number): ResizeObserver {
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const box = entry.devicePixelContentBoxSize?.[0];
    const dpr = window.devicePixelRatio || 1;
    let changed: boolean;
    if (maxPixelRatio === undefined) {
      changed = box
        ? resizeCanvas(canvas, target, box.inlineSize, box.blockSize)
        : resizeCanvas(canvas, target, entry.contentRect.width * dpr, entry.contentRect.height * dpr);
    } else {
      // Capped: the device pixel box scaled by the share of the device's pixels that is kept.
      const ratio = canvasPixelRatio(maxPixelRatio);
      changed = box
        ? resizeCanvas(canvas, target, (box.inlineSize * ratio) / dpr, (box.blockSize * ratio) / dpr, ratio)
        : resizeCanvas(canvas, target, entry.contentRect.width * ratio, entry.contentRect.height * ratio, ratio);
    }
    if (changed) onResize?.();
  });
  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(canvas);
  }
  syncCanvasSize(canvas, target, maxPixelRatio);
  return observer;
}
