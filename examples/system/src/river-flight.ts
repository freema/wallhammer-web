// The flight along the longest river of Hearth (key R): its path is a pure function of the plan. No DOM, no worker,
// no clock; arithmetic and Math.sqrt only.
//   - `mainStem(plan)`: from the sea mouth with the longest way upstream, at every confluence the wider inflow (tie:
//     the lower line index), through its lakes along the line (a river is one chain from spring to sea); ordered
//     spring to mouth.
//   - `riverFlightPose(stem, t01)`: from 250 km above the spring down to 150 m above it (the first third), then
//     downstream 120 m above the water, looking ahead, to 1 km past the mouth.

import { LINE_KIND } from './plan.ts';
import type { WorldPlan } from './plan.ts';

/** The path of the flight: unit directions and water levels, spring to mouth. */
export interface RiverStem {
  radiusM: number;
  /** x y z per point, unit. */
  points: Float64Array;
  /** Water level per point, metres above the base sphere. */
  levels: Float64Array;
  /** Metres along the path per point. */
  along: Float64Array;
  lengthM: number;
  /** The plan lines of the path, spring to mouth. */
  lines: Uint32Array;
}

/** A pose of the flight in the body's own frame: the eye in metres from the centre and a point it looks at. */
export interface RiverFlightPose {
  eye: [number, number, number];
  target: [number, number, number];
}

const START_M = 250_000;
const SPRING_M = 150;
const ALONG_M = 120;
const PAST_MOUTH_M = 1000;
const AHEAD_M = 600;

/** The main stem of the river system with the longest way upstream from the sea. */
export function mainStem(plan: WorldPlan): RiverStem {
  const L = plan.lines;
  const R = plan.grid.radiusM;
  const first = L.kindStart[LINE_KIND.river]!;
  const end = L.kindStart[LINE_KIND.river + 1]!;
  const lenOf = (l: number): number => {
    let s = 0;
    for (let k = L.start[l]!; k + 1 < L.start[l + 1]!; k++) {
      const dx = L.points[3 * k + 3]! - L.points[3 * k]!;
      const dy = L.points[3 * k + 4]! - L.points[3 * k + 1]!;
      const dz = L.points[3 * k + 5]! - L.points[3 * k + 2]!;
      s += Math.sqrt(dx * dx + dy * dy + dz * dz) * R;
    }
    return s;
  };
  // Inflows of a node, ascending. A river runs through its lakes as one chain, so a line ends only at a node or in
  // the sea and starts only at a node or a spring.
  const into = new Map<number, number[]>();
  for (let l = first; l < end; l++) {
    const t = L.to[l]!;
    if (t >= 0) {
      if (!into.has(t)) into.set(t, []);
      into.get(t)!.push(l);
    }
  }
  const endWidth = (l: number): number => L.halfWidth[L.start[l + 1]! - 1]!;
  /** The line upstream of `l` the stem follows, or −1 at a spring. */
  const upOf = (l: number): number => {
    const f = L.from[l]!;
    const choices = f >= 0 ? into.get(f) : undefined;
    if (!choices || choices.length === 0) return -1;
    let best = -1;
    for (const c of choices) if (c !== l && (best < 0 || endWidth(c) > endWidth(best))) best = c;
    return best;
  };
  // Way upstream along the stem from every line, memoised; a guard against a loop through lakes.
  const way = new Float64Array(L.from.length).fill(-1);
  const wayOf = (l0: number): number => {
    const chain: number[] = [];
    const seen = new Set<number>();
    let l = l0;
    while (l >= 0 && way[l]! < 0 && !seen.has(l)) {
      seen.add(l);
      chain.push(l);
      l = upOf(l);
    }
    let acc = l >= 0 && way[l]! >= 0 ? way[l]! : 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      acc += lenOf(chain[i]!);
      way[chain[i]!] = acc;
    }
    return way[l0]!;
  };
  let mouth = -1;
  let longest = -1;
  for (let l = first; l < end; l++) {
    if (L.to[l] !== -1) continue;
    const w = wayOf(l);
    if (w > longest) {
      longest = w;
      mouth = l;
    }
  }
  const lines: number[] = [];
  const seen = new Set<number>();
  for (let l = mouth; l >= 0 && !seen.has(l); l = upOf(l)) {
    seen.add(l);
    lines.push(l);
  }
  lines.reverse();
  const pts: number[] = [];
  const lev: number[] = [];
  for (const l of lines) {
    for (let k = L.start[l]!; k < L.start[l + 1]!; k++) {
      const n = pts.length;
      if (n >= 3 && pts[n - 3] === L.points[3 * k] && pts[n - 2] === L.points[3 * k + 1] && pts[n - 1] === L.points[3 * k + 2]) continue;
      pts.push(L.points[3 * k]!, L.points[3 * k + 1]!, L.points[3 * k + 2]!);
      lev.push(Math.max(0, L.grade[k]!));
    }
  }
  const count = pts.length / 3;
  const along = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const dx = pts[3 * i]! - pts[3 * i - 3]!;
    const dy = pts[3 * i + 1]! - pts[3 * i - 2]!;
    const dz = pts[3 * i + 2]! - pts[3 * i - 1]!;
    along[i] = along[i - 1]! + Math.sqrt(dx * dx + dy * dy + dz * dz) * R;
  }
  return { radiusM: R, points: Float64Array.from(pts), levels: Float64Array.from(lev), along, lengthM: count > 0 ? along[count - 1]! : 0, lines: Uint32Array.from(lines) };
}

/** Point of the stem at `s` metres along it (past the mouth: on along the last segment), unit, and its water level. */
function stemAt(stem: RiverStem, s: number): { d: [number, number, number]; level: number } {
  const n = stem.levels.length;
  const P = stem.points;
  if (n === 0) return { d: [0, 1, 0], level: 0 };
  if (n === 1) return { d: [P[0]!, P[1]!, P[2]!], level: stem.levels[0]! };
  let i = 0;
  if (s >= stem.lengthM) i = n - 2;
  else {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (stem.along[mid]! <= s) lo = mid;
      else hi = mid;
    }
    i = lo;
  }
  const seg = stem.along[i + 1]! - stem.along[i]!;
  const t = seg > 0 ? Math.max(0, (s - stem.along[i]!) / seg) : 0;
  const x = P[3 * i]! + (P[3 * i + 3]! - P[3 * i]!) * t;
  const y = P[3 * i + 1]! + (P[3 * i + 4]! - P[3 * i + 1]!) * t;
  const z = P[3 * i + 2]! + (P[3 * i + 5]! - P[3 * i + 2]!) * t;
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  const level = s >= stem.lengthM ? 0 : stem.levels[i]! + (stem.levels[i + 1]! - stem.levels[i]!) * Math.min(1, t);
  return { d: [x / l, y / l, z / l], level };
}

/** The pose of the flight at `t01` (0 high above the spring, 1 a kilometre past the mouth). */
export function riverFlightPose(stem: RiverStem, t01: number): RiverFlightPose {
  const t = Math.min(1, Math.max(0, t01));
  const R = stem.radiusM;
  const at = (d: readonly number[], h: number): [number, number, number] => [d[0]! * (R + h), d[1]! * (R + h), d[2]! * (R + h)];
  const spring = stemAt(stem, 0);
  const ahead0 = stemAt(stem, AHEAD_M);
  if (t < 1 / 3) {
    // Down from high above: fast at first, slow near the ground; the view turns from straight down to downstream.
    const u = t * 3;
    const k = (1 - u) * (1 - u) * (1 - u) * (1 - u);
    const h = spring.level + SPRING_M + (START_M - SPRING_M) * k;
    const eye = at(spring.d, h);
    const down = at(spring.d, spring.level);
    const ahead = at(ahead0.d, ahead0.level);
    const w = u * u * (3 - 2 * u);
    return { eye, target: [down[0] + (ahead[0] - down[0]) * w, down[1] + (ahead[1] - down[1]) * w, down[2] + (ahead[2] - down[2]) * w] };
  }
  const u = (t - 1 / 3) * 1.5;
  const s = u * (stem.lengthM + PAST_MOUTH_M);
  const here = stemAt(stem, s);
  // The first metres blend the height at the end of the descent into the height over the water.
  const h = here.level + ALONG_M + (SPRING_M - ALONG_M) * Math.max(0, 1 - s / 2000);
  const front = stemAt(stem, s + AHEAD_M);
  return { eye: at(here.d, h), target: at(front.d, front.level) };
}
