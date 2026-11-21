// Details near the camera on the page (NSO-717): which squares of details.ts are wanted round the eye, their jobs on
// the pool of workers (or one square per frame on the main thread), and the engine's `NearInstanceLayer` that draws
// them, all through the engine's `NearDetailStream`. Two groups with their own reach: the tufts (60 m) and the stones with the flowers (120 m).
//
// - Per frame: the height above the surface; the wanted squares of each group are those its reach + 25 m touches; at
//   most two jobs in flight, nearest first (the cells keep the rest of the pool); a square is dropped beyond its
//   group's reach + 60 m. Above `DETAIL_OFF_M` no job is posted and every square is dropped.
// - Gain of a group = (1 − smoothstep(200, 300, height)) × the least, over its wanted squares not there yet, of
//   clamp((distance to the square − 10 m) / reach, 0, 1). It falls at once and rises by at most 0.04 per frame: the
//   reach shrinks toward the camera while squares are missing, so no square appears inside the visible reach.
// - Wind: Hearth's wind of the page (`HEARTH_WIND`), along the ground at the eye; strength = min(1, speed / 12). When
//   the system's time moved by more than 1 s since the last frame, the two travelling waves are off for that frame.

import { RAD_PER_TURN, detCos, detSin } from 'wallhammer-web/base';
import type { Vec3 } from 'wallhammer-web/base';
import type { Layer, NearInstanceLayer } from 'wallhammer-web/render';
import type { WorkerPool } from 'wallhammer-web/platform';
import { NearDetailStream } from 'wallhammer-web/runtime';
import type { Engine, NearDetailGroup } from 'wallhammer-web/runtime';
import { SURFACES } from './bodies.ts';
import { BIOME } from './climate.ts';
import { DETAIL, DETAIL_GRID, DETAIL_KINDS, DETAIL_OFF_M, detailShapes, detailStage, generateDetails } from './details.ts';
import { planScope, planSurface, planWater } from './ground.ts';
import type { PlanView } from './inhabited.ts';
import { LINE_KIND, PLAN_BODY } from './plan.ts';
import type { WorldPlan } from './plan.ts';
import { DETAIL_MATERIAL } from './shaders.ts';
import { HEARTH_WIND, placeAt } from './weather.ts';
import { latLonOf } from './world.ts';

const GROUPS: readonly NearDetailGroup[] = [
  { mask: 1 << DETAIL.tuft, kinds: [DETAIL.tuft], reachM: DETAIL_KINDS[DETAIL.tuft]!.fade.reachM },
  { mask: (1 << DETAIL.stone) | (1 << DETAIL.flower), kinds: [DETAIL.stone, DETAIL.flower], reachM: DETAIL_KINDS[DETAIL.stone]!.fade.reachM },
];
/** Wind speed of full strength, m/s. */
const FULL_WIND_MS = 12;

const R = SURFACES[PLAN_BODY]!.radiusM;

export interface DetailStats {
  /** Squares there, both groups. */
  squares: number;
  /** Records held, sent to the GPU and left out by the ceiling. */
  held: number;
  drawn: number;
  clipped: number;
  /** Jobs posted since the start (on the main thread: squares made). */
  jobs: number;
  /** Gain of the tufts and of the stones with the flowers. */
  gain: [number, number];
  /** Milliseconds of the last rebuild of the buffers. */
  rebuildMs: number;
  /** Squares whose job failed. */
  failed: number;
}

export interface Details {
  /** The layer, for its uniforms (`u_toSun`, `u_airNear`, `u_eyePos`). */
  readonly layer: NearInstanceLayer;
  /** Once per frame with the eye in Hearth's turning frame (metres from its centre), or null away from Hearth. */
  frame(eye: Vec3 | null, timeS: number): void;
  /** Every wanted square there, no job in flight and every gain at its target. */
  settled(): boolean;
  stats(): DetailStats;
  dispose(): void;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The details of the body `packed` names, drawn before `before`. Only for a plan of stage `STAGE.climate` or more. */
export function createDetails(o: { engine: Engine; pool: WorkerPool | null; packed: number; plan: WorldPlan; stage: number; before: Layer }): Details {
  const { engine, pool, packed, plan, stage } = o;
  const shapes = detailShapes();
  const scope = planScope(plan, detailStage(stage), null);
  const stream = new NearDetailStream({
    renderer: engine.renderer,
    material: DETAIL_MATERIAL,
    kinds: DETAIL_KINDS.map((k, i) => ({ mesh: shapes[i]!, fade: k.fade, maxInstances: k.maxInstances, bendM: k.bendM })),
    before: o.before,
    grid: DETAIL_GRID,
    groups: GROUPS,
    offM: DETAIL_OFF_M,
    generate: (s, mask) => {
      const d = generateDetails(packed, plan, stage, s, mask);
      return { anchor: d.anchor, radiusM: d.radiusM, start: d.records.start, data: d.records.data };
    },
    pool,
    job: (s, mask) => ({ kind: 'details', seed: packed, stage, face: s.face, i: s.i, j: s.j, mask }),
    // The cells of the surface go first: a job starts only on an idle worker with no job waiting for one.
    idleWorkersOnly: true,
    invalidate: () => engine.invalidate(),
  });

  const windAt = (eye: Vec3): Vec3 => {
    // The wind blows from `fromDeg` (0 = from +z, 90 = from +x): toward the opposite way, along the ground at the eye.
    const toward = ((HEARTH_WIND.fromDeg + 180) / 360) * RAD_PER_TURN;
    const w: Vec3 = [detSin(toward), 0, detCos(toward)];
    const l = Math.sqrt(eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]) || 1;
    const up: Vec3 = [eye[0] / l, eye[1] / l, eye[2] / l];
    const d = w[0] * up[0] + w[1] * up[1] + w[2] * up[2];
    const t: Vec3 = [w[0] - up[0] * d, w[1] - up[1] * d, w[2] - up[2] * d];
    const tl = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]);
    // At the two points where the wind stands along up, any direction along the ground will do.
    return tl > 1e-6 ? [t[0] / tl, t[1] / tl, t[2] / tl] : [up[1], -up[0], 0];
  };

  return {
    layer: stream.layer,
    frame(eye, timeS) {
      if (!eye) {
        stream.frame({ eye: null, dir: [0, 0, 1], heightM: 0, timeS, windDir: [1, 0, 0], windStrength: 0 });
        return;
      }
      const l = Math.sqrt(eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]) || 1;
      const dir: Vec3 = [eye[0] / l, eye[1] / l, eye[2] / l];
      const height = l - R - planSurface(scope, dir[0] * R, dir[1] * R, dir[2] * R);
      const lift = 1 - smooth(200, DETAIL_OFF_M, height);
      stream.frame({ eye, dir, heightM: height, timeS, lift, windDir: windAt(eye), windStrength: Math.min(1, HEARTH_WIND.speedMs / FULL_WIND_MS) });
    },
    settled: () => stream.settled(),
    stats() {
      const st = stream.stats();
      return { squares: st.squares, held: st.held, drawn: st.drawn, clipped: st.clipped, jobs: st.jobs, gain: [st.gains[0]!, st.gains[1]!], rebuildMs: st.rebuildMs, failed: st.failed };
    },
    dispose: () => stream.dispose(),
  };
}

// --- Views of the script interface -----------------------------------------------------------------------------------

/** About `count` directions spread evenly over the sphere (a spiral). */
function spiral(count: number): Vec3[] {
  const out: Vec3[] = [];
  const golden = (RAD_PER_TURN / 2) * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    out.push([detCos(golden * i) * r, y, detSin(golden * i) * r]);
  }
  return out;
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** The direction `m` metres from `d` along the unit tangent `t`. */
const along = (d: Vec3, t: Vec3, m: number): Vec3 => norm([d[0] + (t[0] * m) / R, d[1] + (t[1] * m) / R, d[2] + (t[2] * m) / R]);

/** A tangent at `d`: toward the north pole, or along x at a pole. */
function northAt(d: Vec3): Vec3 {
  const k = d[1];
  const t: Vec3 = [-d[0] * k, 1 - d[1] * k, -d[2] * k];
  const l = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]);
  return l > 1e-6 ? [t[0] / l, t[1] / l, t[2] / l] : [1, 0, 0];
}

/**
 * The views of the details, found by a search over the plan: a flat meadow at eye height and from 30 m, three steps
 * of 3 m along its heading, a river bank (the lanes of the town come with their stage; until then the bank of a river
 * is the line the details keep clear of), dry country, tundra (forest where there is none), and the meadow from 300 m.
 */
export function detailViews(plan: WorldPlan, daylight?: (dir: Vec3) => number): PlanView[] {
  const body = SURFACES[PLAN_BODY]!.name;
  const dirs = spiral(6000);
  const scope = planScope(plan, detailStage(plan.stage), null);
  const ground = (d: Vec3): number => planSurface(scope, d[0] * R, d[1] * R, d[2] * R);
  /** A dry, flat place of the biome: no water and under 1.5 m of fall within 30 m round it. */
  const flat = (d: Vec3, biome: number): boolean => {
    const p = placeAt(plan, d);
    if (p.biome !== biome || p.h < 5 || planWater(scope, d[0] * R, d[1] * R, d[2] * R).kind !== 0) return false;
    const n = northAt(d);
    const e: Vec3 = [d[1] * n[2] - d[2] * n[1], d[2] * n[0] - d[0] * n[2], d[0] * n[1] - d[1] * n[0]];
    const h = ground(d);
    for (const [t, m] of [[n, 30], [n, -30], [e, 30], [e, -30]] as const) if (Math.abs(ground(along(d, t, m)) - h) > 1.5) return false;
    return true;
  };
  const view = (name: string, d: Vec3, height: number, pitchDeg: number, toward?: Vec3): PlanView => {
    const [lat, lon] = latLonOf(d);
    return { name: `world-detail-${name}`, body, lat, lon, height, pitchDeg, yawDeg: 0, map: false, ...(toward ? { toward } : {}), ...(daylight ? { time: daylight(d) } : {}) };
  };
  /** A point `m` metres ahead along `t` at eye height over the ground, to look at. */
  const ahead = (d: Vec3, t: Vec3, m: number, eyeM: number): Vec3 => {
    const a = along(d, t, m);
    const r = R + ground(a) + eyeM;
    return [a[0] * r, a[1] * r, a[2] * r];
  };
  const views: PlanView[] = [];
  const meadow = dirs.find((d) => flat(d, BIOME.meadow));
  if (meadow) {
    const t = northAt(meadow);
    views.push(view('meadow', meadow, 1.7, 3, ahead(meadow, t, 200, -9)));
    views.push(view('meadow-30m', meadow, 30, 35, ahead(meadow, t, 45, 0)));
    for (const [k, name] of ['walk-a', 'walk-b', 'walk-c'].entries()) {
      const d = along(meadow, t, 3 * (k + 1));
      views.push(view(name, d, 1.7, 3, ahead(meadow, t, 200, -9)));
    }
    views.push(view('300m', meadow, 300, 60, ahead(meadow, t, 200, 0)));
  }
  // The bank of a river of the middle classes on flat land, 6 m beyond its edge, looking across it.
  const L = plan.lines;
  let bank: { d: Vec3; to: Vec3 } | null = null;
  for (let l = L.kindStart[LINE_KIND.river]!; l < L.kindStart[LINE_KIND.river + 1]! && !bank; l++) {
    if (L.cls[l]! < 1 || L.cls[l]! > 2) continue;
    for (let k = L.start[l]! + 2; k + 1 < L.start[l + 1]! && !bank; k += 6) {
      const p: Vec3 = [L.points[3 * k]!, L.points[3 * k + 1]!, L.points[3 * k + 2]!];
      const q: Vec3 = [L.points[3 * k + 3]!, L.points[3 * k + 4]!, L.points[3 * k + 5]!];
      const run = norm([q[0] - p[0], q[1] - p[1], q[2] - p[2]]);
      const side = norm([p[1] * run[2] - p[2] * run[1], p[2] * run[0] - p[0] * run[2], p[0] * run[1] - p[1] * run[0]]);
      const d = along(p, side, L.halfWidth[k]! + 6);
      if (placeAt(plan, d).h < 5 || placeAt(plan, d).biome !== BIOME.meadow) continue;
      const r = R + ground(p);
      bank = { d, to: [p[0] * r, p[1] * r, p[2] * r] };
    }
  }
  if (bank) {
    views.push(view('lane', bank.d, 1.7, 8, bank.to));
    views.push(view('lane-again', bank.d, 1.7, 8, bank.to));
  }
  const dry = dirs.find((d) => flat(d, BIOME.dry));
  if (dry) views.push(view('dry', dry, 1.7, 3, ahead(dry, northAt(dry), 200, -9)));
  const cold = dirs.find((d) => flat(d, BIOME.tundra)) ?? dirs.find((d) => flat(d, BIOME.forest));
  if (cold) views.push(view(placeAt(plan, cold).biome === BIOME.tundra ? 'tundra' : 'forest', cold, 1.7, 3, ahead(cold, northAt(cold), 200, -9)));
  return views;
}
