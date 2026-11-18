// Worker script of the planet example with strips: generates and encodes cells with the strips off the main thread.
import { serveCellGenerator } from 'wallhammer-web/runtime';
import { generatePlanetStripCell } from './strips.ts';

serveCellGenerator(generatePlanetStripCell);
