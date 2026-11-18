// Planet example of Wallhammer Web: a flight from the surface of a small planet up to where the whole sphere is in
// view, and back. It puts the engine's large-scale options together, with content of its own:
//   - the world shape `SphereWorld`: a sphere of 100 km radius made of six quadtrees, streamed around the camera,
//   - terrain from noise in space with its own seed, blended between levels, with trees and rocks that hand over to a
//     cover baked into the surface (world.ts, shaders.ts, shapes.ts),
//   - the atmosphere: one shell of air from the ground up to orbit, and the sun where the hour puts it,
//   - the free camera `FreeRig`, a render origin that follows it on all three axes and a depth mode that holds a
//     metre and the whole sphere in one view,
//   - a scripted flight (flight.ts) whose pose is a pure function of time.
//
// URL hash: #seed=2611&lat=..&lon=..&alt=3&yaw=..&pitch=3&hour=..
//   lat, lon: degrees on the sphere (the poles are on the y axis); alt: metres above the surface; pitch: positive
//   looks down. Without lat and lon the page starts at a place found from the seed (`findStart`).
//   fly=1 starts the flight as soon as the start view has loaded; flyS: seconds of the way up (default 50);
//   top: height of the top in metres (default: a quarter above the height that shows the whole sphere with its air).
//   atm=0 switches the atmosphere off, atm=ref starts it in the reference quality (every pixel integrates its own
//   view ray; R switches); air: thickness of the shell in metres (default 30000).
//   depth: reversed (default) or logarithmic. src: workers (default) or main. horizon=0 switches the horizon culling
//   off. px and cells set the tolerance in pixels and the budget of cells; gpu the ceiling of GPU memory in MB
//   (default 560, 0 = none). levels=1 tints the cells by level.
//   strip=0 switches the strips off (strips.ts): the page is then the one without them, its generator, worker and
//   materials. With the strips and without lat and lon the page starts 3 m above the main line, 300 m from its start.
//   view=<name> starts in one of the views of `__wh.presets()`.
// Controls: F starts and stops the flight. W A S D fly along the view, E / Q up and down, Shift faster, drag looks
// around, the wheel changes the speed, 1 jumps to the top, 2 down to the surface, [ ] move the hour, L shows cell
// levels, B measures a frame with the graphics work finished, R switches the air between its tables and the reference
// quality, H hides the panel.

import { definePalette } from 'wallhammer-web';
import type { DepthMode, Vec3 } from 'wallhammer-web/base';
import { FreeRig } from 'wallhammer-web/camera';
import { atmosphereFor, sphereSunDirection } from 'wallhammer-web/env';
import type { Material } from 'wallhammer-web/render';
import { bindFreeInput, workersAvailable } from 'wallhammer-web/platform';
import { GeneratorCellProvider, pixelsPerRadian } from 'wallhammer-web/world';
import type { CellProvider, StreamingConfig } from 'wallhammer-web/world';
import { StreamedWorld, WorkerCellProvider, createEngine, viewerTickets } from 'wallhammer-web/runtime';
import { DEFAULT_FLIGHT, flightDuration, flightPose, wholeSphereHeight } from './flight.ts';
import type { FlightPlan } from './flight.ts';
import { flightStreaming } from './flight-check.ts';
import { OBJECT_MATERIAL, STRIP_MATERIAL, TERRAIN_MATERIAL } from './shaders.ts';
import { rockMesh, treeMesh } from './shapes.ts';
import { STRIP_HALF_WIDTHS, generatePlanetStripCell, planetStrips, stripGroundHeight } from './strips.ts';
import { AIR_HEIGHT_M, DEFAULT_SEED, HORIZON_RADIUS_M, MIN_SPLIT_EDGES, OBJECT_LEVEL, RADIUS_M, SELECTION, SHAPE, directionAt, findStart, generatePlanetCell, latLonOf, surfaceHeight } from './world.ts';

const q = new URLSearchParams(location.hash.slice(1));
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const seed = Math.round(num('seed', DEFAULT_SEED));
const DEG = Math.PI / 180;
const FOV_DEG = 50;
/** Day of the year the sun is computed for. */
const DAY_OF_YEAR = 172;
/** The budget the example is built for: milliseconds of a frame and megabytes of GPU memory. */
const BUDGET = { frameMs: 8, gpuMb: 600 } as const;
const MB = 1048576;

const atmOn = q.get('atm') !== '0';
const airHeightM = Math.max(1000, num('air', AIR_HEIGHT_M));
const depth: DepthMode = q.get('depth') === 'logarithmic' ? 'logarithmic' : 'reversed';
const horizonOn = q.get('horizon') !== '0';
const gpuCeilingMb = Math.max(0, num('gpu', 560));
/** The flight: the top lies a quarter above the least height that shows the whole sphere with its air. */
const topM = Math.max(1000, num('top', 1.25 * wholeSphereHeight(RADIUS_M, atmOn ? airHeightM : 0, FOV_DEG)));
const climbS = Math.max(5, num('flyS', DEFAULT_FLIGHT.climbS));
/** The strips (strips.ts): on unless `strip=0`. */
const stripOn = q.get('strip') !== '0';
const strips = stripOn ? planetStrips(seed) : null;

/** Height of the visible surface at a point of the base sphere: with the strips the ground is cut and filled. */
const groundAt = (x: number, y: number, z: number): number => (stripOn ? stripGroundHeight(seed, x, y, z) : surfaceHeight(seed, x, y, z));

/** Height of a world position above the visible surface under it. */
const heightAbove = (p: readonly [number, number, number]): number => {
  const b = SHAPE.noiseDomain(p);
  return SHAPE.altitude(p) - groundAt(b[0], b[1], b[2]);
};

/** World position `alt` metres above the surface in a direction from the centre. */
function above(d: readonly [number, number, number], alt: number): Vec3 {
  const r = RADIUS_M + groundAt(d[0] * RADIUS_M, d[1] * RADIUS_M, d[2] * RADIUS_M) + alt;
  return [d[0] * r, d[1] * r, d[2] * r];
}

/** Direction from the centre to the centre line of strip line `line`, `m` metres along it (clamped to its ends). */
function stripPoint(line: number, m: number): [number, number, number] {
  const l = strips!.lines[line]!;
  const s = l.stations;
  const F = 12;
  let k = 0;
  while (k + 2 < l.count && s[(k + 1) * F + 11]! < m) k++;
  const a = s[k * F + 11]!;
  const b = s[(k + 1) * F + 11]!;
  const t = Math.min(1, Math.max(0, b > a ? (m - a) / (b - a) : 0));
  return SHAPE.directionOf([s[k * F]! + (s[(k + 1) * F]! - s[k * F]!) * t, s[k * F + 1]! + (s[(k + 1) * F + 1]! - s[k * F + 1]!) * t, s[k * F + 2]! + (s[(k + 1) * F + 2]! - s[k * F + 2]!) * t]);
}
/** Length of strip line `line` in metres. */
const stripEnd = (line: number): number => {
  const l = strips!.lines[line]!;
  return l.stations[(l.count - 1) * 12 + 11]!;
};

// --- Start view ------------------------------------------------------------------------------------------------------
// Without a place in the URL: low land with something to look at, found from the seed; with the strips a point of the
// main line 300 m from its start, looking along it.
const placed = q.has('lat') && q.has('lon');
const found = placed || strips ? null : findStart(seed);
const onStrip = !placed && strips ? latLonOf(stripPoint(0, 300)) : null;
const startLat = found ? found.latDeg : onStrip ? onStrip[0] : num('lat', 0);
const startLon = found ? found.lonDeg : onStrip ? onStrip[1] : num('lon', 0);
// The hour is universal time; the default puts the start place into the morning (the sun stands over the longitude
// 180° − 15° × hour).
// On the strips, which may lie in a winter half of the sphere, the default is the local noon.
const startHour = num('hour', ((((onStrip ? 12 : 8.5) - startLon / 15) % 24) + 24) % 24);

// --- Engine ----------------------------------------------------------------------------------------------------------
// The camera takes up from the shape and keeps itself above the surface; its speed follows its height.
const rig = new FreeRig(
  { fovYDeg: FOV_DEG, maxPitchDeg: 90, minClearance: 2, minSpeed: 5, maxSpeed: 40_000 },
  { shape: SHAPE, heightAbove },
  { position: above(directionAt(startLat, startLon), num('alt', DEFAULT_FLIGHT.lowM)), yawDeg: num('yaw', 0), pitchDeg: num('pitch', DEFAULT_FLIGHT.lowPitchDeg) },
);
if (found && !q.has('yaw')) {
  rig.lookAt(above(found.toward, 0));
  rig.setState({ pitchDeg: num('pitch', DEFAULT_FLIGHT.lowPitchDeg) });
}
if (onStrip) {
  rig.setState({ position: above(stripPoint(0, 300), num('alt', 3)) });
  // Along the line, at its centre 60 m ahead.
  if (!q.has('yaw')) rig.lookAt(above(stripPoint(0, 360), 0));
  if (q.has('pitch')) rig.setState({ pitchDeg: num('pitch', 0) });
}

/** Times of a frame, smoothed: the main thread's part (streaming step and draw calls) and the time between frames. */
const meter = {
  cpuMs: 0,
  intervalMs: 0,
  /** Unsmoothed values of the last frame; the interval is 0 after a rest. */
  lastCpuMs: 0,
  lastIntervalMs: 0,
  /** Time since the frame before, whatever its length; 0 when there was none to count from. */
  lastGapMs: 0,
  startedAt: 0,
  previousAt: 0,
  open: false,
  begin(now: number): void {
    const gap = this.previousAt > 0 ? now - this.previousAt : 0;
    this.lastGapMs = gap;
    // A long gap is a rest of the loop, not a frame.
    this.lastIntervalMs = gap > 0 && gap < 250 ? gap : 0;
    if (this.lastIntervalMs > 0) this.intervalMs = this.intervalMs > 0 ? this.intervalMs + (this.lastIntervalMs - this.intervalMs) * 0.1 : this.lastIntervalMs;
    this.previousAt = now;
    this.startedAt = now;
    this.open = true;
  },
  end(now: number): void {
    if (!this.open) return;
    this.open = false;
    this.lastCpuMs = now - this.startedAt;
    this.cpuMs = this.cpuMs > 0 ? this.cpuMs + (this.lastCpuMs - this.cpuMs) * 0.1 : this.lastCpuMs;
  },
};

const engine = createEngine({
  canvas: document.querySelector<HTMLCanvasElement>('#view')!,
  view: rig,
  palette: definePalette({ sky: '#05070c' }),
  background: [0.02, 0.027, 0.047],
  // `radialUp`: up points away from the sphere's centre in every shader that asks for it.
  renderer: { shadowSoftnessM: 1.2, shadowDistanceM: 4000, shadowMapSize: 4096, depth, radialUp: SHAPE.radial },
  environment: { mode: 'day', site: { latitudeDeg: startLat, longitudeDeg: startLon, dayOfYear: DAY_OF_YEAR, utcOffsetHours: 0 }, hour: startHour, hoursPerSecond: 0.5, weather: {}, wind: { fromDeg: 240, speedMs: 6 }, clouds: { sizeM: 2400 } },
  // The default air of the engine fitted to this small sphere; the ground sphere is the `radialUp` one.
  ...(atmOn ? { atmosphere: { ...atmosphereFor(RADIUS_M, airHeightM), reference: q.get('atm') === 'ref' } } : {}),
  onFrame: () => meter.end(performance.now()),
});
const { renderer, env } = engine;
env.day.pause();
// With radial up the fog layer is given as heights above the base sphere.
env.fogLayer = { bottomY: 0, topY: 1500 };

// --- Streaming -------------------------------------------------------------------------------------------------------
const src = q.get('src') ?? (workersAvailable() ? 'workers' : 'main');
const onMain = src === 'main' || !workersAvailable();
const provider: CellProvider = stripOn
  ? onMain
    ? new GeneratorCellProvider(seed, generatePlanetStripCell)
    : new WorkerCellProvider(new URL('./strip-cell-worker.ts', import.meta.url), seed)
  : onMain
    ? new GeneratorCellProvider(seed, generatePlanetCell)
    : new WorkerCellProvider(new URL('./cell-worker.ts', import.meta.url), seed);
// No `face`: cells of all six faces are streamed. Every root is always wanted, so the far side stays covered. The
// headless check of the flight (flight-check.ts) runs on the same configuration.
const streaming = flightStreaming(Math.max(64, Math.round(num('cells', SELECTION.maxCells))));
const config: StreamingConfig = { ...streaming, screenError: { ...streaming.screenError!, maxErrorPx: Math.max(0.25, num('px', SELECTION.maxErrorPx)) } };
const [terrain, object] = [TERRAIN_MATERIAL, OBJECT_MATERIAL].map((m) => renderer.material(m)) as [Material, Material];
const world = new StreamedWorld({
  renderer,
  config,
  provider,
  // The render origin follows the camera on all three axes: numbers on the GPU stay small anywhere round the sphere.
  originAxes: 'all',
  morph: true,
  ...(horizonOn ? { horizon: { center: SHAPE.centerM, radiusM: HORIZON_RADIUS_M } } : {}),
  // Everything the page holds on the GPU stays under the budget: over the ceiling the least needed cells leave.
  ...(gpuCeilingMb > 0 ? { gpuCeilingBytes: gpuCeilingMb * MB } : {}),
  materials: stripOn ? { terrain, object, strip: renderer.material(STRIP_MATERIAL) } : { terrain, object },
  archetypes: {
    tree: { material: 'object', lods: [{ mesh: treeMesh(true), maxDistance: 260 }, { mesh: treeMesh(false), maxDistance: 2600 }] },
    rock: { material: 'object', lods: [{ mesh: rockMesh(true), maxDistance: 140 }, { mesh: rockMesh(false), maxDistance: 2600 }] },
  },
  uploadMsPerFrame: 3,
  blockingMsPerFrame: 6,
  onActivity: () => engine.invalidate(),
});
engine.add(world);
let showLevels = num('levels', 0) === 1;
const applyUniforms = (): void => void (world.uniforms = { u_showLevels: { float: showLevels ? 1 : 0 }, u_coverLevel: { float: OBJECT_LEVEL } });
applyUniforms();

// --- Flight ----------------------------------------------------------------------------------------------------------
/** A flight in progress: the plan, where it started and how the view stood there. */
interface Flight {
  plan: FlightPlan;
  /** Seconds since the start. */
  t: number;
  /** Direction of the start from the centre, and the height of the surface there. */
  dir: Vec3;
  groundM: number;
  yawDeg: number;
  pitchDeg: number;
  /** Time of the previous frame of the flight in ms, 0 before the first. */
  lastMs: number;
  /** True while a script sets the time (`__wh.setFlight`); the clock does not move it then. */
  held: boolean;
}
/** What a flight measured, frame by frame. */
interface FlightReport {
  finished: boolean;
  seconds: number;
  frames: number;
  cpuMsMean: number;
  cpuMsWorst: number;
  /** Time between frames. A stalled frame counts with its full length: the loop does not rest during a flight. */
  intervalMsMean: number;
  intervalMsWorst: number;
  /** Times between frames that went into the mean. */
  intervals: number;
  /**
   * The display's refresh interval as the flight saw it (the tenth percentile of the times between frames), and the
   * frames that took longer than one and a half of it: refreshes the page missed. The time between frames cannot fall
   * under the refresh interval, so it is compared with that and not with the budget.
   */
  refreshMs: number;
  framesMissed: number;
  /** Frames whose main-thread part alone was above the budget of a frame. */
  cpuOverBudget: number;
  gpuMbPeak: number;
  patchesPeak: number;
  cellsPeak: number;
  holesPeak: number;
  /** A frame at the landing with the graphics work finished, in ms (0 until measured). */
  landingFrameMs: number;
}
let flight: Flight | null = null;
let report: FlightReport | null = null;
/** Times between the frames of the flight, counted in steps of a quarter of a millisecond; the last holds all longer ones. */
const GAP_STEP_MS = 0.25;
const gapCounts = new Uint32Array(400);
let pendingFlight = q.get('fly') === '1';
/** Result of the last measurement with key B, in ms. */
let benchMs = 0;

function startFlight(held = false): Flight {
  const dir = SHAPE.directionOf(rig.position);
  const v = rig.state();
  // From where the camera is: a flight started in the air comes back to that height.
  const lowM = Math.min(Math.max(rig.clearance, 2.5), topM / 4);
  flight = {
    plan: { ...DEFAULT_FLIGHT, lowM, highM: topM, climbS },
    t: 0,
    dir,
    groundM: groundAt(dir[0] * RADIUS_M, dir[1] * RADIUS_M, dir[2] * RADIUS_M),
    yawDeg: v.yawDeg,
    pitchDeg: v.pitchDeg,
    lastMs: 0,
    held,
  };
  report = { finished: false, seconds: 0, frames: 0, cpuMsMean: 0, cpuMsWorst: 0, intervalMsMean: 0, intervalMsWorst: 0, intervals: 0, refreshMs: 0, framesMissed: 0, cpuOverBudget: 0, gpuMbPeak: 0, patchesPeak: 0, cellsPeak: 0, holesPeak: 0, landingFrameMs: 0 };
  gapCounts.fill(0);
  engine.invalidate();
  return flight;
}

/** Puts the camera where the flight is at its time `t`. */
function applyFlight(f: Flight, t: number): void {
  const pose = flightPose(f.plan, RADIUS_M, t);
  const r = RADIUS_M + f.groundM + pose.heightM;
  // The view leaves the pitch it had at the start over the first fifth of the way and returns to it at the end.
  const s = Math.min(1, pose.progress / 0.2);
  const k = s * s * (3 - 2 * s);
  rig.setState({ position: [f.dir[0] * r, f.dir[1] * r, f.dir[2] * r], yawDeg: f.yawDeg + pose.turnDeg, pitchDeg: f.pitchDeg + (pose.pitchDeg - f.pitchDeg) * k });
  // For the speed shown. The ticket ahead that `viewerTickets` makes of it changes nothing on a way straight up or
  // down: it stands over the same point at the same height as the camera's own, one level behind it.
  rig.velocity =[f.dir[0] * pose.climbMs, f.dir[1] * pose.climbMs, f.dir[2] * pose.climbMs];
}

function stopFlight(landed: boolean): void {
  if (!flight) return;
  flight = null;
  rig.velocity = [0, 0, 0];
  if (report) report.finished = landed;
  engine.invalidate();
}

/** Adds the frame that has just been timed to the flight's report. */
function recordFrame(r: FlightReport, f: Flight): void {
  const s = world.stats();
  r.seconds = f.t;
  r.frames++;
  r.cpuMsMean += (meter.lastCpuMs - r.cpuMsMean) / r.frames;
  r.cpuMsWorst = Math.max(r.cpuMsWorst, meter.lastCpuMs);
  if (meter.lastCpuMs > BUDGET.frameMs) r.cpuOverBudget++;
  // A pose held by a script is rendered when the script asks, not by the clock: its gaps are no frame times.
  const gap = f.held ? 0 : meter.lastGapMs;
  if (gap > 0) {
    r.intervals++;
    r.intervalMsMean += (gap - r.intervalMsMean) / r.intervals;
    r.intervalMsWorst = Math.max(r.intervalMsWorst, gap);
    gapCounts[Math.min(gapCounts.length - 1, Math.floor(gap / GAP_STEP_MS))]!++;
    // The refresh interval: the tenth percentile of the gaps. Missed: every gap above one and a half of it.
    let seen = 0;
    let i = 0;
    while (i < gapCounts.length - 1 && (seen += gapCounts[i]!) * 10 < r.intervals) i++;
    r.refreshMs = (i + 0.5) * GAP_STEP_MS;
    r.framesMissed = 0;
    for (let k = Math.ceil((1.5 * r.refreshMs) / GAP_STEP_MS); k < gapCounts.length; k++) r.framesMissed += gapCounts[k]!;
  }
  r.gpuMbPeak = Math.max(r.gpuMbPeak, engine.device.memory().total / MB);
  r.patchesPeak = Math.max(r.patchesPeak, s.cellsVisible);
  r.cellsPeak = Math.max(r.cellsPeak, s.drawn);
  r.holesPeak = Math.max(r.holesPeak, s.holes);
}

// --- Camera → streaming ----------------------------------------------------------------------------------------------
const input = bindFreeInput(engine.canvas, rig, { onChange: () => engine.invalidate() });
let scripted = false;
/** True while `measureFrame` renders: its frames stay out of the frame times. */
let measuring = false;
/** Pixels one radian covers, never less than what splits a cell at `MIN_SPLIT_EDGES` edges (the blend needs the room). */
function ticketPixels(): number {
  const se = config.screenError!;
  return Math.max(pixelsPerRadian(engine.canvas.clientHeight || engine.canvas.height, FOV_DEG * DEG), (MIN_SPLIT_EDGES * se.maxErrorPx) / se.errorPerEdge);
}
// Before the streaming step: move, then hand the camera to the world. The rig's position is in world metres and its
// `origin` follows the render origin.
renderer.beforeFrame.unshift(() => {
  const now = performance.now();
  // The frame before this one is complete now: its times belong to the flight's report.
  if (!measuring) {
    meter.begin(now);
    if (flight && report && flight.lastMs > 0) recordFrame(report, flight);
  }
  if (pendingFlight && world.settled && !world.busy) {
    pendingFlight = false;
    startFlight();
  }
  if (flight) {
    const f = flight;
    // Real time, but never more than a tenth of a second per frame: a stalled frame does not make the camera jump.
    if (!f.held && f.lastMs > 0) f.t += Math.min(0.1, (now - f.lastMs) / 1000);
    f.lastMs = now;
    applyFlight(f, f.t);
    if (!f.held && f.t >= flightDuration(f.plan)) stopFlight(true);
    else engine.invalidate();
  } else if (!scripted) input.step();
  const p = rig.position;
  const eye: [number, number, number] = [p[0], p[1], p[2]];
  // The sun stands where the hour puts it over the turning sphere, and what follows its height (light colours,
  // exposure, the direction shadows are cast in) is computed for the place under the camera.
  env.observer = { up: SHAPE.directionOf(eye), sunDir: sphereSunDirection(DAY_OF_YEAR, env.day.time) };
  world.setFocus(eye);
  rig.origin = [world.origin[0], world.origin[1], world.origin[2]];
  world.setEye(eye);
  world.setTickets(viewerTickets({ eye, altitude: rig.clearance, forward: rig.axes().forward, velocity: rig.velocity, pixelsPerRadian: ticketPixels() }));
});

/** Jumps to `alt` metres above the surface under the camera, looking `pitchDeg` below the horizon. */
function jump(alt: number, pitchDeg: number): void {
  stopFlight(false);
  rig.setState({ position: above(SHAPE.directionOf(rig.position), alt), pitchDeg });
}

/** Average time of a frame of the current view in ms, with the graphics work finished (blocks for the measurement). */
function measureFrame(frames = 30): number {
  measuring = true;
  const ms = renderer.benchmark(rig, frames);
  measuring = false;
  // The frames of the measurement are not frames of the loop.
  meter.previousAt = 0;
  return ms;
}

/** The air's params, or null without the atmosphere. */
const air = engine.atmosphere ? engine.atmosphere.slot.params : null;
/** The air from its tables (false) or with every pixel integrating its own view ray (true), for comparing the two. */
function setAirReference(on: boolean): void {
  if (air) air.reference = on;
}

// --- Keys, panel, URL ------------------------------------------------------------------------------------------------
const hud = document.querySelector<HTMLDivElement>('#hud')!;
const panel = document.querySelector<HTMLPreElement>('#panel')!;
const KEYS: Record<string, () => void> = {
  KeyF: () => (flight ? stopFlight(false) : startFlight()),
  Escape: () => stopFlight(false),
  Digit1: () => jump(topM, 90),
  Digit2: () => jump(DEFAULT_FLIGHT.lowM, DEFAULT_FLIGHT.lowPitchDeg),
  BracketLeft: () => env.day.set((env.day.time + 23.5) % 24),
  BracketRight: () => env.day.set((env.day.time + 0.5) % 24),
  KeyL: () => ((showLevels = !showLevels), applyUniforms()),
  KeyB: () => void (benchMs = measureFrame()),
  KeyR: () => setAirReference(!air?.reference),
  KeyH: () => panel.classList.toggle('hidden'),
};
window.addEventListener('keydown', (e) => {
  const k = KEYS[e.code];
  if (k && !e.repeat) (k(), engine.invalidate());
});
// A hidden page gets no frames: the time it was hidden is not the time of a frame.
document.addEventListener('visibilitychange', () => (meter.previousAt = 0));

const fmt = (v: number, d = 0): string => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const metres = (m: number): string => (Math.abs(m) < 1000 ? `${fmt(m, 1)} m` : `${fmt(m / 1000, Math.abs(m) < 100_000 ? 2 : 1)} km`);
const mb = (b: number): string => `${fmt(b / MB)} MB`;

/** The one line that is always shown: height, speed, patches, time of a frame, GPU memory. */
function hudText(): string {
  const s = world.stats();
  const speed = Math.hypot(rig.velocity[0], rig.velocity[1], rig.velocity[2]);
  const frame = meter.intervalMs > 0 ? `${meter.intervalMs.toFixed(1)} ms (cpu ${meter.cpuMs.toFixed(1)})` : `cpu ${meter.cpuMs.toFixed(1)} ms`;
  return [
    `height ${metres(rig.clearance)}`,
    `speed ${metres(speed)}/s`,
    `patches ${s.cellsVisible} of ${s.drawn}`,
    `frame ${frame}${benchMs > 0 ? `, measured ${benchMs.toFixed(1)} ms` : ''}`,
    `GPU ${mb(engine.device.memory().total)}`,
  ].join('  ·  ');
}

function reportText(r: FlightReport): string {
  const ok = (good: boolean): string => (good ? 'ok' : 'OVER');
  return [
    `flight ${r.finished ? 'finished' : flight ? 'running' : 'stopped'}  ${fmt(r.seconds, 1)} s  ${r.frames} frames`,
    `  frame  ${r.intervalMsMean.toFixed(1)} ms mean, ${r.intervalMsWorst.toFixed(1)} worst between frames; display ${r.refreshMs.toFixed(1)} ms, ${r.framesMissed} frames missed a refresh   cpu ${r.cpuMsMean.toFixed(1)} mean, ${r.cpuMsWorst.toFixed(1)} worst (${r.cpuOverBudget} over ${BUDGET.frameMs} ms)`,
    `  GPU    peak ${fmt(r.gpuMbPeak)} MB of ${BUDGET.gpuMb} MB ${ok(r.gpuMbPeak < BUDGET.gpuMb)}   patches peak ${r.patchesPeak} in view, ${r.cellsPeak} in the cover   holes ${r.holesPeak}`,
    ...(r.landingFrameMs > 0 ? [`  frame at the landing, graphics work finished: ${r.landingFrameMs.toFixed(1)} ms ${ok(r.landingFrameMs < BUDGET.frameMs)}`] : []),
  ].join('\n');
}

function panelText(): string {
  const s = world.stats();
  const r = renderer.lastStats;
  const m = engine.device.memory();
  const [lat, lon] = latLonOf(SHAPE.directionOf(rig.position));
  const st = s.states;
  return [
    `planet  radius ${fmt(RADIUS_M / 1000)} km  seed ${seed}  air ${atmOn ? `${fmt(airHeightM / 1000)} km${air?.reference ? ' (reference)' : ''}` : 'off'}  depth ${renderer.depthMode}  hour ${env.day.time.toFixed(2)} UT`,
    `place   lat ${fmt(lat, 3)}°  lon ${fmt(lon, 3)}°  origin ${fmt(world.origin[0])}, ${fmt(world.origin[1])}, ${fmt(world.origin[2])}`,
    `cells   MESHED ${st.MESHED}  RESIDENT ${st.RESIDENT}  drawn ${s.drawn}/${s.wanted} wanted  holes ${s.holes}  visible ${s.cellsVisible}  behind the horizon ${horizonOn ? s.horizonCulled : 'off'}`,
    `work    in flight ${s.inFlight}  queued ${s.queued}  done ${s.completed}  failed ${s.failed}  evicted ${s.evicted}   ${provider.name}`,
    `memory  cpu ${mb(s.cpuBytes)}  gpu cells ${mb(s.gpuBytes)}  buffers ${mb(m.buffers)}  textures ${mb(m.textures)}  targets ${mb(m.targets)}   detail ${fmt(s.detail * 100)} %   ${s.settled ? 'settled' : 'streaming…'}`,
    `draw    ${r.drawCalls} draws  ${fmt(r.triangles)} tris  shadow ${r.shadowDrawCalls} draws  ${engine.loop.fps ? `${engine.loop.fps.toFixed(0)} fps` : 'idle'}`,
    ...(strips ? [`strips  main ${metres(stripEnd(0))} across a cube edge, at the node it branches into ${metres(stripEnd(1))} and ${metres(stripEnd(2))}, width ${STRIP_HALF_WIDTHS.map((w) => fmt(2 * w)).join(' / ')} m   (strip=0 turns them off)`] : []),
    ...(report ? [reportText(report)] : []),
    `F flight · WASD fly · E/Q up/down · Shift fast · drag look · wheel speed · 1 top · 2 surface · [ ] hour · L levels · B measure · R reference air · H hide`,
  ].join('\n');
}

/** The URL hash of the current view. */
function viewHash(): string {
  const [lat, lon] = latLonOf(SHAPE.directionOf(rig.position));
  const v = rig.state();
  const keep = ['flyS', 'top', 'air', 'px', 'cells', 'gpu'].filter((k) => q.has(k)).map((k) => `&${k}=${q.get(k)}`).join('');
  return `seed=${seed}&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&alt=${rig.clearance.toFixed(1)}&yaw=${v.yawDeg.toFixed(1)}&pitch=${v.pitchDeg.toFixed(1)}&hour=${env.day.time.toFixed(2)}${src !== 'workers' ? `&src=${src}` : ''}${showLevels ? '&levels=1' : ''}${q.has('depth') ? `&depth=${depth}` : ''}${horizonOn ? '' : '&horizon=0'}${atmOn ? (air?.reference ? '&atm=ref' : '') : '&atm=0'}${stripOn ? '' : '&strip=0'}${keep}`;
}

let lastHash = '';
setInterval(() => {
  hud.textContent = hudText();
  if (!panel.classList.contains('hidden')) panel.textContent = panelText();
  // Once after a finished flight, when the view has loaded again: a frame with the graphics work finished.
  if (report && report.finished && report.landingFrameMs === 0 && !flight && !scripted && world.settled && !world.busy) report.landingFrameMs = measureFrame();
  if (flight || scripted) return;
  const h = viewHash();
  if (h !== lastHash) {
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
  /** Direction from the centre of a point to look at (lifted onto the surface); `pitchDeg` then overrides its pitch. */
  toward?: readonly [number, number, number];
}
/** The views along the strips: from orbit, over the edge of the cube, along the main line, at its node. */
function stripPresets(): ViewSpec[] {
  if (!strips) return [];
  // The local noon of each place: the line may lie in a winter half of the sphere.
  const at = (line: number, m: number): { lat: number; lon: number; hour: number } => {
    const [lat, lon] = latLonOf(stripPoint(line, m));
    return { lat, lon, hour: (((12 - lon / 15) % 24) + 24) % 24 };
  };
  // The main line crosses the edge of the cube in its middle (strips.ts).
  const edge = stripEnd(0) / 2;
  const end = stripEnd(0);
  return [
    { name: 'strip-orbit', ...at(0, 0.6 * end), height: topM, pitchDeg: 90 },
    { name: 'strip-edge-20km', ...at(0, edge), height: 20_000, toward: stripPoint(0, edge + 2000), pitchDeg: 90 },
    { name: 'strip-edge-levels', ...at(0, edge - 3500), height: 3000, toward: stripPoint(0, edge + 600), levels: true },
    { name: 'strip-900m', ...at(0, 9000), height: 900, toward: stripPoint(0, 10_300) },
    // Looking back along the line, with the sun of the local noon behind the camera.
    { name: 'strip-surface', ...at(0, 30_000), height: 3, toward: stripPoint(0, 29_900), pitchDeg: 8 },
    { name: 'strip-node', ...at(0, end - 40), height: 150, toward: stripPoint(0, end + 1), pitchDeg: 80 },
  ];
}
/** Puts the camera where a view says. */
function applyView(v: ViewSpec): void {
  const [lat, lon] = latLonOf(SHAPE.directionOf(rig.position));
  rig.setState({ position: above(directionAt(v.lat ?? lat, v.lon ?? lon), v.height ?? rig.clearance), ...(v.yawDeg !== undefined ? { yawDeg: v.yawDeg } : {}), ...(v.pitchDeg !== undefined && !v.toward ? { pitchDeg: v.pitchDeg } : {}) });
  if (v.toward) {
    rig.lookAt(above(v.toward, 0));
    if (v.pitchDeg !== undefined) rig.setState({ pitchDeg: v.pitchDeg });
  }
  if (v.hour !== undefined) (env.day.pause(), env.day.set(v.hour));
  showLevels = v.levels ?? false;
  applyUniforms();
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
    { name: 'planet-surface', lat: startLat, lon: startLon, height: DEFAULT_FLIGHT.lowM, pitchDeg: DEFAULT_FLIGHT.lowPitchDeg },
    { name: 'planet-low', lat: startLat, lon: startLon, height: 900, pitchDeg: 12 },
    { name: 'planet-limb', lat: startLat, lon: startLon, height: 20_000, pitchDeg: 28 },
    { name: 'planet-whole', lat: startLat, lon: startLon, height: topM, pitchDeg: 90 },
    ...stripPresets(),
  ],
  setView: (v: ViewSpec): void => {
    scripted = true;
    stopFlight(false);
    applyView(v);
    panel.classList.toggle('hidden', !v.overlay);
    engine.renderNow();
  },
  getView: () => ({ ...rig.state(), height: rig.clearance }),
  /** The URL hash of the current view (what the page writes to the address bar). */
  hash: viewHash,
  settled: async (): Promise<boolean> => {
    const ok = await settle();
    hud.textContent = hudText();
    panel.textContent = panelText();
    return ok;
  },
  isSettled: (): boolean => world.settled && !world.busy,
  setTimeOfDay: (h: number) => (env.day.pause(), env.day.set(h), engine.renderNow()),
  setTime: (s: number) => (env.time.pause(), env.time.set(s), engine.renderNow()),
  setTick: (): void => {},
  stats: () => ({ ...renderer.lastStats, renderer: engine.device.name, seed, streaming: world.stats(), provider: provider.name, memory: engine.device.memory(), frame: { cpuMs: meter.cpuMs, intervalMs: meter.intervalMs } }),
  overlay: panelText,
  hud: hudText,
  /** The flight: seconds from start to landing, start and stop by the clock, or a pose at a time set by the script. */
  flightSeconds: (): number => flightDuration({ ...DEFAULT_FLIGHT, highM: topM, climbS }),
  startFlight: (): void => void startFlight(),
  stopFlight: (): void => stopFlight(false),
  setFlight: (t: number): void => {
    scripted = true;
    // A flight in progress keeps its plan and its start (the clock stops); without one the flight starts where the
    // camera stands.
    const f = flight ?? startFlight(true);
    f.held = true;
    f.t = Math.max(0, t);
    engine.renderNow();
  },
  flightReport: (): FlightReport | null => (report ? { ...report } : null),
  measureFrame,
  /** The air in the reference quality (true) or from its tables (false). */
  setAirReference: (on: boolean): void => (setAirReference(on), engine.renderNow()),
};
// `view=<name>`: start in a view of the presets.
const startView = stripPresets().find((v) => v.name === q.get('view'));
if (startView) applyView(startView);
engine.start();
