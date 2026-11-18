// Windows and doors of the architecture kit, built in a wall frame (u along, v up, w out; the plaster plane is w = 0).
//
//   window    square, arched or round with a cross: frame, reveal, a recessed pane that glows warm in the evening,
//             bars, a projecting sill, open plank shutters with Z braces, a flower box, optionally a point light
//   door      arched or square: reveal, a leaf of planks of different colours, iron strap hinges with studs, ring
//             handle, stone voussoirs or a timber arch around it, stone steps down to the ground
//
// `windowOpening` / `doorOpening` give the rectangle the plaster and the timber frame must keep free.

import type { MeshBuilder, RGB, Vec2, Vec3 } from '../kit/index.ts';
import { GLOW, MAT, bevelBox, compose34, lathe, mixRgb, scaleRgb, sweep, tube } from '../kit/index.ts';
import type { Opening, Site } from './site.ts';
import { faceOut, plasterColor, woodPaint } from './site.ts';
import { stoneArch, stoneBlock, stoneSteps } from './stone.ts';
import { curvedTimber, timber } from './timber.ts';

export type WindowShape = 'square' | 'arched' | 'round';

export interface WindowOptions {
  shape?: WindowShape;
  /** Centre along the wall and the bottom of the opening (v). */
  u: number;
  v: number;
  /** Opening width and height (round: the diameter is `w`). */
  w: number;
  h: number;
  /** Depth of the reveal to the pane (default 0.22) and the frame's face width (default 0.13). */
  depth?: number;
  frame?: number;
  /** Bars over the pane: a cross (default), a lattice of lead lines, or none. */
  bars?: 'cross' | 'lattice' | 'none';
  /** Open plank shutters on both sides (square windows; default false). */
  shutters?: boolean;
  /** A flower box under the sill (default false). */
  box?: boolean;
  /** A projecting sill (default true). */
  sill?: boolean;
  /** Pane emission 0–1 in the evening (default 1; 0 for a dark window). */
  glow?: number;
  /** Also cast a warm point light in front of the window in the evening. */
  light?: boolean | { radius?: number; intensity?: number };
}

/** The opening a window needs in the wall. */
export function windowOpening(o: WindowOptions): Opening {
  const h = o.shape === 'round' ? o.w : o.h;
  return { u0: o.u - o.w / 2, u1: o.u + o.w / 2, v0: o.v, v1: o.v + h };
}

/** Points of a window's outline (counter-clockwise from outside), closed, at `grow` beyond the opening. */
function outline(shape: WindowShape, u: number, v: number, w: number, h: number, grow = 0, seg = 10): Vec2[] {
  const hw = w / 2 + grow;
  if (shape === 'round') {
    const r = w / 2 + grow;
    const cy = v + w / 2;
    const out: Vec2[] = [];
    for (let k = 0; k < seg * 2; k++) {
      const a = -Math.PI / 2 + (k / (seg * 2)) * Math.PI * 2;
      out.push([u + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return out;
  }
  if (shape === 'arched') {
    const r = w / 2 + grow;
    const spring = v + h - w / 2;
    const out: Vec2[] = [[u - hw, v - grow], [u + hw, v - grow]];
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI;
      out.push([u + Math.cos(a) * r, spring + Math.sin(a) * r]);
    }
    return out;
  }
  return [[u - hw, v - grow], [u + hw, v - grow], [u + hw, v + h + grow], [u - hw, v + h + grow]];
}

/** A small faceted blob (leaf clumps, blossoms, fruit). */
export function blob(site: Site, at: readonly number[], r: number, color: RGB, squash = 1): void {
  lathe(site.b, at, [[0.001, -r * 0.55 * squash], [r, -r * 0.05 * squash], [r * 0.6, r * 0.7 * squash], [0.001, r * 0.9 * squash]], (_p, n) => scaleRgb(color, 0.82 + 0.3 * Math.max(0, n[1])), {
    segments: 5,
    faceted: true,
    phase: site.s.next() * 3,
  });
}

/** A window in the current wall frame. */
export function windowAt(site: Site, o: WindowOptions): void {
  const b = site.b;
  const shape = o.shape ?? 'square';
  const depth = o.depth ?? 0.22;
  const f = o.frame ?? 0.13;
  const { u0, u1, v0, v1 } = windowOpening(o);
  const w = u1 - u0, h = v1 - v0;
  const u = o.u;
  const glowAmount = o.glow ?? 1;
  const pal = site.pal;
  const seed = (site.s.next() * 1e6) | 0;
  const inner = outline(shape, u, v0, w, h, 0, shape === 'round' ? 8 : 8);
  // Plaster that fills the square hole around round and arched outlines (the plaster grid cuts a rectangle).
  if (shape !== 'square') {
    b.withFlags({ cls: MAT.plaster }, () => {
      const col = (x: number, y: number): RGB => plasterColor(pal, x, y, seed);
      for (let k = 0; k < inner.length; k++) {
        const p = inner[k]!, q = inner[(k + 1) % inner.length]!;
        // Project both points outward to the hole's rectangle (straight up/down or sideways by the larger share).
        const proj = (r: Vec2): Vec2 => {
          const dx = r[0] - u, dy = r[1] - (v0 + h / 2);
          const t = Math.min((w / 2) / Math.max(1e-6, Math.abs(dx)), (h / 2) / Math.max(1e-6, Math.abs(dy)));
          return [u + dx * t, v0 + h / 2 + dy * t];
        };
        const P = proj(p), Q = proj(q);
        const pts = [[P[0], P[1], -0.005], [Q[0], Q[1], -0.005], [q[0], q[1], -0.005], [p[0], p[1], -0.005]];
        const area = Math.abs((Q[0] - P[0]) * (p[1] - P[1]) - (p[0] - P[0]) * (Q[1] - P[1])) + Math.abs((Q[0] - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (Q[1] - q[1]));
        if (area < 1e-5) continue;
        faceOut(b, pts, [0, 0, 1], pts.map((r) => col(r[0]!, r[1]!)));
      }
    });
  }
  // Reveal: the sides of the hole from the wall face back to the pane, a little darker than the wall.
  b.withFlags({ cls: MAT.plaster }, () => {
    const cx = u, cy = shape === 'round' ? v0 + w / 2 : shape === 'arched' ? v1 - w / 2 : v0 + h / 2;
    for (let k = 0; k < inner.length; k++) {
      const p = inner[k]!, q = inner[(k + 1) % inner.length]!;
      const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      // Inward: toward the centre for round parts; straight in for the square sides.
      let into: Vec3 = [cx - mid[0]!, cy - mid[1]!, 0];
      if (shape !== 'round' && Math.abs(p[0] - q[0]) < 1e-4) into = [cx - mid[0]!, 0, 0];
      if (shape !== 'round' && Math.abs(p[1] - q[1]) < 1e-4) into = [0, cy - mid[1]!, 0];
      const c = scaleRgb(plasterColor(pal, mid[0]!, mid[1]!, seed), 0.78);
      faceOut(b, [[p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], -depth], [p[0], p[1], -depth]], into, [c, c, scaleRgb(c, 0.8), scaleRgb(c, 0.8)]);
    }
  });
  // The pane: warm light, brighter in the middle.
  b.withFlags({ cls: MAT.glass, glow: glowAmount, channel: GLOW.evening }, () => {
    const cy = v0 + h / 2;
    const center = [u, cy, -depth];
    const pts = inner.map((p) => [p[0], p[1], -depth]);
    const ci = b.vertex(center, [0, 0, 1], scaleRgb(pal.glow, 1.0));
    const ring = pts.map((p) => b.vertex(p, [0, 0, 1], mixRgb(pal.glow, scaleRgb(pal.glow, 0.55), 0.8)));
    for (let k = 0; k < ring.length; k++) b.tri(ci, ring[k]!, ring[(k + 1) % ring.length]!);
  });
  // Bars in front of the pane.
  const bars = o.bars ?? 'cross';
  const barW = 0.075;
  const wz = -depth + 0.045;
  b.withFlags({ cls: MAT.wood }, () => {
    const bar = (x0: number, y0: number, x1: number, y1: number, width: number, col: RGB): void => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const ang = Math.atan2(y1 - y0, x1 - x0);
      site.at(compose34([(x0 + x1) / 2, (y0 + y1) / 2, wz], 0, 0, ang), (s2) =>
        bevelBox(s2.b, [0, 0, 0], [len, width, 0.07], woodPaint(col), { anchor: 'center', bevel: 0.015 }),
      );
    };
    const col = site.tone(pal.timberDark);
    if (bars === 'cross') {
      if (shape === 'round') {
        const r = w / 2, cy = v0 + r;
        bar(u - r, cy, u + r, cy, barW, col);
        bar(u, cy - r, u, cy + r, barW, col);
      } else {
        const vt = shape === 'arched' ? v1 - 0.02 : v1;
        bar(u, v0, u, vt, barW, col);
        const hy = shape === 'arched' ? v1 - w / 2 : v0 + h * 0.56;
        bar(u0, hy, u1, hy, barW, col);
      }
    } else if (bars === 'lattice') {
      // Diamond lead lines, thin and dark, clipped to the opening's box.
      const lead: RGB = [0.16, 0.15, 0.17];
      const step = 0.24;
      const top = shape === 'arched' ? v1 - w / 2 : v1;
      for (let d = -h; d < w + h; d += step) {
        const a: Vec2 = [u0 + d, v0], c: Vec2 = [u0 + d - h, v0 + h];
        const e: Vec2 = [u0 + d - h, v0], g: Vec2 = [u0 + d, v0 + h];
        for (const [p, q] of [[a, c], [e, g]] as const) {
          // Clip the segment to the rectangle u0..u1 × v0..top.
          let t0 = 0, t1 = 1;
          const dx = q[0] - p[0], dy = q[1] - p[1];
          for (const [pp, qq] of [[-dx, p[0] - u0], [dx, u1 - p[0]], [-dy, p[1] - v0], [dy, top - p[1]]] as const) {
            if (Math.abs(pp) < 1e-9) { if (qq < 0) t1 = -1; continue; }
            const r = qq / pp;
            if (pp < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
          }
          if (t1 - t0 > 0.05) bar(p[0] + dx * t0, p[1] + dy * t0, p[0] + dx * t1, p[1] + dy * t1, 0.03, lead);
        }
      }
      bar(u, v0, u, top, barW, col);
    }
  });
  // Frame around the opening, standing out of the wall.
  const fc = pal.timberDark;
  if (shape === 'square') {
    const out = 0.06;
    timber(site, [u0 - f / 2, v0 - f, out], [u0 - f / 2, v1 + f, out], { width: f, depth: 0.16, sag: 0, color: fc });
    timber(site, [u1 + f / 2, v0 - f, out], [u1 + f / 2, v1 + f, out], { width: f, depth: 0.16, sag: 0, color: fc });
    timber(site, [u0 - f * 1.6, v1 + f / 2, out + 0.01], [u1 + f * 1.6, v1 + f / 2, out + 0.01], { width: f * 1.2, depth: 0.18, sag: 0.01, color: fc });
  } else {
    // A frame swept around the curve (closed ring for round, an arch on two jambs for arched).
    const ring = outline(shape, u, v0, w, h, f / 2, 10).map((p) => [p[0], p[1], 0.05] as Vec3);
    const col = site.tone(fc);
    const prof: [number, number][] = [[f / 2, 0.08], [-f / 2, 0.08], [-f / 2, -0.08], [f / 2, -0.08]];
    b.withFlags({ cls: MAT.wood }, () => {
      if (shape === 'round') sweep(b, [...ring, ring[0]!, ring[1]!], prof, woodPaint(col), { closed: true, faceted: true, up: [0, 0, 1] });
      else {
        const arc = ring.slice(2);
        sweep(b, arc, prof, woodPaint(col), { closed: true, faceted: true, caps: true, up: [0, 0, 1] });
        timber(site, [u0 - f / 2, v0 - f, 0.05], [u0 - f / 2, v1 - w / 2 + 0.02, 0.05], { width: f, depth: 0.16, sag: 0, color: fc });
        timber(site, [u1 + f / 2, v0 - f, 0.05], [u1 + f / 2, v1 - w / 2 + 0.02, 0.05], { width: f, depth: 0.16, sag: 0, color: fc });
      }
    });
    if (shape === 'round') {
      // Four wedge blocks at the quarters, a keystone look of the concept's round windows.
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 2;
        const r = w / 2 + f * 0.6;
        site.at(compose34([u + Math.cos(a) * r, v0 + w / 2 + Math.sin(a) * r, 0.06], 0, 0, a - Math.PI / 2), (s2) =>
          s2.b.withFlags({ cls: MAT.wood }, () => bevelBox(s2.b, [0, 0, 0], [0.2, f * 1.6, 0.2], woodPaint(s2.tone(fc)), { anchor: 'center', bevel: 0.04 })),
        );
      }
    }
  }
  // Sill.
  if (o.sill !== false) {
    const sw = w + 2 * f + 0.2;
    const sy = shape === 'round' ? v0 - f * 0.9 - 0.08 : v0 - f - 0.08;
    b.withFlags({ cls: MAT.wood }, () =>
      bevelBox(b, [u, sy, 0.1], [sw, 0.1, 0.32], woodPaint(site.tone(pal.plank)), { bevel: 0.03, jitter: 0.012, stream: site.s }),
    );
    if (o.box) flowerBox(site, { u, v: sy - 0.02, w: sw - 0.06 });
  }
  if (o.shutters && shape !== 'round') shutters(site, { u0: u0 - f, u1: u1 + f, v0: v0 - 0.02, h: h + 0.04 });
  if (o.light) {
    const lo = typeof o.light === 'object' ? o.light : {};
    site.light([u, v0 + h * 0.55, 0.9], [1.0, 0.68, 0.32], lo.radius ?? 6.5, lo.intensity ?? 0.85, 0.05);
  }
}

/** Two plank shutters standing open on both sides of a window (wall frame): planks, battens, Z brace, hinges. */
export function shutters(site: Site, o: { u0: number; u1: number; v0: number; h: number; color?: RGB }): void {
  const leaf = (o.u1 - o.u0) / 2 - 0.02;
  for (const side of [-1, 1] as const) {
    const hinge = side < 0 ? o.u0 : o.u1;
    const open = site.s.nextRange(0.06, 0.4);
    site.at(compose34([hinge, o.v0, 0.06], side < 0 ? open : -open), (s2) => {
      const col = s2.tone(o.color ?? s2.pal.shutter, { hue: 0.015, sat: 0.12, val: 0.14 });
      const n = leaf > 0.55 ? 3 : 2;
      const pw = leaf / n;
      s2.b.withFlags({ cls: MAT.wood }, () => {
        for (let k = 0; k < n; k++) {
          const x = side * (pw * (k + 0.5) + 0.02);
          bevelBox(s2.b, [x, 0, 0], [pw - 0.015, o.h + s2.s.nextJitter(0.03), 0.05], woodPaint(s2.tone(col, { hue: 0.01, sat: 0.08, val: 0.12 })), { bevel: 0.012 });
        }
        // Battens and the Z brace on the outside.
        const batten = scaleRgb(col, 0.82);
        for (const y of [0.16, o.h - 0.24]) bevelBox(s2.b, [side * (leaf / 2 + 0.02), y, 0.045], [leaf - 0.06, 0.1, 0.04], woodPaint(batten), { bevel: 0.012 });
        const ang = Math.atan2(o.h - 0.5, leaf - 0.12) * -side;
        s2.at(compose34([side * (leaf / 2 + 0.02), o.h / 2 - 0.04, 0.045], 0, 0, ang), (s3) =>
          bevelBox(s3.b, [0, 0, 0], [Math.hypot(o.h - 0.5, leaf - 0.12), 0.09, 0.035], woodPaint(batten), { anchor: 'center', bevel: 0.01 }),
        );
      });
      // Iron hinges.
      s2.b.withFlags({ cls: MAT.metal }, () => {
        for (const y of [0.18, o.h - 0.22]) bevelBox(s2.b, [side * 0.18, y, 0.075], [0.36, 0.05, 0.02], s2.pal.iron, { bevel: 0.008 });
      });
    });
  }
}

/** A flower box hanging under a window sill (wall frame): planks, soil, leaves, blossoms and trailing stems. */
export function flowerBox(site: Site, o: { u: number; v: number; w: number }): void {
  const b = site.b;
  const H = 0.26, D = 0.3;
  const col = site.tone(site.pal.plank);
  b.withFlags({ cls: MAT.wood }, () => {
    bevelBox(b, [o.u, o.v - H, 0.18], [o.w, H, D], woodPaint(col), { bevel: 0.025, jitter: 0.01, stream: site.s });
    // Plank lines on the front and two brackets under it.
    bevelBox(b, [o.u, o.v - H * 0.52, 0.18 + D / 2], [o.w + 0.02, 0.025, 0.02], woodPaint(scaleRgb(col, 0.7)), { bevel: 0.006 });
    for (const sx of [-1, 1]) bevelBox(b, [o.u + sx * (o.w / 2 - 0.12), o.v - H - 0.16, 0.12], [0.07, 0.18, 0.22], woodPaint(scaleRgb(col, 0.85)), { bevel: 0.02, taper: [1, 1.0] });
  });
  // Soil.
  b.withFlags({ cls: MAT.ground }, () => bevelBox(b, [o.u, o.v - 0.06, 0.18], [o.w - 0.06, 0.05, D - 0.06], [0.24, 0.16, 0.1], { bevel: 0.01 }));
  // Leaves and blossoms, swaying a little.
  b.withFlags({ cls: MAT.foliage, sway: 0.22 }, () => {
    const n = Math.max(3, Math.round(o.w / 0.2));
    for (let k = 0; k < n; k++) {
      const x = o.u - o.w / 2 + 0.1 + ((o.w - 0.2) * (k + site.s.nextRange(0.2, 0.8))) / n;
      blob(site, [x, o.v + 0.02, 0.18 + site.s.nextJitter(0.07)], site.s.nextRange(0.09, 0.13), site.tone(site.pal.leaves), 0.8);
    }
  });
  b.withFlags({ cls: MAT.foliage, sway: 0.3 }, () => {
    const n = Math.max(4, Math.round(o.w / 0.15));
    const cols = site.pal.flowers;
    const pick = site.s.nextInt(0, cols.length - 1);
    for (let k = 0; k < n; k++) {
      const x = o.u - o.w / 2 + 0.08 + ((o.w - 0.16) * (k + site.s.nextRange(0.1, 0.9))) / n;
      // Mostly one colour per box, some of another.
      const c = site.s.next() < 0.7 ? cols[pick]! : cols[site.s.nextInt(0, cols.length - 1)]!;
      blob(site, [x, o.v + 0.1 + site.s.nextRange(0, 0.1), 0.18 + site.s.nextJitter(0.1)], site.s.nextRange(0.05, 0.075), site.tone(c, { hue: 0.02, sat: 0.1, val: 0.12 }));
    }
    // Trailing stems over the front edge.
    for (let k = 0; k < 2; k++) {
      const x = o.u + (k === 0 ? -1 : 1) * o.w * site.s.nextRange(0.12, 0.35);
      const len = site.s.nextRange(0.25, 0.45);
      const leaf = site.tone(site.pal.leaves);
      tube(b, [[x, o.v - 0.02, 0.18 + D / 2 - 0.02], [x + 0.03, o.v - 0.06, 0.18 + D / 2 + 0.05], [x + 0.05, o.v - len * 0.6, 0.18 + D / 2 + 0.07], [x + 0.02, o.v - len, 0.18 + D / 2 + 0.04]], (t) => 0.035 * (1 - t * 0.5), leaf, { sides: 5, caps: true });
      blob(site, [x + 0.02, o.v - len - 0.03, 0.18 + D / 2 + 0.04], 0.06, site.tone(leaf), 0.9);
    }
  });
}

export interface DoorOptions {
  /** Centre along the wall and the threshold height (v). */
  u: number;
  v: number;
  /** Opening width and full height (to the top of the arch). */
  w: number;
  h: number;
  shape?: 'arched' | 'square';
  /** Depth of the reveal to the leaf (default 0.3). */
  depth?: number;
  /** Stone voussoirs and jambs, or a timber arch (default 'stone'). */
  surround?: 'stone' | 'timber';
  /** Stone steps down to the ground: the threshold's height above the ground (0 for none). */
  steps?: number;
  /** Iron straps, studs and the ring handle (default true). */
  hardware?: boolean;
}

/** The opening a door needs in the wall. */
export function doorOpening(o: DoorOptions): Opening {
  return { u0: o.u - o.w / 2, u1: o.u + o.w / 2, v0: o.v, v1: o.v + o.h };
}

/** A nail head: a low four-sided pyramid pointing out along +w (4 triangles). */
export function stud(b: MeshBuilder, at: readonly number[], r: number, col: RGB): void {
  const [x, y, z] = [at[0]!, at[1]!, at[2]!];
  const tip = [x, y, z + r * 0.9];
  const ring = [[x + r, y, z], [x, y + r, z], [x - r, y, z], [x, y - r, z]];
  for (let k = 0; k < 4; k++) faceOut(b, [ring[k]!, ring[(k + 1) % 4]!, tip], [ring[k]![0]! + ring[(k + 1) % 4]![0]! - 2 * x, ring[k]![1]! + ring[(k + 1) % 4]![1]! - 2 * y, r], col);
}

/** A door in the current wall frame. */
export function doorAt(site: Site, o: DoorOptions): void {
  const b = site.b;
  const shape = o.shape ?? 'arched';
  const depth = o.depth ?? 0.3;
  const { u0, u1, v0, v1 } = doorOpening(o);
  const w = u1 - u0;
  const r = w / 2;
  const spring = shape === 'arched' ? v1 - r : v1;
  const u = o.u;
  const pal = site.pal;
  const seed = (site.s.next() * 1e6) | 0;
  const seg = 10;
  const arc: Vec2[] = [];
  if (shape === 'arched') for (let k = 0; k <= seg; k++) arc.push([u - Math.cos((k / seg) * Math.PI) * r, spring + Math.sin((k / seg) * Math.PI) * r]);
  // Spandrels: plaster above the arch up to the hole's top.
  if (shape === 'arched') {
    b.withFlags({ cls: MAT.plaster }, () => {
      for (let k = 0; k < seg; k++) {
        const p = arc[k]!, q = arc[k + 1]!;
        const pts = [[p[0], p[1], -0.005], [q[0], q[1], -0.005], [q[0], v1, -0.005], [p[0], v1, -0.005]];
        if (v1 - Math.max(p[1], q[1]) < 1e-3 && v1 - Math.min(p[1], q[1]) < 1e-3) continue;
        faceOut(b, pts, [0, 0, 1], pts.map((t) => plasterColor(pal, t[0]!, t[1]!, seed)));
      }
    });
  }
  // Reveal.
  b.withFlags({ cls: MAT.stone }, () => {
    const c = scaleRgb(pal.stone, 0.75);
    const quad = (p: Vec2, q: Vec2, into: Vec3): void => faceOut(b, [[p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], -depth], [p[0], p[1], -depth]], into, c);
    quad([u0, v0], [u0, spring], [1, 0, 0]);
    quad([u1, v0], [u1, spring], [-1, 0, 0]);
    if (shape === 'arched') for (let k = 0; k < seg; k++) {
      const p = arc[k]!, q = arc[k + 1]!;
      quad(p, q, [u - (p[0] + q[0]) / 2, spring - (p[1] + q[1]) / 2, 0]);
    }
    else quad([u0, v1], [u1, v1], [0, -1, 0]);
    // Threshold stone.
    bevelBox(b, [u, v0 - 0.12, -depth / 2 + 0.04], [w + 0.1, 0.14, depth + 0.12], pal.stoneWarm, { bevel: 0.03 });
  });
  // The leaf: planks of different colours, their tops following the arch.
  const n = Math.max(3, Math.round(w / 0.2));
  const pw = w / n;
  const zl = -depth + 0.06;
  b.withFlags({ cls: MAT.wood }, () => {
    for (let k = 0; k < n; k++) {
      const x = u0 + pw * (k + 0.5);
      const dx = Math.max(Math.abs(x - u) - pw / 2, 0);
      const top = shape === 'arched' ? spring + Math.sqrt(Math.max(0, r * r - dx * dx)) : v1;
      const col = site.tone(pal.door, { hue: 0.02, sat: 0.14, val: 0.2 });
      bevelBox(b, [x, v0, zl], [pw - 0.012, top - v0 - 0.01, 0.07], woodPaint(col), { bevel: 0.012, anchor: 'base' });
    }
  });
  if (o.hardware !== false) {
    b.withFlags({ cls: MAT.metal }, () => {
      const iron = pal.iron;
      for (const y of [v0 + 0.42, v0 + Math.min(spring - v0 - 0.2, 1.75)]) {
        const len = w * 0.82;
        bevelBox(b, [u0 + len / 2 + 0.03, y, zl + 0.045], [len, 0.075, 0.025], iron, { anchor: 'center', bevel: 0.01 });
        // Fleur end and studs.
        bevelBox(b, [u0 + len + 0.05, y, zl + 0.045], [0.1, 0.13, 0.025], iron, { anchor: 'center', bevel: 0.02 });
        for (let k = 0; k < 4; k++) stud(b, [u0 + 0.1 + (len - 0.15) * (k / 3), y, zl + 0.057], 0.024, scaleRgb(iron, 1.4));
      }
      // Studs in a grid.
      for (let row = 0; row < 3; row++) for (let k = 0; k < n; k++) {
        const y = v0 + 0.8 + row * 0.28;
        if (y > spring - 0.1) continue;
        stud(b, [u0 + pw * (k + 0.5), y, zl + 0.035], 0.022, scaleRgb(iron, 1.3));
      }
      // Ring handle on a plate.
      const hx = u + w * 0.28, hy = v0 + 1.05;
      bevelBox(b, [hx, hy, zl + 0.045], [0.14, 0.2, 0.02], iron, { anchor: 'center', bevel: 0.02 });
      const ring: Vec3[] = [];
      for (let k = 0; k <= 10; k++) {
        const a = -Math.PI / 2 + (k / 10) * Math.PI * 2;
        ring.push([hx + Math.cos(a) * 0.09, hy - 0.08 + Math.sin(a) * 0.09, zl + 0.08 + 0.03 * Math.max(0, -Math.sin(a))]);
      }
      tube(b, ring, () => 0.014, scaleRgb(iron, 1.2), { sides: 5 });
    });
  }
  // Surround.
  if ((o.surround ?? 'stone') === 'stone') {
    if (shape === 'arched') stoneArch(site, { u, v: spring, r, v0 });
    else {
      // Jamb stones (alternating long and short) and a big lintel.
      for (const side of [-1, 1]) {
        let y = v0;
        let k = 0;
        while (y < v1 - 0.05) {
          const hh = Math.min(v1 - y, site.s.nextRange(0.36, 0.5));
          const wide = k % 2 === 0 ? 0.42 : 0.3;
          stoneBlock(site, [u + side * (w / 2 + wide / 2), y + 0.01, 0.06], [wide, hh - 0.025, 0.24], { bevel: 0.04, jitter: 0.015 });
          y += hh;
          k++;
        }
      }
      stoneBlock(site, [u, v1 + 0.01, 0.07], [w + 0.95, 0.42, 0.27], { bevel: 0.05, jitter: 0.02 });
    }
  } else {
    const t = 0.24;
    timber(site, [u0 - t / 2, v0 - 0.1, 0.05], [u0 - t / 2, spring + 0.05, 0.05], { width: t, depth: 0.2, sag: 0, color: pal.timberDark });
    timber(site, [u1 + t / 2, v0 - 0.1, 0.05], [u1 + t / 2, spring + 0.05, 0.05], { width: t, depth: 0.2, sag: 0, color: pal.timberDark });
    if (shape === 'arched') {
      const R = r + t / 2;
      curvedTimber(site, [u - R, spring, 0.05], [u - R, spring + R * 1.05, 0.05], [u + 0.02, spring + R, 0.05], { width: 0.2, depth: t, color: pal.timberDark, up: [0, 0, 1] });
      curvedTimber(site, [u + R, spring, 0.05], [u + R, spring + R * 1.05, 0.05], [u - 0.02, spring + R, 0.05], { width: 0.2, depth: t, color: pal.timberDark, up: [0, 0, 1] });
    } else timber(site, [u0 - t, v1 + t / 2, 0.06], [u1 + t, v1 + t / 2, 0.06], { width: t, depth: 0.22, sag: 0.01, color: pal.timberDark });
  }
  if (o.steps && o.steps > 0.05) {
    site.at(compose34([0, -o.steps + v0, 0]), (s2) => stoneSteps(s2, { u, width: w + 0.7, top: o.steps! }));
  }
}
