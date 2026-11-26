// Scenarios of the flying body (`FlyingBody` in world/flying.ts) with its default setup over flat ground: a crawl and a
// leap off the ground with beats, the glide's sink rate at the trim speed against the glide ratio, a stall below the
// stall speed and the dive out of it, the radius of a banked turn against the bank's, a flared touch-down that ends
// crawling and then at rest, flying into a wall and diving into the ground without passing through either, perching
// on a roof it comes to rest on, bit-equal runs and a saved state that runs on the same. Then the flight assist
// (`FlightAssist` in world/flight-assist.ts) with its default setup on the same body: hands off it holds its speed and
// height; it reaches its slow, cruise and fast speeds and holds each; it holds a climb and a descent rate; a level
// turn of 360° keeps the speed and the height; it never lets the body stall and dives a stalled one back to speed; a
// descent to the ground lands; flown into a wall it stops beating against it and comes down; two assisted flights are
// bit-equal.

import { CollisionWorld } from '../../packages/wallhammer-web/src/world/collide.ts';
import { DEFAULT_FLYING_BODY, FlyingBody, newFlyingIntent } from '../../packages/wallhammer-web/src/world/flying.ts';
import type { FlyingIntent } from '../../packages/wallhammer-web/src/world/flying.ts';
import { FlightAssist, newFlightAssistInput } from '../../packages/wallhammer-web/src/world/flight-assist.ts';
import type { FlightAssistInput } from '../../packages/wallhammer-web/src/world/flight-assist.ts';
import { f, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

const HZ = 60;
/** The default setup's trim speed (the glide's settled speed). */
const DEFAULT_TRIM = DEFAULT_FLYING_BODY.trimSpeed;

function flat(): CollisionWorld {
  return new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0 });
}

function intent(o: Partial<FlyingIntent> = {}): FlyingIntent {
  return Object.assign(newFlyingIntent(), o);
}

/** A body in the air at (0, y, 0) flying level toward −z at `speed`. */
function launched(world: CollisionWorld, y: number, speed: number): FlyingBody {
  const b = new FlyingBody(world);
  b.teleport(0, y, 0, 0);
  b.velocity[2] = -speed;
  return b;
}

/** Steps `b` for `seconds` with `it` (its `takeOff` used in the first step only); `each` sees every step. */
function run(b: FlyingBody, seconds: number, it: FlyingIntent, each?: (i: number) => void): void {
  const n = Math.round(seconds * HZ);
  for (let i = 0; i < n; i++) {
    b.step(it);
    it.takeOff = false;
    each?.(i);
  }
}

/** The lowest point of the hull's spheres above the ground (the hull level: its attitude only drawn). */
function lowestHull(b: FlyingBody): number {
  const h = b.setup.hull;
  let low = Infinity;
  for (let i = 0; i < h.length; i += 4) low = Math.min(low, b.position[1]! + h[i + 1]! - h[i + 3]!);
  return low;
}

/** A scripted flight: a crawl, a leap with beats, a climb, turns both ways, a dive and a flare to the ground. */
function script(b: FlyingBody): void {
  run(b, 1, intent({ forward: 1 }));
  run(b, 2, intent({ forward: 1, beat: 1, takeOff: true }));
  run(b, 3, intent({ beat: 1, pitch: 0.4 }));
  run(b, 4, intent({ turn: 1 }));
  run(b, 3, intent({ turn: -0.6, beat: 0.5 }));
  run(b, 4, intent({ pitch: -0.5 }));
  run(b, 6, intent({ brake: 1 }));
  run(b, 2, intent({ forward: 1, turn: 0.5 }));
}

/** A body launched at (0, 200, 0) toward −z at `speed` with an assist wanting that speed. */
function assisted(speed: number): { b: FlyingBody; a: FlightAssist } {
  const b = launched(flat(), 200, speed);
  const a = new FlightAssist(b);
  a.reset(speed);
  return { b, a };
}

function input(o: Partial<FlightAssistInput> = {}): FlightAssistInput {
  return Object.assign(newFlightAssistInput(), o);
}

/** Steps `a` for `seconds` with `inp`; `each` sees every step. */
function fly(a: FlightAssist, seconds: number, inp: FlightAssistInput, it: FlyingIntent, each?: (i: number) => void): void {
  const n = Math.round(seconds * HZ);
  for (let i = 0; i < n; i++) {
    a.step(inp, it);
    each?.(i);
  }
}

/** Seconds from the first step to 90 % of the way from `from` to `to` of the speed (−1: not reached). */
function t90(b: FlyingBody, from: number, to: number, i: number, at: { t: number }): void {
  if (at.t < 0 && (b.speed - from) / (to - from) >= 0.9) at.t = (i + 1) / HZ;
}

/** An assisted flight from the ground: a crawl, the leap, a climb, faster, a turn, slower, a descent to the ground. */
function assistedScript(b: FlyingBody, a: FlightAssist): void {
  const it = intent();
  const go = (seconds: number, o: Partial<FlightAssistInput>, forward = 0, takeOff = false): void => {
    const inp = input(o);
    it.forward = forward;
    it.takeOff = takeOff;
    // Frames of 1/30 s and 1/90 s by turns: the assist steers every fixed step all the same.
    for (let t = 0, k = 0; t < seconds; k++) {
      const dt = k % 2 === 0 ? 1 / 30 : 1 / 90;
      a.advance(dt, inp, it);
      it.takeOff = false;
      t += dt;
    }
  };
  go(1, {}, 1);
  go(2, { climb: 1 }, 1, true);
  go(2, { climb: 1, throttle: 1 });
  go(4, { turn: 1 });
  go(2, { throttle: -1, turn: -0.5 });
  go(12, { climb: -1 });
}

export const FLYING_SCENARIOS: Scenario[] = [
  {
    name: 'flying-take-off',
    run() {
      const b = new FlyingBody(flat());
      b.teleport(0, 0, 0, 0);
      run(b, 1, intent({ forward: 1 }));
      const crawl = b.speed;
      const grounded = b.grounded;
      let top = 0;
      run(b, 4, intent({ forward: 1, beat: 1, takeOff: true }), () => (top = Math.max(top, b.position[1]!)));
      const ok = grounded && crawl > 1 && crawl <= b.setup.groundSpeed + 1e-9 && b.takeOffs === 1 && !b.grounded && top > 5 && b.speed > b.setup.stallSpeed;
      return verdict(ok, `crawl ${f(crawl, 2)} m/s, take-offs ${b.takeOffs}, top ${f(top, 2)} m after 4 s of beats, speed ${f(b.speed, 2)} m/s`);
    },
  },
  {
    name: 'flying-glide-sink-rate',
    run() {
      const b = launched(flat(), 400, DEFAULT_TRIM);
      run(b, 25, intent());
      const v = b.velocity;
      const along = Math.hypot(v[0]!, v[2]!);
      const ratio = along / -v[1]!;
      const ok = Math.abs(ratio / b.setup.glideRatio - 1) < 0.2 && Math.abs(b.speed / b.setup.trimSpeed - 1) < 0.2 && !b.stalled;
      return verdict(ok, `level glide settles at ${f(b.speed, 2)} m/s, sinking ${f(-v[1]!, 2)} m/s: ratio ${f(ratio, 2)} against ${b.setup.glideRatio}`);
    },
  },
  {
    name: 'flying-stall',
    run() {
      const b = launched(flat(), 400, 3);
      let stalled = false;
      let fall = 0;
      run(b, 2, intent({ pitch: 1 }), () => {
        stalled ||= b.stalled;
        fall = Math.min(fall, b.velocity[1]!);
      });
      run(b, 8, intent());
      const recovered = !b.stalled && b.speed > b.setup.stallSpeed;
      return verdict(stalled && fall < -3 && recovered, `stalled ${stalled}, falling ${f(-fall, 2)} m/s, after 8 s ${f(b.speed, 2)} m/s and ${recovered ? 'flying' : 'still stalled'}`);
    },
  },
  {
    name: 'flying-bank-turn-radius',
    run() {
      const b = launched(flat(), 400, DEFAULT_TRIM);
      run(b, 4, intent({ turn: 1 }));
      const y0 = b.yaw;
      let turned = 0;
      let last = y0;
      const T = 4;
      run(b, T, intent({ turn: 1 }), () => {
        let d = b.yaw - last;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        turned += d;
        last = b.yaw;
      });
      const V = Math.hypot(b.velocity[0]!, b.velocity[2]!);
      const r = V / Math.abs(turned / T);
      const theory = (V * V) / (b.setup.gravity * Math.tan(b.bank));
      const ok = turned < 0 && Math.abs(r / theory - 1) < 0.3 && Math.abs(b.bank - b.setup.maxBank) < 0.05;
      return verdict(ok, `bank ${f(b.bank, 3)} rad, radius ${f(r, 1)} m against ${f(theory, 1)} m of a level turn at ${f(V, 2)} m/s (right turns the heading down)`);
    },
  },
  {
    name: 'flying-touch-down',
    run() {
      const b = launched(flat(), 2.5, 9);
      let low = Infinity;
      run(b, 6, intent({ brake: 1 }), () => (low = Math.min(low, lowestHull(b))));
      const landed = b.grounded && b.touchDowns === 1;
      run(b, 4, intent());
      const ok = landed && b.speed < 1e-6 && Math.abs(b.position[1]!) < 1e-9 && low > -0.02;
      return verdict(ok, `touch-downs ${b.touchDowns} at ${f(b.touchDownSpeed, 2)} m/s down, at rest ${f(b.speed, 4)} m/s, at ${f(b.position[1]!, 4)} m, hull lowest ${f(low, 3)} m`);
    },
  },
  {
    name: 'flying-wall-and-ground',
    run() {
      const w = flat();
      // A wall 40 m high across the way at z −40, 0.5 m thick.
      w.addBox(0, -40, 20, 0.25, 0, 0, 40);
      const b = launched(w, 3, 14);
      let far = 0;
      let low = Infinity;
      let hits = 0;
      run(b, 6, intent({ beat: 0.3 }), () => {
        far = Math.min(far, b.position[2]!);
        low = Math.min(low, lowestHull(b));
        if (b.contacts > 0) hits++;
      });
      // Then a dive into the ground from 20 m, beside the wall.
      const d = launched(w, 20, 15);
      d.teleport(30, 20, 0, 0);
      d.velocity[2] = -15;
      let dlow = Infinity;
      run(d, 10, intent({ pitch: -1 }), () => (dlow = Math.min(dlow, lowestHull(d))));
      const r = b.setup.hull[3]!;
      const ok = far > -39.75 + r - 0.05 && hits > 0 && low > -0.03 && dlow > -0.03 && d.grounded;
      return verdict(ok, `into the wall: the middle stopped ${f(far + 39.75, 3)} m before its face (radius ${r}), ${hits} steps touching; lowest hull ${f(low, 3)} m; the dive from 20 m: lowest ${f(dlow, 3)} m, ${d.grounded ? 'down' : 'still flying'}`);
    },
  },
  {
    name: 'flying-perch-on-roof',
    run() {
      const w = flat();
      // A flat roof 3 m up that is not standable ground: the body comes to rest on it, held by its hull.
      w.addBox(0, -6, 4, 4, 0, 0, 3, { standable: false });
      const b = new FlyingBody(w);
      b.teleport(0, 4.2, -6, 0);
      run(b, 3, intent());
      const perched = b.perched && b.grounded;
      const y = b.position[1]!;
      // Put down nose first, it levels out sinking onto the roof: one touch-down, no hops.
      const downs = b.touchDowns;
      // Crawling off the edge it drops to the ground.
      run(b, 8, intent({ forward: 1 }));
      const ok = perched && Math.abs(y - 3) < 0.005 && downs === 1 && !b.perched && b.position[1]! < 0.01;
      return verdict(ok, `perched ${perched} at ${f(y, 3)} m (the roof at 3 m) after ${downs} touch-down(s); crawled off: ${b.perched ? 'still perched' : 'down'} at ${f(b.position[1]!, 3)} m`);
    },
  },
  {
    name: 'flying-bits',
    run() {
      const runs = [0, 1].map(() => {
        const b = new FlyingBody(flat());
        b.teleport(0, 0, 0, 0.3);
        script(b);
        return b.saveState();
      });
      const same = runs[0]!.every((x, i) => x === runs[1]![i]);
      return verdict(same, `two scripted flights of 25 s (crawl, leap, climb, turns, dive, flare, crawl): ${same ? 'bit-equal' : 'differ'}`);
    },
  },
  {
    name: 'flying-save-load',
    run() {
      const b = new FlyingBody(flat());
      b.teleport(0, 0, 0, 0);
      run(b, 1, intent({ forward: 1 }));
      run(b, 3, intent({ forward: 1, beat: 1, takeOff: true }));
      const saved = b.saveState();
      run(b, 5, intent({ turn: 0.7, beat: 0.4 }));
      const end1 = b.saveState();
      const c = new FlyingBody(flat());
      c.loadState(saved);
      run(c, 5, intent({ turn: 0.7, beat: 0.4 }));
      const end2 = c.saveState();
      const same = end1.every((x, i) => x === end2[i]);
      return verdict(same, `in the air, saved, 5 s more on the first body and on a second loaded from the save: ${same ? 'bit-equal' : 'differ'}`);
    },
  },
  {
    name: 'flying-assist-hold',
    run() {
      const { b, a } = assisted(a0().cruiseSpeed);
      const it = intent();
      let lo = Infinity, hi = 0, ylo = Infinity, yhi = -Infinity;
      fly(a, 20, input(), it, (i) => {
        if (i < 2 * HZ) return;
        lo = Math.min(lo, b.speed);
        hi = Math.max(hi, b.speed);
        ylo = Math.min(ylo, b.position[1]! - 200);
        yhi = Math.max(yhi, b.position[1]! - 200);
      });
      const w = a.wantedSpeed;
      const ok = hi - w < 0.2 && w - lo < 0.2 && yhi < 0.2 && ylo > -0.2 && b.beatEffort > 0.05 && !b.stalled;
      return verdict(ok, `hands off 20 s at ${w} m/s: speed ${f(lo, 2)}–${f(hi, 2)} m/s, height ${f(ylo, 3)} to ${f(yhi, 3)} m, beating ${f(b.beatEffort, 2)} by itself`);
    },
  },
  {
    name: 'flying-assist-speeds',
    run() {
      const d = a0();
      const { b, a } = assisted(d.cruiseSpeed);
      const it = intent();
      const slow = a.safeSpeed, cruise = d.cruiseSpeed, fast = d.maxSpeed;
      const parts: string[] = [];
      let ok = true, dev = 0;
      for (const to of [slow, fast, cruise, fast, slow]) {
        const from = b.speed;
        a.wantedSpeed = to;
        const at = { t: -1 };
        let lo = Infinity, hi = 0, sdev = 0;
        fly(a, 6, input(), it, (i) => {
          t90(b, from, to, i, at);
          sdev = Math.max(sdev, Math.abs(b.position[1]! - 200));
          if (i >= 4 * HZ) (lo = Math.min(lo, b.speed)), (hi = Math.max(hi, b.speed));
        });
        ok &&= at.t > 0 && at.t < 2.5 && hi - to < 0.25 && to - lo < 0.25 && !b.stalled;
        dev = Math.max(dev, sdev);
        parts.push(`${f(from, 1)}→${f(to, 1)} in ${f(at.t, 2)} s (then ${f(lo, 2)}–${f(hi, 2)}, height within ${f(sdev, 2)} m)`);
      }
      ok &&= dev < 0.5;
      return verdict(ok, `90 % of a speed change: ${parts.join(', ')}`);
    },
  },
  {
    name: 'flying-assist-climb-descent',
    run() {
      const d = a0();
      const parts: string[] = [];
      let ok = true;
      for (const c of [1, -1, 0.5]) {
        const { b, a } = assisted(d.cruiseSpeed);
        const it = intent();
        let vy = 0, n = 0, dv = 0;
        fly(a, 6, input({ climb: c }), it, (i) => {
          dv = Math.max(dv, Math.abs(b.speed - d.cruiseSpeed));
          if (i >= 3 * HZ) (vy += b.velocity[1]!), n++;
        });
        vy /= n;
        const want = c > 0 ? c * d.climbRate : c * d.descentRate;
        ok &&= Math.abs(vy - want) < 0.15 && dv < 0.6;
        parts.push(`climb ${c}: ${f(vy, 2)} m/s against ${f(want, 2)}, speed within ${f(dv, 2)} m/s`);
      }
      return verdict(ok, `at ${d.cruiseSpeed} m/s: ${parts.join('; ')}`);
    },
  },
  {
    name: 'flying-assist-turn',
    run() {
      const { b, a } = assisted(a0().cruiseSpeed);
      const it = intent();
      fly(a, 1, input(), it);
      let turned = 0, last = b.yaw, t = 0, dv = 0, dy = 0;
      const inp = input({ turn: 1 });
      while (Math.abs(turned) < 2 * Math.PI && t < 30) {
        a.step(inp, it);
        t += 1 / HZ;
        let d = b.yaw - last;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        turned += d;
        last = b.yaw;
        dv = Math.max(dv, Math.abs(b.speed - a.wantedSpeed));
        dy = Math.max(dy, Math.abs(b.position[1]! - 200));
      }
      const V = Math.hypot(b.velocity[0]!, b.velocity[2]!);
      const r = V / (Math.abs(b.yaw - last) * HZ || Math.abs(turned) / t);
      const theory = (V * V) / (b.setup.gravity * Math.tan(Math.abs(b.bank)));
      const ok = Math.abs(turned) >= 2 * Math.PI && dv < 0.3 && dy < 0.3 && Math.abs(r / theory - 1) < 0.3;
      return verdict(ok, `a level turn of 360° in ${f(t, 1)} s at ${f(V, 2)} m/s: radius ${f(r, 1)} m against ${f(theory, 1)} m at bank ${f(b.bank, 3)} rad, speed within ${f(dv, 3)} m/s, height within ${f(dy, 3)} m`);
    },
  },
  {
    name: 'flying-assist-no-stall',
    run() {
      // Asked to fly too slow and to climb, then to turn and climb at once: it never stalls.
      const { b, a } = assisted(a0().cruiseSpeed);
      const it = intent();
      let low = Infinity, stalled = false;
      const watch = (): void => {
        low = Math.min(low, b.speed);
        stalled ||= b.stalled;
      };
      fly(a, 10, input({ throttle: -1, climb: 1 }), it, watch);
      fly(a, 10, input({ throttle: -1, climb: 1, turn: 1 }), it, watch);
      // A body stalled already (4 m/s, below the stall speed) is dived back to speed.
      const s = assisted(4);
      let back = -1;
      fly(s.a, 8, input(), it, (i) => {
        if (back < 0 && s.b.speed >= s.a.safeSpeed - 0.5 * s.a.setup.stallMargin) back = (i + 1) / HZ;
      });
      const ok = !stalled && low >= b.setup.stallSpeed && back > 0 && !s.b.stalled && s.b.speed > s.b.setup.stallSpeed;
      return verdict(ok, `20 s of asking slower and up (and a turn): slowest ${f(low, 2)} m/s against a stall at ${b.setup.stallSpeed}, ${stalled ? 'stalled' : 'never stalled'}; from 4 m/s back over the guard in ${f(back, 2)} s, then ${f(s.b.speed, 2)} m/s`);
    },
  },
  {
    name: 'flying-assist-land',
    run() {
      const { b, a } = assisted(8);
      b.teleport(0, 12, 0, 0);
      b.velocity[2] = -8;
      a.reset(8);
      const it = intent();
      let low = Infinity, t = 0;
      const inp = input({ climb: -1 });
      while (!b.grounded && t < 15) {
        a.step(inp, it);
        t += 1 / HZ;
        low = Math.min(low, lowestHull(b));
      }
      const ok = b.grounded && b.touchDowns === 1 && b.touchDownSpeed < 1.5 && low > -0.02;
      return verdict(ok, `a descent from 12 m at 8 m/s: down after ${f(t, 1)} s at ${f(b.touchDownSpeed, 2)} m/s down (it eases to ${a.setup.landingSink}), hull lowest ${f(low, 3)} m`);
    },
  },
  {
    name: 'flying-assist-wall',
    run() {
      // Flown at its cruise into a wall 40 m high, hands off: it stops beating against it and comes down at its foot.
      const w = flat();
      w.addBox(0, -40.3, 8, 0.3, 0, 0, 40);
      const b = launched(w, 10, a0().cruiseSpeed);
      const a = new FlightAssist(b);
      a.reset();
      const it = intent();
      let first = -1, pushing = 0, touching = 0;
      fly(a, 15, input(), it, (i) => {
        if (b.contacts > 0) {
          touching++;
          if (first < 0) first = i;
          if (b.beatEffort > 0.5) pushing++;
        }
      });
      const ok = first >= 0 && pushing / HZ < 1 && b.grounded && b.contacts === 0 && lowestHull(b) > -0.01;
      return verdict(ok, `hit the wall after ${f((first + 1) / HZ, 2)} s; touching it ${f(touching / HZ, 2)} s, of which beating over half ${f(pushing / HZ, 2)} s; after 15 s ${b.grounded ? 'down' : 'in the air'} at ${f(b.position[1]!, 3)} m, ${f(b.position[2]! + 40, 2)} m before the wall's face`);
    },
  },
  {
    name: 'flying-assist-bits',
    run() {
      const runs = [0, 1].map(() => {
        const b = new FlyingBody(flat());
        b.teleport(0, 0, 0, 0.3);
        const a = new FlightAssist(b);
        assistedScript(b, a);
        return { s: b.saveState(), w: a.wantedSpeed, h: a.holdY, b };
      });
      const r0 = runs[0]!, r1 = runs[1]!;
      const same = r0.s.every((x, i) => x === r1.s[i]) && Object.is(r0.w, r1.w) && Object.is(r0.h, r1.h);
      const ok = same && r0.b.takeOffs === 1 && r0.b.touchDowns >= 1 && r0.b.grounded;
      return verdict(ok, `two assisted flights of 23 s from the ground (crawl, leap, climb, faster, a turn, slower, a descent to a landing; frames of 1/30 and 1/90 s): ${same ? 'bit-equal' : 'differ'}, take-offs ${r0.b.takeOffs}, touch-downs ${r0.b.touchDowns}`);
    },
  },
];

/** The assist's default setup. */
function a0(): FlightAssist['setup'] {
  return new FlightAssist(new FlyingBody(flat())).setup;
}
