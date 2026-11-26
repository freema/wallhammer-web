// Scenarios of riding in the movement example (examples/movement/src/ride.ts on the shared steed and its QuadGait): the
// steed driven over the real course the way the page drives it, with the figure in the saddle. Planted hooves stay put
// and within the legs' reach on the flat, up the 20° ramp and up the stairs; the rider's hands stay on the grips and
// its feet in the stirrups at a walk, a trot and a gallop; getting on and off ends with the figure standing on free
// ground (on the left, or on the right beside a wall); two runs are bit-equal.

import { Walker, newWalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
import type { WalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
import { MOVE_PROFILES } from '../../examples/shared/src/figures/profiles.ts';
import { PathfinderBody } from '../../examples/movement/src/body.ts';
import { buildCourse } from '../../examples/movement/src/course.ts';
import type { Course } from '../../examples/movement/src/course.ts';
import { Ride } from '../../examples/movement/src/ride.ts';
import { f, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

let shared: Course | null = null;
function course(): Course {
  shared ??= buildCourse(7);
  return shared;
}

const DEG = Math.PI / 180;

/** A steed at (x, z, heading in degrees) with the figure beside it (or in the saddle when `mounted`). */
function setup(x: number, z: number, yawDeg: number, mounted: boolean): Ride {
  const c = course();
  const profile = MOVE_PROFILES.default;
  const rw = new Walker(c.world, profile.walker);
  const body = new PathfinderBody(rw.setup.height, profile, (px, pz, py) => c.world.groundAt(px, pz, py + 0.5, rw.setup.maxStepUp));
  const yaw = yawDeg * DEG;
  // The figure two metres to the steed's left.
  const fx = x - Math.cos(yaw) * 2, fz = z + Math.sin(yaw) * 2;
  rw.teleport(fx, c.world.groundAt(fx, fz, 1e4, 0), fz, yaw);
  body.reset();
  const ride = new Ride(c.world, body, rw, x, z, yaw);
  if (mounted) ride.mount(true);
  return ride;
}

const scratch = new Float64Array(3);

/** One fixed step of the page: the steed (and while not riding, the figure's walker), then both posed. */
function step(ride: Ride, intent: WalkIntent | null): void {
  const rw = ride.riderWalker;
  if (!ride.riding) rw.step(newWalkIntent());
  ride.step(ride.riding ? intent : null);
  ride.update(1);
  ride.poseSteed();
  rw.renderPosition(scratch, 1);
  if (ride.posesRider) ride.poseRider(scratch[0]!, scratch[1]!, scratch[2]!, rw.renderYaw(1));
}

/** An intent along the steed's heading now (the page's input is turned by the view; here it is the steed's own). */
function ahead(ride: Ride, run: boolean, turn = 0): WalkIntent {
  const i = newWalkIntent();
  const y = ride.walker.yaw + turn;
  i.moveX = -Math.sin(y);
  i.moveZ = -Math.cos(y);
  i.run = run;
  return i;
}

interface Measure {
  /** Largest move of a standing hoof between two steps, m. */
  drift: number;
  /** Largest share of a leg's length between its pivot and its fetlock. */
  reach: number;
  /** Largest gap between a standing fetlock and its step target, m. */
  gap: number;
  /** Largest gap of a hand to its grip and of a foot to its stirrup, m. */
  hand: number;
  foot: number;
  /** Footfalls per leg. */
  downs: number[];
  steps: number;
}

const BONE = 12;

function dist(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): number {
  return Math.hypot(a[i]! - b[j]!, a[i + 1]! - b[j + 1]!, a[i + 2]! - b[j + 2]!);
}

/** Socket position on the steed. */
function socketAt(world: Float64Array, s: { bone: number; local: ArrayLike<number> }, out: Float64Array): void {
  const o = s.bone * BONE, l = s.local;
  for (let r = 0; r < 3; r++) out[r] = world[o + r]! * l[9]! + world[o + 3 + r]! * l[10]! + world[o + 6 + r]! * l[11]! + world[o + 9 + r]!;
}

/** Drives the steed by `intent` for `seconds`, measuring after `settle` seconds. */
function drive(ride: Ride, seconds: number, settle: number, intent: (r: Ride) => WalkIntent): Measure {
  const g = ride.gait, legs = g.kind.steps.legs, w = g.world, c = g.cycle;
  const s = ride.kind.sockets!;
  const rk = ride.rider.kind;
  const hands = [rk.arms!.left.chain.end, rk.arms!.right.chain.end];
  const feet = [rk.legs!.chains[0]!.end, rk.legs!.chains[1]!.end];
  const holds = [s.gripL!, s.gripR!, s.stirrupL!, s.stirrupR!];
  const prev = new Float64Array(12);
  const was = [0, 0, 0, 0];
  const downs0 = Array.from(c.downs);
  const lens: number[] = [];
  const m: Measure = { drift: 0, reach: 0, gap: 0, hand: 0, foot: 0, downs: [], steps: 0 };
  const at = new Float64Array(3);
  const n = Math.round(seconds * ride.walker.setup.stepHz);
  const from = Math.round(settle * ride.walker.setup.stepHz);
  for (let k = 0; k < n; k++) {
    const downsBefore = Array.from(c.downs);
    step(ride, intent(ride));
    for (let i = 0; i < 4; i++) {
      const L = legs[i]!, e = L.chain.end * BONE + 9, u = L.chain.upper * BONE + 9, lo = L.chain.lower * BONE + 9;
      if (lens[i] === undefined) lens[i] = dist(w, u, w, lo) + dist(w, lo, w, e);
      const planted = c.planted[i]! > 0.5;
      if (k >= from) {
        m.reach = Math.max(m.reach, dist(w, u, w, e) / lens[i]!);
        if (planted && was[i] && c.downs[i] === downsBefore[i]) m.drift = Math.max(m.drift, dist(w, e, prev, i * 3));
        if (planted) m.gap = Math.max(m.gap, Math.abs(dist(w, e, c.targets, i * 3)));
      }
      prev[i * 3] = w[e]!;
      prev[i * 3 + 1] = w[e + 1]!;
      prev[i * 3 + 2] = w[e + 2]!;
      was[i] = planted ? 1 : 0;
    }
    if (k >= from && ride.mode === 'on') {
      const rw = ride.rider.gait.world;
      for (let h = 0; h < 4; h++) {
        socketAt(w, holds[h]!, at);
        const b = (h < 2 ? hands[h]! : feet[h - 2]!) * BONE + 9;
        const d = Math.hypot(rw[b]! - at[0]!, rw[b + 1]! - at[1]!, rw[b + 2]! - at[2]!);
        if (h < 2) m.hand = Math.max(m.hand, d);
        else m.foot = Math.max(m.foot, d);
      }
    }
    m.steps++;
  }
  m.downs = Array.from(c.downs, (d, i) => d - downs0[i]!);
  return m;
}

function line(m: Measure): string {
  return `drift ${f(m.drift * 1000, 2)} mm, reach ${f(m.reach)}, gap ${f(m.gap * 1000, 1)} mm, hands ${f(m.hand * 1000, 2)} mm, feet ${f(m.foot * 1000, 2)} mm, footfalls ${m.downs.join('/')}`;
}

/** Hooves: standing still (under 0.5 mm a step), within reach, on their targets (under 2 cm). */
function hoovesOk(m: Measure): boolean {
  return m.drift < 5e-4 && m.reach <= 1.0005 && m.gap < 0.02 && m.downs.every((d) => d >= 2);
}

/** Hands and feet within 5 mm of their holds. */
function holdsOk(m: Measure): boolean {
  return m.hand < 0.005 && m.foot < 0.005;
}

export const RIDE_SCENARIOS: Scenario[] = [
  {
    name: 'ride-gaits-flat',
    run() {
      const out: string[] = [];
      let ok = true;
      for (const [name, trot, run, z] of [['walk', false, false, 70], ['trot', true, false, 76], ['gallop', false, true, 90]] as const) {
        const r = setup(60, z, 0, true);
        r.setTrot(trot);
        const m = drive(r, run ? 5 : 3, run ? 3.5 : 1.5, (x) => ahead(x, run));
        const v = Math.hypot(r.walker.velocity[0]!, r.walker.velocity[2]!);
        const good = hoovesOk(m) && holdsOk(m) && r.mode === 'on';
        ok &&= good;
        out.push(`${name} ${f(v, 2)} m/s: ${line(m)}${good ? '' : ' (bad)'}`);
      }
      return verdict(ok, out.join('; '));
    },
  },
  {
    name: 'ride-ramp-20',
    run() {
      const r = setup(89, 52, -90, true);
      const y0 = r.walker.position[1]!;
      const m = drive(r, 7.5, 0.5, (x) => ahead(x, false));
      const climbed = r.walker.position[1]! - y0;
      return verdict(hoovesOk(m) && holdsOk(m) && climbed > 1.2, `climbed ${f(climbed, 2)} m: ${line(m)}`);
    },
  },
  {
    name: 'ride-stairs',
    run() {
      const r = setup(86.5, 16, -90, true);
      const y0 = r.walker.position[1]!;
      const m = drive(r, 5.6, 0.5, (x) => ahead(x, false));
      const climbed = r.walker.position[1]! - y0;
      return verdict(hoovesOk(m) && holdsOk(m) && climbed > 1.0, `climbed ${f(climbed, 2)} m: ${line(m)}`);
    },
  },
  {
    name: 'ride-turn-trot',
    run() {
      const r = setup(56, 70, 0, true);
      r.setTrot(true);
      const m = drive(r, 4, 1.5, (x) => ahead(x, false, -Math.PI / 2));
      const turned = Math.abs(r.walker.yaw / DEG);
      return verdict(hoovesOk(m) && holdsOk(m) && turned > 90, `turned ${f(turned, 0)}°: ${line(m)}`);
    },
  },
  {
    name: 'ride-mount-dismount',
    run() {
      const r = setup(59.4, 55.8, 90, false);
      // Walk the figure near: one metre to the left of the steed.
      const rw = r.riderWalker;
      rw.teleport(59.4, 0, 57.4, 0);
      const near = r.near();
      const started = r.toggle();
      let t = 0;
      while (r.mode !== 'on' && t < 3) (step(r, null), (t += 1 / 60));
      const onAfter = t;
      const seated = r.seat.weight;
      const held = r.status().holds.every((h) => h > 0.99);
      // A few metres on, then standing again.
      for (let i = 0; i < 90; i++) step(r, ahead(r, false));
      for (let i = 0; i < 60; i++) step(r, null);
      r.toggle();
      // From the first moment of getting off the figure's walker is beside the steed (what follows it never looks
      // back to where it got on).
      const lead = Math.hypot(rw.position[0]! - r.walker.position[0]!, rw.position[2]! - r.walker.position[2]!);
      t = 0;
      while ((r.mode !== 'off' || r.posesRider) && t < 3) (step(r, null), (t += 1 / 60));
      const p = rw.position, q = r.walker.position;
      const ground = course().world.groundAt(p[0]!, p[2]!, p[1]! + 0.4, 0.4);
      const side = (p[2]! - q[2]!) * 1; // the steed faces −x, its left is +z
      const standing = Math.abs(p[1]! - ground) < 1e-6 && Math.abs(r.rider.root[10]! - p[1]!) < 0.6;
      const ok = near && started && onAfter < 2.2 && seated > 0.999 && held && r.mode === 'off' && !r.posesRider && side > 0.9 && standing && lead < 1.5;
      return verdict(ok, `walker ${f(lead, 2)} m from the steed as it gets off, near ${near}, on after ${f(onAfter, 2)} s (seat ${f(seated, 3)}, holds ${held}), off after ${f(t, 2)} s at ${f(side, 2)} m to the left, ground gap ${f(Math.abs(p[1]! - ground), 4)} m`);
    },
  },
  {
    name: 'ride-dismount-right-by-wall',
    run() {
      // Beside the long wall with its face at z = 30: the steed's left (+z) is blocked, its right free.
      const r = setup(22, 29.3, 90, true);
      const leftFree = r.sideFree(1), rightFree = r.sideFree(-1);
      r.dismount(true);
      for (let i = 0; i < 30; i++) step(r, null);
      const p = r.riderWalker.position;
      const side = p[2]! - r.walker.position[2]!;
      return verdict(!leftFree && rightFree && side < -0.9 && r.mode === 'off', `left free ${leftFree}, right free ${rightFree}, got off at ${f(side, 2)} m (+ left)`);
    },
  },
  {
    name: 'ride-deterministic',
    run() {
      const once = (): number[] => {
        const r = setup(60, 82, 0, true);
        drive(r, 2, 0, (x) => ahead(x, true));
        r.setTrot(true);
        drive(r, 1, 0, (x) => ahead(x, false, 0.6));
        return [...r.gait.world, ...r.rider.gait.world, ...r.walker.position];
      };
      const a = once(), b = once();
      let same = a.length === b.length;
      for (let i = 0; same && i < a.length; i++) same = Object.is(a[i], b[i]);
      return verdict(same, `${a.length} numbers of two runs ${same ? 'bit-equal' : 'differ'}`);
    },
  },
];
