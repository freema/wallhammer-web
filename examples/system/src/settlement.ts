// A settlement of the plan of Hearth (stage 3): its frame on the sphere, the flat pad it stands on, and its lots,
// recomputed on any thread from the plan's bytes (the lots are never stored). A frame maps metres east and north of
// the site's centre onto the sphere and the tilted pad; every lot, structure and creature stands at its own point of
// it with its own up, so nothing floats at the far side of the town. Pure: arithmetic and Math.sqrt only.

import type { Vec3 } from 'wallhammer-web/base';
import { hashInts, unit } from 'wallhammer-web/gen-core';
import { plotsAlong } from 'wallhammer-web/gen-plan';
import { SURFACES } from './bodies.ts';
import { LINE_KIND, PLAN_BODY, SITE_KIND } from './plan.ts';
import type { WorldPlan } from './plan.ts';

/** The frame of a site: unit `origin` (its centre), `east` = spin axis × origin, `north` = origin × east; the pad. */
export interface SiteFrame {
  origin: Vec3;
  east: Vec3;
  north: Vec3;
  /** Height of the pad at the centre above the base sphere, m. */
  heightM: number;
  /** Slope of the pad east and north (rise per metre). */
  tilt: [number, number];
}

/** One lot of a settlement, in metres east (`x`) and north (`z`) of its centre. */
export interface Lot {
  id: number;
  x: number;
  z: number;
  /** Unit vector from the lot toward its lane. */
  hx: number;
  hz: number;
  widthM: number;
  depthM: number;
  /** What stands on it (`LOT_USE`). */
  use: number;
  /** Index of its lane in `plan.lines`. */
  line: number;
}

export const LOT_USE = { home: 0, farm: 1, work: 2, hall: 3, mill: 4, tower: 5 } as const;

export interface Settlement {
  site: number;
  frame: SiteFrame;
  /** The green of a village, the square of the town (centre and radius, metres). */
  green: { x: number; z: number; radiusM: number };
  /** Its lane lines, ascending plan indices. */
  lanes: number[];
  lots: Lot[];
}

/** Stream of the hashes of the sites (plan-sites.ts uses it too). */
export const SITE_STREAM = 0x51d0;
/** Radius of the square of the town, m. */
export const SQUARE_RADIUS_M = 40;

const radiusOfBody = (): number => SURFACES[PLAN_BODY]!.radiusM;

/** Radius of the green of a village (14–26 m) or of the square of the town. */
export function greenRadiusM(seed: number, site: number, kind: number): number {
  return kind === SITE_KIND.town ? SQUARE_RADIUS_M : 14 + 12 * unit(hashInts(seed, SITE_STREAM, site, 1));
}

/** The frame of a centre direction (any length) and a pad. */
export function frameOf(dx: number, dy: number, dz: number, heightM: number, tiltE: number, tiltN: number): SiteFrame {
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const o: Vec3 = [dx / l, dy / l, dz / l];
  // (0, 1, 0) × o
  const el = Math.sqrt(o[2] * o[2] + o[0] * o[0]);
  const e: Vec3 = [o[2] / el, 0, -o[0] / el];
  const n: Vec3 = [o[1] * e[2] - o[2] * e[1], o[2] * e[0] - o[0] * e[2], o[0] * e[1] - o[1] * e[0]];
  return { origin: o, east: e, north: n, heightM, tilt: [tiltE, tiltN] };
}

/** The frame of site `site` of the plan, from its bytes. */
export function siteFrame(plan: WorldPlan, site: number): SiteFrame {
  const s = plan.sites;
  if (!s || site < 0 || site >= s.count) throw new Error(`siteFrame: the plan has no site ${site}`);
  return frameOf(s.dir[3 * site]!, s.dir[3 * site + 1]!, s.dir[3 * site + 2]!, s.heightM[site]!, s.tilt[2 * site]!, s.tilt[2 * site + 1]!);
}

/** Metres east and north of the centre → the unit direction on the sphere and the height of the pad there. */
export function sitePoint(f: SiteFrame, x: number, z: number): { dir: Vec3; heightM: number } {
  const R = radiusOfBody();
  const px = f.origin[0] * R + f.east[0] * x + f.north[0] * z;
  const py = f.origin[1] * R + f.east[1] * x + f.north[1] * z;
  const pz = f.origin[2] * R + f.east[2] * x + f.north[2] * z;
  const l = Math.sqrt(px * px + py * py + pz * pz);
  return { dir: [px / l, py / l, pz / l], heightM: f.heightM + f.tilt[0] * x + f.tilt[1] * z };
}

/** A point of any length in the body's frame → metres east and north of the centre (the inverse of `sitePoint`). */
export function siteLocal(f: SiteFrame, x: number, y: number, z: number): { x: number; z: number } {
  const R = radiusOfBody();
  const o = x * f.origin[0] + y * f.origin[1] + z * f.origin[2];
  return { x: (R * (x * f.east[0] + y * f.east[1] + z * f.east[2])) / o, z: (R * (x * f.north[0] + y * f.north[1] + z * f.north[2])) / o };
}

/** Width of the skirt round a pad over which the ground eases from the pad back to its own height, m. */
export function padSkirtM(kind: number): number {
  return kind === SITE_KIND.town ? 120 : 40;
}

/** Radius of the ring of fields round a site: a village `600 + 2.5 · radius`, the town `3.2 · radius`, metres. */
export function fieldRadiusM(plan: WorldPlan, site: number): number {
  const s = plan.sites!;
  const r = s.radiusM[site]!;
  return s.kind[site] === SITE_KIND.town ? 3.2 * r : 600 + 2.5 * r;
}

/** Lots of a village and of the town: front and depth ranges, m. */
const VILLAGE_FRONT: readonly [number, number] = [14, 24];
const VILLAGE_DEPTH: readonly [number, number] = [22, 40];
const VILLAGE_DEPTH_SHARE = 0.3;
const TOWN_FRONT: readonly [number, number] = [10, 18];
const TOWN_DEPTH: readonly [number, number] = [18, 30];
/** Setback beyond the widest half-width of the lanes, gap between lots, room kept round the green, m. */
const SETBACK_EXTRA_M = 1.5;
const LOT_GAP_M = 1;
const GREEN_ROOM_M = 2;
/** A village holds at least this many lots; shares of `work` lots in a village and in the town. */
const MIN_VILLAGE_LOTS = 8;
const VILLAGE_WORK = 0.1;
const TOWN_WORK = 0.15;

const cache = new WeakMap<WorldPlan, Map<number, Settlement>>();

/** The lane lines of a site, ascending. */
export function siteLanes(plan: WorldPlan, site: number): number[] {
  const L = plan.lines;
  const out: number[] = [];
  for (let l = L.kindStart[LINE_KIND.lane]!; l < L.kindStart[LINE_KIND.lane + 1]!; l++) if (L.owner[l] === site) out.push(l);
  return out;
}

/** The settlement of site `site`: its frame, green, lanes and lots. Pure; cached per thread and plan. */
export function settlementOf(plan: WorldPlan, site: number): Settlement {
  let perPlan = cache.get(plan);
  if (!perPlan) {
    perPlan = new Map();
    cache.set(plan, perPlan);
  }
  const known = perPlan.get(site);
  if (known) return known;
  const s = plan.sites;
  if (!s || site < 0 || site >= s.count) throw new Error(`settlementOf: the plan has no site ${site}`);
  const L = plan.lines;
  const frame = siteFrame(plan, site);
  const kind = s.kind[site]!;
  const town = kind === SITE_KIND.town;
  const r = s.radiusM[site]!;
  const greenR = greenRadiusM(plan.seed, site, kind);
  const lanes = siteLanes(plan, site);
  let widest = 0;
  const flat = lanes.map((l) => {
    const a = L.start[l]!;
    const b = L.start[l + 1]!;
    const out = new Float64Array(2 * (b - a));
    for (let p = a; p < b; p++) {
      const q = siteLocal(frame, L.points[3 * p]!, L.points[3 * p + 1]!, L.points[3 * p + 2]!);
      out[2 * (p - a)] = q.x;
      out[2 * (p - a) + 1] = q.z;
      widest = Math.max(widest, L.halfWidth[p]!);
    }
    return out;
  });
  const blocked = (x: number, z: number): boolean => {
    const d = Math.sqrt(x * x + z * z);
    return d < greenR + GREEN_ROOM_M || d > r;
  };
  const seed = hashInts(plan.seed, SITE_STREAM, site);
  const front = town ? TOWN_FRONT : VILLAGE_FRONT;
  let depth: [number, number] = town ? [TOWN_DEPTH[0], TOWN_DEPTH[1]] : [Math.min(VILLAGE_DEPTH[0], VILLAGE_DEPTH_SHARE * r), Math.min(VILLAGE_DEPTH[1], VILLAGE_DEPTH_SHARE * r)];
  let lots: Lot[] = [];
  // A small village that cannot hold its lots gets shallower ones (never a larger radius).
  for (let tries = 0; tries < 6; tries++) {
    const plots = plotsAlong(flat, { frontM: front, depthM: depth, setbackM: widest + SETBACK_EXTRA_M, gapM: LOT_GAP_M, seed, blocked });
    lots = plots.map((p) => ({ id: p.id, x: p.x, z: p.z, hx: p.hx, hz: p.hz, widthM: p.widthM, depthM: p.depthM, use: LOT_USE.home, line: lanes[p.line]! }));
    if (town || lots.length >= MIN_VILLAGE_LOTS) break;
    depth = [Math.max(8, depth[0] * 0.8), Math.max(10, depth[1] * 0.8)];
  }
  assignUses(plan, site, town, lots);
  const result: Settlement = { site, frame, green: { x: 0, z: 0, radiusM: greenR }, lanes, lots };
  perPlan.set(site, result);
  return result;
}

/** The fixed rule of what stands on each lot. */
function assignUses(plan: WorldPlan, site: number, town: boolean, lots: Lot[]): void {
  if (lots.length === 0) return;
  const s = plan.sites!;
  const L = plan.lines;
  const frame = siteFrame(plan, site);
  const dist = (l: Lot): number => Math.sqrt(l.x * l.x + l.z * l.z);
  const taken = new Uint8Array(lots.length);
  /** The free lot with the least `key` (ties: the lower id), or −1. */
  const least = (key: (l: Lot) => number): number => {
    let best = -1;
    let bestKey = Infinity;
    for (const l of lots) {
      if (taken[l.id]) continue;
      const k = key(l);
      if (k < bestKey) {
        bestKey = k;
        best = l.id;
      }
    }
    return best;
  };
  const set = (id: number, use: number): void => {
    if (id < 0) return;
    lots[id]!.use = use;
    taken[id] = 1;
  };
  set(least(dist), LOT_USE.hall);
  if (town) {
    // A tower on the lot nearest each gate.
    for (let k = s.gates[site]!; k < s.gates[site + 1]!; k++) {
      const n = s.gateNodes[k]!;
      const g = siteLocal(frame, L.nodes[4 * n]!, L.nodes[4 * n + 1]!, L.nodes[4 * n + 2]!);
      set(least((l) => (l.x - g.x) * (l.x - g.x) + (l.z - g.z) * (l.z - g.z)), LOT_USE.tower);
    }
  } else {
    set(least((l) => -dist(l)), LOT_USE.mill);
    // The deepest third are farms.
    const free = lots.filter((l) => !taken[l.id]);
    const farms = Math.max(1, Math.floor(lots.length / 3));
    free.sort((a, b) => b.depthM - a.depthM || a.id - b.id);
    for (let i = 0; i < farms && i < free.length - 2; i++) set(free[i]!.id, LOT_USE.farm);
  }
  const share = town ? TOWN_WORK : VILLAGE_WORK;
  let work = 0;
  let firstFree = -1;
  let firstKey = Infinity;
  for (const l of lots) {
    if (taken[l.id]) continue;
    const u = unit(hashInts(plan.seed, SITE_STREAM, site, 2, l.id));
    if (u < share) {
      set(l.id, LOT_USE.work);
      work++;
    } else if (u < firstKey) {
      firstKey = u;
      firstFree = l.id;
    }
  }
  // At least one work lot, and a home left beside it.
  if (work === 0 && firstFree >= 0 && lots.some((l) => !taken[l.id] && l.id !== firstFree)) set(firstFree, LOT_USE.work);
}
