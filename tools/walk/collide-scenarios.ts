// Scenarios of the collision world alone (engine `world/collide.ts`): slide, ground, ceiling, ray, boom clearance,
// removal, determinism and CPU time. No walker here; the walker's scenarios live in their own file.

import { CollisionWorld, newRayHit, newSlideResult } from '../../packages/wallhammer-web/src/world/collide.ts';
import { HeightField } from '../../packages/wallhammer-web/src/gen-core/height-field.ts';
import { f, fail, meanMs, pass, seeded, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

const R = 0.3;
/** Height span of the moving circle: feet plus a step of 0.35 m up to the head at 1.7 m. */
const LO = 0.35;
const HI = 1.7;

const flat = (): CollisionWorld => new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0 });

/** Slides a circle `seconds` long at `speed` m/s along unit (ux, uz) in steps of `dt`; calls `each` after every step. */
function drive(w: CollisionWorld, x: number, z: number, ux: number, uz: number, speed: number, dt: number, seconds: number, each?: (x: number, z: number, step: number) => void): { x: number; z: number; hit: boolean } {
  const out = newSlideResult();
  let hit = false;
  const steps = Math.round(seconds / dt);
  for (let s = 0; s < steps; s++) {
    w.slide(x, z, R, LO, HI, ux * speed * dt, uz * speed * dt, out);
    x = out.x;
    z = out.z;
    hit ||= out.hit;
    each?.(x, z, s);
  }
  return { x, z, hit };
}

/** True when a zero move from (x, z) pushes nothing: the circle is not inside any solid. */
function settled(w: CollisionWorld, x: number, z: number): boolean {
  const out = w.slide(x, z, R, LO, HI, 0, 0, newSlideResult());
  return !out.hit && out.x === x && out.z === z;
}

const slideWall: Scenario = {
  name: 'slide-wall-30deg',
  run() {
    const w = flat();
    w.addBox(0, 0.1, 50, 0.1, 0, 0, 3); // wall face at z = 0
    const ux = Math.cos(Math.PI / 6);
    const uz = Math.sin(Math.PI / 6);
    let minGap = Infinity;
    const end = drive(w, 0, -1, ux, uz, 2, 1 / 60, 3, (_x, z) => {
      minGap = Math.min(minGap, -z);
    });
    const wantX = 2 * 3 * ux;
    return verdict(end.hit && minGap >= R - 1e-6 && Math.abs(end.x - wantX) < 1e-3 && Math.abs(end.z + R) < 1e-6,
      `x ${f(end.x)} (want ${f(wantX)}), min gap ${f(minGap, 6)} (radius ${R})`);
  },
};

const cornerRight: Scenario = {
  name: 'corner-90deg-stops',
  run() {
    const w = flat();
    w.addPrism([-5, 0, 0.2, 0, 0.2, 0.2, -5, 0.2], 0, 3); // wall along x, face z = 0
    w.addPrism([0, -5, 0.2, -5, 0.2, 0.2, 0, 0.2], 0, 3); // wall along z, face x = 0
    const u = Math.SQRT1_2;
    let at1 = [0, 0];
    const end = drive(w, -2, -2, u, u, 2, 1 / 60, 3, (x, z, s) => {
      if (s === 119) at1 = [x, z];
    });
    const drift = Math.max(Math.abs(end.x - at1[0]!), Math.abs(end.z - at1[1]!));
    return verdict(drift < 1e-3 && Math.abs(end.x + R) < 1e-4 && Math.abs(end.z + R) < 1e-4 && settled(w, end.x, end.z),
      `rest (${f(end.x, 4)}, ${f(end.z, 4)}), drift over the last second ${f(drift * 1000, 4)} mm`);
  },
};

const cornerAcute: Scenario = {
  name: 'corner-30deg-stops',
  run() {
    const w = flat();
    // Two thin walls meeting at the apex (0, 0), opening toward −x at ±15°.
    for (const side of [1, -1]) {
      const a = (side * 15 * Math.PI) / 180;
      const dx = -Math.cos(a);
      const dz = Math.sin(a);
      // yaw turns local +x to (cos yaw, −sin yaw); the wall runs along (dx, dz).
      w.addBox(dx * 2.5, dz * 2.5, 2.5, 0.05, Math.atan2(-dz, dx), 0, 3);
    }
    let at1 = [0, 0];
    const end = drive(w, -4, 0.01, 1, 0, 2, 1 / 60, 3, (x, z, s) => {
      if (s === 119) at1 = [x, z];
    });
    const drift = Math.max(Math.abs(end.x - at1[0]!), Math.abs(end.z - at1[1]!));
    // Touching both inner faces: 0.05 + radius from each centre line.
    const wantX = -(0.05 + R) / Math.sin((15 * Math.PI) / 180);
    return verdict(drift < 1e-3 && settled(w, end.x, end.z) && Math.abs(end.x - wantX) < 0.01,
      `rest (${f(end.x, 4)}, ${f(end.z, 4)}), want x ${f(wantX, 4)}, drift over the last second ${f(drift * 1000, 4)} mm`);
  },
};

const thinWall: Scenario = {
  name: 'thin-wall-10mps',
  run() {
    const parts: string[] = [];
    let ok = true;
    for (const dt of [1 / 10, 1 / 30, 1 / 120]) {
      const w = flat();
      w.addBox(5, 0, 0.05, 20, 0, 0, 3); // 0.1 m thick, near face x = 4.95
      let maxX = -Infinity;
      drive(w, 0, 0, 1, 0, 10, dt, 1.5, (x) => {
        maxX = Math.max(maxX, x);
      });
      const good = maxX <= 4.95 - R + 1e-6;
      ok &&= good;
      parts.push(`dt 1/${Math.round(1 / dt)}: max x ${f(maxX, 4)}`);
    }
    return verdict(ok, `${parts.join(', ')} (limit ${f(4.95 - R, 4)})`);
  },
};

const startInside: Scenario = {
  name: 'start-inside-pushed-out',
  run() {
    const w = flat();
    w.addBox(0, 0, 2, 1, 0, 0, 3);
    const out = w.slide(0.5, 0.6, R, LO, HI, 0, 0, newSlideResult());
    const c = w.addCylinder(10, 0, 1, 0, 3);
    const out2 = w.slide(10.2, 0, R, LO, HI, 0, 0, newSlideResult());
    return verdict(Math.abs(out.x - 0.5) < 1e-6 && Math.abs(out.z - 1.3) < 1e-6 && out.hit && out.nz > 0.999
      && Math.abs(out2.x - 11.3) < 1e-6 && out2.solid === c,
      `box: (${f(out.x)}, ${f(out.z)}) want (0.500, 1.300); cylinder: x ${f(out2.x)} want 11.300`);
  },
};

const ground: Scenario = {
  name: 'ground-at',
  run() {
    const w = flat();
    w.addBox(0, 0, 0.5, 0.5, 0, 0, 0.3); // step 0.3
    w.addBox(5, 0, 0.5, 0.5, 0, 0, 0.5); // step 0.5
    w.addBox(10, 0, 0.5, 0.5, 0, 0, 0.2, { standable: false });
    w.addBox(15, 0, 2, 0.5, Math.PI / 2, 0, 1); // turned: long along z
    const got = [
      w.groundAt(0, 0, 0, 0.35), // 0.3
      w.groundAt(5, 0, 0, 0.35), // 0 (too high)
      w.groundAt(5, 0, 0.3, 0.35), // 0.5
      w.groundAt(10, 0, 0, 0.35), // 0 (not standable)
      w.groundAt(0.7, 0, 0, 0.35), // 0 (off the edge, a point)
      w.groundAt(0.7, 0, 0, 0.35, R), // 0.3 (the disc still touches)
      w.groundAt(15, 1.5, 1, 0.35), // 1 (turned box reaches z 1.5)
      w.groundAt(16.5, 0, 1, 0.35), // 0 (it does not reach x 16.5)
    ];
    const want = [0.3, 0, 0.5, 0, 0, 0.3, 1, 0];
    const slope = new CollisionWorld({ heightAt: (x) => 0.5 * x });
    const sg = slope.groundAt(2, 0, 0, 0.35);
    const ok = got.every((g, i) => Math.abs(g - want[i]!) < 1e-6) && Math.abs(sg - 1) < 1e-9;
    return verdict(ok, `got ${got.map((g) => f(g, 2)).join(' ')}, slope ${f(sg, 2)}; want ${want.map((g) => f(g, 2)).join(' ')}, 1.00`);
  },
};

const ceiling: Scenario = {
  name: 'ceiling-at',
  run() {
    const w = flat();
    w.addBox(0, 0, 1, 1, 0, 2, 3);
    w.addBox(0, 0, 1, 1, 0, 4, 5, { blocksSight: false, standable: false });
    const got = [w.ceilingAt(0, 0, 1.7), w.ceilingAt(0, 0, 2.5), w.ceilingAt(0, 0, 3), w.ceilingAt(3, 0, 0), w.ceilingAt(1.2, 0, 1.7), w.ceilingAt(1.2, 0, 1.7, R)];
    const want = [2, 4, 4, Infinity, Infinity, 2];
    return verdict(got.every((g, i) => g === want[i]), `got ${got.join(' ')}, want ${want.join(' ')}`);
  },
};

const raycast: Scenario = {
  name: 'raycast',
  run() {
    const w = flat();
    const box = w.addBox(5, 0, 0.5, 0.5, 0, 0, 2, { tag: 7 });
    const cyl = w.addCylinder(0, 5, 0.5, 0, 2, { tag: 8 });
    w.addBox(2, 0, 0.1, 3, 0, 0, 3, { blocksSight: false }); // invisible limit in front of the box
    const diamond = w.addBox(10, 0, 0.5, 0.5, Math.PI / 4, 0, 2);
    const hit = newRayHit();
    const errors: string[] = [];
    const expect = (name: string, got: boolean, t: number, n: [number, number, number], solid: number, tag: number): void => {
      if (!got) {
        errors.push(`${name}: miss`);
        return;
      }
      const bad = Math.abs(hit.t - t) > 1e-3 || Math.abs(hit.nx - n[0]) > 1e-3 || Math.abs(hit.ny - n[1]) > 1e-3 || Math.abs(hit.nz - n[2]) > 1e-3 || hit.solid !== solid || hit.tag !== tag;
      if (bad) errors.push(`${name}: t ${f(hit.t)} n (${f(hit.nx)}, ${f(hit.ny)}, ${f(hit.nz)}) solid ${hit.solid} tag ${hit.tag}`);
    };
    expect('box side', w.raycast(0, 1, 0, 1, 0, 0, 20, hit), 4.5, [-1, 0, 0], box, 7);
    expect('cylinder', w.raycast(0, 1, 0, 0, 0, 1, 20, hit), 4.5, [0, 0, -1], cyl, 8);
    expect('box top', w.raycast(5, 5, 0, 0, -1, 0, 20, hit), 3, [0, 1, 0], box, 7);
    expect('base', w.raycast(0, 10, -3, 0, -1, 0, 20, hit), 10, [0, 1, 0], -1, -1);
    expect('turned box', w.raycast(6, 1, 0.1, 1, 0, 0, 20, hit), 10 - Math.SQRT1_2 + 0.1 - 6, [-Math.SQRT1_2, 0, Math.SQRT1_2], diamond, 0);
    if (w.raycast(0, 1, 0, 1, 0, 0, 4, hit)) errors.push('maxT: hit beyond maxT');
    expect('endless ray', w.raycast(0, 1, 0, 1, 0, 0, Infinity, hit), 4.5, [-1, 0, 0], box, 7);
    if (w.raycast(0, 1, 0, 0, 1, 0, Infinity, hit)) errors.push('endless ray up: hit');
    const slope = new CollisionWorld({ heightAt: (x) => 0.25 * x });
    const n = 1 / Math.sqrt(1 + 0.0625);
    expect('slope', slope.raycast(0, 1, 0, 1, 0, 0, 20, hit), 4, [-0.25 * n, n, 0], -1, -1);
    if (slope.raycast(0, 1, 0, -1, 0, 0, 20, hit)) errors.push('slope: hit behind');
    return errors.length === 0 ? pass('box side, cylinder, box top, base, turned box, maxT, slope, invisible limit skipped') : fail(errors.join('; '));
  },
};

const clearance: Scenario = {
  name: 'clearance',
  run() {
    const w = flat();
    w.addBox(0, 3.5, 5, 0.5, 0, 0, 5); // face at z = 3
    w.addBox(0, -3.5, 5, 0.5, 0, 0, 5, { blocksSight: false });
    const got = [
      w.clearance(0, 1.5, 0, 0, 0, 1, 6, 0.2), // 2.8
      w.clearance(0, 1.5, 0, 0, 0, -1, 6, 0.2), // 6 (invisible limit)
      w.clearance(0, 1.5, 0, 0, -1, 0, 6, 0.2), // 1.3 (base)
      w.clearance(0, 1.5, 2.9, 0, 0, -1, 6, 0.2), // 0 (starts overlapping)
      w.clearance(0, 1.5, 0, 0, 0, 2, 6, 0), // 3 (a ray: radius 0)
    ];
    const want = [2.8, 6, 1.3, 0, 3];
    return verdict(got.every((g, i) => Math.abs(g - want[i]!) < 2e-3), `got ${got.map((g) => f(g)).join(' ')}, want ${want.map((g) => f(g)).join(' ')}`);
  },
};

const longTurned: Scenario = {
  name: 'long-turned-solid',
  run() {
    // A 200 m wall turned by 37°: listed only in the cells it reaches, yet found from every point along it.
    const w = flat();
    const yaw = (37 * Math.PI) / 180;
    w.addBox(0, 0, 100, 0.1, yaw, 0, 3);
    const ax = Math.cos(yaw);
    const az = -Math.sin(yaw); // along the wall
    const nx = Math.sin(yaw);
    const nz = Math.cos(yaw); // its normal
    const hit = newRayHit();
    const out = newSlideResult();
    let worst = Infinity;
    let rays = 0;
    for (let k = -90; k <= 90; k += 7.3) {
      const px = ax * k - nx * 2;
      const pz = az * k - nz * 2;
      // Walk into it along its normal; the circle must stop 0.1 + R from its centre line.
      let x = px;
      let z = pz;
      for (let s = 0; s < 60; s++) {
        w.slide(x, z, R, LO, HI, nx * 0.1, nz * 0.1, out);
        x = out.x;
        z = out.z;
      }
      worst = Math.min(worst, -(x * nx + z * nz));
      if (w.raycast(px, 1, pz, nx, 0, nz, 10, hit) && Math.abs(hit.t - 1.9) < 1e-3) rays++;
    }
    const want = 0.1 + R;
    return verdict(Math.abs(worst - want) < 1e-4 && rays === 25, `closest centre ${f(worst, 4)} m from the centre line (want ${f(want, 4)}), ${rays} of 25 rays hit at 1.9 m`);
  },
};

const remove: Scenario = {
  name: 'remove-keeps-ids',
  run() {
    const w = flat();
    const a = w.addBox(-5, 0, 0.5, 0.5, 0, 0, 2, { tag: 1 });
    const b = w.addBox(3, 0, 0.1, 5, 0, 0, 2, { tag: 2 });
    const c = w.addBox(8, 0, 0.5, 0.5, 0, 0, 2, { tag: 3 });
    const blocked = drive(w, 0, 0, 1, 0, 2, 1 / 60, 2).x;
    w.remove(b);
    w.remove(b);
    const passed = drive(w, 0, 0, 1, 0, 2, 1 / 60, 2).x;
    const hit = newRayHit();
    const ray = w.raycast(0, 1, 0, 1, 0, 0, 20, hit);
    const ok = w.solidCount === 2 && w.has(a) && !w.has(b) && w.has(c) && blocked < 3 - 0.1 - R + 1e-6 && passed > 3.5 && ray && hit.solid === c && hit.tag === 3;
    return verdict(ok, `count ${w.solidCount}, blocked at x ${f(blocked)}, after remove x ${f(passed)}, ray hits id ${hit.solid} tag ${hit.tag}`);
  },
};

/** A world of `count` boxes and cylinders scattered over `size` × `size` metres on a gently rolling height field. */
export function scattered(count: number, size: number, seed: number): CollisionWorld {
  const step = 2;
  const cols = Math.floor(size / step) + 1;
  const heights = new Float32Array(cols * cols);
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < cols; i++) heights[j * cols + i] = 3 * Math.sin(i * 0.11) * Math.cos(j * 0.07);
  }
  const field = new HeightField(step, cols, cols, heights);
  const w = new CollisionWorld({ heightAt: (x, z) => field.heightAt(x, z), baseMinY: field.minY, baseMaxY: field.maxY });
  const rnd = seeded(seed);
  for (let k = 0; k < count; k++) {
    const x = rnd() * size;
    const z = rnd() * size;
    const y = field.heightAt(x, z) - 0.5;
    if (k % 3 === 0) w.addCylinder(x, z, 0.2 + rnd() * 0.6, y, y + 1 + rnd() * 6);
    else w.addBox(x, z, 0.3 + rnd() * 3, 0.3 + rnd() * 3, rnd() * Math.PI, y, y + 1 + rnd() * 8, { standable: k % 2 === 0 });
  }
  return w;
}

const determinism: Scenario = {
  name: 'same-inputs-same-bits',
  run() {
    const trace = (): Float64Array => {
      const w = scattered(300, 120, 11);
      const rnd = seeded(5);
      const out = newSlideResult();
      const hit = newRayHit();
      const t = new Float64Array(600 * 4);
      let x = 60;
      let z = 60;
      for (let s = 0; s < 600; s++) {
        const a = rnd() * 6.283185307179586;
        w.slide(x, z, R, LO, HI, Math.cos(a) * 0.2, Math.sin(a) * 0.2, out);
        x = out.x;
        z = out.z;
        const y = w.groundAt(x, z, 0, 100);
        w.raycast(x, y + 1.6, z, Math.cos(a), -0.1, Math.sin(a), 30, hit);
        t[s * 4] = x;
        t[s * 4 + 1] = z;
        t[s * 4 + 2] = hit.t;
        t[s * 4 + 3] = w.clearance(x, y + 1.6, z, -Math.cos(a), 0.4, -Math.sin(a), 5, 0.2);
      }
      return t;
    };
    const a = trace();
    const b = trace();
    let same = true;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) same = false;
    return verdict(same, `600 slides, rays and booms in a world of 300 solids, two runs ${same ? 'bit-identical' : 'DIFFER'}`);
  },
};

const timing: Scenario = {
  name: 'cpu-time',
  kind: 'timing',
  run() {
    const size = 300;
    const w = scattered(2000, size, 3);
    const rnd = seeded(9);
    const N = 10000;
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
      const a = rnd() * 6.283185307179586;
      dx[i] = Math.cos(a);
      dz[i] = Math.sin(a);
      dy[i] = -0.2 + rnd() * 0.3;
    }
    const hit = newRayHit();
    const out = newSlideResult();
    let hits = 0;
    const ray = meanMs(N, (i) => {
      if (w.raycast(ox[i]!, oy[i]!, oz[i]!, dx[i]!, dy[i]!, dz[i]!, 30, hit)) hits++;
    });
    const slide = meanMs(N, (i) => {
      w.slide(ox[i]!, oz[i]!, R, oy[i]! - 1.35, oy[i]!, dx[i]! * 0.075, dz[i]! * 0.075, out);
    });
    const ground = meanMs(N, (i) => {
      w.groundAt(ox[i]!, oz[i]!, oy[i]! - 1.7, 0.35, R);
    });
    const boom = meanMs(N, (i) => {
      w.clearance(ox[i]!, oy[i]!, oz[i]!, -dx[i]!, 0.5, -dz[i]!, 4, 0.2);
    });
    const ok = ray <= 0.01;
    return verdict(ok, `2000 solids, mean of ${N}: raycast (30 m) ${f(ray * 1000, 2)} µs (target 10 µs, ${Math.round((hits / 2 / N) * 100)} % hit), slide ${f(slide * 1000, 2)} µs, groundAt ${f(ground * 1000, 2)} µs, clearance (4 m) ${f(boom * 1000, 2)} µs`);
  },
};

export const COLLIDE_SCENARIOS: Scenario[] = [slideWall, cornerRight, cornerAcute, thinWall, startInside, ground, ceiling, raycast, clearance, longTurned, remove, determinism, timing];
