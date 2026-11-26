// Scenarios of the glider in the movement example (examples/movement/src/glide.ts: the engine's FlyingBody with the
// shared glider's steps on the ground and wings in the air, the figure on its back) over the real course. Crawling, the
// planted paws stay put and within the legs' reach; getting on and off ends with the figure standing on free ground
// behind the wing; a flight under scripted input (a crawl, the leap, a turn back, the descent, the flare, the
// touch-down and a crawl on) lands, never takes the hull into the ground and is bit-equal twice. Flown through the
// engine's flight assist (`GLIDER_ASSIST`) with the page's keys: the leap takes off and climbs, W speeds it up to its
// fast flight and S slows it to its slow one (each reached and held in a turn that keeps it inside the course), the
// turns keep the height, it never stalls, and a descent lands by itself; bit-equal twice. Its own climb and descent
// rates at the slow, cruise and fast speeds; W held on a straight heading for 30 s over the course's fence and out over
// the land round it, turned back by the flight range without losing speed; and a descent held outside the course,
// which it does not land on: it keeps over its floor, comes back and lands on the course.

import { Walker, newWalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
import { newFlyingIntent } from '../../packages/wallhammer-web/src/world/flying.ts';
import { newFlightAssistInput } from '../../packages/wallhammer-web/src/world/flight-assist.ts';
import type { FlightAssistInput } from '../../packages/wallhammer-web/src/world/flight-assist.ts';
import type { FlyingIntent } from '../../packages/wallhammer-web/src/world/flying.ts';
import { MOVE_PROFILES } from '../../examples/shared/src/figures/profiles.ts';
import { PathfinderBody } from '../../examples/movement/src/body.ts';
import { COURSE_SIZE_M, FLIGHT_AREA, FLIGHT_CEILING_M, buildCourse } from '../../examples/movement/src/course.ts';
import type { Course } from '../../examples/movement/src/course.ts';
import { GLIDER_ASSIST, Glide } from '../../examples/movement/src/glide.ts';
import { f, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

let shared: Course | null = null;
function course(): Course {
  shared ??= buildCourse(7);
  return shared;
}

const DEG = Math.PI / 180;
/** The page's place of the glider (examples/movement/src/main.ts). */
const PLACE = [76, 61, 0] as const;
const BONE = 12;

/** The glider at its place with the figure 2.6 m behind its left wing (or on its back when `mounted`). */
function setup(mounted: boolean): Glide {
  const c = course();
  const profile = MOVE_PROFILES.default;
  const rw = new Walker(c.world, profile.walker);
  const body = new PathfinderBody(rw.setup.height, profile, (px, pz, py) => c.world.groundAt(px, pz, py + 0.5, rw.setup.maxStepUp));
  const yaw = PLACE[2] * DEG;
  // Left (−cos, sin), back (sin, cos).
  const fx = PLACE[0] - Math.cos(yaw) * 2.6 + Math.sin(yaw) * 3.4, fz = PLACE[1] + Math.sin(yaw) * 2.6 + Math.cos(yaw) * 3.4;
  rw.teleport(fx, c.world.groundAt(fx, fz, 1e4, 0), fz, yaw);
  body.reset();
  const g = new Glide(c.world, body, rw, PLACE[0], PLACE[1], yaw, c.field.maxY + FLIGHT_CEILING_M);
  g.area = FLIGHT_AREA;
  if (mounted) g.mount(true);
  return g;
}

const scratch = new Float64Array(3);

/** One fixed step of the page: the glider (and while not on it, the figure's walker), then both posed. */
function step(g: Glide, intent: FlyingIntent | null): void {
  const rw = g.riderWalker;
  if (!g.riding) rw.step(newWalkIntent());
  g.step(g.riding ? intent : null);
  if (intent) intent.takeOff = false;
  g.update(1);
  g.pose();
  rw.renderPosition(scratch, 1);
  if (g.posesRider) g.poseRider(scratch[0]!, scratch[1]!, scratch[2]!, rw.renderYaw(1));
}

function dist(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): number {
  return Math.hypot(a[i]! - b[j]!, a[i + 1]! - b[j + 1]!, a[i + 2]! - b[j + 2]!);
}

/** The lowest point of the hull's spheres above the ground under the middle. */
function hullClearance(g: Glide): number {
  const b = g.body, h = b.setup.hull, p = b.position;
  const ground = course().world.groundAt(p[0]!, p[2]!, p[1]! + 1, 0.5);
  let low = Infinity;
  for (let i = 0; i < h.length; i += 4) low = Math.min(low, p[1]! + h[i + 1]! - h[i + 3]! - ground);
  return low;
}

/** A flight by its state: crawl, leap, climb, turn back, glide, descend, flare to the ground, crawl on, stop. */
function circuit(g: Glide): { steps: number; low: number; maxAlt: number; turned: number } {
  const it = newFlyingIntent();
  const b = g.body;
  let low = Infinity, maxAlt = 0, turned = 0, last = b.yaw;
  let phase = 0, t = 0, k = 0;
  const hz = 1 / b.stepSeconds;
  for (k = 0; k < 40 * hz && phase < 7; k++) {
    t += b.stepSeconds;
    it.forward = 0;
    it.turn = 0;
    it.pitch = 0;
    it.beat = 0;
    it.brake = 0;
    const alt = g.status().altitude;
    if (phase === 0) {
      it.forward = 1;
      if (t > 1.5) (phase = 1), (it.takeOff = true), (t = 0);
    }
    if (phase === 1) {
      it.forward = 1;
      it.beat = 1;
      if (t > 2) (phase = 2), (t = 0);
    }
    if (phase === 2) {
      // Turning left back the way it came, beating gently.
      it.turn = -1;
      it.beat = 0.4;
      if (Math.abs(turned) > 170 * DEG) (phase = 3), (t = 0);
    }
    if (phase === 3) {
      it.pitch = -0.4;
      if (alt < 3) (phase = 4), (t = 0);
    }
    if (phase === 4) {
      it.brake = 1;
      if (b.grounded) (phase = 5), (t = 0);
    }
    if (phase === 5) {
      it.forward = 0.5;
      if (t > 1) (phase = 6), (t = 0);
    }
    if (phase === 6 && t > 2) phase = 7;
    step(g, it);
    let d = b.yaw - last;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    turned += d;
    last = b.yaw;
    low = Math.min(low, hullClearance(g));
    maxAlt = Math.max(maxAlt, g.status().altitude);
  }
  return { steps: k, low, maxAlt, turned: turned / DEG };
}

/** What one stretch of the assisted flight measured. */
interface Stretch {
  name: string;
  /** Speed over the last 1.5 s of the stretch: lowest, highest, m/s. */
  lo: number;
  hi: number;
  /**
   * For a stretch of W or S held: seconds from its start until the speed is 90 % of the way from where it was to the
   * fast or the slow speed (counted on through the stretches after it; −1: not reached).
   */
  t90: number;
  /** Height over the ground at the start and the end of the stretch, m. */
  alt0: number;
  alt1: number;
}

/**
 * The page's keys over the assist (main.ts `steerGlider`): W/S the throttle in the air (the crawl on the ground), A/D
 * the turn, Space the leap on the ground and the climb in the air, Shift the descent. Stretches: crawl, leap and climb,
 * cruise in a turn, W to fast, fast in a turn, S to slow, slow in a turn, Shift down to the ground, stand.
 */
function assistedCircuit(g: Glide, slowSpeed: number, fastSpeed: number): { stretches: Stretch[]; low: number; maxAlt: number; stalls: number; contacts: number; xz: [number, number, number, number] } {
  const it = newFlyingIntent(), inp = newFlightAssistInput();
  const plan: [string, number, { w?: number; climb?: number; turn?: number; leap?: boolean; untilDown?: boolean }][] = [
    ['crawl', 1.5, { w: 1 }],
    ['leap', 2.5, { leap: true, climb: 1 }],
    ['cruise', 2, { turn: -1 }],
    ['faster', 1.2, { w: 1, turn: -1 }],
    ['fast', 4, { turn: -1 }],
    ['slower', 2, { w: -1, turn: -1 }],
    ['slow', 3, { turn: -1 }],
    ['down', 15, { climb: -1, turn: -1, untilDown: true }],
    ['stand', 2, {}],
  ];
  const b = g.body, hz = 1 / b.stepSeconds;
  const stretches: Stretch[] = [];
  let low = Infinity, maxAlt = 0, stalls = 0, contacts = 0, wasStalled = false;
  const xz: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity];
  let aim: { s: Stretch; from: number; to: number; t: number } | null = null;
  for (const [name, seconds, o] of plan) {
    const alt0 = g.status().altitude;
    let lo = Infinity, hi = 0;
    const st: Stretch = { name, lo, hi, t90: -1, alt0, alt1: alt0 };
    if (o.w) aim = { s: st, from: b.speed, to: o.w > 0 ? fastSpeed : slowSpeed, t: 0 };
    const n = Math.round(seconds * hz);
    for (let k = 0; k < n; k++) {
      const air = !b.grounded;
      it.forward = air ? 0 : (o.w ?? 0);
      it.turn = o.turn ?? 0;
      it.takeOff = k === 0 && !!o.leap;
      inp.throttle = air ? (o.w ?? 0) : 0;
      inp.climb = air ? (o.climb ?? 0) : 0;
      inp.turn = o.turn ?? 0;
      g.step(it, inp);
      g.update(1);
      g.pose();
      if (aim) {
        aim.t += 1 / hz;
        if ((b.speed - aim.from) / (aim.to - aim.from) >= 0.9) (aim.s.t90 = aim.t), (aim = null);
      }
      if (k >= n - 1.5 * hz) (lo = Math.min(lo, b.speed)), (hi = Math.max(hi, b.speed));
      if (!b.grounded) low = Math.min(low, hullClearance(g));
      maxAlt = Math.max(maxAlt, g.status().altitude);
      // The leap leaves the ground far under the stall speed; from the end of the launch on it must never stall.
      if (b.stalled && !wasStalled && name !== 'crawl' && name !== 'leap') stalls++;
      wasStalled = b.stalled;
      contacts += b.contacts > 0 ? 1 : 0;
      const p = b.position;
      xz[0] = Math.min(xz[0], p[0]!), (xz[1] = Math.max(xz[1], p[0]!)), (xz[2] = Math.min(xz[2], p[2]!)), (xz[3] = Math.max(xz[3], p[2]!));
      if (o.untilDown && b.grounded && k > 0) break;
    }
    st.lo = lo;
    st.hi = hi;
    st.alt1 = g.status().altitude;
    stretches.push(st);
  }
  return { stretches, low, maxAlt, stalls, contacts, xz };
}

/** One fixed step of the glider flown through the assist (the rider on), posed. */
function flyStep(g: Glide, it: FlyingIntent, inp: FlightAssistInput): void {
  g.step(it, inp);
  it.takeOff = false;
  g.update(1);
  g.pose();
}

/** Farthest outside the flight range's home area, m (0 inside). */
function outside(x: number, z: number): number {
  const h = FLIGHT_AREA.home;
  return Math.max(h[0] - x, x - h[2], h[1] - z, z - h[3], 0);
}

export const GLIDE_SCENARIOS: Scenario[] = [
  {
    name: 'glide-crawl-paws',
    run() {
      const g = setup(true);
      const gait = g.gait, legs = gait.kind.steps.legs, c = gait.ground.cycle, w = gait.world;
      const it = newFlyingIntent();
      const prev = new Float64Array(12);
      const was = [0, 0, 0, 0];
      const lens: number[] = [];
      let drift = 0, reach = 0;
      const downs0 = Array.from(c.downs);
      const hz = 1 / g.body.stepSeconds;
      for (let k = 0; k < 5 * hz; k++) {
        // A straight crawl, then a crawling turn.
        it.forward = 1;
        it.turn = k > 3 * hz ? 0.6 : 0;
        const before = Array.from(c.downs);
        step(g, it);
        for (let i = 0; i < 4; i++) {
          const L = legs[i]!, e = L.chain.end * BONE + 9, u = L.chain.upper * BONE + 9, lo = L.chain.lower * BONE + 9;
          lens[i] ??= dist(w, u, w, lo) + dist(w, lo, w, e);
          const planted = c.planted[i]! > 0.5;
          if (k > hz) {
            reach = Math.max(reach, dist(w, u, w, e) / lens[i]!);
            if (planted && was[i] && c.downs[i] === before[i]) drift = Math.max(drift, dist(w, e, prev, i * 3));
          }
          prev[i * 3] = w[e]!;
          prev[i * 3 + 1] = w[e + 1]!;
          prev[i * 3 + 2] = w[e + 2]!;
          was[i] = planted ? 1 : 0;
        }
      }
      const downs = Array.from(c.downs, (d, i) => d - downs0[i]!);
      const ok = drift < 5e-4 && reach <= 1.0005 && downs.every((d) => d >= 4) && g.body.grounded;
      return verdict(ok, `crawling 5 s: planted paws drift ${f(drift * 1000, 2)} mm a step, reach ${f(reach)}, footfalls ${downs.join('/')}`);
    },
  },
  {
    name: 'glide-mount-dismount',
    run() {
      const g = setup(false);
      const rw = g.riderWalker;
      const near = g.near();
      const started = g.toggle();
      let t = 0;
      while (g.mode !== 'on' && t < 4) (step(g, null), (t += 1 / 60));
      const onAfter = t;
      const seated = g.seat.weight;
      const held = g.status().holds.every((h) => h > 0.99);
      // A few metres of crawl, then standing again.
      const it = newFlyingIntent();
      it.forward = 1;
      for (let i = 0; i < 90; i++) step(g, it);
      it.forward = 0;
      for (let i = 0; i < 60; i++) step(g, it);
      const off = g.toggle();
      t = 0;
      while ((g.mode !== 'off' || g.posesRider) && t < 3) (step(g, null), (t += 1 / 60));
      const p = rw.position, q = g.body.position;
      const ground = course().world.groundAt(p[0]!, p[2]!, p[1]! + 0.4, 0.4);
      // The glider faces −z: its left is −x, its back +z.
      const left = q[0]! - p[0]!, back = p[2]! - q[2]!;
      const standing = Math.abs(p[1]! - ground) < 1e-6;
      const ok = near && started && onAfter < 3.5 && seated > 0.999 && held && off && g.mode === 'off' && !g.posesRider && left > 0.5 && back > 1 && standing;
      return verdict(ok, `near ${near}, on after ${f(onAfter, 2)} s (seat ${f(seated, 3)}, holds ${held}), off after ${f(t, 2)} s at ${f(left, 2)} m left and ${f(back, 2)} m back, ground gap ${f(Math.abs(p[1]! - ground), 4)} m`);
    },
  },
  {
    name: 'glide-circuit',
    run() {
      const once = (): { g: Glide; r: ReturnType<typeof circuit> } => {
        const g = setup(true);
        return { g, r: circuit(g) };
      };
      const a = once(), b = once();
      const sa = a.g.body.saveState(), sb = b.g.body.saveState();
      let same = sa.every((x, i) => x === sb[i]);
      const wa = a.g.gait.world, wb = b.g.gait.world;
      for (let i = 0; same && i < wa.length; i++) same = Object.is(wa[i], wb[i]);
      const body = a.g.body;
      const ok = same && body.takeOffs === 1 && body.touchDowns === 1 && body.grounded && a.r.maxAlt > 6 && Math.abs(a.r.turned) > 170 && a.r.low > -0.05 && a.g.canDismount();
      return verdict(ok, `take-offs ${body.takeOffs}, touch-downs ${body.touchDowns} (${f(body.touchDownSpeed, 2)} m/s down), highest ${f(a.r.maxAlt, 1)} m, turned ${f(a.r.turned, 0)}°, hull lowest ${f(a.r.low, 3)} m over the ground, ${f(a.r.steps / 60, 1)} s; two runs ${same ? 'bit-equal' : 'differ'}`);
    },
  },
  {
    name: 'glide-assist-circuit',
    run() {
      const once = (): { g: Glide; r: ReturnType<typeof assistedCircuit> } => {
        const g = setup(true);
        return { g, r: assistedCircuit(g, g.assist.safeSpeed, GLIDER_ASSIST.maxSpeed!) };
      };
      const a = once(), b = once();
      const sa = a.g.body.saveState(), sb = b.g.body.saveState();
      let same = sa.every((x, i) => x === sb[i]) && Object.is(a.g.assist.wantedSpeed, b.g.assist.wantedSpeed);
      const wa = a.g.gait.world, wb = b.g.gait.world;
      for (let i = 0; same && i < wa.length; i++) same = Object.is(wa[i], wb[i]);
      const r = a.r, by = (n: string): Stretch => r.stretches.find((s) => s.name === n)!;
      const fast = by('fast'), slow = by('slow'), cruise = by('cruise'), leap = by('leap'), down = by('down');
      const vmax = GLIDER_ASSIST.maxSpeed!, vmin = a.g.assist.safeSpeed;
      const body = a.g.body;
      const ok =
        same &&
        body.takeOffs === 1 &&
        leap.alt1 > 6 &&
        Math.abs(cruise.alt1 - cruise.alt0) < 1.5 &&
        fast.lo > vmax - 0.8 && fast.hi < vmax + 0.8 && Math.abs(fast.alt1 - fast.alt0) < 1 &&
        slow.lo > vmin - 0.5 && slow.hi < vmin + 0.5 && Math.abs(slow.alt1 - slow.alt0) < 1 &&
        fast.lo + fast.hi > 2 * (slow.lo + slow.hi) &&
        by('faster').t90 > 0 && by('faster').t90 < 2.5 && by('slower').t90 > 0 && by('slower').t90 < 2.5 &&
        r.stalls === 0 && r.contacts === 0 &&
        body.grounded && body.touchDowns === 1 && body.touchDownSpeed < 1.5 && r.low > -0.05 &&
        a.g.canDismount();
      const sp = (s: Stretch): string => `${f(s.lo, 1)}–${f(s.hi, 1)} m/s`;
      return verdict(
        ok,
        `leap to ${f(leap.alt1, 1)} m; cruise ${sp(cruise)}; W to fast: 90 % in ${f(by('faster').t90, 2)} s, then ${sp(fast)} in a turn (height ${f(fast.alt0, 1)}→${f(fast.alt1, 1)} m); S to slow: 90 % in ${f(by('slower').t90, 2)} s, then ${sp(slow)} (height ${f(slow.alt0, 1)}→${f(slow.alt1, 1)} m); down from ${f(down.alt0, 1)} m: touch-downs ${body.touchDowns} at ${f(body.touchDownSpeed, 2)} m/s; stalls after the launch ${r.stalls}, steps touching ${r.contacts}, hull lowest ${f(r.low, 3)} m, inside x ${f(r.xz[0], 0)}–${f(r.xz[1], 0)}, z ${f(r.xz[2], 0)}–${f(r.xz[3], 0)}; two runs ${same ? 'bit-equal' : 'differ'}`,
      );
    },
  },
  {
    name: 'glide-assist-rates',
    run() {
      // In the air over the course's length, the speed held, Space and then Shift for 4 s each: the vertical speed of
      // the last 2 s of each against the asked 3.5 m/s.
      const want = GLIDER_ASSIST.climbRate!, down = GLIDER_ASSIST.descentRate!;
      const parts: string[] = [];
      let ok = true;
      for (const speed of [setup(true).assist.safeSpeed, GLIDER_ASSIST.cruiseSpeed!, GLIDER_ASSIST.maxSpeed!]) {
        for (const climb of [1, -1]) {
          const g = setup(true);
          g.launch(60, climb > 0 ? 8 : 26, COURSE_SIZE_M - 5, 0, speed);
          g.assist.wantedSpeed = speed;
          const it = newFlyingIntent(), inp = newFlightAssistInput();
          inp.climb = climb;
          let vy = 0, n = 0, dv = 0, stalled = false;
          const hz = 1 / g.body.stepSeconds;
          for (let k = 0; k < 4 * hz; k++) {
            flyStep(g, it, inp);
            dv = Math.max(dv, Math.abs(g.body.speed - speed));
            stalled ||= g.body.stalled;
            if (k >= 2 * hz) (vy += g.body.velocity[1]!), n++;
          }
          vy /= n;
          const asked = climb > 0 ? want : -down;
          ok &&= Math.abs(vy - asked) < 0.2 && dv < 1.2 && !stalled && g.body.contacts === 0;
          parts.push(`${climb > 0 ? 'climb' : 'descent'} at ${f(speed, 1)}: ${f(vy, 2)} m/s (speed within ${f(dv, 2)})`);
        }
      }
      return verdict(ok, `against ±${f(want, 1)} m/s: ${parts.join(', ')}`);
    },
  },
  {
    name: 'glide-assist-straight',
    run() {
      // Up from the glider's place, then W held on a straight heading for 30 s: over the fence, out over the land and
      // turned back by the flight range, never under the wanted speed's band, never stalled, touching nothing.
      const runOnce = () => {
        const g = setup(true);
        const it = newFlyingIntent(), inp = newFlightAssistInput();
        const b = g.body, hz = 1 / b.stepSeconds;
        it.forward = 1;
        for (let k = 0; k < 1.5 * hz; k++) flyStep(g, it, inp);
        it.forward = 0;
        it.takeOff = true;
        inp.climb = 1;
        for (let k = 0; k < 3 * hz; k++) flyStep(g, it, inp);
        inp.climb = 0;
        inp.throttle = 1;
        const top = GLIDER_ASSIST.maxSpeed!;
        let reached = -1, low = Infinity, high = 0, stalls = 0, touching = 0, far = 0, lowAlt = Infinity, turned = 0, last = b.yaw;
        for (let k = 0; k < 30 * hz; k++) {
          flyStep(g, it, inp);
          if (reached < 0 && b.speed >= top - 1) reached = (k + 1) / hz;
          if (reached >= 0) (low = Math.min(low, b.speed)), (high = Math.max(high, b.speed));
          stalls += b.stalled ? 1 : 0;
          touching += b.contacts > 0 ? 1 : 0;
          const o = outside(b.position[0]!, b.position[2]!);
          far = Math.max(far, o);
          if (o > 0) lowAlt = Math.min(lowAlt, g.status().altitude);
          let d = b.yaw - last;
          if (d > Math.PI) d -= 2 * Math.PI;
          if (d < -Math.PI) d += 2 * Math.PI;
          turned += d;
          last = b.yaw;
        }
        return { g, reached, low, high, stalls, touching, far, lowAlt, turned: Math.abs(turned) / DEG };
      };
      const r = runOnce(), r2 = runOnce();
      const same = r.g.body.saveState().every((x, i) => x === r2.g.body.saveState()[i]);
      const top = GLIDER_ASSIST.maxSpeed!;
      const ok = same && r.reached > 0 && r.low > top - 1.5 && r.high < top + 1 && r.stalls === 0 && r.touching === 0 && r.far > 0 && r.far < FLIGHT_AREA.soft + FLIGHT_AREA.band + 60 && r.lowAlt > FLIGHT_AREA.floor - 0.5 && r.turned > 90;
      return verdict(ok, `top speed ${top} m/s reached after ${f(r.reached, 2)} s, then ${f(r.low, 2)}–${f(r.high, 2)} m/s; stalled steps ${r.stalls}, touching ${r.touching}; out over the land up to ${f(r.far, 0)} m beyond the course (lowest ${f(r.lowAlt, 1)} m there), turned back by ${f(r.turned, 0)}° in all; two runs ${same ? 'bit-equal' : 'differ'}`);
    },
  },
  {
    name: 'glide-assist-outside',
    run() {
      // 40 m outside the course, 10 m up, flying away from it, Shift held for 60 s: it does not come down outside (the
      // floor), the flight range turns it back, and it lands on the course where the figure can get off.
      const g = setup(true);
      g.launch(60, course().world.groundAt(60, -40, 1e4, 0) + 10, -40, 0, GLIDER_ASSIST.cruiseSpeed!);
      const b = g.body;
      const it = newFlyingIntent(), inp = newFlightAssistInput();
      inp.climb = -1;
      const hz = 1 / b.stepSeconds;
      let lowOut = Infinity, far = 0, t = 0, touching = 0;
      for (let k = 0; k < 60 * hz && !b.grounded; k++) {
        flyStep(g, it, inp);
        t = (k + 1) / hz;
        const o = outside(b.position[0]!, b.position[2]!);
        far = Math.max(far, o);
        // Clear of the edge (along it the floor comes and goes as it crosses).
        if (o > 5) lowOut = Math.min(lowOut, g.status().altitude);
        touching += b.contacts > 0 ? 1 : 0;
      }
      // Braking to a stop, then getting off.
      inp.climb = 0;
      for (let k = 0; k < 4 * hz; k++) flyStep(g, it, inp);
      const p = b.position;
      const ok = b.grounded && outside(p[0]!, p[2]!) === 0 && lowOut > FLIGHT_AREA.floor - 0.5 && b.touchDowns === 1 && touching <= 2 && g.canDismount();
      return verdict(ok, `out to ${f(far, 0)} m beyond the course, never under ${f(lowOut, 1)} m there more than 5 m out (floor ${FLIGHT_AREA.floor}); down after ${f(t, 1)} s at (${f(p[0]!, 1)}, ${f(p[2]!, 1)}) on the course, touch-downs ${b.touchDowns}, touching ${touching} steps; can get off ${g.canDismount()}`);
    },
  },
];
