// Worker script of the planet example: generates and encodes cells of the sphere off the main thread. The options of
// the cells (`split`, `extra`) come in the worker's own URL (main.ts, `planetCellQuery`); without them the plain cells.
import { serveCellGenerator } from 'wallhammer-web/runtime';
import { planetCellGenerator, planetCellOptions } from './world.ts';

serveCellGenerator(planetCellGenerator(planetCellOptions(new URLSearchParams(self.location.search))));
