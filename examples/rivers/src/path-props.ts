// What stands and lies along the paths, as real shapes: a pure function of the field, the cover, the path plan, its
// kinds and the seed. The ground's material only shows the trodden earth; everything with a height is built here and
// drawn by the same material as the ground and the trees, so it is lit and shadowed with them:
//   - stones set in the tread: stepping stones a stride apart with a ring of bare soil, laid flags at the places,
//     a pebble now and then in a trodden line;
//   - stone steps where the path climbs, each with a level top, and boulders beside them;
//   - a walk of boards on two beams over damp ground; a footbridge with rails over a narrow water (beams, boards,
//     piles); stepping stones standing on the bed of a wide one, their tops just over its level;
//   - the verge: tufts of grass (ferns under trees), a flower here and there, stones, a fallen trunk in a wood;
//   - a cairn at every named place and a signpost at every junction, its arms along the paths that leave it.
// Every shape is faceted: a face has one normal. Shapes are bucketed by the ground's chunks for culling.

import type { Field } from './field.ts';
import { groundColour, sat, type V3 } from './colours.ts';
import { GROUND_LAYOUT } from './ground-layout.ts';
import { CHUNK_CELLS, LUSH, OVER_MAX_M, UNDER_WOOD, groundHeightAt, putPaths, putVertex, type GroundPiece } from './ground-mesh.ts';
import { FORD_TOP_M, KIND, deckAt, noise1, unit, type Bridge, type PathKinds } from './path-kinds.ts';
import { pathAt, type Path, type PathHit, type PathPlan } from './paths.ts';
import { coverAt, type Cover } from './trees.ts';

type P = [number, number, number];

const STONE_WARM: V3 = [0.37, 0.33, 0.29];
const STONE_COOL: V3 = [0.4, 0.41, 0.4];
const MOSS: V3 = [0.16, 0.26, 0.08];
const SOIL: V3 = [0.2, 0.16, 0.11];
const BOARD: V3 = [0.33, 0.27, 0.2];
const LOG: V3 = [0.25, 0.185, 0.12];
const CUT: V3 = [0.5, 0.4, 0.26];
/** What the tip of a blade of grass is mixed toward. */
const GRASS_TIP: V3 = [0.4, 0.5, 0.16];
const FERN: V3 = [0.1, 0.22, 0.07];
const FLOWERS: V3[] = [
  [0.86, 0.86, 0.8],
  [0.86, 0.68, 0.12],
  [0.52, 0.36, 0.72],
];

/** Half the width the feet keep clear, per kind, metres: nothing of the verge stands nearer to the centreline. */
const CLEAR_M = [0.55, 0.5, 0.78, 0.82, 0.72, 0.7, 0.75];
/** Stride of the stepping stones, depth of a step and of a board with its gap, metres. */
const STRIDE_M = 0.7;
const STEP_DEPTH_M = 0.5;
const BOARD_M = 0.33;

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P, b: P): P => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P, b: P): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mixV = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const TAU = Math.PI * 2;

interface Spot {
  x: number;
  z: number;
  /** Unit tangent, along the path. */
  tx: number;
  tz: number;
  /** The nearest station. */
  i: number;
  /** The station before and the share of the way to the next. */
  lo: number;
  u: number;
}

function lengthsOf(p: Path): Float64Array {
  const cum = new Float64Array(p.n);
  for (let i = 1; i < p.n; i++) cum[i] = cum[i - 1]! + Math.hypot(p.x[i]! - p.x[i - 1]!, p.z[i]! - p.z[i - 1]!);
  return cum;
}

function spotAt(p: Path, cum: Float64Array, s: number, o: Spot): void {
  const n = p.n;
  const at = Math.min(cum[n - 1]!, Math.max(0, s));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m]! <= at) lo = m;
    else hi = m;
  }
  const len = cum[hi]! - cum[lo]!;
  const u = len > 0 ? (at - cum[lo]!) / len : 0;
  o.x = p.x[lo]! + (p.x[hi]! - p.x[lo]!) * u;
  o.z = p.z[lo]! + (p.z[hi]! - p.z[lo]!) * u;
  const tan = (i: number): [number, number] => {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dx = p.x[b]! - p.x[a]!;
    const dz = p.z[b]! - p.z[a]!;
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const ta = tan(lo);
  const tb = tan(hi);
  const tx = ta[0] + (tb[0] - ta[0]) * u;
  const tz = ta[1] + (tb[1] - ta[1]) * u;
  const l = Math.hypot(tx, tz) || 1;
  o.tx = tx / l;
  o.tz = tz / l;
  o.lo = lo;
  o.u = u;
  o.i = u < 0.5 ? lo : hi;
}

/** The shapes along the paths, in chunks of the ground's size, in the ground's vertex layout. */
export function pathProps(f: Field, cover: Cover, pp: PathPlan, kinds: PathKinds, seed: number): GroundPiece[] {
  const size = (f.n - 1) * f.step;
  const chunkM = CHUNK_CELLS * f.step;
  const acrossChunks = Math.ceil(size / chunkM);
  /** Per chunk, ten numbers a vertex: position, normal, colour, and 1 when it lies on the ground and carries its paths. */
  const lists: number[][] = [];

  const gy = (x: number, z: number): number => groundHeightAt(f, x, z);
  const levelAt = (x: number, z: number): number => {
    const i = Math.min(f.n - 1, Math.max(0, Math.round((x - f.x0) / f.step)));
    const j = Math.min(f.n - 1, Math.max(0, Math.round((z - f.z0) / f.step)));
    return f.water[j * f.n + i]!;
  };

  /** One triangle with one normal. With `inside` it is turned to face away from that point. Shades per corner. */
  const tri = (a: P, b: P, c: P, col: V3, sa = 1, sb = sa, sc = sa, inside?: P, normal?: P): void => {
    let n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) return;
    n = [n[0] / l, n[1] / l, n[2] / l];
    if (inside && dot(n, sub(a, inside)) < 0) {
      [b, c] = [c, b];
      [sb, sc] = [sc, sb];
      n = [-n[0], -n[1], -n[2]];
    }
    const m = normal ?? n;
    const ci = Math.min(acrossChunks - 1, Math.max(0, Math.floor((a[2] - f.z0) / chunkM))) * acrossChunks + Math.min(acrossChunks - 1, Math.max(0, Math.floor((a[0] - f.x0) / chunkM)));
    const list = (lists[ci] ??= []);
    list.push(a[0], a[1], a[2], m[0], m[1], m[2], col[0] * sa, col[1] * sa, col[2] * sa, 0);
    list.push(b[0], b[1], b[2], m[0], m[1], m[2], col[0] * sb, col[1] * sb, col[2] * sb, 0);
    list.push(c[0], c[1], c[2], m[0], m[1], m[2], col[0] * sc, col[1] * sc, col[2] * sc, 0);
  };
  /** One triangle with a colour per corner, turned to face away from `inside`. */
  const tri3 = (a: P, b: P, c: P, ca: V3, cb: V3, cc: V3, inside: P, normal?: P): void => {
    let n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) return;
    n = [n[0] / l, n[1] / l, n[2] / l];
    if (dot(n, sub(a, inside)) < 0) {
      [b, c] = [c, b];
      [cb, cc] = [cc, cb];
      n = [-n[0], -n[1], -n[2]];
    }
    if (normal) n = normal;
    const ci = Math.min(acrossChunks - 1, Math.max(0, Math.floor((a[2] - f.z0) / chunkM))) * acrossChunks + Math.min(acrossChunks - 1, Math.max(0, Math.floor((a[0] - f.x0) / chunkM)));
    const list = (lists[ci] ??= []);
    // The last number: the corner lies on the ground and carries its paths (see the pieces below).
    list.push(a[0], a[1], a[2], n[0], n[1], n[2], ca[0], ca[1], ca[2], 1);
    list.push(b[0], b[1], b[2], n[0], n[1], n[2], cb[0], cb[1], cb[2], 1);
    list.push(c[0], c[1], c[2], n[0], n[1], n[2], cc[0], cc[1], cc[2], 1);
  };
  const quad = (a: P, b: P, c: P, d: P, col: V3, shade: number, inside: P): void => {
    tri(a, b, c, col, shade, shade, shade, inside);
    tri(a, c, d, col, shade, shade, shade, inside);
  };

  /**
   * A cut stone standing in the ground: a skirt from under the ground up to a low ring, a higher and narrower ring
   * turned half a step, a point on top. Flat and wide it is a stepping stone or a flag, tall a boulder. Without
   * `base` every point stands on the ground under it, so a flat stone follows a slope.
   */
  const stone = (cx: number, cz: number, rx: number, rz: number, turn: number, h: number, sides: number, key: number, tone: V3, moss: number, base: number | null = null, topR = 0.8, sink = 0.14): void => {
    const cosT = Math.cos(turn);
    const sinT = Math.sin(turn);
    const at = (k: number, half: number, r: number, up: number, q: number): P => {
      const a = ((k + half) / sides) * TAU;
      const j = r * (1 + 0.26 * (unit(key, k, q) - 0.5));
      const ex = Math.cos(a) * rx * j;
      const ez = Math.sin(a) * rz * j;
      const x = cx + cosT * ex - sinT * ez;
      const z = cz + sinT * ex + cosT * ez;
      return [x, (base ?? gy(x, z)) + up, z];
    };
    const y0 = base ?? gy(cx, cz);
    const skirt: P[] = [];
    const low: P[] = [];
    const high: P[] = [];
    for (let k = 0; k < sides; k++) {
      skirt.push(at(k, 0, 1.05, -sink, 1));
      low.push(at(k, 0, 1, h * (0.5 + 0.2 * unit(key, k, 5)), 1));
      high.push(at(k, 0.5, topR, h * (0.93 + 0.14 * unit(key, k, 6)), 2));
    }
    const top: P = [cx + 0.1 * rx * (unit(key, 7) - 0.5), y0 + h * 1.04, cz + 0.1 * rz * (unit(key, 8) - 0.5)];
    const inside: P = [cx, y0 + h * 0.3, cz];
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      const j = 0.94 + 0.12 * unit(key, k, 9);
      // The foot is dark: the stone shades the ground it stands in.
      tri(low[k]!, low[k1]!, skirt[k1]!, tone, 0.8 * j, 0.8 * j, 0.52, inside);
      tri(low[k]!, skirt[k1]!, skirt[k]!, tone, 0.8 * j, 0.52, 0.52, inside);
      tri(low[k]!, low[k1]!, high[k]!, tone, 0.86 * j, 0.86 * j, 0.95 * j, inside);
      tri(high[k]!, high[k1]!, low[k1]!, tone, 0.94 * j, 0.94 * j, 0.82 * j, inside);
      const mossy = unit(key, k, 10) < moss;
      tri(high[k]!, high[k1]!, top, mossy ? mixV(tone, MOSS, 0.8) : tone, 1.04 * j, 1.04 * j, 1.1 * j, inside);
    }
  };

  /** The colour the ground's mesh has at a point (ground-mesh.ts), so what lies on the ground can fade into it. */
  const tintAt = (x: number, z: number): V3 => {
    const e = f.step;
    const ny = 1 / Math.hypot((gy(x + e, z) - gy(x - e, z)) / (2 * e), 1, (gy(x, z + e) - gy(x, z - e)) / (2 * e));
    let c = groundColour(gy(x, z), 1 - ny, OVER_MAX_M);
    const level = 1 - sat((1 - ny - 0.15) / 0.25);
    c = mixV(c, LUSH, 0.55 * coverAt(cover, cover.damp, x, z) * level);
    return mixV(c, UNDER_WOOD, 0.6 * coverAt(cover, cover.wood, x, z) * level);
  };

  /**
   * A ring of bare soil on the ground round a stone that is stepped on, fading into the ground at its rim. The stone
   * covers its middle, so the ring has none.
   */
  const bed = (cx: number, cz: number, r: number, key: number): void => {
    const lift = 0.014;
    const c: P = [cx, gy(cx, cz) + lift, cz];
    const inner: P[] = [];
    const outer: P[] = [];
    const turn = TAU * unit(key, 20);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + turn;
      const rr = r * (0.85 + 0.4 * unit(key, k, 21));
      for (const [ring, share] of [[inner, 0.45], [outer, 1.25]] as const) {
        const x = cx + Math.cos(a) * rr * share;
        const z = cz + Math.sin(a) * rr * share;
        ring.push([x, gy(x, z) + lift, z]);
      }
    }
    const under: P = [cx, c[1] - 1, cz];
    // Lit like the ground it lies on, so its rim cannot be told from the ground.
    const e = f.step;
    const sx = (gy(cx + e, cz) - gy(cx - e, cz)) / (2 * e);
    const sz = (gy(cx, cz + e) - gy(cx, cz - e)) / (2 * e);
    const nl = Math.hypot(sx, 1, sz);
    const lit: P = [-sx / nl, 1 / nl, -sz / nl];
    const tint = tintAt(cx, cz);
    const rim: V3 = [tint[0] / SOIL[0], tint[1] / SOIL[1], tint[2] / SOIL[2]];
    const fade = (a: P, b: P, d: P, sa: number, sb: number, sd: number): void => {
      // Corners at the rim take the ground's colour, the others the soil's.
      const col = (s: number): V3 => (s < 0 ? [SOIL[0] * rim[0], SOIL[1] * rim[1], SOIL[2] * rim[2]] : [SOIL[0] * s, SOIL[1] * s, SOIL[2] * s]);
      tri3(a, b, d, col(sa), col(sb), col(sd), under, lit);
    };
    for (let k = 0; k < 8; k++) {
      const k1 = (k + 1) % 8;
      fade(inner[k]!, outer[k]!, outer[k1]!, 1.15, -1, -1);
      fade(inner[k]!, outer[k1]!, inner[k1]!, 1.15, -1, 1.15);
    }
  };

  /** A box from its middle and three half edges. Faces that look up are light, the others darker. */
  const box = (c: P, u: P, v: P, w: P, col: V3, tone = 1): void => {
    const corner = (a: number, b: number, d: number): P => [c[0] + a * u[0] + b * v[0] + d * w[0], c[1] + a * u[1] + b * v[1] + d * w[1], c[2] + a * u[2] + b * v[2] + d * w[2]];
    const face = (p: P, q: P, r: P, s: P): void => {
      const n = cross(sub(q, p), sub(r, p));
      const out = dot(n, sub(p, c)) < 0 ? -1 : 1;
      const up = (out * n[1]) / (Math.hypot(n[0], n[1], n[2]) || 1);
      quad(p, q, r, s, col, tone * (0.66 + 0.34 * Math.max(0, up)), c);
    };
    for (const d of [-1, 1]) {
      face(corner(d, -1, -1), corner(d, 1, -1), corner(d, 1, 1), corner(d, -1, 1));
      face(corner(-1, d, -1), corner(1, d, -1), corner(1, d, 1), corner(-1, d, 1));
      face(corner(-1, -1, d), corner(1, -1, d), corner(1, 1, d), corner(-1, 1, d));
    }
  };

  /** A round timber from a to b; its two ends are pale cut wood. */
  const tube = (a: P, b: P, r: number, sides: number, col: V3, tone = 1, ends: V3 = CUT): void => {
    const d = sub(b, a);
    const l = Math.hypot(d[0], d[1], d[2]);
    if (l < 1e-6) return;
    let u = cross(d, [0, 1, 0]);
    if (Math.hypot(u[0], u[1], u[2]) < 1e-6 * l) u = [1, 0, 0];
    const ul = Math.hypot(u[0], u[1], u[2]);
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    let v = cross(u, d);
    const vl = Math.hypot(v[0], v[1], v[2]);
    v = [v[0] / vl, v[1] / vl, v[2] / vl];
    const ring = (o: P): P[] =>
      Array.from({ length: sides }, (_, k): P => {
        const g = (k / sides) * TAU;
        const cu = Math.cos(g) * r;
        const sv = Math.sin(g) * r;
        return [o[0] + cu * u[0] + sv * v[0], o[1] + cu * u[1] + sv * v[1], o[2] + cu * u[2] + sv * v[2]];
      });
    const ra = ring(a);
    const rb = ring(b);
    const mid: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      const g = ((k + 0.5) / sides) * TAU;
      const up = Math.cos(g) * u[1] + Math.sin(g) * v[1];
      quad(ra[k]!, ra[k1]!, rb[k1]!, rb[k]!, col, tone * (0.72 + 0.3 * up), mid);
      tri(a, ra[k]!, ra[k1]!, ends, tone, tone, tone, mid);
      tri(b, rb[k]!, rb[k1]!, ends, tone, tone, tone, mid);
    }
  };

  /** A level-topped block from its outline: the top as a fan, the sides straight down to under the ground. */
  const block = (top: P[], col: V3, key: number): void => {
    const n = top.length;
    const c: P = [0, 0, 0];
    let low = Infinity;
    for (const p of top) {
      c[0] += p[0] / n;
      c[1] += p[1] / n;
      c[2] += p[2] / n;
      low = Math.min(low, gy(p[0], p[2]));
    }
    const foot = Math.min(low, c[1] - 0.1) - 0.2;
    const inside: P = [c[0], (c[1] + foot) / 2, c[2]];
    const crown: P = [c[0], c[1] + 0.012, c[2]];
    for (let k = 0; k < n; k++) {
      const a = top[k]!;
      const b = top[(k + 1) % n]!;
      const j = 0.94 + 0.12 * unit(key, k, 31);
      tri(crown, a, b, col, 1.08 * j, 1.0 * j, 1.0 * j, inside);
      tri(a, b, [b[0], foot, b[2]], col, 0.78 * j, 0.78 * j, 0.4, inside);
      tri(a, [b[0], foot, b[2]], [a[0], foot, a[2]], col, 0.78 * j, 0.4, 0.4, inside);
    }
  };

  /**
   * A tuft: blades from one root, leaning outward, each one triangle (the material draws both of its faces) lit like
   * the ground under it. A
   * blade has the ground's colour at its root, so the tuft grows out of the ground instead of standing on it.
   */
  const tuft = (x: number, z: number, r: number, tall: number, blades: number, key: number, tip: V3, wide: number, lean: number): void => {
    const y = gy(x, z) - 0.02;
    const normal: P = [0, 1, 0];
    const root = tintAt(x, z);
    const rise: V3 = [tip[0] / root[0], tip[1] / root[1], tip[2] / root[2]];
    const top = Math.max(rise[0], rise[1], rise[2]);
    for (let k = 0; k < blades; k++) {
      const a = (k / blades) * TAU + TAU * unit(key, k, 41);
      const out = r * (0.2 + 0.8 * unit(key, k, 42));
      const bx = x + Math.cos(a) * out;
      const bz = z + Math.sin(a) * out;
      const hh = tall * (0.5 + 0.5 * unit(key, k, 43));
      const w = wide * (0.7 + 0.6 * unit(key, k, 44));
      const px = -Math.sin(a) * w;
      const pz = Math.cos(a) * w;
      const reach = hh * lean * (0.4 + 1.2 * unit(key, k, 46));
      const end: P = [bx + Math.cos(a) * reach, y + hh, bz + Math.sin(a) * reach];
      const p: P = [bx - px, y, bz - pz];
      const q: P = [bx + px, y, bz + pz];
      const tone = (0.9 + 0.2 * unit(key, k, 45)) * top;
      tri(p, q, end, root, 0.94, 0.94, tone, undefined, normal);
    }
  };

  /** A few flowers over a tuft: each a small bud of four faces on a stem. */
  const flower = (x: number, z: number, tall: number, key: number): void => {
    const col = FLOWERS[Math.floor(unit(key, 51) * FLOWERS.length)]!;
    const stemCol = tintAt(x, z);
    const normal: P = [0, 1, 0];
    const n = 2 + Math.floor(unit(key, 52) * 4);
    for (let k = 0; k < n; k++) {
      const a = TAU * unit(key, k, 53);
      const d = 0.03 + 0.1 * unit(key, k, 54);
      const fx = x + Math.cos(a) * d;
      const fz = z + Math.sin(a) * d;
      const base = gy(fx, fz);
      const y = base + tall * (0.75 + 0.5 * unit(key, k, 55));
      const s = 0.016 + 0.01 * unit(key, k, 56);
      const tipAt: P = [fx, y + s * 1.1, fz];
      const under: P = [fx, y - s, fz];
      const ring: P[] = [0, 1, 2, 3].map((q): P => [fx + Math.cos(a + (q * TAU) / 4) * s, y, fz + Math.sin(a + (q * TAU) / 4) * s]);
      for (let q = 0; q < 4; q++) {
        tri(ring[q]!, ring[(q + 1) % 4]!, tipAt, col, 0.95, 0.95, 1.15, under, normal);
        tri(ring[q]!, ring[(q + 1) % 4]!, under, col, 0.8, 0.8, 0.6, tipAt, normal);
      }
      tri([fx - 0.005, base, fz], [fx + 0.005, base, fz], under, stemCol, 0.9, 0.9, 1.1, undefined, normal);
    }
  };

  const toneOf = (key: number): V3 => {
    const t = mixV(STONE_WARM, STONE_COOL, unit(key, 61));
    const s = 0.94 + 0.32 * unit(key, 62);
    return [t[0] * s, t[1] * s, t[2] * s];
  };

  const hit: PathHit = { d: 0, ox: 0, oz: 0, y: 0, ford: 0, path: 0, i: 0, t: 0 };
  /** Whether a point of path `id` lies on the tread of another path (at a junction the earlier path keeps its own). */
  const onOther = (id: number, x: number, z: number, within: number): boolean => pathAt(pp, x, z, hit) && hit.path !== id && hit.d < within;
  const spot: Spot = { x: 0, z: 0, tx: 0, tz: 0, i: 0, lo: 0, u: 0 };

  /** A footbridge: two beams, boards, posts and rails, piles in the water. */
  const bridge = (br: Bridge, key: number): void => {
    const { x: ax, z: az, tx, tz, lengthM: L } = br;
    const nx = -tz;
    const nz = tx;
    const at = (d: number, side: number, up: number): P => [ax + tx * d + nx * side, deckAt(br, d) + up, az + tz * d + nz * side];
    const spans = Math.max(2, Math.round(L / 1.2));
    for (let q = 0; q < spans; q++) for (const side of [-0.42, 0.42]) tube(at((L * q) / spans, side, -0.15), at((L * (q + 1)) / spans, side, -0.15), 0.095, 6, LOG, 1, LOG);
    for (let d = 0.16, k = 0; d < L - 0.1; d += 0.3, k++) {
      const yaw = 0.07 * (unit(key, k, 71) - 0.5);
      const half = 0.62 + 0.05 * (unit(key, k, 72) - 0.5);
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      box(at(d, 0.03 * (unit(key, k, 73) - 0.5), -0.022), [(nx * cy + tx * sy) * half, 0, (nz * cy + tz * sy) * half], [(tx * cy - nx * sy) * 0.128, 0, (tz * cy - nz * sy) * 0.128], [0, 0.022, 0], BOARD, 0.84 + 0.3 * unit(key, k, 74));
    }
    const posts = Math.max(2, Math.round(L / 1.9) + 1);
    for (const side of [-0.6, 0.6]) {
      let before: P | null = null;
      for (let q = 0; q < posts; q++) {
        const d = 0.25 + ((L - 0.5) * q) / (posts - 1);
        tube(at(d, side, -0.32), at(d, side, 0.98), 0.045, 5, LOG, 1.1);
        const rail = at(d, side, 0.88);
        if (before) tube(before, rail, 0.036, 5, LOG, 1.2);
        before = rail;
      }
    }
    for (let d = 3; d < L - 2.5; d += 3.2)
      for (const side of [-0.42, 0.42]) {
        const top = at(d, side, -0.2);
        tube([top[0], gy(top[0], top[2]) - 0.4, top[2]], top, 0.085, 6, LOG, 0.85);
      }
  };

  /** A cairn: stones laid one on another, smaller toward the top. */
  const cairn = (x: number, z: number, key: number): void => {
    let y = gy(x, z);
    const n = 4 + Math.floor(unit(key, 81) * 2);
    for (let k = 0; k < n; k++) {
      const r = 0.36 * (1 - 0.72 * (k / n)) * (0.9 + 0.2 * unit(key, k, 82));
      const h = 0.2 * (1 - 0.35 * (k / n)) * (0.85 + 0.3 * unit(key, k, 83));
      const off = 0.05 * (unit(key, k, 84) - 0.5);
      stone(x + off, z - off, r, r * (0.8 + 0.3 * unit(key, k, 85)), TAU * unit(key, k, 86), h, 6, key + 97 * k, toneOf(key + 13 * k), k === 0 ? 0.3 : 0.1, y, 0.72, k === 0 ? 0.25 : 0.03);
      y += h * 0.93;
    }
  };

  /** A signpost: a post with a board for every way that leaves it. */
  const signpost = (x: number, z: number, ways: [number, number][], key: number): void => {
    const y = gy(x, z);
    tube([x, y - 0.3, z], [x, y + 1.9, z], 0.055, 6, LOG, 1.1);
    ways.slice(0, 3).forEach(([dx, dz], k) => {
      const l = Math.hypot(dx, dz) || 1;
      const ux = dx / l;
      const uz = dz / l;
      const at = y + 1.72 - 0.2 * k;
      const droop = 0.06 * (unit(key, k, 91) - 0.5);
      box([x + ux * 0.36 - uz * 0.07, at, z + uz * 0.36 + ux * 0.07], [ux * 0.4, droop, uz * 0.4], [0, 0.075, 0], [-uz * 0.014, 0, ux * 0.014], BOARD, 1 + 0.15 * unit(key, k, 92));
    });
    for (let k = 0; k < 3; k++) {
      const a = TAU * unit(key, k, 93);
      stone(x + Math.cos(a) * 0.2, z + Math.sin(a) * 0.2, 0.14, 0.12, a, 0.14, 5, key + k, toneOf(key + k), 0.2);
    }
  };

  /** The place round (x, z), `reach` away, that lies farthest from every path and stands dry; null when none does. */
  const beside = (x: number, z: number, reach: number): [number, number] | null => {
    let best: [number, number] | null = null;
    let far = 0.9;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU;
      const px = x + Math.cos(a) * reach;
      const pz = z + Math.sin(a) * reach;
      if (gy(px, pz) < levelAt(px, pz) + 0.25) continue;
      const d = pathAt(pp, px, pz, hit) ? hit.d : 99;
      if (d > far) {
        far = d;
        best = [px, pz];
      }
    }
    return best;
  };

  pp.paths.forEach((p, id) => {
    const key = (seed * 7919 + id * 104729) | 0;
    const kind = kinds.kind[id]!;
    const lift = kinds.lift[id]!;
    const cum = lengthsOf(p);
    const total = cum[p.n - 1]!;

    // --- What lies in the tread -----------------------------------------------------------------------------------
    let count = 0;
    for (let s = 0.4; s < total - 0.4; count++) {
      spotAt(p, cum, s, spot);
      const { x, z, tx, tz } = spot;
      const nx = -tz;
      const nz = tx;
      const k = kind[spot.i]!;
      const r = (q: number): number => unit(key, count, q);
      if (k === KIND.earth) {
        // A stone trodden into the line now and then.
        if (r(1) < 0.3) {
          const off = 0.42 * (r(2) - 0.5) * 2;
          if (!onOther(id, x + nx * off, z + nz * off, 0.9)) stone(x + nx * off, z + nz * off, 0.07 + 0.09 * r(3), 0.06 + 0.08 * r(4), TAU * r(5), 0.035 + 0.04 * r(6), 5, key + count, toneOf(key + count), 0);
        }
        s += 1.3;
      } else if (k === KIND.stones) {
        const off = (count % 2 ? 0.13 : -0.13) + 0.1 * (r(2) - 0.5);
        const px = x + nx * off;
        const pz = z + nz * off;
        if (r(1) > 0.08 && !onOther(id, px, pz, 0.9)) {
          const rx = 0.21 + 0.1 * r(3);
          bed(px, pz, rx * 1.35, key + count);
          stone(px, pz, rx, rx * (0.72 + 0.4 * r(4)), TAU * r(5), 0.05 + 0.04 * r(6), 6 + (r(7) < 0.4 ? 1 : 0), key + count, toneOf(key + count), r(8) < 0.45 ? 0.35 : 0);
        }
        s += STRIDE_M * (0.9 + 0.25 * r(9));
      } else if (k === KIND.flags) {
        // A row of two or three flags across, the rows set half a flag apart.
        const three = r(1) < 0.45;
        const cuts = three ? [-0.68, -0.22 + 0.14 * (r(2) - 0.5), 0.24 + 0.14 * (r(3) - 0.5), 0.68] : [-0.66, 0.2 * (r(2) - 0.5), 0.66];
        const heading = Math.atan2(nz, nx);
        for (let q = 0; q + 1 < cuts.length; q++) {
          const mid = (cuts[q]! + cuts[q + 1]!) / 2;
          const half = (cuts[q + 1]! - cuts[q]!) / 2;
          const px = x + nx * mid + tx * 0.05 * (unit(key, count, q, 4) - 0.5);
          const pz = z + nz * mid + tz * 0.05 * (unit(key, count, q, 4) - 0.5);
          if (onOther(id, px, pz, 0.8)) continue;
          stone(px, pz, half * 1.02, 0.27, heading + 0.3 * (unit(key, count, q, 5) - 0.5), 0.045 + 0.025 * unit(key, count, q, 6), 5 + Math.floor(unit(key, count, q, 7) * 2), key + count * 8 + q, toneOf(key + count * 8 + q), unit(key, count, q, 8) < 0.2 ? 0.3 : 0, null, 0.9);
        }
        s += 0.52;
      } else if (k === KIND.steps) {
        // The step's top is level; its lower edge stands out of the slope by the rise, its upper edge lies in it.
        spotAt(p, cum, s + 0.5, spot);
        const ahead = gy(spot.x, spot.z);
        spotAt(p, cum, s - 0.5, spot);
        const grade = Math.abs(ahead - gy(spot.x, spot.z));
        const half = 0.62 + 0.14 * r(2);
        const top = Math.max(gy(x, z), gy(x + nx * 0.45, z + nz * 0.45) - 0.03, gy(x - nx * 0.45, z - nz * 0.45) - 0.03) + 0.15 * grade + 0.02;
        const outline: [number, number][] = [
          [-0.3, -half],
          [-0.3 - 0.04 * r(3), 0.2 * (r(4) - 0.5)],
          [-0.3, half * (0.9 + 0.2 * r(5))],
          [0.3, half],
          [0.3 + 0.04 * r(6), 0.2 * (r(7) - 0.5)],
          [0.3, -half * (0.9 + 0.2 * r(8))],
        ];
        block(outline.map(([al, ac]): P => [x + tx * (al + 0.03 * (r(9) - 0.5)) + nx * ac, top, z + tz * (al + 0.03 * (r(9) - 0.5)) + nz * ac]), toneOf(key + count), key + count);
        s += STEP_DEPTH_M;
      } else if (k === KIND.boards) {
        const up = lift[spot.lo]! + (lift[Math.min(p.n - 1, spot.lo + 1)]! - lift[spot.lo]!) * spot.u;
        const yaw = 0.09 * (r(1) - 0.5);
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        const half = 0.58 + 0.07 * (r(2) - 0.5);
        const off = 0.04 * (r(3) - 0.5);
        box([x + nx * off, gy(x, z) + up - 0.022, z + nz * off], [(nx * cy + tx * sy) * half, 0, (nz * cy + tz * sy) * half], [(tx * cy - nx * sy) * 0.13, 0, (tz * cy - nz * sy) * 0.13], [0, 0.022, 0], BOARD, 0.82 + 0.32 * r(4));
        s += BOARD_M;
      } else if (k === KIND.ford) {
        const level = levelAt(x, z);
        const off = (count % 2 ? 0.14 : -0.14) + 0.12 * (r(2) - 0.5);
        const px = x + nx * off;
        const pz = z + nz * off;
        const bedY = gy(px, pz);
        // In the water a stone stands on the bed with its top just over the level; on the bank it is a flat stone.
        const wet = bedY < level;
        const h = wet ? level - bedY + FORD_TOP_M - 0.03 + 0.06 * r(3) : 0.07 + 0.04 * r(3);
        const rx = (wet ? 0.3 + 0.1 * Math.min(2, h) : 0.26) + 0.08 * r(4);
        stone(px, pz, rx, rx * (0.8 + 0.3 * r(5)), TAU * r(6), h, 7, key + count, toneOf(key + count), wet ? 0 : 0.3, wet ? bedY : null, wet ? 0.86 : 0.8, wet ? 0.3 : 0.14);
        s += 0.78 + 0.16 * r(7);
      } else s += 1;
    }

    // --- Bridges and the beams under the boards -------------------------------------------------------------------
    for (const br of kinds.bridges) if (br.path === id) bridge(br, key + br.a);
    for (let i = 0; i + 1 < p.n; i++) {
      if (kind[i] !== KIND.boards || kind[i + 1] !== KIND.boards) continue;
      for (const side of [-0.36, 0.36]) {
        const ends: P[] = [];
        for (const q of [i, i + 1]) {
          spotAt(p, cum, cum[q]!, spot);
          const x = spot.x - spot.tz * side;
          const z = spot.z + spot.tx * side;
          ends.push([x, gy(x, z) + lift[q]! - 0.044 - 0.05, z]);
        }
        tube(ends[0]!, ends[1]!, 0.055, 5, LOG, 1, LOG);
      }
    }

    // --- The verge ------------------------------------------------------------------------------------------------
    for (const side of [-1, 1]) {
      let at = 0;
      for (let s = 0.5; s < total - 0.3; s += 0.5, at++) {
        spotAt(p, cum, s, spot);
        const k = kind[spot.i]!;
        if (k === KIND.bridge || k === KIND.ford) continue;
        const r = (q: number): number => unit(key, side, at, q);
        const clear = CLEAR_M[k]!;
        const wood = coverAt(cover, cover.wood, spot.x, spot.z);
        const damp = coverAt(cover, cover.damp, spot.x, spot.z);
        const place = (out: number): [number, number] | null => {
          const x = spot.x - spot.tz * side * out + spot.tx * 0.4 * (r(11) - 0.5);
          const z = spot.z + spot.tx * side * out + spot.tz * 0.4 * (r(11) - 0.5);
          if (gy(x, z) < levelAt(x, z) + 0.12) return null;
          if (pathAt(pp, x, z, hit) && hit.d < clear) return null;
          return [x, z];
        };
        // Growth: thick in clumps at the edge of the tread, thinning away from it.
        const clump = noise1(s / 7, key + 3 + side) > 0.38 ? 1 : 0.35;
        for (let twice = 0; twice < 2; twice++) {
          const g = (q: number): number => unit(key, side, at, q + 100 * twice);
          if (wood < 0.5) {
            if (g(1) > 0.6 * clump) continue;
            const at2 = place(clear + 0.1 + 2.8 * g(2) * g(2) * g(2));
            if (!at2) continue;
            const tall = 0.13 + 0.2 * g(3) + (damp > 0.6 ? 0.1 : 0);
            tuft(at2[0], at2[1], 0.07 + 0.09 * g(4), tall, 7 + Math.floor(g(5) * 4), key + side * 7 + at * 2 + twice, GRASS_TIP, 0.013, 0.5);
            if (g(6) < 0.1) flower(at2[0], at2[1], tall, key + at * 2 + twice + side);
          } else if (g(1) < 0.2 * clump) {
            const at2 = place(clear + 0.15 + 1.8 * g(2) * g(2));
            if (at2) tuft(at2[0], at2[1], 0.08, 0.3 + 0.2 * g(3), 6, key + side * 7 + at * 2 + twice, FERN, 0.06, 1.1);
          }
        }
        // Stones: a few everywhere, many along steps and in stony stretches.
        const stony = k === KIND.steps ? 0.42 : 0.04 + 0.3 * Math.max(0, (noise1(s / 27, key + 5) - 0.6) / 0.4);
        if (r(7) < stony) {
          const big = k === KIND.steps ? 1.5 : 1;
          const at2 = place(clear + 0.1 + 0.5 * r(8));
          if (at2) {
            const rr = big * (0.12 + 0.2 * r(9) * r(9));
            stone(at2[0], at2[1], rr, rr * (0.7 + 0.5 * r(10)), TAU * r(12), rr * (0.7 + 0.7 * r(13)), 6, key + 31 * at + side, toneOf(key + 31 * at + side), r(14) < 0.35 ? 0.4 : 0, null, 0.62, 0.2);
          }
        }
        // A fallen trunk beside the path in a wood.
        if (wood > 0.6 && k === KIND.earth && r(15) < 0.014) {
          const at2 = place(clear + 0.45);
          if (at2) {
            const len = 1.2 + 1.6 * r(16);
            const turn = 0.5 * (r(17) - 0.5);
            const ux = spot.tx * Math.cos(turn) - spot.tz * Math.sin(turn);
            const uz = spot.tz * Math.cos(turn) + spot.tx * Math.sin(turn);
            const rad = 0.12 + 0.06 * r(18);
            const a: P = [at2[0] - ux * len, 0, at2[1] - uz * len];
            const b: P = [at2[0] + ux * len, 0, at2[1] + uz * len];
            a[1] = gy(a[0], a[2]) + rad * 0.55;
            b[1] = gy(b[0], b[2]) + rad * 0.55;
            if (!(pathAt(pp, a[0], a[2], hit) && hit.d < clear) && !(pathAt(pp, b[0], b[2], hit) && hit.d < clear)) tube(a, b, rad, 7, LOG);
          }
        }
      }
    }
  });

  // --- Waymarks ---------------------------------------------------------------------------------------------------
  pp.places.forEach((place, id) => {
    const key = (seed * 31 + id * 7907) | 0;
    if (place.name !== 'junction') {
      const at = beside(place.x, place.z, 1.9);
      if (at) cairn(at[0], at[1], key);
      return;
    }
    const ways: [number, number][] = [];
    for (const p of pp.paths) {
      const far = Math.min(p.n - 1, 4);
      if (p.from === id) ways.push([p.x[far]! - p.x[0]!, p.z[far]! - p.z[0]!]);
      if (p.to === id) ways.push([p.x[p.n - 1 - far]! - p.x[p.n - 1]!, p.z[p.n - 1 - far]! - p.z[p.n - 1]!]);
    }
    // The path that runs through the junction leads both ways.
    for (let q = 0; q < pp.paths.length && ways.length < 3; q++) {
      const p = pp.paths[q]!;
      if (p.from === id || p.to === id) continue;
      for (let i = 4; i < p.n - 4; i++) {
        if (Math.hypot(p.x[i]! - place.x, p.z[i]! - place.z) > 0.5) continue;
        ways.push([p.x[i + 4]! - p.x[i]!, p.z[i + 4]! - p.z[i]!], [p.x[i - 4]! - p.x[i]!, p.z[i - 4]! - p.z[i]!]);
        break;
      }
    }
    const at = beside(place.x, place.z, 1.7);
    if (at && ways.length > 0) signpost(at[0], at[1], ways, key);
  });

  const stride = GROUND_LAYOUT.stride;
  const pieces: GroundPiece[] = [];
  for (const list of lists) {
    if (!list || list.length === 0) continue;
    const count = list.length / 10;
    const view = new DataView(new ArrayBuffer(count * stride));
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < count; v++) {
      const o = v * 10;
      putVertex(view, v, list[o]!, list[o + 1]!, list[o + 2]!, list[o + 3]!, list[o + 4]!, list[o + 5]!, 0, list[o + 6]!, list[o + 7]!, list[o + 8]!);
      if (list[o + 9]) putPaths(view, v, pp, kinds, list[o]!, list[o + 2]!, hit);
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, list[o + a]!);
        max[a] = Math.max(max[a]!, list[o + a]!);
      }
    }
    const indices = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let v = 0; v < count; v++) indices[v] = v;
    pieces.push({ data: { layout: GROUND_LAYOUT, vertices: new Uint8Array(view.buffer), indices, count }, min, max });
  }
  return pieces;
}
