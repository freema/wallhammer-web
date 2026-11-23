// Nothing in the engine imports the Node-only module.
import { size } from '../marks-store/store.ts';
export const twice = (p: string): number => 2 * size(p);
