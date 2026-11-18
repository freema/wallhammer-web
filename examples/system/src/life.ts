// Who walks where on Hearth at a time (NSO-714): villagers on the lanes of every settlement, parties with a pack beast
// and lone walkers on the roads, troops of skeletons in the middle third of the long roads, grazers standing in the
// fields of the villages. Nothing is simulated: every walk is a fixed path of plan lines walked there and back for
// ever, and its pose is a closed form of the time (`walkPose`), so any jump of the clock poses at once and a query at
// one time never changes the answer at another.
//
// Pure: no DOM, no clock, no Math.random; arithmetic, Math.sqrt / floor / abs / min / max and base/trig only, so Node
// and every browser agree. The caches (walks per site and route, lengths per line) hold only what a fresh call would
// rebuild to the same values.

import { detSinCosTurns } from 'wallhammer-web/base';
import type { Vec3 } from 'wallhammer-web/base';
import { hashInts, unit } from 'wallhammer-web/gen-core';
import { lineAt, lineLengths } from 'wallhammer-web/gen-plan';
import { CREATURE, CREATURE_CAP, VILLAGER_PACK_BIT } from './creatures.ts';
import { planScope, planStripHit, planSurface, planWater } from './ground.ts';
import type { Scope } from './ground.ts';
import { SURFACE_SECTIONS, tileLinesAtPoint } from './plan-lines.ts';
import { LINE_KIND, SITE_KIND, STAGE } from './plan.ts';
import type { WorldPlan } from './plan.ts';
import { settlementOf, siteFrame, siteLanes, siteLocal, sitePoint } from './settlement.ts';

/** Creatures exist only within this distance of the eye, and never more than `LIFE_MAX` of them. */
export const LIFE_RADIUS_M = 400;
export const LIFE_MAX = 300;
/** A site or route joins the near set within this distance of the eye (beyond the site's radius), and not above it. */
const SET_REACH_M = 450;

/** Salts of the hashes, one per use. */
const SALT_SITE = 0x714a;
const SALT_ROUTE = 0x714b;
const SALT_STAND = 0x714d;

/** Longest path of a lane walker, m; seconds a speed ramps at either end of a leg. */
const LANE_PATH_MAX_M = 250;
const RAMP_S = 1;
/** Metres before and after a point over which the heading is taken (blends the joints of lines). */
const CHORD_M = 1;
/** A party: the walker ahead of its beast, m; the spacing of a troop, m; roads that carry a troop, m. */
const PARTY_AHEAD_M = 2.2;
const TROOP_GAP_M = 1.5;
const TROOP_ROAD_M = 3000;

/**
 * One walker: a path of plan lines walked there and back for ever. Path coordinates run from 0 to `lengthM`.
 * - `lines`: per line of the path `±(line + 1)`, the sign the direction of travel along the line (+ toward its end);
 *   `cumM` the path coordinate where each line starts, and the length at the end.
 * - `fromM`: where the path starts on its first line, `toM` where it ends on its last (metres from the line's first point).
 * - A party walks one timetable over `lengthM − spreadM`: each member is `aheadM` ahead of the timetable's point on the
 *   way out and `spreadM − aheadM` ahead of it on the way back, so the leader leads both ways (they change places
 *   while standing at an end). A lone walker has both 0.
 */
export interface Walk {
  kind: number;
  seed: number;
  lines: Int32Array;
  cumM: Float64Array;
  lengthM: number;
  fromM: number;
  toM: number;
  /** Cruising speed, m/s. */
  speed: number;
  /** Seconds standing at the start and at the end. */
  dwellS: [number, number];
  offsetS: number;
  /** Metres to the right of travel. */
  sideM: number;
  aheadM: number;
  spreadM: number;
}

/** A creature that stands where it is (grazers in the fields). */
export interface Stand {
  kind: number;
  seed: number;
  dir: Vec3;
  heightM: number;
  heading: Vec3;
}

/** Where a creature is at a time, in the body's frame. */
export interface LifePose {
  kind: number;
  seed: number;
  /** Unit direction from the body's centre. */
  dir: Vec3;
  /** Height of its feet above the base sphere, m. */
  heightM: number;
  /** Unit tangent it faces. */
  heading: Vec3;
  /** Rise per metre along the heading. */
  slope: number;
  /** Metres walked on the current leg (the gait's phase). */
  distanceM: number;
  speed: number;
  /** 0 moving, 1 standing. */
  state: 0 | 1;
}

/** The sites and routes near the eye, ascending. */
export interface LifeSet {
  sites: number[];
  routes: number[];
}

// --- Lines --------------------------------------------------------------------------------------------------------

interface LineGeo {
  points: Float32Array;
  lengths: Float64Array;
  p0: number;
}
const geoCache = new WeakMap<WorldPlan, Map<number, LineGeo>>();

function lineGeo(plan: WorldPlan, line: number): LineGeo {
  let m = geoCache.get(plan);
  if (!m) {
    m = new Map();
    geoCache.set(plan, m);
  }
  let g = m.get(line);
  if (!g) {
    const L = plan.lines;
    const p0 = L.start[line]!;
    const points = L.points.subarray(3 * p0, 3 * L.start[line + 1]!);
    g = { points, lengths: lineLengths(points, plan.grid.radiusM), p0 };
    m.set(line, g);
  }
  return g;
}

const lineLength = (plan: WorldPlan, line: number): number => {
  const len = lineGeo(plan, line).lengths;
  return len[len.length - 1]!;
};

/** A point of a path: its direction, the heading toward the end of its line (times the sign), grade, strip. */
interface PathPoint {
  dir: Vec3;
  heading: Vec3;
  gradeM: number;
  halfM: number;
  profile: number;
}
const newPoint = (): PathPoint => ({ dir: [0, 0, 0], heading: [0, 0, 0], gradeM: 0, halfM: 1, profile: 0 });

/** Plan line `line` at `alongM` from its first point; `sign` −1 turns the heading round. */
function linePointInto(plan: WorldPlan, line: number, alongM: number, sign: number, out: PathPoint): void {
  const g = lineGeo(plan, line);
  const len = g.lengths;
  const total = len[len.length - 1]!;
  const s = alongM < 0 ? 0 : alongM > total ? total : alongM;
  lineAt(g.points, len, s, out);
  let lo = 0;
  let hi = Math.max(0, len.length - 2);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (len[mid]! <= s) lo = mid;
    else hi = mid - 1;
  }
  const j = Math.min(len.length - 1, lo + 1);
  const span = len[j]! - len[lo]!;
  const t = span > 0 ? (s - len[lo]!) / span : 0;
  const L = plan.lines;
  out.gradeM = L.grade[g.p0 + lo]! + (L.grade[g.p0 + j]! - L.grade[g.p0 + lo]!) * t;
  out.halfM = L.halfWidth[g.p0 + lo]! + (L.halfWidth[g.p0 + j]! - L.halfWidth[g.p0 + lo]!) * t;
  out.profile = L.profile[line]!;
  if (sign < 0) {
    out.heading[0] = -out.heading[0];
    out.heading[1] = -out.heading[1];
    out.heading[2] = -out.heading[2];
  }
}

/** The path of a walk at path coordinate `p` (clamped). */
function pathPointInto(plan: WorldPlan, w: Walk, p: number, out: PathPoint): void {
  const q = p < 0 ? 0 : p > w.lengthM ? w.lengthM : p;
  const n = w.lines.length;
  let i = 0;
  while (i + 1 < n && w.cumM[i + 1]! <= q) i++;
  const code = w.lines[i]!;
  const sign = code < 0 ? -1 : 1;
  const line = sign * code - 1;
  const start = i === 0 ? w.fromM : sign > 0 ? 0 : lineLength(plan, line);
  linePointInto(plan, line, start + sign * (q - w.cumM[i]!), sign, out);
}

/** Height of the drawn surface of a strip above its grade at `a` half-widths across (the hem left out). */
function sectionUp(profile: number, a: number): number {
  const s = SURFACE_SECTIONS[profile] ?? SURFACE_SECTIONS[0]!;
  const x = a < -1 ? -1 : a > 1 ? 1 : a;
  for (let k = 0; k + 3 < s.length; k += 2) {
    const a0 = s[k]!;
    const a1 = s[k + 2]!;
    if (x >= a0 && x <= a1 && a0 >= -1 && a1 <= 1) return a1 > a0 ? s[k + 1]! + ((s[k + 3]! - s[k + 1]!) * (x - a0)) / (a1 - a0) : s[k + 1]!;
  }
  return 0;
}

/** A path from a list of whole lines (signs and cumulative starts), cut to the path coordinates [a, b]. */
function cutPath(plan: WorldPlan, codes: readonly number[], cum: Float64Array, a: number, b: number): { lines: Int32Array; cumM: Float64Array; fromM: number; toM: number; lengthM: number } {
  const n = codes.length;
  let i0 = 0;
  while (i0 + 1 < n && cum[i0 + 1]! <= a) i0++;
  let i1 = i0;
  while (i1 + 1 < n && cum[i1 + 1]! < b) i1++;
  const along = (i: number, p: number): number => {
    const code = codes[i]!;
    const sign = code < 0 ? -1 : 1;
    const line = sign * code - 1;
    return (sign > 0 ? 0 : lineLength(plan, line)) + sign * (p - cum[i]!);
  };
  const lines = new Int32Array(codes.slice(i0, i1 + 1));
  const cumM = new Float64Array(lines.length + 1);
  for (let i = 1; i < lines.length; i++) cumM[i] = cum[i0 + i]! - a;
  cumM[lines.length] = b - a;
  return { lines, cumM, fromM: along(i0, a), toM: along(i1, b), lengthM: b - a };
}

// --- The scope of the page's queries ---------------------------------------------------------------------------------

const scopes = new WeakMap<WorldPlan, Map<number, Scope>>();
function scopeOf(plan: WorldPlan, stage: number): Scope {
  let m = scopes.get(plan);
  if (!m) {
    m = new Map();
    scopes.set(plan, m);
  }
  let s = m.get(stage);
  if (!s) {
    s = planScope(plan, stage, null);
    m.set(stage, s);
  }
  return s;
}

// --- Who --------------------------------------------------------------------------------------------------------

const siteWalkCache = new WeakMap<WorldPlan, Map<number, Walk[]>>();
const routeWalkCache = new WeakMap<WorldPlan, Map<number, Walk[]>>();
const standCache = new WeakMap<WorldPlan, Map<number, Stand[]>>();

function cached<T>(cache: WeakMap<WorldPlan, Map<number, T>>, plan: WorldPlan, key: number, make: () => T): T {
  let m = cache.get(plan);
  if (!m) {
    m = new Map();
    cache.set(plan, m);
  }
  let v = m.get(key);
  if (v === undefined) {
    v = make();
    m.set(key, v);
  }
  return v;
}

const range = (u: number, a: number, b: number): number => a + (b - a) * u;
const clampInt = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, Math.round(x)));
/** A seed as an unsigned integer without the pack bit, or with it. */
const villagerSeed = (h: number, pack: boolean): number => ((h & ~VILLAGER_PACK_BIT) | (pack ? VILLAGER_PACK_BIT : 0)) >>> 0;

/** Metres along lane `line` (from its first point) of the point nearest a point of the site's pad. */
function nearestAlong(plan: WorldPlan, site: number, line: number, x: number, z: number): number {
  const f = siteFrame(plan, site);
  const L = plan.lines;
  const a = L.start[line]!;
  const b = L.start[line + 1]!;
  let best = Infinity;
  let bestAt = 0;
  let run = 0;
  let px = 0;
  let pz = 0;
  for (let p = a; p < b; p++) {
    const q = siteLocal(f, L.points[3 * p]!, L.points[3 * p + 1]!, L.points[3 * p + 2]!);
    if (p > a) {
      const dx = q.x - px;
      const dz = q.z - pz;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - px) * dx + (z - pz) * dz) / l2)) : 0;
      const ex = px + dx * t - x;
      const ez = pz + dz * t - z;
      const d = ex * ex + ez * ez;
      const l = Math.sqrt(l2);
      if (d < best) {
        best = d;
        bestAt = run + l * t;
      }
      run += l;
    }
    px = q.x;
    pz = q.z;
  }
  // From metres on the pad to metres of the line on the sphere (they differ by the curvature only).
  const total = lineLength(plan, line);
  return run > 0 ? (bestAt * total) / run : 0;
}

/**
 * The villagers of a site (stage ≥ 3): `clamp(round(0.6 · lots), 8, 24)` in a village, `min(140, round(0.35 · lots))`
 * in the town. Each starts on the lane of its home lot at the point nearest the lot and walks a chain of one to three
 * lane lines joined at their nodes (never straight back), at most 250 m. Cached per site.
 */
export function siteWalks(plan: WorldPlan, site: number): Walk[] {
  return cached(siteWalkCache, plan, site, () => {
    const S = plan.sites;
    if (!S || site < 0 || site >= S.count) return [];
    const st = settlementOf(plan, site);
    const lots = st.lots;
    const lanes = siteLanes(plan, site);
    if (lots.length === 0 || lanes.length === 0) return [];
    const L = plan.lines;
    const town = S.kind[site] === SITE_KIND.town;
    const count = town ? Math.min(140, Math.round(0.35 * lots.length)) : clampInt(0.6 * lots.length, 8, 24);
    const walks: Walk[] = [];
    for (let k = 0; k < count; k++) {
      const h = (j: number): number => hashInts(plan.seed, SALT_SITE, site, k, j);
      const lot = lots[Math.floor(unit(h(0)) * lots.length)]!;
      const line0 = lot.line;
      const s0 = nearestAlong(plan, site, line0, lot.x, lot.z);
      const steps = 1 + Math.floor(unit(h(2)) * 3);
      /** The path from s0 in one direction. */
      const build = (forward: boolean): { codes: number[]; cum: number[]; toM: number; total: number } => {
        const len0 = lineLength(plan, line0);
        const codes = [(line0 + 1) * (forward ? 1 : -1)];
        const cum = [0];
        let total = forward ? len0 - s0 : s0;
        let toM = forward ? len0 : 0;
        if (total > LANE_PATH_MAX_M) return { codes, cum, toM: forward ? s0 + LANE_PATH_MAX_M : s0 - LANE_PATH_MAX_M, total: LANE_PATH_MAX_M };
        let node = forward ? L.to[line0]! : L.from[line0]!;
        let prev = line0;
        for (let step = 1; step < steps; step++) {
          if (node < 0) break;
          const options = lanes.filter((l) => l !== prev && (L.from[l] === node || L.to[l] === node));
          if (options.length === 0) break;
          const next = options[Math.floor(unit(h(10 + step)) * options.length)]!;
          const fromStart = L.from[next] === node;
          const len = lineLength(plan, next);
          codes.push((next + 1) * (fromStart ? 1 : -1));
          cum.push(total);
          if (total + len > LANE_PATH_MAX_M) {
            const keep = LANE_PATH_MAX_M - total;
            return { codes, cum, toM: fromStart ? keep : len - keep, total: LANE_PATH_MAX_M };
          }
          total += len;
          toM = fromStart ? len : 0;
          node = fromStart ? L.to[next]! : L.from[next]!;
          prev = next;
        }
        return { codes, cum, toM, total };
      };
      let path = build(unit(h(1)) < 0.5);
      // A start next to a dead end turns the other way.
      if (path.total < 20) {
        const other = build(path.codes[0]! < 0);
        if (other.total > path.total) path = other;
      }
      if (path.total < 1) continue;
      const cumM = new Float64Array(path.codes.length + 1);
      path.cum.forEach((c, i) => (cumM[i] = c));
      cumM[path.codes.length] = path.total;
      const speed = range(unit(h(3)), 1.15, 1.45);
      const dwellS: [number, number] = [range(unit(h(4)), 20, 90), range(unit(h(5)), 20, 90)];
      const half = L.halfWidth[L.start[line0]!]!;
      const w: Walk = {
        kind: CREATURE.villager,
        seed: villagerSeed(h(6), unit(h(9)) < 0.08),
        lines: new Int32Array(path.codes),
        cumM,
        lengthM: path.total,
        fromM: s0,
        toM: path.toM,
        speed,
        dwellS,
        offsetS: 0,
        sideM: range(unit(h(7)), 0.15, 0.45) * half,
        aheadM: 0,
        spreadM: 0,
      };
      w.offsetS = unit(h(8)) * periodS(w);
      walks.push(w);
    }
    return walks;
  });
}

/** The lines of route `route` in order from its site a, with the direction each is walked, and their starts. */
function routePath(plan: WorldPlan, route: number): { codes: number[]; cum: Float64Array } {
  const rt = plan.routes!;
  const L = plan.lines;
  const lines = Array.from(rt.lineOf.subarray(rt.lineStart[route]!, rt.lineStart[route + 1]!));
  const end = (l: number, last: boolean): Vec3 => {
    const k = last ? L.start[l + 1]! - 1 : L.start[l]!;
    return [L.points[3 * k]!, L.points[3 * k + 1]!, L.points[3 * k + 2]!];
  };
  const d2 = (p: Vec3, q: Vec3): number => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const s = rt.a[route]!;
  let here: Vec3 = [plan.sites!.dir[3 * s]!, plan.sites!.dir[3 * s + 1]!, plan.sites!.dir[3 * s + 2]!];
  const codes: number[] = [];
  const cum = new Float64Array(lines.length + 1);
  lines.forEach((l, i) => {
    // The same rule as routePoint (plan-routes.ts): the first line runs away from site a, each next from the end left.
    const fw = d2(here, end(l, false)) <= d2(here, end(l, true));
    codes.push((l + 1) * (fw ? 1 : -1));
    here = end(l, fw);
    cum[i + 1] = cum[i]! + lineLength(plan, l);
  });
  return { codes, cum };
}

/**
 * The walkers of a route (stage ≥ 4): `clamp(round(length / 800), 1, 12)` parties over its whole length, 60 % a beast
 * with a villager 2.2 m ahead, 40 % a lone villager with a pack; a route of at least 3 km also carries a troop of
 * three skeletons 1.5 m apart on its middle third. Cached per route.
 */
export function routeWalks(plan: WorldPlan, route: number): Walk[] {
  return cached(routeWalkCache, plan, route, () => {
    const rt = plan.routes;
    if (!rt || route < 0 || route >= rt.count || rt.lineStart[route + 1]! <= rt.lineStart[route]!) return [];
    const { codes, cum } = routePath(plan, route);
    const total = cum[codes.length]!;
    if (!(total > 10)) return [];
    const L = plan.lines;
    const half = L.halfWidth[L.start[Math.abs(codes[0]!) - 1]!]!;
    const whole = cutPath(plan, codes, cum, 0, total);
    const walks: Walk[] = [];
    const parties = clampInt(total / 800, 1, 12);
    for (let k = 0; k < parties; k++) {
      const h = (j: number): number => hashInts(plan.seed, SALT_ROUTE, route, k, j);
      const base = {
        ...whole,
        speed: range(unit(h(1)), 1.1, 1.3),
        dwellS: [range(unit(h(2)), 120, 600), range(unit(h(3)), 120, 600)] as [number, number],
        offsetS: 0,
        sideM: range(unit(h(4)), 0.15, 0.45) * half,
      };
      if (unit(h(0)) < 0.6) {
        const beast: Walk = { ...base, kind: CREATURE.beast, seed: h(5) >>> 0, aheadM: 0, spreadM: PARTY_AHEAD_M };
        // Parties spread over the timetable, each at its own share of the period.
        beast.offsetS = ((k + unit(h(7))) / parties) * periodS(beast);
        walks.push(beast, { ...beast, kind: CREATURE.villager, seed: villagerSeed(h(6), false), aheadM: PARTY_AHEAD_M });
      } else {
        const lone: Walk = { ...base, kind: CREATURE.villager, seed: villagerSeed(h(6), true), aheadM: 0, spreadM: 0 };
        lone.offsetS = ((k + unit(h(7))) / parties) * periodS(lone);
        walks.push(lone);
      }
    }
    if (total >= TROOP_ROAD_M) {
      const h = (j: number): number => hashInts(plan.seed, SALT_ROUTE, route, 1000, j);
      const third = cutPath(plan, codes, cum, total / 3, (2 * total) / 3);
      const spread = 2 * TROOP_GAP_M;
      const lead: Walk = {
        ...third,
        kind: CREATURE.skeleton,
        seed: h(5) >>> 0,
        speed: range(unit(h(1)), 0.95, 1.05),
        dwellS: [range(unit(h(2)), 5, 10), range(unit(h(3)), 5, 10)],
        offsetS: 0,
        sideM: range(unit(h(4)), 0.15, 0.45) * half,
        aheadM: spread,
        spreadM: spread,
      };
      lead.offsetS = unit(h(6)) * periodS(lead);
      walks.push(lead, { ...lead, seed: h(7) >>> 0, aheadM: TROOP_GAP_M }, { ...lead, seed: h(8) >>> 0, aheadM: 0 });
    }
    return walks;
  });
}

/**
 * The grazers of a village (stage ≥ 3; none in the town): two groups of three to six in the ring 1.05–1.35 radii from
 * its centre, each where there is no water and no strip of any line; heights from the surface once. Cached per site.
 */
export function siteStands(plan: WorldPlan, stage: number, site: number): Stand[] {
  return cached(standCache, plan, site * 8 + Math.min(7, stage), () => {
    const S = plan.sites;
    if (!S || stage < STAGE.sites || site < 0 || site >= S.count || S.kind[site] !== SITE_KIND.village) return [];
    const scope = scopeOf(plan, stage);
    const f = siteFrame(plan, site);
    const R = plan.grid.radiusM;
    const r = S.radiusM[site]!;
    const sc: [number, number] = [0, 0];
    const out: Stand[] = [];
    for (let g = 0; g < 2; g++) {
      const h = (j: number, m = 0): number => hashInts(plan.seed, SALT_STAND, site, g, m, j);
      detSinCosTurns(0.5 * g + 0.35 * unit(h(0)), sc);
      const ring = r * range(unit(h(1)), 1.05, 1.35);
      const cx = ring * sc[1];
      const cz = ring * sc[0];
      const count = 3 + Math.floor(unit(h(2)) * 4);
      for (let m = 0; m < count; m++) {
        for (let tries = 0; tries < 4; tries++) {
          detSinCosTurns(unit(h(3 + tries, m)), sc);
          const d = range(unit(h(10 + tries, m)), 1.5, 7);
          const p = sitePoint(f, cx + d * sc[1], cz + d * sc[0]);
          const x = p.dir[0] * R;
          const y = p.dir[1] * R;
          const z = p.dir[2] * R;
          if (planWater(scope, x, y, z).kind !== 0) continue;
          const hit = planStripHit(scope, x, y, z);
          if (hit && hit.share > 0) continue;
          detSinCosTurns(unit(h(20 + tries, m)), sc);
          const e = f.east;
          const nn = f.north;
          const hx = e[0] * sc[1] + nn[0] * sc[0];
          const hy = e[1] * sc[1] + nn[1] * sc[0];
          const hz = e[2] * sc[1] + nn[2] * sc[0];
          out.push({ kind: CREATURE.grazer, seed: h(30, m) >>> 0, dir: p.dir, heightM: planSurface(scope, x, y, z), heading: tangent(p.dir, hx, hy, hz) });
          break;
        }
      }
    }
    return out;
  });
}

/** `(x, y, z)` made square to the unit `dir` and unit; null-safe (a vector along `dir` gives any tangent). */
function tangent(dir: Vec3, x: number, y: number, z: number): Vec3 {
  const k = x * dir[0] + y * dir[1] + z * dir[2];
  let tx = x - k * dir[0];
  let ty = y - k * dir[1];
  let tz = z - k * dir[2];
  let l = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (!(l > 1e-12)) {
    tx = -dir[2];
    ty = 0;
    tz = dir[0];
    l = Math.sqrt(tx * tx + tz * tz) || 1;
  }
  return [tx / l, ty / l, tz / l];
}

// --- When ---------------------------------------------------------------------------------------------------------

/** One leg of a walk: its length, the ramp and its time. */
function legOf(w: Walk): { L: number; ramp: number; T: number } {
  const L = Math.max(0, w.lengthM - w.spreadM);
  const ramp = Math.min(RAMP_S, L / w.speed);
  return { L, ramp, T: L / w.speed + ramp };
}

/** The period of a walk: there, stand, back, stand. */
function periodS(w: Walk): number {
  const leg = legOf(w);
  return 2 * leg.T + w.dwellS[0] + w.dwellS[1];
}

const smooth01 = (x: number): number => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};

const scratch = { a: newPoint(), b: newPoint(), c: newPoint() };
const sc2: [number, number] = [0, 0];

/**
 * The pose of a walk at `timeS` (closed form). With `eye` given, returns false without finishing the pose when the
 * walker is farther than `reachM` from it.
 */
function placeWalk(plan: WorldPlan, w: Walk, timeS: number, out: LifePose, eye: Vec3 | null, reachM: number): boolean {
  const leg = legOf(w);
  const d0 = w.dwellS[0];
  const d1 = w.dwellS[1];
  const T = 2 * leg.T + d0 + d1;
  const x0 = timeS + w.offsetS;
  const tau = T > 0 ? x0 - Math.floor(x0 / T) * T : 0;
  /** Metres and speed `t` seconds into a leg. */
  const along = (t: number): [number, number] => {
    const v = w.speed;
    const r = leg.ramp;
    if (r <= 0) return [0, 0];
    const a = v / r;
    if (t < r) return [0.5 * a * t * t, a * t];
    if (t < leg.T - r) return [0.5 * v * r + v * (t - r), v];
    const u = Math.max(0, leg.T - t);
    return [leg.L - 0.5 * a * u * u, a * u];
  };
  const back = w.spreadM - w.aheadM;
  let p: number;
  let travel = 1;
  let turn = -1;
  let dist = 0;
  let speed = 0;
  if (tau < d0) {
    // Standing at the start: turning from the way back to the way out, changing places in a party.
    turn = smooth01(tau / d0);
    p = back + (w.aheadM - back) * turn;
    travel = -1;
  } else if (tau < d0 + leg.T) {
    [dist, speed] = along(tau - d0);
    p = dist + w.aheadM;
  } else if (tau < d0 + leg.T + d1) {
    turn = smooth01((tau - d0 - leg.T) / d1);
    p = leg.L + w.aheadM + (back - w.aheadM) * turn;
  } else {
    [dist, speed] = along(tau - d0 - leg.T - d1);
    p = leg.L - dist + back;
    travel = -1;
  }
  const R = plan.grid.radiusM;
  const c = scratch.c;
  pathPointInto(plan, w, p, c);
  if (eye) {
    const r0 = R + c.gradeM;
    const dx = c.dir[0] * r0 - eye[0];
    const dy = c.dir[1] * r0 - eye[1];
    const dz = c.dir[2] * r0 - eye[2];
    if (dx * dx + dy * dy + dz * dz > reachM * reachM) return false;
  }
  // The heading along the path: the chord over a metre before and after, so joints and corners blend.
  const a = scratch.a;
  const b = scratch.b;
  pathPointInto(plan, w, p - CHORD_M, a);
  pathPointInto(plan, w, p + CHORD_M, b);
  let fwd: Vec3;
  let slope = 0;
  const cx = (b.dir[0] - a.dir[0]) * R;
  const cy = (b.dir[1] - a.dir[1]) * R;
  const cz = (b.dir[2] - a.dir[2]) * R;
  const chord = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (chord > 1e-3) {
    fwd = tangent(c.dir, cx, cy, cz);
    slope = (b.gradeM - a.gradeM) / chord;
  } else fwd = tangent(c.dir, c.heading[0], c.heading[1], c.heading[2]);
  // Heading: along travel, or turning half a turn to the right while standing at an end.
  let hx = fwd[0] * travel;
  let hy = fwd[1] * travel;
  let hz = fwd[2] * travel;
  if (turn >= 0) {
    detSinCosTurns(0.5 * turn, sc2);
    // right = heading × up
    const rx = hy * c.dir[2] - hz * c.dir[1];
    const ry = hz * c.dir[0] - hx * c.dir[2];
    const rz = hx * c.dir[1] - hy * c.dir[0];
    hx = hx * sc2[1] + rx * sc2[0];
    hy = hy * sc2[1] + ry * sc2[0];
    hz = hz * sc2[1] + rz * sc2[0];
  }
  const h = tangent(c.dir, hx, hy, hz);
  // To the right of the heading by sideM; height from the drawn section there.
  const rx = h[1] * c.dir[2] - h[2] * c.dir[1];
  const ry = h[2] * c.dir[0] - h[0] * c.dir[2];
  const rz = h[0] * c.dir[1] - h[1] * c.dir[0];
  const lx = fwd[1] * c.dir[2] - fwd[2] * c.dir[1];
  const ly = fwd[2] * c.dir[0] - fwd[0] * c.dir[2];
  const lz = fwd[0] * c.dir[1] - fwd[1] * c.dir[0];
  const acrossM = w.sideM * (rx * lx + ry * ly + rz * lz);
  const px = c.dir[0] * R + rx * w.sideM;
  const py = c.dir[1] * R + ry * w.sideM;
  const pz = c.dir[2] * R + rz * w.sideM;
  const pl = Math.sqrt(px * px + py * py + pz * pz);
  const d = out.dir as [number, number, number];
  d[0] = px / pl;
  d[1] = py / pl;
  d[2] = pz / pl;
  const hh = tangent(d, h[0], h[1], h[2]);
  const o = out.heading as [number, number, number];
  o[0] = hh[0];
  o[1] = hh[1];
  o[2] = hh[2];
  out.kind = w.kind;
  out.seed = w.seed;
  out.heightM = c.gradeM + sectionUp(c.profile, c.halfM > 0 ? acrossM / c.halfM : 0);
  out.slope = turn >= 0 ? 0 : slope * travel;
  out.distanceM = dist;
  out.speed = speed;
  out.state = turn >= 0 || speed <= 0 ? 1 : 0;
  return true;
}

/** The pose of walk `w` at `timeS` seconds of the system's clock: there and back for ever, a closed form. */
export function walkPose(plan: WorldPlan, w: Walk, timeS: number, out: LifePose): void {
  placeWalk(plan, w, timeS, out, null, 0);
}

/** A fresh pose to fill. */
export function newPose(): LifePose {
  return { kind: 0, seed: 0, dir: [0, 0, 1], heightM: 0, heading: [1, 0, 0], slope: 0, distanceM: 0, speed: 0, state: 1 };
}

// --- Near the eye ---------------------------------------------------------------------------------------------------

/**
 * The sites whose centre lies within their radius + 450 m of the eye, and the routes with a road or deck line in the
 * tiles within 450 m of it; empty when the eye is more than 450 m above the surface. `eyeHeightM` is the eye's height
 * above the base sphere.
 */
export function lifeSet(plan: WorldPlan, stage: number, eyeDir: Vec3, eyeHeightM: number): LifeSet {
  const set: LifeSet = { sites: [], routes: [] };
  const S = plan.sites;
  if (!S || stage < STAGE.sites) return set;
  const R = plan.grid.radiusM;
  const scope = scopeOf(plan, stage);
  if (eyeHeightM - planSurface(scope, eyeDir[0] * R, eyeDir[1] * R, eyeDir[2] * R) > SET_REACH_M) return set;
  const er = R + eyeHeightM;
  const ex = eyeDir[0] * er;
  const ey = eyeDir[1] * er;
  const ez = eyeDir[2] * er;
  for (let s = 0; s < S.count; s++) {
    const r = R + S.heightM[s]!;
    const dx = S.dir[3 * s]! * r - ex;
    const dy = S.dir[3 * s + 1]! * r - ey;
    const dz = S.dir[3 * s + 2]! * r - ez;
    const reach = S.radiusM[s]! + SET_REACH_M;
    if (dx * dx + dy * dy + dz * dz <= reach * reach) set.sites.push(s);
  }
  if (stage >= STAGE.routes && plan.routes) {
    const L = plan.lines;
    const k0 = L.kindStart[LINE_KIND.road]!;
    const k1 = L.kindStart[LINE_KIND.deck + 1]!;
    const found = new Set<number>();
    // The eye's tile and those 450 m away in eight directions of the horizon.
    const east = tangent(eyeDir, -eyeDir[2], 0, eyeDir[0]);
    const north: Vec3 = [eyeDir[1] * east[2] - eyeDir[2] * east[1], eyeDir[2] * east[0] - eyeDir[0] * east[2], eyeDir[0] * east[1] - eyeDir[1] * east[0]];
    const probe = (u: number, v: number): void => {
      const x = eyeDir[0] * R + east[0] * u + north[0] * v;
      const y = eyeDir[1] * R + east[1] * u + north[1] * v;
      const z = eyeDir[2] * R + east[2] * u + north[2] * v;
      for (const l of tileLinesAtPoint(plan, stage, x, y, z)) if (l >= k0 && l < k1) found.add(L.owner[l]!);
    };
    probe(0, 0);
    for (let i = 0; i < 8; i++) {
      detSinCosTurns(i / 8, sc2);
      probe(SET_REACH_M * sc2[1], SET_REACH_M * sc2[0]);
    }
    set.routes = [...found].filter((r) => r < plan.routes!.count).sort((a, b) => a - b);
  }
  return set;
}

/**
 * The poses within `LIFE_RADIUS_M` of the eye (metres in the body's frame) at `timeS`, written to `out` in the order
 * sites (their walks, then their stands), routes (their walks); each kind stops at `CREATURE_CAP`, all at `LIFE_MAX`.
 * Returns the count; `counts.capped` (when given) gets the poses left out by the ceilings.
 */
export function lifeNear(plan: WorldPlan, stage: number, set: LifeSet, eye: Vec3, timeS: number, out: LifePose[], counts?: { capped: number }): number {
  const per = [0, 0, 0, 0];
  let n = 0;
  let capped = 0;
  const R2 = LIFE_RADIUS_M * LIFE_RADIUS_M;
  const R = plan.grid.radiusM;
  const room = (kind: number): boolean => {
    if (n >= LIFE_MAX || per[kind]! >= (CREATURE_CAP[kind] ?? 0)) {
      capped++;
      return false;
    }
    return true;
  };
  const walk = (w: Walk): void => {
    const pose = (out[n] ??= newPose());
    if (!placeWalk(plan, w, timeS, pose, eye, LIFE_RADIUS_M)) return;
    const r = R + pose.heightM;
    const dx = pose.dir[0] * r - eye[0];
    const dy = pose.dir[1] * r - eye[1];
    const dz = pose.dir[2] * r - eye[2];
    if (dx * dx + dy * dy + dz * dz > R2) return;
    if (!room(w.kind)) return;
    per[w.kind]!++;
    n++;
  };
  for (const s of set.sites) {
    for (const w of siteWalks(plan, s)) walk(w);
    for (const st of siteStands(plan, stage, s)) {
      const r = R + st.heightM;
      const dx = st.dir[0] * r - eye[0];
      const dy = st.dir[1] * r - eye[1];
      const dz = st.dir[2] * r - eye[2];
      if (dx * dx + dy * dy + dz * dz > R2 || !room(st.kind)) continue;
      const pose = (out[n] ??= newPose());
      pose.kind = st.kind;
      pose.seed = st.seed;
      (pose.dir as number[]).splice(0, 3, st.dir[0], st.dir[1], st.dir[2]);
      (pose.heading as number[]).splice(0, 3, st.heading[0], st.heading[1], st.heading[2]);
      pose.heightM = st.heightM;
      pose.slope = 0;
      pose.distanceM = 0;
      pose.speed = 0;
      pose.state = 1;
      per[st.kind]!++;
      n++;
    }
  }
  if (stage >= STAGE.routes) for (const r of set.routes) for (const w of routeWalks(plan, r)) walk(w);
  if (counts) counts.capped = capped;
  return n;
}
