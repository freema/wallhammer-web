// Life of the village on the engine's fixed-step simulation (10 ticks per second, deterministic from the seed, paused
// with the scene). Every agent (people and animals) follows a small routine: a list of steps, each a place, what to
// do there and for how long, and which steps may follow. Walking goes along the walking graph of the layout
// (NavGraph.findPath) with speed easing, a limited turn rate, passing on the right, separation from others and a
// push out of building footprints. Hosts (merchants, the guard at the bridge) serve visitors; the two young people
// meet; the dog follows the child. All state lives in typed arrays saved by `save` / `load`; decisions use
// `sim.random` (named hash streams, no Math.random). The tick does not allocate once routes are cached.

import { ByteReader, ByteWriter, NavGraph } from 'wallhammer-web/sim';
import type { SimState, Simulation } from 'wallhammer-web/sim';
import { ACT } from './rig.ts';
import { angleTo } from './vmath.ts';

/** Animal actions (ids from 20, people use rig.ts ACT). */
export const AACT = { stand: 20, walk: 21, peck: 22, scratch: 23, sit: 24, groom: 25, trot: 26 } as const;

export const KIND = { human: 0, chicken: 1, dog: 2, cat: 3 } as const;

export const MODE = { walk: 0, work: 1, wait: 2, hidden: 3 } as const;

export interface Step {
  x: number;
  z: number;
  yaw: number;
  /** Walking-graph node of the place (−1: walk there directly). */
  node: number;
  /** Wander: a random point within this radius of (x, z) (0: the point itself). */
  r: number;
  /** Actions there (one picked at random each time). */
  acts: number[];
  dmin: number;
  dmax: number;
  /** Action while walking there (walk, carry, run, or an animal walk). */
  walk: number;
  /** Prop mode while walking there and while there. */
  prop: number;
  /** Disappear there (inside a house, beyond the road end). */
  hide: boolean;
  /** Seat height (sitting on a bench), 0 when standing. */
  seat: number;
  /** Talk to this host agent on arrival (−1: nobody). */
  visit: number;
  /** Meeting: the partner agent (−1: none). Both partners have a step with the same `meetId`. */
  meetWith: number;
  meetId: number;
  /** Follow this agent instead of going to a place (the dog). */
  follow: number;
  next: number[];
}

export interface AgentDef {
  kind: number;
  /** Index in the people list (humans) or animal list. */
  ref: number;
  speed: number;
  /** Metres per full gait cycle. */
  stride: number;
  /** Collision radius. */
  radius: number;
  steps: Step[];
  /** Start: first step, and optionally walking in from another place. */
  first: number;
  startX?: number;
  startZ?: number;
  startNode?: number;
  /** A host serves visitors (merchants answer with an offer first). */
  host: 0 | 1 | 2;
  /** Leader of a meeting pair. */
  leader?: boolean;
}

export function step(p: Partial<Step> & Pick<Step, 'x' | 'z' | 'acts'>): Step {
  return {
    yaw: 0, node: -1, r: 0, dmin: 4, dmax: 8, walk: ACT.walk, prop: 0, hide: false, seat: 0, visit: -1, meetWith: -1, meetId: -1, follow: -1, next: [],
    ...p,
  };
}

const MAXP = 96;
const TAU = Math.PI * 2;

export interface Ground {
  /** Ground height for a walker at (x, z): terrain, or the bridge deck. */
  y(x: number, z: number): number;
  /** Signed distance to the nearest building footprint that blocks walking (negative inside). */
  block(x: number, z: number): number;
}

export class VillageLife implements SimState {
  readonly name = 'villagers-life';
  readonly n: number;
  readonly defs: AgentDef[];
  // Interpolated pairs (previous tick, this tick).
  readonly x: Float64Array; readonly z: Float64Array; readonly yaw: Float64Array;
  readonly px: Float64Array; readonly pz: Float64Array; readonly pyaw: Float64Array;
  readonly spd: Float64Array; readonly pspd: Float64Array;
  readonly gait: Float64Array; readonly pgait: Float64Array;
  readonly look: Float64Array; readonly plook: Float64Array;
  // Routine.
  readonly until: Float64Array; readonly actT0: Float64Array; readonly prevT0: Float64Array; readonly speakT: Float64Array;
  readonly tx: Float64Array; readonly tz: Float64Array; readonly tyaw: Float64Array;
  readonly preX: Float64Array; readonly preZ: Float64Array;
  readonly stepIx: Int32Array; readonly act: Int32Array; readonly prevAct: Int32Array; readonly mode: Int32Array;
  readonly pathLen: Int32Array; readonly pathIx: Int32Array; readonly node: Int32Array; readonly partner: Int32Array;
  readonly guest: Int32Array; readonly speaking: Int32Array; readonly prop: Int32Array; readonly hasPre: Int32Array;
  readonly served: Int32Array; readonly still: Float64Array; readonly stuckT: Float64Array;
  readonly path: Int32Array;
  private readonly arrays: (Float64Array | Int32Array)[];
  private readonly nav: NavGraph;
  private readonly ground: Ground;
  private readonly hz: number;

  constructor(defs: AgentDef[], nav: NavGraph, ground: Ground, hz: number) {
    this.defs = defs;
    this.n = defs.length;
    this.nav = nav;
    this.ground = ground;
    this.hz = hz;
    const n = this.n;
    const f = (): Float64Array => new Float64Array(n);
    const i = (): Int32Array => new Int32Array(n);
    this.x = f(); this.z = f(); this.yaw = f(); this.px = f(); this.pz = f(); this.pyaw = f();
    this.spd = f(); this.pspd = f(); this.gait = f(); this.pgait = f(); this.look = f(); this.plook = f();
    this.until = f(); this.actT0 = f(); this.prevT0 = f(); this.speakT = f(); this.tx = f(); this.tz = f(); this.tyaw = f();
    this.preX = f(); this.preZ = f(); this.still = f(); this.stuckT = f();
    this.stepIx = i(); this.act = i(); this.prevAct = i(); this.mode = i(); this.pathLen = i(); this.pathIx = i();
    this.node = i(); this.partner = i(); this.guest = i(); this.speaking = i(); this.prop = i(); this.hasPre = i(); this.served = i();
    this.path = new Int32Array(n * MAXP);
    this.arrays = [
      this.x, this.z, this.yaw, this.px, this.pz, this.pyaw, this.spd, this.pspd, this.gait, this.pgait, this.look, this.plook,
      this.until, this.actT0, this.prevT0, this.speakT, this.tx, this.tz, this.tyaw, this.preX, this.preZ, this.still, this.stuckT,
      this.stepIx, this.act, this.prevAct, this.mode, this.pathLen, this.pathIx, this.node, this.partner, this.guest,
      this.speaking, this.prop, this.hasPre, this.served, this.path,
    ];
  }

  save(w: ByteWriter): void {
    for (const a of this.arrays) w.bytes(a);
  }

  load(r: ByteReader): void {
    for (const a of this.arrays) r.into(a);
  }

  /** A float 0–1 from the simulation's hash stream. */
  private rnd(sim: Simulation, i: number, salt: number): number {
    return sim.random('villagers', i, salt) / 4294967296;
  }

  /** Places everyone at their start (build time, tick 0). */
  init(sim: Simulation): void {
    for (let i = 0; i < this.n; i++) {
      const d = this.defs[i]!;
      const s = d.steps[d.first]!;
      this.partner[i] = -1;
      this.guest[i] = -1;
      this.yaw[i] = s.yaw;
      this.gait[i] = this.rnd(sim, i, 1) * TAU;
      if (d.startX !== undefined && d.startZ !== undefined) {
        this.x[i] = d.startX;
        this.z[i] = d.startZ;
        this.node[i] = d.startNode ?? -1;
        this.begin(sim, i, d.first, 0);
      } else {
        // Already there, part-way through the activity.
        this.stepIx[i] = d.first;
        this.x[i] = s.x;
        this.z[i] = s.z;
        this.node[i] = s.node;
        this.prop[i] = s.prop;
        this.mode[i] = MODE.work;
        this.tx[i] = s.x;
        this.tz[i] = s.z;
        this.tyaw[i] = s.yaw;
        const a = s.acts[Math.floor(this.rnd(sim, i, 2) * s.acts.length)]!;
        this.act[i] = a;
        this.prevAct[i] = a;
        this.actT0[i] = -this.rnd(sim, i, 3) * 5;
        this.until[i] = s.dmin + (s.dmax - s.dmin) * this.rnd(sim, i, 4) * 0.7;
      }
      this.px[i] = this.x[i]!; this.pz[i] = this.z[i]!; this.pyaw[i] = this.yaw[i]!; this.pgait[i] = this.gait[i]!;
    }
  }

  private setAct(i: number, a: number, now: number): void {
    if (this.act[i] === a) return;
    this.prevAct[i] = this.act[i]!;
    this.prevT0[i] = this.actT0[i]!;
    this.act[i] = a;
    this.actT0[i] = now;
  }

  private nearestNode(x: number, z: number): number {
    const nav = this.nav;
    let best = 0, bd = Infinity;
    for (let k = 0; k < nav.nodeCount; k++) {
      const d = (nav.nodeX[k]! - x) ** 2 + (nav.nodeZ[k]! - z) ** 2;
      if (d < bd) (bd = d), (best = k);
    }
    return best;
  }

  /** Starts step `k` of agent i: picks the target and the route, or acts at once when already there. */
  private begin(sim: Simulation, i: number, k: number, now: number): void {
    const d = this.defs[i]!;
    const s = d.steps[k]!;
    const prev = d.steps[this.stepIx[i]!];
    // Leaving a seat: first step out to the front of the bench.
    if (prev && prev.seat > 0 && this.mode[i] !== MODE.walk) {
      this.hasPre[i] = 1;
      this.preX[i] = prev.x + Math.sin(prev.yaw) * 0.55;
      this.preZ[i] = prev.z + Math.cos(prev.yaw) * 0.55;
    } else this.hasPre[i] = 0;
    this.stepIx[i] = k;
    this.prop[i] = s.prop;
    if (this.partner[i]! >= 0) this.release(i);
    // Target point.
    let tx = s.x, tz = s.z;
    if (s.r > 0) {
      for (let tries = 0; tries < 8; tries++) {
        const a = this.rnd(sim, i, 10 + tries) * TAU, rr = Math.sqrt(this.rnd(sim, i, 30 + tries)) * s.r;
        tx = s.x + Math.cos(a) * rr;
        tz = s.z + Math.sin(a) * rr;
        if (this.ground.block(tx, tz) > 0.8) break;
      }
    }
    if (s.seat > 0) {
      // Walk to the front of the seat; sitting slides back onto it.
      tx = s.x + Math.sin(s.yaw) * 0.5;
      tz = s.z + Math.cos(s.yaw) * 0.5;
    }
    this.tx[i] = tx;
    this.tz[i] = tz;
    this.tyaw[i] = s.yaw;
    // Route along the walking graph unless the place is near or has no node.
    this.pathLen[i] = 0;
    this.pathIx[i] = 0;
    const far = Math.hypot(tx - this.x[i]!, tz - this.z[i]!) > 6;
    if (s.node >= 0 && far && s.follow < 0) {
      let from = this.node[i]!;
      if (from < 0 || Math.hypot(this.nav.nodeX[from]! - this.x[i]!, this.nav.nodeZ[from]! - this.z[i]!) > 6) from = this.nearestNode(this.x[i]!, this.z[i]!);
      const route = this.nav.findPath(from, s.node);
      if (route) {
        const o = i * MAXP;
        let n = 0;
        this.path[o + n++] = from;
        for (let e = 0; e < route.length && n < MAXP; e++) this.path[o + n++] = this.nav.edgeTo[route[e]!]!;
        this.pathLen[i] = n;
      }
    }
    this.mode[i] = MODE.walk;
    this.setAct(i, s.walk, now);
  }

  /** Ends a conversation or a visit of agent i (both sides). */
  private release(i: number): void {
    const p = this.partner[i]!;
    if (p >= 0) {
      if (this.partner[p] === i) this.partner[p] = -1;
      if (this.guest[p] === i) this.guest[p] = -1;
    }
    this.partner[i] = -1;
  }

  /** Picks the next step of agent i after step k. */
  private nextStep(sim: Simulation, i: number, now: number): void {
    const d = this.defs[i]!;
    const s = d.steps[this.stepIx[i]!]!;
    const k = s.next.length ? s.next[Math.floor(this.rnd(sim, i, 50) * s.next.length)]! : this.stepIx[i]!;
    this.begin(sim, i, k, now);
    // A leader starting a meeting calls the partner there.
    const ns = d.steps[k]!;
    if (d.leader && ns.meetWith >= 0) {
      const j = ns.meetWith;
      const dj = this.defs[j]!;
      const jk = dj.steps.findIndex((q) => q.meetId === ns.meetId);
      if (jk >= 0 && this.mode[j] !== MODE.hidden) this.begin(sim, j, jk, now);
    }
  }

  /** Arrival of agent i at its step's place. */
  private arrive(sim: Simulation, i: number, now: number): void {
    const d = this.defs[i]!;
    const s = d.steps[this.stepIx[i]!]!;
    this.node[i] = s.node >= 0 ? s.node : this.node[i]!;
    const dur = s.dmin + (s.dmax - s.dmin) * this.rnd(sim, i, 60);
    this.until[i] = now + dur;
    if (s.hide) {
      this.mode[i] = MODE.hidden;
      this.setAct(i, ACT.stand, now);
      return;
    }
    const a = s.acts[Math.floor(this.rnd(sim, i, 61) * s.acts.length)]!;
    if (s.meetWith >= 0) {
      const j = s.meetWith;
      const js = this.defs[j]!.steps[this.stepIx[j]!]!;
      if (this.mode[j] === MODE.wait && js.meetId === s.meetId) {
        // Both here: talk.
        const talk = 8 + 6 * this.rnd(sim, i, 62);
        this.startTalk(i, j, now, talk);
      } else {
        this.mode[i] = MODE.wait;
        this.until[i] = now + 40;
        this.setAct(i, ACT.stand, now);
      }
      return;
    }
    this.mode[i] = MODE.work;
    this.setAct(i, a, now);
    if (s.visit >= 0) {
      const h = s.visit;
      // A busy host: wait standing instead of talking to the air.
      if (this.guest[h]! >= 0 || this.mode[h] === MODE.hidden) this.setAct(i, ACT.stand, now);
      else {
        this.guest[h] = i;
        this.served[h] = 0;
        this.partner[i] = h;
        this.speaking[i] = 1;
        this.speakT[i] = now;
      }
    }
  }

  private startTalk(i: number, j: number, now: number, dur: number): void {
    this.joinTalk(i, now, dur);
    this.joinTalk(j, now, dur);
    this.partner[i] = j;
    this.partner[j] = i;
    this.speaking[i] = 1;
    this.speaking[j] = 0;
  }

  private joinTalk(a: number, now: number, dur: number): void {
    this.mode[a] = MODE.work;
    this.until[a] = now + dur;
    this.setAct(a, ACT.talk, now);
    this.speakT[a] = now;
  }

  /** One tick. */
  tick(sim: Simulation): void {
    const n = this.n;
    const dt = 1 / this.hz;
    const now = sim.tick / this.hz;
    for (let i = 0; i < n; i++) {
      this.px[i] = this.x[i]!; this.pz[i] = this.z[i]!; this.pyaw[i] = this.yaw[i]!;
      this.pspd[i] = this.spd[i]!; this.pgait[i] = this.gait[i]!; this.plook[i] = this.look[i]!;
    }
    for (let i = 0; i < n; i++) this.think(sim, i, now);
    for (let i = 0; i < n; i++) this.move(sim, i, dt, now);
    this.separate();
    for (let i = 0; i < n; i++) this.lookAround(i, dt);
  }

  /** Decisions of agent i. */
  private think(sim: Simulation, i: number, now: number): void {
    const d = this.defs[i]!;
    const s = d.steps[this.stepIx[i]!]!;
    const mode = this.mode[i]!;
    // Followers (the dog) re-target every tick and never finish.
    if (s.follow >= 0) {
      const c = s.follow;
      const fy = this.yaw[c]!;
      // A place behind and to the side of the one followed.
      this.tx[i] = this.x[c]! - Math.sin(fy) * 1.1 + Math.cos(fy) * 0.7;
      this.tz[i] = this.z[c]! - Math.cos(fy) * 1.1 - Math.sin(fy) * 0.7;
      const dist = Math.hypot(this.tx[i]! - this.x[i]!, this.tz[i]! - this.z[i]!);
      if (mode === MODE.walk) {
        if (dist < 0.35 && this.spd[i]! < 0.2) {
          this.mode[i] = MODE.work;
          this.still[i] = now;
          this.setAct(i, AACT.stand, now);
        } else this.setAct(i, this.spd[i]! > 1.6 ? AACT.trot : AACT.walk, now);
      } else {
        this.tyaw[i] = Math.atan2(this.x[c]! - this.x[i]!, this.z[c]! - this.z[i]!);
        if (dist > 1.2) {
          this.mode[i] = MODE.walk;
          this.setAct(i, AACT.walk, now);
        } else if (now - this.still[i]! > 2.5) this.setAct(i, AACT.sit, now);
      }
      return;
    }
    if (mode === MODE.walk) return;
    // Hosts answer their guests.
    if (d.host && mode === MODE.work) {
      const g = this.guest[i]!;
      if (g >= 0) {
        if (this.partner[g] !== i || this.mode[g] !== MODE.work) {
          this.guest[i] = -1;
          this.partner[i] = -1;
          this.setAct(i, s.acts[0]!, now);
        } else {
          this.partner[i] = g;
          this.tyaw[i] = Math.atan2(this.x[g]! - this.x[i]!, this.z[g]! - this.z[i]!);
          if (this.served[i] === 0) {
            this.served[i] = 1;
            const gave = this.act[g] === ACT.give;
            this.setAct(i, gave ? ACT.give : d.host === 1 ? ACT.offer : ACT.talk, now);
            this.speaking[i] = 0;
          } else if (this.act[i] !== ACT.talk && now - this.actT0[i]! > 4) {
            this.setAct(i, ACT.talk, now);
            this.speakT[i] = now;
          }
          // Hosts stay while the guest stays.
          if (this.until[i]! < now + 1) this.until[i] = now + 1;
        }
      }
    }
    // Conversations: face the partner, take turns speaking.
    const p = this.partner[i]!;
    if (p >= 0 && mode === MODE.work) {
      this.tyaw[i] = Math.atan2(this.x[p]! - this.x[i]!, this.z[p]! - this.z[i]!);
      if (i < p && now - this.speakT[i]! > 2 + 3 * this.rnd(sim, i, 70 + (Math.floor(this.speakT[i]! * 10) % 1000))) {
        const si = this.speaking[i]! ? 0 : 1;
        this.speaking[i] = si;
        this.speaking[p] = si ? 0 : 1;
        this.speakT[i] = now;
        this.speakT[p] = now;
      }
    } else if (mode === MODE.work) {
      this.tyaw[i] = s.seat > 0 || s.r === 0 ? s.yaw : this.tyaw[i]!;
    }
    if (mode === MODE.wait) {
      // Waiting for the partner: look toward the way they come.
      const j = s.meetWith;
      if (j >= 0) this.tyaw[i] = Math.atan2(this.x[j]! - this.x[i]!, this.z[j]! - this.z[i]!);
    }
    if (now >= this.until[i]!) {
      // A host with a guest waits; a guest leaves; everyone else moves on.
      if (d.host && this.guest[i]! >= 0) return;
      if (mode === MODE.hidden) this.mode[i] = MODE.work;
      this.nextStep(sim, i, now);
    }
  }

  /** Movement of agent i toward its current waypoint. */
  private move(sim: Simulation, i: number, dt: number, now: number): void {
    const d = this.defs[i]!;
    const s = d.steps[this.stepIx[i]!]!;
    const mode = this.mode[i]!;
    let x = this.x[i]!, z = this.z[i]!;
    if (mode === MODE.hidden) {
      this.spd[i] = 0;
      return;
    }
    if (mode !== MODE.walk) {
      // Standing: ease to a stop, turn toward the facing, slide onto a seat.
      this.spd[i] = Math.max(0, this.spd[i]! - 3 * dt);
      if (s.seat > 0 && this.act[i] === ACT.sit) {
        const dx = s.x - x, dz = s.z - z;
        const l = Math.hypot(dx, dz);
        if (l > 1e-3 && now - this.actT0[i]! > 0.1) {
          const m = Math.min(l, 0.9 * dt);
          this.x[i] = x + (dx / l) * m;
          this.z[i] = z + (dz / l) * m;
        }
      }
      this.turn(i, this.tyaw[i]!, 2.6 * dt);
      return;
    }
    // Current waypoint.
    let wx: number, wz: number, last = false;
    const o = i * MAXP;
    if (this.hasPre[i]) {
      wx = this.preX[i]!; wz = this.preZ[i]!;
      if (Math.hypot(wx - x, wz - z) < 0.2) this.hasPre[i] = 0;
    }
    if (this.hasPre[i]) {
      wx = this.preX[i]!; wz = this.preZ[i]!;
    } else if (this.pathIx[i]! < this.pathLen[i]!) {
      const nd = this.path[o + this.pathIx[i]!]!;
      wx = this.nav.nodeX[nd]!; wz = this.nav.nodeZ[nd]!;
      // Cut corners: move on near a waypoint, or when the next one is as close.
      const dw = Math.hypot(wx - x, wz - z);
      const ix = this.pathIx[i]!;
      let nx: number, nz: number;
      if (ix + 1 < this.pathLen[i]!) {
        const nn = this.path[o + ix + 1]!;
        nx = this.nav.nodeX[nn]!; nz = this.nav.nodeZ[nn]!;
      } else {
        nx = this.tx[i]!; nz = this.tz[i]!;
      }
      if (dw < 0.7 || Math.hypot(nx - x, nz - z) < Math.hypot(nx - wx, nz - wz) * 0.75) {
        this.pathIx[i] = ix + 1;
        if (ix + 1 < this.pathLen[i]!) {
          wx = nx; wz = nz;
        } else {
          wx = this.tx[i]!; wz = this.tz[i]!; last = true;
        }
      }
    } else {
      wx = this.tx[i]!; wz = this.tz[i]!; last = true;
    }
    const dx = wx - x, dz = wz - z;
    const dist = Math.hypot(dx, dz);
    if (last && s.follow < 0 && dist < 0.08) {
      this.x[i] = wx;
      this.z[i] = wz;
      this.spd[i] = Math.max(0, this.spd[i]! - 4 * dt);
      this.arrive(sim, i, now);
      return;
    }
    // Desired heading with passing on the right.
    let want = Math.atan2(dx, dz);
    want += this.steer(i, x, z, want);
    const err = Math.abs(angleTo(this.yaw[i]!, want));
    this.turn(i, want, (this.act[i] === ACT.run ? 5 : 3.6) * dt);
    // Speed: cruise, slow in sharp turns and on the last metres.
    let target = d.speed * (err > 1.2 ? 0.25 : 1 - err * 0.45);
    if (last || s.follow >= 0) target = Math.min(target, Math.sqrt(2 * 1.4 * Math.max(0, dist - 0.02)) + 0.15);
    if (s.follow >= 0) target = Math.min(target, dist * 1.6);
    const v = this.spd[i]!;
    this.spd[i] = target > v ? Math.min(target, v + 1.6 * dt) : Math.max(target, v - 3 * dt);
    const step = this.spd[i]! * dt;
    const yw = this.yaw[i]!;
    x += Math.sin(yw) * step;
    z += Math.cos(yw) * step;
    // Out of building footprints (not next to the goal: doors and work places may touch the walls).
    if (Math.hypot(this.tx[i]! - x, this.tz[i]! - z) > 1.6) {
      const r = d.radius;
      const b = this.ground.block(x, z);
      if (b < r) {
        const e = 0.05;
        const gx = this.ground.block(x + e, z) - this.ground.block(x - e, z);
        const gz = this.ground.block(x, z + e) - this.ground.block(x, z - e);
        const gl = Math.hypot(gx, gz);
        if (gl > 1e-6) {
          x += (gx / gl) * (r - b);
          z += (gz / gl) * (r - b);
        }
      }
    }
    // No headway for 3 s (pushed against a wall or a crowd): skip the waypoint, or count as arrived.
    const moved = Math.hypot(x - this.x[i]!, z - this.z[i]!);
    if (moved < 0.3 * step + 0.002 && this.spd[i]! > 0.1) this.stuckT[i] = this.stuckT[i]! + dt;
    else this.stuckT[i] = Math.max(0, this.stuckT[i]! - dt);
    if (this.stuckT[i]! > 3 && s.follow < 0) {
      this.stuckT[i] = 0;
      if (this.hasPre[i]) this.hasPre[i] = 0;
      else if (this.pathIx[i]! < this.pathLen[i]!) this.pathIx[i] = this.pathIx[i]! + 1;
      else {
        this.x[i] = x;
        this.z[i] = z;
        this.arrive(sim, i, now);
        return;
      }
    }
    this.x[i] = x;
    this.z[i] = z;
    this.gait[i] = this.gait[i]! + (step / (this.act[i] === ACT.run ? d.stride * 1.7 : d.stride)) * TAU;
  }

  /** Steering around agents ahead (pass on the right). */
  private steer(i: number, x: number, z: number, want: number): number {
    const fx = Math.sin(want), fz = Math.cos(want);
    let bias = 0;
    for (let j = 0; j < this.n; j++) {
      if (j === i || this.mode[j] === MODE.hidden) continue;
      const dx = this.x[j]! - x, dz = this.z[j]! - z;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0 || ahead > 2.2) continue;
      // Right of the heading is (−cos, sin) … in x, z: (−fz, fx).
      const side = dx * -fz + dz * fx;
      const reach = this.defs[i]!.radius + this.defs[j]!.radius + 0.25;
      if (Math.abs(side) > reach) continue;
      // Turning right is a negative yaw; when the other is already on the right, go left of them.
      const k = (1 - ahead / 2.2) * 0.7;
      bias += side > 0.15 ? k : -k;
    }
    return Math.max(-0.9, Math.min(0.9, bias));
  }

  private turn(i: number, want: number, maxStep: number): void {
    const d = angleTo(this.yaw[i]!, want);
    let y = this.yaw[i]! + Math.max(-maxStep, Math.min(maxStep, d));
    if (y > Math.PI) y -= TAU;
    if (y < -Math.PI) y += TAU;
    // Keep the interpolation continuous across the wrap.
    const py = this.pyaw[i]!;
    this.pyaw[i] = y + angleTo(y, py);
    this.yaw[i] = y;
  }

  /** Keeps people apart (only those walking yield). */
  private separate(): void {
    for (let i = 0; i < this.n; i++) {
      if (this.mode[i] === MODE.hidden) continue;
      for (let j = i + 1; j < this.n; j++) {
        if (this.mode[j] === MODE.hidden) continue;
        const dx = this.x[j]! - this.x[i]!, dz = this.z[j]! - this.z[i]!;
        const min = this.defs[i]!.radius + this.defs[j]!.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-10) continue;
        const d = Math.sqrt(d2);
        const push = min - d;
        const mi = this.mode[i] === MODE.walk ? 1 : 0, mj = this.mode[j] === MODE.walk ? 1 : 0;
        if (mi + mj === 0) continue;
        const si = mi / (mi + mj), sj = mj / (mi + mj);
        this.x[i] = this.x[i]! - (dx / d) * push * si;
        this.z[i] = this.z[i]! - (dz / d) * push * si;
        this.x[j] = this.x[j]! + (dx / d) * push * sj;
        this.z[j] = this.z[j]! + (dz / d) * push * sj;
      }
    }
  }

  /** Head turning: toward the partner, or a glance at someone passing within 4 m in front. */
  private lookAround(i: number, dt: number): void {
    if (this.defs[i]!.kind !== KIND.human || this.mode[i] === MODE.hidden) return;
    const x = this.x[i]!, z = this.z[i]!, yw = this.yaw[i]!;
    let target = 0;
    const p = this.partner[i]! >= 0 ? this.partner[i]! : this.guest[i]!;
    if (p >= 0) target = angleTo(yw, Math.atan2(this.x[p]! - x, this.z[p]! - z));
    else {
      let best = 16;
      for (let j = 0; j < this.n; j++) {
        if (j === i || this.mode[j] === MODE.hidden || this.defs[j]!.kind === KIND.chicken) continue;
        const dx = this.x[j]! - x, dz = this.z[j]! - z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= best) continue;
        const a = angleTo(yw, Math.atan2(dx, dz));
        if (Math.abs(a) > 1.7) continue;
        best = d2;
        target = a;
      }
    }
    target = Math.max(-1.05, Math.min(1.05, target));
    const l = this.look[i]!;
    const m = 2.4 * dt;
    this.look[i] = l + Math.max(-m, Math.min(m, target - l));
  }

  /** Registers the system and the state. */
  attach(sim: Simulation): void {
    sim.addState(this);
    sim.addSystem('villagers', (s) => this.tick(s));
  }
}
