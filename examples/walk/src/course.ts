// The test course as pure data: rolling ground from the seed, flat pads with one station each, and the solids of the
// collision world. Nothing here touches the DOM or the graphics, so the headless check (tools/walk/course-scenarios.ts)
// walks over exactly the course the page draws.
//
// Layout: a 120 × 120 m square, nine pads of 28 × 28 m on a 3 × 3 grid (centres at 20, 60 and 100 m), the start in
// the middle. Ramps and the pit are shapes of the base surface; everything else is a solid. The square is fenced by
// invisible limits (`blocksSight: false`).

import { HeightField, streamSeed, valueNoise2 } from 'wallhammer-web/gen-core';
import { CollisionWorld } from 'wallhammer-web/world';

/** Edge of the square, metres. */
export const COURSE_SIZE_M = 120;
/** Grid step of the base surface, metres. */
export const GROUND_STEP_M = 0.5;

export type StationId = 'start' | 'walls' | 'pillars' | 'steps' | 'ramps' | 'platforms' | 'passages' | 'thin-wall' | 'footbridge';

export interface Station {
  id: StationId;
  /** Label for the HUD. */
  label: string;
  /** Rectangle of the pad: minX, minZ, maxX, maxZ. */
  rect: readonly [number, number, number, number];
  /** Colour of the station's solids. */
  color: readonly [number, number, number];
  /** A good place to stand to try the station: x, z and the heading (yaw 0 faces −z). */
  spot: readonly [number, number, number];
}

const pad = (cx: number, cz: number): [number, number, number, number] => [cx - 14, cz - 14, cx + 14, cz + 14];
const DEG = Math.PI / 180;
/** Yaw that faces +x, −x, +z and −z. */
const FACE_PX = -Math.PI / 2;
const FACE_NX = Math.PI / 2;
const FACE_PZ = Math.PI;
const FACE_NZ = 0;

export const STATIONS: readonly Station[] = [
  { id: 'start', label: 'Start', rect: pad(60, 60), color: [0.62, 0.6, 0.56], spot: [60, 60, FACE_NZ] },
  { id: 'walls', label: 'Walls and a corner: slides along a wall, stops in the corner', rect: pad(20, 20), color: [0.72, 0.52, 0.42], spot: [16, 24, FACE_NX] },
  { id: 'pillars', label: 'Pillars: gaps of 1.2 to 0.5 m (the body is 0.6 m wide)', rect: pad(60, 20), color: [0.55, 0.6, 0.7], spot: [56, 26, FACE_NZ] },
  { id: 'steps', label: 'Steps 8 × 0.2 m; a 0.3 m step walks up, a 0.5 m one does not', rect: pad(100, 20), color: [0.7, 0.66, 0.5], spot: [88, 21.5, FACE_PX] },
  { id: 'ramps', label: 'Ramps of 20°, 35° and 55° (steeper than 45° does not climb)', rect: pad(100, 60), color: [0.6, 0.6, 0.6], spot: [92, 60, FACE_PX] },
  { id: 'platforms', label: 'Platforms and gaps of 1 to 2.5 m to jump (the longer ones only running)', rect: pad(100, 100), color: [0.5, 0.66, 0.52], spot: [87, 98, FACE_PX] },
  { id: 'passages', label: 'Low passages: a 1.5 m ceiling (too low) and a 2 m one (passes)', rect: pad(60, 100), color: [0.66, 0.5, 0.62], spot: [59, 90, FACE_PZ] },
  { id: 'thin-wall', label: 'Thin wall 0.1 m (no way through, not even running)', rect: pad(20, 100), color: [0.5, 0.62, 0.68], spot: [20, 93, FACE_PZ] },
  { id: 'footbridge', label: 'Footbridge over a pit; out of the pit up a 20° ramp', rect: pad(20, 60), color: [0.62, 0.52, 0.4], spot: [31, 60, FACE_NX] },
];

/** The station whose pad holds the point, or null between pads. */
export function stationAt(x: number, z: number): Station | null {
  for (const s of STATIONS) {
    const r = s.rect;
    if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return s;
  }
  return null;
}

// --- Shapes of the base surface --------------------------------------------------------------------------------------

/** Ramps: three lanes rising toward +x onto one plateau 3 m high (x 104–112, z 48–72). */
export const RAMP_TOP_X = 104;
export const RAMP_END_X = 112;
export const RAMP_HEIGHT_M = 3;
export const RAMP_LANES: readonly { deg: number; z0: number; z1: number }[] = [
  { deg: 20, z0: 50, z1: 54 },
  { deg: 35, z0: 58, z1: 62 },
  { deg: 55, z0: 66, z1: 70 },
];

/** The pit under the footbridge: x 14–26, z 52–72, 3 m deep; its far end (z 63.8–72) is a 20° ramp back up. */
export const PIT = { x0: 14, x1: 26, z0: 52, z1: 72, depth: 3, rampDeg: 20 } as const;

function rampsHeight(x: number, z: number): number {
  if (x >= RAMP_TOP_X && x <= RAMP_END_X && z >= 48 && z <= 72) return RAMP_HEIGHT_M;
  if (x < RAMP_TOP_X) {
    for (const lane of RAMP_LANES) {
      if (z < lane.z0 || z > lane.z1) continue;
      const len = RAMP_HEIGHT_M / Math.tan(lane.deg * DEG);
      const start = RAMP_TOP_X - len;
      if (x > start) return ((x - start) / len) * RAMP_HEIGHT_M;
    }
  }
  return 0;
}

function pitHeight(x: number, z: number): number {
  if (x < PIT.x0 || x > PIT.x1 || z < PIT.z0 || z > PIT.z1) return 0;
  const len = PIT.depth / Math.tan(PIT.rampDeg * DEG);
  const start = PIT.z1 - len;
  if (z > start) return -PIT.depth + ((z - start) / len) * PIT.depth;
  return -PIT.depth;
}

/** Distance from a point to the nearest pad (0 inside one). */
function padDistance(x: number, z: number): number {
  let best = Infinity;
  for (const s of STATIONS) {
    const r = s.rect;
    const dx = Math.max(r[0] - x, 0, x - r[2]);
    const dz = Math.max(r[1] - z, 0, z - r[3]);
    best = Math.min(best, Math.sqrt(dx * dx + dz * dz));
  }
  return best;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The base surface as a height field: rolling ground between the pads, flat pads, the ramps and the pit. */
export function courseField(seed: number): HeightField {
  const s = streamSeed(`walk-${seed}`, 'ground');
  const n = Math.round(COURSE_SIZE_M / GROUND_STEP_M) + 1;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * GROUND_STEP_M;
      const z = j * GROUND_STEP_M;
      const rolling = 2.6 * (0.7 * valueNoise2(x, z, 22, s) + 0.3 * valueNoise2(x, z, 9, s + 1) - 0.5);
      // Flat on the pads, rolling from 1 m to 7 m away from them.
      const k = smooth(1, 7, padDistance(x, z));
      heights[j * n + i] = rolling * k + rampsHeight(x, z) + pitHeight(x, z);
    }
  }
  return new HeightField(GROUND_STEP_M, n, n, heights);
}

// --- Solids ------------------------------------------------------------------------------------------------------------

/** Tag of a solid: the index of its station in STATIONS, or LIMIT_TAG for the invisible fence. */
export const LIMIT_TAG = 100;

/** Pillars: centres along x at z = 20, radius 0.3 m, and the gap after each (between surfaces). */
export const PILLAR_RADIUS_M = 0.3;
export const PILLAR_GAPS_M: readonly number[] = [1.2, 1.0, 0.8, 0.7, 0.6, 0.5];
export const PILLAR_Z = 20;
export function pillarCentres(): number[] {
  const xs = [50];
  for (const g of PILLAR_GAPS_M) xs.push(xs[xs.length - 1]! + 2 * PILLAR_RADIUS_M + g);
  return xs;
}
/** x of the middle of gap `i`. */
export function pillarGapX(i: number): number {
  const xs = pillarCentres();
  return (xs[i]! + xs[i + 1]!) / 2;
}

/** Platforms: x0, x1 and top height; z 96–100. Gaps 1, 1.5, 2 and 2.5 m. */
export const PLATFORMS: readonly (readonly [number, number, number])[] = [
  [90, 93, 0.6],
  [94, 97, 0.6],
  [98.5, 101.5, 1.0],
  [103.5, 106.5, 1.0],
  [109, 112, 0.6],
];
export const PLATFORM_Z: readonly [number, number] = [96, 100];

export interface Course {
  seed: number;
  field: HeightField;
  world: CollisionWorld;
  /** Start: x, z and heading. */
  start: readonly [number, number, number];
}

/** The whole course from the seed: the base surface and every solid. */
export function buildCourse(seed: number): Course {
  const field = courseField(seed);
  const world = new CollisionWorld({
    heightAt: (x, z) => field.heightAt(x, z),
    baseMinY: field.minY,
    baseMaxY: field.maxY,
    baseExtent: [0, 0, COURSE_SIZE_M, COURSE_SIZE_M],
  });
  const tag = (id: StationId): number => STATIONS.findIndex((s) => s.id === id);

  // Walls and a corner: an L of two walls 12 m long meeting at (10, 10), and a long wall with its face at z = 30.
  const walls = { tag: tag('walls') };
  world.addBox(16, 9.8, 6.2, 0.2, 0, 0, 2.5, walls);
  world.addBox(9.8, 16, 0.2, 6.2, 0, 0, 2.5, walls);
  world.addBox(22, 30.2, 8, 0.2, 0, 0, 2.5, walls);

  // A row of pillars with narrowing gaps.
  const pillars = { tag: tag('pillars') };
  for (const x of pillarCentres()) world.addCylinder(x, PILLAR_Z, PILLAR_RADIUS_M, 0, 2.2, pillars);

  // Stairs of eight 0.2 m steps (0.4 m treads) onto a landing at 1.6 m; a single 0.3 m step; a 0.5 m step.
  const steps = { tag: tag('steps') };
  for (let i = 0; i < 8; i++) {
    const x0 = 92 + 0.4 * i;
    world.addPrism([x0, 14, 99, 14, 99, 18, x0, 18], 0, 0.2 * (i + 1), steps);
  }
  world.addPrism([92, 20, 98, 20, 98, 23, 92, 23], 0, 0.3, steps);
  world.addPrism([92, 25, 98, 25, 98, 28, 92, 28], 0, 0.5, steps);

  // Platforms at 0.6 and 1 m with gaps to jump.
  const platforms = { tag: tag('platforms') };
  for (const [x0, x1, top] of PLATFORMS) world.addPrism([x0, PLATFORM_Z[0], x1, PLATFORM_Z[0], x1, PLATFORM_Z[1], x0, PLATFORM_Z[1]], 0, top, platforms);

  // Two passages 2 m wide and 6 m long toward +z: the left one with its ceiling at 1.5 m, the right one at 2 m.
  const passages = { tag: tag('passages') };
  for (const [x0, ceiling] of [[52, 1.5], [64, 2]] as const) {
    world.addPrism([x0 - 0.4, 96, x0, 96, x0, 102, x0 - 0.4, 102], 0, 2.5, passages);
    world.addPrism([x0 + 2, 96, x0 + 2.4, 96, x0 + 2.4, 102, x0 + 2, 102], 0, 2.5, passages);
    world.addPrism([x0 - 0.4, 96, x0 + 2.4, 96, x0 + 2.4, 102, x0 - 0.4, 102], ceiling, 2.5, passages);
  }

  // A thin wall: 0.1 m thick, 16 m long, face toward the start at z = 99.95.
  world.addBox(20, 100, 8, 0.05, 0, 0, 2.5, { tag: tag('thin-wall') });

  // The footbridge: a plank 1.2 m wide over the pit, its top level with the ground on both sides.
  world.addBox(20, 60, 7, 0.6, 0, -0.2, 0, { tag: tag('footbridge') });

  // Invisible limits round the square, 1 m inside its edge.
  const limit = { standable: false, blocksSight: false, tag: LIMIT_TAG };
  const lo = field.minY - 5;
  const hi = field.maxY + 10;
  const e = COURSE_SIZE_M;
  world.addBox(e / 2, 0.75, e / 2, 0.25, 0, lo, hi, limit);
  world.addBox(e / 2, e - 0.75, e / 2, 0.25, 0, lo, hi, limit);
  world.addBox(0.75, e / 2, 0.25, e / 2, 0, lo, hi, limit);
  world.addBox(e - 0.75, e / 2, 0.25, e / 2, 0, lo, hi, limit);

  const st = STATIONS[0]!.spot;
  return { seed, field, world, start: [st[0], st[1], st[2]] };
}
