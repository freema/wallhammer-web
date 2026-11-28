// Scenarios of the wheeled body (`WheeledBody`, `WheeledGroup`, `collideWheeledBodies` in world/wheeled.ts) and the
// collision world's queries it uses (`sphereContacts`, `setBox`): rest on flat ground and on a slope, the default
// tuning's acceleration, top speed, braking distance, turning circles, understeer and a handbrake turn, a ramp, a
// kerb, a jump off an edge, walls head-on, at an angle and thin at top speed, rolling onto the side and upside down,
// energy without throttle, a walker against a parked body, two bodies, frame rates, bits, save and restore, CPU time.

import { CollisionWorld, newSphereContacts } from '../../packages/wallhammer-web/src/world/collide.ts';
import { Walker, newWalkIntent } from '../../packages/wallhammer-web/src/world/walker.ts';
import { WheeledBody, WheeledGroup, newWheeledIntent } from '../../packages/wallhammer-web/src/world/wheeled.ts';
import type { WheeledIntent } from '../../packages/wallhammer-web/src/world/wheeled.ts';
import { f, meanMs, seeded, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

const HZ = 60;
const KMH100 = 100 / 3.6;
const DEG = Math.PI / 180;

function flat(): CollisionWorld {
  return new CollisionWorld({ heightAt: () => 0, baseMinY: 0, baseMaxY: 0 });
}

/** A body set down at rest height over the ground at (x, z), facing `yawDeg`. */
function body(world: CollisionWorld, x = 0, z = 0, yawDeg = 0): WheeledBody {
  const b = new WheeledBody(world);
  b.teleport(x, world.baseHeightAt(x, z) + b.restHeight, z, yawDeg * DEG);
  return b;
}

function intent(throttle = 0, steer = 0, brake = 0, handbrake = false): WheeledIntent {
  const i = newWheeledIntent();
  i.throttle = throttle;
  i.steer = steer;
  i.brake = brake;
  i.handbrake = handbrake;
  return i;
}

/**
 * A body at rest height over the plane y = x · tan(slope), turned to `yawDeg` and tilted with the plane (yaw 90° faces
 * downhill, −90° uphill, 0 across).
 */
function onSlope(world: CollisionWorld, yawDeg: number, slopeDeg: number): WheeledBody {
  const b = new WheeledBody(world);
  b.teleport(0, b.restHeight / Math.cos(slopeDeg * DEG), 0, yawDeg * DEG);
  // The plane's tilt: a turn about z by the slope (x rises), applied after the yaw.
  const t = (slopeDeg * DEG) / 2;
  const q = b.orientation;
  const tz = Math.sin(t);
  const tw = Math.cos(t);
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
  q[0] = tw * x - tz * y;
  q[1] = tw * y + tz * x;
  q[2] = tw * z + tz * w;
  q[3] = tw * w - tz * z;
  return b;
}

/** Gives a body a speed along its forward axis at once (an impulse at the centre of mass). */
function launch(b: WheeledBody, speed: number): void {
  const R = b.rotation;
  const m = b.setup.mass * speed;
  const p = b.position;
  b.applyImpulse(p[0]!, p[1]!, p[2]!, -R[6]! * m, -R[7]! * m, -R[8]! * m);
}

/** Steps a body until its forward speed reaches `speed` with full throttle (at most 60 s). */
function speedUp(b: WheeledBody, speed: number): number {
  const it = intent(1);
  let n = 0;
  while (b.forwardSpeed < speed && n < 60 * HZ) {
    b.step(it);
    n++;
  }
  return n;
}

function finite(b: WheeledBody): boolean {
  for (const a of [b.position, b.orientation, b.velocity, b.angularVelocity]) for (const x of a) if (!Number.isFinite(x)) return false;
  return true;
}

/** Up axis of the body: its y component (1 upright, 0 on its side, −1 upside down). */
function upY(b: WheeledBody): number {
  return b.rotation[4]!;
}

/** Spring energy of the wheels on the ground, J. */
function springEnergy(b: WheeledBody): number {
  let e = 0;
  for (const w of b.wheels) {
    if (!w.grounded) continue;
    const c = Math.min(Math.max(w.compression, 0), w.spec.travel);
    e += 0.5 * w.spec.stiffness * c * c;
  }
  return e;
}

function energy(b: WheeledBody): number {
  return b.kineticEnergy + b.setup.mass * b.setup.gravity * b.position[1]! + springEnergy(b);
}

/** A steady circle: speed held by a throttle controller, full steer after 8 s, mean radius and slips over the last 10 s. */
function circle(speed: number, steer: number): { radius: number; front: number; rear: number } {
  const w = flat();
  const b = body(w);
  const it = intent();
  let sumR = 0;
  let n = 0;
  let front = 0;
  let rear = 0;
  for (let i = 0; i < 30 * HZ; i++) {
    const v = b.forwardSpeed;
    it.throttle = Math.max(0, Math.min(1, (speed - v) * 0.8 + 0.1));
    it.steer = i > 8 * HZ ? steer : 0;
    b.step(it);
    if (i > 20 * HZ) {
      const vel = b.velocity;
      const wy = Math.abs(b.angularVelocity[1]!);
      if (wy > 1e-6) {
        sumR += Math.hypot(vel[0]!, vel[2]!) / wy;
        n++;
      }
      front += b.wheels[0]!.slip + b.wheels[1]!.slip;
      rear += b.wheels[2]!.slip + b.wheels[3]!.slip;
    }
  }
  return { radius: sumR / n, front: front / n, rear: rear / n };
}

/** A wall across +x… at z = zFace (the side facing +z), from x0 to x1, `thick` deep, 3 m high. */
function wallWorld(thick: number): CollisionWorld {
  const w = flat();
  w.addPrism([-30, -thick, 30, -thick, 30, 0, -30, 0], 0, 3);
  return w;
}

/** Head-on into the wall at z = 0 from z = 8, at `speed`: the nearest the hull came, the speed after, the energy. */
function headOn(speed: number, thick: number): { front: number; back: number; e0: number; e1: number; vz: number; stuck: boolean; ok: boolean } {
  const w = wallWorld(thick);
  const b = body(w, 0, 8 + b0Half, 0);
  for (let i = 0; i < 30; i++) b.step(intent());
  launch(b, speed);
  const e0 = b.kineticEnergy;
  let front = Infinity;
  let eMax = 0;
  let ok = true;
  for (let i = 0; i < 4 * HZ; i++) {
    b.step(intent());
    const zFront = lowest(b, 2);
    if (zFront < front) front = zFront;
    if (i > 2 * HZ) eMax = Math.max(eMax, b.kineticEnergy);
    if (!finite(b)) ok = false;
  }
  // Behind the wall's back face means it went through.
  return { front, back: b.position[2]!, e0, e1: eMax, vz: b.velocity[2]!, stuck: false, ok };
}
const b0Half = 2.1;

const scenarios: Scenario[] = [
  {
    name: 'wheeled-sphere-contacts',
    run() {
      // The collision world's sphere query: beside a side, over a top, at a rounded edge, centre inside, the base.
      const w = new CollisionWorld({ heightAt: () => 0 });
      w.addBox(0, 0, 1, 1, 0, 0, 2);
      const c = newSphereContacts(4);
      const errs: number[] = [];
      w.sphereContacts(1.3, 1, 0, 0.5, c);
      errs.push(Math.abs(c.depth[0]! - 0.2), Math.abs(c.nx[0]! - 1));
      w.sphereContacts(0, 2.4, 0, 0.5, c);
      errs.push(Math.abs(c.depth[0]! - 0.1), Math.abs(c.ny[0]! - 1));
      w.sphereContacts(1.2, 2.2, 0, 0.5, c);
      errs.push(Math.abs(c.depth[0]! - (0.5 - Math.SQRT2 * 0.2)), Math.abs(c.nx[0]! - Math.SQRT1_2), Math.abs(c.ny[0]! - Math.SQRT1_2));
      w.sphereContacts(0.9, 1, 0, 0.5, c);
      errs.push(Math.abs(c.depth[0]! - 0.6), Math.abs(c.nx[0]! - 1));
      const base = w.sphereContacts(5, 0.3, 5, 0.5, c);
      errs.push(base === 1 ? Math.abs(c.depth[0]! - 0.2) + Math.abs(c.solid[0]! + 1) : 1);
      const skipped = w.sphereContacts(1.3, 1, 0, 0.5, c, 0);
      const worst = Math.max(...errs);
      return verdict(worst < 1e-9 && skipped === 0, `largest error ${worst.toExponential(1)} over side, top, edge, inside and base; a skipped tag gives ${skipped} contacts`);
    },
  },
  {
    name: 'wheeled-set-box-moves-in-place',
    run() {
      const w = flat();
      const id = w.addBox(0, 0, 1, 2, 0, 0, 1.5, { standable: false, blocksSight: false });
      w.setBox(id, 10, 0, 1, 2, 90 * DEG, 0, 1.5);
      const c = newSphereContacts(4);
      const old = w.sphereContacts(0, 0.75, 0, 0.3, c);
      // Turned 90°: the box's half x of 1 now lies along z, its half z of 2 along x.
      const inX = w.sphereContacts(11.9, 0.75, 0, 0.3, c) === 1;
      const outZ = w.sphereContacts(10, 0.75, 1.4, 0.3, c) === 0;
      const walker = new Walker(w);
      walker.teleport(13, 0, 0);
      const it = newWalkIntent();
      it.moveX = -1;
      for (let i = 0; i < 120; i++) walker.step(it);
      return verdict(old === 0 && inX && outZ && w.has(id) && Math.abs(walker.position[0]! - 12.3) < 1e-3,
        `no contact at the old place: ${old === 0}; turned extents right: ${inX && outZ}; same id kept; a walker stops at x ${f(walker.position[0]!, 4)} (12.3)`);
    },
  },
  {
    name: 'wheeled-rest-flat',
    run() {
      const w = flat();
      const b = new WheeledBody(w);
      b.teleport(3, b.restHeight + 0.05, -2, 30 * DEG);
      const it = intent();
      let y2 = 0;
      for (let i = 0; i < 10 * HZ; i++) {
        b.step(it);
        if (i === 5 * HZ) y2 = b.position[1]!;
      }
      const drift = Math.hypot(b.position[0]! - 3, b.position[2]! + 2);
      const comp = (b.setup.mass * b.setup.gravity) / 4 / b.wheels[0]!.spec.stiffness;
      let cErr = 0;
      for (const wh of b.wheels) cErr = Math.max(cErr, Math.abs(wh.compression - comp));
      const still = Math.abs(b.position[1]! - y2);
      return verdict(drift < 1e-3 && cErr < 2e-3 && still === 0 && b.asleep && Math.abs(b.yaw - 30 * DEG) < 1e-4,
        `drift ${f(drift * 1000, 3)} mm over 10 s, compression ${f(b.wheels[0]!.compression, 4)} m (static ${f(comp, 4)}), height change over the last 5 s ${still}, asleep ${b.asleep}`);
    },
  },
  {
    name: 'wheeled-rest-slope-15-brake-and-handbrake',
    run() {
      const t = Math.tan(15 * DEG);
      const w = new CollisionWorld({ heightAt: (x) => x * t });
      const out: string[] = [];
      let ok = true;
      // Facing downhill (−x is downhill: yaw 90° faces −x) with the brake, uphill with the handbrake, across with the brake.
      for (const [label, yaw, it] of [['brake facing downhill', 90, intent(0, 0, 1)], ['handbrake facing uphill', -90, intent(0, 0, 0, true)], ['brake across', 0, intent(0, 0, 1)]] as const) {
        const b = onSlope(w, yaw, 15);
        let x2 = 0;
        let z2 = 0;
        for (let i = 0; i < 12 * HZ; i++) {
          b.step(it);
          if (i === 2 * HZ) {
            x2 = b.position[0]!;
            z2 = b.position[2]!;
          }
        }
        const drift = Math.hypot(b.position[0]! - x2, b.position[2]! - z2);
        const settle = Math.hypot(x2, z2);
        if (!(drift < 0.005 && settle < 0.15 && b.asleep)) ok = false;
        out.push(`${label}: settled ${f(settle * 100, 1)} cm, drift ${f(drift * 1000, 2)} mm over 10 s, asleep ${b.asleep}`);
      }
      return verdict(ok, out.join('; '));
    },
  },
  {
    name: 'wheeled-acceleration-and-top-speed',
    run() {
      const b = body(flat());
      const it = intent(1);
      let t100 = -1;
      let top = 0;
      for (let i = 0; i < 90 * HZ; i++) {
        b.step(it);
        if (t100 < 0 && b.forwardSpeed >= KMH100) t100 = (i + 1) / HZ;
        if (b.forwardSpeed > top) top = b.forwardSpeed;
      }
      return verdict(t100 >= 7.5 && t100 <= 10.5 && top >= 42 && top <= 48, `0–100 km/h in ${f(t100, 2)} s (8–10), top speed ${f(top, 2)} m/s after 90 s (about 45)`);
    },
  },
  {
    name: 'wheeled-braking-distance',
    run() {
      const b = body(flat());
      speedUp(b, KMH100);
      const v0 = b.forwardSpeed;
      const z0 = b.position[2]!;
      const it = intent(0, 0, 1);
      let n = 0;
      while (b.forwardSpeed > 0.01 && n < 20 * HZ) {
        b.step(it);
        n++;
      }
      const d = z0 - b.position[2]!;
      return verdict(d >= 38 && d <= 52, `from ${f(v0 * 3.6, 1)} km/h to a stop in ${f(d, 2)} m (40–50), ${f(n / HZ, 2)} s`);
    },
  },
  {
    name: 'wheeled-turning-circle-low-speed',
    run() {
      const c = circle(1.5, 1);
      return verdict(c.radius * 2 >= 10 && c.radius * 2 <= 13, `diameter of the centre's circle at 1.5 m/s, full steer: ${f(c.radius * 2, 2)} m (about 11)`);
    },
  },
  {
    name: 'wheeled-understeer-at-speed',
    run() {
      const c = circle(25, 1);
      const lat = (25 * 25) / c.radius / 9.81;
      return verdict(c.front > c.rear && lat > 0.7 && lat < 1.1, `full steer at 25 m/s: radius ${f(c.radius, 1)} m (${f(lat, 2)} g), sliding front ${f(c.front, 2)} m/s > rear ${f(c.rear, 2)} m/s`);
    },
  },
  {
    name: 'wheeled-handbrake-turn',
    run() {
      const turn = (hand: boolean): number => {
        const b = body(flat());
        speedUp(b, 15);
        const y0 = b.yaw;
        for (let i = 0; i < 90; i++) b.step(intent(0, 1, 0, hand && i < 40));
        let d = b.yaw - y0;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        return Math.abs(d) / DEG;
      };
      const plain = turn(false);
      const hand = turn(true);
      return verdict(hand > 1.6 * plain, `heading change in 1.5 s from 15 m/s at full steer: ${f(hand, 1)}° with the handbrake for 0.67 s, ${f(plain, 1)}° without (gain ${f(hand / plain, 2)})`);
    },
  },
  {
    name: 'wheeled-ramp-climb',
    run() {
      // Flat to z = −10, a 12° ramp to 3 m, a plateau beyond.
      const t = Math.tan(12 * DEG);
      const top = 3;
      const w = new CollisionWorld({ heightAt: (_x, z) => (z > -10 ? 0 : Math.min(top, (-10 - z) * t)) });
      const b = body(w, 0, 0, 0);
      const it = intent(0.7);
      let hull = 0;
      for (let i = 0; i < 12 * HZ; i++) {
        b.step(it);
        hull += b.hullContacts;
      }
      const up = upY(b);
      const ok = b.position[2]! < -10 - top / t - 5 && Math.abs(b.position[1]! - (top + b.restHeight)) < 0.1 && up > 0.99 && hull === 0;
      return verdict(ok, `on the plateau at z ${f(b.position[2]!, 1)}, height ${f(b.position[1]!, 3)} (${f(top + b.restHeight, 3)} at rest), up ${f(up, 4)}, hull contacts ${hull}`);
    },
  },
  {
    name: 'wheeled-kerb',
    run() {
      // A kerb 0.15 m high and 3 m deep across the way, driven onto at 6 m/s and off again.
      const w = flat();
      w.addPrism([-20, -15, 20, -15, 20, -12, -20, -12], 0, 0.15);
      const b = body(w, 0, 0, 0);
      speedUp(b, 6);
      let pitch = 0;
      let hull = 0;
      const it = intent(0.2);
      for (let i = 0; i < 4 * HZ; i++) {
        b.step(it);
        pitch = Math.max(pitch, Math.abs(Math.asin(Math.max(-1, Math.min(1, b.rotation[7]!)))) / DEG);
        hull += b.hullContacts;
      }
      const ok = b.position[2]! < -16 && upY(b) > 0.999 && b.forwardSpeed > 4 && hull === 0;
      return verdict(ok, `past the kerb at z ${f(b.position[2]!, 1)}, speed ${f(b.forwardSpeed, 2)} m/s, largest pitch ${f(pitch, 2)}°, hull contacts ${hull}`);
    },
  },
  {
    name: 'wheeled-jump-off-an-edge',
    run() {
      // A plateau 3 m high ending at z = −30; the ground below.
      const w = new CollisionWorld({ heightAt: (_x, z) => (z > -30 ? 3 : 0) });
      const b = body(w, 0, 100, 0);
      speedUp(b, 20);
      let air = 0;
      let landed = -1;
      let minUp = 1;
      const it = intent(0);
      for (let i = 0; i < 6 * HZ; i++) {
        b.step(it);
        if (b.groundedWheels === 0) air++;
        if (air > 0 && landed < 0 && b.groundedWheels > 0) landed = i;
        if (air > 0) minUp = Math.min(minUp, upY(b));
      }
      const ok = finite(b) && air > 20 && landed > 0 && upY(b) > 0.99 && b.forwardSpeed > 10 && b.groundedWheels === 4 && Math.abs(b.position[1]! - b.restHeight) < 0.05;
      return verdict(ok, `${air} steps in the air, on its wheels again at z ${f(b.position[2]!, 1)}, speed ${f(b.forwardSpeed, 2)} m/s, lowest up ${f(minUp, 3)}, height ${f(b.position[1]!, 3)}`);
    },
  },
  {
    name: 'wheeled-wall-head-on',
    run() {
      const out: string[] = [];
      let ok = true;
      for (const speed of [10, 30]) {
        const r = headOn(speed, 0.5);
        // The hull's front never inside the wall (its face at z = 0) by more than a few centimetres, the energy after
        // the hit is below the energy before, and the body does not stay pressed into the wall.
        const pass = r.ok && r.front > -0.06 && r.e1 < r.e0 * 0.5 && r.back > 0;
        if (!pass) ok = false;
        out.push(`${speed} m/s: deepest ${f(-Math.min(r.front, 0) * 100, 1)} cm, energy ${f(r.e0 / 1000, 1)} kJ before, at most ${f(r.e1 / 1000, 2)} kJ after, rebound ${f(r.vz, 2)} m/s`);
      }
      return verdict(ok, out.join('; '));
    },
  },
  {
    name: 'wheeled-wall-at-30-degrees',
    run() {
      // A long wall along z at x = 0 (its face toward +x); the body comes in from +x heading 30° into it.
      const w = flat();
      w.addPrism([-0.5, -200, 0, -200, 0, 50, -0.5, 50], 0, 3);
      const b = body(w, 6, 0, 30);
      for (let i = 0; i < 20; i++) b.step(intent());
      launch(b, 20);
      const v0 = b.velocity;
      const along0 = -v0[2]!;
      const e0 = b.kineticEnergy;
      let minX = Infinity;
      let eMax = 0;
      let hit = -1;
      for (let i = 0; i < 3 * HZ; i++) {
        b.step(intent());
        // Nearest hull sphere surface to the wall.
        const S = b.hullSpheres;
        for (let k = 0; k < S.length; k += 4) {
          const R = b.rotation;
          const x = b.position[0]! + R[0]! * S[k]! + R[3]! * S[k + 1]! + R[6]! * S[k + 2]! - S[k + 3]!;
          if (x < minX) minX = x;
        }
        // The hit: the speed toward the wall gone (the hull stops a few centimetres short when it bounces).
        if (b.velocity[0]! > -0.1 && hit < 0) hit = i;
        if (hit >= 0) eMax = Math.max(eMax, b.kineticEnergy);
      }
      const along = -b.velocity[2]!;
      const heading = b.yaw / DEG;
      const ok = finite(b) && hit >= 0 && minX > -0.06 && along > 0.3 * along0 && eMax <= e0 * 1.0001 && Math.abs(heading) < 20 && b.position[0]! > 0;
      return verdict(ok, `deepest ${f(-Math.min(minX, 0) * 100, 1)} cm; speed along the wall ${f(along0, 1)} → ${f(along, 1)} m/s; heading 30° → ${f(heading, 1)}°; energy never above the start (${f(eMax / e0, 4)})`);
    },
  },
  {
    name: 'wheeled-thin-wall-top-speed',
    run() {
      const w = wallWorld(0.1);
      const b = body(w, 0, 60, 0);
      for (let i = 0; i < 20; i++) b.step(intent());
      launch(b, 46);
      let behind = false;
      let front = Infinity;
      for (let i = 0; i < 3 * HZ; i++) {
        b.step(intent());
        if (b.position[2]! < -0.1) behind = true;
        front = Math.min(front, lowest(b, 2));
      }
      return verdict(!behind && finite(b) && front > -0.1, `a wall 0.1 m thick hit at 46 m/s (0.77 m a step): through it ${behind}, deepest front ${f(-Math.min(front, 0) * 100, 1)} cm, rest at z ${f(b.position[2]!, 2)}`);
    },
  },
  {
    name: 'wheeled-rolled-onto-side-and-upside-down-rests',
    run() {
      const out: string[] = [];
      let ok = true;
      for (const roll of [90, 180, 75]) {
        const w = flat();
        const b = new WheeledBody(w);
        b.teleport(0, 1.6, 0, 0);
        // Turn it about the forward axis (z) by `roll`.
        const h = (roll * DEG) / 2;
        b.orientation[0] = 0;
        b.orientation[1] = 0;
        b.orientation[2] = Math.sin(h);
        b.orientation[3] = Math.cos(h);
        let p2 = [0, 0, 0];
        for (let i = 0; i < 8 * HZ; i++) {
          b.step(intent());
          if (i === 6 * HZ) p2 = [b.position[0]!, b.position[1]!, b.position[2]!];
        }
        const drift = Math.hypot(b.position[0]! - p2[0]!, b.position[1]! - p2[1]!, b.position[2]! - p2[2]!);
        const pass = finite(b) && drift < 1e-3 && b.speed < 0.05 && b.position[1]! > 0.3;
        if (!pass) ok = false;
        out.push(`${roll}°: up ${f(upY(b), 3)}, height ${f(b.position[1]!, 3)}, drift over the last 2 s ${f(drift * 1000, 2)} mm, asleep ${b.asleep}`);
      }
      // An impulse high on the side rolls a body standing on its wheels over.
      const w = flat();
      const b = body(w);
      for (let i = 0; i < 30; i++) b.step(intent());
      const R = b.rotation;
      b.applyImpulse(b.position[0]! + R[3]! * 1.2, b.position[1]! + R[4]! * 1.2, b.position[2]! + R[5]! * 1.2, 7000, 0, 0);
      let minUp = 1;
      for (let i = 0; i < 8 * HZ; i++) {
        b.step(intent());
        minUp = Math.min(minUp, upY(b));
      }
      if (!(finite(b) && minUp < 0 && b.speed < 0.05)) ok = false;
      out.push(`pushed high on the side: rolled to up ${f(minUp, 3)}, rests at up ${f(upY(b), 3)}, speed ${f(b.speed, 3)}`);
      // setUpright() puts it back on its wheels.
      b.setUpright();
      for (let i = 0; i < 3 * HZ; i++) b.step(intent());
      if (!(upY(b) > 0.999 && b.groundedWheels === 4)) ok = false;
      out.push(`after setUpright up ${f(upY(b), 4)}`);
      return verdict(ok, out.join('; '));
    },
  },
  {
    name: 'wheeled-energy-never-grows-without-throttle',
    run() {
      // Rolling over bumps and through turns, a wall at the end, no throttle: the energy (motion, height, springs)
      // never rises above its value at any earlier moment by more than a small tolerance.
      const w = new CollisionWorld({ heightAt: (x, z) => 0.25 * Math.sin(x * 0.3) * Math.sin(z * 0.21) });
      w.addCylinder(-6, -120, 1, 0, 3);
      w.addBox(10, -160, 30, 1, 0, 0, 3);
      const b = body(w, 0, 0, 0);
      for (let i = 0; i < 60; i++) b.step(intent());
      launch(b, 25);
      let best = energy(b);
      const e0 = best;
      let worst = 0;
      for (let i = 0; i < 40 * HZ; i++) {
        const steer = Math.sin(i / 70) * 0.8;
        b.step(intent(0, steer, i % 600 < 30 ? 0.5 : 0, i % 900 > 870));
        const e = energy(b);
        worst = Math.max(worst, e - best);
        if (e < best) best = e;
      }
      const tol = 0.004 * e0;
      return verdict(finite(b) && worst < tol, `largest rise of the energy over its lowest earlier value ${f(worst, 1)} J (tolerance ${f(tol, 0)} J of ${f(e0 / 1000, 1)} kJ); final speed ${f(b.speed, 2)} m/s`);
    },
  },
  {
    name: 'wheeled-walker-blocked-by-parked-body',
    run() {
      const w = flat();
      const b = body(w, 0, 0, 0);
      for (let i = 0; i < 2 * HZ; i++) b.step(intent());
      b.syncObstacle();
      const out: string[] = [];
      let ok = true;
      // From the side (+x) and from the front (−z).
      for (const [sx, sz, mx, mz, want, axis] of [[4, 0, -1, 0, 0.9 + 0.3, 0], [0, -6, 0, 1, -(2.1 + 0.3), 2]] as const) {
        const walker = new Walker(w);
        walker.teleport(sx, 0, sz);
        const it = newWalkIntent();
        it.moveX = mx;
        it.moveZ = mz;
        it.run = true;
        for (let i = 0; i < 4 * HZ; i++) walker.step(it);
        const at = walker.position[axis]!;
        const pass = Math.abs(at - want) < 0.02 && walker.position[1] === 0;
        if (!pass) ok = false;
        out.push(`${axis === 0 ? 'side' : 'front'}: stops at ${f(at, 3)} (${f(want, 2)}), feet at ${f(walker.position[1]!, 2)}`);
      }
      // The body's own hull and wheels do not see its obstacle box: it drives off.
      for (let i = 0; i < 2 * HZ; i++) b.step(intent(0.5));
      if (!(b.position[2]! < -2 && b.hullContacts === 0)) ok = false;
      out.push(`the body drives off its own box to z ${f(b.position[2]!, 2)}`);
      return verdict(ok, out.join('; '));
    },
  },
  {
    name: 'wheeled-two-bodies',
    run() {
      // A body at 12 m/s into a parked one; then two head-on at 8 m/s each.
      const out: string[] = [];
      let ok = true;
      {
        const w = flat();
        const a = body(w, 0, 0, 0);
        const c = body(w, 0.3, -12, 0);
        const g = new WheeledGroup([a, c]);
        for (let i = 0; i < 30; i++) g.step([]);
        launch(a, 12);
        let gap = Infinity;
        for (let i = 0; i < 4 * HZ; i++) {
          g.step([]);
          gap = Math.min(gap, minGap(a, c));
        }
        const pass = finite(a) && finite(c) && gap > -0.05 && a.position[2]! > c.position[2]! && c.position[2]! < -14;
        if (!pass) ok = false;
        out.push(`into a parked body: deepest overlap ${f(-Math.min(gap, 0) * 100, 1)} cm, the parked one pushed ${f(-12 - c.position[2]!, 2)} m`);
      }
      {
        const w = flat();
        const a = body(w, 0, 0, 0);
        const c = body(w, 0, -15, 180);
        const g = new WheeledGroup([a, c]);
        for (let i = 0; i < 30; i++) g.step([]);
        launch(a, 8);
        launch(c, 8);
        const e0 = a.kineticEnergy + c.kineticEnergy;
        let gap = Infinity;
        let eMax = 0;
        let touched = false;
        for (let i = 0; i < 3 * HZ; i++) {
          g.step([]);
          gap = Math.min(gap, minGap(a, c));
          if (gap < 0.02) touched = true;
          if (touched) eMax = Math.max(eMax, a.kineticEnergy + c.kineticEnergy);
        }
        // Equal and opposite: the two bodies end mirrored about z = −7.5.
        const sym = Math.abs(a.position[2]! + c.position[2]! + 15);
        const pass = touched && gap > -0.05 && eMax <= e0 && sym < 1e-6;
        if (!pass) ok = false;
        out.push(`head-on at 8 m/s each: deepest overlap ${f(-Math.min(gap, 0) * 100, 1)} cm, energy after the touch at most ${f(eMax / e0, 3)} of before, mirror error ${sym.toExponential(1)} m`);
      }
      return verdict(ok, out.join('; '));
    },
  },
  {
    name: 'wheeled-frame-rate-independent',
    run() {
      // The same 3 s of input cut into frames of 1/30, 1/60 and 1/144 s give the same steps and the same bits.
      const runs: Uint8Array[] = [];
      const counts: number[] = [];
      for (const fps of [30, 60, 144]) {
        const w = flat();
        w.addBox(3, -25, 2, 1, 0.4, 0, 2);
        const b = body(w);
        const it = intent();
        let steps = 0;
        const frames = 3 * fps;
        for (let k = 0; k < frames; k++) {
          // The intent changes only on whole fixed steps, so every frame rate sees the same input per step.
          // Changes fall on even steps, the start of a frame at 30 Hz.
          it.throttle = steps < 90 ? 1 : 0.3;
          it.steer = steps >= 60 && steps < 120 ? 0.5 : 0;
          it.brake = steps >= 150 ? 1 : 0;
          steps += b.advance(1 / fps, it);
        }
        counts.push(steps);
        runs.push(b.saveState().slice(0, 8 * 21));
      }
      const same = runs.every((r) => r.every((x, i) => x === runs[0]![i]));
      return verdict(counts.every((c) => c === 180) && same, `steps ${counts.join(', ')} (180); pose and velocities bit-equal: ${same}`);
    },
  },
  {
    name: 'wheeled-deterministic',
    run() {
      const once = (): Uint8Array => {
        const w = wallWorld(0.5);
        w.addCylinder(4, -30, 0.5, 0, 3);
        const b = body(w, 0, 40, 0);
        const rnd = seeded(7);
        const it = intent();
        for (let i = 0; i < 20 * HZ; i++) {
          if (i % 20 === 0) {
            it.throttle = rnd() * 2 - 0.6;
            it.steer = rnd() * 2 - 1;
            it.brake = rnd() < 0.2 ? 1 : 0;
            it.handbrake = rnd() < 0.1;
          }
          b.step(it);
        }
        return b.saveState();
      };
      const a = once();
      const c = once();
      const same = a.length === c.length && a.every((x, i) => x === c[i]);
      return verdict(same, `two runs of 20 s with walls, steering, brakes and handbrake: whole states bit-equal ${same} (${a.length} bytes)`);
    },
  },
  {
    name: 'wheeled-save-restore',
    run() {
      const w = wallWorld(0.5);
      const b = body(w, 0, 30, 0);
      const it = intent(1, 0.3);
      for (let i = 0; i < 300; i++) b.step(it);
      const saved = b.saveState();
      for (let i = 0; i < 400; i++) b.step(it);
      const end1 = b.saveState();
      const c = new WheeledBody(w);
      c.loadState(saved);
      for (let i = 0; i < 400; i++) c.step(it);
      const end2 = c.saveState();
      const same = end1.every((x, i) => x === end2[i]);
      return verdict(same && b.stateBytes === 30 * 8 + 4 * 20 * 8 + 8 * 4 * 8, `400 steps after a restore into another body bit-equal: ${same}; ${b.stateBytes} bytes for four wheels`);
    },
  },
  {
    name: 'wheeled-step-cpu',
    kind: 'timing',
    run() {
      // A world of 2,000 solids (as the walker's timing), a body driving a slow circle among them.
      const w = new CollisionWorld({ heightAt: (x, z) => 0.1 * Math.sin(x * 0.05) * Math.cos(z * 0.05) });
      const rnd = seeded(3);
      for (let i = 0; i < 2000; i++) {
        const x = (rnd() - 0.5) * 400;
        const z = (rnd() - 0.5) * 400;
        if (Math.hypot(x, z) < 40) continue;
        if (i % 2 === 0) w.addCylinder(x, z, 0.3 + rnd(), 0, 3);
        else w.addBox(x, z, 0.5 + rnd() * 3, 0.5 + rnd() * 3, rnd() * 3, 0, 2 + rnd() * 5);
      }
      const b = body(w);
      const it = intent(0.4, 0.35);
      for (let i = 0; i < 600; i++) b.step(it);
      const ms = meanMs(10000, () => b.step(it));
      const us = ms * 1000;
      return verdict(us < 20, `${f(us, 2)} µs per step of one body (target 20 µs), at ${f(b.speed, 1)} m/s among 2,000 solids`);
    },
  },
  {
    name: 'wheeled-group-alpha',
    run() {
      // A body in a group draws at the group's share of the step by default and refuses an advance of its own; a body
      // set upright keeps its heading, and a teleport without a yaw keeps it too.
      const w = flat();
      const a = body(w, 0, 0, 0), c = body(w, 6, 0, 40);
      const g = new WheeledGroup([a, c]);
      g.advance(1.5 / HZ, []);
      const share = a.alpha === g.alpha && c.alpha === g.alpha && Math.abs(g.alpha - 0.5) < 1e-9;
      let refused = false;
      try {
        a.advance(1 / HZ, newWheeledIntent());
      } catch {
        refused = true;
      }
      let twice = false;
      try {
        new WheeledGroup([a]);
      } catch {
        twice = true;
      }
      const lone = body(w, 0, 20, 25);
      lone.teleport(0, 5, 20);
      const kept = Math.abs(lone.yaw - 25 * DEG) < 1e-9;
      lone.setUpright();
      const upright = Math.abs(lone.yaw - 25 * DEG) < 1e-9 && Math.abs(lone.position[1]! - lone.restHeight) < 1e-9;
      return verdict(share && refused && twice && kept && upright, `group alpha ${f(g.alpha, 3)} shared by its bodies ${share}; own advance refused ${refused}; a second group refused ${twice}; teleport without a yaw keeps the heading ${kept}; upright at rest height, heading kept ${upright}`);
    },
  },
];

/** Smallest world coordinate `axis` reached by the hull's spheres' surfaces. */
function lowest(b: WheeledBody, axis: number): number {
  const S = b.hullSpheres;
  const R = b.rotation;
  let best = Infinity;
  for (let k = 0; k < S.length; k += 4) {
    const x = b.position[axis]! + R[axis]! * S[k]! + R[3 + axis]! * S[k + 1]! + R[6 + axis]! * S[k + 2]! - S[k + 3]!;
    if (x < best) best = x;
  }
  return best;
}

/** Smallest gap between the hulls' spheres of two bodies (negative: overlap), metres. */
function minGap(a: WheeledBody, b: WheeledBody): number {
  let best = Infinity;
  const pa = a.position, pb = b.position, Ra = a.rotation, Rb = b.rotation;
  const A = a.hullSpheres, B = b.hullSpheres;
  for (let i = 0; i < A.length; i += 4) {
    const ax = pa[0]! + Ra[0]! * A[i]! + Ra[3]! * A[i + 1]! + Ra[6]! * A[i + 2]!;
    const ay = pa[1]! + Ra[1]! * A[i]! + Ra[4]! * A[i + 1]! + Ra[7]! * A[i + 2]!;
    const az = pa[2]! + Ra[2]! * A[i]! + Ra[5]! * A[i + 1]! + Ra[8]! * A[i + 2]!;
    for (let j = 0; j < B.length; j += 4) {
      const bx = pb[0]! + Rb[0]! * B[j]! + Rb[3]! * B[j + 1]! + Rb[6]! * B[j + 2]!;
      const by = pb[1]! + Rb[1]! * B[j]! + Rb[4]! * B[j + 1]! + Rb[7]! * B[j + 2]!;
      const bz = pb[2]! + Rb[2]! * B[j]! + Rb[5]! * B[j + 1]! + Rb[8]! * B[j + 2]!;
      const d = Math.hypot(ax - bx, ay - by, az - bz) - A[i + 3]! - B[j + 3]!;
      if (d < best) best = d;
    }
  }
  return best;
}

export const WHEELED_SCENARIOS: Scenario[] = scenarios;
