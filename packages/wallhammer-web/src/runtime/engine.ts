// The runtime mediator (Wallhammer Zero `eng_runtime`): one object that owns the init order, the frame and the
// shutdown. No container and no plugins: what the engine is made of is spelled out below, in order.
//
// Init:     simulation → environment → canvas and device → frame block from slots → renderer → environment link
//           → view size → input → frame loop
// A frame:  input hooks (they queue commands) → whole fixed ticks of the simulation → environment clocks
//           → extraction hooks (interpolated transforms into layer data) → environment frame → render
// Dispose:  the same in reverse.
//
// `HeadlessEngine` is the same object without canvas and GPU: it steps the simulation and the environment clocks,
// for tests and tools in plain Node. The simulation never reads anything the image side owns.

import type { RGB } from '../base/math.ts';
import type { View } from '../base/view.ts';
import type { EnvSlot } from '../base/env-slot.ts';
import { FrameLoop, bindOrbitInput, observeCanvasSize, syncCanvasSize, watchContextLoss } from '../platform/index.ts';
import type { Canvas, CanvasSizeTarget, LoopClock, OrbitControl } from '../platform/index.ts';
import { Device, createContext } from '../gpu/index.ts';
import { Renderer } from '../render/index.ts';
import type { Layer, RendererOptions } from '../render/index.ts';
import { Environment, assembleFrameBlock, atmosphereSlot, skySlot } from '../env/index.ts';
import type { AtmosphereParams, EnvFrameBlock, EnvironmentConfig, SkyParams } from '../env/index.ts';
import { Simulation } from '../sim/index.ts';
import type { SimData, SimulationOptions, System } from '../sim/index.ts';
import { EnvironmentLink } from './environment-link.ts';
import { PrecipitationLayer } from './precipitation.ts';
import { SkyLayer } from './sky.ts';
import { AtmosphereLayer } from './atmosphere.ts';

export interface HeadlessEngineOptions {
  /** Simulation settings, or a simulation built beforehand. */
  sim?: SimulationOptions | Simulation;
  /** Environment settings, or an environment built beforehand. */
  environment?: EnvironmentConfig | Environment;
}

/** A view the engine can size to the canvas: any rig. */
export type EngineView = View & CanvasSizeTarget;

export interface EngineOptions<V extends EngineView> extends HeadlessEngineOptions {
  canvas: Canvas;
  view: V;
  /** The project's palette (`definePalette`). */
  palette: { data(): Float32Array };
  /** Background in full daylight; the environment darkens it at night. */
  background: RGB;
  /** Environment slots of content and app; they shape the Frame block, so they are fixed at creation. */
  slots?: readonly EnvSlot<any, any>[];
  /** Renderer settings besides palette and frame slots (among them the depth mode, `depth`). */
  renderer?: Omit<RendererOptions, 'palette' | 'frameSlots'>;
  /** Drag orbits and the wheel zooms (the view must be an orbit rig). */
  orbitControls?: boolean;
  /** Adds the screen-space rain and snow layer; it stays the last layer drawn. */
  precipitation?: boolean;
  /**
   * Adds the sky (perspective views only): the sky slot in the Frame block and the sky layer, drawn first. `true` or
   * the sky's params. Materials get the haze on distant geometry by calling `aerialPerspective` from `<sky>`.
   */
  sky?: boolean | Partial<SkyParams>;
  /**
   * Adds air as a shell around a sphere (perspective views only; default off): the atmosphere slot in the Frame block
   * and the atmosphere layer, drawn first. `true` for the default air, or its params (for a sphere of another size
   * spread `atmosphereFor(radiusM, heightM)` into them). The sphere is the renderer's `radialUp` sphere; without it
   * the ground is the plane `groundY`. Materials get the air in front of them by calling `atmosphereApply` and their
   * light from `atmosphereLight`, both from `<atmosphere>`. Use it in the place of `sky`, not together with it.
   */
  atmosphere?: boolean | Partial<AtmosphereParams>;
  /**
   * Upper limit of the canvas's pixels per CSS pixel. Default: none, the device's own pixel ratio. Below it the image
   * is drawn at fewer pixels and the browser scales it up to the canvas's CSS size; the view's `dpr` is the ratio in
   * effect. The samples per pixel are the renderer's option `samples`.
   */
  maxPixelRatio?: number;
  /** On a canvas resize, render at once instead of at the next browser frame (no stretched frame in between). */
  renderOnResize?: boolean;
  /** Called after every loop frame, e.g. for a status line. */
  onFrame?: () => void;
  /**
   * Survive a loss of the graphics context (default off). The device then keeps what every upload was made from
   * (`Device.retainUploads`: references to the uploaded arrays stay alive with their GPU objects) and, when the
   * browser hands a fresh context back, makes every program, buffer, mesh and texture again in place and draws a
   * frame. Nothing above the device has to take part.
   */
  contextRecovery?: boolean;
}

export class HeadlessEngine {
  readonly sim: Simulation;
  readonly env: Environment;
  private readonly inputs: (() => void)[] = [];
  private readonly extractors: ((alpha: number) => void)[] = [];
  /** Conditions that keep the frame loop running (see `animateWhile`). */
  protected readonly keepAlive: (() => boolean)[] = [];
  protected disposed = false;
  /** Real seconds of the frame being made (0 on a frame after a rest); read it in the input and extraction hooks. */
  frameSeconds = 0;

  constructor(o: HeadlessEngineOptions = {}) {
    this.sim = o.sim instanceof Simulation ? o.sim : new Simulation(o.sim);
    this.env = o.environment instanceof Environment ? o.environment : new Environment(o.environment);
  }

  /** Runs at the start of every frame; turn input into commands here (`command`). */
  onInput(fn: () => void): void {
    this.inputs.push(fn);
  }

  /** Runs after the ticks of every frame, before rendering: read interpolated transforms (`alpha`) into layer data. */
  onExtract(fn: (alpha: number) => void): void {
    this.extractors.push(fn);
  }

  /**
   * Keeps the frame loop drawing continuously while `fn` returns true (something the simulation does not own moves:
   * a walking body, a following view). When it turns true call `invalidate` once so the loop wakes up. Returns a
   * function that removes the condition.
   */
  animateWhile(fn: () => boolean): () => void {
    this.keepAlive.push(fn);
    return () => {
      const i = this.keepAlive.indexOf(fn);
      if (i >= 0) this.keepAlive.splice(i, 1);
    };
  }

  /** Registers a simulation system after the ones already registered. */
  system(name: string, run: System): void {
    this.sim.addSystem(name, run);
  }

  /** Queues a command for the next tick. */
  command(kind: string, data: SimData = {}): void {
    this.sim.command(kind, data);
  }

  /** Input, ticks and clocks of one frame of `realSeconds`; returns whether anything moved. */
  protected advance(realSeconds: number): boolean {
    this.frameSeconds = realSeconds;
    for (const fn of this.inputs) fn();
    const ticks = this.sim.advance(realSeconds);
    let moved = ticks > 0 || (this.sim.animating && realSeconds > 0);
    for (const c of this.env.clocks) moved = c.advance(realSeconds) || moved;
    return moved;
  }

  /** Runs the extraction hooks with the simulation's current alpha. */
  extract(): void {
    const alpha = this.sim.alpha;
    for (const fn of this.extractors) fn(alpha);
  }

  /** One whole frame without waiting for the browser (headless: no image). Returns the ticks run. */
  frame(realSeconds: number): number {
    const before = this.sim.tick;
    this.advance(realSeconds);
    this.extract();
    return this.sim.tick - before;
  }

  /** Releases what the engine owns; the object is unusable afterwards. */
  dispose(): void {
    this.disposed = true;
    this.inputs.length = 0;
    this.extractors.length = 0;
    this.keepAlive.length = 0;
  }
}

export class Engine<V extends EngineView = EngineView> extends HeadlessEngine {
  readonly canvas: Canvas;
  readonly device: Device;
  readonly block: EnvFrameBlock;
  readonly renderer: Renderer;
  readonly link: EnvironmentLink;
  private _view: V;
  readonly loop: FrameLoop;
  private readonly undo: (() => void)[] = [];
  private readonly precipitation: PrecipitationLayer | null;
  /** The sky layer (and through it the sky slot), or null without `sky`. */
  readonly sky: SkyLayer | null;
  /** The atmosphere layer (and through it the atmosphere slot), or null without `atmosphere`. */
  readonly atmosphere: AtmosphereLayer | null;
  /** The cap of the canvas's pixel ratio (`EngineOptions.maxPixelRatio`), undefined for none. */
  readonly maxPixelRatio: number | undefined;

  constructor(o: EngineOptions<V>) {
    super(o);
    this.canvas = o.canvas;
    this._view = o.view;
    // The depth mode is the renderer's option; the context has to know it, as a canvas for the reversed or the
    // logarithmic mode is created without its own depth buffer.
    this.device = new Device(createContext(o.canvas, o.renderer?.depth ?? 'standard', o.renderer?.samples));
    this.maxPixelRatio = o.maxPixelRatio;
    if (o.contextRecovery) {
      // Before the first upload: the device keeps only what is uploaded from now on.
      this.device.retainUploads = true;
      this.undo.push(
        watchContextLoss(o.canvas, {
          restored: () => {
            this.device.contextRestored();
            this.loop.invalidate();
          },
        }),
      );
    }
    const sky = o.sky ? skySlot(o.sky === true ? {} : o.sky) : null;
    const air = o.atmosphere ? atmosphereSlot(o.atmosphere === true ? {} : o.atmosphere) : null;
    this.block = air ? assembleFrameBlock([...(o.slots ?? []), ...(sky ? [sky] : []), air]) : assembleFrameBlock(sky ? [...(o.slots ?? []), sky] : (o.slots ?? []));
    this.renderer = new Renderer(this.device, { ...o.renderer, palette: o.palette.data(), frameSlots: this.block });
    this.link = new EnvironmentLink(this.renderer, this.env, { background: o.background, block: this.block });
    this.sky = sky ? new SkyLayer(this.renderer, sky) : null;
    if (this.sky) this.renderer.add(this.sky);
    this.atmosphere = air ? new AtmosphereLayer(this.renderer, air) : null;
    if (this.atmosphere) this.renderer.add(this.atmosphere);
    this.precipitation = o.precipitation ? new PrecipitationLayer(this.renderer, this.link) : null;
    if (this.precipitation) this.renderer.add(this.precipitation);

    // The loop drives one clock: this engine's frame. It is animating while the simulation or an environment clock runs.
    const engine = this;
    const frameClock: LoopClock = {
      get animating(): boolean {
        if (engine.sim.animating) return true;
        for (const c of engine.env.clocks) if (c.animating) return true;
        for (const fn of engine.keepAlive) if (fn()) return true;
        return false;
      },
      advance: (dt) => this.advance(dt),
      onChange: (listener) => {
        this.undo.push(this.sim.onChange(listener));
        for (const c of this.env.clocks) this.undo.push(c.onChange(listener));
      },
    };
    this.loop = new FrameLoop({
      render: () => {
        this.extract();
        this.renderer.render(this.view);
      },
      clocks: [frameClock],
      ...(o.onFrame ? { onFrame: o.onFrame } : {}),
    });

    // The canvas size goes to whichever view is current (`setView`), not only to the first one.
    const sizeTarget: CanvasSizeTarget = {
      get width(): number {
        return engine._view.width;
      },
      set width(w: number) {
        engine._view.width = w;
      },
      get height(): number {
        return engine._view.height;
      },
      set height(h: number) {
        engine._view.height = h;
      },
      get dpr(): number {
        return engine._view.dpr;
      },
      set dpr(d: number) {
        engine._view.dpr = d;
      },
    };
    const observer = observeCanvasSize(o.canvas, sizeTarget, () => (o.renderOnResize ? this.loop.renderNow() : this.loop.invalidate()), o.maxPixelRatio);
    this.undo.push(() => observer.disconnect());
    if (o.orbitControls) {
      if (!('orbitPixels' in o.view)) throw new Error('Engine: orbitControls needs an orbit view');
      // The controls act only while the view they were made for is the current one (see `setView`).
      const orbit = o.view as unknown as OrbitControl;
      const gated: OrbitControl = {
        get dpr(): number {
          return orbit.dpr;
        },
        orbitPixels: (dx, dy) => {
          if ((engine._view as unknown) === orbit) orbit.orbitPixels(dx, dy);
        },
        zoomBy: (f) => {
          if ((engine._view as unknown) === orbit) orbit.zoomBy(f);
        },
      };
      this.undo.push(bindOrbitInput(o.canvas, gated, { onChange: () => this.loop.invalidate() }));
    }
  }

  /** The view the renderer draws through. */
  get view(): V {
    return this._view;
  }

  /**
   * Draws through another view from the next frame on (for example a following view while a body walks, and the
   * orbit view again afterwards). The new view takes the canvas size at once. `orbitControls` act only while the
   * view they were made for is the current one; other controls are the caller's to switch (`WalkInput.enabled`).
   */
  setView(view: V): void {
    if (view === this._view) return;
    view.width = this._view.width;
    view.height = this._view.height;
    view.dpr = this._view.dpr;
    this._view = view;
    this.loop.invalidate();
  }

  /** Adds a layer; layers draw in the order they are added, the precipitation layer stays last. */
  add(layer: Layer): void {
    this.renderer.add(layer);
    if (this.precipitation) {
      this.renderer.remove(this.precipitation);
      this.renderer.add(this.precipitation);
    }
  }

  /**
   * Draws the sky behind the scene (`SkyLayer.behindScene`): only where no layer drawn before it has drawn, instead
   * of across the whole screen before everything. Moves the sky layer to just before `layer`, which should be the
   * first layer that blends or does not write depth (water, glass, particles); null puts it after every layer added
   * so far (before the precipitation). The image stays the same when every layer before it is opaque. Layers added
   * afterwards are drawn after the sky. Does nothing without `sky`.
   */
  moveSkyBefore(layer: Layer | null): void {
    const sky = this.sky;
    if (!sky) return;
    sky.behindScene = true;
    this.renderer.remove(sky);
    if (layer) this.renderer.addBefore(sky, layer);
    else if (this.precipitation) this.renderer.addBefore(sky, this.precipitation);
    else this.renderer.add(sky);
  }

  /** Starts the frame loop: continuous while something moves, otherwise only on `invalidate`. */
  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /** Asks for a frame at the browser's next tick. */
  invalidate(): void {
    this.loop.invalidate();
  }

  /** Renders right now with the current state (no ticks, no clock movement). */
  renderNow(): void {
    syncCanvasSize(this.canvas, this.view, this.maxPixelRatio);
    this.extract();
    this.renderer.render(this.view);
  }

  /** One whole frame without waiting for the browser, including the image. */
  override frame(realSeconds: number): number {
    const ticks = super.frame(realSeconds);
    this.renderer.render(this.view);
    return ticks;
  }

  override dispose(): void {
    if (this.disposed) return;
    this.loop.stop();
    while (this.undo.length > 0) this.undo.pop()!();
    for (const layer of [...this.renderer.layers].reverse()) this.renderer.remove(layer);
    this.renderer.beforeFrame.length = 0;
    super.dispose();
  }
}

/** Creates the engine for a canvas: device, renderer, environment, view, simulation and the frame loop. */
export function createEngine<V extends EngineView>(options: EngineOptions<V>): Engine<V> {
  return new Engine(options);
}

/** Creates the same engine without canvas and GPU: simulation and environment only, stepped by `frame`. */
export function createHeadlessEngine(options: HeadlessEngineOptions = {}): HeadlessEngine {
  return new HeadlessEngine(options);
}
