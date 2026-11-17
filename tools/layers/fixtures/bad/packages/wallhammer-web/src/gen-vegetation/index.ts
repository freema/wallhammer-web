// Known bad: a content module imports another content module.
import { B } from '../gen-ground/index.ts';
export const C = B;
