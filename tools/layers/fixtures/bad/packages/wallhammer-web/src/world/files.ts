// A page module may not import Node's built-ins.
import { readFileSync } from 'node:fs';
export const read = (p: string): string => readFileSync(p, 'utf8');
