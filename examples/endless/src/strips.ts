// Strips of the endless world (strip=1): one line 6 km long from near the default start, which forks at its far end
// into two shorter lines, drawn with the engine's strip tools on the plane.
//   - `endlessStrips(seed)`: the net, a pure function of the seed (arithmetic and Math.sqrt only, stream 0x57a1),
//   - `generateStripCell(seed, cell)`: `generateSmoothCell` with the ground cut and filled under the strips, no objects
//     on the shoulders, and a second mesh of material 'strip'.

import { flatStripSurface, hashInts, stripCarve, stripNearest, stripNet, stripTouches, unit } from 'wallhammer-web/gen-core';
import type { CellContent, CellId, StripHit, StripLine, StripNet, StripProfile, StripSurface } from 'wallhammer-web/gen-core';
import { stripMesh } from 'wallhammer-web/gen-mesh';
import { QUADS, ROOT_LEVEL, SHAPE, buildSmoothCell, groundHeight, surfaceColor } from './terrain.ts';

/** Domain version of the cells with strips (the smooth generator has 1). */
export const STRIP_DOMAIN_VERSION = 2;
/** Half-widths of the main line and the two lines from its node, in metres. */
export const STRIP_HALF_WIDTHS = [8, 5, 5] as const;
/** Lengths of the main line and the two lines from its node, in metres. */
export const STRIP_LENGTHS = [6000, 2000, 1500] as const;
export const STRIP_PROFILE: StripProfile = { section: [-1.25, -1.2, -1, 0, 0, 0.25, 1, 0, 1.25, -1.2], shoulderM: 14, bedM: 0.3 };
/** Metres between points of a line; largest lateral offset and the distance between its knots. */
const STEP_M = 100;
const OFFSET_M = 120;
const KNOT_M = 1500;
/** The grade: never under this height (metres above the water), never further than this from the ground. */
const MIN_GRADE_M = 1.5;
const MAX_CUT_M = 6;
const SMOOTH_POINTS = 6;
const SMOOTH_PASSES = 2;
/** Where the main line starts: near the default start (0, 0) of the page. */
const START: readonly [number, number] = [40, 30];
const STREAM = 0x57a1;

const smoothstep = (t: number): number => {
  const s = Math.min(1, Math.max(0, t));
  return s * s * (3 - 2 * s);
};

/** A lateral offset along a line: smoothstep between knots, values from the stream, 0 at the start. */
function offsetOf(seed: number, key: number, amp: number, s: number): number {
  const f = s / KNOT_M;
  const k = Math.floor(f);
  const knot = (n: number): number => (n <= 0 ? 0 : (2 * unit(hashInts(seed, STREAM, key, 7, n)) - 1) * amp);
  const a = knot(k);
  return a + (knot(k + 1) - a) * smoothstep(f - k);
}

/** Points of a line from (x0, z0) along the unit heading (hx, hz), `length` metres. */
function linePoints(seed: number, key: number, x0: number, z0: number, hx: number, hz: number, length: number, amp: number): number[] {
  const out: number[] = [];
  const n = Math.round(length / STEP_M);
  for (let k = 0; k <= n; k++) {
    const s = k * STEP_M;
    const o = offsetOf(seed, key, amp, s);
    // Right of the heading is (−hz, hx) with up +y and across = tangent × up.
    out.push(x0 + hx * s - hz * o, 0, z0 + hz * s + hx * o);
  }
  return out;
}

function gradeOf(seed: number, points: readonly number[], startM: number | null): number[] {
  const ground: number[] = [];
  for (let k = 0; k < points.length; k += 3) ground.push(groundHeight(seed, points[k]!, points[k + 2]!));
  let h = ground.map((g) => Math.max(MIN_GRADE_M, g));
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next: number[] = [];
    for (let n = 0; n < h.length; n++) {
      let sum = 0;
      let count = 0;
      for (let m = Math.max(0, n - SMOOTH_POINTS); m <= Math.min(h.length - 1, n + SMOOTH_POINTS); m++) (sum += h[m]!, count++);
      next.push(sum / count);
    }
    h = next;
  }
  return h.map((v, n) => {
    const s = startM === null ? v : startM + (v - startM) * smoothstep((n * STEP_M) / 500);
    const g = ground[n]!;
    return Math.max(MIN_GRADE_M, Math.min(g + MAX_CUT_M, Math.max(g - MAX_CUT_M, s)));
  });
}

const netCache = new Map<number, StripNet>();

/** The strips of a seed: a line 6 km long, its far end a node from which lines of 2 and 1.5 km leave. */
export function endlessStrips(seed: number): StripNet {
  const cached = netCache.get(seed);
  if (cached) return cached;
  const r = (q: number): number => unit(hashInts(seed, STREAM, 0xe0d, q));
  // A heading from the stream, normalised with arithmetic only.
  const ax = 2 * r(1) - 1;
  const az = 2 * r(2) - 1;
  const al = Math.sqrt(ax * ax + az * az) || 1;
  const hx = ax / al;
  const hz = az / al;
  const main = linePoints(seed, 0, START[0], START[1], hx, hz, STRIP_LENGTHS[0], OFFSET_M);
  const mainGrade = gradeOf(seed, main, null);
  const n = main.length;
  const node: [number, number, number] = [main[n - 3]!, 0, main[n - 1]!];
  const nodeHeight = mainGrade[mainGrade.length - 1]!;
  // The heading at the end, and the two lines 20°–35° to each side of it (tangents 0.364–0.700).
  const dx = main[n - 3]! - main[n - 6]!;
  const dz = main[n - 1]! - main[n - 4]!;
  const dl = Math.sqrt(dx * dx + dz * dz);
  const ex = dx / dl;
  const ez = dz / dl;
  const lines: StripLine[] = [{ points: main, heights: mainGrade, halfWidths: STRIP_HALF_WIDTHS[0], profile: 0, to: 0 }];
  for (let b = 0; b < 2; b++) {
    const t = (0.36397023426620234 + (0.7002075382097097 - 0.36397023426620234) * r(3 + b)) * (b === 0 ? 1 : -1);
    // Turned toward the right (−ez, ex) by the tangent t.
    const bx = ex - ez * t;
    const bz = ez + ex * t;
    const bl = Math.sqrt(bx * bx + bz * bz);
    const points = linePoints(seed, 0x100 + b, node[0], node[2], bx / bl, bz / bl, STRIP_LENGTHS[b + 1]!, 40);
    lines.push({ points, heights: gradeOf(seed, points, nodeHeight), halfWidths: STRIP_HALF_WIDTHS[b + 1]!, profile: 0, from: 0 });
  }
  const net = stripNet({ radiusM: 0, profiles: [STRIP_PROFILE], nodes: [{ point: node, heightM: nodeHeight }], lines });
  netCache.set(seed, net);
  return net;
}

/** The ground height with the strips: cut and filled, never under the water. */
export function stripSurfaceHeight(seed: number, x: number, z: number): number {
  return Math.max(0, stripCarve(endlessStrips(seed), x, 0, z, groundHeight(seed, x, z)));
}

/** The surface the strip mesh stands on: the plane of the cells, drawn over the carved ground. */
export function endlessStripSurface(seed: number): StripSurface {
  return flatStripSurface({ shape: SHAPE, quads: QUADS, heightAt: (x, z) => stripSurfaceHeight(seed, x, z) });
}

/** Lift of the strip above the drawn surface of a level, from the level's vertex spacing. */
export function stripLiftM(surface: StripSurface, level: number): number {
  return 0.05 + 0.08 * surface.spacingM(level);
}

const BARE: readonly [number, number, number] = [134, 118, 96];

/** Generates one smooth cell with the strips. Pure: (seed, cell) → content. */
export function generateStripCell(seed: number, cell: CellId): CellContent {
  const net = endlessStrips(seed);
  const size = SHAPE.edgeM(cell.level);
  const o = SHAPE.origin(cell);
  // A cell no line reaches is the smooth cell under the domain version of the strips.
  if (!stripTouches(net, o[0] + size / 2, 0, o[2] + size / 2, size * 0.7072)) return buildSmoothCell(seed, cell, { domainVersion: STRIP_DOMAIN_VERSION });
  const hit: StripHit = { line: 0, alongM: 0, acrossM: 0, halfWidthM: 0, gradeM: 0, share: 0 };
  const memo = new Map<string, number>();
  const carved = (x: number, z: number): number => {
    const key = `${x},${z}`;
    let h = memo.get(key);
    if (h === undefined) memo.set(key, (h = stripSurfaceHeight(seed, x, z)));
    return h;
  };
  const surface = flatStripSurface({ shape: SHAPE, quads: QUADS, heightAt: carved });
  return buildSmoothCell(seed, cell, {
    domainVersion: STRIP_DOMAIN_VERSION,
    heightAt: carved,
    colorAt: (x, z, y) => {
      const col = surfaceColor(seed, x, z, y);
      if (!stripNearest(net, x, 0, z, hit) || y <= 0) return col;
      // Over filled water the bank is bare ground.
      const base = col[3] === 255 ? BARE : col;
      const k = hit.share;
      return [Math.round(base[0] + (BARE[0] - base[0]) * k), Math.round(base[1] + (BARE[1] - base[1]) * k), Math.round(base[2] + (BARE[2] - base[2]) * k), 0];
    },
    keepObject: (x, z) => !stripNearest(net, x, 0, z, hit),
    extra: () => {
      const m = stripMesh(net, surface, cell, { coarsestLevel: ROOT_LEVEL, liftM: (level) => stripLiftM(surface, level) });
      return m ? [{ material: 'strip', mesh: m.mesh, bounds: m.bounds }] : [];
    },
  });
}
