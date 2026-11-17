// Known good: the other content module, a roof generator on the base layer.
import { add } from 'wallhammer-web/base';
export const roofPitch = add(30, 0);
// A module may have subfolders; their files belong to the module.
export { ridgeHeight } from './structure/roof.ts';
