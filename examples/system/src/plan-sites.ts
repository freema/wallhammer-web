// Stage 3 of the plan of the world: the settlements of Hearth. A score per node of the grid (water near, gentle
// ground, a kind climate, not too high), a best-first choice with a least distance (one town, then villages), a fit
// of a flat pad to the terrain at every site, and the lanes of each site as lines of the plan: the green or square in
// the middle, lanes out to the rim, the town's rings of cross streets. Pure; called by `worldPlan`.
//
// Deterministic: every random number is `hashInts` of the packed seed with the stream `SITE_STREAM` and integer keys;
// nodes by score then index, sites as picked, lanes per site in a fixed order. Arithmetic, Math.sqrt / floor / abs /
// min / max and the reproducible trigonometry of base only.

import { RAD_PER_TURN, detAtan2, detSinCosTurns, detSinTurns } from 'wallhammer-web/base';
import { hashInts, unit } from 'wallhammer-web/gen-core';
import { gridDirection, gridNodeAt, gridSlopeAt, gridSteps, pickSites } from 'wallhammer-web/gen-plan';
import type { LineTiles } from 'wallhammer-web/gen-plan';
import { BIOME, biomeAt, climateAt, landBiome } from './climate.ts';
import { planGround, planScope, planWater } from './ground.ts';
import { PROFILES, tileLinesAtPoint } from './plan-lines.ts';
import { planLineTiles } from './plan-tiles.ts';
import { LINE_KIND, SITE_KIND, STAGE, TILE_LEVEL, tileReachM } from './plan.ts';
import type { PlanLines, SiteTable, WorldPlan } from './plan.ts';
import { SITE_STREAM, frameOf, greenRadiusM, padSkirtM, sitePoint } from './settlement.ts';
import type { SiteFrame } from './settlement.ts';
import { groundHeight } from './world.ts';

/** Index of the lane profile in `PROFILES` (after brook, stream, river). */
export const LANE_PROFILE = 3;
/** Classes of the lanes: the town's streets 2, the village lanes 3. */
const TOWN_CLASS = 2;
const VILLAGE_CLASS = 3;

/** Score per biome (index by BIOME): sea, ice, tundra, taiga, forest, meadow, dry, rock. */
const BIOME_SCORE = [0, 0, 0.25, 0.55, 0.85, 1, 0, 0] as const;
/** River lines from this half-width on count as water near a node; the town wants the sea or this wide a river. */
const RIVER_NEAR_HALF_WIDTH_M = 3;
const TOWN_RIVER_HALF_WIDTH_M = 12;
const TOWN_WATER_STEPS = 3;
const TOWN_BONUS = 1.3;
/** Steps over the grid that the water score looks at. */
const WATER_STEPS = 8;
/** No site where the relief is this low (m), nor nearer to a pole than this |dir.y|. */
const MIN_RELIEF_M = 4;
const MAX_POLE_Y = 0.9;
/** Slope and height ramps of the score. */
const SLOPE_FROM = 0.03;
const SLOPE_TO = 0.12;
const HEIGHT_FROM_M = 600;
const HEIGHT_TO_M = 1400;
/** The pick: least score, spacing, how many villages. */
const MIN_SCORE = 0.35;
const SPACING_M = 9000;
const VILLAGES = 127;
/** Radii of the pads: village `90 + 130 u`, town `600 + 200 u` (their skirts: `padSkirtM`). */
const VILLAGE_R = [90, 130] as const;
const TOWN_R = [600, 200] as const;
/** Residual limits of the pad fit (village, town), the town's two relaxations, the least tilt. */
const VILLAGE_RESIDUAL_M = 12;
const TOWN_RESIDUAL_M = 30;
const TOWN_RELAX = [1, 1.5, 2.25] as const;
const MAX_TILT = 0.06;
/** Every sample of a pad lies this high above the sea at least, m. */
const MIN_ABOVE_SEA_M = 3;
/** Clearance of a river from the outer edge of the skirt, beyond its half-width and shoulder, m. */
const RIVER_CLEAR_M = 30;
/** Rings of the samples of a fit (village, town): 1 + 6 + 12 + 18 = 37 and 1 + 6 + … + 36 = 127 samples. */
const VILLAGE_RINGS = 3;
const TOWN_RINGS = 6;
/** At most this many fits tested per relaxation of the town and for all villages (a cap on the time). */
const TOWN_TRIES = 600;
const VILLAGE_TRIES = 6000;
/** Lanes: a point at least every this many metres; half-widths; the town's streets and rings. */
const POINT_STEP_M = 24;
const VILLAGE_HALF_WIDTH: readonly [number, number] = [1.6, 2.2];
const TOWN_STREETS = 5;
const TOWN_STREET_HALF_WIDTH_M = 3.5;
const TOWN_CROSS_HALF_WIDTH_M = 2.5;
const TOWN_RINGS_AT = [0.38, 0.72] as const;
/** Village lanes: 2–4, the second toward the second nearest site from 60° away, the rest 70° apart; bend under 8 %. */
const SECOND_MIN_TURNS = 60 / 360;
const REST_MIN_TURNS = 70 / 360;
const MAX_BEND = 0.07;
/** A village over this radius gets one dead-end side lane of 40–80 m from 50–65 % along one of its lanes. */
const SIDE_LANE_FROM_R = 150;
const SIDE_CLEAR_M = 30;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The water part of the score from the steps to the nearest water. */
function waterScore(steps: number): number {
  if (steps === 0) return 0.5;
  if (steps <= 2) return 1;
  if (steps >= WATER_STEPS) return 0.15;
  return 0.7 - ((steps - 3) * (0.7 - 0.15)) / (WATER_STEPS - 3);
}

/** What the sites stage adds to the plan. */
export interface PlanSites {
  sites: SiteTable;
  lines: PlanLines;
  tiles: LineTiles;
}

/** The fit of a pad at a node: height at the centre, tilt east and north, the largest residual within the radius. */
interface Fit {
  heightM: number;
  tiltE: number;
  tiltN: number;
  residualM: number;
}

/** A line of a site in its own frame before it is put on the sphere. */
interface LocalLine {
  /** x z pairs, metres. */
  pts: number[];
  halfWidth: number;
  cls: number;
  /** Local node indices, −1 for a free end. */
  from: number;
  to: number;
}

/** Turns of the angle between two directions given in turns, 0 … 0.5. */
function turnsApart(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
}

/** The sites of the plan and its lane lines. `plan` holds stage 2 (water and moisture). */
export function planSites(plan: WorldPlan, packed: number): PlanSites {
  const g = plan.grid;
  const R = g.radiusM;
  const count = g.count;
  const scope = planScope(plan, STAGE.climate, null);
  const rand = (node: number): number => unit(hashInts(packed, SITE_STREAM, node));
  const L = plan.lines;
  const r0 = L.kindStart[LINE_KIND.river]!;
  const r1 = L.kindStart[LINE_KIND.river + 1]!;

  // 1. Water near every node, and the great water near the town.
  const marks = new Uint8Array(count);
  const great = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (plan.relief[i]! <= 0) {
      marks[i] = 1;
      great[i] = 1;
    } else if (plan.pool[i] !== 0) marks[i] = 1;
  }
  for (let p = L.start[r0]!; p < L.start[r1]!; p++) {
    const hw = L.halfWidth[p]!;
    if (hw < RIVER_NEAR_HALF_WIDTH_M) continue;
    const node = gridNodeAt(g, L.points[3 * p]!, L.points[3 * p + 1]!, L.points[3 * p + 2]!);
    marks[node] = 1;
    if (hw >= TOWN_RIVER_HALF_WIDTH_M) great[node] = 1;
  }
  const steps = gridSteps(g, marks, WATER_STEPS);
  const greatSteps = gridSteps(g, great, TOWN_WATER_STEPS + 1);

  // 2. The score.
  const score = new Float32Array(count);
  const townScore = new Float32Array(count);
  const d: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const rel = plan.relief[i]!;
    if (rel * 0.5 <= MIN_RELIEF_M || plan.pool[i] !== 0) continue;
    gridDirection(g, i, d);
    if (Math.abs(d[1]) > MAX_POLE_Y) continue;
    const h = rel * 0.5;
    const high = 1 - smooth(HEIGHT_FROM_M, HEIGHT_TO_M, h);
    if (high <= 0) continue;
    const c = climateAt(scope, d[0] * R, d[1] * R, d[2] * R, h);
    const kind = BIOME_SCORE[landBiome(c.t, c.m, h)]!;
    if (kind <= 0) continue;
    const slope = 1 - smooth(SLOPE_FROM, SLOPE_TO, gridSlopeAt(g, plan.relief, 0.5, i));
    if (slope <= 0) continue;
    const s = kind * waterScore(steps[i]!) * slope * high * (0.9 + 0.2 * rand(i));
    score[i] = s;
    townScore[i] = greatSteps[i]! <= TOWN_WATER_STEPS ? s * TOWN_BONUS : s;
  }

  // 3. The fit of a pad.
  const bad = new Set<number>([BIOME.sea, BIOME.ice, BIOME.dry, BIOME.rock]);
  const river = new Set<number>();
  // `force` (the town's last resort only) keeps the least-squares plane but skips every refusal; with `dry` it still
  // refuses a pad that the sea, a lake or standing water touches.
  const fitAt = (node: number, r: number, k: number, limit: number, rings: number, force = false, dry = false): Fit | null => {
    gridDirection(g, node, d);
    const f = frameOf(d[0], d[1], d[2], 0, 0, 0);
    const reach = r + k;
    const xs: number[] = [];
    const zs: number[] = [];
    const hs: number[] = [];
    const ps: number[] = [];
    for (let j = 0; j <= rings; j++) {
      const rho = (j / rings) * reach;
      const n = j === 0 ? 1 : 6 * j;
      for (let i = 0; i < n; i++) {
        const [sn, cs] = detSinCosTurns((i + (j % 2) * 0.5) / n);
        const x = rho * cs;
        const z = rho * sn;
        const q = sitePoint(f, x, z).dir;
        const px = q[0] * R;
        const py = q[1] * R;
        const pz = q[2] * R;
        const own = groundHeight(packed, px, py, pz);
        if ((!force || dry) && (own < MIN_ABOVE_SEA_M || plan.pool[gridNodeAt(g, px, py, pz)] !== 0)) return null;
        xs.push(x);
        zs.push(z);
        hs.push(own);
        ps.push(px, py, pz);
      }
    }
    // Least-squares plane h = a + b x + c z.
    let n = 0;
    let sx = 0;
    let sz = 0;
    let sh = 0;
    let sxx = 0;
    let sxz = 0;
    let szz = 0;
    let sxh = 0;
    let szh = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!;
      const z = zs[i]!;
      const h = hs[i]!;
      n++;
      sx += x;
      sz += z;
      sh += h;
      sxx += x * x;
      sxz += x * z;
      szz += z * z;
      sxh += x * h;
      szh += z * h;
    }
    // Centred sums: the samples are symmetric enough that the system is well posed.
    const mx = sx / n;
    const mz = sz / n;
    const mh = sh / n;
    const cxx = sxx - n * mx * mx;
    const cxz = sxz - n * mx * mz;
    const czz = szz - n * mz * mz;
    const cxh = sxh - n * mx * mh;
    const czh = szh - n * mz * mh;
    const det = cxx * czz - cxz * cxz;
    if (!(det > 0)) return null;
    let b = (cxh * czz - czh * cxz) / det;
    let c = (czh * cxx - cxh * cxz) / det;
    const tilt = Math.sqrt(b * b + c * c);
    if (tilt > MAX_TILT) {
      if (!force) return null;
      // A forced pad keeps its tilt within the limit, turned the same way.
      b *= MAX_TILT / tilt;
      c *= MAX_TILT / tilt;
    }
    const a = mh - b * mx - c * mz;
    let residual = 0;
    for (let i = 0; i < xs.length; i++) {
      const pad = a + b * xs[i]! + c * zs[i]!;
      if (!force && pad < MIN_ABOVE_SEA_M) return null;
      const rho = Math.sqrt(xs[i]! * xs[i]! + zs[i]! * zs[i]!);
      if (rho > r) continue;
      const e = Math.abs(hs[i]! - pad);
      if (!force && e > limit) return null;
      residual = Math.max(residual, e);
    }
    if (force && dry) {
      for (let i = 0; i < hs.length; i++) if (planWater(scope, ps[3 * i]!, ps[3 * i + 1]!, ps[3 * i + 2]!).depthM > 0) return null;
    }
    if (force) return { heightM: a, tiltE: b, tiltN: c, residualM: residual };
    // Nothing of stage 1 bends the ground of the pad; no river comes near.
    river.clear();
    for (let i = 0; i < hs.length; i++) {
      const px = ps[3 * i]!;
      const py = ps[3 * i + 1]!;
      const pz = ps[3 * i + 2]!;
      // No point of the pad under standing water (the shore of the lake rule, plan-lakes.ts).
      if (planGround(scope, px, py, pz) !== hs[i] || planWater(scope, px, py, pz).depthM > 0) return null;
      for (const l of tileLinesAtPoint(plan, STAGE.climate, px, py, pz)) river.add(l);
    }
    const cx = ps[0]!;
    const cy = ps[1]!;
    const cz = ps[2]!;
    for (const l of river) {
      let widest = 0;
      let near2 = Infinity;
      for (let p = L.start[l]!; p < L.start[l + 1]!; p++) {
        widest = Math.max(widest, L.halfWidth[p]!);
        const ax = L.points[3 * p]! * R;
        const ay = L.points[3 * p + 1]! * R;
        const az = L.points[3 * p + 2]! * R;
        if (p + 1 >= L.start[l + 1]!) {
          near2 = Math.min(near2, (ax - cx) ** 2 + (ay - cy) ** 2 + (az - cz) ** 2);
          continue;
        }
        const ex = L.points[3 * p + 3]! * R - ax;
        const ey = L.points[3 * p + 4]! * R - ay;
        const ez = L.points[3 * p + 5]! * R - az;
        const e2 = ex * ex + ey * ey + ez * ez;
        const t = e2 > 0 ? Math.min(1, Math.max(0, ((cx - ax) * ex + (cy - ay) * ey + (cz - az) * ez) / e2)) : 0;
        near2 = Math.min(near2, (ax + ex * t - cx) ** 2 + (ay + ey * t - cy) ** 2 + (az + ez * t - cz) ** 2);
      }
      const clear = reach + RIVER_CLEAR_M + widest + PROFILES[L.profile[l]!]!.shoulderM;
      if (near2 < clear * clear) return null;
    }
    // The biome at the centre and at eight points of the rim.
    if (bad.has(biomeAt(scope, cx, cy, cz, hs[0]!))) return null;
    for (let i = 0; i < 8; i++) {
      const [sn, cs] = detSinCosTurns(i / 8);
      const q = sitePoint(f, r * cs, r * sn).dir;
      const px = q[0] * R;
      const py = q[1] * R;
      const pz = q[2] * R;
      if (bad.has(biomeAt(scope, px, py, pz, groundHeight(packed, px, py, pz)))) return null;
    }
    return { heightM: a, tiltE: b, tiltN: c, residualM: residual };
  };

  // 4. The town, best of all, its limit relaxed in two fixed steps (then a total fallback); then the villages.
  const fits = new Map<number, Fit>();
  const radius = new Map<number, number>();
  let town = -1;
  for (const relax of TOWN_RELAX) {
    let tries = 0;
    const got = pickSites(g, townScore, {
      count: 1,
      spacingM: 0,
      minScore: MIN_SCORE,
      accept: (node) => {
        if (tries++ >= TOWN_TRIES) return false;
        const r = TOWN_R[0] + TOWN_R[1] * rand(node);
        const fit = fitAt(node, r, padSkirtM(SITE_KIND.town), TOWN_RESIDUAL_M * relax, TOWN_RINGS);
        if (!fit) return false;
        fits.set(node, fit);
        radius.set(node, r);
        return true;
      },
    });
    if (got.length > 0) {
      town = got[0]!;
      break;
    }
  }
  // Every seed keeps its town. The relaxations ran out: the candidates by town score (higher first, then lower node),
  // first any residual within the other refusals, then the best of them on a forced pad. Villages keep their limits.
  if (town < 0) {
    const order: number[] = [];
    for (let i = 0; i < count; i++) if (townScore[i]! > 0) order.push(i);
    order.sort((p, q) => townScore[q]! - townScore[p]! || p - q);
    const take = (node: number, force: boolean, dry = false): boolean => {
      const r = TOWN_R[0] + TOWN_R[1] * rand(node);
      const fit = fitAt(node, r, padSkirtM(SITE_KIND.town), Infinity, TOWN_RINGS, force, dry);
      if (!fit) return false;
      fits.set(node, fit);
      radius.set(node, r);
      town = node;
      return true;
    };
    const tries = Math.min(order.length, TOWN_TRIES);
    for (let i = 0; i < tries && town < 0; i++) take(order[i]!, false);
    // A forced pad on dry ground first (no sample of it in the sea, a lake or standing water), then any.
    for (let i = 0; i < order.length && town < 0; i++) take(order[i]!, true, true);
    for (let i = 0; i < order.length && town < 0; i++) take(order[i]!, true);
  }
  let villageTries = 0;
  const villages = pickSites(g, score, {
    count: VILLAGES,
    spacingM: SPACING_M,
    minScore: MIN_SCORE,
    ...(town >= 0 ? { taken: [town] } : {}),
    accept: (node) => {
      if (villageTries++ >= VILLAGE_TRIES) return false;
      const r = VILLAGE_R[0] + VILLAGE_R[1] * rand(node);
      const fit = fitAt(node, r, padSkirtM(SITE_KIND.village), VILLAGE_RESIDUAL_M, VILLAGE_RINGS);
      if (!fit) return false;
      fits.set(node, fit);
      radius.set(node, r);
      return true;
    },
  });
  const nodes = town >= 0 ? [town, ...villages] : [...villages];
  const siteCount = nodes.length;

  // 5. The table; every later step works from its float32 values, as every thread does.
  const sites: SiteTable = {
    count: siteCount,
    dir: new Float32Array(3 * siteCount),
    heightM: new Float32Array(siteCount),
    tilt: new Float32Array(2 * siteCount),
    radiusM: new Float32Array(siteCount),
    kind: new Uint8Array(siteCount),
    biome: new Uint8Array(siteCount),
    node: Uint32Array.from(nodes),
    gates: new Uint32Array(siteCount + 1),
    gateNodes: new Uint32Array(0),
  };
  for (let s = 0; s < siteCount; s++) {
    const node = nodes[s]!;
    const fit = fits.get(node)!;
    gridDirection(g, node, d);
    sites.dir[3 * s] = d[0];
    sites.dir[3 * s + 1] = d[1];
    sites.dir[3 * s + 2] = d[2];
    sites.heightM[s] = fit.heightM;
    sites.tilt[2 * s] = fit.tiltE;
    sites.tilt[2 * s + 1] = fit.tiltN;
    sites.radiusM[s] = radius.get(node)!;
    sites.kind[s] = s === 0 && town >= 0 ? SITE_KIND.town : SITE_KIND.village;
    const f = frameOf(sites.dir[3 * s]!, sites.dir[3 * s + 1]!, sites.dir[3 * s + 2]!, 0, 0, 0);
    sites.biome[s] = biomeAt(scope, f.origin[0] * R, f.origin[1] * R, f.origin[2] * R, groundHeight(packed, f.origin[0] * R, f.origin[1] * R, f.origin[2] * R));
  }

  // 6. Lanes per site, appended after the river lines; their nodes after the river nodes.
  const start: number[] = Array.from(L.start);
  const pts: number[] = Array.from(L.points);
  const grade: number[] = Array.from(L.grade);
  const hw: number[] = Array.from(L.halfWidth);
  const profile: number[] = Array.from(L.profile);
  const cls: number[] = Array.from(L.cls);
  const owner: number[] = Array.from(L.owner);
  const from: number[] = Array.from(L.from);
  const to: number[] = Array.from(L.to);
  const planNodes: number[] = Array.from(L.nodes);
  const gateNodes: number[] = [];
  for (let s = 0; s < siteCount; s++) {
    const f = frameOf(sites.dir[3 * s]!, sites.dir[3 * s + 1]!, sites.dir[3 * s + 2]!, sites.heightM[s]!, sites.tilt[2 * s]!, sites.tilt[2 * s + 1]!);
    const { lines, nodes: local, gates } = siteLines(packed, sites, s, f);
    const base = planNodes.length / 4;
    for (const [x, z] of local) {
      const p = sitePoint(f, x, z);
      planNodes.push(p.dir[0], p.dir[1], p.dir[2], p.heightM);
    }
    for (const gte of gates) gateNodes.push(base + gte);
    sites.gates[s + 1] = gateNodes.length;
    for (const line of lines) {
      for (let i = 0; i < line.pts.length; i += 2) {
        const p = sitePoint(f, line.pts[i]!, line.pts[i + 1]!);
        pts.push(p.dir[0], p.dir[1], p.dir[2]);
        grade.push(p.heightM);
        hw.push(line.halfWidth);
      }
      start.push(pts.length / 3);
      profile.push(LANE_PROFILE);
      cls.push(line.cls);
      owner.push(s);
      from.push(line.from >= 0 ? base + line.from : -1);
      to.push(line.to >= 0 ? base + line.to : -1);
    }
  }
  sites.gateNodes = Uint32Array.from(gateNodes);
  const lineCount = owner.length;
  const laneEnd = lineCount;
  const lines: PlanLines = {
    kindStart: Uint32Array.from([r0, r1, laneEnd, laneEnd, laneEnd]),
    start: Uint32Array.from(start),
    points: Float32Array.from(pts),
    grade: Float32Array.from(grade),
    halfWidth: Float32Array.from(hw),
    profile: Uint8Array.from(profile),
    cls: Uint8Array.from(cls),
    owner: Uint32Array.from(owner),
    from: Int32Array.from(from),
    to: Int32Array.from(to),
    nodes: Float32Array.from(planNodes),
  };

  // 7. The index of all lines, with the reach plan-water.ts gives a river (the river entries do not change).
  const nodeWidest = new Float64Array(lines.nodes.length / 4);
  const widest = new Float64Array(lineCount);
  for (let l = 0; l < lineCount; l++) {
    const a = lines.start[l]!;
    const b = lines.start[l + 1]!;
    for (let p = a; p < b; p++) widest[l] = Math.max(widest[l]!, lines.halfWidth[p]!);
    if (lines.from[l]! >= 0) nodeWidest[lines.from[l]!] = Math.max(nodeWidest[lines.from[l]!]!, lines.halfWidth[a]!);
    if (lines.to[l]! >= 0) nodeWidest[lines.to[l]!] = Math.max(nodeWidest[lines.to[l]!]!, lines.halfWidth[b - 1]!);
  }
  const reachM = new Float64Array(lineCount);
  for (let l = 0; l < lineCount; l++) {
    const f = lines.from[l]!;
    const t = lines.to[l]!;
    reachM[l] = tileReachM(Math.max(widest[l]!, f >= 0 ? nodeWidest[f]! : 0, t >= 0 ? nodeWidest[t]! : 0));
  }
  const tiles = planLineTiles({ level: TILE_LEVEL, radiusM: R, start: lines.start, points: lines.points, reachM }, plan.tiles);
  return { sites, lines, tiles };
}

/** Points from (ax, az) to (bx, bz), at least every `POINT_STEP_M`, both ends included. */
function straight(ax: number, az: number, bx: number, bz: number): number[] {
  const len = Math.sqrt((bx - ax) ** 2 + (bz - az) ** 2);
  const n = Math.max(1, Math.ceil(len / POINT_STEP_M));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n);
  return out;
}

/** Bearing in turns (0 = east, 0.25 = north) of another site seen from the frame of a site. */
function bearingTurns(f: SiteFrame, x: number, y: number, z: number): number {
  const e = x * f.east[0] + y * f.east[1] + z * f.east[2];
  const n = x * f.north[0] + y * f.north[1] + z * f.north[2];
  const t = detAtan2(n, e) / RAD_PER_TURN;
  return t < 0 ? t + 1 : t;
}

/** Squared distance from (px, pz) to the polyline of x z pairs. */
function polyline2(pts: readonly number[], px: number, pz: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i]!;
    const az = pts[i + 1]!;
    const ex = pts[i + 2]! - ax;
    const ez = pts[i + 3]! - az;
    const e2 = ex * ex + ez * ez;
    const t = e2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (pz - az) * ez) / e2)) : 0;
    best = Math.min(best, (ax + ex * t - px) ** 2 + (az + ez * t - pz) ** 2);
  }
  return best;
}

/**
 * The lines of one site in its frame: the village's lanes from the rim of its green to its radius (and one side
 * lane), the town's streets from its square to its radius with two rings of cross streets. Local nodes, and which of
 * them are gates (the outer ends of the main lanes, on the radius).
 */
function siteLines(packed: number, sites: SiteTable, s: number, f: SiteFrame): { lines: LocalLine[]; nodes: [number, number][]; gates: number[] } {
  const u = (...keys: number[]): number => unit(hashInts(packed, SITE_STREAM, s, ...keys));
  const r = sites.radiusM[s]!;
  const kind = sites.kind[s]!;
  const greenR = greenRadiusM(packed, s, kind);
  // Bearings of the other sites, nearest first (ties: the lower index).
  const others: { d2: number; turns: number; site: number }[] = [];
  for (let o = 0; o < sites.count; o++) {
    if (o === s) continue;
    const x = sites.dir[3 * o]!;
    const y = sites.dir[3 * o + 1]!;
    const z = sites.dir[3 * o + 2]!;
    const d2 = (x - f.origin[0]) ** 2 + (y - f.origin[1]) ** 2 + (z - f.origin[2]) ** 2;
    others.push({ d2, turns: bearingTurns(f, x, y, z), site: o });
  }
  others.sort((a, b) => a.d2 - b.d2 || a.site - b.site);
  const nodes: [number, number][] = [];
  const lines: LocalLine[] = [];
  const gates: number[] = [];
  const addNode = (x: number, z: number): number => {
    nodes.push([x, z]);
    return nodes.length - 1;
  };
  const dirOf = (turns: number): [number, number] => {
    const [sn, cs] = detSinCosTurns(turns);
    return [cs, sn];
  };

  if (kind === SITE_KIND.town) {
    const first = others.length > 0 ? others[0]!.turns : u(10);
    const angles: number[] = [];
    for (let i = 0; i < TOWN_STREETS; i++) angles.push(first + i / TOWN_STREETS + (i > 0 ? 0.04 * (u(20, i) - 0.5) : 0));
    const ring: number[][] = [[], []];
    for (let i = 0; i < TOWN_STREETS; i++) {
      const [cx, cz] = dirOf(angles[i]!);
      const radii = [greenR, TOWN_RINGS_AT[0] * r, TOWN_RINGS_AT[1] * r, r];
      const n1 = addNode(cx * radii[1]!, cz * radii[1]!);
      const n2 = addNode(cx * radii[2]!, cz * radii[2]!);
      const gate = addNode(cx * r, cz * r);
      ring[0]!.push(n1);
      ring[1]!.push(n2);
      gates.push(gate);
      const ends = [-1, n1, n2, gate];
      for (let k = 0; k < 3; k++) {
        lines.push({ pts: straight(cx * radii[k]!, cz * radii[k]!, cx * radii[k + 1]!, cz * radii[k + 1]!), halfWidth: TOWN_STREET_HALF_WIDTH_M, cls: TOWN_CLASS, from: ends[k]!, to: ends[k + 1]! });
      }
    }
    for (const rn of ring) {
      for (let i = 0; i < TOWN_STREETS; i++) {
        const a = rn[i]!;
        const b = rn[(i + 1) % TOWN_STREETS]!;
        lines.push({ pts: straight(nodes[a]![0], nodes[a]![1], nodes[b]![0], nodes[b]![1]), halfWidth: TOWN_CROSS_HALF_WIDTH_M, cls: TOWN_CLASS, from: a, to: b });
      }
    }
    return { lines, nodes, gates };
  }

  // A village: 2–4 lanes.
  const want = 2 + Math.min(2, Math.floor(3 * u(2)));
  const angles: number[] = [];
  if (others.length > 0) angles.push(others[0]!.turns);
  if (others.length > 1 && turnsApart(others[1]!.turns, angles[0]!) >= SECOND_MIN_TURNS) angles.push(others[1]!.turns);
  for (let k = 0; angles.length < want && k < 64; k++) {
    const a = u(30, k);
    if (angles.every((b) => turnsApart(a, b) >= REST_MIN_TURNS)) angles.push(a);
  }
  const halfWidth = VILLAGE_HALF_WIDTH[0] + (VILLAGE_HALF_WIDTH[1] - VILLAGE_HALF_WIDTH[0]) * u(3);
  const length = r - greenR;
  const steps = Math.max(2, Math.ceil((length * 1.05) / POINT_STEP_M));
  // Each lane as points along s = 0 … 1 with a gentle bend (zero at both ends).
  const lanePts: number[][] = angles.map((a, i) => {
    const [cx, cz] = dirOf(a);
    const bend = MAX_BEND * (2 * u(40, i) - 1) * length;
    const out: number[] = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const along = greenR + length * t;
      const side = k === 0 || k === steps ? 0 : bend * detSinTurns(t / 2);
      out.push(cx * along - cz * side, cz * along + cx * side);
    }
    // The gate lies exactly on the radius.
    out[out.length - 2] = cx * r;
    out[out.length - 1] = cz * r;
    return out;
  });
  // The side lane: from a node at 50–65 % along one lane, square to it, 40–80 m, clear of the other lanes.
  let split = -1;
  let splitAt = 0;
  let side: number[] | null = null;
  if (r > SIDE_LANE_FROM_R && lanePts.length > 0) {
    split = Math.floor(u(50) * lanePts.length) % lanePts.length;
    splitAt = Math.round((0.5 + 0.15 * u(51)) * steps);
    const p = lanePts[split]!;
    const nx = p[2 * splitAt]!;
    const nz = p[2 * splitAt + 1]!;
    const tx = p[2 * splitAt + 2]! - p[2 * splitAt - 2]!;
    const tz = p[2 * splitAt + 3]! - p[2 * splitAt - 1]!;
    const tl = Math.sqrt(tx * tx + tz * tz) || 1;
    const first = u(52) < 0.5 ? 1 : -1;
    const full = 40 + 40 * u(53);
    for (const sign of [first, -first]) {
      for (let len = full; len >= 40 && !side; len -= 10) {
        const ex = nx - (tz / tl) * sign * len;
        const ez = nz + (tx / tl) * sign * len;
        if (Math.sqrt(ex * ex + ez * ez) > r - 5) continue;
        let clear = true;
        for (let q = 0; q < lanePts.length && clear; q++) {
          if (q === split) continue;
          for (let k = 1; k <= 8 && clear; k++) {
            const sx = nx + ((ex - nx) * k) / 8;
            const sz = nz + ((ez - nz) * k) / 8;
            if (polyline2(lanePts[q]!, sx, sz) < SIDE_CLEAR_M * SIDE_CLEAR_M) clear = false;
          }
        }
        if (clear) side = straight(nx, nz, ex, ez);
      }
      if (side) break;
    }
    if (!side) split = -1;
  }
  lanePts.forEach((p, i) => {
    const gate = addNode(p[p.length - 2]!, p[p.length - 1]!);
    gates.push(gate);
    if (i !== split) {
      lines.push({ pts: p, halfWidth, cls: VILLAGE_CLASS, from: -1, to: gate });
      return;
    }
    const node = addNode(p[2 * splitAt]!, p[2 * splitAt + 1]!);
    lines.push({ pts: p.slice(0, 2 * splitAt + 2), halfWidth, cls: VILLAGE_CLASS, from: -1, to: node });
    lines.push({ pts: p.slice(2 * splitAt), halfWidth, cls: VILLAGE_CLASS, from: node, to: gate });
  });
  if (side && split >= 0) {
    // The node of the split is the one added right after the gate of its lane.
    const node = gates[split]! + 1;
    lines.push({ pts: side, halfWidth, cls: VILLAGE_CLASS, from: node, to: -1 });
  }
  return { lines, nodes, gates };
}
