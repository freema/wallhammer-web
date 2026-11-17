// Tree placement rules. The input is a vegetation raster (where the canopy is and how tall), a field of distances
// to walls, the occupied area and street axes. The output is a list of trees with a type by location and a species.
//
// Order: first street avenues at regular spacing along the roadway, then the other trees.
// Those are drawn from a fine grid of candidates with a random position in the cell and accepted from the tallest:
// a candidate passes only when it is far enough from those already accepted. The spacing is thus irregular and no grid is visible.
// Everything is a pure function of the input and the seed, the rule numbers come in `PlantingInput.rules`.

import { SegmentField } from '../gen-core/index.ts';
import type { OutlineField } from '../gen-core/index.ts';
import { hashInts, rand } from '../gen-core/index.ts';
import { valueNoise2 } from '../gen-core/index.ts';
import type { Occupancy } from '../gen-core/index.ts';

/** Tree type by the place where it stands. */
export type TreeKind = 'forest' | 'park' | 'street' | 'house' | 'shrub';
/** Species, i.e. the canopy shape. */
export type TreeSpecies = 'round' | 'tall' | 'conifer' | 'birch' | 'shrub';

export const TREE_KINDS: readonly TreeKind[] = ['forest', 'park', 'street', 'house', 'shrub'];
export const TREE_SPECIES: readonly TreeSpecies[] = ['round', 'tall', 'conifer', 'birch', 'shrub'];

/** Vegetation raster: height and canopy coverage per cell, rows from the north. */
export interface CanopyRaster {
  /** Height in units of `heightScale` metres. */
  height: Uint8Array;
  /** Share of the cell under a canopy, 0–255. */
  cover: Uint8Array;
  cols: number;
  rows: number;
  /** Cell size in metres. */
  step: number;
  heightScale: number;
}

/** Street axis along which an avenue may stand. */
export interface StreetLine {
  /** Polyline, flat array x, z. */
  points: ArrayLike<number>;
  /** Roadway width in metres. */
  width: number;
  id: number;
}

/** Placement rules in metres (setbacks, limits, spacing). The project supplies the numbers. */
export interface PlantingRules {
  // --- Wall setbacks ---
  /** A trunk stands at least this far from a wall. */
  trunkMinWallDistance: number;
  /** Gap between a canopy and a wall: canopy radius is at most the distance to the wall minus this gap. */
  crownWallGap: number;
  /** A canopy smaller than this is not planted. */
  crownMinRadius: number;

  // --- Height from vegetation data ---
  /** Lower vegetation is not drawn at all. */
  minVegetationHeight: number;
  /** Vegetation lower than this is a shrub. */
  shrubMaxHeight: number;
  maxHeight: number;
  /** Radius of the neighbourhood in which the canopy top above a trunk is searched. */
  heightSearchRadius: number;
  /** A vegetation raster cell counts as growth from this coverage (0–1). */
  minCellCover: number;

  // --- Types by location ---
  /** Strip along a road in which only street avenues stand. */
  streetBand: number;
  /** Dense growth may enter the strip along a road only from this distance from the roadway edge. */
  streetBandForestFrom: number;
  /** A tree closer to a wall than this is the "by house" type. */
  nearHouseDistance: number;
  /** Forest: at least this far from buildings and at least this share of vegetation in the neighbourhood. */
  forestMinWallDistance: number;
  forestNeighbourhoodRadius: number;
  forestMinCover: number;
  /** Neighbourhood used to shrink a canopy when the growth in the data is small. */
  localCoverRadius: number;
  /** A tree by a house is not taller than this. */
  houseTreeMaxHeight: number;

  // --- Street avenues ---
  /** Tree spacing in a row and trunk offset from the roadway edge. */
  streetSpacing: number;
  streetKerbOffset: number;
  /** How much a trunk in a row may randomly shift along the street. */
  streetJitter: number;
  /** How far from the row position a canopy must be in the data. */
  streetCanopySearch: number;
  /** A row is planted only along streets at least this wide. */
  streetMinRoadWidth: number;

  // --- Canopies: radius = height × ratio + base, within limits ---
  forestCrown: CrownRule;
  parkCrown: CrownRule;
  streetCrown: CrownRule;
  houseCrown: CrownRule;
  shrubCrown: CrownRule;

  // --- Scatter ---
  /** Grid from which candidates are drawn. Each has a random position in its cell, so the grid is not visible. */
  candidateCell: number;
  /** Size of groups with the same hue and the same species. */
  tintPatch: number;
  speciesPatch: number;
  /** Share of places where the species noise allows conifers and birches: noise threshold 0–1, higher = rarer. */
  coniferThreshold: number;
  birchThreshold: number;
  /** The tree base is slightly below the terrain, so a trunk on a slope does not hang in the air. */
  rootDepth: number;

  // --- Check after generation ---
  /** How far an object's base may be above the terrain and still count as standing on the ground. */
  groundTolerance: number;
  /** Largest allowed sinking of the base of a tree and a car below the terrain. */
  maxSink: number;
}

export interface PlantingInput {
  rules: PlantingRules;
  canopy: CanopyRaster;
  walls: OutlineField;
  occupancy: Occupancy;
  /** Flags of the occupied area on which a trunk must not stand. */
  noTrunkMask: number;
  /** Flags that mean roadway. Its edge is searched by them. */
  roadMask: number;
  streets: StreetLine[];
  heightAt: (x: number, z: number) => number;
  seed: number;
  /**
   * Optional test whether a tree may stand at a point. Replaces the default test (`occupancy` against `noTrunkMask`
   * at the point) everywhere a spot is tested.
   */
  spotFree?: (x: number, z: number) => boolean;
  /**
   * Optional: called when a candidate spot is not free. Returns another spot to use instead, or null to drop the
   * candidate. The returned spot then goes through the usual wall tests. Without it the candidate is dropped.
   */
  relocate?: (x: number, z: number, seed: number) => readonly [number, number] | null;
}

export interface PlantedTree {
  x: number;
  z: number;
  /** Base height (slightly below the terrain). */
  y: number;
  /** Tree height above the base. */
  height: number;
  /** Canopy radius. */
  radius: number;
  kind: TreeKind;
  species: TreeSpecies;
  /** Rotation around the vertical axis. */
  yaw: number;
  /** Hue 0–1, changes smoothly across groups. */
  tint: number;
  /** At what fraction of the height the canopy starts. 0 = from the ground, the trunk is not visible. */
  crownBase: number;
  /** Flexibility in wind, 1 = ordinary broadleaf. */
  flex: number;
  /** Random number 0–1: sway phase and choice of shape variant. */
  phase: number;
}

export interface PlantingStats {
  candidates: number;
  /** Why candidates failed. */
  rejected: { inWall: number; nearWall: number; occupied: number; streetBand: number; crownTooSmall: number; spacing: number };
  streetStations: number;
  /** Trees placed at a spot returned by `relocate`. */
  relocated: number;
}

export interface CrownRule {
  perHeight: number;
  base: number;
  min: number;
  max: number;
  spacing: number;
}

/** Shape by species: how narrow the canopy is relative to the type's rule, where it starts and how it yields to wind. */
const SPECIES_SHAPE: Record<TreeSpecies, { radius: number; crownBase: number; crownBaseForest: number; flex: number }> = {
  round: { radius: 1.0, crownBase: 0.3, crownBaseForest: 0.18, flex: 1.0 },
  tall: { radius: 0.9, crownBase: 0.3, crownBaseForest: 0.2, flex: 0.9 },
  conifer: { radius: 0.62, crownBase: 0.12, crownBaseForest: 0.08, flex: 0.45 },
  birch: { radius: 0.7, crownBase: 0.42, crownBaseForest: 0.36, flex: 1.35 },
  shrub: { radius: 1.0, crownBase: 0, crownBaseForest: 0, flex: 0.6 },
};

/** Largest flexibility in wind among species. The check uses it to compute the worst canopy deflection. */
export const TREE_MAX_FLEX = Math.max(...Object.values(SPECIES_SHAPE).map((v) => v.flex));

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function plantTrees(input: PlantingInput): { trees: PlantedTree[]; stats: PlantingStats } {
  const steps = plantTreesSteps(input);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * The same planting as `plantTrees`, as a generator that pauses between pieces of work (a row of the candidate grid,
 * a street, a batch of candidates), so a caller can spread it over several tasks. The result does not depend on where
 * it pauses.
 */
export function* plantTreesSteps(input: PlantingInput): Generator<void, { trees: PlantedTree[]; stats: PlantingStats }> {
  const { canopy, walls, occupancy, noTrunkMask, roadMask, seed } = input;
  const R = input.rules;
  const CROWN: Record<TreeKind, CrownRule> = { forest: R.forestCrown, park: R.parkCrown, street: R.streetCrown, house: R.houseCrown, shrub: R.shrubCrown };
  // How far the generator queries the wall distance: beyond that the distance affects nothing (largest canopy with gap, forest boundary).
  const WALL_REACH = Math.max(R.forestMinWallDistance, R.parkCrown.max + R.crownWallGap, R.forestCrown.max + R.crownWallGap) + 0.5;
  const { cols, rows, step } = canopy;
  const sizeX = cols * step;
  const sizeZ = rows * step;
  const stats: PlantingStats = {
    candidates: 0,
    rejected: { inWall: 0, nearWall: 0, occupied: 0, streetBand: 0, crownTooSmall: 0, spacing: 0 },
    streetStations: 0,
    relocated: 0,
  };
  const trunkFree = input.spotFree ?? ((x: number, z: number): boolean => (occupancy.at(x, z) & noTrunkMask) === 0);
  const seedTint = hashInts(seed, 101);
  const seedConifer = hashInts(seed, 102);
  const seedBirch = hashInts(seed, 103);
  const seedTall = hashInts(seed, 104);

  // --- Vegetation raster queries ---------------------------------------------------------------
  const coverMin = Math.round(R.minCellCover * 255);
  const cellOf = (x: number, z: number): number => clamp(Math.floor(z / step), 0, rows - 1) * cols + clamp(Math.floor(x / step), 0, cols - 1);
  /** Summed-area table of cells with vegetation, for the share of vegetation in a neighbourhood. */
  const integral = new Uint32Array((cols + 1) * (rows + 1));
  for (let j = 0; j < rows; j++) {
    let run = 0;
    for (let i = 0; i < cols; i++) {
      run += canopy.cover[j * cols + i]! >= coverMin ? 1 : 0;
      integral[(j + 1) * (cols + 1) + i + 1] = integral[j * (cols + 1) + i + 1]! + run;
    }
  }
  yield;
  const coverAround = (x: number, z: number, radius: number): number => {
    const i0 = clamp(Math.floor((x - radius) / step), 0, cols);
    const i1 = clamp(Math.ceil((x + radius) / step), 0, cols);
    const j0 = clamp(Math.floor((z - radius) / step), 0, rows);
    const j1 = clamp(Math.ceil((z + radius) / step), 0, rows);
    const n = (i1 - i0) * (j1 - j0);
    if (n <= 0) return 0;
    const w = cols + 1;
    return (integral[j1 * w + i1]! - integral[j0 * w + i1]! - integral[j1 * w + i0]! + integral[j0 * w + i0]!) / n;
  };
  /** Tallest canopy around a point, in metres. 0 when there is no vegetation around. */
  const heightAround = (x: number, z: number, radius: number): number => {
    const i0 = clamp(Math.floor((x - radius) / step), 0, cols - 1);
    const i1 = clamp(Math.floor((x + radius) / step), 0, cols - 1);
    const j0 = clamp(Math.floor((z - radius) / step), 0, rows - 1);
    const j1 = clamp(Math.floor((z + radius) / step), 0, rows - 1);
    let best = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * cols + i;
        if (canopy.cover[k]! >= coverMin && canopy.height[k]! > best) best = canopy.height[k]!;
      }
    }
    return Math.min(R.maxHeight, best * canopy.heightScale);
  };

  // --- Street edges --------------------------------------------------------------------------------
  const streetEdges = new SegmentField(sizeX, sizeZ);
  for (const st of input.streets) {
    if (st.width >= R.streetMinRoadWidth) streetEdges.addPolyline(st.points, st.width / 2, st.id);
  }

  // --- Accepted trees and their spacing ----------------------------------------------------------
  const trees: PlantedTree[] = [];
  const spacingOf: number[] = [];
  const GRID_M = 4;
  const gCols = Math.ceil(sizeX / GRID_M);
  const gRows = Math.ceil(sizeZ / GRID_M);
  const grid: (number[] | undefined)[] = new Array<number[] | undefined>(gCols * gRows);
  let maxSpacing = 0;
  for (const kind of TREE_KINDS) maxSpacing = Math.max(maxSpacing, CROWN[kind].max * CROWN[kind].spacing);

  const fits = (x: number, z: number, spacing: number): boolean => {
    const reach = (spacing + maxSpacing) / 2;
    const c0 = clamp(Math.floor((x - reach) / GRID_M), 0, gCols - 1);
    const c1 = clamp(Math.floor((x + reach) / GRID_M), 0, gCols - 1);
    const r0 = clamp(Math.floor((z - reach) / GRID_M), 0, gRows - 1);
    const r1 = clamp(Math.floor((z + reach) / GRID_M), 0, gRows - 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = grid[r * gCols + c];
        if (!list) continue;
        for (const t of list) {
          const o = trees[t]!;
          const need = (spacing + spacingOf[t]!) / 2;
          const dx = o.x - x;
          const dz = o.z - z;
          if (dx * dx + dz * dz < need * need) return false;
        }
      }
    }
    return true;
  };

  /**
   * Common ending for all types: trunk setback from the wall, occupied area, canopy size by the wall,
   * spacing from neighbours. Returns true when the tree has grown.
   */
  const place = (x0: number, z0: number, h: number, kind: TreeKind, species: TreeSpecies, treeSeed: number): boolean => {
    let x = x0;
    let z = z0;
    if (x < 0 || z < 0 || x >= sizeX || z >= sizeZ) return false;
    let dWall = walls.distance(x, z, WALL_REACH);
    if (dWall < 0) {
      stats.rejected.inWall++;
      return false;
    }
    if (dWall < R.trunkMinWallDistance) {
      stats.rejected.nearWall++;
      return false;
    }
    if (!trunkFree(x, z)) {
      const alt = input.relocate?.(x0, z0, treeSeed) ?? null;
      const d = alt && alt[0] >= 0 && alt[1] >= 0 && alt[0] < sizeX && alt[1] < sizeZ ? walls.distance(alt[0], alt[1], WALL_REACH) : -1;
      if (!alt || d < R.trunkMinWallDistance || !trunkFree(alt[0], alt[1])) {
        stats.rejected.occupied++;
        return false;
      }
      x = alt[0];
      z = alt[1];
      dWall = d;
      stats.relocated++;
    }
    const rule = CROWN[kind];
    const shape = SPECIES_SHAPE[species];
    let radius = clamp(h * rule.perHeight + rule.base, rule.min, rule.max) * shape.radius * (0.85 + 0.3 * rand(treeSeed, 1));
    // A small islet of vegetation in the data does not get a canopy like a tree in the middle of a forest.
    if (kind !== 'street') radius *= Math.sqrt(clamp(coverAround(x, z, R.localCoverRadius) * 1.4, 0.3, 1));
    radius = Math.max(radius, R.crownMinRadius * 1.1);
    // The canopy must not reach into the wall.
    radius = Math.min(radius, dWall - R.crownWallGap);
    if (radius < R.crownMinRadius) {
      stats.rejected.crownTooSmall++;
      return false;
    }
    const spacing = radius * rule.spacing;
    if (!fits(x, z, spacing)) {
      stats.rejected.spacing++;
      return false;
    }
    const tintNoise = valueNoise2(x, z, R.tintPatch, seedTint);
    const smooth = clamp((tintNoise - 0.25) / 0.5, 0, 1);
    const index = trees.length;
    trees.push({
      x,
      z,
      y: input.heightAt(x, z) - R.rootDepth,
      height: h,
      radius,
      kind,
      species,
      yaw: rand(treeSeed, 2) * Math.PI * 2,
      tint: clamp(smooth * smooth * (3 - 2 * smooth) * 0.82 + 0.18 * rand(treeSeed, 3), 0, 1),
      crownBase: clamp((kind === 'forest' ? shape.crownBaseForest : shape.crownBase) + (species === 'shrub' ? 0 : 0.08 * (rand(treeSeed, 4) - 0.5)), 0, 0.6),
      flex: shape.flex,
      phase: rand(treeSeed, 5),
    });
    spacingOf.push(spacing);
    const g = clamp(Math.floor(z / GRID_M), 0, gRows - 1) * gCols + clamp(Math.floor(x / GRID_M), 0, gCols - 1);
    (grid[g] ??= []).push(index);
    return true;
  };

  // --- 1. Street avenues ------------------------------------------------------------------------
  const isRoad = (x: number, z: number): boolean => (occupancy.at(x, z) & roadMask) !== 0;
  for (const st of input.streets) {
    if (st.width < R.streetMinRoadWidth) continue;
    const p = st.points;
    const n = p.length / 2;
    // One street, one species: an avenue should be uniform.
    const species: TreeSpecies = rand(seed, st.id, 11) < 0.55 ? 'tall' : 'round';
    for (const side of [1, -1]) {
      let next = rand(seed, st.id, side + 20) * R.streetSpacing;
      let walked = 0;
      let station = 0;
      for (let k = 0; k + 1 < n; k++) {
        const ax = p[k * 2]!;
        const az = p[k * 2 + 1]!;
        const dx = p[k * 2 + 2]! - ax;
        const dz = p[k * 2 + 3]! - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-3) continue;
        const tx = dx / len;
        const tz = dz / len;
        const nx = -tz * side;
        const nz = tx * side;
        for (; next <= walked + len; next += R.streetSpacing) {
          station++;
          stats.streetStations++;
          const treeSeed = hashInts(seed, st.id, side + 30, station);
          const t = next - walked + (rand(treeSeed, 6) - 0.5) * 2 * R.streetJitter;
          const cx = ax + tx * t;
          const cz = az + tz * t;
          // Actual roadway edge: from the axis outward while it is still under a road point.
          let kerb = st.width / 2;
          if (isRoad(cx, cz)) {
            kerb = 0;
            while (kerb < st.width / 2 + 3 && isRoad(cx + nx * (kerb + 0.5), cz + nz * (kerb + 0.5))) kerb += 0.5;
            kerb += 0.25;
          }
          // Place for the trunk: a bit beyond the edge. If there is a sidewalk or wall there, try a bit farther, still within the street strip.
          for (let extra = 0; R.streetKerbOffset + extra <= R.streetBand; extra += 1) {
            const off = kerb + R.streetKerbOffset + extra;
            const x = cx + nx * off;
            const z = cz + nz * off;
            if (x < 0 || z < 0 || x >= sizeX || z >= sizeZ) break;
            if (!trunkFree(x, z)) continue;
            const dWall = walls.distance(x, z, WALL_REACH);
            if (dWall < R.trunkMinWallDistance + R.crownMinRadius) continue;
            // Another street is closer than this one (intersection): the row ends there.
            if (streetEdges.distance(x, z, R.streetBand, st.id) < R.streetKerbOffset * 0.6) break;
            const h = heightAround(x, z, R.streetCanopySearch);
            if (h < R.shrubMaxHeight) break;
            place(x, z, h, 'street', species, treeSeed);
            break;
          }
        }
        walked += len;
      }
    }
    yield;
  }

  // --- 2. Candidates from the fine grid, from the tallest ---------------------------------------------------
  const cell = R.candidateCell;
  const cCols = Math.ceil(sizeX / cell);
  const cRows = Math.ceil(sizeZ / cell);
  const candX: number[] = [];
  const candZ: number[] = [];
  const candH: number[] = [];
  const candPriority: number[] = [];
  const candSeed: number[] = [];
  for (let j = 0; j < cRows; j++) {
    for (let i = 0; i < cCols; i++) {
      const s = hashInts(seed, i, j);
      const x = (i + rand(s, 1)) * cell;
      const z = (j + rand(s, 2)) * cell;
      if (x >= sizeX || z >= sizeZ) continue;
      if (canopy.cover[cellOf(x, z)]! < coverMin) continue;
      const h = heightAround(x, z, R.heightSearchRadius);
      if (h < R.minVegetationHeight) continue;
      candX.push(x);
      candZ.push(z);
      candH.push(h);
      candPriority.push(h + 4 * rand(s, 3));
      candSeed.push(s);
    }
    if ((j & 7) === 7) yield;
  }
  stats.candidates = candX.length;
  const order = Array.from(candX.keys()).sort((a, b) => candPriority[b]! - candPriority[a]! || a - b);

  let done = 0;
  for (const c of order) {
    if ((++done & 1023) === 0) yield;
    const x = candX[c]!;
    const z = candZ[c]!;
    let h = candH[c]!;
    const s = candSeed[c]!;
    const dWall = walls.distance(x, z, WALL_REACH);
    if (dWall < 0) {
      stats.rejected.inWall++;
      continue;
    }
    if (dWall < R.trunkMinWallDistance) {
      stats.rejected.nearWall++;
      continue;
    }
    const forestCover = coverAround(x, z, R.forestNeighbourhoodRadius);
    const dStreet = streetEdges.distance(x, z, R.streetBand);
    if (dStreet < R.streetBand && !(forestCover >= R.forestMinCover && dStreet >= R.streetBandForestFrom)) {
      // The strip along a street belongs to the avenue.
      stats.rejected.streetBand++;
      continue;
    }

    let kind: TreeKind;
    let species: TreeSpecies;
    const u = rand(s, 7);
    const v = rand(s, 8);
    const conifer = valueNoise2(x, z, R.speciesPatch, seedConifer);
    const birch = valueNoise2(x, z, R.speciesPatch * 0.7, seedBirch);
    const tall = valueNoise2(x, z, R.speciesPatch * 0.8, seedTall);
    if (h < R.shrubMaxHeight) {
      kind = 'shrub';
      species = 'shrub';
    } else if (dWall < R.nearHouseDistance) {
      kind = 'house';
      h = Math.min(h, R.houseTreeMaxHeight);
      if (h < 4.2) {
        species = 'shrub';
        h = Math.min(h, R.shrubMaxHeight);
      } else species = birch + 0.3 * (u - 0.5) > R.birchThreshold - 0.08 ? 'birch' : conifer + 0.3 * (u - 0.5) > R.coniferThreshold ? 'conifer' : 'round';
    } else if (dWall >= R.forestMinWallDistance && forestCover >= R.forestMinCover) {
      kind = 'forest';
      species = conifer + 0.25 * (u - 0.5) > R.coniferThreshold ? 'conifer' : tall + 0.5 * (v - 0.5) > 0.58 ? 'tall' : 'round';
    } else {
      kind = 'park';
      species = birch + 0.3 * (u - 0.5) > R.birchThreshold ? 'birch' : conifer + 0.3 * (u - 0.5) > R.coniferThreshold ? 'conifer' : v < 0.75 ? 'round' : 'tall';
    }
    place(x, z, h, kind, species, s);
  }

  return { trees, stats };
}
