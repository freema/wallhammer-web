// Loss of the graphics context: the browser may take the context of a canvas away at any time (the driver restarted,
// too many contexts, the tab slept on a phone) and hand a fresh, empty one back later. This watches the two events.
// The browser only restores a context when the "lost" event was answered with `preventDefault`, which is done here.

export interface ContextLossHandlers {
  /** The context is gone: nothing can be drawn or uploaded until `restored`. */
  lost?: () => void;
  /** A fresh context is there: every object of the old one is void and has to be made again. */
  restored: () => void;
}

/** Calls the handlers when the canvas loses its context and when it has a new one. Returns a function that stops. */
export function watchContextLoss(canvas: HTMLCanvasElement, handlers: ContextLossHandlers): () => void {
  const onLost = (e: Event): void => {
    e.preventDefault();
    handlers.lost?.();
  };
  const onRestored = (): void => handlers.restored();
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  return () => {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
  };
}
