// The scripted flight of the planet example: straight up from a point of the surface until the whole sphere is in
// view, a rest there, and the same way back. The pose is a pure function of the time since the start, so the flight
// is the same on every run and the way down mirrors the way up exactly.
//
// The height grows as a power of the progress (from metres to hundreds of kilometres), so every doubling of the
// height takes the same time and the streaming has the same work per second all the way. The progress itself eases
// in and out with no speed and no acceleration at either end. The view starts a little under the horizon, keeps the
// horizon in the picture while it sinks, and ends straight down with the sphere in the middle.

export interface FlightPlan {
  /** Height above the ground at the start and the end, in metres. */
  lowM: number;
  /** Height at the top, in metres. */
  highM: number;
  /** Seconds of the way up; the way down takes the same. */
  climbS: number;
  /** Seconds of rest at the top. */
  holdS: number;
  /** Degrees the view turns to the left about the local up on the way up (and back on the way down). */
  turnDeg: number;
  /** Degrees the view looks under the horizon near the ground. */
  lowPitchDeg: number;
}

export const DEFAULT_FLIGHT: FlightPlan = { lowM: 3, highM: 260_000, climbS: 50, holdS: 6, turnDeg: 50, lowPitchDeg: 3 };

export interface FlightPose {
  /** Share of the way up, 0 at the ground and 1 at the top. */
  progress: number;
  /** Height above the ground under the start, in metres. */
  heightM: number;
  /** Speed along the local up in metres per second (negative on the way down). */
  climbMs: number;
  /** Pitch of the view in degrees, positive under the horizon. */
  pitchDeg: number;
  /** Turn of the view to the left since the start, in degrees. */
  turnDeg: number;
  /** True once the time is past the end of the flight. */
  done: boolean;
}

/** Seconds from the start to the landing. */
export function flightDuration(plan: FlightPlan): number {
  return 2 * plan.climbS + plan.holdS;
}

/** Least height above a sphere from which all of it, with a shell `shellM` thick round it, fits a view `fovYDeg` high. */
export function wholeSphereHeight(radiusM: number, shellM: number, fovYDeg: number): number {
  return (radiusM + shellM) / Math.sin((fovYDeg * Math.PI) / 360) - radiusM;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/** Eases 0–1 with no speed and no acceleration at either end; `ease(x, true)` is its slope. */
function ease(x: number, slope = false): number {
  return slope ? 30 * x * x * (1 - x) * (1 - x) : x * x * x * (x * (6 * x - 15) + 10);
}

/** The pose `t` seconds after the start of a flight over a sphere of `radiusM`. Outside the flight it is the pose of its nearer end. */
export function flightPose(plan: FlightPlan, radiusM: number, t: number): FlightPose {
  const total = flightDuration(plan);
  const up = t <= plan.climbS;
  // Position along the way up, 0–1, and its change per second.
  const x = up ? clamp01(t / plan.climbS) : clamp01((total - t) / plan.climbS);
  const rate = t <= 0 || t >= total || (!up && t < plan.climbS + plan.holdS) ? 0 : (up ? 1 : -1) / plan.climbS;
  const progress = ease(x);
  const span = Math.log(plan.highM / plan.lowM);
  const heightM = plan.lowM * Math.exp(span * progress);
  const climbMs = heightM * span * ease(x, true) * rate;
  // How far the horizon lies under the level view from this height.
  const dipDeg = (Math.acos(radiusM / (radiusM + heightM)) * 180) / Math.PI;
  const s = clamp01((progress - 0.62) / 0.38);
  const down = s * s * (3 - 2 * s);
  const pitchDeg = (dipDeg + plan.lowPitchDeg) * (1 - down) + 90 * down;
  return { progress, heightM, climbMs, pitchDeg, turnDeg: plan.turnDeg * progress, done: t >= total };
}
