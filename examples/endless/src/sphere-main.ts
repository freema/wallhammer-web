// Sphere world on Wallhammer Web (sphere.html): a sphere of 100 km radius made of six quadtrees, streamed around a
// free camera from far above down to the surface. It puts together the engine options a round world needs:
//   - the world shape `SphereWorld` (cells of all six faces, distances along the sphere, up away from the centre),
//   - a generator on 3D noise with the sphere patch mesh, blended between levels (sphere-world.ts),
//   - the renderer's `radialUp` (lighting, fog and upright objects follow the local up),
//   - a render origin that follows the camera on all three axes and a depth mode that holds a metre and the whole
//     sphere in one view,
//   - culling of the cells behind the sphere's own horizon.
//
// URL hash: #seed=7&lat=35&lon=20&alt=180000&yaw=0&pitch=89&hour=13&src=workers&levels=0
//   lat, lon: degrees on the sphere (the poles are on the y axis); alt: metres above the surface; pitch: positive
//   looks down. src: workers (default) or main. depth: reversed (default) or logarithmic. horizon=0 switches the
//   horizon culling off; px and cells set the tolerance in pixels and the budget of cells.
//   atm=1 (default off): the engine's atmosphere, a shell of air round the sphere: the sky from the ground up to
//   orbit, the air in front of the terrain, and the sun where the hour puts it over the turning sphere, so the far
//   side is in the night. air sets the thickness of the shell in metres (default 30000).
//   cover=1 (default off): the terrain carries the trees beyond the levels that draw them (their baked density), and
//   the trees leave one by one across the blend band instead of all at once.
// Controls: W A S D fly along the view, E / Q up and down, Shift faster, drag looks around, the wheel changes the
// speed, 1 jumps far above the surface, 2 down to it, [ ] move the hour, L shows cell levels, H hides this panel.

import { definePalette } from 'wallhammer-web';
import type { DepthMode, Vec3 } from 'wallhammer-web/base';
import { FreeRig } from 'wallhammer-web/camera';
import { atmosphereFor, sphereSunDirection } from 'wallhammer-web/env';
import type { Material } from 'wallhammer-web/render';
import { bindFreeInput, workersAvailable } from 'wallhammer-web/platform';
import { DEFAULT_STREAMING, GeneratorCellProvider, pixelsPerRadian } from 'wallhammer-web/world';
import type { CellProvider, StreamingConfig } from 'wallhammer-web/world';
import { StreamedWorld, WorkerCellProvider, createEngine, viewerTickets } from 'wallhammer-web/runtime';
import { pillarMesh, treeMesh } from './shapes.ts';
import { SPHERE_COVER_TERRAIN_MATERIAL, SPHERE_FADING_PROP_MATERIAL, SPHERE_PROP_MATERIAL, SPHERE_TERRAIN_MATERIAL } from './sphere-shaders.ts';
import { COVER_LEVEL, HORIZON_RADIUS_M, LEAF_LEVEL, MIN_SPLIT_EDGES, RADIUS_M, ROOT_LEVEL, SELECTION, SHAPE, generateSphereCell, surfaceHeight } from './sphere-world.ts';

const q = new URLSearchParams(location.hash.slice(1));
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const seed = Math.round(num('seed', 7));
const DEG = Math.PI / 180;
const FOV_DEG = 50;
/** The two options of this page that are off unless asked for. */
const atmOn = q.get('atm') === '1';
const coverOn = q.get('cover') === '1';
/** Thickness of the shell of air. The highest ground is about 5.5 km. */
const airHeightM = Math.max(1000, num('air', 30_000));
/** Day of the year the sun is computed for. */
const DAY_OF_YEAR = 172;

/** Height of a world position above the visible surface under it. */
const heightAbove = (p: readonly [number, number, number]): number => {
  const b = SHAPE.noiseDomain(p);
  return SHAPE.altitude(p) - surfaceHeight(seed, b[0], b[1], b[2]);
};

/** World position `alt` metres above the surface at a latitude and longitude in degrees. */
function place(latDeg: number, lonDeg: number, alt: number): Vec3 {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const d = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)] as const;
  const r = RADIUS_M + surfaceHeight(seed, d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M) + alt;
  return [d[0] * r, d[1] * r, d[2] * r];
}

/** Latitude and longitude in degrees of a world position. */
function latLon(p: readonly [number, number, number]): [number, number] {
  const d = SHAPE.directionOf(p);
  return [Math.asin(Math.max(-1, Math.min(1, d[1]))) / DEG, Math.atan2(d[2], d[0]) / DEG];
}

// --- Engine ----------------------------------------------------------------------------------------------------------
// The camera takes up from the shape and keeps itself above the surface; its speed follows its height.
const rig = new FreeRig(
  { fovYDeg: FOV_DEG, minClearance: 2, minSpeed: 5, maxSpeed: 40_000 },
  { shape: SHAPE, heightAbove },
  { position: place(num('lat', 35), num('lon', 20), num('alt', 180_000)), yawDeg: num('yaw', 0), pitchDeg: num('pitch', 89) },
);
const depth: DepthMode = q.get('depth') === 'logarithmic' ? 'logarithmic' : 'reversed';
const engine = createEngine({
  canvas: document.querySelector<HTMLCanvasElement>('#view')!,
  view: rig,
  palette: definePalette({ sky: '#05070c' }),
  background: [0.02, 0.027, 0.047],
  // `radialUp`: up points away from the sphere's centre in every shader that asks for it.
  renderer: { shadowSoftnessM: 1.2, shadowDistanceM: 4000, shadowMapSize: 4096, depth, radialUp: SHAPE.radial },
  // The light is one direction for the whole sphere; at hour 13 it stands high over the +y side.
  environment: { mode: 'day', site: { latitudeDeg: 40, longitudeDeg: 0, dayOfYear: DAY_OF_YEAR, utcOffsetHours: 0 }, hour: num('hour', 13), hoursPerSecond: 0.5, weather: {}, wind: { fromDeg: 240, speedMs: 6 }, clouds: { sizeM: 2400 } },
  // The default air of the engine fitted to this small sphere; the ground sphere is the `radialUp` one.
  ...(atmOn ? { atmosphere: atmosphereFor(RADIUS_M, airHeightM) } : {}),
});
const { renderer, env } = engine;
env.day.pause();
// With radial up the fog layer is given as heights above the base sphere.
env.fogLayer = { bottomY: 0, topY: 1500 };

// --- Streaming -------------------------------------------------------------------------------------------------------
const src = q.get('src') ?? (workersAvailable() ? 'workers' : 'main');
const onMain = src === 'main' || !workersAvailable();
// With the cover the cells come from the same generator with its third argument set (another vertex layout).
const provider: CellProvider = coverOn
  ? onMain
    ? new GeneratorCellProvider(seed, (s, cell) => generateSphereCell(s, cell, true))
    : new WorkerCellProvider(new URL('./sphere-cover-cell-worker.ts', import.meta.url), seed)
  : onMain
    ? new GeneratorCellProvider(seed, generateSphereCell)
    : new WorkerCellProvider(new URL('./sphere-cell-worker.ts', import.meta.url), seed);
const config: StreamingConfig = {
  ...DEFAULT_STREAMING,
  shape: SHAPE,
  // No `face`: cells of all six faces are streamed. Every root is always wanted, so the far side stays covered.
  rootLevel: ROOT_LEVEL,
  leafLevel: LEAF_LEVEL,
  rootRange: Infinity,
  prefetch: 0.2,
  hysteresis: 0.3,
  maxInFlight: 12,
  memoryBudgetBytes: 384 * 1024 * 1024,
  screenError: { ...SELECTION, maxErrorPx: Math.max(0.25, num('px', SELECTION.maxErrorPx)), maxCells: Math.max(64, Math.round(num('cells', SELECTION.maxCells))) },
};
const [terrain, prop] = [coverOn ? SPHERE_COVER_TERRAIN_MATERIAL : SPHERE_TERRAIN_MATERIAL, SPHERE_PROP_MATERIAL].map((m) => renderer.material(m)) as [Material, Material];
// The trees are what the cover stands for: with it they get the material that lets them leave one by one.
const fading: Material | null = coverOn ? renderer.material(SPHERE_FADING_PROP_MATERIAL) : null;
const horizonOn = q.get('horizon') !== '0';
const world = new StreamedWorld({
  renderer,
  config,
  provider,
  // The render origin follows the camera on all three axes: numbers on the GPU stay small anywhere round the sphere.
  originAxes: 'all',
  morph: true,
  ...(horizonOn ? { horizon: { center: SHAPE.centerM, radiusM: HORIZON_RADIUS_M } } : {}),
  materials: { terrain, prop, ...(fading ? { fading } : {}) },
  archetypes: {
    // With the cover the fade alone decides where a tree ends: no cut by distance. Where level 10 reaches beyond
    // 2.6 km (a small tolerance `px`, a tall canvas) that cut would come first and remove the trees at once, before
    // the cover is in.
    tree: { material: fading ? 'fading' : 'prop', lods: [{ mesh: treeMesh(true), maxDistance: 700 }, { mesh: treeMesh(false), maxDistance: fading ? Infinity : 2600 }] },
    pillar: { material: 'prop', lods: [{ mesh: pillarMesh(true), maxDistance: 3500 }, { mesh: pillarMesh(false), maxDistance: 20000 }] },
  },
  uploadMsPerFrame: 4,
  blockingMsPerFrame: 8,
  onActivity: () => engine.invalidate(),
});
engine.add(world);
let showLevels = num('levels', 0) === 1;
const applyLevels = (): void => void (world.uniforms = { u_showLevels: { float: showLevels ? 1 : 0 }, ...(coverOn ? { u_coverLevel: { float: COVER_LEVEL } } : {}) });
applyLevels();

// --- Camera → streaming ----------------------------------------------------------------------------------------------
const input = bindFreeInput(engine.canvas, rig, { onChange: () => engine.invalidate() });
let scripted = false;
/** Pixels one radian covers, never less than what splits a cell at `MIN_SPLIT_EDGES` edges (the blend needs the room). */
function ticketPixels(): number {
  const se = config.screenError!;
  return Math.max(pixelsPerRadian(engine.canvas.clientHeight || engine.canvas.height, FOV_DEG * DEG), (MIN_SPLIT_EDGES * se.maxErrorPx) / se.errorPerEdge);
}
// Before the streaming step: move, then hand the camera to the world. The rig's position is in world metres and its
// `origin` follows the render origin.
renderer.beforeFrame.unshift(() => {
  if (!scripted) input.step();
  const p = rig.position;
  const eye: [number, number, number] = [p[0], p[1], p[2]];
  // With the atmosphere the sun stands where the hour puts it over the turning sphere, and what follows its height
  // (light colours, exposure, the direction shadows are cast in) is computed for the place under the camera.
  if (atmOn) env.observer = { up: SHAPE.directionOf(eye), sunDir: sphereSunDirection(DAY_OF_YEAR, env.day.time) };
  world.setFocus(eye);
  rig.origin = [world.origin[0], world.origin[1], world.origin[2]];
  world.setEye(eye);
  world.setTickets(viewerTickets({ eye, altitude: rig.clearance, forward: rig.axes().forward, velocity: rig.velocity, pixelsPerRadian: ticketPixels() }));
});

/** Jumps to `alt` metres above the surface under the camera, looking `pitchDeg` below the horizon. */
function jump(alt: number, pitchDeg: number): void {
  const [lat, lon] = latLon(rig.position);
  rig.setState({ position: place(lat, lon, alt), pitchDeg });
}

// --- Keys, overlay, URL ----------------------------------------------------------------------------------------------
const overlay = document.querySelector<HTMLPreElement>('#overlay')!;
const KEYS: Record<string, () => void> = {
  Digit1: () => jump(180_000, 89),
  Digit2: () => jump(3, 4),
  BracketLeft: () => env.day.set((env.day.time + 23.5) % 24),
  BracketRight: () => env.day.set((env.day.time + 0.5) % 24),
  KeyL: () => ((showLevels = !showLevels), applyLevels()),
  KeyH: () => overlay.classList.toggle('hidden'),
};
window.addEventListener('keydown', (e) => {
  const k = KEYS[e.code];
  if (k && !e.repeat) (k(), engine.invalidate());
});

const fmt = (v: number, d = 0): string => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const mb = (b: number): string => `${(b / 1048576).toFixed(1)} MB`;
function overlayText(): string {
  const s = world.stats();
  const r = renderer.lastStats;
  const [lat, lon] = latLon(rig.position);
  const st = s.states;
  return [
    `lat ${fmt(lat, 3)}°  lon ${fmt(lon, 3)}°  ${fmt(rig.clearance, 1)} m above the surface  ${fmt(Math.hypot(...rig.velocity), 1)} m/s`,
    `sphere radius ${fmt(RADIUS_M / 1000)} km  air ${atmOn ? `${fmt(airHeightM / 1000)} km` : 'off'}  cover ${coverOn ? 'on' : 'off'}  depth ${renderer.depthMode}  origin ${fmt(world.origin[0])}, ${fmt(world.origin[1])}, ${fmt(world.origin[2])}`,
    `cells  MESHED ${st.MESHED}  RESIDENT ${st.RESIDENT}  drawn ${s.drawn}/${s.wanted} wanted  holes ${s.holes}  visible ${s.cellsVisible}  behind the horizon ${horizonOn ? s.horizonCulled : 'off'}`,
    `work   in flight ${s.inFlight}  queued ${s.queued}  done ${s.completed}  failed ${s.failed}  evicted ${s.evicted}   ${provider.name}`,
    `memory cpu ${mb(s.cpuBytes)}  gpu ${mb(s.gpuBytes)}   detail ${fmt(s.detail * 100)} %   ${s.settled ? 'settled' : 'streaming…'}`,
    `frame  ${r.cpuMs.toFixed(1)} ms cpu  ${engine.loop.fps ? `${engine.loop.fps.toFixed(0)} fps` : 'idle'}   ${r.drawCalls} draws  ${fmt(r.triangles)} tris`,
    `WASD fly · E/Q up/down · Shift fast · drag look · wheel speed · 1 far · 2 surface · [ ] hour · L levels · H hide`,
  ].join('\n');
}
let lastHash = '';
setInterval(() => {
  if (!overlay.classList.contains('hidden')) overlay.textContent = overlayText();
  const [lat, lon] = latLon(rig.position);
  const v = rig.state();
  const h = `seed=${seed}&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&alt=${rig.clearance.toFixed(1)}&yaw=${v.yawDeg.toFixed(1)}&pitch=${v.pitchDeg.toFixed(1)}&hour=${env.day.time.toFixed(2)}${src !== 'workers' ? `&src=${src}` : ''}${showLevels ? '&levels=1' : ''}${q.has('depth') ? `&depth=${depth}` : ''}${horizonOn ? '' : '&horizon=0'}${q.has('px') ? `&px=${q.get('px')}` : ''}${q.has('cells') ? `&cells=${q.get('cells')}` : ''}${atmOn ? '&atm=1' : ''}${q.has('air') ? `&air=${q.get('air')}` : ''}${coverOn ? '&cover=1' : ''}`;
  if (h !== lastHash && !scripted) {
    lastHash = h;
    history.replaceState(null, '', `#${h}`);
  }
}, 250);

// --- Script interface (tools/shot/shot.mjs) --------------------------------------------------------------------------
interface ViewSpec {
  name?: string;
  lat?: number;
  lon?: number;
  /** Metres above the surface. */
  height?: number;
  yawDeg?: number;
  pitchDeg?: number;
  hour?: number;
  levels?: boolean;
  overlay?: boolean;
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Renders frames until the streaming has settled (every wanted cell drawn, nothing in flight). */
async function settle(limit = 6000): Promise<boolean> {
  for (let i = 0; i < limit; i++) {
    engine.renderNow();
    if (world.settled && !world.busy) {
      engine.renderNow();
      return true;
    }
    await tick();
  }
  return false;
}
(window as unknown as { __wh: unknown }).__wh = {
  kind: 'free',
  ready: new Promise<void>((resolve) => requestAnimationFrame(() => (engine.renderNow(), resolve()))),
  presets: (): ViewSpec[] => [
    { name: 'sphere-far', lat: 35, lon: 20, height: 180_000, yawDeg: 0, pitchDeg: 89 },
    { name: 'sphere-limb', lat: 35, lon: 20, height: 20_000, yawDeg: 40, pitchDeg: 12 },
    { name: 'sphere-surface', lat: 35, lon: 20, height: 3, yawDeg: 40, pitchDeg: 4 },
    { name: 'sphere-edge', lat: 0, lon: 45, height: 400, yawDeg: 0, pitchDeg: 20, levels: true },
    { name: 'sphere-south', lat: -88, lon: 0, height: 30, yawDeg: 120, pitchDeg: 8 },
  ],
  setView: (v: ViewSpec): void => {
    scripted = true;
    const [lat, lon] = latLon(rig.position);
    rig.setState({ position: place(v.lat ?? lat, v.lon ?? lon, v.height ?? rig.clearance), ...(v.yawDeg !== undefined ? { yawDeg: v.yawDeg } : {}), ...(v.pitchDeg !== undefined ? { pitchDeg: v.pitchDeg } : {}) });
    if (v.hour !== undefined) (env.day.pause(), env.day.set(v.hour));
    showLevels = v.levels ?? false;
    applyLevels();
    overlay.classList.toggle('hidden', !v.overlay);
    engine.renderNow();
  },
  getView: () => ({ ...rig.state(), height: rig.clearance }),
  settled: async (): Promise<boolean> => {
    const ok = await settle();
    overlay.textContent = overlayText();
    return ok;
  },
  isSettled: (): boolean => world.settled && !world.busy,
  setTimeOfDay: (h: number) => (env.day.pause(), env.day.set(h), engine.renderNow()),
  setTime: (s: number) => (env.time.pause(), env.time.set(s), engine.renderNow()),
  setTick: (): void => {},
  stats: () => ({ ...renderer.lastStats, renderer: engine.device.name, seed, streaming: world.stats(), provider: provider.name }),
  overlay: overlayText,
};
engine.start();
