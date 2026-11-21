// A camera path for the free rig: keyframes of an eye position (world metres, double precision) and an aim at times in
// seconds, sampled as a smooth curve. The aim of a key is a point to look at or a heading and pitch in the local
// horizon (the convention of `FreeRig`: heading from the world −z axis laid into the horizon, positive turns left;
// pitch positive looks down). Up comes from a caller's up source, a function or one vector, so the same path serves a
// sphere and a flat world. Every channel (eye, look point, heading, pitch, roll, field of view) is a cubic Hermite
// curve with Catmull-Rom tangents for uneven key spacing, as in `OrbitPath`, so the velocity is continuous at every key
// inside a group. A key marked `cut` starts a new group: nothing is interpolated across it. A segment between two
// look keys follows the look point (a tracking shot keeps its target in the middle); any other segment turns by the
// heading and pitch. Sampling is a pure function of the time; it writes into a pose the caller owns.

import { DEG, clamp, cross, dot, normalize } from '../base/math.ts';
import type { Vec3 } from '../base/math.ts';
import type { WorldPos } from '../gen-core/index.ts';
import { horizonRef } from './free.ts';
import type { FreeRig, UpSource } from './free.ts';

/** How the segment from a key to the next one moves. */
export type FreePathEase = 'smooth' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';

/** One key of a free path. Give the aim either as `look` or as `yawDeg` and `pitchDeg`. */
export interface FreeKey {
  /** Time of the key in seconds from the start of the path (the first key's time). */
  t: number;
  /** World position of the eye in metres (double precision). */
  eye: WorldPos;
  /** A world point the view looks at. */
  look?: WorldPos;
  /** Heading in degrees in the local horizon at `eye` (as `FreeRig`); used when `look` is missing. Default 0. */
  yawDeg?: number;
  /** Pitch in degrees, positive looks down; used when `look` is missing. Default 0. */
  pitchDeg?: number;
  /** Roll about the view direction in degrees, positive banks to the right. Default 0. */
  rollDeg?: number;
  /** Vertical field of view in degrees. Default `FreePathOptions.fovYDeg`. */
  fovYDeg?: number;
  /**
   * The segment from this key to the next: 'smooth' (default, Catmull-Rom), 'linear' (straight at a constant rate,
   * corners at its keys), 'ease-in' (starts from rest), 'ease-out' (comes to rest), 'ease-in-out' (both). A rest
   * holds for both segments that meet at the key, so the velocity stays continuous.
   */
  ease?: FreePathEase;
  /**
   * A cut: the path jumps to this key at its time and nothing is interpolated from the key before. Its time may equal
   * the previous key's time. Until then the group before holds its last key.
   */
  cut?: boolean;
}

/** Where up is: an up source (a `WorldShape`), a function of the world position, or one vector everywhere. */
export type FreePathUp = UpSource | ((p: WorldPos) => Vec3) | readonly [number, number, number];

export interface FreePathOptions {
  /** Up at a world position. Default +y everywhere. */
  up?: FreePathUp;
  /** Field of view of keys that do not state one, in degrees. Default 50. */
  fovYDeg?: number;
  /**
   * True (default): every group starts and ends at rest, as `OrbitPath` does. False: the ends of a group keep the
   * velocity of their segment (a shot that starts and ends moving); `ease` still rests where it asks.
   */
  endsAtRest?: boolean;
}

/** One sample of a free path: the eye and the view's axes in world space. */
export interface FreePose {
  /** World position of the eye in metres. */
  eye: Vec3;
  /** Unit view direction. */
  forward: Vec3;
  /** Unit screen up and screen right, after the roll. */
  up: Vec3;
  right: Vec3;
  /** Unit local up at the eye (from the path's up). */
  localUp: Vec3;
  fovYDeg: number;
  rollDeg: number;
  /** Index of the group (0 before the first cut, 1 after it, …). */
  group: number;
}

/** A pose to sample into. */
export function newFreePose(): FreePose {
  return { eye: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0], right: [1, 0, 0], localUp: [0, 1, 0], fovYDeg: 50, rollDeg: 0, group: 0 };
}

/** Channels per key: eye x, y, z, look x, y, z (NaN without a look point), yaw (unwrapped), pitch, roll, fov. */
const CH = 10;
const EYE = 0;
const LOOK = 3;
const YAW = 6;
const PITCH = 7;
const ROLL = 8;
const FOV = 9;

interface Group {
  /** Index of the first and one past the last key. */
  from: number;
  to: number;
}

export class FreePath {
  readonly keys: readonly FreeKey[];
  /** Seconds from the first key time to the last. */
  readonly duration: number;
  /** Times (relative to the first key) at which a group starts: 0 and every cut. */
  readonly cuts: readonly number[];
  private readonly upAt: (p: WorldPos) => Vec3;
  private readonly times: Float64Array;
  private readonly values: Float64Array;
  private readonly slopes: Float64Array;
  private readonly groups: Group[] = [];
  private readonly scratch = newFreePose();

  constructor(keys: readonly FreeKey[], options: FreePathOptions = {}) {
    if (keys.length < 1) throw new Error('FreePath: needs at least one key');
    for (let i = 1; i < keys.length; i++) {
      const k = keys[i]!;
      const prev = keys[i - 1]!.t;
      if (k.cut ? !(k.t >= prev) : !(k.t > prev)) throw new Error(`FreePath: key times must increase (key ${i}; a cut may repeat the time before it)`);
    }
    this.keys = keys.map((k) => ({ ...k, eye: [k.eye[0], k.eye[1], k.eye[2]] as WorldPos, ...(k.look ? { look: [k.look[0], k.look[1], k.look[2]] as WorldPos } : {}) }));
    const up = options.up;
    if (up === undefined) this.upAt = () => [0, 1, 0];
    else if (typeof up === 'function') this.upAt = (p) => normalize(up(p));
    else if ('upAt' in up) this.upAt = (p) => up.upAt(p);
    else {
      const u = normalize([up[0], up[1], up[2]]);
      this.upAt = () => [u[0], u[1], u[2]];
    }
    const fov = options.fovYDeg ?? 50;
    const endsAtRest = options.endsAtRest ?? true;
    const t0 = keys[0]!.t;
    const n = keys.length;
    this.duration = keys[n - 1]!.t - t0;
    this.times = new Float64Array(n);
    this.values = new Float64Array(n * CH);
    this.slopes = new Float64Array(n * CH);

    // Groups between cuts.
    let from = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || keys[i]!.cut) {
        this.groups.push({ from, to: i });
        from = i;
      }
    }
    this.cuts = this.groups.map((g) => keys[g.from]!.t - t0);

    for (let i = 0; i < n; i++) {
      const k = keys[i]!;
      this.times[i] = k.t - t0;
      const v = i * CH;
      const vs = this.values;
      vs[v + EYE] = k.eye[0];
      vs[v + EYE + 1] = k.eye[1];
      vs[v + EYE + 2] = k.eye[2];
      let yaw = k.yawDeg ?? 0;
      let pitch = k.pitchDeg ?? 0;
      if (k.look) {
        vs[v + LOOK] = k.look[0];
        vs[v + LOOK + 1] = k.look[1];
        vs[v + LOOK + 2] = k.look[2];
        const a = aimOf(k.eye, k.look, this.upAt(k.eye));
        yaw = a[0];
        pitch = a[1];
      } else vs[v + LOOK] = vs[v + LOOK + 1] = vs[v + LOOK + 2] = NaN;
      // The shorter way round from the previous key of the same group.
      const first = i === 0 || k.cut === true;
      const prevYaw = first ? yaw : vs[v - CH + YAW]!;
      vs[v + YAW] = first ? yaw : prevYaw + wrapDeg(yaw - prevYaw);
      vs[v + PITCH] = pitch;
      vs[v + ROLL] = k.rollDeg ?? 0;
      vs[v + FOV] = k.fovYDeg ?? fov;
    }

    // Tangents per group: Catmull-Rom inside, rest where an ease or the ends ask for it.
    for (const g of this.groups) {
      for (let i = g.from; i < g.to; i++) {
        const before = i > g.from ? keys[i - 1]!.ease ?? 'smooth' : null;
        const after = i < g.to - 1 ? keys[i]!.ease ?? 'smooth' : null;
        const end = before === null || after === null;
        const rest = (end && endsAtRest) || before === 'ease-out' || before === 'ease-in-out' || after === 'ease-in' || after === 'ease-in-out';
        for (let c = 0; c < CH; c++) {
          let slope = 0;
          const vi = this.values[i * CH + c]!;
          if (!rest && !Number.isNaN(vi)) {
            const lo = before !== null && !Number.isNaN(this.values[(i - 1) * CH + c]!) ? i - 1 : -1;
            const hi = after !== null && !Number.isNaN(this.values[(i + 1) * CH + c]!) ? i + 1 : -1;
            const s = (j: number): number => (this.values[j * CH + c]! - vi) / (this.times[j]! - this.times[i]!);
            if (lo >= 0 && hi >= 0) slope = (s(lo) + s(hi)) / 2;
            else if (lo >= 0) slope = s(lo);
            else if (hi >= 0) slope = s(hi);
          }
          this.slopes[i * CH + c] = slope;
        }
      }
    }
  }

  /** A time folded into the path: clamped to `0 … duration`. */
  wrap(t: number): number {
    return clamp(t, 0, this.duration);
  }

  /** Index of the group that is shown at time `t`. */
  group(t: number): number {
    const tt = this.wrap(t);
    let g = 0;
    while (g + 1 < this.groups.length && this.times[this.groups[g + 1]!.from]! <= tt) g++;
    return g;
  }

  /** The pose at time `t` (seconds from the start), written into `out`, which is returned. */
  sample(t: number, out: FreePose): FreePose {
    const tt = this.wrap(t);
    const gi = this.group(tt);
    const g = this.groups[gi]!;
    const times = this.times;
    const vs = this.values;
    const ss = this.slopes;
    out.group = gi;
    // The segment: the last key at or before the time within the group.
    let lo = g.from;
    let hi = g.to - 1;
    if (tt >= times[hi]!) lo = hi;
    else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid]! <= tt) lo = mid;
        else hi = mid;
      }
    }
    const a = lo * CH;
    let eye0: number, eye1: number, eye2: number, look0 = NaN, look1 = NaN, look2 = NaN, yaw: number, pitch: number, roll: number, fov: number;
    if (lo === g.to - 1) {
      // Past the group's last key (or a group of one key): hold it.
      eye0 = vs[a + EYE]!;
      eye1 = vs[a + EYE + 1]!;
      eye2 = vs[a + EYE + 2]!;
      look0 = vs[a + LOOK]!;
      look1 = vs[a + LOOK + 1]!;
      look2 = vs[a + LOOK + 2]!;
      yaw = vs[a + YAW]!;
      pitch = vs[a + PITCH]!;
      roll = vs[a + ROLL]!;
      fov = vs[a + FOV]!;
    } else {
      const b = (lo + 1) * CH;
      const h = times[lo + 1]! - times[lo]!;
      const x = clamp((tt - times[lo]!) / h, 0, 1);
      const linear = (this.keys[lo]!.ease ?? 'smooth') === 'linear';
      const x2 = x * x;
      const x3 = x2 * x;
      const h00 = linear ? 1 - x : 2 * x3 - 3 * x2 + 1;
      const h10 = linear ? 0 : x3 - 2 * x2 + x;
      const h01 = linear ? x : -2 * x3 + 3 * x2;
      const h11 = linear ? 0 : x3 - x2;
      const ch = (c: number): number => h00 * vs[a + c]! + h10 * h * ss[a + c]! + h01 * vs[b + c]! + h11 * h * ss[b + c]!;
      eye0 = ch(EYE);
      eye1 = ch(EYE + 1);
      eye2 = ch(EYE + 2);
      // A look point only between two look keys.
      if (!Number.isNaN(vs[a + LOOK]!) && !Number.isNaN(vs[b + LOOK]!)) {
        look0 = ch(LOOK);
        look1 = ch(LOOK + 1);
        look2 = ch(LOOK + 2);
      }
      yaw = ch(YAW);
      pitch = ch(PITCH);
      roll = ch(ROLL);
      fov = ch(FOV);
    }
    out.eye[0] = eye0;
    out.eye[1] = eye1;
    out.eye[2] = eye2;
    const up = this.upAt(out.eye);
    out.localUp[0] = up[0];
    out.localUp[1] = up[1];
    out.localUp[2] = up[2];
    const [ahead, left] = horizonRef(up);
    const cy = Math.cos(yaw * DEG);
    const sy = Math.sin(yaw * DEG);
    // The heading in the horizon: the fallback for screen right when the view runs along up.
    let tan: Vec3 = [ahead[0] * cy + left[0] * sy, ahead[1] * cy + left[1] * sy, ahead[2] * cy + left[2] * sy];
    let f: Vec3;
    if (!Number.isNaN(look0)) {
      f = [look0 - eye0, look1 - eye1, look2 - eye2];
      const l = Math.hypot(f[0], f[1], f[2]);
      if (l > 1e-9) {
        f = [f[0] / l, f[1] / l, f[2] / l];
        const rise = dot(f, up);
        const hz: Vec3 = [f[0] - up[0] * rise, f[1] - up[1] * rise, f[2] - up[2] * rise];
        if (hz[0] * hz[0] + hz[1] * hz[1] + hz[2] * hz[2] > 1e-12) tan = normalize(hz);
      } else f = forwardOf(tan, up, pitch);
    } else f = forwardOf(tan, up, pitch);
    const right0 = normalize(cross(tan, up));
    const up0 = normalize(cross(right0, f));
    // Screen right again from the view direction, so the axes stay at right angles when the view is pitched.
    const r0 = cross(f, up0);
    const cr = Math.cos(roll * DEG);
    const sr = Math.sin(roll * DEG);
    out.forward[0] = f[0];
    out.forward[1] = f[1];
    out.forward[2] = f[2];
    for (let i = 0; i < 3; i++) {
      out.right[i] = r0[i]! * cr - up0[i]! * sr;
      out.up[i] = up0[i]! * cr + r0[i]! * sr;
    }
    out.fovYDeg = fov;
    out.rollDeg = roll;
    return out;
  }

  /**
   * Poses ahead of `t`: at `t`, `t + step`, … up to `t + horizon` (not beyond the end of the path), new objects. For
   * preloading what the view will need (`preloadTickets` in `wallhammer-web/runtime`); the samples cross cuts.
   */
  ahead(t: number, horizonS: number, stepS: number): FreePose[] {
    if (!(stepS > 0)) throw new Error('FreePath.ahead: the step must be positive');
    const out: FreePose[] = [];
    const start = this.wrap(t);
    const end = Math.min(this.duration, start + Math.max(0, horizonS));
    for (let i = 0; ; i++) {
      const at = start + i * stepS;
      if (at > end + 1e-9) break;
      out.push(this.sample(at, newFreePose()));
    }
    // Cuts within the horizon: the first pose of every group that starts there.
    for (const c of this.cuts) if (c > start && c <= end && !out.some((p) => p.group === this.group(c))) out.push(this.sample(c, newFreePose()));
    return out;
  }

  /** Samples the path at `t` and writes it into a free rig (see `writeFreePose`). */
  apply(rig: FreeRig, t: number): void {
    writeFreePose(rig, this.sample(t, this.scratch));
  }
}

/** Heading and pitch in degrees of the view from `eye` to `look`, in the horizon of `up` (the convention of `FreeRig`). */
function aimOf(eye: WorldPos, look: WorldPos, up: Vec3): [number, number] {
  const d = normalize([look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]]);
  const rise = clamp(dot(d, up), -1, 1);
  const h: Vec3 = [d[0] - up[0] * rise, d[1] - up[1] * rise, d[2] - up[2] * rise];
  const [ahead, left] = horizonRef(up);
  const yaw = h[0] * h[0] + h[1] * h[1] + h[2] * h[2] > 1e-12 ? Math.atan2(dot(h, left), dot(h, ahead)) / DEG : 0;
  return [yaw, -Math.asin(rise) / DEG];
}

/** The view direction of a unit heading in the horizon pitched by `pitchDeg` (positive looks down). */
function forwardOf(tan: Vec3, up: Vec3, pitchDeg: number): Vec3 {
  const c = Math.cos(pitchDeg * DEG);
  const s = Math.sin(pitchDeg * DEG);
  return normalize([tan[0] * c - up[0] * s, tan[1] * c - up[1] * s, tan[2] * c - up[2] * s]);
}

function wrapDeg(d: number): number {
  return d - 360 * Math.round(d / 360);
}

/**
 * Writes a pose into a free rig: the position (the velocity is dropped and the rig's clearance applied, so keep
 * `minClearance` low for a path that goes close to the surface), the view direction, the roll and the field of view.
 * The rig's own up source should agree with the path's up.
 */
export function writeFreePose(rig: FreeRig, pose: FreePose): void {
  const p = rig.position;
  p[0] = pose.eye[0];
  p[1] = pose.eye[1];
  p[2] = pose.eye[2];
  rig.velocity[0] = rig.velocity[1] = rig.velocity[2] = 0;
  rig.keepClear();
  const q = rig.position;
  rig.lookAt([q[0] + pose.forward[0], q[1] + pose.forward[1], q[2] + pose.forward[2]]);
  rig.roll = pose.rollDeg * DEG;
  rig.setup.fovYDeg = pose.fovYDeg;
}
