// A seat timeline (`SeatTransition` of `motion`) and the carried body's walker together: getting on starts from where
// the walker stands, and getting off puts the walker where the body will stand at the moment it starts, never at the
// end, so whatever blends from the seat toward the walker (the body's root, the camera's point) moves toward that place
// and never back to where the body got on. Where it may stand: `CollisionWorld.firstStandSpot`.

import type { SeatTransition } from '../motion/seat-transition.ts';
import type { Walker } from './walker.ts';

/** Begins getting on from the walker's place and heading, walking to the carrier over `approachSeconds`. */
export function attachFromWalker(transition: SeatTransition, walker: Walker, approachSeconds: number): boolean {
  const p = walker.position;
  return transition.attach(p[0]!, p[1]!, p[2]!, walker.yaw, approachSeconds);
}

/**
 * Begins getting off and puts the walker at (x, y, z) with heading `yaw` now, where the body will stand. Returns
 * false (and leaves the walker) unless the body was held.
 */
export function releaseToWalker(transition: SeatTransition, walker: Walker, x: number, y: number, z: number, yaw: number): boolean {
  if (!transition.release()) return false;
  walker.teleport(x, y, z, yaw);
  return true;
}
