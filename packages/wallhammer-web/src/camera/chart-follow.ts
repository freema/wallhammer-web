// A following view on a curved world: a `FollowRig` that runs in the flat coordinates of a `SurfaceChart` (base),
// shown in world space. The rig keeps all its behaviour there (the pivot's lag, the boom cut by a clearance from the
// chart's collision world and grown back, the input of `bindWalkInput`); this view places the rig as one rigid body at
// the pivot: the pivot through the chart, the boom and the axes turned by the chart's frame there, so the local up of
// the view is the sphere's up at the pivot and the pivot stays in the middle of the image. The chart bends the ground
// under a boom of length b by at most b² / (2 radius) against that rigid placement (2.5 cm for 10 m on a sphere of
// 2 km), which the radius of the clearance's sphere covers.
//
// Positions handed to the renderer are relative to `origin`, a render origin kept near the eye, as for `FreeRig`: the
// world eye is found in double precision and only its difference to the origin becomes a float, so the view holds a
// millimetre at 1e5 m from the world's origin.
//
// When the followed body is given a new chart (a rechart of `ChartWalker`), `setChart` carries the rig into it: the
// followed point and the pivot are moved to their coordinates in the new chart and the heading is turned by the
// difference of the two charts' frames, so the image does not move.

import type { SurfaceChart } from '../base/chart.ts';
import { DEG, cross, dot, normalize } from '../base/math.ts';
import type { OrthoFrame, Vec3 } from '../base/math.ts';
import { detAtan2 } from '../base/trig.ts';
import type { CullFrustum, Ray, View } from '../base/view.ts';
import type { FollowRig } from './follow.ts';
import { horizonRef } from './free.ts';

export class ChartFollowView implements View {
  /** The rig in chart coordinates: drive it as usual (`follow` with the body's chart position, `update`, input). */
  readonly rig: FollowRig;
  /**
   * World position the renderer's space starts at. Every position the `View` contract hands out is relative to it. Keep
   * it near the eye and equal to the origin the layers are drawn with.
   */
  origin: Vec3 = [0, 0, 0];
  private _chart: SurfaceChart;
  private readonly chartAxes: OrthoFrame = { right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0] };
  private readonly scratchAxes: OrthoFrame = { right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0] };
  private readonly t3: Vec3 = [0, 0, 0];
  private readonly w3: Vec3 = [0, 0, 0];
  private readonly b3: Vec3 = [0, 0, 0];

  constructor(rig: FollowRig, chart: SurfaceChart) {
    this.rig = rig;
    this._chart = chart;
  }

  /** The chart the rig runs in. */
  get chart(): SurfaceChart {
    return this._chart;
  }

  /**
   * Moves the rig into another chart without moving the view: the followed point, the pivot and the heading are
   * carried through world space, the pitch and the boom stay. Nothing happens when `chart` is the current one, so it
   * can be called every frame with the body's chart. After a jump of the body call `rig.snap()` as on a flat world.
   */
  setChart(chart: SurfaceChart): void {
    const old = this._chart;
    if (chart === old) return;
    const rig = this.rig;
    const p = rig.pivot;
    const t = rig.target;
    // The heading as a world direction at the pivot, before anything moves.
    const yaw = rig.yawDeg * DEG;
    const fw = old.vectorToWorld<Vec3>(p[0], p[2], -Math.sin(yaw), 0, -Math.cos(yaw), [0, 0, 0]);
    const pw = old.toWorld<Vec3>(p[0], p[1], p[2], [0, 0, 0]);
    const tw = old.toWorld<Vec3>(t[0], t[1], t[2], [0, 0, 0]);
    const pivot = chart.fromWorld<Vec3>(pw[0], pw[1], pw[2], [0, 0, 0]);
    const target = chart.fromWorld<Vec3>(tw[0], tw[1], tw[2], [0, 0, 0]);
    const fc = chart.vectorFromWorld<Vec3>(pivot[0], pivot[2], fw[0], fw[1], fw[2], [0, 0, 0]);
    const yawDeg = fc[0] === 0 && fc[2] === 0 ? rig.yawDeg : detAtan2(-fc[0], -fc[2]) / DEG;
    rig.setState({ target, pivot, yawDeg, boom: rig.boom });
    this._chart = chart;
  }

  get width(): number {
    return this.rig.width;
  }
  set width(v: number) {
    this.rig.width = v;
  }
  get height(): number {
    return this.rig.height;
  }
  set height(v: number) {
    this.rig.height = v;
  }
  get dpr(): number {
    return this.rig.dpr;
  }
  set dpr(v: number) {
    this.rig.dpr = v;
  }

  /** View: the heading in the local horizon at the pivot, measured from the world −z axis (as `FreeRig.yaw`). */
  get heading(): number {
    const ax = this.axes(this.scratchAxes);
    const p = this.rig.pivot;
    const up = this._chart.upAt(p[0], p[2], this.w3);
    const f = ax.forward;
    const k = dot(f, up);
    const h: Vec3 = [f[0] - up[0] * k, f[1] - up[1] * k, f[2] - up[2] * k];
    const [ahead, left] = horizonRef([up[0], up[1], up[2]]);
    return Math.atan2(dot(h, left), dot(h, ahead));
  }

  private get tanHalfY(): number {
    return Math.tan((this.rig.setup.fovDeg * DEG) / 2);
  }

  /** The distance in front of the eye that counts as the centre of the view (the rig's own). */
  private get focus(): number {
    return this.rig.metresPerPixel / this.rig.pixelGrowth;
  }

  get metresPerPixel(): number {
    return this.rig.metresPerPixel;
  }

  get pixelGrowth(): number {
    return this.rig.pixelGrowth;
  }

  get refDepth(): number {
    const f = this.axes(this.scratchAxes).forward;
    return dot(f, this.eye(this.t3)) + this.focus;
  }

  /** View: screen right, screen up and the view direction in world space (the rig's axes turned by the chart's frame at the pivot). */
  axes(out?: OrthoFrame): OrthoFrame {
    const a = this.rig.axes(this.chartAxes);
    const p = this.rig.pivot;
    const c = this._chart;
    const o = out ?? { right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0] };
    c.vectorToWorld(p[0], p[2], a.right[0], a.right[1], a.right[2], o.right);
    c.vectorToWorld(p[0], p[2], a.up[0], a.up[1], a.up[2], o.up);
    c.vectorToWorld(p[0], p[2], a.forward[0], a.forward[1], a.forward[2], o.forward);
    return o;
  }

  /**
   * The eye in world metres, written to `out`: the pivot's world point plus the boom turned by the chart's frame at the
   * pivot, so the rig is placed as one rigid body and the pivot stays exactly in the middle of the image.
   */
  worldEye(out?: Vec3): Vec3 {
    const rig = this.rig;
    const e = rig.eye(this.t3);
    const p = rig.pivot;
    const c = this._chart;
    const o = out ?? [0, 0, 0];
    const b = c.vectorToWorld(p[0], p[2], e[0] - p[0], e[1] - p[1], e[2] - p[2], this.b3);
    const b0 = b[0];
    const b1 = b[1];
    const b2 = b[2];
    c.toWorld(p[0], p[1], p[2], o);
    o[0] += b0;
    o[1] += b1;
    o[2] += b2;
    return o;
  }

  /** The eye in the renderer's space (the world eye less `origin`, subtracted in double precision). */
  eye(out?: Vec3): Vec3 {
    const w = this.worldEye(this.w3);
    const o = this.origin;
    const e = out ?? [0, 0, 0];
    e[0] = w[0] - o[0];
    e[1] = w[1] - o[1];
    e[2] = w[2] - o[2];
    return e;
  }

  /** World → clip matrix in the renderer's space; near and far as `FollowRig.viewProj`. */
  viewProj(sceneCenter: Vec3, depthHalfRange: number, out?: Float32Array): Float32Array {
    const { right: r, up: u, forward: w } = this.axes(this.scratchAxes);
    const eye = this.eye([0, 0, 0]);
    const s = this.rig.setup;
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

  /** View: rays from the eye through the image corners (left-bottom, left-top, right-bottom, right-top), renderer's space. */
  cornerRays(out?: Ray[]): Ray[] {
    const ax = this.axes(this.scratchAxes);
    const rays: Ray[] = out ?? [0, 1, 2, 3].map(() => ({ origin: [0, 0, 0] as Vec3, dir: [0, 0, 0] as Vec3 }));
    for (let i = 0; i < 4; i++) {
      const r = rays[i]!;
      this.eye(r.origin);
      this.dirInto(i < 2 ? -1 : 1, i % 2 === 0 ? -1 : 1, ax, r.dir);
    }
    return rays;
  }

  /** View: the four side planes through the eye and the plane of the eye itself, normals inward (renderer's space). */
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

  /** View: changes whenever the image of a static scene would (the rig's key, the chart and the origin). */
  key(): string {
    const a = this._chart.anchor;
    const o = this.origin;
    return `${this.rig.key()}|chart ${a[0]},${a[1]},${a[2]}|${o[0]},${o[1]},${o[2]}`;
  }

  /** Ray under a screen point in physical pixels from the top-left corner, in the renderer's space. */
  screenRay(px: number, py: number): Ray {
    return { origin: this.eye(), dir: this.dirInto((2 * px) / this.width - 1, 1 - (2 * py) / this.height, this.axes(), [0, 0, 0]) };
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
}
