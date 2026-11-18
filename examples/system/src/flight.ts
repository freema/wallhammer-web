// The flights of the system example: where the camera is, as a function of the flight's time and of where the bodies
// are. Pure, without the page: the page plans a flight and turns the view, the golden test flies the same legs.
//
// A flight is one or two legs. A leg along a body is kept in that body's turning frame: its low end stands over a
// place of the surface, its far end is a point that may move (the middle between two bodies, a point of another
// frame). The height grows as a power of the leg's time, so every height from metres to the size of the system gets
// its share of it; the direction from the centre goes over from the place to the far end once the camera is above
// everything that stands on the body. Where the bodies are is read at every call, so a leg ends at its far end
// exactly, whatever the system did meanwhile.

import type { Vec3 } from 'wallhammer-web/base';
import type { Body, BodySystem } from 'wallhammer-web/core';
import { UP_Y, ZERO, across, dot3, len, mul, reject, slerp, smooth, sub, turned, unit } from './vec.ts';
import type { V3 } from './vec.ts';

const DEG = Math.PI / 180;

/** A point that may move with the system: where it is now, in the frame asked for. */
export type MovingPoint = (frame: number) => Vec3;

/** A leg along a body. */
export interface SurfaceLeg {
  kind: 'surface';
  body: Body;
  /** The low end: unit direction from the centre in the turning frame, the height of the surface there, and the height above it. */
  site: Vec3;
  groundM: number;
  lowM: number;
  /** The far end. */
  far: MovingPoint;
  seconds: number;
  /** True: the camera rests at the far end. False: it passes it at speed, into or out of another leg. */
  rest: boolean;
  /** True: from the low end to the far end. */
  rising: boolean;
  /** Share of the leg below which the camera stays straight above the low end. */
  turnFrom: number;
}
/** A leg whose length and turn are still to be worked out (`finishLeg`). */
export type OpenLeg = Omit<SurfaceLeg, 'seconds' | 'turnFrom'>;
/** A straight leg between two points, at rest at both ends. */
export interface LineLeg {
  kind: 'line';
  from: MovingPoint;
  to: MovingPoint;
  seconds: number;
}
export type Leg = SurfaceLeg | LineLeg;

/** How far along its heights a leg is at the share `x` of its way from the low end: no speed at an end it rests at. */
export const legProfile = (leg: Pick<SurfaceLeg, 'rest'>, x: number): number => (leg.rest ? x * x * (3 - 2 * x) : x * x * (2 - x));

/** The far end of a leg from the centre of its body (turning frame), and the height of the leg there. */
export function legFar(leg: Pick<SurfaceLeg, 'body' | 'groundM' | 'lowM' | 'far'>): { point: Vec3; dir: Vec3; heightM: number } {
  const point = leg.far(leg.body.turningFrame);
  return { point, dir: unit(point), heightM: Math.max(leg.lowM * 1.0001, len(point) - leg.body.radius - leg.groundM) };
}

/** Where a leg along a body is at the share `x` of its way from the low end, in the turning frame of its body. */
export function surfaceLegPoint(leg: SurfaceLeg, x: number): Vec3 {
  const far = legFar(leg);
  const h = leg.lowM * Math.exp(Math.log(far.heightM / leg.lowM) * legProfile(leg, x));
  const dir = slerp(leg.site, far.dir, smooth((x - leg.turnFrom) / Math.max(1e-6, 0.96 - leg.turnFrom)));
  return mul(dir, leg.body.radius + leg.groundM + h);
}

/** How many times the height of a leg multiplies by e on its way: its length for the eye. */
const legSpan = (leg: Pick<SurfaceLeg, 'body' | 'groundM' | 'lowM' | 'far'>): number => Math.max(0.5, Math.log(legFar(leg).heightM / leg.lowM));

/**
 * Fills in what follows from the ends of a leg: how long it takes (`seconds`, or a time that grows with its span,
 * times `pace`) and from where it leaves the place below it.
 */
export function finishLeg(leg: OpenLeg, pace: number, seconds?: number): SurfaceLeg {
  const span = legSpan(leg);
  // Above an eighth of the radius nothing of the body stands in the way.
  const clear = Math.log(Math.max(1, (0.12 * leg.body.radius) / leg.lowM)) / span;
  const full: SurfaceLeg = { ...leg, seconds: seconds ?? Math.max(6, 2.6 * span) * pace, turnFrom: 0 };
  let lo = 0;
  let hi = 0.85;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (legProfile(full, mid) < clear) lo = mid;
    else hi = mid;
  }
  full.turnFrom = hi;
  return full;
}

/**
 * Seconds a leg that is passed at speed must take so that its speed at the far end is that of the leg `other`
 * there. Both pass the same far end; the one comes in as fast as the other goes out.
 */
export function matchedSeconds(leg: Pick<SurfaceLeg, 'body' | 'groundM' | 'lowM' | 'far'>, other: SurfaceLeg): number {
  // Speed at the far end of a leg passed at speed: its height there times its span, per second of the leg.
  const reach = (l: Pick<SurfaceLeg, 'body' | 'groundM' | 'lowM' | 'far'>): number => legFar(l).heightM * legSpan(l);
  return Math.max(4, (other.seconds * reach(leg)) / reach(other));
}

/**
 * The point two legs meet at between the bodies `a` and `b`: the middle between their centres, moved aside where the
 * straight way would pass within `clearM` of the centre of the system.
 */
export function between(system: BodySystem, a: Body, b: Body, clearM: number): MovingPoint {
  const frames = system.frames;
  const centre = system.bodies[0]!.carriedFrame;
  return (frame) => {
    const pa = frames.convertPoint(ZERO, a.carriedFrame, centre);
    const pb = frames.convertPoint(ZERO, b.carriedFrame, centre);
    const mid: Vec3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
    // The point of the straight way nearest to the centre (the origin of this frame).
    const ab = sub(pb, pa);
    const along = Math.min(1, Math.max(0, -dot3(pa, ab) / Math.max(1, dot3(ab, ab))));
    const nearest: Vec3 = [pa[0] + ab[0] * along, pa[1] + ab[1] * along, pa[2] + ab[2] * along];
    const miss = len(nearest);
    if (miss < clearM) {
      const aside = miss > 1 ? unit(nearest) : unit(reject(UP_Y, unit(ab)), [1, 0, 0]);
      const shift = 2 * (clearM - miss);
      mid[0] += aside[0] * shift;
      mid[1] += aside[1] * shift;
      mid[2] += aside[2] * shift;
    }
    return frames.convertPoint(mid, centre, frame);
  };
}

/** A point fixed in a frame, as the end of a leg. */
export function anchor(system: BodySystem, frame: number, point: V3): MovingPoint {
  const fixed: Vec3 = [point[0], point[1], point[2]];
  return (to) => system.frames.convertPoint(fixed, frame, to);
}

export const flightSeconds = (legs: readonly Leg[]): number => legs.reduce((sum, l) => sum + l.seconds, 0);

/** Where a flight is `t` seconds after its start, in the frame asked for, and on which leg. */
export function flightPoint(system: BodySystem, legs: readonly Leg[], t: number, frame: number): { position: Vec3; leg: Leg; index: number; done: number } {
  let rest = Math.max(0, t);
  let index = 0;
  while (index < legs.length - 1 && rest >= legs[index]!.seconds) rest -= legs[index++]!.seconds;
  const leg = legs[index]!;
  const done = Math.min(1, Math.max(0, rest / leg.seconds));
  if (leg.kind === 'line') {
    const a = leg.from(frame);
    const b = leg.to(frame);
    const k = smooth(done);
    return { position: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k], leg, index, done };
  }
  const local = surfaceLegPoint(leg, leg.rising ? done : 1 - done);
  return { position: system.frames.convertPoint(local, leg.body.turningFrame, frame), leg, index, done };
}

/** The sky of a body at the system's current time: unit directions in its turning frame. */
export interface Sky {
  sun: Vec3;
  /** A second body worth having in the sky, when there is one. */
  companion: Vec3 | null;
}
export function skyOf(system: BodySystem, body: Body, companion: Body | null): Sky {
  const frames = system.frames;
  const tf = body.turningFrame;
  return {
    sun: unit(frames.convertPoint(ZERO, system.bodies[0]!.carriedFrame, tf)),
    companion: companion ? unit(frames.convertPoint(ZERO, companion.carriedFrame, tf)) : null,
  };
}

/**
 * The place to land at under a sky, as a unit direction from the centre. With a companion: on the side of it that
 * faces the sun, far enough from the place under it that it stands 15° to 28° above the horizon; the sun is then
 * above the horizon too, unless the two stand nearly opposite each other. Without one: a low sun, 20° up.
 */
export function landingDirection(sky: Sky): Vec3 {
  if (!sky.companion) return turned(sky.sun, across(sky.sun), 70 * DEG);
  const apart = Math.acos(Math.min(1, Math.max(-1, dot3(sky.companion, sky.sun))));
  const a = Math.min(75 * DEG, Math.max(62 * DEG, apart / 2));
  return turned(sky.companion, unit(reject(sky.sun, sky.companion), across(sky.companion)), a);
}

/**
 * The view after a landing at `site` (unit direction from the centre): toward the companion where it stands at a
 * height that fits the picture, a little above the middle with the horizon still in it; else toward the sun; else
 * along the ground.
 */
export function landingView(sky: Sky, site: V3): Vec3 {
  const elevation = (d: V3): number => Math.asin(Math.min(1, Math.max(-1, dot3(d, site))));
  let toward: Vec3 = across(site);
  let rise = -3 * DEG;
  if (sky.companion && elevation(sky.companion) > 4 * DEG && elevation(sky.companion) < 65 * DEG) {
    toward = unit(reject(sky.companion, site), toward);
    rise = Math.min(34 * DEG, Math.max(1 * DEG, elevation(sky.companion) - 9 * DEG));
  } else if (elevation(sky.sun) > -5 * DEG && elevation(sky.sun) < 70 * DEG) {
    toward = unit(reject(sky.sun, site), toward);
    rise = 2 * DEG;
  }
  return turned(toward, site, rise);
}
