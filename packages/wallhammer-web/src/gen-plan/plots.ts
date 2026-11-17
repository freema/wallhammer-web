// Plots along lines on a plane: rectangles whose front faces a line at a setback, laid one after the other along
// each side of every line. What a line and a plot stand for is up to the caller. Pure: the lines and the seed decide
// the result; arithmetic and `Math.sqrt/floor/abs/min/max` only.

import { hashInts } from '../gen-core/hash.ts';

/** One plot: a rectangle on the plane of the lines. */
export interface Plot {
  /** Index in the result. */
  id: number;
  /** Centre. */
  x: number;
  z: number;
  /** Unit vector from the plot toward its line (its front looks there). */
  hx: number;
  hz: number;
  /** Size along the line and away from it, metres. */
  widthM: number;
  depthM: number;
  /** Index of the line in the input. */
  line: number;
}

/** Options of `plotsAlong`. */
export interface PlotOptions {
  /** Range of the width along the line, metres. */
  frontM: readonly [number, number];
  /** Range of the depth away from the line, metres. */
  depthM: readonly [number, number];
  /** Distance of the middle of a front edge from the centre line, metres; no line comes nearer to a plot. */
  setbackM: number;
  /** Least distance between two plots, metres. */
  gapM: number;
  seed: number;
  /** True where no plot may stand; asked at the centre and the four corners. */
  blocked?: (x: number, z: number) => boolean;
}

/** At most this many plots. */
const MAX_PLOTS = 4096;
/** A dropped plot moves the walk on by this much, metres. */
const DROP_STEP_M = 2;
/** Tolerance of the setback test, metres. */
const SETBACK_TOLERANCE_M = 0.001;

/** A line as segments with their lengths along it. */
interface Walk {
  points: ArrayLike<number>;
  /** Metres along the line at each point. */
  along: Float64Array;
  length: number;
}

function walkOf(points: ArrayLike<number>): Walk {
  const n = Math.floor(points.length / 2);
  const along = new Float64Array(Math.max(1, n));
  for (let i = 1; i < n; i++) {
    const dx = points[2 * i]! - points[2 * i - 2]!;
    const dz = points[2 * i + 1]! - points[2 * i - 1]!;
    along[i] = along[i - 1]! + Math.sqrt(dx * dx + dz * dz);
  }
  return { points, along, length: n > 0 ? along[n - 1]! : 0 };
}

/** Point and unit direction of a walk at `t` metres along it. */
function walkAt(w: Walk, t: number, out: Float64Array): void {
  const n = w.along.length;
  let i = 0;
  while (i + 2 < n && w.along[i + 1]! < t) i++;
  const ax = w.points[2 * i]!;
  const az = w.points[2 * i + 1]!;
  const bx = w.points[2 * i + 2]!;
  const bz = w.points[2 * i + 3]!;
  const dx = bx - ax;
  const dz = bz - az;
  const l = Math.sqrt(dx * dx + dz * dz) || 1;
  const f = (t - w.along[i]!) / l;
  out[0] = ax + dx * f;
  out[1] = az + dz * f;
  out[2] = dx / l;
  out[3] = dz / l;
}

/** Corners of a plot: centre (cx, cz), axis u along its width, v along its depth, half sizes. */
function cornersOf(cx: number, cz: number, ux: number, uz: number, hw: number, hd: number, out: Float64Array): void {
  const vx = -uz;
  const vz = ux;
  out[0] = cx - ux * hw - vx * hd;
  out[1] = cz - uz * hw - vz * hd;
  out[2] = cx + ux * hw - vx * hd;
  out[3] = cz + uz * hw - vz * hd;
  out[4] = cx + ux * hw + vx * hd;
  out[5] = cz + uz * hw + vz * hd;
  out[6] = cx - ux * hw + vx * hd;
  out[7] = cz - uz * hw + vz * hd;
}

/** Whether the corners of two rectangles are at least `gap` apart along one of their four axes (separating axes). */
function apart(a: Float64Array, b: Float64Array, gap: number): boolean {
  for (const r of [a, b]) {
    for (let e = 0; e < 2; e++) {
      const ax = r[2 * e + 2]! - r[2 * e]!;
      const az = r[2 * e + 3]! - r[2 * e + 1]!;
      const l = Math.sqrt(ax * ax + az * az);
      if (!(l > 0)) continue;
      const nx = ax / l;
      const nz = az / l;
      let a0 = Infinity;
      let a1 = -Infinity;
      let b0 = Infinity;
      let b1 = -Infinity;
      for (let k = 0; k < 4; k++) {
        const pa = a[2 * k]! * nx + a[2 * k + 1]! * nz;
        const pb = b[2 * k]! * nx + b[2 * k + 1]! * nz;
        a0 = Math.min(a0, pa);
        a1 = Math.max(a1, pa);
        b0 = Math.min(b0, pb);
        b1 = Math.max(b1, pb);
      }
      if (b0 - a1 >= gap || a0 - b1 >= gap) return true;
    }
  }
  return false;
}

/** Squared distance from point (px, pz) to segment (a, b). */
function pointSegment2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  const ex = ax + dx * t - px;
  const ez = az + dz * t - pz;
  return ex * ex + ez * ez;
}

/** Whether segments (a, b) and (c, d) cross or touch. */
function segmentsMeet(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number): number => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const o1 = o(ax, az, bx, bz, cx, cz);
  const o2 = o(ax, az, bx, bz, dx, dz);
  const o3 = o(cx, cz, dx, dz, ax, az);
  const o4 = o(cx, cz, dx, dz, bx, bz);
  return o1 * o2 <= 0 && o3 * o4 <= 0;
}

/** Whether point (px, pz) lies inside the rectangle of corners `c` (in order round it). */
function insideRect(c: Float64Array, px: number, pz: number): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const ax = c[2 * k]!;
    const az = c[2 * k + 1]!;
    const bx = c[(2 * k + 2) % 8]!;
    const bz = c[(2 * k + 3) % 8]!;
    const cr = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
    const s = cr > 0 ? 1 : cr < 0 ? -1 : 0;
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Squared distance between segment (a, b) and the rectangle of corners `c`. */
function segmentRect2(ax: number, az: number, bx: number, bz: number, c: Float64Array): number {
  if (insideRect(c, ax, az) || insideRect(c, bx, bz)) return 0;
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    const px = c[2 * k]!;
    const pz = c[2 * k + 1]!;
    const qx = c[(2 * k + 2) % 8]!;
    const qz = c[(2 * k + 3) % 8]!;
    if (segmentsMeet(ax, az, bx, bz, px, pz, qx, qz)) return 0;
    best = Math.min(best, pointSegment2(px, pz, ax, az, bx, bz), pointSegment2(ax, az, px, pz, qx, qz), pointSegment2(bx, bz, px, pz, qx, qz));
  }
  return best;
}

/** A square bucket grid of items with boxes. */
class Buckets {
  private readonly cells = new Map<string, number[]>();
  private readonly sizeM: number;
  constructor(sizeM: number) {
    this.sizeM = sizeM;
  }
  add(item: number, x0: number, z0: number, x1: number, z1: number): void {
    const s = this.sizeM;
    for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) {
      for (let j = Math.floor(z0 / s); j <= Math.floor(z1 / s); j++) {
        const key = `${i},${j}`;
        const list = this.cells.get(key);
        if (list) list.push(item);
        else this.cells.set(key, [item]);
      }
    }
  }
  /** Items whose boxes may touch the box; each once, ascending. */
  near(x0: number, z0: number, x1: number, z1: number, out: number[]): number[] {
    out.length = 0;
    const s = this.sizeM;
    for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) {
      for (let j = Math.floor(z0 / s); j <= Math.floor(z1 / s); j++) {
        const list = this.cells.get(`${i},${j}`);
        if (list) for (const v of list) out.push(v);
      }
    }
    out.sort((a, b) => a - b);
    let k = 0;
    for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[i - 1]) out[k++] = out[i]!;
    out.length = k;
    return out;
  }
}

/**
 * Plots along `lines` (each a flat list of x z pairs on a plane, metres). Lines in order; per line the left side, then
 * the right (left of the direction of travel: (−dz, dx)); a walk from the start of the line. Width and depth of the
 * next plot come from `hashInts(seed, line, side, k)` (k counts the tries on that side) within `frontM` and `depthM`.
 * The middle of its front edge lies `setbackM` from the centre line at the middle of its width, and the rectangle is
 * squared to the line's direction there. It is kept when it is at least `gapM` from every plot kept so far, no line
 * passes nearer than `setbackM` − 1 mm to it, and `blocked` is false at its centre and four corners; the walk then
 * moves on by its width plus `gapM`, else by 2 m. At most 4096 plots.
 */
export function plotsAlong(lines: readonly ArrayLike<number>[], o: PlotOptions): Plot[] {
  const walks = lines.map(walkOf);
  const maxDepth = Math.max(o.depthM[0], o.depthM[1]);
  const maxFront = Math.max(o.frontM[0], o.frontM[1]);
  const bucketM = Math.max(8, maxFront + maxDepth);
  // Segments of every line in a bucket grid.
  const segs: number[] = [];
  const segBuckets = new Buckets(bucketM);
  for (const w of walks) {
    const n = w.along.length;
    for (let i = 0; i + 1 < n; i++) {
      const ax = w.points[2 * i]!;
      const az = w.points[2 * i + 1]!;
      const bx = w.points[2 * i + 2]!;
      const bz = w.points[2 * i + 3]!;
      segBuckets.add(segs.length / 4, Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz));
      segs.push(ax, az, bx, bz);
    }
  }
  const plots: Plot[] = [];
  const corners: Float64Array[] = [];
  const plotBuckets = new Buckets(bucketM);
  const at = new Float64Array(4);
  const c = new Float64Array(8);
  const near: number[] = [];
  const limit2 = Math.max(0, o.setbackM - SETBACK_TOLERANCE_M) ** 2;
  for (let line = 0; line < walks.length && plots.length < MAX_PLOTS; line++) {
    const w = walks[line]!;
    if (w.length <= 0) continue;
    for (let side = 0; side < 2 && plots.length < MAX_PLOTS; side++) {
      const sign = side === 0 ? 1 : -1;
      let t = 0;
      for (let k = 0; plots.length < MAX_PLOTS; k++) {
        const h = hashInts(o.seed, line, side, k) >>> 0;
        const width = o.frontM[0] + (o.frontM[1] - o.frontM[0]) * ((h & 0xffff) / 65535);
        const depth = o.depthM[0] + (o.depthM[1] - o.depthM[0]) * ((h >>> 16) / 65535);
        if (t + width > w.length) break;
        walkAt(w, t + width / 2, at);
        const ux = at[2]!;
        const uz = at[3]!;
        // Outward normal of this side.
        const nx = -uz * sign;
        const nz = ux * sign;
        const cx = at[0]! + nx * (o.setbackM + depth / 2);
        const cz = at[1]! + nz * (o.setbackM + depth / 2);
        cornersOf(cx, cz, ux, uz, width / 2, depth / 2, c);
        let x0 = Infinity;
        let z0 = Infinity;
        let x1 = -Infinity;
        let z1 = -Infinity;
        for (let q = 0; q < 4; q++) {
          x0 = Math.min(x0, c[2 * q]!);
          x1 = Math.max(x1, c[2 * q]!);
          z0 = Math.min(z0, c[2 * q + 1]!);
          z1 = Math.max(z1, c[2 * q + 1]!);
        }
        let ok = true;
        if (o.blocked) {
          ok = !o.blocked(cx, cz);
          for (let q = 0; q < 4 && ok; q++) ok = !o.blocked(c[2 * q]!, c[2 * q + 1]!);
        }
        if (ok) {
          const m = o.setbackM;
          for (const s of segBuckets.near(x0 - m, z0 - m, x1 + m, z1 + m, near)) {
            if (segmentRect2(segs[4 * s]!, segs[4 * s + 1]!, segs[4 * s + 2]!, segs[4 * s + 3]!, c) < limit2) {
              ok = false;
              break;
            }
          }
        }
        if (ok) {
          const g = o.gapM;
          for (const p of plotBuckets.near(x0 - g, z0 - g, x1 + g, z1 + g, near)) {
            if (!apart(corners[p]!, c, g)) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) {
          t += DROP_STEP_M;
          continue;
        }
        const id = plots.length;
        plots.push({ id, x: cx, z: cz, hx: -nx, hz: -nz, widthM: width, depthM: depth, line });
        corners.push(Float64Array.from(c));
        plotBuckets.add(id, x0, z0, x1, z1);
        t += width + o.gapM;
      }
    }
  }
  return plots;
}
