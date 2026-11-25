// Worker script of the planet example with strips: generates and encodes cells with the strips off the main thread.
// The options of the cells come in the worker's own URL, as for cell-worker.ts.
import { serveCellGenerator } from 'wallhammer-web/runtime';
import { planetStripCellGenerator } from './strips.ts';
import { planetCellOptions } from './world.ts';

serveCellGenerator(planetStripCellGenerator(planetCellOptions(new URLSearchParams(self.location.search))));
