// The window is the browser global here: platform may name it.
import { add } from '../base/math.ts';
export function size(canvas: HTMLCanvasElement): number {
  return add(canvas.width, window.devicePixelRatio);
}
export function tick(fn: () => void): number {
  return requestAnimationFrame(fn);
}
