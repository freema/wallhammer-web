// Rivers example on Wallhammer Web: an island whose sea, lakes and running water follow one rule. The plan gives a
// level of water along every line (plan.ts), the ground is only ever cut down to it (ground.ts), and water is
// wherever the ground lies under the level that may stand there: the sea's (0), a lake's or a line's. The page draws
// exactly that: the ground as chunked meshes, and one water sheet that lies at those levels (water-mesh.ts).
//
// URL hash: #seed=3&view=fall&free   (seed default 1; view one of the presets below, default island; free, or
// mode=free, opens in free flight)
// Controls: orbit (drag orbits, the wheel zooms) or free flight (F toggles; drag looks, W A S D / arrows fly, E / Space
// up, Q / C down, Shift faster, the wheel sets the speed); keys 1–9 and 0 jump to the presets in both; K follows the
// walkers on the paths in turn (walkers.ts), the first, the second, …, none.
//
// The build takes about two seconds of work on the main thread. It runs in slices of a few tens of milliseconds that
// yield to the browser between them, and reports its stages through the engine's `Progress` (loading.ts draws it).

import { PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import { Progress, type ProgressReport, type Vec3 } from 'wallhammer-web/base';
import { FreeRig } from 'wallhammer-web/camera';
import { bindFreeInput, type FreeInput } from 'wallhammer-web/platform';
import { ParticleLayer, PieceLayer } from 'wallhammer-web/render';
import type { Material } from 'wallhammer-web/render';
import { createEngine } from 'wallhammer-web/runtime';
import { fieldRows, fieldSize, type Field } from './field.ts';
import { FigureCast } from './figures/cast.ts';
import { GROUND_MATERIAL } from './ground-material.ts';
import { SEA_FLOOR_M, SEA_REACH_M, STEP_M, groundPieces, seaFloorPiece } from './ground-mesh.ts';
import { HALF_M, SIZE_M } from './land.ts';
import { LoadingBar } from './loading.ts';
import { mistSources } from './mist.ts';
import { waterPlan, type Plan } from './plan.ts';
import { layPaths } from './path-ground.ts';
import { pathPlan, pathStats, type PathPlan } from './paths.ts';
import { coverOf, treePieces } from './trees.ts';
import { pathKinds } from './path-kinds.ts';
import { pathProps } from './path-props.ts';
import { WALKER_LOOK_M, viewsOf, walkerView, type RiverView } from './views.ts';
import { walkerPlace, walkerStates, walkersOf, type Walkers } from './walkers.ts';
import { WATER_MATERIAL } from './water-material.ts';
import { openSeaPiece, waterPieces } from './water-mesh.ts';

const q = new URLSearchParams(location.hash.slice(1));
const seedText = Number(q.get('seed') ?? 1);
const seed = Number.isFinite(seedText) ? Math.round(seedText) : 1;
const freeAtStart = (q.has('free') && q.get('free') !== '0') || q.get('mode') === 'free';
const panel = document.querySelector<HTMLPreElement>('#panel')!;
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;

// --- Field lookups ---------------------------------------------------------------------------------------------------
let plan: Plan | null = null;
let field: Field | null = null;
let paths: PathPlan | null = null;
let walkers: Walkers | null = null;

/** A value of the field at a point (bilinear), or `outside` beyond the square (and before the field is built). */
function fieldAt(values: Float32Array, x: number, z: number, outside: number): number {
  const f = field;
  if (!f) return outside;
  const fx = (x - f.x0) / f.step;
  const fz = (z - f.z0) / f.step;
  if (fx < 0 || fz < 0 || fx >= f.n - 1 || fz >= f.n - 1) return outside;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const k = j * f.n + i;
  const g = values;
  return (g[k]! * (1 - u) + g[k + 1]! * u) * (1 - v) + (g[k + f.n]! * (1 - u) + g[k + f.n + 1]! * u) * v;
}
/** Ground height of the field at a point (bilinear), for keeping the orbit's eye above it. */
function groundAt(x: number, z: number): number {
  return field ? fieldAt(field.ground, x, z, SEA_FLOOR_M) : SEA_FLOOR_M;
}
/** The top of what is there: the ground or the water standing over it; beyond the square the sea at 0. */
function surfaceAt(x: number, z: number): number {
  return field ? Math.max(fieldAt(field.ground, x, z, SEA_FLOOR_M), fieldAt(field.water, x, z, 0)) : 0;
}

// --- Engine ----------------------------------------------------------------------------------------------------------
const view = new PerspectiveOrbitRig({ fovYDeg: 50, minPitchDeg: -15, maxPitchDeg: 88, minDistance: 4, maxDistance: 8000 }, { target: [-100, 0, -100], yawDeg: 34, pitchDeg: 20, distance: 3000 });
/** Metres the free camera keeps above the ground and above any water (`surfaceAt`). */
const FREE_CLEARANCE_M = 1.5;
// The free camera is made up front and swapped in with `engine.setView`; its pitch limit matches the orbit's, so a view
// handed from one rig to the other keeps its direction.
const free = new FreeRig(
  { fovYDeg: 50, maxPitchDeg: 88, minClearance: FREE_CLEARANCE_M, minSpeed: 4, maxSpeed: 1500 },
  { heightAbove: (p) => p[1] - surfaceAt(p[0], p[2]) },
);
const engine = createEngine<PerspectiveOrbitRig | FreeRig>({
  canvas,
  view,
  palette: definePalette({ sky: '#9cb8cf' }),
  background: [0x9c / 255, 0xb8 / 255, 0xcf / 255],
  // One view holds a bank a few metres away and the island kilometres away: reversed depth.
  renderer: { depth: 'reversed', depthNearM: 0.3, shadowSoftnessM: 0.8, shadowDistanceM: 1500 },
  environment: { mode: 'day', site: { latitudeDeg: 47, longitudeDeg: 0, dayOfYear: 200, utcOffsetHours: 0 }, hour: 15.5, hoursPerSecond: 0.5, wind: { fromDeg: 230, speedMs: 4 } },
  // The orbit controls act only while the orbit rig is the engine's view; the free controls are bound in free mode.
  orbitControls: true,
  sky: { hazeDistanceM: 9000, cloudHeightM: 1500 },
});
const { renderer, env } = engine;
env.day.pause();

// --- Presets ---------------------------------------------------------------------------------------------------------
interface Preset {
  name: string;
  target: [number, number, number];
  yawDeg: number;
  pitchDeg: number;
  distance: number;
  fov: number;
}
/** An orbit state that puts the eye at `eye` and looks at `target` (forward = −sin yaw cos pitch, −sin pitch, −cos yaw cos pitch). */
function orbitThrough(eye: readonly number[], target: readonly number[]): { target: [number, number, number]; yawDeg: number; pitchDeg: number; distance: number } {
  const dx = target[0]! - eye[0]!;
  const dy = target[1]! - eye[1]!;
  const dz = target[2]! - eye[2]!;
  const d = Math.hypot(dx, dy, dz);
  return { target: [target[0]!, target[1]!, target[2]!], yawDeg: (Math.atan2(-dx, -dz) * 180) / Math.PI, pitchDeg: (Math.asin(-dy / d) * 180) / Math.PI, distance: d };
}
/** An eye, a target and a field of view as a state of the orbit rig. */
function presetOf(v: RiverView): Preset {
  return { name: v.name, ...orbitThrough(v.eye, v.target), fov: v.fov };
}
let presets: Preset[] = [];

// --- Following a walker ------------------------------------------------------------------------------------------------
/** The walker the orbit follows (its target tracks the walker every frame), or −1. */
let following = -1;
/** The preset `walker` for walker `i` at the current animation time. */
function walkerPreset(i: number): Preset | null {
  if (!walkers || i < 0 || i >= walkers.walkers.length) return null;
  const at = walkerPlace(walkers, i, env.time.time);
  return presetOf(walkerView(at.position, at.forward));
}

// --- Two modes: orbit and free flight --------------------------------------------------------------------------------
type Mode = 'orbit' | 'free';
let mode: Mode = 'orbit';
let freeInput: FreeInput | null = null;

/**
 * Applies a (partial) preset. The orbit rig takes it as it always has; in free mode the orbit is first set to what the
 * free camera shows, so the parts the preset leaves out stay as they are, and the free camera then takes the orbit's
 * eye and direction.
 */
function setView(v: Partial<Preset>): void {
  // The preset `walker` is made afresh for the walker followed (the first if none), at the current time, and starts
  // following it; any other preset stops following.
  if (v.name === 'walker') {
    const i = following >= 0 ? following : 0;
    const p = walkerPreset(i);
    if (!p) return;
    v = p;
    following = i;
    if (mode === 'free') setMode('orbit');
  } else if (v.name !== undefined) following = -1;
  if (mode === 'free') orbitFromFree();
  if (v.fov !== undefined) view.setup.fovYDeg = v.fov;
  view.setState(v);
  if (mode === 'free') freeFromOrbit();
  showPanel();
}

/** The free camera at the orbit's eye, looking the same way through the same field of view. */
function freeFromOrbit(): void {
  const s = view.state();
  free.setup.fovYDeg = view.setup.fovYDeg;
  // setState drops the velocity and lifts the eye to the clearance if it is lower (the orbit keeps 1 m above the ground only).
  free.setState({ position: view.eye(), yawDeg: s.yawDeg, pitchDeg: s.pitchDeg });
}

/**
 * The orbit around what the free camera looks at: the target is where the view direction meets the ground or the
 * water. Looking above the horizon (or at ground farther than the orbit reaches) the target is a point on the surface
 * straight ahead along the heading, a few times the eye's height away. The eye stays where it is.
 */
function orbitFromFree(): void {
  const eye = free.position;
  const fwd = free.axes().forward;
  const reach = view.setup.maxDistance;
  const hit = surfaceHit(eye, fwd, reach);
  let target: Vec3;
  if (hit !== null) {
    const t = Math.max(hit, view.setup.minDistance);
    target = [eye[0] + fwd[0] * t, eye[1] + fwd[1] * t, eye[2] + fwd[2] * t];
  } else {
    const h = free.headingDir();
    const height = eye[1] - surfaceAt(eye[0], eye[2]);
    const d = Math.min(reach * 0.5, Math.max(200, 4 * height));
    const x = eye[0] + h[0] * d;
    const z = eye[2] + h[2] * d;
    target = [x, surfaceAt(x, z), z];
  }
  view.setup.fovYDeg = free.setup.fovYDeg;
  view.setState(orbitThrough(eye, target));
}

/** Distance along the unit ray from `o` to the first point below the surface (ground or water), or null within `maxT`. */
function surfaceHit(o: Vec3, d: Vec3, maxT: number): number | null {
  const above = (t: number): number => o[1] + d[1] * t - surfaceAt(o[0] + d[0] * t, o[2] + d[2] * t);
  let h = above(0);
  if (h <= 0) return 0;
  let t0 = 0;
  // Steps a fraction of the height above the surface: long high up, a metre near it, so a slope is not stepped over.
  for (let t = 0; t < maxT; ) {
    t0 = t;
    t = Math.min(maxT, t + Math.min(50, Math.max(1, h * 0.4)));
    h = above(t);
    if (h <= 0) {
      let lo = t0;
      let hi = t;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (above(mid) > 0) lo = mid;
        else hi = mid;
      }
      return hi;
    }
    if (t >= maxT) break;
  }
  return null;
}

function setMode(m: Mode): void {
  if (m === mode) return;
  if (m === 'free') {
    following = -1;
    freeFromOrbit();
    freeInput = bindFreeInput(canvas, free, { onChange: () => engine.invalidate() });
    engine.setView(free);
  } else {
    freeInput?.dispose();
    freeInput = null;
    orbitFromFree();
    engine.setView(view);
  }
  mode = m;
  canvas.classList.toggle('free', m === 'free');
  showPanel();
  engine.invalidate();
}

// Held keys move the free camera by the real time since the last frame; the render origin stays at the world's.
renderer.beforeFrame.unshift(() => {
  if (freeInput) freeInput.step();
});

// --- Building --------------------------------------------------------------------------------------------------------
let buildMs = 0;
let loadMs = 0;
const counts = { ground: 0, water: 0, groundTriangles: 0, waterTriangles: 0 };

// Weights from times measured on the main thread (Apple M4 Pro, seed 1), in about tenths of a second: the plan ~0.2 s,
// the field ~1.65 s, the ground pieces ~0.18 s, the water pieces ~0.05 s; the uploads (estimated) ~0.06 s; the shaders
// and the first frame ~0.03 s together (the programs link in the driver while the field is sampled).
const progress = new Progress([
  { key: 'plan', label: 'Planning the water', weight: 2 },
  { key: 'field', label: 'Sampling the ground and the water', weight: 16.5 },
  { key: 'ground', label: 'Shaping the ground', weight: 2 },
  { key: 'water', label: 'Laying the water', weight: 0.5 },
  { key: 'upload', label: 'Uploading the meshes', weight: 0.6 },
  { key: 'shaders', label: 'Compiling the shaders', weight: 0.1 },
  { key: 'frame', label: 'Drawing the first frame', weight: 0.2 },
]);
const bar = new LoadingBar(document.querySelector<HTMLDivElement>('#loading')!);
progress.subscribe((r) => bar.show(r));

/** About how long one slice of work holds the main thread before the browser gets it back (to paint the bar). */
const SLICE_MS = 40;
let sliceEnd = 0;
// A message to oneself is a new task at once: unlike setTimeout it is not clamped to 4 ms after a few nestings, and
// unlike requestAnimationFrame it runs in a hidden tab too. The browser paints between tasks when a frame is due.
const channel = new MessageChannel();
const queued: (() => void)[] = [];
channel.port1.onmessage = () => queued.shift()?.();
const nextTask = (): Promise<void> => new Promise((resolve) => (queued.push(resolve), channel.port2.postMessage(null)));
/** Gives the browser the main thread when the current slice has run its time; otherwise returns at once. */
async function pause(): Promise<void> {
  if (performance.now() < sliceEnd) return;
  await nextTask();
  sliceEnd = performance.now() + SLICE_MS;
}
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** The plan's numbers: lines, lakes, falls and stretches where a level rises (expected 0). */
function checksOf(p: Plan): { lines: number; joining: number; lakes: number; falls: number; highestFallM: number; uphill: number } {
  let falls = 0;
  let top = 0;
  let uphill = 0;
  for (const l of p.lines)
    for (let i = 0; i + 1 < l.n; i++) {
      if (l.fall[i]) (falls++, (top = Math.max(top, l.level[i]! - l.level[i + 1]!)));
      if (l.level[i + 1]! > l.level[i]! + 1e-9) uphill++;
    }
  return { lines: p.lines.length, joining: p.lines.filter((l) => l.into >= 0).length, lakes: p.lakes.length, falls, highestFallM: Math.round(top * 10) / 10, uphill };
}

async function build(): Promise<void> {
  const t0 = performance.now();
  // The programs start compiling now and link in the driver while the main thread works on the plan and the field.
  const [groundMat, waterMat] = [GROUND_MATERIAL, WATER_MATERIAL].map((m) => renderer.material(m)) as [Material, Material];
  // Let the bar show its first stage before the plan holds the main thread.
  await nextTask();
  plan = waterPlan(seed);
  progress.complete('plan');
  sliceEnd = 0;
  await pause();

  const rows = fieldRows(plan, -HALF_M, -HALF_M, SIZE_M, STEP_M);
  progress.total('field', fieldSize(SIZE_M, STEP_M));
  let rowsDone = 0;
  for (;;) {
    const r = rows.next();
    if (r.done) {
      field = r.value;
      break;
    }
    // The report is updated once per slice, not per row: the bar cannot show more often than it is painted.
    if (performance.now() >= sliceEnd) {
      progress.advance('field', r.value - rowsDone);
      rowsDone = r.value;
      await pause();
    }
  }
  progress.complete('field');
  await pause();

  // The paths are laid over the finished water: they read the field and then cut their treads into it.
  const laid = pathPlan(plan, field);
  paths = laid;
  layPaths(field, laid);
  await pause();
  const cover = coverOf(field, seed);
  const treeData = treePieces(field, cover, seed, laid);
  await pause();
  const kinds = pathKinds(laid, field, cover, seed);
  walkers = walkersOf(laid, kinds, field, seed);
  const groundData = [...groundPieces(field, cover, laid, kinds), seaFloorPiece(field), ...treeData, ...pathProps(field, cover, laid, kinds, seed)];
  progress.complete('ground');
  await pause();
  const waterData = [...waterPieces(field), openSeaPiece(field)];
  progress.complete('water');
  await pause();

  progress.total('upload', groundData.length + waterData.length);
  const ground = new PieceLayer({ material: groundMat, order: 'front-to-back', name: 'ground' });
  let top = 0;
  for (const p of groundData) {
    ground.add({ mesh: renderer.createMesh(p.data, groundMat), min: p.min, max: p.max });
    counts.ground++;
    counts.groundTriangles += p.data.count / 3;
    top = Math.max(top, p.max[1]);
    progress.advance('upload');
    await pause();
  }
  const water = new PieceLayer({ material: waterMat, name: 'water' });
  for (const p of waterData) {
    water.add({ mesh: renderer.createMesh(p.data, waterMat), min: p.min, max: p.max });
    counts.water++;
    counts.waterTriangles += p.data.count / 3;
    progress.advance('upload');
    await pause();
  }
  // The walkers are opaque and drawn after the ground; the water blends over both, so it is drawn after them.
  const cast = new FigureCast(renderer);
  cast.prepare(['pathfinder']);
  const walking = walkers;
  // Posed every frame from the animation time (`setTime` freezes them), before the frame is drawn; the orbit's
  // target follows the walker followed.
  engine.onExtract(() => {
    const t = env.time.time;
    if (following >= 0 && mode === 'orbit') {
      const at = walkerPlace(walking, following, t);
      view.setState({ target: [at.position[0], at.position[1] + WALKER_LOOK_M, at.position[2]] });
    }
    cast.figures = walkerStates(walking, t);
    cast.update(engine.view.eye());
  });
  engine.add(ground);
  engine.add(cast.layer);
  engine.add(water);
  // The mist of the falls, over the water.
  engine.add(new ParticleLayer(renderer, mistSources(plan), { name: 'mist' }));
  const R = HALF_M + SEA_REACH_M;
  renderer.bounds = { min: [-R, SEA_FLOOR_M - 1, -R], max: [R, top + 20, R] };
  view.setup.groundAt = groundAt;
  view.setup.minEyeHeight = 1;
  presets = viewsOf(plan, laid).map(presetOf);
  const firstWalker = walkerPreset(0);
  if (firstWalker) presets.push(firstWalker);
  if (freeAtStart) setMode('free');
  const first = presets.find((p) => p.name === q.get('view')) ?? presets[0];
  if (first) setView(first);
  buildMs = performance.now() - t0;

  // Programs the driver still links (KHR_parallel_shader_compile), polled every few milliseconds instead of blocking on
  // them (a timer, not a frame: it runs in a hidden tab too).
  const compiling = engine.device.compiling();
  progress.total('shaders', compiling);
  for (let left = compiling, done = 0; left > 0; left = engine.device.compiling()) {
    progress.advance('shaders', compiling - left - done);
    done = compiling - left;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  progress.complete('shaders');
  showPanel();
}

function showPanel(): void {
  if (!plan) return;
  const c = checksOf(plan);
  const lakes = plan.lakes.map((l) => `${l.nodes}@${l.level.toFixed(0)} m`).join(', ') || 'none';
  const controls =
    mode === 'orbit'
      ? ['orbit: drag orbits, wheel zooms', 'F  free flight', `K  follow a walker (${following >= 0 ? `now ${following + 1} of ${walkers?.walkers.length ?? 0}` : 'none'})`]
      : ['free flight: drag looks, W A S D / arrows fly', 'E / Space up, Q / C down', 'Shift faster, wheel sets the speed', 'F  orbit'];
  panel.textContent = [
    `seed ${seed}  (#seed=N, #view=name, #free)`,
    `${c.lines} lines, ${c.joining} joining another`,
    `${c.falls} falls, highest ${c.highestFallM.toFixed(0)} m; ${c.uphill} stretches rising`,
    `lakes (nodes@level): ${lakes}`,
    `paths: ${paths ? `${paths.paths.length}, ${(pathStats(paths).reduce((m, p) => m + p.lengthM, 0) / 1000).toFixed(1)} km` : 'none'}`,
    `walkers: ${walkers ? `${walkers.walkers.length} on ${walkers.loops.length} loops` : 'none'}`,
    `built in ${(buildMs / 1000).toFixed(1)} s`,
    '',
    ...controls,
    // Keys 1–9 and 0 reach the first ten presets; `walker` is reached with K.
    ...presets.map((p, i) => `${p.name === 'walker' ? 'K' : i < 10 ? (i + 1) % 10 : ' '}  ${p.name}`),
  ].join('\n');
  panel.hidden = false;
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || !field) return;
  if (e.code === 'KeyF') {
    if (!e.repeat) setMode(mode === 'orbit' ? 'free' : 'orbit');
    return;
  }
  if (e.code === 'KeyK') {
    if (!e.repeat) followNext();
    return;
  }
  const i = e.key === '0' ? 9 : Number(e.key) - 1;
  const p = Number.isInteger(i) ? presets[i] : undefined;
  if (p) (setView(p), engine.invalidate());
});

/** Follows the next walker (the first, the second, …, then none), from behind it. */
function followNext(): void {
  const n = walkers?.walkers.length ?? 0;
  const next = following + 1 < n ? following + 1 : -1;
  if (next < 0) following = -1;
  else {
    following = next;
    setView({ name: 'walker' });
  }
  showPanel();
  engine.invalidate();
}

// --- The script interface ----------------------------------------------------------------------------------------------
let resolveReady: () => void = () => {};
const ready = new Promise<void>((resolve) => (resolveReady = resolve));
const now = (f: () => void): void => (f(), engine.renderNow());

(window as unknown as { __wh: unknown }).__wh = {
  kind: 'rivers',
  ready,
  presets: () => presets,
  setView: (v: Partial<Preset>) => now(() => setView(v)),
  /** The orbit state of the view; in free mode that of the orbit `F` would return to (the eye exactly, the direction unless it is out of the orbit's pitch range). */
  getView: () => {
    if (mode === 'free') orbitFromFree();
    return { ...view.state(), fov: view.setup.fovYDeg };
  },
  /** `orbit` or `free`. */
  mode: (): Mode => mode,
  /** Switches the mode as F does. */
  setMode: (m: Mode) => now(() => setMode(m === 'free' ? 'free' : 'orbit')),
  /** The free camera's state (position in world metres, yaw and pitch in degrees) and its height over the ground or water. */
  freeState: () => ({ ...free.state(), clearance: free.clearance }),
  /** The loading report (`ProgressReport` of the engine's `Progress`). */
  progress: (): ProgressReport => progress.report,
  /** Resolves when the frame shows the current state (shaders compiled, shadow map drawn). */
  settled: async (): Promise<boolean> => {
    await ready;
    for (let i = 0; i < 3; i++) {
      engine.renderNow();
      await nextFrame();
    }
    return true;
  },
  setTimeOfDay: (h: number) => now(() => (env.day.pause(), env.day.set(h))),
  setTime: (s: number) => now(() => (env.time.pause(), env.time.set(s))),
  stats: () => ({ ...renderer.lastStats, renderer: engine.device.name, seed, buildMs: Math.round(buildMs), loadMs: Math.round(loadMs), pieces: { ...counts }, fieldPoints: field ? field.n * field.n : 0 }),
  checks: () => (plan ? checksOf(plan) : null),
  /** Per path: the places it joins, its length, its steepest grade and its fords. */
  paths: () => (paths ? pathStats(paths) : null),
  /** Per walker at the current animation time: its place on the ground, heading (degrees, 0 toward −z, 90 toward +x), look, path and loop. */
  walkers: () => {
    const w = walkers;
    if (!w) return null;
    return w.walkers.map((k, i) => {
      const at = walkerPlace(w, i, env.time.time);
      const l = w.loops[k.loop]!;
      return { position: at.position, headingDeg: (Math.atan2(at.forward[0], -at.forward[2]) * 180) / Math.PI, variant: k.variant, motion: k.motion, path: l.path, stations: [l.from, l.to], loopM: l.lengthM, alongM: at.alongM, leader: k.leader };
    });
  },
  /** The walker the orbit follows (0-based), or −1; `follow(i)` follows walker i from behind (−1 stops). */
  following: () => following,
  follow: (i: number) => now(() => (i >= 0 ? ((following = i), setView({ name: 'walker' })) : (following = -1), showPanel())),
  /** Milliseconds one frame of the current view costs, its GPU work finished: the mean of `frames` synchronous renders. */
  measureFrame: (frames = 30) => renderer.benchmark(mode === 'free' ? free : view, frames),
};

async function begin(): Promise<void> {
  const t0 = performance.now();
  try {
    await build();
    engine.start();
    // The bar says what is coming before the first frame holds the main thread (shadow map, first draws).
    await nextFrame();
    engine.renderNow();
  } catch (err) {
    console.error(err);
    bar.fail(err instanceof Error ? err.message : String(err));
    return;
  }
  progress.finish();
  loadMs = performance.now() - t0;
  canvas.classList.add('drawn');
  bar.hide();
  resolveReady();
}
void begin();

if (import.meta.hot) import.meta.hot.dispose(() => (freeInput?.dispose(), engine.dispose()));
