// Fantasy village on Wallhammer Web: a living village in a hand-painted classic MMORPG style, from code alone. The
// layout (src/layout.ts) and the terrain height (src/terrain/height.ts) are the shared ground truth; content modules
// (src/modules.ts) build static meshes, instanced parts, lights and particle emitters from them; the scene assembly
// (src/render/scene.ts) turns those into engine layers; src/env.ts sets the light from late afternoon to evening.
//
// URL hash: #seed=7&yaw=22&pitch=30&dist=66&tx=2&ty=5&tz=-6&e=0&p=0&v=1   (e evening, p paused, v villagers)
// Measuring parameters (kept in the hash when given): pr=1.5 cap of the canvas pixel ratio (default 1.5; 0 = none),
// sh=0 shadow redraws per second for moving parts (default 0 = every frame they move), sky=behind|first (default
// behind: the sky is shaded only where the scene left the screen empty), aa=0|2|4 samples per pixel (default: the
// browser's antialiasing), movie=1 starts the movie mode after the build, walk=1 the walk mode (neither written back).
// Controls: drag orbits, the wheel zooms, 1 overview, 2 street level, E afternoon/evening, P or space pause, V villagers,
// M movie mode (a looping tour, src/movie.ts), Escape (or a drag, the wheel) leaves it.
// G walk mode (src/walk/): a figure on the square, W A S D or the arrows walk, Shift runs, Space jumps, a drag turns,
// the wheel moves the camera, F first person; G or Escape back to the orbit view above the figure.

import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import type { FollowRig } from 'wallhammer-web/camera';
import { createEngine } from 'wallhammer-web/runtime';
import { formatProfile, profileFrame } from 'wallhammer-web/tools';
import type { FrameProfile } from 'wallhammer-web/tools';
import { Simulation } from 'wallhammer-web/sim';
import { SIM_HZ, createBuildContext } from './context.ts';
import { DAY_LIGHT, HOUR_AFTERNOON, HOUR_EVENING, MoodSwitch, SITE, villageGlowSlot } from './env.ts';
import { formatReport, inspect } from './kit/inspect.ts';
import type { MeshReport } from './kit/inspect.ts';
import type { Contribution, FrameInfo } from './kit/types.ts';
import { villageLayout } from './layout.ts';
import { MODULES } from './modules.ts';
import { Movie } from './movie.ts';
import { VillageScene } from './render/scene.ts';
import { heightField } from './terrain/height.ts';
import { WalkMode } from './walk/mode.ts';
import type { VillageLayout } from './layout.ts';

const q = new URLSearchParams(location.hash.slice(1));
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const seed = Math.round(num('seed', 7));
/** Cap of the canvas pixel ratio; 0 or less: the device's own ratio. */
const pixelRatioCap = num('pr', 1.5);
/** Shadow redraws per second of animation time caused by moving parts; 0 = in every frame they move. */
const shadowHz = Math.max(0, num('sh', 0));
const skyFirst = q.get('sky') === 'first';
const aaParam = q.get('aa');
const samples = aaParam === '0' ? 0 : aaParam === '2' ? 2 : aaParam === '4' ? 4 : undefined;
/** Start in movie mode once the village is built. */
const movieAtStart = q.get('movie') === '1';
/** Start in walk mode once the village is built. */
const walkAtStart = q.get('walk') === '1';
/** The measuring parameters as given in the address, written back unchanged by `hash()`. */
const extraHash = ['pr', 'sh', 'sky', 'aa'].filter((k) => q.has(k)).map((k) => `&${k}=${q.get(k)}`).join('');

interface ViewPreset {
  name: string;
  target: [number, number, number];
  yawDeg: number;
  pitchDeg: number;
  distance: number;
  /** Optional mood for the shot tool: switches instantly. */
  evening?: boolean;
}

/** 1: the overview of the inn and the square. 2: at street level on the square, looking at the inn past the well. */
const OVERVIEW: ViewPreset = { name: 'overview', target: [2, 5, -6], yawDeg: 22, pitchDeg: 30, distance: 66 };
const STREET: ViewPreset = { name: 'street', target: [4, 4.8, -7], yawDeg: -6, pitchDeg: 6, distance: 18 };
const PRESETS: ViewPreset[] = [
  OVERVIEW,
  STREET,
  { ...OVERVIEW, name: 'overview-evening', evening: true },
  { ...STREET, name: 'street-evening', evening: true },
  { name: 'river', target: [24, 3, 14], yawDeg: 60, pitchDeg: 18, distance: 42 },
  { name: 'mill', target: [36, 4, -24], yawDeg: 110, pitchDeg: 16, distance: 28 },
  { name: 'far', target: [0, 6, -20], yawDeg: 170, pitchDeg: 22, distance: 210 },
];

// --- Engine ------------------------------------------------------------------------------------------------------------
const sim = new Simulation({ seed: `village-${seed}`, hz: SIM_HZ });
const glow = villageGlowSlot();
const mood = new MoodSwitch(q.get('e') === '1' ? HOUR_EVENING : HOUR_AFTERNOON);
const view = new PerspectiveOrbitRig(
  { fovYDeg: 38, minDistance: 3, maxDistance: 420 },
  { target: [num('tx', OVERVIEW.target[0]), num('ty', OVERVIEW.target[1]), num('tz', OVERVIEW.target[2])], yawDeg: num('yaw', OVERVIEW.yawDeg), pitchDeg: num('pitch', OVERVIEW.pitchDeg), distance: num('dist', OVERVIEW.distance) },
);
const engine = createEngine<PerspectiveOrbitRig | FollowRig>({
  canvas: document.querySelector<HTMLCanvasElement>('#view')!,
  view,
  palette: definePalette({ sky: '#c9a8b8' }),
  background: [0.79, 0.66, 0.72],
  slots: [glow],
  renderer: { shadowSoftnessM: 0.22, shadowDistanceM: 230, ...(samples !== undefined ? { samples } : {}) },
  ...(pixelRatioCap > 0 ? { maxPixelRatio: pixelRatioCap } : {}),
  sim,
  environment: {
    mode: 'day',
    site: SITE,
    hour: mood.hour,
    day: DAY_LIGHT,
    weather: { cloudCover: 0.12 },
    wind: { fromDeg: 250, speedMs: 3 },
    clouds: { darkness: 0.25, sizeM: 420 },
  },
  orbitControls: true,
  sky: { hazeDistanceM: 450 },
});
const { renderer, env } = engine;
env.day.pause();
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;

// --- State ---------------------------------------------------------------------------------------------------------------
let paused = q.get('p') === '1';
let villagersOn = q.get('v') !== '0';
let scene: VillageScene | null = null;
let source: { layout: VillageLayout; heightAt: (x: number, z: number) => number; contributions: { name: string; c: Contribution }[] } | null = null;
let reports: MeshReport[] = [];
let buildMs = 0;
const frame: FrameInfo = { time: 0, dt: 0, evening: 0, alpha: 0, eye: [0, 0, 0], villagersVisible: villagersOn };
let lastReal = performance.now();
// Measured frame times: the real interval between presented frames and the renderer's processor time, over the last
// FRAME_WINDOW frames (a ring buffer; nothing is allocated per frame).
const FRAME_WINDOW = 120;
const frameIntervals = new Float32Array(FRAME_WINDOW);
const frameCpu = new Float32Array(FRAME_WINDOW);
let frameCount = 0;
interface FrameTimes {
  /** Mean real interval between frames, ms. */
  meanMs: number;
  /** Slowest interval in the window, ms. */
  worstMs: number;
  /** Mean processor time of the renderer per frame, ms (without waiting for the graphics). */
  cpuMs: number;
  /** Frames in the window. */
  frames: number;
}
function frameTimes(): FrameTimes {
  const n = Math.min(frameCount, FRAME_WINDOW);
  let sum = 0, worst = 0, cpu = 0;
  for (let i = 0; i < n; i++) {
    const v = frameIntervals[i]!;
    sum += v;
    if (v > worst) worst = v;
    cpu += frameCpu[i]!;
  }
  return { meanMs: n ? sum / n : 0, worstMs: worst, cpuMs: n ? cpu / n : 0, frames: n };
}

function applyPause(): void {
  if (paused) {
    env.time.pause();
    sim.pause();
  } else {
    env.time.play();
    sim.play();
  }
}

// --- Movie mode ------------------------------------------------------------------------------------------------------------
// The tour drives the view and the mood while it runs; the HUD and the cursor are hidden (body.movie), the hash is
// written only when the mode starts or ends.
const movie = new Movie({
  view,
  canvas,
  unpause: () => {
    if (!paused) return;
    paused = false;
    applyPause();
  },
  evening: () => mood.evening,
  setEvening: (on, instant) => {
    if (instant) {
      mood.set(on ? HOUR_EVENING : HOUR_AFTERNOON);
      env.day.set(mood.hour);
    } else if (mood.evening !== on) mood.toggle();
  },
  invalidate: () => engine.invalidate(),
  changed: (active) => {
    hudEl.innerHTML = hud();
    if (!active) writeHash();
  },
});

// --- Walk mode ---------------------------------------------------------------------------------------------------------------
// Built on its first start from the modules' solids; the movie and the walk exclude each other.
const walk = new WalkMode({
  engine,
  orbit: view,
  canvas,
  seed,
  get layout() {
    return source!.layout;
  },
  heightAt: (x, z) => source!.heightAt(x, z),
  contributions: () => source?.contributions ?? [],
  scene: () => scene,
  time: () => env.time.time,
  changed: (active) => {
    document.body.classList.toggle('walking', active);
    hudEl.innerHTML = hud();
    if (!active) writeHash();
  },
});
/** Starts the movie (leaving the walk mode first). */
const startMovie = (fromStart = false): void => {
  walk.stop();
  movie.start(fromStart);
};

function hash(): string {
  const v = view.state();
  const r = (x: number, d = 1): string => String(Math.round(x * 10 ** d) / 10 ** d);
  return `seed=${seed}&yaw=${r(v.yawDeg)}&pitch=${r(v.pitchDeg)}&dist=${r(v.distance)}&tx=${r(v.target[0])}&ty=${r(v.target[1])}&tz=${r(v.target[2])}&e=${mood.evening ? 1 : 0}&p=${paused ? 1 : 0}&v=${villagersOn ? 1 : 0}${extraHash}`;
}

let hashTimer = 0;
function writeHash(): void {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => history.replaceState(null, '', `#${hash()}`), 250);
}

function setView(v: Partial<ViewPreset>): void {
  view.setState({ ...(v.target ? { target: v.target } : {}), ...(v.yawDeg !== undefined ? { yawDeg: v.yawDeg } : {}), ...(v.pitchDeg !== undefined ? { pitchDeg: v.pitchDeg } : {}), ...(v.distance !== undefined ? { distance: v.distance } : {}) });
  if (v.evening !== undefined) {
    mood.set(v.evening ? HOUR_EVENING : HOUR_AFTERNOON);
    env.day.set(mood.hour);
  }
  engine.invalidate();
  writeHash();
}

function hud(): string {
  const st = renderer.lastStats;
  const s = scene?.stats();
  const h = Math.floor(mood.hour), m = Math.floor((mood.hour - h) * 60);
  const lines = [
    `<b>Fantasy village</b>  seed ${seed}  ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${mood.moving ? '→ ' : ''}${mood.evening ? 'evening' : 'afternoon'}${paused ? '  paused' : ''}${villagersOn ? '' : '  villagers hidden'}`,
    walk.active
      ? `WASD/arrows walk · Shift run · space jump · drag turn · wheel camera · F first person · G/Esc leave · E evening · V villagers · M movie`
      : `drag orbit · wheel zoom · 1 overview · 2 street · E evening · P/space pause · V villagers · M movie · G walk`,
  ];
  if (walk.active) lines.push(walk.hudLine());
  if (s) {
    const ft = frameTimes();
    const fpsText = ft.frames > 10 && ft.meanMs > 0 ? `${ft.meanMs.toFixed(1)} ms/frame (${(1000 / ft.meanMs).toFixed(0)} fps, worst ${ft.worstMs.toFixed(1)} ms, cpu ${ft.cpuMs.toFixed(1)} ms)` : 'measuring frame time…';
    const moving = st.dynamicShadowDrawCalls && st.dynamicShadowDrawCalls === st.shadowDrawCalls ? ' (moving parts only)' : '';
    lines.push(`${(st.triangles / 1e6).toFixed(2)} M tris · ${st.drawCalls} draw calls · shadow ${st.shadowDrawCalls ? `${(st.shadowTriangles / 1e6).toFixed(2)} M in ${st.shadowDrawCalls}${moving}` : 'cached'} · scene ${((s.staticTriangles + s.partTriangles) / 1e6).toFixed(2)} M`);
    lines.push(`${fpsText} · ${s.lightsActive}/${s.lights} lights · ${s.particles.particles} particles · ${engine.view.width}×${engine.view.height} px (dpr ${engine.view.dpr.toFixed(2)}) · build ${(buildMs / 1000).toFixed(1)} s`);
  } else lines.push('building…');
  return lines.join('\n');
}

// --- Build -------------------------------------------------------------------------------------------------------------
// The build runs as one task: handing control back to the browser between the steps made it three times slower (measured:
// 3.9 s in one task, 6 to 16 s in steps). The loading screen therefore runs on the compositor alone, timed by the step
// durations of the last load on this machine: the bar and the phase labels keep moving while the page is blocked.
const PHASES: readonly { label: string; steps: readonly string[] }[] = [
  { label: 'Shaping the land', steps: ['layout', 'ground', 'water', 'paving', 'bridge', 'weir', 'rocks'] },
  { label: 'Raising the buildings', steps: ['inn', 'cottages', 'forge', 'mill', 'windmill', 'castle'] },
  { label: 'Planting trees and grass', steps: ['vegetation'] },
  { label: 'Setting out props and villagers', steps: ['props', 'villagers', 'fx'] },
  { label: 'Sending the scene to the graphics card', steps: ['scene', 'shaders'] },
];
/** Shares of the build time per phase, used until this machine has its own timings. */
const DEFAULT_SHARES = [0.33, 0.3, 0.1, 0.13, 0.14];
const DEFAULT_BUILD_MS = 4500;
const TIMINGS_KEY = 'fantasy-village:build-ms';
function storedTimings(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(TIMINGS_KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}
const loadingEl = document.getElementById('loading');
const loadingFill = loadingEl?.querySelector<HTMLElement>('.fill');
const loadingSteps = loadingEl?.querySelector<HTMLElement>('.steps');

/** Starts the bar and the labels for the expected build time. Only transform and opacity move, so the compositor runs them. */
function startLoadingScreen(): void {
  if (!loadingFill || !loadingSteps) return;
  const before = storedTimings();
  let phaseMs = PHASES.map((p) => p.steps.reduce((a, n) => a + (typeof before[n] === 'number' ? before[n]! : 0), 0));
  if (phaseMs.some((v) => v <= 0)) phaseMs = DEFAULT_SHARES.map((v) => v * DEFAULT_BUILD_MS);
  const total = phaseMs.reduce((a, v) => a + v, 0);
  // The bar stops just short of the end and waits there when this build takes longer than the last one.
  loadingFill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(0.97)' }], { duration: total, fill: 'forwards', easing: 'linear' });
  loadingSteps.textContent = '';
  let at = 0;
  PHASES.forEach((phase, i) => {
    const el = document.createElement('span');
    el.textContent = `${phase.label}…`;
    loadingSteps.appendChild(el);
    const last = i === PHASES.length - 1;
    const fade = Math.min(0.2, 150 / Math.max(1, phaseMs[i]!));
    el.animate(
      [{ opacity: 0 }, { opacity: 1, offset: fade }, { opacity: 1, offset: 1 - fade }, { opacity: last ? 1 : 0 }],
      { duration: phaseMs[i]!, delay: at, fill: 'both', easing: 'linear' },
    );
    at += phaseMs[i]!;
  });
}

function build(): void {
  const t0 = performance.now();
  const taken: Record<string, number> = {};
  const step = <T>(name: string, fn: () => T): T => {
    const s0 = performance.now();
    const result = fn();
    taken[name] = Math.round(performance.now() - s0);
    return result;
  };

  const ctx = step('layout', () => {
    const layout = villageLayout(seed);
    return createBuildContext(seed, layout, heightField(layout, seed), sim);
  });
  const contributions: { name: string; c: Contribution }[] = [];
  const out: MeshReport[] = [];
  for (const mod of MODULES) {
    step(mod.name, () => {
      const c = mod.build(ctx);
      contributions.push({ name: mod.name, c });
      for (const p of c.statics ?? []) if (p.mesh.triangleCount) out.push(inspect(`${mod.name}/${p.name ?? p.material}`, p.mesh));
      for (const set of c.parts ?? []) out.push(inspect(`${mod.name}/${set.name} (part ×${set.count})`, set.part));
    });
  }
  reports = out;
  // Only the solids are kept for the walk mode (the meshes go to the graphics card and are let go).
  source = { layout: ctx.layout, heightAt: ctx.heightAt, contributions: contributions.map(({ name, c }) => ({ name, c: c.solids ? { solids: c.solids } : {} })) };
  const built = step('scene', () => {
    const sc = new VillageScene(
      {
        renderer,
        add: (layer) => engine.add(layer),
        glow: () => engine.link.value(glow),
      },
      contributions,
      { shadowHz },
    );
    // The sky behind the opaque layers (statics, parts): shaded only where they left the screen empty, same image.
    if (!skyFirst) engine.moveSkyBefore(sc.firstBlendedLayer);
    sc.setGroupVisible('villagers', villagersOn);
    return sc;
  });
  // The first frame compiles the shaders and draws the shadow map.
  step('shaders', () => {
    scene = built;
    applyPause();
    engine.renderNow();
  });
  buildMs = performance.now() - t0;
  try {
    localStorage.setItem(TIMINGS_KEY, JSON.stringify(taken));
  } catch {
    // Storage may be blocked; the next load then uses the default timing.
  }
}

engine.onExtract((alpha) => {
  const now = performance.now();
  const realMs = now - lastReal;
  const real = Math.min(0.25, realMs / 1000);
  lastReal = now;
  // Idle gaps (the loop renders only on demand while paused and still) are not frame times: skip them.
  if (scene && realMs > 0 && realMs < 250) {
    const k = frameCount++ % FRAME_WINDOW;
    frameIntervals[k] = realMs;
    // The renderer's processor time of the previous frame (this callback runs before the next render).
    frameCpu[k] = renderer.lastStats.cpuMs;
  }
  // The tour moves the view (and starts mood switches) before anything reads them.
  movie.update(real);
  if (mood.step(real)) {
    env.day.set(mood.hour);
    engine.invalidate();
  }
  if (!scene) return;
  const t = env.time.time;
  frame.dt = paused ? 0 : Math.max(0, t - frame.time);
  frame.time = t;
  frame.alpha = alpha;
  frame.evening = engine.link.value(glow)?.evening ?? 0;
  // The walking figure and its view, then the eye of the current view, written in place.
  walk.extract(real);
  engine.view.eye(frame.eye);
  frame.villagersVisible = villagersOn;
  scene.update(frame);
  refreshHud();
});

const hudEl = document.getElementById('hud')!;
let hudFrame = 0;
const refreshHud = (): void => {
  if (movie.active) return;
  if (++hudFrame % 10 === 0 || !scene) hudEl.innerHTML = hud();
};

// --- Keys and the script interface ----------------------------------------------------------------------------------------
/** Pause and play; the movie keeps the scene running. */
const togglePause = (): void => {
  if (movie.active) return;
  paused = !paused;
  applyPause();
};
const KEYS: Record<string, () => void> = {
  '1': () => (movie.stop(), walk.stop(), setView(OVERVIEW)),
  '2': () => (movie.stop(), walk.stop(), setView(STREET)),
  e: () => mood.toggle(),
  p: togglePause,
  ' ': togglePause,
  m: () => (movie.active ? movie.stop() : startMovie()),
  escape: () => (movie.stop(), walk.stop()),
  g: () => (movie.stop(), walk.toggle()),
  f: () => walk.toggleFirstPerson(),
  v: () => {
    villagersOn = !villagersOn;
    scene?.setGroupVisible('villagers', villagersOn);
  },
};
window.addEventListener('keydown', (e) => {
  // Browser shortcuts (Cmd+R and the like) and held-key repeats are not ours.
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const k = e.key.toLowerCase();
  // While walking Space jumps (the walk input owns it), not pause.
  if (walk.active && k === ' ') return;
  const fn = KEYS[k];
  if (!fn) return;
  e.preventDefault();
  fn();
  engine.invalidate();
  writeHash();
  hudEl.innerHTML = hud();
});
canvas.addEventListener('pointerup', writeHash);
canvas.addEventListener('wheel', writeHash, { passive: true });
// A drag or the wheel takes the camera back: the orbit controls go on from where the tour left the view.
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons !== 0) movie.stop();
});
canvas.addEventListener('wheel', () => movie.stop(), { passive: true });

/**
 * Frame profile of the current view (`profileFrame`): synchronous, `frames` frames per measurement. `running` advances
 * the animation by 1/60 s per frame as the loop would (nothing moves while paused); the time is set back afterwards.
 */
function profile(frames = 20): FrameProfile {
  // The view takes the canvas size, as the loop does before a frame.
  engine.renderNow();
  const t0 = env.time.time;
  const p = profileFrame(renderer, engine.view, {
    frames,
    step: () => {
      sim.advance(1 / 60);
      for (const c of env.clocks) c.advance(1 / 60);
      engine.extract();
    },
  });
  env.time.set(t0);
  engine.renderNow();
  return p;
}
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
let resolveReady: () => void = () => {};
const ready = new Promise<void>((resolve) => (resolveReady = resolve));

(window as unknown as { __wh: unknown }).__wh = {
  kind: 'orbit',
  ready,
  presets: () => PRESETS,
  setView: (v: Partial<ViewPreset>) => (walk.stop(), setView(v), engine.renderNow()),
  getView: () => view.state(),
  hash,
  hud: () => hud().replace(/<\/?b>/g, ''),
  /** Resolves when the frame shows the current state: shaders compiled, shadows drawn, mood switch finished. */
  settled: async (): Promise<boolean> => {
    for (let i = 0; i < 120 && mood.moving; i++) await nextFrame();
    for (let i = 0; i < 3; i++) {
      engine.renderNow();
      await nextFrame();
    }
    return !mood.moving;
  },
  setEvening: (on: boolean) => (mood.set(on ? HOUR_EVENING : HOUR_AFTERNOON), env.day.set(mood.hour), engine.renderNow()),
  setTimeOfDay: (h: number) => (mood.set(h), env.day.set(h), engine.renderNow()),
  setTime: (s: number) => ((paused = true), applyPause(), env.time.set(s), engine.renderNow()),
  stats: () => ({ ...renderer.lastStats, renderer: engine.device.name, seed, buildMs: Math.round(buildMs), evening: frame.evening, sunElevationDeg: env.sun().elevationDeg, frameTimes: frameTimes(), scene: scene?.stats() }),
  /** Per-mesh numbers (size, triangles, flipped faces, volume) of every module's statics and part meshes. */
  inspect: (filter = ''): string[] => reports.filter((r) => r.name.includes(filter)).map(formatReport),
  /** Frame profile of the current view: frame times and the cost of every layer (see `profileFrame`). */
  profile,
  /** The same as a text table. */
  profileText: (frames = 20): string => formatProfile(profile(frames)),
  /**
   * Movie mode: `start()` the tour (blending in from the current view), `stop()`, `active()`, `seek(t)` (show the tour
   * at `t` seconds, camera and mood at once; the tour runs on from there while active).
   */
  movie: {
    start: () => startMovie(),
    stop: () => movie.stop(),
    active: () => movie.active,
    seek: (t: number) => (movie.seek(t), engine.renderNow()),
  },
  /**
   * Walk mode: `start()` (the figure on the square, the follow view), `stop()` (the orbit view above the figure),
   * `active()`, `state()` (position, speed, grounded, first person, solids), `walkTo(x, z, seconds, { run })` (fixed
   * walker steps toward a point, synchronously, the same path as `pnpm collisions`), `teleport(x, y, z, yawDeg?)` (y
   * NaN or omitted: on the ground), `firstPerson()` (toggles it), `solids()` (solids per label).
   */
  walk: {
    start: () => (movie.stop(), walk.start(), engine.renderNow()),
    stop: () => (walk.stop(), engine.renderNow()),
    active: () => walk.active,
    state: () => walk.state(),
    walkTo: (x: number, z: number, seconds: number, o: { run?: boolean; within?: number } = {}) => {
      movie.stop();
      const s = walk.walkTo(x, z, seconds, o);
      engine.renderNow();
      return s;
    },
    teleport: (x: number, y: number | undefined, z: number, yawDeg?: number) => {
      movie.stop();
      const s = walk.teleport(x, y, z, yawDeg);
      engine.renderNow();
      return s;
    },
    firstPerson: () => (walk.toggleFirstPerson(), engine.renderNow(), walk.firstPerson),
    solids: () => walk.world?.counts ?? null,
  },
};

// Build once the loading screen has painted and its animations have started, then start. A hidden tab gets no
// animation frames, so there the build starts from the task queue.
function begin(): void {
  try {
    build();
  } catch (err) {
    console.error(err);
    loadingEl?.classList.add('failed');
    for (const a of loadingEl?.getAnimations({ subtree: true }) ?? []) a.cancel();
    if (loadingSteps) loadingSteps.textContent = `The build failed: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  engine.start();
  hudEl.innerHTML = hud();
  if (movieAtStart) startMovie(true);
  else if (walkAtStart) walk.start();
  if (loadingFill) loadingFill.animate([{ transform: 'scaleX(1)' }], { duration: 150, fill: 'forwards' });
  loadingEl?.classList.add('done');
  setTimeout(() => loadingEl?.remove(), 700);
  resolveReady();
}
startLoadingScreen();
if (document.hidden) setTimeout(begin, 0);
else requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(begin, 0)));
