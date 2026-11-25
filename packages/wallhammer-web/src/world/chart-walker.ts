// Walking on a sphere through a moving local chart. The flat `CollisionWorld` and `Walker` run unchanged in the
// coordinates of a `SurfaceChart` (base): chart y is the height above a reference radius, chart x and z run along the
// sphere. The base surface of the collision world is the sphere's own height function seen through the chart,
// `radiusAt(direction) − radius`, so the feet stand exactly on it; the solids are the caller's, added in chart
// coordinates.
//
// When the walker gets farther than `rechartM` from the chart's origin, a new chart is anchored under it ("rechart"):
// its position, velocity, heading and the pose it is drawn from between steps are carried into the new chart through
// world vectors, so nothing jumps, a new collision world is made and `onRechart` lets the caller add its solids again.
// The check runs after every fixed step, so where a rechart happens depends only on the walker's state, never on how
// the real time was cut into frames: the same inputs give the same path bit for bit, as for a flat `Walker`.
//
// The method is exact in height and right to first order along the sphere: across the line from the chart's origin a
// length is stretched by about θ² / 6 (θ: the angle from the origin, rechartM / radius at most). It is meant for a
// radius much larger than `rechartM`.

import { SurfaceChart } from '../base/chart.ts';
import type { Mat34 } from '../base/mat34.ts';
import { detAtan2, detSinCos } from '../base/trig.ts';
import { CollisionWorld } from './collide.ts';
import type { CollisionWorldOptions } from './collide.ts';
import { WALKER_STATE_BYTES, WALKER_TUNING_KEYS, Walker, newWalkIntent } from './walker.ts';
import type { WalkIntent, WalkerSetup, WalkerTuning } from './walker.ts';

/** Distance of the ground from the sphere's centre in a unit direction, metres. */
export type RadiusAt = (dx: number, dy: number, dz: number) => number;

export interface ChartWalkerOptions {
  /** Reference radius of the sphere, metres: chart y is the height above it. */
  radiusM: number;
  /** Centre of the sphere in world metres; default the origin. */
  center?: readonly [number, number, number];
  /** The ground: its distance from the centre in a unit direction. Called many times per step; keep it cheap. */
  radiusAt: RadiusAt;
  /** The walker's setup over `DEFAULT_WALKER`. */
  walker?: Partial<WalkerSetup>;
  /** A new chart is anchored under the walker when it gets farther than this from the chart's origin. Default min(48 m, radius / 64). */
  rechartM?: number;
  /**
   * Options of each chart's collision world besides its height function: `cellSize`, `baseStep`, and `baseMinY` /
   * `baseMaxY` (the lowest and highest ground as heights above `radiusM`). `baseExtent` defaults to a square of
   * ±`extentM` round the chart's origin.
   */
  collision?: Omit<CollisionWorldOptions, 'heightAt'>;
  /** Half the side of the square in which a chart's base surface is searched by rays (the camera boom, picks). Default min(1024 m, radius). */
  extentM?: number;
  /** Called with every new chart and its new, empty collision world: add the solids near the walker there, in chart coordinates. */
  onRechart?(chart: SurfaceChart, world: CollisionWorld): void;
}

/** Doubles before the walker's own state: version, anchor, x axis, leftover time, a pending jump, one spare. */
const HEAD_FLOATS = 10;
/** Bytes of one saved state (`ChartWalker.saveState`): the chart's anchor and x axis and the stepping, then a walker's state. */
export const CHART_WALKER_STATE_BYTES = HEAD_FLOATS * 8 + WALKER_STATE_BYTES;
const STATE_VERSION = 1;

// Places in a walker's saved state (`Walker.saveState`, layout 1): position, velocity, yaw, the previous position and
// yaw. They are rewritten when the walker is carried into another chart.
const S_POS = 1;
const S_VEL = 4;
const S_YAW = 7;
const S_PREV = 11;
const S_PREV_YAW = 14;
const S_ACC = 15;

export class ChartWalker {
  readonly radiusM: number;
  readonly center: readonly [number, number, number];
  readonly rechartM: number;
  readonly extentM: number;
  /** The caller's hook for a new chart; may be replaced at any time. */
  onRechart: ((chart: SurfaceChart, world: CollisionWorld) => void) | null;
  /** New charts made so far (by stepping, a teleport or a loaded state). */
  recharts = 0;

  private readonly radiusAt: RadiusAt;
  private readonly setupIn: Partial<WalkerSetup>;
  private readonly collisionIn: Omit<CollisionWorldOptions, 'heightAt'>;
  private _chart: SurfaceChart;
  private _world: CollisionWorld;
  private _walker: Walker;
  private acc = 0;
  private pendingJump = false;
  private readonly scratch: WalkIntent = newWalkIntent();
  private readonly f = new Float64Array(WALKER_STATE_BYTES / 8);
  private readonly bytes = new Uint8Array(this.f.buffer);
  private readonly head = new Float64Array(HEAD_FLOATS);
  private readonly headBytes = new Uint8Array(this.head.buffer);
  private readonly up: [number, number, number] = [0, 0, 0];
  private readonly t3: [number, number, number] = [0, 0, 0];
  private readonly sc: [number, number] = [0, 0];

  /** A walker standing at the point of the sphere in the direction `start` (default +y), at the ground. */
  constructor(options: ChartWalkerOptions, start: readonly [number, number, number] = [0, 1, 0]) {
    this.radiusM = options.radiusM;
    if (!(this.radiusM > 0)) throw new Error('ChartWalker: radiusM must be positive');
    const c = options.center ?? [0, 0, 0];
    this.center = [c[0], c[1], c[2]];
    this.radiusAt = options.radiusAt;
    this.rechartM = options.rechartM ?? Math.min(48, this.radiusM / 64);
    if (!(this.rechartM > 0)) throw new Error('ChartWalker: rechartM must be positive');
    this.extentM = options.extentM ?? Math.min(1024, this.radiusM);
    this.setupIn = { ...options.walker };
    this.collisionIn = { ...options.collision };
    this.onRechart = options.onRechart ?? null;
    this._chart = new SurfaceChart(this.center, this.radiusM, start);
    this._world = this.makeWorld(this._chart);
    this._walker = new Walker(this._world, this.setupIn);
    this.teleportDirection(start);
  }

  /** The current chart. A new one replaces it at every rechart; compare by identity to notice. */
  get chart(): SurfaceChart {
    return this._chart;
  }

  /** The current chart's collision world (a new one at every rechart). */
  get world(): CollisionWorld {
    return this._world;
  }

  /** The flat walker inside the current chart (a new one at every rechart; read it, step through this class). */
  get walker(): Walker {
    return this._walker;
  }

  get setup(): Readonly<WalkerSetup> {
    return this._walker.setup;
  }

  /** `Walker.retune` of the walker now and of every walker of a later chart. */
  retune(o: Partial<WalkerTuning>): void {
    for (const k of WALKER_TUNING_KEYS) if (o[k] !== undefined) this.setupIn[k] = o[k];
    this._walker.retune(o);
  }

  get stepSeconds(): number {
    return this._walker.stepSeconds;
  }

  get grounded(): boolean {
    return this._walker.grounded;
  }

  get steep(): boolean {
    return this._walker.steep;
  }

  /** Heading in the current chart, radians (the convention of `Walker.yaw`). */
  get yaw(): number {
    return this._walker.yaw;
  }

  get travelled(): number {
    return this._walker.travelled;
  }

  /** Share of the way from the last step to the next one, 0–1. */
  get alpha(): number {
    const a = this.acc / this._walker.stepSeconds;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  /** Feet in world metres, written to `out`. */
  position<T extends { [i: number]: number }>(out: T): T {
    const p = this._walker.position;
    return this._chart.toWorld(p[0]!, p[1]!, p[2]!, out);
  }

  /** Velocity in world metres per second, written to `out`. */
  velocity<T extends { [i: number]: number }>(out: T): T {
    const p = this._walker.position;
    const v = this._walker.velocity;
    return this._chart.vectorToWorld(p[0]!, p[2]!, v[0]!, v[1]!, v[2]!, out);
  }

  /** Height of the feet above the ground under them, metres (0 standing). */
  get heightAboveGround(): number {
    const p = this._walker.position;
    return p[1]! - this._world.baseHeightAt(p[0]!, p[2]!);
  }

  /** Distance of the walker's feet from the chart's origin along the sphere, metres. */
  get chartDistance(): number {
    const p = this._walker.position;
    return Math.sqrt(p[0]! * p[0]! + p[2]! * p[2]!);
  }

  /**
   * A world point (an object's place) in the current chart's coordinates, written to `out` as x, y, z. Returns whether
   * it lies within `reach` metres of the chart's origin along the sphere (default the chart's extent), so `onRechart`
   * can skip what is too far to matter. Horizontal lengths (a radius, a half extent) carry over unchanged to first order.
   * The point straight opposite the chart's origin is π · radius away (`SurfaceChart.fromWorld`), so it is within reach
   * only of a reach that long.
   */
  toChart(point: readonly [number, number, number], out: { [i: number]: number }, reach = this.extentM): boolean {
    this._chart.fromWorld(point[0], point[1], point[2], out);
    const x = out[0]!;
    const z = out[2]!;
    return x * x + z * z <= reach * reach;
  }

  /**
   * Puts the feet at a world point with no velocity; the body settles onto the ground in the next step. `facing` is a
   * world direction the body should face (its part along up is dropped); without it the heading is kept as a chart
   * heading. A new chart is anchored there.
   */
  teleport(point: readonly [number, number, number], facing?: readonly [number, number, number]): void {
    const c = this.center;
    const chart = new SurfaceChart(c, this.radiusM, [point[0] - c[0], point[1] - c[1], point[2] - c[2]]);
    const y = Math.sqrt((point[0] - c[0]) ** 2 + (point[1] - c[1]) ** 2 + (point[2] - c[2]) ** 2) - this.radiusM;
    let yaw = this._walker.yaw;
    if (facing) {
      const t = chart.vectorFromWorld(0, 0, facing[0], facing[1], facing[2], this.t3);
      if (t[0] !== 0 || t[2] !== 0) yaw = detAtan2(-t[0], -t[2]);
    }
    this.install(chart);
    this._walker.teleport(0, y, 0, yaw);
    this.acc = 0;
    this.pendingJump = false;
  }

  /** Puts the feet `above` metres over the ground in the direction `dir` from the centre (see `teleport`). */
  teleportDirection(dir: readonly [number, number, number], above = 0, facing?: readonly [number, number, number]): void {
    const l = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    if (!(l > 0)) throw new Error('ChartWalker.teleportDirection: the direction must not be zero');
    const dx = dir[0] / l;
    const dy = dir[1] / l;
    const dz = dir[2] / l;
    const r = this.radiusAt(dx, dy, dz) + above;
    const c = this.center;
    this.teleport([c[0] + dx * r, c[1] + dy * r, c[2] + dz * r], facing);
  }

  /**
   * Advances by real seconds in fixed steps; returns the number of steps taken. The same rules as `Walker.advance`
   * (leftover time carries over, a jump asked between steps waits for the next one, at most `maxStepsPerAdvance`
   * steps), and a rechart may follow any step. `intent` is in the current chart's x and z, as a following view in the
   * same chart turns its input (`FollowRig.forward`).
   */
  advance(dt: number, intent: WalkIntent): number {
    if (intent.jump) this.pendingJump = true;
    if (!(dt > 0)) return 0;
    this.acc += dt;
    const h = this._walker.stepSeconds;
    const max = this._walker.setup.maxStepsPerAdvance;
    const sc = this.scratch;
    sc.moveX = intent.moveX;
    sc.moveZ = intent.moveZ;
    sc.run = intent.run;
    let n = 0;
    while (this.acc + 1e-9 * h >= h) {
      if (n >= max) {
        this.acc = 0;
        break;
      }
      sc.jump = this.pendingJump;
      this.pendingJump = false;
      this.step(sc);
      this.acc -= h;
      n++;
    }
    if (this.acc < 0) this.acc = 0;
    return n;
  }

  /** One fixed step and, when the walker has gone farther than `rechartM`, a rechart. */
  step(intent: WalkIntent): void {
    this._walker.step(intent);
    const p = this._walker.position;
    if (p[0]! * p[0]! + p[2]! * p[2]! > this.rechartM * this.rechartM) this.rechart();
  }

  /** Anchors a new chart under the walker now (also done by `step` past `rechartM`). */
  rechart(): void {
    const old = this._chart;
    const f = this.f;
    this._walker.saveState(this.bytes);
    const P: [number, number, number] = [0, 0, 0];
    const Q: [number, number, number] = [0, 0, 0];
    const V: [number, number, number] = [0, 0, 0];
    const F: [number, number, number] = [0, 0, 0];
    const G: [number, number, number] = [0, 0, 0];
    const px = f[S_POS]!;
    const pz = f[S_POS + 2]!;
    const qx = f[S_PREV]!;
    const qz = f[S_PREV + 2]!;
    old.toWorld(px, f[S_POS + 1]!, pz, P);
    old.toWorld(qx, f[S_PREV + 1]!, qz, Q);
    old.vectorToWorld(px, pz, f[S_VEL]!, f[S_VEL + 1]!, f[S_VEL + 2]!, V);
    this.facingWorld(old, px, pz, f[S_YAW]!, F);
    this.facingWorld(old, qx, qz, f[S_PREV_YAW]!, G);
    // The new chart's axes are the old ones carried to the walker along the great circle: a heading keeps its numbers.
    const chart = old.moved(px, pz);
    const t = this.t3;
    chart.fromWorld(P[0], P[1], P[2], t);
    f[S_POS] = t[0];
    f[S_POS + 1] = t[1];
    f[S_POS + 2] = t[2];
    chart.fromWorld(Q[0], Q[1], Q[2], t);
    f[S_PREV] = t[0];
    f[S_PREV + 1] = t[1];
    f[S_PREV + 2] = t[2];
    chart.vectorFromWorld(f[S_POS]!, f[S_POS + 2]!, V[0], V[1], V[2], t);
    f[S_VEL] = t[0];
    f[S_VEL + 1] = t[1];
    f[S_VEL + 2] = t[2];
    f[S_YAW] = this.yawOf(chart, f[S_POS]!, f[S_POS + 2]!, F, f[S_YAW]!);
    f[S_PREV_YAW] = this.yawOf(chart, f[S_PREV]!, f[S_PREV + 2]!, G, f[S_PREV_YAW]!);
    f[S_ACC] = 0;
    this.install(chart);
    this._walker.loadState(this.bytes);
  }

  /** World direction of the chart heading `yaw` at the chart point (x, z). */
  private facingWorld(chart: SurfaceChart, x: number, z: number, yaw: number, out: [number, number, number]): void {
    const sc = detSinCos(yaw, this.sc);
    chart.vectorToWorld(x, z, -sc[0], 0, -sc[1], out);
  }

  /** Chart heading of a world direction at the chart point (x, z); `keep` when it has no horizontal part. */
  private yawOf(chart: SurfaceChart, x: number, z: number, w: readonly number[], keep: number): number {
    const t = chart.vectorFromWorld(x, z, w[0]!, w[1]!, w[2]!, this.t3);
    return t[0] === 0 && t[2] === 0 ? keep : detAtan2(-t[0], -t[2]);
  }

  /** Makes `chart` current with a new collision world and walker (or the ones given), and lets the caller add its solids. */
  private install(chart: SurfaceChart, world = this.makeWorld(chart), walker = new Walker(world, this.setupIn)): void {
    this._chart = chart;
    this._world = world;
    this._walker = walker;
    this.recharts++;
    this.onRechart?.(chart, this._world);
  }

  private makeWorld(chart: SurfaceChart): CollisionWorld {
    const up = this.up;
    const R = this.radiusM;
    const radiusAt = this.radiusAt;
    const e = this.extentM;
    return new CollisionWorld({
      baseExtent: [-e, -e, e, e],
      ...this.collisionIn,
      heightAt: (x, z) => {
        chart.upAt(x, z, up);
        return radiusAt(up[0], up[1], up[2]) - R;
      },
    });
  }

  /** Feet between the last two steps in the current chart, written to `out` (`Walker.renderPosition`). */
  renderChartPosition<T extends Float64Array | number[]>(out: T, alpha?: number): T {
    this._walker.renderPosition(out, alpha ?? this.alpha);
    return out;
  }

  /** Feet between the last two steps in world metres, written to `out`. */
  renderPosition<T extends { [i: number]: number }>(out: T, alpha?: number): T {
    const p = this.renderChartPosition(this.t3 as unknown as number[], alpha);
    return this._chart.toWorld(p[0]!, p[1]!, p[2]!, out);
  }

  /** Unit local up at the drawn feet, written to `out`. */
  renderUp<T extends { [i: number]: number }>(out: T, alpha?: number): T {
    const p = this.renderChartPosition(this.t3 as unknown as number[], alpha);
    return this._chart.upAt(p[0]!, p[2]!, out);
  }

  /** Heading between the last two steps in the current chart, radians (`Walker.renderYaw`). */
  renderYaw(alpha?: number): number {
    return this._walker.renderYaw(alpha ?? this.alpha);
  }

  /** `travelled` between the last two steps (`Walker.renderTravelled`). */
  renderTravelled(alpha?: number): number {
    return this._walker.renderTravelled(alpha ?? this.alpha);
  }

  /** Unit world direction the drawn body faces, written to `out`. */
  renderFacing<T extends { [i: number]: number }>(out: T, alpha?: number): T {
    const a = alpha ?? this.alpha;
    const p = this.renderChartPosition(this.t3 as unknown as number[], a);
    const sc = detSinCos(this._walker.renderYaw(a), this.sc);
    return this._chart.vectorToWorld(p[0]!, p[2]!, -sc[0], 0, -sc[1], out);
  }

  /**
   * The drawn body's frame as a 3 × 4 matrix: columns right, up and back (a shape modelled with +y up facing −z faces
   * the heading), then the feet less `origin` (a render origin; default the world origin).
   */
  renderFrame<T extends Mat34>(out: T, alpha?: number, origin?: readonly [number, number, number]): T {
    const a = alpha ?? this.alpha;
    const p = this.renderChartPosition(this.t3 as unknown as number[], a);
    const x = p[0]!;
    const y = p[1]!;
    const z = p[2]!;
    const sc = detSinCos(this._walker.renderYaw(a), this.sc);
    const s = sc[0];
    const c = sc[1];
    const chart = this._chart;
    chart.frameAt(x, y, z, out, origin);
    // The frame's x and z turned by the heading about its y (the rotation about +y of `mat34RotationY`).
    const x0 = out[0]!, x1 = out[1]!, x2 = out[2]!;
    const z0 = out[6]!, z1 = out[7]!, z2 = out[8]!;
    out[0] = x0 * c - z0 * s;
    out[1] = x1 * c - z1 * s;
    out[2] = x2 * c - z2 * s;
    out[6] = x0 * s + z0 * c;
    out[7] = x1 * s + z1 * c;
    out[8] = x2 * s + z2 * c;
    return out;
  }

  /**
   * Writes the whole state (the chart's anchor, the stepping, the walker's own state in its chart) into `out`
   * (at least `CHART_WALKER_STATE_BYTES` from `offset`; default a new array) and returns it.
   */
  saveState(out?: Uint8Array, offset = 0): Uint8Array {
    const o = out ?? new Uint8Array(CHART_WALKER_STATE_BYTES);
    if (o.length < offset + CHART_WALKER_STATE_BYTES) throw new Error('ChartWalker.saveState: the output is too short');
    const h = this.head;
    const a = this._chart.anchor;
    const x = this._chart.frame.x;
    h[0] = STATE_VERSION;
    h[1] = a[0];
    h[2] = a[1];
    h[3] = a[2];
    h[4] = x[0];
    h[5] = x[1];
    h[6] = x[2];
    h[7] = this.acc;
    h[8] = this.pendingJump ? 1 : 0;
    h[9] = 0;
    o.set(this.headBytes, offset);
    this._walker.saveState(o, offset + HEAD_FLOATS * 8);
    return o;
  }

  /**
   * Restores a state written by `saveState` of a walker with the same options. Everything is checked before anything
   * changes: a refused state (too few bytes, another version of the head or of the walker's part, a bad anchor) throws
   * and leaves this walker, its chart and its world as they were. A state in a chart with another anchor makes that
   * chart current with a new world and walker holding the state, then calls `onRechart`.
   */
  loadState(bytes: Uint8Array, offset = 0): void {
    if (bytes.length < offset + CHART_WALKER_STATE_BYTES) throw new Error('ChartWalker.loadState: too few bytes');
    const h = this.head;
    this.headBytes.set(bytes.subarray(offset, offset + HEAD_FLOATS * 8));
    if (h[0] !== STATE_VERSION) throw new Error('ChartWalker.loadState: not a chart walker state');
    // Read out of the scratch now: `onRechart` may save a state, which writes it.
    const acc = h[7]!;
    const jump = h[8] === 1;
    const a = this._chart.anchor;
    const x = this._chart.frame.x;
    const at = offset + HEAD_FLOATS * 8;
    // The chart's own anchor and axis, taken as they are: the same chart bit for bit.
    if (a[0] !== h[1] || a[1] !== h[2] || a[2] !== h[3] || x[0] !== h[4] || x[1] !== h[5] || x[2] !== h[6]) {
      // The new chart, world and walker are made and loaded aside (`Walker.loadState` throws before it changes
      // anything) and only then made current.
      const chart = SurfaceChart.exact(this.center, this.radiusM, [h[1]!, h[2]!, h[3]!], [h[4]!, h[5]!, h[6]!]);
      const world = this.makeWorld(chart);
      const walker = new Walker(world, this.setupIn);
      walker.loadState(bytes, at);
      this.install(chart, world, walker);
    } else this._walker.loadState(bytes, at);
    this.acc = acc;
    this.pendingJump = jump;
  }
}
