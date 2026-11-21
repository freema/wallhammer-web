// A scene that plays in a circle: time brought into one pass, an animation clock that runs a whole number of turns of
// the shaders' sines in a pass, sines that close with the loop and the share of a fade over to the earlier pass.
// Pure: arithmetic, Math.floor and Math.sin.

const TAU = Math.PI * 2;

/** The time `t` (s) brought into one pass of `loopS` seconds, 0 ≤ result < loopS. */
export function loopWrap(t: number, loopS: number): number {
  return t - Math.floor(t / loopS) * loopS;
}

/**
 * The animation clock at the loop's time `t`: `baseS` plus `clockS` seconds of clock for each pass, `passes` passes
 * played before this one. A sine of the shaders whose period divides `clockS` closes with the loop.
 */
export function loopClock(t: number, loopS: number, clockS: number, baseS = 0, passes = 0): number {
  return baseS + (loopWrap(t, loopS) / loopS + passes) * clockS;
}

/** A sine that passes `n` whole times in a loop of `loopS` seconds. */
export function loopTurns(t: number, n: number, loopS: number, phase = 0): number {
  return Math.sin((TAU * n * t) / loopS + phase);
}

/**
 * The share 0–1 of a fade over to the same motion one pass earlier at the loop's time `t`: 0 at the pass's start, 1 at
 * its end, with no speed at either end (smoothstep of the share of the pass). A motion that does not close by itself,
 * blended by it with its own copy one pass back, ends where it began.
 */
export function loopFade(t: number, loopS: number): number {
  const u = loopWrap(t, loopS) / loopS;
  return u * u * (3 - 2 * u);
}
