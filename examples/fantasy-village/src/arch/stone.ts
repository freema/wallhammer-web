// Stonework of the architecture kit: plinths of big irregular blocks in courses (asymmetric: stepped piers rise
// where asked), buttresses, chimneys of stacked stones with a cap and pots, stone steps and arch surrounds.
// Blocks are bevelled boxes with jittered corners, a slight taper and a colour of their own; nothing is a clean box.

import type { RGB, Vec2 } from '../kit/index.ts';
import { MAT, bevelBox, clamp, compose34, lathe, lerp, mixRgb } from '../kit/index.ts';
import type { Site } from './site.ts';
import { stonePaint, wallFrame } from './site.ts';

/** A colour for one block: the base varied, sometimes warm or dark. */
export function blockColor(site: Site, base?: RGB): RGB {
  const p = site.pal;
  const r = site.s.next();
  const c = base ?? (r < 0.18 ? p.stoneWarm : r < 0.3 ? p.stoneDark : r < 0.42 ? mixRgb(p.stone, p.stoneWarm, 0.5) : p.stone);
  return site.tone(c, { hue: 0.02, sat: 0.14, val: 0.12 });
}

export interface BlockOptions {
  bevel?: number;
  jitter?: number;
  taper?: number;
  color?: RGB;
}

/** One stone block of `size` (x, y, z) standing at `at` (bottom centre), painted and jittered. */
export function stoneBlock(site: Site, at: readonly number[], size: readonly number[], o: BlockOptions = {}): void {
  const c = o.color ?? blockColor(site);
  const s = site.s;
  site.b.withFlags({ cls: MAT.stone }, () =>
    bevelBox(site.b, at, size, stonePaint(c, (s.next() * 1e6) | 0), {
      bevel: o.bevel ?? clamp(Math.min(size[0]!, size[1]!, size[2]!) * 0.16, 0.03, 0.11),
      jitter: o.jitter ?? 0.03,
      stream: s,
      taper: o.taper ?? s.nextRange(0.94, 0.99),
      edgeLight: 1.16,
    }),
  );
}

export interface PlinthOptions {
  /** Closed outline (local x, z) in wall order (see `rectWalls`): the outer face of the wall above. */
  ring: readonly Vec2[];
  /** Top of the plinth (local y): the bed of the wall above. */
  top: number;
  /** How far it reaches below y = 0 into the ground (default 0.45). */
  below?: number;
  /** Thickness of the blocks (default 0.62). */
  depth?: number;
  /** How far the blocks stand out of the wall line (default 0.14). */
  proud?: number;
  /** Course heights and block lengths, ranges in metres (defaults [0.38, 0.56] and [0.6, 1.05]: B2). */
  course?: readonly [number, number];
  block?: readonly [number, number];
  /** Where the stonework rises higher (asymmetric piers): edge index, range along the edge and the top height. */
  rises?: readonly { edge: number; u0: number; u1: number; top: number }[];
  /** Gaps on an edge (e.g. where another building joins), from u0 to u1, full height. */
  gaps?: readonly { edge: number; u0: number; u1: number }[];
  /** Edges to leave out entirely (hidden inside another body). */
  skipEdges?: readonly number[];
}

/**
 * A plinth of big irregular blocks along a closed outline, course by course, with staggered joints and alternating
 * corner stones (quoins), blocks standing out by varying amounts. Rises add stepped piers above the top.
 */
export function stonePlinth(site: Site, o: PlinthOptions): void {
  const below = o.below ?? 0.45;
  const depth = o.depth ?? 0.62;
  const proud = o.proud ?? 0.14;
  const [c0, c1] = o.course ?? [0.38, 0.56];
  const [l0, l1] = o.block ?? [0.6, 1.05];
  const n = o.ring.length;
  const total = o.top + below;
  const courses = Math.max(1, Math.round(total / ((c0 + c1) / 2)));
  // Course boundaries (shared by every edge so corners line up), jittered.
  const ys: number[] = [-below];
  for (let k = 1; k < courses; k++) ys.push(-below + (total * k) / courses + site.s.nextJitter(0.05));
  ys.push(o.top);
  for (let e = 0; e < n; e++) {
    if (o.skipEdges?.includes(e)) continue;
    const wall = wallFrame(o.ring[e]!, o.ring[(e + 1) % n]!, 0);
    const gaps = (o.gaps ?? []).filter((g) => g.edge === e);
    site.onWall(wall, (w) => {
      const course = (k: number, y0: number, y1: number, from: number, to: number, long0: boolean, long1: boolean): void => {
        const start = from - (long0 ? proud : proud - depth);
        const end = to + (long1 ? proud : proud - depth);
        let u = start;
        // Stagger: odd courses start with a half block.
        let first = k % 2 === 1 ? w.s.nextRange(l0 * 0.45, l0 * 0.8) : w.s.nextRange(l0, l1);
        while (u < end - 0.05) {
          let len = first;
          first = w.s.nextRange(l0, l1);
          if (end - (u + len) < l0 * 0.5) len = end - u;
          const uc = u + len / 2;
          u += len;
          if (gaps.some((g) => uc > g.u0 && uc < g.u1)) continue;
          const d = depth * w.s.nextRange(0.85, 1.05);
          const out = proud + w.s.nextJitter(0.05);
          stoneBlock(w, [uc, y0 + 0.012, out - d / 2], [len - 0.035, y1 - y0 - 0.025, d]);
        }
      };
      for (let k = 0; k < courses; k++) {
        const long = (k + e) % 2 === 0;
        course(k, ys[k]!, ys[k + 1]!, 0, wall.length, long, long);
      }
      // Rises: further courses over a range of the edge.
      for (const r of (o.rises ?? []).filter((q) => q.edge === e)) {
        const extra = Math.max(1, Math.round((r.top - o.top) / ((c0 + c1) / 2)));
        let y = o.top;
        for (let k = 0; k < extra; k++) {
          const y1 = k === extra - 1 ? r.top : y + (r.top - o.top) / extra + w.s.nextJitter(0.04);
          const atStart = r.u0 <= 0.01, atEnd = r.u1 >= wall.length - 0.01;
          const long = (k + courses + e) % 2 === 0;
          course(k + courses, y, y1, Math.max(0, r.u0), Math.min(wall.length, r.u1), atStart ? long : true, atEnd ? long : true);
          y = y1;
        }
      }
    });
  }
}

export interface ButtressOptions {
  /** Foot on the wall line (local x, z) and the outward heading of the buttress (yaw, 0 = +z). */
  x: number;
  z: number;
  yaw: number;
  /** Width along the wall, height and depth out of the wall at the foot (defaults 0.95, 2.2, 1.2). */
  width?: number;
  height?: number;
  depth?: number;
  /** Depth into the ground (default 0.4). */
  below?: number;
}

/** A stepped stone buttress: courses getting shallower upward, topped by a sloping wedge stone. */
export function buttress(site: Site, o: ButtressOptions): void {
  const width = o.width ?? 0.95, height = o.height ?? 2.2, depth = o.depth ?? 1.2, below = o.below ?? 0.4;
  site.at(compose34([o.x, 0, o.z], o.yaw), (w) => {
    const n = Math.max(3, Math.round((height + below) / 0.48));
    let y = -below;
    for (let k = 0; k < n; k++) {
      const h = (height + below) / n + w.s.nextJitter(0.04);
      const f = k / (n - 1);
      const d = lerp(depth, depth * 0.42, f * f);
      const wd = width * lerp(1.04, 0.92, f) + w.s.nextJitter(0.04);
      // Two stones side by side on alternate courses, one wide stone on the others.
      if (k % 2 === 0 && wd > 0.8) {
        const split = w.s.nextRange(0.4, 0.6);
        stoneBlock(w, [-wd / 2 + (wd * split) / 2, y, d / 2 - 0.2], [wd * split - 0.03, h - 0.03, d]);
        stoneBlock(w, [wd / 2 - (wd * (1 - split)) / 2, y, d / 2 - 0.2], [wd * (1 - split) - 0.03, h - 0.03, d]);
      } else stoneBlock(w, [0, y, d / 2 - 0.2], [wd, h - 0.03, d]);
      y += h;
    }
    // Sloping cap: a wedge that runs from the front edge up to the wall.
    const d = depth * 0.42;
    w.b.withFlags({ cls: MAT.stone }, () =>
      bevelBox(w.b, [0, y - 0.02, d / 2 - 0.2], [width * 0.98, 0.55, d + 0.06], stonePaint(blockColor(w), 7), {
        bevel: 0.06,
        taper: [1.0, 0.2],
        lean: [0, -(d + 0.06) * 0.4],
        edgeLight: 1.2,
      }),
    );
  });
}

export interface ChimneyOptions {
  /** Centre of the shaft (local x, z), its foot and top heights. */
  x: number;
  z: number;
  y0: number;
  y1: number;
  /** Shaft size (along x, z) at the foot; the shaft narrows by `taper` (share) to the top (default 0.88). */
  w?: number;
  d?: number;
  taper?: number;
  /** Turn of the shaft about y. */
  yaw?: number;
  /** Chimney pots on the cap (default 1). */
  pots?: number;
  /** Emit smoke from the pots (default true). */
  smoke?: boolean | Partial<Omit<import('../kit/index.ts').ParticleSource, 'position'>>;
  /** A wider lower stack (a chimney breast outside a gable): height of the wide part and its extra width. */
  breast?: { height: number; extra: number };
}

/**
 * A chimney of stacked stones: courses of blocks around a hollow shaft with alternating corners, narrowing upward,
 * a projecting cap course, a dark flue and clay pots. Returns the local top point (where the smoke starts).
 */
export function stoneChimney(site: Site, o: ChimneyOptions): readonly [number, number, number] {
  const W = o.w ?? 1.2, D = o.d ?? 1.0, taper = o.taper ?? 0.88;
  let top: [number, number, number] = [o.x, o.y1, o.z];
  site.at(compose34([o.x, 0, o.z], o.yaw ?? 0), (c) => {
    const ring = (y: number, h: number, w: number, d: number, k: number): void => {
      const t = Math.min(0.38, Math.min(w, d) * 0.34);
      const alt = k % 2 === 0;
      // Front and back faces: full width on even courses, inner on odd; the sides the other way.
      const fw = alt ? w : w - 2 * t, sd = alt ? d - 2 * t : d;
      for (const sz of [-1, 1]) {
        const parts = fw > 1.15 ? 2 : 1;
        const split = parts === 2 ? c.s.nextRange(0.38, 0.62) : 1;
        let x = -fw / 2;
        for (let p = 0; p < parts; p++) {
          const len = p === 0 ? fw * split : fw * (1 - split);
          stoneBlock(c, [x + len / 2, y, sz * (d / 2 - t / 2) + c.s.nextJitter(0.025)], [len - 0.03, h - 0.025, t + c.s.nextJitter(0.03)]);
          x += len;
        }
      }
      for (const sx of [-1, 1]) {
        stoneBlock(c, [sx * (w / 2 - t / 2) + c.s.nextJitter(0.025), y, 0], [t + c.s.nextJitter(0.03), h - 0.025, sd - 0.03]);
      }
    };
    let y = o.y0;
    let k = 0;
    // Chimney breast: a wider stack below.
    if (o.breast) {
      const hb = o.breast.height;
      const n = Math.max(1, Math.round((hb - o.y0) / 0.52));
      for (; k < n; k++) {
        const h = (hb - o.y0) / n;
        ring(y, h, W + o.breast.extra, D + o.breast.extra * 0.5, k);
        y += h;
      }
      // Sloping weathering stones from the breast to the shaft.
      c.b.withFlags({ cls: MAT.stone }, () =>
        bevelBox(c.b, [0, y, 0], [W + o.breast!.extra, 0.42, D + o.breast!.extra * 0.5], stonePaint(blockColor(c), 11), { bevel: 0.07, taper: [W / (W + o.breast!.extra), D / (D + o.breast!.extra * 0.5)], edgeLight: 1.2 }),
      );
      y += 0.42;
    }
    const capY = o.y1 - 0.3;
    const n = Math.max(2, Math.round((capY - y) / 0.5));
    const y0 = y;
    for (let j = 0; j < n; j++, k++) {
      const f = j / n;
      const h = (capY - y0) / n;
      const s = lerp(1, taper, f);
      ring(y, h, W * s, D * s, k);
      y += h;
    }
    // Cap course: a projecting slab of two stones, and a thinner second slab.
    const wt = W * taper, dt = D * taper;
    stoneBlock(c, [-(wt + 0.22) / 4, capY, 0], [(wt + 0.22) / 2 - 0.02, 0.18, dt + 0.22]);
    stoneBlock(c, [(wt + 0.22) / 4, capY, 0], [(wt + 0.22) / 2 - 0.02, 0.18, dt + 0.22]);
    stoneBlock(c, [0, capY + 0.18, 0], [wt + 0.02, 0.12, dt + 0.02], { bevel: 0.04 });
    // Dark flue inside the top.
    c.b.withFlags({ cls: MAT.stone }, () => bevelBox(c.b, [0, capY + 0.2, 0], [wt - 0.36, 0.12, dt - 0.36], [0.08, 0.07, 0.07], { bevel: 0.02 }));
    // Pots.
    const pots = o.pots ?? 1;
    let topY = capY + 0.3;
    for (let p = 0; p < pots; p++) {
      const px = pots === 1 ? 0 : (p / (pots - 1) - 0.5) * wt * 0.5;
      const h = c.s.nextRange(0.42, 0.6);
      const r = c.s.nextRange(0.15, 0.19);
      const clay = c.tone([0.62, 0.36, 0.24]);
      c.b.withFlags({ cls: MAT.stone }, () => {
        lathe(c.b, [px, capY + 0.28, 0], [[r * 1.15, 0], [r, 0.08], [r * 0.9, h * 0.7], [r * 1.12, h * 0.85], [r * 1.1, h]], (_p, n) => [clay[0] * (0.9 + 0.15 * n[1]), clay[1] * (0.9 + 0.15 * n[1]), clay[2] * (0.9 + 0.15 * n[1])], { segments: 10, phase: c.s.next() });
        lathe(c.b, [px, capY + 0.28, 0], [[r * 1.1, h], [r * 0.8, h], [r * 0.75, h - 0.15]], [0.1, 0.07, 0.06], { segments: 10 });
      });
      topY = Math.max(topY, capY + 0.28 + h);
      if (p === 0) top = [o.x + px, topY, o.z];
    }
    if (o.smoke !== false) {
      const extra = typeof o.smoke === 'object' ? o.smoke : {};
      c.emit([pots === 1 ? 0 : -wt * 0.25, topY + 0.05, 0], {
        kind: 'smoke',
        count: 34,
        life: 7,
        size: [0.55, 2.8],
        rise: 0.85,
        spread: [0.18, 0.22],
        wind: 1,
        colorStart: [0.42, 0.4, 0.42, 0.6],
        colorEnd: [0.72, 0.7, 0.74, 0],
        ...extra,
      });
    }
  });
  return top;
}

export interface StepsOptions {
  /** Centre along the wall, width of the flight, threshold height (v of the top step). */
  u: number;
  width: number;
  top: number;
  /** Number of steps below the threshold landing (default from the height, about 0.24 m each). */
  count?: number;
  /** Tread depth (default 0.42) and the landing depth in front of the door (default 0.55). */
  run?: number;
  landing?: number;
}

/** Stone steps in front of a door, in a wall frame: a landing at the threshold and steps down to the ground. */
export function stoneSteps(site: Site, o: StepsOptions): void {
  const n = o.count ?? Math.max(1, Math.round(o.top / 0.24));
  const rise = o.top / (n + 0.0001);
  const run = o.run ?? 0.42;
  const landing = o.landing ?? 0.55;
  let w0 = -0.15;
  for (let k = 0; k <= n; k++) {
    const topY = o.top - k * rise;
    const d = k === 0 ? landing + 0.15 : run;
    const width = o.width + k * 0.14 + site.s.nextJitter(0.06);
    // Two slabs side by side on wide steps.
    const split = width > 1.5 ? site.s.nextRange(0.42, 0.58) : 1;
    const uc = o.u + site.s.nextJitter(0.04);
    if (split < 1) {
      stoneBlock(site, [uc - width / 2 + (width * split) / 2, -0.35, w0 + d / 2], [width * split - 0.03, topY + 0.35, d], { bevel: 0.05 });
      stoneBlock(site, [uc + width / 2 - (width * (1 - split)) / 2, -0.35, w0 + d / 2], [width * (1 - split) - 0.03, topY + 0.35, d], { bevel: 0.05 });
    } else stoneBlock(site, [uc, -0.35, w0 + d / 2], [width, topY + 0.35, d], { bevel: 0.05 });
    w0 += d;
  }
}

/**
 * A round arch of wedge stones (voussoirs) in the plane w = 0 of a wall frame, around a semicircle of radius `r`
 * centred at (u, v), with a bigger keystone, plus jamb stones down to `v0` on both sides.
 */
export function stoneArch(site: Site, o: { u: number; v: number; r: number; v0: number; thick?: number; depth?: number; stones?: number }): void {
  const thick = o.thick ?? 0.34, depth = o.depth ?? 0.24;
  const n = o.stones ?? Math.max(5, Math.round((Math.PI * (o.r + thick / 2)) / 0.42)) | 1;
  for (let k = 0; k < n; k++) {
    const a0 = Math.PI - (k / n) * Math.PI, a1 = Math.PI - ((k + 1) / n) * Math.PI;
    const am = (a0 + a1) / 2;
    const key = k === (n - 1) / 2;
    const t = key ? thick * 1.3 : thick * site.s.nextRange(0.92, 1.1);
    const rm = o.r + t / 2;
    const len = (a0 - a1) * rm - 0.03;
    // The frame's x runs along the arch, y outward from the centre; the stone's bottom lies on the opening's edge.
    site.at(compose34([o.u + Math.cos(am) * o.r, o.v + Math.sin(am) * o.r, 0], 0, 0, am - Math.PI / 2), (w) =>
      stoneBlock(w, [0, 0, depth / 2 - 0.06 + (key ? 0.04 : 0)], [len, t, depth + (key ? 0.08 : 0)], { bevel: 0.04, jitter: 0.015, taper: 1.08 }),
    );
  }
  // Jambs: alternating long and short stones.
  for (const side of [-1, 1]) {
    let v = o.v0;
    let k = 0;
    while (v < o.v - 0.05) {
      const h = Math.min(o.v - v, site.s.nextRange(0.36, 0.5));
      const wide = k % 2 === 0 ? thick * 1.25 : thick * 0.9;
      stoneBlock(site, [o.u + side * (o.r + wide / 2), v + 0.01, depth / 2 - 0.06], [wide, h - 0.025, depth], { bevel: 0.04, jitter: 0.015 });
      v += h;
      k++;
    }
  }
}
