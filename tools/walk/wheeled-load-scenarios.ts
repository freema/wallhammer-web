// Scenarios of what a wheeled body carries and is pushed by (`WheeledBody.setLoad`, `applyForce`, the hook of
// `advance` in world/wheeled.ts) and of the saved state of a `WheeledGroup`: a load sinks the springs by its weight and
// leans the body to its side until the springs' centre is under the common centre of mass, a load high up leans the
// body out of a turn and back under drive and does not turn it in a free fall, an impulse and a meeting of two bodies
// keep the momentum of the body and its loads, a changed load wakes a sleeping body, a force lasts one step, states
// with loads and of a group restore to the same bits, and a state written before loads existed is still read.

import { ByteReader } from '../../packages/wallhammer-web/src/sim/bytes.ts';
import { CollisionWorld } from '../../packages/wallhammer-web/src/world/collide.ts';
import { WHEELED_LOAD_SLOTS, WheeledBody, WheeledGroup, newWheeledIntent } from '../../packages/wallhammer-web/src/world/wheeled.ts';
import type { WheeledIntent } from '../../packages/wallhammer-web/src/world/wheeled.ts';
import { f, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

const HZ = 60;
const DEG = Math.PI / 180;

function flat(): CollisionWorld {
  return new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0 });
}

function body(world: CollisionWorld, x = 0, z = 0, yawDeg = 0): WheeledBody {
  const b = new WheeledBody(world);
  b.teleport(x, world.baseHeightAt(x, z) + b.restHeight, z, yawDeg * DEG);
  return b;
}

function intent(throttle = 0, steer = 0, brake = 0): WheeledIntent {
  const i = newWheeledIntent();
  i.throttle = throttle;
  i.steer = steer;
  i.brake = brake;
  return i;
}

/** Steps an idle body until it sleeps (at most `seconds`); returns the steps taken. */
function settle(b: WheeledBody, seconds = 6): number {
  const it = intent();
  let n = 0;
  while (n < seconds * HZ) {
    b.step(it);
    n++;
    if (b.asleep) break;
  }
  return n;
}

/** Roll to the right (the body's up axis leaning to +x of a body that faces −z) and pitch nose up, radians. */
function rollRight(b: WheeledBody): number {
  // The body's up axis along its own right axis projected to the horizontal: positive when the right side is lower.
  const R = b.rotation;
  const rx = R[0]!, rz = R[2]!;
  const l = Math.hypot(rx, rz);
  return Math.asin((R[3]! * rx + R[5]! * rz) / l);
}

function pitchUp(b: WheeledBody): number {
  // The forward axis (−z of the body) above the horizon.
  return Math.asin(-b.rotation[7]!);
}

/**
 * How far the springs are from balancing the weight of a resting body with one load (`mass` at x, y, z of its frame)
 * about the ground under the origin, along `axis` (0: x, 2: z): the difference of the two moments over the weight,
 * metres of arm.
 */
function offBalance(b: WheeledBody, mass: number, x: number, y: number, z: number, axis: number): number {
  const R = b.rotation;
  const total = b.setup.mass + mass;
  const k = mass / total;
  // The common centre of mass in the world, along the axis.
  const c = b.position[axis]! + (R[axis]! * x + R[3 + axis]! * y + R[6 + axis]! * z) * k;
  let moment = 0;
  let sum = 0;
  for (const w of b.wheels) {
    // The spring's force alone: the load of a wheel also has the damper's share of the last motion before sleep.
    const force = w.spec.stiffness * w.compression;
    moment += force * w.contact[axis]!;
    sum += force;
  }
  return Math.abs(moment / sum - c);
}

/** World point of the centre of mass of a body and its one load in slot 0 at (0.6, 0.5, −0.8) of 300 kg. */
function commonCentre(b: WheeledBody): [number, number, number] {
  const R = b.rotation;
  const k = 300 / b.totalMass;
  const x = 0.6 * k, y = 0.5 * k, z = -0.8 * k;
  return [
    b.position[0]! + R[0]! * x + R[3]! * y + R[6]! * z,
    b.position[1]! + R[1]! * x + R[4]! * y + R[7]! * z,
    b.position[2]! + R[2]! * x + R[5]! * y + R[8]! * z,
  ];
}

/** Momentum of such a body and its load: the total mass × the velocity of their common centre of mass. */
function momentum(b: WheeledBody): [number, number, number] {
  const c = commonCentre(b);
  const rx = c[0] - b.position[0]!, ry = c[1] - b.position[1]!, rz = c[2] - b.position[2]!;
  const v = b.velocity;
  const w = b.angularVelocity;
  const m = b.totalMass;
  return [m * (v[0]! + w[1]! * rz - w[2]! * ry), m * (v[1]! + w[2]! * rx - w[0]! * rz), m * (v[2]! + w[0]! * ry - w[1]! * rx)];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Steady circle at `speed` with `steer` after 4 s; mean roll to the right over the last 3 s of 10 s. */
function rollInTurn(mass: number, y: number, speed: number, steer: number): number {
  const b = body(flat());
  if (mass > 0) b.setLoad(0, mass, 0, y, 0);
  const it = intent();
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 10 * HZ; i++) {
    it.throttle = Math.max(0, Math.min(1, (speed - b.forwardSpeed) * 0.8 + 0.1));
    it.steer = i > 4 * HZ ? steer : 0;
    b.step(it);
    if (i >= 7 * HZ) {
      sum += rollRight(b);
      n++;
    }
  }
  return sum / n;
}

/** Full throttle from rest for 1.5 s: the largest pitch nose up and the distance covered. */
function squat(mass: number, y: number): { pitch: number; run: number } {
  const b = body(flat());
  if (mass > 0) b.setLoad(0, mass, 0, y, 0);
  settle(b);
  const rest = pitchUp(b);
  const z0 = b.position[2]!;
  const it = intent(1);
  let pitch = 0;
  for (let i = 0; i < 1.5 * HZ; i++) {
    b.step(it);
    pitch = Math.max(pitch, pitchUp(b) - rest);
  }
  return { pitch, run: z0 - b.position[2]! };
}

const scenarios: Scenario[] = [
  {
    name: 'wheeled-load-rests-lower-and-leans',
    run() {
      const b = body(flat());
      const s = b.setup;
      const k = s.wheels[0]!.stiffness;
      settle(b);
      const y0 = b.position[1]!;
      // 300 kg at the centre of mass: every spring takes a quarter of the weight more.
      b.setLoad(0, 300, 0, 0, 0);
      settle(b);
      const sink = y0 - b.position[1]!;
      const wantSink = (300 * s.gravity) / (4 * k);
      const weight = (s.mass + 300) * s.gravity;
      let load = 0;
      for (const w of b.wheels) load += w.load;
      const level = Math.abs(rollRight(b)) < 1e-4 && Math.abs(pitchUp(b)) < 1e-4;
      // The same mass 0.6 m to the right: the body leans to it, near the weight's torque over the springs' roll
      // stiffness (4 k t²), and still falls asleep.
      b.setLoad(0, 300, 0.6, 0, 0);
      settle(b);
      const slept = b.asleep;
      const roll = rollRight(b);
      const t = Math.abs(s.wheels[0]!.x);
      const wantRoll = (300 * s.gravity * 0.6) / (4 * k * t * t);
      // 1 m forward of the centre: the nose goes down.
      b.setLoad(0, 300, 0, 0, -1);
      settle(b);
      const nose = pitchUp(b);
      // Taken away: the old rest pose (as near as a body falls asleep).
      b.setLoad(0, 0);
      settle(b);
      const back = Math.abs(b.position[1]! - y0);
      const levelAgain = Math.abs(rollRight(b)) < 1e-3 && Math.abs(pitchUp(b)) < 1e-3;
      // A body that never sleeps comes all the way to rest: there the springs carry the whole weight, and their
      // centre is under the centre of mass of the body and its load (to the side, to the front, and high and askew).
      const awake = new WheeledBody(flat(), { sleepSeconds: 1e9 });
      awake.teleport(0, awake.restHeight, 0, 0);
      const it = intent();
      let off = 0;
      let carried = 0;
      for (const [x, y, z] of [[0.6, 0, 0], [0, 0, -1], [0.3, 1.1, 0.4]] as const) {
        awake.setLoad(0, 300, x, y, z);
        for (let i = 0; i < 8 * HZ; i++) awake.step(it);
        off = Math.max(off, offBalance(awake, 300, x, y, z, 0), offBalance(awake, 300, x, y, z, 2));
        let springs = 0;
        for (const w of awake.wheels) springs += w.spec.stiffness * w.compression;
        carried = Math.max(carried, Math.abs(springs / weight - 1));
      }
      const ok = Math.abs(sink - wantSink) < 1e-3 && Math.abs(load / weight - 1) < 0.01 && level && slept && roll > 0 && Math.abs(roll / wantRoll - 1) < 0.25 && nose < -0.01 && back < 1e-3 && levelAgain && b.loadMass === 0 && b.totalMass === s.mass && off < 1e-4 && carried < 1e-4;
      return verdict(ok,
        `300 kg at the centre: ${f(sink * 1000, 2)} mm lower (static ${f(wantSink * 1000, 2)}), wheel loads ${f(load / weight, 4)} of the weight, level ${level}; 0.6 m to the right: asleep ${slept}, roll ${f(roll / DEG, 3)}° (springs alone ${f(wantRoll / DEG, 3)}°); 1 m forward: nose ${f(nose / DEG, 2)}°; taken away: ${f(back * 1000, 3)} mm from the old height, level ${levelAgain}; at full rest in three places the springs' centre is ${f(off * 1000, 3)} mm from under the common centre of mass and they carry the weight to ${carried.toExponential(1)}`);
    },
  },
  {
    name: 'wheeled-load-wakes-on-change-only',
    run() {
      const b = body(flat());
      settle(b);
      const slept = b.asleep;
      // Emptying an empty slot and clearing no loads change nothing.
      b.setLoad(2, 0);
      b.clearLoads();
      const still = b.asleep;
      b.setLoad(2, 80, 0.3, 0.2, 0.1);
      const woke = !b.asleep && b.loadMass === 80 && b.totalMass === b.setup.mass + 80;
      settle(b);
      b.setLoad(2, 80, 0.3, 0.2, 0.1);
      const same = b.asleep;
      b.setLoad(2, 80, 0.3, 0.2, 0.4);
      const moved = !b.asleep;
      settle(b);
      b.clearLoads();
      const cleared = !b.asleep && b.loadMass === 0;
      let refused = 0;
      for (const bad of [() => b.setLoad(-1, 1), () => b.setLoad(WHEELED_LOAD_SLOTS, 1), () => b.setLoad(0.5, 1), () => b.setLoad(0, -1), () => b.setLoad(0, NaN), () => b.setLoad(0, 1, Infinity)]) {
        try {
          bad();
        } catch {
          refused++;
        }
      }
      return verdict(slept && still && woke && same && moved && cleared && refused === 6,
        `asleep ${slept}; an empty slot emptied and no loads cleared: still asleep ${still}; a load set: awake ${woke}; the same values again: still asleep ${same}; its point moved: awake ${moved}; cleared: awake ${cleared}; bad slots and masses refused ${refused} of 6`);
    },
  },
  {
    name: 'wheeled-load-high-leans-and-squats',
    run() {
      // A steady right turn at 10 m/s: the body rolls out of it (to the left); 300 kg at 1.1 m above the centre of
      // mass rolls it further. Under full throttle the nose rises further too, and the heavier body covers less ground.
      const bare = rollInTurn(0, 0, 10, 0.5);
      const high = rollInTurn(300, 1.1, 10, 0.5);
      const low = rollInTurn(300, 0, 10, 0.5);
      const s0 = squat(0, 0);
      const s1 = squat(300, 1.1);
      const ok = bare < -0.005 && high < bare * 1.25 && Math.abs(low) < Math.abs(high) && s1.pitch > s0.pitch * 1.2 && s1.run < s0.run * 0.95;
      return verdict(ok,
        `roll in a right turn at 10 m/s: bare ${f(bare / DEG, 2)}°, 300 kg at the centre ${f(low / DEG, 2)}°, 300 kg 1.1 m up ${f(high / DEG, 2)}°; full throttle for 1.5 s: nose up ${f(s0.pitch / DEG, 2)}° and ${f(s0.run, 2)} m bare, ${f(s1.pitch / DEG, 2)}° and ${f(s1.run, 2)} m loaded`);
    },
  },
  {
    name: 'wheeled-load-free-fall-does-not-turn',
    run() {
      // In the air a load off the centre pulls with its weight and resists the fall alike: the body does not turn.
      const b = new WheeledBody(flat(), { drag: 0 });
      b.teleport(0, 30, 0, 20 * DEG);
      b.setLoad(0, 300, 0.7, 0.4, -1.2);
      const it = intent();
      let turn = 0;
      for (let i = 0; i < HZ; i++) {
        b.step(it);
        turn = Math.max(turn, Math.hypot(b.angularVelocity[0]!, b.angularVelocity[1]!, b.angularVelocity[2]!));
      }
      const fell = 30 - b.position[1]!;
      const want = 0.5 * b.setup.gravity * (1 + 1 / HZ);
      return verdict(turn < 1e-9 && Math.abs(fell - want) < 1e-6, `1 s of free fall with 300 kg off the centre: fastest turning ${turn.toExponential(1)} rad/s, fell ${f(fell, 4)} m (${f(want, 4)})`);
    },
  },
  {
    name: 'wheeled-load-keeps-momentum',
    run() {
      // In the air, without drag: an impulse changes the momentum of the body and its load together by itself, one
      // through their common centre of mass does not turn the body, and two bodies with loads that meet keep the sum
      // of their momenta.
      const mk = (x: number, z: number, yawDeg: number): WheeledBody => {
        const b = new WheeledBody(flat(), { drag: 0 });
        b.teleport(x, 40, z, yawDeg * DEG);
        b.setLoad(0, 300, 0.6, 0.5, -0.8);
        return b;
      };
      const it = intent();
      const a = mk(0, 0, 25);
      for (let i = 0; i < 5; i++) a.step(it);
      const before = momentum(a);
      const J = [700, 400, -1500] as const;
      a.applyImpulse(a.position[0]! + 0.9, a.position[1]! + 0.3, a.position[2]! - 0.4, J[0], J[1], J[2]);
      const after = momentum(a);
      let dp = 0;
      for (let k = 0; k < 3; k++) dp = Math.max(dp, Math.abs(after[k]! - before[k]! - J[k]));
      const turned = Math.hypot(a.angularVelocity[0]!, a.angularVelocity[1]!, a.angularVelocity[2]!);
      const c = mk(10, 0, 70);
      const cw = commonCentre(c);
      c.applyImpulse(cw[0]!, cw[1]!, cw[2]!, 900, -300, 500);
      const straight = Math.hypot(c.angularVelocity[0]!, c.angularVelocity[1]!, c.angularVelocity[2]!);
      const e = c.kineticEnergy;
      const speed = Math.hypot(900, 300, 500) / c.totalMass;
      const wantE = 0.5 * c.totalMass * speed * speed;
      // Two bodies with loads thrown at each other.
      const p = mk(0, 0, 0);
      const q = mk(0.5, -6, 140);
      p.applyImpulse(p.position[0]!, p.position[1]!, p.position[2]!, 0, 0, -9000);
      q.applyImpulse(q.position[0]!, q.position[1]!, q.position[2]!, 0, 0, 14000);
      let met = 0;
      let lost = 0;
      for (let i = 0; i < HZ; i++) {
        p.step(it);
        q.step(it);
        const m0 = momentum(p);
        const n0 = momentum(q);
        if (!p.collide(q)) continue;
        met++;
        const m1 = momentum(p);
        const n1 = momentum(q);
        for (let k = 0; k < 3; k++) lost = Math.max(lost, Math.abs(m1[k]! + n1[k]! - m0[k]! - n0[k]!));
      }
      return verdict(dp < 1e-9 && turned > 0.05 && straight < 1e-12 && Math.abs(e / wantE - 1) < 1e-9 && met > 0 && lost < 1e-8,
        `an impulse off the centre: momentum of the body and its load off by ${dp.toExponential(1)} kg m/s, turning ${f(turned, 3)} rad/s; one through the common centre of mass: turning ${straight.toExponential(1)} rad/s, energy ${f(e, 2)} J (${f(wantE, 2)}); two loaded bodies meeting in the air for ${met} steps: the sum of their momenta off by at most ${lost.toExponential(1)} kg m/s`);
    },
  },
  {
    name: 'wheeled-apply-force-one-step',
    run() {
      // In the air: a force for one step changes the velocity in that step only; the same force every step is the
      // matching impulse every step.
      const mk = (): WheeledBody => {
        const b = new WheeledBody(flat(), { drag: 0 });
        b.teleport(0, 40, 0, 10 * DEG);
        return b;
      };
      const it = intent();
      const a = mk();
      const g = a.setup.gravity;
      const h = a.stepSeconds;
      const F = 6000;
      a.applyForce(a.position[0]!, a.position[1]!, a.position[2]!, 0, F, 0);
      a.step(it);
      const dv1 = a.velocity[1]!;
      a.step(it);
      const dv2 = a.velocity[1]! - dv1;
      const one = Math.abs(dv1 - (F / a.setup.mass - g) * h) < 1e-12 && Math.abs(dv2 + g * h) < 1e-12;
      // Off the centre, sideways and up, for half a second: forces against impulses.
      const p = mk();
      const q = mk();
      for (let i = 0; i < HZ / 2; i++) {
        const fx = 900, fy = 2500, fz = -400;
        p.applyForce(p.position[0]! + 0.5, p.position[1]! + 0.2, p.position[2]! - 1, fx, fy, fz);
        q.applyImpulse(q.position[0]! + 0.5, q.position[1]! + 0.2, q.position[2]! - 1, fx * h, fy * h, fz * h);
        p.step(it);
        q.step(it);
      }
      let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(p.position[k]! - q.position[k]!), Math.abs(p.velocity[k]! - q.velocity[k]!), Math.abs(p.angularVelocity[k]! - q.angularVelocity[k]!));
      // A sleeping body wakes; a teleport drops a force that waits.
      const r = body(flat());
      settle(r);
      r.applyForce(r.position[0]!, r.position[1]!, r.position[2]!, 0, 100, 0);
      const woke = !r.asleep;
      r.teleport(0, 40, 0);
      r.step(it);
      const dropped = Math.abs(r.velocity[1]! + g * h) < 1e-9;
      return verdict(one && d < 1e-9 && woke && dropped,
        `one call: ${f(dv1, 5)} m/s in its step, ${f(dv2, 5)} in the next (gravity alone ${f(-g * h, 5)}): ${one}; a force every step against its impulse every step for 0.5 s: largest difference ${d.toExponential(1)}; wakes ${woke}; dropped by a teleport ${dropped}`);
    },
  },
  {
    name: 'wheeled-advance-after-step',
    run() {
      // The hook of a single body's advance runs once after every step; a force asked in it acts in the next step.
      const b = new WheeledBody(flat(), { drag: 0 });
      b.teleport(0, 40, 0);
      const it = intent();
      const g = b.setup.gravity;
      const h = b.stepSeconds;
      let calls = 0;
      const seen: number[] = [];
      const steps = b.advance(3.5 / HZ, it, () => {
        calls++;
        seen.push(b.steps);
        // Carries the body's weight from the next step on.
        b.applyForce(b.position[0]!, b.position[1]!, b.position[2]!, 0, b.setup.mass * g, 0);
      });
      const none = b.advance(0.2 / HZ, it, () => {
        calls += 100;
      });
      // Step 1 falls; steps 2 and 3 are carried.
      const fell = Math.abs(b.velocity[1]! + g * h) < 1e-12;
      return verdict(steps === 3 && calls === 3 && none === 0 && seen.join() === '1,2,3' && fell,
        `advance of 3.5 steps: ${steps} steps, ${calls} calls after steps ${seen.join(', ')}; no step, no call: ${none === 0 && calls === 3}; the force of the hook holds the body from the next step on ${fell}`);
    },
  },
  {
    name: 'wheeled-save-restore-with-loads',
    run() {
      const w = flat();
      w.addBox(6, -40, 2, 1, 0.3, 0, 2);
      const b = body(w, 0, 0, 0);
      b.setLoad(1, 300, 0.2, 1.1, 0.3);
      b.setLoad(5, 80, -0.4, 0.1, -0.2);
      const it = intent(1, 0.3);
      for (let i = 0; i < 200; i++) b.step(it);
      const saved = b.saveState();
      for (let i = 0; i < 300; i++) b.step(it);
      const end1 = b.saveState();
      const c = new WheeledBody(w);
      c.setLoad(0, 999, 1, 1, 1);
      c.loadState(saved);
      const carried = c.loadMass === 380;
      for (let i = 0; i < 300; i++) c.step(it);
      const same = sameBytes(end1, c.saveState());
      // A state of the format before loads: the header and the wheels, marked version 1.
      const bare = body(w, 0, 0, 0);
      for (let i = 0; i < 200; i++) bare.step(it);
      const oldBytes = (30 + 4 * 20) * 8;
      const v1 = bare.saveState().slice(0, oldBytes);
      new Float64Array(v1.buffer, 0, 1)[0] = 1;
      for (let i = 0; i < 300; i++) bare.step(it);
      const d = new WheeledBody(w);
      d.setLoad(3, 500, 0, 1, 0);
      d.loadState(v1);
      const emptied = d.loadMass === 0;
      for (let i = 0; i < 300; i++) d.step(it);
      const old = sameBytes(bare.saveState(), d.saveState());
      // The same old state as a part of a simulation's snapshot (`simState`): the part is as short as the state was.
      const e = new WheeledBody(w);
      e.setLoad(2, 200, 0, 1, 0);
      e.simState('body').load(new ByteReader(v1));
      const g = new WheeledBody(w);
      g.loadState(v1);
      const asPart = e.loadMass === 0 && sameBytes(e.saveState(), g.saveState());
      let refused = false;
      try {
        d.loadState(saved.slice(0, oldBytes));
      } catch {
        refused = true;
      }
      const bytes = (30 + 4 * 20 + 4 * WHEELED_LOAD_SLOTS) * 8;
      return verdict(carried && same && emptied && old && asPart && refused && b.stateBytes === bytes,
        `two loads restored into another body (${c.loadMass} kg): 300 steps on bit-equal ${same}; a state of the old format (${oldBytes} bytes) read, loads emptied ${emptied}, 300 steps on bit-equal to a body without loads ${old}, also as a part of a simulation's snapshot ${asPart}; a cut state refused ${refused}; ${b.stateBytes} bytes for four wheels`);
    },
  },
  {
    name: 'wheeled-group-save-restore',
    run() {
      // Two bodies that meet, advanced by frames that leave time over; a second group restored from the first's state
      // goes on to the same bits, the leftover time included.
      const mk = (): { g: WheeledGroup; a: WheeledBody; c: WheeledBody } => {
        const w = flat();
        const a = body(w, 0, 0, 0);
        const c = body(w, 0.4, -14, 180);
        return { g: new WheeledGroup([a, c]), a, c };
      };
      const its = [intent(1, 0.1), intent(0.8, -0.05)];
      const one = mk();
      one.a.setLoad(0, 250, 0, 1, 0);
      const frame = 1 / 47;
      for (let i = 0; i < 90; i++) one.g.advance(frame, its);
      const saved = one.g.saveState();
      const leftover = one.g.fixed.leftover;
      let touched = 0;
      for (let i = 0; i < 140; i++) one.g.advance(frame, its, (t) => (touched += t));
      const end1 = one.g.saveState();
      const two = mk();
      two.g.loadState(saved);
      const kept = two.g.fixed.leftover === leftover && leftover > 0 && two.g.alpha === leftover / two.g.stepSeconds && two.a.loadMass === 250;
      for (let i = 0; i < 140; i++) two.g.advance(frame, its);
      const same = sameBytes(end1, two.g.saveState());
      const three = new WheeledGroup([body(flat())]);
      let refused = false;
      try {
        three.loadState(saved);
      } catch {
        refused = true;
      }
      const bytes = 3 * 8 + one.a.stateBytes + one.c.stateBytes;
      return verdict(kept && same && refused && touched > 0 && one.g.stateBytes === bytes,
        `leftover ${f(leftover * 1000, 3)} ms and the load restored ${kept}; 140 frames on through a collision (${touched} touching steps) bit-equal ${same}; a state of another group refused ${refused}; ${one.g.stateBytes} bytes for two bodies`);
    },
  },
];

export const WHEELED_LOAD_SCENARIOS: Scenario[] = scenarios;
