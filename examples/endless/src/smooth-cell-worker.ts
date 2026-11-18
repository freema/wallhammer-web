// Worker script of smooth levels of detail (lod=smooth): as cell-worker.ts, with the generator whose cells can blend
// into the level one coarser.
import { serveCellGenerator } from 'wallhammer-web/runtime';
import { generateSmoothCell } from './terrain.ts';

serveCellGenerator(generateSmoothCell);
