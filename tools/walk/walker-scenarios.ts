// Scenarios of the walker (engine `world/walker.ts`) over the collision world: sliding along a wall, resting in a
// corner, steps and stairs, slopes, jumps and ceilings, no steering or turning in the air, falling off an edge, a thin
// wall at speed, determinism, a solid that appears over the body, and the CPU time of one step (spec M2, 3.3 and 3.4).
// Then the saved state (`saveState`, `loadState`, `simState`): a save loaded into a second walker saves the same bytes,
// a restored walker steps on and draws exactly like the original, offsets and refused buffers, and the walker as a
// part of a `Simulation` snapshot.

import { ByteReader, ByteWriter } from '../../packages/wallhammer-web/src/sim/bytes.ts';
import { Simulation } from '../../packages/wallhammer-web/src/sim/simulation.ts';
import { CollisionWorld, newRayHit } from '../../packages/wallhammer-web/src/world/collide.ts';
import { WALKER_STATE_BYTES, Walker, newWalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
import type { WalkIntent, WalkerSetup } from '../../packages/wallhammer-web/src/world/walker.ts';
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
  'prevYaw', 'acc', 'stepOffset', 'prevStepOffset', 'prevTravelled', 'spare'];
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

export const WALKER_SCENARIOS: Scenario[] = [wall30, corner, steps, slopes, jump, airMomentum, standingJump, fall, thinWall,
  determinism, appear, timing, stateRoundTrip, stateContinues, stateOffsets, stateSim];
