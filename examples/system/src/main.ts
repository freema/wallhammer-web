// System example of Wallhammer Web: a sun and four bodies on their paths, and one flight with the free camera from
// the view of the whole system down to a few metres above the surface of any of them, without a loading screen.
// It puts the engine's large-scale options together, with content of its own:
//   - `BodySystem` of core: the paths and the turning of the bodies from the time alone, and a frame per body,
//   - the frames: the camera's position is kept in the frame of the body it is at (the turning one near the surface,
//     the carried one farther out, the sun's between the bodies), and goes over from one to the next without a jump,
//   - one generator for every body (world.ts), streamed round the camera for the body it is at (`StreamedWorld`),
//     and drawn from its six coarsest cells for every other one (far.ts),
//   - the atmosphere of the engine round the body the camera is at, a shell of air per body from afar (shaders.ts),
//   - a render origin that follows the camera, and a depth mode that holds a metre and the whole system in one view,
//   - flights whose path is a function of their time and of where the bodies are (digits, F).
//
// URL hash: #seed=725&body=Hearth&lat=..&lon=..&alt=3&yaw=..&pitch=3&t=..&rate=1
//   body, lat, lon, alt, yaw, pitch: a start at a body (degrees on it, metres above its surface; pitch: positive looks
//   down). Without `body` the page starts at the view of the whole system.
//   t: time of the system in seconds; rate: how many times faster than real it runs (0, 1, 10, 100, 1000).
//   fly=1 starts the first flight of the tour as soon as the bodies are there; tour=1 goes on from stop to stop.
//   pace: multiplier of the time a flight takes (default 1). orbits=0 hides the paths, names=0 the names.
//   depth: reversed (default) or logarithmic. src: workers (default) or main. px and cells set the tolerance in pixels
//   and the budget of cells; gpu the ceiling of GPU memory in MB (default 560, 0 = none). levels=1 tints the cells.
//   world: stage of the plan of Hearth (inhabited.ts), 0 for none (the page as before it), default the highest built;
//   from 1 the cells of Hearth come from the plan (lakes, rivers cut into the ground, a strip of water on them).
//   map=1 draws the plan's rivers and lakes over Hearth. From 5 the relief casts its shade and the settlements light
//   up at night (lights.ts); J then shows the shade alone.
//   life=0 leaves out the creatures that walk the lanes and roads from stage 3 (life.ts, life-layer.ts).
// Controls: 1–4 fly to a body, 0 to the view of the whole system, F to the next stop of the tour, Escape stops a
// flight. W A S D fly along the view, E / Q up and down, Shift faster, drag looks around, the wheel changes the speed.
// , and . slow the time down and speed it up, P pauses it. O paths, N names, L cell levels, B measures a frame with
// the graphics work finished, H hides the panel, M shows the marks of the plan, R flies along the main river.

import { definePalette } from 'wallhammer-web';
import { quatAxisTurns, quatRotate, relativeMatrix, snapRenderOrigin } from 'wallhammer-web/base';
import type { DepthMode, Vec3 } from 'wallhammer-web/base';
import { FreeRig } from 'wallhammer-web/camera';
import type { UpSource } from 'wallhammer-web/camera';
import { BodySystem, orbitPosition } from 'wallhammer-web/core';
import type { Body } from 'wallhammer-web/core';
import { DEFAULT_WEATHER, atmosphereFor, cloudFieldSlot } from 'wallhammer-web/env';
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import { WorkerPool, bindFreeInput, workersAvailable } from 'wallhammer-web/platform';
import type { Material, SceneBounds } from 'wallhammer-web/render';
import { CloudShellLayer, StreamedWorld, createEngine, viewerTickets } from 'wallhammer-web/runtime';
import type { StreamArchetype } from 'wallhammer-web/runtime';
import { DEFAULT_STREAMING, GeneratorCellProvider, decodeCell, pixelsPerRadian } from 'wallhammer-web/world';
import type { CellProvider, CellResult, SphereWorld, StreamingConfig } from 'wallhammer-web/world';
import { CLOCK_HZ, SUN, SURFACES, bodyDefs } from './bodies.ts';
import type { SurfaceSpec } from './bodies.ts';
import { FarLayer, ShellLayer } from './far.ts';
import { anchor, between, finishLeg, flightPoint, flightSeconds, landingDirection, landingView, matchedSeconds, skyOf } from './flight.ts';
import type { Leg, MovingPoint, OpenLeg, SurfaceLeg } from './flight.ts';
import type { FarBody, FarPath, FarScene } from './far.ts';
import { detailViews } from './details-page.ts';
import { lifeLine, lifeViews } from './life-layer.ts';
import { createInhabited, daylightTime, planMarks, planStatus, planViews, plannedBody, riverPose, siteViews, sitesLine, structureViews, waterViews, worldLine } from './inhabited.ts';
import { siteFrame, sitePoint } from './settlement.ts';
import { SettlementLayer } from './settlement-layer.ts';
import { STRUCTURE_ROWS } from './structures.ts';
import { windowLightSlot } from 'wallhammer-web/gen-arch';
import { snowSlot } from 'wallhammer-web/gen-ground';
import type { Inhabited, PlannedBody } from './inhabited.ts';
import { PLAN_BODY, STAGE, STAGE_MAX } from './plan.ts';
import type { WorldPlan } from './plan.ts';
import { createLoader } from './loader.ts';
import { CLIMATE_OBJECT_MATERIAL, CLIMATE_TERRAIN_MATERIAL, OBJECT_MATERIAL, PLANNED_TERRAIN_MATERIAL, TERRAIN_MATERIAL, WATER_MATERIAL, WAY_MATERIAL } from './shaders.ts';
import { SHADE_OBJECT_MATERIAL, SHADE_TERRAIN_MATERIAL, SHADE_WATER_MATERIAL, SHADE_WAY_MATERIAL } from './shaders.ts';
import { LightsLayer, shadeViews } from './lights.ts';
import { broadleafMesh, flatCrownMesh, rockMesh, shardMesh, shrubMesh, treeMesh } from './shapes.ts';
import { NO_CLOUD_FIELD, climateViews, hearthCloudField, placeAt as climatePlaceAt, weatherAt } from './weather.ts';
import { UP_Y, ZERO, blend, cross3, dot3, len, mul, reject, slerp, smooth, sub, unit } from './vec.ts';
import type { V3 } from './vec.ts';
import { routeViews, routesLine } from './inhabited.ts';
import { routeStats } from './plan-routes.ts';
import type { RouteStats } from './plan-routes.ts';
import { DEFAULT_SEED, MIN_SPLIT_EDGES, ROOT_LEVEL, SELECTION, bodyShape, directionAt, findSite, generateBodyCell, horizonRadiusM, latLonOf, objectLevel, packSeed, surfaceHeight } from './world.ts';

const q = new URLSearchParams(location.hash.slice(1));
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const seed = Math.round(num('seed', DEFAULT_SEED));
/** Stage of the plan of Hearth; 0: no plan at all. */
const stage = Math.min(STAGE_MAX, Math.max(0, Math.round(num('world', STAGE_MAX))));
/** Details near the camera on Hearth (from stage 2, details.ts); `details=0` leaves them out. */
const showDetails = num('details', 1) !== 0;
/** Creatures near the camera on Hearth (from stage 3, life.ts); `life=0` leaves them out. */
const showLife = num('life', 1) !== 0;
/** The planned body on the page (stage ≥ 1), set once the plan is started; null at `world=0`. */
let plannedB: PlannedBody | null = null;
/** Height of what is seen on a body at a point of its base sphere: from the plan where there is one (rivers too). */
function surfaceOf(s: { index: number; packed: number }, x: number, y: number, z: number): number {
  const h = plannedB && s.index === PLAN_BODY ? plannedB.surfaceAt(x, y, z) : null;
  return h ?? surfaceHeight(s.packed, x, y, z);
}
const DEG = Math.PI / 180;
const FOV_DEG = 50;
/** The budget the example is built for: milliseconds of a frame and megabytes of GPU memory. */
const BUDGET = { frameMs: 8, gpuMb: 600 } as const;
const MB = 1048576;
const depth: DepthMode = q.get('depth') === 'logarithmic' ? 'logarithmic' : 'reversed';
const gpuCeilingMb = Math.max(0, num('gpu', 560));
/** Multiplier of the time a flight takes. */
const pace = Math.min(8, Math.max(0.25, num('pace', 1)));
/** How many times faster than real the system can run. */
const RATES = [0, 1, 10, 100, 1000] as const;
/** Height above the surface a flight ends at, in metres. */
const LAND_M = 3;
/** The view of the whole system: a point of the sun's frame, above the plane of the paths. */
const OVERVIEW: V3 = [0, 75_000_000, 115_000_000];
/** Distances from the centre of a body, in its radii: where its surface starts and stops to be streamed. */
const NEAR_IN = 6;
const NEAR_OUT = 6.6;
/** Where the engine's atmosphere takes the picture over from the shell of air: fully below, not at all above. */
const AIR_FULL = 4.2;
const AIR_NONE = 5.7;
/** Within these distances the camera is taken along with the turning of the body: fully below, not at all above. */
const DRAG_FULL = 7;
const DRAG_NONE = 10;
/** Smallest angle a body and the sun are drawn at, in radians (about three and four pixels). */
const MIN_BODY_RAD = 0.0026;
const MIN_SUN_RAD = 0.0034;

// --- The system ------------------------------------------------------------------------------------------------------
const system = new BodySystem(bodyDefs());
const frames = system.frames;
const sunBody = system.bodies[0]!;

/** A body with a surface: what the page keeps about it. Its index in the system is `index + 1` (the sun is 0). */
interface Surface {
  index: number;
  spec: SurfaceSpec;
  body: Body;
  /** Seed of its generator (`packSeed`). */
  packed: number;
  shape: SphereWorld;
  companion: Body | null;
  /** Its six coarsest cells, once generated: drawn from afar, and handed to the streaming without a second run. */
  roots: (CellContent | null)[];
  far: FarBody;
  provider: CellProvider;
  config: StreamingConfig;
}

/** Time of the system as a whole number of ticks of its clock. */
let tick = Math.round(Math.max(0, num('t', 0)) * CLOCK_HZ);
let rate: number = RATES.includes(num('rate', 1) as (typeof RATES)[number]) ? num('rate', 1) : 1;
system.setTick(tick, CLOCK_HZ);

/** Index in the system of the body the camera is kept by (0: the sun). Changes with a margin, see `updateFrames`. */
let attached = 0;
/** True while the camera is near enough to that body for its surface to be streamed. */
let near = false;
/** The frame the camera's position is in and the picture is drawn in. Its origin is the centre of the attached body. */
let drawFrame = sunBody.carriedFrame;
/** Per body of the system, in the frame of the picture: its centre and its axis; and the up of the whole system. */
const centers: Vec3[] = system.bodies.map(() => [0, 0, 0]);
const axes: Vec3[] = system.bodies.map(() => [0, 1, 0]);
const systemUp: Vec3 = [0, 1, 0];

/** Reads the places of the bodies in the frame of the picture. After the time or the frame has changed. */
function refresh(): void {
  for (const b of system.bodies) {
    frames.convertPoint(ZERO, b.carriedFrame, drawFrame, centers[b.index]!);
    frames.convertDirection(UP_Y, b.turningFrame, drawFrame, axes[b.index]!);
  }
  frames.convertDirection(UP_Y, system.root, drawFrame, systemUp);
}
refresh();

/**
 * Where up is at a point of the picture's frame, as the body `index` has it: away from its centre near the surface,
 * along its axis farther out, and what its parent says at the border of its reach. A function of the place alone, so
 * it does not jump where the camera goes over from one body to another.
 */
function upOf(index: number, p: V3): Vec3 {
  if (index <= 0) return [systemUp[0], systemUp[1], systemUp[2]];
  const b = system.bodies[index]!;
  const r = sub(p, centers[index]!);
  const d = len(r);
  const R = b.radius;
  const radial = unit(r, axes[index]!);
  if (d <= 2 * R) return radial;
  const from = Math.max(7 * R, 0.4 * b.influence);
  const to = Math.max(1.3 * from, 0.85 * b.influence);
  const outer = smooth((d - from) / (to - from));
  const far = outer > 0 ? blend(axes[index]!, upOf(b.parent, p), outer) : axes[index]!;
  return blend(radial, far, smooth((d - 2 * R) / (3 * R)));
}
const upSource: UpSource = { upAt: (p) => upOf(attached, p) };

const src = q.get('src') ?? (workersAvailable() ? 'workers' : 'main');
const onMain = src === 'main' || !workersAvailable();
const pool = onMain ? null : new WorkerPool(new URL('./cell-worker.ts', import.meta.url));
const providerName = pool ? `generator (${pool.size} workers, one pool for every body)` : 'generator (main thread)';

/** Cells of one body from the shared pool of workers. The coarsest ones are answered from memory once they are there. */
function pooledProvider(s: Pick<Surface, 'packed' | 'roots'>, workers: WorkerPool): CellProvider {
  return {
    name: providerName,
    blocking: false,
    async request(cell: CellId, signal: AbortSignal): Promise<CellResult> {
      const root = cell.level === ROOT_LEVEL ? s.roots[cell.face] : null;
      if (root) return { content: root, bytes: null, origin: 'memory' };
      const job = workers.run<ArrayBuffer>({ seed: s.packed, cell: { face: cell.face, level: cell.level, x: cell.x, y: cell.y } });
      const onAbort = (): void => job.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        return { content: decodeCell(new Uint8Array(await job.promise)), bytes: null, origin: 'generated' };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

const maxCells = Math.max(64, Math.round(num('cells', SELECTION.maxCells)));
const maxErrorPx = Math.max(0.25, num('px', SELECTION.maxErrorPx));
const surfaces: Surface[] = SURFACES.map((spec, index) => {
  const packed = packSeed(seed, index);
  const shape = bodyShape(index);
  const roots: (CellContent | null)[] = [null, null, null, null, null, null];
  const far: FarBody = { radiusM: spec.radiusM, topM: spec.radiusM + spec.airM, airColor: spec.tint, cells: [], center: [0, 0, 0], model: new Float32Array(16), toSun: [0, 1, 0], size: 1, solid: false, shell: 0 };
  // No `face`: cells of all six faces are streamed, and every root is always wanted, so the far side stays covered.
  const config: StreamingConfig = { ...DEFAULT_STREAMING, shape, rootLevel: ROOT_LEVEL, leafLevel: spec.leafLevel, rootRange: Infinity, prefetch: 0.2, hysteresis: 0.3, maxInFlight: 12, memoryBudgetBytes: 320 * MB, screenError: { ...SELECTION, maxCells, maxErrorPx } };
  return {
    index,
    spec,
    body: system.bodies[index + 1]!,
    packed,
    shape,
    companion: spec.companion ? system.body(spec.companion) : null,
    roots,
    far,
    provider: pool ? pooledProvider({ packed, roots }, pool) : new GeneratorCellProvider(packed, generateBodyCell),
    config,
  };
});
/** The body with a surface the camera is kept by, or null between the bodies. */
const attachedSurface = (): Surface | null => (attached > 0 ? surfaces[attached - 1]! : null);
/** The body whose surface is streamed, or null. */
const home = (): Surface | null => (near ? attachedSurface() : null);

/** Height of a point of the picture's frame above what is under it: the surface near a body, a little above its base sphere from afar. */
const heightAbove = (p: V3): number => {
  const h = home();
  if (h) {
    const b = h.shape.noiseDomain(p);
    return h.shape.altitude(p) - surfaceOf(h, b[0], b[1], b[2]);
  }
  let least = Infinity;
  for (const b of system.bodies) least = Math.min(least, len(sub(p, centers[b.index]!)) - b.radius * (b.index === 0 ? 1 : 1.08));
  return least;
};

/** A point `alt` metres above the surface of a body in a direction from its centre, in its turning frame. */
function above(s: Surface, d: V3, alt: number): Vec3 {
  const R = s.spec.radiusM;
  return mul(d, R + surfaceOf(s, d[0] * R, d[1] * R, d[2] * R) + alt);
}

// --- Engine ----------------------------------------------------------------------------------------------------------
// The camera takes up from the bodies and keeps itself above them; its speed follows its height, up to a speed that
// crosses the system in seconds.
const rig = new FreeRig({ fovYDeg: FOV_DEG, maxPitchDeg: 90, minClearance: 2, minSpeed: 5, maxSpeed: 40_000_000 }, { shape: upSource, heightAbove });

/** Turns the view to a heading (a direction, its part along the horizon counts) and a pitch. */
function setHeading(dir: V3, pitch: number): void {
  const p = rig.position;
  // Far enough ahead that the sum keeps the direction, whatever the size of the position.
  const k = Math.max(1000, len(p) * 1e-3);
  rig.lookAt([p[0] + dir[0] * k, p[1] + dir[1] * k, p[2] + dir[2] * k]);
  rig.pitch = pitch;
}

/** The sphere up points away from in the shaders: the attached body, whose centre is the origin of the picture's frame. */
const upSphere: { center: [number, number, number]; radiusM: number } = { center: [0, 0, 0], radiusM: SUN.radiusM };
const firstAir = SURFACES.find((s) => s.airM > 0) ?? SURFACES[0]!;

/** Times of a frame, smoothed: the main thread's part (streaming step and draw calls) and the time between frames. */
const meter = {
  cpuMs: 0,
  intervalMs: 0,
  /** Unsmoothed values of the last frame; the interval is 0 after a rest. */
  lastCpuMs: 0,
  lastIntervalMs: 0,
  startedAt: 0,
  previousAt: 0,
  open: false,
  begin(now: number): void {
    const gap = this.previousAt > 0 ? now - this.previousAt : 0;
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

/**
 * The real time between two callbacks of requestAnimationFrame, smoothed. Its own loop, apart from the engine's (which
 * rests while nothing changes and whose meter skips gaps over 250 ms as rests), so that a stall of the main thread
 * shows in the HUD however long it is. A hidden page starts over.
 */
const rafGap = { ms: 0, last: 0 };
const rafTick = (now: number): void => {
  if (rafGap.last > 0) {
    const gap = now - rafGap.last;
    rafGap.ms = rafGap.ms > 0 ? rafGap.ms + (gap - rafGap.ms) * 0.2 : gap;
  }
  rafGap.last = now;
  requestAnimationFrame(rafTick);
};
requestAnimationFrame(rafTick);
document.addEventListener('visibilitychange', () => {
  rafGap.last = 0;
  rafGap.ms = 0;
});

/** From stage 2: Hearth's cloud cover by place (weather.ts), and whether the clouds are shown (`clouds=0`, key C). */
const cloudSlot = stage >= STAGE.climate ? cloudFieldSlot({ ...NO_CLOUD_FIELD }) : null;
let showClouds = q.get('clouds') !== '0';
/** Height of the cloud shell above the base sphere, metres. */
const CLOUD_SHELL_M = 3000;

const engine = createEngine({
  ...(cloudSlot ? { slots: [cloudSlot, ...(stage >= STAGE.sites ? [snowSlot(), windowLightSlot()] : [])], precipitation: true } : {}),
  canvas: document.querySelector<HTMLCanvasElement>('#view')!,
  view: rig,
  // From stage 3 the rows of the structures follow the sky (structures.ts, `STRUCTURE_ROW_BASE`).
  palette: stage >= STAGE.sites ? definePalette({ sky: '#000000', ...STRUCTURE_ROWS }) : definePalette({ sky: '#000000' }),
  background: [0, 0, 0],
  // `radialUp`: up points away from the centre of the attached body in every shader that asks for it. The object is
  // kept by the renderer and its radius changed here when the camera goes over to another body.
  renderer: { shadowSoftnessM: 1.2, shadowDistanceM: 4000, shadowMapSize: 4096, depth, radialUp: upSphere },
  environment: { mode: 'day', site: { latitudeDeg: 0, longitudeDeg: 0, dayOfYear: 172, utcOffsetHours: 0 }, hour: 12, hoursPerSecond: 0.5, weather: {}, wind: { fromDeg: 240, speedMs: 6 }, clouds: { sizeM: 2400 } },
  // The default air of the engine fitted to a body. Every body with air has a shell of the same share of its radius,
  // so the tables computed here hold for all of them (see `AIR_PER_RADIUS`).
  atmosphere: atmosphereFor(firstAir.radiusM, firstAir.airM),
  onFrame: () => meter.end(performance.now()),
});
const { renderer, env } = engine;
env.day.pause();
// From stage 2 the clouds, the rain and the weather run on the time of the system (set every frame).
if (cloudSlot) env.time.pause();
// One exposure everywhere: the picture must not change its brightness where the camera goes over between bodies.
env.dayLight.exposureNight = 1;
env.dayLight.lowSunExposure = 0;
const air = engine.atmosphere!.slot;
const airExposure = air.params.exposure;
// The stars and the sun are drawn by this page, fixed to the system and placed by it.
air.params.stars = 0;
air.params.sunDiscRad = -1;

// --- What is drawn from afar -----------------------------------------------------------------------------------------
const scene: FarScene = {
  eye: [0, 0, 0],
  airNear: 0,
  starGain: 1,
  toFixed: new Float32Array(16),
  sun: { center: [0, 0, 0], radiusM: SUN.radiusM, size: 1 },
  bodies: surfaces.map((s) => s.far),
  paths: [],
  pathAlpha: 0,
  marks: [],
  showMarks: stage > 0 && q.get('map') === '1',
};
// Stage 5: the far bodies carry the shade of the relief (only the planned one has it; the others draw lit).
const farLayer = new FarLayer(renderer, scene, { shade: stage >= STAGE.shade });
const shellLayer = new ShellLayer(renderer, scene);
engine.add(farLayer);
engine.add(shellLayer);
/** From stage 2: Hearth's clouds, a shell drawn after the solid bodies and before the shells of air. */
const cloudShell = cloudSlot ? new CloudShellLayer(renderer, engine.link) : null;
if (cloudShell) {
  cloudShell.opacity = 0;
  cloudShell.heightM = CLOUD_SHELL_M;
  renderer.addBefore(cloudShell, shellLayer);
}

/** The paths: one round of every body, in the frame of the body it goes round. */
const PATH_POINTS = 256;
const paths: { path: FarPath; parentFrame: number }[] = surfaces.map((s) => {
  const o = s.body.orbit!;
  const points = new Float64Array(PATH_POINTS * 3);
  const p: Vec3 = [0, 0, 0];
  for (let i = 0; i < PATH_POINTS; i++) {
    orbitPosition(o, (o.periodS * i) / PATH_POINTS, p);
    points.set(p, i * 3);
  }
  const path: FarPath = { mesh: farLayer.createPath(points), model: new Float32Array(16), color: s.spec.tint };
  scene.paths.push(path);
  return { path, parentFrame: system.bodies[s.body.parent]!.carriedFrame };
});
let showPaths = q.get('orbits') !== '0';
let showNames = q.get('names') !== '0';
let showLevels = num('levels', 0) === 1;

// --- The coarsest cells of every body --------------------------------------------------------------------------------
/** Coarsest cells still to be generated. */
let rootsLeft = surfaces.length * 6;
/** True once the planned body's coarsest cells come from its plan (stage ≥ 1). */
let plannedRootsIn = false;
/** With the generator on the main thread: the cells waiting for their frame. */
const rootQueue: { s: Surface; face: number }[] = [];

function rootReady(s: Surface, face: number, content: CellContent): void {
  // Once the planned roots of the planned body are there, its plain ones only count.
  const replaced = s.index === PLAN_BODY && plannedRootsIn;
  if (!replaced) s.roots[face] = content;
  const mesh = content.meshes[0];
  if (mesh && !replaced) {
    const o = s.shape.origin(content.cell);
    s.far.cells.push({ mesh: farLayer.createCell(mesh.mesh), origin: [o[0], o[1], o[2]] });
  }
  rootsLeft--;
  engine.invalidate();
}
for (const s of surfaces) {
  for (let face = 0; face < 6; face++) {
    if (!pool) {
      rootQueue.push({ s, face });
      continue;
    }
    const job = pool.run<ArrayBuffer>({ seed: s.packed, cell: { face, level: ROOT_LEVEL, x: 0, y: 0 } });
    job.promise.then(
      (buf) => rootReady(s, face, decodeCell(new Uint8Array(buf))),
      (e: unknown) => void (note = `a cell of ${s.spec.name} failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}

// --- The plan of the world (inhabited.ts): one job after the coarsest cells, then a copy for every worker ------------
const planned = surfaces[PLAN_BODY]!;
const inh: Inhabited | null = stage > 0 ? createInhabited({ engine, pool, packed: planned.packed, stage, details: showDetails, life: showLife, before: cloudShell ?? shellLayer }) : null;
/** True once the plan is there or has failed: the page counts as loaded only then. */
let planSettled = inh === null;
/** With a plan: the loader in the lower middle of the page (loader.ts), while the plan and then the surface load. */
const loader = inh ? createLoader({ seed: planned.packed, stage, plan: true }) : null;
// From stage 1 the planned body's cells come from the plan: its streaming waits for it, and from afar its six
// coarsest planned cells replace the plain ones once they are there (the strips are not drawn from afar).
plannedB = inh ? plannedBody(inh, { pool, packed: planned.packed, name: `${providerName}, with the plan of stage ${stage}` }) : null;
if (plannedB) planned.provider = plannedB.provider;
plannedB?.roots.then(
  (contents) => {
    for (const c of planned.far.cells) renderer.device.deleteMesh(c.mesh);
    planned.far.cells.length = 0;
    contents.forEach((content, face) => {
      planned.roots[face] = content;
      const o = planned.shape.origin(content.cell);
      planned.far.cells.push({ mesh: farLayer.createCell(content.meshes[0]!.mesh), origin: [o[0], o[1], o[2]] });
    });
    // The planned cells carry the depth code in the alpha of their colour (planned-cell.ts).
    planned.far.depthCode = 1;
    if (stage >= STAGE.shade) planned.far.shade = 1;
    plannedRootsIn = true;
    engine.invalidate();
  },
  (e: unknown) => void (note = `a planned cell failed: ${e instanceof Error ? e.message : String(e)}`),
);
/** Colours of the marks: the river lines by class (the great ones brightest), then the outlines of the lakes. */
const MARK_COLORS: readonly (readonly [number, number, number, number])[] = [
  [0.62, 0.9, 1, 1],
  [0.42, 0.72, 1, 0.9],
  [0.32, 0.56, 0.92, 0.7],
  [0.26, 0.46, 0.8, 0.5],
  [0.95, 0.97, 1, 0.95],
  // Stage 3: the crosses over the sites.
  [1, 0.62, 0.22, 1],
  // Stage 4: the roads and decks.
  [0.96, 0.86, 0.52, 0.95],
];
if (inh) {
  inh.whenReady.then(
    () => {
      const m = planMarks(inh.plan()!);
      [...m.rivers, m.pools, m.sites, m.roads].forEach((points, i) => {
        if (points.length > 0) scene.marks.push({ mesh: farLayer.createLines(points), body: planned.far, color: MARK_COLORS[i]! });
      });
      planSettled = true;
      // Stage 3: `site=<n>` in the address starts over that site (`alt`, default 300 m).
      if (q.has('site') && inh.plan()?.sites) goToSite(Math.round(num('site', 0)), num('alt', 300));
      engine.invalidate();
    },
    () => void (planSettled = true),
  );
}
/** The site the key G went to last. */
let siteAt = -1;
/** Stage 3: puts the camera south of site `n` (wrapped), `alt` above the ground, looking at its centre. */
function goToSite(n: number, alt = 300): void {
  const S = inh?.plan()?.sites;
  if (!S || S.count === 0) return;
  siteAt = ((n % S.count) + S.count) % S.count;
  const f = siteFrame(inh!.plan()!, siteAt);
  const R = planned.spec.radiusM;
  const from = sitePoint(f, 0, -(S.radiusM[siteAt]! + 300));
  const centre = sitePoint(f, 0, 0);
  placeAt(planned, [from.dir[0], from.dir[1], from.dir[2]], alt, 0, 20);
  const r = R + centre.heightM;
  rig.lookAt([centre.dir[0] * r, centre.dir[1] * r, centre.dir[2] * r]);
  updateFrames();
  engine.invalidate();
  loader?.rearm();
}

// --- Streaming of the body the camera is at --------------------------------------------------------------------------
const [terrain, object] = [TERRAIN_MATERIAL, OBJECT_MATERIAL].map((m) => renderer.material(m)) as [Material, Material];
/** The planned body's own materials (stage ≥ 1): the terrain with standing water and the rivers. */
const plannedMaterials = inh
  ? stage >= STAGE.shade
    ? { terrain: renderer.material(SHADE_TERRAIN_MATERIAL), water: renderer.material(SHADE_WATER_MATERIAL), object: renderer.material(SHADE_OBJECT_MATERIAL) }
    : cloudSlot
    ? { terrain: renderer.material(CLIMATE_TERRAIN_MATERIAL), water: renderer.material(WATER_MATERIAL), object: renderer.material(CLIMATE_OBJECT_MATERIAL) }
    : { terrain: renderer.material(PLANNED_TERRAIN_MATERIAL), water: renderer.material(WATER_MATERIAL), object }
  : null;
/** Stage 3: the lanes of the planned cells, and the massing of the settlements near the eye. */
const wayMaterial = inh && stage >= STAGE.sites ? renderer.material(stage >= STAGE.shade ? SHADE_WAY_MATERIAL : WAY_MATERIAL) : null;
/** Stage 5: the shade alone (key J), and the lights of the settlements once the plan is there. */
let shadeView = false;
let lightsLayer: LightsLayer | null = null;
/** Puts the lights after the streamed surface (re-added on every change of body) and before the shells. */
function placeLights(): void {
  if (!lightsLayer) return;
  renderer.remove(lightsLayer);
  renderer.addBefore(lightsLayer, cloudShell ?? shellLayer);
}
if (inh && stage >= STAGE.shade)
  inh.whenReady.then(
    () => {
      if (!inh.plan()) return;
      lightsLayer = new LightsLayer(renderer, scene, planned.far, inh.plan()!);
      placeLights();
      engine.invalidate();
    },
    () => {},
  );
const settlementLayer = inh && stage >= STAGE.sites ? new SettlementLayer(renderer, planned.packed, { pool, stage, clock: () => env.time.time, onChange: () => engine.invalidate() }) : null;
if (settlementLayer) {
  renderer.addBefore(settlementLayer, cloudShell ?? shellLayer);
  renderer.addBefore(settlementLayer.intact, cloudShell ?? shellLayer);
  renderer.addBefore(settlementLayer.damaged, cloudShell ?? shellLayer);
  renderer.addBefore(settlementLayer.transient, cloudShell ?? shellLayer);
}
/** The eye in Hearth's frame while Hearth is the body near (for the pick of the structures), else null. */
let structureEye: Vec3 | null = null;
/** Key X: a strike at the structure part in the middle of the view. Keys of the structures it changed. */
function strikeView(): number[] {
  if (!settlementLayer || !structureEye) return [];
  const hit = settlementLayer.pick(structureEye, rig.axes().forward);
  return hit ? settlementLayer.strikeAt(hit.point) : [];
}
/**
 * `hit=1`: once the near structures of the view are built, fixed strikes on the front walls of the two nearest
 * (their middle, 2.5 m up), so the picture shows damage without a hand on the keys.
 */
const hitOnce = q.get('hit') === '1';
let hitDone: (() => void) | null = null;
const hitApplied = new Promise<void>((resolve) => (hitDone = resolve));
function applyFixedHits(): void {
  if (!hitOnce || !hitDone || !settlementLayer?.settled || settlementLayer.near().length === 0) return;
  const plan = inh!.plan()!;
  for (const r of settlementLayer.near().slice(0, 2)) {
    const ring = r.specs[0]!.rings[0]!;
    let front = 0;
    for (let i = 1; i < ring.length; i += 2) front = Math.max(front, ring[i]!);
    const f = r.frame;
    const rr = plan.grid.radiusM + f.heightM;
    const y = r.specs[0]!.groundRef + 2.5;
    // The fall is skipped to its end: the picture shows the rubble grown.
    settlementLayer.strikeAt([f.origin[0] * rr + f.y[0] * y + f.z[0] * front, f.origin[1] * rr + f.y[1] * y + f.z[1] * front, f.origin[2] * rr + f.y[2] * y + f.z[2] * front], undefined, undefined, false);
  }
  hitDone();
  hitDone = null;
}
/** The shapes of stage 2 (climate.ts places them on Hearth). */
const climateArchetypes: Readonly<Record<string, StreamArchetype>> = cloudSlot
  ? {
      broadleaf: { material: 'object', lods: [{ mesh: broadleafMesh(true), maxDistance: 260 }, { mesh: broadleafMesh(false), maxDistance: 2600 }] },
      shrub: { material: 'object', lods: [{ mesh: shrubMesh(true), maxDistance: 120 }, { mesh: shrubMesh(false), maxDistance: 900 }] },
      'flat-crown': { material: 'object', lods: [{ mesh: flatCrownMesh(true), maxDistance: 260 }, { mesh: flatCrownMesh(false), maxDistance: 2600 }] },
      shard: { material: 'object', lods: [{ mesh: shardMesh(true), maxDistance: 140 }, { mesh: shardMesh(false), maxDistance: 1600 }] },
    }
  : {};
/** The clock of the flow of the water: seconds the page has run, at most real time, stopped by a pause, 0 under a script. */
let flowTime = 0;
let world: StreamedWorld | null = null;
let worldOf: Surface | null = null;

/**
 * Without a streamed surface there is no scene to take the size of the picture from, and the renderer would draw
 * only its background. This runs after the streaming step and gives it a box round the eye in that case. What is
 * drawn from afar does not depend on the size of that box.
 */
const GUARD: SceneBounds = { min: [-1e6, -1e6, -1e6], max: [1e6, 1e6, 1e6] };
const guard = (): void => {
  if (!world || !renderer.bounds) renderer.bounds = GUARD;
};
/** Puts the guard behind every other step of the frame (a new streamed world adds its step at the end). */
function placeGuard(): void {
  const i = renderer.beforeFrame.indexOf(guard);
  if (i >= 0) renderer.beforeFrame.splice(i, 1);
  renderer.beforeFrame.push(guard);
}
placeGuard();

/** Streams the surface of the body the camera is near, and of no other. */
function syncWorld(): void {
  const want = home();
  if (want === worldOf) return;
  if (world) world.dispose();
  world = null;
  worldOf = want;
  covered = false;
  if (!want) return;
  world = new StreamedWorld({
    renderer,
    config: want.config,
    provider: want.provider,
    // The render origin follows the camera on all three axes: numbers on the GPU stay small anywhere round the body.
    originAxes: 'all',
    morph: true,
    horizon: { center: [0, 0, 0], radiusM: horizonRadiusM(want.packed) },
    // Everything the page holds on the GPU stays under the budget: over the ceiling the least needed cells leave.
    ...(gpuCeilingMb > 0 ? { gpuCeilingBytes: gpuCeilingMb * MB } : {}),
    materials: want === planned && plannedMaterials ? { terrain: plannedMaterials.terrain, object: plannedMaterials.object, water: plannedMaterials.water, ...(wayMaterial ? { way: wayMaterial } : {}) } : { terrain, object },
    archetypes: {
      tree: { material: 'object', lods: [{ mesh: treeMesh(true), maxDistance: 260 }, { mesh: treeMesh(false), maxDistance: 2600 }] },
      rock: { material: 'object', lods: [{ mesh: rockMesh(true), maxDistance: 140 }, { mesh: rockMesh(false), maxDistance: 2600 }] },
      ...(want === planned ? climateArchetypes : {}),
    },
    uploadMsPerFrame: 3,
    blockingMsPerFrame: 6,
    onActivity: () => engine.invalidate(),
  });
  // Between the solid bodies and the shells of air (from stage 2: before the clouds).
  renderer.addBefore(world, cloudShell ?? shellLayer);
  placeLights();
  placeGuard();
}

/** What follows from the body the camera is kept by: the sphere of "up" and, for a body with air, the air itself. */
function onAttach(): void {
  const s = attachedSurface();
  upSphere.radiusM = s ? s.spec.radiusM : SUN.radiusM;
  // The air is switched over while none of it is in the picture (`AIR_NONE` lies inside every reach).
  if (s && s.spec.airM > 0) Object.assign(air.medium, atmosphereFor(s.spec.radiusM, s.spec.airM));
}

/**
 * Chooses the body the camera is kept by and the frame its position is in, from where it is, and takes the position,
 * the heading and the velocity over when the frame changes. The picture does not change by it: the same place and
 * the same view, in other numbers.
 */
function updateFrames(): void {
  const p = rig.position;
  // Entering a reach takes the camera over at its border, leaving it a tenth beyond: no flipping on the border.
  const enter = system.dominantBody(p, drawFrame, 1);
  const keep = system.dominantBody(p, drawFrame, 1.1);
  const next = keep === attached ? attached : Math.max(enter, 0);
  let nextNear = false;
  let nextFrame = sunBody.carriedFrame;
  if (next > 0) {
    const b = system.bodies[next]!;
    const d = len(sub(p, centers[next]!));
    nextNear = d < (near && next === attached ? NEAR_OUT : NEAR_IN) * b.radius;
    nextFrame = nextNear ? b.turningFrame : b.carriedFrame;
  }
  if (nextFrame !== drawFrame) {
    const heading = frames.convertDirection(rig.headingDir(), drawFrame, nextFrame);
    const position = frames.convertPoint(p, drawFrame, nextFrame);
    const velocity = frames.convertDirection(rig.velocity, drawFrame, nextFrame);
    const pitch = rig.pitch;
    drawFrame = nextFrame;
    refresh();
    rig.position = position;
    rig.velocity = velocity;
    const changed = next !== attached;
    attached = next;
    near = nextNear;
    if (changed) onAttach();
    setHeading(heading, pitch);
    rig.keepClear();
    return;
  }
  if (next !== attached) {
    attached = next;
    onAttach();
  }
  near = nextNear;
}

/** Puts the camera at a body: a direction from its centre, a height above its surface, and optionally the view. */
function placeAt(s: Surface, dir: V3, alt: number, yawDeg?: number, pitchDeg?: number): void {
  attached = s.index + 1;
  near = true;
  drawFrame = s.body.turningFrame;
  refresh();
  onAttach();
  rig.setState({ position: above(s, dir, Math.max(alt, rig.setup.minClearance)), ...(yawDeg !== undefined ? { yawDeg } : {}), ...(pitchDeg !== undefined ? { pitchDeg } : {}) });
  updateFrames();
}

/** Puts the camera at the view of the whole system, looking at the sun. */
function placeOverview(): void {
  attached = 0;
  near = false;
  drawFrame = sunBody.carriedFrame;
  refresh();
  onAttach();
  rig.setState({ position: [OVERVIEW[0], OVERVIEW[1], OVERVIEW[2]] });
  rig.lookAt([0, 0, 0]);
  updateFrames();
}

// --- Start view ------------------------------------------------------------------------------------------------------
const startBody = surfaces.find((s) => s.spec.name.toLowerCase() === (q.get('body') ?? '').toLowerCase()) ?? null;
if (startBody) placeAt(startBody, directionAt(num('lat', 0), num('lon', 0)), num('alt', LAND_M), num('yaw', 0), num('pitch', 3));
else placeOverview();

// --- Flights ---------------------------------------------------------------------------------------------------------
// The legs and where the camera is on them are in flight.ts. Here: planning a flight from where the camera is, the
// view that goes with it, and its report.

interface Flight {
  legs: Leg[];
  /** Seconds since the start. */
  t: number;
  /** Name of where it goes, for the panel. */
  goal: string;
  /** The view at the start: a direction of a frame. */
  view0: { frame: number; dir: Vec3 };
  /** Index in the system of the body a rising or straight leg looks at. */
  target: number;
  /** The view at the landing, in the turning frame of the last leg's body; null without a landing. */
  final: Vec3 | null;
  /** Where the camera was a frame ago, for its velocity. */
  previous: { frame: number; position: Vec3 } | null;
  /** True while a script sets the time (`__wh.setFlight`); the clock does not move it then. */
  held: boolean;
}
/** What a flight measured, frame by frame. */
interface FlightReport {
  goal: string;
  finished: boolean;
  seconds: number;
  frames: number;
  cpuMsMean: number;
  cpuMsWorst: number;
  intervalMsMean: number;
  intervalMsWorst: number;
  /** Frames whose interval was above the budget of a frame. */
  framesOverBudget: number;
  gpuMbPeak: number;
  patchesPeak: number;
  cellsPeak: number;
  holesPeak: number;
  /** A frame at the end with the graphics work finished, in ms (0 until measured). */
  endFrameMs: number;
}
let flight: Flight | null = null;
let report: FlightReport | null = null;
/** The flight along the main river of the planned body (key R, river-flight.ts): seconds since its start, and held by a script. */
interface RiverFlight {
  t: number;
  seconds: number;
  held: boolean;
  previous: Vec3 | null;
}
let river: RiverFlight | null = null;
/** Seconds the flight along the river takes at pace 1. */
const RIVER_FLIGHT_S = 150;
/** Stops of the tour: indices in the system, 0 is the view of the whole system. */
const TOUR = [...surfaces.map((s) => s.index + 1), 0];
let tourAt = -1;
let touring = q.get('tour') === '1' || q.get('movie') === '1';
if (q.get('movie') === '1') document.body.classList.add('movie');
let pendingFlight = q.get('fly') === '1' || touring;
/** Seconds the tour still waits at a stop. */
let tourWaitS = 0;
/** Result of the last measurement with key B, in ms. */
let benchMs = 0;
/** A line for the panel about the last key that did nothing. */
let note = '';

/**
 * Where to land on a body and where to look there, both in its turning frame, for the time of the arrival: a place
 * with the sun above the horizon and, where the body has a companion, the companion in the sky. The system is read
 * at that time and put back.
 */
function landing(s: Surface, arriveS: number): { site: Vec3; view: Vec3 } {
  system.setTime(arriveS);
  const sky = skyOf(system, s.body, s.companion);
  system.setTick(tick, CLOCK_HZ);
  const site = findSite(s.packed, landingDirection(sky));
  return { site, view: landingView(sky, site) };
}

/** Height of the surface of a body in a unit direction from its centre. */
const groundAt = (s: Surface, d: V3): number => surfaceOf(s, d[0] * s.spec.radiusM, d[1] * s.spec.radiusM, d[2] * s.spec.radiusM);

/** Plans a flight to a body (index in the system) or to the view of the whole system (0). Null when already there. */
function planFlight(goal: number): Flight | null {
  const p = rig.position;
  const from = home();
  const base = { t: 0, view0: { frame: drawFrame, dir: rig.axes().forward }, previous: null, held: false };
  /** The time of the system a number of seconds of the flight from now (the clock stands still under a script). */
  const timeAfter = (seconds: number): number => tick / CLOCK_HZ + seconds * (scripted ? 0 : rate);
  /** The leg up from where the camera is, at the body it is near. */
  const up = (s: Surface, far: MovingPoint, rest: boolean): SurfaceLeg => {
    const site = unit(p);
    return finishLeg({ kind: 'surface', body: s.body, site, groundM: groundAt(s, site), lowM: Math.max(rig.clearance, 2.5), far, rest, rising: true }, pace);
  };
  if (goal === 0) {
    const to = anchor(system, sunBody.carriedFrame, OVERVIEW);
    if (len(sub(to(drawFrame), p)) < 1000) return null;
    const legs: Leg[] = from ? [up(from, to, true)] : [{ kind: 'line', from: anchor(system, drawFrame, p), to, seconds: 12 * pace }];
    return { ...base, goal: 'the whole system', legs, target: 0, final: null };
  }
  const s = surfaces[goal - 1]!;
  /** The leg down to the body from a far end, landing at a time of the system. `seconds` fixes how long it takes. */
  const down = (far: MovingPoint, rest: boolean, arriveS: number, seconds?: (leg: OpenLeg) => number): { leg: SurfaceLeg; view: Vec3 } => {
    const at = landing(s, arriveS);
    const open: OpenLeg = { kind: 'surface', body: s.body, site: at.site, groundM: groundAt(s, at.site), lowM: LAND_M, far, rest, rising: false };
    return { leg: finishLeg(open, pace, seconds?.(open)), view: at.view };
  };
  /** How long a leg down from a far end takes, before its place is known: a leg to the place under that far end. */
  const guess = (far: MovingPoint, rest: boolean): OpenLeg => ({ kind: 'surface', body: s.body, site: unit(far(s.body.turningFrame)), groundM: 0, lowM: LAND_M, far, rest, rising: false });
  if (!from || from === s) {
    // Already at this body: from low above it there is nowhere to fly.
    if (from === s && rig.clearance < 0.5 * s.spec.radiusM) return null;
    // From between the bodies, or from high above this one: one leg down from where the camera is.
    const far = anchor(system, drawFrame, p);
    const d = down(far, true, timeAfter(finishLeg(guess(far, true), pace).seconds));
    return { ...base, goal: s.spec.name, legs: [d.leg], target: goal, final: d.view };
  }
  // From one body to another: up from where the camera is to the point between them, and down from there. The way
  // down takes as long as makes its speed at that point the speed of the way up.
  const meet = between(system, from.body, s.body, 10 * SUN.radiusM);
  const rise = up(from, meet, false);
  const d = down(meet, false, timeAfter(rise.seconds + matchedSeconds(guess(meet, false), rise)), (open) => matchedSeconds(open, rise));
  return { ...base, goal: s.spec.name, legs: [rise, d.leg], target: goal, final: d.view };
}

/**
 * Turns the view toward a direction of the picture's frame. The pitch follows at once. The heading follows fast
 * where the direction has a clear part along the horizon. Where it points straight up or down a heading means
 * nothing for the direction and only turns the picture round its middle: there it goes slowly toward `hint`, the
 * direction the view will take next, or stays as it is.
 */
function aim(v: V3, dt: number, snap: boolean, hint: V3 | null = null): void {
  const up = rig.up();
  const rise = Math.min(1, Math.max(-1, dot3(v, up)));
  const flat = reject(v, up);
  const clear = smooth((len(flat) - 0.02) / 0.25);
  const hinted = hint ? unit(reject(hint, up), ZERO) : ZERO;
  const mixed: Vec3 = [flat[0] * clear + hinted[0] * (1 - clear), flat[1] * clear + hinted[1] * (1 - clear), flat[2] * clear + hinted[2] * (1 - clear)];
  if (len(mixed) > 1e-4) {
    const want = unit(mixed);
    const now = rig.headingDir();
    // Positive turns left, as `FreeRig.turn` counts it.
    const angle = Math.atan2(dot3(cross3(now, want), up), dot3(now, want));
    const perSecond = 5 * clear + (hint ? 1.2 * (1 - clear) : 0);
    rig.turn(angle * (snap ? 1 : 1 - Math.exp(-dt * perSecond)), 0);
  }
  rig.pitch = -Math.asin(rise);
}

/**
 * How far the view of a leg along a body has turned from the ground to the sky: 0 near its low end, 1 from half a
 * radius above the surface up, by the height the camera is at.
 */
function lift(leg: SurfaceLeg, position: V3): number {
  const h = len(sub(position, centers[leg.body.index]!)) - leg.body.radius - leg.groundM;
  const whole = Math.max(0.5, Math.log((0.5 * leg.body.radius) / leg.lowM));
  return smooth((Math.log(Math.max(h, leg.lowM) / leg.lowM) / whole - 0.25) / 0.75);
}

/** Puts the camera where the flight is at its time, with the view that belongs there. `dt`: seconds since the last frame. */
function applyFlight(f: Flight, dt: number): void {
  const { position, leg, index, done } = flightPoint(system, f.legs, f.t, drawFrame);
  const view0 = frames.convertDirection(f.view0.dir, f.view0.frame, drawFrame);
  const toward = (body: number): Vec3 => unit(sub(centers[body]!, position), view0);
  let view: Vec3;
  let next: Vec3 | null = null;
  if (leg.kind === 'line') view = slerp(view0, toward(f.target), smooth((done - 0.1) / 0.5));
  else if (leg.rising) view = slerp(view0, toward(f.target), lift(leg, position));
  else {
    // Down: at the body's centre from afar, and up to the view of the landing as the ground comes near.
    view = toward(leg.body.index);
    if (f.final) {
      next = frames.convertDirection(f.final, leg.body.turningFrame, drawFrame);
      view = slerp(next, view, lift(leg, position));
    }
    // A flight that starts with the way down leaves the view it started with first.
    if (index === 0) view = slerp(view0, view, smooth(done / 0.25));
  }
  // For the prediction of the streaming and the speed shown.
  if (f.previous && f.previous.frame === drawFrame && dt > 0) rig.velocity = mul(sub(position, f.previous.position), 1 / dt);
  f.previous = { frame: drawFrame, position };
  rig.position = position;
  aim(view, dt, f.held, next);
  rig.keepClear();
}

function startFlight(goal: number, held = false): Flight | null {
  const f = planFlight(goal);
  if (!f) {
    note = goal === 0 ? 'already at the view of the whole system' : `already at ${surfaces[goal - 1]!.spec.name}`;
    return null;
  }
  note = '';
  f.held = held;
  flight = f;
  rig.velocity = [0, 0, 0];
  report = { goal: f.goal, finished: false, seconds: 0, frames: 0, cpuMsMean: 0, cpuMsWorst: 0, intervalMsMean: 0, intervalMsWorst: 0, framesOverBudget: 0, gpuMbPeak: 0, patchesPeak: 0, cellsPeak: 0, holesPeak: 0, endFrameMs: 0 };
  const stop = TOUR.indexOf(goal);
  if (stop >= 0) tourAt = stop;
  engine.invalidate();
  return f;
}

function stopFlight(arrived: boolean): void {
  if (!flight) return;
  flight = null;
  rig.velocity = [0, 0, 0];
  if (report) report.finished = arrived;
  // A flight stopped by hand also stops the tour.
  if (!arrived) touring = false;
  else tourWaitS = 6;
  engine.invalidate();
}

/** Starts the flight along the river; false before the plan is there. */
function startRiverFlight(held = false): boolean {
  if (!plannedB?.stem()) {
    note = inh ? 'the plan is not there yet' : 'no plan at world=0';
    return false;
  }
  stopFlight(false);
  touring = false;
  note = '';
  river = { t: 0, seconds: RIVER_FLIGHT_S * pace, held, previous: null };
  engine.invalidate();
  return true;
}

/** Puts the camera where the flight along the river is at its time. `dt`: seconds since the last frame. */
function applyRiverFlight(r: RiverFlight, dt: number): void {
  if (!r.held) r.t += dt;
  const pose = plannedB ? riverPose(plannedB, Math.min(1, r.t / r.seconds)) : null;
  if (!pose) {
    river = null;
    return;
  }
  // The pose is in the body's own turning frame: the camera is kept there for the whole flight.
  if (drawFrame !== planned.body.turningFrame) {
    attached = planned.index + 1;
    near = true;
    drawFrame = planned.body.turningFrame;
    refresh();
    onAttach();
    r.previous = null;
  }
  rig.velocity = r.previous && dt > 0 ? mul(sub(pose.eye, r.previous), 1 / dt) : [0, 0, 0];
  r.previous = pose.eye;
  rig.position = pose.eye;
  rig.lookAt(pose.target);
  if (!r.held && r.t >= r.seconds) river = null;
}

/** The next stop of the tour. */
function nextStop(): void {
  if (flight) return;
  for (let tries = 0; tries < TOUR.length; tries++) {
    tourAt = (tourAt + 1) % TOUR.length;
    if (startFlight(TOUR[tourAt]!)) return;
  }
}

/** Adds the frame that has just been timed to the flight's report. */
function recordFrame(r: FlightReport, f: Flight): void {
  r.seconds = f.t;
  r.frames++;
  r.cpuMsMean += (meter.lastCpuMs - r.cpuMsMean) / r.frames;
  r.cpuMsWorst = Math.max(r.cpuMsWorst, meter.lastCpuMs);
  if (meter.lastIntervalMs > 0 && r.frames > 1) {
    r.intervalMsMean += (meter.lastIntervalMs - r.intervalMsMean) / (r.frames - 1);
    r.intervalMsWorst = Math.max(r.intervalMsWorst, meter.lastIntervalMs);
    if (meter.lastIntervalMs > BUDGET.frameMs) r.framesOverBudget++;
  }
  r.gpuMbPeak = Math.max(r.gpuMbPeak, engine.device.memory().total / MB);
  if (!world) return;
  const s = world.stats();
  r.patchesPeak = Math.max(r.patchesPeak, s.cellsVisible);
  r.cellsPeak = Math.max(r.cellsPeak, s.drawn);
  r.holesPeak = Math.max(r.holesPeak, s.holes);
}

// --- The frame -------------------------------------------------------------------------------------------------------
const input = bindFreeInput(engine.canvas, rig, { onChange: () => engine.invalidate() });
/** True once a script has taken the view over: the clock and the keys then leave the time and the camera alone. */
let scripted = false;
/** True while `measureFrame` renders: its frames stay out of the frame times and move nothing. */
let measuring = false;
/** Time of the previous frame in ms, 0 before the first. */
let lastFrameMs = 0;
/** True once the streamed surface covers its whole body, so the body is not drawn from afar as well. */
let covered = false;

/** Pixels one radian covers, never less than what splits a cell at `MIN_SPLIT_EDGES` edges (the blend needs the room). */
function ticketPixels(): number {
  return Math.max(pixelsPerRadian(engine.canvas.clientHeight || engine.canvas.height, FOV_DEG * DEG), (MIN_SPLIT_EDGES * maxErrorPx) / SELECTION.errorPerEdge);
}

/** True when the bodies are there and the surface round the camera has loaded. */
const loaded = (): boolean => rootsLeft === 0 && planSettled && (!world || (world.settled && !world.busy)) && (inh?.details()?.settled() ?? true);

/**
 * Takes the camera along with the turning of the body it comes near, by the share of the turn that belongs to its
 * distance, so that it turns with the body fully before its position goes over into the body's turning frame.
 * `dtS`: seconds of the system's time since the last frame.
 */
function dragAlong(dtS: number): void {
  const s = attachedSurface();
  if (!s || near) return;
  const period = s.body.spin.periodS;
  // A jump of the time is not a motion to take part in.
  if (period === 0 || Math.abs(dtS) > Math.abs(period) / 4) return;
  const p = rig.position;
  const R = s.spec.radiusM;
  const share = 1 - smooth((len(p) - DRAG_FULL * R) / ((DRAG_NONE - DRAG_FULL) * R));
  if (share <= 0) return;
  const turn = quatAxisTurns(s.body.spin.axis, (share * dtS) / period);
  const heading = quatRotate(turn, rig.headingDir());
  const pitch = rig.pitch;
  rig.position = quatRotate(turn, p);
  rig.velocity = quatRotate(turn, rig.velocity);
  setHeading(heading, pitch);
}

/** Hands the camera and the places of the bodies to everything that draws. After the camera has moved. */
function syncView(): void {
  const p = rig.position;
  const eye: [number, number, number] = [p[0], p[1], p[2]];
  const h = home();
  // The engine's atmosphere: all of it close to a body with air, none of it from afar.
  const airNear = h && h.spec.airM > 0 ? 1 - smooth((len(p) / h.spec.radiusM - AIR_FULL) / (AIR_NONE - AIR_FULL)) : 0;
  air.params.exposure = airExposure * airNear;

  syncWorld();
  if (world && h) {
    world.setFocus(eye);
    rig.origin = [world.origin[0], world.origin[1], world.origin[2]];
    world.setEye(eye);
    // The prediction looks two seconds ahead: never farther than a part of the height, or it would land under the ground.
    const speed = len(rig.velocity);
    const cap = 0.3 * Math.max(rig.clearance, 10);
    world.setTickets(viewerTickets({ eye, altitude: rig.clearance, forward: rig.axes().forward, velocity: speed > cap ? mul(rig.velocity, cap / speed) : rig.velocity, pixelsPerRadian: ticketPixels() }));
    // Asked only until the streamed surface has taken over: its coarsest cells stay loaded from then on.
    if (!covered) {
      const st = world.stats();
      covered = st.drawn > 0 && st.holes === 0;
    }
  } else {
    const o = snapRenderOrigin(eye, 1024, 'all');
    renderer.worldOrigin = o;
    rig.origin = [o[0], o[1], o[2]];
    covered = false;
  }
  const o = renderer.worldOrigin;
  scene.eye = sub(eye, o);
  scene.airNear = airNear;
  relativeMatrix(frames.relativePose(drawFrame, system.root), ZERO, scene.toFixed);
  const sunAt = centers[0]!;
  const sunFar = len(sub(sunAt, eye));
  scene.sun.center = sub(sunAt, o);
  scene.sun.size = Math.max(1, (MIN_SUN_RAD * sunFar) / SUN.radiusM);
  let pathFade = 1;
  for (const s of surfaces) {
    const c = centers[s.index + 1]!;
    const f = s.far;
    const d = len(sub(c, eye));
    const R = s.spec.radiusM;
    f.center = sub(c, o);
    relativeMatrix(frames.relativePose(s.body.turningFrame, drawFrame), o, f.model);
    f.toSun = unit(sub(sunAt, c));
    f.size = Math.max(1, (MIN_BODY_RAD * d) / R);
    f.solid = f.cells.length === 6 && !(s === worldOf && covered);
    f.shell = s.spec.airM > 0 ? (s === h ? 1 - airNear : 1) : 0;
    // A path is a line without a width: near the body it belongs to, and near any other, it only gets in the way.
    pathFade *= smooth((d - 8 * R) / (30 * R));
  }
  scene.pathAlpha = showPaths ? 0.5 * pathFade : 0;
  for (const path of paths) relativeMatrix(frames.relativePose(path.parentFrame, drawFrame), o, path.path.model);

  // The sun for the engine: its direction at the body the camera is at, and up where the camera is.
  const at = attachedSurface();
  const toSun = h ? h.far.toSun : unit(sub(sunAt, at && near ? centers[attached]! : eye));
  const up = rig.up();
  env.observer = { up, sunDir: toSun };
  // The stars are lost in the lit air of a day.
  let starGain = 1;
  if (h && airNear > 0) {
    const inAir = 1 - smooth((len(p) - h.spec.radiusM - 0.25 * h.spec.airM) / (0.75 * h.spec.airM));
    starGain = 1 - airNear * inAir * smooth((dot3(up, toSun) + 0.12) / 0.2);
  }
  scene.starGain = starGain;
  scene.shadeView = shadeView;
  if (world && h) world.uniforms = { u_showLevels: { float: showLevels ? 1 : 0 }, u_shadeView: { float: shadeView ? 1 : 0 }, u_coverLevel: { float: objectLevel(h.index) }, u_toSun: { vec3: [toSun[0], toSun[1], toSun[2]] }, u_airNear: { float: airNear }, ...(plannedMaterials && h === planned ? { u_flowTime: { float: flowTime } } : {}), ...(cloudSlot && h === planned ? { u_eyePos: { vec3: [scene.eye[0], scene.eye[1], scene.eye[2]] } } : {}) };
  if (settlementLayer) {
    // In the body's frame while Hearth is the body near (its turning frame is the frame of the picture then).
    settlementLayer.update(inh!.plan(), h === planned ? eye : null, [o[0], o[1], o[2]]);
    structureEye = h === planned ? eye : null;
    applyFixedHits();
  }
  const details = inh?.details();
  if (details) details.layer.uniforms = { u_toSun: { vec3: [toSun[0], toSun[1], toSun[2]] }, u_airNear: { float: airNear }, u_eyePos: { vec3: [scene.eye[0], scene.eye[1], scene.eye[2]] } };
  syncClimate(toSun);
  placeNames();
}

/** The weather under the eye (stage 2), for the panel. */
let weatherHere: { biome: number; cover: number; rain: number; snow: number } | null = null;
/** The place under the eye last probed for the weather, kept while the eye's direction does not change. */
let placeCache: { plan: WorldPlan; dir: Vec3; place: ReturnType<typeof climatePlaceAt> } | null = null;

/**
 * From stage 2: Hearth's cloud cover by place while Hearth is the body of radial up, none otherwise; the weather at
 * the place under the eye (`weatherAt`), faded with height; and the cloud shell placed on the body.
 */
function syncClimate(toSun: Vec3): void {
  if (!cloudSlot || !cloudShell) return;
  const timeS = tick / CLOCK_HZ;
  env.time.set(timeS);
  const plan = inh?.plan() ?? null;
  const onHearth = attachedSurface() === planned;
  if (!plan || !onHearth || !showClouds) {
    cloudSlot.params = { ...NO_CLOUD_FIELD };
    cloudShell.opacity = 0;
    env.weather = { ...DEFAULT_WEATHER };
    weatherHere = null;
    if (!plan || !onHearth) return;
  } else cloudSlot.params = hearthCloudField(timeS);
  // The body's turning frame → render space (its 3 × 3 part), and the eye's direction in the body's frame.
  const m = planned.far.model;
  const p = sub(rig.position, centers[planned.index + 1]!);
  const d = unit(p);
  const dir: Vec3 = [m[0]! * d[0] + m[1]! * d[1] + m[2]! * d[2], m[4]! * d[0] + m[5]! * d[1] + m[6]! * d[2], m[8]! * d[0] + m[9]! * d[1] + m[10]! * d[2]];
  const R = planned.spec.radiusM;
  const altitude = len(p) - R;
  // One probe of the ground per change of the place under the eye (none while the eye stands), shared by both.
  const pc = placeCache;
  if (!pc || pc.plan !== plan || pc.dir[0] !== dir[0] || pc.dir[1] !== dir[1] || pc.dir[2] !== dir[2]) placeCache = { plan, dir, place: climatePlaceAt(plan, dir) };
  const place = placeCache!.place;
  const w = weatherAt(plan, dir, timeS, place);
  weatherHere = { biome: place.biome, cover: showClouds ? w.cloudCover : 0, rain: w.precipitationKind === 'rain' ? w.precipitation : 0, snow: w.precipitationKind === 'snow' ? w.precipitation : 0 };
  if (!showClouds) return;
  // Cloud cover and fog fade out between one and two shell heights, the falling rain or snow between 1.5 and 2 km,
  // wet ground and fresh snow from 20 to 30 km.
  const clouds = 1 - smooth((altitude - CLOUD_SHELL_M) / CLOUD_SHELL_M);
  const fall = 1 - smooth((altitude - 1500) / 500);
  const ground = 1 - smooth((altitude - 20_000) / 10_000);
  env.weather = {
    cloudCover: w.cloudCover * clouds,
    fog: w.fog * clouds,
    precipitation: w.precipitation * fall,
    precipitationKind: w.precipitationKind,
    snowCover: w.snowCover * ground,
    wetness: w.wetness * ground,
  };
  const f = planned.far;
  cloudShell.center = [f.center[0], f.center[1], f.center[2]];
  cloudShell.baseRadiusM = R;
  cloudShell.light = [toSun[0], toSun[1], toSun[2]];
  cloudShell.toField.set([m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!]);
  cloudShell.opacity = 1;
}

/** Names of the biomes, for the panel. */
const BIOME_NAMES = ['sea', 'ice', 'tundra', 'taiga', 'forest', 'meadow', 'dry land', 'rocks'] as const;

// Before every other step of the frame: the time, the camera, the frames, and what follows from them.
renderer.beforeFrame.unshift(() => {
  const now = performance.now();
  const gap = lastFrameMs > 0 ? now - lastFrameMs : 0;
  // Real time, but never more than a tenth of a second per frame, and nothing after a rest of the loop.
  const dt = measuring || gap > 250 ? 0 : Math.min(0.1, gap / 1000);
  if (!measuring) {
    lastFrameMs = now;
    meter.begin(now);
    // The frame before this one is complete now: its times belong to the flight's report.
    if (flight && report && flight.previous) recordFrame(report, flight);
  }
  // With the generator on the main thread: one of the coarsest cells per frame.
  const waiting = measuring ? undefined : rootQueue.shift();
  if (waiting) rootReady(waiting.s, waiting.face, generateBodyCell(waiting.s.packed, { face: waiting.face, level: ROOT_LEVEL, x: 0, y: 0 }));

  // The time of the system, in whole ticks.
  const before = tick;
  if (!scripted && !measuring) tick += Math.round(dt * rate * CLOCK_HZ);
  system.setTick(tick, CLOCK_HZ);
  refresh();
  if (tick !== before) dragAlong((tick - before) / CLOCK_HZ);

  // The camera.
  if (!measuring) {
    if (pendingFlight && !flight && loaded()) {
      pendingFlight = false;
      nextStop();
    }
    if (touring && !flight && !pendingFlight && !scripted) {
      tourWaitS -= dt;
      if (tourWaitS <= 0 && loaded()) nextStop();
    }
    if (river) applyRiverFlight(river, dt);
    else if (flight) {
      const f = flight;
      if (!f.held) f.t += dt;
      applyFlight(f, dt);
      if (!f.held && f.t >= flightSeconds(f.legs)) stopFlight(true);
    } else if (!scripted) input.step();
    if (plannedMaterials) flowTime = scripted ? 0 : flowTime + (rate > 0 ? dt : 0);
  }
  updateFrames();
  syncView();
  // The details near the camera: only while Hearth's own surface is streamed, where the picture is in its turning frame.
  if (inh) inh.frame(world && worldOf === planned ? rig.position : null, tick / CLOCK_HZ);
  lightsLayer?.update(world && worldOf === planned ? rig.position : null);
  if (flight || (river && !river.held) || touring || rootsLeft > 0 || (rate > 0 && !scripted) || !(inh?.details()?.settled() ?? true)) engine.invalidate();
});

/** Average time of a frame of the current view in ms, with the graphics work finished (blocks for the measurement). */
function measureFrame(count = 30): number {
  measuring = true;
  const ms = renderer.benchmark(rig, count);
  measuring = false;
  // The frames of the measurement are not frames of the loop.
  meter.previousAt = 0;
  lastFrameMs = 0;
  return ms;
}

// --- Names, keys, panel, URL -----------------------------------------------------------------------------------------
const hud = document.querySelector<HTMLDivElement>('#hud')!;
const panel = document.querySelector<HTMLPreElement>('#panel')!;
const labels = document.querySelector<HTMLDivElement>('#labels')!;
const names: { index: number; radiusM: number; el: HTMLSpanElement; shown: boolean }[] = system.bodies.map((b) => {
  const el = document.createElement('span');
  el.textContent = b.name;
  el.style.display = 'none';
  labels.append(el);
  return { index: b.index, radiusM: b.radius, el, shown: false };
});

/** Moves the names to their bodies. A name is shown while its body is small in the picture. */
function placeNames(): void {
  const o = renderer.worldOrigin;
  const forward = rig.axes().forward;
  const eye = rig.eye();
  for (const n of names) {
    const c = sub(centers[n.index]!, o);
    const v = sub(c, eye);
    const d = len(v);
    const show = showNames && dot3(v, forward) > 0 && n.radiusM / d < 0.03;
    if (show) {
      const [x, y] = rig.project(c);
      n.el.style.transform = `translate(${(x / rig.dpr).toFixed(1)}px, ${(y / rig.dpr - 6).toFixed(1)}px)`;
    }
    if (show !== n.shown) {
      n.shown = show;
      n.el.style.display = show ? '' : 'none';
    }
  }
}

/** Goes to the next slower or faster rate of the time. */
function changeRate(step: number): void {
  const i = RATES.indexOf(rate as (typeof RATES)[number]);
  rate = RATES[Math.min(RATES.length - 1, Math.max(0, (i < 0 ? 1 : i) + step))]!;
}
let rateBeforePause = 1;
const flyKey = (goal: number) => (): void => {
  stopFlight(false);
  touring = false;
  startFlight(goal);
};
// Movie mode (key V, `movie=1`): a clean screen for filming. The panel, the line at the bottom, the names and the
// cursor are hidden and the tour flies on from stop to stop; V again (or Escape) brings everything back.
function setMovie(on: boolean): void {
  document.body.classList.toggle('movie', on);
  if (on) {
    touring = true;
    if (!flight && !river) nextStop();
  } else touring = false;
}
const KEYS: Record<string, () => void> = {
  Digit0: flyKey(0),
  ...Object.fromEntries(surfaces.map((s) => [`Digit${s.index + 1}`, flyKey(s.index + 1)])),
  KeyF: () => (flight ? stopFlight(false) : nextStop()),
  Escape: () => {
    river = null;
    stopFlight(false);
    document.body.classList.remove('movie');
  },
  Comma: () => changeRate(-1),
  Period: () => changeRate(1),
  KeyP: () => {
    if (rate > 0) rateBeforePause = rate;
    rate = rate > 0 ? 0 : rateBeforePause;
  },
  KeyO: () => void (showPaths = !showPaths),
  KeyN: () => void (showNames = !showNames),
  KeyL: () => void (showLevels = !showLevels),
  KeyB: () => void (benchMs = measureFrame()),
  KeyH: () => panel.classList.toggle('hidden'),
  KeyM: () => void (scene.showMarks = inh !== null && !scene.showMarks),
  KeyR: () => (river ? void (river = null) : void startRiverFlight()),
  KeyC: () => void (showClouds = !showClouds),
  KeyG: () => void goToSite(siteAt + 1),
  KeyX: () => void strikeView(),
  KeyJ: () => void (shadeView = stage >= STAGE.shade && !shadeView),
  KeyV: () => setMovie(!document.body.classList.contains('movie')),
};
window.addEventListener('keydown', (e) => {
  const k = KEYS[e.code];
  if (k && !e.repeat) (k(), engine.invalidate());
});

const fmt = (v: number, d = 0): string => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const metres = (m: number): string => (Math.abs(m) < 1000 ? `${fmt(m, 1)} m` : `${fmt(m / 1000, Math.abs(m) < 100_000 ? 2 : Math.abs(m) < 10_000_000 ? 1 : 0)} km`);
const mb = (b: number): string => `${fmt(b / MB)} MB`;

/** Where the camera is, in words. */
function placeText(): string {
  const s = attachedSurface();
  if (!s) return `between the bodies, ${metres(len(sub(centers[0]!, rig.position)))} from the sun`;
  if (!near) return `${metres(len(rig.position) - s.spec.radiusM)} from ${s.spec.name}`;
  const [lat, lon] = latLonOf(unit(rig.position));
  return `${s.spec.name}  lat ${fmt(lat, 3)}°  lon ${fmt(lon, 3)}°`;
}

/** The one line that is always shown: where, height, speed, patches, time of a frame, GPU memory. */
function hudText(): string {
  const s = world ? world.stats() : null;
  const speed = len(rig.velocity);
  // The real time between two animation frames of the page (a stall of the main thread shows in it), and the main
  // thread's part of the engine's frame.
  const frame = rafGap.ms > 0 ? `${rafGap.ms.toFixed(1)} ms (cpu ${meter.cpuMs.toFixed(1)})` : `cpu ${meter.cpuMs.toFixed(1)} ms`;
  const at = attachedSurface();
  return [
    at ? at.spec.name : 'system',
    `height ${metres(rig.clearance)}`,
    `speed ${metres(speed)}/s`,
    `time ×${rate}`,
    `patches ${s ? `${s.cellsVisible} of ${s.drawn}` : '–'}`,
    `frame ${frame}${benchMs > 0 ? `, measured ${benchMs.toFixed(1)} ms` : ''}`,
    `GPU ${mb(engine.device.memory().total)}`,
    ...(inh ? [planStatus(inh)] : []),
  ].join('  ·  ');
}

function reportText(r: FlightReport): string {
  const ok = (good: boolean): string => (good ? 'ok' : 'OVER');
  return [
    `flight to ${r.goal} ${r.finished ? 'finished' : flight ? 'running' : 'stopped'}  ${fmt(r.seconds, 1)} s  ${r.frames} frames`,
    `  frame  ${r.intervalMsMean.toFixed(1)} ms mean, ${r.intervalMsWorst.toFixed(1)} worst between frames (${r.framesOverBudget} over ${BUDGET.frameMs} ms)   cpu ${r.cpuMsMean.toFixed(1)} mean, ${r.cpuMsWorst.toFixed(1)} worst`,
    `  GPU    peak ${fmt(r.gpuMbPeak)} MB of ${BUDGET.gpuMb} MB ${ok(r.gpuMbPeak < BUDGET.gpuMb)}   patches peak ${r.patchesPeak} drawn, ${r.cellsPeak} loaded   holes ${r.holesPeak}`,
    ...(r.endFrameMs > 0 ? [`  frame at the end, graphics work finished: ${r.endFrameMs.toFixed(1)} ms ${ok(r.endFrameMs < BUDGET.frameMs)}`] : []),
  ].join('\n');
}

function panelText(): string {
  const s = world ? world.stats() : null;
  const r = renderer.lastStats;
  const m = engine.device.memory();
  const o = renderer.worldOrigin;
  return [
    `system  seed ${seed}  time ${fmt(tick / CLOCK_HZ, 1)} s ×${rate}  depth ${renderer.depthMode}  ${rootsLeft > 0 ? `bodies: ${rootsLeft} cells to go` : `${surfaces.length} bodies`}`,
    `place   ${placeText()}   frame "${frames.name(drawFrame)}"  origin ${fmt(o[0])}, ${fmt(o[1])}, ${fmt(o[2])}`,
    s
      ? `cells   MESHED ${s.states.MESHED}  RESIDENT ${s.states.RESIDENT}  drawn ${s.drawn}/${s.wanted} wanted  holes ${s.holes}  visible ${s.cellsVisible}  behind the horizon ${s.horizonCulled}`
      : `cells   no surface is streamed here; every body is drawn from its six coarsest cells`,
    s ? `work    in flight ${s.inFlight}  queued ${s.queued}  done ${s.completed}  failed ${s.failed}  evicted ${s.evicted}   ${providerName}` : `work    ${providerName}`,
    `memory  ${s ? `cpu ${mb(s.cpuBytes)}  gpu cells ${mb(s.gpuBytes)}  ` : ''}buffers ${mb(m.buffers)}  textures ${mb(m.textures)}  targets ${mb(m.targets)}${s ? `   detail ${fmt(s.detail * 100)} %   ${s.settled ? 'settled' : 'streaming…'}` : ''}`,
    `draw    ${r.drawCalls} draws  ${fmt(r.triangles)} tris  shadow ${r.shadowDrawCalls} draws  ${engine.loop.fps ? `${engine.loop.fps.toFixed(0)} fps` : 'idle'}`,
    ...(report ? [reportText(report)] : []),
    ...(inh && plannedB ? [worldLine(inh, plannedB)] : []),
    ...(inh && sitesLine(inh) ? [sitesLine(inh)!] : []),
    ...(inh && routesLine(inh) ? [routesLine(inh)!] : []),
    ...(cloudSlot ? [climateLine()] : []),
    ...(inh?.life() ? [lifeLine(inh.life()!)] : []),
    ...(note ? [note] : []),
    `${surfaces.map((x) => `${x.index + 1} ${x.spec.name}`).join(' · ')} · 0 system · F next stop · WASD fly · E/Q up/down · Shift fast · drag look · wheel speed`,
    `, . time slower/faster · P pause · O paths · N names · L levels · B measure · H hide${inh ? ' · M plan · R river flight' : ''}${cloudSlot ? ' · C clouds' : ''}${settlementLayer ? ' · X strike the structure in the middle of the view' : ''}${stage >= STAGE.shade ? ' · J shade only' : ''}`,
  ].join('\n');
}

/** Stage 2: the biome under the eye, the cloud cover and the rain or snow there. */
function climateLine(): string {
  const w = weatherHere;
  if (!w) return `weather ${showClouds ? 'only on Hearth' : 'clouds off (C)'}`;
  const fall = w.snow > 0.01 ? `snow ${fmt(w.snow * 100)} %` : w.rain > 0.01 ? `rain ${fmt(w.rain * 100)} %` : 'no precipitation';
  return `weather ${BIOME_NAMES[w.biome] ?? '?'}  cloud cover ${fmt(w.cover * 100)} %  ${fall}${showClouds ? '' : '  (clouds off, C)'}`;
}

let lastHash = '';
setInterval(() => {
  hud.textContent = hudText();
  if (loader) {
    const st = world ? world.stats() : null;
    // Done of the wanted cells: every wanted cell is either resident, in flight or waiting in the queue.
    const cells = st ? { wanted: st.wanted, done: Math.max(0, st.wanted - st.queued - st.inFlight) } : null;
    loader.update({ planDone: planSettled, cells, settled: loaded(), hidden: scripted });
  }
  if (!panel.classList.contains('hidden')) panel.textContent = panelText();
  // Once after a finished flight, when the view has loaded again: a frame with the graphics work finished.
  if (report && report.finished && report.endFrameMs === 0 && !flight && !scripted && loaded()) report.endFrameMs = measureFrame();
  if (flight || scripted) return;
  const keep = ['pace', 'px', 'cells', 'gpu'].filter((k) => q.has(k)).map((k) => `&${k}=${q.get(k)}`).join('');
  const s = home();
  let where = '';
  if (s) {
    const [lat, lon] = latLonOf(unit(rig.position));
    const v = rig.state();
    where = `&body=${s.spec.name}&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&alt=${rig.clearance.toFixed(1)}&yaw=${v.yawDeg.toFixed(1)}&pitch=${v.pitchDeg.toFixed(1)}`;
  }
  // The time is written in whole seconds while it runs, so the address does not change with every frame.
  const t = rate > 0 ? Math.floor(tick / CLOCK_HZ / 10) * 10 : tick / CLOCK_HZ;
  const h = `seed=${seed}${where}&t=${t}&rate=${rate}${src !== 'workers' ? `&src=${src}` : ''}${showLevels ? '&levels=1' : ''}${showPaths ? '' : '&orbits=0'}${showNames ? '' : '&names=0'}${q.has('depth') ? `&depth=${depth}` : ''}${q.has('world') ? `&world=${stage}` : ''}${scene.showMarks ? '&map=1' : ''}${cloudSlot && !showClouds ? '&clouds=0' : ''}${showDetails ? '' : '&details=0'}${showLife ? '' : '&life=0'}${keep}`;
  if (h !== lastHash) {
    lastHash = h;
    history.replaceState(null, '', `#${h}`);
  }
}, 250);

// --- Script interface (tools/shot/shot.mjs) --------------------------------------------------------------------------
interface ViewSpec {
  name?: string;
  /** Name of a body; without it the view of the whole system. */
  body?: string;
  lat?: number;
  lon?: number;
  /** Metres above the surface. */
  height?: number;
  yawDeg?: number;
  pitchDeg?: number;
  /** Look at the centre of the body instead of along `yawDeg` and `pitchDeg`. */
  lookAtBody?: boolean;
  /** Time of the system in seconds. */
  time?: number;
  levels?: boolean;
  /** Stage 5: show the shade of the relief alone. */
  shadeView?: boolean;
  overlay?: boolean;
  /** Draw the marks of the plan of the world. */
  map?: boolean;
  /** A point to look at, metres in the body's own frame (after the place; instead of `yawDeg` and `pitchDeg`). */
  toward?: [number, number, number];
  /** A pose of the flight along the river, 0–1, instead of the place. */
  riverFlight?: number;
}
const nextTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Renders frames until the bodies are there and the streaming has settled. */
async function settle(limit = 6000): Promise<boolean> {
  for (let i = 0; i < limit; i++) {
    engine.renderNow();
    if (loaded()) {
      engine.renderNow();
      return true;
    }
    await nextTask();
  }
  return false;
}
/** `routeStats` per plan, for the script interface. */
const routeStatsOf = new WeakMap<WorldPlan, RouteStats>();
(window as unknown as { __wh: unknown }).__wh = {
  kind: 'free',
  // With a plan: also once it is there (or has failed) and every worker holds it.
  ready: Promise.all([new Promise<void>((resolve) => requestAnimationFrame(() => (engine.renderNow(), resolve()))), inh ? inh.whenReady.catch(() => {}) : null, hitOnce && settlementLayer ? hitApplied : null]).then(() => engine.renderNow()),
  presets: (): ViewSpec[] => [
    { name: 'system-whole' },
    ...surfaces.flatMap((s): ViewSpec[] => [
      { name: `system-${s.spec.name.toLowerCase()}-far`, body: s.spec.name, lat: 20, lon: 30, height: 4 * s.spec.radiusM, lookAtBody: true },
      { name: `system-${s.spec.name.toLowerCase()}-surface`, body: s.spec.name, lat: 20, lon: 30, height: LAND_M, pitchDeg: 3 },
    ]),
    // The views of the plan, each at a time with the sun high over its place (the clock is put back after the search).
    ...(inh?.plan()
      ? planViews(inh.plan()!, (d) => {
          const t = daylightTime(system, planned.body, d);
          system.setTick(tick, CLOCK_HZ);
          return t;
        })
      : []),
    // Stage 1: the views of the water, from the plan and its main stem.
    ...(inh?.plan() && plannedB?.stem()
      ? waterViews(inh.plan()!, plannedB.stem()!, (d) => {
          const t = daylightTime(system, planned.body, d);
          system.setTick(tick, CLOCK_HZ);
          return t;
        })
      : []),
    // Stage 2: the views of the climate and the weather.
    ...(cloudSlot && inh?.plan()
      ? climateViews(inh.plan()!, (d) => {
          const t = daylightTime(system, planned.body, d);
          system.setTick(tick, CLOCK_HZ);
          return t;
        })
      : []),
    // Stage 3: the views of the settlements.
    ...(inh?.plan()?.sites
      ? siteViews(inh.plan()!, (d) => {
          const t = daylightTime(system, planned.body, d);
          system.setTick(tick, CLOCK_HZ);
          return t;
        })
      : []),
    // Stage 4: the views of the roads.
    ...(inh?.plan()?.routes
      ? routeViews(inh.plan()!, (d) => {
          const t = daylightTime(system, planned.body, d);
          system.setTick(tick, CLOCK_HZ);
          return t;
        })
      : []),
    // Stage 3: the views of the structures.
    ...(settlementLayer && inh?.plan()?.sites
      ? structureViews(inh.plan()!, (d) => {
          const t = daylightTime(system, planned.body, d);
          system.setTick(tick, CLOCK_HZ);
          return t;
        })
      : []),
    // Stage 5 (and the morning view at stage 4): the shade of the relief and the lights at night.
    ...(inh?.plan()?.routes
      ? (() => {
          const period = Math.abs(planned.body.spin.periodS) || 86_400;
          const sun = system.bodies[0]!;
          const views = shadeViews(inh.plan()!, stage, {
            periodS: period,
            toSun: (t) => {
              system.setTime(t);
              const s = system.frames.convertPoint([0, 0, 0], sun.carriedFrame, planned.body.turningFrame);
              const l = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
              return [s[0] / l, s[1] / l, s[2] / l];
            },
          });
          system.setTick(tick, CLOCK_HZ);
          return views;
        })()
      : []),
    // From stage 3: the views of the creatures, each at a pinned time.
    ...(inh?.life() && inh.plan()
      ? lifeViews(inh.plan()!, stage, (d) => {
          const t = daylightTime(system, planned.body, d);
          system.setTick(tick, CLOCK_HZ);
          return t;
        })
      : []),
    // From stage 2: the views of the details near the camera.
    ...(inh?.details() && inh.plan()
      ? detailViews(inh.plan()!, (d) => {
          const t = daylightTime(system, planned.body, d);
          system.setTick(tick, CLOCK_HZ);
          return t;
        })
      : []),
  ],
  /** Fingerprint of the water of the plan (`planHash(plan, 'water')`), or null without a plan. */
  planHash: (): string | null => inh?.report()?.hash ?? null,
  /** Stage 4: what the roads of the plan are (`routeStats`), or null below stage 4. */
  routes: (): RouteStats | null => {
    const p = inh?.plan();
    if (!p?.routes) return null;
    // Samples the ground along every road: once per plan, never on the panel's refresh.
    let st = routeStatsOf.get(p);
    if (!st) routeStatsOf.set(p, (st = routeStats(p)));
    return st;
  },
  setView: (v: ViewSpec): void => {
    scripted = true;
    loader?.hide();
    stopFlight(false);
    river = null;
    if (v.time !== undefined) {
      tick = Math.round(v.time * CLOCK_HZ);
      system.setTick(tick, CLOCK_HZ);
    }
    const s = surfaces.find((x) => x.spec.name.toLowerCase() === (v.body ?? '').toLowerCase());
    if (s) {
      placeAt(s, directionAt(v.lat ?? 0, v.lon ?? 0), v.height ?? LAND_M, v.yawDeg ?? 0, v.pitchDeg ?? 3);
      // Up is the axis of the body from 5 radii out, not the line from its centre, so "straight down" would look
      // past the body there; aim at its centre instead.
      if (v.lookAtBody) rig.lookAt(centers[s.index + 1]!);
      else if (v.toward) rig.lookAt(v.toward);
    } else placeOverview();
    if (v.riverFlight !== undefined && startRiverFlight(true)) {
      river!.t = Math.min(1, Math.max(0, v.riverFlight)) * river!.seconds;
      applyRiverFlight(river!, 0);
      updateFrames();
    }
    showLevels = v.levels ?? false;
    shadeView = stage >= STAGE.shade && (v.shadeView ?? false);
    scene.showMarks = inh !== null && (v.map ?? false);
    panel.classList.toggle('hidden', !v.overlay);
    engine.renderNow();
  },
  getView: () => ({ ...rig.state(), height: rig.clearance, body: attachedSurface()?.spec.name ?? SUN.name, near }),
  settled: async (): Promise<boolean> => {
    const ok = await settle();
    hud.textContent = hudText();
    panel.textContent = panelText();
    return ok;
  },
  isSettled: loaded,
  setTimeOfDay: (): void => {},
  /** The time of the system in seconds, or in ticks of its clock; the clock of the page then stands still. */
  setTime: (s: number): void => {
    scripted = true;
    loader?.hide();
    tick = Math.round(s * CLOCK_HZ);
    engine.renderNow();
  },
  setTick: (n: number): void => {
    scripted = true;
    loader?.hide();
    tick = Math.round(n);
    engine.renderNow();
  },
  stats: () => ({ ...renderer.lastStats, renderer: engine.device.name, seed, time: tick / CLOCK_HZ, attached: system.bodies[attached]!.name, near, streaming: world ? world.stats() : null, provider: providerName, memory: engine.device.memory(), frame: { cpuMs: meter.cpuMs, intervalMs: meter.intervalMs }, system: system.fingerprint(), plan: inh?.report() ?? null, details: inh?.details()?.stats() ?? null, life: inh?.life()?.stats() ?? null, structures: settlementLayer?.stats() ?? null }),
  /** A strike at the structure part in the middle of the view (key X); keys of the structures it changed. */
  strike: (): number[] => (engine.invalidate(), strikeView()),
  /** Hash of the damage table of the structures, or null below stage 3. */
  damageHash: (): string | null => settlementLayer?.damage.hash() ?? null,
  overlay: panelText,
  hud: hudText,
  /** Flights: to a body by name (anything else: the whole system), by the clock or at a time set by the script. */
  startFlight: (body?: string): boolean => startFlight(1 + surfaces.findIndex((x) => x.spec.name.toLowerCase() === (body ?? '').toLowerCase())) !== null,
  stopFlight: (): void => stopFlight(false),
  flightSeconds: (): number => (flight ? flightSeconds(flight.legs) : 0),
  setFlight: (t: number): void => {
    scripted = true;
    loader?.hide();
    if (!flight) return;
    flight.held = true;
    flight.t = Math.max(0, Math.min(flightSeconds(flight.legs), t));
    engine.renderNow();
  },
  flightReport: (): FlightReport | null => (report ? { ...report } : null),
  /** The flight along the main river (key R): started by the clock, or held at a share 0–1 by the script. */
  startRiverFlight: (): boolean => startRiverFlight(),
  setRiverFlight: (t01: number): void => {
    scripted = true;
    loader?.hide();
    if (!river && !startRiverFlight(true)) return;
    river!.held = true;
    river!.t = Math.min(1, Math.max(0, t01)) * river!.seconds;
    engine.renderNow();
  },
  measureFrame,
};
engine.start();
