// Building specs and the parts of the building mesh: roofs by tier, superstructures on flat roofs, footprint edges,
// entrances with steps and canopies, chimneys, and the per-wall façade data for the shader. Windows, plinth and joints
// are not geometry: the generator writes the position on the wall into the vertices (metres along the wall, height
// above the floor base, height above the ground) and the shader draws the rest. The plan of one structure
// (`StructurePlan`) is defined here and shared by the intact mesh, the interior and the damage model. The mesh itself
// is assembled in the module root (../build.ts), which may use all three subfolders.

import { distToSegment, hashInts, unit } from '../../gen-core/index.ts';
import type { OrientedBox, Ring } from '../../gen-core/index.ts';
import type { PropBox } from '../../gen-mesh/index.ts';

export type { PropBox };
import { DOOR_KIND, FACADE_DIM, FACADE_FLAG, FootprintIndex, wallBoxCorners } from './facade.ts';
import type { CorniceRecipe, EntranceSpec, FacadeRecipe } from './facade.ts';
import { ROOF_PROFILE, apexRoof, fieldRoof, flatRoof, ridgeRoof } from './roof.ts';
import type { CreaseLine, RoofGeometry, RoofProfile } from './roof.ts';
import type { ArchMeshDims } from './dims.ts';
import { ARCH_WINDOW_BIT, BUILDING_ATTRIBS, BUILDING_LAYOUT, VertexWriter, boxInside, pushBox, wallBox } from './writer.ts';
import type { VertexMaterial, WallAttr } from './writer.ts';
import type { StructureState } from '../../base/index.ts';

export { BUILDING_ATTRIBS, BUILDING_LAYOUT };

/**
 * Roof kinds. `apex` rises from every edge of a convex footprint to a point above the box centre (pyramid, or a tall
 * pointed roof when the ridge height is large), `dome` is the same with a round profile, `mansard` is a hipped ridge
 * roof with two slopes per face. `apex` and `dome` need a convex footprint without holes; otherwise the roof is flat.
 */
export type RoofKind = 'flat' | 'gable' | 'hip' | 'field' | 'apex' | 'dome' | 'mansard';

/**
 * Options of the destructible structure model (damaged.ts). Without them the output is exactly the plain mesh; with an
 * all-intact state it is byte for byte the same as without.
 */
export interface StructureOptions {
  /** Also emit the destructible description (`StructureDesc`) of every structure. */
  describe?: boolean;
  /** Damage state per structure id. The per-part state vector is an explicit generator input. */
  states?: ReadonlyMap<number, StructureState>;
  /** Structures that events never change. */
  keepOut?: ReadonlySet<number>;
  /**
   * Emit only the structures at these indices of `specs` (and no props). The others still count as neighbours (shared
   * walls, balconies), so a structure comes out exactly as it does in the full mesh.
   */
  only?: ReadonlySet<number>;
  /** Also return the interior plan of every emitted structure (`interiors`, by structure id). It never changes the mesh. */
  interiors?: boolean;
  /**
   * Draw every emitted structure part by part, as the damaged path does, even when it is intact: every triangle then
   * lies within one part (for presentation that moves parts, see fall.ts). Off by default.
   */
  byParts?: boolean;
}

/** How the shader draws windows on buildings without a façade recipe. */
export const WINDOW_STYLE = { none: 0, punched: 1, strip: 2, sparse: 3 } as const;

/**
 * How the walls are finished (`BuildingSpec.wallFinish`): plain render (today's look), a timber frame drawn over the
 * render, coursed stone, upright boards. Drawn by the `finishes` variant of the structure material only.
 */
export const WALL_FINISH = { render: 0, frame: 1, stone: 2, boards: 3 } as const;
/**
 * How pitched roofs are covered (`BuildingSpec.roofCover`): plain courses (today's look), thatch, slate, shingle.
 * Drawn by the `finishes` variant of the structure material only.
 */
export const ROOF_COVER = { courses: 0, thatch: 1, slate: 2, shingle: 3 } as const;

/**
 * The material byte of a structure's vertices (`a_mat.z`): the window style in bits 0–1, the wall finish in bits 2–3,
 * the roof cover in bits 4–5 and shutters in bit 6. A spec without finish, cover and shutters gives its window style.
 */
export function materialCode(b: BuildingSpec): number {
  const finish = (b.wallFinish ?? 0) & 3;
  const cover = (b.roofCover ?? 0) & 3;
  const shutters = b.facade?.window.shutters ? 1 : 0;
  if (finish === 0 && cover === 0 && shutters === 0) return b.windowStyle;
  return (b.windowStyle & 3) | (finish << 2) | (cover << 4) | (shutters << 6);
}

export interface BuildingSpec {
  id: number;
  /** Hash derived from the building ID. Drives the tint and all small details, so a building always looks the same. */
  hash: number;
  rings: Ring[];
  box: OrientedBox;
  /** Lowest terrain under the footprint. Walls reach a little below it. */
  groundMin: number;
  /** Terrain the floors are counted from (median under the footprint). */
  groundRef: number;
  /** Eave height from lidar; for a flat roof the roof surface. Metres above sea level. */
  eaveY: number;
  /** Ridge height; equal to the eave for a flat roof. */
  ridgeY: number;
  roof: RoofKind;
  ridgeAcross: boolean;
  /** Height profile of the roof faces; overrides the kind's own (read by gable, hip, apex, dome, mansard). */
  roofProfile?: RoofProfile;
  /**
   * Structures with the same non-zero group are parts of one composition: their walls never count as shared or blind
   * because of each other. A part standing on another part has `groundMin` and `groundRef` at the level it stands on.
   */
  group?: number;
  /**
   * A member of a group that stands on other members of it. The footprint tests of entrances, steps, balconies and
   * bands of the other members of the same non-zero group ignore it, so a part on top never blocks the walls under it.
   */
  raised?: boolean;
  /** Wall finish (`WALL_FINISH`), 0 when absent. */
  wallFinish?: number;
  /** Cover of a pitched roof (`ROOF_COVER`), 0 when absent. */
  roofCover?: number;
  /** Number of storeys from the registry, 0 = unknown. Used when it fits the height. */
  levelsHint: number;
  /** Usual storey height for this kind of building. */
  floorHeightNominal: number;
  bayWidth: number;
  windowStyle: number;
  parapetHeight: number;
  /** Palette rows. */
  wallColor: number;
  roofColor: number;
  trimColor: number;
  /** Colour of superstructures on a flat roof. */
  roofUnitColor: number;
  /** Optional façade recipe. Without it the building is drawn the simple way (punched window grid). */
  facade?: FacadeRecipe;
}

export interface BuildingMeshStats {
  buildings: number;
  tier1: number;
  tier2: number;
  tier3: number;
  /** Buildings that should have had a pitched roof and ended flat because the check failed. */
  roofFallbacks: number;
  parapets: number;
  /** Procedural superstructures on flat roofs. */
  roofUnits: number;
  /** Superstructures given by the application (lidar), and those dropped because they did not fit the roof. */
  roofBoxes: number;
  roofBoxesDropped: number;
  /** Of the dropped ones: lower than FACADE_DIM.roofBoxMinHeight above the eave (the rest did not fit inside). */
  roofBoxesLow: number;
  props: number;
  /** Façade detail: buildings with a recipe, entrances (and those with no free wall), balconies, cornice walls, chimneys, shared walls. */
  withRecipe: number;
  entrances: number;
  entrancesDropped: number;
  steps: number;
  canopies: number;
  balconies: number;
  corniceWalls: number;
  chimneys: number;
  partyWalls: number;
  blindWalls: number;
  /** Triangles per building (walls, roof and its own detail), sorted. */
  trianglesPerBuilding: number[];
}

export function buildRoof(b: BuildingSpec, dims: ArchMeshDims): { roof: RoofGeometry; fellBack: boolean } {
  let roof: RoofGeometry | null = null;
  const pitch = {
    ridgeY: b.ridgeY,
    eaveWanted: b.eaveY,
    minEaveY: b.groundRef + dims.minWallHeight,
    minSlope: dims.roofSlopeMin,
    maxSlope: dims.roofSlopeMax,
  };
  if (b.roof === 'gable' || b.roof === 'hip') {
    const o = { box: b.box, ridgeAcross: b.ridgeAcross, hipped: b.roof === 'hip', pitch };
    roof = ridgeRoof(b.rings, b.roofProfile ? { ...o, profile: b.roofProfile } : o);
  } else if (b.roof === 'field') {
    roof = fieldRoof(b.rings, pitch, dims.fieldRoofMaxTriangles);
  } else if (b.roof === 'mansard') {
    roof = ridgeRoof(b.rings, { box: b.box, ridgeAcross: b.ridgeAcross, hipped: true, pitch, profile: b.roofProfile ?? ROOF_PROFILE.mansard });
  } else if (b.roof === 'apex' || b.roof === 'dome') {
    roof = apexRoof(b.rings, {
      cx: b.box.cx,
      cz: b.box.cz,
      eaveY: Math.max(b.eaveY, b.groundRef + dims.minWallHeight),
      topY: b.ridgeY,
      profile: b.roofProfile ?? (b.roof === 'dome' ? ROOF_PROFILE.dome : ROOF_PROFILE.straight),
    });
  }
  if (roof) return { roof, fellBack: false };
  return { roof: flatRoof(b.rings, b.roof === 'flat' ? b.eaveY : b.ridgeY), fellBack: b.roof !== 'flat' };
}

/** Procedural superstructures on a flat roof: lift housing, ventilation. Placement from the building hash. */
export function roofUnits(b: BuildingSpec, dims: ArchMeshDims, roofY: number, area: number, scale = 1): PropBox[] {
  if (area < dims.roofUnitMinRoofArea) return [];
  const count = Math.min(dims.roofUnitMaxCount, Math.max(1, Math.floor(area / dims.roofUnitAreaPerUnit)));
  const out: PropBox[] = [];
  const { box } = b;
  const TRIES = 8;
  /** Distance of a unit from the roof edge. */
  const MARGIN = 1.2;
  for (let k = 0; k < count; k++) {
    for (let t = 0; t < TRIES; t++) {
      const h = hashInts(b.hash, 500 + k, t);
      const r = (i: number): number => unit(hashInts(h, i));
      const halfL = ((dims.roofUnitMinSize + (dims.roofUnitMaxSize - dims.roofUnitMinSize) * r(1) * r(1)) / 2) * scale;
      const halfW = Math.max(dims.roofUnitMinSize / 2, halfL * (0.45 + 0.5 * r(2)));
      const u = (r(3) * 2 - 1) * Math.max(0, box.halfL - halfL - MARGIN);
      const v = (r(4) * 2 - 1) * Math.max(0, box.halfW - halfW - MARGIN);
      const cx = box.cx + box.ux * u - box.uz * v;
      const cz = box.cz + box.uz * u + box.ux * v;
      const cand = { cx, cz, ux: box.ux, uz: box.uz, halfL, halfW };
      // The whole unit including the margin must lie on the roof.
      if (!boxInside(cand, b.rings, MARGIN)) continue;
      if (out.some((o) => Math.hypot(o.cx - cx, o.cz - cz) < o.halfL + halfL + 1)) continue;
      const big = halfL * 2 > 3;
      const height = (dims.roofUnitMinHeight + (dims.roofUnitMaxHeight - dims.roofUnitMinHeight) * (big ? 0.5 + 0.5 * r(5) : 0.4 * r(5))) * (scale < 1 ? 0.6 : 1);
      out.push({ cx, cz, baseY: roofY, ux: box.ux, uz: box.uz, halfL, halfW, height, slope: 0, color: big ? b.wallColor : b.roofUnitColor, hash: h });
      break;
    }
  }
  return out;
}

/** Points where a footprint edge must be split because a roof crease crosses it. Parameters 0–1, sorted. */
export function edgeSplits(ax: number, az: number, bx: number, bz: number, creases: CreaseLine[]): number[] {
  const ts = [0, 1];
  for (const c of creases) {
    const sa = c.nx * ax + c.nz * az - c.off;
    const sb = c.nx * bx + c.nz * bz - c.off;
    if (sa * sb < 0) {
      const t = sa / (sa - sb);
      if (t > 1e-3 && t < 1 - 1e-3) ts.push(t);
    }
  }
  return ts.sort((p, q) => p - q);
}

/** One footprint edge with what the façade needs to know about it. */
export interface Edge {
  ring: number;
  i: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  len: number;
  /** Unit direction a → b and outward normal. */
  dx: number;
  dz: number;
  nx: number;
  nz: number;
  /** Window columns: count and width. */
  cols: number;
  colW: number;
  party: boolean;
  blind: boolean;
  balconies: boolean;
  /** Is the wall top constant along the edge (eave edge, not a gable)? */
  levelTop: boolean;
  /** Is the corner at a / at b convex? */
  convexA: boolean;
  convexB: boolean;
  doors: PlacedDoor[];
}

export interface PlacedDoor {
  u: number;
  width: number;
  y: number;
  kind: number;
  spec: EntranceSpec;
}

const DOOR_CODE: Record<EntranceSpec['kind'], number> = { door: DOOR_KIND.door, garage: DOOR_KIND.garage, portal: DOOR_KIND.portal, arch: DOOR_KIND.arch };

/** Height of an opening by its kind code; an arch door's height follows its width. */
function doorHeight(kind: number, width: number): number {
  if (kind === DOOR_KIND.arch) return width * FACADE_DIM.archHeightPerWidth;
  return kind === DOOR_KIND.garage ? FACADE_DIM.garageDoorHeight : kind === DOOR_KIND.portal ? FACADE_DIM.portalHeight : FACADE_DIM.doorHeight;
}

/**
 * Footprint index of a spec list, built once per list and reused by later calls with the same list (a damaged
 * structure is regenerated with `only` against the full list many times). The cache keys on the array and checks
 * that every spec's rings are still the same objects, so a list changed in place gets a new index.
 */
const footprintCache = new WeakMap<readonly BuildingSpec[], { rings: Ring[][]; index: FootprintIndex | null }>();
export function footprintIndex(specs: readonly BuildingSpec[]): FootprintIndex | null {
  const hit = footprintCache.get(specs);
  if (hit && hit.rings.length === specs.length && hit.rings.every((r, i) => r === specs[i]!.rings)) return hit.index;
  const rings = specs.map((s) => s.rings);
  const index = specs.some((s) => s.facade) ? new FootprintIndex(rings) : null;
  footprintCache.set(specs, { rings, index });
  return index;
}

/** A box the recipe places, with its path (edge index into `StructurePlan.edges`, column, storey, rule index). */
export interface PlannedBox {
  edge: number;
  c: number;
  f: number;
  k: number;
  box: PropBox;
}

export interface PlannedCanopy {
  /** Index of the entrance in the recipe. */
  k: number;
  edge: number;
  /** Door position along the wall. */
  u: number;
  box: PropBox;
}

/** Everything the generator worked out for one structure; shared by the intact path, the description and damage. */
export interface StructurePlan {
  b: BuildingSpec;
  rec: FacadeRecipe | undefined;
  roof: RoofGeometry;
  flat: boolean;
  baseY: number;
  eaveY: number;
  floors: number;
  floorHeight: number;
  groundFloorH: number;
  floorBase: number;
  parapet: number;
  insets: (Ring | null)[];
  wallTopExtra: number;
  mat: VertexMaterial;
  edges: Edge[];
  /** Split parameters (0–1) of every edge: roof creases and the middles between doors, as the intact path splits. */
  splits: number[][];
  /** Base façade data per edge (null without a recipe). */
  attrs: (WallAttr | null)[];
  balconies: PlannedBox[];
  cornice: CorniceRecipe | null;
  tops: PlannedBox[];
  chimneys: PlannedBox[];
  canopies: PlannedCanopy[];
  groundAt: (x: number, z: number) => number;
}

/** Per-wall façade data written into every vertex of the wall. */
export function wallAttr(rec: FacadeRecipe, e: Edge, groundFloorH: number, floorHeight: number): WallAttr {
  let flags = FACADE_FLAG.recipe;
  if (e.blind) flags |= FACADE_FLAG.blind;
  if (rec.panelJoints) flags |= FACADE_FLAG.panelJoints;
  if (rec.stairStrip) flags |= FACADE_FLAG.stairStrip;
  if (rec.window.transom) flags |= FACADE_FLAG.transom;
  if (e.balconies && rec.balconies) {
    flags |= FACADE_FLAG.balconies;
    if (rec.balconies.kind === 'loggia') flags |= FACADE_FLAG.loggia;
  }
  if (rec.cornice) flags |= FACADE_FLAG.cornice;
  // Window size clamped so it fits the column and the storey.
  const ww = Math.min(rec.window.width, e.colW * 0.7);
  const wh = Math.min(rec.window.height, floorHeight - 0.55);
  const sill = Math.min(rec.window.sill, Math.max(0.3, floorHeight - wh - 0.25));
  const curtain = Math.round(Math.max(0, Math.min(1, rec.curtainShare)) * 15);
  const blind = Math.round(Math.max(0, Math.min(1, rec.blindShare)) * 15);
  const balconyMask = rec.balconies ? rec.balconies.columnMask & 15 : 0;
  // An arched window stores its height on the tall scale (the writer reads the bit).
  const arch = rec.window.arch ? ARCH_WINDOW_BIT : 0;
  return {
    doorU: -1e4,
    doorW: 0,
    doorY: 0,
    groundFloorH,
    win: [ww, wh, sill, rec.plinthHeight],
    bits: [flags, rec.window.mullions | (rec.groundFloor << 2) | arch, curtain | (blind << 4), balconyMask | ((rec.window.narrowMask & 15) << 4)],
    cols: [rec.colors.frame, rec.colors.plinth, rec.colors.door, rec.colors.accent],
  };
}

/**
 * Places the requested entrances on free walls: nearest wall to the preferred point that is not shared with a
 * neighbour and is long enough; the door goes to the centre of the nearest window column. Builds the steps
 * (when the threshold is above the terrain) and the canopy.
 */
export function placeEntrances(
  rec: FacadeRecipe,
  edges: Edge[],
  b: BuildingSpec,
  self: number,
  index: FootprintIndex,
  groundAt: (x: number, z: number) => number,
  stats: BuildingMeshStats,
  anchored: PropBox[],
  w: VertexWriter,
  canopies: PlannedCanopy[],
  keepCanopy: ((k: number) => boolean) | null,
  skip?: (i: number) => boolean,
): void {
  rec.entrances.forEach((ent, k) => {
    let best: Edge | null = null;
    let bestD = Infinity;
    for (const e of edges) {
      if (e.party || e.len < ent.width + 0.4) continue;
      // Prefer walls facing the point: a wall seen from behind gets a penalty.
      const facing = (ent.x - (e.ax + e.bx) / 2) * e.nx + (ent.z - (e.az + e.bz) / 2) * e.nz;
      const d = distToSegment(ent.x, ent.z, e.ax, e.az, e.bx, e.bz) + (facing < 0 ? 6 : 0);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) {
      stats.entrancesDropped++;
      return;
    }
    const e = best;
    const along = (ent.x - e.ax) * e.dx + (ent.z - e.az) * e.dz;
    const col = Math.max(0, Math.min(e.cols - 1, Math.floor(along / e.colW)));
    let u = (col + 0.5) * e.colW;
    const half = ent.width / 2;
    const margin = Math.min(FACADE_DIM.wallEndMargin, (e.len - ent.width) / 2);
    u = Math.max(margin + half, Math.min(e.len - margin - half, u));
    if (e.doors.some((d) => Math.abs(d.u - u) < Math.max(e.colW, ent.width + 0.6))) return;
    const kind = DOOR_CODE[ent.kind];
    // Threshold: terrain in front of the door plus the raise, never below the terrain at the wall itself.
    const px = e.ax + e.dx * u;
    const pz = e.az + e.dz * u;
    const gWall = Math.max(groundAt(px - e.dx * half, pz - e.dz * half), groundAt(px + e.dx * half, pz + e.dz * half), groundAt(px, pz));
    const gFront = groundAt(px + e.nx * 0.8, pz + e.nz * 0.8);
    const y = Math.max(gWall + 0.02, gFront + ent.raise);
    // Steps and canopy must not poke into a neighbour; when they would, the door goes elsewhere or nowhere.
    const rise = y - gFront;
    const nSteps = rise > FACADE_DIM.minStepHeight ? Math.min(FACADE_DIM.maxSteps, Math.ceil(rise / FACADE_DIM.stepRise) - 1) : -1;
    const reach = Math.max(ent.canopy, nSteps >= 0 ? FACADE_DIM.landingDepth + nSteps * FACADE_DIM.stepTread : 0.3);
    const extra = Math.max(FACADE_DIM.canopyExtraWidth, 0.6) / 2;
    if (index.anyOccupied(wallBoxCorners(e.ax, e.az, e.dx, e.dz, u - half - extra, u + half + extra, 0.05, reach + 0.1), self, skip)) {
      stats.entrancesDropped++;
      return;
    }
    e.doors.push({ u, width: ent.width, y, kind, spec: ent });
    e.doors.sort((p, q) => p.u - q.u);
    stats.entrances++;
    const h = hashInts(b.hash, 800, k);
    if (nSteps >= 0) {
      // Landing level with the threshold, then steps down; each lower step only covers its own tread, so no
      // two boxes share a face. Every box reaches under the lowest terrain around it.
      const sw = ent.width + 0.5;
      for (let s = 0; s <= nSteps; s++) {
        const d0 = s === 0 ? 0 : FACADE_DIM.landingDepth + (s - 1) * FACADE_DIM.stepTread;
        const d1 = FACADE_DIM.landingDepth + s * FACADE_DIM.stepTread;
        const top = y - s * FACADE_DIM.stepRise;
        const corners = wallBoxCorners(e.ax, e.az, e.dx, e.dz, u - sw / 2, u + sw / 2, d0, d1);
        let gMin = Infinity;
        for (let c = 0; c < 8; c += 2) gMin = Math.min(gMin, groundAt(corners[c]!, corners[c + 1]!));
        const bottom = Math.min(gMin, top) - FACADE_DIM.stepSink;
        const box = wallBox(e.ax, e.az, e.dx, e.dz, u - sw / 2, u + sw / 2, d0, d1, bottom, top - bottom, rec.colors.plinth, hashInts(h, s));
        pushBox(w, box);
        anchored.push(box);
      }
      stats.steps++;
    }
    if (ent.canopy > 0) {
      const cw = ent.width + FACADE_DIM.canopyExtraWidth;
      const cy = y + doorHeight(kind, ent.width) + FACADE_DIM.canopyGap;
      const box = wallBox(e.ax, e.az, e.dx, e.dz, u - cw / 2, u + cw / 2, 0, ent.canopy, cy, FACADE_DIM.canopyThickness, b.trimColor, hashInts(h, 99));
      canopies.push({ k, edge: edges.indexOf(e), u, box });
      if (!keepCanopy || keepCanopy(k)) pushBox(w, box);
      stats.canopies++;
    }
  });
}

/** Chimneys near the ridge of a pitched roof, with their index in the recipe's chimney rule. */
export function chimneyBoxes(b: BuildingSpec, rec: FacadeRecipe, roof: RoofGeometry): PlannedBox[] {
  const { box } = b;
  const along = b.ridgeAcross ? [-box.uz, box.ux] : [box.ux, box.uz];
  const halfAlong = b.ridgeAcross ? box.halfW : box.halfL;
  const across = [-along[1]!, along[0]!];
  const count = Math.max(1, Math.min(rec.chimneys, Math.round((halfAlong * 2) / 9)));
  const [sx, sz] = FACADE_DIM.chimneySize;
  const out: PlannedBox[] = [];
  for (let k = 0; k < count; k++) {
    const h = hashInts(b.hash, 1000, k);
    const r = (i: number): number => unit(hashInts(h, i));
    // Spread along the ridge, a little off it on a random side.
    const t = count === 1 ? (r(1) - 0.5) * 0.6 : -0.6 + (1.2 * k) / (count - 1) + (r(1) - 0.5) * 0.15;
    const off = (r(2) < 0.5 ? -1 : 1) * (0.4 + 0.9 * r(3));
    const cx = box.cx + along[0]! * t * halfAlong + across[0]! * off;
    const cz = box.cz + along[1]! * t * halfAlong + across[1]! * off;
    const cand = { cx, cz, ux: along[0]!, uz: along[1]!, halfL: sz / 2, halfW: sx / 2 };
    if (!boxInside(cand, b.rings, 0.6)) continue;
    let low = Infinity;
    let high = -Infinity;
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const y = roof.topAt(cx + cand.ux * cand.halfL * su - cand.uz * cand.halfW * sv, cz + cand.uz * cand.halfL * su + cand.ux * cand.halfW * sv);
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
    const top = Math.max(high + 0.5, roof.topAt(box.cx, box.cz) + FACADE_DIM.chimneyAboveRidge * (0.6 + 0.6 * r(4)));
    out.push({ edge: -1, c: 0, f: 0, k, box: { ...cand, baseY: low - 0.1, height: top - low + 0.1, slope: 0, color: rec.colors.chimney, hash: h } });
  }
  return out;
}
