// The walk mode of the village: a figure on the square that a player walks through the village (W A S D or the arrows,
// Shift runs, Space jumps, a drag turns the view, the wheel moves the camera in and out, F first person), with the
// engine's walker over the collision world the modules hand over (src/walk/world.ts) and its follow view. Built on the
// first start (the world takes a moment), switched on and off with `start` and `stop`; while off it costs nothing and
// the orbit view, its controls and the village behave as without it.

import { FollowRig } from 'wallhammer-web/camera';
import type { PerspectiveOrbitRig } from 'wallhammer-web';
import { bindWalkInput } from 'wallhammer-web/platform';
import type { WalkInput, WalkInputState } from 'wallhammer-web/platform';
import type { Engine } from 'wallhammer-web/runtime';
import { Walker, newSlideResult, newWalkIntent } from 'wallhammer-web/world';
import type { Contribution } from '../kit/index.ts';
import type { VillageLayout } from '../layout.ts';
import type { VillageScene } from '../render/scene.ts';
import { PlayerFigure } from './player.ts';
import { buildWalkWorld, driveTo, walkState } from './world.ts';
import type { WalkState, WalkWorld } from './world.ts';

const DEG = Math.PI / 180;
/** Boom length behind the figure, metres. */
const BOOM_M = 5;
/** Radius of the sphere the boom is cleared with: a little more than the corner of the near plane. */
const BOOM_RADIUS_M = 0.25;

export interface WalkHost {
  engine: Engine<PerspectiveOrbitRig | FollowRig>;
  orbit: PerspectiveOrbitRig;
  canvas: HTMLCanvasElement;
  seed: number;
  layout: VillageLayout;
  heightAt: (x: number, z: number) => number;
  contributions: () => readonly { name: string; c: Contribution }[];
  scene: () => VillageScene | null;
  /** The animation clock, seconds (the figure's idle motion). */
  time: () => number;
  /** Called when the mode starts or stops. */
  changed: (active: boolean) => void;
}

/** What `__wh.walk.state()` returns. */
export interface WalkModeState extends WalkState {
  active: boolean;
  firstPerson: boolean;
  boom: number;
  solids: number;
}

export class WalkMode {
  private readonly host: WalkHost;
  private built: { ww: WalkWorld; walker: Walker; rig: FollowRig; input: WalkInput; figure: PlayerFigure } | null = null;
  private on = false;
  private thirdPersonDistance = BOOM_M;
  // Per frame scratch.
  private readonly held: WalkInputState = { forward: 0, right: 0, run: false, jump: false };
  private readonly intent = newWalkIntent();
  private readonly fw = [0, 0, 0];
  private readonly at = new Float64Array(3);
  private readonly lastAt = new Float64Array(3);
  private readonly eye: [number, number, number] = [0, 0, 0];
  private readonly lastEye: [number, number, number] = [0, 0, 0];
  private moving = false;
  private asking = false;

  constructor(host: WalkHost) {
    this.host = host;
    const { engine } = host;
    engine.onInput(() => this.input());
    engine.animateWhile(() => this.on && (this.moving || this.asking || !this.built!.walker.grounded || this.built!.walker.steep || this.built!.input.gamepadConnected));
  }

  get active(): boolean {
    return this.on;
  }

  /** The collision world (built on the first start), for the debug view and checks. */
  get world(): WalkWorld | null {
    return this.built?.ww ?? null;
  }

  private build(): NonNullable<WalkMode['built']> {
    if (this.built) return this.built;
    const h = this.host;
    const ww = buildWalkWorld(h.contributions(), h.heightAt, -20, 60);
    const world = ww.world;
    const walker = new Walker(world);
    const rig = new FollowRig(
      { fovDeg: 55, minDistance: 0, maxDistance: 16, pivotHeight: 1.55, followLag: 0.12, minPitchDeg: -30, maxPitchDeg: 75, near: 0.1, far: 1500 },
      { clearance: (ox, oy, oz, dx, dy, dz, max) => world.clearance(ox, oy, oz, dx, dy, dz, max, BOOM_RADIUS_M) },
    );
    rig.distance = BOOM_M;
    rig.pitchDeg = 14;
    const input = bindWalkInput(h.canvas, rig, { onChange: () => h.engine.invalidate(), draggingClass: 'dragging' });
    input.enabled = false;
    const figure = new PlayerFigure(h.seed);
    h.scene()?.addParts(figure.sets);
    this.built = { ww, walker, rig, input, figure };
    return this.built;
  }

  /** Starts walking: the figure on the square (south of the well, looking where the orbit view looked). */
  start(): void {
    if (this.on) return;
    const b = this.build();
    const L = this.host.layout;
    const yaw = this.host.orbit.state().yawDeg * DEG;
    this.place(L.well.x, L.well.z + 3.2, yaw);
    b.rig.yawDeg = yaw / DEG;
    b.rig.pitchDeg = 14;
    b.figure.setVisible(b.rig.distance > 0);
    this.host.engine.setView(b.rig);
    b.input.enabled = true;
    this.on = true;
    this.sync();
    this.host.engine.invalidate();
    this.host.changed(true);
  }

  /** Stops walking: the orbit view comes back above the figure, looking the same way. */
  stop(): void {
    if (!this.on || !this.built) return;
    const b = this.built;
    b.input.enabled = false;
    this.on = false;
    const p = b.rig.pivot;
    this.host.orbit.setState({ target: [p[0]!, p[1]!, p[2]!], yawDeg: b.rig.yawDeg, pitchDeg: 32, distance: 22 });
    this.host.engine.setView(this.host.orbit);
    this.host.engine.invalidate();
    this.host.changed(false);
  }

  toggle(): void {
    if (this.on) this.stop();
    else this.start();
  }

  /** First person and back (the figure hides while the eye is in its head). */
  toggleFirstPerson(): void {
    if (!this.on || !this.built) return;
    const rig = this.built.rig;
    if (rig.distance > 0) {
      this.thirdPersonDistance = rig.distance;
      rig.distance = 0;
    } else rig.distance = this.thirdPersonDistance;
    this.host.engine.invalidate();
  }

  get firstPerson(): boolean {
    return !!this.built && this.built.rig.distance <= 0;
  }

  /**
   * Puts the feet on the ground at (x, z) facing `yaw` (engine convention, 0 faces −z); a spot inside a solid is pushed
   * out by sliding there from 2 m south, so the figure never starts inside a wall.
   */
  private place(x: number, z: number, yaw: number): void {
    const { walker, ww } = this.built!;
    const world = ww.world;
    const r = walker.setup.radius;
    const y = world.groundAt(x, z, 1e4, 0, r);
    const slide = world.slide(x, z + 2, r, y + walker.setup.maxStepUp, y + walker.setup.height, 0, -2, newSlideResult());
    walker.teleport(slide.x, world.groundAt(slide.x, slide.z, 1e4, 0, r), slide.z, yaw);
  }

  private input(): void {
    if (!this.on || !this.built) return;
    const { walker, rig, input } = this.built;
    const engine = this.host.engine;
    input.read(this.held, engine.frameSeconds);
    rig.forward(this.fw);
    const fw = this.fw, st = this.held, it = this.intent;
    it.moveX = fw[0]! * st.forward - fw[2]! * st.right;
    it.moveZ = fw[2]! * st.forward + fw[0]! * st.right;
    it.run = st.run;
    it.jump = st.jump;
    this.asking = st.forward !== 0 || st.right !== 0 || st.jump;
    walker.advance(engine.frameSeconds, it);
  }

  /**
   * Per rendered frame while active: the view follows the drawn position, the figure is posed. Writes the eye into
   * `eyeOut`. No allocation.
   */
  extract(dt: number): void {
    if (!this.on || !this.built) return;
    const { walker, rig, figure } = this.built;
    const at = this.at;
    walker.renderPosition(at);
    rig.follow(at[0]!, at[1]!, at[2]!);
    rig.update(dt);
    const firstPerson = rig.boom < 0.35;
    figure.setVisible(!firstPerson);
    const v = walker.velocity;
    figure.pose(at[0]!, at[1]!, at[2]!, walker.renderYaw(), Math.hypot(v[0]!, v[2]!), walker.travelled, this.intent.run, !walker.grounded, this.host.time());
    rig.eye(this.eye);
    const e = this.eye, le = this.lastEye, la = this.lastAt;
    this.moving =
      Math.abs(at[0]! - la[0]!) + Math.abs(at[1]! - la[1]!) + Math.abs(at[2]! - la[2]!) > 1e-5 ||
      Math.abs(e[0] - le[0]) + Math.abs(e[1] - le[1]) + Math.abs(e[2] - le[2]) > 1e-5;
    la.set(at);
    le[0] = e[0];
    le[1] = e[1];
    le[2] = e[2];
  }

  /** The view at the walker at once (after a teleport or a scripted walk). */
  private sync(): void {
    const { walker, rig, figure } = this.built!;
    walker.renderPosition(this.at);
    rig.follow(this.at[0]!, this.at[1]!, this.at[2]!);
    rig.snap();
    const v = walker.velocity;
    figure.pose(this.at[0]!, this.at[1]!, this.at[2]!, walker.renderYaw(), Math.hypot(v[0]!, v[2]!), walker.travelled, false, !walker.grounded, this.host.time());
  }

  state(): WalkModeState | null {
    if (!this.built) return null;
    const b = this.built;
    return { ...walkState(b.walker), active: this.on, firstPerson: b.rig.distance <= 0, boom: b.rig.boom, solids: b.ww.world.solidCount };
  }

  /**
   * Walks toward (x, z) for `seconds` of fixed walker steps, synchronously (the same path as `pnpm collisions`), then
   * the view snaps to the figure. Starts the mode when it is off.
   */
  walkTo(x: number, z: number, seconds: number, o: { run?: boolean; within?: number } = {}): WalkModeState {
    if (!this.on) this.start();
    driveTo(this.built!.walker, x, z, seconds, o);
    this.sync();
    this.host.engine.invalidate();
    return this.state()!;
  }

  /** Puts the feet at (x, y, z); y omitted or not finite: on the ground there. Starts the mode when it is off. */
  teleport(x: number, y: number | undefined, z: number, yawDeg?: number): WalkModeState {
    if (!this.on) this.start();
    const { walker } = this.built!;
    const yaw = yawDeg !== undefined ? yawDeg * DEG : walker.yaw;
    if (y === undefined || !Number.isFinite(y)) this.place(x, z, yaw);
    else walker.teleport(x, y, z, yaw);
    this.sync();
    this.host.engine.invalidate();
    return this.state()!;
  }

  /** One line for the HUD while walking. */
  hudLine(): string {
    const s = this.state();
    if (!s) return '';
    const where = s.grounded ? (s.steep ? 'sliding' : 'on foot') : 'in the air';
    return `walking · x ${s.x.toFixed(1)} z ${s.z.toFixed(1)} · ${s.speed.toFixed(1)} m/s ${where} · ${s.firstPerson ? 'first person' : `camera ${s.boom.toFixed(1)} m`} · ${s.solids} solids`;
  }
}
