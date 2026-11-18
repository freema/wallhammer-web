// The structures of the settlements of Hearth (stage 3): one structure per lot of every site, made from the lot's use,
// plus, round a town, a ring of line walls with towers on it. Every structure is a short list of parts of the
// structure generator (`gen-arch`) in metres of its own frame: y up along the body's radius at its point, z toward
// its lane, x to the right seen from the lane. Pure functions of the plan, the cluster and the item; no DOM and no
// worker API, so the page, a worker and Node give the same bytes.
//
// Clusters: one per site (its lots, then the ring of a town), then one per span of the routes (stage 4): the stone
// abutments at both ends of a deck, the piers under it and the parapets along both its edges. The deck itself is the
// strip of the routes. `clusterMassing` is the distant level of a cluster (one prism per part, turned into the body's
// axes, one mesh); `clusterFull` the full meshes of some of its items (both run in the workers, cell-worker.ts).

import { detSinCosTurns } from 'wallhammer-web/base';
import type { MeshData, StructureDesc, Vec3 } from 'wallhammer-web/base';
import { hashInts, lineRing, orientedBox, ringSignedArea, unit } from 'wallhammer-web/gen-core';
import type { Ring } from 'wallhammer-web/gen-core';
import { GROUND_FLOOR, MASSING_LAYOUT, ROOF_COVER, WALL_FINISH, WINDOW_STYLE, buildBuildingMesh, buildMassingMesh } from 'wallhammer-web/gen-arch';
import type { ArchDims, BuildingSpec, EntranceSpec, FacadeRecipe, PropBox, RoofKind, StructureOptions } from 'wallhammer-web/gen-arch';
import { BIOME } from './climate.ts';
import { planGround, planScope, planStripHit, planWater } from './ground.ts';
import type { Scope } from './ground.ts';
import { laneLengthM, lanePoint } from './plan-routes.ts';
import { SITE_KIND } from './plan.ts';
import type { WorldPlan } from './plan.ts';
import { LOT_USE, settlementOf, sitePoint } from './settlement.ts';
import type { Lot, SiteFrame } from './settlement.ts';

export const STRUCTURE_KIND = { cottage: 0, house: 1, farmstead: 2, workshop: 3, hall: 4, mill: 5, tower: 6, pier: 7, parapet: 8, rampart: 9 } as const;
/** Names of the kinds, for the page. */
export const STRUCTURE_KIND_NAME: readonly string[] = ['cottage', 'house', 'farmstead', 'workshop', 'hall', 'mill', 'tower', 'pier', 'parapet', 'rampart'];

/** Hash stream of the structures (`hashInts(plan.seed, STRUCTURE_STREAM, cluster, item)`); choices use `7130 + k`. */
export const STRUCTURE_STREAM = 713;
const CHOICE = 7130;
/** Keys: `cluster * KEY_ITEMS + item`. */
export const KEY_ITEMS = 4096;

export const STRUCTURE_DIMS: ArchDims = {
  minWallHeight: 2.4,
  wallBelowGround: 0.8,
  floorHeightMin: 2.5,
  floorHeightMax: 9,
  parapetThickness: 0.35,
  roofSlopeMin: 0.32,
  roofSlopeMax: 1.7,
  // No procedural boxes on flat roofs.
  roofUnitMinRoofArea: 1e9,
  roofUnitAreaPerUnit: 1e9,
  roofUnitMaxCount: 0,
  roofUnitMinSize: 1,
  roofUnitMaxSize: 1,
  roofUnitMinHeight: 1,
  roofUnitMaxHeight: 1,
  plinthHeight: 0.4,
  wallBaseShadeHeight: 1.0,
  parapetHeight: 0.6,
};

/** Palette rows of the structures, appended after the page's own rows (`STRUCTURE_ROW_BASE` is the first index). */
export const STRUCTURE_ROWS = {
  plaster: '#d6ccb4',
  plasterWarm: '#c9b08c',
  timber: '#5a4330',
  stone: '#918a7c',
  stoneDark: '#6c665c',
  boards: '#7a5c3e',
  thatch: '#a38a52',
  slate: '#4b4d57',
  shingle: '#6e4c37',
  trim: '#e0d9c8',
  plinth: '#5b554d',
  door: '#4a3b2e',
  shutter: '#3f5a40',
  chimney: '#6d5a4c',
  glass: '#22272c',
  glassLit: '#56646e',
} as const;
export const STRUCTURE_ROW_BASE = 1;
type Row = keyof typeof STRUCTURE_ROWS;
const ROW_KEYS = Object.keys(STRUCTURE_ROWS) as Row[];
export const row = (k: Row): number => STRUCTURE_ROW_BASE + ROW_KEYS.indexOf(k);

export interface StructureFrame {
  /** Unit vector from the body's centre, the frame's up. */
  origin: Vec3;
  /** Height of the frame's y = 0 above the base sphere, m. */
  heightM: number;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}
export interface StructureRecipe {
  /** `cluster * 4096 + item`; stable, the key of the damage table. */
  key: number;
  kind: number;
  hash: number;
  frame: StructureFrame;
  /** 1–4 parts in metres of the frame; `spec.id` = index. */
  specs: BuildingSpec[];
  /** Boxes that are not parts (the sail cross). */
  props: PropBox[];
  /** East m, north m in the site frame, height above the pad m, strength 0–1. */
  light: [number, number, number, number] | null;
}

// --- Small vector helpers (doubles) -----------------------------------------------------------------------------------

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.sqrt(dot(a, a)) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The scope of the page per plan (structures ask for the ground at any point). */
const scopes = new WeakMap<WorldPlan, Scope>();
export function structureScope(plan: WorldPlan): Scope {
  let s = scopes.get(plan);
  if (!s) {
    s = planScope(plan, plan.stage, null);
    scopes.set(plan, s);
  }
  return s;
}

/** A frame at the point of a site frame (east `x`, north `z`) whose z points along `head` (east, north). */
function frameAt(plan: WorldPlan, f: SiteFrame, x: number, z: number, hx: number, hz: number): StructureFrame {
  const p = sitePoint(f, x, z);
  const y = p.dir;
  const t: Vec3 = [f.east[0] * hx + f.north[0] * hz, f.east[1] * hx + f.north[1] * hz, f.east[2] * hx + f.north[2] * hz];
  const k = dot(t, y);
  const zz = norm([t[0] - y[0] * k, t[1] - y[1] * k, t[2] - y[2] * k]);
  const xx = cross(y, zz);
  const s = structureScope(plan);
  const R = plan.grid.radiusM;
  return { origin: y, heightM: planGround(s, y[0] * R, y[1] * R, y[2] * R), x: xx, y, z: zz };
}

/** Ground of a frame at its point (x, z), metres above its y = 0. The plan's ground takes points of the base sphere in metres. */
export function frameGround(plan: WorldPlan, scope: Scope, fr: StructureFrame): (x: number, z: number) => number {
  const R = plan.grid.radiusM;
  return (x: number, z: number): number => {
    const px = fr.origin[0] * R + fr.x[0] * x + fr.z[0] * z;
    const py = fr.origin[1] * R + fr.x[1] * x + fr.z[1] * z;
    const pz = fr.origin[2] * R + fr.x[2] * x + fr.z[2] * z;
    const k = R / Math.sqrt(px * px + py * py + pz * pz);
    return planGround(scope, px * k, py * k, pz * k) - fr.heightM;
  };
}

// --- Rings ---------------------------------------------------------------------------------------------------------

const ringOf = (pts: number[]): Ring => {
  const r = Float32Array.from(pts);
  if (ringSignedArea(r) > 0) return r;
  const out = new Float32Array(r.length);
  for (let i = 0; i < r.length / 2; i++) {
    out[i * 2] = r[r.length - 2 - i * 2]!;
    out[i * 2 + 1] = r[r.length - 1 - i * 2]!;
  }
  return out;
};
const rect = (x0: number, z0: number, x1: number, z1: number): Ring => ringOf([x0, z0, x1, z0, x1, z1, x0, z1]);
/** A regular polygon of `n` sides round (cx, cz), one side facing +z. */
function polygon(n: number, r: number, cx = 0, cz = 0): Ring {
  const pts: number[] = [];
  const sc: [number, number] = [0, 0];
  for (let i = 0; i < n; i++) {
    detSinCosTurns((i + 0.5) / n, sc);
    pts.push(cx + r * sc[0], cz + r * sc[1]);
  }
  return ringOf(pts);
}

// --- Kinds by lot --------------------------------------------------------------------------------------------------

const FILL_ORDER = [STRUCTURE_KIND.workshop, STRUCTURE_KIND.farmstead, STRUCTURE_KIND.mill, STRUCTURE_KIND.hall, STRUCTURE_KIND.tower, STRUCTURE_KIND.house, STRUCTURE_KIND.cottage];
const kindsCache = new WeakMap<WorldPlan, Map<number, Uint8Array>>();

/** The kind per lot of `settlementOf(plan, site)`, with at least five distinct kinds wherever the lots allow. */
export function siteKinds(plan: WorldPlan, site: number): Uint8Array {
  let m = kindsCache.get(plan);
  if (!m) kindsCache.set(plan, (m = new Map()));
  const hit = m.get(site);
  if (hit) return hit;
  const lots = settlementOf(plan, site).lots;
  const out = new Uint8Array(lots.length);
  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i]!;
    const h = hashInts(plan.seed, STRUCTURE_STREAM, site, i);
    switch (lot.use) {
      case LOT_USE.farm:
        out[i] = STRUCTURE_KIND.farmstead;
        break;
      case LOT_USE.work:
        out[i] = STRUCTURE_KIND.workshop;
        break;
      case LOT_USE.hall:
        out[i] = STRUCTURE_KIND.hall;
        break;
      case LOT_USE.mill:
        out[i] = STRUCTURE_KIND.mill;
        break;
      case LOT_USE.tower:
        out[i] = STRUCTURE_KIND.tower;
        break;
      default:
        out[i] = unit(hashInts(h, CHOICE)) < 0.5 ? STRUCTURE_KIND.cottage : STRUCTURE_KIND.house;
    }
  }
  const count = (k: number): number => out.reduce((n, v) => n + (v === k ? 1 : 0), 0);
  const distinct = (): number => new Set(out).size;
  while (distinct() < 5) {
    const missing = FILL_ORDER.find((k) => count(k) === 0);
    if (missing === undefined) break;
    let best = -1;
    let bestA = -1;
    for (let i = 0; i < lots.length; i++) {
      if (count(out[i]!) < 2) continue;
      const a = lots[i]!.widthM * lots[i]!.depthM;
      if (a > bestA) {
        bestA = a;
        best = i;
      }
    }
    if (best < 0) break;
    out[best] = missing;
  }
  m.set(site, out);
  return out;
}

// --- Recipes -------------------------------------------------------------------------------------------------------

interface Look {
  stone: boolean;
}

function facade(o: Partial<FacadeRecipe>): FacadeRecipe {
  return {
    groundFloorHeight: 3,
    groundFloor: GROUND_FLOOR.windows,
    plinthHeight: 0.4,
    window: { width: 0.9, height: 1.1, sill: 0.9, mullions: 1, transom: false, narrowMask: 0 },
    curtainShare: 0,
    blindShare: 0.15,
    panelJoints: false,
    blindEndWalls: 0,
    balconies: null,
    cornice: null,
    entrances: [],
    stairStrip: false,
    chimneys: 0,
    roofBoxes: null,
    colors: { frame: row('trim'), plinth: row('plinth'), door: row('door'), accent: row('shutter'), chimney: row('chimney') },
    ...o,
  };
}

interface PartIn {
  ring: Ring;
  roof: RoofKind;
  /** Base (floor level), eave and ridge in metres of the frame. */
  base: number;
  eave: number;
  ridge: number;
  levels: number;
  floorH: number;
  wall: number;
  roofColor: number;
  finish: number;
  cover: number;
  parapet?: number;
  style?: number;
  facade?: FacadeRecipe;
  group?: number;
  raised?: boolean;
  groundMin?: number;
}

/** One part; the wall foot reaches below the lowest ground under its ring unless `groundMin` is given. */
function part(id: number, hash: number, ground: (x: number, z: number) => number, p: PartIn): BuildingSpec {
  let gmin = Infinity;
  for (let i = 0; i < p.ring.length; i += 2) gmin = Math.min(gmin, ground(p.ring[i]!, p.ring[i + 1]!));
  return {
    id,
    hash: hashInts(hash, CHOICE + 90, id),
    rings: [p.ring],
    box: orientedBox(p.ring),
    groundMin: p.groundMin ?? Math.min(gmin, p.base),
    groundRef: p.base,
    eaveY: p.eave,
    ridgeY: p.ridge,
    roof: p.roof,
    ridgeAcross: false,
    levelsHint: p.levels,
    floorHeightNominal: p.floorH,
    bayWidth: 2.8,
    windowStyle: p.style ?? WINDOW_STYLE.punched,
    parapetHeight: p.parapet ?? 0,
    wallColor: p.wall,
    roofColor: p.roofColor,
    trimColor: row('trim'),
    roofUnitColor: row('chimney'),
    wallFinish: p.finish,
    roofCover: p.cover,
    ...(p.facade ? { facade: p.facade } : {}),
    ...(p.group ? { group: p.group } : {}),
    ...(p.raised ? { raised: true } : {}),
  };
}

const door = (x: number, z: number, kind: EntranceSpec['kind'], width: number): EntranceSpec => ({ x, z, kind, width, raise: 0.15, canopy: 0 });

/** The parts of a structure of `kind` with room `W` × `D` (x × z, front at +z). */
function partsOf(kind: number, hash: number, W: number, D: number, look: Look, ground: (x: number, z: number) => number): { specs: BuildingSpec[]; props: PropBox[] } {
  const ch = (k: number): number => unit(hashInts(hash, CHOICE + k));
  const g0 = ground(0, 0);
  const homeWall = look.stone ? row('stone') : ch(1) < 0.5 ? row('plaster') : row('plasterWarm');
  const homeFinish = look.stone ? WALL_FINISH.stone : WALL_FINISH.render;
  const specs: BuildingSpec[] = [];
  const props: PropBox[] = [];
  const shut = { width: 0.8, height: 1.0, sill: 0.9, mullions: 1 as const, transom: false, narrowMask: 0, shutters: true };
  switch (kind) {
    case STRUCTURE_KIND.cottage: {
      const w = Math.min(W, 7 + 2 * ch(2));
      const d = Math.min(D, 5.5 + ch(3));
      const slope = 1.2 + 0.3 * ch(4);
      const eave = g0 + 3;
      specs.push(
        part(0, hash, ground, {
          ring: rect(-w / 2, -d / 2, w / 2, d / 2),
          roof: 'gable',
          base: g0,
          eave,
          ridge: eave + slope * (d / 2),
          levels: 1,
          floorH: 2.8,
          wall: homeWall,
          roofColor: row('thatch'),
          finish: homeFinish,
          cover: ROOF_COVER.thatch,
          facade: facade({ window: shut, entrances: [door(w * (ch(5) - 0.5) * 0.4, d / 2, 'door', 1.0)], chimneys: 1 }),
        }),
      );
      break;
    }
    case STRUCTURE_KIND.house: {
      const w = Math.min(W - 0.9, 8 + 2 * ch(2));
      const d = Math.min(D - 0.45, 7 + ch(3));
      const lower = g0 + 3;
      const slope = 0.9 + 0.3 * ch(4);
      const group = 1;
      const finish = look.stone ? WALL_FINISH.stone : WALL_FINISH.frame;
      specs.push(
        part(0, hash, ground, {
          ring: rect(-w / 2, -d / 2, w / 2, d / 2),
          roof: 'flat',
          base: g0,
          eave: lower,
          ridge: lower,
          levels: 1,
          floorH: 3,
          wall: homeWall,
          roofColor: row('shingle'),
          finish: homeFinish,
          cover: ROOF_COVER.courses,
          group,
          facade: facade({ window: shut, cornice: { height: 0.25, projection: 0.45, underside: true }, entrances: [door(0, d / 2, 'door', 1.1)] }),
        }),
      );
      const o = 0.45;
      const up = d + o;
      const eave = lower + 2.8;
      specs.push(
        part(1, hash, ground, {
          ring: rect(-w / 2 - o, -d / 2, w / 2 + o, d / 2 + o),
          roof: 'gable',
          base: lower,
          groundMin: lower + STRUCTURE_DIMS.wallBelowGround - 0.25,
          eave,
          ridge: eave + slope * (Math.min(w + 2 * o, up) / 2),
          levels: 1,
          floorH: 2.8,
          wall: homeWall,
          roofColor: row('shingle'),
          finish,
          cover: ROOF_COVER.shingle,
          group,
          raised: true,
          facade: facade({ window: shut, plinthHeight: 0, groundFloorHeight: 2.8, chimneys: 1 }),
        }),
      );
      break;
    }
    case STRUCTURE_KIND.farmstead: {
      const d = Math.min(D, 6 + ch(3));
      const total = Math.min(W, 24);
      const barnW = total >= 18 ? Math.min(9, total * 0.38) : 0;
      const w = total - (barnW > 0 ? barnW + 1 : 0);
      const x0 = -total / 2;
      const eave = g0 + 2.8;
      specs.push(
        part(0, hash, ground, {
          ring: rect(x0, -d / 2, x0 + w, d / 2),
          roof: 'gable',
          base: g0,
          eave,
          ridge: eave + 1.2 * (d / 2),
          levels: 1,
          floorH: 2.8,
          wall: homeWall,
          roofColor: row('thatch'),
          finish: homeFinish,
          cover: ROOF_COVER.thatch,
          facade: facade({ window: shut, entrances: [door(x0 + w * 0.3, d / 2, 'door', 1.0)], chimneys: 1 }),
        }),
      );
      if (barnW > 0) {
        const bx = x0 + w + 1;
        const bd = Math.min(D, d + 1);
        const be = g0 + 4;
        specs.push(
          part(1, hash, ground, {
            ring: rect(bx, -bd / 2, bx + barnW, bd / 2),
            roof: 'gable',
            base: g0,
            eave: be,
            ridge: be + 0.9 * (bd / 2),
            levels: 1,
            floorH: 4,
            wall: row('boards'),
            roofColor: row('thatch'),
            finish: WALL_FINISH.boards,
            cover: ROOF_COVER.thatch,
            style: WINDOW_STYLE.none,
            facade: facade({ window: { width: 0, height: 0, sill: 1, mullions: 0, transom: false, narrowMask: 0 }, blindShare: 1, entrances: [door(bx + barnW / 2, bd / 2, 'garage', 2.8)] }),
          }),
        );
      }
      break;
    }
    case STRUCTURE_KIND.workshop: {
      const w = Math.min(W, 9 + 2 * ch(2));
      const d = Math.min(D, 7 + ch(3));
      const eave = g0 + 4;
      specs.push(
        part(0, hash, ground, {
          ring: rect(-w / 2, -d / 2, w / 2, d / 2),
          roof: 'gable',
          base: g0,
          eave,
          ridge: eave + 0.8 * (d / 2),
          levels: 1,
          floorH: 4,
          wall: row('stone'),
          roofColor: row('slate'),
          finish: WALL_FINISH.stone,
          cover: ROOF_COVER.slate,
          facade: facade({ entrances: [door(0, d / 2, 'door', 2.4)], chimneys: 2 }),
        }),
      );
      break;
    }
    case STRUCTURE_KIND.hall: {
      const w = Math.min(W, 22);
      const d = Math.min(D, 14);
      const eave = g0 + 9;
      const slope = 1.2 + 0.3 * ch(4);
      const span = Math.min(w, d) / 2;
      const ridge = eave + slope * span;
      const group = 1;
      specs.push(
        part(0, hash, ground, {
          ring: rect(-w / 2, -d / 2, w / 2, d / 2),
          roof: 'hip',
          base: g0,
          eave,
          ridge,
          levels: 2,
          floorH: 4.5,
          wall: look.stone ? row('stone') : row('plaster'),
          roofColor: row('slate'),
          finish: look.stone ? WALL_FINISH.stone : WALL_FINISH.render,
          cover: ROOF_COVER.slate,
          group,
          facade: facade({
            groundFloorHeight: 4.5,
            window: { width: 1.1, height: 2.2, sill: 1.1, mullions: 1, transom: true, narrowMask: 0, arch: true },
            cornice: { height: 0.4, projection: 0.3 },
            entrances: [door(0, d / 2, ch(5) < 0.5 ? 'arch' : 'portal', 2.6)],
          }),
        }),
      );
      // A turret on the ridge: it stands in the roof, its walls start inside the slopes.
      const t = 1.6;
      const tb = eave + slope * (span - t);
      specs.push(
        part(1, hash, ground, {
          ring: rect(-t, -t, t, t),
          roof: 'apex',
          base: tb,
          groundMin: tb,
          eave: ridge + 2.4,
          ridge: ridge + 5.4,
          levels: 1,
          floorH: 3,
          wall: look.stone ? row('stone') : row('plaster'),
          roofColor: row('slate'),
          finish: look.stone ? WALL_FINISH.stone : WALL_FINISH.render,
          cover: ROOF_COVER.slate,
          group,
          raised: true,
          style: WINDOW_STYLE.sparse,
          facade: facade({ plinthHeight: 0 }),
        }),
      );
      break;
    }
    case STRUCTURE_KIND.mill: {
      const r = Math.min(3.2, W / 2, D / 2);
      const eave = g0 + 9;
      specs.push(
        part(0, hash, ground, {
          ring: polygon(12, r),
          roof: 'apex',
          base: g0,
          eave,
          ridge: eave + 3.6,
          levels: 3,
          floorH: 3,
          wall: row('stone'),
          roofColor: row('shingle'),
          finish: WALL_FINISH.stone,
          cover: ROOF_COVER.shingle,
          style: WINDOW_STYLE.sparse,
          facade: facade({ window: { width: 0.6, height: 0.9, sill: 1.0, mullions: 0, transom: false, narrowMask: 0 }, blindShare: 0.5, entrances: [door(0, r, 'door', 1.0)] }),
        }),
      );
      // The sail cross: two thin boxes 0.4 m in front of the wall facing the lane.
      const hub = eave - 1.2;
      const arm = 6.5;
      const cz = r + 0.4;
      const sail = (vertical: boolean): PropBox => ({
        cx: 0,
        cz,
        baseY: vertical ? hub - arm : hub - 0.35,
        ux: 1,
        uz: 0,
        halfL: vertical ? 0.35 : arm,
        halfW: 0.12,
        height: vertical ? 2 * arm : 0.7,
        slope: 0,
        color: row('timber'),
        hash: hashInts(hash, CHOICE + 80, vertical ? 1 : 0),
      });
      props.push(sail(true), sail(false));
      break;
    }
    case STRUCTURE_KIND.tower: {
      const round = ch(2) < 0.5;
      const s = Math.min(3, W / 2, D / 2);
      const eave = g0 + 12;
      const cap = ch(3) < 0.5;
      specs.push(
        part(0, hash, ground, {
          ring: round ? polygon(12, s + 0.3) : rect(-s, -s, s, s),
          roof: cap ? 'apex' : 'flat',
          base: g0,
          eave,
          ridge: cap ? eave + 4 : eave,
          levels: 4,
          floorH: 3,
          wall: row('stone'),
          roofColor: cap ? row('slate') : row('stoneDark'),
          finish: WALL_FINISH.stone,
          cover: ROOF_COVER.slate,
          parapet: cap ? 0 : 1.1,
          style: WINDOW_STYLE.sparse,
          facade: facade({ window: { width: 0.5, height: 1.0, sill: 1.2, mullions: 0, transom: false, narrowMask: 0 }, blindShare: 0.5, entrances: [door(0, s, 'door', 1.0)] }),
        }),
      );
      break;
    }
  }
  return { specs, props };
}

/** A wall along the x axis of its frame, `L` m long: a ring 2.2 m wide, 6.5 m high, flat with a parapet. */
function rampartParts(hash: number, L: number, ground: (x: number, z: number) => number): BuildingSpec[] {
  const ring = lineRing([-L / 2, 0, L / 2, 0], 1.1);
  if (!ring) return [];
  const g = Math.min(ground(-L / 2, 0), ground(L / 2, 0), ground(0, 0));
  const top = Math.max(ground(-L / 2, 0), ground(L / 2, 0)) + 6.5;
  return [
    part(0, hash, ground, {
      ring,
      roof: 'flat',
      base: g,
      eave: top,
      ridge: top,
      levels: 2,
      floorH: 3.2,
      wall: row('stone'),
      roofColor: row('stoneDark'),
      finish: WALL_FINISH.stone,
      cover: ROOF_COVER.courses,
      parapet: 1.1,
      style: WINDOW_STYLE.none,
      facade: facade({ window: { width: 0, height: 0, sill: 1, mullions: 0, transom: false, narrowMask: 0 }, blindShare: 1 }),
    }),
  ];
}

/** Spans of the routes (stage 4), 0 below it. */
const spanCount = (plan: WorldPlan): number => (plan.sites ? (plan.routes?.spans.deck.length ?? 0) : 0);

/** Clusters: one per site, then one per span (`cluster - sites.count` is the span). */
export function clusterCount(plan: WorldPlan): number {
  return (plan.sites?.count ?? 0) + spanCount(plan);
}

export function clusterCentre(plan: WorldPlan, cluster: number): { dir: Vec3; heightM: number; radiusM: number } {
  const S = plan.sites!;
  if (cluster < S.count) return { dir: [S.dir[3 * cluster]!, S.dir[3 * cluster + 1]!, S.dir[3 * cluster + 2]!], heightM: S.heightM[cluster]!, radiusM: S.radiusM[cluster]! + 40 };
  const line = plan.routes!.spans.deck[cluster - S.count]!;
  const L = laneLengthM(plan, line);
  const p = lanePoint(plan, line, L / 2);
  return { dir: p.dir, heightM: p.heightM, radiusM: L / 2 + 20 };
}

// --- Spans ---------------------------------------------------------------------------------------------------------

/** Piers stand at most this far apart; abutments reach this far onto the bank; parapet pieces at most this long. */
const PIER_STEP_M = 14;
const ABUTMENT_M = 3;
const PARAPET_PIECE_M = 30;
/** A parapet piece is split further where the deck's grade changes more than this along it (its top is level). */
const PARAPET_RISE_M = 0.4;
/** Tops of piers and abutments under the deck's grade, and the least height worth a pier, m. */
const PIER_TOP_M = 0.35;
const PIER_MIN_M = 0.3;

/** A frame on a line point: y up there, x along the heading, z across (x = y × z); y = 0 at `heightM`. */
function lineFrame(dir: Vec3, heading: Vec3, heightM: number): StructureFrame {
  const y = norm(dir);
  const k = dot(heading, y);
  const x = norm([heading[0] - y[0] * k, heading[1] - y[1] * k, heading[2] - y[2] * k]);
  return { origin: y, heightM, x, y, z: cross(x, y) };
}

/** A plain stone block or wall without openings over `ring` in a frame, from `base` to a flat top at `top`. */
function stonePart(hash: number, ground: (x: number, z: number) => number, ring: Ring, base: number, top: number, groundMin?: number): BuildingSpec {
  return part(0, hash, ground, {
    ring,
    roof: 'flat',
    base,
    ...(groundMin !== undefined ? { groundMin } : {}),
    eave: top,
    ridge: top,
    levels: 1,
    floorH: Math.max(1, top - base),
    wall: row('stone'),
    roofColor: row('stoneDark'),
    finish: WALL_FINISH.stone,
    cover: ROOF_COVER.courses,
    style: WINDOW_STYLE.none,
    facade: facade({ window: { width: 0, height: 0, sill: 1, mullions: 0, transom: false, narrowMask: 0 }, blindShare: 1, plinthHeight: 0 }),
  });
}

/** The structures of a span cluster in item order: the two abutments, the piers, the parapets of one side, then the other. */
function spanRecipes(plan: WorldPlan, cluster: number): StructureRecipe[] {
  const span = cluster - plan.sites!.count;
  const sp = plan.routes!.spans;
  const line = sp.deck[span]!;
  const half = sp.widthM[span]! / 2;
  const total = laneLengthM(plan, line);
  const scope = structureScope(plan);
  const R = plan.grid.radiusM;
  const out: StructureRecipe[] = [];
  const push = (kind: number, frame: StructureFrame, make: (hash: number, ground: (x: number, z: number) => number) => BuildingSpec | null): void => {
    const item = out.length;
    const hash = hashInts(plan.seed, STRUCTURE_STREAM, cluster, item);
    const spec = make(hash, frameGround(plan, scope, frame));
    if (spec) out.push({ key: cluster * KEY_ITEMS + item, kind, hash, frame, specs: [spec], props: [], light: null });
  };
  const frameAtS = (s: number): StructureFrame => {
    const p = lanePoint(plan, line, s);
    return lineFrame(p.dir, p.heading, p.heightM);
  };
  const lowest = (ground: (x: number, z: number) => number, ring: Ring): number => {
    let g = Infinity;
    for (let i = 0; i < ring.length; i += 2) g = Math.min(g, ground(ring[i]!, ring[i + 1]!));
    return g;
  };
  const across = half + 0.2;
  // Abutments: a block at each end reaching onto the bank, its top under the deck.
  for (const end of [0, 1]) {
    push(STRUCTURE_KIND.pier, frameAtS(end === 0 ? 0 : total), (hash, ground) => {
      const ring = end === 0 ? rect(-ABUTMENT_M, -across, 1, across) : rect(-1, -across, ABUTMENT_M, across);
      const g = lowest(ground, ring);
      return -PIER_TOP_M - g < PIER_MIN_M ? null : stonePart(hash, ground, ring, g, -PIER_TOP_M);
    });
  }
  // Piers: evenly spaced, at most `PIER_STEP_M` apart, from the river bed to under the deck.
  const piers = Math.max(0, Math.ceil(total / PIER_STEP_M) - 1);
  for (let k = 1; k <= piers; k++) {
    push(STRUCTURE_KIND.pier, frameAtS((total * k) / (piers + 1)), (hash, ground) => {
      const ring = rect(-0.7, -across, 0.7, across);
      const g = lowest(ground, ring);
      return -PIER_TOP_M - g < PIER_MIN_M ? null : stonePart(hash, ground, ring, g, -PIER_TOP_M);
    });
  }
  // Parapets: a wall 0.45 m wide just inside each edge, from 0.1 m under the deck to 1 m over it, in level pieces.
  let lo = Infinity;
  let hi = -Infinity;
  for (let s = 0; s <= total; s += 5) {
    const h = lanePoint(plan, line, s).heightM;
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  const pieces = Math.max(1, Math.min(Math.floor(total / 4), Math.max(Math.ceil(total / PARAPET_PIECE_M), Math.ceil((hi - lo) / PARAPET_RISE_M))));
  const off = half - 0.225 - 0.05;
  for (const side of [-1, 1]) {
    for (let k = 0; k < pieces; k++) {
      const s0 = (total * k) / pieces;
      const s1 = (total * (k + 1)) / pieces;
      const frame = frameAtS((s0 + s1) / 2);
      const O: Vec3 = [frame.origin[0] * (R + frame.heightM), frame.origin[1] * (R + frame.heightM), frame.origin[2] * (R + frame.heightM)];
      const n = Math.max(2, Math.ceil((s1 - s0) / 5) + 1);
      const pts: number[] = [];
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const p = lanePoint(plan, line, s0 + ((s1 - s0) * i) / (n - 1));
        const side3 = norm(cross(p.heading, p.dir));
        const r = R + p.heightM;
        const P: Vec3 = [p.dir[0] * r + side3[0] * off * side - O[0], p.dir[1] * r + side3[1] * off * side - O[1], p.dir[2] * r + side3[2] * off * side - O[2]];
        pts.push(dot(P, frame.x), dot(P, frame.z));
        const y = dot(P, frame.y);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      push(STRUCTURE_KIND.parapet, frame, (hash, ground) => {
        const ring = lineRing(pts, 0.225);
        return ring ? stonePart(hash, ground, ring, y0 - 0.1, y1 + 1.0, y0 - 0.1) : null;
      });
    }
  }
  return out;
}

const lookOf = (plan: WorldPlan, site: number): Look => {
  const b = plan.sites!.biome[site]!;
  return { stone: b === BIOME.tundra || b === BIOME.rock };
};

/** The structure of a lot of a site. */
export function structureFor(lot: Lot, site: number, plan: WorldPlan): StructureRecipe {
  const s = settlementOf(plan, site);
  const item = s.lots.indexOf(lot);
  const kind = siteKinds(plan, site)[item < 0 ? lot.id : item]!;
  return lotRecipe(plan, site, s.frame, lot, item < 0 ? lot.id : item, kind);
}

function lotRecipe(plan: WorldPlan, site: number, f: SiteFrame, lot: Lot, item: number, kind: number): StructureRecipe {
  const hash = hashInts(plan.seed, STRUCTURE_STREAM, site, item);
  const W = Math.max(3, lot.widthM - 2);
  const D = Math.max(3, lot.depthM - 2);
  // The footprint's depth is known only after the recipe; stand it toward the front of the plot by its own size.
  const depthGuess = kind === STRUCTURE_KIND.hall ? Math.min(D, 14) : kind === STRUCTURE_KIND.mill || kind === STRUCTURE_KIND.tower ? Math.min(D, 7) : Math.min(D, 8);
  const shift = Math.max(0, lot.depthM / 2 - 1 - depthGuess / 2 - 1);
  const frame = frameAt(plan, f, lot.x + lot.hx * shift, lot.z + lot.hz * shift, lot.hx, lot.hz);
  const ground = frameGround(plan, structureScope(plan), frame);
  const { specs, props } = partsOf(kind, hash, W, Math.min(D, 2 * (lot.depthM / 2 - shift) - 2), lookOf(plan, site), ground);
  const lit = kind !== STRUCTURE_KIND.tower && kind !== STRUCTURE_KIND.mill;
  const ex = lot.x + lot.hx * shift;
  const nz = lot.z + lot.hz * shift;
  return { key: site * KEY_ITEMS + item, kind, hash, frame, specs, props, light: lit ? [ex, nz, 1.6, kind === STRUCTURE_KIND.hall ? 1 : 0.6] : null };
}

/** The ring round a town: its walls (items) and the towers on it. */
function ringRecipes(plan: WorldPlan, site: number, f: SiteFrame, first: number): StructureRecipe[] {
  const S = plan.sites!;
  if (S.kind[site] !== SITE_KIND.town) return [];
  const scope = structureScope(plan);
  const R = S.radiusM[site]! + 30;
  const n = Math.max(8, Math.round((2 * Math.PI * R) / 26));
  const sc: [number, number] = [0, 0];
  const nodes: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    detSinCosTurns(i / n, sc);
    nodes.push([R * sc[0], R * sc[1]]);
  }
  const RB = plan.grid.radiusM;
  const groundAt = (x: number, z: number): number => {
    const p = sitePoint(f, x, z);
    return planGround(scope, p.dir[0] * RB, p.dir[1] * RB, p.dir[2] * RB);
  };
  const free = (x: number, z: number): boolean => {
    const p = sitePoint(f, x, z);
    const [dx, dy, dz] = [p.dir[0] * RB, p.dir[1] * RB, p.dir[2] * RB];
    if (planWater(scope, dx, dy, dz).kind !== 0) return false;
    const h = planStripHit(scope, dx, dy, dz);
    return !(h && h.alongM >= 0 && Math.abs(h.acrossM) < h.halfWidthM + 4);
  };
  const kept: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const a = nodes[i]!;
    const b = nodes[(i + 1) % n]!;
    const L = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
    const steps = Math.max(1, Math.ceil(L / 4));
    let ok = Math.abs(groundAt(a[0], a[1]) - groundAt(b[0], b[1])) <= 4;
    for (let k = 0; ok && k <= steps; k++) ok = free(a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps);
    kept.push(ok);
  }
  const out: StructureRecipe[] = [];
  let item = first;
  for (let i = 0; i < n; i++) {
    const a = nodes[i]!;
    const b = nodes[(i + 1) % n]!;
    if (kept[i]) {
      const L = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[1] + b[1]) / 2;
      // z toward the centre; x along the wall then follows from the frame (x = y × z).
      const frame = frameAt(plan, f, mx, mz, -mx / R, -mz / R);
      const hash = hashInts(plan.seed, STRUCTURE_STREAM, site, item);
      const specs = rampartParts(hash, L + 0.6, frameGround(plan, scope, frame));
      if (specs.length) out.push({ key: site * KEY_ITEMS + item, kind: STRUCTURE_KIND.rampart, hash, frame, specs, props: [], light: null });
      item++;
    }
    if (i % 8 === 0 && (kept[i] || kept[(i + n - 1) % n])) {
      const frame = frameAt(plan, f, a[0], a[1], -a[0] / R, -a[1] / R);
      const hash = hashInts(plan.seed, STRUCTURE_STREAM, site, item);
      const { specs } = partsOf(STRUCTURE_KIND.tower, hash, 8, 8, { stone: true }, frameGround(plan, scope, frame));
      out.push({ key: site * KEY_ITEMS + item, kind: STRUCTURE_KIND.tower, hash, frame, specs, props: [], light: null });
      item++;
    }
  }
  return out;
}

const recipesCache = new WeakMap<WorldPlan, Map<number, StructureRecipe[]>>();

/** The structures of a cluster in item order: the lots by index, then the ring of a town; for a span its ends, piers and sides. */
export function clusterRecipes(plan: WorldPlan, cluster: number): StructureRecipe[] {
  let m = recipesCache.get(plan);
  if (!m) recipesCache.set(plan, (m = new Map()));
  const hit = m.get(cluster);
  if (hit) return hit;
  if (cluster >= plan.sites!.count) {
    const spans = spanRecipes(plan, cluster);
    m.set(cluster, spans);
    return spans;
  }
  const s = settlementOf(plan, cluster);
  const kinds = siteKinds(plan, cluster);
  const out = s.lots.map((lot, i) => lotRecipe(plan, cluster, s.frame, lot, i, kinds[i]!));
  out.push(...ringRecipes(plan, cluster, s.frame, out.length));
  m.set(cluster, out);
  return out;
}

/** 4 numbers per recipe with a light, in item order: east m, north m, height above the pad m, strength 0–1. */
export function structureLights(plan: WorldPlan, site: number): Float32Array {
  const lights = clusterRecipes(plan, site).flatMap((r) => r.light ?? []);
  return Float32Array.from(lights);
}

/** The recipe of a key (null when its cluster has no such item). */
export function recipeByKey(plan: WorldPlan, key: number): StructureRecipe | null {
  const cluster = Math.floor(key / KEY_ITEMS);
  if (cluster >= clusterCount(plan)) return null;
  return clusterRecipes(plan, cluster).find((r) => r.key === key) ?? null;
}

/** The distant level of a cluster: `MASSING_LAYOUT`, vertices in metres from `clusterCentre` in the body's axes. */
export interface ClusterMassing {
  mesh: MeshData;
  /** First vertex of every item (in the order of `clusterRecipes`); the last entry is the vertex count. */
  spans: Uint32Array;
  /** First index of every item; the last entry is the index count. */
  indexSpans: Uint32Array;
  /** Key of every item. */
  keys: Uint32Array;
}

/**
 * The massing of a cluster: `buildMassingMesh` per recipe in its frame, its positions and normals turned into the axes
 * of the body (doubles, then float32 relative to the cluster's centre), all recipes in one indexed mesh.
 */
export function clusterMassing(plan: WorldPlan, cluster: number): ClusterMassing {
  const recipes = clusterRecipes(plan, cluster);
  const c = clusterCentre(plan, cluster);
  const R = plan.grid.radiusM;
  const C: Vec3 = [c.dir[0] * (R + c.heightM), c.dir[1] * (R + c.heightM), c.dir[2] * (R + c.heightM)];
  const stride = MASSING_LAYOUT.stride;
  const parts = recipes.map((r) => buildMassingMesh(r.specs, STRUCTURE_DIMS).mesh);
  const vertexCount = parts.reduce((n, m) => n + m.vertices.byteLength / stride, 0);
  const indexCount = parts.reduce((n, m) => n + (m.indices?.length ?? 0), 0);
  const buf = new ArrayBuffer(vertexCount * stride);
  const bytes = new Uint8Array(buf);
  const f32 = new Float32Array(buf);
  const i8 = new Int8Array(buf);
  const indices = new Uint32Array(indexCount);
  const spans = new Uint32Array(recipes.length + 1);
  const indexSpans = new Uint32Array(recipes.length + 1);
  const keys = new Uint32Array(recipes.length);
  let v = 0;
  let ix = 0;
  recipes.forEach((r, i) => {
    const m = parts[i]!;
    const fr = r.frame;
    const rr = R + fr.heightM;
    const O: Vec3 = [fr.origin[0] * rr - C[0], fr.origin[1] * rr - C[1], fr.origin[2] * rr - C[2]];
    spans[i] = v;
    indexSpans[i] = ix;
    keys[i] = r.key;
    const n = m.vertices.byteLength / stride;
    bytes.set(new Uint8Array(m.vertices.buffer, m.vertices.byteOffset, n * stride), v * stride);
    for (let k = 0; k < n; k++) {
      const f = ((v + k) * stride) / 4;
      const x = f32[f]!;
      const y = f32[f + 1]!;
      const z = f32[f + 2]!;
      for (let a = 0; a < 3; a++) f32[f + a] = O[a]! + fr.x[a]! * x + fr.y[a]! * y + fr.z[a]! * z;
      const o = (v + k) * stride + 16;
      const nx = i8[o]! / 127;
      const ny = i8[o + 1]! / 127;
      const nz = i8[o + 2]! / 127;
      for (let a = 0; a < 3; a++) i8[o + a] = Math.max(-127, Math.min(127, Math.round((fr.x[a]! * nx + fr.y[a]! * ny + fr.z[a]! * nz) * 127)));
    }
    const src = m.indices ?? [];
    for (let k = 0; k < src.length; k++) indices[ix + k] = src[k]! + v;
    v += n;
    ix += src.length;
  });
  spans[recipes.length] = v;
  indexSpans[recipes.length] = ix;
  return { mesh: { layout: MASSING_LAYOUT, vertices: bytes, indices, count: ix }, spans, indexSpans, keys };
}

/** Intact full meshes of some items of a cluster (indices into `clusterRecipes`) with the descriptions of their parts. */
export function clusterFull(plan: WorldPlan, cluster: number, items: readonly number[]): { item: number; key: number; mesh: MeshData; descs: StructureDesc[] }[] {
  const recipes = clusterRecipes(plan, cluster);
  const scope = structureScope(plan);
  const out: { item: number; key: number; mesh: MeshData; descs: StructureDesc[] }[] = [];
  for (const item of items) {
    const r = recipes[item];
    if (!r) continue;
    const b = buildStructure(r, plan, scope, { describe: true });
    out.push({ item, key: r.key, mesh: b.mesh, descs: b.structures });
  }
  return out;
}

/** The mesh of one structure in its frame (`props` are left out by the caller once it is a ruin). */
export function buildStructure(r: StructureRecipe, plan: WorldPlan, scope: Scope, o: StructureOptions = {}, props = true): ReturnType<typeof buildBuildingMesh> {
  return buildBuildingMesh(r.specs, props ? r.props : [], frameGround(plan, scope, r.frame), STRUCTURE_DIMS, o);
}

/** Column-major matrix of a frame into render space (the frame's point minus the render origin, both in the body's frame). */
export function frameMatrix(plan: WorldPlan, fr: StructureFrame, renderOrigin: Vec3, out: Float32Array): Float32Array {
  const r = plan.grid.radiusM + fr.heightM;
  out.set([fr.x[0], fr.x[1], fr.x[2], 0, fr.y[0], fr.y[1], fr.y[2], 0, fr.z[0], fr.z[1], fr.z[2], 0]);
  out[12] = fr.origin[0] * r - renderOrigin[0];
  out[13] = fr.origin[1] * r - renderOrigin[1];
  out[14] = fr.origin[2] * r - renderOrigin[2];
  out[15] = 1;
  return out;
}
