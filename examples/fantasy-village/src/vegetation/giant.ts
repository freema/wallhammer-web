// The giant twisted broadleaf trees of the concept (B2): a thick trunk twisted with bark ridges as geometry, a
// buttressed foot running out into visible roots that follow the ground, a few strong limbs, and a huge crown of
// many leaf clusters of different sizes, dark below and sunlit above. Every giant has its own shape from its seed
// (static mesh, merged into the chunks), and keeps its limbs and leaves out of the buildings next to it.

import type { Stream, Vec3 } from '../kit/index.ts';
import { MAT, MeshBuilder, add3, bakeAo, clamp, groundAo, hex, lerp, norm3, scale3, smoothstep, sub3 } from '../kit/index.ts';
import { barkTube, bezier, leaf } from './common.ts';
import { IVY, OAK, leafCluster } from './foliage.ts';

export interface GiantInput {
  x: number;
  z: number;
  /** Scale against the typical giant (0.9–1.2). */
  scale: number;
  stream: Stream;
  heightAt(x: number, z: number): number;
  /** Moves a point with a radius out of every building (horizontally), unless it is above the roof. */
  clear(p: Vec3, r: number): Vec3;
  /** How far a root may run from (x, z) in direction (dx, dz), up to `want` metres (stops before walls, water, streets). */
  rootRoom(x: number, z: number, dx: number, dz: number, want: number): number;
  /** Unit horizontal direction away from the nearest building (0, 0 when none is near). */
  away: [number, number];
  /** Wrap the trunk in ivy. */
  ivy: boolean;
}

const BARK = hex('#5c3a24');
const BARK_LIGHT = hex('#a0704a');

/**
 * The ground height sampled once on a grid round (x, z) and interpolated: the height field is costly per call and
 * the ambient occlusion and the roots ask for it hundreds of thousands of times. Outside the grid it falls back.
 */
function cachedHeight(h: (x: number, z: number) => number, cx: number, cz: number, half: number, cell: number): (x: number, z: number) => number {
  const n = Math.ceil((2 * half) / cell) + 1;
  const x0 = cx - half, z0 = cz - half;
  const grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) grid[j * n + i] = h(x0 + i * cell, z0 + j * cell);
  return (x, z) => {
    const fx = (x - x0) / cell, fz = (z - z0) / cell;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= n - 1 || j >= n - 1) return h(x, z);
    const u = fx - i, v = fz - j;
    const a = grid[j * n + i]!, b = grid[j * n + i + 1]!, c = grid[(j + 1) * n + i]!, d = grid[(j + 1) * n + i + 1]!;
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

/** Builds one giant tree in world coordinates. */
export function giantTree(gIn: GiantInput): MeshBuilder {
  const g: GiantInput = { ...gIn, heightAt: cachedHeight(gIn.heightAt, gIn.x, gIn.z, 17, 0.4) };
  const b = new MeshBuilder();
  const s = g.stream;
  const sc = g.scale;
  const y0 = g.heightAt(g.x, g.z);
  let yMin = y0;
  for (let k = 0; k < 8; k++) yMin = Math.min(yMin, g.heightAt(g.x + Math.sin(k * 0.785) * 2.6 * sc, g.z + Math.cos(k * 0.785) * 2.6 * sc));
  const R0 = s.range(1.15, 1.35) * sc;
  const forkH = s.range(6.4, 7.6) * sc;
  // Lean: partly random, partly away from the nearest building.
  const la = s.range(0, Math.PI * 2);
  const leanAmt = s.range(0.7, 1.5) * sc;
  const lean = norm3([Math.sin(la) * 0.6 + g.away[0] * 1.2, 0, Math.cos(la) * 0.6 + g.away[1] * 1.2]);
  const side = norm3([-lean[2], 0, lean[0]]);
  const wig = s.range(0.4, 0.8) * sc * s.sign(1);
  const base: Vec3 = [g.x, yMin - 0.8, g.z];
  const top: Vec3 = [g.x + lean[0] * leanAmt, y0 + forkH + 0.9 * sc, g.z + lean[2] * leanAmt];
  const trunk = bezier(
    base,
    add3([g.x, y0 + forkH * 0.38, g.z], scale3(side, wig)),
    add3(add3([g.x, y0 + forkH * 0.72, g.z], scale3(side, -wig * 0.7)), scale3(lean, leanAmt * 0.45)),
    top,
    22,
  );
  const lobes = s.int(6, 8);
  const lobePhase = s.range(0, Math.PI * 2);
  const twistSign = s.sign(2);
  const groundShare = (y0 - base[1]) / (top[1] - base[1]);
  const trunkR = (f: number): number => {
    const above = Math.max(0, f - groundShare) / (1 - groundShare);
    return R0 * lerp(1.0, 0.62, Math.pow(above, 0.8)) * (1 + 0.55 * (1 - smoothstep(0, 0.16, above)));
  };
  b.set({ cls: MAT.bark, sway: 0, glow: 0 });
  barkTube(b, trunk, {
    sides: 30,
    radius: trunkR,
    ridges: 15,
    ridgeDepth: 0.1,
    twist: 1.5 * twistSign,
    flare: (f, a) => {
      const above = Math.max(0, f - groundShare) / (1 - groundShare);
      const lobe = Math.pow(0.5 + 0.5 * Math.cos(lobes * (a - lobePhase)), 3);
      return 0.75 * lobe * (1 - smoothstep(0, 0.3, above));
    },
    bark: BARK,
    barkLight: BARK_LIGHT,
    moss: 0.75,
    foot: groundShare + 0.1,
    seed: Math.floor(s.next() * 1e6),
  });

  // Roots: out of the buttress lobes, arching down into the ground and following it.
  for (let k = 0; k < lobes; k++) {
    const a = lobePhase + (k / lobes) * Math.PI * 2;
    const dx = Math.sin(a), dz = Math.cos(a);
    const want = s.range(3.6, 6.2) * sc;
    const L = g.rootRoom(g.x, g.z, dx, dz, want);
    if (L < R0 * 1.6) continue;
    const pts: Vec3[] = [];
    const ph = s.range(0, 6);
    const rr = R0 * s.range(0.42, 0.55);
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const d = lerp(R0 * 0.45, L, Math.pow(t, 0.85));
      const w = Math.sin(t * Math.PI * 1.4 + ph) * 0.45 * t * sc;
      const px = g.x + dx * d - dz * w, pz = g.z + dz * d + dx * w;
      const r = lerp(rr, 0.07, Math.pow(t, 0.7));
      const lift = lerp(1.1 * sc, r * 0.15, smoothstep(0, 0.55, t));
      pts.push([px, g.heightAt(px, pz) + lift, pz]);
    }
    barkTube(b, pts, {
      sides: 10,
      radius: (f) => lerp(rr, 0.06, Math.pow(f, 0.7)),
      ridges: 4,
      ridgeDepth: 0.07,
      twist: 0.4,
      bark: BARK,
      barkLight: BARK_LIGHT,
      moss: 0.6,
      foot: 0,
      seed: Math.floor(s.next() * 1e6),
      phase: a,
    });
  }

  // Crown frame.
  const Rh = s.range(7.4, 8.8) * sc;
  const Rv = s.range(4.6, 5.4) * sc;
  // The crown centre stands at a fixed height over the ground (not over the fork), so every giant towers ~19–22 m.
  const C: Vec3 = g.clear(add3([top[0] + g.away[0] * 1.8 * sc, y0 + 12.6 * sc, top[2] + g.away[1] * 1.8 * sc], scale3(lean, 0.6 * sc)), Rh * 0.3);
  const fork = trunk[trunk.length - 3]!;
  const limbCount = s.int(4, 5);
  const az0 = s.range(0, Math.PI * 2);
  interface Limb {
    path: Vec3[];
    r0: number;
    end: Vec3;
  }
  const limbs: Limb[] = [];
  const forkR = trunkR(0.9);
  for (let k = 0; k <= limbCount; k++) {
    const leader = k === limbCount;
    const az = az0 + (k / limbCount) * Math.PI * 2 + s.range(-0.45, 0.45);
    const hd: Vec3 = [Math.sin(az), 0, Math.cos(az)];
    const toward = hd[0] * g.away[0] + hd[2] * g.away[1];
    const reach = s.range(0.55, 0.78) * (toward < -0.4 ? 0.7 : 1);
    let end: Vec3 = leader
      ? add3(C, [s.range(-1, 1) * sc, Rv * 0.55, s.range(-1, 1) * sc])
      : add3(C, [hd[0] * Rh * reach, s.range(-2.4, 1.2) * sc, hd[2] * Rh * reach]);
    end = g.clear(end, 1.2);
    const start = sub3(fork, [0, 0.9 * sc, 0]);
    const p1 = add3(fork, add3([0, 2.0 * sc, 0], scale3(hd, leader ? 0.2 : 0.8 * sc)));
    const p2 = add3(scale3(add3(fork, end), 0.5), [0, leader ? 0.5 : 1.6 * sc, 0]);
    const path = bezier(start, p1, p2, end, 12).map((p) => g.clear(p, 0.6));
    const r0 = forkR * (leader ? 0.62 : s.range(0.5, 0.62));
    limbs.push({ path, r0, end });
    barkTube(b, path, {
      sides: 14,
      radius: (f) => lerp(r0, 0.14 * sc, Math.pow(f, 0.75)),
      ridges: 7,
      ridgeDepth: 0.08,
      twist: 0.9 * twistSign,
      bark: BARK,
      barkLight: BARK_LIGHT,
      foot: 0,
      sway: (f) => 0.08 * f,
      seed: Math.floor(s.next() * 1e6),
      phase: az,
    });
  }

  // Clusters: several round each limb end, a few big inner fillers, a crown on the leader.
  interface Cluster {
    c: Vec3;
    r: Vec3;
    limb: number;
    inner: boolean;
  }
  const clusters: Cluster[] = [];
  limbs.forEach((l, li) => {
    const leader = li === limbs.length - 1;
    const n = leader ? 3 : s.int(4, 6);
    if (leader) {
      // The crown top: a big sunlit cluster right over the leader.
      const rr = s.range(2.8, 3.3) * sc;
      clusters.push({ c: g.clear(add3(l.end, [0, 1.4 * sc, 0]), rr * 0.85), r: [rr * 1.1, rr * 0.78, rr * 1.1], limb: li, inner: false });
    }
    for (let k = 0; k < n; k++) {
      const rr = s.range(2.1, 3.6) * sc * (leader ? 1.05 : 1);
      const off: Vec3 = [s.range(-2.6, 2.6) * sc, s.range(-1.0, 2.2) * sc, s.range(-2.6, 2.6) * sc];
      // Push the outer clusters a little further out, so the crown has lobes, not a ball.
      const out = norm3([l.end[0] - C[0], 0, l.end[2] - C[2]]);
      const c = g.clear(add3(add3(l.end, off), scale3(out, leader ? 0 : 1.2 * sc)), rr * 0.85);
      clusters.push({ c, r: [rr * s.range(0.9, 1.15), rr * s.range(0.68, 0.82), rr * s.range(0.9, 1.15)], limb: li, inner: false });
    }
  });
  for (let k = 0; k < 3; k++) {
    const a = az0 + k * 2.1;
    const rr = s.range(3.2, 3.9) * sc;
    const c = g.clear(add3(C, [Math.sin(a) * Rh * 0.3, s.range(-0.5, 1.2) * sc, Math.cos(a) * Rh * 0.3]), rr * 0.8);
    clusters.push({ c, r: [rr, rr * 0.75, rr], limb: -1, inner: true });
  }
  // Twigs from the limbs into the outer clusters (so no cluster floats).
  for (const cl of clusters) {
    if (cl.inner) continue;
    const l = limbs[cl.limb]!;
    const from = l.path[Math.floor(s.range(0.55, 0.85) * (l.path.length - 1))]!;
    const to = add3(from, scale3(sub3(cl.c, from), 0.85));
    const mid = add3(scale3(add3(from, to), 0.5), [0, 0.7 * sc, 0]);
    const path = bezier(from, mid, mid, to, 6).map((p) => g.clear(p, 0.3));
    barkTube(b, path, {
      sides: 7,
      radius: (f) => lerp(0.24 * sc, 0.05, f),
      ridges: 3,
      ridgeDepth: 0.06,
      twist: 0.3,
      bark: BARK,
      barkLight: BARK_LIGHT,
      foot: 0,
      sway: (f) => 0.1 + 0.25 * f,
      seed: Math.floor(s.next() * 1e6),
    });
  }
  const crownLo = C[1] - Rv, crownHi = C[1] + Rv * 1.2;
  b.set({ cls: MAT.foliage });
  for (const cl of clusters) {
    const t = clamp((cl.c[1] - crownLo) / (crownHi - crownLo), 0, 1);
    const shade = lerp(0.74, 1.1, t) * (cl.inner ? 0.82 : 1);
    leafCluster(b, cl.c, cl.r, OAK, s, { shade });
  }

  if (g.ivy) trunkIvy(b, trunk, trunkR, groundShare, s);

  b.set({ cls: MAT.generic, sway: 0 });
  bakeAo(b, { ground: g.heightAt, rays: 10, reach: 3.2, cell: 0.3, strength: 0.7 });
  groundAo(b, g.heightAt, 1.4, 0.45);
  return b;
}

/** Ivy climbing the trunk in a loose spiral up to the fork: a thin vine with small dark leaves. */
function trunkIvy(b: MeshBuilder, trunk: readonly Vec3[], trunkR: (f: number) => number, from: number, s: Stream): void {
  const turns = s.range(1.1, 1.6);
  const a0 = s.range(0, Math.PI * 2);
  const vine: Vec3[] = [];
  const n = 26;
  for (let i = 0; i <= n; i++) {
    const f = lerp(from, 0.86, i / n);
    const j = f * (trunk.length - 1);
    const j0 = Math.floor(j), j1 = Math.min(trunk.length - 1, j0 + 1);
    const c = add3(scale3(trunk[j0]!, 1 - (j - j0)), scale3(trunk[j1]!, j - j0));
    const a = a0 + (i / n) * turns * Math.PI * 2;
    const r = trunkR(f) * 1.1 + 0.05;
    vine.push([c[0] + Math.sin(a) * r, c[1], c[2] + Math.cos(a) * r]);
  }
  b.set({ cls: MAT.bark, sway: 0 });
  barkTube(b, vine, { sides: 5, radius: () => 0.05, ridges: 0, ridgeDepth: 0, twist: 0, bark: hex('#3a2a1a'), barkLight: hex('#5a4028'), foot: 0, seed: 3 });
  b.set({ cls: MAT.foliage });
  const st = IVY;
  for (let i = 0; i < vine.length - 1; i++) {
    const p = vine[i]!, q = vine[i + 1]!;
    const along = norm3(sub3(q, p));
    for (let k = 0; k < 7; k++) {
      const t = s.next();
      const at = add3(p, scale3(sub3(q, p), t));
      // Out of the trunk: away from the axis at this height.
      const j = Math.min(trunk.length - 1, Math.round(lerp(from, 0.86, (i + t) / n) * (trunk.length - 1)));
      const out = norm3([at[0] - trunk[j]![0], 0, at[2] - trunk[j]![2]]);
      const spread = add3(scale3(along, s.nextJitter(1)), [0, s.nextJitter(0.6), 0]);
      const base = add3(add3(at, scale3(spread, 0.35)), scale3(out, 0.05));
      const tip = norm3(add3(add3(scale3(out, 0.6), [s.nextJitter(1), s.nextRange(-0.8, 0.3), s.nextJitter(1)]), [0, 0, 0]));
      const col = st.mid.map((c, ci) => c * s.nextRange(0.8, 1.15) * (ci === 1 ? 1.02 : 1)) as [number, number, number];
      leaf(b, base, tip, out, st.leafLen * s.nextRange(0.8, 1.3), st.leafWidth, { base: col, tip: st.light, under: st.dark }, [0.05, 0.2], out);
    }
  }
}
