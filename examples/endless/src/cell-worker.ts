// Worker script: generates cells off the main thread. The encoded bytes travel back as a transferred buffer.
import { serveCellGenerator } from 'wallhammer-web/runtime';
import { generateCell } from './terrain.ts';

serveCellGenerator(generateCell);
