// Worker script of the strips (strip=1): as smooth-cell-worker.ts, with the generator that adds the strips.
import { serveCellGenerator } from 'wallhammer-web/runtime';
import { generateStripCell } from './strips.ts';

serveCellGenerator(generateStripCell);
