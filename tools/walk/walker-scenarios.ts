// Scenarios of the walker (engine `world/walker.ts`) over the collision world: sliding along a wall, resting in a
// corner, steps and stairs, slopes, jumps and ceilings, no steering or turning in the air, falling off an edge, a thin
// wall at speed, determinism, a solid that appears over the body, and the CPU time of one step (spec M2, 3.3 and 3.4).
// Then the saved state (`saveState`, `loadState`, `simState`): a save loaded into a second walker saves the same bytes,
// a restored walker steps on and draws exactly like the original, offsets and refused buffers, and the walker as a
// part of a `Simulation` snapshot. Last the momentum options (`deceleration`, `runAcceleration`, `turnSpeedAtRun`):
// the stop distance from a run, the run-up, the radius of a running turn, the same options through a `ChartWalker`,
// the default setup stepping exactly as with the options spelled out, the fixed-step stop distance and the rate of
// change in the air. Last the slope effect on the speed (`uphillSpeedLoss`, `downhillSpeedGain`, `downhillSpeedLoss`,
// `slopeSpeedFloor`): off by default (the same speed on a ramp as on the flat, the same bits as with the options spelled
// out at 0), slower uphill and on steep descents and a little faster on gentle ones, never below the floor, unscaled
// in the air, a steady speed on stairs that matches a base ramp of the same mean slope, and the same bits twice and
// across a saved state.

import { ByteReader, ByteWriter } from '../../packages/wallhammer-web/src/sim/bytes.ts';
import { Simulation } from '../../packages/wallhammer-web/src/sim/simulation.ts';
import { CollisionWorld, newRayHit } from '../../packages/wallhammer-web/src/world/collide.ts';
import { ChartWalker } from '../../packages/wallhammer-web/src/world/chart-walker.ts';
import { DEFAULT_WALKER, WALKER_STATE_BYTES, Walker, newWalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
import type { WalkIntent, WalkerSetup } from '../../packages/wallhammer-web/src/world/walker.ts';
import { MOVE_PROFILES } from '../../examples/shared/src/figures/profiles.ts';
import { scattered } from './collide-scenarios.ts';
import { f, meanMs, seeded, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

const flat = (): CollisionWorld => new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0 });

function walker(w: CollisionWorld, x: number, y: number, z: number, setup?: Partial<WalkerSetup>): Walker {
  const k = new Walker(w, setup);
  k.teleport(x, y, z);
  return k;
}

function intent(moveX: number, moveZ: number, run = false, jump = false): WalkIntent {
  const i = newWalkIntent();
  i.moveX = moveX;
  i.moveZ = moveZ;
  i.run = run;
  i.jump = jump;
  return i;
}

/** Fixed steps for `seconds` with one intent; `each` sees the walker after every step. */
function walk(k: Walker, it: WalkIntent, seconds: number, each?: (k: Walker, step: number) => void): void {
  const n = Math.round(seconds * k.setup.stepHz);
  for (let s = 0; s < n; s++) {
    k.step(it);
    each?.(k, s);
  }
}

const wall30: Scenario = {
  name: 'walker-wall-30deg',
  run() {
    const w = flat();
    w.addBox(0, 0.1, 50, 0.1, 0, 0, 3); // wall face at z = 0
    const k = walker(w, 0, 0, -1);
    let minGap = Infinity;
    walk(k, intent(Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), true), 4, (k) => {
      minGap = Math.min(minGap, -k.position[2]!);
    });
    const r = k.setup.radius;
    // Along the wall the body keeps the run speed's share along it, cos 30°.
    const vx = k.velocity[0]!;
    const want = k.setup.runSpeed * Math.cos(Math.PI / 6);
    return verdict(minGap >= r - 1e-6 && Math.abs(k.position[2]! + r) < 1e-4 && Math.abs(vx - want) < 0.05 && k.position[0]! > 10,
      `x ${f(k.position[0]!)}, speed along the wall ${f(vx)} (want ${f(want)}), min gap ${f(minGap, 6)} (radius ${r})`);
  },
};

const corner: Scenario = {
  name: 'walker-corner-rests',
  run() {
    const w = flat();
    w.addPrism([-5, 0, 0.2, 0, 0.2, 0.2, -5, 0.2], 0, 3);
    w.addPrism([0, -5, 0.2, -5, 0.2, 0.2, 0, 0.2], 0, 3);
    const k = walker(w, -2, 0, -2);
    const it = intent(0.8, 0.6, true);
    walk(k, it, 3);
    const x0 = k.position[0]!;
    const z0 = k.position[2]!;
    let drift = 0;
    walk(k, it, 1, (k) => {
      drift = Math.max(drift, Math.abs(k.position[0]! - x0), Math.abs(k.position[2]! - z0));
    });
    const r = k.setup.radius;
    return verdict(drift <= 0.001 && Math.abs(x0 + r) < 1e-3 && Math.abs(z0 + r) < 1e-3,
      `rest (${f(x0, 4)}, ${f(z0, 4)}), drift over 1 s ${f(drift * 1000, 4)} mm`);
  },
};

const steps: Scenario = {
  name: 'walker-steps',
  run() {
    const one = (h: number): [number, number] => {
      const w = flat();
      w.addPrism([2, -5, 12, -5, 12, 5, 2, 5], 0, h);
      const k = walker(w, 0, 0, 0);
      walk(k, intent(1, 0), 4);
      return [k.position[0]!, k.position[1]!];
    };
    const [x30, y30] = one(0.3);
    const [x50, y50] = one(0.5);
    // Eight steps of 0.2 m with treads of 0.3 m, then a landing.
    const w = flat();
    for (let i = 0; i < 8; i++) {
      const x = 2 + i * 0.3;
      w.addPrism([x, -2, i === 7 ? 12 : x + 0.3, -2, i === 7 ? 12 : x + 0.3, 2, x, 2], 0, 0.2 * (i + 1));
    }
    const k = walker(w, 0, 0, 0);
    let stalled = 0;
    let lastX = 0;
    walk(k, intent(1, 0), 6, (k) => {
      if (k.position[0]! < 7 && k.position[0]! - lastX < 1e-4) stalled++;
      lastX = k.position[0]!;
    });
    const ok = Math.abs(y30 - 0.3) < 1e-9 && x30 > 4 && y50 === 0 && x50 <= 2 - 0.3 + 1e-6 && Math.abs(k.position[1]! - 1.6) < 1e-9 && k.position[0]! > 5 && stalled === 0;
    return verdict(ok,
      `0.30 m: up at y ${f(y30)} x ${f(x30)}; 0.50 m: stopped at x ${f(x50)} y ${f(y50)}; stairs 8 × 0.2 m: y ${f(k.position[1]!)} x ${f(k.position[0]!)}, stalled steps ${stalled}`);
  },
};

const slopes: Scenario = {
  name: 'walker-slopes',
  run() {
    const ramp = (deg: number): CollisionWorld => {
      const t = Math.tan((deg * Math.PI) / 180);
      const top = 3;
      return new CollisionWorld({ heightAt: (x) => (x <= 0 ? 0 : Math.min(x * t, top)), baseMinY: 0, baseMaxY: top });
    };
    // 30° goes up to the top.
    const w30 = ramp(30);
    const a = walker(w30, -1, 0, 0);
    let under30 = 0;
    walk(a, intent(1, 0), 6, (k) => {
      under30 = Math.max(under30, w30.baseHeightAt(k.position[0]!, k.position[2]!) - k.position[1]!);
    });
    // 55° stops at the foot.
    const w55 = ramp(55);
    const b = walker(w55, -1, 0, 0);
    let maxY55 = 0;
    walk(b, intent(1, 0, true), 5, (k) => {
      maxY55 = Math.max(maxY55, k.position[1]!);
    });
    // Put on the 55° slope, the body slides back down to its foot.
    const c = walker(w55, 1, Math.tan((55 * Math.PI) / 180), 0);
    let wasSteep = false;
    walk(c, intent(0, 0), 3, (k) => {
      wasSteep ||= k.steep;
    });
    const ok = Math.abs(a.position[1]! - 3) < 1e-9 && a.grounded && under30 <= 1e-9 && maxY55 < 0.1 && c.position[1]! < 0.05 && c.position[0]! < 0.05 && wasSteep && c.grounded;
    return verdict(ok,
      `30°: top y ${f(a.position[1]!)} (lowest under base ${f(under30, 6)}); 55°: highest y ${f(maxY55)}; slid from (1, 1.43) to x ${f(c.position[0]!)} y ${f(c.position[1]!)}`);
  },
};

const jump: Scenario = {
  name: 'walker-jump-ceiling',
  run() {
    const open = flat();
    const k = walker(open, 0, 0, 0);
    walk(k, intent(0, 0), 0.2);
    let top = 0;
    k.step(intent(0, 0, false, true));
    walk(k, intent(0, 0), 2, (k) => {
      top = Math.max(top, k.position[1]!);
    });
    const s = k.setup;
    const want = (s.jumpSpeed * s.jumpSpeed) / (2 * s.gravity);
    const err = Math.abs(top - want) / want;
    // Under a slab whose underside is at 2.2 m the head stops there.
    const roofed = flat();
    roofed.addBox(0, 0, 3, 3, 0, 2.2, 3);
    const c = walker(roofed, 0, 0, 0);
    walk(c, intent(0, 0), 0.2);
    let topC = 0;
    c.step(intent(0, 0, false, true));
    walk(c, intent(0, 0), 2, (k) => {
      topC = Math.max(topC, k.position[1]!);
    });
    const ok = err <= 0.03 && k.grounded && k.position[1]! === 0 && Math.abs(topC + s.height - 2.2) < 1e-9 && c.grounded && c.position[1]! === 0;
    return verdict(ok,
      `top ${f(top, 4)} m, want ${f(want, 4)} (error ${f(err * 100, 2)} %, allowed 3 %); under the 2.2 m underside the head reached ${f(topC + s.height, 4)} m`);
  },
};

/**
 * Runs toward −z, jumps, then holds `air` (a world direction, running) until landing. Returns the largest change of the
 * horizontal velocity and of the heading against the step of take-off, seen after any step in the air or the landing.
 */
function airborne(air: [number, number], setup?: Partial<WalkerSetup>): { dv: number; dyaw: number; seconds: number; v0: number } {
  const k = walker(flat(), 0, 0, 0, setup);
  walk(k, intent(0, -1, true), 1.5);
  k.step(intent(0, -1, true, true));
  const vx = k.velocity[0]!;
  const vz = k.velocity[2]!;
  const yaw = k.yaw;
  const it = intent(air[0], air[1], true);
  let dv = 0;
  let dyaw = 0;
  let n = 0;
  while (!k.grounded && n < 600) {
    k.step(it);
    n++;
    dv = Math.max(dv, Math.hypot(k.velocity[0]! - vx, k.velocity[2]! - vz));
    let d = Math.abs(k.yaw - yaw);
    if (d > Math.PI) d = 2 * Math.PI - d;
    dyaw = Math.max(dyaw, d);
  }
  return { dv, dyaw, seconds: n / k.setup.stepHz, v0: Math.hypot(vx, vz) };
}

const airMomentum: Scenario = {
  name: 'walker-air-keeps-momentum-and-heading',
  run() {
    // Default setup: input held in the air (a 90° turn, the opposite way, 45°, nothing) changes neither the velocity of
    // take-off nor the heading, bit for bit.
    const dirs: [number, number][] = [[1, 0], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2], [0, 0]];
    let worstV = 0;
    let worstYaw = 0;
    let seconds = 0;
    for (const d of dirs) {
      const r = airborne(d);
      worstV = Math.max(worstV, r.dv);
      worstYaw = Math.max(worstYaw, r.dyaw);
      seconds = r.seconds;
    }
    // An explicit share of control and turn rate stay within what they allow: airControl × acceleration × air time and
    // airTurnSpeed × air time.
    const air = 0.1;
    const turn = 2;
    const r = airborne([1, 0], { airControl: air, airTurnSpeed: turn });
    const s = new Walker(flat()).setup;
    const vBound = air * s.acceleration * r.seconds + 1e-9;
    const yawBound = turn * r.seconds + 1e-9;
    const ok = worstV === 0 && worstYaw === 0 && seconds > 0.8 && r.dv > 0 && r.dv <= vBound && r.dyaw > 0 && r.dyaw <= yawBound;
    return verdict(ok,
      `defaults (airControl ${s.airControl}, airTurnSpeed ${s.airTurnSpeed}): over ${f(seconds, 3)} s in the air with 4 inputs, velocity change ${f(worstV, 6)} m/s, heading change ${f(worstYaw, 6)} rad; ` +
      `airControl ${air}, airTurnSpeed ${turn}: ${f(r.dv)} m/s (at most ${f(vBound)}), ${f(r.dyaw)} rad (at most ${f(yawBound)})`);
  },
};

const standingJump: Scenario = {
  name: 'walker-standing-jump-lands-in-place',
  run() {
    // A jump from standing with a direction held in the air (walking or running, four ways) comes down where it left.
    let worst = 0;
    let worstYaw = 0;
    let landed = 0;
    for (const [mx, mz, run] of [[1, 0, true], [0, 1, false], [-1, 0, true], [0.6, -0.8, false]] as const) {
      const k = walker(flat(), 3, 0, -2);
      walk(k, intent(0, 0), 0.2);
      const x0 = k.position[0]!;
      const z0 = k.position[2]!;
      const yaw0 = k.yaw;
      k.step(intent(0, 0, false, true));
      const it = intent(mx, mz, run);
      let n = 0;
      while (!k.grounded && n < 600) {
        k.step(it);
        n++;
      }
      if (k.grounded && n > 40) landed++;
      worst = Math.max(worst, Math.hypot(k.position[0]! - x0, k.position[2]! - z0));
      worstYaw = Math.max(worstYaw, Math.abs(k.yaw - yaw0));
    }
    return verdict(landed === 4 && worst === 0 && worstYaw === 0,
      `${landed} of 4 jumps landed; farthest from the take-off spot ${f(worst, 9)} m, heading change ${f(worstYaw, 6)} rad`);
  },
};

const fall: Scenario = {
  name: 'walker-fall-land',
  run() {
    const w = flat();
    w.addPrism([-5, -5, 0, -5, 0, 5, -5, 5], 0, 2); // platform 2 m high, edge at x = 0
    const k = walker(w, -1, 2, 0);
    walk(k, intent(0, 0), 0.1);
    let left = false;
    let lowest = Infinity;
    let landed = -1;
    walk(k, intent(1, 0), 3, (k, s) => {
      if (!k.grounded) left = true;
      lowest = Math.min(lowest, k.position[1]!);
      if (left && landed < 0 && k.grounded) landed = s;
    });
    const ok = left && landed >= 0 && k.grounded && k.position[1]! === 0 && lowest >= 0 && k.position[0]! > 1;
    return verdict(ok, `left the edge, landed after step ${landed}, end y ${f(k.position[1]!)} x ${f(k.position[0]!)}, lowest y ${f(lowest, 6)}`);
  },
};

const thinWall: Scenario = {
  name: 'walker-thin-wall-10mps',
  run() {
    const parts: string[] = [];
    let ok = true;
    for (const dt of [1 / 10, 1 / 30, 1 / 120]) {
      const w = flat();
      w.addPrism([2, -5, 2.1, -5, 2.1, 5, 2, 5], 0, 3);
      const k = walker(w, 0, 0, 0, { runSpeed: 10, acceleration: 1000 });
      const it = intent(1, 0, true);
      let maxX = -Infinity;
      for (let t = 0; t < 1; t += dt) {
        k.advance(dt, it);
        maxX = Math.max(maxX, k.position[0]!);
      }
      const passed = maxX > 2 - k.setup.radius + 1e-6;
      if (passed) ok = false;
      parts.push(`dt 1/${Math.round(1 / dt)}: max x ${f(maxX, 4)}`);
    }
    return verdict(ok, `${parts.join(', ')} (wall face at 2, radius 0.3)`);
  },
};

/** A course with solids on a rolling surface and a script of intents from a seed. */
function course(): CollisionWorld {
  return scattered(300, 120, 11);
}

const determinism: Scenario = {
  name: 'walker-same-inputs-same-bits',
  run() {
    const N = 1200;
    const trace = (): Float64Array => {
      const w = course();
      const k = walker(w, 60, 10, 60);
      const rnd = seeded(7);
      const dts = seeded(8);
      const it = newWalkIntent();
      const out = new Float64Array(N * 4);
      for (let i = 0; i < N; i++) {
        if (i % 40 === 0) {
          const a = rnd() * Math.PI * 2;
          it.moveX = Math.cos(a);
          it.moveZ = Math.sin(a);
          it.run = rnd() < 0.5;
        }
        it.jump = i % 97 === 0;
        k.advance(0.004 + dts() * 0.03, it);
        out[i * 4] = k.position[0]!;
        out[i * 4 + 1] = k.position[1]!;
        out[i * 4 + 2] = k.position[2]!;
        out[i * 4 + 3] = k.yaw;
      }
      return out;
    };
    const a = trace();
    const b = trace();
    let same = 0;
    for (let i = 0; i < a.length; i++) if (Object.is(a[i], b[i])) same++;
    // advance(1/30) once against advance(1/60) twice, over 4 s of a changing script.
    const w = course();
    const p = walker(w, 40, 10, 40);
    const q = walker(w, 40, 10, 40);
    const rnd = seeded(3);
    const it = newWalkIntent();
    let apart = 0;
    for (let i = 0; i < 120; i++) {
      if (i % 15 === 0) {
        const ang = rnd() * Math.PI * 2;
        it.moveX = Math.cos(ang);
        it.moveZ = Math.sin(ang);
        it.run = rnd() < 0.5;
      }
      it.jump = i % 31 === 0;
      p.advance(1 / 30, it);
      q.advance(1 / 60, it);
      q.advance(1 / 60, it);
      for (let c = 0; c < 3; c++) if (!Object.is(p.position[c], q.position[c])) apart++;
    }
    const moved = Math.hypot(a[(N - 1) * 4]! - 60, a[(N - 1) * 4 + 2]! - 60);
    return verdict(same === a.length && apart === 0 && p.steps === 240 && q.steps === 240,
      `two runs: ${same} of ${a.length} numbers equal (moved ${f(moved, 1)} m); 1/30 against 2 × 1/60: ${apart} differing coordinates over 120 frames, ${p.steps} and ${q.steps} steps`);
  },
};

const appear: Scenario = {
  name: 'walker-solid-appears',
  run() {
    const w = flat();
    const k = walker(w, 0, 0, 0);
    walk(k, intent(0, 0), 0.1);
    const id = w.addBox(0.1, 0, 0.5, 0.5, 0, 0, 2);
    walk(k, intent(0, 0), 0.1);
    const x = k.position[0]!;
    const z = k.position[2]!;
    // Distance from the box (x 0.6 / −0.4, z ±0.5) to the centre.
    const dx = Math.max(-0.4 - x, 0, x - 0.6);
    const dz = Math.max(-0.5 - z, 0, z - 0.5);
    const gap = Math.hypot(dx, dz);
    const outside = gap >= k.setup.radius - 1e-5;
    // Blocked while the box stands, through once it is removed.
    const b = walker(w, -2, 0, 0);
    walk(b, intent(1, 0), 3);
    const blocked = b.position[0]!;
    w.remove(id);
    const c = walker(w, -2, 0, 0);
    walk(c, intent(1, 0), 3);
    return verdict(outside && blocked < -0.4 - 0.3 + 1e-6 && c.position[0]! > 2,
      `pushed out to (${f(x, 4)}, ${f(z, 4)}), gap ${f(gap, 4)}; walking +x blocked at ${f(blocked)}, after remove reached ${f(c.position[0]!)}`);
  },
};

const timing: Scenario = {
  name: 'walker-cpu-time',
  kind: 'timing',
  run() {
    const size = 300;
    const w = scattered(2000, size, 3);
    const k = walker(w, 150, 10, 150);
    const rnd = seeded(21);
    const N = 10000;
    const mx = new Float64Array(N);
    const mz = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = Math.floor(i / 120) * 2.399963;
      mx[i] = Math.cos(a);
      mz[i] = Math.sin(a);
    }
    const it = intent(0, 0, true);
    const step = meanMs(N, (i) => {
      it.moveX = mx[i]!;
      it.moveZ = mz[i]!;
      it.jump = i % 180 === 0;
      k.step(it);
      // Keep the body on the course.
      const p = k.position;
      if (p[0]! < 20 || p[0]! > size - 20 || p[2]! < 20 || p[2]! > size - 20) k.teleport(20 + rnd() * (size - 40), 10, 20 + rnd() * (size - 40));
    });
    // A raycast in the same world, from eye height in random directions, 30 m.
    const hit = newRayHit();
    const ox = new Float64Array(N);
    const oy = new Float64Array(N);
    const oz = new Float64Array(N);
    const dx = new Float64Array(N);
    const dy = new Float64Array(N);
    const dz = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      ox[i] = 20 + rnd() * (size - 40);
      oz[i] = 20 + rnd() * (size - 40);
      oy[i] = w.groundAt(ox[i]!, oz[i]!, 0, 0) + 1.7;
      const a = rnd() * Math.PI * 2;
      dx[i] = Math.cos(a);
      dz[i] = Math.sin(a);
      dy[i] = -0.2 + rnd() * 0.3;
    }
    const ray = meanMs(N, (i) => {
      w.raycast(ox[i]!, oy[i]!, oz[i]!, dx[i]!, dy[i]!, dz[i]!, 30, hit);
    });
    return verdict(step <= 0.02 && ray <= 0.01,
      `2000 solids, mean of ${N}: walker step ${f(step * 1000, 2)} µs (target 20 µs), raycast (30 m) ${f(ray * 1000, 2)} µs (target 10 µs)`);
  },
};

// --- Saved state -------------------------------------------------------------------------------------------------------

/** Names of the 20 doubles of a saved state, for reporting which one differs (layout of `Walker.saveState`). */
const STATE_SLOTS = ['version', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'flags', 'travelled', 'steps', 'prevX', 'prevY', 'prevZ',
  'prevYaw', 'acc', 'stepOffset', 'prevStepOffset', 'prevTravelled', 'grade'];
const PENDING_JUMP = 4;

/** Double `slot` of a saved state at `offset`. */
function stateSlot(bytes: Uint8Array, slot: number, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, WALKER_STATE_BYTES).getFloat64(slot * 8, true);
}

/** Empty when `a` and `b` (two saved states) are equal byte for byte, else the differing slots with both values. */
function stateDiff(a: Uint8Array, b: Uint8Array): string {
  if (a.length !== b.length) return `length ${a.length} against ${b.length}`;
  const out: string[] = [];
  for (let s = 0; s < WALKER_STATE_BYTES / 8; s++) {
    for (let i = s * 8; i < s * 8 + 8; i++) {
      if (a[i] !== b[i]) {
        out.push(`${STATE_SLOTS[s]} ${stateSlot(a, s)} against ${stateSlot(b, s)}`);
        break;
      }
    }
  }
  return out.join(', ');
}

/** A walled room with a two-level platform (0.3 m steps) and a turned pillar. */
function stateRoom(): CollisionWorld {
  const w = flat();
  w.addBox(7, -0.1, 7.2, 0.1, 0, 0, 3);
  w.addBox(7, 14.1, 7.2, 0.1, 0, 0, 3);
  w.addBox(-0.1, 7, 0.1, 7.2, 0, 0, 3);
  w.addBox(14.1, 7, 0.1, 7.2, 0, 0, 3);
  w.addPrism([4, 4, 9, 4, 9, 9, 4, 9], 0, 0.3);
  w.addPrism([5.5, 5.5, 7.5, 5.5, 7.5, 7.5, 5.5, 7.5], 0, 0.6);
  w.addBox(11, 3, 0.5, 0.5, 0.6, 0, 3);
  return w;
}

/** A fixed script of frames: frame times and intents (direction, run and jump changing), the same on every call. */
interface StateScript {
  dt: Float64Array;
  intents: WalkIntent[];
}

function stateScript(frames: number): StateScript {
  const rnd = seeded(31);
  const dt = new Float64Array(frames);
  const intents: WalkIntent[] = [];
  let mx = 1;
  let mz = 0.4;
  let run = false;
  for (let i = 0; i < frames; i++) {
    if (i < 160) {
      // First straight up the two platform steps from the start corner, walking.
      mx = 0.7071;
      mz = 0.7071;
      run = false;
    } else if (i % 40 === 0) {
      const a = rnd() * Math.PI * 2;
      mx = Math.cos(a);
      mz = Math.sin(a);
      run = rnd() < 0.6;
    }
    dt[i] = 0.004 + rnd() * 0.03;
    // After the climb every 70th frame asks for a jump; every second one comes on a frame too short for a step, so it
    // stays pending.
    const jump = i >= 160 && i % 70 === 0;
    if (jump && i % 140 === 0) dt[i] = 0.001;
    intents.push(intent(mx, mz, run, jump));
  }
  return { dt, intents };
}

const STATE_FRAMES = 720;
const STATE_SETUP: Partial<WalkerSetup> = { turnSpeed: 6 };

function stateWalker(w: CollisionWorld): Walker {
  return walker(w, 2, 0, 2, STATE_SETUP);
}

/** Frames `from` to `to` (exclusive) of the script; `each` sees the walker after every frame. */
function play(k: Walker, s: StateScript, from: number, to: number, each?: (k: Walker, frame: number) => void): void {
  for (let i = from; i < to; i++) {
    k.advance(s.dt[i]!, s.intents[i]!);
    each?.(k, i);
  }
}

const stateRoundTrip: Scenario = {
  name: 'walker-state-round-trip',
  run() {
    const w = stateRoom();
    const script = stateScript(STATE_FRAMES);
    const a = stateWalker(w);
    const b = stateWalker(w);
    let equal = 0;
    let firstDiff = '';
    let air = 0;
    let pending = 0;
    let easing = 0;
    let onPlatform = 0;
    play(a, script, 0, STATE_FRAMES, (k, i) => {
      const saved = k.saveState().slice();
      b.loadState(saved);
      const d = stateDiff(saved, b.saveState());
      if (d === '') equal++;
      else if (!firstDiff) firstDiff = `frame ${i}: ${d}`;
      const pend = (stateSlot(saved, 8) & PENDING_JUMP) !== 0;
      if (!k.grounded) air++;
      if (pend) pending++;
      if (stateSlot(saved, 16) !== 0) easing++;
      if (k.grounded && k.position[1]! > 0.25) onPlatform++;
    });
    const ok = equal === STATE_FRAMES && firstDiff === '' && air > 0 && pending > 0 && easing > 0 && onPlatform > 0;
    return verdict(ok,
      `${equal} of ${STATE_FRAMES} frames saved, loaded into a second walker and saved again equal byte for byte${firstDiff ? ` (first difference ${firstDiff})` : ''}; covered: in the air ${air}, jump pending ${pending}, step easing ${easing}, on the platform ${onPlatform} frames`);
  },
};

const stateContinues: Scenario = {
  name: 'walker-state-restored-continues',
  run() {
    const w = stateRoom();
    const script = stateScript(STATE_FRAMES);
    // Pick moments from one run: the first frame in the air, with a jump pending, with a step being eased, and a plain
    // one late in the run.
    const probe = stateWalker(w);
    let atAir = -1;
    let atPending = -1;
    let atEasing = -1;
    play(probe, script, 0, STATE_FRAMES - 200, (k, i) => {
      const s = k.saveState();
      if (atAir < 0 && i > 30 && !k.grounded) atAir = i;
      if (atPending < 0 && (stateSlot(s, 8) & PENDING_JUMP) !== 0) atPending = i;
      if (atEasing < 0 && stateSlot(s, 16) !== 0) atEasing = i;
    });
    const moments = [atAir, atPending, atEasing, STATE_FRAMES - 210];
    const span = 180; // about 3.4 s of frames
    const alpha = 0.37;
    const pa = new Float64Array(3);
    const pb = new Float64Array(3);
    let compared = 0;
    let bytesApart = 0;
    let drawApart = 0;
    let firstDiff = '';
    let seconds = 0;
    for (const m of moments) {
      if (m < 0) continue;
      const a = stateWalker(w);
      play(a, script, 0, m + 1);
      const b = stateWalker(w);
      b.loadState(a.saveState().slice());
      for (let i = m + 1; i < m + 1 + span; i++) {
        a.advance(script.dt[i]!, script.intents[i]!);
        b.advance(script.dt[i]!, script.intents[i]!);
        seconds += script.dt[i]!;
        compared++;
        const d = stateDiff(a.saveState().slice(), b.saveState());
        if (d !== '') {
          bytesApart++;
          if (!firstDiff) firstDiff = `from frame ${m}, frame ${i}: ${d}`;
        }
        // Drawn values at a fixed alpha and at the walker's own alpha (the saved leftover time).
        for (const al of [alpha, undefined]) {
          a.renderPosition(pa, al);
          b.renderPosition(pb, al);
          for (let c = 0; c < 3; c++) if (!Object.is(pa[c], pb[c])) drawApart++;
          if (!Object.is(a.renderYaw(al), b.renderYaw(al))) drawApart++;
          if (!Object.is(a.renderTravelled(al), b.renderTravelled(al))) drawApart++;
        }
      }
    }
    const found = moments.filter((m) => m >= 0).length;
    return verdict(found === moments.length && bytesApart === 0 && drawApart === 0,
      `${found} restore moments (in the air at frame ${atAir}, jump pending at ${atPending}, step easing at ${atEasing}, plain at ${moments[3]}), ${compared} frames (${f(seconds, 1)} s) stepped on: ${bytesApart} states apart, ${drawApart} drawn values apart (renderPosition, renderYaw, renderTravelled at alpha ${alpha} and own alpha)${firstDiff ? `; first difference ${firstDiff}` : ''}`);
  },
};

/** True when `fn` throws. */
function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const stateOffsets: Scenario = {
  name: 'walker-state-offsets-errors',
  run() {
    const w = stateRoom();
    const script = stateScript(200);
    const k = stateWalker(w);
    play(k, script, 0, 200);
    const plain = k.saveState().slice();
    const bad: string[] = [];
    // At an offset (not a multiple of 8): exactly the state's bytes change, the rest stays.
    const at = 13;
    const out = new Uint8Array(at + WALKER_STATE_BYTES + 37).fill(0xab);
    if (k.saveState(out, at) !== out) bad.push('saveState(out) did not return out');
    let touched = 0;
    for (let i = 0; i < out.length; i++) if ((i < at || i >= at + WALKER_STATE_BYTES) && out[i] !== 0xab) touched++;
    if (touched) bad.push(`${touched} bytes outside the state changed`);
    const inside = stateDiff(out.slice(at, at + WALKER_STATE_BYTES), plain);
    if (inside) bad.push(`state at offset differs: ${inside}`);
    const b = stateWalker(w);
    b.loadState(out, at);
    const back = stateDiff(b.saveState().slice(), plain);
    if (back) bad.push(`loaded from offset differs: ${back}`);
    // Exact fit works, one byte short throws, on both sides.
    if (throws(() => k.saveState(new Uint8Array(200), 40))) bad.push('saveState into an exact fit threw');
    if (!throws(() => k.saveState(new Uint8Array(WALKER_STATE_BYTES - 1)))) bad.push('saveState into 159 bytes did not throw');
    if (!throws(() => k.saveState(new Uint8Array(200), 41))) bad.push('saveState at offset 41 of 200 did not throw');
    if (!throws(() => b.loadState(new Uint8Array(WALKER_STATE_BYTES - 1)))) bad.push('loadState of 159 bytes did not throw');
    if (!throws(() => b.loadState(out, out.length - WALKER_STATE_BYTES + 1))) bad.push('loadState past the end did not throw');
    // A wrong version throws, and a refused load leaves the walker as it was.
    const wrong = plain.slice();
    new DataView(wrong.buffer).setFloat64(0, 2, true);
    if (!throws(() => b.loadState(wrong))) bad.push('loadState of version 2 did not throw');
    if (!throws(() => b.loadState(new Uint8Array(WALKER_STATE_BYTES)))) bad.push('loadState of zeros did not throw');
    const after = stateDiff(b.saveState().slice(), plain);
    if (after) bad.push(`a refused load changed the walker: ${after}`);
    return verdict(bad.length === 0,
      bad.length ? bad.join('; ') : `offset ${at}: ${WALKER_STATE_BYTES} bytes written, ${out.length - WALKER_STATE_BYTES} around untouched, loaded back equal; short buffers, version 2 and zeros refused, the walker kept after a refused load`);
  },
};

const stateSim: Scenario = {
  name: 'walker-state-in-simulation',
  run() {
    const w = stateRoom();
    const script = stateScript(400);
    // One fixed step per tick, the intent of the tick's frame of the script.
    const build = (): [Simulation, Walker] => {
      const k = stateWalker(w);
      const sim = new Simulation({ seed: 'walker-state', hz: k.setup.stepHz });
      sim.addState(k.simState('walker'));
      sim.addSystem('walk', (s) => k.step(script.intents[s.tick]!));
      return [sim, k];
    };
    const [sim, k] = build();
    sim.step(150);
    const snap = sim.snapshot();
    const hashes: string[] = [];
    const states: Uint8Array[] = [];
    for (let i = 0; i < 200; i++) {
      sim.step();
      hashes.push(sim.stateHash());
      states.push(k.saveState().slice());
    }
    // Back in the same simulation, and in a second one with its own walker.
    sim.restore(snap);
    const [sim2, k2] = build();
    sim2.restore(snap);
    let apart = 0;
    let firstDiff = '';
    for (let i = 0; i < 200; i++) {
      sim.step();
      sim2.step();
      const d = stateDiff(k.saveState().slice(), states[i]!) || stateDiff(k2.saveState().slice(), states[i]!);
      if (d || sim.stateHash() !== hashes[i] || sim2.stateHash() !== hashes[i]) {
        apart++;
        if (!firstDiff) firstDiff = `tick ${151 + i}: ${d || 'hash'}`;
      }
    }
    // The part alone, through the byte streams.
    const bw = new ByteWriter();
    k.simState('a').save(bw);
    const part = bw.finish();
    const k3 = stateWalker(w);
    k3.simState('b').load(new ByteReader(part));
    const direct = stateDiff(k3.saveState().slice(), k.saveState());
    const ok = apart === 0 && part.length === WALKER_STATE_BYTES && direct === '';
    return verdict(ok,
      `snapshot at tick 150, 200 ticks on: ${apart} ticks apart after restore (same and second simulation)${firstDiff ? ` (first ${firstDiff})` : ''}; part alone ${part.length} bytes, loaded ${direct ? `differs: ${direct}` : 'equal'}`);
  },
};


// --- Momentum ----------------------------------------------------------------------------------------------------------

/** Runs +x to full speed, releases the input; metres from the release to a stop, seconds to stop, and the stopped walker. */
function stopFrom(setup: Partial<WalkerSetup>): { dist: number; secs: number; speed: number } {
  const k = walker(flat(), 0, 0, 0, setup);
  walk(k, intent(1, 0, true), 3);
  const speed = k.velocity[0]!;
  const x0 = k.position[0]!;
  let n = 0;
  const idle = intent(0, 0);
  while (Math.hypot(k.velocity[0]!, k.velocity[2]!) > 0 && n < 600) {
    k.step(idle);
    n++;
  }
  return { dist: k.position[0]! - x0, secs: n * k.stepSeconds, speed };
}

const stopDistance: Scenario = {
  name: 'walker-momentum-stop-distance',
  run() {
    const parts: string[] = [];
    let ok = true;
    for (const [label, setup, d] of [['default', {}, DEFAULT_WALKER.acceleration], ['deceleration 9', { deceleration: 9 }, 9], ['deceleration 5, acceleration 30', { deceleration: 5, acceleration: 30 }, 5]] as const) {
      const r = stopFrom(setup);
      // v² / (2d) in continuous time; a fixed step brakes before it moves, so up to one step's distance less.
      const want = (r.speed * r.speed) / (2 * d);
      const err = r.dist - want;
      ok &&= err > -r.speed / 60 - 0.01 && err < 0.01 && Math.abs(r.secs - r.speed / d) < 2 / 60;
      parts.push(`${label}: ${f(r.dist)} m in ${f(r.secs, 2)} s from ${f(r.speed, 2)} m/s (v²/2d ${f(want)} m)`);
    }
    return verdict(ok, parts.join('; '));
  },
};

const runUp: Scenario = {
  name: 'walker-momentum-run-up',
  run() {
    const time = (setup: Partial<WalkerSetup>, run: boolean): number => {
      const k = walker(flat(), 0, 0, 0, setup);
      const it = intent(1, 0, run);
      const top = run ? k.setup.runSpeed : k.setup.walkSpeed;
      let n = 0;
      while (k.velocity[0]! < top - 1e-9 && n < 600) {
        k.step(it);
        n++;
      }
      return n * k.stepSeconds;
    };
    const setup = { acceleration: 8, runAcceleration: 4 };
    const run = time(setup, true);
    const walkUp = time(setup, false);
    const dflt = time({}, true);
    const s = DEFAULT_WALKER;
    const ok = Math.abs(run - s.runSpeed / 4) < 2 / 60 && Math.abs(walkUp - s.walkSpeed / 8) < 2 / 60 && Math.abs(dflt - s.runSpeed / s.acceleration) < 2 / 60;
    return verdict(ok, `to the run speed with runAcceleration 4: ${f(run, 2)} s (want ${f(s.runSpeed / 4, 2)}); to the walk speed with acceleration 8: ${f(walkUp, 2)} s (want ${f(s.walkSpeed / 8, 2)}); default to the run speed ${f(dflt, 2)} s`);
  },
};

/** Runs +x at full speed, then asks for −x: the sideways offset of the path when it heads −x, and the heading's lead over the velocity. */
function reverse(setup: Partial<WalkerSetup>): { offset: number; minSpeed: number; lag: number } {
  const k = walker(flat(), 0, 0, 0, { ...setup });
  walk(k, intent(1, 0, true), 3);
  // A hair to the left, so the reversal turns one way.
  const it = intent(-1, 0.001, true);
  const z0 = k.position[2]!;
  let minSpeed = Infinity;
  let lag = 0;
  let n = 0;
  while (n < 600) {
    k.step(it);
    n++;
    const vx = k.velocity[0]!, vz = k.velocity[2]!;
    const sp = Math.hypot(vx, vz);
    minSpeed = Math.min(minSpeed, sp);
    if (sp > 0.5) {
      // The heading against the velocity's direction (yaw 0 faces −z).
      let d = Math.atan2(-vx, -vz) - k.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      lag = Math.max(lag, Math.abs(d));
    }
    if (vx < 0 && Math.abs(vz) < 1e-3 * sp) break;
  }
  return { offset: k.position[2]! - z0, minSpeed, lag };
}

const turnArc: Scenario = {
  name: 'walker-momentum-turn-radius',
  run() {
    const rate = 3;
    const arc = reverse({ turnSpeedAtRun: rate });
    const again = reverse({ turnSpeedAtRun: rate });
    const on = reverse({});
    const v = DEFAULT_WALKER.runSpeed;
    // Half a circle of radius v / rate: the path ends 2 v / rate to the side; the speed stays (the turn is within the acceleration).
    const want = (2 * v) / rate;
    const ok = Math.abs(Math.abs(arc.offset) - want) < 0.03 * want && arc.minSpeed > v - 0.05 && arc.lag < 0.15 && Object.is(arc.offset, again.offset) && Math.abs(on.offset) < 0.05 && on.minSpeed < 0.5;
    return verdict(ok, `turnSpeedAtRun ${rate}: a reversal at ${v} m/s swings ${f(Math.abs(arc.offset))} m to the side (2v/rate ${f(want)}), speed at least ${f(arc.minSpeed, 2)} m/s, heading within ${f(arc.lag / DEG_W, 1)}° of the velocity, the same bits twice ${Object.is(arc.offset, again.offset)}; default: ${f(on.offset)} m to the side, speed down to ${f(on.minSpeed, 2)} m/s (turns on the spot)`);
  },
};
const DEG_W = Math.PI / 180;

const momentumDefaults: Scenario = {
  name: 'walker-momentum-defaults-unchanged',
  run() {
    // The options spelled out at the values that mean "as before" step bit for bit like the default setup.
    const spelled: Partial<WalkerSetup> = { deceleration: DEFAULT_WALKER.acceleration, runAcceleration: DEFAULT_WALKER.acceleration, turnSpeedAtRun: 0 };
    const trace = (setup: Partial<WalkerSetup>): Uint8Array[] => {
      const k = walker(course(), 60, 10, 60, setup);
      const rnd = seeded(21);
      const it = newWalkIntent();
      const out: Uint8Array[] = [];
      for (let i = 0; i < 1500; i++) {
        if (i % 30 === 0) {
          const a = rnd() * Math.PI * 2;
          const stop = rnd() < 0.3;
          it.moveX = stop ? 0 : Math.cos(a);
          it.moveZ = stop ? 0 : Math.sin(a);
          it.run = rnd() < 0.5;
        }
        it.jump = i % 113 === 0;
        k.step(it);
        if (i % 5 === 0) out.push(k.saveState().slice());
      }
      return out;
    };
    const a = trace({});
    const b = trace(spelled);
    let apart = 0;
    for (let i = 0; i < a.length; i++) if (stateDiff(a[i]!, b[i]!)) apart++;
    const d = DEFAULT_WALKER;
    const zero = d.deceleration === 0 && d.runAcceleration === 0 && d.turnSpeedAtRun === 0;
    return verdict(apart === 0 && zero, `defaults deceleration ${d.deceleration}, runAcceleration ${d.runAcceleration}, turnSpeedAtRun ${d.turnSpeedAtRun}; 1500 steps against the options spelled out: ${apart} of ${a.length} saved states differ`);
  },
};

const chartMomentum: Scenario = {
  name: 'walker-momentum-chart-walker',
  run() {
    const R = 2000;
    const cw = new ChartWalker({ radiusM: R, radiusAt: () => R, walker: { deceleration: 6, turnSpeedAtRun: 2 } });
    const run = intent(0, -1, true);
    for (let i = 0; i < 180; i++) cw.step(run);
    const a: [number, number, number] = [0, 0, 0];
    cw.position(a);
    const speed = cw.walker.velocity[2]!;
    const idle = intent(0, 0);
    let n = 0;
    while (Math.hypot(cw.walker.velocity[0]!, cw.walker.velocity[2]!) > 0 && n < 600) {
      cw.step(idle);
      n++;
    }
    const b: [number, number, number] = [0, 0, 0];
    cw.position(b);
    // Along the sphere: the angle between the two feet times the radius.
    const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
    const dist = Math.acos(Math.min(1, dot)) * R;
    const want = (speed * speed) / 12;
    const s = cw.setup;
    const ok = Math.abs(speed) > 4 && dist - want > -Math.abs(speed) / 60 - 0.01 && dist - want < 0.01 && s.deceleration === 6 && s.turnSpeedAtRun === 2;
    return verdict(ok, `setup through ChartWalker: deceleration ${s.deceleration}, turnSpeedAtRun ${s.turnSpeedAtRun}; stopped ${f(dist)} m after the release from ${f(Math.abs(speed), 2)} m/s (v²/2d ${f(want)} m) in ${n} steps, ${cw.recharts} charts`);
  },
};

const retune: Scenario = {
  name: 'walker-momentum-retune',
  run() {
    // Retuned in the middle of a run, a walker steps on exactly like one built with the new numbers from that state.
    const t = { deceleration: 7, turnSpeedAtRun: 3, runSpeed: 5 };
    const a = walker(course(), 60, 10, 60);
    const it = intent(0.6, 0.8, true);
    walk(a, it, 2);
    const b = walker(course(), 0, 0, 0, t);
    b.loadState(a.saveState());
    a.retune(t);
    const turn = intent(-0.8, 0.6, true);
    let apart = 0;
    for (let i = 0; i < 240; i++) {
      const x = i < 120 ? turn : intent(0, 0);
      a.step(x);
      b.step(x);
      if (stateDiff(a.saveState().slice(), b.saveState().slice())) apart++;
    }
    // A chart walker keeps the new numbers over a rechart.
    const R = 300;
    const cw = new ChartWalker({ radiusM: R, radiusAt: () => R });
    cw.retune({ deceleration: 5, height: 3 } as Partial<WalkerSetup>);
    const run = intent(0, -1, true);
    for (let i = 0; i < 1200; i++) cw.step(run);
    const kept = cw.recharts > 1 && cw.setup.deceleration === 5 && cw.setup.height === DEFAULT_WALKER.height;
    return verdict(apart === 0 && kept, `retuned walker against a new one from the same state: ${apart} of 240 steps differ; chart walker after ${cw.recharts} charts: deceleration ${cw.setup.deceleration}, height ${cw.setup.height} (not a tuning field)`);
  },
};

const stopFixedStep: Scenario = {
  name: 'walker-momentum-stop-distance-fixed-step',
  run() {
    // The fixed-step stop distance is v²/2d − v·dt/2 (the continuous v²/2d less half a step's travel) when v / (d·dt)
    // is a whole number of steps: 4.5 m/s, deceleration 5 at 60 Hz stops in 54 steps.
    const d = 5;
    const r = stopFrom({ deceleration: d });
    const dt = 1 / 60;
    const continuous = (r.speed * r.speed) / (2 * d);
    const fixed = continuous - (r.speed * dt) / 2;
    return verdict(Math.abs(r.dist - fixed) < 1e-9 && r.speed === DEFAULT_WALKER.runSpeed, `from ${f(r.speed, 2)} m/s with deceleration ${d}: ${f(r.dist, 6)} m; v²/2d − v·dt/2 ${f(fixed, 6)} m (continuous v²/2d ${f(continuous, 4)} m)`);
  },
};

const airRate: Scenario = {
  name: 'walker-air-control-rate-is-acceleration',
  run() {
    // In the air the velocity changes at acceleration × airControl whatever the momentum options say: braking (no
    // input), speeding up while running and turning at the same speed. deceleration 40, runAcceleration 2,
    // acceleration 10, airControl 0.5: 5 m/s² in all three.
    const setup: Partial<WalkerSetup> = { acceleration: 10, deceleration: 40, runAcceleration: 2, airControl: 0.5, jumpSpeed: 6 };
    const want = 10 * 0.5;
    const rates: string[] = [];
    let ok = true;
    for (const [label, air, run] of [['brake', [0, 0], false], ['run-up', [-1, 0], true], ['turn', [0, -1], true]] as const) {
      // Walk −x at the walk speed (or run at the run speed for the turn), jump, then hold `air` for 10 steps in the air.
      const k = walker(flat(), 0, 0, 0, setup);
      const lead = label === 'turn' ? intent(-1, 0, true) : intent(-1, 0, false);
      walk(k, lead, 2);
      k.step(label === 'turn' ? intent(-1, 0, true, true) : intent(-1, 0, false, true));
      const it = intent(air[0], air[1], run);
      let most = 0;
      for (let s = 0; s < 10; s++) {
        const vx = k.velocity[0]!, vz = k.velocity[2]!;
        k.step(it);
        if (k.grounded) break;
        most = Math.max(most, Math.hypot(k.velocity[0]! - vx, k.velocity[2]! - vz) * k.setup.stepHz);
      }
      ok &&= Math.abs(most - want) < 1e-9;
      rates.push(`${label} ${f(most, 4)} m/s²`);
    }
    return verdict(ok, `${rates.join(', ')} (want ${want} each)`);
  },
};

// --- Slope effect on the speed -------------------------------------------------------------------------------------

/** A straight base ramp rising toward +x at `deg` from x = 0 onto a plateau `height` metres high (flat before it). */
function longRamp(deg: number, height: number): CollisionWorld {
  const t = Math.tan((deg * Math.PI) / 180);
  return new CollisionWorld({ heightAt: (x) => (x <= 0 ? 0 : Math.min(x * t, height)), baseMinY: 0, baseMaxY: height });
}

/** The slope options of the examples' figure (examples/shared profiles.ts, default). */
const { uphillSpeedLoss, downhillSpeedGain, downhillSpeedLoss, slopeSpeedFloor } = MOVE_PROFILES.default.walker;
const SLOPE: Partial<WalkerSetup> = { uphillSpeedLoss, downhillSpeedGain, downhillSpeedLoss, slopeSpeedFloor };

/** Slope factor of `SLOPE` at grade `g` (+ uphill). */
function slopeFactor(g: number, s: Partial<WalkerSetup> = SLOPE): number {
  const k = g > 0 ? 1 - s.uphillSpeedLoss! * g : 1 - g * (s.downhillSpeedGain! + s.downhillSpeedLoss! * g);
  return Math.max(k, s.slopeSpeedFloor!);
}

/**
 * Mean horizontal speed of a walker along ±x on `w` between `a` and `b` (in the direction of travel), from `x0` with a
 * run-up; also the lowest and highest speed there.
 */
function speedOver(w: CollisionWorld, setup: Partial<WalkerSetup>, run: boolean, x0: number, a: number, b: number): { mean: number; lo: number; hi: number } {
  const dir = b > a ? 1 : -1;
  const k = walker(w, x0, w.groundAt(x0, 0, 1e4, 0), 0, setup);
  const it = intent(dir, 0, run);
  let sum = 0, n = 0, lo = Infinity, hi = 0;
  for (let i = 0; i < 60 * 40; i++) {
    k.step(it);
    const x = k.position[0]!;
    if ((x - a) * dir > 0 && (b - x) * dir > 0 && k.grounded) {
      const v = k.lastStepDistance / k.stepSeconds;
      sum += v;
      n++;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if ((x - b) * dir > 0) break;
  }
  return { mean: n > 0 ? sum / n : 0, lo, hi };
}

const slopeDefaults: Scenario = {
  name: 'walker-slope-defaults-unchanged',
  run() {
    // Default setup: up and down a 20° ramp exactly at the walk and run speeds (horizontal), as on the flat.
    const w = longRamp(20, 4);
    const d = DEFAULT_WALKER;
    let worst = 0;
    for (const run of [false, true]) {
      const want = run ? d.runSpeed : d.walkSpeed;
      for (const r of [speedOver(w, {}, run, -6, 2, 9), speedOver(w, {}, run, 17, 9, 2)]) worst = Math.max(worst, Math.abs(r.lo - want), Math.abs(r.hi - want));
    }
    // The options spelled out at 0 (with another floor) step bit for bit like the default setup, the grade slot 0.
    const trace = (setup: Partial<WalkerSetup>): Uint8Array[] => {
      const k = walker(course(), 60, 10, 60, setup);
      const rnd = seeded(23);
      const it = newWalkIntent();
      const out: Uint8Array[] = [];
      for (let i = 0; i < 900; i++) {
        if (i % 30 === 0) {
          const a = rnd() * Math.PI * 2;
          it.moveX = Math.cos(a);
          it.moveZ = Math.sin(a);
          it.run = rnd() < 0.5;
        }
        it.jump = i % 113 === 0;
        k.step(it);
        if (i % 5 === 0) out.push(k.saveState().slice());
      }
      return out;
    };
    const a = trace({});
    const b = trace({ uphillSpeedLoss: 0, downhillSpeedGain: 0, downhillSpeedLoss: 0, slopeSpeedFloor: 0.9 });
    let apart = 0, graded = 0;
    for (let i = 0; i < a.length; i++) {
      if (stateDiff(a[i]!, b[i]!)) apart++;
      if (stateSlot(a[i]!, 19) !== 0) graded++;
    }
    const zero = d.uphillSpeedLoss === 0 && d.downhillSpeedGain === 0 && d.downhillSpeedLoss === 0;
    return verdict(worst < 1e-12 && apart === 0 && graded === 0 && zero,
      `defaults: largest speed difference from the flat on a 20° ramp ${f(worst, 9)} m/s; 900 steps against the options spelled out at 0: ${apart} of ${a.length} saved states differ, ${graded} with a grade`);
  },
};

const slopeUpDown: Scenario = {
  name: 'walker-slope-up-and-down',
  run() {
    const t = (deg: number): number => Math.tan((deg * Math.PI) / 180);
    const ws = DEFAULT_WALKER.walkSpeed;
    const parts: string[] = [];
    let ok = true;
    // Up and down ramps of 8°, 20° and 35°: the steady speed is the walk speed times the factor at the ramp's grade.
    for (const [deg, height] of [[8, 2], [20, 4], [35, 6]] as const) {
      const w = longRamp(deg, height);
      const top = height / t(deg);
      const up = speedOver(w, SLOPE, false, -6, top * 0.3, top * 0.7).mean;
      const down = speedOver(w, SLOPE, false, top + 6, top * 0.7, top * 0.3).mean;
      const wantUp = ws * slopeFactor(t(deg)), wantDown = ws * slopeFactor(-t(deg));
      ok &&= Math.abs(up - wantUp) < 0.01 * ws && Math.abs(down - wantDown) < 0.01 * ws;
      parts.push(`${deg}°: up ${f(up, 2)} (want ${f(wantUp, 2)}), down ${f(down, 2)} (want ${f(wantDown, 2)})`);
      if (deg === 20) ok &&= up < 0.75 * ws && up > 0.65 * ws;
      if (deg === 8) ok &&= down > ws;
      if (deg === 35) ok &&= down < 0.8 * ws;
    }
    // A steep loss never stops the body: on a 40° ramp (allowed up to 45°) with a loss of 3 it climbs at the floor.
    const steep = speedOver(longRamp(40, 8), { ...SLOPE, uphillSpeedLoss: 3 }, false, -6, 3, 7);
    ok &&= Math.abs(steep.mean - ws * slopeSpeedFloor) < 1e-6;
    // In the air the speed is not scaled: a jump from the 20° ramp with full air control speeds back up to the walk speed.
    const k = walker(longRamp(20, 8), 10, 10 * t(20), 0, { ...SLOPE, airControl: 1, jumpSpeed: 5 });
    walk(k, intent(1, 0), 2);
    const before = k.velocity[0]!;
    k.step(intent(1, 0, false, true));
    walk(k, intent(1, 0), 0.4);
    const air = k.velocity[0]!;
    ok &&= !k.grounded && Math.abs(air - ws) < 1e-9 && before < 0.75 * ws;
    return verdict(ok, `walk ${ws} m/s; ${parts.join('; ')}; 40° with loss 3: ${f(steep.mean, 3)} m/s (floor ${f(ws * slopeSpeedFloor, 3)}); in the air from ${f(before, 2)} back to ${f(air, 3)} m/s`);
  },
};

const slopeStairs: Scenario = {
  name: 'walker-slope-stairs-steady',
  run() {
    // 30 solid steps of 0.2 m with 0.4 m treads (mean grade 0.5) and of 0.17 m with 0.3 m treads: well into the flight
    // the speed stays within a few per cent of its mean and up to 3 % of a base ramp of the same mean slope.
    const parts: string[] = [];
    let ok = true;
    for (const [rise, tread] of [[0.2, 0.4], [0.17, 0.3]] as const) {
      const w = flat();
      for (let i = 0; i < 30; i++) w.addPrism([2 + i * tread, -2, 2 + (i + 1) * tread, -2, 2 + (i + 1) * tread, 2, 2 + i * tread, 2], 0, rise * (i + 1));
      const end = 2 + 30 * tread;
      w.addPrism([end, -2, end + 20, -2, end + 20, 2, end, 2], 0, rise * 30);
      const ramp = longRamp((Math.atan(rise / tread) * 180) / Math.PI, 30 * rise);
      for (const run of [false, true]) {
        const up = speedOver(w, SLOPE, run, -6, 2 + 12 * tread, 2 + 22 * tread);
        const down = speedOver(w, SLOPE, run, end + 6, 2 + 14 * tread, 2 + 4 * tread);
        // The ramp starts at x 0, the stairs at x 2: the same part of the slope.
        const rUp = speedOver(ramp, SLOPE, run, -8, 12 * tread, 22 * tread).mean;
        const jitter = Math.max((up.hi - up.lo) / up.mean, (down.hi - down.lo) / down.mean) / 2;
        const flatSpeed = run ? DEFAULT_WALKER.runSpeed : DEFAULT_WALKER.walkSpeed;
        ok &&= jitter < 0.05 && Math.abs(up.mean / rUp - 1) < 0.03 && up.mean < 0.7 * flatSpeed && down.mean < flatSpeed;
        parts.push(`${rise}/${tread} ${run ? 'run' : 'walk'}: up ${f(up.mean, 2)} (ramp ${f(rUp, 2)}), down ${f(down.mean, 2)}, ±${f(jitter * 100, 1)} %`);
      }
    }
    return verdict(ok, parts.join('; '));
  },
};

const slopeDeterminism: Scenario = {
  name: 'walker-slope-same-bits',
  run() {
    // With the slope effect on: two runs over the scattered course give the same bits, and a walker loaded from a
    // saved state in the middle (the grade included) steps on exactly like the original.
    const trace = (): { states: Uint8Array[]; mid: Uint8Array } => {
      const k = walker(course(), 60, 10, 60, SLOPE);
      const rnd = seeded(29);
      const it = newWalkIntent();
      const states: Uint8Array[] = [];
      let mid = new Uint8Array(0);
      for (let i = 0; i < 600; i++) {
        if (i % 30 === 0) {
          const a = rnd() * Math.PI * 2;
          it.moveX = Math.cos(a);
          it.moveZ = Math.sin(a);
          it.run = rnd() < 0.5;
        }
        it.jump = i % 97 === 0;
        k.step(it);
        if (i === 299) mid = k.saveState().slice();
        if (i >= 300) states.push(k.saveState().slice());
      }
      return { states, mid };
    };
    const a = trace();
    const b = trace();
    let apart = 0;
    for (let i = 0; i < a.states.length; i++) if (stateDiff(a.states[i]!, b.states[i]!)) apart++;
    // Continue from the saved middle with the same script.
    const c = walker(course(), 0, 0, 0, SLOPE);
    c.loadState(a.mid);
    const rnd = seeded(29);
    const it = newWalkIntent();
    let resumed = 0;
    for (let i = 0; i < 600; i++) {
      if (i % 30 === 0) {
        const ang = rnd() * Math.PI * 2;
        it.moveX = Math.cos(ang);
        it.moveZ = Math.sin(ang);
        it.run = rnd() < 0.5;
      }
      if (i < 300) continue;
      it.jump = i % 97 === 0;
      c.step(it);
      if (stateDiff(c.saveState(), a.states[i - 300]!)) resumed++;
    }
    const grade = stateSlot(a.mid, 19);
    return verdict(apart === 0 && resumed === 0 && grade !== 0, `two runs: ${apart} of ${a.states.length} states differ; resumed from step 300 (grade ${f(grade, 3)}): ${resumed} differ`);
  },
};

const slopeProbe: Scenario = {
  name: 'walker-slope-probe-window',
  run() {
    const t20 = Math.tan((20 * Math.PI) / 180);
    // The defaults spelled out (a 1 m window, 0.3 s of easing) step bit for bit as the defaults.
    const trace = (setup: Partial<WalkerSetup>): Uint8Array[] => {
      const k = walker(longRamp(20, 4), -6, 0, 0, setup);
      const out: Uint8Array[] = [];
      walk(k, intent(1, 0), 8, (k, i) => {
        if (i % 10 === 0) out.push(k.saveState().slice());
      });
      return out;
    };
    const a = trace(SLOPE);
    const b = trace({ ...SLOPE, gradeProbe: 1, gradeSmoothing: 0.3 });
    let apart = 0;
    for (let i = 0; i < a.length; i++) if (stateDiff(a[i]!, b[i]!)) apart++;
    // `grade` is the eased grade the speed uses (the saved state's slot), the ramp's tangent well up it.
    const g = walker(longRamp(20, 8), -6, 0, 0, SLOPE);
    let slotSame = true;
    walk(g, intent(1, 0), 6, (k) => {
      slotSame &&= k.grade === stateSlot(k.saveState(), 19);
    });
    const onRamp = g.grade;
    // Without easing the grade is the probe's at once; a window of 2.5 m reads the foot of the ramp sooner (its
    // farthest point reaches 1.3 m further ahead) and the same tangent up it.
    const firstGraded = (probe: number): { at: number; up: number } => {
      const k = walker(longRamp(20, 8), -8, 0, 0, { ...SLOPE, gradeProbe: probe, gradeSmoothing: 0 });
      let at = NaN;
      walk(k, intent(1, 0), 8, (k) => {
        if (Number.isNaN(at) && k.grade > 0.01) at = k.position[0]!;
      });
      return { at, up: k.grade };
    };
    const one = firstGraded(1), wide = firstGraded(2.5);
    const sooner = one.at - wide.at;
    const ok = apart === 0 && slotSame && Math.abs(onRamp - t20) < 1e-3 && Math.abs(one.up - t20) < 1e-9 && Math.abs(wide.up - t20) < 1e-9 && sooner > 0.8 && sooner < 1.6;
    return verdict(ok, `defaults spelled out: ${apart} of ${a.length} saved states differ; grade on a 20° ramp ${f(onRamp, 4)} (tangent ${f(t20, 4)}), equal to the saved slot ${slotSame}; without easing first graded at x ${f(one.at, 2)} (1 m) and ${f(wide.at, 2)} (2.5 m), ${f(sooner, 2)} m sooner, up the ramp ${f(one.up, 6)} and ${f(wide.up, 6)}`);
  },
};

export const WALKER_SCENARIOS: Scenario[] = [wall30, corner, steps, slopes, jump, airMomentum, standingJump, fall, thinWall,
  determinism, appear, timing, stateRoundTrip, stateContinues, stateOffsets, stateSim, stopDistance, runUp, turnArc, momentumDefaults, chartMomentum, retune,
  stopFixedStep, airRate, slopeDefaults, slopeUpDown, slopeStairs, slopeDeterminism, slopeProbe];
