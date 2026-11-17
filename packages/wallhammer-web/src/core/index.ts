// Layer 2, core: clocks and the palette mechanism.

export { Clock } from './clock.ts';
export type { ClockOptions } from './clock.ts';
export { PALETTE_CAPACITY, definePalette } from './palette.ts';
export type { Palette } from './palette.ts';
export { TRACK_CRUMBLE_S, TRACK_FLOATS, TRACK_GLSL, TRACK_GRAVITY, TRACK_MAX_FLIGHT_S, trackAttribs, trackFlightTime, trackLifetime, trackPose, writeTrack } from './ballistic.ts';
export type { BallisticTrack, DustPuff, TrackPose } from './ballistic.ts';
export { ORBIT_MAX_ECCENTRICITY, ORBIT_SOLVER_STEPS, orbitPosition, orbitVelocity, prepareOrbit, prepareSpin, solveKepler, spinRate, spinRotation } from './kepler.ts';
export type { Orbit, OrbitElements, Spin, SpinElements } from './kepler.ts';
export { BODY_INFLUENCE_RADII, BodySystem } from './bodies.ts';
export type { Body, BodyDef, SubPoint } from './bodies.ts';
export { FADE_GLSL, LevelFade, fadeFragment, withFade } from './level-fade.ts';
export type { LevelFadeOptions } from './level-fade.ts';
export { COVER_FADE_GLSL, coverFade, coverKeep } from './cover-fade.ts';
