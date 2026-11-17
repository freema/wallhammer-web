// Closed-form tracks of transient rigid pieces: a piece stands still until it lets go, flies on a ballistic arc while
// it turns about a fixed axis through its pivot, and on landing crumbles (flattens and spreads into the ground) and is
// gone. A piece in dust mode stands still and is gone the moment it lets go (its place is taken by a dust puff).
// Everything is a function of the track and the clock time, with no state carried between frames, so pausing or
// scrubbing the clock shows the same pose every time, also back to before the piece landed.
//
// The vertex shader evaluates the same formulas (`TRACK_GLSL`); `trackPose` is the reference. A mesh that moves on
// tracks carries the track in every vertex: `TRACK_FLOATS` floats after its own attributes (`writeTrack`).

import type { VertexAttrib } from '../base/data.ts';

/** Gravity of the tracks (m/s²). */
export const TRACK_GRAVITY = 9.81;
/** After landing a piece crumbles into the ground over this long. */
export const TRACK_CRUMBLE_S = 0.45;
/** Longest flight; a track that would fly longer lands at this time wherever it is. */
export const TRACK_MAX_FLIGHT_S = 4;
/** Sideways spread of a crumbling piece at the end of its crumble (fraction of its size). */
const SPREAD = 0.35;

export interface BallisticTrack {
  /** Clock time (seconds) at which the piece lets go; before it, the piece stands exactly where it is. */
  start: number;
  /** Pivot at rest (metres) and its initial velocity (m/s). */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Unit axis of the turn and the turn rate (rad/s). */
  ax: number;
  ay: number;
  az: number;
  spin: number;
  /** Height at which the pivot comes to rest. */
  land: number;
  /** Dust mode: the piece does not fly, it is gone when it lets go. */
  dust?: boolean;
}

/** A dust cloud: centre, clock time it starts, size (metres). */
export interface DustPuff {
  x: number;
  y: number;
  z: number;
  start: number;
  size: number;
}

/** Seconds of flight from letting go until the pivot reaches its landing height (0 in dust mode). */
export function trackFlightTime(t: BallisticTrack): number {
  if (t.dust) return 0;
  const a = TRACK_GRAVITY / 2;
  const drop = t.y - t.land;
  if (drop <= 0 && t.vy <= 0) return 0;
  const disc = t.vy * t.vy + 4 * a * drop;
  const tl = (t.vy + Math.sqrt(Math.max(0, disc))) / (2 * a);
  return Math.min(TRACK_MAX_FLIGHT_S, Math.max(0, tl));
}

/** Seconds from letting go until nothing of the piece is left. */
export function trackLifetime(t: BallisticTrack): number {
  return t.dust ? 0 : trackFlightTime(t) + TRACK_CRUMBLE_S;
}

export interface TrackPose {
  /** Pivot position. */
  x: number;
  y: number;
  z: number;
  /** Turn about the track axis (radians). */
  angle: number;
  /** 0 while whole, rising to 1 while it crumbles after landing. */
  crumble: number;
  phase: 'waiting' | 'flying' | 'crumbling' | 'gone';
}

/** Pose of a track at clock time `now`. */
export function trackPose(t: BallisticTrack, now: number): TrackPose {
  const age = now - t.start;
  if (age <= 0) return { x: t.x, y: t.y, z: t.z, angle: 0, crumble: 0, phase: 'waiting' };
  if (t.dust) return { x: t.x, y: t.y, z: t.z, angle: 0, crumble: 1, phase: 'gone' };
  const fl = trackFlightTime(t);
  const tau = Math.min(age, fl);
  const k = Math.min(1, Math.max(0, (age - fl) / TRACK_CRUMBLE_S));
  const x = t.x + t.vx * tau;
  const z = t.z + t.vz * tau;
  const y = Math.max(t.land, t.y + t.vy * tau - (TRACK_GRAVITY / 2) * tau * tau) - 0.4 * k;
  const phase = age < fl ? 'flying' : k < 1 ? 'crumbling' : 'gone';
  return { x, y, z, angle: t.spin * tau, crumble: k, phase };
}

/**
 * Floats of a track in a vertex: pivot and start, velocity and landing height, axis and spin, flight time, mode and a
 * moving-only mark (a vertex with the mark is collapsed onto the pivot until the piece lets go).
 */
export const TRACK_FLOATS = 16;

/** Vertex attributes of the track at byte `offset` of a vertex (names a_track0 … a_track3). */
export function trackAttribs(offset: number): VertexAttrib[] {
  return [0, 1, 2, 3].map((k) => ({ name: `a_track${k}`, size: 4, type: 'f32' as const, offset: offset + k * 16 }));
}

/** Writes the track floats at `f32[at]`; `movingOnly` marks a vertex that is not drawn before the piece lets go. */
export function writeTrack(f32: Float32Array, at: number, t: BallisticTrack, movingOnly = false): void {
  f32[at] = t.x;
  f32[at + 1] = t.y;
  f32[at + 2] = t.z;
  f32[at + 3] = t.start;
  f32[at + 4] = t.vx;
  f32[at + 5] = t.vy;
  f32[at + 6] = t.vz;
  f32[at + 7] = t.land;
  f32[at + 8] = t.ax;
  f32[at + 9] = t.ay;
  f32[at + 10] = t.az;
  f32[at + 11] = t.spin;
  f32[at + 12] = trackFlightTime(t);
  f32[at + 13] = t.dust ? 1 : 0;
  f32[at + 14] = movingOnly ? 1 : 0;
  f32[at + 15] = 0;
}

const g = (v: number): string => v.toFixed(4);

/**
 * GLSL of the tracks (needs `u_time` of the frame block): `trackPlace(p, n, a_track0, a_track1, a_track2, a_track3)`
 * returns the moved position of a vertex at `p` and turns its normal `n`.
 */
export const TRACK_GLSL = /* glsl */ `
vec3 trackTurn(vec3 v, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
vec3 trackPlace(vec3 p, inout vec3 n, vec4 t0, vec4 t1, vec4 t2, vec4 t3) {
  float age = u_time.x - t0.w;
  if (age <= 0.0) return t3.z > 0.5 ? t0.xyz : p;
  if (t3.y > 0.5) return t0.xyz;
  float fl = t3.x;
  float tau = min(age, fl);
  vec3 c = t0.xyz + t1.xyz * tau;
  c.y = max(t1.w, t0.y + t1.y * tau - ${g(TRACK_GRAVITY / 2)} * tau * tau);
  float ang = t2.w * tau;
  vec3 local = trackTurn(p - t0.xyz, t2.xyz, ang);
  n = trackTurn(n, t2.xyz, ang);
  float k = clamp((age - fl) / ${g(TRACK_CRUMBLE_S)}, 0.0, 1.0);
  if (k >= 1.0) return c;
  local *= vec3(1.0 + ${g(SPREAD)} * k, 1.0 - k, 1.0 + ${g(SPREAD)} * k);
  c.y -= 0.4 * k;
  return c + local;
}
`;
