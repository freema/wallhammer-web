// Endless world on Wallhammer Web: noise terrain without edges, streamed in quadtree cells around the camera. Cells
// are generated in Web Workers (or read from baked files), uploaded within a time budget per frame and drawn relative
// to a render origin that follows the camera, so the world looks the same at 10,000 km from the origin as at it.
//
// URL hash: #seed=7&x=0&z=0&yaw=30&pitch=14&dist=260&hour=15&w=clear&src=workers&levels=0
//   src: workers (default), main (main-thread generator within a frame budget) or files (baked cells, see README)
// Controls: WASD fly, Shift faster, drag orbits, wheel changes the height, [ ] move the hour, L shows cell levels,
// H hides this panel.
// cam=free in the hash swaps the orbit camera for the engine's free camera (see free-camera.ts): W A S D fly along the
// view, E / Q up and down, drag looks around, the wheel changes the speed; alt is the start height above the surface.
// follow=1 (or the key F) makes the free camera hold its height above the surface while it moves.
// N in the free camera switches the mark mode (dev server only): a click pins a note to the terrain, kept by the dev
// server's store; marks=1 turns the marks on in a page driven by a script, marks=0 hides the pins.
// lod=smooth in the hash switches on smooth levels of detail (off by default): levels are chosen by the error on the
// screen within a budget of cells (px: tolerance in pixels, default 2; cells: the budget, default 800) and the terrain
// blends between levels instead of jumping. Baked files of this mode live in their own folder (see README).
// depth=reversed|logarithmic, origin=all and scene=precision in the hash switch on the renderer's depth modes, the
// render origin that also follows the height, and the precision test scene (see precision-scene.ts). All off by default.
// shadows=cascades in the hash switches the renderer's shadow map to several maps around the eye (sharp near, reaching
// as far as the shadow distance); shadows=snapped to one map fixed to the world's texel grid. Off by default.
// strip=1 in the hash adds the strips of strips.ts (off by default): it implies lod=smooth and cells from the workers
// (or src=main), with the generator that cuts the ground under the strips and adds their meshes.
// dmg=1 in the hash adds small structures of blocks that a click breaks (structures.ts; off by default). It implies
// lod=smooth and cells from the workers (or src=main); with strip=1 the strips win and dmg is ignored. The damage
// state is one `CellStates` store (cap=<n>: its ceiling in units, default 2000), kept in the hash as d=<text>; the
// cells that draw a changed structure are refreshed in place. R puts every structure back.
// The clouds are the engine's volumetric clouds (a layer from 1.5 to 4 km) in place of the sky's flat deck, and their
// shadows come from the engine's cloud shadow texture. vol=0 in the hash switches both off: the sky's flat deck and the
// shadows computed per fragment, as before.

import { DEFAULT_WEATHER, PerspectiveOrbitRig, definePalette } from 'wallhammer-web';
import type { WeatherState } from 'wallhammer-web';
import type { Material } from 'wallhammer-web/render';
import { bindFreeInput, fetchBytes, trackHeldKeys, workersAvailable } from 'wallhammer-web/platform';
import { cellId, cellKey, shapeHash } from 'wallhammer-web/gen-core';
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import { DEFAULT_STREAMING, FileCellProvider, GeneratorCellProvider, encodeCell, pixelsPerRadian } from 'wallhammer-web/world';
import type { CellEdits, CellProvider, StreamingConfig, Ticket } from 'wallhammer-web/world';
import { StreamedWorld, WorkerCellProvider, createEngine, heightPick, installEngineMarking, viewTickets } from 'wallhammer-web/runtime';
import { CellStates, applyEventToAll, decodeCellStates, raycastParts } from 'wallhammer-web/sim/destruction';
import { hashBytes } from 'wallhammer-web/sim';
import { DAMAGE, entryRung } from 'wallhammer-web/base';
import { DEMO_EVENTS, HOME_LEVEL, STRUCTURE_MIN_LEVEL, cellStructures, demoEvent, drawingCells, findDemoStructure, generateDamageCell, structureEvent } from './structures.ts';
import { pillarMesh, rockMesh, treeMesh } from './shapes.ts';
import { FREE_HELP, FREE_PRESETS, createFreeRig, freeHash, placeFreeRig } from './free-camera.ts';
import { PRECISION_HELP, PRECISION_PRESETS, PRECISION_START, PrecisionScene, precisionOptions } from './precision-scene.ts';
import { PROP_MATERIAL, PROP_MORPH_MATERIAL, STRIP_MATERIAL, STRUCTURE_MATERIAL, TERRAIN_MATERIAL, TERRAIN_MORPH_MATERIAL } from './shaders.ts';
import { endlessStrips, generateStripCell, stripSurfaceHeight } from './strips.ts';
import { FACE, LEAF_LEVEL, ROOT_LEVEL, SHAPE, SMOOTH_MIN_SPLIT_EDGES, SMOOTH_SELECTION, SMOOTH_STREAMING, generateCell, generateSmoothCell, surfaceHeight as plainSurfaceHeight } from './terrain.ts';

const q = new URLSearchParams(location.hash.slice(1));
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const seed = Math.round(num('seed', 7));
/** The strips (strip=1): smooth levels from the generator with the strips. */
const stripOn = q.get('strip') === '1';
/** The damage demo (dmg=1): structures of blocks in a damage state that survives leaving and coming back. */
const dmgOn = q.get('dmg') === '1' && !stripOn;
const demo = dmgOn ? findDemoStructure(seed) : null;
/** The damage state of every structure: the authority; cells are a view of it. */
const dmgCap = Math.max(1, Math.round(num('cap', 2000)));
let store = new CellStates({ maxUnits: dmgCap });
if (dmgOn && q.has('d')) store = decodeCellStates(q.get('d') ?? '', { maxUnits: dmgCap }).store;
/** What a provider hands the generator: the store's text for the home cells under a cell that draws structures. */
const dmgEdits: CellEdits = (c) => (c.level >= STRUCTURE_MIN_LEVEL ? store.text(c) : '');
/** Height of the visible surface: with the strips the ground is cut and filled under them. */
const surfaceHeight = (s: number, x: number, z: number): number => (stripOn ? stripSurfaceHeight(s, x, z) : plainSurfaceHeight(s, x, z));
const WEATHER: Record<string, Partial<WeatherState>> = {
  clear: {},
  clouds: { cloudCover: 0.5 },
  rain: { cloudCover: 0.85, precipitation: 0.6, precipitationKind: 'rain', wetness: 0.8, fog: 0.25 },
  snow: { cloudCover: 0.75, precipitation: 0.6, precipitationKind: 'snow', snowCover: 0.8, fog: 0.2 },
  fog: { cloudCover: 0.3, fog: 0.6 },
};
let weatherName = q.get('w') ?? 'clear';
/** The volumetric clouds and the cloud shadow texture (on unless vol=0). */
const volOn = q.get('vol') !== '0';

// --- Engine ----------------------------------------------------------------------------------------------------------
// The free camera is an option (cam=free); without it nothing below differs from the orbit camera alone.
// Depth mode, render origin axes and the precision test scene (depth=, origin=, scene=precision). The scene brings
// the free camera and its own start place; without these keys every value below is what it was.
const precision = precisionOptions(q);
// Shadow mode (shadows=cascades or shadows=snapped). Without the key the renderer gets exactly the options it had.
const shadowMode = q.get('shadows') === 'cascades' ? 'cascades' : q.get('shadows') === 'snapped' ? 'snapped' : null;
const start = precision.scene ? PRECISION_START : { x: 0, z: 0, alt: 60, pitchDeg: 14 };
const free = q.get('cam') === 'free' || precision.scene ? createFreeRig(seed, { x: num('x', start.x), z: num('z', start.z), height: num('alt', start.alt), yawDeg: num('yaw', 30), pitchDeg: num('pitch', start.pitchDeg), follow: q.get('follow') === '1' }) : null;
const orbit = new PerspectiveOrbitRig({ fovYDeg: 50, minDistance: 40, maxDistance: 4000, minPitchDeg: 2, maxPitchDeg: 80 }, { yawDeg: num('yaw', 30), pitchDeg: num('pitch', 14), distance: num('dist', 260) });
const engine = createEngine({
  canvas: document.querySelector<HTMLCanvasElement>('#view')!,
  view: free ?? orbit,
  palette: definePalette({ sky: '#9db8cc' }),
  background: [0x9d / 255, 0xb8 / 255, 0xcc / 255],
  renderer: { shadowSoftnessM: 1.2, shadowDistanceM: 2500, shadowMapSize: 4096, ...(precision.depth !== 'standard' ? { depth: precision.depth } : {}), ...(shadowMode ? { shadows: { mode: shadowMode } } : {}) },
  environment: { mode: 'day', site: { latitudeDeg: 47, longitudeDeg: 0, dayOfYear: 200, utcOffsetHours: 0 }, hour: num('hour', 15), hoursPerSecond: 0.5, weather: WEATHER[weatherName] ?? {}, wind: { fromDeg: 240, speedMs: 6 }, clouds: { sizeM: 2400 } },
  orbitControls: !free,
  precipitation: true,
  sky: { hazeDistanceM: 7000, cloudHeightM: 2500 },
  ...(volOn ? { cloudVolume: true, cloudShadows: true } : {}),
});
const { renderer, env } = engine;
/** The orbit rig. With the free camera it is not the engine's view and only keeps the orbit code below typed. */
const view = orbit;
env.day.pause();

// --- Streaming -------------------------------------------------------------------------------------------------------
// The strips have no baked files: they come from the workers or the main thread.
const src = (stripOn || dmgOn) && q.get('src') === 'files' ? 'workers' : (q.get('src') ?? (workersAvailable() ? 'workers' : 'main'));
// Smooth levels of detail (lod=smooth). Without it nothing below differs: the same generator, materials and settings.
const smooth = q.get('lod') === 'smooth' || stripOn || dmgOn;
const provider: CellProvider = stripOn
  ? src === 'main' || !workersAvailable()
    ? new GeneratorCellProvider(seed, generateStripCell)
    : new WorkerCellProvider(new URL('./strip-cell-worker.ts', import.meta.url), seed)
  : dmgOn
    ? src === 'main' || !workersAvailable()
      ? new GeneratorCellProvider(seed, generateDamageCell, dmgEdits)
      : new WorkerCellProvider(new URL('./damage-cell-worker.ts', import.meta.url), seed, undefined, dmgEdits)
  : src === 'files'
    ? new FileCellProvider(`${import.meta.env.BASE_URL}cells/${seed}`, fetchBytes, smooth ? { shapeHash: shapeHash(SHAPE) } : {})
    : src === 'main' || !workersAvailable()
      ? new GeneratorCellProvider(seed, smooth ? generateSmoothCell : generateCell)
      : new WorkerCellProvider(smooth ? new URL('./smooth-cell-worker.ts', import.meta.url) : new URL('./cell-worker.ts', import.meta.url), seed);
const baseConfig: StreamingConfig = { ...DEFAULT_STREAMING, shape: SHAPE, face: FACE, rootLevel: ROOT_LEVEL, leafLevel: LEAF_LEVEL, maxInFlight: 12, memoryBudgetBytes: 256 * 1024 * 1024 };
const config: StreamingConfig = smooth
  ? { ...baseConfig, ...SMOOTH_STREAMING, screenError: { ...SMOOTH_SELECTION, maxErrorPx: Math.max(0.25, num('px', SMOOTH_SELECTION.maxErrorPx)), maxCells: Math.max(32, Math.round(num('cells', SMOOTH_SELECTION.maxCells))) } }
  : baseConfig;
const [terrain, prop] = (smooth ? [TERRAIN_MORPH_MATERIAL, PROP_MORPH_MATERIAL] : [TERRAIN_MATERIAL, PROP_MATERIAL]).map((m) => renderer.material(m)) as [Material, Material];
/**
 * Smooth levels measure the error in CSS pixels of this view (both cameras have a 50° field of view). The view never
 * counts as smaller than the one that splits a cell at `SMOOTH_MIN_SPLIT_EDGES` edges: below that the blend between
 * levels has no room to finish before the next level takes over. The predicted point ahead only preloads: the levels
 * on the screen follow the viewer alone, as the blend assumes.
 */
const screenTickets = (t: Ticket[]): Ticket[] => {
  const se = config.screenError;
  if (!smooth || !se) return t;
  const px = Math.max(pixelsPerRadian(engine.canvas.clientHeight || engine.canvas.height, (50 * Math.PI) / 180), (SMOOTH_MIN_SPLIT_EDGES * se.maxErrorPx) / se.errorPerEdge);
  return t.map((k) => ({ ...k, pixelsPerRadian: px, ...(k.kind === 'predict' ? { preload: true } : {}) }));
};
const world = new StreamedWorld({
  renderer,
  config,
  provider,
  ...(precision.originAxes === 'all' ? { originAxes: precision.originAxes } : {}),
  morph: smooth,
  materials: stripOn ? { terrain, prop, strip: renderer.material(STRIP_MATERIAL) } : dmgOn ? { terrain, prop, structure: renderer.material(STRUCTURE_MATERIAL) } : { terrain, prop },
  archetypes: {
    tree: { material: 'prop', lods: [{ mesh: treeMesh(true), maxDistance: 700 }, { mesh: treeMesh(false), maxDistance: 2600 }] },
    rock: { material: 'prop', lods: [{ mesh: rockMesh(true), maxDistance: 400 }, { mesh: rockMesh(false), maxDistance: 1500 }] },
    pillar: { material: 'prop', lods: [{ mesh: pillarMesh(true), maxDistance: 3500 }, { mesh: pillarMesh(false), maxDistance: 20000 }] },
  },
  uploadMsPerFrame: 4,
  blockingMsPerFrame: 8,
  onActivity: () => engine.invalidate(),
  ...(dmgOn ? { onResident: (cell: CellId, _m: unknown, content: CellContent) => noteResident(cell, content) } : {}),
});
engine.add(world);
// The precision test scene (scene=precision): two objects fixed to the world, drawn after the streamed cells.
const precisionScene = precision.scene && free ? new PrecisionScene({ renderer, rig: free, origin: () => world.origin }) : null;
if (precisionScene) engine.add(precisionScene);
let showLevels = num('levels', 0) === 1;
const applyLevels = (): void => void (world.uniforms = { u_showLevels: { float: showLevels ? 1 : 0 } });
applyLevels();

// --- Damage demo (dmg=1) ---------------------------------------------------------------------------------------------
// The store is the authority. A hit commits to it and refreshes every cell of levels 7–9 that draws a changed (or
// ruined) structure: drawn cells keep their picture until the new content is swapped in, others are built again when
// wanted. A cell's bytes depend only on (seed, cell, edits text), so leaving and coming back gives the same bytes.
const dmg = {
  /** Events applied so far: the n-th event gets the seed hashInts(0xd357, n). */
  events: 0,
  ruinedByCap: 0,
  refused: 0,
  /** Per cell key: how many times new content arrived and the hash of its bytes (cells that draw the demo). */
  built: new Map<string, { count: number; hash: string; content: CellContent | null }>(),
  /** While a refresh runs: the cover before it, and whether any frame drew another one. */
  swap: null as { before: string; changed: boolean } | null,
  coverChanged: null as boolean | null,
};
const demoCells = demo ? new Set(drawingCells(demo.home).map(cellKey)) : new Set<string>();

function noteResident(cell: CellId, content: CellContent): void {
  const k = cellKey(cell);
  if (!demoCells.has(k)) return;
  const b = dmg.built.get(k) ?? { count: 0, hash: '', content: null };
  // A re-upload of the same content (after leaving the GPU) is not a new build.
  if (b.content !== content) {
    b.count++;
    b.hash = hashBytes(encodeCell(content));
    b.content = content;
  }
  dmg.built.set(k, b);
}

const coverKey = (): string => world.manager.drawn().map(cellKey).join(';');
// After the streaming step of every frame: did the cover change while a refresh was waiting for its content?
renderer.beforeFrame.push(() => {
  if (!dmg.swap) return;
  if (coverKey() !== dmg.swap.before) dmg.swap.changed = true;
  if (world.manager.refreshes().pending === 0) {
    dmg.coverChanged = dmg.swap.changed;
    dmg.swap = null;
  }
});

/** Cells of levels 7–9 drawing the structures of these home cells, tracked or not. */
function refreshHomes(homes: readonly CellId[]): void {
  const cells = new Map<string, CellId>();
  for (const h of homes) for (const c of drawingCells(h)) cells.set(cellKey(c), c);
  if (!dmg.swap && world.manager.refreshes().pending === 0) dmg.swap = { before: coverKey(), changed: false };
  world.refresh(cells.values());
}

/** Applies one event (cm, in the home cell's frame) to the structures of a home cell and commits the result. */
function hitHome(home: CellId, at: (n: number) => ReturnType<typeof structureEvent>): void {
  const structures = cellStructures(seed, home);
  if (structures.length === 0) return;
  const ev = at(dmg.events++);
  const r = applyEventToAll(structures, store.of(home), ev);
  if (r.changes.length === 0) return;
  const c = store.commit(home, r.states);
  if (!c.accepted) {
    dmg.refused++;
    return;
  }
  dmg.ruinedByCap += c.ruined.length;
  refreshHomes([home, ...c.ruined.map((x) => x.cell)]);
}

/** The fixed events of the demo on the demo structure (preset act 'hit', the golden recipe uses the same). */
function hitDemo(): void {
  if (!demo) return;
  DEMO_EVENTS.forEach((_, k) => hitHome(demo.home, (n) => demoEvent(demo.structure, k, n)));
}

/** A click without a drag: the first part under the cursor among the structures within 400 m, then an event there. */
function hitAtScreen(cssX: number, cssY: number): void {
  const k = engine.canvas.width / Math.max(1, engine.canvas.clientWidth);
  const ray = (free ?? orbit).screenRay(cssX * k, cssY * k);
  const o = world.toWorld(ray.origin);
  const reach = 400;
  const lo = SHAPE.cellAt([pos.x - reach, 0, pos.z - reach], HOME_LEVEL);
  const hi = SHAPE.cellAt([pos.x + reach, 0, pos.z + reach], HOME_LEVEL);
  let best: { home: CellId; t: number; point: [number, number, number] } | null = null;
  for (let y = lo.y; y <= hi.y; y++) {
    for (let x = lo.x; x <= hi.x; x++) {
      const home = cellId(FACE, HOME_LEVEL, x, y);
      const structures = cellStructures(seed, home);
      if (structures.length === 0) continue;
      const states = store.of(home);
      const h = SHAPE.origin(home);
      // The structures' own frame: metres from the home cell's origin.
      const hit = raycastParts(structures, [o[0] - h[0], o[1], o[2] - h[2]], ray.dir, (s, p) => {
        const st = states.get(s);
        const e = st?.parts.get(p);
        return !!st && (st.ruin || (e !== undefined && entryRung(e) === DAMAGE.gone));
      });
      if (hit && (!best || hit.t < best.t)) best = { home, t: hit.t, point: hit.point };
    }
  }
  if (!best) return;
  const p = best.point;
  hitHome(best.home, (n) => structureEvent(n, p[0] * 100, p[1] * 100, p[2] * 100));
  engine.invalidate();
}

/** R: every structure back as generated. */
function clearDamage(): void {
  const homes = store.cells();
  store.clear();
  refreshHomes(homes);
}

if (dmgOn) {
  let down: [number, number] | null = null;
  engine.canvas.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
  engine.canvas.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5 && e.button === 0) {
      const rect = engine.canvas.getBoundingClientRect();
      hitAtScreen(e.clientX - rect.left, e.clientY - rect.top);
    }
    down = null;
  });
}

/** The panel line of the damage demo (also `__wh.hud()`). */
function damageLine(): string {
  if (!dmgOn || !demo) return '';
  const home = demo.home;
  const drawnBy = world.manager.drawn().find((c) => demoCells.has(cellKey(c)));
  const b = dmg.built.get(cellKey(home));
  const st = store.of(home).get(demo.structure.id);
  const state = !st ? 'intact' : st.ruin ? 'ruin' : `${st.parts.size} damaged parts`;
  return [
    `damage  changed structures ${store.structures}  units ${store.units}/${store.maxUnits}  state hash ${store.hash()}  ruins by the ceiling ${dmg.ruinedByCap}  refused hits ${dmg.refused}`,
    `demo structure  cell ${cellKey(home)} ${world.manager.state(home)}  state: ${state}  built ${b?.count ?? 0}×  content ${b?.hash || '—'}  drawn by ${drawnBy ? cellKey(drawnBy) : 'no cell'}  cover during the swap: ${dmg.coverChanged === null ? '—' : dmg.coverChanged ? 'changed' : 'unchanged'}`,
  ].join('\n');
}

// --- Camera: a target that flies over the ground (world metres, double), the orbit rig around it ---------------------
const pos = { x: num('x', demo ? demo.x : 0), z: num('z', demo ? demo.z : 0) };
const velocity: [number, number] = [0, 0];
const keys = trackHeldKeys(() => engine.invalidate());

/** Puts the rig over `pos` in render space and hands the tickets to the streaming. A function of the state only. */
function syncCamera(): void {
  world.setFocus([pos.x, 0, pos.z]);
  const ground = surfaceHeight(seed, pos.x, pos.z);
  view.target = [pos.x - world.origin[0], ground + 2, pos.z - world.origin[2]];
  // Keep the eye above the ground under it.
  let eye = world.toWorld(view.eye());
  const under = surfaceHeight(seed, eye[0], eye[2]) + 8;
  if (eye[1] < under) {
    view.target = [view.target[0], view.target[1] + (under - eye[1]), view.target[2]];
    eye = world.toWorld(view.eye());
  }
  const f = view.axes().forward;
  world.setEye(eye);
  world.setTickets(screenTickets(viewTickets(eye, eye[1] - surfaceHeight(seed, eye[0], eye[2]), [f[0], f[2]], velocity)));
  env.fogLayer = { bottomY: Math.min(0, ground - 40), topY: ground + 120 };
}

let last = 0;
function move(): void {
  const t = performance.now();
  const dt = last > 0 ? Math.min(0.1, (t - last) / 1000) : 0;
  last = t;
  const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const side = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  if (fwd === 0 && side === 0) {
    velocity[0] = velocity[1] = 0;
    last = 0;
    return;
  }
  const speed = Math.min(3000, Math.max(20, view.distance * 0.9)) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 6 : 1);
  const yaw = view.yaw;
  // Forward is the view's heading on the ground (yaw 0 looks toward −z).
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const n = Math.hypot(fwd, side);
  velocity[0] = ((fx * fwd + rx * side) / n) * speed;
  velocity[1] = ((fz * fwd + rz * side) / n) * speed;
  pos.x += velocity[0] * dt;
  pos.z += velocity[1] * dt;
  engine.invalidate();
}

// The free camera (cam=free): held keys move the rig, which keeps itself above the terrain; the streaming then gets the
// same data as from `syncCamera`. The rig's position is in world metres and its `origin` follows the render origin.
const freeInput = free ? bindFreeInput(engine.canvas, free, { onChange: () => engine.invalidate() }) : null;
function syncFree(rig: NonNullable<typeof free>): void {
  if (!scripted) freeInput?.step();
  const p = rig.position;
  pos.x = p[0];
  pos.z = p[2];
  velocity[0] = rig.velocity[0];
  velocity[1] = rig.velocity[2];
  world.setFocus([p[0], p[1], p[2]]);
  rig.origin = [world.origin[0], world.origin[1], world.origin[2]];
  const f = rig.headingDir();
  world.setEye([p[0], p[1], p[2]]);
  world.setTickets(screenTickets(viewTickets([p[0], p[1], p[2]], rig.clearance, [f[0], f[2]], velocity)));
  const ground = p[1] - rig.clearance;
  // The fog layer is given in render space: with origin=all the render origin has a height (0 otherwise).
  const oy = world.origin[1];
  env.fogLayer = { bottomY: Math.min(0, ground - 40) - oy, topY: ground + 120 - oy };
}

// Before the sky reads the eye and before the streaming step: move, then place the camera.
renderer.beforeFrame.unshift(() => {
  if (free) return syncFree(free);
  if (!scripted) move();
  syncCamera();
});

// --- Keys, overlay, URL ----------------------------------------------------------------------------------------------
const KEYS: Record<string, () => void> = {
  BracketLeft: () => env.day.set((env.day.time + 23.5) % 24),
  BracketRight: () => env.day.set((env.day.time + 0.5) % 24),
  KeyL: () => ((showLevels = !showLevels), applyLevels()),
  KeyH: () => overlay.classList.toggle('hidden'),
  // Free camera only: hold the height above the surface while moving.
  ...(free ? { KeyF: () => void (free.setup.followSurface = !free.setup.followSurface) } : {}),
  KeyP: () => precisionScene?.placeNear(),
  // Damage demo only: every structure back as generated.
  ...(dmgOn ? { KeyR: clearDamage } : {}),
};
window.addEventListener('keydown', (e) => {
  const k = KEYS[e.code];
  if (k && !e.repeat) (k(), engine.invalidate());
});

const overlay = document.querySelector<HTMLPreElement>('#overlay')!;
const fmt = (v: number, d = 0): string => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const mb = (b: number): string => `${(b / 1048576).toFixed(1)} MB`;
function generationMs(): { avg: number; jobs: number } {
  if (provider instanceof WorkerCellProvider) {
    const t = provider.pool.timing;
    return { avg: t.jobs ? t.ms / t.jobs : 0, jobs: t.jobs };
  }
  const s = world.stats();
  return { avg: s.generateMsAvg, jobs: s.completed };
}
function overlayText(): string {
  const s = world.stats();
  const r = renderer.lastStats;
  const eye = free ? free.position : world.toWorld(view.eye());
  const g = generationMs();
  const st = s.states;
  return [
    `x ${fmt(pos.x, 1)}  z ${fmt(pos.z, 1)}  eye ${fmt(eye[1])} m   origin ${fmt(world.origin[0])}, ${fmt(world.origin[2])}`,
    `cells  MESHED ${st.MESHED}  RESIDENT ${st.RESIDENT}  drawn ${s.drawn}/${s.wanted} wanted  holes ${s.holes}  visible ${s.cellsVisible}`,
    `work   in flight ${s.inFlight}  queued ${s.queued}  done ${s.completed}  stale ${s.stale}  cancelled ${s.cancelled}  failed ${s.failed}  evicted ${s.evicted}`,
    `gen    ${g.avg.toFixed(1)} ms/cell (${provider.name})   upload ${s.uploadMsAvg.toFixed(2)} ms/cell, last frame ${s.uploads} in ${s.uploadMs.toFixed(1)} ms`,
    `memory cpu ${mb(s.cpuBytes)}  gpu ${mb(s.gpuBytes)}   ${s.settled ? 'settled' : 'streaming…'}`,
    `frame  ${r.cpuMs.toFixed(1)} ms cpu  ${engine.loop.fps ? `${engine.loop.fps.toFixed(0)} fps` : 'idle'}   ${r.drawCalls} draws  ${fmt(r.triangles)} tris  (cells: ${s.drawCalls} draws, ${fmt(s.instances)} instances)`,
    ...(smooth ? [`levels smooth  tolerance ${fmt(config.screenError!.maxErrorPx, 2)} px  budget ${s.wanted}/${config.screenError!.maxCells} cells  detail ${fmt(s.detail * 100)} %${s.shapeMismatches ? `  wrong shape ${s.shapeMismatches}` : ''}`] : []),
    ...(free ? [`camera free  ${fmt(free.clearance, 1)} m above the surface  ${fmt(Math.hypot(...free.velocity), 1)} m/s (cruise ${fmt(free.speed, 1)} m/s)${free.setup.followSurface ? '  following the surface' : ''}`] : []),
    ...(precision.hash ? [`depth  ${renderer.depthMode}${renderer.depthMode !== precision.depth ? ` (asked for ${precision.depth})` : ''}   origin axes ${precision.originAxes}, origin height ${fmt(world.origin[1])} m`] : []),
    ...(precisionScene ? [precisionScene.overlayLine(), PRECISION_HELP] : []),
    ...(shadowMode ? [`shadows ${renderer.shadowMode}  map ${r.shadowMapPx} px  ${r.shadowUpdates} parts drawn this frame  ${r.shadowDrawCalls} draws  ${fmt(r.shadowTriangles)} tris`] : []),
    ...(dmgOn ? [damageLine(), 'click without dragging breaks a structure · R restores every structure'] : []),
    free ? FREE_HELP : `WASD fly · Shift fast · drag orbit · wheel height · [ ] hour · L levels · H hide`,
  ].join('\n');
}
/** The URL hash of the current view; it keeps `marks=` of the address the page was opened with. */
function viewHash(): string {
  const v = view.state();
  return `seed=${seed}&${free ? freeHash(free) : `x=${pos.x.toFixed(1)}&z=${pos.z.toFixed(1)}&yaw=${v.yawDeg.toFixed(1)}&pitch=${v.pitchDeg.toFixed(1)}&dist=${v.distance.toFixed(0)}`}&hour=${env.day.time.toFixed(2)}&w=${weatherName}${src !== 'workers' ? `&src=${src}` : ''}${showLevels ? '&levels=1' : ''}${smooth ? `&lod=smooth${q.has('px') ? `&px=${q.get('px')}` : ''}${q.has('cells') ? `&cells=${q.get('cells')}` : ''}` : ''}${precision.hash}${shadowMode ? `&shadows=${shadowMode}` : ''}${stripOn ? '&strip=1' : ''}${dmgOn ? `&dmg=1${q.has('cap') ? `&cap=${dmgCap}` : ''}${store.structures > 0 ? `&d=${store.text()}` : ''}` : ''}${volOn ? '' : '&vol=0'}${q.has('marks') ? `&marks=${q.get('marks')}` : ''}`;
}
let lastHash = '';
setInterval(() => {
  if (!overlay.classList.contains('hidden')) overlay.textContent = overlayText();
  const h = viewHash();
  if (h !== lastHash && !scripted) {
    lastHash = h;
    history.replaceState(null, '', `#${h}`);
  }
}, 250);

// --- Script interface (tools/shot/shot.mjs) --------------------------------------------------------------------------
interface ViewSpec {
  name?: string;
  x?: number;
  z?: number;
  yawDeg?: number;
  pitchDeg?: number;
  distance?: number;
  /** Free camera (cam=free) only: metres above the surface. */
  height?: number;
  hour?: number;
  levels?: boolean;
  /** Show the overlay (its numbers change from run to run, so shots meant to be identical leave it off). */
  overlay?: boolean;
  /** Fly from (x, z) to (toX, toZ) in this many frames after settling at the start, and shoot mid-flight. */
  flight?: { toX: number; toZ: number; frames: number };
  /**
   * Damage demo only, run once the view has settled (then it settles again): `hit` applies `DEMO_EVENTS` to the demo
   * structure, `forget` refreshes the cells that draw it, so the ones not on the GPU are forgotten (NONE), not cached.
   */
  act?: 'hit' | 'forget';
}
/** With dmg=1: the demo structure intact, hit, from 30 km away, back, from 700 m, and the level tints over it. */
function damagePresets(): ViewSpec[] {
  if (!demo) return [];
  const { x, z } = demo;
  const near = { x, z, yawDeg: 35, pitchDeg: 24, distance: 60 };
  return [
    { name: 'dmg-intact', ...near },
    { name: 'dmg-hit', ...near, act: 'hit' },
    { name: 'dmg-away', x: x + 30_000, z, yawDeg: 35, pitchDeg: 18, distance: 260, act: 'forget' },
    { name: 'dmg-back', ...near },
    { name: 'dmg-far', x, z, yawDeg: 35, pitchDeg: 20, distance: 700 },
    { name: 'dmg-levels', x, z, yawDeg: 35, pitchDeg: 38, distance: 400, levels: true },
  ];
}
/** With the strips: far along the main line, its node close up, and the level tints over it. */
function stripPresets(): ViewSpec[] {
  if (!stripOn) return [];
  const l = endlessStrips(seed).lines[0]!;
  const s = l.stations;
  const at = (k: number): [number, number] => [s[k * 12]!, s[k * 12 + 2]!];
  const [x0, z0] = at(0);
  const [x1, z1] = at(l.count - 1);
  // Yaw 0 looks toward −z: the heading (dx, dz) has the yaw atan2(−dx, −dz).
  const yawDeg = (Math.atan2(-(x1 - x0), -(z1 - z0)) * 180) / Math.PI;
  const [xm, zm] = at(Math.floor(l.count / 2));
  const [xn, zn] = at(Math.max(0, l.count - 2));
  return [
    { name: 'strip-far', x: x0 + (x1 - x0) * 0.1, z: z0 + (z1 - z0) * 0.1, yawDeg, pitchDeg: 9, distance: 1200 },
    { name: 'strip-near', x: (xn + x1) / 2, z: (zn + z1) / 2, yawDeg, pitchDeg: 32, distance: 90 },
    { name: 'strip-levels', x: xm, z: zm, yawDeg, pitchDeg: 38, distance: 2600, levels: true },
  ];
}
let scripted = false;
let pendingFlight: { toX: number; toZ: number; frames: number } | null = null;
let pendingAct: ViewSpec['act'] | null = null;
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

/** Frame times of the last scripted flight: CPU ms per frame (average, worst) and the upload ms per frame. */
let lastFlight = { frames: 0, cpuMsAvg: 0, cpuMsMax: 0, uploadMsAvg: 0, uploadMsMax: 0, uploads: 0 };

async function fly(f: { toX: number; toZ: number; frames: number }): Promise<void> {
  await settle();
  const fl = { frames: 0, cpuMsAvg: 0, cpuMsMax: 0, uploadMsAvg: 0, uploadMsMax: 0, uploads: 0 };
  const x0 = pos.x;
  const z0 = pos.z;
  for (let i = 1; i <= f.frames; i++) {
    const t = i / f.frames;
    const nx = x0 + (f.toX - x0) * t;
    const nz = z0 + (f.toZ - z0) * t;
    velocity[0] = (nx - pos.x) * 60;
    velocity[1] = (nz - pos.z) * 60;
    pos.x = nx;
    pos.z = nz;
    engine.renderNow();
    const st = world.stats();
    fl.frames++;
    fl.cpuMsAvg += renderer.lastStats.cpuMs / f.frames;
    fl.cpuMsMax = Math.max(fl.cpuMsMax, renderer.lastStats.cpuMs);
    fl.uploadMsAvg += st.uploadMs / f.frames;
    fl.uploadMsMax = Math.max(fl.uploadMsMax, st.uploadMs);
    fl.uploads += st.uploads;
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  }
  lastFlight = fl;
  velocity[0] = velocity[1] = 0;
}

(window as unknown as { __wh: unknown }).__wh = {
  kind: 'orbit',
  ready: new Promise<void>((resolve) => requestAnimationFrame(() => (engine.renderNow(), resolve()))),
  presets: (): ViewSpec[] => precisionScene ? [...PRECISION_PRESETS] : free ? [...FREE_PRESETS] : [
    { name: 'origin', x: 0, z: 0, yawDeg: 160, pitchDeg: 12, distance: 900 },
    { name: 'far', x: 10_000_000, z: 0, yawDeg: 30, pitchDeg: 14, distance: 260 },
    { name: 'far-close', x: 10_000_000, z: 0, yawDeg: 200, pitchDeg: 22, distance: 70 },
    { name: 'flight', x: 0, z: 0, yawDeg: 30, pitchDeg: 18, distance: 600, levels: true, overlay: true, flight: { toX: -9000, toZ: -15600, frames: 60 } },
    { name: 'night', x: 10_000_000, z: 0, yawDeg: 30, pitchDeg: 14, distance: 260, hour: 22.5 },
    ...stripPresets(),
    ...damagePresets(),
  ],
  /** The URL hash of the current view (what the page writes to the address bar). */
  hash: viewHash,
  setView: (v: ViewSpec): void => {
    scripted = true;
    // A flight view froze the loop to keep its mid-flight image; the next view runs it again.
    engine.start();
    if (v.x !== undefined) pos.x = v.x;
    if (v.z !== undefined) pos.z = v.z;
    view.setState({ ...(v.yawDeg !== undefined ? { yawDeg: v.yawDeg } : {}), ...(v.pitchDeg !== undefined ? { pitchDeg: v.pitchDeg } : {}), ...(v.distance !== undefined ? { distance: v.distance } : {}) });
    if (free) placeFreeRig(free, seed, v);
    if (precisionScene && v.name === 'precision') precisionScene.placeNear();
    if (v.hour !== undefined) (env.day.pause(), env.day.set(v.hour));
    showLevels = v.levels ?? false;
    applyLevels();
    pendingFlight = v.flight ?? null;
    pendingAct = v.act ?? null;
    overlay.classList.toggle('hidden', !v.overlay);
    engine.renderNow();
  },
  getView: () => (free ? { ...free.state(), x: pos.x, z: pos.z, height: free.clearance } : { ...view.state(), x: pos.x, z: pos.z }),
  /** Resolves once the image for the current view is complete (or, for a flight view, once the flight is done). */
  settled: async (): Promise<boolean> => {
    if (pendingFlight) {
      const f = pendingFlight;
      pendingFlight = null;
      await fly(f);
      // Freeze on the last flight frame: no further frame streams in the missing cells before the shot is taken.
      engine.stop();
      overlay.textContent = overlayText();
      return world.settled;
    }
    let ok = await settle();
    if (pendingAct) {
      const act = pendingAct;
      pendingAct = null;
      if (act === 'hit') hitDemo();
      else if (demo) world.refresh(drawingCells(demo.home));
      ok = await settle();
    }
    overlay.textContent = overlayText();
    return ok;
  },
  isSettled: (): boolean => world.settled && !world.busy,
  setTimeOfDay: (h: number) => (env.day.pause(), env.day.set(h), engine.renderNow()),
  setTime: (s: number) => (env.time.pause(), env.time.set(s), engine.renderNow()),
  setTick: (): void => {},
  setWeather: (name: string) => ((weatherName = name), (env.weather = { ...DEFAULT_WEATHER, ...(WEATHER[name] ?? {}) }), engine.renderNow()),
  stats: () => ({ ...renderer.lastStats, renderer: engine.device.name, seed, x: pos.x, z: pos.z, streaming: world.stats(), generation: generationMs(), provider: provider.name, flight: lastFlight }),
  overlay: overlayText,
  /** The line of the damage demo (empty without dmg=1); the shot tool prints it. */
  hud: damageLine,
  benchmark: (n: number): number => renderer.benchmark(engine.view, n),
};

// Marks (key N in the free camera): notes pinned to points of the terrain, picked against its height function. Only in
// the dev server (the live demos have none); `__wh.marks` is the script interface.
if (import.meta.env.DEV) {
  const marks = installEngineMarking(engine, { pick: heightPick((x, z) => surfaceHeight(seed, x, z), { maxDistanceM: 50_000 }), hash: viewHash });
  Object.assign((window as unknown as { __wh: object }).__wh, { marks });
}
engine.start();
