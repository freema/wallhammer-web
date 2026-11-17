// Engine-only example: any engine module except the content modules.
import { Renderer } from 'wallhammer-web/render';
import { lineMesh } from 'wallhammer-web/gen-mesh';
console.log(Renderer, lineMesh(1));
