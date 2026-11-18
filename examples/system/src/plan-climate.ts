// Stage 2 of the plan: the moisture of every node of the grid, from the water of stage 1. The moisture noise of the
// living terrain is the dry floor; near the sea, the lakes and the rivers it rises toward a wet value, with a reach
// that grows with the width of the river, and far from any water it sinks a little below the noise.
//
// Pure and deterministic: nodes ascending, neighbours in the order of `gridNeighbours`, ties to the lower source;
// arithmetic and Math.sqrt / floor / abs / min / max only, so Node and every browser give the same bytes.

import { gridDirection, gridNeighbours, gridNodeAt } from 'wallhammer-web/gen-plan';
import type { WorldPlan } from './plan.ts';
import { bodyClimate } from './world.ts';

/** Sources of moisture: reach in metres and strength 0–1. */
const SEA = { reachM: 6000, strength: 0.45 };
const LAKE = { reachM: 3000, strength: 0.7 };
/** A river point: reach `clamp(400 + 90 · half-width, 600, 4000)` m; strength 0.9, under 5 m of half-width 0.6. */
const RIVER_STRENGTH = 0.9;
const BROOK_STRENGTH = 0.6;
const BROOK_HALF_WIDTH_M = 5;
/** Beyond these distances from any water (by hops on the grid) the ground dries below its noise. */
const FAR_FROM_M = 12000;
const FAR_TO_M = 45000;
const FAR_DRYING = 0.3;
/** Moisture the near water pulls toward. */
const WET_TARGET = 0.88;
/** Water nodes themselves are never drier than this (in the byte scale). */
const WATER_FLOOR = 200;

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Moisture of every node of the plan's grid, 0–255. Pure: the water sections and the seed decide it. */
export function planMoisture(plan: WorldPlan, packed: number): Uint8Array {
  const g = plan.grid;
  const count = g.count;
  const R = g.radiusM;
  const dir = new Float64Array(3 * count);
  const d: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    gridDirection(g, i, d);
    dir[3 * i] = d[0];
    dir[3 * i + 1] = d[1];
    dir[3 * i + 2] = d[2];
  }

  // The source of each node that holds one: its strength and reach (the strongest, then the farthest reaching).
  const srcStrength = new Float32Array(count);
  const srcReach = new Float32Array(count);
  const water = new Uint8Array(count);
  const offer = (node: number, strength: number, reach: number): void => {
    if (strength > srcStrength[node]! || (strength === srcStrength[node]! && reach > srcReach[node]!)) {
      srcStrength[node] = strength;
      srcReach[node] = reach;
    }
  };
  for (let i = 0; i < count; i++) {
    if (plan.pool[i] !== 0) {
      offer(i, LAKE.strength, LAKE.reachM);
      water[i] = 1;
    } else if (plan.relief[i]! <= 0) {
      offer(i, SEA.strength, SEA.reachM);
      water[i] = 1;
    }
  }
  const L = plan.lines;
  const r0 = L.kindStart[0]!;
  const r1 = L.kindStart[1]!;
  for (let p = L.start[r0]!; p < L.start[r1]!; p++) {
    const hw = L.halfWidth[p]!;
    const node = gridNodeAt(g, L.points[3 * p]!, L.points[3 * p + 1]!, L.points[3 * p + 2]!);
    offer(node, hw < BROOK_HALF_WIDTH_M ? BROOK_STRENGTH : RIVER_STRENGTH, Math.min(4000, Math.max(600, 400 + 90 * hw)));
  }

  // Near: spread from all sources, breadth first, a node taking a source's value when it is larger.
  const near = new Float32Array(count);
  const owner = new Int32Array(count).fill(-1);
  const queue = new Int32Array(count);
  const queued = new Uint8Array(count);
  let head = 0;
  let size = 0;
  const push = (node: number): void => {
    if (queued[node]) return;
    queued[node] = 1;
    queue[(head + size) % count] = node;
    size++;
  };
  // Hops to the nearest source, for `far`.
  const hops = new Int32Array(count).fill(-1);
  const hopQueue = new Int32Array(count);
  let hopEnd = 0;
  for (let i = 0; i < count; i++) {
    if (srcStrength[i]! <= 0) continue;
    near[i] = srcStrength[i]!;
    owner[i] = i;
    push(i);
    hops[i] = 0;
    hopQueue[hopEnd++] = i;
  }
  const nb = new Int32Array(8);
  while (size > 0) {
    const u = queue[head]!;
    head = (head + 1) % count;
    size--;
    queued[u] = 0;
    const s = owner[u]!;
    const sx = dir[3 * s]!, sy = dir[3 * s + 1]!, sz = dir[3 * s + 2]!;
    const strength = srcStrength[s]!;
    const reach = srcReach[s]!;
    const k = gridNeighbours(g, u, nb);
    for (let j = 0; j < k; j++) {
      const v = nb[j]!;
      const dx = dir[3 * v]! - sx, dy = dir[3 * v + 1]! - sy, dz = dir[3 * v + 2]! - sz;
      const chord = Math.sqrt(dx * dx + dy * dy + dz * dz) * R;
      if (chord >= reach) continue;
      // Rounded to the stored precision: a float64 candidate above its own float32 copy would win again for ever.
      const value = Math.fround(strength * (1 - smooth(0, reach, chord)));
      if (value > near[v]! || (value === near[v]! && value > 0 && s < owner[v]!)) {
        near[v] = value;
        owner[v] = s;
        push(v);
      }
    }
  }
  for (let h = 0; h < hopEnd; h++) {
    const u = hopQueue[h]!;
    const k = gridNeighbours(g, u, nb);
    for (let j = 0; j < k; j++) {
      const v = nb[j]!;
      if (hops[v]! >= 0) continue;
      hops[v] = hops[u]! + 1;
      hopQueue[hopEnd++] = v;
    }
  }

  const spacing = Math.sqrt((4 * Math.PI * R * R) / count);
  const wet = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const h = plan.relief[i]! * 0.5;
    const m0 = bodyClimate(packed, dir[3 * i]!, dir[3 * i + 1]!, dir[3 * i + 2]!, h)?.m ?? 0;
    const far = hops[i]! < 0 ? 1 : smooth(FAR_FROM_M, FAR_TO_M, hops[i]! * spacing);
    const floor = m0 * (1 - FAR_DRYING * far);
    const m = Math.min(1, Math.max(0, Math.max(floor, floor + (WET_TARGET - m0) * near[i]!)));
    let b = Math.floor(255 * m + 0.5);
    if (water[i] && b < WATER_FLOOR) b = WATER_FLOOR;
    wet[i] = b;
  }
  return wet;
}
