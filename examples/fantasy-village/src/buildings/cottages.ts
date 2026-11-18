// The six cottages (B2), each a different plan (layout.ts CottagePlan) and silhouette, composed from the architecture
// kit (src/arch) and the shared helpers of this folder (shared.ts):
//
//   cottage-0  'L'        a storey and a knee wall, a back wing with its own gable roof running into the main roof
//   cottage-1  'chimney'  two storeys jettied to the front on a terrace with a stone retaining wall and steps, a big
//                         chimney breast outside the east gable, a back dormer
//   cottage-2  'annex'    a storey and a knee wall, a lean-to annex of stone and planks against the west gable
//   cottage-3  'dormer'   a steep roof over a knee wall with two big front dormers and one at the back
//   cottage-4  'long'     long and low under ochre thatch with deep bell-cast eaves, a porch on posts along
//                         the front, a tall chimney through the ridge
//   cottage-5  'crooked'  two storeys leaning, the steep sagging roof twisted against the walls, a crooked chimney,
//                         a low side wing
//
// Every cottage: shingle roofs in red or rust (cottage-4 thatch), lit windows (the evening glow and a warm light at
// one or two of them), a lantern by the door, smoke from every chimney, baked ambient occlusion.
// Owner: buildings. POIs it serves: 'cottage-door' (in front of each door: the door is at local x 0 on the front).

import { COTTAGE_RUST, THATCH_PALETTE, buildHouse, buildRoof, doorAt, dormer, dormerHole, emitters, openSite, paletteFor, rectWalls, roofHoleFor, roofShape, stoneChimney, stoneSteps, timber, wallFrame, wallLantern, wallPoint, windowAt } from '../arch/index.ts';
import type { ArchPalette, DormerSpec, House, HouseSpec, Site } from '../arch/index.ts';
import type { ContentModule, ParticleSource, PointLight, SolidDef, StaticPiece, Vec3 } from '../kit/index.ts';
import { MAT, MeshBuilder, bevelBox, compose34, hex, lerp, mixRgb } from '../kit/index.ts';
import { chimneySmoke } from '../fx/smoke.ts';
import type { Structure } from '../layout.ts';
import { finish, foundationDepth, gableInfill, leanToRoof, localGround, plankWall, postOnPad, stoneCourses, stoneWall, structureSolids, thatchRoof } from './shared.ts';
import type { StoneOpening } from './shared.ts';

type Ground = (lx: number, lz: number) => number;

/** What a plan builds besides the geometry: chimney tops (site-local) with the smoke strength. */
interface Built {
  /** `world`: the top is already a world point (built in a sub-frame). */
  smoke: { top: Vec3; strength: number; world?: boolean }[];
}

// Window presets (B2: windows 0.8–1.0 m wide; shutters and flower boxes on the street sides).
const shuttered = (w = 0.85, h = 1.1) => ({ shape: 'square' as const, w, h, bars: 'cross' as const, shutters: true, box: true });
const plain = (w = 0.8, h = 1.0) => ({ shape: 'square' as const, w, h, bars: 'cross' as const });
const lattice = (w = 0.75, h = 0.95) => ({ shape: 'square' as const, w, h, bars: 'lattice' as const });
const lit = { radius: 5.5, intensity: 0.65 };

/** The lantern beside the front door (wall frame of the ground floor's front wall). */
function doorLantern(site: Site, house: House, offset: number, v = 2.05): void {
  const front = house.walls[0]!.front;
  site.onWall(front, (w) => wallLantern(w.child('lantern'), { u: front.length / 2 + offset, v, reach: 0.38, radius: 6, intensity: 0.9 }));
}

const smokeOf = (h: House, strength: number): Built['smoke'] => h.chimneyTops.map((t) => ({ top: t, strength }));

// --- cottage-0: L plan -------------------------------------------------------------------------------------------------

function cottageL(site: Site, s: Structure, g: Ground): Built {
  const r = s.body;
  const wing = s.wings[0]!;
  const floorY = 0.65;
  const below = foundationDepth(g, { x: (r.x + wing.x) / 2, z: (r.z + wing.z) / 2, w: r.w + 1, d: r.d + wing.d });
  // The wing covers the main back wall from its east corner to the wing's west wall.
  const coveredBack = r.x + r.w / 2 - (wing.x - wing.w / 2) + 0.05;
  const main: HouseSpec = {
    rect: r,
    floorY,
    storeys: [2.75, 0.75],
    storeyWalls: { 0: { back: { from: coveredBack } } },
    plinth: {
      below,
      rises: [{ side: 'front', u0: 0, u1: 0.7, top: 1.15 }, { side: 'left', u0: r.d - 0.9, u1: r.d, top: 0.95 }],
      buttresses: [{ x: r.x - r.w / 2, z: r.z - r.d / 2 + 0.8, yaw: -Math.PI / 2, height: 1.7, width: 0.8, depth: 0.9 }],
    },
    openings: [
      { side: 'front', storey: 0, at: 0, door: { w: 1.05, h: 2.15, shape: 'square', surround: 'timber' } },
      { side: 'front', storey: 0, at: -2.35, window: { ...shuttered(), light: lit } },
      { side: 'front', storey: 0, at: 2.3, window: shuttered(0.9, 1.15) },
      { side: 'left', storey: 0, at: 0.9, window: plain(0.8, 1.05) },
      { side: 'left', storey: 'gable', at: 0, window: { shape: 'round', w: 0.75, h: 0.75, bars: 'cross', sill: false, v: 0.55 } },
      { side: 'right', storey: 0, at: -0.9, window: { ...plain(0.85, 1.05), shutters: true } },
      { side: 'right', storey: 'gable', at: 0.3, window: { ...plain(0.7, 0.85), v: 0.45 } },
      { side: 'back', storey: 0, at: 1.9, window: lattice() },
    ],
    roof: {
      axis: 'x',
      pitch: 0.78,
      eave: 0.6,
      gable: [0.7, 0.55],
      sag: 0.32,
      curl: 0.42,
      dormers: [{ facing: 'front', at: -1.5, width: 1.7, height: 1.35, window: { shape: 'square', w: 0.7, h: 0.8, bars: 'cross', box: true } }],
    },
    chimneys: [{ x: r.x - 1.35, z: r.z - 1.0, w: 0.9, d: 0.85, above: 0.9, pots: 1, smoke: false }],
  };
  const wingSpec: HouseSpec = {
    rect: wing,
    floorY,
    storeys: [2.75],
    // Its front wall stands inside the main body up to the main east wall.
    walls: { front: { from: r.x + r.w / 2 - (wing.x - wing.w / 2) - 0.05 } },
    plinth: { below, rises: [{ side: 'back', u0: wing.w - 0.7, u1: wing.w, top: 1.05 }] },
    openings: [
      { side: 'back', storey: 0, at: -0.3, window: { ...plain(0.85, 1.05), shutters: true } },
      { side: 'back', storey: 'gable', at: 0, window: { shape: 'arched', w: 0.7, h: 1.0, bars: 'cross', v: 0.4 } },
      { side: 'right', storey: 0, at: 0.2, window: { ...lattice(0.8, 1.0), glow: 0.85 } },
      { side: 'left', storey: 0, at: 0.55, door: { w: 0.95, h: 2.0, shape: 'square', surround: 'timber', hardware: true } },
    ],
    roof: {
      axis: 'z',
      pitch: 0.86,
      eave: 0.5,
      // The front end runs into the main roof (open), far enough to meet its back slope.
      gable: [0.55, 1.55],
      ends: ['gable', 'open'],
      sag: 0.14,
      curl: 0.3,
    },
  };
  const h = buildHouse(site.child('main'), main);
  buildHouse(site.child('wing'), wingSpec);
  doorLantern(site.child('front'), h, 0.95);
  return { smoke: smokeOf(h, 0.9) };
}

// --- cottage-1: two storeys on a terrace, a chimney breast on the gable --------------------------------------------------

function cottageChimney(site: Site, s: Structure, g: Ground): Built {
  const r = s.body;
  const floorY = 0.7;
  const main: HouseSpec = {
    rect: r,
    floorY,
    storeys: [2.7, 2.45],
    jetty: { front: 0.42, back: 0.25 },
    plinth: {
      below: 0.6,
      rises: [{ side: 'front', u0: r.w - 0.75, u1: r.w, top: 1.45 }, { side: 'left', u0: 0, u1: 1.1, top: 1.1 }],
    },
    openings: [
      { side: 'front', storey: 0, at: 0, door: { w: 1.15, h: 2.35, shape: 'arched', surround: 'stone' } },
      { side: 'front', storey: 0, at: -2.25, window: { ...shuttered(0.9, 1.15), light: lit } },
      { side: 'front', storey: 0, at: 2.3, window: { shape: 'round', w: 0.85, h: 0.85, bars: 'cross', box: true, v: 1.05 } },
      { side: 'front', storey: 1, at: -2.3, window: shuttered() },
      { side: 'front', storey: 1, at: 0, window: { ...shuttered(0.8, 1.0), light: { radius: 5, intensity: 0.5 } } },
      { side: 'front', storey: 1, at: 2.3, window: shuttered() },
      { side: 'left', storey: 0, at: 0.8, window: plain(0.8, 1.05) },
      { side: 'left', storey: 1, at: -0.9, window: { shape: 'arched', w: 0.75, h: 1.15, bars: 'cross', box: true } },
      { side: 'left', storey: 'gable', at: 0, window: { shape: 'round', w: 0.7, h: 0.7, bars: 'cross', sill: false, v: 0.6 } },
      // The east gable carries the chimney breast in its middle: windows beside it.
      { side: 'right', storey: 0, at: 1.9, window: lattice(0.7, 0.95) },
      { side: 'right', storey: 1, at: -1.95, window: plain(0.7, 0.95) },
      { side: 'back', storey: 0, at: -1.6, window: { ...plain(0.85, 1.05), shutters: true } },
      { side: 'back', storey: 1, at: 1.8, window: plain(0.8, 1.0) },
    ],
    roof: {
      axis: 'x',
      pitch: 0.84,
      eave: 0.6,
      gable: [0.65, 0.75],
      sag: 0.36,
      curl: 0.5,
      dormers: [{ facing: 'back', at: -1.0, width: 1.8, height: 1.4 }],
    },
    chimneys: [
      // Outside the east gable, from the ground past the ridge, widening into a breast over the ground floor.
      { x: r.x + r.w / 2 + 0.55, z: r.z - 0.2, w: 1.0, d: 1.45, taper: 0.82, above: 1.5, pots: 2, smoke: false, breast: { height: floorY + 3.3, extra: 0.4 } },
    ],
  };
  const h = buildHouse(site.child('main'), main);
  doorLantern(site.child('front'), h, -1.05, 2.45);
  terrace(site.child('terrace'), s, g);
  return { smoke: smokeOf(h, 1.05) };
}

/**
 * The retaining wall round a raised pad (Structure.raise): coursed blocks a little outside the pad's ring, from the
 * natural ground up to a low parapet, with a flight of steps down from the door.
 */
function terrace(site: Site, s: Structure, g: Ground): void {
  const r = s.body;
  // Layout pad margin of this cottage is 2.2 m; the wall stands 0.5 m beyond (the pad's falloff runs under it).
  const m = 2.2 + 0.5;
  const ring = { x: r.x, z: r.z, w: r.w + 2 * m, d: r.d + 2 * m };
  const walls = rectWalls(ring, 0);
  const sides = ['front', 'right', 'back', 'left'] as const;
  let lowest = 0;
  for (const side of sides) {
    const w = walls[side];
    for (let k = 0; k <= 10; k++) {
      const p = wallPoint(w, (w.length * k) / 10, 0, 0.9);
      lowest = Math.min(lowest, g(p[0], p[2]));
    }
  }
  const courses = stoneCourses(site, lowest - 0.45, 0.4, [0.55, 0.72]);
  const stepW = 1.5;
  sides.forEach((side, e) => {
    const w = walls[side];
    const L = w.length;
    const ground = (u: number): number => {
      const p = wallPoint(w, u, 0, 0.9);
      return g(p[0], p[2]);
    };
    const ops: StoneOpening[] = side === 'front' ? [{ u0: L / 2 - stepW / 2 - 0.05, u1: L / 2 + stepW / 2 + 0.05, v0: -20, v1: 20, lintel: false }] : [];
    site.onWall(w, (ws) => stoneWall(ws, { to: L, bottom: courses[0]!, top: 0.4, courses, openings: ops, depth: 0.95, proud: 0.12, edge: e, ground, block: [0.85, 1.3] }));
  });
  // Steps from the pad down to the ground in front of the door: a frame at the ground height there.
  const front = walls.front;
  const mid = wallPoint(front, front.length / 2, 0, 0);
  let gy = 0;
  for (let k = 0; k <= 6; k++) gy = Math.min(gy, g(mid[0], mid[2] + 0.4 + k * 0.4));
  if (gy < -0.15) {
    const f = wallFrame([front.a[0], front.a[1]], [front.b[0], front.b[1]], gy);
    site.onWall(f, (ws) => {
      stoneSteps(ws, { u: front.length / 2, width: stepW, top: -gy, run: 0.4, landing: 0.35 });
      // Cheek stones either side of the flight.
      for (const sx of [-1, 1]) {
        const u = front.length / 2 + sx * (stepW / 2 + 0.28);
        const n = Math.max(1, Math.ceil(-gy / 0.5));
        for (let k = 0; k < n; k++) {
          const v0 = (-gy * k) / n - 0.3, v1 = (-gy * (k + 1)) / n;
          const reach = lerp(0.6 + -gy * 0.95, 0.5, k / n);
          stoneWallBlock(ws, u, v0, v1, reach);
        }
      }
    });
  }
}

/** A long cheek stone beside a flight of steps (wall frame: u along, v up, w out). */
function stoneWallBlock(site: Site, u: number, v0: number, v1: number, reach: number): void {
  const d = reach + 0.2;
  site.b.withFlags({ cls: MAT.stone }, () =>
    bevelBox(site.b, [u, v0, d / 2 - 0.25], [0.5, v1 - v0 + 0.06, d], mixRgb(site.pal.stone, site.pal.stoneDark, site.s.nextRange(0, 0.5)), { bevel: 0.06, jitter: 0.025, stream: site.s }),
  );
}

// --- cottage-2: a lean-to annex on the west gable ----------------------------------------------------------------------

function cottageAnnex(site: Site, s: Structure, g: Ground): Built {
  const r = s.body;
  const a = s.wings[0]!;
  const floorY = 0.6;
  const below = foundationDepth(g, r);
  // The annex covers the main west wall from its back corner to the annex front.
  const coveredLeft = a.z + a.d / 2 - (r.z - r.d / 2) + 0.05;
  const main: HouseSpec = {
    rect: r,
    floorY,
    storeys: [2.65, 0.85],
    storeyWalls: { 0: { left: { from: coveredLeft } } },
    plinth: { below, rises: [{ side: 'right', u0: 0, u1: 0.8, top: 1.2 }, { side: 'back', u0: 0, u1: 1.0, top: 0.95 }] },
    openings: [
      { side: 'front', storey: 0, at: 0, door: { w: 1.0, h: 2.1, shape: 'arched', surround: 'timber' } },
      { side: 'front', storey: 0, at: -2.0, window: { ...shuttered(0.85, 1.1), light: lit } },
      { side: 'front', storey: 0, at: 2.05, window: shuttered(0.9, 1.1) },
      { side: 'right', storey: 0, at: 0.4, window: { shape: 'round', w: 0.85, h: 0.85, bars: 'cross', box: true, v: 1.1 } },
      { side: 'right', storey: 'gable', at: 0, window: { ...plain(0.75, 0.9), shutters: true, v: 0.45 } },
      { side: 'left', storey: 'gable', at: 0.2, window: { shape: 'round', w: 0.6, h: 0.6, bars: 'cross', sill: false, v: 0.95 } },
      { side: 'back', storey: 0, at: -1.2, window: lattice(0.75, 0.95) },
    ],
    roof: { axis: 'x', pitch: 0.72, eave: 0.6, gable: [0.5, 0.65], sag: 0.3, curl: 0.38, dormers: [{ facing: 'back', at: 0.9, width: 1.7, height: 1.3 }] },
    chimneys: [{ x: r.x + 1.9, z: r.z - 0.7, w: 0.95, d: 0.85, above: 1.0, pots: 2, smoke: false }],
  };
  const h = buildHouse(site.child('main'), main);
  annex(site.child('annex'), s, g, below);
  doorLantern(site.child('front'), h, 0.95);
  return { smoke: smokeOf(h, 0.85) };
}

/** The annex: a stone base course and plank walls under a lean-to roof sloping away from the gable. */
function annex(site: Site, s: Structure, g: Ground, below: number): void {
  const r = s.body;
  const a = s.wings[0]!;
  const xIn = r.x - r.w / 2; // the main west wall
  const xOut = a.x - a.w / 2;
  const z0 = a.z - a.d / 2, z1 = a.z + a.d / 2;
  const over = 0.45;
  const yHigh = 3.15, yLow = 1.95;
  // Roof surface height over local x (the deck's top).
  const roofY = (x: number): number => lerp(yHigh, yLow, (xIn - x) / (xIn - (xOut - over)));
  const under = (x: number): number => roofY(x) - 0.17;
  const courses = stoneCourses(site, -below, 0.85, [0.4, 0.5]);
  // Walls in wall order round the outside: front (z1, west → east), outer (x out), back (z0, east → west).
  const walls = [
    { w: wallFrame([xOut, z1], [xIn, z1]), side: 'front' },
    { w: wallFrame([xOut, z0], [xOut, z1]), side: 'outer' },
    { w: wallFrame([xIn, z0], [xOut, z0]), side: 'back' },
  ];
  walls.forEach(({ w, side }, e) => {
    const L = w.length;
    const xAt = (u: number): number => wallPoint(w, u, 0)[0];
    const top = (u: number): number => under(xAt(u));
    const ground = (u: number): number => {
      const p = wallPoint(w, u, 0, 0.5);
      return g(p[0], p[2]);
    };
    const door = side === 'front' ? { u: L - 1.0, w: 0.95, h: 1.95 } : undefined;
    const win = side === 'outer' ? { u: L / 2 + 0.2, v: 0.95, w: 0.6, h: 0.55 } : side === 'back' ? { u: 1.2, v: 1.05, w: 0.55, h: 0.55 } : undefined;
    site.onWall(w, (ws) => {
      const stoneOps: StoneOpening[] = door ? [{ u0: door.u - door.w / 2, u1: door.u + door.w / 2, v0: 0, v1: 0.85, lintel: false }] : [];
      stoneWall(ws, { to: L, bottom: -below, top: 0.85, courses, openings: stoneOps, depth: 0.5, proud: 0.1, edge: e, cornerStart: side !== 'front', cornerEnd: side !== 'back', ground });
      const plankOps = [
        ...(door ? [{ u0: door.u - door.w / 2, u1: door.u + door.w / 2, v0: 0, v1: door.h }] : []),
        ...(win ? [{ u0: win.u - win.w / 2, u1: win.u + win.w / 2, v0: win.v, v1: win.v + win.h }] : []),
      ];
      plankWall(ws, { from: 0, to: L, bottom: 0.85, top, openings: plankOps });
      // Corner posts and a head rail under the roof.
      timber(ws, [0.1, 0.85, -0.02], [0.1, top(0.1) - 0.02, -0.02], { width: 0.24, depth: 0.24, sag: 0 });
      timber(ws, [0.05, 0.86, 0.02], [L - 0.05, 0.86, 0.02], { width: 0.2, depth: 0.16, sag: 0.01 });
      // A plank door with a timber surround, a small lattice window.
      if (door) doorAt(ws.child('door'), { u: door.u, v: 0, w: door.w, h: door.h, shape: 'square', surround: 'timber', steps: 0 });
      if (win) windowAt(ws.child('win'), { shape: 'square', ...win, bars: 'lattice', glow: 0.6, depth: 0.12 });
    });
  });
  // Lean-to roof: its frame turns the slope to run west (frame z = −local x, frame x = local z).
  site.at(compose34([0, 0, 0], -Math.PI / 2), (f) =>
    leanToRoof(f, { x0: z0 - 0.35, x1: z1 + 0.35, zHigh: -xIn - 0.02, yHigh, zLow: -(xOut - over), yLow, sag: 0.07 }),
  );
}

// --- cottage-3: big dormers --------------------------------------------------------------------------------------------

function cottageDormer(site: Site, s: Structure, g: Ground): Built {
  const r = s.body;
  const floorY = 0.7;
  const main: HouseSpec = {
    rect: r,
    floorY,
    storeys: [2.7, 1.05],
    plinth: {
      below: foundationDepth(g, r),
      rises: [{ side: 'front', u0: 0, u1: 0.65, top: 1.3 }, { side: 'front', u0: r.w - 0.65, u1: r.w, top: 1.3 }],
      buttresses: [{ x: r.x + r.w / 2, z: r.z - r.d / 2 + 0.85, yaw: Math.PI / 2, height: 1.8, width: 0.8, depth: 0.95 }],
    },
    openings: [
      { side: 'front', storey: 0, at: 0, door: { w: 1.15, h: 2.3, shape: 'arched', surround: 'stone' } },
      { side: 'front', storey: 0, at: -2.55, window: { ...shuttered(0.95, 1.15), light: lit } },
      { side: 'front', storey: 0, at: 2.55, window: shuttered(0.95, 1.15) },
      { side: 'left', storey: 0, at: -0.8, window: plain(0.8, 1.05) },
      { side: 'left', storey: 'gable', at: 0, window: { shape: 'arched', w: 0.75, h: 1.1, bars: 'cross', box: true, v: 0.35 } },
      { side: 'right', storey: 0, at: 0.9, window: { ...lattice(0.8, 1.0), glow: 0.9 } },
      { side: 'right', storey: 'gable', at: 0, window: { shape: 'round', w: 0.8, h: 0.8, bars: 'cross', sill: false, v: 0.6 } },
      { side: 'back', storey: 0, at: -2.4, window: plain(0.85, 1.05) },
      { side: 'back', storey: 0, at: 1.4, door: { w: 0.95, h: 2.0, shape: 'square', surround: 'timber' } },
    ],
    roof: {
      axis: 'x',
      pitch: 0.95,
      eave: 0.65,
      gable: [0.6, 0.6],
      sag: 0.38,
      curl: 0.5,
      dormers: [
        { facing: 'front', at: -2.1, width: 2.25, height: 1.65, window: { shape: 'square', w: 0.95, h: 1.05, bars: 'cross', shutters: true, box: true, light: { radius: 5, intensity: 0.5 } } },
        { facing: 'front', at: 2.1, width: 2.25, height: 1.65, window: { shape: 'arched', w: 0.9, h: 1.15, bars: 'cross', box: true } },
        { facing: 'back', at: -0.3, width: 2.6, height: 1.5, window: { shape: 'square', w: 1.2, h: 0.95, bars: 'lattice' } },
      ],
    },
    chimneys: [{ x: r.x + 0.4, z: r.z - 0.35, w: 1.0, d: 0.9, above: 1.05, pots: 2, smoke: false }],
  };
  const h = buildHouse(site.child('main'), main);
  doorLantern(site.child('front'), h, -1.1, 2.4);
  return { smoke: smokeOf(h, 0.95) };
}

// --- cottage-4: long, low, thatched, with a porch -----------------------------------------------------------------------

function cottageLong(site: Site, s: Structure, g: Ground): Built {
  const r = s.body;
  const floorY = 0.4;
  const storey = 2.75;
  const chimney = { x: r.x + 2.1, z: r.z - 0.15, w: 1.05, d: 0.95 };
  const main: HouseSpec = {
    rect: r,
    floorY,
    storeys: [storey],
    plinth: { below: foundationDepth(g, r), rises: [{ side: 'left', u0: 0, u1: r.d, top: 0.85 }] },
    frame: { spacing: 1.9, braces: 'cross' },
    openings: [
      { side: 'front', storey: 0, at: 0, door: { w: 1.05, h: 2.1, shape: 'square', surround: 'timber' } },
      { side: 'front', storey: 0, at: -2.0, window: { ...shuttered(0.85, 1.0), box: false, light: lit } },
      { side: 'front', storey: 0, at: -3.6, window: lattice(0.7, 0.9) },
      { side: 'front', storey: 0, at: 2.1, window: { ...shuttered(0.85, 1.0), box: false } },
      { side: 'front', storey: 0, at: 3.65, window: { ...plain(0.7, 0.9), glow: 0.8 } },
      { side: 'back', storey: 0, at: -1.5, window: plain(0.8, 0.95) },
      { side: 'back', storey: 0, at: 2.6, window: lattice(0.7, 0.85) },
      { side: 'right', storey: 0, at: 0.6, window: { ...shuttered(0.8, 1.0), box: true } },
    ],
    roof: false,
  };
  const h = buildHouse(site.child('main'), main);
  // Thatch: a steep roof with bell-cast eaves deep enough to shelter the porch, a nearly straight ridge.
  const eaveY = h.eaveY;
  const shape = roofShape({ x: r.x, z: r.z, y: eaveY, axis: 'x', length: r.w, span: r.d, rise: 0.66 * r.d, eave: 1.45, gable: [0.45, 0.45], sag: 0.14, flare: 0.62, curl: 0.06, dip: 0.04 });
  const hole = roofHoleFor(shape, chimney.x, chimney.z, chimney.w + 0.25, chimney.d + 0.25, 0.05);
  const thatch = site.with({ pal: THATCH_PALETTE }).child('thatch');
  thatchRoof(thatch, shape, { holes: [hole] });
  for (const side of ['left', 'right'] as const) {
    gableInfill(site.child(`gable-${side}`), shape, r, eaveY, side, side === 'left' ? [{ shape: 'square', w: 0.7, h: 0.85, bars: 'cross', shutters: true, at: 0, v: 0.5 }] : [{ shape: 'round', w: 0.65, h: 0.65, bars: 'cross', sill: false, at: 0, v: 0.75 }]);
  }
  // A tall chimney clear of the straw, with a drip course where it leaves the thatch.
  const top = stoneChimney(site.child('chimney'), { x: chimney.x, z: chimney.z, y0: shape.heightAt(chimney.x, chimney.z) - 1.6, y1: shape.ridgeY + 1.55, w: chimney.w, d: chimney.d, taper: 0.86, pots: 2, smoke: false });
  porch(site.child('porch'), s, shape, floorY);
  doorLantern(site.child('front'), h, 0.95, 2.15);
  return { smoke: [{ top: [top[0], top[1], top[2]], strength: 1.0 }] };
}

/** The porch along the front under the deep thatch eave: plank deck, posts on stones, a head beam, braces, a bench. */
function porch(site: Site, s: Structure, shape: ReturnType<typeof roofShape>, floorY: number): void {
  const r = s.body;
  const zW = r.z + r.d / 2;
  const zP = zW + 1.2; // the post line
  const x0 = r.x - r.w / 2 + 0.55, x1 = r.x + r.w / 2 - 0.55;
  const deckY = Math.min(floorY - 0.06, 0.32);
  // Head beam just under the thatch's underside over the post line.
  let headY = Infinity;
  for (let k = 0; k <= 8; k++) headY = Math.min(headY, shape.underside(lerp(x0, x1, k / 8), zP + 0.2));
  headY -= 0.05;
  const posts = 4;
  for (let k = 0; k < posts; k++) {
    const x = lerp(x0 + 0.1, x1 - 0.1, k / (posts - 1));
    postOnPad(site, x, zP, headY - 0.24, { width: 0.26, pad: deckY + 0.02, ground: -0.25 });
    // Curved-looking braces from post to head beam (two straight pieces each).
    for (const sx of [-1, 1]) {
      if ((k === 0 && sx < 0) || (k === posts - 1 && sx > 0)) continue;
      timber(site, [x + sx * 0.08, headY - 0.95, zP], [x + sx * 0.62, headY - 0.26, zP], { width: 0.16, depth: 0.15, sag: 0 });
    }
    // A tie beam from the post head back to the wall plate.
    timber(site, [x, headY - 0.12, zP + 0.1], [x, headY + 0.05, zW - 0.05], { width: 0.2, depth: 0.2, sag: 0 });
  }
  timber(site, [x0 - 0.35, headY - 0.12, zP], [x1 + 0.35, headY - 0.12, zP], { width: 0.26, depth: 0.24, sag: 0.03, overhang: 0.05 });
  // Plank deck on joists, from the wall to beyond the posts.
  const deck0 = zW + 0.02, deck1 = zP + 0.35;
  site.b.withFlags({ cls: MAT.wood }, () => {
    for (const z of [deck0 + 0.15, (deck0 + deck1) / 2, deck1 - 0.15]) bevelBox(site.b, [(x0 + x1) / 2, deckY - 0.32, z], [x1 - x0 + 0.5, 0.22, 0.16], site.pal.timberDark, { bevel: 0.03 });
    let x = x0 - 0.25;
    while (x < x1 + 0.25) {
      const w = Math.min(site.s.nextRange(0.24, 0.32), x1 + 0.25 - x);
      if (w > 0.08) bevelBox(site.b, [x + w / 2, deckY - 0.1, (deck0 + deck1) / 2 + site.s.nextJitter(0.03)], [w - 0.02, 0.07, deck1 - deck0 + site.s.nextJitter(0.06)], site.tone(mixRgb(site.pal.plank, site.pal.timber, site.s.next() * 0.5)), { bevel: 0.015 });
      x += w;
    }
  });
  // A bench against the wall west of the door.
  const bx0 = r.x - 3.3, bx1 = r.x - 1.0;
  site.b.withFlags({ cls: MAT.wood }, () => {
    bevelBox(site.b, [(bx0 + bx1) / 2, deckY + 0.42, zW + 0.33], [bx1 - bx0, 0.07, 0.38], site.tone(site.pal.plank), { bevel: 0.02 });
    for (const x of [bx0 + 0.2, bx1 - 0.2]) bevelBox(site.b, [x, deckY - 0.04, zW + 0.33], [0.08, 0.46, 0.34], site.pal.timberDark, { bevel: 0.015 });
  });
}

// --- cottage-5: crooked -------------------------------------------------------------------------------------------------

function cottageCrooked(site: Site, s: Structure, g: Ground): Built {
  const r = s.body;
  const wing = s.wings[0]!;
  const floorY = 0.6;
  const below = foundationDepth(g, { x: (r.x + wing.x) / 2 - 0.5, z: r.z, w: r.w + wing.w, d: r.d });
  const leftCovered = r.z + r.d / 2 - (wing.z - wing.d / 2);
  let smoke: Built['smoke'] = [];
  // The whole house leans a little to the south-east; the roof is twisted against the walls on top of that.
  site.at(compose34([0, 0, 0], 0, 0.012, -0.018), (lean) => {
    const main: HouseSpec = {
      rect: r,
      floorY,
      storeys: [2.6, 2.3],
      jetty: { front: 0.38, back: 0.22, right: 0.28 },
      storeyWalls: { 0: { left: { to: r.d - leftCovered - 0.05 } } },
      plinth: { below, rises: [{ side: 'right', u0: r.d - 1.0, u1: r.d, top: 1.35 }], buttresses: [{ x: r.x + r.w / 2, z: r.z + 0.4, yaw: Math.PI / 2, height: 2.0, width: 0.75, depth: 1.0 }] },
      frame: { braces: 'diagonal', spacing: 1.8 },
      openings: [
        { side: 'front', storey: 0, at: 0, door: { w: 1.0, h: 2.0, shape: 'arched', surround: 'timber' } },
        { side: 'front', storey: 0, at: 2.1, window: { ...shuttered(0.8, 1.05), light: lit } },
        { side: 'front', storey: 1, at: -1.9, window: { ...shuttered(0.75, 0.95), light: { radius: 5, intensity: 0.5 } } },
        { side: 'front', storey: 1, at: 0.6, window: { shape: 'round', w: 0.7, h: 0.7, bars: 'cross', v: 1.0 } },
        { side: 'front', storey: 1, at: 2.35, window: plain(0.7, 0.9) },
        { side: 'right', storey: 0, at: -0.5, window: lattice(0.7, 0.9) },
        { side: 'right', storey: 1, at: 0.9, window: { ...shuttered(0.75, 0.95), box: false } },
        { side: 'back', storey: 0, at: 0.8, window: plain(0.75, 0.95) },
        { side: 'back', storey: 1, at: -1.4, window: { ...lattice(0.7, 0.85), glow: 0.7 } },
        { side: 'left', storey: 1, at: -0.9, window: plain(0.7, 0.9) },
      ],
      roof: false,
    };
    const h = buildHouse(lean.child('main'), main);
    const wingSpec: HouseSpec = {
      rect: wing,
      floorY: floorY - 0.15,
      storeys: [2.35],
      walls: { right: false, front: { to: r.x - r.w / 2 - (wing.x - wing.w / 2) + 0.05 }, back: { from: wing.x + wing.w / 2 - (r.x - r.w / 2) - 0.05 } },
      plinth: { below },
      openings: [
        { side: 'front', storey: 0, at: -0.25, window: { ...shuttered(0.7, 0.95), box: true } },
        { side: 'left', storey: 0, at: 0.4, window: lattice(0.65, 0.85) },
        { side: 'front', storey: 'gable', at: 0, window: { shape: 'round', w: 0.5, h: 0.5, bars: 'cross', sill: false, v: 0.4 } },
      ],
      roof: { axis: 'z', pitch: 0.95, eave: 0.45, gable: [0.5, 0.5], sag: 0.2, curl: 0.45 },
    };
    buildHouse(lean.child('wing'), wingSpec);
    doorLantern(lean.child('front'), h, -0.9, 2.0);
    // The twisted roof: its own frame turned and tipped a little against the top storey.
    const top = h.rects[1]!;
    lean.at(compose34([0.04, 0, -0.03], 0.028, 0.012, 0.026), (tw) => {
      const shape = roofShape({ x: top.x, z: top.z, y: h.eaveY, axis: 'x', length: top.w, span: top.d, rise: 0.9 * top.d, eave: 0.55, gable: [0.5, 0.7], sag: 0.6, flare: 0.3, curl: 0.62, dip: 0.12 });
      const d: DormerSpec = { s: 1.3, side: 1, width: 1.6, height: 1.3, pitch: 1.2, window: { shape: 'square', w: 0.65, h: 0.75, bars: 'cross', box: true } };
      const chim = { x: top.x - 1.4, z: top.z - 0.8, w: 0.85, d: 0.8 };
      buildRoof(tw.child('roof'), shape, { holes: [dormerHole(shape, d), roofHoleFor(shape, chim.x, chim.z, chim.w + 0.25, chim.d + 0.25, 0.05)] });
      dormer(tw.child('dormer'), shape, d);
      gableInfill(tw.child('gable-left'), shape, top, h.eaveY, 'left', [{ shape: 'square', w: 0.6, h: 0.75, bars: 'cross', shutters: true, at: 0.2, v: 0.55 }], -0.2);
      gableInfill(tw.child('gable-right'), shape, top, h.eaveY, 'right', [{ shape: 'round', w: 0.6, h: 0.6, bars: 'cross', sill: false, at: -0.1, v: 0.9 }], -0.2);
      // The chimney leans its own way.
      tw.at(compose34([chim.x, 0, chim.z], 0.25, -0.045, 0.06), (c) => {
        const t = stoneChimney(c.child('chimney'), { x: 0, z: 0, y0: shape.heightAt(chim.x, chim.z) - 1.4, y1: shape.ridgeY + 1.0, w: chim.w, d: chim.d, taper: 0.8, pots: 1, smoke: false });
        smoke = [{ top: c.world(t[0], t[1], t[2]), strength: 0.8, world: true }];
      });
    });
  });
  return { smoke };
}

// --- Module ------------------------------------------------------------------------------------------------------------

const PLANS: Record<string, (site: Site, s: Structure, g: Ground) => Built> = {
  L: cottageL,
  chimney: cottageChimney,
  annex: cottageAnnex,
  dormer: cottageDormer,
  long: cottageLong,
  crooked: cottageCrooked,
};

/** Each cottage its own shade of plaster and timber, so the six do not read as copies. */
function paletteOf(s: Structure): ArchPalette {
  const base = s.plan === 'long' ? COTTAGE_RUST : paletteFor(s);
  const tints: Partial<ArchPalette>[] = [
    { plaster: hex('#ecdcb2'), plasterWarm: hex('#e2c48c') },
    { plaster: hex('#e8d2a8'), plasterWarm: hex('#dcb47e'), timber: hex('#5a3820'), shutter: hex('#3d5a8c') },
    { plaster: hex('#f0e2c0'), plasterWarm: hex('#e6cc96'), shutter: hex('#7a3a2a') },
    { plaster: hex('#ecd6b8'), plasterWarm: hex('#e2bc98'), timber: hex('#6e4428'), shutter: hex('#4a6a3a') },
    { plaster: hex('#eee0bc'), plasterWarm: hex('#dcc08c'), timber: hex('#5c3c24'), shutter: hex('#3a5a7a') },
    { plaster: hex('#e4d4ae'), plasterWarm: hex('#d8b882'), timber: hex('#4e3220'), shutter: hex('#6a4a8a') },
  ];
  return { ...base, ...(tints[s.index % tints.length] ?? {}) };
}

export const cottages: ContentModule = {
  name: 'cottages',
  build(ctx) {
    const statics: StaticPiece[] = [];
    const lights: PointLight[] = [];
    const particles: ParticleSource[] = [];
    const solids: SolidDef[] = [];
    let triangles = 0;
    const t0 = performance.now();
    for (const s of ctx.layout.structures) {
      if (s.kind !== 'cottage') continue;
      const padY = ctx.field.padY(s.id);
      const g = localGround(ctx, s, padY);
      const b = new MeshBuilder();
      const out = emitters();
      const m = compose34([s.x, padY, s.z], s.yaw);
      const plan = PLANS[s.plan ?? 'L'] ?? cottageL;
      openSite(b, m, ctx.stream(`cottage:${s.id}`), paletteOf(s), out, (site) => {
        const built = plan(site, s, g);
        for (const q of built.smoke) {
          const top = q.world ? q.top : site.world(q.top[0], q.top[1], q.top[2]);
          out.particles.push(...chimneySmoke(top, { strength: q.strength }));
        }
      });
      finish(ctx, s, b);
      triangles += b.triangleCount;
      statics.push({ material: 'solid', mesh: b, name: s.id });
      solids.push(...structureSolids(ctx, s, b));
      lights.push(...out.lights);
      particles.push(...out.particles);
    }
    return { statics, lights, particles, solids, stats: { cottageTriangles: triangles, cottageLights: lights.length, cottageMs: Math.round(performance.now() - t0) } };
  },
};
