// Perspective camera rig that follows a moving point: a pivot above the followed point that trails it with a lag, and a
// boom from the pivot back to the eye, turned by a yaw around the vertical axis and a pitch above the horizon. A
// clearance callback (typically a collision world's sphere cast) shortens the boom at once where something stands
// between the pivot and the eye; the boom grows back smoothly. A boom of length 0 is the view from the pivot itself.
// Keys, pointer and gamepad are bound by `bindWalkInput` in platform. Implements `View` for the renderer.
//
// Flat world only: up is +y. A curved world would take the unit up at the pivot from an up source (as `FreeRig` does)
// in `update` and build the horizon of `axes` and `forward` from it; the places are marked "up:" below.

import { DEG, clamp, crossInto, dot, normalize, cross } from '../base/math.ts';
import type { OrthoFrame, Vec3 } from '../base/math.ts';
import type { CullFrustum, Ray, View } from '../base/view.ts';

/**
 * How far the boom may reach from the pivot (ox, oy, oz) along the unit direction (dx, dy, dz), at most `maxDist`.
 * Return `maxDist` where the way is free. Close over the radius of the sphere you cast, so the near plane stays clear.
 */
export type BoomClearance = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number) => number;

export interface FollowSetup {
  /** Vertical field of view in degrees. */
  fovDeg: number;
  /** Near and far plane in metres. The scene's depth range may pull them closer together, never apart. */
  near: number;
  far: number;
  /** Boom length limits, metres; 0 is the view from the pivot itself (first person). */
  minDistance: number;
  maxDistance: number;
  /** Pitch limits in degrees; positive looks down from above the pivot. */
  minPitchDeg: number;
  maxPitchDeg: number;
  /** Pivot above the followed point, metres. */
  pivotHeight: number;
  /** Seconds in which the pivot closes most (95 %) of the gap to the followed point; 0 follows rigidly. */
  followLag: number;
  /** Seconds in which a shortened boom regains most (95 %) of its length; 0 springs back at once. */
  boomReturn: number;
  /** Radians of turn per CSS pixel of pointer movement. */
  turnPerPx: number;
  /** Smallest distance in front of the eye that counts as the centre of the view (`metresPerPixel`, `refDepth`). */
  minFocus: number;
}

export const DEFAULT_FOLLOW: FollowSetup = {
  fovDeg: 60,
  near: 0.1,
  far: 2000,
  minDistance: 1,
  maxDistance: 12,
  minPitchDeg: -40,
  maxPitchDeg: 80,
  pivotHeight: 1.5,
  followLag: 0.15,
  boomReturn: 0.3,
  turnPerPx: 0.004,
  minFocus: 2,
};

export interface FollowOptions {
  /** Shortens the boom where something blocks it. Without it the boom always has its full length. */
  clearance?: BoomClearance;
}

/**
 * Everything that places a following view, as numbers: enough to put the eye back exactly. The followed point
 * belongs to the caller (a figure the game moves); the next `follow` and `update` move the view on from here.
 */
export interface FollowState {
  /** The followed point as last given to `follow`. */
  target: Vec3;
  /** The smoothed pivot (it may trail the followed point raised by `pivotHeight`). */
  pivot: Vec3;
  yawDeg: number;
  pitchDeg: number;
  /** The wanted boom length. */
  distance: number;
  /** The boom length drawn (shortened by the clearance, or growing back). */
  boom: number;
}

/** Below this boom length (with `minDistance` 0) zooming in snaps to the view from the pivot. */
const SNAP_TO_PIVOT = 0.5;

export class FollowRig implements View {
  readonly setup: FollowSetup;
  /** Heading in degrees; 0 looks toward −z, positive turns left. */
  yawDeg = 0;
  /** Pitch in degrees; positive looks down. Kept within the setup's limits by the methods, not on assignment. */
  pitchDeg = 20;
  /** Wanted boom length in metres; 0 is the view from the pivot. The drawn length is `boom`. */
  distance = 4;
  /** Shortens the boom; may be replaced at any time. */
  clearance: BoomClearance | null;
  /** Canvas size in physical pixels and physical pixels per CSS pixel. */
  width = 1;
  height = 1;
  dpr = 1;
  /** The followed point as last given to `follow`. */
  readonly target: Vec3 = [0, 0, 0];
  /** The smoothed pivot the boom turns around (followed point raised by `pivotHeight`, trailing it by `followLag`). */
  readonly pivot: Vec3 = [0, 0, 0];
  /** The boom length drawn: `distance`, shortened by the clearance and growing back smoothly. */
  private _boom = 4;
  /** False until the first `follow`: the pivot then jumps to the target instead of trailing it from the origin. */
  private placed = false;
  private readonly scratch: OrthoFrame = { right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0] };
  private readonly scratchVp: OrthoFrame = { right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0] };
  private readonly scratchEye: Vec3 = [0, 0, 0];
  /** The numbers the last `key` was made from (NaN: none yet) and that key. */
  private readonly keyOf = new Float64Array(9).fill(NaN);
  private keyText = '';

  constructor(setup: Partial<FollowSetup> = {}, options: FollowOptions = {}) {
    this.setup = { ...DEFAULT_FOLLOW, ...setup };
    this.clearance = options.clearance ?? null;
    this.distance = clamp(this.distance, this.setup.minDistance, this.setup.maxDistance);
    this._boom = this.distance;
    this.pitchDeg = clamp(this.pitchDeg, this.setup.minPitchDeg, this.setup.maxPitchDeg);
  }

  /** The boom length drawn this frame, metres. */
  get boom(): number {
    return this._boom;
  }

  /** Sets the followed point (the walker's render position). The first call places the pivot there at once. */
  follow(x: number, y: number, z: number): void {
    const t = this.target;
    t[0] = x;
    t[1] = y;
    t[2] = z;
    if (!this.placed) this.snap();
  }

  /** Puts the pivot on the followed point and the boom at its wanted length at once (after a jump, a cut). */
  snap(): void {
    this.placed = true;
    const t = this.target;
    // up: the pivot height would be laid along the local up.
    this.pivot[0] = t[0];
    this.pivot[1] = t[1] + this.setup.pivotHeight;
    this.pivot[2] = t[2];
    this._boom = this.reach(this.distance);
  }

  /** The view as numbers (copies), for `setState`. */
  state(): FollowState {
    const t = this.target;
    const p = this.pivot;
    return { target: [t[0], t[1], t[2]], pivot: [p[0], p[1], p[2]], yawDeg: this.yawDeg, pitchDeg: this.pitchDeg, distance: this.distance, boom: this._boom };
  }

  /**
   * Puts the view at a state as it is, without smoothing and without asking the clearance (a recorded view comes back
   * bit for bit). Left-out parts keep their values; without `boom` the boom gets the length the clearance allows for
   * `distance`. The followed point is the caller's: the next `follow` and `update` move the view on from here.
   */
  setState(s: Partial<FollowState>): void {
    if (s.target) {
      this.target[0] = s.target[0];
      this.target[1] = s.target[1];
      this.target[2] = s.target[2];
    }
    if (s.yawDeg !== undefined) this.yawDeg = s.yawDeg;
    if (s.pitchDeg !== undefined) this.pitchDeg = s.pitchDeg;
    if (s.distance !== undefined) this.distance = s.distance;
    if (s.pivot) {
      this.pivot[0] = s.pivot[0];
      this.pivot[1] = s.pivot[1];
      this.pivot[2] = s.pivot[2];
    }
    if (s.target || s.pivot) this.placed = true;
    this._boom = s.boom ?? this.reach(this.distance);
  }

  /** Smooths the pivot and shortens the boom by `clearance`; call once per frame with the real seconds since the last. */
  update(dt: number): void {
    const s = this.setup;
    const t = this.target;
    const p = this.pivot;
    const step = Math.max(0, dt);
    // 1 − e^(−3 t / lag) closes 95 % of the gap in `lag` seconds, whatever the frame rate.
    const k = s.followLag > 0 ? 1 - Math.exp((-3 * step) / s.followLag) : 1;
    // up: the pivot height would be laid along the local up.
    p[0] += (t[0] - p[0]) * k;
    p[1] += (t[1] + s.pivotHeight - p[1]) * k;
    p[2] += (t[2] - p[2]) * k;
    const want = this.reach(this.distance);
    if (want <= this._boom) this._boom = want;
    else {
      const g = s.boomReturn > 0 ? 1 - Math.exp((-3 * step) / s.boomReturn) : 1;
      this._boom += (want - this._boom) * g;
      // Close enough is there: the key, and with it a still image, settles.
      if (want - this._boom < 1e-4) this._boom = want;
    }
  }

  /** The length a boom of `wanted` metres may have now: the clearance along the boom's direction from the pivot. */
  private reach(wanted: number): number {
    if (wanted <= 0) return 0;
    if (!this.clearance) return wanted;
    const f = this.axes(this.scratch).forward;
    const p = this.pivot;
    // The boom runs from the pivot against the view direction.
    const r = this.clearance(p[0], p[1], p[2], -f[0], -f[1], -f[2], wanted);
    return Number.isFinite(r) ? clamp(r, 0, wanted) : wanted;
  }

  /** Turns by pointer movement in physical pixels: right turns the view right, down turns it down. */
  turnPixels(dx: number, dy: number): void {
    const k = this.setup.turnPerPx / this.dpr / DEG;
    this.yawDeg -= dx * k;
    // Keep the heading within ±180° so the key stays short and comparable.
    if (this.yawDeg > 180) this.yawDeg -= 360;
    else if (this.yawDeg < -180) this.yawDeg += 360;
    this.pitchDeg = clamp(this.pitchDeg + dy * k, this.setup.minPitchDeg, this.setup.maxPitchDeg);
  }

  /**
   * Multiplies the wanted boom length (below 1 comes closer), within `minDistance` … `maxDistance`. With
   * `minDistance` 0 a boom shorter than half a metre becomes 0, the view from the pivot; zooming out from 0 starts at
   * `max(minDistance, 0.5)`.
   */
  zoomBy(factor: number): void {
    const s = this.setup;
    if (this.distance <= 0) {
      if (factor > 1) this.distance = Math.max(s.minDistance, SNAP_TO_PIVOT);
      return;
    }
    let d = clamp(this.distance * factor, s.minDistance, s.maxDistance);
    if (s.minDistance <= 0 && d < SNAP_TO_PIVOT && factor < 1) d = 0;
    this.distance = d;
  }

  /** Unit direction on the ground plane the view looks along, for turning input into world movement. Written to `out`. */
  forward(out: number[]): number[] {
    const yaw = this.yawDeg * DEG;
    // up: on a curved world this is the heading laid into the local horizon.
    out[0] = -Math.sin(yaw);
    out[1] = 0;
    out[2] = -Math.cos(yaw);
    return out;
  }

  /** View: rotation around the vertical axis in radians. */
  get heading(): number {
    return this.yawDeg * DEG;
  }

  private get tanHalfY(): number {
    return Math.tan((this.setup.fovDeg * DEG) / 2);
  }

  /** Distance in front of the eye that counts as the centre of the view: the pivot, or `minFocus` when closer. */
  private get focus(): number {
    return Math.max(this._boom, this.setup.minFocus);
  }

  /** View: pixel size at the centre of the view. */
  get metresPerPixel(): number {
    return this.focus * this.pixelGrowth;
  }

  /** View: metres per pixel gained per metre of depth. */
  get pixelGrowth(): number {
    return (2 * this.tanHalfY) / this.height;
  }

  /** View: depth of the centre of the view along the view direction. */
  get refDepth(): number {
    const f = this.axes(this.scratch).forward;
    return dot(f, this.eye(this.scratchEye)) + this.focus;
  }

  /** View: screen right, screen up and the view direction. With `out` its arrays are written and `out` is returned. */
  axes(out?: OrthoFrame): OrthoFrame {
    const yaw = this.yawDeg * DEG;
    const p = this.pitchDeg * DEG;
    const f = out ?? { right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0] };
    // up: the horizon here is the plane normal to +y.
    f.right[0] = Math.cos(yaw);
    f.right[1] = 0;
    f.right[2] = -Math.sin(yaw);
    f.forward[0] = -Math.sin(yaw) * Math.cos(p);
    f.forward[1] = -Math.sin(p);
    f.forward[2] = -Math.cos(yaw) * Math.cos(p);
    crossInto(f.right, f.forward, f.up);
    return f;
  }

  /** The eye: the pivot moved back along the view direction by the drawn boom. With `out` it is written there. */
  eye(out?: Vec3): Vec3 {
    const f = this.axes(this.scratch).forward;
    const p = this.pivot;
    const b = this._boom;
    const e: Vec3 = out ?? [0, 0, 0];
    e[0] = p[0] - f[0] * b;
    e[1] = p[1] - f[1] * b;
    e[2] = p[2] - f[2] * b;
    return e;
  }

  /**
   * World → clip matrix. The near and far planes are the setup's, pulled in to the sphere of `depthHalfRange` around
   * `sceneCenter` where it is smaller (never pushed out).
   */
  viewProj(sceneCenter: Vec3, depthHalfRange: number, out?: Float32Array): Float32Array {
    const { right: r, up: u, forward: w } = this.axes(this.scratchVp);
    const eye = this.eye(this.scratchEye);
    const s = this.setup;
    const dc = dot(w, sceneCenter) - dot(w, eye);
    const near = Math.max(s.near, dc - depthHalfRange);
    const far = Math.max(Math.min(s.far, dc + depthHalfRange), near * 2);
    const fy = 1 / this.tanHalfY;
    const fx = fy / (this.width / this.height);
    const a = (far + near) / (far - near);
    const b = (-2 * far * near) / (far - near);
    const m = out ?? new Float32Array(16);
    m.fill(0);
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

  /** Direction through a point in normalised screen coordinates (−1…1, y up) for the axes `ax`, written into `out`. */
  private dirInto(sx: number, sy: number, ax: OrthoFrame, out: Vec3): Vec3 {
    const { right, up, forward } = ax;
    const ty = this.tanHalfY;
    const tx = ty * (this.width / this.height);
    const x = forward[0] + right[0] * sx * tx + up[0] * sy * ty;
    const y = forward[1] + right[1] * sx * tx + up[1] * sy * ty;
    const z = forward[2] + right[2] * sx * tx + up[2] * sy * ty;
    const l = Math.hypot(x, y, z) || 1;
    out[0] = x / l;
    out[1] = y / l;
    out[2] = z / l;
    return out;
  }

  /**
   * View: rays from the eye through the image corners (left-bottom, left-top, right-bottom, right-top). With `out`
   * (see `newCornerRays`) each ray's own arrays are written and `out` is returned.
   */
  cornerRays(out?: Ray[]): Ray[] {
    const ax = this.axes(this.scratchVp);
    if (!out) {
      const eye = this.eye();
      const rays: Ray[] = [];
      for (let i = 0; i < 4; i++) rays.push({ origin: eye, dir: this.dirInto(i < 2 ? -1 : 1, i % 2 === 0 ? -1 : 1, ax, [0, 0, 0]) });
      return rays;
    }
    for (let i = 0; i < 4; i++) {
      const r = out[i]!;
      this.eye(r.origin);
      this.dirInto(i < 2 ? -1 : 1, i % 2 === 0 ? -1 : 1, ax, r.dir);
    }
    return out;
  }

  /** View: the four side planes through the eye and the plane of the eye itself, normals inward. */
  cullVolume(): CullFrustum {
    const eye = this.eye();
    const ax = this.axes();
    const forward = ax.forward;
    const d = [this.dirInto(-1, -1, ax, [0, 0, 0]), this.dirInto(-1, 1, ax, [0, 0, 0]), this.dirInto(1, 1, ax, [0, 0, 0]), this.dirInto(1, -1, ax, [0, 0, 0])];
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
    const p = this.pivot;
    // The string is made again only when a number in it changed, so a still view allocates nothing.
    const k = this.keyOf;
    if (k[0] === p[0] && k[1] === p[1] && k[2] === p[2] && k[3] === this.yawDeg && k[4] === this.pitchDeg && k[5] === this._boom && k[6] === this.width && k[7] === this.height && k[8] === this.setup.fovDeg) return this.keyText;
    k[0] = p[0];
    k[1] = p[1];
    k[2] = p[2];
    k[3] = this.yawDeg;
    k[4] = this.pitchDeg;
    k[5] = this._boom;
    k[6] = this.width;
    k[7] = this.height;
    k[8] = this.setup.fovDeg;
    this.keyText = `follow|${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}|${this.yawDeg.toFixed(4)}|${this.pitchDeg.toFixed(4)}|${this._boom.toFixed(3)}|${this.setup.fovDeg}|${this.width}x${this.height}`;
    return this.keyText;
  }

  /** Ray under a screen point in physical pixels from the top-left corner. */
  screenRay(px: number, py: number): Ray {
    return { origin: this.eye(), dir: this.dirInto((2 * px) / this.width - 1, 1 - (2 * py) / this.height, this.axes(), [0, 0, 0]) };
  }

  /** Where a world point lands on the canvas, in physical pixels from the top-left corner. */
  project(p: Vec3): [number, number] {
    const { right, up, forward } = this.axes();
    const e = this.eye();
    const v: Vec3 = [p[0] - e[0], p[1] - e[1], p[2] - e[2]];
    const z = dot(forward, v);
    const ty = this.tanHalfY;
    const tx = ty * (this.width / this.height);
    return [((dot(right, v) / (z * tx) + 1) * this.width) / 2, ((1 - dot(up, v) / (z * ty)) * this.height) / 2];
  }
}
