// Headless cases of the free camera path (`FreePath` in camera/free-path.ts), run by check:follow next to the cases of
// the following view. Plain Node: keys hit exactly, velocity continuous at inner keys, cuts, a look point kept in the
// middle, local up on a sphere of 100 km, easing, roll, purity, sampling ahead and writing a pose into a `FreeRig`.

import { FreeRig } from '../../packages/wallhammer-web/src/camera/free.ts';
import { FreePath, newFreePose, writeFreePose } from '../../packages/wallhammer-web/src/camera/free-path.ts';
import type { FreeKey, FreePose } from '../../packages/wallhammer-web/src/camera/free-path.ts';
import type { Vec3 } from '../../packages/wallhammer-web/src/base/math.ts';
import type { FollowCase } from './check.ts';

const R = 100_000;
const radialUp = (p: readonly [number, number, number]): Vec3 => {
  const l = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / l, p[1] / l, p[2] / l];
};
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const at = (path: FreePath, t: number): FreePose => path.sample(t, newFreePose());

/** A path over a sphere of radius R: three keys of heading and pitch, a cut, then two look keys at one target. */
function sphereKeys(): FreeKey[] {
  const surf = (x: number, z: number, h: number): [number, number, number] => {
    const l = Math.hypot(x, R, z);
    return [(x / l) * (R + h), (R / l) * (R + h), (z / l) * (R + h)];
  };
  return [
    { t: 0, eye: surf(0, 0, 120), yawDeg: 10, pitchDeg: 5 },
    { t: 4, eye: surf(300, -500, 90), yawDeg: 40, pitchDeg: 12, rollDeg: 8 },
    { t: 9, eye: surf(900, -800, 200), yawDeg: -170, pitchDeg: 0, fovYDeg: 35 },
    { t: 9, eye: surf(5000, 3000, 30), look: surf(5100, 3000, 0), cut: true },
    { t: 15, eye: surf(5100, 3100, 40), look: surf(5100, 3000, 0) },
  ];
}

export function runPathChecks(): FollowCase[] {
  const out: FollowCase[] = [];
  const add = (name: string, ok: boolean, detail: string): void => void out.push({ name: `path: ${name}`, ok, detail });
  const keys = sphereKeys();
  const path = new FreePath(keys, { up: radialUp, endsAtRest: false });

  // 1. Keys are hit exactly; a heading key at pitch 0 looks along the local horizon.
  {
    let worst = 0;
    for (const k of [keys[0]!, keys[1]!, keys[3]!, keys[4]!]) worst = Math.max(worst, dist(at(path, k.t).eye, k.eye));
    const p2 = at(path, 9 - 1e-9);
    const level = Math.abs(dot(p2.forward, radialUp(p2.eye)));
    add('keys hit, horizon on a sphere', worst < 1e-6 && level < 1e-6 && p2.fovYDeg > 34.99, `largest miss ${worst.toExponential(1)} m at ${R / 1000} km radius, pitch 0 leaves the horizon by ${level.toExponential(1)}, fov ${p2.fovYDeg.toFixed(3)}°`);
  }

  // 2. Velocity continuous at an inner key (left and right differences agree), position and view.
  {
    const h = 1e-4;
    const v = (t0: number, t1: number): number[] => {
      const a = at(path, t0), b = at(path, t1);
      return [0, 1, 2].map((i) => (b.eye[i]! - a.eye[i]!) / (t1 - t0));
    };
    const left = v(4 - h, 4);
    const right = v(4, 4 + h);
    const jump = dist(left, right);
    const speed = Math.hypot(left[0]!, left[1]!, left[2]!);
    const f0 = at(path, 4 - h).forward, f1 = at(path, 4).forward, f2 = at(path, 4 + h).forward;
    const turnL = dist(f0, f1) / h, turnR = dist(f1, f2) / h;
    add('velocity continuous at a key', jump < 1e-3 * speed + 1e-3 && Math.abs(turnL - turnR) < 1e-3 * turnL + 1e-6, `speed ${speed.toFixed(3)} m/s, jump ${jump.toExponential(1)} m/s; turn rate ${turnL.toFixed(5)} vs ${turnR.toFixed(5)} rad/s`);
  }

  // 3. A cut: the group before holds nothing past it, the new group starts at the cut key exactly.
  {
    const before = at(path, 9 - 1e-6);
    const after = at(path, 9);
    const ok = before.group === 0 && after.group === 1 && dist(after.eye, keys[3]!.eye) < 1e-6 && dist(before.eye, keys[2]!.eye) < 1e-2 && path.cuts.length === 2 && path.cuts[1] === 9;
    add('cut without interpolation', ok, `groups ${before.group} → ${after.group}, cut at ${path.cuts.join(', ')} s, jump ${dist(before.eye, after.eye).toFixed(0)} m`);
  }

  // 4. Between two look keys at one target the view stays on it.
  {
    const target = keys[3]!.look!;
    let worst = 0;
    for (let t = 9; t <= 15; t += 0.25) {
      const p = at(path, t);
      const d = [target[0] - p.eye[0], target[1] - p.eye[1], target[2] - p.eye[2]];
      const l = Math.hypot(d[0]!, d[1]!, d[2]!);
      // The sine of the angle (the length of the cross product): well conditioned near 0, unlike acos.
      const f = p.forward;
      const c = [d[1]! * f[2] - d[2]! * f[1], d[2]! * f[0] - d[0]! * f[2], d[0]! * f[1] - d[1]! * f[0]];
      worst = Math.max(worst, Math.hypot(c[0]!, c[1]!, c[2]!) / l);
    }
    add('look point kept in the middle', worst < 1e-9, `largest angle off the target ${worst.toExponential(1)} rad`);
  }

  // 5. Axes orthonormal everywhere, roll turns screen up toward screen right.
  {
    let worst = 0;
    for (let t = 0; t <= path.duration; t += 0.1) {
      const p = at(path, t);
      for (const a of [p.forward, p.up, p.right]) worst = Math.max(worst, Math.abs(Math.hypot(a[0], a[1], a[2]) - 1));
      worst = Math.max(worst, Math.abs(dot(p.forward, p.up)), Math.abs(dot(p.forward, p.right)), Math.abs(dot(p.up, p.right)));
    }
    const p = at(path, 4);
    const lu = radialUp(p.eye);
    const tilt = Math.atan2(dot(p.right, lu), dot(p.up, lu)) / (Math.PI / 180);
    add('axes orthonormal, roll', worst < 1e-9 && Math.abs(-tilt - 8) < 0.5, `largest error ${worst.toExponential(1)}; roll 8° at the key leaves screen right ${(-tilt).toFixed(3)}° below the horizon`);
  }

  // 6. Easing: ease-in-out rests at both keys, linear keeps a constant velocity; endsAtRest rests at the ends.
  {
    const two = (ease: FreeKey['ease'], endsAtRest: boolean): FreePath =>
      new FreePath([{ t: 0, eye: [0, 10, 0], ease }, { t: 2, eye: [20, 10, 0] }, { t: 4, eye: [60, 10, 0] }], { endsAtRest });
    const speedAt = (p: FreePath, t: number): number => (at(p, t + 1e-5).eye[0] - at(p, t - 1e-5).eye[0]) / 2e-5;
    const eased = two('ease-in-out', false);
    const linear = two('linear', false);
    const rested = two('smooth', true);
    const easeOk = Math.abs(speedAt(eased, 2)) < 1e-3 && Math.abs(at(eased, 1).eye[0] - 10) < 1e-9;
    const linOk = Math.abs(speedAt(linear, 0.5) - 10) < 1e-6 && Math.abs(speedAt(linear, 1.5) - 10) < 1e-6;
    const restOk = Math.abs((at(rested, 1e-5).eye[0] - at(rested, 0).eye[0]) / 1e-5) < 1e-3;
    add('easing and rest', easeOk && linOk && restOk, `ease-in-out at its end ${speedAt(eased, 2).toExponential(1)} m/s, linear ${speedAt(linear, 0.5).toFixed(6)} m/s, rest at the start: ${restOk}`);
  }

  // 7. Pure: the same time gives the same bytes in any order, and a second path from the same keys agrees.
  {
    const times = [13.1, 0.3, 9, 4.7, 15, 2.2];
    const a = times.map((t) => at(path, t));
    const twin = new FreePath(sphereKeys(), { up: radialUp, endsAtRest: false });
    const b = [...times].reverse().map((t) => at(twin, t)).reverse();
    const same = a.every((p, i) => JSON.stringify(p) === JSON.stringify(b[i]));
    add('pure sampling', same, `${times.length} samples equal in reverse order and on a second path`);
  }

  // 8. Sampling ahead crosses the cut; a pose written into a free rig gives the rig the same view.
  {
    const ahead = path.ahead(7, 4, 1);
    const groups = new Set(ahead.map((p) => p.group));
    const rig = new FreeRig({ minClearance: 0 }, { shape: { upAt: radialUp } });
    rig.width = 1280;
    rig.height = 720;
    const pose = at(path, 5.5);
    writeFreePose(rig, pose);
    const ax = rig.axes();
    const off = Math.max(dist(ax.forward, pose.forward), dist(ax.up, pose.up), dist(ax.right, pose.right), dist(rig.position, pose.eye));
    const fovOk = rig.setup.fovYDeg === pose.fovYDeg;
    add('ahead and written into a FreeRig', ahead.length === 5 && groups.has(0) && groups.has(1) && off < 1e-9 && fovOk, `${ahead.length} poses ahead in groups ${[...groups].join(', ')}; rig differs by ${off.toExponential(1)}, fov ${rig.setup.fovYDeg.toFixed(3)}°`);
  }
  return out;
}
