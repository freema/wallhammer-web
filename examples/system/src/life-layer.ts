// The creatures of Hearth on the page (NSO-714): who walks where comes from life.ts, how each kind looks from
// creatures.ts, and the engine's `RigLayer` poses and draws them. Per frame with the eye on Hearth: the near set of
// sites and routes (rebuilt after the eye moved 50 m), the poses within `LIFE_RADIUS_M` at the system's time, their
// records in render space (the body's frame minus the render origin; up is radial there, so the heading is written in
// the local frame of each creature's own up).

import { toFramePlane, upFrame, writeRigInstance } from 'wallhammer-web/base';
import type { RigInstance, Vec3 } from 'wallhammer-web/base';
import { RigLayer } from 'wallhammer-web/render';
import type { Layer } from 'wallhammer-web/render';
import type { Engine } from 'wallhammer-web/runtime';
import { SURFACES } from './bodies.ts';
import { CREATURE, CREATURE_CAP, creatureLook, creatureRigs } from './creatures.ts';
import type { CreatureLook } from './creatures.ts';
import type { PlanView } from './inhabited.ts';
import { LIFE_MAX, lifeNear, lifeSet, newPose, routeWalks, siteStands, siteWalks, walkPose } from './life.ts';
import type { LifePose, LifeSet, Walk } from './life.ts';
import { PLAN_BODY, SITE_KIND, STAGE } from './plan.ts';
import type { WorldPlan } from './plan.ts';
import { siteFrame, sitePoint } from './settlement.ts';
import { latLonOf } from './world.ts';

/** The eye moves this far before the near set of sites and routes is taken again, m. */
const RESET_M = 50;
/** Looks kept per kind before the cache is emptied. */
const LOOK_CACHE = 4096;

export interface LifeStats {
  /** Drawn near (animated) and far (still), left out as too small on screen. */
  near: number;
  far: number;
  hidden: number;
  /** Records made this frame, and poses left out by the ceilings per kind and in all. */
  made: number;
  capped: number;
  /** Milliseconds of the poses and records this frame. */
  logicMs: number;
  /** Near sites and routes. */
  sites: number;
  routes: number;
}

export interface Life {
  readonly layer: RigLayer;
  /** Once per frame with the eye in Hearth's turning frame (metres from its centre), or null away from Hearth. */
  frame(eye: Vec3 | null, timeS: number): void;
  stats(): LifeStats;
  dispose(): void;
}

/** The creatures of the plan at `stage` (≥ `STAGE.sites`), drawn before `before`. */
export function createLife(o: { engine: Engine; plan: WorldPlan; stage: number; before: Layer }): Life {
  const { engine, plan, stage } = o;
  const renderer = engine.renderer;
  const R = plan.grid.radiusM;
  const layer = new RigLayer(renderer);
  renderer.addBefore(layer, o.before);
  const kinds = creatureRigs().map((d, i) => layer.addKind(d, CREATURE_CAP[i] ?? 0));
  const looks: Map<number, CreatureLook>[] = kinds.map(() => new Map());
  const poses: LifePose[] = [];
  const counts = { capped: 0 };
  const per = kinds.map(() => 0);
  const r: RigInstance = { x: 0, y: 0, z: 0, slope: 0, dirX: 0, dirZ: 1, x1: 0, y1: 0, z1: 0, slope1: 0, dirX1: 0, dirZ1: 1, distance: 0, speed: 0, turnRate: 0, seed: 0, state: 1, heightScale: 1, widthScale: 1, variants: 0, colors: [0, 0, 0, 0] };
  let set: LifeSet = { sites: [], routes: [] };
  let setEye: Vec3 | null = null;
  let made = 0;
  let logicMs = 0;

  const lookOf = (kind: number, seed: number): CreatureLook => {
    const m = looks[kind]!;
    let l = m.get(seed);
    if (!l) {
      if (m.size >= LOOK_CACHE) m.clear();
      l = creatureLook(kind, seed);
      m.set(seed, l);
    }
    return l;
  };

  const empty = (): void => {
    for (const k of kinds) layer.commit(k, 0);
    made = 0;
    counts.capped = 0;
  };

  return {
    layer,
    frame: (eye, timeS) => {
      if (!eye) {
        layer.enabled = false;
        setEye = null;
        empty();
        return;
      }
      layer.enabled = true;
      const t0 = performance.now();
      const el = Math.sqrt(eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]) || 1;
      if (!setEye || (eye[0] - setEye[0]) ** 2 + (eye[1] - setEye[1]) ** 2 + (eye[2] - setEye[2]) ** 2 > RESET_M * RESET_M) {
        set = lifeSet(plan, stage, [eye[0] / el, eye[1] / el, eye[2] / el], el - R);
        setEye = [eye[0], eye[1], eye[2]];
      }
      const n = set.sites.length + set.routes.length > 0 ? lifeNear(plan, stage, set, eye, timeS, poses, counts) : ((counts.capped = 0), 0);
      const origin = renderer.worldOrigin;
      per.fill(0);
      const staging = kinds.map((k) => layer.staging(k));
      for (let i = 0; i < n; i++) {
        const p = poses[i]!;
        const k = p.kind;
        const rr = R + p.heightM;
        r.x = r.x1 = p.dir[0] * rr - origin[0];
        r.y = r.y1 = p.dir[1] * rr - origin[1];
        r.z = r.z1 = p.dir[2] * rr - origin[2];
        const [dx, dz] = toFramePlane(upFrame(p.dir), p.heading);
        const dl = Math.sqrt(dx * dx + dz * dz) || 1;
        r.dirX = r.dirX1 = dx / dl;
        r.dirZ = r.dirZ1 = dz / dl;
        r.slope = r.slope1 = p.slope;
        r.distance = p.distanceM;
        r.speed = p.speed;
        r.state = p.state;
        r.seed = (p.seed >>> 0) / 4294967296;
        const look = lookOf(k, p.seed);
        r.heightScale = look.heightScale;
        r.widthScale = look.widthScale;
        r.variants = look.variants;
        r.colors = look.colors;
        writeRigInstance(staging[k]!, per[k]!++, r);
      }
      kinds.forEach((k, i) => layer.commit(k, per[i]!));
      made = n;
      logicMs = performance.now() - t0;
    },
    stats: () => ({ near: layer.counts.near, far: layer.counts.far, hidden: layer.counts.hidden, made, capped: counts.capped, logicMs, sites: set.sites.length, routes: set.routes.length }),
    dispose: () => {
      layer.clear();
      renderer.remove(layer);
    },
  };
}

/** The line about the creatures in the panel. */
export function lifeLine(life: Life): string {
  const s = life.stats();
  return `life    ${s.made} creatures (near ${s.near}, far ${s.far}, small ${s.hidden})${s.capped > 0 ? `  over the caps ${s.capped}` : ''}  logic ${s.logicMs.toFixed(2)} ms  at most ${LIFE_MAX}`;
}

/**
 * The views of the creatures, each at a pinned time (the daylight time of its place, then the first moment some
 * walker of the scene is under way): low along a lane of the first village behind a villager, the same 3 s later, a
 * party on a road from the side, a beast close up, a troop of skeletons, grazers in a field, a village on the far
 * side of Hearth from above, and the first village from straight above.
 */
export function lifeViews(plan: WorldPlan, stage: number, daylight?: (dir: Vec3) => number): PlanView[] {
  const S = plan.sites;
  if (!S || S.count === 0 || stage < STAGE.sites) return [];
  const body = SURFACES[PLAN_BODY]!.name;
  const R = plan.grid.radiusM;
  const pose = newPose();
  const views: PlanView[] = [];
  const view = (name: string, dir: Vec3, height: number, time: number, extra: Partial<PlanView> = {}): PlanView => {
    const [lat, lon] = latLonOf(dir);
    return { name, body, lat, lon, height, pitchDeg: 89, yawDeg: 0, map: false, time, ...extra };
  };
  const timeAt = (dir: Vec3): number => (daylight ? daylight(dir) : 0);
  /** From time `t` on, the first time within 10 minutes that `w` walks (in steps of 5 s); `t` when it never does. */
  const walking = (w: Walk, t: number): number => {
    for (let k = 0; k < 120; k++) {
      walkPose(plan, w, t + 5 * k, pose);
      if (pose.state === 0) return t + 5 * k;
    }
    walkPose(plan, w, t, pose);
    return t;
  };
  /** The point `back` m behind the pose and `side` m to its right, as a direction; `at`: the pose's point `lift` m up. */
  const around = (p: LifePose, back: number, side: number): Vec3 => {
    const u = p.dir;
    const h = p.heading;
    const rx = h[1] * u[2] - h[2] * u[1];
    const ry = h[2] * u[0] - h[0] * u[2];
    const rz = h[0] * u[1] - h[1] * u[0];
    const x = u[0] * R - h[0] * back + rx * side;
    const y = u[1] * R - h[1] * back + ry * side;
    const z = u[2] * R - h[2] * back + rz * side;
    const l = Math.sqrt(x * x + y * y + z * z);
    return [x / l, y / l, z / l];
  };
  const at = (p: LifePose, lift: number): Vec3 => {
    const r = R + p.heightM + lift;
    return [p.dir[0] * r, p.dir[1] * r, p.dir[2] * r];
  };
  const villages: number[] = [];
  for (let s = 0; s < S.count; s++) if (S.kind[s] === SITE_KIND.village) villages.push(s);
  const v = villages[0];
  if (v !== undefined) {
    const w = siteWalks(plan, v)[0];
    const centre = sitePoint(siteFrame(plan, v), 0, 0).dir;
    if (w) {
      const t = walking(w, timeAt(centre));
      const p = { ...pose, dir: [...pose.dir] as Vec3, heading: [...pose.heading] as Vec3 };
      const eye = around(p, 9, 1.5);
      views.push(view('world-life-lane', eye, 1.7, t, { pitchDeg: 5, toward: at(p, 1) }));
      views.push(view('world-life-lane-later', eye, 1.7, t + 3, { pitchDeg: 5, toward: at(p, 1) }));
    }
    const stands = siteStands(plan, stage, v);
    const g = stands[0];
    if (g) {
      const p: LifePose = { ...newPose(), dir: g.dir, heading: g.heading, heightM: g.heightM };
      views.push(view('world-field', around(p, 10, 4), 3, timeAt(g.dir), { pitchDeg: 10, toward: at(p, 0.4) }));
    }
    views.push(view('world-village-top', centre, 80,timeAt(centre), { pitchDeg: 89 }));
  }
  const rt = plan.routes;
  if (rt && stage >= STAGE.routes) {
    let party: Walk | null = null;
    let troop: Walk | null = null;
    for (let i = 0; i < rt.count && (!party || !troop); i++) {
      for (const w of routeWalks(plan, i)) {
        if (!party && w.kind === CREATURE.beast) party = w;
        if (!troop && w.kind === CREATURE.skeleton) troop = w;
      }
    }
    if (party) {
      walkPose(plan, party, 0, pose);
      const t = walking(party, timeAt(pose.dir));
      const p = { ...pose, dir: [...pose.dir] as Vec3, heading: [...pose.heading] as Vec3 };
      views.push(view('world-road', around(p, -4, 10), 3, t, { pitchDeg: 8, toward: at(p, 1) }));
      views.push(view('world-gait', around(p, -1, 6), 1.2, t, { pitchDeg: 2, toward: at(p, 0.8) }));
    }
    if (troop) {
      walkPose(plan, troop, 0, pose);
      const t = walking(troop, timeAt(pose.dir));
      const p = { ...pose, dir: [...pose.dir] as Vec3, heading: [...pose.heading] as Vec3 };
      views.push(view('world-troop', around(p, -7, 3), 1.8, t, { pitchDeg: 5, toward: at(p, 1) }));
    }
  }
  // The village farthest round the body from the first one: up is radial there too.
  if (v !== undefined && villages.length > 1) {
    const d = (s: number): number => S.dir[3 * s]! * S.dir[3 * v]! + S.dir[3 * s + 1]! * S.dir[3 * v + 1]! + S.dir[3 * s + 2]! * S.dir[3 * v + 2]!;
    let far = villages[1]!;
    for (const s of villages) if (d(s) < d(far)) far = s;
    const w = siteWalks(plan, far)[0];
    if (w) {
      const c = sitePoint(siteFrame(plan, far), 0, 0).dir;
      const t = walking(w, timeAt(c));
      const p = { ...pose, dir: [...pose.dir] as Vec3, heading: [...pose.heading] as Vec3 };
      views.push(view('world-far-side', around(p, 6, 4), 4, t, { pitchDeg: 20, toward: at(p, 0.8) }));
    }
  }
  return views;
}
