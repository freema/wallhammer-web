// Strips of the planet example: one line 50 km long laid over an edge of the cube, which forks at its far end into two
// shorter lines, drawn with the engine's strip tools (gen-core/strip.ts, strip-surface.ts, gen-mesh/strip-mesh.ts).
//   - `planetStrips(seed)`: the net, a pure function of the seed (arithmetic and Math.sqrt only, stream 0x57a1),
//   - `generatePlanetStripCell(seed, cell)`: `generatePlanetCell` with the ground cut and filled under the strips, no
//     objects and no cover on the shoulders, and a second mesh of material 'strip'.

import { cubeDirection, cubeGrid, hashInts, sphereStripSurface, stripCarve, stripNearest, stripNet, stripTouches, unit } from 'wallhammer-web/gen-core';
import type { CellContent, CellId, SpherePatchOptions, StripHit, StripLine, StripNet, StripProfile, StripSurface } from 'wallhammer-web/gen-core';
import { stripMesh } from 'wallhammer-web/gen-mesh';
import { QUADS, RADIUS_M, ROOT_LEVEL, buildPlanetCell, findStart, groundHeight, surfaceColor, surfaceCover } from './world.ts';

/** Domain version of the cells with strips (the plain generator has 1). */
export const STRIP_DOMAIN_VERSION = 2;
/** Half-widths of the main line and the two lines from its node, in metres. */
export const STRIP_HALF_WIDTHS = [9, 6, 4.5] as const;
/** Length of the main line and of the two lines from its node, in metres. */
export const STRIP_LENGTHS = [50_000, 6000, 4000] as const;
/** The one profile of the net: a section with a camber and hems, the shoulder and the bed. */
export const STRIP_PROFILE: StripProfile = { section: [-1.25, -1.2, -1, 0, 0, 0.25, 1, 0, 1.25, -1.2], shoulderM: 14, bedM: 0.3 };
/** Metres between points of a line. */
const STEP_M = 250;
/** Largest lateral offset of the main line and of the lines from the node, metres; knots of the offset every so many metres. */
const OFFSET_M = 150;
const BRANCH_OFFSET_M = 60;
const KNOT_M = 5000;
/** The grade: never under this height (metres above the sea), never further than this from the ground. */
const MIN_GRADE_M = 4;
const MAX_CUT_M = 6;
/** Half the window of the moving mean that smooths the ground into the grade, in points; passes of it. */
const SMOOTH_POINTS = 8;
const SMOOTH_PASSES = 2;
/** Tangents of the bounds of the heading to the edge (50°, 70°) and of each line from the node to the main line (20°, 35°). */
const TAN_50 = 1.19175359259421;
const TAN_70 = 2.7474774194546216;
const TAN_20 = 0.36397023426620234;
const TAN_35 = 0.7002075382097097;
/** Candidates of the main line, the share of its points that must stand on land, the highest ground allowed. */
const CANDIDATES = 64;
const LAND_SHARE = 0.8;
const LAND_M = 2;
const HIGHEST_M = 1800;
const STREAM = 0x57a1;

type V3 = [number, number, number];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const norm = (a: readonly number[]): V3 => {
  const l = Math.sqrt(dot(a, a));
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};
/** tan(x) for |x| ≤ 0.3 from its series (error under 1e-8): the arithmetic way from an arc length to a gnomonic step. */
const tanOf = (x: number): number => {
  const x2 = x * x;
  return x * (1 + x2 * (1 / 3 + x2 * (2 / 15 + x2 * (17 / 315 + x2 * (62 / 2835 + x2 * (1382 / 155925))))));
};
const smoothstep = (t: number): number => {
  const s = Math.min(1, Math.max(0, t));
  return s * s * (3 - 2 * s);
};

/** The 12 edges of the cube: the two axes where the face coordinates are at ±1, their signs, and the axis along the edge. */
const EDGES: readonly { i: number; si: number; j: number; sj: number; k: number }[] = (() => {
  const out: { i: number; si: number; j: number; sj: number; k: number }[] = [];
  for (const [i, j, k] of [[0, 1, 2], [0, 2, 1], [1, 2, 0]] as const) for (const si of [1, -1]) for (const sj of [1, -1]) out.push({ i, si, j, sj, k });
  return out;
})();

/** A lateral offset along a line: smoothstep between knots `KNOT_M` apart, values from the stream, at most `amp` metres. */
function offsetOf(seed: number, key: number, amp: number, s: number, firstZero: boolean): number {
  const f = s / KNOT_M;
  const k = Math.floor(f);
  const knot = (n: number): number => (firstZero && n <= 0 ? 0 : (2 * unit(hashInts(seed, STREAM, key, 7, n + 64)) - 1) * amp);
  const a = knot(k);
  return a + (knot(k + 1) - a) * smoothstep(f - k);
}

/** Points of a line from `start` with heading `heading` (unit, tangent at start), `count` points `STEP_M` apart from `s0`. */
function linePoints(seed: number, key: number, start: V3, heading: V3, s0: number, count: number, amp: number, firstZero: boolean): number[] {
  const side = cross(start, heading);
  const out: number[] = [];
  for (let n = 0; n < count; n++) {
    const s = s0 + n * STEP_M;
    const g = tanOf(s / RADIUS_M);
    const o = offsetOf(seed, key, amp, s - s0, firstZero) / RADIUS_M;
    const d = norm([start[0] + heading[0] * g + side[0] * o, start[1] + heading[1] * g + side[1] * o, start[2] + heading[2] * g + side[2] * o]);
    out.push(d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M);
  }
  return out;
}

/** Ground under each point of a line. */
function groundOf(seed: number, points: readonly number[]): number[] {
  const out: number[] = [];
  for (let n = 0; n < points.length; n += 3) out.push(groundHeight(seed, points[n]!, points[n + 1]!, points[n + 2]!));
  return out;
}

/** The grade from the ground: lifted out of the sea, smoothed along the line, then held within `MAX_CUT_M` of it. */
function gradeOf(ground: readonly number[], startM: number | null): number[] {
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
    // A line from the node starts at the node's height and reaches its own grade over the first kilometre.
    const w = startM === null ? 1 : smoothstep((n * STEP_M) / 1000);
    const s = startM === null ? v : startM + (v - startM) * w;
    const g = ground[n]!;
    return Math.max(MIN_GRADE_M, Math.min(g + MAX_CUT_M, Math.max(g - MAX_CUT_M, s)));
  });
}

/** The candidate `k` of the main line: a point on an edge of the cube and a heading 50°–70° to it. */
function candidate(seed: number, k: number, order: readonly number[]): { points: number[]; heading: V3 } {
  const e = EDGES[order[k % order.length]!]!;
  const r = (q: number): number => unit(hashInts(seed, STREAM, k, q));
  const c: V3 = [0, 0, 0];
  c[e.i] = e.si;
  c[e.j] = e.sj;
  // Away from the corners of the cube: lines through a corner are not drawn.
  c[e.k] = 0.6 * r(1) - 0.3;
  const p = norm(c);
  const axis: V3 = [0, 0, 0];
  axis[e.k] = 1;
  const pk = dot(axis, p);
  const along = norm([axis[0] - pk * p[0], axis[1] - pk * p[1], axis[2] - pk * p[2]]);
  const across = cross(p, along);
  const t = TAN_50 + (TAN_70 - TAN_50) * r(2);
  const sa = r(3) < 0.5 ? 1 : -1;
  const sc = r(4) < 0.5 ? 1 : -1;
  const heading = norm([along[0] * sa + across[0] * sc * t, along[1] * sa + across[1] * sc * t, along[2] * sa + across[2] * sc * t]);
  const half = STRIP_LENGTHS[0] / 2;
  return { points: linePoints(seed, k, p, heading, -half, Math.round(STRIP_LENGTHS[0] / STEP_M) + 1, OFFSET_M, false), heading };
}

/** Unit tangent of a line at its last point, along the line. */
function endHeading(points: readonly number[]): { at: V3; heading: V3 } {
  const n = points.length;
  const at = norm([points[n - 3]!, points[n - 2]!, points[n - 1]!]);
  const d = [points[n - 3]! - points[n - 6]!, points[n - 2]! - points[n - 5]!, points[n - 1]! - points[n - 4]!];
  const k = dot(d, at);
  return { at, heading: norm([d[0]! - k * at[0], d[1]! - k * at[1], d[2]! - k * at[2]]) };
}

const netCache = new Map<number, StripNet>();
/** Which candidate the main line of a seed is (for the README and the checks); -1 before `planetStrips` ran. */
const chosen = new Map<number, number>();

/**
 * The strips of a seed. The main line is the first of 64 candidates (edges ordered from the one nearest to the start
 * place) with land under 80 % of its points and no ground above 1800 m, else the first candidate; its far end is a node
 * from which two lines leave, 6 and 4 km long, 40°–70° apart.
 */
export function planetStrips(seed: number): StripNet {
  const cached = netCache.get(seed);
  if (cached) return cached;
  // The start place is a direction 8 km from `findStart`'s point: near enough to choose the nearest edge.
  const near = norm(findStart(seed).toward);
  // Nearer edges first (a larger sum of the two signed coordinates), ties by index.
  const score = EDGES.map((e) => e.si * near[e.i]! + e.sj * near[e.j]!);
  const order = EDGES.map((_, n) => n).sort((a, b) => (score[a]! > score[b]! ? -1 : score[a]! < score[b]! ? 1 : a - b));
  let pick = 0;
  let main = candidate(seed, 0, order);
  let mainGround = groundOf(seed, main.points);
  for (let k = 0; k < CANDIDATES; k++) {
    const c = k === 0 ? main : candidate(seed, k, order);
    const g = k === 0 ? mainGround : groundOf(seed, c.points);
    let land = 0;
    let high = false;
    for (const v of g) (land += v > LAND_M ? 1 : 0), (high ||= v > HIGHEST_M);
    if (!high && land >= LAND_SHARE * g.length) {
      pick = k;
      main = c;
      mainGround = g;
      break;
    }
  }
  chosen.set(seed, pick);
  const mainGrade = gradeOf(mainGround, null);
  const end = endHeading(main.points);
  const nodeHeight = mainGrade[mainGrade.length - 1]!;
  const side = cross(end.at, end.heading);
  const r = (q: number): number => unit(hashInts(seed, STREAM, 0x40de, q));
  const lines: StripLine[] = [{ points: main.points, heights: mainGrade, halfWidths: STRIP_HALF_WIDTHS[0], profile: 0, to: 0 }];
  for (let b = 0; b < 2; b++) {
    // One line to each side of the main line's direction, each 20°–35° from it.
    const t = (TAN_20 + (TAN_35 - TAN_20) * r(b)) * (b === 0 ? 1 : -1);
    const heading = norm([end.heading[0] + side[0] * t, end.heading[1] + side[1] * t, end.heading[2] + side[2] * t]);
    const points = linePoints(seed, 0x100 + b, end.at, heading, 0, Math.round(STRIP_LENGTHS[b + 1]! / STEP_M) + 1, BRANCH_OFFSET_M, true);
    lines.push({ points, heights: gradeOf(groundOf(seed, points), nodeHeight), halfWidths: STRIP_HALF_WIDTHS[b + 1]!, profile: 0, from: 0 });
  }
  const p = main.points;
  const net = stripNet({ radiusM: RADIUS_M, profiles: [STRIP_PROFILE], nodes: [{ point: [p[p.length - 3]!, p[p.length - 2]!, p[p.length - 1]!], heightM: nodeHeight }], lines });
  netCache.set(seed, net);
  return net;
}

/** The candidate the main line of a seed was taken from. */
export function planetStripCandidate(seed: number): number {
  planetStrips(seed);
  return chosen.get(seed) ?? 0;
}

/** Lift of the strip above the drawn surface of a level, from the level's vertex spacing. */
export function stripLiftM(surface: StripSurface, level: number): number {
  return 0.05 + 0.08 * surface.spacingM(level);
}

/** Colour the shoulders are tinted toward: bare ground. */
const BARE: readonly [number, number, number] = [134, 118, 96];

/** The ground height with the strips: cut and filled, never under the sea. */
export function stripGroundHeight(seed: number, x: number, y: number, z: number): number {
  return Math.max(0, stripCarve(planetStrips(seed), x, y, z, groundHeight(seed, x, y, z)));
}

/** The surface the strip mesh stands on: the sphere of the cells, drawn over the carved ground. */
export function planetStripSurface(seed: number): StripSurface {
  return sphereStripSurface({ radiusM: RADIUS_M, quads: QUADS, heightAt: (x, y, z) => stripGroundHeight(seed, x, y, z) });
}

/** Centre of a cell on the base sphere and the distance from it to its farthest corner. */
function cellReach(cell: CellId): { c: V3; r: number } {
  const n = 2 ** cell.level;
  const m = cubeDirection(cell.face, cubeGrid(2 * cell.x + 1, 2 * n), cubeGrid(2 * cell.y + 1, 2 * n));
  let r = 0;
  for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    const d = cubeDirection(cell.face, cubeGrid(cell.x + i, n), cubeGrid(cell.y + j, n));
    const dx = d[0] - m[0];
    const dy = d[1] - m[1];
    const dz = d[2] - m[2];
    r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz) * RADIUS_M);
  }
  return { c: [m[0] * RADIUS_M, m[1] * RADIUS_M, m[2] * RADIUS_M], r };
}

/** Generates one cell with the strips. Pure: (seed, cell) → content. */
export function generatePlanetStripCell(seed: number, cell: CellId): CellContent {
  const net = planetStrips(seed);
  const { c, r } = cellReach(cell);
  // A cell no line reaches is the plain cell under the domain version of the strips.
  if (!stripTouches(net, c[0], c[1], c[2], r)) return buildPlanetCell(seed, cell, { domainVersion: STRIP_DOMAIN_VERSION });
  const hit: StripHit = { line: 0, alongM: 0, acrossM: 0, halfWidthM: 0, gradeM: 0, share: 0 };
  // Heights of the carved ground by point: the mesher asks for the same grid vertices again and again.
  const memo = new Map<string, number>();
  const carved = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    let h = memo.get(key);
    if (h === undefined) memo.set(key, (h = stripGroundHeight(seed, x, y, z)));
    return h;
  };
  // Share of the strips at a grid vertex (0 = none): the cover asks for the vertex the colour asked for just before.
  let lastX = NaN;
  let lastY = NaN;
  let lastZ = NaN;
  let lastK = 0;
  const shareAt = (x: number, y: number, z: number): number => {
    if (x !== lastX || y !== lastY || z !== lastZ) {
      lastK = stripNearest(net, x, y, z, hit) ? hit.share : 0;
      lastX = x;
      lastY = y;
      lastZ = z;
    }
    return lastK;
  };
  const surface = sphereStripSurface({ radiusM: RADIUS_M, quads: QUADS, heightAt: carved });
  return buildPlanetCell(seed, cell, {
    domainVersion: STRIP_DOMAIN_VERSION,
    patch: (o: SpherePatchOptions): SpherePatchOptions => ({
      ...o,
      heightAt: carved,
      colorAt: (x, y, z, h) => {
        const col = surfaceColor(seed, x, y, z, h);
        if (col[3] === 255) return col;
        const k = shareAt(x, y, z);
        if (k === 0) return col;
        return [Math.round(col[0] + (BARE[0] - col[0]) * k), Math.round(col[1] + (BARE[1] - col[1]) * k), Math.round(col[2] + (BARE[2] - col[2]) * k), 0];
      },
      coverAt: (x, y, z, h) => {
        const col = surfaceCover(seed, x, y, z, h);
        return shareAt(x, y, z) > 0 ? [col[0], col[1], col[2], 0] : col;
      },
    }),
    keepObject: (x, y, z) => !stripNearest(net, x, y, z, hit),
    extra: () => {
      const m = stripMesh(net, surface, cell, { coarsestLevel: ROOT_LEVEL, liftM: (level) => stripLiftM(surface, level) });
      return m ? [{ material: 'strip', mesh: m.mesh, bounds: m.bounds }] : [];
    },
  });
}
