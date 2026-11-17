// Scenarios for the golden hashes of choosing places on a sphere grid and plots along lines (gen-plan): `pickSites`,
// `gridSteps`, `gridSlopeAt` and `plotsAlong`. Engine code only. Each returns plain data to hash and throws when a
// property that must hold does not.

import type { Vec3 } from '../../../packages/wallhammer-web/src/base/index.ts';
import { fractalNoise3 } from '../../../packages/wallhammer-web/src/gen-core/index.ts';
import { gridDirection, gridNeighbours, gridSlopeAt, gridSteps, pickSites, plotsAlong, sphereGrid } from '../../../packages/wallhammer-web/src/gen-plan/index.ts';
import type { Plot } from '../../../packages/wallhammer-web/src/gen-plan/index.ts';

const fail = (what: string): never => {
  throw new Error(what);
};

/**
 * `pickSites` on a level-4 grid with a fractal score: descending score, every pair at least the spacing apart, every
 * candidate left out explained (near a better taken node, refused, or past the count), `taken` keeps its spacing and is
 * not returned. `gridSteps` against a brute-force search round a corner of the cube. `gridSlopeAt` on an even rise.
 */
export function sitesScript(): unknown[] {
  const R = 50_000;
  const g = sphereGrid(R, 4);
  const d: Vec3 = [0, 0, 0];
  const e: Vec3 = [0, 0, 0];
  const score = Float32Array.from({ length: g.count }, (_, i) => {
    gridDirection(g, i, d);
    return fractalNoise3(d[0] * R, d[1] * R, d[2] * R, { cellM: 20_000, octaves: 3 }, 719);
  });
  const chord = (a: number, b: number): number => {
    gridDirection(g, a, d);
    gridDirection(g, b, e);
    return Math.hypot(d[0] - e[0], d[1] - e[1], d[2] - e[2]) * R;
  };
  const spacingM = 18_000;
  const minScore = 0.35;
  const refused = new Set<number>();
  const accept = (n: number): boolean => {
    if (n % 11 === 3) {
      refused.add(n);
      return false;
    }
    return true;
  };
  const taken = Uint32Array.of(5, 777);
  const want = 25;
  const picks = pickSites(g, score, { count: want, spacingM, minScore, taken, accept });
  const out: unknown[] = [picks];
  for (let k = 1; k < picks.length; k++) {
    const a = picks[k - 1]!;
    const b = picks[k]!;
    if (score[a]! < score[b]! || (score[a] === score[b] && a > b)) fail(`pickSites: pick ${k} out of order`);
  }
  for (let i = 0; i < picks.length; i++) {
    if (taken.includes(picks[i]!)) fail('pickSites: returned a taken node');
    for (let j = 0; j < i; j++) if (chord(picks[i]!, picks[j]!) < spacingM) fail(`pickSites: picks ${j} and ${i} too near`);
    for (const t of taken) if (chord(picks[i]!, t) < spacingM) fail(`pickSites: pick ${i} too near a taken node`);
  }
  const full = picks.length === want;
  const last = picks[picks.length - 1]!;
  for (let n = 0; n < g.count; n++) {
    if (!(score[n]! >= minScore) || picks.includes(n) || taken.includes(n)) continue;
    const after = full && (score[n]! < score[last]! || (score[n] === score[last] && n > last));
    if (after || refused.has(n)) continue;
    let explained = false;
    for (const t of taken) if (chord(n, t) < spacingM) explained = true;
    for (const p of picks) if ((score[p]! > score[n]! || (score[p] === score[n] && p < n)) && chord(n, p) < spacingM) explained = true;
    if (!explained) fail(`pickSites: candidate ${n} was left out with no reason`);
  }
  // gridSteps against a breadth-first search done the slow way, on the three faces round the corner (+x, +y, +z).
  const marks = new Uint8Array(g.count);
  for (const p of picks) marks[p] = 1;
  const steps = gridSteps(g, marks, 9);
  const nb = new Int32Array(8);
  const brute = new Uint8Array(g.count).fill(9);
  let frontier: number[] = [];
  for (let i = 0; i < g.count; i++) if (marks[i]) ((brute[i] = 0), frontier.push(i));
  for (let s = 1; s <= 9 && frontier.length; s++) {
    const next: number[] = [];
    for (const u of frontier) {
      const k = gridNeighbours(g, u, nb);
      for (let j = 0; j < k; j++) if (brute[nb[j]!] === 9 && !marks[nb[j]!] && s < 9) ((brute[nb[j]!] = s), next.push(nb[j]!));
    }
    frontier = next;
  }
  let checked = 0;
  for (let i = 0; i < g.count; i++) {
    gridDirection(g, i, d);
    if (!(d[0] > 0 && d[1] > 0 && d[2] > 0)) continue;
    checked++;
    if (steps[i] !== brute[i]) fail(`gridSteps: node ${i} has ${steps[i]}, brute force ${brute[i]}`);
  }
  if (checked < 50) fail(`gridSteps: only ${checked} nodes round the corner`);
  // gridSlopeAt on a height rising evenly along one axis: the height is s · (arc from the plane x = 0), so the
  // steepest neighbour step has the slope s within the rounding of the chord against the arc.
  const s = 0.05;
  const rise = Float32Array.from({ length: g.count }, (_, i) => {
    gridDirection(g, i, d);
    return s * R * Math.asin(Math.max(-1, Math.min(1, d[0])));
  });
  const slopes: number[] = [];
  for (let i = 0; i < g.count; i += 13) {
    gridDirection(g, i, d);
    if (Math.abs(d[0]) > 0.5) continue;
    const got = gridSlopeAt(g, rise, 1, i);
    if (got > s * 1.02 + 1e-9) fail(`gridSlopeAt: node ${i} gives ${got}, more than the rise ${s}`);
    slopes.push(got);
  }
  if (Math.max(...slopes) < s * 0.98) fail(`gridSlopeAt: the steepest node gives ${Math.max(...slopes)}, not ${s}`);
  out.push(steps, Float64Array.from(slopes));
  return out;
}

/** Corners of a plot, x z pairs, counter-clockwise or not. */
function corners(p: Plot): number[] {
  const ax = -p.hz;
  const az = p.hx;
  const w = p.widthM / 2;
  const t = p.depthM / 2;
  return [
    p.x + ax * w + p.hx * t, p.z + az * w + p.hz * t,
    p.x - ax * w + p.hx * t, p.z - az * w + p.hz * t,
    p.x - ax * w - p.hx * t, p.z - az * w - p.hz * t,
    p.x + ax * w - p.hx * t, p.z + az * w - p.hz * t,
  ];
}
function pointSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l = dx * dx + dz * dz;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}
function crosses(a: number[], i: number, b: number[], j: number): boolean {
  const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number): number => Math.sign((qx - px) * (rz - pz) - (qz - pz) * (rx - px));
  const [ax, az, bx, bz] = [a[i]!, a[i + 1]!, a[i + 2]!, a[i + 3]!];
  const [cx, cz, dx, dz] = [b[j]!, b[j + 1]!, b[j + 2]!, b[j + 3]!];
  return o(ax, az, bx, bz, cx, cz) * o(ax, az, bx, bz, dx, dz) < 0 && o(cx, cz, dx, dz, ax, az) * o(cx, cz, dx, dz, bx, bz) < 0;
}
function inside(c: number[], x: number, z: number): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const ax = c[2 * k]!;
    const az = c[2 * k + 1]!;
    const bx = c[(2 * k + 2) % 8]!;
    const bz = c[(2 * k + 3) % 8]!;
    const s = Math.sign((bx - ax) * (z - az) - (bz - az) * (x - ax));
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
/** Least distance between a closed polygon `c` (4 corners) and a polyline or polygon `q` (x z pairs). */
function distance(c: number[], q: number[], closed: boolean): number {
  const ring = [...c, c[0]!, c[1]!];
  const path = closed ? [...q, q[0]!, q[1]!] : q;
  for (let i = 0; i + 3 < ring.length; i += 2) for (let j = 0; j + 3 < path.length; j += 2) if (crosses(ring, i, path, j)) return 0;
  for (let j = 0; j + 1 < path.length; j += 2) if (inside(c, path[j]!, path[j + 1]!)) return 0;
  if (closed) for (let i = 0; i + 1 < c.length; i += 2) if (inside(q, c[i]!, c[i + 1]!)) return 0;
  let best = Infinity;
  for (let i = 0; i + 3 < ring.length; i += 2) for (let j = 0; j + 1 < path.length; j += 2) best = Math.min(best, pointSegment(path[j]!, path[j + 1]!, ring[i]!, ring[i + 1]!, ring[i + 2]!, ring[i + 3]!));
  for (let j = 0; j + 3 < path.length; j += 2) for (let i = 0; i + 1 < c.length; i += 2) best = Math.min(best, pointSegment(c[i]!, c[i + 1]!, path[j]!, path[j + 1]!, path[j + 2]!, path[j + 3]!));
  return best;
}

/**
 * `plotsAlong`: a straight line, a bent one, three lines meeting at a node, a blocked disc. No two plots nearer than
 * the gap, every front edge at the setback from its line, no line nearer than the setback, none blocked, unit headings,
 * ids ascending, the same seed twice the same, another seed differs.
 */
export function plotsScript(): unknown[] {
  const lines: number[][] = [
    [0, 0, 120, 0],
    [0, 60, 50, 70, 90, 110, 100, 160],
    [200, 50, 260, 50],
    [200, 50, 170, 110],
    [200, 50, 230, -10],
  ];
  const disc = { x: 60, z: -18, r: 12 };
  const blocked = (x: number, z: number): boolean => Math.hypot(x - disc.x, z - disc.z) < disc.r;
  const o = { frontM: [8, 16] as const, depthM: [10, 22] as const, setbackM: 6, gapM: 3, seed: 7190, blocked };
  const plots = plotsAlong(lines, o);
  if (plots.length < 20) fail(`plotsAlong: only ${plots.length} plots`);
  const cs = plots.map(corners);
  plots.forEach((p, i) => {
    if (p.id !== i) fail(`plotsAlong: id ${p.id} at ${i}`);
    if (Math.abs(Math.hypot(p.hx, p.hz) - 1) > 1e-9) fail(`plotsAlong: plot ${i} heading not unit`);
    const c = cs[i]!;
    if (blocked(p.x, p.z) || [0, 2, 4, 6].some((k) => blocked(c[k]!, c[k + 1]!))) fail(`plotsAlong: plot ${i} is blocked`);
    // Middle of the front edge, at the setback from its own line.
    const fx = p.x + p.hx * (p.depthM / 2);
    const fz = p.z + p.hz * (p.depthM / 2);
    const own = lines[p.line]!;
    let near = Infinity;
    for (let k = 0; k + 3 < own.length; k += 2) near = Math.min(near, pointSegment(fx, fz, own[k]!, own[k + 1]!, own[k + 2]!, own[k + 3]!));
    if (Math.abs(near - o.setbackM) > 1e-3) fail(`plotsAlong: plot ${i} front edge is ${near} m from its line`);
    for (const l of lines) if (distance(c, l, false) < o.setbackM - 1e-3) fail(`plotsAlong: a line passes ${distance(c, l, false)} m from plot ${i}`);
    for (let j = 0; j < i; j++) if (distance(c, cs[j]!, true) < o.gapM - 1e-6) fail(`plotsAlong: plots ${j} and ${i} are ${distance(c, cs[j]!, true)} m apart`);
  });
  const again = plotsAlong(lines, o);
  if (JSON.stringify(again) !== JSON.stringify(plots)) fail('plotsAlong: the same seed gave another result');
  const other = plotsAlong(lines, { ...o, seed: 7191 });
  if (JSON.stringify(other) === JSON.stringify(plots)) fail('plotsAlong: another seed gave the same result');
  return [Float64Array.from(plots.flatMap((p) => [p.id, p.x, p.z, p.hx, p.hz, p.widthM, p.depthM, p.line]))];
}
