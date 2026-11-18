// Worker script of the sphere page: generates and encodes cells of the sphere off the main thread.
import { serveCellGenerator } from 'wallhammer-web/runtime';
import { generateSphereCell } from './sphere-world.ts';

serveCellGenerator(generateSphereCell);
