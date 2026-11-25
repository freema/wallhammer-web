// The walker's figure on the course (the default; `figure=boxes` draws the box figure of pose.ts instead): the shared
// pathfinder (examples/shared) with a ponytail, moved by a `FigureGait` of a movement profile (profiles.ts there). The
// gait's graph cross-fades stand, walk and run on the ground speed and leans into starts and stops; the phase follows
// the distance moved, so the feet keep their place while the body speeds up or brakes; `fitToGround` puts the feet on
// the course; the ponytail lags behind the motion (the engine's `ChainLag`). The course is flat (+y up), so the
// figure's root is also the frame the ponytail's motion is kept in.

import { FigureGait } from '../../shared/src/figures/gait.ts';
import type { FigureKind } from '../../shared/src/figures/kind.ts';
import { PATHFINDERS } from '../../shared/src/figures/pathfinder.ts';
import type { MoveProfile } from '../../shared/src/figures/profiles.ts';

/** What the figure needs of the ground: its height at (x, z) near the height `y` (`CollisionWorld.groundAt`). */
export type GroundAt = (x: number, z: number, y: number) => number;

export class PathfinderBody {
  readonly kind: FigureKind;
  gait: FigureGait;
  profile: MoveProfile;
  /** Figure's size against the kind's own. */
  readonly scale: number;
  /** The root of the last pose: columns left, up and forward of the figure, then the feet. */
  readonly root = new Float64Array(12);
  /** Largest angle of the ponytail's links from their posed directions after the last pose, radians. */
  tailAngle = 0;
  private y = 0;
  private readonly ground: { heightAt: (x: number, z: number) => number };

  constructor(heightM: number, profile: MoveProfile, groundAt: GroundAt) {
    this.kind = PATHFINDERS.pathfinder();
    this.scale = heightM / this.kind.heightM;
    this.profile = profile;
    this.gait = this.makeGait(profile);
    this.ground = { heightAt: (x, z) => groundAt(x, z, this.y) };
  }

  private makeGait(p: MoveProfile): FigureGait {
    return new FigureGait(this.kind, { walkSpeed: p.walker.walkSpeed, runSpeed: p.walker.runSpeed, scale: this.scale, seed: 0.37, strideScale: p.gait.strideScale, lean: p.gait.lean, lag: true });
  }

  /** A gait of another profile; the figure starts standing. */
  setProfile(p: MoveProfile): void {
    this.profile = p;
    this.gait = this.makeGait(p);
  }

  /** Standing, nothing travelled (after a teleport). */
  reset(): void {
    this.gait.reset();
  }

  /** `dt` seconds in which the body moved `moved` metres over the ground, stood (`grounded`) or not, climbing at `climb` m/s. */
  update(dt: number, moved: number, grounded: boolean, climb: number): void {
    this.gait.update(dt, moved, grounded, climb);
  }

  /** Poses the figure with its feet at (x, y, z), facing the heading `yaw` (it faces (−sin yaw, −cos yaw)). Returns the bones. */
  pose(x: number, y: number, z: number, yaw: number): Float64Array {
    const c = Math.cos(yaw), s = Math.sin(yaw), k = this.scale;
    const r = this.root;
    r[0] = -c * k;
    r[1] = 0;
    r[2] = s * k;
    r[3] = 0;
    r[4] = k;
    r[5] = 0;
    r[6] = -s * k;
    r[7] = 0;
    r[8] = -c * k;
    r[9] = x;
    r[10] = y;
    r[11] = z;
    this.y = y;
    const bones = this.gait.solve(r, this.ground, y);
    this.tailAngle = this.gait.applyLag(r);
    return bones;
  }
}
