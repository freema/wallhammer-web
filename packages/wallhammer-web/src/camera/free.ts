// Perspective camera rig that moves freely: a position in world metres (double precision), a heading along the local
// horizon and a pitch. The up direction is asked from an up source (a `WorldShape`) at the rig's position, so nothing
// here assumes which axis is up and the same rig serves a flat and a curved world. An optional callback tells the
// height above the surface; the rig uses it to keep a minimum clearance, to scale its speed and to place the near
// plane. The renderer sees the rig relative to `origin`, so only a difference of doubles ever becomes a float.
// Keys and pointer are bound by `bindFreeInput` in platform. Implements `View` for the renderer.

import { DEG, clamp, cross, dot, normalize } from '../base/math.ts';
import type { OrthoFrame, Vec3 } from '../base/math.ts';
import type { CullFrustum, Ray, View } from '../base/view.ts';
import type { WorldPos, WorldShape } from '../gen-core/index.ts';

/** The part of a world shape the rig reads: the unit up direction at a world position. */
export type UpSource = Pick<WorldShape, 'upAt'>;

/** Height of a world position above the surface under it, measured along the local up, in metres. */
export type HeightAbove = (p: WorldPos) => number;

export interface FreeSetup {
  /** Vertical field of view in degrees. */
  fovYDeg: number;
  /** Limit of the pitch on both sides of the horizon, in degrees (at most 90). */
  maxPitchDeg: number;
  /** Radians of turn per CSS pixel of pointer movement. */
  turnPerPx: number;
  /** Height above the surface the rig never goes below, in metres. Needs a height callback. */
  minClearance: number;
  /**
   * `true`: a move keeps the height above the surface, so the rig follows the surface up and down and only the part of
   * a move along the local up changes that height. `false`: the rig keeps its course and only `minClearance` holds it
   * off the surface. Needs a height callback.
   */
  followSurface: boolean;
  /** Cruise speed gained per metre of height above the surface (1 crosses its own height every second). */
  speedPerHeight: number;
  /** Limits of the cruise speed in metres per second. Without a height callback the rig cruises at `minSpeed`. */
  minSpeed: number;
  maxSpeed: number;
  /** Speed factor while the boost is held. */
  boost: number;
  /** Time constant in seconds with which the velocity follows the input; 0 follows it at once. */
  inertiaS: number;
  /** `true`: "forward" moves along the horizon whatever the pitch. `false`: it moves along the view direction. */
  levelMove: boolean;
  /** Largest ratio of the far to the near plane. The near plane sits at far / depthRatio unless the surface is closer. */
  depthRatio: number;
  /** The near plane is never farther than this fraction of the height above the surface (when it is known). */
  nearPerHeight: number;
  /** Smallest distance of the near plane in metres. */
  minNear: number;
}

export const DEFAULT_FREE: FreeSetup = {
  fovYDeg: 50,
  maxPitchDeg: 89,
  turnPerPx: 0.004,
  minClearance: 2,
  followSurface: false,
  speedPerHeight: 1,
  minSpeed: 5,
  maxSpeed: 5000,
  boost: 6,
  inertiaS: 0.12,
  levelMove: false,
  depthRatio: 2000,
  nearPerHeight: 0.25,
  minNear: 0.1,
};

export interface FreeOptions {
  /** Where up is. The default is +y everywhere, as on a flat world. */
  shape?: UpSource;
  /** Height above the surface. Without it the rig neither keeps a clearance nor scales its speed. */
  heightAbove?: HeightAbove;
}

export interface FreeState {
  /** World position in metres. */
  position: Vec3;
  /** Heading in degrees, measured in the local horizon from the world −z axis; positive turns left. */
  yawDeg: number;
  /** Pitch in degrees; positive looks below the horizon. */
  pitchDeg: number;
}

const UP_Y: UpSource = { upAt: () => [0, 1, 0] };

/**
 * Reference directions in the horizon of `up`: the world −z axis laid into the horizon (heading 0) and the direction a
 * quarter turn to its left (heading 90°). Where up runs along z, the +x axis takes the place of −z.
 */
export function horizonRef(up: Vec3): [Vec3, Vec3] {
  // (−z) − up·((−z)·up)
  let n: Vec3 = [up[0] * up[2], up[1] * up[2], up[2] * up[2] - 1];
  if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 1e-12) n = [1 - up[0] * up[0], -up[1] * up[0], -up[2] * up[0]];
  const ahead = normalize(n);
  return [ahead, cross(up, ahead)];
}

export class FreeRig implements View {
  readonly setup: FreeSetup;
  /** World position of the eye in metres. After writing it directly call `keepClear()`. */
  position: Vec3 = [0, 0, 0];
  /**
   * World position the renderer's space starts at. Every position the `View` contract hands out (`eye`, rays, the
   * cull volume, the matrix) is relative to it. Keep it near the eye and equal to the origin the layers are drawn with.
   */
  origin: Vec3 = [0, 0, 0];
  /** Pitch in radians; positive looks below the horizon. */
  pitch = 0;
  /** Roll about the view direction in radians, positive banks to the right. Default 0; turning and moving keep it. */
  roll = 0;
  /** Multiplier of the cruise speed the user controls (see `scaleSpeed`). */
  speedScale = 1;
  /** World velocity in metres per second after the last `move`. */
  velocity: Vec3 = [0, 0, 0];
  /** Height above the surface at the last `keepClear`, NaN without a height callback. */
  clearance = NaN;
  /** Distance in front of the eye that counts as the centre of the view (`metresPerPixel`, `refDepth`). */
  focusDistance = 50;
  /** Height above the surface, or null. May be replaced at any time. */
  heightAbove: HeightAbove | null;
  /** Canvas size in physical pixels and physical pixels per CSS pixel. */
  width = 1;
  height = 1;
  dpr = 1;
  private readonly shape: UpSource;
  /** Unit heading in the local horizon. */
  private tangent: Vec3 = [0, 0, -1];

  constructor(setup: Partial<FreeSetup> = {}, options: FreeOptions = {}, state?: Partial<FreeState>) {
    this.setup = { ...DEFAULT_FREE, ...setup };
    this.shape = options.shape ?? UP_Y;
    this.heightAbove = options.heightAbove ?? null;
    this.setState(state ?? {});
  }

  /** Jumps to a state: the velocity is dropped on a new position and the clearance is applied. */
  setState(s: Partial<FreeState>): void {
    if (s.position) {
      this.position = [s.position[0], s.position[1], s.position[2]];
      this.velocity = [0, 0, 0];
    }
    // After the position: the reference of the heading depends on where up is there.
    if (s.yawDeg !== undefined) this.yaw = s.yawDeg * DEG;
    if (s.pitchDeg !== undefined) this.pitch = this.clampPitch(s.pitchDeg * DEG);
    this.keepClear();
  }

  state(): FreeState {
    const p = this.position;
    return { position: [p[0], p[1], p[2]], yawDeg: this.yaw / DEG, pitchDeg: this.pitch / DEG };
  }

  private clampPitch(p: number): number {
    const m = Math.min(90, this.setup.maxPitchDeg) * DEG;
    return clamp(p, -m, m);
  }

  /**
   * Unit up at the position. The position may have moved to a place with another up since the heading was stored, so
   * this also lays the heading back into the horizon (the same heading, carried along).
   */
  up(): Vec3 {
    const up = this.shape.upAt(this.position);
    const t = this.tangent;
    const d = dot(t, up);
    // On a flat world the heading never leaves the horizon and stays bit for bit as it was.
    if (Math.abs(d) > 1e-12) {
      const h: Vec3 = [t[0] - up[0] * d, t[1] - up[1] * d, t[2] - up[2] * d];
      // A heading that ran along the new up has no direction left: take the reference one.
      this.tangent = h[0] * h[0] + h[1] * h[1] + h[2] * h[2] < 1e-12 ? horizonRef(up)[0] : normalize(h);
    }
    return up;
  }

  /** Unit direction of the heading in the local horizon (the view direction without its pitch). */
  headingDir(): Vec3 {
    this.up();
    const t = this.tangent;
    return [t[0], t[1], t[2]];
  }

  /** Heading in radians, measured in the local horizon from the world −z axis; positive turns left. */
  get yaw(): number {
    const [ahead, left] = horizonRef(this.up());
    return Math.atan2(dot(this.tangent, left), dot(this.tangent, ahead));
  }

  set yaw(a: number) {
    const [ahead, left] = horizonRef(this.shape.upAt(this.position));
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.tangent = [ahead[0] * c + left[0] * s, ahead[1] * c + left[1] * s, ahead[2] * c + left[2] * s];
  }

  /** View: rotation around the local up in radians. */
  get heading(): number {
    return this.yaw;
  }

  private get tanHalfY(): number {
    return Math.tan((this.setup.fovYDeg * DEG) / 2);
  }

  /** View: pixel size at `focusDistance` in front of the eye. */
  get metresPerPixel(): number {
    return this.focusDistance * this.pixelGrowth;
  }

  /** View: metres per pixel gained per metre of depth. */
  get pixelGrowth(): number {
    return (2 * this.tanHalfY) / this.height;
  }

  /** View: depth of the point `focusDistance` in front of the eye, in the renderer's space. */
  get refDepth(): number {
    return dot(this.axes().forward, this.eye()) + this.focusDistance;
  }

  /** Screen right, screen up and the view direction, built from the local up, the heading and the pitch. */
  axes(): OrthoFrame {
    const up = this.up();
    const t = this.tangent;
    const c = Math.cos(this.pitch);
    const s = Math.sin(this.pitch);
    const right = cross(t, up);
    const forward: Vec3 = [t[0] * c - up[0] * s, t[1] * c - up[1] * s, t[2] * c - up[2] * s];
    const screenUp = cross(right, forward);
    if (this.roll === 0) return { right, forward, up: screenUp };
    const cr = Math.cos(this.roll);
    const sr = Math.sin(this.roll);
    return {
      right: [right[0] * cr - screenUp[0] * sr, right[1] * cr - screenUp[1] * sr, right[2] * cr - screenUp[2] * sr],
      forward,
      up: [screenUp[0] * cr + right[0] * sr, screenUp[1] * cr + right[1] * sr, screenUp[2] * cr + right[2] * sr],
    };
  }

  /** The eye in the renderer's space: the world position minus `origin`, subtracted in double precision. With `out` it is written there. */
  eye(out?: Vec3): Vec3 {
    const p = this.position;
    const o = this.origin;
    if (!out) return [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    out[0] = p[0] - o[0];
    out[1] = p[1] - o[1];
    out[2] = p[2] - o[2];
    return out;
  }

  /**
   * World → clip matrix (the world here is the renderer's space). The far plane encloses the sphere of
   * `depthHalfRange` around `sceneCenter`. The near plane sits at far / `depthRatio`, but no farther than
   * `nearPerHeight` of the height above the surface, so that the surface under a low eye is not cut away.
   */
  viewProj(sceneCenter: Vec3, depthHalfRange: number): Float32Array {
    const { right: r, up: u, forward: w } = this.axes();
    const eye = this.eye();
    const s = this.setup;
    const dc = dot(w, sceneCenter) - dot(w, eye);
    const far = Math.max(dc + depthHalfRange, 1);
    let ahead = far / s.depthRatio;
    if (Number.isFinite(this.clearance)) ahead = Math.min(ahead, this.clearance * s.nearPerHeight);
    // A scene that starts farther away than that moves the near plane out to its own start, as nothing is in front of it.
    const near = Math.max(dc - depthHalfRange, Math.min(Math.max(ahead, s.minNear), far / 2));
    const fy = 1 / this.tanHalfY;
    const fx = fy / (this.width / this.height);
    const a = (far + near) / (far - near);
    const b = (-2 * far * near) / (far - near);
    const m = new Float32Array(16);
    const re = dot(r, eye);
    const ue = dot(u, eye);
    const we = dot(w, eye);
    for (let i = 0; i < 3; i++) {
      m[i * 4 + 0] = fx * r[i]!;
      m[i * 4 + 1] = fy * u[i]!;
      m[i * 4 + 2] = a * w[i]!;
      m[i * 4 + 3] = w[i]!;
    }
    m[12] = -fx * re;
    m[13] = -fy * ue;
    m[14] = -a * we + b;
    m[15] = -we;
    return m;
  }

  /** Direction through a point given in normalised screen coordinates (−1…1, y up). */
  private dirAt(sx: number, sy: number): Vec3 {
    const { right, up, forward } = this.axes();
    const ty = this.tanHalfY;
    const tx = ty * (this.width / this.height);
    return normalize([
      forward[0] + right[0] * sx * tx + up[0] * sy * ty,
      forward[1] + right[1] * sx * tx + up[1] * sy * ty,
      forward[2] + right[2] * sx * tx + up[2] * sy * ty,
    ]);
  }

  /** View: rays from the eye through the image corners (left-bottom, left-top, right-bottom, right-top). */
  cornerRays(): Ray[] {
    const eye = this.eye();
    const rays: Ray[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) rays.push({ origin: eye, dir: this.dirAt(sx, sy) });
    return rays;
  }

  /** View: the four side planes through the eye and the plane of the eye itself, normals inward. */
  cullVolume(): CullFrustum {
    const eye = this.eye();
    const { forward } = this.axes();
    const d = [this.dirAt(-1, -1), this.dirAt(-1, 1), this.dirAt(1, 1), this.dirAt(1, -1)];
    const planes: [number, number, number, number][] = [[forward[0], forward[1], forward[2], -dot(forward, eye)]];
    for (let i = 0; i < 4; i++) {
      let n = normalize(cross(d[i]!, d[(i + 1) % 4]!));
      if (dot(n, forward) < 0) n = [-n[0], -n[1], -n[2]];
      planes.push([n[0], n[1], n[2], -dot(n, eye)]);
    }
    return { kind: 'frustum', planes };
  }

  /** View: changes whenever the image of a static scene would. */
  key(): string {
    this.up();
    const p = this.position;
    const o = this.origin;
    const t = this.tangent;
    return `free|${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}|${o[0]},${o[1]},${o[2]}|${t[0].toFixed(5)},${t[1].toFixed(5)},${t[2].toFixed(5)}|${this.pitch.toFixed(5)}|${this.clearance.toFixed(2)}|${this.width}x${this.height}|${this.setup.fovYDeg}${this.roll === 0 ? '' : `|r${this.roll.toFixed(5)}`}`;
  }

  /** Ray under a screen point in physical pixels from the top-left corner, in the renderer's space. */
  screenRay(px: number, py: number): Ray {
    return { origin: this.eye(), dir: this.dirAt((2 * px) / this.width - 1, 1 - (2 * py) / this.height) };
  }

  /** Where a point of the renderer's space lands on the canvas, in physical pixels from the top-left corner. */
  project(p: Vec3): [number, number] {
    const { right, up, forward } = this.axes();
    const e = this.eye();
    const v: Vec3 = [p[0] - e[0], p[1] - e[1], p[2] - e[2]];
    const z = dot(forward, v);
    const ty = this.tanHalfY;
    const tx = ty * (this.width / this.height);
    return [((dot(right, v) / (z * tx) + 1) * this.width) / 2, ((1 - dot(up, v) / (z * ty)) * this.height) / 2];
  }

  /** Turns by angles in radians: the heading around the local up (positive turns left), the pitch (positive looks down). */
  turn(yawDelta: number, pitchDelta: number): void {
    const up = this.up();
    const t = this.tangent;
    const left = cross(up, t);
    const c = Math.cos(yawDelta);
    const s = Math.sin(yawDelta);
    this.tangent = normalize([t[0] * c + left[0] * s, t[1] * c + left[1] * s, t[2] * c + left[2] * s]);
    this.pitch = this.clampPitch(this.pitch + pitchDelta);
  }

  /** Turns by pointer movement in physical pixels: right turns the view right, down turns it down. */
  turnPixels(dx: number, dy: number): void {
    const k = this.setup.turnPerPx / this.dpr;
    this.turn(-dx * k, dy * k);
  }

  /** Turns the view toward a world position. */
  lookAt(target: WorldPos): void {
    const up = this.up();
    const p = this.position;
    const d = normalize([target[0] - p[0], target[1] - p[1], target[2] - p[2]]);
    const rise = dot(d, up);
    const h: Vec3 = [d[0] - up[0] * rise, d[1] - up[1] * rise, d[2] - up[2] * rise];
    // Straight up or down keeps the heading.
    if (h[0] * h[0] + h[1] * h[1] + h[2] * h[2] > 1e-12) this.tangent = normalize(h);
    this.pitch = this.clampPitch(-Math.asin(clamp(rise, -1, 1)));
  }

  /** Cruise speed in metres per second at the current height, before the boost. */
  get speed(): number {
    const s = this.setup;
    const h = this.clearance;
    return (Number.isFinite(h) ? clamp(h * s.speedPerHeight, s.minSpeed, s.maxSpeed) : s.minSpeed) * this.speedScale;
  }

  /** Multiplies the user's speed multiplier, kept within 1/64 … 64. */
  scaleSpeed(factor: number): void {
    this.speedScale = clamp(this.speedScale * factor, 1 / 64, 64);
  }

  /**
   * Moves for `dt` seconds. The inputs are −1…1: `forward` along the view direction (along the horizon with
   * `levelMove`), `right` along screen right, `up` along the local up. The velocity follows the input with the
   * inertia of the setup. Returns whether the rig is still moving, so the caller knows to draw another frame.
   */
  move(forward: number, right: number, up: number, dt: number, boost = false): boolean {
    const upDir = this.up();
    const a = this.axes();
    const along = this.setup.levelMove ? this.tangent : a.forward;
    let dx = along[0] * forward + a.right[0] * right + upDir[0] * up;
    let dy = along[1] * forward + a.right[1] * right + upDir[1] * up;
    let dz = along[2] * forward + a.right[2] * right + upDir[2] * up;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1) {
      dx /= len;
      dy /= len;
      dz /= len;
    }
    const cruise = this.speed;
    const speed = cruise * (boost ? this.setup.boost : 1);
    const tau = this.setup.inertiaS;
    const k = tau > 0 ? 1 - Math.exp(-Math.max(0, dt) / tau) : 1;
    const v = this.velocity;
    v[0] += (dx * speed - v[0]) * k;
    v[1] += (dy * speed - v[1]) * k;
    v[2] += (dz * speed - v[2]) * k;
    // Without input the velocity only decays: below a small fraction of the cruise speed it is rest.
    if (len === 0 && Math.hypot(v[0], v[1], v[2]) < Math.max(1e-4, cruise * 0.02)) v[0] = v[1] = v[2] = 0;
    if (v[0] === 0 && v[1] === 0 && v[2] === 0) return false;
    if (dt > 0) {
      const p = this.position;
      this.position = [p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt];
      // Following the surface: the height asked for is the one before the step plus the step's part along up.
      const rise = (v[0] * upDir[0] + v[1] * upDir[1] + v[2] * upDir[2]) * dt;
      this.settle(this.setup.followSurface && Number.isFinite(this.clearance) ? this.clearance + rise : undefined);
    }
    return true;
  }

  /**
   * Reads the height above the surface and, where it is below `minClearance`, lifts the position along the local up.
   * `move` and `setState` call it; call it yourself after writing `position` or when the surface changed.
   */
  keepClear(): void {
    this.settle(undefined);
  }

  /** Moves the position along the local up to the height `hold` above the surface, or only up to `minClearance`. */
  private settle(hold: number | undefined): void {
    if (!this.heightAbove) {
      this.clearance = NaN;
      return;
    }
    let h = this.heightAbove(this.position);
    const want = Math.max(hold ?? h, this.setup.minClearance);
    // A height that is not a number (a callback without an answer there) leaves the position alone.
    if (want !== h && Number.isFinite(want) && Number.isFinite(h)) {
      const up = this.up();
      const lift = want - h;
      const p = this.position;
      this.position = [p[0] + up[0] * lift, p[1] + up[1] * lift, p[2] + up[2] * lift];
      h = want;
    }
    this.clearance = h;
  }
}
