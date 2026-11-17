import { SUN } from '../env/sun.ts';
import { shape } from '../gen-arch/index.ts';
export class Renderer {
  draw(gl: WebGL2RenderingContext): void {
    gl.drawArrays(gl.TRIANGLES, 0, SUN + shape());
    document.title = 'x';
  }
}
