// Cases of the following view on a sphere (engine `camera/chart-follow.ts` over `world/chart-walker.ts`): the world
// eye and the view direction move on smoothly while the followed body is given new charts, the view's numbers handed to
// the renderer are relative to its origin and keep their digits at 1e5 m, and a ridge behind the body cuts the boom so
// the eye stays above the ground.

import { ChartFollowView } from '../../packages/wallhammer-web/src/camera/chart-follow.ts';
import { FollowRig } from '../../packages/wallhammer-web/src/camera/follow.ts';
import { ChartWalker } from '../../packages/wallhammer-web/src/world/chart-walker.ts';
import type { RadiusAt } from '../../packages/wallhammer-web/src/world/chart-walker.ts';
import { newWalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
import type { FollowCase } from './check.ts';

type V3 = [number, number, number];
const unit = (v: readonly number[]): V3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
const crossv = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const dotv = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

const START: V3 = unit([0.31, 0.83, -0.46]);
const FACING: V3 = unit(crossv(START, [0, 0, 1]));

/** A walker on a sphere and a following view of it, wired as the recipe in docs/cameras.md says. */
function setup(R: number, radiusAt: RadiusAt): { w: ChartWalker; view: ChartFollowView; frame: (dt: number, moveZ: number) => boolean } {
  const w = new ChartWalker({ radiusM: R, radiusAt }, START);
  w.teleportDirection(START, 0, FACING);
  const rig = new FollowRig(
    { followLag: 0.15, boomReturn: 0.3, pivotHeight: 1.5, minDistance: 0, maxDistance: 12 },
    { clearance: (ox, oy, oz, dx, dy, dz, max) => w.world.clearance(ox, oy, oz, dx, dy, dz, max, 0.25) },
  );
  rig.width = 1280;
  rig.height = 720;
  rig.distance = 8;
  rig.pitchDeg = 15;
  rig.yawDeg = (w.yaw * 180) / Math.PI;
  const view = new ChartFollowView(rig, w.chart);
  const it = newWalkIntent();
  const p: V3 = [0, 0, 0];
  const frame = (dt: number, moveZ: number): boolean => {
    const before = w.recharts;
    // Straight ahead along the view's heading (as bindWalkInput turns the keys).
    const yaw = (rig.yawDeg * Math.PI) / 180;
    it.moveX = -Math.sin(yaw) * -moveZ;
    it.moveZ = -Math.cos(yaw) * -moveZ;
    it.run = true;
    w.advance(dt, it);
    view.setChart(w.chart);
    w.renderChartPosition(p);
    rig.follow(p[0], p[1], p[2]);
    rig.update(dt);
    // A slow turn, so the heading is carried through recharts while it changes.
    rig.yawDeg += 6 * dt;
    return w.recharts !== before;
  };
  return { w, view, frame };
}

export function runSphereFollowChecks(): FollowCase[] {
  const out: FollowCase[] = [];
  const add = (name: string, ok: boolean, detail: string): void => void out.push({ name, ok, detail });

  // 1. Across recharts the world eye and the view direction move on as between other frames (within a hair).
  for (const R of [2000, 100_000]) {
    const bumps: RadiusAt = (x, y, z) => R + 2 * (Math.sin((x * R) / 97) * Math.cos((z * R) / 131) + 0.6 * Math.sin((y * R) / 71 + 1.3));
    const { w, view, frame } = setup(R, bumps);
    const dt = 1 / 60;
    let lastEye: V3 | null = null;
    let lastF: V3 | null = null;
    let lastMove = NaN;
    let lastTurn = NaN;
    let worst = { moveJump: 0, turnJump: 0, moveJumpRechart: 0, turnJumpRechart: 0 };
    let recharts = 0;
    for (let i = 0; i < 60 * 45; i++) {
      const re = frame(dt, -1);
      const eye = view.worldEye([0, 0, 0]);
      const f = view.axes().forward;
      const fw: V3 = [f[0], f[1], f[2]];
      if (lastEye && lastF) {
        const move = dist(eye, lastEye);
        const turn = Math.acos(Math.min(1, dotv(fw, lastF)));
        if (i > 60 && Number.isFinite(lastMove)) {
          const mj = Math.abs(move - lastMove);
          const tj = Math.abs(turn - lastTurn);
          if (re) {
            recharts++;
            worst.moveJumpRechart = Math.max(worst.moveJumpRechart, mj);
            worst.turnJumpRechart = Math.max(worst.turnJumpRechart, tj);
          } else {
            worst.moveJump = Math.max(worst.moveJump, mj);
            worst.turnJump = Math.max(worst.turnJump, tj);
          }
        }
        lastMove = move;
        lastTurn = turn;
      }
      lastEye = eye;
      lastF = fw;
    }
    // The renderer's numbers: the eye relative to an origin near it keeps millimetres at 1e5 m.
    const we = view.worldEye([0, 0, 0]);
    view.origin = [Math.round(we[0]), Math.round(we[1]), Math.round(we[2])];
    const re = view.eye([0, 0, 0]);
    const rel = Math.hypot(re[0] - (we[0] - view.origin[0]), re[1] - (we[1] - view.origin[1]), re[2] - (we[2] - view.origin[2]));
    const rays = view.cornerRays();
    const raysOk = rays.every((r) => dist(r.origin, re) === 0);
    // At a rechart the boom is laid in a frame carried along another path, which turns it by about the area between the
    // paths over R²: well under a microradian. Allowed: 0.1 mm of the eye's step and 1 µrad of its turn.
    const smooth = worst.moveJumpRechart <= Math.max(1e-4, 3 * worst.moveJump) && worst.turnJumpRechart <= Math.max(1e-6, 3 * worst.turnJump);
    add(
      `sphere: view continuous across recharts (R ${R} m)`,
      smooth && recharts >= 3 && rel === 0 && raysOk && Math.abs(re[0]) < 1,
      `${recharts} recharts; eye step changes ${worst.moveJump.toExponential(1)} m between frames, ${worst.moveJumpRechart.toExponential(1)} m at a rechart; turn changes ${worst.turnJump.toExponential(1)} rad, ${worst.turnJumpRechart.toExponential(1)} at a rechart; eye relative to origin ${re.map((v) => v.toFixed(3)).join(', ')}`,
    );
    worst = { moveJump: 0, turnJump: 0, moveJumpRechart: 0, turnJumpRechart: 0 };
  }

  // 2. A ridge 4 m behind the body, 8 m high: the boom is cut and the eye stays above the ground; without it, full.
  {
    const R = 2000;
    const back: V3 = [-FACING[0], -FACING[1], -FACING[2]];
    const ridge = (on: boolean): RadiusAt => (x, y, z) => {
      if (!on) return R;
      // Along-track distance behind the start, metres, on the great circle START → back.
      const s = Math.atan2(x * back[0] + y * back[1] + z * back[2], x * START[0] + y * START[1] + z * START[2]) * R;
      return R + 8 * Math.exp(-(((s - 4) / 1.5) ** 2));
    };
    const measure = (on: boolean): { boom: number; eyeAbove: number } => {
      const rAt = ridge(on);
      const { w, view, frame } = setup(R, rAt);
      view.rig.yawDeg = (w.yaw * 180) / Math.PI;
      // Standing still: the boom points back over the ridge.
      for (let i = 0; i < 60; i++) {
        frame(1 / 60, 0);
        view.rig.yawDeg = (w.yaw * 180) / Math.PI;
      }
      const e = view.worldEye([0, 0, 0]);
      const c = w.center;
      const d: V3 = [e[0] - c[0], e[1] - c[1], e[2] - c[2]];
      const r = Math.hypot(d[0], d[1], d[2]);
      return { boom: view.rig.boom, eyeAbove: r - rAt(d[0] / r, d[1] / r, d[2] / r) };
    };
    const free = measure(false);
    const cut = measure(true);
    add('sphere: boom cut by a ridge', free.boom === 8 && cut.boom < 4 && cut.eyeAbove > 0.2, `without the ridge boom ${free.boom.toFixed(3)} m (eye ${free.eyeAbove.toFixed(2)} m above ground); with it ${cut.boom.toFixed(3)} m, eye ${cut.eyeAbove.toFixed(2)} m above the ground under it`);
  }
  return out;
}
