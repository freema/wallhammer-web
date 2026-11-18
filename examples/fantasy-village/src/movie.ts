// Movie mode: a looping camera tour of the village on the engine's `OrbitPath`, with the afternoon turning to evening
// half way and back at the end. The page (main.ts) owns
// the view, the mood and the pause; it hands them in as a `MovieHost`. Positions come from src/layout.ts: the square
// at the origin (ground 2.5 m), the inn at (6, −12), the street to the mill along it, the mill at (33, −24) with its
// wheel and the weir east of it, the river south-west past the forge (20, 9) to the bridge near (14, 26), the castle
// on its ridge at (0, −150), its pad at 55 m. The eye stays at least 14 m from the target with a pitch between 8° and 45°.

import { OrbitPath, blendOrbitState, writeOrbitState } from 'wallhammer-web/camera';
import type { OrbitKey, OrbitState, PerspectiveOrbitRig } from 'wallhammer-web/camera';

/** Seconds of one loop of the tour. */
export const TOUR_SECONDS = 45;
/** Tour time at which the switch to evening starts, and the switch back (it takes `SWITCH_SECONDS`, 6 s, so the loop starts in the afternoon again). */
export const TOUR_EVENING_FROM = 19;
export const TOUR_AFTERNOON_FROM = 39;

/** The keys of the tour: target, yaw (0 looks north, toward −z), pitch above the horizon, distance. */
export const TOUR_KEYS: readonly OrbitKey[] = [
  // The overview of preset 1.
  { t: 0, target: [2, 5, -6], yawDeg: 22, pitchDeg: 30, distance: 66 },
  // Down over the south street toward the square.
  { t: 4, target: [3, 4.5, -2], yawDeg: 8, pitchDeg: 20, distance: 38 },
  // Low on the square, facing the inn past the well.
  { t: 9, target: [4, 4.5, -8], yawDeg: -10, pitchDeg: 11, distance: 20 },
  // Along the street to the mill, the inn on the left.
  { t: 14, target: [17, 5, -7], yawDeg: -35, pitchDeg: 13, distance: 18 },
  // The mill and its wheel, from the south-west.
  { t: 19, target: [37, 4.5, -23], yawDeg: -30, pitchDeg: 17, distance: 22 },
  // Round over the weir and the river.
  { t: 23, target: [38, 3.5, -14], yawDeg: 45, pitchDeg: 24, distance: 25 },
  // Downstream past the forge.
  { t: 27, target: [27, 3, 12], yawDeg: 130, pitchDeg: 20, distance: 24 },
  // The bridge, looking downstream along the river.
  { t: 31, target: [14, 3.5, 26], yawDeg: 130, pitchDeg: 16, distance: 22 },
  // Up over the village, turning north.
  { t: 35, target: [5, 12, -40], yawDeg: 60, pitchDeg: 26, distance: 70 },
  // The castle on its ridge, the village below.
  { t: 40, target: [0, 62, -140], yawDeg: 8, pitchDeg: 18, distance: 120 },
  // (closes back to the overview at TOUR_SECONDS)
];

export const TOUR = new OrbitPath(TOUR_KEYS, { loop: true, duration: TOUR_SECONDS });

/** Seconds of the blend from the free view into the tour when the mode starts with `M`. */
const BLEND_SECONDS = 2.5;

/** What the movie needs from the page. */
export interface MovieHost {
  view: PerspectiveOrbitRig;
  canvas: HTMLCanvasElement;
  /** Unpauses the animation when it is paused. */
  unpause(): void;
  /** Is the mood heading to evening? */
  evening(): boolean;
  /** Sets the mood: a smooth switch, or at once. */
  setEvening(on: boolean, instant: boolean): void;
  invalidate(): void;
  /** The mode started or stopped (HUD, hash). */
  changed(active: boolean): void;
}

export class Movie {
  /** Tour time in seconds, `0 … TOUR_SECONDS`. */
  time = 0;
  private on = false;
  private blendT = BLEND_SECONDS;
  private readonly from: OrbitState = { target: [0, 0, 0], yawDeg: 0, pitchDeg: 0, distance: 1 };
  private readonly pose: OrbitState = { target: [0, 0, 0], yawDeg: 0, pitchDeg: 0, distance: 1 };
  private readonly host: MovieHost;

  constructor(host: MovieHost) {
    this.host = host;
  }

  get active(): boolean {
    return this.on;
  }

  /** Starts the tour: from its beginning with `fromStart` (a cut), else blending from the current view into it. */
  start(fromStart = false): void {
    if (fromStart || !this.on) this.time = 0;
    if (fromStart) {
      this.blendT = BLEND_SECONDS;
      this.host.setEvening(false, true);
    } else if (!this.on) {
      const s = this.host.view.state();
      this.from.target[0] = s.target[0];
      this.from.target[1] = s.target[1];
      this.from.target[2] = s.target[2];
      this.from.yawDeg = s.yawDeg;
      this.from.pitchDeg = s.pitchDeg;
      this.from.distance = s.distance;
      this.blendT = 0;
    }
    if (!this.on) {
      this.on = true;
      document.body.classList.add('movie');
      this.host.changed(true);
    }
    this.host.unpause();
    this.place(0);
  }

  /** Leaves the mode; the view stays where the tour left it. */
  stop(): void {
    if (!this.on) return;
    this.on = false;
    document.body.classList.remove('movie');
    this.host.changed(false);
  }

  toggle(): void {
    if (this.on) this.stop();
    else this.start();
  }

  /** Every frame, with real seconds, before the view is read. */
  update(seconds: number): void {
    if (!this.on) return;
    this.time += seconds;
    this.time = TOUR.wrap(this.time);
    this.place(seconds);
  }

  /** Sets the tour time and shows that moment (camera and mood at once). Works also outside the mode. */
  seek(t: number): void {
    this.time = TOUR.wrap(t);
    this.blendT = BLEND_SECONDS;
    this.host.setEvening(this.eveningAt(this.time), true);
    TOUR.apply(this.host.view, this.time);
    this.host.invalidate();
  }

  private eveningAt(t: number): boolean {
    return t >= TOUR_EVENING_FROM && t < TOUR_AFTERNOON_FROM;
  }

  /** The camera at the current tour time (blended from the free view while the blend runs), and the mood. */
  private place(seconds: number): void {
    const view = this.host.view;
    if (this.blendT < BLEND_SECONDS) {
      this.blendT = Math.min(BLEND_SECONDS, this.blendT + seconds);
      const x = this.blendT / BLEND_SECONDS;
      TOUR.sample(this.time, this.pose);
      writeOrbitState(view, blendOrbitState(this.from, this.pose, x * x * (3 - 2 * x), this.pose));
    } else TOUR.apply(view, this.time);
    const evening = this.eveningAt(this.time);
    if (evening !== this.host.evening()) this.host.setEvening(evening, false);
    this.host.invalidate();
  }
}
