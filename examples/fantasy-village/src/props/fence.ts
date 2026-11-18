// Fences from layout.fences: rough rail fences of crooked posts with two (sometimes three) sagging rails that overhang
// the posts, different heights, a broken rail here and there; garden picket fences with pointed pickets between
// rails; a gate in every gap left in a fence line (hinged on a thicker post, standing ajar).

import type { BuildContext, MeshBuilder, RGB, SolidDef, Stream, Vec3 } from '../kit/index.ts';
import { MAT, PALETTE, VARY_RICH, bevelBox, compose34, crookedBeam, mixRgb, scaleRgb, segmentSolid, vary } from '../kit/index.ts';
import type { Fence } from '../layout.ts';
import { riverNear, structureDist } from '../layout.ts';
import { PROP, facingFace, lightWoodColor, woodColor } from './common.ts';

export interface FenceStats {
  posts: number;
  rails: number;
  pickets: number;
  gates: number;
}

/**
 * Builds one fence into `b` (world coordinates). With `solids` it also hands over a thin wall per railed span for the
 * walk mode (the open gate and the breaks in buildings or water stay passable).
 */
export function buildFence(ctx: BuildContext, b: MeshBuilder, f: Fence, fi: number, stats: FenceStats, solids?: SolidDef[]): void {
  const s = ctx.stream('props.fence').child(fi);
  const { layout } = ctx;
  // Posts: the layout's points, with extra posts on long garden sides so no rail spans more than ~2 m.
  const pts: [number, number][] = [];
  for (let k = 0; k < f.points.length; k++) {
    const a = f.points[k]!;
    pts.push([a[0], a[1]]);
    const c = f.points[k + 1];
    if (!c) continue;
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const n = Math.ceil(L / (f.kind === 'picket' ? 2.0 : 2.6));
    for (let i = 1; i < n; i++) pts.push([a[0] + ((c[0] - a[0]) * i) / n, a[1] + ((c[1] - a[1]) * i) / n]);
  }
  // Drop posts that would stand in a building or in the water (the fence breaks there).
  const ok = pts.map(([x, z]) => structureDist(layout.structures, x, z) > 0.3 && riverNear(layout.river, x, z).dist > riverNear(layout.river, x, z).at.width / 2 + 0.3);
  const tops: Vec3[] = [];
  const picket = f.kind === 'picket';
  // A gate in the gap between the last and the first point (garden fences and the yard leave one).
  let hasGate = false;
  if (!f.closed && f.points.length > 2) {
    const a = f.points[f.points.length - 1]!, c = f.points[0]!;
    const gap = Math.hypot(c[0] - a[0], c[1] - a[1]);
    hasGate = gap > 0.8 && gap < 3.6 && ok[0]! && ok[pts.length - 1]!;
  }
  pts.forEach(([x, z], k) => {
    if (!ok[k]) {
      tops.push([x, 0, z]);
      return;
    }
    const y = ctx.heightAt(x, z);
    const gatePost = hasGate && (k === 0 || k === pts.length - 1);
    const h = (picket ? s.range(0.95, 1.1, k, 1) : s.range(1.0, 1.38, k, 1)) + (gatePost ? 0.3 : 0);
    const lean: [number, number] = [s.jitter(0.07, k, 2), s.jitter(0.07, k, 3)];
    const c = woodColor(s, k, 4);
    b.withFlags({ cls: MAT.wood }, () => {
      crookedBeam(b, [x, y - 0.35, z], [x + lean[0], y + h, z + lean[1]], (p) => scaleRgb(c, 0.7 + 0.35 * Math.min(1, Math.max(0, (p[1] - y) / h))), {
        width: gatePost ? 0.27 : picket ? s.range(0.15, 0.19, k, 5) : s.range(0.19, 0.26, k, 5), wobble: 0.025, twist: s.jitter(0.25, k, 6), irregular: 0.14, stream: s.child(k), segments: 3,
        // The sawn top shows light, weathered end grain.
        endPaint: mixRgb(scaleRgb(c, 1.25), PROP.endGrain, 0.4),
      });
    });
    stats.posts++;
    tops.push([x + lean[0] * 0.5, y, z + lean[1] * 0.5]);
  });
  // Rails (and pickets) between neighbouring posts.
  for (let k = 0; k + 1 < pts.length; k++) {
    if (!ok[k] || !ok[k + 1]) continue;
    const A = tops[k]!, B = tops[k + 1]!;
    const dx = B[0] - A[0], dz = B[2] - A[2];
    const L = Math.hypot(dx, dz);
    if (L < 0.2) continue;
    if (solids) {
      const sd = segmentSolid('fence', A[0], A[2], B[0], B[2], 0.24, Math.min(A[1], B[1]) - 0.5, Math.max(A[1], B[1]) + 1.15, { standable: false });
      if (sd) solids.push(sd);
    }
    const ux = dx / L, uz = dz / L;
    const heights = picket ? [0.32, 0.78] : s.chance(0.18, k, 20) ? [0.35, 0.68, 1.0] : [0.42, 0.88];
    heights.forEach((hh, r) => {
      const c = lightWoodColor(s, k, r, 21);
      const over = s.range(0.08, 0.22, k, r, 22);
      // Now and then a lower rail has come loose at one end and hangs down.
      const broken = !picket && r === 0 && s.chance(0.07, k, 25);
      const ya = A[1] + hh + s.jitter(0.05, k, r, 23), yb = broken ? B[1] + 0.12 : B[1] + hh + s.jitter(0.05, k, r, 24);
      // A missing upper rail now and then.
      if (!picket && r === heights.length - 1 && s.chance(0.06, k, 26)) return;
      const side = (r % 2 ? 1 : -1) * (picket ? 0.1 : 0.13);
      const ox = -uz * side, oz = ux * side;
      b.withFlags({ cls: MAT.wood }, () =>
        crookedBeam(b, [A[0] - ux * over + ox, ya, A[2] - uz * over + oz], [B[0] + ux * (broken ? -0.2 : over) + ox, yb, B[2] + uz * (broken ? -0.2 : over) + oz], c, {
          width: picket ? 0.07 : s.range(0.09, 0.13, k, r, 27), depth: picket ? 0.08 : s.range(0.11, 0.15, k, r, 28), sag: picket ? 0.01 : s.range(0.02, 0.06, k, r, 29),
          wobble: 0.02, twist: s.jitter(0.3, k, r, 30), irregular: 0.12, stream: s.child(1000 + k * 4 + r),
        }),
      );
      stats.rails++;
    });
    if (picket) {
      // Pickets on the outer side of the rails, pointed tops, slightly uneven.
      const n = Math.max(1, Math.floor(L / 0.24));
      const yaw = Math.atan2(ux, uz);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const x = A[0] + dx * t - uz * 0.16, z = A[2] + dz * t + ux * 0.16;
        const y = ctx.heightAt(x, z) - 0.08;
        const ph = s.range(0.88, 1.05, k, i, 40);
        const c = vary(s.chance(0.5, k, i, 41) ? PALETTE.timberLight : PALETTE.plank, VARY_RICH, s, k, i, 42);
        b.withFlags({ cls: MAT.wood }, () =>
          b.with(compose34([x, y, z], yaw + Math.PI / 2, s.jitter(0.05, k, i, 43), s.jitter(0.06, k, i, 44)), () => {
            picketBoard(b, 0.11, 0.035, ph, c);
          }),
        );
        stats.pickets++;
      }
    }
  }
  if (hasGate) gate(ctx, b, s, f.points[f.points.length - 1]!, f.points[0]!, picket, stats);
}

/** A gate hung on the thick end post at `a`, latching toward the post at `c`, standing ajar. */
function gate(ctx: BuildContext, b: MeshBuilder, s: Stream, a: readonly [number, number], c: readonly [number, number], picket: boolean, stats: FenceStats): void {
  const dx = c[0] - a[0], dz = c[1] - a[1];
  const gap = Math.hypot(dx, dz);
  const w = Math.min(gap - 0.25, 1.25);
  const y = ctx.heightAt(a[0], a[1]);
  const along = Math.atan2(dx, dz);
  // Swung open inward by 20–45°.
  const open = s.range(0.35, 0.8, 1);
  const wood: RGB = lightWoodColor(s, 50);
  const h = picket ? 0.95 : 1.05;
  // The leaf, in its own frame: x along the gate from the hinge, y up.
  const m = compose34([a[0], y + 0.06, a[1]], along - Math.PI / 2 + open);
  b.withFlags({ cls: MAT.wood }, () =>
    b.with(m, () => {
      const x0 = 0.16, x1 = 0.16 + w;
      crookedBeam(b, [x0, 0.15, 0], [x1, 0.15, 0], wood, { width: 0.08, depth: 0.11, segments: 3 });
      crookedBeam(b, [x0, h - 0.18, 0], [x1, h - 0.18, 0], wood, { width: 0.08, depth: 0.11, segments: 3 });
      crookedBeam(b, [x0, 0.05, 0], [x0, h - 0.08, 0], scaleRgb(wood, 0.9), { width: 0.1, segments: 3 });
      crookedBeam(b, [x1, 0.05, 0], [x1, h - 0.08, 0], scaleRgb(wood, 0.9), { width: 0.1, segments: 3 });
      // The Z brace.
      crookedBeam(b, [x0 + 0.05, 0.2, 0.05], [x1 - 0.05, h - 0.23, 0.05], scaleRgb(wood, 0.85), { width: 0.08, depth: 0.05, segments: 3, up: [0, 0, 1] });
      // Boards.
      const n = Math.max(3, Math.floor(w / 0.17));
      for (let i = 0; i < n; i++) {
        const x = x0 + 0.06 + ((w - 0.12) * (i + 0.5)) / n;
        const ph = h - 0.1 + s.jitter(0.04, i, 52);
        bevelBox(b, [x, 0.0, -0.06], [(w - 0.12) / n - 0.025, ph, 0.03], vary(wood, VARY_RICH, s, i, 53), { bevel: 0.01, taper: [1, 1] });
      }
      // Iron hinges and a latch.
      b.withFlags({ cls: MAT.metal }, () => {
        for (const hy of [0.15, h - 0.18]) bevelBox(b, [x0 + 0.12, hy - 0.03, 0.065], [0.3, 0.05, 0.015], PALETTE.iron, { bevel: 0.005 });
        bevelBox(b, [x1 - 0.06, h * 0.55, 0.07], [0.14, 0.04, 0.03], PALETTE.ironLight, { bevel: 0.005 });
      });
    }),
  );
  stats.gates++;
}

/**
 * One pointed picket board (thin and many: a sharp prism of 14 triangles rather than a bevelled box), standing on
 * the origin, width along x, thickness along z, darker toward the ground.
 */
function picketBoard(b: MeshBuilder, w: number, d: number, h: number, c: RGB): void {
  const s = h - 0.1, x = w / 2, z = d / 2;
  const shade = (y: number): RGB => scaleRgb(c, 0.72 + 0.36 * Math.min(1, y / h));
  for (const sz of [-1, 1]) {
    const pts: Vec3[] = [[-x, 0, sz * z], [x, 0, sz * z], [x, s, sz * z], [0, h, sz * z], [-x, s, sz * z]];
    facingFace(b, pts, [0, 0, sz], pts.map((p) => shade(p[1])));
  }
  for (const sx of [-1, 1]) {
    const side: Vec3[] = [[sx * x, 0, -z], [sx * x, 0, z], [sx * x, s, z], [sx * x, s, -z]];
    facingFace(b, side, [sx, 0, 0], side.map((p) => scaleRgb(shade(p[1]), 0.9)));
    const slope: Vec3[] = [[sx * x, s, -z], [sx * x, s, z], [0, h, z], [0, h, -z]];
    facingFace(b, slope, [sx, 1, 0], slope.map((p) => scaleRgb(shade(p[1]), 1.08)));
  }
}
