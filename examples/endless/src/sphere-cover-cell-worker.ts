// Worker script of the sphere page with `cover=1`: the same cells with the baked cover of the surface.
import { serveCellGenerator } from 'wallhammer-web/runtime';
import { generateSphereCell } from './sphere-world.ts';

serveCellGenerator((seed, cell) => generateSphereCell(seed, cell, true));
