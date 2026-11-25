// Scenarios of walking on a sphere through a moving local chart (engine `base/chart.ts`, `world/chart-walker.ts`):
// the feet stay on an analytic ground of spheres of 2 km and 100 km with bumps over long walks through many recharts,
// the drawn position and the speed over the ground do not jump at a rechart, walking straight ahead goes round a great
// circle and closes it, the same inputs give the same bits however the time is cut into frames, a saved state goes on
// exactly like the original (and a refused one changes nothing), a solid added again in every new chart still stops
// the body, a chart's frame near the −y pole and its antipode, and the CPU time of a step.

import { SurfaceChart } from '../../packages/wallhammer-web/src/base/chart.ts';
import { CHART_WALKER_STATE_BYTES, ChartWalker } from '../../packages/wallhammer-web/src/world/chart-walker.ts';
import type { RadiusAt } from '../../packages/wallhammer-web/src/world/chart-walker.ts';
import { newWalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
import type { WalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
import { f, meanMs, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

type V3 = [number, number, number];

const unit = (v: readonly number[]): V3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const len = (v: readonly number[]): number => Math.hypot(v[0]!, v[1]!, v[2]!);
const dotv = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const crossv = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

/** A sphere with smooth bumps of about `amp` metres, a few hundred metres across (slopes of a few percent). */
export function bumpySphere(R: number, amp: number): RadiusAt {
  return (x, y, z) => R + amp * (Math.sin((x * R) / 97) * Math.cos((z * R) / 131) + 0.6 * Math.sin((y * R) / 71 + 1.3));
}

/** Where the walks start: off every axis, so no frame is special. */
export const START: V3 = unit([0.31, 0.83, -0.46]);
/** A world direction square to `START` to face. */
export const FACING: V3 = unit(crossv(START, [0, 0, 1]));

/** The intent that walks straight ahead (the walker's own heading in its chart). */
function ahead(w: ChartWalker, it: WalkIntent, run = true): WalkIntent {
  it.moveX = -Math.sin(w.yaw);
  it.moveZ = -Math.cos(w.yaw);
  it.run = run;
  it.jump = false;
  return it;
}

interface LongWalk {
  maxGroundErr: number;
  maxChartDist: number;
  maxStepRatio: number;
  maxSpeedJump: number;
  maxSpeedJumpRechart: number;
  recharts: number;
  metres: number;
}

/** Walks straight ahead for `seconds` in frames of 1/60 s and measures the ground, the drawn path and the speed. */
function longWalk(R: number, amp: number, seconds: number): LongWalk {
  const radiusAt = bumpySphere(R, amp);
  const w = new ChartWalker({ radiusM: R, radiusAt, center: [10, -20, 30] }, START);
  w.teleportDirection(START, 0, FACING);
  const it = newWalkIntent();
  const dt = 1 / 60;
  const frames = Math.round(seconds / dt);
  const c = w.center;
  const p: V3 = [0, 0, 0];
  const at: V3 = [0, 0, 0];
  let last: V3 | null = null;
  let lastSpeed = NaN;
  const out: LongWalk = { maxGroundErr: 0, maxChartDist: 0, maxStepRatio: 0, maxSpeedJump: 0, maxSpeedJumpRechart: 0, recharts: 0, metres: 0 };
  const r0 = w.recharts;
  const run = w.setup.runSpeed;
  for (let i = 0; i < frames; i++) {
    const before = w.recharts;
    w.advance(dt, ahead(w, it));
    out.maxChartDist = Math.max(out.maxChartDist, w.chartDistance);
    if (i > 10 && w.grounded) {
      w.position(p);
      const v = sub(p, c);
      out.maxGroundErr = Math.max(out.maxGroundErr, Math.abs(len(v) - radiusAt(...unit(v))));
    }
    w.renderPosition(at);
    if (last) {
      const d = len(sub(at, last));
      out.metres += d;
      out.maxStepRatio = Math.max(out.maxStepRatio, d / (run * dt));
      const speed = d / dt;
      // After the start (full speed after 0.25 s): the change of the drawn speed from one frame to the next.
      if (i > 30) {
        const jump = Math.abs(speed - lastSpeed);
        if (w.recharts !== before) out.maxSpeedJumpRechart = Math.max(out.maxSpeedJumpRechart, jump);
        else out.maxSpeedJump = Math.max(out.maxSpeedJump, jump);
      }
      lastSpeed = speed;
    }
    last = [at[0], at[1], at[2]];
  }
  out.recharts = w.recharts - r0;
  return out;
}

function longWalkScenario(name: string, R: number, amp: number, seconds: number): Scenario {
  return {
    name,
    run: () => {
      const r = longWalk(R, amp, seconds);
      const rechartM = Math.min(48, R / 64);
      const ok = r.maxGroundErr < 1e-6 && r.maxChartDist <= rechartM + 4.5 / 60 + 1e-9 && r.recharts >= Math.floor(r.metres / rechartM) - 1 && r.maxStepRatio < 1.02 && r.maxSpeedJumpRechart <= Math.max(0.01, 2 * r.maxSpeedJump);
      return verdict(
        ok,
        `R ${R} m, ${f(r.metres, 0)} m walked, ${r.recharts} recharts; feet off the ground ${r.maxGroundErr.toExponential(1)} m at most; chart distance ${f(r.maxChartDist, 2)} m at most; drawn step ${f(r.maxStepRatio, 4)} × run speed × dt at most; drawn speed changes ${f(r.maxSpeedJump, 4)} m/s between frames, ${f(r.maxSpeedJumpRechart, 4)} m/s at a rechart`,
      );
    },
  };
}

export const SPHERE_SCENARIOS: Scenario[] = [
  longWalkScenario('sphere-walk-2km-stays-on-the-ground', 2000, 3, 200),
  longWalkScenario('sphere-walk-100km-stays-on-the-ground', 100_000, 3, 300),
  {
    // Straight ahead on a smooth sphere of 300 m is a great circle: it stays in its plane and closes after 2πR.
    name: 'sphere-great-circle-closes',
    run: () => {
      const R = 300;
      const w = new ChartWalker({ radiusM: R, radiusAt: () => R }, START);
      w.teleportDirection(START, 0, FACING);
      const it = newWalkIntent();
      const n = unit(crossv(START, FACING));
      const p: V3 = [0, 0, 0];
      const fw: V3 = [0, 0, 0];
      let p0: V3 | null = null;
      let f0: V3 | null = null;
      let from = 0;
      let plane = 0;
      let gap = NaN;
      let turn = NaN;
      for (let i = 0; i < 40_000; i++) {
        w.step(ahead(w, it));
        w.position(p);
        plane = Math.max(plane, Math.abs(dotv(p, n)));
        // Full speed from 10 m on: the circle is measured from there, by the walker's own travelled distance.
        if (!p0 && w.travelled >= 10) {
          p0 = [p[0], p[1], p[2]];
          f0 = w.renderFacing([0, 0, 0], 1);
          from = w.travelled;
        } else if (p0 && w.travelled - from >= 2 * Math.PI * R) {
          gap = len(sub(p, p0));
          w.renderFacing(fw, 1);
          turn = Math.acos(Math.min(1, dotv(fw, f0!)));
          break;
        }
      }
      // The last step overshoots by less than one step (4.5 m/s / 60).
      return verdict(gap < 0.08 && turn < 1e-3 && plane < 1e-6, `after 2πR = ${f(2 * Math.PI * R, 1)} m: ${f(gap, 4)} m from the start, heading turned ${turn.toExponential(1)} rad, ${w.recharts} recharts, off the circle's plane ${plane.toExponential(1)} m at most`);
    },
  },
  {
    // One call of 1/30 s and two of 1/60 s end in the same bits, recharts and a jump included; a saved state goes on alike.
    name: 'sphere-walk-deterministic',
    run: () => {
      const R = 2000;
      const make = (): ChartWalker => {
        const w = new ChartWalker({ radiusM: R, radiusAt: bumpySphere(R, 3) }, START);
        w.teleportDirection(START, 0, FACING);
        return w;
      };
      const it = newWalkIntent();
      it.moveX = 0.6;
      it.moveZ = -0.8;
      it.run = true;
      const drive = (w: ChartWalker, chop: number, seconds: number): void => {
        const frames = Math.round((seconds * 30) / 1) * chop;
        for (let i = 0; i < frames; i++) {
          it.jump = i === 300 * chop;
          w.advance(1 / (30 * chop), it);
        }
      };
      const a = make();
      const b = make();
      const c = make();
      drive(a, 1, 30);
      drive(b, 2, 30);
      drive(c, 1, 30);
      const bits = (w: ChartWalker): string => Buffer.from(w.saveState().subarray(0, 4 * 8)).toString('hex') + Buffer.from(w.walker.saveState().subarray(8, 7 * 8)).toString('hex');
      const same = bits(a) === bits(c);
      const chopped = bits(a) === bits(b);
      // Saved and loaded into another walker: both go on in the same bits.
      const kept = a.saveState().slice();
      const d = make();
      d.loadState(kept);
      const loaded = Buffer.compare(Buffer.from(d.saveState()), Buffer.from(kept)) === 0;
      drive(a, 1, 10);
      drive(d, 1, 10);
      const onward = Buffer.compare(Buffer.from(a.saveState()), Buffer.from(d.saveState())) === 0;
      const ok = same && chopped && loaded && onward && a.recharts > 3 && kept.length === CHART_WALKER_STATE_BYTES;
      return verdict(ok, `same inputs same bits ${same}; 1/30 s vs 2 × 1/60 s same bits ${chopped}; ${a.recharts} recharts; saved state loads ${loaded} and goes on alike ${onward} (${CHART_WALKER_STATE_BYTES} bytes)`);
    },
  },
  {
    // A cylinder fixed in the world 120 m ahead, added again in every new chart that reaches it, stops the body.
    name: 'sphere-solid-added-on-rechart-blocks',
    run: () => {
      const R = 2000;
      const w = new ChartWalker({ radiusM: R, radiusAt: () => R }, START);
      // The axis of the cylinder: 120 m along the great circle the walk follows.
      const th = 120 / R;
      const axis = unit([START[0] * Math.cos(th) + FACING[0] * Math.sin(th), START[1] * Math.cos(th) + FACING[1] * Math.sin(th), START[2] * Math.cos(th) + FACING[2] * Math.sin(th)]);
      const W: V3 = [axis[0] * R, axis[1] * R, axis[2] * R];
      const at: V3 = [0, 0, 0];
      let added = 0;
      w.onRechart = (_chart, world) => {
        if (!w.toChart(W, at, 200)) return;
        world.addCylinder(at[0], at[2], 3, at[1] - 1, at[1] + 3);
        added++;
      };
      w.teleportDirection(START, 0, FACING);
      const it = newWalkIntent();
      it.run = true;
      const goal: V3 = [0, 0, 0];
      // Every frame straight at the cylinder's axis, found in the current chart: the body must stop at its side.
      for (let i = 0; i < 60 * 60; i++) {
        w.toChart(W, goal, 1e9);
        const q = w.walker.position;
        const dx = goal[0] - q[0]!;
        const dz = goal[2] - q[2]!;
        const l = Math.hypot(dx, dz) || 1;
        it.moveX = dx / l;
        it.moveZ = dz / l;
        w.advance(1 / 60, it);
      }
      const p = w.position([0, 0, 0]);
      // Distance of the feet from the cylinder's axis, along the sphere.
      const along = Math.acos(Math.min(1, dotv(unit(p), axis))) * R;
      const ok = along >= 3 + w.setup.radius - 1e-3 && along < 3 + w.setup.radius + 0.05 && added > 1 && w.recharts > 3;
      return verdict(ok, `stopped ${f(along, 3)} m from the axis (cylinder 3 m + body ${w.setup.radius} m); added again in ${added} charts of ${w.recharts}`);
    },
  },
  {
    name: 'sphere-chart-round-trip',
    run: () => {
      // A chart's maps forth and back, and a moved chart's frame against the frame carried to its origin.
      const ch = new SurfaceChart([5, 6, 7], 100_000, START);
      let worst = 0;
      let worstVec = 0;
      const p: V3 = [0, 0, 0];
      const q: V3 = [0, 0, 0];
      const v: V3 = [0, 0, 0];
      for (let i = 0; i < 200; i++) {
        const x = (i % 20) * 7 - 70;
        const z = Math.floor(i / 20) * 13 - 60;
        const y = (i % 7) - 3;
        ch.toWorld(x, y, z, p);
        ch.fromWorld(p[0], p[1], p[2], q);
        worst = Math.max(worst, Math.abs(q[0] - x), Math.abs(q[1] - y), Math.abs(q[2] - z));
        ch.vectorToWorld(x, z, 0.3, -0.5, 0.8, v);
        ch.vectorFromWorld(x, z, v[0], v[1], v[2], q);
        worstVec = Math.max(worstVec, Math.abs(q[0] - 0.3), Math.abs(q[1] + 0.5), Math.abs(q[2] - 0.8));
      }
      const m = ch.moved(40, -30);
      const carried = ch.vectorToWorld(40, -30, 1, 0, 0, [0, 0, 0] as V3);
      const frameDiff = len(sub(m.frame.x, carried));
      const up = ch.upAt(40, -30, [0, 0, 0] as V3);
      const upDiff = len(sub(m.anchor, up));
      return verdict(worst < 1e-8 && worstVec < 1e-12 && frameDiff < 1e-12 && upDiff < 1e-12, `points back within ${worst.toExponential(1)} m at 1e5 m, vectors ${worstVec.toExponential(1)}; a moved chart's axes ${frameDiff.toExponential(1)} from the carried ones, its anchor ${upDiff.toExponential(1)} from the up there`);
    },
  },
  {
    name: 'sphere-chart-frame-near-pole',
    run: () => {
      // Anchors near and at −y (where `upFrame` turns the world half round instead of rotating) and two ordinary ones
      // on a sphere of 1000 km: the frame is orthonormal and the chart's origin maps back to (0, 0, 0).
      const R = 1e6;
      const anchors: V3[] = [[0.001, -Math.sqrt(1 - 1e-6), 0], [0, -1, 0], unit([0.003, -0.99999, 0.002]), START, [0, 1, 0]];
      let frameErr = 0;
      let originErr = 0;
      const p: V3 = [0, 0, 0];
      const q: V3 = [0, 0, 0];
      for (const a of anchors) {
        const ch = new SurfaceChart([0, 0, 0], R, a);
        const { x, y, z } = ch.frame;
        frameErr = Math.max(frameErr, Math.abs(dotv(x, y)), Math.abs(dotv(x, z)), Math.abs(dotv(y, z)), Math.abs(len(x) - 1), Math.abs(len(z) - 1), len(sub(crossv(x, y), z)));
        ch.toWorld(0, 0, 0, p);
        ch.fromWorld(p[0], p[1], p[2], q);
        originErr = Math.max(originErr, len(q));
      }
      return verdict(frameErr < 1e-12 && originErr < 1e-6, `5 anchors (3 near −y): frame off orthonormal by ${frameErr.toExponential(1)}, the origin maps back within ${originErr.toExponential(1)} m at 1e6 m`);
    },
  },
  {
    name: 'sphere-chart-antipode-far',
    run: () => {
      // The point straight opposite a chart's origin lies π·R away along the sphere: the chart puts it there (not at its
      // origin), and `toChart` does not take it as within reach.
      const R = 2000;
      const c: V3 = [10, -20, 30];
      const ch = new SurfaceChart(c, R, START);
      const anti: V3 = [c[0] - START[0] * R, c[1] - START[1] * R, c[2] - START[2] * R];
      const q = ch.fromWorld(anti[0], anti[1], anti[2], [0, 0, 0] as V3);
      const dist = Math.hypot(q[0], q[2]);
      const back = ch.toWorld(q[0], q[1], q[2], [0, 0, 0] as V3);
      const w = new ChartWalker({ radiusM: R, radiusAt: () => R, center: c }, START);
      const near = w.toChart(anti, [0, 0, 0], 100);
      const ok = Math.abs(dist - Math.PI * R) < 1e-6 && Math.abs(q[1]) < 1e-9 && len(sub(back, anti)) < 1e-6 && !near;
      return verdict(ok, `antipode at ${f(dist, 3)} m along the sphere (π·R ${f(Math.PI * R, 3)}), height ${q[1].toExponential(1)}; back to the world within ${len(sub(back, anti)).toExponential(1)} m; toChart within 100 m: ${near}`);
    },
  },
  {
    name: 'sphere-load-state-refused-keeps-state',
    run: () => {
      // A chart walker elsewhere is handed a state from another chart whose embedded walker part has a bad version
      // (byte 80) or whose head has one: `loadState` throws and leaves the walker as it was, with no new chart.
      const R = 2000;
      const a = new ChartWalker({ radiusM: R, radiusAt: () => R }, START);
      a.teleportDirection(START, 0, FACING);
      const it = newWalkIntent();
      for (let i = 0; i < 120; i++) a.advance(1 / 60, ahead(a, it));
      const saved = a.saveState();
      let calls = 0;
      const b = new ChartWalker({ radiusM: R, radiusAt: () => R, onRechart: () => calls++ }, FACING);
      for (let i = 0; i < 30; i++) b.advance(1 / 60, ahead(b, it));
      const before = b.saveState();
      const chart = b.chart;
      const recharts = b.recharts;
      calls = 0;
      const results: string[] = [];
      for (const at of [80, 0]) {
        const bad = saved.slice();
        new DataView(bad.buffer).setFloat64(at, 99, true);
        let threw = false;
        try {
          b.loadState(bad);
        } catch {
          threw = true;
        }
        const now = b.saveState();
        let same = now.length === before.length;
        for (let i = 0; same && i < now.length; i++) same = now[i] === before[i];
        results.push(`byte ${at}: threw ${threw}, state kept ${same}`);
        if (!threw || !same) results.push('FAILED');
      }
      // The good state still loads and moves the walker into the saved chart.
      b.loadState(saved);
      const loaded = b.saveState();
      let equal = loaded.length === saved.length;
      for (let i = 0; equal && i < saved.length; i++) equal = loaded[i] === saved[i];
      const unchanged = results.every((r) => r !== 'FAILED');
      const ok = unchanged && b.recharts === recharts + 1 && calls === 1 && equal && b.chart !== chart;
      return verdict(ok, `${results.join('; ')}; then the good state: loaded ${equal}, recharts ${recharts} → ${b.recharts}, onRechart called ${calls} time(s)`);
    },
  },
  {
    name: 'sphere-step-cpu-time',
    kind: 'timing',
    run: () => {
      const R = 100_000;
      const w = new ChartWalker({ radiusM: R, radiusAt: bumpySphere(R, 3) }, START);
      w.teleportDirection(START, 0, FACING);
      const it = newWalkIntent();
      const ms = meanMs(5000, () => w.step(ahead(w, it)));
      return verdict(ms < 0.03, `${f(ms * 1000, 2)} µs per step with recharts every ${f(w.rechartM, 0)} m (${w.recharts} so far), target 30 µs`);
    },
  },
];
