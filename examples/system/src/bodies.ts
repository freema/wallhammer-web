// The system of the example: a sun and four bodies with a surface, at the reduced scale the engine is built for
// (radii of tens of kilometres, distances of tens of thousands, a day of minutes). Plain data, read by the page and by
// the cell workers. The paths and the turning are placed by `BodySystem` of core from the time alone.
//
//   sun    the centre; it only shines
//   Hearth sea, forests and snow under a shell of air
//   Pale   its moon: craters, no air, always the same side toward Hearth, so each is large in the other's sky
//   Ember  a larger body of sand and rock under air of its own
//   Rime   a small frozen body far out, on a tilted, stretched path

import type { BodyDef, OrbitElements, SpinElements } from 'wallhammer-web/core';

/** What the surface of a body is made of (world.ts has one terrain per look). */
export type Look = 'living' | 'desert' | 'cratered' | 'ice';

export interface SurfaceSpec {
  /** Name in the system, in the URL and on screen. */
  name: string;
  /** The body it goes round. */
  parent: string;
  /** Radius of the base sphere in metres. */
  radiusM: number;
  /** Thickness of its shell of air in metres; 0 = none. Every shell is 0.3 radii thick (see `AIR_PER_RADIUS`). */
  airM: number;
  look: Look;
  /** Finest quadtree level of its cells: about 50–80 m along an edge. */
  leafLevel: number;
  orbit: OrbitElements;
  spin: SpinElements;
  /** Radius of the sphere within which the camera is carried along with the body, in radii. */
  influenceRadii: number;
  /** Colour of its path and of its air seen from afar, 0–1. */
  tint: readonly [number, number, number];
  /** A body to have in the sky after a landing, when there is one worth it. */
  companion?: string;
}

/**
 * Thickness of a shell of air in radii of its body. The engine computes the tables of the air once, for one ratio of
 * shell to sphere and one mixture; they hold for every body whose air is the same mixture scaled to its size.
 */
export const AIR_PER_RADIUS = 0.3;

export const SUN = { name: 'sun', radiusM: 300_000 } as const;

export const SURFACES: readonly SurfaceSpec[] = [
  {
    name: 'Hearth',
    parent: 'sun',
    radiusM: 100_000,
    airM: 100_000 * AIR_PER_RADIUS,
    look: 'living',
    leafLevel: 11,
    orbit: { semiMajorAxis: 22_000_000, periodS: 10_800, eccentricity: 0.03, phase: 0.08 },
    spin: { periodS: 1200, tiltDeg: 18, tiltLongitudeDeg: 40 },
    influenceRadii: 30,
    tint: [0.42, 0.62, 1.0],
    companion: 'Pale',
  },
  {
    name: 'Pale',
    parent: 'Hearth',
    radiusM: 30_000,
    airM: 0,
    look: 'cratered',
    leafLevel: 10,
    orbit: { semiMajorAxis: 1_400_000, periodS: 2400, inclinationDeg: 8, ascendingNodeDeg: 30, phase: 0.3 },
    // One turn per round: the same side faces Hearth.
    spin: { periodS: 2400 },
    influenceRadii: 12,
    tint: [0.78, 0.78, 0.76],
    companion: 'Hearth',
  },
  {
    name: 'Ember',
    parent: 'sun',
    radiusM: 140_000,
    airM: 140_000 * AIR_PER_RADIUS,
    look: 'desert',
    leafLevel: 12,
    orbit: { semiMajorAxis: 38_000_000, periodS: 24_500, eccentricity: 0.06, inclinationDeg: 3, ascendingNodeDeg: 110, phase: 0.55 },
    spin: { periodS: 1900, tiltDeg: 25, tiltLongitudeDeg: 200 },
    influenceRadii: 30,
    tint: [1.0, 0.62, 0.38],
  },
  {
    name: 'Rime',
    parent: 'sun',
    radiusM: 60_000,
    airM: 0,
    look: 'ice',
    leafLevel: 11,
    orbit: { semiMajorAxis: 60_000_000, periodS: 48_600, eccentricity: 0.18, inclinationDeg: 9, ascendingNodeDeg: 250, periapsisDeg: 60, phase: 0.8 },
    spin: { periodS: 3100, tiltDeg: 6, tiltLongitudeDeg: 300 },
    influenceRadii: 30,
    tint: [0.7, 0.9, 1.0],
  },
];

/** Ticks of the system's clock per second: the time is kept as a whole number of them. */
export const CLOCK_HZ = 1000;

/** The whole system for `BodySystem`: the sun first (index 0), then the surfaces in the order of `SURFACES`. */
export function bodyDefs(): BodyDef[] {
  return [
    // The sun's reach holds every place of the system, so a position always has a body to be kept by.
    { name: SUN.name, radius: SUN.radiusM, influence: 1e13 },
    ...SURFACES.map((s): BodyDef => ({ name: s.name, parent: s.parent, radius: s.radiusM, orbit: s.orbit, spin: s.spin, influence: s.radiusM * s.influenceRadii })),
  ];
}
