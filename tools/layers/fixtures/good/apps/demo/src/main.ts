import { shape } from 'wallhammer-web/gen-ground';
import { Renderer } from 'wallhammer-web/render';
const gl = document.createElement('canvas').getContext('webgl2') as WebGL2RenderingContext;
gl.clear(gl.COLOR_BUFFER_BIT);
console.log(shape(), new Renderer({} as never));
