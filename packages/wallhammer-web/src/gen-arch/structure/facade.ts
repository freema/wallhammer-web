// Façade recipes: a generic description of what a building's walls carry (entrances, plinth, ground floor,
// window formats, balconies, cornice, chimneys, roof superstructures). The engine knows nothing about building
// types; the application decides which recipe a building gets. Elements that cast a visible shadow or change
// the silhouette become geometry here, everything flat is drawn by the building shader from per-vertex data.

import { pointInRings } from '../../gen-core/index.ts';
import type { Ring } from '../../gen-core/index.ts';

/** How the ground floor differs from the floors above. */
export const GROUND_FLOOR = {
  /** Same windows as the floors above. */
  windows: 0,
  /** Large glazing (lobby, shop, university entrance hall). */
  glazed: 1,
  /** Small high windows (utility rooms, garages, halls). */
  high: 2,
  /** No windows. */
  blind: 3,
} as const;
export type GroundFloorKind = (typeof GROUND_FLOOR)[keyof typeof GROUND_FLOOR];

/** Kind of opening an entrance gets. Codes are what the shader reads. */
export const DOOR_KIND = { none: 0, door: 1, garage: 2, portal: 3, arch: 4 } as const;
/** `arch`: a leaf with a half-round head, as wide as the entrance; its height follows the width (`FACADE_DIM.archHeightPerWidth`). */
export type DoorKind = 'door' | 'garage' | 'portal' | 'arch';

export interface WindowRecipe {
  /** Size of the standard window in metres and its sill height above the floor. */
  width: number;
  height: number;
  sill: number;
  /** Vertical glazing bars: 0, 1 (centre) or 2 (thirds). */
  mullions: 0 | 1 | 2;
  /** Horizontal bar in the upper part of the window (older casement windows). */
  transom: boolean;
  /**
   * Four-bit mask over a period of four window columns: a set bit makes that column a narrow window
   * (kitchen, bathroom, stairs side). 0 = all columns the same.
   */
  narrowMask: number;
  /**
   * Half-round head as wide as the window (the height includes it). Such a window may be taller than an ordinary one
   * (up to 20.4 m instead of 5.1 m). Interior and damaged openings stay rectangles of the full height.
   */
  arch?: boolean;
  /**
   * A shutter leaf on each side of every window, each 0.45 × the window width, in the `accent` row. Drawn by the
   * `finishes` variant of the structure material only.
   */
  shutters?: boolean;
}

export interface BalconyRecipe {
  /** balcony: a slab with a solid parapet standing out of the wall; loggia: a shallow parapet with a dark recess behind. */
  kind: 'balcony' | 'loggia';
  /** How far the parapet stands out of the wall. */
  depth: number;
  /** Four-bit mask over a period of four window columns: which columns carry a balcony. */
  columnMask: number;
  /** Walls shorter than this get none. */
  minWallLength: number;
  /** Keep walls with an entrance free of balconies (typical for small houses with one door). */
  avoidEntranceWalls?: boolean;
}

export interface CorniceRecipe {
  /** Height of the moulding band under the eave and how far it stands out. */
  height: number;
  projection: number;
  /** The band also gets its face looking down (an overhang above it is then closed). */
  underside?: boolean;
}

/** One entrance. The application gives a preferred point; the engine picks the nearest free wall. */
export interface EntranceSpec {
  x: number;
  z: number;
  kind: DoorKind;
  /** Clear width of the opening. */
  width: number;
  /** Threshold height above the terrain in front of the door. Steps fill the difference. */
  raise: number;
  /** Depth of the canopy above the door, 0 = none. */
  canopy: number;
}

/** A superstructure box with absolute top height (metres above sea level), e.g. measured by lidar. */
export interface RoofBoxSpec {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  halfL: number;
  halfW: number;
  topY: number;
}

export interface FacadeRecipe {
  /** Ground floor height; the floors above share the rest of the wall. 0 = same as the floors above. */
  groundFloorHeight: number;
  groundFloor: GroundFloorKind;
  plinthHeight: number;
  window: WindowRecipe;
  /** Share of windows with curtains and with lowered blinds (0–1, chosen per window by hash). */
  curtainShare: number;
  blindShare: number;
  /** Prefab panel joints along floors and window columns, with a slight tone per panel. */
  panelJoints: boolean;
  /** On an elongated building, end walls shorter than this have no windows (blind gables). 0 = off. */
  blindEndWalls: number;
  balconies: BalconyRecipe | null;
  cornice: CorniceRecipe | null;
  entrances: EntranceSpec[];
  /** Stairwell window strip above each door (landing windows offset by half a floor). */
  stairStrip: boolean;
  /** Chimneys on a pitched roof, 0 = none. */
  chimneys: number;
  /** Superstructures on a flat roof. null = the engine places procedural ones, [] = none. */
  roofBoxes: RoofBoxSpec[] | null;
  /** Palette rows. */
  colors: { frame: number; plinth: number; door: number; accent: number; chimney: number };
}

/** Distances and sizes for façade geometry. */
export const FACADE_DIM = {
  /** Door height above the threshold, garage door and glazed portal. */
  doorHeight: 2.25,
  garageDoorHeight: 2.1,
  portalHeight: 2.7,
  /** One step: rise and tread. */
  stepRise: 0.16,
  stepTread: 0.3,
  /** Landing in front of the door. */
  landingDepth: 1.0,
  /** Below this difference between threshold and terrain no steps are built. */
  minStepHeight: 0.1,
  maxSteps: 7,
  /** How deep the steps reach under the terrain so they never float on a slope. */
  stepSink: 0.3,
  /** Canopy: gap above the door, slab thickness and how much wider than the door it is. */
  canopyGap: 0.25,
  canopyThickness: 0.16,
  canopyExtraWidth: 0.9,
  /** Distance from a wall end to the nearest door or balcony edge. */
  wallEndMargin: 0.45,
  /** Balcony slab thickness and parapet height above the floor. */
  balconySlab: 0.16,
  balconyParapet: 1.05,
  /** Balcony width as a share of the window column, and its cap in metres. */
  balconyColumnShare: 0.84,
  balconyMaxWidth: 3.8,
  /** Cornice top sits this much under the wall top so it never shares a plane with a parapet. */
  corniceTopGap: 0.04,
  /** Chimney size and how far it stands above the ridge. */
  chimneySize: [0.55, 0.75] as const,
  chimneyAboveRidge: 0.85,
  /** Sample offset in front of a wall when testing whether a neighbour stands there. */
  partyProbe: 0.3,
  /** Share of a wall covered by a neighbour from which the wall counts as a shared (party) wall. */
  partyShare: 0.5,
  /** Superstructures keep this distance from the roof edge (parapet thickness included). */
  roofBoxMargin: 0.45,
  /** Lowest superstructure worth drawing. */
  roofBoxMinHeight: 0.4,
  /** Height of an arch door as a multiple of its width (the head included). */
  archHeightPerWidth: 1.5,
} as const;

/** Bits of the per-vertex façade flags (`a_bits.x`). The building shader reads the same numbers. */
export const FACADE_FLAG = {
  recipe: 1,
  blind: 2,
  panelJoints: 4,
  stairStrip: 8,
  transom: 16,
  balconies: 32,
  loggia: 64,
  cornice: 128,
} as const;

/**
 * Footprints of all buildings with a coarse grid, for "does another building stand here" queries:
 * shared walls, and façade elements that would poke into a neighbour.
 */
export class FootprintIndex {
  private readonly cell = 16;
  private readonly grid = new Map<number, number[]>();
  private readonly rings: Ring[][];

  constructor(rings: Ring[][]) {
    this.rings = rings;
    rings.forEach((rs, i) => {
      const outer = rs[0];
      if (!outer) return;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let k = 0; k < outer.length; k += 2) {
        minX = Math.min(minX, outer[k]!);
        maxX = Math.max(maxX, outer[k]!);
        minZ = Math.min(minZ, outer[k + 1]!);
        maxZ = Math.max(maxZ, outer[k + 1]!);
      }
      for (let gz = Math.floor(minZ / this.cell); gz <= Math.floor(maxZ / this.cell); gz++) {
        for (let gx = Math.floor(minX / this.cell); gx <= Math.floor(maxX / this.cell); gx++) {
          const key = gz * 100003 + gx;
          let list = this.grid.get(key);
          if (!list) this.grid.set(key, (list = []));
          list.push(i);
        }
      }
    });
  }

  /** Is the point inside a building other than `self` (and other than those `skip` names)? */
  occupied(x: number, z: number, self: number, skip?: (i: number) => boolean): boolean {
    const list = this.grid.get(Math.floor(z / this.cell) * 100003 + Math.floor(x / this.cell));
    if (!list) return false;
    for (const i of list) if (i !== self && !(skip && skip(i)) && pointInRings(x, z, this.rings[i]!)) return true;
    return false;
  }

  /** Is any of the points inside another building? Points as flat x, z pairs. */
  anyOccupied(pts: readonly number[], self: number, skip?: (i: number) => boolean): boolean {
    for (let k = 0; k < pts.length; k += 2) if (this.occupied(pts[k]!, pts[k + 1]!, self, skip)) return true;
    return false;
  }
}

/** Share of the wall from a to b that has another building (not one `skip` names) right in front of it. */
export function partyShare(index: FootprintIndex, self: number, ax: number, az: number, bx: number, bz: number, skip?: (i: number) => boolean): number {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 1e-3) return 0;
  const nx = (bz - az) / len;
  const nz = -(bx - ax) / len;
  const n = Math.max(3, Math.min(24, Math.round(len / 1.5)));
  let hit = 0;
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n;
    const x = ax + (bx - ax) * t + nx * FACADE_DIM.partyProbe;
    const z = az + (bz - az) * t + nz * FACADE_DIM.partyProbe;
    if (index.occupied(x, z, self, skip)) hit++;
  }
  return hit / n;
}

/** Corners of a box standing in front of a wall: from `u0` to `u1` along the wall, `d0` to `d1` out of it. */
export function wallBoxCorners(ax: number, az: number, dx: number, dz: number, u0: number, u1: number, d0: number, d1: number): number[] {
  const nx = dz;
  const nz = -dx;
  const out: number[] = [];
  for (const [u, d] of [
    [u0, d0],
    [u1, d0],
    [u1, d1],
    [u0, d1],
  ] as const) {
    out.push(ax + dx * u + nx * d, az + dz * u + nz * d);
  }
  return out;
}
