// Minimal 3D example on Wallhammer Web: a perspective orbit view of a small island with standing stones, lit by the
// sun of a chosen day and hour, and figures that walk among the stones through the fixed-step simulation; a cart and
// porters drawn as instanced rigs go round the ring on a track (rigs.ts). Everything
// comes from code; the same seed, tick, time and view always give the same image.
//
// URL hash: #seed=7&tick=600&hour=18.5&day=250&yaw=35&pitch=24&dist=105&w=rain   (tick: frozen at that tick)
// Controls: drag orbits, the wheel zooms, [ ] move the hour, space runs the day, P pauses the figures, . steps one
// tick, - and = halve and double their speed, C calls the wanderers to the gap in the ring.

import { DEFAULT_WEATHER, PerspectiveOrbitRig, definePalette, heightFieldMesh } from 'wallhammer-web';
import type { InstanceData, MeshData, WeatherState } from 'wallhammer-web';
import { InstancedLayer, MeshLayer, RigLayer } from 'wallhammer-web/render';
import type { InstanceBatch, Material } from 'wallhammer-web/render';
import type { Uniforms } from 'wallhammer-web/base';
import { createEngine } from 'wallhammer-web/runtime';
import { FigureLayer } from './figures.ts';
import { glowSlot } from './glow.ts';
import { TAG, createLife } from './life.ts';
import { TrackRigs } from './rigs.ts';
import { ISLAND_SIZE_M, RING_YAW, STONE_BOUNDS, TRACK_RADIUS_M, boulderMesh, boulders, islandField, ringMesh, seaMesh, slabMesh, standingStones } from './scene.ts';
import { GROUND_MATERIAL, SOLID_MATERIAL, STONE_MATERIAL } from './shaders.ts';

const q = new URLSearchParams(location.hash.slice(1));
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const seed = Math.round(num('seed', 7));
const WEATHER: Record<string, Partial<WeatherState>> = {
  clear: {},
  clouds: { cloudCover: 0.45 },
  rain: { cloudCover: 0.8, precipitation: 0.7, precipitationKind: 'rain', wetness: 0.8, fog: 0.25 },
  snow: { cloudCover: 0.7, precipitation: 0.6, precipitationKind: 'snow', snowCover: 0.8, fog: 0.2 },
  fog: { cloudCover: 0.3, fog: 0.7 },
};

// --- Engine: canvas, renderer, environment, view, simulation and the frame loop in one place -------------------------
const glow = glowSlot();
const life = createLife(seed);
const engine = createEngine({
  canvas: document.querySelector<HTMLCanvasElement>('#view')!,
  view: new PerspectiveOrbitRig({ fovYDeg: 40, minDistance: 25, maxDistance: 260 }, { yawDeg: num('yaw', 35), pitchDeg: num('pitch', 24), distance: num('dist', 105) }),
  palette: definePalette({ sky: '#8fb2c9' }),
  background: [0x8f / 255, 0xb2 / 255, 0xc9 / 255],
  slots: [glow],
  // The sea reaches far beyond the island, so shadows are limited to what is near.
  renderer: { shadowSoftnessM: 0.35, shadowDistanceM: 420 },
  sim: life.sim,
  // The moon stands low in the south, so the orbit view can see it.
  environment: { mode: 'day', day: { moonAzimuthDeg: 150, moonElevationDeg: 13 }, site: { latitudeDeg: 51, longitudeDeg: 0, dayOfYear: num('day', 250), utcOffsetHours: 0 }, hour: num('hour', 18.5), hoursPerSecond: 0.5, weather: WEATHER[q.get('w') ?? 'clear'] ?? {}, wind: { fromDeg: 230, speedMs: 5 }, clouds: { sizeM: 520 } },
  orbitControls: true,
  precipitation: true,
  sky: { hazeDistanceM: 1500, cloudHeightM: 1000 },
});
const { renderer, env, sim, view } = engine;
env.day.pause();

// --- Scene -----------------------------------------------------------------------------------------------------------
const field = islandField(seed);
/** How far the sea reaches beyond the island: far enough that its edge lies under the horizon haze. */
const SEA_REACH_M = 4000;
const c = ISLAND_SIZE_M / 2;
view.target = [c, 6, c];
env.fogLayer = { bottomY: field.minY, topY: field.maxY + 10 };
renderer.bounds = { min: [-SEA_REACH_M, field.minY - 6, -SEA_REACH_M], max: [ISLAND_SIZE_M + SEA_REACH_M, field.maxY + 24, ISLAND_SIZE_M + SEA_REACH_M] };
const [ground, solid, stoneMat] = [GROUND_MATERIAL, SOLID_MATERIAL, STONE_MATERIAL].map((m) => renderer.material(m)) as [Material, Material, Material];
const meshLayer = (material: Material, data: MeshData, albedo: [number, number, number], extra: Uniforms = {}): MeshLayer =>
  new MeshLayer({ material, mesh: renderer.createMesh(data, material), uniforms: { u_albedo: { vec3: albedo }, ...extra } });
const stones = (shape: MeshData, data: InstanceData, albedo: [number, number, number], glowBand: number): InstanceBatch => {
  const instances = renderer.createInstances(data);
  return { lods: [renderer.createMesh(shape, stoneMat, instances)], instances, all: data.data, uniforms: { u_albedo: { vec3: albedo }, u_glowBand: { float: glowBand } } };
};
engine.add(meshLayer(ground, heightFieldMesh(field, field.minY - 6), [1, 1, 1]));
engine.add(meshLayer(solid, seaMesh(-0.8, SEA_REACH_M), [0.12, 0.2, 0.23], { u_water: { float: 1 }, u_glowShare: { float: 0 } }));
engine.add(meshLayer(solid, ringMesh([c, field.heightAt(c, c), c], 7.5, 0.9, RING_YAW), [0.62, 0.6, 0.58], { u_water: { float: 0 }, u_glowShare: { float: 0.35 } }));
const stoneLayer = new InstancedLayer(engine.device, { material: stoneMat, bounds: STONE_BOUNDS });
stoneLayer.batches = [stones(slabMesh(), standingStones(field, seed), [0.6, 0.58, 0.55], 1), stones(boulderMesh(seed), boulders(field, seed), [0.47, 0.45, 0.43], 0)];
engine.add(stoneLayer);

// --- Figures: the simulation moves them, extraction places them ------------------------------------------------------
const figures = new FigureLayer(renderer);
const t = life.figures.table;
const robeOf = (row: number): number => (t.col.tag[row]! % 8 === TAG.procession ? 0 : 1 + (t.idAt(row) % 5));
engine.onExtract((alpha) => figures.update(life.figures, alpha, field, robeOf));
engine.add(figures);

// --- Rig demo: the cart and porters on the track, posed in the vertex shader from `extractPose` ------------------------
const rigLayer = new RigLayer(renderer);
const gapAngle = (9 / 13) * Math.PI * 2;
const trackStop: [number, number, number] = [c + Math.cos(gapAngle) * TRACK_RADIUS_M, 0, c + Math.sin(gapAngle) * TRACK_RADIUS_M];
trackStop[1] = field.heightAt(trackStop[0], trackStop[2]) + 1;
const trackRigs = new TrackRigs(rigLayer);
engine.onExtract((alpha) => {
  trackRigs.update(life.track, alpha, field);
  // Lamps come on as the sun goes down.
  rigLayer.lamps = Math.min(1, Math.max(0, (4 - env.sun().elevationDeg) / 8));
});
engine.add(rigLayer);
if (q.has('tick')) (sim.seek(num('tick', 0)), sim.pause());

// --- Keys and the script interface -------------------------------------------------------------------------------------
const KEYS: Record<string, () => void> = {
  '[': () => env.day.set((env.day.time + 23.5) % 24),
  ']': () => env.day.set((env.day.time + 0.5) % 24),
  ' ': () => env.day.toggle(),
  p: () => (sim.paused ? sim.play() : sim.pause()),
  '.': () => sim.stepOnce(),
  '-': () => sim.setSpeed(sim.speed / 2),
  '=': () => sim.setSpeed(Math.min(16, sim.speed * 2)),
  c: () => engine.command('call'),
};
window.addEventListener('keydown', (e) => KEYS[e.key.toLowerCase()] && (KEYS[e.key.toLowerCase()]!(), engine.invalidate()));

const now = <T>(f: () => T): T => (f(), engine.renderNow(), undefined as T);
(window as unknown as { __wh: unknown }).__wh = {
  kind: 'orbit',
  ready: new Promise<void>((resolve) => requestAnimationFrame(() => (engine.renderNow(), resolve()))),
  presets: () => [
    { name: 'orbit-a', yawDeg: 35, pitchDeg: 24, distance: 105 },
    { name: 'orbit-b', yawDeg: 200, pitchDeg: 14, distance: 70 },
    { name: 'close', yawDeg: 300, pitchDeg: 26, distance: 42 },
    // Close on the track where the cart halts, at the gap in the ring.
    { name: 'track', target: trackStop, yawDeg: 250, pitchDeg: 20, distance: 15 },
    { name: 'track-b', target: trackStop, yawDeg: 160, pitchDeg: 32, distance: 20 },
  ],
  setView: (v: { target?: [number, number, number]; yawDeg?: number; pitchDeg?: number; distance?: number }) => now(() => view.setState(v)),
  getView: () => view.state(),
  setTimeOfDay: (h: number) => now(() => (env.day.pause(), env.day.set(h))),
  setTime: (s: number) => now(() => (env.time.pause(), env.time.set(s))),
  setTick: (n: number) => now(() => (sim.pause(), sim.seek(n))),
  setWeather: (name: string) => now(() => (env.weather = { ...DEFAULT_WEATHER, ...(WEATHER[name] ?? {}) })),
  rigs: () => ({ ...rigLayer.counts, track: life.track.table.count }),
  stats: () => ({ ...renderer.lastStats, renderer: engine.device.name, seed, tick: sim.tick, state: sim.stateHash(), figures: t.count, glow: engine.link.value(glow)?.strength ?? 0 }),
  benchmark: (n: number): number => renderer.benchmark(view, n),
};
engine.start();
