// The ground of Hearth with its plan: one pure function of the point for every thread, level and cell, so cells,
// levels and threads agree without talking to each other. No DOM, no worker, no clock; arithmetic, Math.sqrt and the
// engine's noise only.
//
// The steps, in this order: the terrain's own ground (`groundHeight` of world.ts), the lake rule (plan-lakes.ts: the
// bed of a lake and a low dam where the real ground would let it leak), from stage 3 the pad of a site eased over its
// skirt, then `stripCarve` with the net of the point's tile (rivers from stage 1, lanes from stage 3). The lake is part
// of the natural ground; pads and strips are built on it. Water stands where the signed depth is above zero: of the
// lake whose domain holds the point `min(L − g, 300 · (q − Q0))`, of the sea `−g`; the larger counts.

import { stripCarve, stripNearest } from 'wallhammer-web/gen-core';
import type { CellId, StripHit, StripNet } from 'wallhammer-web/gen-core';
import { clearNet, inLineBall, lineNetAt, nearDeck, netLines, tileLinesAtPoint } from './plan-lines.ts';
import { LINE_KIND, STAGE } from './plan.ts';
import type { WorldPlan } from './plan.ts';
import { fieldRadiusM, padSkirtM, siteFrame, siteLocal } from './settlement.ts';
import type { SiteFrame } from './settlement.ts';
import { groundHeight } from './world.ts';
import { inLakeDomain, lakeAt, lakeBed, lakeBendSeed, lakeDepth, lakeHere } from './plan-lakes.ts';

/** Objects keep this far outside the radius of a site; fields stronger than this share keep them out too. */
const SITE_CLEAR_M = 10;
const FIELD_CLEAR = 0.5;
/** Objects keep this far from the edge of a deck (stage 4). */
const DECK_CLEAR_M = 1;
/** Fields fade from this share of their radius to the radius, and where the own ground is this far off the pad (m). */
const FIELD_FADE_FROM = 0.8;
const FIELD_OFF_FROM_M = 25;
const FIELD_OFF_M = 40;

/** What a thread derives once from the sites of a plan: frames, radii, skirts, field radii, centres in metres. */
interface SiteRing {
  frames: SiteFrame[];
  radiusM: Float64Array;
  skirtM: Float64Array;
  fieldM: Float64Array;
  centre: Float64Array;
}
const ringsOf = new WeakMap<WorldPlan, SiteRing>();

function siteRing(plan: WorldPlan): SiteRing {
  let r = ringsOf.get(plan);
  if (r) return r;
  const s = plan.sites!;
  const R = plan.grid.radiusM;
  const frames: SiteFrame[] = [];
  const radiusM = new Float64Array(s.count);
  const skirtM = new Float64Array(s.count);
  const fieldM = new Float64Array(s.count);
  const centre = new Float64Array(3 * s.count);
  for (let i = 0; i < s.count; i++) {
    const f = siteFrame(plan, i);
    frames.push(f);
    radiusM[i] = s.radiusM[i]!;
    skirtM[i] = padSkirtM(s.kind[i]!);
    fieldM[i] = fieldRadiusM(plan, i);
    centre[3 * i] = f.origin[0] * R;
    centre[3 * i + 1] = f.origin[1] * R;
    centre[3 * i + 2] = f.origin[2] * R;
  }
  r = { frames, radiusM, skirtM, fieldM, centre };
  ringsOf.set(plan, r);
  return r;
}

/** The site whose fields reach a point (sites lie 9 km apart, so at most one), or null. */
function siteNear(plan: WorldPlan, x: number, y: number, z: number): { site: number; x: number; z: number; d: number } | null {
  const ring = siteRing(plan);
  const R = plan.grid.radiusM;
  const l = Math.sqrt(x * x + y * y + z * z);
  if (!(l > 0)) return null;
  const px = (x / l) * R;
  const py = (y / l) * R;
  const pz = (z / l) * R;
  for (let i = 0; i < ring.frames.length; i++) {
    const reach = ring.fieldM[i]! + 50;
    const dx = px - ring.centre[3 * i]!;
    const dy = py - ring.centre[3 * i + 1]!;
    const dz = pz - ring.centre[3 * i + 2]!;
    if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
    const q = siteLocal(ring.frames[i]!, x, y, z);
    return { site: i, x: q.x, z: q.z, d: Math.sqrt(q.x * q.x + q.z * q.z) };
  }
  return null;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Everything known about one point, computed once. */
interface Probe {
  x: number;
  y: number;
  z: number;
  /** The terrain's own ground. */
  own: number;
  /** The own ground after the lake rule (the natural ground). */
  natural: number;
  /** Ground before the strips cut it (natural ground with the pad of a site). */
  uncut: number;
  /** Level of the standing water at the point: the lake whose domain holds it, else the sea (0). */
  standing: number;
  /** Ground with the plan. */
  ground: number;
  /** Lake whose water stands at the point (−1: none) and its level. */
  lake: number;
  lakeLevel: number;
  /** Signed depth of the water at the point (m): the larger of the lake's and the sea's. */
  depth: number;
  /** The net of the tile, when a line of it can reach the point. */
  net: StripNet | null;
  /** Hit of `stripNearest`, asked for lazily (undefined: not asked yet). */
  hit: StripHit | null | undefined;
  /** Whether the point is clear of every strip, asked for lazily. */
  clear: boolean | undefined;
  /** Stage 3: the site near the point (−1: none), metres east and north of its centre, distance, pad height there. */
  site: number;
  siteX: number;
  siteZ: number;
  siteD: number;
  padM: number;
}

/** What can touch one cell; a cell's scope gives the same bits as the scope of any point (`null`). */
export interface Scope {
  readonly plan: WorldPlan;
  readonly stage: number;
  readonly cell: CellId | null;
  /** Seed of the bend of a lake's share (the shore noise). */
  readonly shoreSeed: number;
  /** Probes of a cell by point (a cell asks for its vertices again and again); null for the page's scope. */
  readonly memo: Map<string, Probe> | null;
  last: Probe | null;
}

/** The scope of a cell, or with `null` the scope of any point (the page). */
export function planScope(plan: WorldPlan, stage: number, cell: CellId | null): Scope {
  return { plan, stage, cell, shoreSeed: lakeBendSeed(plan.seed), memo: cell ? new Map() : null, last: null };
}

const here = lakeHere();

function probe(s: Scope, x: number, y: number, z: number): Probe {
  const last = s.last;
  if (last && last.x === x && last.y === y && last.z === z) return last;
  const key = s.memo ? `${x},${y},${z}` : '';
  const known = s.memo?.get(key);
  if (known) return (s.last = known);
  const plan = s.plan;
  const own = groundHeight(plan.seed, x, y, z);
  // The lake rule: the bed of a lake and its dam, part of the natural ground.
  lakeAt(plan, s.shoreSeed, x, y, z, here);
  const natural = lakeBed(here, own);
  let g = natural;
  // Stage 3: the pad of a site, eased back to the own ground over its skirt (before the lines cut their lanes in it).
  let site = -1;
  let siteX = 0;
  let siteZ = 0;
  let siteD = 0;
  let padM = 0;
  if (s.stage >= STAGE.sites && plan.sites) {
    const near = siteNear(plan, x, y, z);
    if (near) {
      const ring = siteRing(plan);
      const f = ring.frames[near.site]!;
      site = near.site;
      siteX = near.x;
      siteZ = near.z;
      siteD = near.d;
      padM = f.heightM + f.tilt[0] * near.x + f.tilt[1] * near.z;
      const r = ring.radiusM[site]!;
      const w = 1 - smooth(r, r + ring.skirtM[site]!, near.d);
      if (w > 0) g = g + w * (padM - g);
    }
  }
  // Exact fast exit: no line of the tile has the point in its ball, so no net is built or asked.
  let net: StripNet | null = null;
  for (const l of tileLinesAtPoint(plan, s.stage, x, y, z)) {
    if (inLineBall(plan, l, x, y, z, s.stage)) {
      net = lineNetAt(plan, s.stage, x, y, z);
      break;
    }
  }
  const uncut = g;
  // The level of the standing water: the lake whose domain holds the point, else the sea.
  const standing = inLakeDomain(here) ? here.level : 0;
  if (net) {
    const cut = stripCarve(net, x, y, z, g);
    // Under standing water a strip only cuts: its fill fades out where the ground lies 0.2–1.2 m under the level, so
    // a river that runs through a lake or into the sea raises no bank across it. The same weight as the strip's fade.
    g = cut > g ? g + (cut - g) * (1 - smooth(0.2, 1.2, standing - g)) : cut;
  }
  // The water: the lake's signed depth over the final ground, the sea's, the larger counts.
  const dl = lakeDepth(here, g);
  const lake = dl > 0 ? here.lake : -1;
  const lakeLevel = dl > 0 ? here.level : 0;
  const depth = Math.max(dl, -g);
  const pr: Probe = { x, y, z, own, natural, uncut, standing, ground: g, lake, lakeLevel, depth, net, hit: undefined, clear: undefined, site, siteX, siteZ, siteD, padM };
  if (s.memo) s.memo.set(key, pr);
  s.last = pr;
  return pr;
}

function hitOf(pr: Probe): StripHit | null {
  if (pr.hit === undefined) pr.hit = pr.net ? stripNearest(pr.net, pr.x, pr.y, pr.z) : null;
  return pr.hit;
}

/** Height of the ground above the base sphere at a point of it (metres; under water below the water). */
export function planGround(s: Scope, x: number, y: number, z: number): number {
  return probe(s, x, y, z).ground;
}

/** The level of the lake whose domain holds a point (plan-lakes.ts, q > Q0), NaN outside every domain. */
export function planLakeHold(s: Scope, x: number, y: number, z: number): number {
  lakeAt(s.plan, s.shoreSeed, x, y, z, here);
  return inLakeDomain(here) ? here.level : NaN;
}

/**
 * How far a river strip has dissolved into the standing water at a point of its centre, 0–1: `smooth(0.2, 1.2, level
 * of the standing water − the ground there before the carve)`. 1 in the sea and deep in a lake, 0 on land.
 */
export function planStripFade(s: Scope, x: number, y: number, z: number): number {
  const pr = probe(s, x, y, z);
  return smooth(0.2, 1.2, pr.standing - pr.uncut);
}

/** The natural ground at a point: the terrain's own after the lake rule, before pads and strips (for colour and scree). */
export function planOwnGround(s: Scope, x: number, y: number, z: number): number {
  return probe(s, x, y, z).natural;
}

/** What is seen: the level of the water where its depth is above zero, else the ground. */
export function planSurface(s: Scope, x: number, y: number, z: number): number {
  const pr = probe(s, x, y, z);
  return pr.lake >= 0 ? pr.lakeLevel : pr.depth > 0 ? 0 : pr.ground;
}

/**
 * The water at a point: 0 none (level = the surface), 1 sea, 2 lake, 3 river (level = its grade); `depthM` the signed
 * depth of the standing water (lake or sea, the larger; negative on land).
 */
export function planWater(s: Scope, x: number, y: number, z: number): { kind: 0 | 1 | 2 | 3; levelM: number; depthM: number } {
  const pr = probe(s, x, y, z);
  if (pr.lake >= 0) return { kind: 2, levelM: pr.lakeLevel, depthM: pr.depth };
  if (pr.ground < 0) return { kind: 1, levelM: 0, depthM: pr.depth };
  const h = hitOf(pr);
  if (h && h.share >= 1 && isRiver(s.plan, pr.net!, h.line)) return { kind: 3, levelM: h.gradeM, depthM: pr.depth };
  return { kind: 0, levelM: pr.ground, depthM: pr.depth };
}

/** Whether line `line` of a net is a river (from stage 3 a net holds lanes too). */
function isRiver(plan: WorldPlan, net: StripNet, line: number): boolean {
  return netLines(net)[line]! < plan.lines.kindStart[LINE_KIND.river + 1]!;
}

/**
 * Stage 3: the site near a point and where the point lies in it: metres east (`x`) and north (`z`) of its centre, the
 * distance `d`, the height of its pad there, and the strength 0–1 of its fields (none inside its radius, none where the
 * own ground lies far off the pad, fading at the rim of the fields). Null away from every site or below stage 3.
 */
export function planSiteAt(s: Scope, x: number, y: number, z: number): { site: number; x: number; z: number; d: number; padM: number; field: number } | null {
  const pr = probe(s, x, y, z);
  if (pr.site < 0) return null;
  const ring = siteRing(s.plan);
  const r = ring.radiusM[pr.site]!;
  const F = ring.fieldM[pr.site]!;
  let field = 0;
  if (pr.siteD > r && pr.siteD < F && pr.depth <= 0) {
    field = (1 - smooth(FIELD_FADE_FROM * F, F, pr.siteD)) * smooth(r, r + ring.skirtM[pr.site]!, pr.siteD) * (1 - smooth(FIELD_OFF_FROM_M, FIELD_OFF_M, Math.abs(pr.own - pr.padM)));
  }
  return { site: pr.site, x: pr.siteX, z: pr.siteZ, d: pr.siteD, padM: pr.padM, field };
}

/** The hit of the nearest strip at a point (null where no line has a share). */
export function planStripHit(s: Scope, x: number, y: number, z: number): StripHit | null {
  return hitOf(probe(s, x, y, z));
}

/** The plan line of the nearest strip at a point (as `planStripHit` finds it), −1 where no line has a share. */
export function planStripLine(s: Scope, x: number, y: number, z: number): number {
  const pr = probe(s, x, y, z);
  const h = hitOf(pr);
  return h ? netLines(pr.net!)[h.line]! : -1;
}

/** True where an object may stand: no water and at least 2 m outside every strip. */
export function planClear(s: Scope, x: number, y: number, z: number): boolean {
  const pr = probe(s, x, y, z);
  if (pr.clear === undefined) {
    if (pr.depth > 0) pr.clear = false;
    else if (!pr.net) pr.clear = true;
    else {
      const h = hitOf(pr);
      pr.clear = !(h && h.share >= 1) && !stripNearest(clearNet(pr.net), pr.x, pr.y, pr.z);
    }
    // Stage 3: nothing of the wild stands in a settlement, its edge or its fields.
    if (pr.clear && pr.site >= 0) {
      if (pr.siteD < siteRing(s.plan).radiusM[pr.site]! + SITE_CLEAR_M) pr.clear = false;
      else if (planSiteAt(s, x, y, z)!.field > FIELD_CLEAR) pr.clear = false;
    }
    // Stage 4: nothing stands under a deck or within a metre of its edge (decks are not in the carving net).
    if (pr.clear && s.stage >= STAGE.routes && nearDeck(s.plan, x, y, z, DECK_CLEAR_M)) pr.clear = false;
  }
  return pr.clear;
}
