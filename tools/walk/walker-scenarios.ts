// Scenarios of the walker (engine `world/walker.ts`) over the collision world: sliding along a wall, resting in a
// corner, steps and stairs, slopes, jumps and ceilings, falling off an edge, a thin wall at speed, determinism, a solid
// that appears over the body, and the CPU time of one step (spec M2, 3.3 and 3.4).

import { CollisionWorld, newRayHit } from '../../packages/wallhammer-web/src/world/collide.ts';
import { Walker, newWalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
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

export const WALKER_SCENARIOS: Scenario[] = [wall30, corner, steps, slopes, jump, fall, thinWall, determinism, appear, timing];
