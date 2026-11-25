// Headless check of the engine's motion module (`wallhammer-web/motion`) and its post steps, in plain Node, without a
// browser or graphics. One line per scenario; exit code 1 when a check fails or the run takes over 5 s. Every
// skeleton here is a made-up chain of bones (no figure of any game): the module itself holds no motion.
//
//   node tools/motion/check.ts            all scenarios      (pnpm check:motion)
//   node tools/motion/check.ts marks      only scenarios whose name contains "marks"

import {
  ChainAim,
  ChainLag,
  MotionGraph,
  Pose,
  SocketBlend,
  TwoBoneReach,
  WeightFade,
  aimAngles,
  aimChain,
  blendTransform,
  Skeleton,
  addPose,
  blendPose,
  boneMask,
  compileMotionGraph,
  fitToGround,
  reachTwoBone,
  setBoneAxisAngle,
  setBoneEuler,
  socketTransform,
  solvePose,
  speedWeights,
  subtractPose,
} from '../../packages/wallhammer-web/src/motion/index.ts';
import type { AimAngles, AimChain, LagChain, MotionGraphDesc, MotionSource, Socket, TwoBoneChain } from '../../packages/wallhammer-web/src/motion/index.ts';

interface Result {
  ok: boolean;
  detail: string;
}
interface Scenario {
  name: string;
  kind?: 'check' | 'timing';
  run(): Result;
}

const f = (v: number, d = 4): string => v.toFixed(d);
const DEG = Math.PI / 180;
const ID = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

/** Angle about x of a bone's rotation (assumes a rotation about x). */
function angleX(p: Pose, b: number): number {
  return 2 * Math.atan2(p.rot[b * 4]!, p.rot[b * 4 + 3]!);
}

/** A made-up chain: a root and two links hanging below it, then a tip. */
function chain3(): Skeleton {
  return new Skeleton([
    { name: 'root', parent: -1, joint: [0, 1, 0] },
    { name: 'mid', parent: 0, joint: [0, -0.5, 0] },
    { name: 'tip', parent: 1, joint: [0, -0.5, 0] },
  ]);
}

/** A source that turns bone 0 about x to a fixed angle. */
function still(rad: number): MotionSource {
  return { sample: (o) => setBoneAxisAngle(o, 0, 1, 0, 0, rad) };
}

/** A pose fingerprint: FNV-1a over the float bits. */
function fingerprint(p: Pose, h = 2166136261): number {
  const u = new Uint32Array(p.rot.buffer, p.rot.byteOffset, p.rot.length);
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i]!, 16777619) >>> 0;
  const v = new Uint32Array(p.offset.buffer, p.offset.byteOffset, p.offset.length);
  for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v[i]!, 16777619) >>> 0;
  return h;
}

function poseDiff(a: Pose, b: Pose): number {
  let m = 0;
  for (let i = 0; i < a.rot.length; i++) m = Math.max(m, Math.abs(a.rot[i]! - b.rot[i]!));
  for (let i = 0; i < a.offset.length; i++) m = Math.max(m, Math.abs(a.offset[i]! - b.offset[i]!));
  return m;
}

// --- Blend and masks -------------------------------------------------------------------------------------------------

const BLEND: Scenario[] = [
  {
    name: 'blend-mask',
    run() {
      const sk = chain3();
      const a = new Pose(sk), b = new Pose(sk), out = new Pose(sk);
      setBoneAxisAngle(b, 0, 1, 0, 0, 90 * DEG);
      setBoneAxisAngle(b, 1, 1, 0, 0, 90 * DEG);
      b.offset[1] = 0.2;
      const mask = boneMask(sk, ['root'], { descendants: false });
      blendPose(out, a, b, 0.5, mask);
      const r0 = angleX(out, 0) / DEG, r1 = angleX(out, 1) / DEG;
      blendPose(out, a, b, 0.5);
      const all1 = angleX(out, 1) / DEG, off = out.offset[1]!;
      const ok = Math.abs(r0 - 45) < 1e-4 && Math.abs(r1) < 1e-6 && Math.abs(all1 - 45) < 1e-4 && Math.abs(off - 0.1) < 1e-6;
      return { ok, detail: `masked: root ${f(r0)}°, mid ${f(r1)}° (mask 0); unmasked mid ${f(all1)}°, offset ${f(off)} m` };
    },
  },
  {
    name: 'mask-descendants',
    run() {
      const sk = chain3();
      const deep = boneMask(sk, ['mid']);
      const flat = boneMask(sk, ['mid'], { descendants: false, weight: 0.5 });
      const ok = deep.join() === '0,1,1' && flat.join() === '0,0.5,0';
      return { ok, detail: `with descendants [${deep.join(', ')}], without and weight 0.5 [${flat.join(', ')}]` };
    },
  },
  {
    name: 'blend-shortest-arc',
    run() {
      const sk = chain3();
      const a = new Pose(sk), b = new Pose(sk), out = new Pose(sk);
      setBoneAxisAngle(a, 0, 1, 0, 0, 170 * DEG);
      // −170° written with the opposite sign of w: the shortest way between them is 20°, through 180°.
      setBoneAxisAngle(b, 0, 1, 0, 0, -170 * DEG);
      blendPose(out, a, b, 0.5);
      const ang = Math.abs(angleX(out, 0)) / DEG;
      return { ok: Math.abs(ang - 180) < 1e-3, detail: `halfway between 170° and −170°: ${f(ang)}° (180 expected, not 0)` };
    },
  },
  {
    name: 'additive',
    run() {
      const sk = chain3();
      const base = new Pose(sk), add = new Pose(sk), out = new Pose(sk), back = new Pose(sk), diff = new Pose(sk);
      setBoneAxisAngle(base, 0, 1, 0, 0, 30 * DEG);
      setBoneAxisAngle(add, 0, 1, 0, 0, 20 * DEG);
      add.offset[0] = 0.1;
      addPose(out, base, add, 1);
      const full = angleX(out, 0) / DEG;
      addPose(out, base, add, 0.5);
      const half = angleX(out, 0) / DEG;
      const halfOff = out.offset[0]!;
      // Difference and back: base + (a − base) = a.
      setBoneEuler(back, 1, 0.3, -0.2, 0.5, 'yxz');
      subtractPose(diff, back, base);
      addPose(out, base, diff, 1);
      const err = poseDiff(out, back);
      const ok = Math.abs(full - 50) < 1e-4 && Math.abs(half - 40) < 0.05 && Math.abs(halfOff - 0.05) < 1e-6 && err < 1e-6;
      return { ok, detail: `30° + 20°: ${f(full)}°; at weight 0.5 ${f(half)}°, offset ${f(halfOff)}; base + (a − base) − a = ${err.toExponential(1)}` };
    },
  },
];

// --- Automatic weights -----------------------------------------------------------------------------------------------

const WEIGHTS: Scenario[] = [
  {
    name: 'speed-weights',
    run() {
      const ranges = [[0.5, 1.2, 1.8], [0, 0, 0.4], [1.5, 3, 5]] as const;
      const w = [0, 0, 0];
      let maxJump = 0, maxSumErr = 0;
      let prev: number[] | null = null;
      for (let v = -1; v <= 7; v += 0.001) {
        speedWeights(ranges, v, w);
        maxSumErr = Math.max(maxSumErr, Math.abs(w[0]! + w[1]! + w[2]! - 1));
        if (prev) for (let i = 0; i < 3; i++) maxJump = Math.max(maxJump, Math.abs(w[i]! - prev[i]!));
        prev = [...w];
      }
      speedWeights(ranges, -1, w);
      const below = w.join();
      speedWeights(ranges, 9, w);
      const above = w.join();
      speedWeights(ranges, 2.1, w);
      const mid = w.map((x) => f(x, 3)).join(', ');
      const ok = maxSumErr < 1e-12 && maxJump < 0.002 && below === '0,1,0' && above === '0,0,1';
      return { ok, detail: `sum error ${maxSumErr.toExponential(1)}, largest step over 0.001 m/s ${f(maxJump)}; below the range [${below}], above [${above}], at 2.1 [${mid}]` };
    },
  },
  {
    name: 'speed-blend-phase',
    run() {
      // Two loops of different length in one state share one phase; at the middle speed the phase rate is the mix.
      const sk = chain3();
      const slow: MotionSource = { duration: 1.2, speed: [0.5, 1, 1.5], sample: (o, t) => setBoneAxisAngle(o, 0, 1, 0, 0, t) };
      const fast: MotionSource = { duration: 0.6, speed: [1.5, 2, 4], sample: (o, t) => setBoneAxisAngle(o, 0, 1, 0, 0, -t) };
      const g = new MotionGraph(compileMotionGraph({ skeleton: sk, layers: [{ name: 'base', states: [{ name: 'move', sources: [slow, fast], by: 'speed' }] }] }));
      g.setParam('speed', 1);
      g.update(0.6);
      const p1 = g.phase();
      g.setParam('speed', 2);
      g.update(0.6);
      const p2 = g.phase() - p1;
      g.setParam('speed', 1.5);
      g.update(0.6);
      const p3 = g.phase() - p1 - p2;
      // At 1.5: weights 0.5/0.5, rates (1.5/1)/1.2 and (1.5/2)/0.6 → 0.5·1.25 + 0.5·1.25.
      const ok = Math.abs(p1 - 0.5) < 1e-9 && Math.abs(p2 - 1) < 1e-9 && Math.abs(p3 - 0.75) < 1e-9;
      return { ok, detail: `phase over 0.6 s: slow alone ${f(p1)}, fast alone ${f(p2)}, mixed at 1.5 m/s ${f(p3)}` };
    },
  },
];

// --- Transitions -----------------------------------------------------------------------------------------------------

function twoStates(seconds: number, ease: 'linear' | 'smooth'): MotionGraph {
  const sk = chain3();
  return new MotionGraph(
    compileMotionGraph({
      skeleton: sk,
      params: { go: 0 },
      layers: [
        {
          name: 'base',
          states: [
            { name: 'a', source: still(0) },
            { name: 'b', source: still(90 * DEG) },
          ],
          transitions: [
            { from: 'a', to: 'b', seconds, ease, when: [{ param: 'go', op: '==', value: 1 }] },
            { from: 'b', to: 'a', seconds, ease, when: [{ param: 'go', op: '==', value: 0 }] },
          ],
        },
      ],
    }),
  );
}

const TRANSITIONS: Scenario[] = [
  {
    name: 'transition-times',
    run() {
      const g = twoStates(0.5, 'linear');
      const p = new Pose(g.def.skeleton);
      g.setParam('go', 1);
      const ws: string[] = [];
      let ok = true;
      for (let i = 1; i <= 6; i++) {
        g.update(0.1);
        g.evaluate(p);
        const wb = g.weightOf('b');
        ws.push(f(wb, 2));
        // The pose is the blend: the angle grows as the nlerp of 0° and 90°.
        const expect = Math.min(1, i / 5);
        ok &&= Math.abs(wb - expect) < 1e-9;
      }
      const after = g.state();
      const n = g.data[g.def.layers[0]!.at]!;
      ok &&= after === 'b' && n === 1;
      return { ok, detail: `weight of b after each 0.1 s (the fade starts with the update that takes the switch): ${ws.join(' ')}; then state ${after}, active ${n}` };
    },
  },
  {
    name: 'transition-smooth',
    run() {
      const g = twoStates(1, 'smooth');
      g.setParam('go', 1);
      g.update(0); // starts the transition
      g.update(0.25);
      const w = g.weightOf('b');
      return { ok: Math.abs(w - 0.15625) < 1e-9, detail: `smooth ease at a quarter: ${f(w, 5)} (3t² − 2t³ = 0.15625)` };
    },
  },
  {
    name: 'transition-interrupt',
    run() {
      const g = twoStates(0.5, 'linear');
      const p0 = new Pose(g.def.skeleton), p1 = new Pose(g.def.skeleton);
      g.setParam('go', 1);
      g.update(0);
      g.update(0.2);
      g.evaluate(p0);
      // Back while the first is still fading in.
      g.setParam('go', 0);
      g.update(0);
      g.evaluate(p1);
      const jump = poseDiff(p0, p1);
      // The rest of the way back (0.6 s, the fade is 0.5 s) must be continuous: no step above what 1/50 of the fade allows.
      let worst = 0;
      for (let i = 0; i < 60; i++) {
        p0.copy(p1);
        g.update(0.01);
        g.evaluate(p1);
        worst = Math.max(worst, poseDiff(p0, p1));
      }
      const settled = Math.abs(angleX(p1, 0)) < 1e-6 && g.state() === 'a';
      const ok = jump < 1e-7 && worst < 0.02 && settled;
      return { ok, detail: `step at the interruption ${jump.toExponential(1)}, largest step per 0.01 s afterwards ${f(worst)}, back in a: ${settled}` };
    },
  },
  {
    name: 'transition-full-list',
    run() {
      // Flipping back and forth every update fills the list of active states; the pose may only step by the share of
      // the state that is dropped.
      const g = twoStates(1, 'linear');
      const p0 = new Pose(g.def.skeleton), p1 = new Pose(g.def.skeleton);
      let worst = 0;
      g.evaluate(p1);
      for (let i = 0; i < 20; i++) {
        g.setParam('go', i % 2 === 0 ? 1 : 0);
        p0.copy(p1);
        g.update(0.05);
        g.evaluate(p1);
        worst = Math.max(worst, poseDiff(p0, p1));
      }
      const n = g.data[g.def.layers[0]!.at]!;
      return { ok: n <= g.def.maxBlend && worst < 0.1, detail: `active states ${n} (at most ${g.def.maxBlend}), largest step per update ${f(worst)}` };
    },
  },
  {
    name: 'triggers-and-end',
    run() {
      const sk = chain3();
      const once: MotionSource = { duration: 0.5, loop: false, sample: (o, t) => setBoneAxisAngle(o, 0, 1, 0, 0, t) };
      const g = new MotionGraph(
        compileMotionGraph({
          skeleton: sk,
          layers: [
            {
              name: 'base',
              states: [{ name: 'idle', source: still(0) }, { name: 'act', source: once }],
              transitions: [
                { from: 'idle', to: 'act', seconds: 0, trigger: 'go' },
                { from: 'act', to: 'idle', seconds: 0, after: 1 },
              ],
            },
          ],
        }),
      );
      g.trigger('go');
      g.update(0.1);
      const s1 = g.state();
      g.update(0.3);
      const s2 = g.state();
      const ph = g.phase();
      g.update(0.3);
      g.update(0);
      const s3 = g.state();
      // A trigger nobody consumes is gone after the update: set while in act, it must not restart act once idle.
      const g2 = new MotionGraph(g.def);
      g2.trigger('go');
      g2.update(0);
      const t1 = g2.state();
      g2.trigger('go');
      g2.update(0.6);
      g2.update(0);
      g2.update(0);
      const t2 = g2.state();
      const ok = s1 === 'act' && s2 === 'act' && Math.abs(ph - 0.8) < 1e-9 && s3 === 'idle' && t1 === 'act' && t2 === 'idle';
      return { ok, detail: `trigger → ${s1}; at phase ${f(ph, 2)} ${s2}; after the end ${s3}; a trigger set where nothing takes it is dropped: ${t2}` };
    },
  },
];

// --- Marks and events ------------------------------------------------------------------------------------------------

function markGraph(drive: boolean): MotionGraph {
  const sk = chain3();
  const loop: MotionSource = {
    duration: 1,
    marks: [
      { name: 'right', at: 0.75 },
      { name: 'left', at: 0.25 },
    ],
    unit: 'phase',
    sample: (o, t) => setBoneAxisAngle(o, 1, 1, 0, 0, Math.sin(2 * Math.PI * t)),
  };
  return new MotionGraph(
    compileMotionGraph({
      skeleton: sk,
      maxEvents: 64,
      layers: [{ name: 'legs', states: [{ name: 'cycle', source: loop, ...(drive ? { drive: { param: 'distance', per: 1.25 } } : {}) }] }],
    }),
  );
}

function drain(g: MotionGraph, into: string[]): void {
  g.drainEvents((kind, name, state, layer) => into.push(`${kind}:${name}@${state}/${layer}`));
}

const MARKS: Scenario[] = [
  {
    name: 'marks-small-steps',
    run() {
      const g = markGraph(false);
      const ev: string[] = [];
      for (let i = 0; i < 360; i++) {
        g.update(0.01);
        drain(g, ev);
      }
      const names = ev.map((e) => e.split('@')[0]!.slice(5)).join(' ');
      const ok = ev.length === 7 && names === 'left right left right left right left' && ev[0] === 'mark:left@cycle/legs';
      return { ok, detail: `3.6 passes in 0.01 s steps: ${ev.length} marks: ${names}` };
    },
  },
  {
    name: 'marks-large-dt',
    run() {
      const g = markGraph(false);
      const ev: string[] = [];
      g.update(3.6);
      drain(g, ev);
      const names = ev.map((e) => e.split('@')[0]!.slice(5)).join(' ');
      const exact = markGraph(false);
      const ev2: string[] = [];
      exact.update(0.25); // lands on a mark exactly: reported once
      exact.update(0);
      exact.update(0.5);
      drain(exact, ev2);
      const ok = names === 'left right left right left right left' && ev2.length === 2;
      return { ok, detail: `one update of 3.6 s: ${ev.length} marks in order (${names}); landing on a mark and staying: ${ev2.length} (2 expected)` };
    },
  },
  {
    name: 'marks-driven',
    run() {
      // Phase from a distance: 1.25 m per pass; walking 3 m forward then 1 m back.
      const g = markGraph(true);
      const ev: string[] = [];
      g.setParam('distance', 3);
      g.update(0.016);
      drain(g, ev);
      const fwd = ev.length;
      const ph = g.phase();
      ev.length = 0;
      g.setParam('distance', 2);
      g.update(0.016);
      drain(g, ev);
      const back = ev.map((e) => e.split('@')[0]!.slice(5)).join(' ');
      // 3 m = 2.4 passes: left 0.25, right 0.75, left 1.25, right 1.75, left 2.25 → 5; back to 1.6 passes: crosses 2.25 (left), 1.75 (right).
      const ok = fwd === 5 && Math.abs(ph - 2.4) < 1e-12 && back === 'left right';
      return { ok, detail: `3 m forward: ${fwd} marks, phase ${f(ph, 2)}; 1 m back: ${back}` };
    },
  },
  {
    name: 'events-enter-leave',
    run() {
      const g = twoStates(0.2, 'linear');
      const ev: string[] = [];
      g.setParam('go', 1);
      g.update(0.1);
      drain(g, ev);
      const ok = ev.join() === 'enter:b@b/base,leave:a@a/base';
      return { ok, detail: ev.join(', ') };
    },
  },
];

// --- Reach and ground ------------------------------------------------------------------------------------------------

const REACH: Scenario[] = [
  {
    name: 'reach-in-range',
    run() {
      const sk = chain3();
      const p = new Pose(sk);
      setBoneAxisAngle(p, 1, 1, 0, 0, 0.3); // a slight bend shows the plane
      const w = new Float64Array(sk.count * 12);
      solvePose(sk, p, ID, w);
      const ch: TwoBoneChain = { upper: 0, lower: 1, end: 2 };
      const t = [0.2, 0.35, 0.3];
      const d = reachTwoBone(sk, p, ID, w, ch, t);
      // The bones keep their lengths.
      const l1 = Math.hypot(w[12 + 9]! - w[9]!, w[12 + 10]! - w[10]!, w[12 + 11]! - w[11]!);
      const l2 = Math.hypot(w[24 + 9]! - w[12 + 9]!, w[24 + 10]! - w[12 + 10]!, w[24 + 11]! - w[12 + 11]!);
      const ok = d < 1e-5 && Math.abs(l1 - 0.5) < 1e-6 && Math.abs(l2 - 0.5) < 1e-6;
      return { ok, detail: `end to target ${d.toExponential(1)} m, bone lengths ${f(l1, 6)} ${f(l2, 6)}` };
    },
  },
  {
    name: 'reach-out-of-range',
    run() {
      const sk = chain3();
      const p = new Pose(sk);
      setBoneAxisAngle(p, 1, 1, 0, 0, 0.3);
      const w = new Float64Array(sk.count * 12);
      solvePose(sk, p, ID, w);
      const t = [0, 1, 2.5]; // 2.5 m from the root joint, the chain is 1 m
      const d = reachTwoBone(sk, p, ID, w, { upper: 0, lower: 1, end: 2 }, t);
      // Stretched toward the target: the end lies on the line from the root joint, 1 m out.
      const ex = w[24 + 9]!, ey = w[24 + 10]!, ez = w[24 + 11]!;
      const along = Math.hypot(ex, ey - 1, ez);
      const off = Math.hypot(ex, ey - 1); // sideways from the +z line through (0, 1, 0)
      const ok = Math.abs(d - 1.5) < 1e-3 && Math.abs(along - 1) < 1e-4 && off < 1e-2;
      return { ok, detail: `distance left ${f(d)} m (1.5 expected), end ${f(along)} m from the root joint, ${f(off)} m off the line` };
    },
  },
  {
    name: 'reach-pole-and-straight',
    run() {
      const sk = chain3();
      // Straight chain, target closer: with the bend axis +x of the lower bone the middle joint goes to +z.
      const p = new Pose(sk);
      const w = new Float64Array(sk.count * 12);
      solvePose(sk, p, ID, w);
      const d = reachTwoBone(sk, p, ID, w, { upper: 0, lower: 1, end: 2, bend: [1, 0, 0] }, [0, 0.3, 0]);
      const midZ = w[12 + 11]!;
      const lowerTurn = angleX(p, 1);
      // With a pole on the +x side the middle joint turns there.
      const q = new Pose(sk);
      setBoneAxisAngle(q, 1, 1, 0, 0, 0.4);
      solvePose(sk, q, ID, w);
      const d2 = reachTwoBone(sk, q, ID, w, { upper: 0, lower: 1, end: 2 }, [0, 0.3, 0], 1, [2, 0.6, 0]);
      const midX = w[12 + 9]!;
      const ok = d < 1e-5 && midZ > 0.1 && lowerTurn > 0 && d2 < 1e-5 && midX > 0.1;
      return { ok, detail: `straight: reached (${d.toExponential(1)}), middle joint z ${f(midZ, 3)}, lower bone turned ${f(lowerTurn / DEG, 1)}° about +x; with a pole at +x: reached (${d2.toExponential(1)}), middle joint x ${f(midX, 3)}` };
    },
  },
  {
    name: 'reach-weight',
    run() {
      const sk = chain3();
      const p = new Pose(sk);
      setBoneAxisAngle(p, 1, 1, 0, 0, 0.3);
      const w = new Float64Array(sk.count * 12);
      solvePose(sk, p, ID, w);
      const before = fingerprint(p);
      const d0 = reachTwoBone(sk, p, ID, w, { upper: 0, lower: 1, end: 2 }, [0.2, 0.35, 0.3], 0);
      const same = fingerprint(p) === before;
      const d5 = reachTwoBone(sk, p, ID, w, { upper: 0, lower: 1, end: 2 }, [0.2, 0.35, 0.3], 0.5);
      const ok = same && d5 > 1e-3 && d5 < d0;
      return { ok, detail: `weight 0 leaves the pose (${same}), distance ${f(d0)}; weight 0.5 halfway, distance ${f(d5)}` };
    },
  },
  {
    name: 'ground-fit',
    run() {
      // Two made-up chains side by side on a step: the right one stands 0.15 m higher, the left one 0.1 m lower.
      const sk = new Skeleton([
        { name: 'hub', parent: -1, joint: [0, 1, 0] },
        { name: 'l1', parent: 0, joint: [-0.2, 0, 0] },
        { name: 'l2', parent: 1, joint: [0, -0.5, 0] },
        { name: 'l3', parent: 2, joint: [0, -0.5, 0] },
        { name: 'r1', parent: 0, joint: [0.2, 0, 0] },
        { name: 'r2', parent: 4, joint: [0, -0.5, 0] },
        { name: 'r3', parent: 5, joint: [0, -0.5, 0] },
      ]);
      const p = new Pose(sk);
      setBoneAxisAngle(p, 2, 1, 0, 0, 0.2);
      setBoneAxisAngle(p, 5, 1, 0, 0, 0.2);
      const w = new Float64Array(sk.count * 12);
      solvePose(sk, p, ID, w);
      const restL = w[3 * 12 + 10]!, restR = w[6 * 12 + 10]!;
      const chains: TwoBoneChain[] = [
        { upper: 1, lower: 2, end: 3 },
        { upper: 4, lower: 5, end: 6 },
      ];
      fitToGround(sk, p, ID, w, chains, { heightAt: (x) => (x > 0 ? 0.15 : -0.1), planeY: 0, lower: 0 });
      const yl = w[3 * 12 + 10]!, yr = w[6 * 12 + 10]!;
      const hub = p.offset[1]!;
      const ok = Math.abs(yl - (restL - 0.1)) < 1e-5 && Math.abs(yr - (restR + 0.15)) < 1e-5 && Math.abs(hub + 0.1) < 1e-6;
      return { ok, detail: `ends from ${f(restL, 3)} / ${f(restR, 3)} to ${f(yl, 3)} / ${f(yr, 3)} m, hub lowered ${f(hub, 3)} m` };
    },
  },
  {
    name: 'ground-fit-align',
    run() {
      // One made-up chain over a slope rising 0.3 m per metre along x and 0.1 along z: with `align` the end bone's axes
      // are those of the plain fit turned by the rotation that takes +y to the ground's normal, the end's joint stays
      // where the fit put it, and `maxAlign` caps the tilt.
      const sk = new Skeleton([
        { name: 'hub', parent: -1, joint: [0, 1, 0] },
        { name: 'l1', parent: 0, joint: [0, 0, 0] },
        { name: 'l2', parent: 1, joint: [0, -0.5, 0] },
        { name: 'l3', parent: 2, joint: [0, -0.45, 0] },
      ]);
      const chains: TwoBoneChain[] = [{ upper: 1, lower: 2, end: 3 }];
      const heightAt = (x: number, z: number): number => 0.3 * x + 0.1 * z;
      const run = (o: { align?: number; maxAlign?: number }): { w: Float64Array; p: Pose } => {
        const p = new Pose(sk);
        setBoneAxisAngle(p, 2, 1, 0, 0, 0.2);
        const w = new Float64Array(sk.count * 12);
        solvePose(sk, p, ID, w);
        fitToGround(sk, p, ID, w, chains, { heightAt, planeY: 0, ...o });
        return { w, p };
      };
      /** Column `c` of the end bone's matrix. */
      const axis = (w: Float64Array, c: number): number[] => [w[36 + c * 3]!, w[36 + c * 3 + 1]!, w[36 + c * 3 + 2]!];
      /** `v` turned by `angle` about the unit axis `k` (Rodrigues). */
      const turned = (v: number[], k: number[], angle: number): number[] => {
        const c = Math.cos(angle), s = Math.sin(angle);
        const d = k[0]! * v[0]! + k[1]! * v[1]! + k[2]! * v[2]!;
        const x = [k[1]! * v[2]! - k[2]! * v[1]!, k[2]! * v[0]! - k[0]! * v[2]!, k[0]! * v[1]! - k[1]! * v[0]!];
        return [0, 1, 2].map((i) => v[i]! * c + x[i]! * s + k[i]! * d * (1 - c));
      };
      // The tilt: about (−0.1, 0, 0.3) normalised (up × normal), by atan of the slope's length.
      const kl = Math.hypot(0.1, 0.3);
      const k = [-0.1 / kl, 0, 0.3 / kl];
      const slope = Math.atan(Math.hypot(0.3, 0.1));
      const plain = run({});
      const tilted = run({ align: 1 });
      const capped = run({ align: 1, maxAlign: 0.1 });
      let err = 0;
      for (let c = 0; c < 3; c++) {
        const want = turned(axis(plain.w, c), k, slope);
        const wantCap = turned(axis(plain.w, c), k, 0.1);
        const got = axis(tilted.w, c);
        const gotCap = axis(capped.w, c);
        for (let i = 0; i < 3; i++) err = Math.max(err, Math.abs(got[i]! - want[i]!), Math.abs(gotCap[i]! - wantCap[i]!));
      }
      const moved = Math.hypot(tilted.w[45]! - plain.w[45]!, tilted.w[46]! - plain.w[46]!, tilted.w[47]! - plain.w[47]!);
      const ok = err < 1e-6 && moved < 1e-9 && slope > 0.2;
      return { ok, detail: `end turned by the ground's tilt (${f(slope, 4)} rad; capped 0.1) within ${err.toExponential(1)}, its joint moved ${moved.toExponential(1)} m` };
    },
  },
];

// --- Eased weights, reaching for a moving target, aiming, sockets -----------------------------------------------------

/** A root frame turned about z by `tilt` and about its own y by `yaw`, at (x, y, z): a figure on a curved world. */
function tiltedRoot(tilt: number, yaw: number, x: number, y: number, z: number): Float64Array {
  const ct = Math.cos(tilt), st = Math.sin(tilt), cy = Math.cos(yaw), sy = Math.sin(yaw);
  // Columns of Rz(tilt) · Ry(yaw).
  return new Float64Array([ct * cy, st * cy, -sy, -st, ct, 0, ct * sy, st * sy, cy, x, y, z]);
}

/** A point given in a root frame's own axes, in the frame the pose is solved in. */
function inRoot(r: ArrayLike<number>, x: number, y: number, z: number): number[] {
  return [r[0]! * x + r[3]! * y + r[6]! * z + r[9]!, r[1]! * x + r[4]! * y + r[7]! * z + r[10]!, r[2]! * x + r[5]! * y + r[8]! * z + r[11]!];
}

/** A made-up trunk with a top link: a hub on the root, a trunk link and a top link above it. */
function trunk(): Skeleton {
  return new Skeleton([
    { name: 'hub', parent: -1, joint: [0, 0, 0] },
    { name: 'trunk', parent: 0, joint: [0, 1, 0] },
    { name: 'top', parent: 1, joint: [0, 0.5, 0] },
  ]);
}

const AIM: AimChain = { bones: [1, 2], shares: [0.4, 0.6], maxYaw: 70 * DEG, maxUp: 30 * DEG, maxDown: 40 * DEG, eye: [0, 0.1, 0] };

const POST: Scenario[] = [
  {
    name: 'fade-eased',
    run() {
      const fd = new WeightFade(0);
      fd.to(1, 0.4);
      const v: number[] = [];
      for (let i = 0; i < 8; i++) v.push(fd.update(0.05));
      let mono = true;
      for (let i = 1; i < v.length; i++) if (v[i]! < v[i - 1]!) mono = false;
      // Turning back half way starts from where it is, without a jump.
      const g = new WeightFade(0);
      g.to(1, 1);
      g.update(0.5);
      const mid = g.value;
      g.to(0, 1);
      const afterTurn = g.value;
      g.update(0.01);
      const jump = Math.abs(g.value - mid);
      const z = new WeightFade(0.3);
      z.to(0.8, 0);
      const ok = mono && v[0]! < 0.05 && v[3]! === 0.5 && v[7]! === 1 && fd.done && afterTurn === mid && jump < 1e-3 && z.value === 0.8;
      return { ok, detail: `0→1 in 0.4 s by 0.05 s: ${v.map((x) => f(x, 3)).join(' ')}; turned back at ${f(mid, 3)}: first step ${jump.toExponential(1)}; 0 s jumps (${z.value})` };
    },
  },
  {
    name: 'reach-soft-continuous',
    run() {
      // The target moves along a line from 0.5 m to 1.6 m from the upper joint (the chain is 1 m) and back: the end
      // never moves much farther than the target did, and a far target is never quite reached (no straight snap).
      const sk = chain3();
      const p = new Pose(sk);
      const w = new Float64Array(sk.count * 12);
      const r = new TwoBoneReach({ upper: 0, lower: 1, end: 2 }, { soft: 0.9 });
      r.fade.set(1);
      let worst = 0;
      let prev: number[] | null = null;
      let near = 0;
      let far = 0;
      const steps = 400;
      for (let i = 0; i <= steps; i++) {
        const s = i <= steps / 2 ? i / (steps / 2) : 2 - i / (steps / 2);
        const d = 0.5 + 1.1 * s;
        p.reset();
        setBoneAxisAngle(p, 1, 1, 0, 0, 0.3);
        solvePose(sk, p, ID, w);
        r.setTarget(0, 1 - 0.6 * d, 0.8 * d);
        const left = r.apply(sk, p, ID, w);
        const e = [w[24 + 9]!, w[24 + 10]!, w[24 + 11]!];
        if (prev) worst = Math.max(worst, Math.hypot(e[0]! - prev[0]!, e[1]! - prev[1]!, e[2]! - prev[2]!) / (1.1 / (steps / 2)));
        prev = e;
        if (i === 0) near = left;
        if (i === steps / 2) far = Math.hypot(e[0]!, e[1]! - 1, e[2]!);
      }
      const ok = near < 1e-4 && worst < 1.2 && far < 1 && far > 0.97;
      return { ok, detail: `near target reached (${near.toExponential(1)}); end moves at most ${f(worst, 2)}× the target's step; 1.6 m out the end is ${f(far, 4)} m from the upper joint (chain 1 m)` };
    },
  },
  {
    name: 'reach-eased-weight',
    run() {
      // In over 0.3 s, out over 0.3 s: the end slides from its pose to the target and back without a jump.
      const sk = chain3();
      const p = new Pose(sk);
      const w = new Float64Array(sk.count * 12);
      const r = new TwoBoneReach({ upper: 0, lower: 1, end: 2 });
      r.setTarget(0.3, 0.4, 0.2);
      r.on(0.3);
      let prev: number[] | null = null;
      let worst = 0;
      let reached = Infinity;
      let back = Infinity;
      for (let i = 0; i < 60; i++) {
        if (i === 30) r.off(0.3);
        r.update(1 / 60);
        p.reset();
        setBoneAxisAngle(p, 1, 1, 0, 0, 0.3);
        solvePose(sk, p, ID, w);
        const rest = [w[24 + 9]!, w[24 + 10]!, w[24 + 11]!];
        const left = r.apply(sk, p, ID, w);
        const e = [w[24 + 9]!, w[24 + 10]!, w[24 + 11]!];
        if (prev) worst = Math.max(worst, Math.hypot(e[0]! - prev[0]!, e[1]! - prev[1]!, e[2]! - prev[2]!));
        prev = e;
        if (i === 25) reached = left;
        if (i === 59) back = Math.hypot(e[0]! - rest[0]!, e[1]! - rest[1]!, e[2]! - rest[2]!);
      }
      const ok = reached < 1e-4 && back < 1e-9 && worst < 0.06;
      return { ok, detail: `reached after the fade in (${reached.toExponential(1)}), back on the pose after the fade out (${back.toExponential(1)}); largest step of the end ${f(worst, 3)} m a frame` };
    },
  },
  {
    name: 'reach-end-rotation',
    run() {
      const sk = chain3();
      const p = new Pose(sk);
      const w = new Float64Array(sk.count * 12);
      const root = tiltedRoot(0.5, 0.3, 2, 3, 4);
      solvePose(sk, p, root, w);
      const r = new TwoBoneReach({ upper: 0, lower: 1, end: 2 });
      r.fade.set(1);
      const t = inRoot(root, 0.2, 0.5, 0.4);
      r.setTarget(t[0]!, t[1]!, t[2]!);
      // Wanted: the end turned 0.7 rad about the solved frame's z.
      r.endRotation.set([0, 0, Math.sin(0.35), Math.cos(0.35)]);
      r.useEndRotation = true;
      const left = r.apply(sk, p, root, w);
      // Its x axis should be (cos 0.7, sin 0.7, 0).
      const err = Math.hypot(w[24]! - Math.cos(0.7), w[25]! - Math.sin(0.7), w[26]!);
      const ok = left < 1e-4 && err < 1e-5;
      return { ok, detail: `reached on a tilted root (${left.toExponential(1)}), end's x axis off the wanted turn by ${err.toExponential(1)}` };
    },
  },
  {
    name: 'aim-limits-and-behind',
    run() {
      // A point circles the trunk at the height of the top link, on a root tilted 0.6 rad (a curved world): the facing
      // stays within ±70°, follows the point in front, fades back to straight ahead behind it and never flips.
      const sk = trunk();
      const p = new Pose(sk);
      const w = new Float64Array(sk.count * 12);
      const root = tiltedRoot(0.6, 0.2, 5, -2, 1);
      const a: AimAngles = { yaw: 0, pitch: 0, goalYaw: 0, goalPitch: 0, faceYaw: 0, facePitch: 0 };
      let maxYaw = 0;
      let maxStep = 0;
      let prev = 0;
      let frontLeft = 0;
      let behind = 1;
      const steps = 720;
      for (let i = 0; i <= steps; i++) {
        const ang = (2 * Math.PI * i) / steps;
        p.reset();
        solvePose(sk, p, root, w);
        const t = inRoot(root, 3 * Math.sin(ang), 1.6, 3 * Math.cos(ang));
        const left = aimChain(sk, p, root, w, AIM, t, 1);
        aimAngles(w, root, AIM, t, a);
        maxYaw = Math.max(maxYaw, Math.abs(a.faceYaw));
        if (i > 0) maxStep = Math.max(maxStep, Math.abs(a.faceYaw - prev));
        prev = a.faceYaw;
        if (i === steps / 12) frontLeft = left; // 30° to the side
        if (i === steps / 2) behind = Math.abs(a.faceYaw);
      }
      // A point high above: the pitch stops at the limit.
      p.reset();
      solvePose(sk, p, root, w);
      const up = inRoot(root, 0, 9, 1);
      aimChain(sk, p, root, w, AIM, up, 1);
      aimAngles(w, root, AIM, up, a);
      const ok = maxYaw <= 70 * DEG + 1e-6 && frontLeft < 1e-3 && behind < 1e-6 && maxStep < 2 * DEG && a.facePitch <= 30 * DEG + 1e-6 && a.facePitch > 29 * DEG;
      return { ok, detail: `facing within ${f(maxYaw / DEG, 2)}° (limit 70°), 30° to the side reached (${frontLeft.toExponential(1)} rad left), straight behind ${f(behind / DEG, 4)}°, largest step ${f(maxStep / DEG, 2)}° per 0.5° of the point; point above: pitch ${f(a.facePitch / DEG, 2)}° (limit 30°)` };
    },
  },
  {
    name: 'aim-shares-and-weight',
    run() {
      // A point 40° to the side: the trunk takes 0.4 of the turn, the top link the rest; at weight 0.5 half of it.
      const sk = trunk();
      const p = new Pose(sk);
      const w = new Float64Array(sk.count * 12);
      const t = [Math.sin(40 * DEG) * 4, 1.6, Math.cos(40 * DEG) * 4];
      solvePose(sk, p, ID, w);
      aimChain(sk, p, ID, w, AIM, t, 1);
      const trunkYaw = Math.atan2(w[12 + 6]!, w[12 + 8]!);
      const topYaw = Math.atan2(w[24 + 6]!, w[24 + 8]!);
      p.reset();
      solvePose(sk, p, ID, w);
      const c = new ChainAim(AIM);
      c.setTarget(t[0]!, t[1]!, t[2]!);
      c.on(0.2);
      c.update(0.1);
      c.apply(sk, p, ID, w);
      const halfYaw = Math.atan2(w[24 + 6]!, w[24 + 8]!);
      const tYaw = Math.atan2(t[0]!, t[2]!);
      const ok = Math.abs(trunkYaw - 0.4 * tYaw) < 0.5 * DEG && Math.abs(topYaw - tYaw) < 0.5 * DEG && Math.abs(halfYaw - 0.5 * tYaw) < 0.5 * DEG;
      return { ok, detail: `trunk ${f(trunkYaw / DEG, 2)}°, top ${f(topYaw / DEG, 2)}° of ${f(tYaw / DEG, 2)}°; at weight ${f(c.weight, 2)}: ${f(halfYaw / DEG, 2)}°` };
    },
  },
  {
    name: 'socket-blend',
    run() {
      // A thing passes from a socket on the tip of one chain to a socket on the root of another over 1 s: it starts
      // and ends exactly on the sockets, moves without a jump, and stays a rigid turn on the way.
      const sk = chain3();
      const pa = new Pose(sk);
      const pb = new Pose(sk);
      setBoneAxisAngle(pa, 1, 1, 0, 0, 0.6);
      setBoneAxisAngle(pb, 0, 0, 1, 0, 2.5);
      const wa = new Float64Array(sk.count * 12);
      const wb = new Float64Array(sk.count * 12);
      solvePose(sk, pa, tiltedRoot(0.3, 0, 0, 0, 0), wa);
      solvePose(sk, pb, tiltedRoot(-0.2, 1, 1.5, 0, 0.5), wb);
      const sa: Socket = { bone: 2, local: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -0.1, 0.05] };
      const sb: Socket = { bone: 0, local: [0, 1, 0, -1, 0, 0, 0, 0, 1, 0.2, 0, 0] };
      const at0 = socketTransform(wa, sa, new Float64Array(12));
      const at1 = socketTransform(wb, sb, new Float64Array(12));
      const out = new Float64Array(12);
      const bl = new SocketBlend();
      bl.write(wa, sa, wb, sb, out);
      let start = 0;
      for (let i = 0; i < 12; i++) start = Math.max(start, Math.abs(out[i]! - at0[i]!));
      bl.to(1, 1);
      let prev = [out[9]!, out[10]!, out[11]!];
      let worst = 0;
      let rigid = 0;
      for (let i = 0; i < 60; i++) {
        bl.update(1 / 50);
        bl.write(wa, sa, wb, sb, out);
        worst = Math.max(worst, Math.hypot(out[9]! - prev[0]!, out[10]! - prev[1]!, out[11]! - prev[2]!));
        prev = [out[9]!, out[10]!, out[11]!];
        rigid = Math.max(rigid, Math.abs(Math.hypot(out[0]!, out[1]!, out[2]!) - 1), Math.abs(out[0]! * out[3]! + out[1]! * out[4]! + out[2]! * out[5]!));
      }
      let end = 0;
      for (let i = 0; i < 12; i++) end = Math.max(end, Math.abs(out[i]! - at1[i]!));
      const gap = Math.hypot(at1[9]! - at0[9]!, at1[10]! - at0[10]!, at1[11]! - at0[11]!);
      // The socket on the solved tip: its point is the tip's matrix times the local point (0, −0.1, 0.05).
      let pointErr = 0;
      for (let c = 0; c < 3; c++) pointErr = Math.max(pointErr, Math.abs(at0[9 + c]! - (wa[24 + 3 + c]! * -0.1 + wa[24 + 6 + c]! * 0.05 + wa[24 + 9 + c]!)));
      const half = blendTransform(at0, at1, 0.5, new Float64Array(12));
      const midOk = Math.abs(half[9]! - 0.5 * (at0[9]! + at1[9]!)) < 1e-12;
      const ok = start < 1e-12 && end < 1e-12 && worst < 1.6 * (gap / 50) && rigid < 1e-9 && midOk && pointErr < 1e-12;
      return { ok, detail: `starts on the first socket (${start.toExponential(1)}), ends on the second (${end.toExponential(1)}); ${f(gap, 3)} m in 1 s, largest step ${f(worst, 4)} m per 0.02 s; rigid within ${rigid.toExponential(1)}` };
    },
  },
  {
    name: 'socket-blend-mirrored',
    run() {
      // Two mirrored transforms (determinant −1) stay mirrored all the way: the same one blended with itself is itself
      // at every weight, two turned ones keep a determinant of −1. Ends of different handedness take the first's up to
      // 0.5 and the second's from there.
      const det = (m: ArrayLike<number>): number => m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[3]! * (m[1]! * m[8]! - m[2]! * m[7]!) + m[6]! * (m[1]! * m[5]! - m[2]! * m[4]!);
      const mirror = new Float64Array([-1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0, 0]);
      const out = new Float64Array(12);
      let selfErr = 0;
      let detErr = 0;
      // A mirror about x, turned 0.4 rad about y and then 2 rad about z, both scaled by 2 along the second axis.
      const turned = (a: number, axis: 'y' | 'z'): Float64Array => {
        const c = Math.cos(a), s = Math.sin(a);
        const r = axis === 'y' ? [c, 0, -s, 0, 1, 0, s, 0, c] : [c, s, 0, -s, c, 0, 0, 0, 1];
        const m = new Float64Array(12);
        // r · diag(−1, 2, 1)
        for (let col = 0; col < 3; col++) {
          const k = col === 0 ? -1 : col === 1 ? 2 : 1;
          for (let row = 0; row < 3; row++) m[col * 3 + row] = r[col * 3 + row]! * k;
        }
        return m;
      };
      const ma = turned(0.4, 'y');
      const mb = turned(2, 'z');
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        blendTransform(mirror, mirror, t, out);
        for (let k = 0; k < 12; k++) selfErr = Math.max(selfErr, Math.abs(out[k]! - mirror[k]!));
        blendTransform(ma, mb, t, out);
        detErr = Math.max(detErr, Math.abs(det(out) + 2));
      }
      const before = det(blendTransform(mirror, ID, 0.49, out));
      const after = det(blendTransform(mirror, ID, 0.5, out));
      const ok = selfErr < 1e-12 && detErr < 1e-9 && before < 0 && after > 0;
      return { ok, detail: `a mirror blended with itself off by ${selfErr.toExponential(1)}; two turned mirrors keep det −2 within ${detErr.toExponential(1)}; mirror to identity: det ${f(before, 3)} at 0.49, ${f(after, 3)} at 0.5` };
    },
  },
  {
    name: 'aim-weight-zero-reports-left',
    run() {
      // A point 40° to the side with the weight at 0: `ChainAim.apply` reports the angle left as `aimChain(…, 0)` does
      // (the whole 40°), and turns nothing.
      const sk = trunk();
      const p = new Pose(sk);
      const w = new Float64Array(sk.count * 12);
      const t = [Math.sin(40 * DEG) * 4, 1.6, Math.cos(40 * DEG) * 4];
      solvePose(sk, p, ID, w);
      const direct = aimChain(sk, p, ID, w, AIM, t, 0);
      const before = w.slice();
      const c = new ChainAim(AIM);
      c.setTarget(t[0]!, t[1]!, t[2]!);
      const got = c.apply(sk, p, ID, w);
      let moved = 0;
      for (let i = 0; i < w.length; i++) moved = Math.max(moved, Math.abs(w[i]! - before[i]!));
      const ok = direct > 30 * DEG && got === direct && c.left === direct && moved === 0;
      return { ok, detail: `weight 0: aimChain reports ${f(direct / DEG, 2)}° left, ChainAim.apply ${f(got / DEG, 2)}° (left ${f(c.left / DEG, 2)}°); bones moved ${moved}` };
    },
  },
  {
    name: 'post-determinism',
    run() {
      // The post steps in the documented order, twice over the same 600 frames: the same poses.
      const run = (): number => {
        const sk = trunk();
        const arm = chain3();
        const p = new Pose(sk);
        const pa = new Pose(arm);
        const w = new Float64Array(sk.count * 12);
        const wa = new Float64Array(arm.count * 12);
        const aim = new ChainAim(AIM);
        const reach = new TwoBoneReach({ upper: 0, lower: 1, end: 2 });
        const out = new Float64Array(12);
        let h = 2166136261;
        for (let i = 0; i < 600; i++) {
          const t = i / 60;
          if (i % 120 === 0) aim.on(0.4);
          if (i % 120 === 60) aim.off(0.4);
          if (i % 90 === 0) reach.on(0.3);
          if (i % 90 === 45) reach.off(0.3);
          aim.update(1 / 60);
          reach.update(1 / 60);
          aim.setTarget(3 * Math.sin(t), 1.5, 3 * Math.cos(0.7 * t));
          reach.setTarget(0.3 * Math.sin(t), 0.5, 0.4);
          p.reset();
          pa.reset();
          solvePose(sk, p, ID, w);
          solvePose(arm, pa, ID, wa);
          aim.apply(sk, p, ID, w);
          reach.apply(arm, pa, ID, wa);
          socketTransform(wa, { bone: 2, local: ID }, out);
          h = fingerprint(pa, fingerprint(p, h));
          const u = new Uint32Array(new Float64Array(out).buffer);
          for (let k = 0; k < u.length; k++) h = Math.imul(h ^ u[k]!, 16777619) >>> 0;
        }
        return h;
      };
      const a = run();
      const b = run();
      return { ok: a === b, detail: `600 frames of aim, reach and a socket: ${a.toString(16)} / ${b.toString(16)}` };
    },
  },
];

// --- Save, restore, determinism and many figures -------------------------------------------------------------------

/** A graph of three layers over a made-up chain of `bones` links: a base with two speed motions, an override and an additive layer. */
function bigDesc(bones: number): MotionGraphDesc<{ seed: number }> {
  const spec = [];
  for (let i = 0; i < bones; i++) spec.push({ name: `b${i}`, parent: i - 1, joint: [0, i === 0 ? 1 : 0.1, 0] as [number, number, number] });
  const sk = new Skeleton(spec);
  const wave = (amp: number, dur: number, speed: [number, number, number]): MotionSource<{ seed: number }> => ({
    duration: dur,
    speed,
    marks: [{ name: 'beat', at: 0.5 }],
    sample(o, t, p) {
      for (let b = 0; b < sk.count; b++) setBoneEuler(o, b, amp * Math.sin((2 * Math.PI * t) / dur + b * 0.3 + p.seed), 0.1 * amp, 0);
    },
  });
  const tilt: MotionSource<{ seed: number }> = { sample: (o, t) => setBoneAxisAngle(o, 0, 0, 0, 1, 0.2 * Math.sin(t)) };
  const sway: MotionSource<{ seed: number }> = { sample: (o, t) => setBoneAxisAngle(o, bones - 1, 0, 1, 0, 0.3 * Math.sin(1.7 * t)) };
  return {
    skeleton: sk,
    params: { speed: 0, mode: 0, lean: 0 },
    triggers: ['hop'],
    layers: [
      {
        name: 'base',
        states: [
          { name: 'rest', source: wave(0.02, 3, [0, 0, 0.3]) },
          { name: 'move', sources: [wave(0.2, 1.1, [0.3, 1, 1.6]), wave(0.4, 0.7, [1.5, 3, 5])], by: 'speed', sync: 'go' },
          { name: 'hop', source: { ...wave(0.6, 0.5, [0, 0, 0]), loop: false } },
        ],
        transitions: [
          { from: 'rest', to: 'move', seconds: 0.3, when: [{ param: 'speed', op: '>', value: 0.2 }] },
          { from: 'move', to: 'rest', seconds: 0.4, when: [{ param: 'speed', op: '<=', value: 0.2 }] },
          { from: '*', to: 'hop', seconds: 0.1, trigger: 'hop' },
          { from: 'hop', to: 'rest', seconds: 0.2, after: 1 },
        ],
      },
      { name: 'upper', mask: boneMask(sk, [`b${bones >> 1}`]), weight: 'lean', states: [{ name: 'off' }, { name: 'tilt', source: tilt }], transitions: [{ from: 'off', to: 'tilt', seconds: 0.45, when: [{ param: 'mode', op: '==', value: 1 }] }, { from: 'tilt', to: 'off', seconds: 0.45, when: [{ param: 'mode', op: '==', value: 0 }] }] },
      { name: 'finish', mode: 'additive', states: [{ name: 'sway', source: sway }] },
    ],
  };
}

/** Drives a figure through a fixed script for `frames` frames; returns a fingerprint of poses and events. */
function script(g: MotionGraph<{ seed: number }>, from: number, frames: number, p: Pose): number {
  let h = 2166136261;
  for (let i = from; i < from + frames; i++) {
    const t = i / 60;
    g.setParam('speed', 2.5 * Math.max(0, Math.sin(t * 0.7)));
    g.setParam('mode', Math.floor(t / 1.3) % 2);
    g.setParam('lean', 0.5 + 0.5 * Math.sin(t));
    if (i % 97 === 50) g.trigger('hop');
    g.update(1 / 60);
    g.evaluate(p);
    h = fingerprint(p, h);
    g.drainEvents((kind, name, state) => {
      for (const c of `${kind}${name}${state}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    });
  }
  return h;
}

const STATE: Scenario[] = [
  {
    name: 'set-state-part-way',
    run() {
      // Straight into 'cycle' 1.1 s in (1 s per pass): phase 1.1, no events; the next mark comes at phase 1.25.
      const g = markGraph(false);
      g.update(0.1);
      drain(g, []);
      g.setState('cycle', 'legs', 1.1);
      const ev: string[] = [];
      drain(g, ev);
      const ph = g.phase('legs');
      const quiet = ev.length;
      g.update(0.2);
      drain(g, ev);
      const after = ev.map((e) => e.split('@')[0]).join(' ');
      // Into a state of a two-state layer: it is the only active one at once, at full weight.
      const t = twoStates(0.5, 'linear');
      t.setState('b', undefined, 0.2);
      const wb = t.weightOf('b'), wa = t.weightOf('a');
      let threw = false;
      try {
        t.setState('none');
      } catch {
        threw = true;
      }
      const ok = Math.abs(ph - 1.1) < 1e-12 && quiet === 0 && after === 'mark:left' && wb === 1 && wa === 0 && t.state() === 'b' && Math.abs(t.time() - 0.2) < 1e-12 && threw;
      return { ok, detail: `phase ${ph.toFixed(3)} with ${quiet} events, then ${after}; two states: weight b ${wb}, a ${wa}, time ${t.time().toFixed(3)}; unknown state throws: ${threw}` };
    },
  },
  {
    name: 'save-restore',
    run() {
      const def = compileMotionGraph(bigDesc(12));
      const a = new MotionGraph(def, { seed: 0.3 });
      const p = new Pose(def.skeleton);
      script(a, 0, 200, p);
      const bytes = a.save();
      const ha = script(a, 200, 300, p);
      const b = new MotionGraph(def, { seed: 0.3 });
      b.restore(bytes);
      const hb = script(b, 200, 300, p);
      return { ok: ha === hb, detail: `${bytes.length} bytes of state; 300 frames after the save: ${ha.toString(16)} / after restore ${hb.toString(16)}` };
    },
  },
  {
    name: 'determinism',
    run() {
      const runOnce = (): number => {
        const def = compileMotionGraph(bigDesc(12));
        const g = new MotionGraph(def, { seed: 0.7 });
        return script(g, 0, 600, new Pose(def.skeleton));
      };
      const h1 = runOnce(), h2 = runOnce();
      return { ok: h1 === h2, detail: `two runs of 600 frames: ${h1.toString(16)} / ${h2.toString(16)}` };
    },
  },
  {
    name: 'figures-500',
    kind: 'timing',
    run() {
      // 500 figures of 20 bones share one description: update, evaluate and solve to world matrices every frame.
      const def = compileMotionGraph(bigDesc(20));
      const n = 500;
      const figs: MotionGraph<{ seed: number }>[] = [];
      for (let i = 0; i < n; i++) figs.push(new MotionGraph(def, { seed: i * 0.618 }));
      const pose = new Pose(def.skeleton);
      const world = new Float64Array(def.skeleton.count * 12);
      const root = new Float64Array(ID);
      const frame = (k: number): void => {
        for (let i = 0; i < n; i++) {
          const g = figs[i]!;
          g.setParam('speed', 2 * Math.max(0, Math.sin(k * 0.01 + i)));
          g.setParam('mode', (k + i) % 200 < 100 ? 1 : 0);
          g.setParam('lean', 0.7);
          g.update(1 / 60);
          g.evaluate(pose);
          root[9] = i;
          solvePose(def.skeleton, pose, root, world);
          g.drainEvents(() => {});
        }
      };
      for (let k = 0; k < 30; k++) frame(k);
      const heap0 = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      const frames = 60;
      for (let k = 30; k < 30 + frames; k++) frame(k);
      const ms = (performance.now() - t0) / frames;
      const grew = (process.memoryUsage().heapUsed - heap0) / frames;
      const state = figs[0]!.byteLength;
      return { ok: ms < 8, detail: `${f(ms, 2)} ms per frame for ${n} figures (3 layers, 20 bones; update + evaluate + solve), state ${state} B per figure, heap change ${f(grew / 1024, 1)} KiB per frame (informative)` };
    },
  },
];

// --- Two layer stacks of the M3 spec, on made-up chains ----------------------------------------------------------------

const STACKS: Scenario[] = [
  {
    name: 'stack-action-gait-hold-look',
    run() {
      // Actions on the base layer chosen by a number (cross-fade 0.45 s), a repeated action with its own cycle length
      // (rate from a parameter) and a mark at 0.66 that the game turns into an effect; a gait added by a weight; an
      // override over one branch with its own weight; a turn added last.
      const sk = new Skeleton([
        { name: 'hub', parent: -1, joint: [0, 1, 0] },
        { name: 'arm', parent: 0, joint: [0.2, 0.3, 0] },
        { name: 'hand', parent: 1, joint: [0, -0.3, 0] },
        { name: 'top', parent: 0, joint: [0, 0.4, 0] },
      ]);
      const pose = (rad: number, bone = 1): MotionSource => ({ sample: (o) => setBoneAxisAngle(o, bone, 1, 0, 0, rad) });
      const swing: MotionSource = { duration: 1, marks: [{ name: 'hit', at: 0.66 }], sample: (o, t) => setBoneAxisAngle(o, 1, 1, 0, 0, -1.2 * Math.sin(2 * Math.PI * t)) };
      const g = new MotionGraph(
        compileMotionGraph({
          skeleton: sk,
          params: { act: 0, cycle: 0.8, walk: 0, hold: 0 },
          layers: [
            {
              name: 'action',
              states: [{ name: 'rest', source: pose(0) }, { name: 'repeat', source: swing, rate: 'cycle' }, { name: 'reach', source: pose(-1.4) }],
              transitions: [
                { from: '*', to: 'rest', seconds: 0.45, when: [{ param: 'act', op: '==', value: 0 }] },
                { from: '*', to: 'repeat', seconds: 0.45, when: [{ param: 'act', op: '==', value: 1 }] },
                { from: '*', to: 'reach', seconds: 0.45, when: [{ param: 'act', op: '==', value: 2 }] },
              ],
            },
            { name: 'gait', mode: 'additive', weight: 'walk', states: [{ name: 'step', source: { duration: 1, sample: (o, t) => setBoneAxisAngle(o, 0, 0, 0, 1, 0.1 * Math.sin(2 * Math.PI * t)) } }] },
            { name: 'hold', mask: boneMask(sk, ['arm']), weight: 'hold', states: [{ name: 'carry', source: pose(-0.5) }] },
            { name: 'look', mode: 'additive', states: [{ name: 'turn', source: pose(0.3, 3) }] },
          ],
        }),
      );
      const p = new Pose(sk);
      g.setParam('act', 1);
      let hits = 0;
      const cb = (kind: string, name: string): void => {
        if (kind === 'mark' && name === 'hit') hits++;
      };
      // 0.8 cycles per second for 10 s: 8 cycles, so 8 hits (the first at 0.66 / 0.8 = 0.825 s).
      for (let i = 0; i < 600; i++) {
        g.update(1 / 60);
        g.drainEvents(cb);
      }
      g.setParam('act', 2);
      g.update(0.2);
      const mid = g.weightOf('reach', 'action');
      g.update(0.25);
      const done = g.weightOf('reach', 'action');
      g.setParam('hold', 1);
      g.update(0);
      g.evaluate(p);
      const arm = angleX(p, 1) / DEG, top = angleX(p, 3) / DEG;
      const ok = hits === 8 && mid > 0.3 && mid < 0.7 && Math.abs(done - 1) < 1e-9 && Math.abs(arm + 0.5 / DEG) < 1e-3 && Math.abs(top - 0.3 / DEG) < 1e-3;
      return { ok, detail: `marks 'hit' in 10 s at 0.8 cycles/s: ${hits}; weight of the new action after 0.2 s ${f(mid, 3)}, after 0.45 s ${f(done, 3)}; held branch ${f(arm, 2)}° (override), turn added ${f(top, 2)}°` };
    },
  },
  {
    name: 'stack-distance-and-rest',
    run() {
      // A cycle driven by distance (1.25 m per pass) blended by a layer weight over a rest whose source reads the game's
      // input (a cycle of its own every 11 s); the root drop is an offset the game writes into the pose.
      const sk = chain3();
      const input = { time: 0 };
      const rest: MotionSource<{ time: number }> = { sample: (o, _t, inp) => setBoneAxisAngle(o, 1, 1, 0, 0, (inp.time % 11) / 11) };
      const cycle: MotionSource<{ time: number }> = { duration: 1, unit: 'phase', marks: [{ name: 'down', at: 0 }], sample: (o, t) => setBoneAxisAngle(o, 1, 1, 0, 0, Math.sin(2 * Math.PI * t)) };
      const g = new MotionGraph(
        compileMotionGraph({
          skeleton: sk,
          params: { distance: 0, move: 0 },
          layers: [
            { name: 'rest', states: [{ name: 'rest', source: rest }] },
            { name: 'move', weight: 'move', states: [{ name: 'cycle', source: cycle, drive: { param: 'distance', per: 1.25 } }] },
          ],
        }),
        input,
      );
      const p = new Pose(sk);
      let downs = 0;
      for (let i = 0; i <= 100; i++) {
        input.time = i * 0.1;
        g.setParam('distance', i * 0.1); // 10 m
        g.setParam('move', 1);
        g.update(0.1);
        g.drainEvents((k, n) => {
          if (k === 'mark' && n === 'down') downs++;
        });
      }
      const ph = g.phase('move');
      g.setParam('move', 0);
      input.time = 5.5;
      g.update(0.1);
      g.evaluate(p);
      const restAngle = angleX(p, 1);
      const ok = Math.abs(ph - 8) < 1e-9 && downs === 8 && Math.abs(restAngle - 0.5) < 1e-6;
      return { ok, detail: `10 m at 1.25 m per pass: phase ${f(ph, 3)}, ${downs} marks; at rest the source reads the game's input: ${f(restAngle, 3)} rad` };
    },
  },
];

// --- A chain that lags behind (ChainLag) -----------------------------------------------------------------------------

/** A made-up body: a hub, a top 1.6 m above it, and a chain of three links hung behind the top. */
function lagBody(): Skeleton {
  return new Skeleton([
    { name: 'hub', parent: -1, joint: [0, 0, 0] },
    { name: 'top', parent: 0, joint: [0, 1.6, 0] },
    { name: 'link1', parent: 1, joint: [0, 0, -0.1] },
    { name: 'link2', parent: 2, joint: [0, -0.12, -0.06] },
    { name: 'link3', parent: 3, joint: [0, -0.14, -0.02] },
  ]);
}
const LAG: LagChain = { bones: [2, 3, 4], end: [0, -0.14, 0], stiffness: 60, damping: 8, gravity: 0, maxAngle: 50 * DEG };

/** A root at (x, y, z) turned by `yaw` about y. */
function yawRoot(yaw: number, x: number, y: number, z: number, out = new Float64Array(12)): Float64Array {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.set([c, 0, -s, 0, 1, 0, s, 0, c, x, y, z]);
  return out;
}

/**
 * Frames of 1/60 s of a figure placed by `at(frame, root)`: the pose is the rest pose, solved, then the chain applied.
 * `each` sees the angles (and the solved world) after every frame. Returns the pose's rotations at the end.
 */
function lagRun(frames: number, at: (i: number, root: Float64Array) => number | void, chain: LagChain = LAG, each?: (i: number, lag: ChainLag, world: Float64Array, most: number) => void, motionAt?: (i: number, m: Float64Array) => void): Float32Array {
  const sk = lagBody();
  const pose = new Pose(sk);
  const world = new Float64Array(sk.count * 12);
  const root = new Float64Array(12);
  const motion = new Float64Array(12);
  const lag = new ChainLag(sk, chain);
  for (let i = 0; i < frames; i++) {
    const dt = at(i, root);
    pose.reset();
    solvePose(sk, pose, root, world);
    motionAt?.(i, motion);
    const most = lag.apply(typeof dt === 'number' ? dt : 1 / 60, sk, pose, root, world, motionAt ? motion : root);
    each?.(i, lag, world, most);
  }
  return pose.rot.slice();
}

/** The free end of the chain in the solved world. */
function lagTip(world: Float64Array): number[] {
  const b = 4 * 12;
  return [world[b + 3]! * -0.14 + world[b + 9]!, world[b + 4]! * -0.14 + world[b + 10]!, world[b + 5]! * -0.14 + world[b + 11]!];
}

const LAGS: Scenario[] = [
  {
    name: 'lag-rest-stays',
    run() {
      // Standing still (and moving at a steady speed): nothing swings. With a share of gravity it sags once and stays.
      let still = 0;
      lagRun(300, (_, r) => void yawRoot(0.3, 2, 0, 1, r), LAG, (_, __, ___, m) => (still = Math.max(still, m)));
      let steady = 0;
      lagRun(300, (i, r) => void yawRoot(0, 0, 0, i * 0.05, r), LAG, (i, _, __, m) => void (i > 0 && (steady = Math.max(steady, m))));
      let sag = 0;
      let drift = 0;
      const tips: number[][] = [];
      lagRun(420, (_, r) => void yawRoot(0, 0, 0, 0, r), { ...LAG, gravity: 0.5 }, (i, _, w, m) => {
        if (i === 359) sag = m;
        if (i >= 360) tips.push(lagTip(w));
      });
      for (const t of tips) drift = Math.max(drift, Math.hypot(t[0]! - tips[0]![0]!, t[1]! - tips[0]![1]!, t[2]! - tips[0]![2]!));
      const ok = still === 0 && steady < 1e-6 && sag > 2 * DEG && drift < 1e-4;
      return { ok, detail: `still 5 s: largest angle ${still}; steady 3 m/s: ${(steady / DEG).toExponential(1)}°; half gravity: sags ${f(sag / DEG, 1)}°, then moves ${f(drift * 1000, 3)} mm over 1 s` };
    },
  },
  {
    name: 'lag-stop-swings-and-settles',
    run() {
      // 3 m/s along +z for 2 s (the chain hangs behind, at −z), then a stop in one frame: the end swings forward past
      // its posed place, and the swing dies away.
      const v = 3;
      let posed: number[] = [];
      let fwd = 0;
      let late = 0;
      let lateAngle = 0;
      const sk = lagBody();
      lagRun(360, (i, r) => void yawRoot(0, 0, 0, Math.min(i, 120) * (v / 60), r), LAG, (i, _, w, m) => {
        if (i < 120) return;
        if (!posed.length) {
          const p = new Pose(sk);
          const ww = new Float64Array(sk.count * 12);
          solvePose(sk, p, yawRoot(0, 0, 0, 2 * v), ww);
          posed = lagTip(ww);
        }
        const dz = lagTip(w)[2]! - posed[2]!;
        if (i < 180) fwd = Math.max(fwd, dz);
        if (i >= 300) {
          late = Math.max(late, Math.abs(dz));
          lateAngle = Math.max(lateAngle, m);
        }
      });
      const ok = fwd > 0.05 && late < 0.002 && lateAngle < 1 * DEG;
      return { ok, detail: `a stop from ${v} m/s: the end swings ${f(fwd * 100, 1)} cm forward of its posed place within 1 s; 3–4 s after: within ${f(late * 1000, 2)} mm, ${f(lateAngle / DEG, 2)}°` };
    },
  },
  {
    name: 'lag-angle-limit',
    run() {
      // A violent shake (0.4 m at 3 Hz, spinning a turn a second, bouncing): no link leaves its limit.
      const lim = 35 * DEG;
      let most = 0;
      let each = 0;
      lagRun(600, (i, r) => {
        const t = i / 60;
        void yawRoot(t * 2 * Math.PI, Math.sin(t * 6 * Math.PI) * 0.4, Math.abs(Math.sin(t * 5 * Math.PI)) * 0.8, Math.cos(t * 6 * Math.PI) * 0.4, r);
      }, { ...LAG, maxAngle: lim, gravity: 1 }, (_, lag, __, m) => {
        most = Math.max(most, m);
        for (const a of lag.angles) each = Math.max(each, a);
      });
      return { ok: most <= lim + 1e-4 && most > lim - 2 * DEG && each === most, detail: `limit ${f(lim / DEG, 1)}°: largest angle over 10 s of shaking ${f(most / DEG, 3)}°` };
    },
  },
  {
    name: 'lag-same-inputs-same-bits',
    run() {
      const script = (i: number, r: Float64Array): number => {
        const t = i / 60;
        yawRoot(Math.sin(t) * 2, Math.sin(t * 1.3) * 3, 0, t * 2 + Math.sin(t * 4), r);
        // Uneven frames: the fixed steps carry the rest.
        return 1 / 60 + Math.sin(i * 0.7) * 0.006;
      };
      const a = lagRun(500, script, { ...LAG, gravity: 0.4 });
      const b = lagRun(500, script, { ...LAG, gravity: 0.4 });
      let same = 0;
      for (let i = 0; i < a.length; i++) if (Object.is(a[i], b[i])) same++;
      return { ok: same === a.length, detail: `two runs of 500 uneven frames: ${same} of ${a.length} rotation numbers equal` };
    },
  },
  {
    name: 'lag-teleport-and-long-frame',
    run() {
      // A jump of 200 m puts the chain back on its posed shape; a frame of 5 s or a NaN frame takes at most maxSteps
      // steps and stays finite.
      let afterJump = -1;
      let finite = true;
      let most = 0;
      lagRun(240, (i, r) => {
        yawRoot(0, i >= 120 ? 200 : 0, 0, (Math.min(i, 119) * 3) / 60, r);
        return i === 60 ? 5 : i === 90 ? Number.NaN : 1 / 60;
      }, LAG, (i, lag, w, m) => {
        if (i === 120) afterJump = m;
        for (const x of lagTip(w)) if (!Number.isFinite(x)) finite = false;
        most = Math.max(most, m);
        void lag;
      });
      return { ok: afterJump === 0 && finite && most <= LAG.maxAngle + 1e-4, detail: `the frame after a 200 m jump: angle ${afterJump}; a 5 s and a NaN frame: finite ${finite}, largest angle ${f(most / DEG, 2)}° (limit ${f(LAG.maxAngle / DEG, 0)}°)` };
    },
  },
  {
    name: 'lag-stall-keeps-speed',
    run() {
      // Standing, then one frame of 2.5 s (a stall, far more than maxSteps steps) in which the body starts a steady run
      // of 4.6 m/s: the chain is carried over the dropped steps and leaves them moving with its joint, so after the
      // stall it hangs as in a steady run instead of flying to its limit.
      let t = 0;
      let afterStall = -1;
      lagRun(180, (i, r) => {
        const dt = i === 120 ? 2.5 : 1 / 60;
        if (i > 120) t += dt;
        else if (i === 120) t = 2.5;
        yawRoot(0, 0, 0, 4.6 * t, r);
        return dt;
      }, LAG, (i, _, __, m) => {
        if (i === 120) afterStall = m;
      });
      return { ok: afterStall < 0.5 * DEG, detail: `angle after a 2.5 s frame that starts a run from standing ${f(afterStall / DEG, 4)}° (a run of 1/60 s frames: 0°)` };
    },
  },
  {
    name: 'lag-steady-motion-frame',
    run() {
      // The frame the pose is solved in jumps every half second (a new chart), the motion frame does not: the chain
      // swings exactly as with the steady frame alone.
      const pathAt = (i: number, r: Float64Array): Float64Array => yawRoot(Math.sin(i / 50), Math.sin(i / 30), 0, i / 20, r);
      const ref: number[] = [];
      lagRun(300, (i, r) => void pathAt(i, r), LAG, (_, __, ___, m) => void ref.push(m));
      let apart = 0;
      const shift = new Float64Array(12);
      lagRun(300, (i, r) => {
        pathAt(i, shift);
        // The same placement seen from a frame moved by (k · 37 m, 0, −k · 11 m) and turned by k · 0.4 rad about y.
        const k = Math.floor(i / 30);
        const c = Math.cos(k * 0.4), sn = Math.sin(k * 0.4);
        for (let col = 0; col < 4; col++) {
          const x = shift[col * 3]!, y = shift[col * 3 + 1]!, z = shift[col * 3 + 2]!;
          const tx = col === 3 ? k * 37 : 0, tz = col === 3 ? -k * 11 : 0;
          r[col * 3] = c * x + sn * z + tx;
          r[col * 3 + 1] = y;
          r[col * 3 + 2] = -sn * x + c * z + tz;
        }
      }, LAG, (i, _, __, m) => void (apart = Math.max(apart, Math.abs(m - ref[i]!))), (i, m) => void pathAt(i, m));
      return { ok: apart < 1e-6 && Math.max(...ref) > 1 * DEG, detail: `10 jumps of the solve frame: angles differ from the steady run by at most ${apart.toExponential(1)} rad (largest swing ${f(Math.max(...ref) / DEG, 1)}°)` };
    },
  },
  {
    name: 'lag-sub-step-frames',
    run() {
      // Frames shorter than a step (1/120 s, one step every second frame): after every step the chain is where it is
      // with frames of 1/60 s (a run of 3 m/s for 2 s, then a stop), so no motion of the joint is lost; and with a limit
      // of 0 no frame, with a step or without, draws a link off its posed direction (frames of 1/144 s).
      const zAt = (t: number): number => 3 * Math.min(t, 2);
      const ref: number[] = [];
      lagRun(240, (i, r) => void yawRoot(0, 0, 0, zAt(i / 60), r), LAG, (_, __, ___, m) => void ref.push(m));
      let apart = 0;
      lagRun(480, (i, r) => {
        yawRoot(0, 0, 0, zAt(i / 120), r);
        return 1 / 120;
      }, LAG, (i, _, __, m) => {
        // Frame i is at i / 120 s; every second one ends on a step of the reference run and is compared with it.
        if (i % 2 === 0) apart = Math.max(apart, Math.abs(m - ref[i / 2]!));
      });
      let worst = 0;
      lagRun(600, (i, r) => {
        const t = i / 144;
        yawRoot(Math.sin(t * 3), Math.sin(t * 5) * 0.5, 0, 4 * t, r);
        return 1 / 144;
      }, { ...LAG, maxAngle: 0 }, (_, __, ___, m) => void (worst = Math.max(worst, m)));
      const ok = apart < 1e-9 && Math.max(...ref) > 1 * DEG && worst < 1e-6;
      return { ok, detail: `frames of 1/120 s against 1/60 s: angles after each step differ by ${apart.toExponential(1)} rad (swing ${f(Math.max(...ref) / DEG, 1)}°); limit 0 with frames of 1/144 s: largest drawn angle ${f(worst / DEG, 4)}°` };
    },
  },
];

// --- Run -------------------------------------------------------------------------------------------------------------

const PACKAGES: { label: string; scenarios: Scenario[] }[] = [
  { label: 'blend and masks', scenarios: BLEND },
  { label: 'automatic weights', scenarios: WEIGHTS },
  { label: 'transitions', scenarios: TRANSITIONS },
  { label: 'marks and events', scenarios: MARKS },
  { label: 'reach and ground', scenarios: REACH },
  { label: 'eased reach, aim, sockets', scenarios: POST },
  { label: 'state, determinism, many figures', scenarios: STATE },
  { label: 'layer stacks', scenarios: STACKS },
  { label: 'lagging chain', scenarios: LAGS },
];

const LIMIT_MS = 5000;
const filter = process.argv[2] ?? '';
const start = performance.now();
let failed = 0;
let run = 0;
for (const pkg of PACKAGES) {
  console.log(`# ${pkg.label}`);
  for (const sc of pkg.scenarios) {
    if (filter && !sc.name.includes(filter)) continue;
    run++;
    const t0 = performance.now();
    let r: Result;
    try {
      r = sc.run();
    } catch (e) {
      r = { ok: false, detail: `threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}` };
    }
    const ms = performance.now() - t0;
    const timing = sc.kind === 'timing';
    const word = r.ok ? 'ok  ' : timing ? 'slow' : 'FAIL';
    if (!r.ok && !timing) failed++;
    console.log(`${word} ${sc.name} (${ms.toFixed(0)} ms): ${r.detail}`);
  }
}
const total = performance.now() - start;
const late = total > LIMIT_MS;
console.log(`motion: ${run - failed} of ${run} scenarios ok, ${total.toFixed(0)} ms${late ? ` (over the limit of ${LIMIT_MS} ms)` : ''}`);
if (failed > 0 || late || run === 0) process.exit(1);
