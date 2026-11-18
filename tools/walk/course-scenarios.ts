// Scenarios over the real test course of the walking example (examples/walk/src/course.ts): every station walked
// the way the page's `__wh.walkTo` walks it (examples/walk/src/drive.ts), so a change of the engine that breaks an
// ability shows up here before anyone opens the page.

import { Walker } from '../../packages/wallhammer-web/src/world/walker.ts';
import { PIT, PILLAR_GAPS_M, PILLAR_RADIUS_M, PILLAR_Z, PLATFORMS, RAMP_HEIGHT_M, buildCourse, pillarGapX } from '../../examples/walk/src/course.ts';
import type { Course } from '../../examples/walk/src/course.ts';
import { driveTo } from '../../examples/walk/src/drive.ts';
import type { DriveOptions, WalkState } from '../../examples/walk/src/drive.ts';
import { f, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

let shared: Course | null = null;
/** The course of the page's default seed, built once for all scenarios. */
function course(): Course {
  shared ??= buildCourse(7);
  return shared;
}

/** A walker standing on the ground at (x, z). */
function standAt(x: number, z: number, yaw = 0): Walker {
  const c = course();
  const w = new Walker(c.world);
  w.teleport(x, c.world.groundAt(x, z, 1e3, 0), z, yaw);
  return w;
}

interface Track {
  minY: number;
  maxY: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Walks to (x, z) and records the extremes of the path. */
function go(w: Walker, x: number, z: number, seconds: number, o: DriveOptions = {}): { end: WalkState; t: Track } {
  const t: Track = { minY: Infinity, maxY: -Infinity, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const end = driveTo(w, course().world, x, z, seconds, o, (k) => {
    const p = k.position;
    t.minY = Math.min(t.minY, p[1]!);
    t.maxY = Math.max(t.maxY, p[1]!);
    t.minX = Math.min(t.minX, p[0]!);
    t.maxX = Math.max(t.maxX, p[0]!);
    t.minZ = Math.min(t.minZ, p[2]!);
    t.maxZ = Math.max(t.maxZ, p[2]!);
  });
  return { end, t };
}

const R = 0.3;

const walls: Scenario = {
  name: 'course-walls',
  run() {
    // Into the corner of the L (faces at x = 10 and z = 10), then along the long wall (face at z = 30) at 30°.
    const a = go(standAt(14, 14), 4, 4, 4);
    const corner = Math.abs(a.end.x - 10 - R) < 0.01 && Math.abs(a.end.z - 10 - R) < 0.01 && a.t.minX >= 10 + R - 1e-6;
    const b = go(standAt(16, 26), 16 + 17.32, 26 + 10, 6);
    const slid = b.t.maxZ <= 30 - R + 1e-6 && b.end.x > 22 && Math.abs(b.end.z - (30 - R)) < 0.01;
    return verdict(corner && slid, `corner rest (${f(a.end.x)}, ${f(a.end.z)}) want (10.3, 10.3); along the wall to x ${f(b.end.x)}, closest z ${f(b.t.maxZ)} (face 30, radius ${R})`);
  },
};

const pillars: Scenario = {
  name: 'course-pillars',
  run() {
    // Straight through each gap from z 23 toward z 17: gaps wider than the body pass, narrower ones stop it.
    const out: string[] = [];
    let ok = true;
    PILLAR_GAPS_M.forEach((gap, i) => {
      const x = pillarGapX(i);
      const r = go(standAt(x, PILLAR_Z + 3), x, PILLAR_Z - 3, 6);
      const passed = r.end.z < PILLAR_Z - 2;
      const want = gap > 2 * PILLAR_RADIUS_M + 0.001 ? true : gap < 2 * PILLAR_RADIUS_M - 0.001 ? false : null;
      if (want !== null && passed !== want) ok = false;
      out.push(`${gap.toFixed(1)} m ${passed ? 'passed' : `stopped at z ${f(r.end.z, 2)}`}`);
    });
    return verdict(ok, out.join(', '));
  },
};

const steps: Scenario = {
  name: 'course-steps',
  run() {
    const stairs = go(standAt(88, 16), 97, 16, 8);
    const low = go(standAt(88, 21.5), 95, 21.5, 6);
    const high = go(standAt(88, 26.5), 95, 26.5, 6);
    const ok = Math.abs(stairs.end.y - 1.6) < 0.01 && stairs.end.x > 96 && Math.abs(low.end.y - 0.3) < 0.01 && high.end.x <= 92 - R + 1e-6 && Math.abs(high.end.y) < 0.01;
    return verdict(ok, `stairs: y ${f(stairs.end.y)} at x ${f(stairs.end.x)}; 0.3 m: y ${f(low.end.y)}; 0.5 m: stopped at x ${f(high.end.x)} y ${f(high.end.y)}`);
  },
};

const ramps: Scenario = {
  name: 'course-ramps',
  run() {
    const r20 = go(standAt(92, 52), 108, 52, 12);
    const r35 = go(standAt(92, 60), 108, 60, 12);
    const r55 = go(standAt(98, 68), 108, 68, 6);
    const top = RAMP_HEIGHT_M;
    const ok = Math.abs(r20.end.y - top) < 0.01 && Math.abs(r35.end.y - top) < 0.01 && r55.end.y < 0.5 && r55.end.x < 103;
    return verdict(ok, `20°: y ${f(r20.end.y)} x ${f(r20.end.x)}; 35°: y ${f(r35.end.y)} x ${f(r35.end.x)}; 55°: highest y ${f(r55.t.maxY)}, end x ${f(r55.end.x)} y ${f(r55.end.y)}`);
  },
};

const platforms: Scenario = {
  name: 'course-platforms',
  run() {
    // Running with jumps from the ground over all four gaps onto the last platform; walking (no run) falls short of
    // the 2 m gap.
    const last = PLATFORMS[PLATFORMS.length - 1]!;
    const run = go(standAt(87, 98), (last[0] + last[1]) / 2, 98, 10, { run: true, jump: true });
    const onLast = run.end.x > last[0] && Math.abs(run.end.y - last[2]) < 0.01 && run.end.grounded;
    const third = PLATFORMS[3]!;
    const walk = go(standAt(87, 98), (third[0] + third[1]) / 2, 98, 14, { jump: true });
    const short = !(walk.end.x > third[0] && Math.abs(walk.end.y - third[2]) < 0.01);
    return verdict(onLast && short, `run: end x ${f(run.end.x)} y ${f(run.end.y)} (last top ${last[2]}); walk: end x ${f(walk.end.x)} y ${f(walk.end.y)}, ${short ? 'falls short of the 2 m gap' : 'made the 2 m gap'}`);
  },
};

const passages: Scenario = {
  name: 'course-passages',
  run() {
    const low = go(standAt(53, 92), 53, 106, 10);
    const high = go(standAt(65, 92), 65, 106, 10);
    const ok = low.end.z <= 96 - R + 1e-6 && high.end.z > 105;
    return verdict(ok, `ceiling 1.5 m: stopped at z ${f(low.end.z)} (opening 96); ceiling 2 m: through to z ${f(high.end.z)}, head room kept (top y ${f(high.t.maxY + 1.7)})`);
  },
};

const thinWall: Scenario = {
  name: 'course-thin-wall',
  run() {
    const r = go(standAt(20, 94), 20, 106, 4, { run: true });
    const ok = r.t.maxZ <= 99.95 - R + 1e-6;
    return verdict(ok, `running at it: closest z ${f(r.t.maxZ, 4)} (face 99.95, radius ${R})`);
  },
};

const footbridge: Scenario = {
  name: 'course-footbridge',
  run() {
    const across = go(standAt(31, 60), 9, 60, 16);
    const crossed = across.end.x < 10 && across.t.minY > -0.01;
    const off = go(standAt(20, 60), 20, 56, 3);
    const fell = Math.abs(off.end.y + PIT.depth) < 0.01 && off.end.grounded;
    const out = go(standAt(20, 58), 20, 76, 12);
    const climbed = out.end.z > 73 && Math.abs(out.end.y) < 0.6;
    return verdict(crossed && fell && climbed, `across: end x ${f(across.end.x)}, lowest y ${f(across.t.minY)}; off the side: y ${f(off.end.y)}; out of the pit by the ramp: z ${f(out.end.z)} y ${f(out.end.y)}`);
  },
};

export const COURSE_SCENARIOS: Scenario[] = [walls, pillars, steps, ramps, platforms, passages, thinWall, footbridge];
