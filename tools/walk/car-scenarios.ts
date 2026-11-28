// Scenarios of driving in the movement example (examples/movement/src/car.ts: two compact cars, each the engine's
// WheeledBody, stepped together in a WheeledGroup over the real course, the figure getting in and out). Getting in,
// driving and getting out ends with the figure standing on free ground beside the car; the figure's walker cannot walk
// through a parked car; a car cannot be entered through a wall, and next to a wall the figure gets out on the other
// side; one car pushed into the other never sinks into it; a lap under scripted input is bit-equal twice; a car rolling
// across the loose patch lays ruts there and nothing on grass. The loads: the figure's mass moves onto the car as it
// sits down and off again as it gets up (the car sinks on the driver's side and comes back); with the roof load the car
// sits lower, pulls away more slowly with its nose higher, rolls further in the same turn and stays on its wheels.

import { newSlideResult } from '../../packages/wallhammer-web/src/world/collide.ts';
import { Walker } from '../../packages/wallhammer-web/src/world/walker.ts';
import type { WheeledBody } from '../../packages/wallhammer-web/src/world/wheeled.ts';
import { MOVE_PROFILES } from '../../examples/shared/src/figures/profiles.ts';
import { PathfinderBody } from '../../examples/movement/src/body.ts';
import { Cars, DRIVER_KG, ROOF_LOAD_KG } from '../../examples/movement/src/car.ts';
import type { CarPlace } from '../../examples/movement/src/car.ts';
import { buildCourse } from '../../examples/movement/src/course.ts';
import type { Course } from '../../examples/movement/src/course.ts';
import { driveTo } from '../../examples/movement/src/drive.ts';
import { TRACE_KIND } from '../../examples/movement/src/trace-kinds.ts';
import { CONTACT_TRAIL_FLOATS } from '../../packages/wallhammer-web/src/core/contact-trail.ts';
import { f, verdict } from './scenario.ts';
import type { Scenario } from './scenario.ts';

let shared: Course | null = null;
function course(): Course {
  shared ??= buildCourse(7);
  return shared;
}

const DEG = Math.PI / 180;
/** The page's places of the two cars (examples/movement/src/main.ts). */
const PLACES: readonly CarPlace[] = [
  [66, 54.5, 90],
  [51, 50, 0],
];

/** The cars on the course with the figure's walker at (x, z); `run` gets them and returns the verdict, then they go. */
function withCars<T>(x: number, z: number, yawDeg: number, places: readonly CarPlace[], run: (cars: Cars, walker: Walker) => T): T {
  const c = course();
  const profile = MOVE_PROFILES.default;
  const walker = new Walker(c.world, profile.walker);
  const body = new PathfinderBody(walker.setup.height, profile, (px, pz, py) => c.world.groundAt(px, pz, py + 0.5, walker.setup.maxStepUp));
  walker.teleport(x, c.world.groundAt(x, z, 1e4, 0), z, yawDeg * DEG);
  const cars = new Cars(c.world, body, walker, places);
  try {
    return run(cars, walker);
  } finally {
    cars.removeObstacles();
  }
}

/** Steps the cars until `done` or `seconds` run out; returns the steps taken. */
function stepUntil(cars: Cars, seconds: number, done: () => boolean): number {
  const n = Math.round(seconds / cars.stepSeconds);
  for (let i = 0; i < n; i++) {
    if (done()) return i;
    cars.step();
  }
  return n;
}

/** The walker's feet in car `b`'s frame: x to its right, z backward. */
function inCarFrame(b: WheeledBody, w: Walker): [number, number] {
  const p = w.position, q = b.position, R = b.rotation;
  const dx = p[0]! - q[0]!, dz = p[2]! - q[2]!;
  return [dx * R[0]! + dz * R[2]!, dx * R[6]! + dz * R[8]!];
}

/** Whether the walker's cylinder overlaps no solid: a slide of nothing from where it stands leaves it there. */
const slid = newSlideResult();
function standsFree(w: Walker): boolean {
  const p = w.position, s = w.setup;
  const out = course().world.slide(p[0]!, p[2]!, s.radius - 0.005, p[1]! + s.maxStepUp, p[1]! + s.height, 0, 0, slid);
  return Math.hypot(out.x - p[0]!, out.z - p[2]!) < 1e-6;
}

/** Deepest overlap of the two cars' hull spheres, m (negative: apart). */
function hullOverlap(a: WheeledBody, b: WheeledBody): number {
  let deepest = -Infinity;
  const pa = a.position, pb = b.position, A = a.rotation, B = b.rotation, sa = a.hullSpheres, sb = b.hullSpheres;
  for (let i = 0; i < sa.length; i += 4) {
    const ax = pa[0]! + A[0]! * sa[i]! + A[3]! * sa[i + 1]! + A[6]! * sa[i + 2]!;
    const ay = pa[1]! + A[1]! * sa[i]! + A[4]! * sa[i + 1]! + A[7]! * sa[i + 2]!;
    const az = pa[2]! + A[2]! * sa[i]! + A[5]! * sa[i + 1]! + A[8]! * sa[i + 2]!;
    for (let j = 0; j < sb.length; j += 4) {
      const bx = pb[0]! + B[0]! * sb[j]! + B[3]! * sb[j + 1]! + B[6]! * sb[j + 2]!;
      const by = pb[1]! + B[1]! * sb[j]! + B[4]! * sb[j + 1]! + B[7]! * sb[j + 2]!;
      const bz = pb[2]! + B[2]! * sb[j]! + B[5]! * sb[j + 1]! + B[8]! * sb[j + 2]!;
      const d = sa[i + 3]! + sb[j + 3]! - Math.hypot(bx - ax, by - ay, bz - az);
      if (d > deepest) deepest = d;
    }
  }
  return deepest;
}

/** Roll to the right and nose-up pitch of a body, degrees. */
function rollRightDeg(b: WheeledBody): number {
  const R = b.rotation;
  return Math.asin((R[3]! * R[0]! + R[5]! * R[2]!) / Math.hypot(R[0]!, R[2]!)) / DEG;
}
function noseUpDeg(b: WheeledBody): number {
  return Math.asin(-b.rotation[7]!) / DEG;
}

export const CAR_SCENARIOS: Scenario[] = [
  {
    name: 'car-get-in-drive-get-out',
    run() {
      // The figure 1.5 m out from car 0's driver's door, as the page starts it a few steps away.
      return withCars(66, 57.5, 0, PLACES, (cars, walker) => {
        const near = cars.near(0);
        const entered = cars.enter(0);
        const inSteps = stepUntil(cars, 4, () => cars.mode === 'on');
        const b = cars.bodies[0]!;
        const d = cars.drive;
        // Off along the pad, a turn, then the brakes until it stands.
        d.throttle = 1;
        stepUntil(cars, 1.5, () => false);
        d.steer = 0.6;
        stepUntil(cars, 0.8, () => false);
        d.throttle = 0;
        d.steer = 0;
        d.brake = 1;
        stepUntil(cars, 4, () => Math.abs(b.forwardSpeed) < 0.2);
        d.brake = 0;
        const driven = Math.hypot(b.position[0]! - 66, b.position[2]! - 54.5);
        const exited = cars.exit();
        // From the first moment of getting out the figure's walker is at the door (what follows it never looks back
        // to where it got in).
        const lead = Math.hypot(walker.position[0]! - b.position[0]!, walker.position[2]! - b.position[2]!);
        const outSteps = stepUntil(cars, 3, () => cars.mode === 'off');
        const [lx, lz] = inCarFrame(b, walker);
        const ground = course().world.groundAt(walker.position[0]!, walker.position[2]!, walker.position[1]! + 0.5, 0.5);
        const free = standsFree(walker);
        const side = -lx - (b.setup.halfWidth + walker.setup.radius);
        const ok = near && entered && cars.mode === 'off' && exited && driven > 8 && side > -0.01 && side < 0.6 && Math.abs(lz) < 1.5 && Math.abs(walker.position[1]! - ground) < 0.02 && free && cars.figureShown && lead < 2.5;
        return verdict(ok, `walker ${f(lead, 2)} m from the car as it gets out, near ${near}, in after ${f(inSteps / 60, 2)} s, driven ${f(driven, 1)} m, out after ${f(outSteps / 60, 2)} s on the ${cars.side === 1 ? 'left' : 'right'}: ${f(side, 3)} m clear of the side, ${f(lz, 2)} m along, feet ${f(walker.position[1]! - ground, 3)} m over the ground, free ${free}`);
      });
    },
  },
  {
    name: 'car-walker-blocked-by-parked-car',
    run() {
      // Into parked car 1 (at 51, 50, facing −z) from its side and from its front, the way the page walks.
      const c = course();
      return withCars(47, 50, -90, PLACES, (cars, walker) => {
        driveTo(walker, c.world, 55, 50, 3);
        const side = walker.position[0]!;
        walker.teleport(51, c.world.groundAt(51, 44, 1e4, 0), 44, 180 * DEG);
        driveTo(walker, c.world, 51, 56, 3);
        const front = walker.position[2]!;
        const b = cars.bodies[1]!, r = walker.setup.radius;
        const wantSide = 51 - b.setup.halfWidth - r, wantFront = 50 - b.setup.halfLength - r;
        const ok = Math.abs(side - wantSide) < 0.02 && Math.abs(front - wantFront) < 0.02;
        return verdict(ok, `side: stops at x ${f(side, 3)} (${f(wantSide, 2)}); front: stops at z ${f(front, 3)} (${f(wantFront, 2)})`);
      });
    },
  },
  {
    name: 'car-no-entry-through-a-wall',
    run() {
      // Car 0 beside the thin wall (z 99.95–100.05) with its driver's door against it; the figure just behind the wall,
      // within reach of the door's place.
      return withCars(20, 100.6, 180, [[20, 98.8, 90], PLACES[1]!], (cars, walker) => {
        const dist = cars.distance(0);
        const near = cars.near(0);
        const entered = cars.enter(0);
        return verdict(dist < 2 && !near && !entered && cars.mode === 'off', `${f(dist, 2)} m from the door's place across the wall: near ${near}, got in ${entered}`);
      });
    },
  },
  {
    name: 'car-exit-on-the-right-beside-a-wall',
    run() {
      return withCars(20, 96, 0, [[20, 98.8, 90], PLACES[1]!], (cars, walker) => {
        cars.enter(0, true);
        stepUntil(cars, 0.5, () => false);
        const exited = cars.exit();
        stepUntil(cars, 3, () => cars.mode === 'off');
        const b = cars.bodies[0]!;
        const [lx] = inCarFrame(b, walker);
        const free = standsFree(walker);
        const ok = exited && cars.mode === 'off' && cars.side === -1 && lx > b.setup.halfWidth && walker.position[2]! < 98 && free;
        return verdict(ok, `out on the ${cars.side === 1 ? 'left' : 'right'}, ${f(lx, 2)} m right of the centre at z ${f(walker.position[2]!, 2)}, free ${free}`);
      });
    },
  },
  {
    name: 'car-pushed-into-the-other-no-overlap',
    run() {
      // Car 0 behind parked car 1, full throttle into it for 3 s, then off. The hulls keep apart within the group's
      // contact slop (half a centimetre).
      return withCars(60, 60, 0, [[51, 57.8, 0], PLACES[1]!], (cars) => {
        cars.enter(0, true);
        const [a, b] = cars.bodies as [WheeledBody, WheeledBody];
        const z1 = b.position[2]!;
        let deepest = -Infinity;
        cars.drive.throttle = 1;
        for (let i = 0; i < 180; i++) {
          cars.step();
          deepest = Math.max(deepest, hullOverlap(a, b));
        }
        cars.drive.throttle = 0;
        for (let i = 0; i < 120; i++) {
          cars.step();
          deepest = Math.max(deepest, hullOverlap(a, b));
        }
        const end = hullOverlap(a, b);
        const pushed = z1 - b.position[2]!;
        return verdict(deepest < 0.02 && end < 0.01 && pushed > 0.5, `deepest overlap ${f(deepest * 100, 2)} cm, at the end ${f(end * 100, 2)} cm, the parked car pushed ${f(pushed, 2)} m`);
      });
    },
  },
  {
    name: 'car-lap-deterministic',
    run() {
      // A scripted lap of the start pad (throttle, steering, brakes, the handbrake), car 1 knocked on the way; twice.
      const lap = (): Uint8Array => withCars(64, 57.5, 0, PLACES, (cars) => {
        cars.enter(0, true);
        const d = cars.drive;
        for (let i = 0; i < 720; i++) {
          const t = i / 60;
          d.throttle = t < 4 ? 1 : t < 6 ? 0.4 : t < 8 ? -1 : 0.7;
          d.steer = Math.sin(t * 0.9) * (t < 9 ? 0.8 : 1);
          d.brake = t > 10 && t < 10.5 ? 1 : 0;
          d.handbrake = t > 6.5 && t < 7.2;
          cars.step();
        }
        const parts = cars.bodies.map((b) => b.saveState());
        const marks = new Uint8Array(cars.trail.data.buffer.slice(0));
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0) + marks.length + 8);
        let o = 0;
        for (const p of parts) (out.set(p, o), (o += p.length));
        out.set(marks, o);
        new DataView(out.buffer).setFloat64(out.length - 8, cars.marksLaid);
        return out;
      });
      const a = lap(), b = lap();
      let same = a.length === b.length;
      for (let i = 0; same && i < a.length; i++) same = a[i] === b[i];
      return verdict(same, `two laps of 12 s: states of both cars and the tyre marks bit-equal ${same} (${a.length} bytes)`);
    },
  },
  {
    name: 'car-driver-is-a-load',
    run() {
      // The figure 1.5 m out from car 0's driver's door; it gets in, sits for 2 s and gets out again.
      return withCars(66, 57.5, 0, PLACES, (cars) => {
        const b = cars.bodies[0]!, other = cars.bodies[1]!;
        stepUntil(cars, 1, () => b.asleep && other.asleep);
        const y0 = b.position[1]!, roll0 = rollRightDeg(b);
        cars.enter(0);
        // The mass comes with the seat's weight: never down while getting in, part of it on the way.
        let rising = true, part = false, last = 0;
        stepUntil(cars, 4, () => {
          const m = b.loadMass;
          if (m < last - 1e-9) rising = false;
          if (m > 1 && m < DRIVER_KG - 1) part = true;
          last = m;
          return cars.mode === 'on';
        });
        const seated = b.loadMass;
        stepUntil(cars, 2, () => b.asleep);
        const sink = y0 - b.position[1]!, lean = rollRightDeg(b) - roll0;
        const status = cars.status().cars[0]!.loadKg;
        cars.exit();
        stepUntil(cars, 3, () => cars.mode === 'off');
        const left = b.loadMass;
        stepUntil(cars, 3, () => b.asleep);
        const back = Math.abs(b.position[1]! - y0), level = Math.abs(rollRightDeg(b) - roll0);
        // 80 kg on four springs of 26,000 N/m: 7.5 mm; the seat is on the left, so the car leans left.
        const ok = rising && part && seated === DRIVER_KG && status === DRIVER_KG && sink > 0.005 && sink < 0.011 && lean < -0.15 && lean > -0.8 && left === 0 && back < 0.002 && level < 0.1 && other.loadMass === 0 && other.asleep;
        return verdict(ok, `getting in the car's load rises to ${f(seated, 0)} kg (never down ${rising}, in part on the way ${part}); seated it sits ${f(sink * 1000, 1)} mm lower and leans ${f(-lean, 2)}° to the driver's side; out again ${f(left, 0)} kg, ${f(back * 1000, 2)} mm and ${f(level, 3)}° from where it stood; the parked car ${f(other.loadMass, 0)} kg, asleep ${other.asleep}`);
      });
    },
  },
  {
    name: 'car-roof-load-lower-slower-rolls-more',
    run() {
      // Car 0 on the open ground by the start pad, the figure in it: at rest, 1 s of full throttle from a standstill,
      // on to 2.4 s, then 0.9 s of a full left turn (the page's presets car-accelerate and car-turn), then 4 s more of it.
      const drive = (roof: boolean) => withCars(60, 50, 0, [[56, 47, 180], [20, 20, 0]], (cars) => {
        const b = cars.bodies[0]!;
        cars.setRoofLoad(0, roof);
        cars.put(0, 56, 47, 180 * DEG);
        cars.enter(0, true);
        stepUntil(cars, 3, () => b.asleep);
        const y = b.position[1]!, kg = b.loadMass;
        const x0 = b.position[0]!, z0 = b.position[2]!, p0 = noseUpDeg(b);
        const d = cars.drive;
        let nose = 0;
        d.throttle = 1;
        stepUntil(cars, 1, () => ((nose = Math.max(nose, noseUpDeg(b) - p0)), false));
        const run = Math.hypot(b.position[0]! - x0, b.position[2]! - z0);
        stepUntil(cars, 1.4, () => false);
        d.throttle = 0.6;
        d.steer = -1;
        stepUntil(cars, 0.9, () => false);
        const roll = rollRightDeg(b);
        let up = 1;
        stepUntil(cars, 4, () => ((up = Math.min(up, b.rotation[4]!)), false));
        return { y, kg, run, nose, roll, up };
      });
      const bare = drive(false), load = drive(true);
      // Taking the load off again: the car comes back up.
      const back = withCars(60, 50, 0, [[56, 47, 180], [20, 20, 0]], (cars) => {
        const b = cars.bodies[0]!;
        stepUntil(cars, 1, () => b.asleep);
        const y0 = b.position[1]!;
        cars.setRoofLoad(0, true);
        const woke = !b.asleep;
        stepUntil(cars, 3, () => b.asleep);
        const down = y0 - b.position[1]!;
        cars.setRoofLoad(0, false);
        stepUntil(cars, 3, () => b.asleep);
        return { woke, down, off: Math.abs(b.position[1]! - y0), kg: b.loadMass, shown: cars.status().cars[0]!.roofLoad };
      });
      const sink = bare.y - load.y;
      const ok =
        bare.kg === DRIVER_KG && load.kg === DRIVER_KG + ROOF_LOAD_KG && sink > 0.012 && sink < 0.03 && load.run < bare.run * 0.93 && load.nose > bare.nose + 0.1 &&
        load.roll > bare.roll + 0.6 && bare.up > 0.95 && load.up > 0.95 && back.woke && back.down > 0.012 && back.off < 0.002 && back.kg === 0 && !back.shown;
      return verdict(ok, `with ${ROOF_LOAD_KG} kg on the roof (loads ${f(load.kg, 0)} kg against ${f(bare.kg, 0)}): ${f(sink * 1000, 1)} mm lower at rest; 1 s of full throttle ${f(load.run, 2)} m against ${f(bare.run, 2)} m, nose up ${f(load.nose, 2)}° against ${f(bare.nose, 2)}°; in the same left turn rolled ${f(load.roll, 2)}° against ${f(bare.roll, 2)}°, least up ${f(load.up, 3)} against ${f(bare.up, 3)} over 4 s more of it; put on a standing car it wakes ${back.woke} and sinks ${f(back.down * 1000, 1)} mm, taken off it is ${f(back.off * 1000, 2)} mm from where it stood`);
    },
  },
  {
    name: 'car-ruts-on-loose-ground',
    run() {
      // Driven gently west for 3 s: across the loose patch in front of the start (z 50), then the same on grass (z 62).
      const drive = (z: number): { ruts: number; skids: number; laid: number } => withCars(80, z + 4, 0, [[72, z, 90], [20, 20, 0]], (cars) => {
        cars.enter(0, true);
        cars.drive.throttle = 0.45;
        for (let i = 0; i < 180; i++) cars.step();
        let ruts = 0, skids = 0;
        const d = cars.trail.data;
        for (let k = 0; k < cars.trail.count; k++) {
          const kind = d[k * CONTACT_TRAIL_FLOATS + 10]!;
          if (kind === TRACE_KIND.rut) ruts++;
          else if (kind === TRACE_KIND.skid) skids++;
        }
        return { ruts, skids, laid: cars.marksLaid };
      });
      const loose = drive(50), grass = drive(62);
      return verdict(loose.ruts >= 20 && loose.skids === 0 && grass.laid === 0, `across the loose patch ${loose.ruts} ruts, ${loose.skids} skid marks; on grass ${grass.laid} marks`);
    },
  },
];
