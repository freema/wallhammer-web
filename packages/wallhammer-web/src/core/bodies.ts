// A system of bodies on rails, laid out as nested frames. Each body gets two frames in a `FrameSet`:
//   - a carried frame: its origin is the centre of the body, its axes stay parallel to the axes of the whole system;
//     bodies that go round this body hang under it, so they do not turn with it;
//   - a turning frame under it: the same origin, turned by the body's spin; what stands on the body hangs under it.
// `setTime` places every frame from the time alone (`kepler.ts`), so the state at a time T does not depend on how
// the clock got there. Keep the time as a whole number of ticks and divide (`setTick`); a sum of fractional steps
// would itself differ between a stepped and a jumped run.
//
// Day, night and seasons need no code of their own: the direction from a point of a turning frame to the frame of
// the light (`FrameSet.directionTo`) changes with the spin, and the latitude under the light (`subPoint`) swings
// with the tilt over one round.

import type { Vec3 } from '../base/math.ts';
import { FrameSet, directionToDeg } from '../base/frames.ts';
import { orbitPosition, orbitVelocity, prepareOrbit, prepareSpin, spinRate, spinRotation } from './kepler.ts';
import type { Orbit, OrbitElements, Spin, SpinElements } from './kepler.ts';

/** Reach of a body when `BodyDef.influence` is not given, in radii. */
export const BODY_INFLUENCE_RADII = 5;

/** One body of a system. */
export interface BodyDef {
  /** Unique name. */
  name: string;
  /** Name of the body this one goes round; it must come earlier in the list. Omitted: the centre of the system. */
  parent?: string;
  /** Mean radius in metres. */
  radius: number;
  /** Path round the parent. Omitted: the body stays at the parent's centre. */
  orbit?: OrbitElements;
  /** Turning about its own axis. Omitted: it does not turn and its axes are those of the system. */
  spin?: SpinElements;
  /** Radius of the sphere within which positions are best kept in this body's frames. Default `BODY_INFLUENCE_RADII` radii. */
  influence?: number;
}

/** A body of a built system. */
export interface Body {
  readonly index: number;
  readonly name: string;
  /** Index of the parent body, −1 at the centre of the system. */
  readonly parent: number;
  readonly radius: number;
  readonly influence: number;
  readonly orbit: Orbit | null;
  readonly spin: Spin;
  /** Frame at the body's centre with the axes of the system. */
  readonly carriedFrame: number;
  /** Frame at the body's centre that turns with the body; +y is its axis. */
  readonly turningFrame: number;
}

/** Latitude and longitude on a body under another frame's origin, and the way to it. */
export interface SubPoint {
  latitudeDeg: number;
  longitudeDeg: number;
  /** Unit direction from the body's centre in its turning frame. */
  direction: Vec3;
  /** Distance between the two centres. */
  distance: number;
}

export class BodySystem {
  /** All frames of the system. Further frames (patches, moving things) may be added under the body frames. */
  readonly frames = new FrameSet();
  /** The top frame of the whole system. */
  readonly root: number;
  readonly bodies: readonly Body[];
  private readonly byName = new Map<string, Body>();
  private now = 0;

  constructor(defs: readonly BodyDef[]) {
    this.root = this.frames.add('system');
    const bodies: Body[] = [];
    for (const def of defs) {
      if (this.byName.has(def.name)) throw new Error(`bodies: two bodies are named "${def.name}"`);
      if (!(def.radius > 0)) throw new Error(`bodies: "${def.name}" needs a positive radius`);
      const parent = def.parent === undefined ? null : this.byName.get(def.parent);
      if (parent === undefined) throw new Error(`bodies: parent "${def.parent}" of "${def.name}" is not defined before it`);
      const carriedFrame = this.frames.add(def.name, parent ? parent.carriedFrame : this.root);
      const turningFrame = this.frames.add(`${def.name}/turning`, carriedFrame);
      const body: Body = {
        index: bodies.length,
        name: def.name,
        parent: parent ? parent.index : -1,
        radius: def.radius,
        influence: def.influence ?? def.radius * BODY_INFLUENCE_RADII,
        orbit: def.orbit ? prepareOrbit(def.orbit) : null,
        spin: prepareSpin(def.spin),
        carriedFrame,
        turningFrame,
      };
      bodies.push(body);
      this.byName.set(body.name, body);
    }
    this.bodies = bodies;
    this.setTime(0);
  }

  /** The body with this name; throws when there is none. */
  body(name: string): Body {
    const b = this.byName.get(name);
    if (!b) throw new Error(`bodies: no body "${name}"`);
    return b;
  }

  /** Time the frames are placed for (seconds). */
  get time(): number {
    return this.now;
  }

  /** Places every body frame for time `t` (seconds). The result depends on `t` alone. */
  setTime(t: number): void {
    this.now = t;
    const p: Vec3 = [0, 0, 0];
    const v: Vec3 = [0, 0, 0];
    const w: Vec3 = [0, 0, 0];
    for (const b of this.bodies) {
      if (b.orbit) {
        this.frames.setOrigin(b.carriedFrame, orbitPosition(b.orbit, t, p));
        this.frames.setMotion(b.carriedFrame, orbitVelocity(b.orbit, t, v));
      }
      this.frames.setRotation(b.turningFrame, spinRotation(b.spin, t));
      this.frames.setMotion(b.turningFrame, [0, 0, 0], spinRate(b.spin, w));
    }
  }

  /** Places the frames for a whole tick of a clock with `hz` ticks per second. */
  setTick(tick: number, hz: number): void {
    this.setTime(tick / hz);
  }

  /**
   * The body whose reach holds the point `p` of frame `frame`: the most deeply nested one, and of several equally
   * deep the one the point is relatively nearest to. −1 when the point is within no reach. `reach` scales every
   * influence radius; pass a little more than 1 when asking whether to leave a body, so the answer does not flip
   * on the boundary.
   */
  dominantBody(p: readonly [number, number, number], frame: number, reach = 1): number {
    let best = -1;
    let bestDepth = -1;
    let bestShare = 0;
    const local: Vec3 = [0, 0, 0];
    for (const b of this.bodies) {
      this.frames.convertPoint(p, frame, b.carriedFrame, local);
      const share = Math.sqrt(local[0] * local[0] + local[1] * local[1] + local[2] * local[2]) / (b.influence * reach);
      if (share > 1) continue;
      const depth = this.frames.depth(b.carriedFrame);
      if (depth > bestDepth || (depth === bestDepth && share < bestShare)) {
        best = b.index;
        bestDepth = depth;
        bestShare = share;
      }
    }
    return best;
  }

  /**
   * The point of body `body` that has the origin of frame `target` straight overhead. With the frame of the light
   * as the target, the latitude is the season (it swings between plus and minus the tilt over one round) and the
   * longitude is where it is noon.
   */
  subPoint(body: number, target: number): SubPoint {
    const b = this.bodies[body];
    if (!b) throw new Error(`bodies: no body ${body}`);
    const { direction, distance } = this.frames.directionTo(target, b.turningFrame);
    return { ...directionToDeg(direction), direction, distance };
  }

  /** Digest of every frame of the system at the current time (`FrameSet.fingerprint`). */
  fingerprint(): number {
    return this.frames.fingerprint();
  }
}
