// The routines of the village (A6, B4): which places each person and animal goes to, what they do there and for
// how long. Places come from the layout's points of interest, so another seed moves the life with the village.

import { poi, structure } from '../layout.ts';
import type { VillageLayout } from '../layout.ts';
import type { Animal } from './animals.ts';
import type { Person } from './looks.ts';
import { PROP } from './looks.ts';
import { ACT } from './rig.ts';
import { AACT, KIND, step } from './sim.ts';
import type { AgentDef, Step } from './sim.ts';

/** Seat height of the village benches (metres above the ground). */
export const SEAT_Y = 0.45;

interface Place {
  x: number;
  z: number;
  yaw: number;
  node: number;
}

const dirX = (yaw: number): number => Math.sin(yaw);
const dirZ = (yaw: number): number => Math.cos(yaw);

/** A point of interest, optionally moved `fwd` metres along its facing and `side` metres to its left. */
function at(l: VillageLayout, id: string, fwd = 0, side = 0, turn = 0): Place {
  const p = poi(l, id);
  return {
    x: p.x + dirX(p.yaw) * fwd + Math.cos(p.yaw) * side,
    z: p.z + dirZ(p.yaw) * fwd - Math.sin(p.yaw) * side,
    yaw: p.yaw + turn,
    node: p.node,
  };
}

/** A spot by the well at angle `a` (around the well), facing it. */
function wellSpot(l: VillageLayout, a: number): Place {
  const w = l.well;
  const p = poi(l, 'well');
  const x = w.x + Math.sin(a) * 1.35, z = w.z + Math.cos(a) * 1.35;
  return { x, z, yaw: a + Math.PI, node: p.node };
}

/** Just outside a structure's front door, facing out. */
function doorSpot(l: VillageLayout, id: string, poiId: string): Place {
  const d = structure(l, id).door;
  return { x: d.x + dirX(d.yaw) * 0.3, z: d.z + dirZ(d.yaw) * 0.3, yaw: d.yaw, node: poi(l, poiId).node };
}

/** The seat of bench k: facing the bench's heading, its point of interest stands in front of it. */
function seat(l: VillageLayout, k: number, poiId: string): Place {
  const b = l.benches[k]!;
  return { x: b.x + dirX(b.yaw) * 0.06, z: b.z + dirZ(b.yaw) * 0.06, yaw: b.yaw, node: poi(l, poiId).node };
}

const S = (p: Place, o: Partial<Step> & Pick<Step, 'acts'>): Step => step({ x: p.x, z: p.z, yaw: p.yaw, node: p.node, ...o });

/** The guard post on the other side of the bridge end from the bridge-guard point (mirrored across the road). */
export function guardPost(l: VillageLayout): Place {
  const g = poi(l, 'bridge-guard');
  const br = l.bridge;
  const ax = Math.sin(br.yaw), az = Math.cos(br.yaw);
  // Distance across the bridge axis, mirrored.
  const dx = g.x - br.x, dz = g.z - br.z;
  const across = dx * az - dz * ax;
  return { x: g.x - 2 * across * az, z: g.z + 2 * across * ax, yaw: g.yaw, node: g.node };
}

/** Agent definitions for the people (indices as in looks.ts makePeople) and the animals after them. */
export function routines(l: VillageLayout, people: Person[], animals: Animal[]): AgentDef[] {
  const idx = (role: string, slot = -1): number => people.findIndex((p) => p.role === role && (slot < 0 || p.slot === slot));
  const merchant = [idx('merchant', 0), idx('merchant', 1), idx('merchant', 2)];
  const post = idx('guard-post');
  const loverA = idx('lover-a'), loverB = idx('lover-b'), child = idx('child');
  const postAt = guardPost(l);
  // Visitors of the guard stand 1.2 m in front of him, on either side.
  const visitGuard = (side: number): Place => {
    const x = postAt.x + dirX(postAt.yaw) * 1.2 + Math.cos(postAt.yaw) * side;
    const z = postAt.z + dirZ(postAt.yaw) * 1.2 - Math.sin(postAt.yaw) * side;
    return { x, z, yaw: Math.atan2(postAt.x - x, postAt.z - z), node: postAt.node };
  };
  const endNW = at(l, 'road-end-north-west'), endS = at(l, 'road-end-south');
  // Meeting places of the young pair: centre and the axis the two stand on.
  const meets: { c: Place; axis: number }[] = [
    { c: { ...wellSpot(l, 0.9), x: l.well.x + 2.6, z: l.well.z + 1.2 }, axis: 0.4 },
    { c: at(l, 'square', 0, 0), axis: 1.9 },
    { c: at(l, 'riverside', -0.8, 0), axis: 2.6 },
    { c: at(l, 'bench-1', -1.3, 0), axis: -0.6 },
  ];
  const meetSpot = (k: number, sideA: boolean): Place => {
    const m = meets[k]!;
    const s = sideA ? 1 : -1;
    return {
      x: m.c.x + Math.sin(m.axis) * 0.55 * s,
      z: m.c.z + Math.cos(m.axis) * 0.55 * s,
      yaw: m.axis + (sideA ? Math.PI : 0),
      node: m.c.node,
    };
  };

  const defs: AgentDef[] = people.map((p, i): AgentDef => {
    const legLen = p.body.thigh + p.body.shin;
    const base = { kind: KIND.human, ref: i, speed: p.speed, stride: legLen * 1.55, radius: p.role === 'child' ? 0.22 : 0.28, first: 0, host: 0 as 0 | 1 | 2 };
    switch (p.role) {
      case 'smith':
        return { ...base, steps: [
          S(at(l, 'anvil'), { acts: [ACT.hammer], dmin: 12, dmax: 25, next: [0, 0, 1] }),
          S(at(l, 'forge-fire'), { acts: [ACT.tend], dmin: 6, dmax: 10, next: [0] }),
        ] };
      case 'innkeeper':
        return { ...base, steps: [
          S(at(l, 'inn-door'), { acts: [ACT.sweep], dmin: 10, dmax: 18, next: [1, 1, 2, 3] }),
          S(doorSpot(l, 'inn', 'inn-door'), { acts: [ACT.stand], hide: true, dmin: 12, dmax: 30, next: [0, 2] }),
          S(at(l, 'inn-barrels', 0.1), { acts: [ACT.stand], dmin: 5, dmax: 9, next: [0, 1] }),
          S(at(l, 'inn-door', -3.2, 0.8, Math.PI), { acts: [ACT.talk, ACT.stand], dmin: 4, dmax: 8, next: [0, 1] }),
        ] };
      case 'merchant': {
        const k = p.slot;
        return { ...base, host: 1, steps: [
          S(at(l, `stall-${k}`), { acts: [ACT.stand, ACT.offer, ACT.stand], dmin: 5, dmax: 10, next: [0, 0, 1] }),
          S(at(l, `stall-${k}`, -0.1, k === 1 ? -0.9 : 0.9), { acts: [ACT.stand], dmin: 3, dmax: 6, next: [0] }),
        ] };
      }
      case 'farmer':
        return { ...base, steps: [
          S(at(l, 'garden-0'), { acts: [ACT.hoe], dmin: 20, dmax: 35, next: [0, 1] }),
          S(at(l, 'garden-0'), { acts: [ACT.stand], dmin: 2, dmax: 3, prop: PROP.carry, next: [2] }),
          S(at(l, 'stall-0-front'), { acts: [ACT.give], dmin: 6, dmax: 9, prop: PROP.carry, walk: ACT.carry, visit: merchant[0]!, next: [3] }),
          S(at(l, 'garden-0'), { acts: [ACT.stand], dmin: 2, dmax: 3, prop: PROP.carry, walk: ACT.carry, next: [0] }),
        ] };
      case 'shopper': {
        const home = doorSpot(l, 'cottage-3', 'cottage-3-door');
        return { ...base, first: 1, startX: home.x, startZ: home.z, startNode: home.node, steps: [
          S(home, { acts: [ACT.stand], hide: true, dmin: 15, dmax: 30, next: [1, 2] }),
          S(at(l, 'stall-1-front'), { acts: [ACT.talk], dmin: 8, dmax: 14, visit: merchant[1]!, next: [2, 3] }),
          S(at(l, 'stall-2-front'), { acts: [ACT.talk], dmin: 8, dmax: 12, visit: merchant[2]!, next: [1, 3] }),
          S(wellSpot(l, -0.9), { acts: [ACT.drink, ACT.stand], dmin: 5, dmax: 8, next: [4, 0] }),
          S(at(l, 'square', 0, 2.5), { acts: [ACT.stand], dmin: 4, dmax: 8, next: [0, 1] }),
        ] };
      }
      case 'guard-patrol':
        return { ...base, steps: [
          S(at(l, 'bridge-guard', 0.3, -0.6), { acts: [ACT.guard], dmin: 5, dmax: 9, next: [1] }),
          S(at(l, 'square', 0, -3), { acts: [ACT.guard], dmin: 4, dmax: 8, next: [2] }),
          S(at(l, 'inn-door', -2.8, -2.2, Math.PI), { acts: [ACT.guard], dmin: 4, dmax: 7, next: [3] }),
          S(wellSpot(l, 2.4), { acts: [ACT.guard, ACT.drink], dmin: 3, dmax: 6, next: [0] }),
        ] };
      case 'guard-post':
        return { ...base, host: 2, steps: [
          S(postAt, { acts: [ACT.guard], dmin: 10, dmax: 25, next: [0, 0, 1] }),
          S({ ...postAt, x: postAt.x + Math.sin(l.bridge.yaw) * 2.5, z: postAt.z + Math.cos(l.bridge.yaw) * 2.5 }, { acts: [ACT.guard], dmin: 3, dmax: 6, next: [0] }),
        ] };
      case 'traveller': {
        const a = p.slot === 0;
        const g = visitGuard(a ? 0.55 : -0.55);
        const steps = a
          ? [
              S(endNW, { acts: [ACT.stand], hide: true, dmin: 20, dmax: 40, next: [1] }),
              S(wellSpot(l, 1.9), { acts: [ACT.drink], dmin: 5, dmax: 8, next: [2] }),
              S(g, { acts: [ACT.talk], dmin: 6, dmax: 10, visit: post, next: [3] }),
              S(endS, { acts: [ACT.stand], hide: true, dmin: 20, dmax: 40, next: [4] }),
              S(g, { acts: [ACT.talk], dmin: 6, dmax: 10, visit: post, next: [5] }),
              S(wellSpot(l, 1.9), { acts: [ACT.drink], dmin: 5, dmax: 8, next: [0] }),
            ]
          : [
              S(endS, { acts: [ACT.stand], hide: true, dmin: 20, dmax: 40, next: [1] }),
              S(g, { acts: [ACT.talk], dmin: 6, dmax: 10, visit: post, next: [2] }),
              S(at(l, 'inn-door', -4.5, 1.5), { acts: [ACT.stand], dmin: 6, dmax: 10, next: [3] }),
              S(endNW, { acts: [ACT.stand], hide: true, dmin: 20, dmax: 40, next: [4] }),
              S(wellSpot(l, -2.4), { acts: [ACT.drink], dmin: 5, dmax: 8, next: [5] }),
              S(g, { acts: [ACT.talk], dmin: 6, dmax: 10, visit: post, next: [0] }),
            ];
        const start = a ? endNW : endS;
        return { ...base, steps, first: 1, startX: start.x, startZ: start.z, startNode: start.node };
      }
      case 'oldman':
        return { ...base, radius: 0.26, steps: [
          S(seat(l, 1, 'bench-1'), { acts: [ACT.sit], seat: SEAT_Y, dmin: 30, dmax: 60, next: [1, 2] }),
          S(seat(l, 2, 'bench-2'), { acts: [ACT.sit], seat: SEAT_Y, dmin: 30, dmax: 60, next: [0, 2] }),
          S(seat(l, 0, 'inn-bench'), { acts: [ACT.sit], seat: SEAT_Y, dmin: 30, dmax: 60, next: [0, 1] }),
        ] };
      case 'lover-a': {
        const home = doorSpot(l, 'cottage-0', 'cottage-0-door');
        const meetSteps = meets.map((_, k) => S(meetSpot(k, true), { acts: [ACT.talk], meetWith: loverB, meetId: k, next: [0, 5, 6] }));
        const sq = at(l, 'square', 0, -1);
        return { ...base, leader: true, first: 1, startX: sq.x, startZ: sq.z, startNode: sq.node, steps: [
          S(home, { acts: [ACT.stand], hide: true, dmin: 10, dmax: 25, next: [1, 2, 3, 4] }),
          ...meetSteps,
          S(at(l, 'garden-2', 0.3), { acts: [ACT.stand], dmin: 6, dmax: 10, next: [1, 2, 3, 4] }),
          S(wellSpot(l, -2.0), { acts: [ACT.drink, ACT.stand], dmin: 5, dmax: 8, next: [1, 2, 3, 4] }),
        ] };
      }
      case 'lover-b': {
        const home = doorSpot(l, 'cottage-5', 'cottage-5-door');
        const meetSteps = meets.map((_, k) => S(meetSpot(k, false), { acts: [ACT.talk], meetWith: loverA, meetId: k, next: [4, 5, 6] }));
        const start = at(l, 'inn-barrels', -1.5);
        return { ...base, first: 0, startX: start.x, startZ: start.z, startNode: start.node, steps: [
          ...meetSteps,
          S(at(l, 'inn-barrels', -0.8, 1.2), { acts: [ACT.stand], dmin: 8, dmax: 15, next: [5, 6] }),
          S(at(l, 'mill-door', -1.0), { acts: [ACT.stand], dmin: 6, dmax: 10, next: [4, 6] }),
          S(home, { acts: [ACT.stand], hide: true, dmin: 10, dmax: 20, next: [4, 5] }),
        ] };
      }
      case 'child': {
        const sq = l.square;
        return { ...base, steps: [
          S({ x: sq.x + 1, z: sq.z + 1, yaw: 0, node: -1 }, { acts: [ACT.stand], r: 6, walk: ACT.run, dmin: 1.5, dmax: 4, next: [0, 0, 0, 1] }),
          S(wellSpot(l, 0.2), { acts: [ACT.drink], walk: ACT.run, node: -1, dmin: 2, dmax: 4, next: [0] }),
        ] };
      }
    }
  });

  // Animals.
  const yard = at(l, 'chickens');
  const garden = at(l, 'garden-0', -2.2, 0.8);
  let hen = 0;
  for (const a of animals) {
    const ref = defs.length;
    if (a.kind === 'chicken') {
      const loose = hen === 3;
      const c = loose ? garden : yard;
      defs.push({
        kind: KIND.chicken, ref, speed: a.speed, stride: a.stride, radius: 0.12, first: 0, host: 0,
        steps: [S({ ...c, node: -1 }, { acts: [AACT.peck, AACT.peck, AACT.scratch, AACT.stand], r: loose ? 1.8 : 2.6, walk: AACT.walk, dmin: 1.5, dmax: 5, next: [0] })],
        startX: c.x + Math.sin(hen * 2.1) * 1.2, startZ: c.z + Math.cos(hen * 2.1) * 1.2, startNode: -1,
      });
      hen++;
    } else if (a.kind === 'dog') {
      defs.push({
        kind: KIND.dog, ref, speed: a.speed, stride: a.stride, radius: 0.22, first: 0, host: 0,
        steps: [S({ x: l.square.x, z: l.square.z, yaw: 0, node: -1 }, { acts: [AACT.stand], walk: AACT.walk, follow: child, dmin: 1, dmax: 1, next: [0] })],
        startX: l.square.x - 1.5, startZ: l.square.z + 1, startNode: -1,
      });
    } else {
      defs.push({
        kind: KIND.cat, ref, speed: a.speed, stride: a.stride, radius: 0.13, first: 0, host: 0,
        steps: [
          S(at(l, 'inn-barrels', -0.5, -0.7), { acts: [AACT.groom, AACT.sit], walk: AACT.walk, dmin: 15, dmax: 40, next: [0, 1] }),
          S(wellSpot(l, 3.6), { acts: [AACT.sit, AACT.groom], walk: AACT.walk, dmin: 8, dmax: 15, next: [0] }),
        ],
      });
    }
  }
  return defs;
}
