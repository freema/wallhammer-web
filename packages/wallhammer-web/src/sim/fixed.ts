// Integer units of the simulation. Positions along paths are whole millimetres, speeds millimetres per tick and
// accelerations millimetres per tick squared, so movement logic is exact integer arithmetic (tier A). Only `Math.sqrt`
// is used, which IEEE 754 defines exactly; transcendental functions are not.
//
// The app speaks metres and seconds; these helpers convert once, at the boundary, with explicit rounding.

/** Metres to whole millimetres. */
export function mm(metres: number): number {
  return Math.round(metres * 1000);
}

/** Metres rounded to the nearest millimetre, still in metres: how coordinates enter the simulation. */
export function snapMm(metres: number): number {
  return Math.round(metres * 1000) / 1000;
}

/** Metres per second to millimetres per tick. */
export function mmPerTick(metresPerSecond: number, hz: number): number {
  return Math.round((metresPerSecond * 1000) / hz);
}

/** Metres per second squared to millimetres per tick squared (at least 1 when positive). */
export function mmPerTick2(metresPerSecond2: number, hz: number): number {
  if (metresPerSecond2 <= 0) return 0;
  return Math.max(1, Math.round((metresPerSecond2 * 1000) / (hz * hz)));
}

/** Floor of the square root of a non-negative integer below 2^53. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

/** Integer length of a vector given in millimetres. */
export function lengthMm(dx: number, dz: number): number {
  return Math.round(Math.sqrt(dx * dx + dz * dz));
}

/**
 * Distance covered from speed v until standing, braking by `decel` each tick, counting this tick's move:
 * v + (v − a) + (v − 2a) + … over the positive terms.
 */
export function stoppingDistance(v: number, decel: number): number {
  if (v <= 0) return 0;
  const k = Math.floor(v / decel);
  return (k + 1) * v - (decel * k * (k + 1)) / 2;
}

/** The highest speed (mm/tick) from which the entity can still stop within `d` millimetres. */
export function brakeSpeed(d: number, decel: number): number {
  if (d <= 0) return 0;
  // Continuous estimate v(v + a) / 2a = d, then corrected to the exact discrete profile.
  let v = Math.floor((isqrt(decel * decel + 8 * decel * d) - decel) / 2);
  while (v > 0 && stoppingDistance(v, decel) > d) v--;
  while (stoppingDistance(v + 1, decel) <= d) v++;
  return v;
}

/** The highest speed from which braking reaches `limit` within `d` millimetres: v² = limit² + 2·a·d. */
export function approachSpeed(limit: number, d: number, decel: number): number {
  return isqrt(limit * limit + 2 * decel * Math.max(0, d));
}
