// The station: four domes, the corridors between them, the airlock on the central dome, the roof platform with its
// service unit, masts and dish, a small entry module on the north dome and utility boxes. `stationPlan` derives the
// numbers every builder and `pnpm inspect` share from the layout: dome shapes, window angles kept clear of corridors
// and doors, and the corridor joints.

import { MeshBuilder } from './kit/mesh.ts';
import { place } from './kit/math.ts';
import type { V3 } from './kit/math.ts';
import { instanceSet, pushInstance, writeInstance } from 'wallhammer-web/render';
import { box, cylinder, panelGrid, prism } from './kit/shapes.ts';
import type { BuildContext, Contribution, FrameInfo, OutpostModule } from './kit/types.ts';
import type { DomeSite, Layout } from './layout.ts';
import { AIRLOCK, airlock } from './structures/airlock.ts';
import type { AirlockOptions } from './structures/airlock.ts';
import { corridor, corridorRing, planCorridor, ringTransform } from './structures/corridor.ts';
import type { CorridorPlan } from './structures/corridor.ts';
import { angleGap, dome, domeTop } from './structures/dome.ts';
import type { DomeOptions } from './structures/dome.ts';
import { antennaMast, dish, dishTransform } from './structures/masts.ts';
import { serviceUnit, utilityBox } from './structures/power.ts';
import { rgb } from './style/palette.ts';

/** The airlock of this station: a lower door than the default so the window band runs over the portal. */
export const STATION_AIRLOCK: AirlockOptions = { ...AIRLOCK, height: 3.9, sill: 0.9, doorH: 2.25, steps: 6, stairRun: 3.0 };

/** Share of the central dome radius cut off flat on top for the roof platform. */
const ROOF_CUT = 0.32;

/** Something on a dome wall that windows and footings keep clear of: angle, half width (radians), height range. */
export interface WallObstacle {
  what: string;
  angle: number;
  half: number;
  y0: number;
  y1: number;
}

export interface DomePlan {
  site: DomeSite;
  /** Dome centre on the ground. */
  at: V3;
  options: DomeOptions;
  obstacles: WallObstacle[];
}

export interface StationPlan {
  domes: Record<string, DomePlan>;
  corridors: CorridorPlan[];
  /** Airlock: world position of its wall point and the angle on the central dome. */
  airlock: { at: V3; angle: number; options: AirlockOptions };
  roof: { y: number; radius: number };
  /** Where the dish pivot stands (world) and its resting yaw. */
  dish: { pivot: V3; yaw: number };
  /** North dome entry module angle. */
  entryAngle: number;
}

/** Window centre angles: `n` evenly from `phase`, without those whose window (half width `half`) meets an obstacle. */
function windowAngles(n: number, phase: number, half: number, y0: number, y1: number, obstacles: readonly WallObstacle[]): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = phase + (k / n) * Math.PI * 2;
    const hit = obstacles.some((o) => o.y1 > y0 && o.y0 < y1 && angleGap(a, o.angle) < o.half + half + 0.04);
    if (!hit) out.push(a);
  }
  return out;
}

export function stationPlan(layout: Layout, heightAt: (x: number, z: number) => number): StationPlan {
  const at = (d: DomeSite): V3 => [d.x, heightAt(d.x, d.z), d.z];
  const { central, west, north, east } = layout.domes;
  const { axisY, radius } = layout.corridor;
  const corridors = layout.corridors.map(([a, c]) => {
    const A = layout.domes[a as keyof Layout['domes']], C = layout.domes[c as keyof Layout['domes']];
    return planCorridor(`${a}-${c}`, { at: at(A), shape: A }, { at: at(C), shape: C }, axisY, radius);
  });
  const obstacles: Record<string, WallObstacle[]> = { central: [], west: [], north: [], east: [] };
  for (const p of corridors) {
    for (const [end, id] of [[p.a, p.name.split('-')[0]!], [p.c, p.name.split('-')[1]!]] as const) {
      const R = (layout.domes as Record<string, DomeSite>)[id]!.radius;
      obstacles[id]!.push({ what: `corridor ${p.name}`, angle: end.azimuth, half: Math.asin(Math.min(1, (radius + 0.25) / R)), y0: axisY - radius - 0.2, y1: axisY + radius + 0.2 });
    }
  }
  const al = STATION_AIRLOCK;
  const alAngle = Math.atan2(layout.airlock.x - central.x, layout.airlock.z - central.z);
  obstacles.central!.push({ what: 'airlock', angle: alAngle, half: Math.atan2(al.width / 2 + 0.2, central.radius), y0: 0, y1: al.height });
  // Pipes and the tool board of the maintenance corner (below the window band).
  obstacles.central!.push({ what: 'maintenance wall', angle: -0.47, half: 0.3, y0: 0, y1: 3.1 });
  const entryAngle = -0.3;
  obstacles.north!.push({ what: 'entry module', angle: entryAngle, half: Math.atan2(1.4, north.radius), y0: 0, y1: 2.6 });

  const smallWin = (d: DomeSite, n: number, phase: number): DomeOptions['windows'] => {
    const w = 2.5, y0 = 0.85, y1 = 1.9;
    return { angles: windowAngles(n, phase, w / 2 / d.radius, y0, y1, obstacles[d.id]!), width: w, y0, y1, panes: 2 };
  };
  const keep = (id: string): DomeOptions['keepFree'] => obstacles[id]!.map((o) => ({ angle: o.angle, half: o.half }));
  const domes: Record<string, DomePlan> = {
    central: {
      site: central,
      at: at(central),
      obstacles: obstacles.central!,
      options: {
        ...central,
        ribs: 16,
        hatch: ROOF_CUT,
        top: 'flat',
        footings: 12,
        keepFree: keep('central'),
        windows: { angles: windowAngles(12, alAngle, 3.4 / 2 / 7.9, 3.95, 4.8, obstacles.central!), width: 3.4, y0: 3.95, y1: 4.8, panes: 3, on: 'shoulder' },
        stripes: [{ angle: 0.72, from: 0.06, to: 0.93 }],
        bars: [{ t: 0.5, from: 0.5, to: 1.05 }],
        stripeWidth: 0.95,
      },
    },
    west: { site: west, at: at(west), obstacles: obstacles.west!, options: { ...west, ribs: 12, keepFree: keep('west'), windows: smallWin(west, 8, 0.15), stripes: [{ angle: 0.95 }], bars: [{ t: 0.6, from: 0.55, to: 1.35 }] } },
    north: { site: north, at: at(north), obstacles: obstacles.north!, options: { ...north, ribs: 12, keepFree: keep('north'), windows: smallWin(north, 8, 0.4), stripes: [{ angle: 0.55 }], bars: [{ t: 0.6, from: 0.2, to: 0.9 }] } },
    east: { site: east, at: at(east), obstacles: obstacles.east!, options: { ...east, ribs: 12, keepFree: keep('east'), windows: smallWin(east, 7, 0.0), stripes: [{ angle: 0.85 }], bars: [{ t: 0.62, from: 0.5, to: 1.2 }] } },
  };
  const c = domes.central!;
  const roofY = c.at[1] + domeTop(central, ROOF_CUT);
  return {
    domes,
    corridors,
    airlock: { at: [layout.airlock.x, c.at[1], layout.airlock.z], angle: alAngle, options: al },
    roof: { y: roofY + 0.3, radius: ROOF_CUT * central.radius + 0.25 },
    dish: { pivot: [central.x + 1.45, roofY + 0.3 + 0.95, central.z + 0.85], yaw: 0.45 },
    entryAngle,
  };
}

/** A small entry module on a dome wall: a chamfered box with an orange-framed hatch and a tiny window. */
function entryModule(b: MeshBuilder): void {
  b.paint(rgb('shell'));
  prism(b, [[-1.2, 0], [1.2, 0], [1.2, 2.0], [0.8, 2.45], [-0.8, 2.45], [-1.2, 2.0]], -1.5, 1.5);
  const o = b.outline;
  b.outline = false;
  b.paint(rgb('orange'));
  b.with(place(0, 0.25, 1.51), () => panelGrid(b, 1.3, 1.85, 1, 1));
  b.paint(rgb('shellPanel'));
  b.with(place(0, 0.4, 1.52), () => panelGrid(b, 0.95, 1.55, 1, 1));
  b.paint(rgb('teal'));
  b.with(place(0, 1.35, 1.53), () => panelGrid(b, 0.45, 0.4, 1, 1));
  b.outline = o;
  b.paint(rgb('metalMid'));
  b.with(place(0.9, 2.45, 0), () => box(b, [0.35, 0.25, 0.5]));
}

/** Placement on a dome wall: at angle `a` (θ from +z toward +x), `out` metres off the wall radius, `y` over the ground. */
export function onWall(d: DomePlan, a: number, out: number, y = 0, radius = d.site.radius): ReturnType<typeof place> {
  return place(d.at[0] + Math.sin(a) * (radius + out), d.at[1] + y, d.at[2] + Math.cos(a) * (radius + out), a);
}

export const stationModule: OutpostModule = {
  name: 'station',
  build(ctx: BuildContext): Contribution {
    const plan = stationPlan(ctx.layout, ctx.heightAt);
    const statics: Contribution['statics'] = [];

    // Domes.
    for (const [id, d] of Object.entries(plan.domes)) {
      const b = new MeshBuilder();
      b.with(place(d.at[0], d.at[1], d.at[2]), () => dome(b, d.options));
      statics.push({ name: `dome ${id}`, mesh: b });
    }

    // Corridors and their rings (one instanced ring mesh for all of them).
    const ringMesh = new MeshBuilder();
    corridorRing(ringMesh, ctx.layout.corridor.radius);
    const nRings = plan.corridors.reduce((s, p) => s + p.rings.length, 0);
    const rings = instanceSet(ringMesh.build(), nRings, { name: 'corridor rings' });
    for (const p of plan.corridors) {
      const b = new MeshBuilder();
      corridor(b, p, ctx.heightAt);
      statics.push({ name: `corridor ${p.name}`, mesh: b });
      for (const s of p.rings) pushInstance(rings, ringTransform(p, s));
    }

    // Airlock on the central dome.
    const al = new MeshBuilder();
    const A = plan.airlock;
    al.with(place(A.at[0], A.at[1], A.at[2]), () => airlock(al, A.options));
    statics.push({ name: 'airlock', mesh: al });

    // Roof platform: a deck, the service unit, two masts, the dish pedestal and beacons.
    const c = plan.domes.central!;
    const roof = new MeshBuilder();
    const ry = plan.roof.y;
    roof.with(place(c.at[0], ry - 0.38, c.at[2]), () => {
      roof.paint(rgb('shellPanel'));
      cylinder(roof, plan.roof.radius, 0.38, { segments: 40 });
    });
    roof.with(place(c.at[0] - 1.15, ry, c.at[2] + 0.15, 0.1), () => serviceUnit(roof, [1.6, 1.0, 1.15]));
    roof.with(place(c.at[0] + 0.15, ry, c.at[2] - 0.75), () => antennaMast(roof, { height: 5.6, panelRows: [0.7, 0.88], crossarm: 0.55 }));
    roof.with(place(c.at[0] - 0.6, ry, c.at[2] - 1.7), () => antennaMast(roof, { height: 3.0, panelRows: [0.8], panel: [0.18, 0.7] }));
    roof.paint(rgb('metalMid'));
    roof.with(place(plan.dish.pivot[0], ry, plan.dish.pivot[2]), () => cylinder(roof, 0.16, plan.dish.pivot[1] - ry, { segments: 10, rTop: 0.12 }));
    roof.paint(rgb('orange'));
    for (const [x, z] of [[-2.35, 1.2], [2.3, -1.25], [-1.0, -2.45]] as const) roof.with(place(c.at[0] + x, ry, c.at[2] + z), () => cylinder(roof, 0.1, 0.45, { segments: 8 }));
    statics.push({ name: 'roof', mesh: roof });

    const dishMesh = new MeshBuilder();
    dish(dishMesh, 0.6);
    const dishSet = instanceSet(dishMesh.build(), 1, { name: 'dish' });
    pushInstance(dishSet, dishTransform(plan.dish.pivot, plan.dish.yaw));

    // Entry module on the north dome, utility boxes by the domes.
    const extra = new MeshBuilder();
    const n = plan.domes.north!;
    extra.with(onWall(n, plan.entryAngle, -0.2), () => entryModule(extra));
    const w = plan.domes.west!, e = plan.domes.east!;
    extra.with(onWall(w, 0.55, 0.9), () => utilityBox(extra, [0.9, 1.0, 0.6]));
    extra.with(onWall(e, 0.25, 0.9), () => utilityBox(extra, [0.8, 0.9, 0.55], false));
    extra.with(onWall(c, 1.25, 0.75), () => utilityBox(extra, [1.0, 1.2, 0.6]));
    statics.push({ name: 'dome extras', mesh: extra });

    // The dish slowly re-aims: it holds a heading, then turns to the next one over a few seconds (a fixed cycle of
    // headings round its resting one, a pure function of time).
    const AIMS = [0, 0.55, 0.2, -0.45, -0.1, 0.4];
    const HOLD = 7, TURN = 5;
    const update = (f: FrameInfo): void => {
      const cycle = HOLD + TURN;
      const k = Math.floor(f.time / cycle);
      const u = Math.min(1, Math.max(0, (f.time - k * cycle - HOLD) / TURN));
      const e = u * u * (3 - 2 * u);
      const from = AIMS[k % AIMS.length]!, to = AIMS[(k + 1) % AIMS.length]!;
      writeInstance(dishSet, 0, dishTransform(plan.dish.pivot, plan.dish.yaw + from + (to - from) * e));
      dishSet.dirty = true;
    };

    return { statics, parts: [rings, dishSet], update };
  },
};
