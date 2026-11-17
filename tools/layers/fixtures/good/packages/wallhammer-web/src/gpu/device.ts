import { add } from '../base/math.ts';
export type GL = WebGL2RenderingContext;
export class Device {
  constructor(private readonly gl: GL) {}
  clear(): void {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT + add(0, 0));
  }
}
