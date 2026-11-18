// The forge (B2): an open hall under a heavy red roof on stone pillars and heavy timber plates with curved braces,
// its back and west side closed by a stone base and sooty planks, the street front and the east side open, a stone
// chimney carrying the smithy's flue (props/smithy.ts) up through the roof, a plank lean-to with firewood at the back,
// a hanging sign with an anvil and a lantern on the street side.
//
// The equipment inside (hearth, hood and the flue up to local y 4.7, bellows, anvil, quench tub, tools, crates) comes
// from props/smithy.ts; the floor stays at the pad (local y 0) for it and the hall keeps clear of it. The fire's glow,
// light and smoke come from fx/index.ts: the smoke should leave from `forgeChimneyTop` (below) instead of the props'
// flue top, which now ends inside the chimney.
// Owner: buildings. POIs it serves: 'anvil' and 'forge-fire' (layout.ts), inside the open front.

import { FORGE_PALETTE, buildRoof, curvedTimber, emitters, hangingSign, openSite, signSwing, swingingSigns, rectWalls, roofHoleFor, roofShape, stoneBlock, stoneChimney, timber, wallFrame, wallLantern, wallPoint, windowAt } from '../arch/index.ts';
import type { RoofShape, SignSwing, Site } from '../arch/index.ts';
import type { BuildContext, ContentModule, FrameInfo, PartSet, ParticleSource, PointLight, SolidDef, StaticPiece, Vec3 } from '../kit/index.ts';
import { MAT, MeshBuilder, applyPoint34, bevelBox, compose34, lathe, mixRgb, scaleRgb } from '../kit/index.ts';
import type { Structure } from '../layout.ts';
import { finish, foundationDepth, gableInfill, leanToRoof, localGround, plankWall, stoneCourses, stoneWall, structureSolids } from './shared.ts';

/** Top of the stone pillars, and of the plates on them (the roof's wall plate). */
const PILLAR_TOP = 2.5;
const PLATE_TOP = 2.95;
/** Pillar section. */
const P = 0.82;
/** The smithy's flue (props/smithy.ts): centre and the height of its cap. */
const FLUE = { x: -1.75, z: -0.1, top: 4.78 };

/** The roof over the body: low and heavy, deep eaves. */
function forgeRoof(s: Structure): RoofShape {
  const r = s.body;
  return roofShape({ x: r.x, z: r.z, y: PLATE_TOP, axis: 'x', length: r.w, span: r.d, rise: 0.52 * r.d, eave: 0.95, gable: [0.85, 0.85], sag: 0.36, flare: 0.3, curl: 0.34, dip: 0.1 });
}

/** Local top of the chimney (the smoke's start). */
function chimneyTopY(shape: RoofShape): number {
  return shape.ridgeY + 1.25;
}

/** World point at the mouth of the forge chimney: where fx should emit the forge smoke. */
export function forgeChimneyTop(ctx: BuildContext, s: Structure): Vec3 {
  const m = compose34([s.x, ctx.field.padY(s.id), s.z], s.yaw);
  return applyPoint34(m, FLUE.x, chimneyTopY(forgeRoof(s)) + 0.15, FLUE.z, [0, 0, 0]);
}

/** A stone pillar of stacked blocks (alternately one block and two half blocks), a cap stone on top. */
function pillar(site: Site, x: number, z: number, bottom: number): void {
  let y = bottom;
  let k = 0;
  while (y < PILLAR_TOP - 0.2) {
    const h = Math.min(PILLAR_TOP - 0.16 - y, site.s.nextRange(0.42, 0.56));
    if (k % 2 === 0) stoneBlock(site, [x + site.s.nextJitter(0.02), y + 0.01, z + site.s.nextJitter(0.02)], [P, h - 0.025, P]);
    else {
      const along = k % 4 === 1;
      for (const sx of [-1, 1]) stoneBlock(site, [x + (along ? sx * P * 0.25 : 0), y + 0.01, z + (along ? 0 : sx * P * 0.25)], [along ? P / 2 - 0.02 : P, h - 0.025, along ? P : P / 2 - 0.02]);
    }
    y += h;
    k++;
  }
  stoneBlock(site, [x, PILLAR_TOP - 0.16, z], [P + 0.14, 0.16, P + 0.14], { bevel: 0.04 });
}

function buildForge(site: Site, s: Structure, g: (x: number, z: number) => number, swing: SignSwing): void {
  const r = s.body;
  const wing = s.wings[0]!;
  const x0 = r.x - r.w / 2, x1 = r.x + r.w / 2, z0 = r.z - r.d / 2, z1 = r.z + r.d / 2;
  const below = foundationDepth(g, { x: r.x, z: (r.z + wing.z) / 2, w: r.w, d: r.d + wing.d });
  const walls = rectWalls(r, 0);
  const courses = stoneCourses(site, -below, PILLAR_TOP, [0.42, 0.55]);

  // --- Foundations, kerbs and the stone bases of the closed walls ---
  const sides = ['front', 'right', 'back', 'left'] as const;
  sides.forEach((side, e) => {
    const w = walls[side];
    const L = w.length;
    const ground = (u: number): number => {
      const p = wallPoint(w, u, 0, 0.45);
      return g(p[0], p[2]);
    };
    const closed = side === 'back' || side === 'left';
    const top = closed ? 1.0 : 0.2;
    // The street entry: no kerb across the middle of the front.
    const ops = side === 'front' ? [{ u0: L / 2 - 1.7, u1: L / 2 + 1.7, v0: -0.05, v1: 5, lintel: false }] : [];
    site.onWall(w, (ws) => stoneWall(ws, { from: P, to: L - P, bottom: -below, top, courses, openings: ops, depth: 0.55, proud: 0.08, edge: e, cornerStart: false, cornerEnd: false, ground }));
  });
  // Pillars at the four corners.
  for (const [x, z] of [[x0, z1], [x1, z1], [x1, z0], [x0, z0]] as const) {
    const cx = x + (x < 0 ? P / 2 : -P / 2), cz = z + (z < 0 ? P / 2 : -P / 2);
    pillar(site.child(`pillar${x}${z}`), cx, cz, Math.min(-0.3, g(cx + Math.sign(cx) * 0.6, cz + Math.sign(cz) * 0.6) - 0.35));
  }

  // --- Plank walls above the stone bases: back and west ---
  const plankTop = (): number => PILLAR_TOP + 0.02;
  site.onWall(walls.back, (ws) => {
    const L = walls.back.length;
    const win = { u: L - (r.x - 0.2 - x0), v: 1.3, w: 0.8, h: 0.6 };
    plankWall(ws, { from: P, to: L - P, bottom: 1.0, top: plankTop, openings: [{ u0: win.u - win.w / 2, u1: win.u + win.w / 2, v0: win.v, v1: win.v + win.h }], color: scaleRgb(ws.pal.plank, 0.8) });
    windowAt(ws.child('win'), { shape: 'square', u: win.u, v: win.v, w: win.w, h: win.h, bars: 'none', shutters: true, glow: 0.5, depth: 0.1 });
    timber(ws, [P, 1.02, 0.03], [L - P, 1.02, 0.03], { width: 0.18, depth: 0.16, sag: 0 });
  });
  site.onWall(walls.left, (ws) => {
    const L = walls.left.length;
    const win = { u: 1.2 - z0, v: 1.25, w: 0.75, h: 0.65 };
    plankWall(ws, { from: P, to: L - P, bottom: 1.0, top: plankTop, openings: [{ u0: win.u - win.w / 2, u1: win.u + win.w / 2, v0: win.v, v1: win.v + win.h }], color: scaleRgb(ws.pal.plank, 0.8) });
    windowAt(ws.child('win'), { shape: 'square', u: win.u, v: win.v, w: win.w, h: win.h, bars: 'cross', glow: 0.8, depth: 0.1, light: { radius: 4, intensity: 0.4 } });
    timber(ws, [P, 1.02, 0.03], [L - P, 1.02, 0.03], { width: 0.18, depth: 0.16, sag: 0 });
    // The sign on an arm near the street corner: its board faces the street.
    hangingSign(ws.child('sign'), { u: L - 0.45, v: 2.2, reach: 1.45, w: 1.05, h: 0.74, emblem: 'anvil', swing });
  });

  // --- Heavy plates on the pillars, curved braces, tie beams, king posts ---
  const yb = (PILLAR_TOP + PLATE_TOP) / 2;
  const pc = P / 2;
  const heavy = { width: 0.44, depth: 0.42, sag: 0.03, color: site.pal.timberDark, overhang: 0.25 };
  timber(site, [x0 - 0.2, yb, z1 - pc], [x1 + 0.2, yb, z1 - pc], { ...heavy, sag: 0.06 });
  timber(site, [x0 - 0.2, yb, z0 + pc], [x1 + 0.2, yb, z0 + pc], heavy);
  timber(site, [x0 + pc, yb + 0.02, z0 - 0.15], [x0 + pc, yb + 0.02, z1 + 0.15], { ...heavy, width: 0.4 });
  timber(site, [x1 - pc, yb + 0.02, z0 - 0.15], [x1 - pc, yb + 0.02, z1 + 0.15], { ...heavy, width: 0.4 });
  // Curved braces from the pillars to the plates on the open sides.
  const brace = (a: Vec3, c: Vec3, b: Vec3): void => curvedTimber(site, a, c, b, { width: 0.22, depth: 0.2, color: site.pal.timber });
  for (const sx of [-1, 1]) {
    const px = sx < 0 ? x0 + P : x1 - P;
    const zf = z1 - pc;
    brace([px - sx * 0.02, 1.55, zf], [px - sx * 0.45, 2.15, zf], [px - sx * 1.35, PILLAR_TOP - 0.02, zf]);
  }
  for (const sz of [-1, 1]) {
    const pz = sz < 0 ? z0 + P : z1 - P;
    const xf = x1 - pc;
    brace([xf, 1.6, pz - sz * 0.02], [xf, 2.15, pz - sz * 0.42], [xf, PILLAR_TOP - 0.02, pz - sz * 1.25]);
  }
  // Tie beams across the hall, clear of the hood and the flue, with king posts and struts up to the ridge.
  const shape = forgeRoof(s);
  for (const tx of [-0.25, 1.95]) {
    timber(site, [tx, PLATE_TOP - 0.18, z0 - 0.1], [tx, PLATE_TOP - 0.18, z1 + 0.1], { width: 0.34, depth: 0.32, sag: 0.05, color: site.pal.timberDark });
    const ridgeUnder = shape.underside(tx, 0) - 0.12;
    timber(site, [tx, PLATE_TOP - 0.02, 0], [tx, ridgeUnder, 0], { width: 0.26, depth: 0.26, sag: 0 });
    for (const sz of [-1, 1]) {
      const zf = sz * (r.d / 2 - 0.9);
      timber(site, [tx, PLATE_TOP - 0.02, sz * 0.15], [tx, shape.underside(tx, zf) - 0.12, zf], { width: 0.2, depth: 0.2, sag: 0 });
    }
  }
  // Ridge purlin under the ridge.
  timber(site, [x0 + 0.4, shape.underside(x0 + 0.4, 0) - 0.18, 0], [x1 - 0.4, shape.underside(x1 - 0.4, 0) - 0.18, 0], { width: 0.26, depth: 0.26, sag: 0.04 });

  // --- Roof, gables, chimney ---
  const chim = { w: 0.95, d: 0.82 };
  buildRoof(site.child('roof'), shape, { holes: [roofHoleFor(shape, FLUE.x, FLUE.z, chim.w + 0.1, chim.d + 0.1, 0.08)], shingles: { width: [0.55, 0.7], exposure: 0.46, thick: 0.11, missing: 0.03, skewed: 0.1 } });
  gableInfill(site.child('gable-left'), shape, r, PLATE_TOP, 'left', [{ shape: 'square', w: 0.6, h: 0.6, bars: 'none', shutters: true, at: 0, v: 0.55, glow: 0.4 }], -0.25);
  // The east gable over the open side: boards with a smoke vent under the apex.
  const east = rectWalls(r, PLATE_TOP).right;
  site.onWall(east, (ws) => {
    const L = east.length;
    const top = (u: number): number => {
      const p = wallPoint(east, Math.min(L, Math.max(0, u)), 0);
      return shape.underside(p[0], p[2]) - PLATE_TOP - 0.02;
    };
    const apex = top(L / 2);
    plankWall(ws, { from: 0, to: L, bottom: -0.2, top, openings: [{ u0: L / 2 - 0.45, u1: L / 2 + 0.45, v0: apex - 1.2, v1: apex - 0.45 }], color: scaleRgb(ws.pal.plank, 0.85) });
    for (const sx of [-1, 1]) timber(ws, [L / 2 + sx * 0.5, apex - 1.3, 0.04], [L / 2 + sx * 0.5, apex - 0.35, 0.04], { width: 0.12, depth: 0.12, sag: 0 });
  });
  stoneChimney(site.child('chimney'), { x: FLUE.x, z: FLUE.z, y0: FLUE.top - 0.04, y1: chimneyTopY(shape), w: chim.w, d: chim.d, taper: 0.86, pots: 0, smoke: false });

  // --- Lean-to at the back: stone base, planks, open to the east, firewood inside ---
  leanTo(site.child('lean-to'), s, g, below, shape);

  // --- Lantern on the street pillar by the entry ---
  const front = walls.front;
  site.onWall(front, (ws) => wallLantern(ws.child('lantern'), { u: front.length - P - 0.05, v: 1.95, reach: 0.35, radius: 6.5, intensity: 0.9 }));
}

/** The lean-to behind the west half: a stone base and planks under a single slope, open to the east, firewood stacked. */
function leanTo(site: Site, s: Structure, g: (x: number, z: number) => number, below: number, shape: RoofShape): void {
  const a = s.wings[0]!;
  const xa = a.x - a.w / 2, xb = a.x + a.w / 2;
  const zIn = s.body.z - s.body.d / 2, zOut = a.z - a.d / 2;
  const over = 0.35;
  // High edge under the main roof's back eave, a slope of about 0.38.
  // (Just inside the roof's eave line: the shape ends there.)
  const eaveTip = zIn - shape.qMax + shape.halfD + 0.04;
  const slope = 0.38;
  const yAtTip = Math.min(shape.underside(xa + 0.2, eaveTip), shape.underside(xb - 0.2, eaveTip)) - 0.14;
  const yHigh = yAtTip + slope * (zIn - eaveTip);
  const yLow = yHigh - slope * (zIn - (zOut - over));
  const roofY = (z: number): number => yHigh - slope * (zIn - z);
  const courses = stoneCourses(site, -below, 0.6, [0.38, 0.46]);
  // West wall (outward −x) from the back corner of the main body to the lean-to's back, then the back wall (−z).
  const west = wallFrame([xa, zOut], [xa, zIn]);
  const back = wallFrame([xb, zOut], [xa, zOut]);
  [west, back].forEach((w, e) => {
    const L = w.length;
    const ground = (u: number): number => {
      const p = wallPoint(w, u, 0, 0.45);
      return g(p[0], p[2]);
    };
    const top = (u: number): number => roofY(wallPoint(w, u, 0)[2]) - 0.2;
    site.onWall(w, (ws) => {
      stoneWall(ws, { to: L, bottom: -below, top: 0.6, courses, depth: 0.45, proud: 0.08, edge: e, cornerStart: e === 1, cornerEnd: e === 0, ground });
      plankWall(ws, { from: 0, to: L, bottom: 0.6, top, color: scaleRgb(ws.pal.plank, 0.82) });
    });
  });
  // Corner post on the open east side, a head beam under the eave.
  const zp = zOut + 0.15;
  stoneBlock(site, [xb - 0.15, -0.3, zp], [0.42, 0.55, 0.42], { bevel: 0.05 });
  timber(site, [xb - 0.15, 0.24, zp], [xb - 0.15, roofY(zp) - 0.32, zp], { width: 0.24, depth: 0.24, sag: 0 });
  timber(site, [xb - 0.15, roofY(zIn - 0.2) - 0.28, zIn - 0.1], [xb - 0.15, roofY(zp) - 0.26, zp - 0.12], { width: 0.2, depth: 0.2, sag: 0 });
  leanToRoof(site, { x0: xa - over, x1: xb + over, zHigh: zIn, yHigh, zLow: zOut - over, yLow, sag: 0.06 });
  // Firewood: split logs stacked on two rails along the west wall.
  const logs = site.child('logs');
  logs.b.withFlags({ cls: MAT.wood }, () => {
    for (const z of [zOut + 0.4, zOut + 1.4]) bevelBox(logs.b, [xa + 0.75, 0.0, z], [1.2, 0.1, 0.1], logs.pal.timberDark, { bevel: 0.02 });
    const rows = 5;
    for (let j = 0; j < rows; j++) {
      const n = 6 - (j % 2);
      for (let i = 0; i < n; i++) {
        const x = xa + 0.28 + i * 0.21 + (j % 2) * 0.1 + logs.s.nextJitter(0.02);
        const y = 0.1 + j * 0.19 + 0.1;
        const len = logs.s.nextRange(1.35, 1.55);
        const end = mixRgb([0.72, 0.56, 0.36], [0.55, 0.4, 0.26], logs.s.next());
        logs.b.with(compose34([x, y, zOut + 0.2 + len / 2 + logs.s.nextJitter(0.05)], 0, Math.PI / 2, logs.s.next() * 6), () =>
          lathe(logs.b, [0, -len / 2, 0], [[0.1, 0], [0.1, len]], (p) => (Math.abs(p[1]) > len / 2 - 0.02 ? end : scaleRgb(logs.pal.timber, 0.85 + 0.25 * logs.s.float(i, j))), { segments: 6, capBottom: true, capTop: true, faceted: true }),
        );
      }
    }
  });
}

export const forge: ContentModule = {
  name: 'forge',
  build(ctx) {
    const statics: StaticPiece[] = [];
    const lights: PointLight[] = [];
    const particles: ParticleSource[] = [];
    const parts: PartSet[] = [];
    let update: ((f: FrameInfo) => void) | undefined;
    const solids: SolidDef[] = [];
    const t0 = performance.now();
    for (const s of ctx.layout.structures) {
      if (s.kind !== 'forge') continue;
      const padY = ctx.field.padY(s.id);
      const g = localGround(ctx, s, padY);
      const b = new MeshBuilder();
      const out = emitters();
      const swing = signSwing();
      openSite(b, compose34([s.x, padY, s.z], s.yaw), ctx.stream(`forge:${s.id}`), FORGE_PALETTE, out, (site) => buildForge(site, s, g, swing));
      // The sign board swings rigidly about its arm (one forge in the village: one set).
      const signs = swingingSigns(`${s.id}.sign`, swing);
      if (signs) (parts.push(...signs.parts), (update = signs.update));
      finish(ctx, s, b);
      statics.push({ material: 'solid', mesh: b, name: s.id });
      // The open forge is closed to a walking figure as a whole: the smithy fills it.
      solids.push(...structureSolids(ctx, s, b));
      lights.push(...out.lights);
      particles.push(...out.particles);
    }
    return { statics, parts, update, lights, particles, solids, stats: { forgeTriangles: statics.reduce((n, p) => n + p.mesh.triangleCount, 0), forgeMs: Math.round(performance.now() - t0) } };
  },
};
