// Worker script of the planet example: generates and encodes cells of the sphere off the main thread.
import { serveCellGenerator } from 'wallhammer-web/runtime';
import { generatePlanetCell } from './world.ts';

serveCellGenerator(generatePlanetCell);
