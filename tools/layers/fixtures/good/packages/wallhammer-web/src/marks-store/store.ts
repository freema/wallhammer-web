// A Node-only module may import Node's built-ins and lower layers.
import { readFileSync } from 'node:fs';
import { add } from '../base/math.ts';
export const size = (p: string): number => add(readFileSync(p).length, 0);
