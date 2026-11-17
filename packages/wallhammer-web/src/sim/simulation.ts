// Fixed-step simulation (Wallhammer Zero `eng_sim`, determinism tier A). The tick counter is an integer and the step
// is fixed (20 Hz by default), so the state after tick N depends only on the seed, the initial setup and the
// commands stamped for ticks below N: never on the frame rate, the wall clock, rendering or the camera.
//
// - Input is only commands, each stamped with the tick it applies to. They are kept as a log, so seeking back
//   restores a checkpoint and replays the log.
// - Systems are plain functions run in registration order every tick. Commands of a tick are applied first.
// - State lives in registered `SimState` parts (entity tables, path sets, the event queue). A snapshot is their bytes
//   in registration order, the state hash is a hash of the snapshot.
// - Pause, speed and single-step only decide how many ticks a frame runs; they are not state.
// - Randomness only from named streams of the seed (`random`), keyed by the tick and integers. No `Math.random`.

import { hashInts, streamSeed } from '../gen-core/hash.ts';
import { ByteReader, ByteWriter, hashBytes } from './bytes.ts';
import { EventQueue } from './events.ts';
import type { SimData } from './events.ts';

/** A part of the simulation state: saved into snapshots in a fixed order and hashed. */
export interface SimState {
  readonly name: string;
  save(w: ByteWriter): void;
  load(r: ByteReader): void;
}

/** A system: a plain function run once per tick. */
export type System = (sim: Simulation) => void;

export interface Command {
  /** Tick the command applies to (applied before the systems of that tick). */
  readonly tick: number;
  readonly kind: string;
  readonly data: SimData;
}

export type CommandHandler = (cmd: Command, sim: Simulation) => void;

export interface SimulationOptions {
  /** World seed; named streams derive from it. */
  seed?: string | number;
  /** Ticks per simulated second (integer). Default 20. */
  hz?: number;
  /** Most ticks one frame may run; beyond that simulated time slows down instead of stalling the frame. Default 8. */
  maxTicksPerFrame?: number;
  /** A checkpoint for seeking is kept every this many ticks. Default 200. */
  checkpointEvery?: number;
  /** How many checkpoints are kept besides the one of tick 0. Default 32. */
  checkpoints?: number;
}

const MAGIC = 0x31534857; // "WHS1"

export class Simulation {
  readonly seed: string;
  readonly hz: number;
  readonly events = new EventQueue();
  /** Most ticks one `advance` runs. */
  maxTicksPerFrame: number;
  private readonly systems: { name: string; run: System }[] = [];
  private readonly states: SimState[] = [this.events];
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly commands: Command[] = [];
  private cursor = 0;
  private tickNow = 0;
  private acc = 0;
  private inTick = false;
  private running = true;
  private rate = 1;
  private readonly checkpointEvery: number;
  private readonly checkpointLimit: number;
  private readonly checkpoints = new Map<number, Uint8Array>();
  private readonly tickListeners = new Set<(sim: Simulation) => void>();
  private readonly changeListeners = new Set<() => void>();

  constructor(options: SimulationOptions = {}) {
    this.seed = String(options.seed ?? 0);
    this.hz = Math.round(options.hz ?? 20);
    if (this.hz < 1) throw new Error('Simulation: hz must be at least 1');
    this.maxTicksPerFrame = options.maxTicksPerFrame ?? 8;
    this.checkpointEvery = Math.max(1, options.checkpointEvery ?? 200);
    this.checkpointLimit = options.checkpoints ?? 32;
  }

  /** Ticks run so far; also the tick that runs next. */
  get tick(): number {
    return this.tickNow;
  }

  /** Simulated seconds (for display; logic counts ticks). */
  get time(): number {
    return this.tickNow / this.hz;
  }

  /** Fraction 0–1 of the way from the last tick to the next one, for interpolating the image. */
  get alpha(): number {
    return this.acc;
  }

  get paused(): boolean {
    return !this.running;
  }

  /** Multiplier of simulated time per real second. */
  get speed(): number {
    return this.rate;
  }

  /** Does the simulation move on its own (for the frame loop)? Without systems or queued commands nothing can change. */
  get animating(): boolean {
    return this.running && this.rate > 0 && (this.systems.length > 0 || this.cursor < this.commands.length);
  }

  /** Converts seconds to whole ticks. */
  ticks(seconds: number): number {
    return Math.round(seconds * this.hz);
  }

  // --- Setup -------------------------------------------------------------------------------------------------------

  /** Adds a system after the ones already registered. Names must be unique. */
  addSystem(name: string, run: System): void {
    if (this.systems.some((s) => s.name === name)) throw new Error(`Simulation: system "${name}" is already registered`);
    this.systems.push({ name, run });
  }

  /** Adds a state part; snapshots save the parts in registration order. Names must be unique. */
  addState(state: SimState): void {
    if (this.states.some((s) => s.name === state.name)) throw new Error(`Simulation: state "${state.name}" is already registered`);
    this.states.push(state);
  }

  /** Handles commands of one kind. A command without a handler is an error when its tick runs. */
  onCommand(kind: string, handler: CommandHandler): void {
    if (this.handlers.has(kind)) throw new Error(`Simulation: command "${kind}" already has a handler`);
    this.handlers.set(kind, handler);
  }

  /** Called after every tick (also during seeking), e.g. to record hashes. Returns an unsubscribe function. */
  onTick(listener: (sim: Simulation) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  /** Called when pause, speed or the tick change from outside the frame (step, seek, restore). */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.changeListeners) l();
  }

  // --- Input -------------------------------------------------------------------------------------------------------

  /**
   * Queues a command for `tick` (default: the next tick). Commands of one tick apply in the order they were queued.
   * A command for a tick that already ran is an error. Queued from inside a tick, the default is the tick after it.
   */
  command(kind: string, data: SimData = {}, tick = this.tickNow): Command {
    if (this.inTick && tick === this.tickNow) tick++;
    if (!Number.isInteger(tick) || tick < this.tickNow) throw new Error(`Simulation: command "${kind}" for tick ${tick}, but tick ${this.tickNow} is next`);
    const cmd: Command = { tick, kind, data };
    let i = this.commands.length;
    while (i > this.cursor && this.commands[i - 1]!.tick > tick) i--;
    this.commands.splice(i, 0, cmd);
    // Checkpoints after this tick belong to a log without this command.
    for (const t of [...this.checkpoints.keys()]) if (t > tick) this.checkpoints.delete(t);
    // A queued command can wake a simulation without systems.
    if (!this.inTick) this.changed();
    return cmd;
  }

  /** The command log (applied and pending). */
  get commandLog(): readonly Command[] {
    return this.commands;
  }

  /** A uint32 from the named stream of the seed, keyed by the current tick and the given integers. */
  random(stream: string, ...keys: number[]): number {
    return hashInts(streamSeed(this.seed, stream), this.tickNow, ...keys);
  }

  // --- Stepping ----------------------------------------------------------------------------------------------------

  private runTick(): void {
    const t = this.tickNow;
    if (t % this.checkpointEvery === 0 && !this.checkpoints.has(t)) this.keepCheckpoint(t);
    this.events.beginTick(t);
    this.inTick = true;
    while (this.cursor < this.commands.length && this.commands[this.cursor]!.tick === t) {
      const cmd = this.commands[this.cursor++]!;
      const h = this.handlers.get(cmd.kind);
      if (!h) throw new Error(`Simulation: no handler for command "${cmd.kind}" (tick ${t})`);
      h(cmd, this);
    }
    for (const s of this.systems) s.run(this);
    this.inTick = false;
    this.tickNow = t + 1;
    for (const l of this.tickListeners) l(this);
  }

  private keepCheckpoint(t: number): void {
    this.checkpoints.set(t, this.snapshot());
    // Keep tick 0 and the newest ones.
    const ticks = [...this.checkpoints.keys()].filter((k) => k !== 0).sort((a, b) => a - b);
    while (ticks.length > this.checkpointLimit) this.checkpoints.delete(ticks.shift()!);
  }

  /** Runs n ticks now, paused or not. */
  step(n = 1): void {
    for (let i = 0; i < n; i++) this.runTick();
    this.acc = 0;
    if (n > 0) this.changed();
  }

  /**
   * Feeds real time (seconds) from the frame: runs as many whole ticks as fit, at most `maxTicksPerFrame`, and keeps
   * the remainder as `alpha`. Returns the number of ticks run.
   */
  advance(realSeconds: number): number {
    if (!this.running || realSeconds <= 0 || this.rate <= 0) return 0;
    this.acc += realSeconds * this.rate * this.hz;
    let n = Math.floor(this.acc);
    this.acc -= n;
    if (n > this.maxTicksPerFrame) n = this.maxTicksPerFrame;
    for (let i = 0; i < n; i++) this.runTick();
    return n;
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.changed();
  }

  play(): void {
    if (this.running) return;
    this.running = true;
    this.changed();
  }

  setSpeed(speed: number): void {
    if (speed === this.rate) return;
    this.rate = Math.max(0, speed);
    this.changed();
  }

  /**
   * Starts the clock over: restores `snapshot` when given (for example one taken before the first tick), makes the
   * state tick 0 and forgets the checkpoints and the command log, which belong to the old clock. For an app that puts
   * tick 0 at a point of its own time and moves it on a long jump (see `Agendas.setOrigin`).
   */
  rebase(snapshot?: Uint8Array): void {
    if (snapshot) this.restore(snapshot);
    this.tickNow = 0;
    this.acc = 0;
    this.checkpoints.clear();
    this.commands.length = 0;
    this.cursor = 0;
    this.changed();
  }

  /** Pauses and runs exactly one tick. */
  stepOnce(): void {
    this.running = false;
    this.step(1);
  }

  /** Goes to an exact tick: forward by stepping, back by restoring the nearest checkpoint and replaying the log. */
  seek(tick: number): void {
    tick = Math.max(0, Math.floor(tick));
    if (tick < this.tickNow) {
      let best = -1;
      for (const t of this.checkpoints.keys()) if (t <= tick && t > best) best = t;
      if (best < 0) throw new Error(`Simulation: no checkpoint at or before tick ${tick}`);
      this.restore(this.checkpoints.get(best)!);
    }
    for (let t = this.tickNow; t < tick; t++) this.runTick();
    this.acc = 0;
    this.changed();
  }

  // --- State -------------------------------------------------------------------------------------------------------

  /** All state as bytes: the tick and every state part in registration order. Commands are input, not state. */
  snapshot(): Uint8Array {
    const w = new ByteWriter();
    w.u32(MAGIC);
    w.i32(this.tickNow);
    w.u32(this.states.length);
    for (const s of this.states) {
      const part = new ByteWriter();
      s.save(part);
      w.str(s.name);
      w.u32(part.length);
      w.bytes(part.finish());
    }
    return w.finish();
  }

  /** Restores a snapshot of this simulation (same state parts). Commands for later ticks are replayed from the log. */
  restore(bytes: Uint8Array): void {
    const r = new ByteReader(bytes);
    if (r.u32() !== MAGIC) throw new Error('Simulation: not a snapshot');
    const tick = r.i32();
    const n = r.u32();
    if (n !== this.states.length) throw new Error(`Simulation: snapshot has ${n} state parts, the simulation ${this.states.length}`);
    for (const s of this.states) {
      const name = r.str();
      if (name !== s.name) throw new Error(`Simulation: snapshot part "${name}" where "${s.name}" was expected`);
      const len = r.u32();
      const part = new Uint8Array(len);
      r.into(part);
      s.load(new ByteReader(part));
    }
    this.tickNow = tick;
    this.acc = 0;
    let c = 0;
    while (c < this.commands.length && this.commands[c]!.tick < tick) c++;
    this.cursor = c;
    this.changed();
  }

  /** Hash of the whole state (16 hex digits). Equal hashes mean equal snapshots. */
  stateHash(): string {
    return hashBytes(this.snapshot());
  }
}
