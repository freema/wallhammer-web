// Headless check of the engine's following view (`FollowRig`): no browser, no GPU, plain Node.
//
//   node tools/follow-check/check.ts      (from the workspace root: pnpm check:follow)
//
// Prints one line per case and exits with 1 when a case fails. `runFollowChecks()` is exported, so another check
// script (check:walk) can run the same cases and print them with its own. The cases of the free camera path
// (`path-cases.ts`) and of the marks for the engine's cameras (`mark-cases.ts`) run here too, after those of the
// following view.

import { FollowRig } from '../../packages/wallhammer-web/src/camera/follow.ts';
import type { BoomClearance } from '../../packages/wallhammer-web/src/camera/follow.ts';
import { newCornerRays } from '../../packages/wallhammer-web/src/base/view.ts';
import { runMarkChecks } from './mark-cases.ts';
import { runPathChecks } from './path-cases.ts';
import { runSphereFollowChecks } from './sphere-cases.ts';

export interface FollowCase {
  name: string;
  ok: boolean;
  detail: string;
}

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;

function rig(clearance?: BoomClearance): FollowRig {
  const r = new FollowRig({ followLag: 0.15, boomReturn: 0.3, pivotHeight: 1.5, minDistance: 0, maxDistance: 12 }, clearance ? { clearance } : {});
  r.width = 1280;
  r.height = 720;
  r.distance = 6;
  r.yawDeg = 30;
  r.pitchDeg = 20;
  r.follow(10, 2, -4);
  return r;
}

export function runFollowChecks(): FollowCase[] {
  const out: FollowCase[] = [];
  const add = (name: string, ok: boolean, detail: string): void => void out.push({ name, ok, detail });

  // 1. The boom is cut to the clearance exactly, at once; the clearance is asked along −forward from the pivot.
  {
    let limit = 2.5;
    let asked = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0, max: 0 };
    const r = rig((ox, oy, oz, dx, dy, dz, max) => {
      asked = { ox, oy, oz, dx, dy, dz, max };
      return Math.min(limit, max);
    });
    r.update(1 / 60);
    const f = r.axes().forward;
    const dirOk = near(asked.dx, -f[0], 1e-12) && near(asked.dy, -f[1], 1e-12) && near(asked.dz, -f[2], 1e-12);
    const fromPivot = asked.ox === r.pivot[0] && asked.oy === r.pivot[1] && asked.oz === r.pivot[2];
    const eye = r.eye();
    const eyeDist = Math.hypot(eye[0] - r.pivot[0], eye[1] - r.pivot[1], eye[2] - r.pivot[2]);
    add('boom cut to clearance', r.boom === 2.5 && dirOk && fromPivot && asked.max === 6 && near(eyeDist, 2.5, 1e-9), `boom ${r.boom}, eye ${eyeDist.toFixed(6)} m from the pivot, asked max ${asked.max}`);

    // 2. Freed again, the boom grows back smoothly: not at once, 95 % of the gap in boomReturn, all of it later.
    limit = Infinity;
    r.update(1 / 60);
    const first = r.boom;
    let t = 1 / 60;
    while (t < 0.3 - 1e-9) {
      r.update(1 / 60);
      t += 1 / 60;
    }
    const at03 = r.boom;
    for (let i = 0; i < 60; i++) r.update(1 / 60);
    const smoothOk = first > 2.5 && first < 3.5 && near((at03 - 2.5) / 3.5, 0.95, 0.005) && r.boom === 6;
    add('boom grows back smoothly', smoothOk, `after 1 frame ${first.toFixed(3)} m, after 0.3 s ${at03.toFixed(3)} m (${(((at03 - 2.5) / 3.5) * 100).toFixed(1)} % of the gap), after 1.3 s ${r.boom} m`);
  }

  // 3. The pivot reaches its target: 95 % of a jump in followLag, all of it later, the same at 30 and 120 frames/s.
  {
    const a = rig();
    const b = rig();
    a.follow(20, 2, -4);
    b.follow(20, 2, -4);
    for (let i = 0; i < 9; i++) a.update(1 / 60); // 0.15 s
    const share = (a.pivot[0] - 10) / 10;
    for (let i = 0; i < 18; i++) b.update(1 / 120);
    const rateDiff = Math.abs(a.pivot[0] - b.pivot[0]);
    const rateSame = rateDiff < 1e-9;
    for (let i = 0; i < 300; i++) a.update(1 / 60);
    const there = near(a.pivot[0], 20, 1e-9) && near(a.pivot[1], 3.5, 1e-9) && near(a.pivot[2], -4, 1e-9);
    add('pivot reaches the target', near(share, 0.95, 1e-3) && rateSame && there, `95 % in followLag: ${(share * 100).toFixed(3)} %, 60 vs 120 frames/s differ by ${rateDiff.toExponential(1)} m, settled at ${a.pivot.map((v) => v.toFixed(6)).join(', ')}`);
    const rigid = new FollowRig({ followLag: 0 });
    rigid.follow(0, 0, 0);
    rigid.follow(5, 1, 5);
    rigid.update(1 / 60);
    add('followLag 0 follows rigidly', rigid.pivot[0] === 5 && rigid.pivot[1] === 1 + rigid.setup.pivotHeight && rigid.pivot[2] === 5, `pivot ${rigid.pivot.join(', ')}`);
  }

  // 4. forward() matches yawDeg and the view's heading; a drag to the right turns it toward screen right.
  {
    const r = rig();
    const fw = [0, 0, 0];
    let worst = 0;
    for (const yaw of [0, 30, 90, -90, 180, -135, 271]) {
      r.yawDeg = yaw;
      r.forward(fw);
      const f = r.axes().forward;
      const h = Math.hypot(f[0], f[2]);
      worst = Math.max(worst, Math.abs(fw[0] + Math.sin((yaw * Math.PI) / 180)), Math.abs(fw[2] + Math.cos((yaw * Math.PI) / 180)), Math.abs(fw[0] - f[0] / h), Math.abs(fw[2] - f[2] / h), Math.abs(fw[1]));
    }
    r.yawDeg = 0;
    const right = r.axes().right;
    r.turnPixels(50, 0);
    r.forward(fw);
    const turnedRight = fw[0] * right[0] + fw[2] * right[2] > 0;
    r.yawDeg = 0;
    add('forward matches yawDeg', worst < 1e-12 && turnedRight && r.heading === 0, `largest difference ${worst.toExponential(1)}, a drag right turns toward screen right: ${turnedRight}`);
  }

  // 5. Distance 0 is the view from the pivot; the pivot is at the screen centre otherwise.
  {
    const r = rig();
    r.update(0);
    const [px, py] = r.project([r.pivot[0], r.pivot[1], r.pivot[2]]);
    const centred = near(px, 640, 1e-6) && near(py, 360, 1e-6);
    r.distance = 0;
    r.update(1 / 60);
    const e = r.eye();
    const fromPivot = r.boom === 0 && e[0] === r.pivot[0] && e[1] === r.pivot[1] && e[2] === r.pivot[2];
    r.zoomBy(1.5);
    const out = r.distance === 0.5;
    r.zoomBy(0.5);
    add('first person at distance 0', centred && fromPivot && out && r.distance === 0, `pivot drawn at ${px.toFixed(3)}, ${py.toFixed(3)}; eye on the pivot: ${fromPivot}; zoom out of 0 to 0.5 m, back in to 0`);
  }

  // 6. A still view keeps its key (the same string, nothing made again); a change makes a new one.
  {
    const r = rig();
    r.update(1);
    const k1 = r.key();
    r.update(1);
    const k2 = r.key();
    r.turnPixels(3, 0);
    const k3 = r.key();
    add('key cached while still', k1 === k2 && k3 !== k1, k3);
  }

  // Processor time of one frame of the rig with a clearance (update + matrix + corner rays into the caller's arrays).
  {
    const r = rig((_ox, _oy, _oz, _dx, _dy, _dz, max) => max * 0.8);
    const m = new Float32Array(16);
    const rays = newCornerRays();
    const n = 10000;
    for (let i = 0; i < 1000; i++) r.update(1 / 60);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      r.follow(i * 0.01, 0, 0);
      r.update(1 / 60);
      r.viewProj([0, 0, 0], 500, m);
      r.cornerRays(rays);
    }
    const ms = (performance.now() - t0) / n;
    add('cpu time per frame', ms < 0.05, `${(ms * 1000).toFixed(2)} µs per frame (update, viewProj, cornerRays), Node`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = performance.now();
  const cases = [...runFollowChecks(), ...runPathChecks(), ...runMarkChecks(), ...runSphereFollowChecks()];
  for (const c of cases) console.log(`${c.ok ? 'ok  ' : 'FAIL'} follow: ${c.name} — ${c.detail}`);
  const failed = cases.filter((c) => !c.ok).length;
  console.log(`${cases.length - failed}/${cases.length} follow cases passed in ${(performance.now() - t0).toFixed(0)} ms`);
  if (failed > 0) process.exit(1);
}
