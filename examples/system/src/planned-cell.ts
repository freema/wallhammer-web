// A cell of Hearth with its plan (stage ≥ 1): the terrain with the lakes as surface, the rivers cut into the ground
// and a valley round them (ground.ts), no object or tree cover in water, and one mesh of material 'water' for the
// rivers: the strip tool's mesh of a view of the net with flat sections. Stage 5 adds the skyline codes of shade.ts to
// the terrain vertices, the objects and the strip vertices. Pure: (seed, cell, plan, stage) → content.
// No DOM, no worker, no clock.

import { stripMesh, STRIP_LAYOUT } from 'wallhammer-web/gen-mesh';
import type { CellContent, CellId, LocalBounds, SpherePatchOptions } from 'wallhammer-web/gen-core';
import type { MeshData, VertexLayout } from 'wallhammer-web/base';
import { detSinCosTurns } from 'wallhammer-web/base';
import { hashInts, unit } from 'wallhammer-web/gen-core';
import { planClear, planGround, planOwnGround, planScope, planSiteAt, planStripFade, planStripHit, planStripLine, planSurface, planWater } from './ground.ts';
import { CLASS_FROM_LEVEL, deckNetOfCell, lineLengthM, lineNetOfCell, meshNet, netLines, planStripSurface, riverRunM } from './plan-lines.ts';
import { LINE_KIND, PLAN_BODY, SITE_KIND, STAGE } from './plan.ts';
import { mainRoadLines } from './plan-routes.ts';
import { SITE_STREAM, greenRadiusM } from './settlement.ts';
import type { WorldPlan } from './plan.ts';
import { OBJECT_LAYOUT, ROOT_LEVEL, buildBodyCell, objectLevel } from './world.ts';
import { SURFACES } from './bodies.ts';
import { climateRules, frozenColor, frozenShare, landColor, landCover, plantThinning } from './climate.ts';
import { shadeCodeAt } from './shade.ts';

/** Stage 5: an object instance, `OBJECT_LAYOUT` followed by `i_extra`, the four skyline codes at its base point. */
export const OBJECT_EXTRA_LAYOUT: VertexLayout = {
  stride: OBJECT_LAYOUT.stride + 4,
  attribs: [...OBJECT_LAYOUT.attribs, { name: 'i_extra', size: 4, type: 'u8', normalized: true, offset: OBJECT_LAYOUT.stride }],
};

/** Stage 5: a vertex of a strip mesh (`water`, `way`), `STRIP_LAYOUT` followed by `a_extra`, the skyline codes there. */
export const STRIP_EXTRA_LAYOUT: VertexLayout = {
  stride: STRIP_LAYOUT.stride + 4,
  attribs: [...STRIP_LAYOUT.attribs, { name: 'a_extra', size: 4, type: 'u8', normalized: true, offset: STRIP_LAYOUT.stride }],
};

/**
 * Stage 5: `mesh` (in `STRIP_LAYOUT`, relative to `origin`) repacked into `STRIP_EXTRA_LAYOUT`, each vertex with the
 * codes at its own direction.
 */
function stripWithShade(plan: WorldPlan, mesh: MeshData, origin: readonly [number, number, number]): MeshData {
  const from = STRIP_LAYOUT.stride;
  const to = STRIP_EXTRA_LAYOUT.stride;
  const src = new Uint8Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const count = src.byteLength / from;
  const out = new Uint8Array(count * to);
  const code = new Uint8Array(4);
  for (let v = 0; v < count; v++) {
    out.set(src.subarray(v * from, (v + 1) * from), v * to);
    const x = view.getFloat32(v * from, true) + origin[0];
    const y = view.getFloat32(v * from + 4, true) + origin[1];
    const z = view.getFloat32(v * from + 8, true) + origin[2];
    shadeCodeAt(plan, x, y, z, code);
    out.set(code, v * to + from);
  }
  return { ...mesh, layout: STRIP_EXTRA_LAYOUT, vertices: out };
}

/**
 * Stage 5: instances in `OBJECT_LAYOUT` (relative to `origin`) repacked into `OBJECT_EXTRA_LAYOUT` with the codes at
 * each base point. Instances are floats to the culling, which copies them one float at a time: where the four bytes
 * would read as a NaN, the last is lowered by one so the copy keeps them.
 */
function instancesWithShade(plan: WorldPlan, data: Float32Array, origin: readonly [number, number, number]): Float32Array {
  const from = OBJECT_LAYOUT.stride / 4;
  const to = OBJECT_EXTRA_LAYOUT.stride / 4;
  const count = data.length / from;
  const out = new Float32Array(count * to);
  const bytes = new Uint8Array(out.buffer);
  const code = new Uint8Array(4);
  for (let i = 0; i < count; i++) {
    out.set(data.subarray(i * from, (i + 1) * from), i * to);
    shadeCodeAt(plan, data[i * from]! + origin[0], data[i * from + 1]! + origin[1], data[i * from + 2]! + origin[2], code);
    if ((code[3]! & 0x7f) === 0x7f && code[2]! >= 0x80) code[3] = code[3]! - 1;
    bytes.set(code, i * to * 4 + OBJECT_LAYOUT.stride);
  }
  return out;
}

type RGB = readonly [number, number, number];
/** Bed and bank of a river; bare rock and scree of a valley wall; sand of a shore and silt of a deep bed. */
const GRAVEL: RGB = [150, 140, 122];
const SCREE: RGB = [128, 120, 110];
const SAND: RGB = [172, 160, 124];
const SILT: RGB = [88, 84, 70];
/** The bank counts from this share of the strip; walls are bare from 6 m of cut, fully from 40 m. */
const BANK_SHARE = 0.85;
/** Raw earth of the bank where the shoulder of a way cuts or fills, from this much cut (m), fully from the second. */
const BANK_EARTH: RGB = [124, 104, 78];
const WAY_BANK_FROM_M = 0.5;
const WAY_BANK_FULL_M = 2.5;
/**
 * Paving of the ways (0–1; the way shader lays setts where it passes one half, along a ragged line): the town's
 * streets 1, a road 1 from this far inside the town's radius (m) fading to 0 this far outside (so its setts end about
 * 100 m outside); a village's lanes and the road through it this much, the road fading out this far outside the
 * village's radius.
 */
const TOWN_PAVING_IN_M = -40;
const TOWN_PAVING_OUT_M = 240;
const VILLAGE_PAVING = 0.6;
const VILLAGE_PAVING_OUT_M = 40;
const WALL_FROM_M = 6;
const WALL_FULL_M = 40;
/** Under water the bed turns to sand within the first metres and to silt toward this depth (m). */
const SAND_TO_M = 1.5;
const SILT_FROM_M = 1;
const SILT_TO_M = 14;

/**
 * The depth code of a terrain vertex (its colour's alpha): `clamp(round(32 + 8 · depth), 0, 255)`, −4 m … +27.9 m in
 * steps of 12.5 cm, land included. The fragment shader puts the waterline at its zero.
 */
export function depthCode(depthM: number): number {
  return Math.min(255, Math.max(0, Math.round(32 + 8 * depthM)));
}

/** How far a river strip has dissolved at its last metres: 1 at the end of its chain, 0 from 60 m before it. */
const END_FADE_M = 60;
/** Stage 3: the trodden ground of a settlement, the green of a village, the square of the town, three tones of fields. */
const YARD: RGB = [122, 112, 88];
const GREEN: RGB = [86, 124, 58];
const SQUARE: RGB = [172, 164, 146];
const FIELDS: readonly RGB[] = [
  [168, 152, 82],
  [104, 132, 58],
  [132, 106, 70],
];
/** A patch of field is this wide and long (m); the yard fades in over this many metres inside the radius. */
const FIELD_W_M = 60;
const FIELD_L_M = 180;
const YARD_EDGE_M = 15;

/** Stage 3: the colour of a settlement and its fields over the land's colour `c` at a point; a function of the point only. */
function siteColor(seed: number, c: readonly number[], at: { site: number; x: number; z: number; d: number; field: number }, kind: number, radiusM: number): readonly number[] {
  if (at.d <= radiusM) {
    let out = mix(c, YARD, 0.75 * (1 - smooth(radiusM - YARD_EDGE_M, radiusM, at.d)));
    const green = greenRadiusM(seed, at.site, kind);
    if (at.d < green) out = mix(out, kind === SITE_KIND.town ? SQUARE : GREEN, 1 - smooth(green - 3, green, at.d));
    return out;
  }
  if (at.field <= 0) return c;
  // A patchwork of strips turned by an angle of the site's own.
  const [sn, cs] = detSinCosTurns(unit(hashInts(seed, SITE_STREAM, at.site, 3)));
  const u = Math.floor((at.x * cs + at.z * sn) / FIELD_W_M);
  const v = Math.floor((-at.x * sn + at.z * cs) / FIELD_L_M);
  const tone = FIELDS[Math.min(2, Math.floor(3 * unit(hashInts(seed, SITE_STREAM, at.site, 4, u, v))))]!;
  return mix(c, tone, 0.8 * at.field);
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: readonly number[], b: RGB, k: number): [number, number, number] => [a[0]! + (b[0] - a[0]!) * k, a[1]! + (b[1] - a[1]!) * k, a[2]! + (b[2] - a[2]!) * k];
const bytes = (c: readonly number[], a: number): [number, number, number, number] => [Math.round(Math.min(255, Math.max(0, c[0]!))), Math.round(Math.min(255, Math.max(0, c[1]!))), Math.round(Math.min(255, Math.max(0, c[2]!))), a];

/** Lift of the water strip above the drawn surface of a level, from the level's vertex spacing (as the planet example). */
function liftOf(spacingM: number): number {
  return 0.05 + 0.08 * spacingM;
}

/** Added to the domain version of the cells with the climate (stage 2 on), whose trees reach the coarser levels. */
const THINNED_VERSION = 10;

/** Generates one cell of the body `packed` names with its plan. Throws unless the plan is of that body and holds `stage`. */
export function generateWorldCell(packed: number, cell: CellId, plan: WorldPlan, stage: number): CellContent {
  if (packed !== plan.seed) throw new Error(`generateWorldCell: the plan is of seed ${plan.seed}, the cell of ${packed}`);
  if (!(stage >= 1 && stage <= plan.stage)) throw new Error(`generateWorldCell: stage ${stage} is not in 1…${plan.stage}`);
  // Stage 5 is the cell of stage 4 with the skyline codes added to the terrain, the objects and the strips.
  return stage >= STAGE.shade ? worldCell(packed, cell, plan, STAGE.routes, true) : worldCell(packed, cell, plan, stage, false);
}

/** The cell of `stage` (1…4); with `shade` also the skyline codes of stage 5 (`shade.ts`). */
function worldCell(packed: number, cell: CellId, plan: WorldPlan, stage: number, shade: boolean): CellContent {
  const s = planScope(plan, stage, cell);
  const ground = (x: number, y: number, z: number): number => planGround(s, x, y, z);
  const surface = (x: number, y: number, z: number): number => planSurface(s, x, y, z);
  // From stage 2 the climate gives the colour of the land, the cover and the rules; the sea and the lakes freeze.
  const climate = stage >= STAGE.climate;
  // From stage 3 the settlements: their pads (ground.ts), colours, lanes and clear ground.
  const sites = stage >= STAGE.sites && plan.sites !== null;
  /** The origin of the cell, as `extra` gets it (for the codes of the objects). */
  let cellOrigin: readonly [number, number, number] | null = null;
  const code = new Uint8Array(4);
  const extraAt: NonNullable<SpherePatchOptions['extraAt']> = (x, y, z) => {
    shadeCodeAt(plan, x, y, z, code);
    return [code[0]!, code[1]!, code[2]!, code[3]!];
  };
  const riverEnd = plan.lines.kindStart[LINE_KIND.river + 1]!;
  const content = buildBodyCell(packed, cell, {
    // From stage 2 the trees also stand, thinned, in the three levels above the object level (climate.ts, `THIN_RANK`):
    // a version of its own.
    domainVersion: 1 + (shade ? STAGE.shade : stage) + (climate ? THINNED_VERSION : 0),
    ...(climate ? { rules: climateRules(s, SURFACES[PLAN_BODY]!.leafLevel), thin: plantThinning(packed, objectLevel(PLAN_BODY)) } : {}),
    patch: (own: SpherePatchOptions): SpherePatchOptions => {
      const terrainColor = own.colorAt!;
      const ownColor: NonNullable<SpherePatchOptions['colorAt']> = climate ? (x, y, z, h) => (h <= 0 ? terrainColor(x, y, z, h) : landColor(s, x, y, z, h)) : terrainColor;
      const ownCover: NonNullable<SpherePatchOptions['coverAt']> = climate ? (x, y, z, h) => landCover(s, x, y, z, h) : own.coverAt!;
      // rgb is the colour of the bed, also under water (no tint of water in a vertex); alpha the depth code.
      const colorAt: NonNullable<SpherePatchOptions['colorAt']> = (x, y, z) => {
        const water = planWater(s, x, y, z);
        const g = planGround(s, x, y, z);
        const code = depthCode(water.depthM);
        // The ground's own colour; at or under the sea's level (where the terrain gives the sea) sand.
        let c: readonly number[] = g > 0 ? ownColor(x, y, z, g) : SAND;
        if (c.length > 3 && c[3] === 255) c = SAND;
        if (water.depthM > 0) {
          const d = water.depthM;
          c = mix(mix(c, SAND, 0.7 * smooth(0, SAND_TO_M, d)), SILT, smooth(SILT_FROM_M, SILT_TO_M, d));
          return bytes(c, code);
        }
        const cut = planOwnGround(s, x, y, z) - g;
        c = mix(c, SCREE, smooth(WALL_FROM_M, WALL_FULL_M, cut) * 0.9);
        if (sites) {
          const at = planSiteAt(s, x, y, z);
          if (at) c = siteColor(packed, c, at, plan.sites!.kind[at.site]!, plan.sites!.radiusM[at.site]!);
        }
        const hit = planStripHit(s, x, y, z);
        if (hit) {
          if (planStripLine(s, x, y, z) < riverEnd) {
            if (hit.share > BANK_SHARE) c = mix(c, GRAVEL, smooth(BANK_SHARE, 1, hit.share));
          } else if (hit.share < 1) {
            // Beside a way the ground keeps its own colour (it shows through the worn edges of the way); where the
            // shoulder cuts into the slope or fills it the bank is raw earth, a cut more than a fill.
            const bank = smooth(WAY_BANK_FROM_M, WAY_BANK_FULL_M, Math.abs(cut)) * smooth(0, 0.2, hit.share);
            c = mix(c, BANK_EARTH, (cut > 0 ? 0.65 : 0.35) * bank);
          }
        }
        return bytes(c, code);
      };
      return {
        ...own,
        heightAt: surface,
        colorAt: climate
          ? (x, y, z, h) => {
              const c = colorAt(x, y, z, h);
              const kind = planWater(s, x, y, z).kind;
              return kind === 1 || kind === 2 ? frozenColor([c[0], c[1], c[2], c[3]], frozenShare(s, x, y, z)) : c;
            }
          : colorAt,
        coverAt: (x, y, z, h) => {
          const c = ownCover(x, y, z, h);
          if (!planClear(s, x, y, z)) return [c[0], c[1], c[2], 0];
          const thin = 1 - smooth(WALL_FROM_M, WALL_FULL_M, planOwnGround(s, x, y, z) - planGround(s, x, y, z));
          return [c[0], c[1], c[2], Math.round(c[3] * thin)];
        },
        ...(shade ? { extraAt } : {}),
      };
    },
    ground,
    // The rules of stage 2 ask `planClear` themselves (shards stand on frozen water).
    keepObject: (x, y, z) => climate || planClear(s, x, y, z),
    extra: (origin) => {
      const net = lineNetOfCell(plan, stage, cell);
      const out = [...riverMesh(net, origin), ...(sites ? wayMesh(net, origin) : [])];
      if (!shade) return out;
      cellOrigin = origin;
      return out.map((m) => ({ ...m, mesh: stripWithShade(plan, m.mesh, origin) }));
    },
  });
  if (!shade) return content;
  const o = cellOrigin as readonly [number, number, number] | null;
  if (!o) throw new Error('generateWorldCell: the cell gave no origin');
  return {
    ...content,
    instances: content.instances.map((b) => ({ ...b, data: { layout: OBJECT_EXTRA_LAYOUT, data: instancesWithShade(plan, b.data.data, o) } })),
  };

  function riverMesh(net: ReturnType<typeof lineNetOfCell>, origin: readonly [number, number, number]): { material: string; mesh: MeshData; bounds: LocalBounds }[] {
    {
      const view = net ? meshNet(net, plan, LINE_KIND.river, cell.level) : null;
      if (!view) return [];
      const strip = planStripSurface(plan, ground);
      const m = stripMesh(view, strip, cell, { coarsestLevel: ROOT_LEVEL, liftM: (level) => liftOf(strip.spacingM(level)) });
      if (!m) return [];
      // a_strip: y becomes the metres to the end of the water (the end of the chain), w the class (+4 on the coarsest
      // level that meshes it) plus 0.9 × the fade into standing water at the centre of the station (ground.ts,
      // `planStripFade`), at least the fade of the last metres of the chain, so no strip ends with a visible cut.
      const lines = netLines(view);
      const run = riverRunM(plan);
      const R = plan.grid.radiusM;
      const v = m.mesh.vertices;
      const f = new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
      const stride = STRIP_LAYOUT.stride / 4;
      for (let i = 0; i + stride <= f.length; i += stride) {
        const line = lines[Math.round(f[i + 10]!)]!;
        const c = Math.min(3, plan.lines.cls[line]!);
        const toEnd = run[line]! + lineLengthM(plan, line) - f[i + 8]!;
        f[i + 8] = Math.fround(toEnd);
        // The centre of the station: back across the section, on the base sphere.
        const k = Math.abs(f[i + 7]!) * f[i + 9]!;
        const cx = f[i]! + origin[0] - f[i + 4]! * k;
        const cy = f[i + 1]! + origin[1] - f[i + 5]! * k;
        const cz = f[i + 2]! + origin[2] - f[i + 6]! * k;
        const l = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
        const fade = Math.max(planStripFade(s, (cx / l) * R, (cy / l) * R, (cz / l) * R), 1 - smooth(0, END_FADE_M, toEnd));
        f[i + 10] = c + (c > 0 && cell.level === CLASS_FROM_LEVEL[c] ? 4 : 0) + 0.9 * fade;
      }
      return [{ material: 'water', mesh: m.mesh, bounds: m.bounds }];
    }
  }

  /**
   * Stage 3: the lanes of the cell as one mesh of material 'way', apart from the rivers. Stage 4: the lanes and roads in
   * one mesh, the decks in a second (from their own net, lifted a little more).
   */
  function wayMesh(net: ReturnType<typeof lineNetOfCell>, origin: readonly [number, number, number]): { material: string; mesh: MeshData; bounds: LocalBounds }[] {
    const routes = stage >= STAGE.routes;
    const out: { material: string; mesh: MeshData; bounds: LocalBounds }[] = [];
    const view = net ? meshNet(net, plan, LINE_KIND.lane, cell.level, routes ? LINE_KIND.road + 1 : LINE_KIND.lane + 1) : null;
    if (view) out.push(...wayOf(view, 0.5, origin));
    if (routes) {
      const decks = deckNetOfCell(plan, cell);
      const deckView = decks ? meshNet(decks, plan, LINE_KIND.deck, cell.level) : null;
      if (deckView) out.push(...wayOf(deckView, 0.75, origin));
    }
    return out;
  }

  /**
   * One way mesh of a view. a_strip: w becomes the code `class + 4 · coarsest + 8 · kind + 32 · main` (kind 0 lane, 1
   * road, 2 deck; coarsest: the coarsest level that meshes the line; main: a road or deck of a main road, `mainRoadLines`)
   * plus 0.9 × the share of paving at the centre of the station (`pavingAt`).
   */
  function wayOf(view: NonNullable<ReturnType<typeof meshNet>>, lift: number, origin: readonly [number, number, number]): { material: string; mesh: MeshData; bounds: LocalBounds }[] {
    const strip = planStripSurface(plan, ground);
    const m = stripMesh(view, strip, cell, { coarsestLevel: ROOT_LEVEL, liftM: (level) => lift * liftOf(strip.spacingM(level)) });
    if (!m) return [];
    const lines = netLines(view);
    const ks = plan.lines.kindStart;
    const main = stage >= STAGE.routes ? mainRoadLines(plan) : null;
    const R = plan.grid.radiusM;
    const v = m.mesh.vertices;
    const f = new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
    const stride = STRIP_LAYOUT.stride / 4;
    for (let i = 0; i + stride <= f.length; i += stride) {
      const line = lines[Math.round(f[i + 10]!)]!;
      const c = Math.min(3, plan.lines.cls[line]!);
      const kind = line >= ks[LINE_KIND.deck]! ? 2 : line >= ks[LINE_KIND.road]! ? 1 : 0;
      const big = kind > 0 && main && main[line] ? 1 : 0;
      let pave = 0;
      if (kind === 0) pave = c === 2 ? 1 : VILLAGE_PAVING;
      else if (kind === 1) {
        // The centre of the station: back across the section, on the base sphere.
        const k = Math.abs(f[i + 7]!) * f[i + 9]!;
        const cx = f[i]! + origin[0] - f[i + 4]! * k;
        const cy = f[i + 1]! + origin[1] - f[i + 5]! * k;
        const cz = f[i + 2]! + origin[2] - f[i + 6]! * k;
        const l = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
        pave = pavingAt((cx / l) * R, (cy / l) * R, (cz / l) * R);
      }
      f[i + 10] = c + (cell.level === CLASS_FROM_LEVEL[c] ? 4 : 0) + 8 * kind + 32 * big + 0.9 * pave;
    }
    return [{ material: 'way', mesh: m.mesh, bounds: m.bounds }];
  }

  /** Share of paving of a road at a point: full from the town's gates, fading out over the road toward it; less by a village. */
  function pavingAt(x: number, y: number, z: number): number {
    const at = planSiteAt(s, x, y, z);
    if (!at) return 0;
    const r = plan.sites!.radiusM[at.site]!;
    return plan.sites!.kind[at.site] === SITE_KIND.town ? 1 - smooth(r + TOWN_PAVING_IN_M, r + TOWN_PAVING_OUT_M, at.d) : VILLAGE_PAVING * (1 - smooth(r, r + VILLAGE_PAVING_OUT_M, at.d));
  }
}
