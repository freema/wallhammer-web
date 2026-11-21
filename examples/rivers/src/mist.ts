// Mist at the falls: looping particle sources for the engine's `ParticleLayer`, from the plan alone. A fall high enough
// gets a cloud that rises from its foot, and a high one also spray that peels off the sheet on its way down. The
// particles live in the vertex shader of the engine's layer; nothing is simulated here.

import type { ParticleSource } from 'wallhammer-web/render';
import { smooth } from './land.ts';
import type { Plan } from './plan.ts';

/** A fall lower than this has foam at its foot and no mist, metres. */
const MIN_FALL_M = 3;
/** From this height on a fall has all the mist there is, metres. */
const FULL_FALL_M = 26;

/** The mist of every fall of the plan. About 30 particles for the foot of a high fall, 10 more for its sheet. */
export function mistSources(plan: Plan): ParticleSource[] {
  const out: ParticleSource[] = [];
  for (const l of plan.lines)
    for (let i = 0; i + 1 < l.n; i++) {
      if (!l.fall[i]) continue;
      const drop = l.level[i]! - l.level[i + 1]!;
      if (drop < MIN_FALL_M) continue;
      const s = smooth(MIN_FALL_M, FULL_FALL_M, drop);
      const half = l.half[i + 1]!;
      const foot = l.level[i + 1]!;
      // The foot: where the sheet meets the pool, half a stretch below the lip.
      out.push({
        position: [0.65 * l.cx[i + 1]! + 0.35 * l.cx[i]!, foot + 0.4, 0.65 * l.cz[i + 1]! + 0.35 * l.cz[i]!],
        count: Math.round(8 + 22 * s),
        life: 3.2 + 1.6 * s,
        size: [half + 1.5, 2 * half + 4 + 9 * s],
        rise: 0.7 + 1.5 * s,
        spread: [0.9 * half, 0.5 + 0.9 * s],
        gravity: 0.2,
        wind: 0.3,
        colorStart: [0.86, 0.9, 0.93, 0.42 + 0.2 * s],
        colorEnd: [0.9, 0.93, 0.96, 0.1],
      });
      if (drop < 12) continue;
      // The sheet: spray that leaves it a third of the way up and falls with it.
      out.push({
        position: [0.5 * (l.cx[i]! + l.cx[i + 1]!), foot + 0.4 * drop, 0.5 * (l.cz[i]! + l.cz[i + 1]!)],
        count: Math.round(10 * s),
        life: 2.4,
        size: [1.5 + half, 4 + half],
        rise: -2,
        spread: [0.8 * half, 0.5],
        gravity: 2.5,
        wind: 0.2,
        colorStart: [0.88, 0.91, 0.94, 0.3],
        colorEnd: [0.9, 0.93, 0.96, 0.12],
      });
    }
  return out;
}
