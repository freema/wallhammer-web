// Math.random() or Date.now() in a comment does not count; sqrt is exact, so the simulation may use it.
import { add } from '../base/math.ts';
export function step(n: number): number {
  return add(n, Math.floor(Math.sqrt(n)));
}
