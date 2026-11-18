// The plan of the outpost: where everything stands, as plain numbers, and the routes that moving things follow. It is
// the shared ground truth of all content modules and of the terrain (which flattens a pad under every site and keeps
// craters and rocks off sites and routes). Builders that add a structure add or use its site here.
//
// Axes: metres, y up. The default camera looks toward −z (yaw 0), so +x is screen right and +z is toward the viewer.
// The central dome stands near the origin with its airlock facing +z.

import { normalize } from './kit/math.ts';
import type { V3 } from './kit/math.ts';

export interface DomeSite {
  id: string;
  x: number;
  z: number;
  /** Radius of the cylindrical wall (the cap starts at this radius). */
  radius: number;
  /** Height of the wall under the cap. */
  wallH: number;
  /** Height of the cap above the wall (above the shoulder when there is one). */
  capH: number;
  /** A sloped ring between the wall and the cap (the two-tier central dome). */
  shoulder?: { h: number; inset: number };
}

export interface Site {
  id: string;
  x: number;
  z: number;
  /** Turn about +y, radians (0: the front faces +z). */
  yaw: number;
}

/** A flat circle in the terrain (height `y`), blended into the ground over `fall` metres. */
export interface Pad {
  x: number;
  z: number;
  r: number;
  fall: number;
  y: number;
}

/** A circle that craters and rocks keep out of. */
export interface Keepout {
  x: number;
  z: number;
  r: number;
}

export interface Layout {
  seed: number;
  /** Unit direction to the sun (low: long shadows). */
  sunDir: V3;
  /** The planet over the horizon: unit direction to its centre and its angular radius. */
  planet: { dir: V3; radiusDeg: number };
  domes: { central: DomeSite; west: DomeSite; north: DomeSite; east: DomeSite };
  /** Corridors join dome pairs (ids). */
  corridors: [string, string][];
  /** Tube of every corridor: axis height over the ground at the domes, and radius. */
  corridor: { axisY: number; radius: number };
  /** The airlock on the front of the central dome, its maintenance corner, and the other sites of section 3. */
  airlock: Site;
  maintenance: Site;
  tower: Site;
  antennas: Site;
  generators: Site;
  solar: Site[];
  landingPad: Site & { radius: number };
  /** Crates of the style test (and of the maintenance corner). */
  crates: (Site & { size: V3 })[];
  /** The rover's closed loop (x, z points, about 0.5 m apart, counter-clockwise seen from above). */
  roverLoop: [number, number][];
  /** Extra tyre tracks that leave the loop (open polylines). */
  trackSpurs: [number, number][][];
  /** The walking astronaut's route: from the foot of the airlock stairs to the maintenance corner and back. */
  walkerPath: [number, number][];
  /** Where the second astronaut stands (by the foot of the stairs, facing the rover side). */
  standSpot: [number, number];
  pads: Pad[];
  keepouts: Keepout[];
  /** The fixed large crater in the back (x, z, radius, depth). */
  bigCrater: { x: number; z: number; r: number; depth: number };
  /** Radius of the ring of far ridges (where they rise). */
  ridgeRadius: number;
}

function deg(d: number): number {
  return (d * Math.PI) / 180;
}

/** A direction from a heading (degrees from −z toward +x) and an elevation (degrees above the horizon). */
export function skyDir(headingDeg: number, elevationDeg: number): V3 {
  const h = deg(headingDeg), e = deg(elevationDeg);
  return normalize([Math.sin(h) * Math.cos(e), Math.sin(e), -Math.cos(h) * Math.cos(e)]);
}

/** Ellipse points about (cx, cz), radii (rx, rz), about `stepM` apart, counter-clockwise seen from above. */
function ellipse(cx: number, cz: number, rx: number, rz: number, stepM: number): [number, number][] {
  const perimeter = Math.PI * (3 * (rx + rz) - Math.sqrt((3 * rx + rz) * (rx + 3 * rz)));
  const n = Math.max(8, Math.round(perimeter / stepM));
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([cx + rx * Math.cos(t), cz - rz * Math.sin(t)]);
  }
  return out;
}

export function outpostLayout(seed: number): Layout {
  // The central dome is two-tier: a wall, a sloped shoulder carrying the window band, then the cap (cut flat on top
  // for the roof platform).
  const central: DomeSite = { id: 'central', x: 0, z: -2, radius: 8.5, wallH: 3.2, capH: 4.3, shoulder: { h: 1.8, inset: 1.0 } };
  const west: DomeSite = { id: 'west', x: -26, z: 7, radius: 6.5, wallH: 2.4, capH: 4.6 };
  const north: DomeSite = { id: 'north', x: -21, z: -25, radius: 6, wallH: 2.3, capH: 4.3 };
  const east: DomeSite = { id: 'east', x: 18, z: -13, radius: 5.5, wallH: 2.2, capH: 4.0 };
  // The airlock portal stands on the wall of the central dome, at x = 1.5 (its back sinks into the wall).
  const airlockX = 1.5;
  const airlock: Site = { id: 'airlock', x: airlockX, z: central.z + Math.sqrt(central.radius ** 2 - airlockX ** 2), yaw: 0 };
  const maintenance: Site = { id: 'maintenance', x: -4.2, z: 9.8, yaw: 0 };
  const landingPad = { id: 'landing-pad', x: 37, z: -24, yaw: 0, radius: 9.5 };
  const roverLoop = ellipse(25, 7, 8.5, 10, 0.5);
  // From the foot of the stairs (portal front + 3.6 m of stairs), round the left handrail, to the workbench and back.
  const walkerPath: [number, number][] = [[1.5, 13.6], [0.0, 13.5], [-1.0, 12.4], [-1.8, 10.6], [-2.5, 9.1], [-3.0, 8.3]];
  const standSpot: [number, number] = [4.6, 13.2];
  const crates: (Site & { size: V3 })[] = [
    { id: 'crate-a', x: -3.1, z: 13.9, yaw: 0.1, size: [1.5, 1.0, 1.1] },
    { id: 'crate-b', x: -1.5, z: 14.7, yaw: -0.08, size: [1.1, 0.8, 0.9] },
    { id: 'crate-c', x: -3.0, z: 15.5, yaw: 0.16, size: [0.95, 0.65, 0.8] },
  ];
  const solar: Site[] = [
    { id: 'solar-west', x: -33, z: -13, yaw: -0.35 },
    { id: 'solar-north', x: 20, z: -42, yaw: -0.45 },
  ];
  const tower: Site = { id: 'tower', x: -34, z: -36, yaw: 0.3 };
  const antennas: Site = { id: 'antennas', x: 14.5, z: -30, yaw: 0 };
  const generators: Site = { id: 'generators', x: 9.5, z: -28, yaw: -0.15 };
  const bigCrater = { x: 36, z: -55, r: 11, depth: 1.8 };

  const domes = { central, west, north, east };
  const pads: Pad[] = [
    ...Object.values(domes).map((d) => ({ x: d.x, z: d.z, r: d.radius + 2.5, fall: 6, y: 0 })),
    { x: airlock.x, z: airlock.z + 4, r: 6, fall: 5, y: 0 },
    { x: maintenance.x, z: maintenance.z, r: 5.5, fall: 5, y: 0 },
    { x: landingPad.x, z: landingPad.z, r: landingPad.radius + 2, fall: 6, y: 0 },
    ...solar.map((s) => ({ x: s.x, z: s.z, r: 9.5, fall: 5, y: 0 })),
    { x: tower.x, z: tower.z, r: 4, fall: 4, y: 0 },
    { x: (antennas.x + generators.x) / 2, z: (antennas.z + generators.z) / 2, r: 7, fall: 5, y: 0 },
  ];
  const keepouts: Keepout[] = [
    ...pads.map((p) => ({ x: p.x, z: p.z, r: p.r + 1 })),
    // Corridors between the domes.
    ...([['central', 'west'], ['central', 'north'], ['central', 'east']] as const).flatMap(([a, c]) => {
      const A = domes[a], C = domes[c];
      const out: Keepout[] = [];
      for (let t = 0; t <= 1; t += 0.1) out.push({ x: A.x + (C.x - A.x) * t, z: A.z + (C.z - A.z) * t, r: 4 });
      return out;
    }),
    ...walkerPath.map(([x, z]) => ({ x, z, r: 1.8 })),
    ...crates.map((c) => ({ x: c.x, z: c.z, r: 1.6 })),
    { x: bigCrater.x, z: bigCrater.z, r: bigCrater.r * 1.3 },
  ];
  const trackSpurs: [number, number][][] = [
    // Toward the landing pad ramp, and out of the picture at the bottom right.
    [[30.5, -0.5], [33, -6], [35.5, -11.5], [37, -14.5]],
    [[29, 16], [32, 22], [36, 29], [41, 37], [46, 46]],
  ];
  for (const s of trackSpurs) for (const [x, z] of s) keepouts.push({ x, z, r: 2.2 });
  for (let i = 0; i < roverLoop.length; i += 4) keepouts.push({ x: roverLoop[i]![0], z: roverLoop[i]![1], r: 2.6 });

  return {
    seed,
    sunDir: skyDir(-120, 24),
    planet: { dir: skyDir(21, 1.7), radiusDeg: 4.5 },
    domes,
    corridors: [['central', 'west'], ['central', 'north'], ['central', 'east']],
    corridor: { axisY: 2.2, radius: 1.3 },
    airlock,
    maintenance,
    tower,
    antennas,
    generators,
    solar,
    landingPad,
    crates,
    roverLoop,
    trackSpurs,
    walkerPath,
    standSpot,
    pads,
    keepouts,
    bigCrater,
    ridgeRadius: 250,
  };
}
