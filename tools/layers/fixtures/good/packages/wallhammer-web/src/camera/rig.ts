import { add } from '../base/math.ts';
export const rig = { window: add(1, 1), document: 2 };
export function rigTotal(r: typeof rig): number {
  return r.window + r.document;
}
