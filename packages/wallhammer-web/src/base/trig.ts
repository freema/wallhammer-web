// Reproducible trigonometry. `Math.sin` and its relatives are not defined exactly by IEEE 754 or by the language, so
// two machines (or Node and a browser) may return results that differ in the last bit. Everything here is built only
// from + − × ÷, `Math.sqrt`, `Math.floor`, `Math.round` and `Math.abs`, which are exact, in a fixed order of
// operations, so the same input gives the same 64 bits everywhere. The accuracy is that of the usual library kernels
// (about one unit in the last place); the point is that the error is the same on every machine.
//
// Angles are best kept in turns (1 turn = 360°): the fractional part of a turn count is taken without any rounding,
// so an angle that grows with time (`phase + t / period`) keeps its precision however many turns have passed.

/** Radians in one turn (2π rounded to a double). */
export const RAD_PER_TURN = 6.283185307179586;

const TURN_PER_RAD = 0.15915494309189535;
const HALF_PI = 1.5707963267948966;
const PI = 3.141592653589793;
/** 2 / π, and π / 2 split into a 33-bit head (so `k * PIO2_HI` is exact for |k| < 2^20) and its remainder. */
const TWO_OVER_PI = 0.6366197723675814;
const PIO2_HI = 1.5707963267341256;
const PIO2_LO = 6.077100506506192e-11;
/** Largest |radians| reduced with the split π / 2; beyond it the angle is reduced through turns (less accurate). */
const RAD_REDUCE_MAX = 1.5e6;

// Polynomial kernels on [−π/4, π/4] (minimax coefficients of the classic sine and cosine kernels).
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

function kernelSin(x: number): number {
  const z = x * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + z * x * (S1 + z * r);
}

function kernelCos(x: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  return 1 - (0.5 * z - z * r);
}

/** Writes sine and cosine of the kernel argument `x` (|x| ≤ π/4) moved by `quarter` quarter turns. */
function fromQuarter(quarter: number, x: number, out: [number, number]): [number, number] {
  const s = kernelSin(x);
  const c = kernelCos(x);
  switch (quarter & 3) {
    case 0:
      out[0] = s;
      out[1] = c;
      break;
    case 1:
      out[0] = c;
      out[1] = -s;
      break;
    case 2:
      out[0] = -s;
      out[1] = -c;
      break;
    default:
      out[0] = -c;
      out[1] = s;
  }
  return out;
}

/**
 * Sine and cosine of an angle in turns, as `[sin, cos]` (written to `out` when given). The reduction to one turn is
 * exact, so the result stays accurate for any number of whole turns.
 */
export function detSinCosTurns(turns: number, out: [number, number] = [0, 0]): [number, number] {
  const f = turns - Math.floor(turns); // 0 … 1, no rounding
  const quarter = Math.round(f * 4); // 0 … 4
  return fromQuarter(quarter, (f - quarter * 0.25) * RAD_PER_TURN, out);
}

/** Sine of an angle in turns. */
export function detSinTurns(turns: number): number {
  return detSinCosTurns(turns)[0];
}

/** Cosine of an angle in turns. */
export function detCosTurns(turns: number): number {
  return detSinCosTurns(turns)[1];
}

/**
 * Sine and cosine of an angle in radians, as `[sin, cos]`. The absolute error stays near 1e-16 up to about a million
 * radians (the reduced angle is good to about 1e-20, so a result close to zero keeps fewer digits as the angle
 * grows); larger angles are still reproducible but lose accuracy, keep those in turns.
 */
export function detSinCos(radians: number, out: [number, number] = [0, 0]): [number, number] {
  if (!(Math.abs(radians) < RAD_REDUCE_MAX)) return detSinCosTurns(radians * TURN_PER_RAD, out);
  const quarter = Math.round(radians * TWO_OVER_PI);
  return fromQuarter(quarter, radians - quarter * PIO2_HI - quarter * PIO2_LO, out);
}

/** Sine of an angle in radians. */
export function detSin(radians: number): number {
  return detSinCos(radians)[0];
}

/** Cosine of an angle in radians. */
export function detCos(radians: number): number {
  return detSinCos(radians)[1];
}

// Arc tangent: the argument is folded onto one of four reference points, the rest is an odd polynomial.
const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.570796326794896558] as const;
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17] as const;
const T0 = 3.33333333333329318027e-1;
const T1 = -1.99999999998764832476e-1;
const T2 = 1.42857142725034663711e-1;
const T3 = -1.11111104054623557880e-1;
const T4 = 9.09088713343650656196e-2;
const T5 = -7.69187620504482999495e-2;
const T6 = 6.66107313738753120669e-2;
const T7 = -5.83357013379057348645e-2;
const T8 = 4.97687799461593236017e-2;
const T9 = -3.65315727442169155270e-2;
const T10 = 1.62858201153657823623e-2;

/** Arc tangent in radians, −π/2 … π/2. */
export function detAtan(v: number): number {
  if (v !== v) return v;
  const neg = v < 0;
  let x = neg ? -v : v;
  if (x > 1e18) return neg ? -HALF_PI : HALF_PI;
  let id = -1;
  if (x >= 0.4375) {
    if (x < 1.1875) {
      if (x < 0.6875) {
        id = 0;
        x = (2 * x - 1) / (2 + x);
      } else {
        id = 1;
        x = (x - 1) / (x + 1);
      }
    } else if (x < 2.4375) {
      id = 2;
      x = (x - 1.5) / (1 + 1.5 * x);
    } else {
      id = 3;
      x = -1 / x;
    }
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (T0 + w * (T2 + w * (T4 + w * (T6 + w * (T8 + w * T10)))));
  const s2 = w * (T1 + w * (T3 + w * (T5 + w * (T7 + w * T9))));
  const r = id < 0 ? x - x * (s1 + s2) : ATAN_HI[id]! - (x * (s1 + s2) - ATAN_LO[id]! - x);
  return neg ? -r : r;
}

/** Angle of the vector (x, y) in radians, −π … π. Both arguments must be finite; (0, 0) gives 0. */
export function detAtan2(y: number, x: number): number {
  if (x > 0) return detAtan(y / x);
  if (x < 0) return y >= 0 ? detAtan(y / x) + PI : detAtan(y / x) - PI;
  return y > 0 ? HALF_PI : y < 0 ? -HALF_PI : 0;
}

/** Arc sine in radians, −π/2 … π/2. The argument is clamped to −1 … 1. */
export function detAsin(v: number): number {
  const x = v < -1 ? -1 : v > 1 ? 1 : v;
  return detAtan2(x, Math.sqrt((1 - x) * (1 + x)));
}

/** Arc cosine in radians, 0 … π. The argument is clamped to −1 … 1. */
export function detAcos(v: number): number {
  const x = v < -1 ? -1 : v > 1 ? 1 : v;
  return detAtan2(Math.sqrt((1 - x) * (1 + x)), x);
}
