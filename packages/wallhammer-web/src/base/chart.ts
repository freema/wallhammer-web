// A local chart of a sphere: flat coordinates (x, y, z) near a point of the sphere, so code written for a flat world
// with +y up (a collision world, a walker, a following view) can run on a curved one. The chart is anchored at a unit
// direction `anchor` from the sphere's centre; x and z run along the sphere from there, y is the height above the
// reference radius.
//
// The map is the exponential map of the sphere: the chart point (x, z) lies on the great circle that leaves the anchor
// in the direction x · frame.x + z · frame.z, at the arc length √(x² + z²) measured on the reference sphere. Chart y
// is exact: a point at chart height y is (radius + y) from the centre, so a height function of the sphere becomes a
// height function of the chart without error. In the plane the chart is exact along every line through its origin and
// stretched by about θ² / 6 across them (θ: the angle from the anchor), so lengths and angles are right to first
// order. It is meant for a sphere whose radius is much larger than the distance from the chart's origin a mover is
// allowed before it is given a new chart (a "rechart"): at 48 m on a sphere of 2 km the error across is 1e-4.
//
// Vectors (headings, velocities, view axes) map by the rotation that takes the anchor to the direction of the point
// along that great circle, so the local up at a chart point is always the radial up and the tangent frame is carried
// along the circle without turning.
//
// Only + − × ÷, Math.sqrt and the reproducible trigonometry of `trig.ts`: the same input gives the same bits on every
// machine, as a walker that steps through a chart needs.

import type { Mat34 } from './mat34.ts';
import { detAtan2, detSinCos } from './trig.ts';
import { squareToUp, upFrame } from './up.ts';
import type { UpFrame } from './up.ts';

/** Three numbers to write into. */
type Out3 = { [index: number]: number };

/** Scratch of the map at one chart point: the direction, the unit chart direction in the world and sin θ, cos θ. */
interface Rot {
  /** Unit world direction of the chart point from the centre. */
  dx: number;
  dy: number;
  dz: number;
  /** Unit world direction the great circle leaves the anchor in (0 at the origin). */
  ex: number;
  ey: number;
  ez: number;
  s: number;
  /** cos θ − 1, kept apart so a small angle keeps its digits. */
  cm1: number;
}

export class SurfaceChart {
  /** Centre of the sphere in world metres. */
  readonly center: readonly [number, number, number];
  /** Reference radius: chart y is the height above it. */
  readonly radiusM: number;
  /** Unit direction from the centre to the chart's origin. */
  readonly anchor: readonly [number, number, number];
  /** The chart's axes at its origin as world directions: `x` and `z` span the horizon, `y` is the anchor. */
  readonly frame: UpFrame;
  private readonly rot: Rot = { dx: 0, dy: 0, dz: 0, ex: 0, ey: 0, ez: 0, s: 0, cm1: 0 };
  private readonly sc: [number, number] = [0, 0];
  private readonly tmp: [number, number, number] = [0, 0, 0];

  /**
   * A chart of the sphere of `radiusM` round `center`, anchored at the direction `anchor` (any length but zero; it is
   * made a unit vector). `xAxis` sets the chart's x axis (its part along the anchor is dropped); without it (or with one
   * along the anchor) the axes are those of `upFrame(anchor)`, except within 1e-5 of −y, where `upFrame`'s fixed x is
   * made square to the anchor. The z axis is always x × anchor, so the frame is orthonormal and right-handed like the
   * world's for every anchor.
   */
  constructor(center: readonly [number, number, number], radiusM: number, anchor: readonly [number, number, number], xAxis?: readonly [number, number, number]) {
    if (!(radiusM > 0)) throw new Error(`SurfaceChart: radius must be positive, got ${radiusM}`);
    const l = Math.sqrt(anchor[0] * anchor[0] + anchor[1] * anchor[1] + anchor[2] * anchor[2]);
    if (!(l > 0) || !Number.isFinite(l)) throw new Error('SurfaceChart: the anchor must be a finite direction');
    this.center = [center[0], center[1], center[2]];
    this.radiusM = radiusM;
    const a: [number, number, number] = [anchor[0] / l, anchor[1] / l, anchor[2] / l];
    this.anchor = a;
    let x: readonly number[] | null = null;
    if (xAxis) {
      const k = xAxis[0] * a[0] + xAxis[1] * a[1] + xAxis[2] * a[2];
      const h = [xAxis[0] - a[0] * k, xAxis[1] - a[1] * k, xAxis[2] - a[2] * k];
      const m = Math.sqrt(h[0]! * h[0]! + h[1]! * h[1]! + h[2]! * h[2]!);
      if (m > 1e-12) x = [h[0]! / m, h[1]! / m, h[2]! / m];
    }
    this.frame = frameOf(a, x ?? squareX(a));
  }

  /**
   * The chart with exactly this anchor and x axis, taken as they are (a chart's own `anchor` and `frame.x`, saved):
   * the same chart bit for bit, which normalising them again would not promise.
   */
  static exact(center: readonly [number, number, number], radiusM: number, anchor: readonly [number, number, number], xAxis: readonly [number, number, number]): SurfaceChart {
    const c = new SurfaceChart(center, radiusM, anchor);
    const self = c as unknown as { anchor: readonly number[]; frame: UpFrame };
    self.anchor = [anchor[0], anchor[1], anchor[2]];
    self.frame = frameOf(self.anchor, xAxis);
    return c;
  }

  /** A chart of the same sphere anchored at the direction of a world point (the point must not be the centre). */
  static at(center: readonly [number, number, number], radiusM: number, point: readonly [number, number, number]): SurfaceChart {
    return new SurfaceChart(center, radiusM, [point[0] - center[0], point[1] - center[1], point[2] - center[2]]);
  }

  /**
   * A chart anchored at this chart's point (x, z), with this chart's axes carried there along the great circle (the
   * frame of `vectorToWorld` at that point). A direction has nearly the same chart numbers in both, so a heading or an
   * input does not turn when a mover is given the new chart; and the axes never pass through the turn `upFrame` makes
   * opposite to +y.
   */
  moved(x: number, z: number): SurfaceChart {
    const r = this.place(x, z);
    const fx = this.frame.x;
    const t = this.turn(r, fx[0], fx[1], fx[2], 1, [0, 0, 0] as [number, number, number]);
    return new SurfaceChart(this.center, this.radiusM, [r.dx, r.dy, r.dz], t);
  }

  /** Fills `rot` for the chart point (x, z). */
  private place(x: number, z: number): Rot {
    const r = this.rot;
    const f = this.frame;
    const a = this.anchor;
    const rho = Math.sqrt(x * x + z * z);
    if (!(rho > 0)) {
      r.dx = a[0];
      r.dy = a[1];
      r.dz = a[2];
      r.ex = r.ey = r.ez = 0;
      r.s = 0;
      r.cm1 = 0;
      return r;
    }
    const ux = x / rho;
    const uz = z / rho;
    r.ex = f.x[0] * ux + f.z[0] * uz;
    r.ey = f.x[1] * ux + f.z[1] * uz;
    r.ez = f.x[2] * ux + f.z[2] * uz;
    const theta = rho / this.radiusM;
    const sc = detSinCos(theta, this.sc);
    const s = sc[0];
    const c = sc[1];
    // cos θ − 1 = −2 sin²(θ/2) keeps its digits for a small angle, where 1 − cos θ would round to a few bits.
    const h = detSinCos(theta * 0.5, this.sc)[0];
    r.s = s;
    r.cm1 = -2 * h * h;
    r.dx = a[0] * c + r.ex * s;
    r.dy = a[1] * c + r.ey * s;
    r.dz = a[2] * c + r.ez * s;
    return r;
  }

  /** Unit world direction from the centre to the chart point (x, z): the local up there. Written to `out`. */
  upAt<T extends Out3>(x: number, z: number, out: T): T {
    const r = this.place(x, z);
    out[0] = r.dx;
    out[1] = r.dy;
    out[2] = r.dz;
    return out;
  }

  /** World point of the chart point (x, y, z), written to `out`. */
  toWorld<T extends Out3>(x: number, y: number, z: number, out: T): T {
    const r = this.place(x, z);
    const k = this.radiusM + y;
    const c = this.center;
    out[0] = c[0] + r.dx * k;
    out[1] = c[1] + r.dy * k;
    out[2] = c[2] + r.dz * k;
    return out;
  }

  /**
   * Chart point (x, y, z) of a world point, written to `out`. The centre itself has no chart point (gives 0, −radius,
   * 0). The point straight opposite the anchor (the antipode) is π · radius from the origin along every direction; it
   * gives (π · radius, y, 0), on the chart's +x axis, so it is never taken for a point near the origin.
   */
  fromWorld<T extends Out3>(px: number, py: number, pz: number, out: T): T {
    const c = this.center;
    const f = this.frame;
    const vx = px - c[0];
    const vy = py - c[1];
    const vz = pz - c[2];
    const along = vx * f.y[0] + vy * f.y[1] + vz * f.y[2];
    const cx = vx * f.x[0] + vy * f.x[1] + vz * f.x[2];
    const cz = vx * f.z[0] + vy * f.z[1] + vz * f.z[2];
    const h = Math.sqrt(cx * cx + cz * cz);
    const r = Math.sqrt(vx * vx + vy * vy + vz * vz);
    out[1] = r - this.radiusM;
    if (!(h > 0)) {
      // On the anchor's line: the origin, or straight opposite it, π · radius away along every great circle; that point
      // is put on the chart's +x axis (where `toWorld` maps it back), never at the origin.
      out[0] = along < 0 ? Math.PI * this.radiusM : 0;
      out[2] = 0;
      return out;
    }
    const k = (detAtan2(h, along) * this.radiusM) / h;
    out[0] = cx * k;
    out[2] = cz * k;
    return out;
  }

  /**
   * A chart vector at the chart point (x, z) as a world vector, written to `out`: the chart's x and z go along the
   * horizon there, y along the local up. Lengths are kept (a rotation).
   */
  vectorToWorld<T extends Out3>(x: number, z: number, vx: number, vy: number, vz: number, out: T): T {
    const f = this.frame;
    const wx = f.x[0] * vx + f.y[0] * vy + f.z[0] * vz;
    const wy = f.x[1] * vx + f.y[1] * vy + f.z[1] * vz;
    const wz = f.x[2] * vx + f.y[2] * vy + f.z[2] * vz;
    return this.turn(this.place(x, z), wx, wy, wz, 1, out);
  }

  /** A world vector at the chart point (x, z) as a chart vector, written to `out`: the inverse of `vectorToWorld`. */
  vectorFromWorld<T extends Out3>(x: number, z: number, wx: number, wy: number, wz: number, out: T): T {
    const f = this.frame;
    const t = this.turn(this.place(x, z), wx, wy, wz, -1, this.tmp);
    out[0] = f.x[0] * t[0] + f.x[1] * t[1] + f.x[2] * t[2];
    out[1] = f.y[0] * t[0] + f.y[1] * t[1] + f.y[2] * t[2];
    out[2] = f.z[0] * t[0] + f.z[1] * t[1] + f.z[2] * t[2];
    return out;
  }

  /**
   * Turns a world vector by the rotation of the chart point in `r` (`sign` 1) or by its inverse (−1): the rotation in
   * the plane of the anchor a and the unit direction e by θ, w' = w + (w·a)((cos θ − 1) a ± sin θ e) + (w·e)(∓sin θ a +
   * (cos θ − 1) e).
   */
  private turn<T extends Out3>(r: Rot, wx: number, wy: number, wz: number, sign: number, out: T): T {
    const a = this.anchor;
    const wa = wx * a[0] + wy * a[1] + wz * a[2];
    const we = wx * r.ex + wy * r.ey + wz * r.ez;
    const s = r.s * sign;
    const cm1 = r.cm1;
    const ka = wa * cm1 - we * s;
    const ke = wa * s + we * cm1;
    out[0] = wx + ka * a[0] + ke * r.ex;
    out[1] = wy + ka * a[1] + ke * r.ey;
    out[2] = wz + ka * a[2] + ke * r.ez;
    return out;
  }

  /**
   * The local frame at the chart point (x, y, z) as a 3 × 4 matrix (columns: the chart's x, y and z turned to that
   * point, then the world point less `origin`), so a shape modelled for a flat world with +y up is stood on the sphere
   * there. `origin` is a render origin (default the world origin); the subtraction is done in double precision.
   */
  frameAt<T extends Mat34>(x: number, y: number, z: number, out: T, origin?: readonly [number, number, number]): T {
    const f = this.frame;
    const r = this.place(x, z);
    const t = this.tmp;
    for (let col = 0; col < 3; col++) {
      const v = col === 0 ? f.x : col === 1 ? f.y : f.z;
      this.turn(r, v[0], v[1], v[2], 1, t);
      out[col * 3] = t[0];
      out[col * 3 + 1] = t[1];
      out[col * 3 + 2] = t[2];
    }
    const k = this.radiusM + y;
    const c = this.center;
    const o = origin ?? ZERO;
    out[9] = c[0] - o[0] + r.dx * k;
    out[10] = c[1] - o[1] + r.dy * k;
    out[11] = c[2] - o[2] + r.dz * k;
    return out;
  }
}

const ZERO = [0, 0, 0] as const;

/**
 * The x axis of `upFrame(a)` made square to the unit `a`. `upFrame` is exact except within 1e-5 of −y, where it gives
 * the world's +x whatever `a` leans to: there (any x off square by more than 1e-12) the part along `a` is dropped and
 * the rest made a unit vector, so the frame stays orthonormal for every anchor. Elsewhere x is taken as it is.
 */
function squareX(a: readonly number[]): readonly number[] {
  return squareToUp(a, upFrame([a[0]!, a[1]!, a[2]!]).x);
}

/** The frame with up `a` and x axis `x` (both unit, square to each other); z = x × a. */
function frameOf(a: readonly number[], x: readonly number[]): UpFrame {
  const x0 = x[0]!, x1 = x[1]!, x2 = x[2]!;
  const a0 = a[0]!, a1 = a[1]!, a2 = a[2]!;
  return { x: [x0, x1, x2], y: [a0, a1, a2], z: [x1 * a2 - x2 * a1, x2 * a0 - x0 * a2, x0 * a1 - x1 * a0] };
}
