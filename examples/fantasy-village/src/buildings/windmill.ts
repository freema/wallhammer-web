// The windmill on the far hill (B3): a tapering round tower of coursed stone on a stepped plinth, an arched door to
// the village with a lantern, small lit windows climbing round the tower, a timber gallery (stage) on struts with a
// railing, a boat-shaped thatched cap on a timber curb with boarded gables, a tail pole with a chain wheel down to the
// gallery, and four lattice sails with cream cloth (one reefed) turning slowly: a dynamic part set.
// Owner: buildings.

import { THATCH_PALETTE, curvedTimber, doorAt, emitters, openSite, rectWalls, roofShape, stoneBlock, timber, wallFrame, wallLantern, wallPoint, windowAt } from '../arch/index.ts';
import type { ArchPalette, Site } from '../arch/index.ts';
import type { ContentModule, FrameInfo, Mat34, PartSet, ParticleSource, PointLight, RGB, SolidDef, StaticPiece, Vec3 } from '../kit/index.ts';
import { MAT, MeshBuilder, PALETTE, bevelBox, clamp, compose34, createPartSet, hex, lathe, lerp, mixRgb, pushPart, scaleRgb, sweep, writePart } from '../kit/index.ts';
import { finish, foundationDepth, localGround, plankWall, smoothQuad, spin34, structureSolids, thatchRoof } from './shared.ts';

/** Tower: radius at the foot and at the top, height of the top (the curb). */
const R0 = 2.6, R1 = 1.95, TOP = 8.6;
/** Gallery deck height and its reach out of the tower. */
const GALLERY = 4.9, GREACH = 1.0;
/** Hub of the sails (site-local) and the windshaft's tilt (front end up). */
const HUB: Vec3 = [0, TOP + 1.25, 3.0];
const TILT = -0.12;
/** Sail speed (rad/s) and length. */
const SAIL_SPEED = 0.55, SAIL = 7.6;

const radiusAt = (y: number): number => lerp(R0, R1, clamp(y / TOP, 0, 1));

/** Light limewashed stone with warm patches, thatch for the cap. */
const WINDMILL_PALETTE: ArchPalette = {
  ...THATCH_PALETTE,
  stone: hex('#b0a89a'),
  stoneWarm: hex('#bca88c'),
  stoneDark: hex('#86807a'),
  plank: hex('#7a5232'),
  shutter: hex('#4a6a3a'),
};

/** An opening of the round wall: heading round the tower (0 = front), bottom and size. */
interface RoundOpening {
  a: number;
  v: number;
  w: number;
  h: number;
  door?: boolean;
  light?: boolean;
}

const OPENINGS: RoundOpening[] = [
  { a: 0, v: 0, w: 1.15, h: 2.3, door: true },
  { a: 0, v: 3.3, w: 0.62, h: 0.85, light: true },
  { a: 1.95, v: 1.6, w: 0.55, h: 0.75 },
  { a: -2.2, v: 3.0, w: 0.55, h: 0.75 },
  { a: Math.PI, v: 1.7, w: 0.55, h: 0.75 },
  { a: 0.85, v: 5.9, w: 0.6, h: 0.8, light: true },
  { a: -1.1, v: 6.4, w: 0.55, h: 0.75 },
  // The door onto the gallery at the back.
  { a: Math.PI - 0.35, v: GALLERY + 0.05, w: 0.85, h: 1.9, door: true },
];

/** The wall frame tangent to the tower at heading `a` and height `v` (u = 1 at the opening's centre, w outward). */
function tangentFrame(a: number, r: number) {
  const nx = Math.sin(a), nz = Math.cos(a);
  const dx = nz, dz = -nx;
  const cx = nx * r, cz = nz * r;
  return wallFrame([cx - dx, cz - dz], [cx + dx, cz + dz], 0);
}

function tower(site: Site, below: number): void {
  // Courses from below the ground to the curb; blocks round each course, joints staggered, openings left free.
  const ys: number[] = [-below];
  while (ys[ys.length - 1]! < TOP - 0.3) ys.push(Math.min(TOP, ys[ys.length - 1]! + site.s.nextRange(0.44, 0.56)));
  ys[ys.length - 1] = TOP;
  const depth = 0.62;
  for (let k = 0; k < ys.length - 1; k++) {
    const y0 = ys[k]!, y1 = ys[k + 1]!;
    const r = radiusAt((y0 + y1) / 2) + 0.06;
    const circ = 2 * Math.PI * r;
    const n = Math.max(8, Math.round(circ / site.s.nextRange(0.78, 0.92)));
    const phase = site.s.next() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a0 = phase + (i / n) * Math.PI * 2;
      const am = a0 + Math.PI / n;
      // Leave openings free (with a margin for their surrounds).
      const blocked = OPENINGS.some((o) => {
        let d = Math.abs(((am - o.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        d *= r;
        const top = o.v + o.h + (o.door ? 0.35 : 0.25);
        return d < o.w / 2 + 0.28 && y1 > o.v - 0.12 && y0 < top;
      });
      if (blocked) continue;
      const len = circ / n - 0.035;
      site.at(compose34([Math.sin(am) * (r - depth / 2), y0 + 0.012, Math.cos(am) * (r - depth / 2)], am), (b) =>
        stoneBlock(b, [b.s.nextJitter(0.015), 0, b.s.nextJitter(0.03)], [len, y1 - y0 - 0.025, depth * b.s.nextRange(0.9, 1.05)], { taper: b.s.nextRange(0.95, 1.0) }),
      );
    }
  }
  // A stepped plinth ring round the foot.
  const pr = R0 + 0.28;
  const n = 22;
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    if (Math.abs(((a + Math.PI) % (Math.PI * 2)) - Math.PI) * pr < 0.95) continue;
    site.at(compose34([Math.sin(a) * (pr - 0.35), -below, Math.cos(a) * (pr - 0.35)], a), (b) =>
      stoneBlock(b, [0, 0, 0], [(2 * Math.PI * pr) / n - 0.04, below + 0.42, 0.75], { bevel: 0.06, color: mixRgb(b.pal.stoneDark, b.pal.stone, 0.4) }),
    );
  }
  // Openings: windows and doors in tangent frames, with a lintel stone and jambs where the blocks were left out.
  for (const o of OPENINGS) {
    const r = radiusAt(o.v + o.h / 2) + 0.06;
    site.onWall(tangentFrame(o.a, r), (w) => {
      if (o.door) {
        doorAt(w.child('door'), { u: 1, v: o.v, w: o.w, h: o.h, shape: 'arched', surround: o.v > 1 ? 'timber' : 'stone', steps: 0, depth: 0.45 });
        if (o.v < 1) wallLantern(w.child('lantern'), { u: 1 + o.w / 2 + 0.55, v: 1.95, reach: 0.38, radius: 6.5, intensity: 0.9 });
      } else {
        windowAt(w.child('win'), { shape: 'square', u: 1, v: o.v, w: o.w, h: o.h, bars: 'cross', depth: 0.42, sill: true, ...(o.light ? { light: { radius: 5, intensity: 0.5 } } : { glow: 0.85 }) });
        stoneBlock(w, [1, o.v + o.h + 0.01, -0.28], [o.w + 0.5, 0.26, 0.5], { bevel: 0.04 });
      }
      // Jamb stones either side, alternating long and short, filling the margin the courses left.
      for (const sx of [-1, 1]) {
        let v = o.v - 0.1;
        let k = 0;
        const top = o.v + o.h + (o.door ? 0.3 : 0.27);
        while (v < top - 0.05) {
          const h = Math.min(top - v, w.s.nextRange(0.34, 0.46));
          const wd = k % 2 ? 0.26 : 0.36;
          if (!o.door || v < o.v + o.h - o.w / 2) stoneBlock(w, [1 + sx * (o.w / 2 + wd / 2 + 0.02), v, -0.27], [wd, h - 0.025, 0.56], { bevel: 0.035 });
          v += h;
          k++;
        }
      }
      // Over a door: fill the arch's shoulders up to the courses.
      if (o.door) stoneBlock(w, [1, o.v + o.h + 0.02, -0.28], [o.w + 0.9, 0.3, 0.52], { bevel: 0.04 });
    });
  }
}

function gallery(site: Site): void {
  const r0 = radiusAt(GALLERY) - 0.05, r1 = radiusAt(GALLERY) + GREACH;
  const wood = site.pal.plank;
  // Deck: radial boards on a ring of joists.
  const nb = 44;
  site.b.withFlags({ cls: MAT.wood }, () => {
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2;
      const wOut = (2 * Math.PI * r1) / nb - 0.02;
      site.b.with(compose34([0, GALLERY, 0], a), () =>
        bevelBox(site.b, [0, -0.06, (r0 + r1) / 2], [wOut * 0.82, 0.06, r1 - r0], site.tone(mixRgb(wood, site.pal.timber, site.s.next() * 0.4)), { bevel: 0.012, taper: [1.0, 1.0] }),
      );
    }
  });
  // Joist ring and edge beam (swept rings).
  const ring = (r: number, y: number, prof: [number, number][], col: RGB): void => {
    const path: Vec3[] = [];
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      path.push([Math.sin(a) * r, y, Math.cos(a) * r]);
    }
    site.b.withFlags({ cls: MAT.wood }, () => sweep(site.b, path, prof, col, { closed: true, caps: false, up: [0, 1, 0], faceted: true }));
  };
  const box = (w: number, h: number): [number, number][] => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  ring(r1 - 0.08, GALLERY - 0.2, box(0.16, 0.22), site.pal.timberDark);
  ring(r0 + 0.35, GALLERY - 0.2, box(0.16, 0.22), site.pal.timberDark);
  // Struts from the tower to the edge, posts and rails above.
  const ns = 14;
  for (let i = 0; i < ns; i++) {
    const a = ((i + 0.5) / ns) * Math.PI * 2;
    const sx = Math.sin(a), sz = Math.cos(a);
    const rw = radiusAt(GALLERY - 1.7);
    timber(site, [sx * (rw - 0.05), GALLERY - 1.7, sz * (rw - 0.05)], [sx * (r1 - 0.15), GALLERY - 0.24, sz * (r1 - 0.15)], { width: 0.15, depth: 0.15, sag: 0, color: site.pal.timberDark });
    timber(site, [sx * (r0 + 0.02), GALLERY - 0.26, sz * (r0 + 0.02)], [sx * (r1 - 0.05), GALLERY - 0.26, sz * (r1 - 0.05)], { width: 0.14, depth: 0.16, sag: 0 });
    timber(site, [sx * (r1 - 0.08), GALLERY - 0.05, sz * (r1 - 0.08)], [sx * (r1 - 0.08), GALLERY + 1.0, sz * (r1 - 0.08)], { width: 0.1, depth: 0.1, sag: 0, overhang: 0.04 });
  }
  ring(r1 - 0.08, GALLERY + 1.0, box(0.1, 0.08), site.pal.timber);
  ring(r1 - 0.08, GALLERY + 0.5, box(0.06, 0.06), site.pal.timber);
}

function cap(site: Site): Vec3 {
  // The curb and the cap's base frame resting on it.
  const curbPath: Vec3[] = [];
  for (let k = 0; k <= 40; k++) {
    const a = (k / 40) * Math.PI * 2;
    curbPath.push([Math.sin(a) * (R1 + 0.06), TOP + 0.1, Math.cos(a) * (R1 + 0.06)]);
  }
  site.b.withFlags({ cls: MAT.wood }, () => {
    sweep(site.b, curbPath, [[-0.14, -0.1], [0.14, -0.1], [0.14, 0.1], [-0.14, 0.1]], site.pal.timberDark, { closed: true, caps: false, faceted: true });
    bevelBox(site.b, [0, TOP + 0.2, 0], [3.7, 0.2, 3.5], site.pal.timberDark, { bevel: 0.04 });
    for (const x of [-1.6, 1.6]) bevelBox(site.b, [x, TOP + 0.4, 0], [0.24, 0.26, 3.75], site.pal.timber, { bevel: 0.03 });
  });
  const base = TOP + 0.66;
  const rect = { x: 0, z: 0, w: 3.6, d: 3.4 };
  // Ridge along z (the windshaft): s from the back (−z) to the front (+z).
  const shape = roofShape({ x: 0, z: 0, y: base, axis: 'z', length: rect.d, span: rect.w, rise: 2.35, eave: 0.42, gable: [0.38, 0.4], sag: 0.1, flare: 0.42, curl: 0.12, dip: 0.04 });
  thatchRoof(site.child('thatch'), shape, { thick: 0.15, butt: 0.15, course: 0.36 });
  // Boarded gables front and back, low board walls under the eaves at the sides.
  const capWalls = rectWalls(rect, TOP + 0.3);
  for (const side of ['front', 'back'] as const) {
    const w = capWalls[side];
    const L = w.length;
    site.onWall(w, (ws) => {
      const top = (u: number): number => {
        const p = wallPoint(w, Math.min(L, Math.max(0, u)), 0);
        return shape.underside(p[0], p[2]) - (TOP + 0.3) - 0.02;
      };
      // The front gable leaves a hole for the windshaft.
      const sv = HUB[1] - 0.25 - (TOP + 0.3);
      const hole = side === 'front' ? [{ u0: L / 2 - 0.3, u1: L / 2 + 0.3, v0: sv - 0.3, v1: sv + 0.3 }] : [];
      plankWall(ws, { from: 0, to: L, bottom: 0, top, openings: hole, width: 0.24 });
      timber(ws, [0.08, 0.02, 0.05], [0.08, top(0.08) - 0.05, 0.05], { width: 0.14, depth: 0.12, sag: 0 });
      timber(ws, [L - 0.08, 0.02, 0.05], [L - 0.08, top(L - 0.08) - 0.05, 0.05], { width: 0.14, depth: 0.12, sag: 0 });
    });
  }
  for (const side of ['right', 'left'] as const) {
    const w = capWalls[side];
    site.onWall(w, (ws) => plankWall(ws, { from: 0, to: w.length, bottom: 0, top: () => base - (TOP + 0.3) + 0.05, width: 0.26 }));
  }
  // Windshaft stub out of the front gable to the hub (static; the sails and the poll end turn).
  const tail: Vec3 = [0, HUB[1] - Math.sin(-TILT) * (HUB[2] + 0.2), -0.2];
  timber(site, tail, [HUB[0], HUB[1], HUB[2] - 0.4], { width: 0.34, depth: 0.34, sag: 0, color: site.pal.timberDark, up: [1, 0, 0] });
  // Tail pole: from under the back of the cap down and out to the gallery, braced, with a chain wheel at its end.
  const r = radiusAt(GALLERY) + GREACH;
  const end: Vec3 = [0, GALLERY + 1.25, -r - 0.9];
  const start: Vec3 = [0, TOP + 0.35, -rect.d / 2 + 0.3];
  timber(site, start, end, { width: 0.26, depth: 0.24, sag: 0.04, color: site.pal.timberDark });
  for (const sx of [-1, 1]) curvedTimber(site, [sx * 1.4, TOP + 0.3, -rect.d / 2 + 0.2], [sx * 0.8, TOP - 0.2, -rect.d / 2 - 0.9], [sx * 0.08, lerp(start[1], end[1], 0.42), lerp(start[2], end[2], 0.42)], { width: 0.13, depth: 0.13, color: site.pal.timber });
  // Chain wheel: rim, spokes and handles.
  site.at(compose34([end[0] + 0.25, end[1] - 0.15, end[2] + 0.15], Math.PI / 2, 0, 0), (w) => {
    const rim: Vec3[] = [];
    for (let k = 0; k <= 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      rim.push([Math.cos(a) * 0.55, Math.sin(a) * 0.55, 0]);
    }
    w.b.withFlags({ cls: MAT.wood }, () => {
      sweep(w.b, rim, [[-0.04, -0.04], [0.04, -0.04], [0.04, 0.04], [-0.04, 0.04]], w.pal.timber, { closed: true, caps: false, faceted: true, up: [0, 0, 1] });
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        w.b.with(compose34([0, 0, 0], 0, 0, a), () => bevelBox(w.b, [0, 0.28, 0], [0.05, 0.54, 0.05], w.pal.timberDark, { anchor: 'center', bevel: 0.01 }));
        w.b.with(compose34([0, 0, 0], 0, 0, a + 0.5), () => bevelBox(w.b, [0, 0.64, 0], [0.04, 0.18, 0.04], w.pal.timberDark, { anchor: 'center', bevel: 0.01 }));
      }
    });
  });
  return HUB;
}

/** The four sails and the poll end in the hub frame: axle along +z, sails in the x–y plane. */
function sailsMesh(stream: Site['s']): MeshBuilder {
  const b = new MeshBuilder();
  const wood = hex('#6a4a30');
  const cloth = PALETTE.fabricCream;
  // Poll end: an iron canister on the shaft, and the shaft's head.
  b.withFlags({ cls: MAT.metal }, () => {
    bevelBox(b, [0, 0, -0.1], [0.62, 0.62, 0.62], scaleRgb(PALETTE.iron, 1.1), { anchor: 'center', bevel: 0.06 });
    b.with(compose34([0, 0, -0.45], 0, Math.PI / 2, 0), () => lathe(b, [0, -0.1, 0], [[0.26, 0], [0.3, 0.12], [0.3, 0.45], [0.2, 0.55]], PALETTE.iron, { segments: 10, capBottom: true, capTop: true }));
  });
  for (let k = 0; k < 4; k++) {
    const reef = k === 2 ? 0.45 : 1;
    b.with(compose34([0, 0, 0], 0, 0, (k / 4) * Math.PI * 2), () => {
      const z = k % 2 === 0 ? 0.18 : 0.42;
      b.withFlags({ cls: MAT.wood }, () => {
        // The stock (whip) through the canister, tapering out.
        bevelBox(b, [0, 0.2, z], [0.24, SAIL - 0.2, 0.22], scaleRgb(wood, 0.95 + 0.1 * stream.float(k, 1)), { bevel: 0.03, taper: [0.6, 0.7] });
        // Hemlaths along both edges.
        for (const [x, w] of [[-0.42, 0.07], [1.55, 0.08]] as const) bevelBox(b, [x, 1.3, z - 0.02], [w, SAIL - 1.45, w], wood, { bevel: 0.015 });
        // Sail bars across, every 0.44 m.
        for (let y = 1.35; y < SAIL - 0.1; y += 0.44) bevelBox(b, [0.56, y, z - 0.02], [2.08, 0.05, 0.05], scaleRgb(wood, 0.9 + 0.2 * stream.float(k, Math.round(y * 10))), { anchor: 'center', bevel: 0.012 });
        // Short leading boards on the narrow side.
        bevelBox(b, [-0.25, 1.4, z - 0.05], [0.3, SAIL - 1.6, 0.025], scaleRgb(wood, 1.08), { bevel: 0.008 });
      });
      // Cloth: spread over the wide side (or reefed toward the stock), billowing a little, both faces.
      const x0 = 0.12, x1 = lerp(0.3, 1.5, reef);
      const y0 = 1.45, y1 = SAIL - 0.25;
      const cols = 3, rows = 10;
      b.withFlags({ cls: MAT.fabric, sway: 0.06 }, () => {
        const pt = (i: number, j: number): Vec3 => {
          const fx = i / cols, fy = j / rows;
          return [lerp(x0, x1, fx), lerp(y0, y1, fy), z - 0.09 - 0.07 * Math.sin(Math.PI * fx) * Math.sin(Math.PI * fy) * reef];
        };
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const c = scaleRgb(mixRgb(cloth, hex('#d8c49a'), stream.float(k, i, j) * 0.6), 0.92 + 0.08 * stream.float(k, i, j, 2));
            const q = [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)];
            smoothQuad(b, q, [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]], [c, c, c, c]);
            const back = scaleRgb(c, 0.86);
            smoothQuad(b, q, [[0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 0, -1]], [back, back, back, back]);
          }
        }
      });
      // A reefed sail: the cloth rolled along the stock.
      if (reef < 1) b.withFlags({ cls: MAT.fabric }, () => lathe(b, [0.2, 1.45, z - 0.1], [[0.07, 0], [0.09, 0.3], [0.09, SAIL - 2.0], [0.07, SAIL - 1.7]], scaleRgb(cloth, 0.9), { segments: 6, capBottom: true, capTop: true, noise: 0.15, stream }));
    });
  }
  return b;
}

export const windmill: ContentModule = {
  name: 'windmill',
  build(ctx) {
    const statics: StaticPiece[] = [];
    const lights: PointLight[] = [];
    const particles: ParticleSource[] = [];
    const parts: PartSet[] = [];
    const solids: SolidDef[] = [];
    const mills: { set: PartSet; p: Vec3; yaw: number; m: Mat34 }[] = [];
    const t0 = performance.now();
    for (const s of ctx.layout.structures) {
      if (s.kind !== 'windmill') continue;
      const padY = ctx.field.padY(s.id);
      const g = localGround(ctx, s, padY);
      const below = foundationDepth(g, { x: 0, z: 0, w: 2 * R0, d: 2 * R0 }, 0.4, 0.5);
      const b = new MeshBuilder();
      const out = emitters();
      const m = compose34([s.x, padY, s.z], s.yaw);
      const stream = ctx.stream(`windmill:${s.id}`);
      let hub: Vec3 = [0, 0, 0];
      openSite(b, m, stream, WINDMILL_PALETTE, out, (site) => {
        tower(site.child('tower'), below);
        gallery(site.child('gallery'));
        const h = cap(site.child('cap'));
        hub = site.world(h[0], h[1], h[2]);
      });
      finish(ctx, s, b, 14);
      statics.push({ material: 'solid', mesh: b, name: s.id });
      solids.push(...structureSolids(ctx, s, b));
      lights.push(...out.lights);
      particles.push(...out.particles);
      const set = createPartSet('windmill.sails', sailsMesh(stream.child('sails')), 1, { dynamic: true, castShadow: true });
      const pm = spin34(new Float64Array(12), hub[0], hub[1], hub[2], s.yaw, TILT, 0);
      pushPart(set, pm);
      parts.push(set);
      mills.push({ set, p: hub, yaw: s.yaw, m: pm });
    }
    return {
      statics,
      parts,
      lights,
      particles,
      solids,
      update(frame: FrameInfo) {
        for (const w of mills) {
          spin34(w.m, w.p[0], w.p[1], w.p[2], w.yaw, TILT, -frame.time * SAIL_SPEED);
          writePart(w.set, 0, w.m);
          w.set.dirty = true;
        }
      },
      stats: { windmillTriangles: statics.reduce((n, p) => n + p.mesh.triangleCount, 0), windmillSailTriangles: parts.reduce((n, p) => n + p.part.triangleCount, 0), windmillMs: Math.round(performance.now() - t0) },
    };
  },
};
