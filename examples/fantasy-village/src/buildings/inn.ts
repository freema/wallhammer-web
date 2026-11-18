// The inn (B2): the richest building of the village, composed from the architecture kit (src/arch).
//
//   main body   stone plinth of big blocks with piers and buttresses, two half-timbered storeys of cream plaster and
//               dark timbers, the upper one jettied toward the square on joists and curved brackets; an arched door
//               with ironwork and stone steps, round windows with a cross, shuttered windows with flower boxes
//   roof        blue-violet slate shingles on a curved roof with a sagging ridge, overdrawn gables, two dormers to the
//               square and one to the back
//   wing        one storey and a knee wall on the east side, its own roof with the gable to the square, a dormer
//   chimneys    a big chimney breast on the west gable with smoke, a stack through the back slope, one on the wing
//   front       hanging sign with a tankard, a blue banner with gold, two lanterns by the door, barrels by the wall
//
// Owner: architecture. POIs it serves: 'inn-door' (the door at local x −1.5), 'inn-barrels' (the barrels).

import { INN_PALETTE, barrel, banner, buildHouse, cachedGround, emitters, hangingSign, openSite, signSwing, swingingSigns, wallLantern } from '../arch/index.ts';
import type { SignSwing } from '../arch/index.ts';
import type { House, HouseSpec, Site } from '../arch/index.ts';
import type { ContentModule, FrameInfo, PartSet, ParticleSource, PointLight, SolidDef, StaticPiece } from '../kit/index.ts';
import { structureSolids } from './shared.ts';
import { MeshBuilder, bakeAo, compose34, groundAo } from '../kit/index.ts';
import { chimneySmoke } from '../fx/smoke.ts';
import type { Structure } from '../layout.ts';

/** Floor height of the inn above its pad (top of the plinth). */
const FLOOR = 0.78;

/** The main body (layout: body x −1.5, z 0, 11 × 8.5): two storeys, the upper one jettied to the front. */
export function mainSpec(s: Structure): HouseSpec {
  const r = s.body;
  // The wing covers the east wall of the ground floor from its front corner on (wall u from the front corner).
  const wing = s.wings[0];
  const wingFrontU = wing ? r.z + r.d / 2 - (wing.z + wing.d / 2) : r.d;
  const round = { shape: 'round' as const, w: 1.0, h: 1.0, bars: 'cross' as const, box: true };
  const square = { shape: 'square' as const, w: 0.95, h: 1.2, bars: 'cross' as const, shutters: true, box: true };
  return {
    rect: r,
    floorY: FLOOR,
    storeys: [3.0, 2.8],
    jetty: { front: 0.45 },
    // Inside the wing the ground floor's east wall is not seen: build it only to just behind the wing's front.
    storeyWalls: { 0: { right: { to: wingFrontU + 0.35 } } },
    plinth: {
      // Asymmetric piers: the front-left corner rises high, the back-left a little, the front-right a step.
      rises: [
        { side: 'front', u0: 0, u1: 0.62, top: 1.75 },
        { side: 'left', u0: 0, u1: 1.6, top: 1.25 },
        { side: 'front', u0: r.w - 0.68, u1: r.w, top: 1.2 },
        { side: 'back', u0: r.w - 2.4, u1: r.w, top: 1.05 },
      ],
      gaps: [{ side: 'right', u0: wingFrontU + 0.3, u1: r.d + 1 }],
      buttresses: [
        { x: r.x - r.w / 2, z: r.z - r.d / 2 + 0.75, yaw: -Math.PI / 2, height: 2.4 },
        { x: r.x - 1.0, z: r.z - r.d / 2, yaw: Math.PI, height: 2.0, width: 0.85 },
      ],
    },
    openings: [
      // Front, ground floor: the arched door in the middle, round windows with a cross, square windows at the ends.
      { side: 'front', storey: 0, at: 0, door: { w: 1.45, h: 2.55, shape: 'arched', surround: 'stone' } },
      { side: 'front', storey: 0, at: -2.55, window: { ...round, light: true, v: 1.05 } },
      { side: 'front', storey: 0, at: 2.55, window: { ...round, light: true, v: 1.05 } },
      { side: 'front', storey: 0, at: -4.15, window: { ...square, w: 0.75, shutters: false, v: 0.95 } },
      { side: 'front', storey: 0, at: 4.15, window: { shape: 'square', w: 0.8, h: 1.15, bars: 'lattice', box: true, v: 0.95 } },
      // Front, upper floor: three shuttered windows with flower boxes over the door and the round windows.
      { side: 'front', storey: 1, at: -3.45, window: { ...square } },
      { side: 'front', storey: 1, at: 0, window: { ...square, light: { radius: 6, intensity: 0.7 } } },
      { side: 'front', storey: 1, at: 3.45, window: { ...square } },
      // West gable side.
      { side: 'left', storey: 0, at: 2.4, window: { ...square, w: 0.85 } },
      { side: 'left', storey: 1, at: 2.4, window: { shape: 'arched', w: 0.8, h: 1.3, bars: 'cross', box: true } },
      { side: 'left', storey: 1, at: -3.35, window: { shape: 'square', w: 0.65, h: 0.8, bars: 'cross', v: 1.1 } },
      { side: 'left', storey: 'gable', at: 1.55, window: { shape: 'round', w: 0.8, h: 0.8, bars: 'cross', sill: false, v: 0.65 } },
      // East side: an upper window in front of the wing and a window in the gable.
      { side: 'right', storey: 1, at: -(r.d + 0.45) / 2 + 1.2, window: { shape: 'square', w: 0.7, h: 1.0, bars: 'cross' } },
      { side: 'right', storey: 'gable', at: 0.6, window: { shape: 'square', w: 0.75, h: 0.95, bars: 'cross', v: 0.75 } },
      // Back.
      { side: 'back', storey: 0, at: -2.6, window: { shape: 'square', w: 0.85, h: 1.1, bars: 'cross', shutters: true } },
      { side: 'back', storey: 0, at: 2.2, window: { shape: 'square', w: 0.75, h: 0.95, bars: 'lattice', glow: 0.7 } },
      { side: 'back', storey: 1, at: -2.6, window: { shape: 'square', w: 0.85, h: 1.1, bars: 'cross', box: true } },
      { side: 'back', storey: 1, at: 1.2, window: { shape: 'round', w: 0.8, h: 0.8, bars: 'cross' } },
    ],
    roof: {
      axis: 'x',
      pitch: 0.7,
      eave: 0.7,
      gable: [0.8, 0.6],
      sag: 0.34,
      curl: 0.45,
      dormers: [
        { facing: 'front', at: -3.1, width: 2.0, window: { shape: 'round', w: 0.85, h: 0.85, bars: 'cross', box: true } },
        { facing: 'front', at: 2.7, width: 2.0, window: { shape: 'square', w: 0.85, h: 1.0, bars: 'cross', shutters: false, box: true } },
        { facing: 'back', at: -0.6, width: 1.8 },
      ],
    },
    chimneys: [
      // The big chimney breast outside the west gable, from the ground past the ridge.
      { x: r.x - r.w / 2 - 0.62, z: r.z - 1.2, w: 1.15, d: 1.75, taper: 0.8, above: 1.5, pots: 2, smoke: false, breast: { height: FLOOR + 3.2, extra: 0.45 } },
      // A stack through the back slope.
      { x: r.x + 3.0, z: r.z - 1.7, w: 1.0, d: 0.9, above: 1.0, pots: 1, smoke: false },
    ],
  };
}

/** The wing (layout: x 5.5, z −1.2, 5 × 7): a storey and a knee wall, its gable to the square. */
export function wingSpec(s: Structure): HouseSpec {
  const w = s.wings[0]!;
  const r = s.body;
  // Only the strip of its west wall behind the main body shows.
  const behind = r.z - r.d / 2 - (w.z - w.d / 2);
  return {
    rect: w,
    floorY: FLOOR,
    storeys: [3.0, 0.85],
    // Its west wall and the west end of its front stand inside the main body.
    walls: { left: { to: Math.max(0.05, behind) }, front: { from: r.x + r.w / 2 - (w.x - w.w / 2) - 0.05 } },
    plinth: {
      rises: [{ side: 'back', u0: 0, u1: 1.0, top: 1.3 }],
      buttresses: [{ x: w.x + w.w / 2, z: w.z - w.d / 2 + 0.6, yaw: Math.PI / 2, height: 1.9, width: 0.8 }],
    },
    openings: [
      { side: 'front', storey: 0, at: -0.3, window: { shape: 'square', w: 0.9, h: 1.2, bars: 'cross', box: true } },
      { side: 'front', storey: 0, at: 1.45, door: { w: 1.0, h: 2.15, shape: 'square', surround: 'timber' } },
      { side: 'front', storey: 'gable', at: 0, window: { shape: 'arched', w: 0.8, h: 1.25, bars: 'cross', box: true, v: 0.45 } },
      { side: 'right', storey: 0, at: -1.9, window: { shape: 'square', w: 0.85, h: 1.1, bars: 'cross', shutters: true } },
      { side: 'right', storey: 0, at: 1.5, window: { shape: 'round', w: 0.85, h: 0.85, bars: 'cross', box: true, v: 1.15 } },
      { side: 'back', storey: 0, at: 0.3, window: { shape: 'square', w: 0.8, h: 1.0, bars: 'lattice' } },
      { side: 'back', storey: 'gable', at: 0, window: { shape: 'round', w: 0.7, h: 0.7, bars: 'cross', sill: false, v: 0.5 } },
    ],
    roof: {
      axis: 'z',
      pitch: 0.68,
      eave: 0.55,
      gable: [0.55, 0.65],
      sag: 0.22,
      dormers: [{ facing: 'right', at: -0.4, width: 1.8 }],
      // The part of the west slope that runs into the main body is not seen: no shingles there.
      holes: [{ x: (w.x - w.w / 2 - 0.6 + r.x + r.w / 2) / 2, z: w.z - 0.2, w: r.x + r.w / 2 - (w.x - w.w / 2 - 0.6) - 0.15, d: r.d - 0.6 }],
    },
    chimneys: [{ x: w.x + 1.1, z: w.z - w.d / 2 + 1.1, w: 0.8, d: 0.8, above: 0.6, pots: 1, smoke: false }],
  };
}

/** Lanterns, the sign, the banner and the barrels on the main body's front (wall frames of `house`). */
function frontDetails(site: Site, house: House, s: Structure, swing: SignSwing): void {
  const front0 = house.walls[0]!.front;
  const front1 = house.walls[1]!.front;
  const L = front0.length;
  site.onWall(front0, (w) => {
    // Lanterns either side of the door, above the stone arch springing.
    wallLantern(w.child('lantern-l'), { u: L / 2 - 1.35, v: 2.35, reach: 0.42 });
    wallLantern(w.child('lantern-r'), { u: L / 2 + 1.35, v: 2.35, reach: 0.42 });
    // The sign on an arm near the west corner, over the street, below the jetty.
    hangingSign(w.child('sign'), { u: 1.35, v: 2.45, reach: 1.55, w: 1.05, h: 0.75, emblem: 'tankard', swing });
  });
  site.onWall(front1, (w) => {
    // The banner between the middle and the east window of the upper floor.
    banner(w.child('banner'), { u: L / 2 + 1.75, v: 2.45, reach: 1.25, w: 0.9, h: 2.25, foot: 'swallow', emblem: 'tankard', face: 'out' });
  });
  // Barrels by the wall east of the door (POI 'inn-barrels' stands in front of them).
  const zf = s.body.z + s.body.d / 2 + 0.72;
  const bs = site.child('barrels');
  barrel(bs, { at: [2.15, 0, zf], yaw: 0.3 });
  barrel(bs, { at: [2.95, 0, zf + 0.05], yaw: 1.1, h: 0.82, r: 0.31 });
  barrel(bs, { at: [2.55, 0.86, zf + 0.02], yaw: 0.7, h: 0.7, r: 0.27 });
  barrel(bs, { at: [3.75, 0, zf + 0.35], yaw: Math.PI / 2 + 0.15, lying: true, h: 0.85, r: 0.3 });
}

export const inn: ContentModule = {
  name: 'inn',
  build(ctx) {
    const statics: StaticPiece[] = [];
    const lights: PointLight[] = [];
    const particles: ParticleSource[] = [];
    const parts: PartSet[] = [];
    const updates: ((f: FrameInfo) => void)[] = [];
    const solids: SolidDef[] = [];
    let triangles = 0;
    let buildMs = 0, aoMs = 0;
    for (const s of ctx.layout.structures) {
      if (s.kind !== 'inn') continue;
      const t0 = performance.now();
      const b = new MeshBuilder();
      const out = emitters();
      const swing = signSwing();
      const m = compose34([s.x, ctx.field.padY(s.id), s.z], s.yaw);
      openSite(b, m, ctx.stream(`inn:${s.id}`), INN_PALETTE, out, (site) => {
        const main = buildHouse(site.child('main'), mainSpec(s));
        const wing = s.wings[0] ? buildHouse(site.child('wing'), wingSpec(s)) : undefined;
        frontDetails(site.child('front'), main, s, swing);
        main.chimneyTops.forEach((t, i) => out.particles.push(...chimneySmoke(site.world(t[0], t[1], t[2]), { strength: i === 0 ? 1.3 : 0.8 })));
        wing?.chimneyTops.forEach((t) => out.particles.push(...chimneySmoke(site.world(t[0], t[1], t[2]), { strength: 0.6 })));
      });
      const t1 = performance.now();
      buildMs += t1 - t0;
      // Ambient occlusion: the eaves, the jetty, the reveals and the joints between the stones darken.
      const ground = cachedGround(ctx.heightAt, s.x - 16, s.z - 16, s.x + 16, s.z + 16, 0.5);
      bakeAo(b, { ground, cell: 0.2, rays: 12, reach: 2.2 });
      groundAo(b, ground, 1.0, 0.35);
      aoMs += performance.now() - t1;
      triangles += b.triangleCount;
      statics.push({ material: 'solid', mesh: b, name: s.id });
      solids.push(...structureSolids(ctx, s, b));
      lights.push(...out.lights);
      particles.push(...out.particles);
      // The sign board swings rigidly about its arm (a part set of its own).
      const signs = swingingSigns(`${s.id}.sign`, swing);
      if (signs) {
        parts.push(...signs.parts);
        updates.push(signs.update);
        triangles += swing.mesh.triangleCount;
      }
    }
    const update = updates.length ? (f: FrameInfo): void => {
      for (const u of updates) u(f);
    } : undefined;
    return { statics, parts, update, lights, particles, solids, stats: { innTriangles: triangles, innLights: lights.length, innBuildMs: Math.round(buildMs), innAoMs: Math.round(aoMs) } };
  },
};
