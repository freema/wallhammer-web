// Closed-form poses of the walking figure, read from the walker every drawn frame. On the ground: a stride with the
// knee bending in the forward swing, the rear heel lifting and the hips dipping by what the legs lose in height, so the
// lowest sole stays on the ground. In the air: a jump read from the vertical speed (a push-off with pointed toes and
// the arms thrown up, a tucked rise, the legs reaching down in the fall); a fall from an edge reaches down at once. On
// landing: a squat as deep as the impact was fast, recovered in about 0.4 s. Nothing in the air follows the distance
// walked, so the legs neither swing nor plant there. Pure: the same samples give the same pose; no clock, no
// randomness, no DOM (the headless walk check reads it).

/** Hip joints above the soles with straight legs and flat feet, metres. */
export const HIP_M = 0.85;
export const THIGH_M = 0.42;
export const SHIN_M = 0.36;
/** Ankle above the sole, metres. */
export const ANKLE_M = 0.07;
/** Toe ahead of the ankle and heel behind it, metres. */
export const TOE_M = 0.18;
export const HEEL_M = 0.06;
/** Metres walked per full stride cycle (left and right step). */
export const STRIDE_M = 1.5;

const TAU = Math.PI * 2;

/**
 * A key pose, each channel as [running: lead, running: trail, standing]. Legs: the lead leg is the one ahead at
 * take-off. Arms: the first is the arm opposite the lead leg (it goes forward with it, as in a stride). `lean` is
 * [running, standing]. A jump between standing and running mixes the two by the speed of take-off.
 */
interface Key {
  lean: readonly [number, number];
  hip: readonly [number, number, number];
  knee: readonly [number, number, number];
  toe: readonly [number, number, number];
  arm: readonly [number, number, number];
  spread: readonly [number, number, number];
}

/** Just after take-off: running, the lead knee driven up and the push leg stretched behind; standing, legs and toes stretched, arms thrown up. */
const PUSH: Key = { lean: [0.16, 0.06], hip: [0.95, -0.42, -0.05], knee: [1.45, 0.15, 0.1], toe: [0.35, 0.8, 0.8], arm: [1.6, -0.7, 2.5], spread: [0.1, 0.15, 0.2] };
/** Rising to the top: running, the lead knee up front and the push leg folded under; standing, both knees drawn up. */
const TUCK: Key = { lean: [0.2, 0.25], hip: [1.25, 0.25, 1.2], knee: [1.55, 1.95, 2.0], toe: [0.3, 0.5, 0.35], arm: [1.45, 0.2, 1.7], spread: [0.35, 0.55, 0.3] };
/** Falling: legs reaching down for the ground (running, the lead one forward), arms out for balance. */
const REACH: Key = { lean: [0.1, 0.05], hip: [0.7, 0.2, 0.35], knee: [0.5, 0.6, 0.4], toe: [0.1, 0.15, 0.15], arm: [0.9, 0.4, 0.6], spread: [0.8, 0.9, 1.0] };
/** Landed: knees bent, feet flat, leaning forward. */
const SQUAT: Key = { lean: [0.38, 0.38], hip: [0.95, 0.95, 0.95], knee: [1.75, 1.75, 1.75], toe: [0, 0, 0], arm: [0.45, 0.45, 0.45], spread: [0.35, 0.35, 0.35] };

/** Channels kept by `keep` and mixed back by `mixFrom`: lean, then hip, knee, toe, arm, spread per side. */
const KEPT = 11;

/** Hermite step from 0 at `e0` to 1 at `e1`. */
function smooth(e0: number, e1: number, x: number): number {
  const t = (x - e0) / (e1 - e0);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Vertical distance from the hip joint down to the lowest point of the sole of one leg. */
export function legReach(hip: number, knee: number, toe: number): number {
  const st = Math.sin(toe);
  const ct = Math.cos(toe);
  const front = ANKLE_M * ct + TOE_M * st;
  const back = ANKLE_M * ct - HEEL_M * st;
  return THIGH_M * Math.cos(hip) + SHIN_M * Math.cos(hip - knee) + (front > back ? front : back);
}

/** One sample of the walker for the pose. */
export interface MotionSample {
  /** Seconds of walker steps (monotonic until a teleport sets them back). */
  time: number;
  /** Metres walked (drives the stride). */
  travelled: number;
  /** Horizontal and vertical speed, m/s. */
  speed: number;
  vy: number;
  grounded: boolean;
}

/**
 * The pose channels of the figure and the little it remembers between frames (whether it is in the air, whether that
 * began with a jump, which leg led, when it landed and how fast). Angles in radians.
 */
export class FigureMotion {
  /** How far the hips sit below `HIP_M`, metres (negative: up on the toes). */
  drop = 0;
  /** Forward lean of the upper body about the hips. */
  lean = 0;
  /** Per leg (0 left, 1 right): hip swing forward, knee bend (the shin swings back), toe pitch down. */
  readonly hip = new Float64Array(2);
  readonly knee = new Float64Array(2);
  readonly toe = new Float64Array(2);
  /** Per arm (0 left, 1 right): swing forward against the upper body, spread outward. */
  readonly arm = new Float64Array(2);
  readonly spread = new Float64Array(2);

  private readonly jumpSpeed: number;
  private readonly runSpeed: number;
  private air = false;
  private jumped = false;
  private lead = 0;
  private running = 0;
  private leftAt = 0;
  private lastVy = 0;
  private landedAt = -Infinity;
  private impact = 0;
  private last = -Infinity;
  /** The pose it left the ground with and the pose it touched down with, blended out after take-off and landing. */
  private readonly left = new Float64Array(KEPT);
  private readonly landed = new Float64Array(KEPT);

  constructor(setup: { jumpSpeed: number; runSpeed: number }) {
    this.jumpSpeed = setup.jumpSpeed > 0 ? setup.jumpSpeed : 1;
    this.runSpeed = setup.runSpeed > 0 ? setup.runSpeed : 1;
  }

  /** Whether the last sample was in the air, and whether that flight began with a jump. */
  get airborne(): boolean {
    return this.air;
  }
  get jumping(): boolean {
    return this.air && this.jumped;
  }

  /** Poses the channels for one sample. */
  update(s: MotionSample): void {
    if (s.time < this.last) {
      // Teleported: nothing of the last flight or landing carries over.
      this.air = false;
      this.landedAt = -Infinity;
    }
    this.last = s.time;
    const phase = (s.travelled / STRIDE_M) * TAU;
    const amp = 0.55 * Math.min(1, s.speed / 2.2);
    if (!s.grounded) {
      if (!this.air) {
        this.air = true;
        this.jumped = s.vy > 0.5 * this.jumpSpeed;
        this.lead = Math.sin(phase) >= 0 ? 0 : 1;
        this.running = Math.min(1, s.speed / this.runSpeed);
        this.leftAt = s.time;
        this.keep(this.left);
      }
      this.lastVy = s.vy;
      const t = s.time - this.leftAt;
      if (this.jumped) {
        // The phase of the jump from the vertical speed: 1 at take-off, 0 at the top, −1 back at the take-off height.
        const u = s.vy / this.jumpSpeed;
        if (u >= 0.6) this.blend(TUCK, PUSH, smooth(0.6, 0.9, u));
        else this.blend(REACH, TUCK, smooth(-0.7, 0.2, u));
        this.mixFrom(this.left, 1 - smooth(0, 0.05, t));
      } else {
        // Off an edge: from the pose it left with, reaching down within 0.15 s.
        this.mixFrom(this.left, 1);
        this.toward(REACH, smooth(0, 0.15, t));
      }
      // Up on the toes when stretched beyond straight legs, never sunk below the feet.
      const d = HIP_M - this.lowest();
      this.drop = d < 0 ? d : 0;
      return;
    }
    if (this.air) {
      this.air = false;
      this.impact = this.lastVy < 0 ? -this.lastVy : 0;
      this.landedAt = s.time;
      this.keep(this.landed);
    }
    const t = s.time - this.landedAt;
    this.stride(phase, amp, Math.min(1, s.speed / this.runSpeed));
    // From the pose it touched down with into the stride over 0.2 s, squatting by the impact.
    this.mixFrom(this.landed, 1 - smooth(0, 0.2, t));
    this.toward(SQUAT, this.squat(t));
    this.drop = HIP_M - this.lowest();
  }

  /** Weight of the landing squat `t` seconds after touching down: deeper for a faster impact, gone after 0.42 s. */
  private squat(t: number): number {
    if (!(t >= 0) || this.impact < 1.5) return 0;
    const depth = Math.min(1, 0.3 + (this.impact - 1.5) / 6);
    const env = t < 0.05 ? 0.8 + 0.2 * (t / 0.05) : 1 - smooth(0.05, 0.42, t);
    return depth * env;
  }

  /** Copies the limb channels into `out`. */
  private keep(out: Float64Array): void {
    out[0] = this.lean;
    for (let i = 0; i < 2; i++) {
      out[1 + i] = this.hip[i]!;
      out[3 + i] = this.knee[i]!;
      out[5 + i] = this.toe[i]!;
      out[7 + i] = this.arm[i]!;
      out[9 + i] = this.spread[i]!;
    }
  }

  /** Limb channels blended toward the kept `k` by `w`. */
  private mixFrom(k: Float64Array, w: number): void {
    if (!(w > 0)) return;
    const v = 1 - w;
    this.lean = this.lean * v + k[0]! * w;
    for (let i = 0; i < 2; i++) {
      this.hip[i] = this.hip[i]! * v + k[1 + i]! * w;
      this.knee[i] = this.knee[i]! * v + k[3 + i]! * w;
      this.toe[i] = this.toe[i]! * v + k[5 + i]! * w;
      this.arm[i] = this.arm[i]! * v + k[7 + i]! * w;
      this.spread[i] = this.spread[i]! * v + k[9 + i]! * w;
    }
  }

  /** The stride at `phase` with hip amplitude `amp`; `running` 0–1 leans the body forward. */
  private stride(phase: number, amp: number, running: number): void {
    for (let i = 0; i < 2; i++) {
      const p = phase + i * Math.PI;
      const a = amp * Math.sin(p);
      const c = Math.cos(p);
      this.hip[i] = a;
      // The knee bends while the leg swings forward; the rear heel lifts.
      this.knee[i] = c > 0 ? 1.9 * amp * c : 0;
      this.toe[i] = a < 0 ? -0.6 * a : 0;
      // Each arm against its leg.
      this.arm[i] = -0.8 * a;
      this.spread[i] = 0.06;
    }
    this.lean = 0.1 * running;
  }

  /** Channels set to `a`, then blended toward `b` by `w`. */
  private blend(a: Key, b: Key, w: number): void {
    this.toward(a, 1);
    this.toward(b, w);
  }

  /** Channels blended toward the key pose `k` by `w`, its running and standing variants mixed by the take-off speed. */
  private toward(k: Key, w: number): void {
    if (w <= 0) return;
    const r = this.running;
    const s = 1 - r;
    const v = 1 - w;
    for (let i = 0; i < 2; i++) {
      // Leg i leads or trails; arm i is opposite the lead leg when leg i is not the lead.
      const leg = i === this.lead ? 0 : 1;
      const arm = leg === 0 ? 1 : 0;
      this.hip[i] = this.hip[i]! * v + (k.hip[leg] * r + k.hip[2] * s) * w;
      this.knee[i] = this.knee[i]! * v + (k.knee[leg] * r + k.knee[2] * s) * w;
      this.toe[i] = this.toe[i]! * v + (k.toe[leg] * r + k.toe[2] * s) * w;
      this.arm[i] = this.arm[i]! * v + (k.arm[arm] * r + k.arm[2] * s) * w;
      this.spread[i] = this.spread[i]! * v + (k.spread[arm] * r + k.spread[2] * s) * w;
    }
    this.lean = this.lean * v + (k.lean[0] * r + k.lean[1] * s) * w;
  }

  /** The longer reach of the two legs. */
  private lowest(): number {
    const l = legReach(this.hip[0]!, this.knee[0]!, this.toe[0]!);
    const r = legReach(this.hip[1]!, this.knee[1]!, this.toe[1]!);
    return l > r ? l : r;
  }
}
