// Perspective camera rig that orbits a target point: yaw around the vertical axis, pitch above the horizon and a
// distance. Drag turns it, the wheel zooms (see `bindOrbitInput` in platform). Implements `View` for the renderer.

import { DEG, clamp, cross, crossInto, dot, normalize } from '../base/math.ts';
import type { OrthoFrame, Vec3 } from '../base/math.ts';
import type { CullFrustum, Ray, View } from '../base/view.ts';

export interface OrbitSetup {
  /** Vertical field of view in degrees. */
  fovYDeg: number;
  /** Limits of the pitch above the horizon and of the distance to the target. */
  minPitchDeg: number;
  maxPitchDeg: number;
  minDistance: number;
  maxDistance: number;
  /** Radians of turn per CSS pixel of drag. */
  turnPerPx: number;
  /**
   * Height of the ground under a point (x, z), for keeping the eye above it. Optional: without it nothing is kept
   * and the rig behaves as it always did.
   */
  groundAt?: ((x: number, z: number) => number) | null;
  /** Least height of the eye over `groundAt`, metres. Default 1. Read only when `groundAt` is set. */
  minEyeHeight?: number;
}

export const DEFAULT_ORBIT: OrbitSetup = { fovYDeg: 45, minPitchDeg: 5, maxPitchDeg: 85, minDistance: 2, maxDistance: 500, turnPerPx: 0.006 };

export interface OrbitState {
  target: Vec3;
  yawDeg: number;
  pitchDeg: number;
  distance: number;
}

export class PerspectiveOrbitRig implements View {
  readonly setup: OrbitSetup;
  target: Vec3 = [0, 0, 0];
  /** Rotation around the vertical axis in radians; 0 looks toward −z. */
  yaw = 0;
  /** Elevation of the view above the horizon in radians (positive looks down). */
  pitch = 30 * DEG;
  distance = 50;
  /** Canvas size in physical pixels and physical pixels per CSS pixel. */
  width = 1;
  height = 1;
  dpr = 1;
  /** Scratch of the methods that take `out`, so they allocate nothing themselves. */
  private readonly scratch: OrthoFrame = { right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0] };
  private readonly scratchVp: OrthoFrame = { right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0] };
  private readonly scratchEye: Vec3 = [0, 0, 0];
  /** The numbers the last `key` was made from (NaN: none yet) and that key. */
  private readonly keyOf = new Float64Array(8).fill(NaN);
  private keyText = '';

  constructor(setup: Partial<OrbitSetup> = {}, state?: Partial<OrbitState>) {
    this.setup = { ...DEFAULT_ORBIT, ...setup };
    if (state) this.setState(state);
  }

  setState(s: Partial<OrbitState>): void {
    if (s.target) this.target = [...s.target];
    if (s.yawDeg !== undefined) this.yaw = s.yawDeg * DEG;
    if (s.pitchDeg !== undefined) this.pitch = clamp(s.pitchDeg, this.setup.minPitchDeg, this.setup.maxPitchDeg) * DEG;
    if (s.distance !== undefined) this.distance = clamp(s.distance, this.setup.minDistance, this.setup.maxDistance);
    this.keepAboveGround();
  }

  /**
   * With `setup.groundAt`: raises the pitch (never above `maxPitchDeg`) until the eye stands at least `minEyeHeight`
   * over the ground, the least raise that does it (to a hundredth of a degree). `setState`, `orbitPixels` and `zoomBy`
   * call it; call it yourself when the ground under the eye changed. Returns whether the pitch changed. Allocates
   * nothing; without `groundAt` it does nothing.
   */
  keepAboveGround(): boolean {
    const ground = this.setup.groundAt;
    if (!ground) return false;
    const min = this.setup.minEyeHeight ?? 1;
    const maxPitch = this.setup.maxPitchDeg * DEG;
    const start = this.pitch;
    if (this.eyeClear(ground, min, start) >= 0 || start >= maxPitch) return false;
    if (this.eyeClear(ground, min, maxPitch) < 0) {
      this.pitch = maxPitch;
      return true;
    }
    // Bisection between a pitch that is too low and one that clears the ground.
    let lo = start;
    let hi = maxPitch;
    while (hi - lo > 1e-4) {
      const mid = (lo + hi) / 2;
      if (this.eyeClear(ground, min, mid) >= 0) hi = mid;
      else lo = mid;
    }
    this.pitch = hi;
    return true;
  }

  /** Height of the eye over the ground minus `min` for the pitch `p`, the rest of the state as it is. */
  private eyeClear(ground: (x: number, z: number) => number, min: number, p: number): number {
    const t = this.target;
    const d = this.distance;
    const h = Math.cos(p) * d;
    const x = t[0] + Math.sin(this.yaw) * h;
    const y = t[1] + Math.sin(p) * d;
    const z = t[2] + Math.cos(this.yaw) * h;
    return y - ground(x, z) - min;
  }

  state(): OrbitState {
    return { target: [...this.target], yawDeg: this.yaw / DEG, pitchDeg: this.pitch / DEG, distance: this.distance };
  }

  get heading(): number {
    return this.yaw;
  }

  private get tanHalfY(): number {
    return Math.tan((this.setup.fovYDeg * DEG) / 2);
  }

  /** View: pixel size at the target. */
  get metresPerPixel(): number {
    return this.distance * this.pixelGrowth;
  }

  /** View: metres per pixel gained per metre of depth. */
  get pixelGrowth(): number {
    return (2 * this.tanHalfY) / this.height;
  }

  /** View: depth of the target along the view direction. */
  get refDepth(): number {
    return dot(this.axes(this.scratch).forward, this.target);
  }

  /** View: screen right, screen up and the view direction. With `out` its arrays are written and `out` is returned. */
  axes(out?: OrthoFrame): OrthoFrame {
    const yaw = this.yaw;
    const p = this.pitch;
    const f = out ?? { right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0] };
    const right = f.right;
    const forward = f.forward;
    right[0] = Math.cos(yaw);
    right[1] = 0;
    right[2] = -Math.sin(yaw);
    forward[0] = -Math.sin(yaw) * Math.cos(p);
    forward[1] = -Math.sin(p);
    forward[2] = -Math.cos(yaw) * Math.cos(p);
    crossInto(right, forward, f.up);
    return f;
  }

  /** The eye: the target moved back along the view direction by the distance. With `out` it is written there. */
  eye(out?: Vec3): Vec3 {
    const f = this.axes(this.scratch).forward;
    const t = this.target;
    const d = this.distance;
    const e: Vec3 = out ?? [0, 0, 0];
    e[0] = t[0] - f[0] * d;
    e[1] = t[1] - f[1] * d;
    e[2] = t[2] - f[2] * d;
    return e;
  }

  /** World → clip matrix. Near and far planes enclose the sphere of `depthHalfRange` around `sceneCenter`. */
  viewProj(sceneCenter: Vec3, depthHalfRange: number, out?: Float32Array): Float32Array {
    const { right: r, up: u, forward: w } = this.axes(this.scratchVp);
    const eye = this.eye(this.scratchEye);
    const dc = dot(w, sceneCenter) - dot(w, eye);
    const far = Math.max(dc + depthHalfRange, 1);
    const near = Math.max(dc - depthHalfRange, far / 2000, 0.05);
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

  /** `dirAt` for the axes `ax`, written into `out` (the same numbers, nothing allocated). */
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

  /**
   * View: rays from the eye through the image corners. Without `out` the four rays share one origin array; with `out`
   * (see `newCornerRays`) each ray's own arrays are written and `out` is returned.
   */
  cornerRays(out?: Ray[]): Ray[] {
    if (!out) {
      const eye = this.eye();
      const rays: Ray[] = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) rays.push({ origin: eye, dir: this.dirAt(sx, sy) });
      return rays;
    }
    const ax = this.axes(this.scratch);
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

  key(): string {
    const t = this.target;
    // The string is made again only when a number in it changed, so a still view allocates nothing.
    const k = this.keyOf;
    if (k[0] === t[0] && k[1] === t[1] && k[2] === t[2] && k[3] === this.yaw && k[4] === this.pitch && k[5] === this.distance && k[6] === this.width && k[7] === this.height) return this.keyText;
    k[0] = t[0];
    k[1] = t[1];
    k[2] = t[2];
    k[3] = this.yaw;
    k[4] = this.pitch;
    k[5] = this.distance;
    k[6] = this.width;
    k[7] = this.height;
    this.keyText = `orbit|${t[0].toFixed(3)},${t[1].toFixed(3)},${t[2].toFixed(3)}|${this.yaw.toFixed(5)}|${this.pitch.toFixed(5)}|${this.distance.toFixed(3)}|${this.width}x${this.height}`;
    return this.keyText;
  }

  /** Ray under a screen point in physical pixels from the top-left corner. */
  screenRay(px: number, py: number): Ray {
    return { origin: this.eye(), dir: this.dirAt((2 * px) / this.width - 1, 1 - (2 * py) / this.height) };
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

  /** Drag by physical pixels: horizontal turns around the target, vertical tilts. */
  orbitPixels(dx: number, dy: number): void {
    const k = this.setup.turnPerPx / this.dpr;
    this.yaw -= dx * k;
    this.pitch = clamp(this.pitch + dy * k, this.setup.minPitchDeg * DEG, this.setup.maxPitchDeg * DEG);
    this.keepAboveGround();
  }

  /** Multiplies the distance to the target (below 1 comes closer). */
  zoomBy(factor: number): void {
    this.distance = clamp(this.distance * factor, this.setup.minDistance, this.setup.maxDistance);
    this.keepAboveGround();
  }
}
