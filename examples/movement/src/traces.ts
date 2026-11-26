// Traces on the course: prints where the figure's boots, the steed's hooves and the glider's paws are put down, ruts
// and skid marks of the cars (laid by src/car.ts), and dust kicked up on loose ground (and blown up by the glider's
// wings where it takes off and touches down). The mechanisms are the engine's: one
// `ContactTrail` drawn by a `ContactTrailLayer` (the looks per kind in src/shaders.ts), one-shot bursts of a
// `ParticleLayer`, and the collision world's surface tags (`SURFACE` of src/course.ts) for what the ground is. What
// marks or dusts, how much and in which colours is decided here.
//
// Time: the cars' clock (`Cars.time`), which runs whenever the page steps anything (the frame loop and a script's
// held steps alike), so a script that steps the page and then draws sees prints and dust of the right age. Every
// burst's seed comes from the step it is fired at and its source, so the same steps give the same dust.

import { ContactTrail } from 'wallhammer-web/core';
import { hashInt } from 'wallhammer-web/gen-core';
import type { ParticleBurst } from 'wallhammer-web/gen-core';
import { ContactTrailLayer, ParticleLayer } from 'wallhammer-web/render';
import type { Material, Renderer } from 'wallhammer-web/render';
import type { CollisionWorld } from 'wallhammer-web/world';
import type { PathfinderBody } from './body.ts';
import type { Cars } from './car.ts';
import type { Glide } from './glide.ts';
import { SURFACE } from './course.ts';
import type { Ride } from './ride.ts';
import { TRACE_KIND, TRACE_LIFE_S } from './trace-kinds.ts';

/** Marks the trail keeps (the oldest give way). */
const TRAIL_CAPACITY = 2048;
/** Burst particles kept. */
const DUST_CAPACITY = 1536;
/** A boot print: width and length, m. */
const BOOT_PRINT: readonly [number, number] = [0.15, 0.32];
/** A hoof print: width and length, m (the steed's hooves are wide and round). */
const HOOF_PRINT: readonly [number, number] = [0.24, 0.26];
/** A paw print of the glider: wide, round, m. */
const PAW_PRINT: readonly [number, number] = [0.6, 0.66];
/** Faster than this the steed trots (between its walk and its trot) and its hooves kick dust on loose ground, m/s. */
const HOOF_DUST_SPEED_MS = 2.6;
/** A wheel slipping faster than this dusts on any ground, m/s; on loose ground a wheel dusts from `LOOSE_DUST_SPEED_MS`. */
const WHEEL_DUST_SLIP_MS = 1.6;
const LOOSE_DUST_SPEED_MS = 2;
/** Seconds between two puffs of one wheel. */
const WHEEL_PUFF_S = 0.07;
/**
 * Dust of dry earth (linear colour and opacity at birth and at death; paler than the ground it rises from, so it reads
 * against it), and the grey haze of a tyre sliding on grass.
 */
const EARTH_START: readonly [number, number, number, number] = [0.78, 0.68, 0.53, 0.6];
const EARTH_END: readonly [number, number, number, number] = [0.86, 0.8, 0.7, 0];
const HAZE_START: readonly [number, number, number, number] = [0.72, 0.72, 0.7, 0.3];
const HAZE_END: readonly [number, number, number, number] = [0.8, 0.8, 0.78, 0];

/** Sources of bursts, for their seeds. */
const SOURCE_HOOF = 1;
const SOURCE_WHEEL = 2;
const SOURCE_PAW = 3;
const SOURCE_WINGS = 4;

export class Traces {
  readonly trail = new ContactTrail(TRAIL_CAPACITY);
  readonly layer: ContactTrailLayer;
  readonly dust: ParticleLayer;
  /** Prints laid by feet and hooves, and dust bursts fired, so far. */
  prints = 0;
  private readonly world: CollisionWorld;
  /** The steed's puts down per leg already seen. */
  private readonly hoofDowns = new Float64Array(4);
  /** The glider's puts down per leg, take-offs and touch-downs already seen. */
  private readonly pawDowns = new Float64Array(4);
  private takeOffs = 0;
  private touchDowns = 0;
  /** Per wheel the time of its last puff. */
  private readonly lastPuff: Float64Array;
  /** Which of the figure's feet the drained step events put down (bit 0 left, bit 1 right). */
  private steps = 0;
  private readonly onEvent = (kind: string, name: string): void => {
    if (kind !== 'mark') return;
    if (name === 'step.l') this.steps |= 1;
    else if (name === 'step.r') this.steps |= 2;
  };
  private readonly burst: ParticleBurst & { position: [number, number, number]; velocity: [number, number, number]; size: [number, number]; spread: [number, number] } = {
    position: [0, 0, 0],
    time: 0,
    count: 0,
    life: 1,
    size: [0.3, 1],
    rise: 0.5,
    spread: [0.1, 0.5],
    velocity: [0, 0, 0],
    gravity: 0.4,
    wind: 0.6,
    colorStart: EARTH_START,
    colorEnd: EARTH_END,
    seed: 0,
  };

  constructor(renderer: Renderer, material: Material, world: CollisionWorld, wheels: number) {
    this.world = world;
    this.layer = new ContactTrailLayer(renderer, this.trail, { material, name: 'traces', lift: 0.012 });
    this.dust = new ParticleLayer(renderer, [], { name: 'dust', burstCapacity: DUST_CAPACITY });
    this.lastPuff = new Float64Array(wheels).fill(-1e9);
  }

  /** Sets the time the trail and the dust are drawn at (call before drawing). */
  setTime(now: number): void {
    this.layer.time = now;
    this.dust.burstTime = now;
  }

  /** Whether dust still flies (the page keeps drawing frames while it does). */
  busy(): boolean {
    return this.dust.burstsBusy();
  }

  /** Forgets every mark and every burst (a scene starts clean); the steed's footfalls start over. */
  clear(ride: Ride | null, glide: Glide | null = null): void {
    this.trail.clear();
    this.dust.clearBursts();
    this.lastPuff.fill(-1e9);
    if (ride) this.hoofDowns.set(ride.gait.cycle.downs);
    if (glide) this.seeGlider(glide);
    this.steps = 0;
  }

  /**
   * The figure's footfalls since the last call: its gait marks a step of each foot (`step.l`, `step.r`); a foot put
   * down on the base surface leaves a print under the bone `footL` or `footR` of the last pose. Drains the gait's
   * events in any case; `onFoot` false (riding, driving, the box figure) lays nothing.
   */
  feet(body: PathfinderBody, onFoot: boolean, yaw: number, now: number): void {
    this.steps = 0;
    body.gait.graph.drainEvents(this.onEvent);
    if (!onFoot || this.steps === 0) return;
    const names = body.kind.skeleton.names;
    const w = body.gait.world;
    for (let side = 0; side < 2; side++) {
      if ((this.steps & (1 << side)) === 0) continue;
      const b = names.indexOf(side === 0 ? 'footL' : 'footR');
      if (b < 0) continue;
      const x = w[b * 12 + 9]!, y = w[b * 12 + 10]!, z = w[b * 12 + 11]!;
      // A little forward of the ankle: the sole's middle.
      const fx = x - Math.sin(yaw) * 0.06, fz = z - Math.cos(yaw) * 0.06;
      this.print(fx, y, fz, yaw, BOOT_PRINT, TRACE_KIND.bootGrass, TRACE_KIND.bootLoose, now);
    }
  }

  /**
   * The steed's footfalls since the last call (its step cycle's count of puts down per leg): a print of each hoof
   * where it was put down and, on loose ground at a trot or a gallop, a puff of dust thrown back from it.
   */
  hooves(ride: Ride, now: number): void {
    const c = ride.gait.cycle;
    const yaw = ride.walker.yaw;
    const v = ride.walker.velocity;
    const speed = Math.hypot(v[0]!, v[2]!);
    for (let i = 0; i < 4; i++) {
      const d = c.downs[i]!;
      if (d < this.hoofDowns[i]!) this.hoofDowns[i] = d;
      if (d === this.hoofDowns[i]) continue;
      this.hoofDowns[i] = d;
      const x = c.points[i * 3]!, y = c.points[i * 3 + 1]!, z = c.points[i * 3 + 2]!;
      const loose = this.print(x, y, z, yaw, HOOF_PRINT, TRACE_KIND.hoofGrass, TRACE_KIND.hoofLoose, now);
      if (loose && speed > HOOF_DUST_SPEED_MS) {
        const gallop = speed > ride.speeds.trot + 1;
        const b = this.burst;
        b.position[0] = x;
        b.position[1] = this.world.groundAt(x, z, y + 0.3, 0.3) + 0.05;
        b.position[2] = z;
        b.time = now;
        b.count = gallop ? 14 : 8;
        b.life = gallop ? 1.8 : 1.4;
        b.size[0] = 0.3;
        b.size[1] = gallop ? 1.6 : 1.2;
        b.rise = gallop ? 0.9 : 0.6;
        b.spread[0] = 0.12;
        b.spread[1] = gallop ? 0.9 : 0.6;
        // Thrown back against the way the steed goes, a little up.
        b.velocity[0] = -v[0]! * 0.18;
        b.velocity[1] = 0;
        b.velocity[2] = -v[2]! * 0.18;
        b.gravity = 0.5;
        b.colorStart = EARTH_START;
        b.colorEnd = EARTH_END;
        b.seed = hashInt(hashInt(Math.round(now * 60), SOURCE_HOOF), i);
        this.dust.fire(b);
      }
    }
  }

  /** Takes the glider's counts as seen (nothing is laid for what happened before). */
  seeGlider(glide: Glide): void {
    this.pawDowns.set(glide.gait.ground.cycle.downs);
    this.takeOffs = glide.body.takeOffs;
    this.touchDowns = glide.body.touchDowns;
  }

  /**
   * The glider's paws put down since the last call: a print of each (the wing tips' and the hind feet's) and on loose
   * ground a puff of sand thrown back and out from a wing's paw; a cloud blown up under it at a take-off and a
   * touch-down (sand on loose ground, a faint haze elsewhere).
   */
  paws(glide: Glide, now: number): void {
    const c = glide.gait.ground.cycle;
    const b0 = glide.body;
    const yaw = b0.yaw;
    const v = b0.velocity;
    const speed = Math.hypot(v[0]!, v[2]!);
    if (b0.takeOffs < this.takeOffs || b0.touchDowns < this.touchDowns) this.seeGlider(glide);
    for (let i = 0; i < 4; i++) {
      const d = c.downs[i]!;
      if (d < this.pawDowns[i]!) this.pawDowns[i] = d;
      if (d === this.pawDowns[i]) continue;
      this.pawDowns[i] = d;
      if (!b0.grounded) continue;
      const x = c.points[i * 3]!, y = c.points[i * 3 + 1]!, z = c.points[i * 3 + 2]!;
      const hind = i >= 2;
      const loose = this.print(x, y, z, yaw, hind ? HOOF_PRINT : PAW_PRINT, TRACE_KIND.hoofGrass, TRACE_KIND.hoofLoose, now);
      if (loose && !hind && speed > 0.4) {
        const b = this.burst;
        const out = i === 0 ? 1 : -1;
        b.position[0] = x;
        b.position[1] = this.world.groundAt(x, z, y + 0.3, 0.3) + 0.05;
        b.position[2] = z;
        b.time = now;
        b.count = 6 + Math.round(4 * Math.min(1, speed / 2.3));
        b.life = 1.3;
        b.size[0] = 0.4;
        b.size[1] = 1.6;
        b.rise = 0.5;
        b.spread[0] = 0.12;
        b.spread[1] = 0.6;
        // Back and out from the paw (left is (−cos yaw, sin yaw)).
        b.velocity[0] = -v[0]! * 0.3 - Math.cos(yaw) * out * 0.5;
        b.velocity[1] = 0.2;
        b.velocity[2] = -v[2]! * 0.3 + Math.sin(yaw) * out * 0.5;
        b.gravity = 0.6;
        b.colorStart = EARTH_START;
        b.colorEnd = EARTH_END;
        b.seed = hashInt(hashInt(Math.round(now * 60), SOURCE_PAW), i);
        this.dust.fire(b);
      }
    }
    const up = b0.takeOffs !== this.takeOffs, down = b0.touchDowns !== this.touchDowns;
    this.takeOffs = b0.takeOffs;
    this.touchDowns = b0.touchDowns;
    if (!up && !down) return;
    const p = b0.position;
    const tag = this.world.groundTagAt(p[0]!, p[2]!, p[1]! + 0.3, 2);
    const loose = tag === SURFACE.loose;
    const b = this.burst;
    b.position[0] = p[0]!;
    b.position[1] = this.world.groundAt(p[0]!, p[2]!, p[1]! + 0.3, 2) + 0.1;
    b.position[2] = p[2]!;
    b.time = now;
    b.count = loose ? 36 : 14;
    b.life = loose ? 2.2 : 1.4;
    b.size[0] = 0.5;
    b.size[1] = loose ? 2.6 : 1.8;
    b.rise = loose ? 1.2 : 0.8;
    b.spread[0] = 1.6;
    b.spread[1] = loose ? 2.4 : 1.6;
    b.velocity[0] = v[0]! * 0.15;
    b.velocity[1] = 0;
    b.velocity[2] = v[2]! * 0.15;
    b.gravity = 0.3;
    b.colorStart = loose ? EARTH_START : HAZE_START;
    b.colorEnd = loose ? EARTH_END : HAZE_END;
    b.seed = hashInt(hashInt(Math.round(now * 60), SOURCE_WINGS), up ? 1 : 2);
    this.dust.fire(b);
  }

  /**
   * Dust of the cars' wheels: a wheel on loose ground rolling fast enough, or one sliding on any ground, puffs every
   * `WHEEL_PUFF_S`, more the faster it goes (pale haze on grass, earth on loose ground).
   */
  wheels(cars: Cars, now: number): void {
    for (let i = 0; i < cars.bodies.length; i++) {
      const body = cars.bodies[i]!;
      if (body.asleep) continue;
      const v = body.velocity;
      const speed = Math.hypot(v[0]!, v[2]!);
      for (let w = 0; w < body.wheels.length; w++) {
        const ws = body.wheels[w]!;
        if (!ws.grounded) continue;
        const k = i * 4 + w;
        const loose = ws.surfaceTag === SURFACE.loose;
        const slipping = ws.slip > WHEEL_DUST_SLIP_MS;
        if (!slipping && !(loose && speed > LOOSE_DUST_SPEED_MS)) continue;
        if (now - this.lastPuff[k]! < WHEEL_PUFF_S) continue;
        this.lastPuff[k] = now;
        const strength = Math.min(1, (loose ? speed / 10 : 0) + (slipping ? ws.slip / 8 : 0));
        const b = this.burst;
        const c = ws.contact;
        b.position[0] = c[0]!;
        b.position[1] = c[1]! + 0.08;
        b.position[2] = c[2]!;
        b.time = now;
        b.count = 2 + Math.round(5 * strength);
        b.life = 1.1 + 1.1 * strength;
        b.size[0] = 0.3;
        b.size[1] = 1 + 1.4 * strength;
        b.rise = 0.5 + 0.6 * strength;
        b.spread[0] = 0.15;
        b.spread[1] = 0.6 + 0.8 * strength;
        // Left behind: a little of the car's speed, the rest stays where the wheel was.
        b.velocity[0] = v[0]! * 0.12;
        b.velocity[1] = 0;
        b.velocity[2] = v[2]! * 0.12;
        b.gravity = 0.2;
        b.colorStart = loose ? EARTH_START : HAZE_START;
        b.colorEnd = loose ? EARTH_END : HAZE_END;
        b.seed = hashInt(hashInt(Math.round(now * 60), SOURCE_WHEEL), k);
        this.dust.fire(b);
      }
    }
  }

  /** A print on the base surface under (x, z): faint on grass, deep on loose ground; none on a solid. Returns whether the ground is loose. */
  private print(x: number, y: number, z: number, yaw: number, size: readonly [number, number], grassKind: number, looseKind: number, now: number): boolean {
    const tag = this.world.groundTagAt(x, z, y + 0.3, 0.4);
    if (tag !== SURFACE.grass && tag !== SURFACE.loose) return false;
    const loose = tag === SURFACE.loose;
    const kind = loose ? looseKind : grassKind;
    const gy = this.world.groundAt(x, z, y + 0.3, 0.4);
    // The base surface's normal from its slope.
    const e = 0.1;
    const gx = (this.world.baseHeightAt(x + e, z) - this.world.baseHeightAt(x - e, z)) / (2 * e);
    const gz = (this.world.baseHeightAt(x, z + e) - this.world.baseHeightAt(x, z - e)) / (2 * e);
    const l = Math.sqrt(gx * gx + 1 + gz * gz);
    this.trail.layRaw(x, gy, z, -gx / l, 1 / l, -gz / l, yaw, size[0], size[1], kind, now, TRACE_LIFE_S[kind]!);
    this.prints++;
    return loose;
  }
}
