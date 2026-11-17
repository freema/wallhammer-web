import type { GL } from 'wallhammer-web/gpu';
import { Renderer } from 'wallhammer-web/render';
import { B } from '../gen-ground/index.ts';
import { main } from 'demo-app';
export function shape(): number {
  return B + main + (Renderer ? 1 : 0);
}
export function upload(gl: GL): void {
  void gl;
}
export function frame(): number {
  return requestAnimationFrame(() => {});
}
