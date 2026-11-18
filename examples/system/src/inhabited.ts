// The inhabited world on the page: the one place main.ts talks to about the plan of Hearth. It has the plan computed
// (one job on the pool of workers, or on the main thread), hands its bytes to every worker, and offers what the page
// shows of it: the line at the bottom, the marks drawn over the body from afar and the views of the script interface.
// From stage 1 the cells of the planned body come from the plan (`plannedBody`): a provider that waits for it, the
// surface the camera keeps clear of, the flight along the main river and the views of the water.

import type { Vec3 } from 'wallhammer-web/base';
import type { Body, BodySystem } from 'wallhammer-web/core';
import { cellId, cubeDirection, cubeFaceOf, cubeGrid, cubeNeighbour } from 'wallhammer-web/gen-core';
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import { gridDirection, gridNeighbours, gridNodeAt } from 'wallhammer-web/gen-plan';
import type { WorkerPool } from 'wallhammer-web/platform';
import type { Layer } from 'wallhammer-web/render';
import type { Engine } from 'wallhammer-web/runtime';
import { decodeCell } from 'wallhammer-web/world';
import type { CellProvider, CellResult } from 'wallhammer-web/world';
import { SURFACES } from './bodies.ts';
import { createDetails } from './details-page.ts';
import type { Details } from './details-page.ts';
import { detailStage } from './details.ts';
import { createLife } from './life-layer.ts';
import type { Life } from './life-layer.ts';
import { planScope, planSurface, planWater } from './ground.ts';
import type { Scope } from './ground.ts';
import { LINE_KIND, PLAN_BODY, SITE_KIND, STAGE, decodePlan, planHash, worldPlan } from './plan.ts';
import type { WorldPlan } from './plan.ts';
import { laneLengthM, lanePoint, routePoint } from './plan-routes.ts';
import { settlementOf, siteFrame, sitePoint } from './settlement.ts';
import { KEY_ITEMS, STRUCTURE_KIND, clusterRecipes } from './structures.ts';
import { generateWorldCell } from './planned-cell.ts';
import { mainStem, riverFlightPose } from './river-flight.ts';
import type { RiverFlightPose, RiverStem } from './river-flight.ts';
import { ROOT_LEVEL, generateBodyCell, groundHeight, latLonOf } from './world.ts';
import { lakeAt, lakeBed, lakeBendSeed, lakeHere } from './plan-lakes.ts';

/**
 * Whether the heights of the plan are computed as six jobs on the pool, one face each, and joined for the plan job.
 * Only worth it when the heights alone take more than 2.5 s in one worker (see the table "Plan budget" of README.md).
 */
const SPLIT_HEIGHTS = false;

/** What the plan took and what it holds, for `__wh.stats().plan`. */
export interface PlanReport {
  /** Milliseconds per phase as the thread that computed it measured them, `total` for the whole job, `wall` on the page. */
  ms: Record<string, number>;
  bytes: number;
  rivers: number;
  lines: number;
  points: number;
  pools: number;
  /** Workers that hold the plan (all of the pool), 0 without a pool. */
  workers: number;
  hash: string;
}

export interface Inhabited {
  /** The plan once it is there. */
  plan(): WorldPlan | null;
  readonly stage: number;
  /** Resolves when the plan is there and every worker holds it; rejects when it failed. */
  whenReady: Promise<void>;
  /** Once per frame with the eye in the body's frame, or null when the body is not the one drawn near: the details. */
  frame(eye: Vec3 | null, timeS: number): void;
  /** The details near the camera (from stage `STAGE.climate`, once the plan is there), or null. */
  details(): Details | null;
  /** The creatures near the camera (from stage `STAGE.sites`, once the plan is there), or null. */
  life(): Life | null;
  /** The plan is there (or failed) and the details, if any, are settled. */
  settled(): boolean;
  dispose(): void;
  report(): PlanReport | null;
  /** Why the plan failed, or null. */
  error(): string | null;
}

/**
 * Starts the plan of the body `packed` names at `stage`. Call it after the coarsest cells are queued on the pool.
 * `details` (default true) makes the details near the camera from stage `STAGE.climate`, drawn before `before`;
 * `life` (default true) the creatures near the camera from stage `STAGE.sites` (life-layer.ts), drawn before it too.
 */
export function createInhabited(o: { engine: Engine; pool: WorkerPool | null; packed: number; stage: number; details?: boolean; life?: boolean; before?: Layer }): Inhabited {
  const { engine, pool, packed, stage } = o;
  let plan: WorldPlan | null = null;
  let report: PlanReport | null = null;
  let failure: string | null = null;
  let disposed = false;
  let details: Details | null = null;
  let life: Life | null = null;
  const started = performance.now();

  const finish = (p: WorldPlan, bytes: number, ms: Record<string, number>, workers: number): void => {
    const L = p.lines;
    ms.wall = performance.now() - started;
    report = {
      ms,
      bytes,
      // The owner of the last river line (from stage 3 lanes follow the rivers).
      rivers: L.kindStart[LINE_KIND.river + 1]! > 0 ? L.owner[L.kindStart[LINE_KIND.river + 1]! - 1]! + 1 : 0,
      lines: L.owner.length,
      points: L.points.length / 3,
      pools: p.pools.level.length,
      workers,
      hash: planHash(p, 'water'),
    };
    plan = p;
    if ((o.details ?? true) && o.before && detailStage(stage) >= STAGE.climate) details = createDetails({ engine, pool, packed, plan: p, stage, before: o.before });
    if ((o.life ?? true) && o.before && stage >= STAGE.sites) life = createLife({ engine, plan: p, stage, before: o.before });
    engine.invalidate();
  };

  const onPool = async (workers: WorkerPool): Promise<void> => {
    const ms: Record<string, number> = {};
    let heights: Float32Array | undefined;
    if (SPLIT_HEIGHTS) {
      const t0 = performance.now();
      const before = workers.timing.ms;
      const faces = await Promise.all([0, 1, 2, 3, 4, 5].map((face) => workers.run<Float32Array>({ kind: 'plan-heights', seed: packed, face }).promise));
      heights = new Float32Array(faces.reduce((n, f) => n + f.length, 0));
      faces.forEach((f, i) => heights!.set(f, i * f.length));
      ms.heightsWall = performance.now() - t0;
      ms.heightsWorkers = workers.timing.ms - before;
    }
    const job = workers.run<{ bytes: ArrayBuffer; ms: Record<string, number> }>({ kind: 'plan', seed: packed, stage, ...(heights ? { heights } : {}) }, heights ? [heights.buffer] : []);
    const r = await job.promise;
    if (disposed) return;
    const p = decodePlan(r.bytes);
    // Every worker checks the fingerprint of its copy: all threads hold the same plan.
    await workers.broadcast({ kind: 'have-plan', seed: packed, bytes: r.bytes, hash: planHash(p, 'water') });
    if (disposed) return;
    finish(p, r.bytes.byteLength, { ...ms, ...r.ms }, workers.size);
  };

  const onMain = async (): Promise<void> => {
    // One frame (and a refresh of the line at the bottom) shows that the plan is being computed before it blocks.
    engine.invalidate();
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 300)));
    if (disposed) return;
    const ms: Record<string, number> = {};
    const t0 = performance.now();
    let last = t0;
    const p = worldPlan(packed, stage, {
      mark: (phase) => {
        const now = performance.now();
        ms[phase] = now - last;
        last = now;
      },
    });
    ms.total = performance.now() - t0;
    finish(p, p.relief.buffer.byteLength, ms, 0);
  };

  const whenReady = (pool ? onPool(pool) : onMain()).catch((e: unknown) => {
    failure = e instanceof Error ? e.message : String(e);
    engine.invalidate();
    throw e;
  });

  return {
    plan: () => plan,
    stage,
    whenReady,
    frame: (eye, timeS) => {
      details?.frame(eye, timeS);
      life?.frame(eye, timeS);
    },
    details: () => details,
    life: () => life,
    settled: () => (plan !== null || failure !== null) && (details?.settled() ?? true),
    dispose: () => {
      disposed = true;
      details?.dispose();
      life?.dispose();
      life = null;
      details = null;
    },
    report: () => report,
    error: () => failure,
  };
}

/** A whole number with a space between the groups of three digits. */
function groups(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** The noun for a count: `noun` for one, `noun` with an s for any other count. */
function plural(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`;
}

/** The part of the line at the bottom about the plan. */
export function planStatus(inh: Inhabited): string {
  const failed = inh.error();
  if (failed) return `World plan: error (${failed})`;
  const r = inh.report();
  if (!r) return 'World plan: computing…';
  const seconds = ((r.ms.total ?? r.ms.wall ?? 0) / 1000).toFixed(1);
  return `World plan: ${seconds} s · ${groups(r.rivers)} ${plural(r.rivers, 'river')} · ${groups(r.pools)} ${plural(r.pools, 'lake')} · hash ${r.hash}`;
}

/** Plain line segments in the body's own frame (x y z per end, metres from its centre), ready for a line mesh. */
export interface PlanMarks {
  /** The river lines, one list per class (0 the great rivers). */
  rivers: Float32Array[];
  /** The cell edges between a lake node and a node outside that lake. */
  pools: Float32Array;
  /** Stage 3: a cross over every site, 2 km for a village, 5 km for the town (empty below stage 3). */
  sites: Float32Array;
  /** Stage 4: the road and deck lines (empty below stage 4). */
  roads: Float32Array;
}

/** The marks of the plan: its river lines by class, the outlines of its lakes and a cross per site. */
export function planMarks(plan: WorldPlan): PlanMarks {
  const R = plan.grid.radiusM;
  const L = plan.lines;
  const perClass: number[][] = [[], [], [], []];
  for (let l = L.kindStart[LINE_KIND.river]!; l < L.kindStart[LINE_KIND.river + 1]!; l++) {
    const out = perClass[Math.min(3, L.cls[l]!)]!;
    for (let i = L.start[l]!; i + 1 < L.start[l + 1]!; i++) {
      for (const k of [i, i + 1]) {
        const r = R + Math.max(0, L.grade[k]!);
        out.push(L.points[3 * k]! * r, L.points[3 * k + 1]! * r, L.points[3 * k + 2]! * r);
      }
    }
  }
  const { n, count } = plan.grid;
  const nn = n * n;
  const edges: number[] = [];
  const corner = (face: number, cx: number, cy: number, r: number): void => {
    const d = cubeDirection(face, cubeGrid(cx, n), cubeGrid(cy, n));
    edges.push(d[0] * r, d[1] * r, d[2] * r);
  };
  // Per side of a cell: the step to the neighbour and the two corners of the edge between them.
  const SIDES: readonly [number, number, number, number, number, number][] = [
    [-1, 0, 0, 0, 0, 1],
    [1, 0, 1, 0, 1, 1],
    [0, -1, 0, 0, 1, 0],
    [0, 1, 0, 1, 1, 1],
  ];
  for (let i = 0; i < count; i++) {
    const k = plan.pool[i]!;
    if (k === 0) continue;
    const face = Math.floor(i / nn);
    const y = Math.floor((i - face * nn) / n);
    const x = i - face * nn - y * n;
    const r = R + plan.pools.level[k - 1]!;
    for (const [dx, dy, ax, ay, bx, by] of SIDES) {
      const c = cubeNeighbour(face, plan.grid.level, x, y, dx, dy);
      if (c && plan.pool[c.face * nn + c.y * n + c.x] === k) continue;
      corner(face, x + ax, y + ay, r);
      corner(face, x + bx, y + by, r);
    }
  }
  const crosses: number[] = [];
  const S = plan.sites;
  for (let s = 0; S && s < S.count; s++) {
    const f = siteFrame(plan, s);
    const arm = (S.kind[s] === SITE_KIND.town ? 5000 : 2000) / 2;
    for (const [ax, az] of [
      [1, 0],
      [0, 1],
    ] as const) {
      for (const k of [-1, 1]) {
        const p = sitePoint(f, k * arm * ax, k * arm * az);
        const r = R + Math.max(0, p.heightM) + 50;
        crosses.push(p.dir[0] * r, p.dir[1] * r, p.dir[2] * r);
      }
    }
  }
  const roads: number[] = [];
  if (plan.routes) {
    for (let l = L.kindStart[LINE_KIND.road]!; l < L.kindStart[LINE_KIND.deck + 1]!; l++) {
      for (let i = L.start[l]!; i + 1 < L.start[l + 1]!; i++) {
        for (const k of [i, i + 1]) {
          const r = R + Math.max(0, L.grade[k]!) + 30;
          roads.push(L.points[3 * k]! * r, L.points[3 * k + 1]! * r, L.points[3 * k + 2]! * r);
        }
      }
    }
  }
  return { rivers: perClass.map((c) => Float32Array.from(c)), pools: Float32Array.from(edges), sites: Float32Array.from(crosses), roads: Float32Array.from(roads) };
}

/** Panel lines per plan: built once from the plan's tables, read on every refresh of the panel. */
const routesLines = new WeakMap<WorldPlan, string>();
const sitesLines = new WeakMap<WorldPlan, string>();

/**
 * The part of the panel about the roads (stage 4), or null without them. Counted from the route and site
 * tables once per plan; it never samples the ground (the grades and clearances of `routeStats` stay out of the panel).
 */
export function routesLine(inh: Inhabited): string | null {
  const p = inh.plan();
  const rt = p?.routes;
  if (!p || !rt) return null;
  let line = routesLines.get(p);
  if (line === undefined) {
    const sites = p.sites?.count ?? 0;
    const joined = new Uint8Array(sites);
    for (let r = 0; r < rt.count; r++) {
      joined[rt.a[r]!] = 1;
      joined[rt.b[r]!] = 1;
    }
    let lone = 0;
    for (let s = 0; s < sites; s++) if (!joined[s]) lone++;
    const spans = rt.spans.deck.length;
    line = `Roads: ${groups(rt.count)} ${plural(rt.count, 'route')}, ${groups(spans)} ${plural(spans, 'bridge')}, ${groups(lone)} ${plural(lone, 'settlement')} without a road`;
    routesLines.set(p, line);
  }
  return line;
}

/**
 * Stage 4: the views of the roads: 20 km over the town with the marks and with the levels, at a gate of the town along
 * its road, on the steepest piece of road, at the longest deck and at the shortest, at a junction of three roads, and
 * from 400 km with the marks.
 */
export function routeViews(plan: WorldPlan, daylight?: (dir: Vec3) => number): PlanView[] {
  const rt = plan.routes;
  const S = plan.sites;
  if (!rt || !S || rt.count === 0) return [];
  const body = SURFACES[PLAN_BODY]!.name;
  const R = plan.grid.radiusM;
  const L = plan.lines;
  const view = (name: string, dir: Vec3, height: number, extra: Partial<PlanView> = {}): PlanView => {
    const [lat, lon] = latLonOf(dir);
    return { name, body, lat, lon, height, pitchDeg: 89, yawDeg: 0, map: false, ...extra, ...(daylight ? { time: daylight(dir) } : {}) };
  };
  const pointOf = (d: Vec3, h: number): Vec3 => [d[0] * (R + h), d[1] * (R + h), d[2] * (R + h)];
  const town: Vec3 = [S.dir[0]!, S.dir[1]!, S.dir[2]!];
  const views: PlanView[] = [view('world-roads-20km', town, 20_000, { map: true }), view('world-roads-levels', town, 20_000, { levels: true })];
  // At the gate of the first route that leaves the town (else route 0), looking 300 m along the road.
  let r0 = 0;
  for (let r = 0; r < rt.count; r++) {
    if (rt.a[r] === 0 || rt.b[r] === 0) {
      r0 = r;
      break;
    }
  }
  const fromTown = rt.a[r0] === 0 || rt.b[r0] !== 0;
  const len0 = rt.lengthM[r0]!;
  const g0 = routePoint(plan, r0, fromTown ? 0 : len0);
  const g1 = routePoint(plan, r0, fromTown ? 300 : len0 - 300);
  views.push(view('world-road-gate', g0.dir, g0.heightM + 8, { pitchDeg: 10, toward: pointOf(g1.dir, g1.heightM + 2) }));
  // The steepest piece of any road line.
  let steep = -1;
  let steepP = 0;
  let steepG = -1;
  for (let l = L.kindStart[LINE_KIND.road]!; l < L.kindStart[LINE_KIND.road + 1]!; l++) {
    for (let p = L.start[l]!; p + 1 < L.start[l + 1]!; p++) {
      const dx = L.points[3 * p + 3]! - L.points[3 * p]!;
      const dy = L.points[3 * p + 4]! - L.points[3 * p + 1]!;
      const dz = L.points[3 * p + 5]! - L.points[3 * p + 2]!;
      const m = Math.sqrt(dx * dx + dy * dy + dz * dz) * R;
      const g = m > 0 ? Math.abs(L.grade[p + 1]! - L.grade[p]!) / m : 0;
      if (g > steepG) {
        steepG = g;
        steep = l;
        steepP = p;
      }
    }
  }
  if (steep >= 0) {
    const d: Vec3 = [L.points[3 * steepP]!, L.points[3 * steepP + 1]!, L.points[3 * steepP + 2]!];
    const e: Vec3 = [L.points[3 * steepP + 3]!, L.points[3 * steepP + 4]!, L.points[3 * steepP + 5]!];
    views.push(view('world-road-slope', d, L.grade[steepP]! + 40, { pitchDeg: 20, toward: pointOf(e, L.grade[steepP + 1]!) }));
  }
  // The longest and the shortest deck, seen from 60 m off its middle at its height.
  const n = rt.spans.deck.length;
  if (n > 0) {
    const e = rt.spans.ends;
    const spanM = (i: number): number => Math.sqrt((e[8 * i]! - e[8 * i + 4]!) ** 2 + (e[8 * i + 1]! - e[8 * i + 5]!) ** 2 + (e[8 * i + 2]! - e[8 * i + 6]!) ** 2) * R;
    let long = 0;
    let short = 0;
    for (let i = 1; i < n; i++) {
      if (spanM(i) > spanM(long)) long = i;
      if (spanM(i) < spanM(short)) short = i;
    }
    const deckView = (name: string, i: number): PlanView => {
      const mx = (e[8 * i]! + e[8 * i + 4]!) / 2;
      const my = (e[8 * i + 1]! + e[8 * i + 5]!) / 2;
      const mz = (e[8 * i + 2]! + e[8 * i + 6]!) / 2;
      const ml = Math.sqrt(mx * mx + my * my + mz * mz);
      const mid: Vec3 = [mx / ml, my / ml, mz / ml];
      // Off to the side: across the deck, 60 m.
      const ax = e[8 * i + 4]! - e[8 * i]!;
      const ay = e[8 * i + 5]! - e[8 * i + 1]!;
      const az = e[8 * i + 6]! - e[8 * i + 2]!;
      let sx = ay * mid[2] - az * mid[1];
      let sy = az * mid[0] - ax * mid[2];
      let sz = ax * mid[1] - ay * mid[0];
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      sx = (sx / sl) * (60 / R);
      sy = (sy / sl) * (60 / R);
      sz = (sz / sl) * (60 / R);
      const ol = Math.sqrt((mid[0] + sx) ** 2 + (mid[1] + sy) ** 2 + (mid[2] + sz) ** 2);
      const off: Vec3 = [(mid[0] + sx) / ol, (mid[1] + sy) / ol, (mid[2] + sz) / ol];
      const h = (e[8 * i + 3]! + e[8 * i + 7]!) / 2;
      return view(name, off, h + 12, { pitchDeg: 15, toward: pointOf(mid, h) });
    };
    views.push(deckView('world-deck', long));
    if (n > 1) views.push(deckView('world-deck-small', short));
  }
  // A junction: the first node (stage 4) that three or more road lines meet at.
  const meets = new Map<number, number>();
  for (let l = L.kindStart[LINE_KIND.road]!; l < L.kindStart[LINE_KIND.deck + 1]!; l++) {
    for (const k of [L.from[l]!, L.to[l]!]) if (k >= 0) meets.set(k, (meets.get(k) ?? 0) + 1);
  }
  let junction = -1;
  for (let k = 0; k < L.nodes.length / 4; k++) {
    if ((meets.get(k) ?? 0) >= 3) {
      junction = k;
      break;
    }
  }
  if (junction >= 0) {
    const d: Vec3 = [L.nodes[4 * junction]!, L.nodes[4 * junction + 1]!, L.nodes[4 * junction + 2]!];
    views.push(view('world-junction', d, L.nodes[4 * junction + 3]! + 150, { pitchDeg: 70 }));
  }
  views.push(view('world-roads-map', town, 400_000, { map: true }));
  return views;
}

/** The part of the panel about the settlements (stage 3), or null without them. */
export function sitesLine(inh: Inhabited): string | null {
  const p = inh.plan();
  const S = p?.sites;
  if (!p || !S) return null;
  const cached = sitesLines.get(p);
  if (cached !== undefined) return cached;
  let towns = 0;
  for (let s = 0; s < S.count; s++) if (S.kind[s] === SITE_KIND.town) towns++;
  const villages = S.count - towns;
  const v = `${groups(villages)} ${plural(villages, 'village')}`;
  const line = `Settlements: ${groups(S.count)} (${towns > 0 ? `a town and ${v}` : v}) · G next settlement`;
  sitesLines.set(p, line);
  return line;
}

/**
 * Stage 3: the views of the settlements, from the plan: from orbit and 400 km up with the marks, the town 20 km and
 * 1 km away, a village 1 km away, low along one of its lanes, at the edge of its pad, and over it with the levels.
 */
export function siteViews(plan: WorldPlan, daylight?: (dir: Vec3) => number): PlanView[] {
  const S = plan.sites;
  if (!S || S.count === 0) return [];
  const body = SURFACES[PLAN_BODY]!.name;
  const R = plan.grid.radiusM;
  const view = (name: string, dir: Vec3, height: number, extra: Partial<PlanView> = {}): PlanView => {
    const [lat, lon] = latLonOf(dir);
    return { name, body, lat, lon, height, pitchDeg: 89, yawDeg: 0, map: false, ...extra, ...(daylight ? { time: daylight(dir) } : {}) };
  };
  const at = (s: number, x: number, z: number, up = 0): { dir: Vec3; point: Vec3 } => {
    const p = sitePoint(siteFrame(plan, s), x, z);
    const r = R + p.heightM + up;
    return { dir: p.dir, point: [p.dir[0] * r, p.dir[1] * r, p.dir[2] * r] };
  };
  const town = 0;
  // A village: the one nearest to the town (site 1 when there is a town, else site 0).
  const village = S.count > 1 ? 1 : 0;
  const rt = S.radiusM[town]!;
  const rv = S.radiusM[village]!;
  const views: PlanView[] = [
    view('world-sites-orbit', at(town, 0, 0).dir, 4 * R, { map: true, lookAtBody: true }),
    view('world-sites-map', at(town, 0, 0).dir, 400_000, { map: true }),
    view('world-sites-20km', at(town, 0, 0).dir, 20_000),
    view('world-town-1km', at(town, 0, -rt - 600).dir, 1000, { pitchDeg: 35, toward: at(town, 0, 0).point }),
    view('world-village-1km', at(village, 0, -rv - 700).dir, 1000, { pitchDeg: 35, toward: at(village, 0, 0).point }),
  ];
  // Low along a lane of the village: from its outer end toward the centre.
  const L = plan.lines;
  for (let l = L.kindStart[LINE_KIND.lane]!; l < L.kindStart[LINE_KIND.lane + 1]!; l++) {
    if (L.owner[l] !== village || L.to[l]! < 0) continue;
    const k = L.start[l + 1]! - 1;
    const d: Vec3 = [L.points[3 * k]!, L.points[3 * k + 1]!, L.points[3 * k + 2]!];
    views.push(view('world-village-lane', d, 12, { pitchDeg: 10, toward: at(village, 0, 0, 4).point }));
    break;
  }
  views.push(view('world-pad-edge', at(village, rv + 20, 0).dir, 25, { pitchDeg: 15, toward: at(village, 0, 0).point }));
  views.push(view('world-village-levels', at(village, 0, 0).dir, 3000, { pitchDeg: 60, levels: true }));
  return views;
}

/**
 * The views of the structures (structures.ts): the lowest-index village from about 1 km, along its first lot at eye
 * height, from 6 km, the town with its ring, and a village on another face of the cube than the first.
 */
export function structureViews(plan: WorldPlan, daylight?: (dir: Vec3) => number): PlanView[] {
  const S = plan.sites;
  if (!S || S.count === 0) return [];
  const body = SURFACES[PLAN_BODY]!.name;
  const R = plan.grid.radiusM;
  const view = (name: string, dir: Vec3, height: number, extra: Partial<PlanView> = {}): PlanView => {
    const [lat, lon] = latLonOf(dir);
    return { name, body, lat, lon, height, pitchDeg: 89, yawDeg: 0, map: false, ...extra, ...(daylight ? { time: daylight(dir) } : {}) };
  };
  const at = (s: number, x: number, z: number, up = 0): { dir: Vec3; point: Vec3 } => {
    const p = sitePoint(siteFrame(plan, s), x, z);
    const r = R + p.heightM + up;
    return { dir: p.dir, point: [p.dir[0] * r, p.dir[1] * r, p.dir[2] * r] };
  };
  const villages: number[] = [];
  for (let s = 0; s < S.count; s++) if (S.kind[s] === SITE_KIND.village) villages.push(s);
  // Spans (stage 4): the middle of each deck, its heading and length.
  const spans: { mid: { dir: Vec3; heightM: number; heading: Vec3 }; lengthM: number }[] = [];
  const sp = plan.routes?.spans;
  for (let i = 0; sp && i < sp.deck.length; i++) {
    const lengthM = laneLengthM(plan, sp.deck[i]!);
    spans.push({ mid: lanePoint(plan, sp.deck[i]!, lengthM / 2), lengthM });
  }
  const spanNear = (s: number): boolean => {
    const c = [S.dir[3 * s]! * R, S.dir[3 * s + 1]! * R, S.dir[3 * s + 2]! * R];
    return spans.some((p) => Math.sqrt((p.mid.dir[0] * R - c[0]!) ** 2 + (p.mid.dir[1] * R - c[1]!) ** 2 + (p.mid.dir[2] * R - c[2]!) ** 2) < 500);
  };
  // The lowest-index village with a span within 500 m of its centre, else the lowest-index village.
  const v = villages.find(spanNear) ?? villages[0] ?? 0;
  const rv = S.radiusM[v]!;
  const face = (s: number): number => {
    const d = [S.dir[3 * s]!, S.dir[3 * s + 1]!, S.dir[3 * s + 2]!];
    let k = 0;
    for (let i = 1; i < 3; i++) if (Math.abs(d[i]!) > Math.abs(d[k]!)) k = i;
    return 2 * k + (d[k]! < 0 ? 1 : 0);
  };
  const views: PlanView[] = [view('world-village', at(v, 0, -rv - 500).dir, 700, { pitchDeg: 35, toward: at(v, 0, 0).point })];
  const lot = settlementOf(plan, v).lots[0];
  if (lot) {
    const out = lot.depthM / 2 + 6;
    views.push(view('world-lane', at(v, lot.x + lot.hx * out + lot.hz * 6, lot.z + lot.hz * out - lot.hx * 6).dir, 1.7, { pitchDeg: 5, toward: at(v, lot.x, lot.z, 3).point }));
  }
  views.push(view('world-village-far', at(v, 0, -rv - 4000).dir, 4000, { pitchDeg: 35, toward: at(v, 0, 0).point }));
  const town = S.kind.indexOf(SITE_KIND.town);
  if (town >= 0) {
    // From outside the walls: 220 m out from the first tower of the ring and 60 m to its side, 25 m up, looking at
    // the tower's middle, so the tower and the walls on both sides of it are in frame. No tower: the old slant view.
    const tower = clusterRecipes(plan, town).find((r) => r.kind === STRUCTURE_KIND.tower && r.key % KEY_ITEMS >= settlementOf(plan, town).lots.length);
    if (tower) {
      const fr = tower.frame;
      const o = fr.origin;
      const e: Vec3 = [o[0] * R - fr.z[0] * 220 + fr.x[0] * 60, o[1] * R - fr.z[1] * 220 + fr.x[1] * 60, o[2] * R - fr.z[2] * 220 + fr.x[2] * 60];
      const l = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
      const r = R + fr.heightM + 9;
      views.push(view('world-town', [e[0] / l, e[1] / l, e[2] / l], 25, { pitchDeg: 5, toward: [o[0] * r, o[1] * r, o[2] * r] }));
    } else views.push(view('world-town', at(town, 0, -S.radiusM[town]! - 350).dir, 250, { pitchDeg: 30, toward: at(town, 0, 0).point }));
  }
  // A span from the bank: 70 m to the side of the middle of its deck, 12 m up, looking at the deck (the one nearest the village above).
  if (spans.length > 0) {
    const c: Vec3 = [S.dir[3 * v]!, S.dir[3 * v + 1]!, S.dir[3 * v + 2]!];
    let k = 0;
    const away = (i: number): number => 1 - (spans[i]!.mid.dir[0] * c[0] + spans[i]!.mid.dir[1] * c[1] + spans[i]!.mid.dir[2] * c[2]);
    for (let i = 1; i < spans.length; i++) if (away(i) < away(k)) k = i;
    const m = spans[k]!.mid;
    const d = m.dir;
    const h = m.heading;
    const side: Vec3 = [h[1] * d[2] - h[2] * d[1], h[2] * d[0] - h[0] * d[2], h[0] * d[1] - h[1] * d[0]];
    const e: Vec3 = [d[0] * R + side[0] * 70 + h[0] * 25, d[1] * R + side[1] * 70 + h[1] * 25, d[2] * R + side[2] * 70 + h[2] * 25];
    const l = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
    const r = R + m.heightM - 1;
    views.push(view('world-span', [e[0] / l, e[1] / l, e[2] / l], 12, { pitchDeg: 5, toward: [d[0] * r, d[1] * r, d[2] * r] }));
  }
  const b = villages.find((s) => face(s) !== face(v));
  if (b !== undefined) views.push(view('world-village-b', at(b, 0, -S.radiusM[b]! - 500).dir, 700, { pitchDeg: 35, toward: at(b, 0, 0).point }));
  return views;
}

/** A view of the script interface (the fields `__wh.setView` reads). */
export interface PlanView {
  name: string;
  body: string;
  lat: number;
  lon: number;
  height: number;
  pitchDeg: number;
  yawDeg: number;
  lookAtBody?: boolean;
  time?: number;
  /** Whether the marks of the plan are drawn. */
  map: boolean;
  /** A point to look at, metres in the body's own frame (instead of `yawDeg` and `pitchDeg`). */
  toward?: Vec3;
  /** Tint the cells by level. */
  levels?: boolean;
  /** Show the shade of the relief alone (grey), stage 5. */
  shadeView?: boolean;
  /** A pose of the flight along the river, 0–1 (the place above is then only where it starts). */
  riverFlight?: number;
}

/**
 * The views of the plan: from orbit over the mouth with the largest flow (with and without the marks), 20 km over that
 * mouth and over the largest lake, 60 km over a river that crosses an edge of the cube. `daylight` gives a time of the
 * system with the sun high over a direction; without it the views have no time.
 */
export function planViews(plan: WorldPlan, daylight?: (dir: Vec3) => number): PlanView[] {
  const body = SURFACES[PLAN_BODY]!.name;
  const R = plan.grid.radiusM;
  const L = plan.lines;
  const point = (k: number): Vec3 => [L.points[3 * k]!, L.points[3 * k + 1]!, L.points[3 * k + 2]!];
  // The mouth into the sea with the widest river.
  let mouth: Vec3 = [0, 0, 1];
  let widest = -1;
  const riverEnd = L.kindStart[LINE_KIND.river + 1]!;
  for (let l = 0; l < riverEnd; l++) {
    if (L.to[l] !== -1) continue;
    const k = L.start[l + 1]! - 1;
    const p = point(k);
    if (plan.pool[gridNodeAt(plan.grid, p[0], p[1], p[2])] !== 0) continue;
    if (L.halfWidth[k]! > widest) {
      widest = L.halfWidth[k]!;
      mouth = p;
    }
  }
  // The lake with the most nodes, at the mean direction of its nodes.
  let lake: Vec3 = mouth;
  if (plan.pools.nodes.length > 0) {
    let big = 0;
    for (let k = 1; k < plan.pools.nodes.length; k++) if (plan.pools.nodes[k]! > plan.pools.nodes[big]!) big = k;
    const sum: Vec3 = [0, 0, 0];
    const d: Vec3 = [0, 0, 0];
    for (let i = 0; i < plan.grid.count; i++) {
      if (plan.pool[i] !== big + 1) continue;
      gridDirection(plan.grid, i, d);
      sum[0] += d[0];
      sum[1] += d[1];
      sum[2] += d[2];
    }
    const l = Math.sqrt(sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]);
    if (l > 0) lake = [sum[0] / l, sum[1] / l, sum[2] / l];
  }
  // A river over an edge of the cube: the first of class 0 or 1, else the widest that crosses one.
  let edge: Vec3 | null = null;
  let edgeWidth = -1;
  for (let l = 0; l < riverEnd; l++) {
    for (let k = L.start[l]!; k + 1 < L.start[l + 1]!; k++) {
      if (cubeFaceOf(point(k)).face === cubeFaceOf(point(k + 1)).face) continue;
      const w = L.cls[l]! <= 1 ? Infinity : L.halfWidth[k]!;
      if (w > edgeWidth) {
        edgeWidth = w;
        edge = point(k);
      }
      break;
    }
    if (edgeWidth === Infinity) break;
  }
  const view = (name: string, dir: Vec3, height: number, map: boolean, lookAtBody = false): PlanView => {
    const [lat, lon] = latLonOf(dir);
    return { name, body, lat, lon, height, pitchDeg: 89, yawDeg: 0, map, ...(lookAtBody ? { lookAtBody } : {}), ...(daylight ? { time: daylight(dir) } : {}) };
  };
  return [
    view('world-orbit', mouth, 4 * R, true, true),
    view('world-orbit-plain', mouth, 4 * R, false, true),
    view('world-mouth-20km', mouth, 20_000, true),
    view('world-pool-20km', lake, 20_000, true),
    view('world-edge-60km', edge ?? mouth, 60_000, true),
  ];
}

/**
 * A time of the system within one turn of `body` (from 0) at which the sun stands highest over the direction `dir` of
 * its turning frame. Moves the time of `system`; the caller puts it back.
 */
export function daylightTime(system: BodySystem, body: Body, dir: Vec3): number {
  const period = Math.abs(body.spin.periodS) || 86_400;
  const sun = system.bodies[0]!;
  const STEPS = 96;
  let best = 0;
  let bestUp = -2;
  for (let i = 0; i < STEPS; i++) {
    const t = (i * period) / STEPS;
    system.setTime(t);
    const s = system.frames.convertPoint([0, 0, 0], sun.carriedFrame, body.turningFrame);
    const l = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
    const up = (s[0] * dir[0] + s[1] * dir[1] + s[2] * dir[2]) / l;
    if (up > bestUp) {
      bestUp = up;
      best = t;
    }
  }
  return best;
}

// --- Stage 1 on the page: the planned cells, the surface for the camera, the flight along the river -----------------

/** An error the streaming takes for a cancelled request. */
function aborted(): Error {
  const e = new Error('cell request cancelled');
  e.name = 'AbortError';
  return e;
}

/** What the page needs of the planned body once the plan is there. */
export interface PlannedBody {
  /** Cells of the planned body: they wait for the plan, then come from `generateWorldCell` (a `cell` job or here). */
  provider: CellProvider;
  /** The six coarsest planned cells, for the body from afar and for the streaming; resolves after the plan. */
  roots: Promise<CellContent[]>;
  /** What is seen at a point of the base sphere, the level of a river included; null before the plan. */
  surfaceAt(x: number, y: number, z: number): number | null;
  /** The main stem of the plan, null before it. */
  stem(): RiverStem | null;
  /** Kilometres of river lines in the plan, 0 before it. */
  riverKm(): number;
}

/** The planned body of `inh` on the page. `name` is the provider's name in the panel. */
export function plannedBody(inh: Inhabited, o: { pool: WorkerPool | null; packed: number; name: string }): PlannedBody {
  const { pool, packed } = o;
  const stage = inh.stage;
  let scope: Scope | null = null;
  let stem: RiverStem | null = null;
  let km = 0;
  const ready = inh.whenReady.then(
    () => true,
    () => false,
  );
  /** One cell: with the plan from it, without it (the plan failed) the plain generator. */
  const generate = async (cell: CellId, signal: AbortSignal | null): Promise<CellContent> => {
    const ok = await ready;
    if (signal?.aborted) throw aborted();
    const plan = inh.plan();
    const id = { face: cell.face, level: cell.level, x: cell.x, y: cell.y };
    if (!pool) return ok && plan ? generateWorldCell(packed, Object.freeze(id), plan, stage) : generateBodyCell(packed, Object.freeze(id));
    const job = pool.run<ArrayBuffer>(ok && plan ? { kind: 'cell', seed: packed, cell: id, stage } : { seed: packed, cell: id });
    const onAbort = (): void => job.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return decodeCell(new Uint8Array(await job.promise));
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
  const roots = Promise.all([0, 1, 2, 3, 4, 5].map((face) => generate(cellId(face, ROOT_LEVEL, 0, 0), null)));
  void ready.then((ok) => {
    const plan = inh.plan();
    if (!ok || !plan) return;
    scope = planScope(plan, stage, null);
    stem = mainStem(plan);
    const L = plan.lines;
    const R = plan.grid.radiusM;
    let m = 0;
    for (let l = L.kindStart[LINE_KIND.river]!; l < L.kindStart[LINE_KIND.river + 1]!; l++) {
      for (let k = L.start[l]!; k + 1 < L.start[l + 1]!; k++) {
        const dx = L.points[3 * k + 3]! - L.points[3 * k]!;
        const dy = L.points[3 * k + 4]! - L.points[3 * k + 1]!;
        const dz = L.points[3 * k + 5]! - L.points[3 * k + 2]!;
        m += Math.sqrt(dx * dx + dy * dy + dz * dz) * R;
      }
    }
    km = m / 1000;
  });
  return {
    provider: {
      name: o.name,
      blocking: false,
      async request(cell: CellId, signal: AbortSignal): Promise<CellResult> {
        if (cell.level === ROOT_LEVEL) return { content: (await roots)[cell.face]!, bytes: null, origin: 'memory' };
        return { content: await generate(cell, signal), bytes: null, origin: 'generated' };
      },
    },
    roots,
    surfaceAt: (x, y, z) => {
      if (!scope) return null;
      const w = planWater(scope, x, y, z);
      const s = planSurface(scope, x, y, z);
      return w.kind === 3 ? Math.max(s, w.levelM) : s;
    },
    stem: () => stem,
    riverKm: () => km,
  };
}

/** The line of the panel about the world: its stage, kilometres of rivers and the number of lakes. */
export function worldLine(inh: Inhabited, body: PlannedBody): string {
  const r = inh.report();
  const lakes = r ? r.pools : 0;
  return `world   stage ${inh.stage} · ${groups(body.riverKm())} km of rivers · ${groups(lakes)} ${plural(lakes, 'lake')}`;
}

/** A pose of the flight along the river for `t01`, or null before the plan. */
export function riverPose(body: PlannedBody, t01: number): RiverFlightPose | null {
  const s = body.stem();
  return s && s.lengthM > 0 ? riverFlightPose(s, t01) : null;
}

/**
 * The views of stage 1, computed from the plan: along the main stem (20 km over it, its spring, low over its widest
 * part, its first confluence, its mouth), a lake with an inlet and an outlet, a river over an edge of the cube with
 * the levels tinted, and eight poses of the flight.
 */
export function waterViews(plan: WorldPlan, stem: RiverStem, daylight?: (dir: Vec3) => number): PlanView[] {
  const body = SURFACES[PLAN_BODY]!.name;
  const R = plan.grid.radiusM;
  const L = plan.lines;
  const P = stem.points;
  const n = stem.levels.length;
  const dirAt = (i: number): Vec3 => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!];
  const along = (from: number, metres: number): number => {
    let i = from;
    while (i + 1 < n && stem.along[i]! - stem.along[from]! < metres) i++;
    return i;
  };
  const toward = (d: Vec3, h: number): Vec3 => [d[0] * (R + h), d[1] * (R + h), d[2] * (R + h)];
  const view = (name: string, dir: Vec3, height: number, extra: Partial<PlanView> = {}): PlanView => {
    const [lat, lon] = latLonOf(dir);
    return { name, body, lat, lon, height, pitchDeg: 89, yawDeg: 0, map: false, ...extra, ...(daylight ? { time: daylight(dir) } : {}) };
  };
  const views: PlanView[] = [];
  if (n >= 2) {
    const mid = along(0, stem.lengthM / 2);
    views.push(view('world-river-20km', dirAt(mid), 20_000));
    const s1 = along(0, 400);
    views.push(view('world-spring', dirAt(0), 60, { pitchDeg: 20, toward: toward(dirAt(s1), stem.levels[s1]!) }));
    // The widest point of the stem: the end of its last line of the lowest class.
    let wide = Math.max(0, n - 2);
    for (let i = n - 1; i >= 0; i--) {
      if (stem.levels[i]! > 2) {
        wide = Math.max(0, i - 4);
        break;
      }
    }
    const w1 = along(wide, 300);
    views.push(view('world-river-low', dirAt(wide), 30, { pitchDeg: 15, toward: toward(dirAt(w1), stem.levels[w1]!) }));
    // The first confluence on the stem: a node where two lines end.
    const ends = new Map<number, number>();
    for (let l = 0; l < L.to.length; l++) if (L.to[l]! >= 0) ends.set(L.to[l]!, (ends.get(L.to[l]!) ?? 0) + 1);
    let conf: Vec3 | null = null;
    for (const l of stem.lines) {
      const t = L.to[l]!;
      if (t >= 0 && (ends.get(t) ?? 0) >= 2) {
        conf = [L.nodes[4 * t]!, L.nodes[4 * t + 1]!, L.nodes[4 * t + 2]!];
        break;
      }
    }
    if (conf) views.push(view('world-confluence', conf, 300));
    const m0 = Math.max(0, n - 4);
    const mouth = dirAt(n - 1);
    const back = dirAt(m0);
    // Past the mouth: on along the last part of the stem, over the sea.
    const past: Vec3 = [mouth[0] * 2 - back[0], mouth[1] * 2 - back[1], mouth[2] * 2 - back[2]];
    views.push(view('world-mouth', back, 500, { pitchDeg: 30, toward: toward(past, 0) }));
  }
  // The largest lake with an inlet and an outlet (at least 12 nodes), seen from its outlet and over its shore.
  let lake = -1;
  for (let k = 0; k < plan.pools.nodes.length; k++) {
    if (plan.pools.nodes[k]! < 12 || plan.pools.outlet[k]! < 0) continue;
    if (lake < 0 || plan.pools.nodes[k]! > plan.pools.nodes[lake]!) lake = k;
  }
  if (lake >= 0) {
    const sum: Vec3 = [0, 0, 0];
    const d: Vec3 = [0, 0, 0];
    for (let i = 0; i < plan.grid.count; i++) {
      if (plan.pool[i] !== lake + 1) continue;
      gridDirection(plan.grid, i, d);
      sum[0] += d[0];
      sum[1] += d[1];
      sum[2] += d[2];
    }
    const l = Math.sqrt(sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]) || 1;
    const centre: Vec3 = [sum[0] / l, sum[1] / l, sum[2] / l];
    const out = gridDirection(plan.grid, plan.pools.outlet[lake]!, [0, 0, 0]) as Vec3;
    const level = plan.pools.level[lake]!;
    views.push(view('world-lake', out, 400, { pitchDeg: 35, toward: toward(centre, level) }));
    // The river that leaves the lake: the point of a river line nearest to the outlet, and three points on.
    let away: Vec3 | null = null;
    let best = Infinity;
    let bestK = -1;
    const riverEnd = L.kindStart[LINE_KIND.river + 1]!;
    for (let k = 0; k < L.start[riverEnd]!; k++) {
      const dx = L.points[3 * k]! - out[0];
      const dy = L.points[3 * k + 1]! - out[1];
      const dz = L.points[3 * k + 2]! - out[2];
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < best) {
        best = dd;
        bestK = k;
      }
    }
    if (bestK >= 0) {
      let li = 0;
      while (L.start[li + 1]! <= bestK) li++;
      const e = Math.min(L.start[li + 1]! - 1, bestK + 3);
      away = [L.points[3 * e]!, L.points[3 * e + 1]!, L.points[3 * e + 2]!];
    }
    views.push(view('world-outlet', out, 150, { pitchDeg: 30, toward: toward(away ?? centre, level) }));
  }
  views.push(...shoreViews(plan, view, toward));
  // A river over an edge of the cube, with the levels tinted.
  for (let li = 0; li < L.from.length && views.every((v) => v.name !== 'world-edge-levels'); li++) {
    if (L.cls[li]! > 1) continue;
    for (let k = L.start[li]!; k + 1 < L.start[li + 1]!; k++) {
      const a: Vec3 = [L.points[3 * k]!, L.points[3 * k + 1]!, L.points[3 * k + 2]!];
      const b: Vec3 = [L.points[3 * k + 3]!, L.points[3 * k + 4]!, L.points[3 * k + 5]!];
      if (cubeFaceOf(a).face !== cubeFaceOf(b).face) {
        views.push(view('world-edge-levels', a, 3000, { pitchDeg: 60, levels: true }));
        break;
      }
    }
  }
  for (let k = 0; k < 8; k++) views.push(view(`world-flight-${k}`, n > 0 ? dirAt(0) : [0, 1, 0], 1000, { riverFlight: k / 7 }));
  return views;
}

/**
 * The views of water as one surface: straight down from 1.5 km on the first lake of at least 12 nodes, 2 m above its
 * shore along it, a river running into it from 200 m, 2 m above a sea shore along it, and the highest dam of the lake
 * rule (plan-lakes.ts) over the lakes of at least 12 nodes. A view whose place is not found is left out.
 */
function shoreViews(plan: WorldPlan, view: (name: string, dir: Vec3, height: number, extra?: Partial<PlanView>) => PlanView, toward: (d: Vec3, h: number) => Vec3): PlanView[] {
  const out: PlanView[] = [];
  const R = plan.grid.radiusM;
  const L = plan.lines;
  const scope = planScope(plan, STAGE.water, null);
  const depthAt = (d: Vec3): number => planWater(scope, d[0] * R, d[1] * R, d[2] * R).depthM;
  const dirOf = (i: number): Vec3 => gridDirection(plan.grid, i, [0, 0, 0]) as Vec3;
  const unitOf = (x: number, y: number, z: number): Vec3 => {
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / l, y / l, z / l];
  };
  const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => unitOf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  // The waterline between a wet direction and a dry one: the first of 64 steps on the way that is dry.
  const shoreBetween = (wet: Vec3, dry: Vec3): Vec3 | null => {
    if (!(depthAt(wet) > 0)) return null;
    for (let s = 1; s <= 64; s++) {
      const p = lerp(wet, dry, s / 64);
      if (!(depthAt(p) > 0)) return p;
    }
    return null;
  };
  // A point `metres` along the shore from `at`, square to the way toward the water.
  const alongShore = (at: Vec3, wet: Vec3, metres: number): Vec3 => {
    const ix = wet[0] - at[0];
    const iy = wet[1] - at[1];
    const iz = wet[2] - at[2];
    const c = unitOf(at[1] * iz - at[2] * iy, at[2] * ix - at[0] * iz, at[0] * iy - at[1] * ix);
    const k = metres / R;
    return unitOf(at[0] + c[0] * k, at[1] + c[1] * k, at[2] + c[2] * k);
  };
  const nb = new Int32Array(8);
  const count = plan.grid.count;
  // The first lake of at least 12 nodes.
  let lake = -1;
  for (let k = 0; k < plan.pools.nodes.length && lake < 0; k++) if (plan.pools.nodes[k]! >= 12) lake = k;
  if (lake >= 0) {
    const level = plan.pools.level[lake]!;
    const sum: Vec3 = [0, 0, 0];
    let edgeWet = -1;
    let edgeDry = -1;
    for (let i = 0; i < count; i++) {
      if (plan.pool[i] !== lake + 1) continue;
      const d = dirOf(i);
      sum[0] += d[0];
      sum[1] += d[1];
      sum[2] += d[2];
      if (edgeWet >= 0) continue;
      const k = gridNeighbours(plan.grid, i, nb);
      for (let j = 0; j < k && edgeWet < 0; j++) {
        if (plan.pool[nb[j]!] === 0) {
          edgeWet = i;
          edgeDry = nb[j]!;
        }
      }
    }
    out.push(view('world-lake-top', unitOf(sum[0], sum[1], sum[2]), 1500));
    const shore = edgeWet >= 0 ? shoreBetween(dirOf(edgeWet), dirOf(edgeDry)) : null;
    if (shore) out.push(view('world-shore-low', shore, 2, { pitchDeg: 5, toward: toward(alongShore(shore, dirOf(edgeWet), 300), level) }));
    // An inlet: the first point of a river line that is dry, followed by one in the water of this lake.
    const riverEnd = L.kindStart[LINE_KIND.river + 1]!;
    let inlet: [Vec3, Vec3] | null = null;
    for (let l = 0; l < riverEnd && !inlet; l++) {
      for (let k = L.start[l]!; k + 1 < L.start[l + 1]!; k++) {
        const b: Vec3 = [L.points[3 * k + 3]!, L.points[3 * k + 4]!, L.points[3 * k + 5]!];
        if (plan.pool[gridNodeAt(plan.grid, b[0], b[1], b[2])] !== lake + 1) continue;
        const a: Vec3 = [L.points[3 * k]!, L.points[3 * k + 1]!, L.points[3 * k + 2]!];
        if (depthAt(a) > 0 || !(depthAt(b) > 0)) continue;
        const e = Math.max(L.start[l]!, k - 3);
        inlet = [[L.points[3 * e]!, L.points[3 * e + 1]!, L.points[3 * e + 2]!], b];
        break;
      }
    }
    if (inlet) out.push(view('world-inlet', inlet[0], 200, { pitchDeg: 35, toward: toward(inlet[1], level) }));
  }
  // A sea shore: the first base node with a neighbour of land at least 2 m high.
  let coast: Vec3 | null = null;
  let coastWet: Vec3 | null = null;
  for (let i = 0; i < count && !coast; i++) {
    if (plan.relief[i]! > 0 || plan.pool[i] !== 0) continue;
    const k = gridNeighbours(plan.grid, i, nb);
    for (let j = 0; j < k; j++) {
      const q = nb[j]!;
      if (plan.pool[q] !== 0 || plan.relief[q]! < 4) continue;
      const s = shoreBetween(dirOf(i), dirOf(q));
      if (s) {
        coast = s;
        coastWet = dirOf(i);
      }
      break;
    }
  }
  if (coast && coastWet) out.push(view('world-coast-low', coast, 2, { pitchDeg: 5, toward: toward(alongShore(coast, coastWet, 300), 0) }));
  // The highest dam: the lake rule's rise over the own ground, five points on every way out of a lake of 12 nodes or more.
  const here = lakeHere();
  const bend = lakeBendSeed(plan.seed);
  let damM = 0;
  let dam: [Vec3, Vec3, number] | null = null;
  for (let i = 0; i < count; i++) {
    const p = plan.pool[i]!;
    if (p === 0 || plan.pools.nodes[p - 1]! < 12) continue;
    const k = gridNeighbours(plan.grid, i, nb);
    for (let j = 0; j < k; j++) {
      const q = nb[j]!;
      if (plan.pool[q] !== 0) continue;
      for (let s = 1; s <= 5; s++) {
        const at = lerp(dirOf(i), dirOf(q), s / 6);
        const own = groundHeight(plan.seed, at[0] * R, at[1] * R, at[2] * R);
        const rise = lakeBed(lakeAt(plan, bend, at[0] * R, at[1] * R, at[2] * R, here), own) - own;
        if (rise > damM) {
          damM = rise;
          dam = [at, dirOf(q), plan.pools.level[p - 1]!];
        }
      }
    }
  }
  if (dam) out.push(view('world-leak', dam[1], 60, { pitchDeg: 20, toward: toward(dam[0], dam[2]) }));
  return out;
}
