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
  SeatTransition,
  SocketSeat,
  StepCycle,
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
  headingRoot,
  reachTwoBone,
  setBoneAxisAngle,
  setBoneEuler,
  socketTransform,
  solvePose,
  speedWeights,
  subtractPose,
} from '../../packages/wallhammer-web/src/motion/index.ts';
import type { AimAngles, AimChain, BoneSpec, LagChain, MotionGraphDesc, MotionSource, SeatTransitionOptions, Socket, StepCycleDesc, StepPattern, TwoBoneChain } from '../../packages/wallhammer-web/src/motion/index.ts';

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

// --- A body carried by another, reaching at sockets, steps of several legs ------------------------------------------

/** Largest difference of two arrays of numbers. */
function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

function det34(m: ArrayLike<number>): number {
  return m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[3]! * (m[1]! * m[8]! - m[2]! * m[7]!) + m[6]! * (m[1]! * m[5]! - m[2]! * m[4]!);
}

/** A made-up carrier: chain3 solved on a tilted root, a socket on its tip turned by `yaw` and then by `tilt` about x. */
function carrier(yaw: number, tilt: number, mirrored = false): { world: Float64Array; socket: Socket } {
  const sk = chain3();
  const p = new Pose(sk);
  const world = new Float64Array(sk.count * 12);
  solvePose(sk, p, ID, world);
  // The tip's matrix is the identity at (0, 0, 0): the socket's local is its transform in the solve frame.
  const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  // Ry(yaw) · Rx(tilt), columns.
  const x = [cy, 0, -sy], y = [sy * st, ct, cy * st], z = [sy * ct, -st, cy * ct];
  const k = mirrored ? -1 : 1;
  const local = [k * x[0]!, k * x[1]!, k * x[2]!, ...y, ...z, 0.3, 0.2, -0.1];
  return { world, socket: { bone: 2, local } };
}

/** A made-up seat timeline for the scenarios. */
const SEAT_TIMELINE: SeatTransitionOptions = {
  attach: { seconds: 1.2, weightFrom: 0.1, weightSeconds: 0.8, rise: 0.6, riseTo: 0.5 },
  release: { seconds: 1, weightFrom: 0.2, weightSeconds: 0.6, rise: 0.6, riseFrom: 0.3, riseTo: 0.9 },
};

const SEAT: Scenario[] = [
  {
    name: 'seat-weights',
    run() {
      const { world, socket } = carrier(0.7, 0.4);
      const free = yawRoot(-0.3, 4, 0, 2);
      const at = socketTransform(world, socket, new Float64Array(12));
      const out = new Float64Array(12);
      const seat = new SocketSeat();
      seat.write(free, world, socket, out);
      const w0 = maxDiff(out, free);
      seat.fade.set(1);
      seat.write(free, world, socket, out);
      const w1 = maxDiff(out, at);
      seat.fade.set(0.5);
      seat.write(free, world, socket, out);
      const mid = maxDiff(out, blendTransform(free, at, 0.5, new Float64Array(12)));
      // Eased on over 0.5 s: no jump.
      seat.fade.set(0);
      seat.on(0.5);
      let prev = free.slice();
      let worst = 0;
      for (let i = 0; i < 40; i++) {
        seat.update(1 / 60);
        seat.write(free, world, socket, out);
        worst = Math.max(worst, Math.hypot(out[9]! - prev[9]!, out[10]! - prev[10]!, out[11]! - prev[11]!));
        prev = out.slice();
      }
      const gap = Math.hypot(at[9]! - free[9]!, at[10]! - free[10]!, at[11]! - free[11]!);
      const end = maxDiff(out, at);
      const ok = w0 === 0 && w1 === 0 && mid < 1e-12 && end === 0 && worst < 1.6 * gap / 30;
      return { ok, detail: `weight 0 off the free root by ${w0}, weight 1 off the socket by ${w1}, 0.5 off the blend by ${mid.toExponential(1)}; on over 0.5 s: ${f(gap, 2)} m, largest step ${f(worst, 3)} m a frame, ends on the socket (${end})` };
    },
  },
  {
    name: 'seat-tilt-share',
    run() {
      // A socket turned 0.7 rad about y and tilted 0.4 rad about its x: tilt 0 keeps the root upright with the
      // socket's place and heading, 0.5 takes half the tilt, 1 all of it.
      const { world, socket } = carrier(0.7, 0.4);
      const at = socketTransform(world, socket, new Float64Array(12));
      const free = yawRoot(0, 0, 0, 0);
      const out = new Float64Array(12);
      const seat = new SocketSeat({ tilt: 0 });
      seat.fade.set(1);
      const tiltOf = (m: ArrayLike<number>): number => Math.acos(Math.min(1, m[4]! / Math.hypot(m[3]!, m[4]!, m[5]!)));
      seat.write(free, world, socket, out);
      const t0 = tiltOf(out);
      const heading = Math.atan2(out[6]!, out[8]!);
      const place = Math.hypot(out[9]! - at[9]!, out[10]! - at[10]!, out[11]! - at[11]!);
      seat.tilt = 0.5;
      seat.write(free, world, socket, out);
      const tHalf = tiltOf(out);
      const headingHalf = Math.atan2(out[6]!, out[8]!);
      seat.tilt = 1;
      seat.write(free, world, socket, out);
      const tFull = tiltOf(out);
      const ok = t0 < 1e-12 && Math.abs(heading - 0.7) < 1e-12 && place < 1e-12 && Math.abs(tHalf - 0.2) < 1e-9 && Math.abs(headingHalf - 0.7) < 1e-9 && Math.abs(tFull - 0.4) < 1e-9;
      return { ok, detail: `tilt 0: ${f(t0 / DEG, 4)}° off up, heading ${f(heading, 4)} rad (0.7), place off ${place.toExponential(1)}; tilt 0.5: ${f(tHalf / DEG, 3)}° (11.459), heading ${f(headingHalf, 4)}; tilt 1: ${f(tFull / DEG, 3)}° (22.918)` };
    },
  },
  {
    name: 'seat-mirrored',
    run() {
      // A mirrored socket: the carried root stays mirrored at every weight and tilt share, upright at tilt 0.
      const { world, socket } = carrier(-1.1, 0.5, true);
      const free = new Float64Array([-1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 1]);
      const out = new Float64Array(12);
      const seat = new SocketSeat({ tilt: 0 });
      let worstDet = 0;
      let upright = 0;
      for (let i = 0; i <= 10; i++) {
        seat.fade.set(i / 10);
        for (const tilt of [0, 0.3, 1]) {
          seat.tilt = tilt;
          seat.write(free, world, socket, out);
          worstDet = Math.max(worstDet, Math.abs(det34(out) + 1));
          if (i === 10 && tilt === 0) upright = Math.hypot(out[3]!, out[4]! - 1, out[5]!);
        }
      }
      seat.tilt = 0;
      seat.write(free, world, socket, out);
      const heading = Math.atan2(out[6]!, out[8]!);
      const ok = worstDet < 1e-9 && upright < 1e-12 && Math.abs(heading + 1.1) < 1e-12;
      return { ok, detail: `determinant −1 within ${worstDet.toExponential(1)} at all weights and shares; tilt 0: second axis off up by ${upright.toExponential(1)}, heading ${f(heading, 4)} rad (−1.1)` };
    },
  },
  {
    name: 'reach-socket',
    run() {
      // An arm of one body reaches a socket of another and takes its turn; without the end rotation only the point.
      const { world: cw, socket } = carrier(0.5, 0.3);
      const sock = { bone: socket.bone, local: [...socket.local.slice(0, 9), 0.25, 0.45, 0.35] };
      const at = socketTransform(cw, sock, new Float64Array(12));
      const sk = chain3();
      const p = new Pose(sk);
      const w = new Float64Array(sk.count * 12);
      const root = yawRoot(0, 0, 0, 0);
      const r = new TwoBoneReach({ upper: 0, lower: 1, end: 2 }, { soft: 1 });
      r.fade.set(1);
      solvePose(sk, p, root, w);
      const before = w.slice(24, 33);
      r.setTargetSocket(cw, sock);
      const leftPoint = r.apply(sk, p, root, w);
      const plain = maxDiff(r.target, [at[9]!, at[10]!, at[11]!]);
      p.reset();
      solvePose(sk, p, root, w);
      r.useEndRotation = true;
      r.setTargetSocket(cw, sock);
      const left = r.apply(sk, p, root, w);
      const turn = maxDiff(w.subarray(24, 33), at.subarray(0, 9));
      const ok = leftPoint < 1e-6 && plain === 0 && left < 1e-6 && turn < 1e-6 && maxDiff(before, at.subarray(0, 9)) > 0.1;
      return { ok, detail: `point reached (${leftPoint.toExponential(1)}), target is the socket's point; with the end rotation reached (${left.toExponential(1)}) and the end's axes off the socket's by ${turn.toExponential(1)}` };
    },
  },
  {
    name: 'seat-transition-phases-and-cues',
    run() {
      // Approach 0.5 s, on 1.2 s (weight 0.1–0.9 s, rise 0.6 by 0.5 s), off 1 s (weight 0.2–0.8 s). Stepped at 60 and
      // at 144 per second: phases change at the same times within a step, every cue fires once, the approach walks
      // its whole length.
      const run = (hz: number) => {
        const tr = new SeatTransition(SEAT_TIMELINE);
        const dt = 1 / hz;
        tr.attach(1, 0, 2, 0, 0.5);
        let fired = 0, walked = 0, heldAt = -1, freeAt = -1, t = 0, rAt05 = -1;
        const first = tr.phase;
        for (let i = 0; i < hz * 2; i++) {
          tr.advance(dt);
          t += dt;
          if (tr.crossed(0.5)) fired++;
          if (tr.crossed(1.0)) fired++;
          walked += tr.approachMoved(3);
          if (tr.became('held')) heldAt = t;
          if (rAt05 < 0 && tr.elapsed >= 1.0) rAt05 = tr.rise();
        }
        const held = tr.phase, w1 = tr.weight();
        const released = tr.release();
        let offFired = 0;
        t = 0;
        for (let i = 0; i < hz * 2; i++) {
          tr.advance(dt);
          t += dt;
          if (tr.gettingOff && tr.crossed(0)) offFired++;
          if (tr.became('free')) freeAt = t;
        }
        return { first, fired, walked, heldAt, held, w1, released, offFired, freeAt, end: tr.phase, w0: tr.weight(), rAt05 };
      };
      const a = run(60), b = run(144);
      const ok = [a, b].every((r) => r.first === 'approach' && r.fired === 2 && Math.abs(r.walked - 3) < 1e-9 && Math.abs(r.heldAt - 1.7) < 1 / 60 + 1e-9 && r.held === 'held' && r.w1 === 1 && r.released && r.offFired === 1 && Math.abs(r.freeAt - 1) < 1 / 60 + 1e-9 && r.end === 'free' && r.w0 === 0 && r.rAt05 > 0.59);
      return {
        ok,
        detail: `60/s: held at ${f(a.heldAt, 3)} s, free after ${f(a.freeAt, 3)} s, walked ${f(a.walked, 6)} m, cues ${a.fired}+${a.offFired}; 144/s: held at ${f(b.heldAt, 3)} s, free after ${f(b.freeAt, 3)} s, cues ${b.fired}+${b.offFired}`,
      };
    },
  },
  {
    name: 'seat-transition-place-and-root',
    run() {
      // The free place walks from where getting on began to the stand place, then rises toward the seat; on the seat
      // the root is the socket's; getting off the place starts raised and comes down to the stand place.
      const tr = new SeatTransition(SEAT_TIMELINE);
      const stand = [3, 0.2, 2, Math.PI / 2];
      const out = new Float64Array(4);
      tr.attach(0, 0, 0, -Math.PI / 2, 0.5);
      tr.place(stand, 1.5, out);
      const start = Math.hypot(out[0]!, out[1]!, out[2]!);
      // A step past the approach: at the stand place, just starting to rise.
      for (let i = 0; i < 31; i++) tr.advance(1 / 60);
      tr.place(stand, 1.5, out);
      const atStand = Math.hypot(out[0]! - 3, out[2]! - 2) < 1e-12 && out[1]! >= 0.2 && out[1]! < 0.21 && Math.abs(Math.cos(out[3]!)) < 1e-12 && Math.abs(Math.sin(out[3]!) - 1) < 1e-12;
      for (let i = 0; i < 89; i++) tr.advance(1 / 60);
      tr.place(stand, 1.5, out);
      const risen = out[1]! - 0.2;
      // The carrier: one bone 1 m up, turned a quarter about +y; its socket 0.5 m along its x.
      const carrier = new Float64Array([0, 0, -1, 0, 1, 0, 1, 0, 0, 4, 1, 2]);
      const socket: Socket = { bone: 0, local: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0, 0]) };
      const free = headingRoot(out[0]!, out[1]!, out[2]!, out[3]!, 1, new Float64Array(12));
      const root = tr.write(free, carrier, socket, new Float64Array(12));
      const onSocket = Math.hypot(root[9]! - 4, root[10]! - 1, root[11]! - 1.5) < 1e-12;
      tr.release();
      tr.place(stand, 1.5, out);
      const raisedAtRelease = Math.abs(out[1]! - (0.2 + 1.3 * 0.6)) < 1e-12;
      for (let i = 0; i < 70; i++) tr.advance(1 / 60);
      tr.place(stand, 1.5, out);
      const down = Math.abs(out[1]! - 0.2) < 1e-12;
      const ok = start < 1e-12 && atStand && Math.abs(risen - 1.3 * 0.6) < 1e-12 && onSocket && raisedAtRelease && down && tr.phase === 'free';
      return { ok, detail: `start ${f(start, 6)} m from where it began, at the stand place after the approach ${atStand}, risen ${f(risen, 3)} m (0.78), on the socket ${onSocket}, raised at the release ${raisedAtRelease}, down at the end ${down}` };
    },
  },
  {
    name: 'seat-transition-state',
    run() {
      // Saved in the middle of getting on and restored into a new timeline: both go on bit for bit.
      const a = new SeatTransition(SEAT_TIMELINE);
      a.attach(1, 2, 3, 0.5, 0.4);
      for (let i = 0; i < 37; i++) a.advance(1 / 60);
      const b = new SeatTransition(SEAT_TIMELINE);
      b.restore(a.save());
      const out: number[] = [];
      for (let i = 0; i < 200; i++) {
        a.advance(1 / 60);
        b.advance(1 / 60);
        if (i === 120) (a.release(), b.release());
        out.push(a.weight(0.3) - b.weight(0.3), a.rise() - b.rise(), a.progress(0.7) - b.progress(0.7), a.elapsed - b.elapsed);
      }
      const same = out.every((v) => v === 0) && a.phase === b.phase;
      let refused = false;
      try {
        b.restore(new Uint8Array(88));
      } catch {
        refused = true;
      }
      return { ok: same && refused, detail: `restored timeline equal for 200 steps ${same}, a state of zeros refused ${refused}` };
    },
  },
];

// Steps of several legs: a made-up body of four two-bone legs, hips 0.9 m up, legs 1.1 m long.
const STEP_HOMES: [number, number, number][] = [
  [-0.3, 0, 0.6],
  [0.3, 0, 0.6],
  [-0.3, 0, -0.6],
  [0.3, 0, -0.6],
];
const STEP_PATTERNS: StepPattern[] = [
  { speed: 0.8, stride: 0.9, offsets: [0.25, 0.75, 0, 0.5], duty: 0.75, lift: 0.08 },
  { speed: 2.5, stride: 1.6, offsets: [0, 0.5, 0.5, 0], duty: 0.5, lift: 0.12 },
  { speed: 6, stride: 2.8, offsets: [0.5, 0.6, 0, 0.1], duty: 0.35, lift: 0.15 },
];
/**
 * Bounds of the step checks. At 60 Hz a target moves at most a swing's top speed in a frame: the fastest pattern's
 * end crosses about its stride (2.8 m) in its swing (0.65 of a pass at 2.1 passes a second, 0.3 s), 1.5 times as fast
 * at the middle of the eased swing: 0.23 m a frame. Its step changes from one frame to the next by at most the swing's
 * acceleration (about 0.05 m) and, at a lift, the body's speed for a frame (0.1 m at 6 m/s: a lifted end starts out
 * carried with the body). Between frame rates a step lands within 2 cm when the cycle never has to hasten, within
 * 0.3 m (a drift of its phase) when it does.
 */
const STEP_BOUND = 0.25;
const STEP_BEND = 0.16;
const STEP_RATE_FREE = 0.02;
const STEP_RATE_HELD = 0.3;
const STEP_DESC: StepCycleDesc = { homes: STEP_HOMES, patterns: STEP_PATTERNS, reach: 0.5 };
const bumps = (x: number, z: number): number => 0.05 * Math.sin(0.7 * x) * Math.cos(0.5 * z);

function stepBody(): Skeleton {
  const bones: BoneSpec[] = [{ name: 'body', parent: -1, joint: [0, 0.9, 0] }];
  STEP_HOMES.forEach((h, i) => {
    bones.push({ name: `u${i}`, parent: 0, joint: [h[0], 0, h[2]] });
    bones.push({ name: `l${i}`, parent: 1 + i * 3, joint: [0, -0.55, 0] });
    bones.push({ name: `e${i}`, parent: 2 + i * 3, joint: [0, -0.55, 0] });
  });
  return new Skeleton(bones);
}

/** A body's path sampled at 1440 Hz: speed and turn rate from `profile(t)`, integrated in small fixed steps. */
interface StepPath {
  yaw: Float64Array;
  x: Float64Array;
  z: Float64Array;
  v: Float64Array;
  turn: Float64Array;
}
const PATH_HZ = 1440;
function stepPath(seconds: number, profile: (t: number) => [number, number]): StepPath {
  const n = Math.round(seconds * PATH_HZ) + 1;
  const p: StepPath = { yaw: new Float64Array(n), x: new Float64Array(n), z: new Float64Array(n), v: new Float64Array(n), turn: new Float64Array(n) };
  const h = 1 / PATH_HZ;
  for (let i = 0; i < n; i++) {
    const [v, turn] = profile(i * h);
    p.v[i] = v;
    p.turn[i] = turn;
    if (i > 0) {
      p.yaw[i] = p.yaw[i - 1]! + turn * h;
      p.x[i] = p.x[i - 1]! + Math.sin(p.yaw[i]!) * v * h;
      p.z[i] = p.z[i - 1]! + Math.cos(p.yaw[i]!) * v * h;
    }
  }
  return p;
}

/** Runs a `StepCycle` along `path` at `hz` frames a second; `each(frame, cycle, root, time)` after every update. */
function stepRun(path: StepPath, hz: number, each?: (i: number, c: StepCycle, root: Float64Array, t: number) => void, cycle = new StepCycle(STEP_DESC), from = 0): StepCycle {
  const every = PATH_HZ / hz;
  const root = new Float64Array(12);
  const frames = Math.floor((path.x.length - 1) / every);
  for (let i = from; i <= frames; i++) {
    const k = i * every;
    yawRoot(path.yaw[k]!, path.x[k]!, 0, path.z[k]!, root);
    const v = path.v[k]!, yaw = path.yaw[k]!;
    if (i === 0) cycle.reset(root, bumps);
    else cycle.update(1 / hz, root, Math.sin(yaw) * v, Math.cos(yaw) * v, path.turn[k]!, bumps);
    each?.(i, cycle, root, i / hz);
  }
  return cycle;
}

/** 0 → 6 m/s over 6 s, held 2 s, back to 0 over 6 s, 2 s standing; a slow weave of the heading throughout. */
const RAMP = stepPath(16, (t) => [t < 6 ? t : t < 8 ? 6 : t < 14 ? 6 - (t - 8) : 0, t < 14 ? 0.3 * Math.sin(t * 0.8) : 0]);

/** Horizontal distance of a leg's end from its home under `root`. */
function fromHome(c: StepCycle, i: number, root: ArrayLike<number>, p: ArrayLike<number> = c.targets): number {
  const hx = root[0]! * STEP_HOMES[i]![0] + root[6]! * STEP_HOMES[i]![2] + root[9]!;
  const hz = root[2]! * STEP_HOMES[i]![0] + root[8]! * STEP_HOMES[i]![2] + root[11]!;
  return Math.hypot(p[i * 3]! - hx, p[i * 3 + 2]! - hz);
}

function stepFingerprint(c: StepCycle, h: number): number {
  const u = new Uint32Array(c.data.buffer, c.data.byteOffset, c.data.length * 2);
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i]!, 16777619) >>> 0;
  return h;
}

const STEPS: Scenario[] = [
  {
    name: 'steps-planted-hold',
    run() {
      // While an end is planted its target does not change by a bit, through the speed-up, the weave and the stop.
      let moved = 0;
      let frames = 0;
      const prev = new Float64Array(12);
      const wasPlanted = new Float64Array(4);
      stepRun(RAMP, 60, (i, c) => {
        for (let l = 0; l < 4; l++) {
          if (i > 0 && wasPlanted[l] === 1 && c.planted[l] === 1 && c.landed[l] === 0) {
            frames++;
            for (let k = 0; k < 3; k++) if (c.targets[l * 3 + k] !== prev[l * 3 + k]) moved++;
          }
          wasPlanted[l] = c.planted[l]!;
        }
        prev.set(c.targets);
      });
      return { ok: moved === 0 && frames > 1000, detail: `${frames} leg-frames planted, ${moved} coordinates changed while planted` };
    },
  },
  {
    name: 'steps-no-slide',
    run() {
      // At each pattern's own speed (straight, 5 s): a planted end stays within half the stance's travel (duty · stride
      // / 2) and the tolerance of its home, so a leg never has to stretch far behind or ahead.
      const parts: string[] = [];
      let ok = true;
      for (const p of STEP_PATTERNS) {
        const path = stepPath(5, () => [p.speed, 0]);
        let most = 0;
        stepRun(path, 60, (i, c, root) => {
          if (i < 60) return;
          for (let l = 0; l < 4; l++) if (c.planted[l] === 1) most = Math.max(most, fromHome(c, l, root));
        });
        const bound = (p.duty as number) * p.stride / 2 + 0.04 + p.speed / 60;
        if (!(most <= bound)) ok = false;
        parts.push(`${p.speed} m/s: ${f(most, 3)} m (bound ${f(bound, 3)})`);
      }
      return { ok, detail: `farthest planted end from its home: ${parts.join(', ')}` };
    },
  },
  {
    name: 'steps-offsets',
    run() {
      // At each pattern's speed every end is put down when the phase reaches its offset (within one frame's advance).
      const parts: string[] = [];
      let ok = true;
      for (const p of STEP_PATTERNS) {
        const path = stepPath(5, () => [p.speed, 0]);
        let worst = 0;
        let downs = 0;
        stepRun(path, 60, (i, c) => {
          if (i < 60) return;
          for (let l = 0; l < 4; l++) {
            if (c.landed[l] !== 1) continue;
            downs++;
            const lag = c.phase - p.offsets[l]! - Math.floor(c.phase - p.offsets[l]!);
            worst = Math.max(worst, lag / (c.rate / 60));
          }
        });
        if (!(worst <= 1 + 1e-9) || downs < 8) ok = false;
        parts.push(`${p.speed} m/s: ${downs} downs, latest ${f(worst, 3)} of a frame's advance after the offset`);
      }
      return { ok, detail: parts.join('; ') };
    },
  },
  {
    name: 'steps-blend-continuous',
    run() {
      // 0 → 6 m/s and back at 60 Hz through all three patterns: no target jumps. A step of a target in a frame is at
      // most a swing's top speed (1.5 × its travel over its time) and its change from the frame before stays small.
      let worstStep = 0;
      let worstBend = 0;
      const p1 = new Float64Array(12), p2 = new Float64Array(12);
      stepRun(RAMP, 60, (i, c) => {
        for (let k = 0; k < 4; k++) {
          const o = k * 3;
          if (i >= 1) worstStep = Math.max(worstStep, Math.hypot(c.targets[o]! - p1[o]!, c.targets[o + 1]! - p1[o + 1]!, c.targets[o + 2]! - p1[o + 2]!));
          if (i >= 2) worstBend = Math.max(worstBend, Math.hypot(c.targets[o]! - 2 * p1[o]! + p2[o]!, c.targets[o + 1]! - 2 * p1[o + 1]! + p2[o + 1]!, c.targets[o + 2]! - 2 * p1[o + 2]! + p2[o + 2]!));
        }
        p2.set(p1);
        p1.set(c.targets);
      });
      const ok = worstStep < STEP_BOUND && worstBend < STEP_BEND;
      return { ok, detail: `largest step of a target ${f(worstStep, 3)} m a frame (bound ${STEP_BOUND}), largest change of a step ${f(worstBend, 3)} m (bound ${STEP_BEND})` };
    },
  },
  {
    name: 'steps-turn-on-spot',
    run() {
      // Turning on the spot at 1.2 rad/s for 4 s, then still for 3 s: never fewer than three ends down, every end
      // planted within `reach` (0.5 m, and one frame's turn) of its home, and afterwards all down within the tolerance of home and the cycle stopped.
      const path = stepPath(7, (t) => [0, t < 4 ? 1.2 : 0]);
      let fewest = 4;
      let farthest = 0;
      let downs = 0;
      const c = stepRun(path, 60, (i, c, root) => {
        let n = 0;
        for (let l = 0; l < 4; l++) {
          n += c.planted[l]!;
          if (c.planted[l] === 1) farthest = Math.max(farthest, fromHome(c, l, root));
          downs += c.landed[l]!;
        }
        fewest = Math.min(fewest, n);
      });
      const root = yawRoot(path.yaw[path.yaw.length - 1]!, 0, 0, 0);
      let home = 0;
      for (let l = 0; l < 4; l++) home = Math.max(home, fromHome(c, l, root));
      const all = c.planted.every((v) => v === 1);
      const ok = fewest >= 3 && farthest <= 0.5 + 1.2 * 0.7 / 60 && all && home <= 0.04 && c.rate === 0 && downs > 8;
      return { ok, detail: `${downs} steps, never fewer than ${fewest} ends down, farthest planted end from home ${f(farthest, 3)} m; after: all down ${all}, within ${f(home, 4)} m of home, rate ${c.rate}` };
    },
  },
  {
    name: 'steps-stop-mid-stride',
    run() {
      // 3 m/s for 2.1 s (a gait with a flight), then a dead stop and 3 s standing: the ends in the air land, and the
      // others shuffle home one at a time: no end is lifted while that would leave fewer than three down.
      const path = stepPath(5.1, (t) => [t < 2.1 ? 3 : 0, 0]);
      let fewest = 4;
      let inAir = 0;
      let lifts = 0;
      const was = new Float64Array(4);
      const c = stepRun(path, 60, (i, c) => {
        const down = c.planted.reduce((a, b) => a + b, 0);
        if (i === 126) inAir = 4 - down;
        if (i >= 126) {
          for (let l = 0; l < 4; l++) {
            if (was[l] === 1 && c.planted[l] === 0) {
              lifts++;
              fewest = Math.min(fewest, down);
            }
          }
        }
        was.set(c.planted);
      });
      const root = yawRoot(0, path.x[path.x.length - 1]!, 0, path.z[path.z.length - 1]!);
      let home = 0;
      for (let l = 0; l < 4; l++) home = Math.max(home, fromHome(c, l, root));
      const ok = fewest >= 3 && lifts > 0 && c.planted.every((v) => v === 1) && home <= 0.04 && c.rate === 0;
      return { ok, detail: `${inAir} ends in the air at the stop; ${lifts} lifts after it, each leaving at least ${fewest} down; 3 s later all down within ${f(home, 4)} m of home, rate ${c.rate}` };
    },
  },
  {
    name: 'steps-frame-rate',
    run() {
      // The ramp at 30, 60 and 144 Hz: every step at 30 and 60 Hz is put down near a step of the same leg at 144 Hz
      // (none missed or added: a missing step would leave one a stride from any other), and the counts agree within
      // one. Twice: with a `reach` the legs never need (only the pass's advance differs: a few centimetres) and with the
      // body's 0.5 m (the cycle hastens now and then, and its phase drifts by a little between frame rates).
      const at = (hz: number, desc: StepCycleDesc): number[][] => {
        const out: number[][] = [[], [], [], []];
        stepRun(RAMP, hz, (_, c) => {
          for (let l = 0; l < 4; l++) if (c.landed[l] === 1) out[l]!.push(c.points[l * 3]!, c.points[l * 3 + 2]!);
        }, new StepCycle(desc));
        return out;
      };
      const compare = (desc: StepCycleDesc): [number, number, string] => {
        const ref = at(144, desc);
        let worst = 0;
        let apart = 0;
        let counts = `144 Hz ${ref.map((g) => g.length / 2).join('/')}`;
        for (const hz of [30, 60]) {
          const got = at(hz, desc);
          for (let l = 0; l < 4; l++) {
            apart = Math.max(apart, Math.abs(got[l]!.length - ref[l]!.length) / 2);
            for (const [a, b] of [[got[l]!, ref[l]!], [ref[l]!, got[l]!]] as const) {
              for (let k = 0; k < a.length; k += 2) {
                let near = Infinity;
                for (let j = 0; j < b.length; j += 2) near = Math.min(near, Math.hypot(a[k]! - b[j]!, a[k + 1]! - b[j + 1]!));
                worst = Math.max(worst, near);
              }
            }
          }
          counts += `, ${hz} Hz ${got.map((g) => g.length / 2).join('/')}`;
        }
        return [worst, apart, counts];
      };
      const [free, freeApart, freeCounts] = compare({ ...STEP_DESC, reach: 2 });
      const [held, heldApart, heldCounts] = compare(STEP_DESC);
      const ok = free < STEP_RATE_FREE && held < STEP_RATE_HELD && freeApart <= 1 && heldApart <= 1;
      return { ok, detail: `reach 2 m: steps ${freeCounts}, each within ${f(free, 4)} m of one at 144 Hz (bound ${STEP_RATE_FREE}); reach 0.5 m: steps ${heldCounts}, within ${f(held, 4)} m (bound ${STEP_RATE_HELD})` };
    },
  },
  {
    name: 'steps-determinism',
    run() {
      const run = (): number => {
        let h = 2166136261;
        stepRun(RAMP, 60, (_, c) => void (h = stepFingerprint(c, h)));
        return h;
      };
      const a = run(), b = run();
      return { ok: a === b, detail: `${RAMP.x.length / 24 | 0} frames of the ramp twice: ${a.toString(16)} / ${b.toString(16)}` };
    },
  },
  {
    name: 'steps-save-restore',
    run() {
      // Saved part-way through the ramp, restored into a new cycle: the rest of the run is the same to the bit.
      let saved: Uint8Array | null = null;
      let tailA = 2166136261;
      stepRun(RAMP, 60, (i, c) => {
        if (i === 300) saved = c.save();
        if (i > 300) tailA = stepFingerprint(c, tailA);
      });
      const other = new StepCycle(STEP_DESC);
      other.restore(saved!);
      let tailB = 2166136261;
      stepRun(RAMP, 60, (i, c) => {
        if (i > 300) tailB = stepFingerprint(c, tailB);
      }, other, 301);
      return { ok: tailA === tailB, detail: `${other.byteLength} bytes; the rest after a restore ${tailA.toString(16)} / ${tailB.toString(16)}` };
    },
  },
  {
    name: 'steps-support-plane',
    run() {
      // Standing on a plane rising 0.2 along the world's z and 0.1 along x, turned 0.6 rad: the plane under the ends
      // gives the ground's height under the root and its rise along the root's forward (+z) and side (+x).
      const plane = (x: number, z: number): number => 0.3 + 0.1 * x + 0.2 * z;
      const yaw = 0.6;
      const root = yawRoot(yaw, 1, 0, 2);
      const c = new StepCycle(STEP_DESC);
      c.reset(root, plane);
      // Along the root's z (sin, 0, cos) the rise is 0.1 sin + 0.2 cos; along its x (cos, 0, −sin) 0.1 cos − 0.2 sin.
      const pitch = Math.atan(0.1 * Math.sin(yaw) + 0.2 * Math.cos(yaw));
      const roll = Math.atan(0.1 * Math.cos(yaw) - 0.2 * Math.sin(yaw));
      const err = Math.max(Math.abs(c.supportHeight - plane(1, 2)), Math.abs(c.pitch - pitch), Math.abs(c.roll - roll));
      return { ok: err < 1e-12, detail: `height ${f(c.supportHeight, 4)} (${f(plane(1, 2), 4)}), pitch ${f(c.pitch, 4)} (${f(pitch, 4)}), roll ${f(c.roll, 4)} (${f(roll, 4)}) rad` };
    },
  },
  {
    name: 'steps-rebase',
    run() {
      // Half way through the ramp the solve frame is moved and turned (a new chart): carried by `rebase`, the cycle
      // goes on exactly as in the old frame, its targets the old ones moved by the same transform.
      const a = 0.7, c0 = Math.cos(a), s0 = Math.sin(a);
      const m = [c0, 0, -s0, 0, 1, 0, s0, 0, c0, -30, 0.5, 12];
      const move = (p: ArrayLike<number>, o: number): number[] => [m[0]! * p[o]! + m[6]! * p[o + 2]! + m[9]!, p[o + 1]! + m[10]!, m[2]! * p[o]! + m[8]! * p[o + 2]! + m[11]!];
      const ref: number[][] = [];
      stepRun(RAMP, 60, (i, c) => {
        if (i >= 400) ref.push(Array.from(c.targets));
      });
      // The same run, the frame changed at frame 400: roots and ground given in the new frame from then on.
      const cyc = new StepCycle(STEP_DESC);
      const root = new Float64Array(12);
      const moved = new Float64Array(12);
      const ground = (x: number, z: number): number => {
        // Back to the old frame for the ground: the inverse of m.
        const dx = x - m[9]!, dz = z - m[11]!;
        return bumps(c0 * dx - s0 * dz, s0 * dx + c0 * dz) + m[10]!;
      };
      let worst = 0;
      const every = PATH_HZ / 60;
      for (let i = 0; i <= 960; i++) {
        const k = i * every;
        yawRoot(RAMP.yaw[k]!, RAMP.x[k]!, 0, RAMP.z[k]!, root);
        let vx = Math.sin(RAMP.yaw[k]!) * RAMP.v[k]!, vz = Math.cos(RAMP.yaw[k]!) * RAMP.v[k]!;
        let r: Float64Array = root;
        let h = bumps;
        if (i >= 400) {
          if (i === 400) cyc.rebase(m);
          const p = move(root, 9);
          yawRoot(RAMP.yaw[k]! + a, p[0]!, p[1]!, p[2]!, moved);
          [vx, vz] = [c0 * vx + s0 * vz, -s0 * vx + c0 * vz];
          r = moved;
          h = ground;
        }
        if (i === 0) cyc.reset(r, h);
        else cyc.update(1 / 60, r, vx, vz, RAMP.turn[k]!, h);
        if (i >= 400) {
          const want = ref[i - 400]!;
          for (let l = 0; l < 4; l++) {
            const w = move(want, l * 3);
            worst = Math.max(worst, Math.hypot(cyc.targets[l * 3]! - w[0]!, cyc.targets[l * 3 + 1]! - w[1]!, cyc.targets[l * 3 + 2]! - w[2]!));
          }
        }
      }
      return { ok: worst < 1e-6, detail: `targets after the change of frame off the moved ones by at most ${worst.toExponential(1)} m over 560 frames` };
    },
  },
  {
    name: 'steps-four-legs-reach',
    run() {
      // A made-up body with four two-bone legs, each reaching its target over the bumpy ground along the ramp.
      const sk = stepBody();
      const pose = new Pose(sk);
      const world = new Float64Array(sk.count * 12);
      const reaches = STEP_HOMES.map((_, i) => new TwoBoneReach({ upper: 1 + i * 3, lower: 2 + i * 3, end: 3 + i * 3 }, { soft: 1 }));
      for (const r of reaches) r.fade.set(1);
      let planted = 0;
      let swing = 0;
      stepRun(RAMP, 60, (_, c, root) => {
        pose.reset();
        for (let i = 0; i < 4; i++) setBoneAxisAngle(pose, 2 + i * 3, 1, 0, 0, -0.3);
        solvePose(sk, pose, root, world);
        for (let i = 0; i < 4; i++) {
          const r = reaches[i]!;
          r.setTarget(c.targets[i * 3]!, c.targets[i * 3 + 1]!, c.targets[i * 3 + 2]!);
          const left = r.apply(sk, pose, root, world);
          if (c.planted[i] === 1) planted = Math.max(planted, left);
          else swing = Math.max(swing, left);
        }
      });
      const ok = planted < 1e-4 && swing < 1e-3;
      return { ok, detail: `distance left: planted ends ${planted.toExponential(1)} m, swinging ends ${swing.toExponential(1)} m` };
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
  { label: 'a body carried by another', scenarios: SEAT },
  { label: 'steps of several legs', scenarios: STEPS },
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
