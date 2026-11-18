// The water mill (B2) on the bank below the weir:
//
//   ground floor  coursed stone, its river side standing on a deep foundation down the bank to the water; an arched
//                 door with a pentice roof on curved brackets, shuttered windows, two millstones by the north wall
//   upper floor   half-timbered with a knee wall, a blue slate roof with its gables to the street and the river, a
//                 loading hatch in the street gable under a sack hoist (beam, pulley, rope and a sack), a dormer,
//                 a chimney with smoke
//   wheel         a breastshot wheel of shrouds, sole boards, buckets, spokes and an iron-banded hub on a shaft that
//                 runs from a stone pier in the river into the mill's wall; a dynamic part set turned in `update`
//   head race     a plank flume on trestles taking water above the weir and pouring it onto the wheel's upstream side:
//                 a water piece with flow flags, spray and mist particles where it falls and where the wheel churns
//
// The wheel turns about an axle at right angles to the mill's river wall (east–west), so its shaft enters the mill;
// layout.millWheel gives its centre, axle height, radius and width (its `yaw` is not used, see the report).
// Owner: buildings. POIs it serves: 'mill-door' (in front of the door, the street side).

import { COTTAGE_RUST, INN_PALETTE, buildHouse, doorAt, emitters, openSite, rectWalls, stoneBlock, timber, curvedTimber, wallLantern, wallPoint, windowAt, windowOpening, doorOpening } from '../arch/index.ts';
import type { ArchPalette, HouseSpec, Site } from '../arch/index.ts';
import type { BuildContext, ContentModule, FrameInfo, Mat34, PartSet, ParticleSource, PointLight, RGB, SolidDef, StaticPiece, Vec3 } from '../kit/index.ts';
import { MAT, MeshBuilder, PALETTE, bevelBox, clamp, compose34, createPartSet, hex, lathe, lerp, mixRgb, norm3, pushPart, scaleRgb, tube, waterFlags, writePart, yawOf } from '../kit/index.ts';
import { chimneySmoke } from '../fx/smoke.ts';
import { riverAt, toLocal } from '../layout.ts';
import type { Structure } from '../layout.ts';
import { finish, foundationDepth, leanToRoof, localGround, smoothQuad, spin34, stoneCourses, stoneWall, structureSolids } from './shared.ts';
import type { StoneOpening } from './shared.ts';

/** Top of the stone ground floor (local y): the timber floor above starts here. */
const STONE_TOP = 3.2;
/** Turning speed of the wheel (rad/s): the bottom moves downstream. */
const WHEEL_SPEED = 0.55;

/** Rust timbers and plaster with the inn's blue-violet slate (B2: the mill has a blue roof). */
const MILL_PALETTE: ArchPalette = {
  ...COTTAGE_RUST,
  roof: INN_PALETTE.roof,
  roofAccents: INN_PALETTE.roofAccents,
  roofDeck: INN_PALETTE.roofDeck,
  ridge: INN_PALETTE.ridge,
  plaster: hex('#eadcb6'),
  stone: hex('#8e8a86'),
  stoneWarm: hex('#a49684'),
  stoneDark: hex('#66626a'),
  shutter: hex('#3d5a8c'),
};

// --- The building ------------------------------------------------------------------------------------------------------

function millBody(site: Site, s: Structure, g: (x: number, z: number) => number): Vec3[] {
  const r = s.body;
  const below = foundationDepth(g, r, 0.4, 0.45);
  const walls = rectWalls(r, 0);
  const courses = stoneCourses(site, -below, STONE_TOP, [0.46, 0.6]);
  const sides = ['front', 'right', 'back', 'left'] as const;
  // Openings of the stone floor in wall frames (u from the wall's start, v from the pad).
  const L = r.w;
  const door = { u: L / 2, v: 0, w: 1.4, h: 2.45 };
  const win = (u: number, v = 1.05, w = 0.72, h = 0.9) => ({ shape: 'square' as const, u, v, w, h, bars: 'cross' as const, shutters: true, depth: 0.3 });
  const windows: Record<(typeof sides)[number], ReturnType<typeof win>[]> = {
    front: [{ ...win(L / 2 - 2.05), shutters: true }, win(L / 2 + 2.05)],
    right: [win(L / 2 + 0.6, 1.1, 0.7, 0.85)],
    back: [win(L / 2 + 1.2, 1.25, 0.65, 0.8)],
    left: [win(L / 2 - 0.4, 1.1, 0.7, 0.85)],
  };
  sides.forEach((side, e) => {
    const w = walls[side];
    const ground = (u: number): number => {
      const p = wallPoint(w, u, 0, 0.55);
      return g(p[0], p[2]);
    };
    const ops: StoneOpening[] = windows[side].map((q) => ({ ...windowOpening(q), sill: true }));
    if (side === 'front') ops.push({ ...doorOpening({ ...door, shape: 'arched' }), arch: { u: door.u, spring: door.h - door.w / 2, r: door.w / 2 } });
    site.onWall(w, (ws) => {
      stoneWall(ws, { to: w.length, bottom: -below, top: STONE_TOP, courses, openings: ops, depth: 0.7, proud: 0.12, edge: e, ground, block: [0.7, 1.0] });
      for (const q of windows[side]) windowAt(ws.child('win'), { ...q, glow: side === 'front' ? 1 : 0.8, ...(side === 'front' && q.u < L / 2 ? { light: { radius: 5, intensity: 0.55 } } : {}) });
      if (side === 'front') {
        doorAt(ws.child('door'), { ...door, shape: 'arched', surround: 'stone', steps: 0 });
        wallLantern(ws.child('lantern'), { u: door.u + 1.25, v: 2.05, reach: 0.36, radius: 6, intensity: 0.9 });
      }
    });
  });
  // A heavy course of quoins at the river corners down the bank (buttresses against the current).
  for (const [x, yaw] of [[r.x - r.w / 2 + 0.6, Math.PI], [r.x + r.w / 2 - 0.6, Math.PI]] as const) {
    const z = r.z - r.d / 2;
    const gy = g(x, z - 1.1);
    if (gy < -1.2) buttressDown(site.child('buttress'), x, z, yaw, gy - 0.4, Math.min(1.6, STONE_TOP - 0.8));
  }

  // --- Upper floor: half-timbered, knee wall, slate roof, gables to the street and the river ---
  const allGaps = sides.map((side) => ({ side, u0: -1, u1: 20 }));
  const upper: HouseSpec = {
    rect: r,
    floorY: STONE_TOP,
    storeys: [2.6, 0.95],
    plinth: { gaps: allGaps, below: 0 },
    openings: [
      { side: 'front', storey: 0, at: -1.6, window: { shape: 'square', w: 0.85, h: 1.1, bars: 'cross', shutters: true, box: true, light: { radius: 5, intensity: 0.5 } } },
      { side: 'front', storey: 0, at: 1.6, window: { shape: 'square', w: 0.85, h: 1.1, bars: 'cross', shutters: true, box: true } },
      { side: 'front', storey: 'gable', at: 0, window: { shape: 'square', w: 1.05, h: 1.35, bars: 'none', shutters: true, sill: true, glow: 0.35, v: 0.2 } },
      { side: 'back', storey: 0, at: -1.7, window: { shape: 'square', w: 0.8, h: 1.0, bars: 'cross', shutters: true } },
      { side: 'back', storey: 0, at: 1.5, window: { shape: 'round', w: 0.8, h: 0.8, bars: 'cross', box: true, v: 1.05 } },
      { side: 'back', storey: 'gable', at: 0, window: { shape: 'round', w: 0.8, h: 0.8, bars: 'cross', sill: false, v: 0.7 } },
      { side: 'right', storey: 0, at: -1.4, window: { shape: 'square', w: 0.8, h: 1.0, bars: 'lattice' } },
      { side: 'right', storey: 0, at: 1.5, window: { shape: 'square', w: 0.8, h: 1.0, bars: 'cross', shutters: true, box: true } },
      { side: 'left', storey: 0, at: 0.4, window: { shape: 'arched', w: 0.75, h: 1.15, bars: 'cross' } },
    ],
    roof: {
      axis: 'z',
      pitch: 0.72,
      eave: 0.6,
      // The street gable reaches further out over the sack hoist.
      gable: [0.6, 1.15],
      sag: 0.34,
      curl: 0.46,
      dormers: [{ facing: 'right', at: -0.6, width: 1.9, height: 1.45, window: { shape: 'square', w: 0.8, h: 0.9, bars: 'cross', box: true } }],
    },
    chimneys: [{ x: r.x - 1.65, z: r.z - 1.3, w: 0.9, d: 0.85, above: 0.9, pots: 1, smoke: false }],
  };
  const h = buildHouse(site.child('upper'), upper);
  // A floor beam course over the stone where the timber storey starts.
  for (const side of sides) {
    const w = rectWalls(r, STONE_TOP)[side];
    site.onWall(w, (ws) => timber(ws, [-0.25, -0.1, 0.1], [w.length + 0.25, -0.1, 0.1], { width: 0.22, depth: 0.24, sag: 0.01, color: ws.pal.timberDark }));
  }
  sackHoist(site.child('hoist'), s, h.roof!.ridgeY, h.eaveY);
  pentice(site.child('pentice'), s, door);
  millstones(site.child('millstones'), s);
  return h.chimneyTops;
}

/** Stone courses from the bank up the river corners (wall frame turned by `yaw`). */
function buttressDown(site: Site, x: number, z: number, yaw: number, bottom: number, top: number): void {
  site.at(compose34([x, 0, z], yaw), (w) => {
    let y = bottom;
    let k = 0;
    while (y < top - 0.1) {
      const h = Math.min(top - y, w.s.nextRange(0.45, 0.58));
      const f = clamp((y - bottom) / (top - bottom), 0, 1);
      const d = lerp(1.25, 0.55, f);
      stoneBlock(w, [k % 2 ? 0.06 : -0.06, y, d / 2 - 0.1], [lerp(1.15, 0.9, f), h - 0.03, d]);
      y += h;
      k++;
    }
    w.b.withFlags({ cls: MAT.stone }, () => bevelBox(w.b, [0, y - 0.02, 0.2], [0.9, 0.42, 0.62], w.pal.stoneDark, { bevel: 0.05, taper: [1, 0.25], lean: [0, -0.2] }));
  });
}

/** The sack hoist on the street gable: a beam out of the apex, braces, a pulley, a rope with a hook and a sack. */
function sackHoist(site: Site, s: Structure, ridgeY: number, eaveY: number): void {
  const r = s.body;
  const zW = r.z + r.d / 2;
  const y = lerp(eaveY, ridgeY, 0.62);
  const reach = 1.3;
  timber(site, [0, y, zW - 0.9], [0, y, zW + reach], { width: 0.24, depth: 0.26, sag: 0.02, color: site.pal.timberDark, overhang: 0.05 });
  curvedTimber(site, [0, y - 1.05, zW + 0.05], [0, y - 0.45, zW + 0.25], [0, y - 0.1, zW + 0.85], { width: 0.16, depth: 0.16 });
  // Pulley: a wheel in an iron stirrup under the beam's end.
  const pz = zW + reach - 0.12;
  site.b.withFlags({ cls: MAT.metal }, () => {
    tube(site.b, [[-0.09, y - 0.1, pz], [-0.09, y - 0.42, pz]], () => 0.018, site.pal.iron, { sides: 4 });
    tube(site.b, [[0.09, y - 0.1, pz], [0.09, y - 0.42, pz]], () => 0.018, site.pal.iron, { sides: 4 });
  });
  site.b.withFlags({ cls: MAT.wood }, () =>
    site.b.with(compose34([0, y - 0.38, pz], Math.PI / 2, 0, Math.PI / 2), () => lathe(site.b, [0, -0.05, 0], [[0.15, 0], [0.17, 0.03], [0.17, 0.07], [0.15, 0.1]], site.pal.timber, { segments: 10, capBottom: true, capTop: true })),
  );
  // Rope down to a hook and a hanging sack (the rope sways a little).
  const ropeTop = y - 0.4, ropeBot = STONE_TOP + 1.2;
  site.b.withFlags({ cls: MAT.fabric, sway: 0.15 }, () => {
    tube(site.b, [[0.16, ropeTop, pz], [0.16, ropeBot, pz]], () => 0.022, hex('#b09a70'), { sides: 4 });
    tube(site.b, [[-0.16, ropeTop, pz], [-0.16, ropeTop - 1.4, pz + 0.05], [-0.1, ropeTop - 2.2, zW + 0.15]], () => 0.022, hex('#b09a70'), { sides: 4 });
  });
  site.b.withFlags({ cls: MAT.metal, sway: 0.2 }, () => tube(site.b, [[0.16, ropeBot + 0.02, pz], [0.16, ropeBot - 0.12, pz], [0.22, ropeBot - 0.2, pz], [0.26, ropeBot - 0.1, pz]], () => 0.02, site.pal.iron, { sides: 4 }));
  site.b.withFlags({ cls: MAT.fabric, sway: 0.25 }, () =>
    lathe(site.b, [0.16, ropeBot - 0.95, pz], [[0.05, 0], [0.24, 0.06], [0.29, 0.3], [0.27, 0.55], [0.16, 0.72], [0.05, 0.8]], (p) => scaleRgb(PALETTE.fabricCream, 0.85 + 0.12 * Math.sin(p[1] * 9)), { segments: 9, capBottom: true, capTop: true, noise: 0.08, stream: site.s }),
  );
}

/** A pentice over the door: a small shingle roof on two curved brackets. */
function pentice(site: Site, s: Structure, door: { u: number; w: number; h: number }): void {
  const r = s.body;
  const zW = r.z + r.d / 2 + 0.12;
  const half = door.w / 2 + 0.75;
  const yHigh = door.h + 0.62, yLow = door.h + 0.2;
  leanToRoof(site, { x0: r.x - half, x1: r.x + half, zHigh: zW, yHigh, zLow: zW + 1.15, yLow, sag: 0.05, rafters: true, ledger: true });
  for (const sx of [-1, 1]) {
    const x = r.x + sx * (half - 0.25);
    curvedTimber(site, [x, door.h - 0.55, zW], [x, door.h - 0.05, zW + 0.3], [x, yLow - 0.25, zW + 0.95], { width: 0.16, depth: 0.16, color: site.pal.timberDark });
  }
}

/** Two millstones by the north wall: one leaning against it, one lying in front. */
function millstones(site: Site, s: Structure): void {
  const r = s.body;
  const x = r.x - r.w / 2 - 0.22;
  const stone: RGB = hex('#a29c94');
  const profile: [number, number][] = [[0.12, 0], [0.66, 0], [0.7, 0.04], [0.7, 0.22], [0.66, 0.27], [0.12, 0.27]];
  const paint = (p: Vec3): RGB => {
    const rr = Math.hypot(p[0], p[2]);
    // Dressing furrows on the face, the eye darker.
    const f = Math.abs(Math.sin(Math.atan2(p[2], p[0]) * 6 + rr * 3));
    return rr < 0.16 ? scaleRgb(stone, 0.55) : scaleRgb(stone, 0.88 + 0.14 * f);
  };
  site.b.withFlags({ cls: MAT.stone }, () => {
    // Leaning: the disc's axis turned to point out of the wall, tipped back against it.
    site.b.with(compose34([x - 0.12, 0.68, r.z + 1.6], 0, 0, -Math.PI / 2 + 0.22), () => lathe(site.b, [0, -0.13, 0], profile, paint, { segments: 18, capBottom: true, capTop: true, stream: site.s, noise: 0.015 }));
    lathe(site.b, [x - 1.0, 0.0, r.z - 0.6], profile, paint, { segments: 18, capBottom: false, capTop: true, phase: 0.4 });
  });
}

// --- Wheel -------------------------------------------------------------------------------------------------------------

/** The wheel in its own frame: axle along z, centre at the origin. Shaft from z = −shaftOut to z = shaftIn. */
function wheelMesh(R: number, W: number, shaftOut: number, shaftIn: number, s: Site['s']): MeshBuilder {
  const b = new MeshBuilder();
  const wet = mixRgb(hex('#5e3e26'), hex('#3a3a26'), 0.35);
  const wood = (k: number): RGB => scaleRgb(mixRgb(wet, hex('#7a5232'), s.float(k, 1) * 0.5), 0.85 + 0.25 * s.float(k, 2));
  const iron = PALETTE.iron;
  const radial = (angle: number, z: number, r0: number, r1: number, w: number, d: number, col: RGB, cls: number): void => {
    b.withFlags({ cls }, () => b.with(compose34([0, 0, z], 0, 0, angle), () => bevelBox(b, [0, (r0 + r1) / 2, 0], [w, r1 - r0, d], col, { anchor: 'center', bevel: Math.min(0.03, w * 0.25) })));
  };
  const rIn = R - 0.38;
  // Shrouds: two rings of curved segments (felloes), joints staggered between the sides.
  const n = 16;
  for (const side of [-1, 1]) {
    for (let k = 0; k < n; k++) {
      const a = ((k + (side > 0 ? 0.5 : 0)) / n) * Math.PI * 2;
      const len = 2 * Math.PI * ((R + rIn) / 2) / n + 0.02;
      b.withFlags({ cls: MAT.wood }, () => b.with(compose34([0, 0, side * (W / 2 - 0.04)], 0, 0, a), () => bevelBox(b, [0, (R + rIn) / 2, 0], [len, R - rIn, 0.09], wood(k + side * 50), { anchor: 'center', bevel: 0.025 })));
    }
    // Iron ring on the outer face of each shroud (as short straight straps).
    for (let k = 0; k < 24; k++) radial(((k + 0.5) / 24) * Math.PI * 2, side * (W / 2 + 0.01), R - 0.04, R + 0.005, 2 * Math.PI * R / 24 + 0.01, 0.03, iron, MAT.metal);
  }
  // Sole boards: the drum between the shrouds; buckets (paddles) standing out to the rim.
  const nb = 24;
  for (let k = 0; k < nb; k++) {
    const a = (k / nb) * Math.PI * 2;
    radial(a + Math.PI / nb, 0, rIn - 0.05, rIn + 0.02, 2 * Math.PI * rIn / nb - 0.015, W - 0.12, scaleRgb(wood(k + 100), 0.85), MAT.wood);
    // A bucket: a radial board and a short lip turned forward (the water sits in the angle).
    radial(a, 0, rIn, R + 0.03, 0.055, W - 0.14, wood(k + 200), MAT.wood);
    b.withFlags({ cls: MAT.wood }, () =>
      b.with(compose34([0, 0, 0], 0, 0, a), () => b.with(compose34([0, R - 0.05, 0], 0, 0, -0.75), () => bevelBox(b, [0.1, 0, 0], [0.22, 0.05, W - 0.14], scaleRgb(wood(k + 300), 0.9), { anchor: 'center', bevel: 0.015 }))),
    );
  }
  // Spokes: eight a side, from the hub to the shrouds, crossed by a tie ring at half radius.
  for (const side of [-1, 1]) {
    for (let k = 0; k < 8; k++) {
      const a = ((k + (side > 0 ? 0 : 0.5)) / 8) * Math.PI * 2;
      radial(a, side * (W / 2 - 0.1), 0.3, rIn + 0.04, 0.14, 0.13, wood(k + 400 + side * 10), MAT.wood);
    }
    for (let k = 0; k < 8; k++) {
      const a = ((k + 0.5 + (side > 0 ? 0 : 0.5)) / 8) * Math.PI * 2;
      radial(a, side * (W / 2 - 0.02), 1.0 - 0.06, 1.0 + 0.06, 2 * Math.PI * 1.0 / 8 + 0.04, 0.08, scaleRgb(wood(k + 500), 0.9), MAT.wood);
    }
  }
  // Hub and shaft along z: lathes turned from +y to +z.
  b.with(compose34([0, 0, 0], 0, Math.PI / 2, 0), () => {
    b.withFlags({ cls: MAT.wood }, () => {
      lathe(b, [0, -W / 2 - 0.12, 0], [[0.36, 0], [0.4, 0.08], [0.4, W + 0.16], [0.36, W + 0.24]], wood(600), { segments: 8, capBottom: true, capTop: true, faceted: true });
      lathe(b, [0, -shaftOut, 0], [[0.19, 0], [0.21, 0.05], [0.21, shaftOut + shaftIn - 0.05], [0.19, shaftOut + shaftIn]], scaleRgb(wood(601), 0.8), { segments: 8, capBottom: true, capTop: true, faceted: true });
    });
    b.withFlags({ cls: MAT.metal }, () => {
      for (const y of [-W / 2 - 0.08, -0.12, 0.12, W / 2 + 0.06]) lathe(b, [0, y, 0], [[0.415, 0], [0.415, 0.07]], iron, { segments: 8, capBottom: false, capTop: false, faceted: true });
      for (const y of [-shaftOut + 0.15, shaftIn - 0.35]) lathe(b, [0, y, 0], [[0.225, 0], [0.225, 0.1]], iron, { segments: 8, capBottom: false, capTop: false, faceted: true });
    });
  });
  return b;
}

// --- Head race ---------------------------------------------------------------------------------------------------------

interface Race {
  /** Path of the flume's bottom (site-local, x, y, z) from the intake to the lip over the wheel. */
  path: Vec3[];
}

/** The flume's course: from above the weir along the mill-side bank to the wheel's upstream side, falling gently. */
function raceCourse(ctx: BuildContext, s: Structure, padY: number, wl: readonly [number, number], R: number, axleY: number): Race {
  const { river, weir } = ctx.layout;
  const g = localGround(ctx, s, padY);
  const toward = (along: number, inset: number): Vec3 => {
    const p = riverAt(river, along), a = riverAt(river, along - 1), c = riverAt(river, along + 1);
    const dx = c.x - a.x, dz = c.z - a.z, l = Math.hypot(dx, dz) || 1;
    let nx = -dz / l, nz = dx / l;
    if (nx * (s.x - p.x) + nz * (s.z - p.z) < 0) (nx = -nx), (nz = -nz);
    const bottom = weir.top - 0.24 - padY;
    // As far toward the mill-side bank as the ground stays under the flume.
    let k = p.width / 2 - inset;
    let lx = 0, lz = 0;
    for (; k > 0; k -= 0.25) {
      [lx, lz] = toLocal(s, p.x + nx * k, p.z + nz * k);
      if (g(lx, lz) < bottom - 0.45) break;
    }
    return [lx, bottom, lz];
  };
  const intake = toward(weir.along - 3.2, 0.9);
  const mid = toward(weir.along + 0.6, 0.7);
  // The lip: on the upstream side of the wheel, a little above the axle.
  const lipY = Math.min(intake[1] - 0.1, axleY + 0.25);
  const lip: Vec3 = [wl[0] - (R + 0.32), lipY, wl[1]];
  // Run in and a short straight before the lip, aimed along the wheel's plane.
  const pre: Vec3 = [lip[0] - 1.4, lerp(mid[1], lipY, 0.75), lip[2]];
  return { path: [intake, mid, pre, lip].map((p, i, a) => [p[0], lerp(intake[1], lipY, i / (a.length - 1)), p[2]] as Vec3) };
}

/** The flume: plank trough on yokes and trestles (site-local) and its water (a separate water mesh, site-local too). */
function flume(site: Site, water: MeshBuilder, race: Race, g: (x: number, z: number) => number, yawWorld: number): { spout: Vec3; dir: Vec3 } {
  const path = race.path;
  const inner = 0.72, side = 0.42, thick = 0.07;
  const plank = site.pal.plank;
  // Length-wise positions of the yokes.
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!, c = path[i + 1]!;
    const dx = c[0] - a[0], dz = c[2] - a[2], dy = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    const yaw = yawOf(dx, dz);
    const pitch = -Math.atan2(dy, len);
    const ext = i === path.length - 2 ? 0.05 : 0.38;
    site.at(compose34([a[0], a[1], a[2]], yaw, pitch), (f) => {
      f.b.withFlags({ cls: MAT.wood }, () => {
        // Bottom boards and side boards (two per side), slightly uneven.
        for (const x of [-inner / 4, inner / 4]) bevelBox(f.b, [x, -thick, len / 2], [inner / 2 + 0.02, thick, len + ext], f.tone(plank), { bevel: 0.015 });
        for (const sx of [-1, 1]) {
          for (const [y0, h] of [[-thick, side / 2], [side / 2 - thick, side / 2 + 0.02]] as const) {
            bevelBox(f.b, [sx * (inner / 2 + thick / 2), y0, len / 2], [thick, h, len + ext], f.tone(scaleRgb(plank, 0.9)), { bevel: 0.015 });
          }
        }
      });
      // Yokes: a U of three timbers every 1.1 m.
      const n = Math.max(1, Math.round(len / 1.1));
      for (let k = 0; k <= n; k++) {
        const z = (len * k) / n;
        if (i > 0 && k === 0) continue;
        timber(f, [-inner / 2 - 0.2, -thick - 0.08, z], [inner / 2 + 0.2, -thick - 0.08, z], { width: 0.13, depth: 0.13, sag: 0 });
        for (const sx of [-1, 1]) timber(f, [sx * (inner / 2 + thick + 0.06), -thick - 0.15, z], [sx * (inner / 2 + thick + 0.06), side + 0.04, z], { width: 0.11, depth: 0.11, sag: 0 });
      }
    });
    // Trestles: two legs on stone pads where the ground is below the trough.
    const n = Math.max(1, Math.round(len / 2.2));
    for (let k = 0; k <= n; k++) {
      if (i > 0 && k === 0) continue;
      const t = k / n;
      const x = lerp(a[0], c[0], t), z = lerp(a[2], c[2], t), y = lerp(a[1], c[1], t) - thick - 0.15;
      const nx = Math.cos(yaw), nz = -Math.sin(yaw);
      for (const sx of [-1, 1]) {
        const lx = x + nx * sx * 0.62, lz = z + nz * sx * 0.62;
        const gy = g(lx, lz);
        if (gy > y - 0.35) continue;
        stoneBlock(site, [lx, gy - 0.35, lz], [0.42, 0.55, 0.42], { bevel: 0.05 });
        timber(site, [lx, gy + 0.18, lz], [x + nx * sx * 0.42, y, z + nz * sx * 0.42], { width: 0.15, depth: 0.15, sag: 0 });
      }
      const gm = g(x, z);
      if (gm < y - 1.2) timber(site, [x + nx * 0.5, y - 0.15, z + nz * 0.5], [x - nx * 0.5, Math.max(gm + 0.4, y - 1.3), z - nz * 0.5], { width: 0.1, depth: 0.1, sag: 0 });
    }
  }
  // Water in the trough: a strip along the path, flowing toward the lip.
  const level = side * 0.55;
  const deep: RGB = mixRgb(PALETTE.water, PALETTE.waterShallow, 0.35);
  const cs = Math.cos(yawWorld), sn = Math.sin(yawWorld);
  const worldDir = (dx: number, dz: number): [number, number] => [cs * dx + sn * dz, -sn * dx + cs * dz];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!, c = path[i + 1]!;
    const dx = c[0] - a[0], dz = c[2] - a[2], l = Math.hypot(dx, dz) || 1;
    const nx = dz / l, nz = -dx / l;
    const [wx, wz] = worldDir(dx / l, dz / l);
    const steps = Math.max(2, Math.ceil(l / 0.8));
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps, t1 = (k + 1) / steps;
      const p = (t: number, sx: number): Vec3 => [lerp(a[0], c[0], t) + nx * sx * (inner / 2 - 0.01), lerp(a[1], c[1], t) + level, lerp(a[2], c[2], t) + nz * sx * (inner / 2 - 0.01)];
      const foam = i === path.length - 2 ? 0.25 + 0.4 * t1 : 0.12;
      water.set(waterFlags(foam, 0.8, wx, wz));
      const q = [p(t0, -1), p(t1, -1), p(t1, 1), p(t0, 1)];
      smoothQuad(water, q, [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]], [deep, deep, deep, deep]);
    }
  }
  // The pour: a sheet curving down from the lip onto the buckets (both faces), foaming as it falls.
  const a = path[path.length - 2]!, lip = path[path.length - 1]!;
  const dx = lip[0] - a[0], dz = lip[2] - a[2], l = Math.hypot(dx, dz) || 1;
  const ux = dx / l, uz = dz / l, nx = uz, nz = -ux;
  const [wx, wz] = worldDir(ux, uz);
  const rows = 6;
  const sheet = (t: number, sx: number): Vec3 => {
    const fwd = 0.45 * t + 0.1;
    return [lip[0] + ux * fwd + nx * sx * (inner / 2 - 0.06), lip[1] + level - 1.15 * t * t, lip[2] + uz * fwd + nz * sx * (inner / 2 - 0.06)];
  };
  for (let k = 0; k < rows; k++) {
    const t0 = k / rows, t1 = (k + 1) / rows;
    water.set(waterFlags(clamp(0.45 + t1 * 0.5, 0, 1), 1, wx, wz));
    const q = [sheet(t0, -1), sheet(t0, 1), sheet(t1, 1), sheet(t1, -1)];
    const n = norm3([ux, 0.6, uz]);
    const col = mixRgb(PALETTE.waterShallow, PALETTE.foam, 0.25 + 0.4 * t1);
    smoothQuad(water, q, [n, n, n, n], [col, col, col, col]);
    const m: Vec3 = [-n[0], -n[1], -n[2]];
    smoothQuad(water, q, [m, m, m, m], [col, col, col, col]);
  }
  return { spout: sheet(1, 0), dir: [ux, 0, uz] };
}

// --- Module ------------------------------------------------------------------------------------------------------------

export const mill: ContentModule = {
  name: 'mill',
  build(ctx) {
    const statics: StaticPiece[] = [];
    const lights: PointLight[] = [];
    const particles: ParticleSource[] = [];
    const parts: PartSet[] = [];
    const t0 = performance.now();
    const solids: SolidDef[] = [];
    const wheels: { set: PartSet; x: number; y: number; z: number; yaw: number; m: Mat34 }[] = [];
    for (const s of ctx.layout.structures) {
      if (s.kind !== 'mill') continue;
      const padY = ctx.field.padY(s.id);
      const g = localGround(ctx, s, padY);
      const wheel = ctx.layout.millWheel;
      const wl = toLocal(s, wheel.x, wheel.z);
      const axleY = wheel.y - padY;
      const R = wheel.radius, W = wheel.width;
      const backZ = s.body.z - s.body.d / 2;
      // Shaft: from the outer pier to into the river wall.
      const pierZ = wl[1] - W / 2 - 0.62;
      const shaftOut = wl[1] - pierZ + 0.3, shaftIn = backZ + 0.25 - wl[1];
      const b = new MeshBuilder();
      const water = new MeshBuilder().set({ cls: MAT.generic });
      const out = emitters();
      const m = compose34([s.x, padY, s.z], s.yaw);
      let tops: Vec3[] = [];
      let pour: { spout: Vec3; dir: Vec3 } | undefined;
      const stream = ctx.stream(`mill:${s.id}`);
      openSite(b, m, stream, MILL_PALETTE, out, (site) => {
        tops = millBody(site.child('body'), s, g);
        // The outer bearing: a stone pier from the river bed, an oak pillow block on top.
        const pg = g(wl[0], pierZ);
        let y = Math.min(pg, axleY - 1) - 0.4;
        const pier = site.child('pier');
        let k = 0;
        while (y < axleY - 0.32) {
          const h = Math.min(axleY - 0.3 - y, pier.s.nextRange(0.42, 0.55));
          const wdt = lerp(1.05, 0.8, clamp((y - pg) / (axleY - pg), 0, 1));
          stoneBlock(pier, [wl[0] + (k % 2 ? 0.04 : -0.04), y, pierZ], [wdt, h - 0.03, 0.85]);
          y += h;
          k++;
        }
        pier.b.withFlags({ cls: MAT.wood }, () => bevelBox(pier.b, [wl[0], axleY - 0.32, pierZ], [0.7, 0.13, 0.6], pier.pal.timberDark, { bevel: 0.03 }));
        // A bearing plate on the mill wall where the shaft enters.
        site.b.withFlags({ cls: MAT.wood }, () => bevelBox(site.b, [wl[0], axleY - 0.55, backZ - 0.18], [0.9, 1.1, 0.14], site.pal.timberDark, { bevel: 0.03 }));
        site.b.withFlags({ cls: MAT.metal }, () => bevelBox(site.b, [wl[0], axleY - 0.3, backZ - 0.26], [0.56, 0.6, 0.05], site.pal.iron, { bevel: 0.01 }));
        // Head race and its water.
        const race = raceCourse(ctx, s, padY, wl, R, axleY);
        water.with(m, () => {
          pour = flume(site.child('flume'), water, race, g, s.yaw);
        });
      });
      for (const t of tops) particles.push(...chimneySmoke(applyLocal(m, t), { strength: 0.65 }));
      if (pour) {
        const sp = applyLocal(m, pour.spout);
        particles.push({ kind: 'dust', position: sp, count: 18, life: 0.8, size: [0.09, 0.04], rise: 0.6, spread: [0.3, 0.9], gravity: 5, wind: 0.1, colorStart: [0.95, 0.98, 1, 0.8], colorEnd: [0.9, 0.95, 1, 0] });
        particles.push({ kind: 'steam', position: sp, count: 10, life: 1.8, size: [0.4, 1.3], rise: 0.25, spread: [0.35, 0.2], wind: 0.5, colorStart: [0.92, 0.95, 0.97, 0.25], colorEnd: [0.92, 0.95, 0.97, 0] });
      }
      // Churn and mist where the buckets leave the water, downstream of the wheel's bottom.
      const churn = applyLocal(m, [wl[0] + 0.9, ctx.field.river(wheel.x, wheel.z).at.y - padY + 0.05, wl[1]]);
      particles.push({ kind: 'dust', position: churn, count: 16, life: 0.7, size: [0.1, 0.05], rise: 1.1, spread: [0.5, 0.8], gravity: 5, wind: 0.1, colorStart: [0.95, 0.98, 1, 0.75], colorEnd: [0.9, 0.95, 1, 0] });
      particles.push({ kind: 'steam', position: churn, count: 14, life: 2.4, size: [0.6, 1.8], rise: 0.3, spread: [0.8, 0.25], wind: 0.5, colorStart: [0.92, 0.95, 0.97, 0.22], colorEnd: [0.92, 0.95, 0.97, 0] });
      finish(ctx, s, b, 18);
      statics.push({ material: 'solid', mesh: b, name: s.id });
      solids.push(...structureSolids(ctx, s, b));
      statics.push({ material: 'water', mesh: water, name: `${s.id}-race`, castShadow: false });
      lights.push(...out.lights);
      particles.push(...out.particles);
      // The wheel: one dynamic instance turned about its axle every frame.
      const mesh = wheelMesh(R, W, shaftOut, shaftIn, stream.child('wheel'));
      const set = createPartSet('mill.wheel', mesh, 1, { dynamic: true, castShadow: true });
      const wm = spin34(new Float64Array(12), wheel.x, wheel.y, wheel.z, s.yaw, 0, 0);
      pushPart(set, wm);
      parts.push(set);
      wheels.push({ set, x: wheel.x, y: wheel.y, z: wheel.z, yaw: s.yaw, m: wm });
    }
    return {
      statics,
      parts,
      lights,
      particles,
      solids,
      update(frame: FrameInfo) {
        for (const w of wheels) {
          spin34(w.m, w.x, w.y, w.z, w.yaw, 0, frame.time * WHEEL_SPEED);
          writePart(w.set, 0, w.m);
          w.set.dirty = true;
        }
      },
      stats: { millTriangles: statics.reduce((n, p) => n + p.mesh.triangleCount, 0), millWheelTriangles: parts.reduce((n, p) => n + p.part.triangleCount, 0), millMs: Math.round(performance.now() - t0) },
    };
  },
};

/** A site-local point to world under the structure transform. */
function applyLocal(m: Mat34, p: readonly number[]): Vec3 {
  return [m[0]! * p[0]! + m[3]! * p[1]! + m[6]! * p[2]! + m[9]!, m[1]! * p[0]! + m[4]! * p[1]! + m[7]! * p[2]! + m[10]!, m[2]! * p[0]! + m[5]! * p[1]! + m[8]! * p[2]! + m[11]!];
}
