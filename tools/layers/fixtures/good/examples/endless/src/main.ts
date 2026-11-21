// Engine-only example: any engine module except the content modules, and the files of examples/shared.
import { Renderer } from 'wallhammer-web/render';
import { lineMesh } from 'wallhammer-web/gen-mesh';
import { sharedLine } from '../../shared/src/util.ts';
console.log(Renderer, lineMesh(1), sharedLine());
