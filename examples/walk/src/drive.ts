// Scripted walking: steers a walker toward a point in fixed steps, the way a player would hold a direction. Shared by
// the page (`__wh.walkTo`) and the headless check (tools/walk/course-scenarios.ts), so both walk the same path bit for
// bit. Pure: no DOM, no clock.

import { newWalkIntent } from 'wallhammer-web/world';
import type { CollisionWorld, WalkIntent, Walker } from 'wallhammer-web/world';
import { stationAt } from './course.ts';

export interface DriveOptions {
  /** Run instead of walk. Default false. */
  run?: boolean;
  /**
   * Jump by itself: at an edge ahead (the ground drops by more than a step) and at a ledge ahead that is higher than a
   * step but within reach of a jump. Default false.
   */
  jump?: boolean;
  /** Stop asking for movement within this distance of the goal, metres. Default 0.05. */
  within?: number;
}

/** What a page or a check reads back. */
export interface WalkState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Horizontal speed, m/s. */
  speed: number;
  yawDeg: number;
  grounded: boolean;
  steep: boolean;
  /** Station id under the feet, or '' between pads. */
  station: string;
  /** Fixed steps since the last teleport. */
  steps: number;
}

export function walkState(w: Walker): WalkState {
  const p = w.position;
  const v = w.velocity;
  return {
    x: p[0]!,
    y: p[1]!,
    z: p[2]!,
    vx: v[0]!,
    vy: v[1]!,
    vz: v[2]!,
    speed: Math.sqrt(v[0]! * v[0]! + v[2]! * v[2]!),
    yawDeg: (w.yaw * 180) / Math.PI,
    grounded: w.grounded,
    steep: w.steep,
    station: stationAt(p[0]!, p[2]!)?.id ?? '',
    steps: w.steps,
  };
}

const scratch: WalkIntent = newWalkIntent();

/**
 * Walks `walker` toward (x, z) for `seconds` of fixed steps (it keeps pushing when blocked, like a held key). `each`
 * sees the walker after every step. Returns the state at the end.
 */
export function driveTo(walker: Walker, world: CollisionWorld, x: number, z: number, seconds: number, o: DriveOptions = {}, each?: (w: Walker) => void): WalkState {
  const s = walker.setup;
  const n = Math.max(0, Math.round(seconds * s.stepHz));
  const within = o.within ?? 0.05;
  const it = scratch;
  it.run = o.run ?? false;
  for (let i = 0; i < n; i++) {
    const p = walker.position;
    const dx = x - p[0]!;
    const dz = z - p[2]!;
    const d = Math.sqrt(dx * dx + dz * dz);
    it.jump = false;
    if (d <= within) {
      it.moveX = 0;
      it.moveZ = 0;
    } else {
      // Full intent until half a metre out, then less, so the body does not overshoot the goal.
      const k = Math.min(1, d / 0.5) / d;
      it.moveX = dx * k;
      it.moveZ = dz * k;
      if (o.jump && walker.grounded && !walker.steep) it.jump = shouldJump(walker, world, dx / d, dz / d);
    }
    walker.step(it);
    each?.(walker);
  }
  return walkState(walker);
}

/** An edge just ahead or a ledge a little further ahead, within the reach of a jump. */
function shouldJump(w: Walker, world: CollisionWorld, ux: number, uz: number): boolean {
  const s = w.setup;
  const p = w.position;
  const feet = p[1]!;
  const v = w.velocity;
  const speed = Math.sqrt(v[0]! * v[0]! + v[2]! * v[2]!);
  // Edge: the ground just in front of the body is lower than a step down.
  const ex = p[0]! + ux * (s.radius + 0.05);
  const ez = p[2]! + uz * (s.radius + 0.05);
  if (world.groundAt(ex, ez, feet, s.maxStepUp) < feet - s.maxStepUp - 0.05) return true;
  // Ledge: a top above a step but below the top of a jump, ahead by the distance covered while rising a little.
  const reach = (s.jumpSpeed * s.jumpSpeed) / (2 * s.gravity);
  const ahead = s.radius + 0.1 + speed * 0.15;
  const lx = p[0]! + ux * ahead;
  const lz = p[2]! + uz * ahead;
  const top = world.groundAt(lx, lz, feet, reach - 0.05);
  return top > feet + s.maxStepUp + 0.01;
}
