import { Renderer } from '../render/renderer.ts';
export function wander(): number {
  return Math.random() + (Renderer ? Math.sin(Date.now()) : 0);
}
