import { B } from 'wallhammer-web/gen-ground';
import { DEMO } from 'demo-app';
export function clear(gl: WebGL2RenderingContext): number {
  gl.clear(gl.COLOR_BUFFER_BIT);
  return B + DEMO;
}
