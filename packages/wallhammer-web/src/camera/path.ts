// A camera path for the orbit rig: keyframes of the orbit state (target, yaw, pitch, distance) at times in seconds,
// sampled as a smooth curve. Each channel is a cubic Hermite curve through the keys with Catmull-Rom tangents for
// uneven key spacing (the mean of the slopes to both neighbours, per second), so the velocity is continuous at every
// key. The yaw takes the shorter way round between neighbouring keys, the distance is interpolated in log space (equal
// zoom factors take equal time and it never reaches zero). An open path starts and ends at rest; a looping path closes
// from its last key back to its first, with the same smoothness at the seam. Sampling writes into a state the caller
// owns and allocates nothing.

import { DEG, clamp } from '../base/math.ts';
import type { Vec3 } from '../base/math.ts';
import type { OrbitState, PerspectiveOrbitRig } from './orbit.ts';

/** One key of an orbit path: the orbit state at a time. */
export interface OrbitKey extends OrbitState {
  /** Time of the key in seconds from the start of the path. */
  t: number;
}

export interface OrbitPathOptions {
  /** True: the path repeats with the period `duration`, closing from the last key back to the first. Default false. */
  loop?: boolean;
  /**
   * Length of the path in seconds. A looping path needs it to be later than the last key (the time of the closing
   * segment is `duration` minus the last key time); default: the last key time plus the mean key spacing. An open path
   * always ends at its last key and ignores it.
   */
  duration?: number;
}

/** Channels per key: target x, y, z, yaw (degrees, unwrapped), pitch (degrees), log of the distance. */
const CH = 6;

export class OrbitPath {
  readonly keys: readonly OrbitKey[];
  readonly loop: boolean;
  /** Seconds from the first key time (0 at the start of the path) to its end, or to where a loop repeats. */
  readonly duration: number;
  /** Key times, with one extra key at `duration` for a loop (the first key again). */
  private readonly times: Float64Array;
  /** Channel values and tangents (per second) per key, `CH` numbers per key. */
  private readonly values: Float64Array;
  private readonly slopes: Float64Array;
  /** One sample's channels, reused. */
  private readonly channels = new Float64Array(CH);
  private readonly scratch: OrbitState = { target: [0, 0, 0], yawDeg: 0, pitchDeg: 0, distance: 1 };

  constructor(keys: readonly OrbitKey[], options: OrbitPathOptions = {}) {
    if (keys.length < 1) throw new Error('OrbitPath: needs at least one key');
    for (let i = 1; i < keys.length; i++) if (!(keys[i]!.t > keys[i - 1]!.t)) throw new Error(`OrbitPath: key times must increase (key ${i})`);
    this.keys = keys.map((k) => ({ ...k, target: [...k.target] as Vec3 }));
    this.loop = options.loop ?? false;
    const t0 = keys[0]!.t;
    const last = keys[keys.length - 1]!.t;
    const meanGap = keys.length > 1 ? (last - t0) / (keys.length - 1) : 1;
    if (this.loop) {
      const end = options.duration !== undefined ? t0 + options.duration : last + meanGap;
      if (!(end > last)) throw new Error('OrbitPath: a looping path needs a duration beyond its last key');
      this.duration = end - t0;
    } else this.duration = last - t0;

    // A loop gets the first key again at its end; its yaw continues from the last key.
    const n = keys.length + (this.loop ? 1 : 0);
    this.times = new Float64Array(n);
    this.values = new Float64Array(n * CH);
    this.slopes = new Float64Array(n * CH);
    for (let i = 0; i < n; i++) {
      const k = keys[i % keys.length]!;
      this.times[i] = i < keys.length ? k.t - t0 : this.duration;
      const v = i * CH;
      this.values[v] = k.target[0];
      this.values[v + 1] = k.target[1];
      this.values[v + 2] = k.target[2];
      // Shortest way round from the previous key: unwrap into ±180° of it.
      const prev = i > 0 ? this.values[v - CH + 3]! : k.yawDeg;
      this.values[v + 3] = prev + wrapDeg(k.yawDeg - prev);
      this.values[v + 4] = k.pitchDeg;
      this.values[v + 5] = Math.log(Math.max(1e-6, k.distance));
    }
    // Turns of the yaw over one loop (a multiple of 360°): the neighbour before the first key is the last one, less it.
    const turn = this.loop ? this.values[(n - 1) * CH + 3]! - this.values[3]! : 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < CH; c++) {
        let slope = 0;
        if (n > 1) {
          const lo = i > 0 ? i - 1 : this.loop ? n - 2 : -1;
          const hi = i < n - 1 ? i + 1 : this.loop ? 1 : -1;
          // An open path rests at its ends.
          if (lo >= 0 && hi >= 0) {
            const tLo = i > 0 ? this.times[lo]! : this.times[lo]! - this.duration;
            const tHi = i < n - 1 ? this.times[hi]! : this.times[hi]! + this.duration;
            let vLo = this.values[lo * CH + c]!;
            let vHi = this.values[hi * CH + c]!;
            if (c === 3 && i === 0) vLo -= turn;
            if (c === 3 && i === n - 1) vHi += turn;
            const vi = this.values[i * CH + c]!;
            slope = ((vi - vLo) / (this.times[i]! - tLo) + (vHi - vi) / (tHi - this.times[i]!)) / 2;
          }
        }
        this.slopes[i * CH + c] = slope;
      }
    }
  }

  /** A time folded into the path: modulo `duration` for a loop, clamped to `0 … duration` otherwise. */
  wrap(t: number): number {
    if (!this.loop) return clamp(t, 0, this.duration);
    const d = this.duration;
    return d > 0 ? t - Math.floor(t / d) * d : 0;
  }

  /** The state at time `t` (seconds from the start), written into `out`, which is returned. */
  sample(t: number, out: OrbitState): OrbitState {
    const times = this.times;
    const n = times.length;
    const tt = this.wrap(t);
    // The segment: the last key at or before the time (binary search, at most n − 2).
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= tt) lo = mid;
      else hi = mid;
    }
    const a = lo * CH;
    const vs = this.values;
    const ss = this.slopes;
    if (n === 1) {
      out.target[0] = vs[0]!;
      out.target[1] = vs[1]!;
      out.target[2] = vs[2]!;
      out.yawDeg = vs[3]!;
      out.pitchDeg = vs[4]!;
      out.distance = Math.exp(vs[5]!);
      return out;
    }
    const b = hi * CH;
    const h = times[hi]! - times[lo]!;
    const x = clamp((tt - times[lo]!) / h, 0, 1);
    const x2 = x * x;
    const x3 = x2 * x;
    const h00 = 2 * x3 - 3 * x2 + 1;
    const h10 = x3 - 2 * x2 + x;
    const h01 = -2 * x3 + 3 * x2;
    const h11 = x3 - x2;
    const r = this.channels;
    for (let c = 0; c < CH; c++) r[c] = h00 * vs[a + c]! + h10 * h * ss[a + c]! + h01 * vs[b + c]! + h11 * h * ss[b + c]!;
    out.target[0] = r[0]!;
    out.target[1] = r[1]!;
    out.target[2] = r[2]!;
    out.yawDeg = r[3]!;
    out.pitchDeg = r[4]!;
    out.distance = Math.exp(r[5]!);
    return out;
  }

  /** Samples the path at `t` and writes it into the rig in place (see `writeOrbitState`). */
  apply(rig: PerspectiveOrbitRig, t: number): void {
    writeOrbitState(rig, this.sample(t, this.scratch));
  }
}

/** An angle in degrees folded into −180 … 180. */
function wrapDeg(d: number): number {
  return d - 360 * Math.round(d / 360);
}

/**
 * Writes a state into an orbit rig without allocating: the target is copied into the rig's own array, pitch and
 * distance are clamped to the rig's setup as `setState` does.
 */
export function writeOrbitState(rig: PerspectiveOrbitRig, s: OrbitState): void {
  rig.target[0] = s.target[0];
  rig.target[1] = s.target[1];
  rig.target[2] = s.target[2];
  rig.yaw = s.yawDeg * DEG;
  rig.pitch = clamp(s.pitchDeg, rig.setup.minPitchDeg, rig.setup.maxPitchDeg) * DEG;
  rig.distance = clamp(s.distance, rig.setup.minDistance, rig.setup.maxDistance);
}

/**
 * Between two orbit states at `x` (0: `a`, 1: `b`), written into `out`: the target and pitch linearly, the yaw the
 * shorter way round, the distance in log space. For blending from a free view into a path and back. `out` may be `a`
 * or `b`.
 */
export function blendOrbitState(a: OrbitState, b: OrbitState, x: number, out: OrbitState): OrbitState {
  const ax = a.target[0], ay = a.target[1], az = a.target[2];
  const yaw = a.yawDeg + wrapDeg(b.yawDeg - a.yawDeg) * x;
  const pitch = a.pitchDeg + (b.pitchDeg - a.pitchDeg) * x;
  const distance = Math.exp(Math.log(Math.max(1e-6, a.distance)) * (1 - x) + Math.log(Math.max(1e-6, b.distance)) * x);
  out.target[0] = ax + (b.target[0] - ax) * x;
  out.target[1] = ay + (b.target[1] - ay) * x;
  out.target[2] = az + (b.target[2] - az) * x;
  out.yawDeg = yaw;
  out.pitchDeg = pitch;
  out.distance = distance;
  return out;
}
