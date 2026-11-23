import { readFileSync } from 'node:fs';
export const size = (p: string): number => readFileSync(p).length;
