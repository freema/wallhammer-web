// Lunar research outpost on Wallhammer Web: a small station on a grey plain under a black sky, drawn in a flat comic
// look (style/materials.ts): palette colours, three hard light steps, dark outlines, long hard shadows from one low
// sun, and the home planet low over the horizon. The layout (src/layout.ts) and the ground height
// (src/terrain/height.ts) are the shared ground truth; content modules (src/modules.ts) build meshes and part sets
// from them; the scene (src/render/scene.ts) turns those into engine layers.
//
// URL hash: #seed=1&yaw=0&pitch=18&dist=33&tx=3.5&ty=2&tz=0&p=0      (p paused; views=a,b limits __wh.presets)
//   tick=<n> shows the state at that simulation tick, paused (a mark's view carries it).
// Controls: drag orbits, the wheel zooms, R or Home the default view (also the HUD button), space pauses. N switches
// the mark mode (dev server only: a click pins a note to the ground; marks=1 turns the marks on in a page driven by a
// script, marks=0 hides the pins).

import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { createEngine, heightPick, installEngineMarking } from 'wallhammer-web/runtime';
import { Simulation } from 'wallhammer-web/sim';
import { formatProfile, profileFrame } from 'wallhammer-web/tools';
import type { FrameProfile } from 'wallhammer-web/tools';
import { buildContext } from './context.ts';
import type { MeshData } from 'wallhammer-web/base';
import type { Contribution, FrameInfo } from './kit/types.ts';
import { outpostLayout } from './layout.ts';
import { outpostModules } from './modules.ts';
import { OutpostScene } from './render/scene.ts';
import { terrain } from './terrain/height.ts';
import type { Terrain } from './terrain/height.ts';

const q = new URLSearchParams(location.hash.slice(1));
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const seed = Math.round(num('seed', 1));
/** Cap of the canvas pixel ratio (pr=0: the device's own ratio). */
const pixelRatioCap = num('pr', 1.5);

interface ViewPreset {
  name: string;
  target: [number, number, number];
  yawDeg: number;
  pitchDeg: number;
  distance: number;
}

/** The composition of the concept: an elevated three-quarter view over the station, the planet top right. */
const DEFAULT_VIEW: ViewPreset = { name: 'default', target: [3.5, 2, 0], yawDeg: 0, pitchDeg: 18, distance: 33 };
const PRESETS: ViewPreset[] = [
  DEFAULT_VIEW,
  { name: 'dome', target: [18, 2.5, -13], yawDeg: -28, pitchDeg: 16, distance: 24 },
  { name: 'maintenance', target: [-1.5, 1.4, 9], yawDeg: 18, pitchDeg: 18, distance: 15 },
  { name: 'roof', target: [0.5, 10.5, -2], yawDeg: -25, pitchDeg: 24, distance: 16 },
  { name: 'pad', target: [33, 1, -26], yawDeg: -15, pitchDeg: 32, distance: 34 },
  { name: 'low', target: [6, 2, -6], yawDeg: 12, pitchDeg: 7, distance: 45 },
  { name: 'high', target: [0, 0, -10], yawDeg: 30, pitchDeg: 55, distance: 120 },
  { name: 'crew', target: [2.2, 1.1, 11.5], yawDeg: 8, pitchDeg: 14, distance: 11 },
  { name: 'rover', target: [16.7, 1.2, 8.4], yawDeg: -12, pitchDeg: 16, distance: 12 },
];
/** `#views=default,crew` limits the views listed to scripts (screenshot tools take every listed one). */
const viewFilter = (q.get('views') ?? '').split(',').filter(Boolean);
const listedViews = viewFilter.length ? PRESETS.filter((p) => viewFilter.includes(p.name)) : PRESETS;
/** Lowest eye height over the ground under it, metres. */
const EYE_CLEARANCE = 1.5;

// --- Engine ------------------------------------------------------------------------------------------------------------
const layout = outpostLayout(seed);
const sim = new Simulation({ seed: `outpost-${seed}`, hz: 30 });
const view = new PerspectiveOrbitRig(
  { fovYDeg: 50, minPitchDeg: 4, maxPitchDeg: 86, minDistance: 6, maxDistance: 180 },
  { target: [num('tx', DEFAULT_VIEW.target[0]), num('ty', DEFAULT_VIEW.target[1]), num('tz', DEFAULT_VIEW.target[2])], yawDeg: num('yaw', DEFAULT_VIEW.yawDeg), pitchDeg: num('pitch', DEFAULT_VIEW.pitchDeg), distance: num('dist', DEFAULT_VIEW.distance) },
);
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const engine = createEngine({
  canvas,
  view,
  palette: definePalette({ sky: '#000000' }),
  background: [0, 0, 0],
  // Hard shadows: a small penumbra over the whole station, cut at one half by the toon material.
  renderer: { shadowSoftnessM: 0.12, shadowDistanceM: 170 },
  ...(pixelRatioCap > 0 ? { maxPixelRatio: pixelRatioCap } : {}),
  sim,
  // A sun fixed in the world; the look uses nothing else of the environment's light.
  environment: { mode: 'fixed', weather: { cloudCover: 0 } },
  orbitControls: true,
});
const { renderer, env } = engine;
env.setFixedLight([...layout.sunDir]);

// --- State ---------------------------------------------------------------------------------------------------------------
let paused = q.get('p') === '1';
let scene: OutpostScene | null = null;
/** The ground, once built (the pick of the marks reads it). */
let ground: Terrain | null = null;
/** Size facts of every static mesh and part mesh, for `__wh.inspect`. */
let meshes: { name: string; triangles: number; vertices: number; size: number[]; count: number }[] = [];
function facts(name: string, m: MeshData, count: number): (typeof meshes)[number] {
  const stride = m.layout.stride;
  const v = m.vertices as Uint8Array;
  const f = new DataView(v.buffer, v.byteOffset, v.byteLength);
  const n = v.byteLength / stride;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const x = f.getFloat32(i * stride + k * 4, true);
    min[k] = Math.min(min[k]!, x);
    max[k] = Math.max(max[k]!, x);
  }
  return { name, triangles: m.count / 3, vertices: n, size: max.map((x, k) => x - min[k]!), count };
}
let buildMs = 0;
/** The simulation right after the build (tick 0): every module keeps its moving state in it. */
let tickZero: Uint8Array | null = null;
const frame: FrameInfo = { time: 0, dt: 0, alpha: 0, eye: [0, 0, 0] };

function applyPause(): void {
  if (paused) {
    env.time.pause();
    sim.pause();
  } else {
    env.time.play();
    sim.play();
  }
}

function hash(): string {
  const v = view.state();
  const r = (x: number): string => String(Math.round(x * 10) / 10);
  return `seed=${seed}&yaw=${r(v.yawDeg)}&pitch=${r(v.pitchDeg)}&dist=${r(v.distance)}&tx=${r(v.target[0])}&ty=${r(v.target[1])}&tz=${r(v.target[2])}&p=${paused ? 1 : 0}`;
}
let hashTimer = 0;
function writeHash(): void {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => history.replaceState(null, '', `#${hash()}`), 250);
}

function setView(v: Partial<ViewPreset>): void {
  view.setState({ ...(v.target ? { target: v.target } : {}), ...(v.yawDeg !== undefined ? { yawDeg: v.yawDeg } : {}), ...(v.pitchDeg !== undefined ? { pitchDeg: v.pitchDeg } : {}), ...(v.distance !== undefined ? { distance: v.distance } : {}) });
  engine.invalidate();
  writeHash();
}
const resetCamera = (): void => setView(DEFAULT_VIEW);

// --- HUD -----------------------------------------------------------------------------------------------------------------
const hudLines = document.querySelector<HTMLElement>('#hud .lines')!;
function hud(): string {
  const s = scene?.stats();
  const st = renderer.lastStats;
  const lines = [
    `<b>Lunar research outpost</b>${paused ? '  · paused' : ''}`,
    'drag: orbit · wheel: zoom · R / Home: default view · space: pause',
  ];
  lines.push(s ? `${(st.triangles / 1e6).toFixed(2)} M triangles · ${st.drawCalls} draws · build ${(buildMs / 1000).toFixed(1)} s` : 'building…');
  return lines.join('\n');
}
let hudFrame = 0;
const refreshHud = (force = false): void => {
  if (force || ++hudFrame % 15 === 0) hudLines.innerHTML = hud();
};

// --- Build -----------------------------------------------------------------------------------------------------------------
function build(): void {
  const t0 = performance.now();
  const t = terrain(layout);
  ground = t;
  const ctx = buildContext(seed, layout, t);
  const contributions: { name: string; c: Contribution }[] = [];
  const list: typeof meshes = [];
  for (const mod of outpostModules(t, sim)) {
    const c = mod.build(ctx);
    contributions.push({ name: mod.name, c });
    for (const set of c.parts ?? []) list.push(facts(`${mod.name}/${set.name}`, set.mesh, set.count));
  }
  // The orbit keeps the eye EYE_CLEARANCE over the ground (raising the pitch when it would go under).
  view.setup.groundAt = t.heightAt;
  view.setup.minEyeHeight = EYE_CLEARANCE;
  view.keepAboveGround();
  meshes = list;
  scene = new OutpostScene(renderer, (layer) => engine.add(layer), contributions, layout.planet);
  meshes = [...scene.built.map((p) => facts(p.name, p.mesh, 1)), ...meshes];
  tickZero = sim.snapshot();
  applyPause();
  engine.renderNow();
  buildMs = performance.now() - t0;
}

engine.onExtract((alpha) => {
  if (!scene) return;
  scene.setInk(view.height);
  // Animation time is the simulation's: whole ticks plus the share of the next one.
  const time = (sim.tick + (paused ? 0 : alpha)) / sim.hz;
  frame.dt = paused ? 0 : Math.max(0, time - frame.time);
  frame.time = time;
  frame.alpha = alpha;
  view.eye(frame.eye);
  scene.update(frame);
  refreshHud();
});

// --- Keys and the script interface ----------------------------------------------------------------------------------------
const togglePause = (): void => {
  paused = !paused;
  applyPause();
};
const KEYS: Record<string, () => void> = { r: resetCamera, home: resetCamera, ' ': togglePause };
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const fn = KEYS[e.key.toLowerCase()];
  if (!fn) return;
  e.preventDefault();
  fn();
  engine.invalidate();
  writeHash();
  refreshHud(true);
});
document.getElementById('reset')!.addEventListener('click', () => {
  resetCamera();
  refreshHud(true);
});
canvas.addEventListener('pointerup', writeHash);
canvas.addEventListener('wheel', writeHash, { passive: true });

function profile(frames = 20): FrameProfile {
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

function setTick(n: number): number {
  paused = true;
  applyPause();
  if (tickZero) {
    sim.rebase(tickZero);
    sim.step(Math.max(0, Math.floor(n)));
  }
  engine.renderNow();
  refreshHud(true);
  return sim.tick;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
let resolveReady: () => void = () => {};
const ready = new Promise<void>((resolve) => (resolveReady = resolve));

(window as unknown as { __wh: unknown }).__wh = {
  kind: 'orbit',
  ready,
  presets: () => listedViews,
  setView: (v: Partial<ViewPreset>) => (setView(v), engine.renderNow()),
  getView: () => view.state(),
  hash,
  resetCamera: () => (resetCamera(), engine.renderNow()),
  setPaused: (on: boolean) => ((paused = on), applyPause(), engine.renderNow(), paused),
  /** Pauses and shows the state at simulation tick `n` (set up again from tick 0 and stepped). */
  setTick,
  /** Pauses and shows the state at `s` seconds of animation time (the nearest tick). */
  setTime: (s: number) => setTick(Math.round(s * sim.hz)),
  tick: () => sim.tick,
  /** Resolves when the frame shows the current state (shaders compiled, shadow map drawn). */
  settled: async (): Promise<boolean> => {
    for (let i = 0; i < 3; i++) {
      engine.renderNow();
      await nextFrame();
    }
    return true;
  },
  stats: () => ({ ...renderer.lastStats, renderer: engine.device.name, seed, buildMs: Math.round(buildMs), scene: scene?.stats() }),
  /** Triangles and size of every module's static mesh and part mesh (name filter optional). */
  inspect: (filter = ''): string[] =>
    meshes
      .filter((m) => m.name.includes(filter))
      .map(({ name, triangles, vertices, size, count }) => `${name}${count !== 1 ? ` ×${count}` : ''}: ${triangles} tris, ${vertices} verts, ${size.map((v) => v.toFixed(1)).join(' × ')} m`),
  profile,
  profileText: (frames = 20): string => formatProfile(profile(frames)),
};

// Marks (key N): notes pinned to points of the ground, picked against its height function (the station, its props,
// the crew and the rover are not in it). A mark's hash is the page's own (`hash()`) with the simulation tick (`tick=`)
// and the exact view; the light is fixed, so no clocks are recorded. Only in the dev server (the live demos have none);
// `__wh.marks` is the script interface.
if (import.meta.env.DEV) {
  const marks = installEngineMarking(engine, {
    pick: heightPick((x, z) => (ground ? ground.heightAt(x, z) : 0), { maxDistanceM: 2000, surface: 'ground' }),
    hash: () => `${hash()}&tick=${sim.tick}`,
    clocks: false,
    allowed: () => scene !== null,
  });
  Object.assign((window as unknown as { __wh: object }).__wh, { marks });
}

function begin(): void {
  const loading = document.getElementById('loading');
  try {
    build();
  } catch (err) {
    console.error(err);
    loading?.classList.add('failed');
    const msg = loading?.querySelector('.msg');
    if (msg) msg.textContent = `Build failed: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  engine.start();
  if (q.has('tick')) setTick(num('tick', 0));
  refreshHud(true);
  loading?.classList.add('done');
  // Ready once the loading screen has faded out, so a screenshot shows the scene alone.
  setTimeout(() => {
    loading?.remove();
    resolveReady();
  }, 600);
}
if (document.hidden) setTimeout(begin, 0);
else requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(begin, 0)));

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    scene?.dispose();
    engine.dispose();
  });
}
