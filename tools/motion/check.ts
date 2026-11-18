// Headless check of the engine's motion module (`wallhammer-web/motion`) and its post steps, in plain Node, without a
// browser or graphics. One line per scenario; exit code 1 when a check fails or the run takes over 5 s. Every
// skeleton here is a made-up chain of bones (no figure of any game): the module itself holds no motion.
//
//   node tools/motion/check.ts            all scenarios      (pnpm check:motion)
//   node tools/motion/check.ts marks      only scenarios whose name contains "marks"

import {
  MotionGraph,
  Pose,
  Skeleton,
  addPose,
  blendPose,
  boneMask,
  compileMotionGraph,
  fitToGround,
  reachTwoBone,
  setBoneAxisAngle,
  setBoneEuler,
  solvePose,
  speedWeights,
  subtractPose,
} from '../../packages/wallhammer-web/src/motion/index.ts';
import type { MotionGraphDesc, MotionSource, TwoBoneChain } from '../../packages/wallhammer-web/src/motion/index.ts';

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

// --- Run -------------------------------------------------------------------------------------------------------------

const PACKAGES: { label: string; scenarios: Scenario[] }[] = [
  { label: 'blend and masks', scenarios: BLEND },
  { label: 'automatic weights', scenarios: WEIGHTS },
  { label: 'transitions', scenarios: TRANSITIONS },
  { label: 'marks and events', scenarios: MARKS },
  { label: 'reach and ground', scenarios: REACH },
  { label: 'state, determinism, many figures', scenarios: STATE },
  { label: 'layer stacks', scenarios: STACKS },
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
