// Destruction example on Wallhammer Web: generated structures on plain ground. A click sends a destruction event to
// the destruction model (tier A, integers, deterministic); the changed structures are regenerated from
// (recipe, seed, state) and uploaded again, and the rubble of gone parts is drawn from its footprints. The state is
// the only truth and lives in the URL, so a link reproduces the same ruin.
//
// A collapse is presented over a second or two: the state is final at once, the parts it took away come down as
// transient pieces on closed-form tracks (gen-arch `fallPieces`, render `TransientLayer`) in the order of the event's
// timeline, and their rubble grows in where they land. All of it is a function of the engine clock.
//
// URL hash: #r=3&e=900&t=4&d=<state>&yaw=35&pitch=24&dist=95&hour=14
//   s=<scenario,...> scripted events; with at=<seconds> the scenario is presented and the clock frozen that long
//   after its last event (reproducible collapse frames). budget=<n> caps the pieces in flight.
// Controls: click blasts at the point under the cursor, drag orbits, the wheel zooms, [ ] radius, - = energy,
// Z undo, R reset, H hides the text, D toggles debris, space runs the day.

import { DEFAULT_WEATHER, PerspectiveOrbitRig, heightFieldMesh } from 'wallhammer-web';
import type { MeshData, StructureDesc, StructureState, WeatherState } from 'wallhammer-web';
import { hashInts } from 'wallhammer-web/gen-core';
import { MeshLayer, TransientLayer } from 'wallhammer-web/render';
import type { DustPuff } from 'wallhammer-web';
import type { Mesh } from 'wallhammer-web/gpu';
import type { Material } from 'wallhammer-web/render';
import { createEngine } from 'wallhammer-web/runtime';
import {
  applyEventToAll,
  compileStructure,
  decodeStates,
  destructionEvent,
  encodeStates,
  raycastParts,
  rubbleFootprints,
  stateHash,
  TIMELINE_TICK_S,
} from 'wallhammer-web/sim/destruction';
import { FALL_LAYOUT, buildBuildingMesh, buildRubbleMesh, fallPieces, fallingMaterial, rubbleColours, structureMaterial, structureUniforms, windowLightSlot } from 'wallhammer-web/gen-arch';
import type { FallChange, FallEvent, FallOutput } from 'wallhammer-web/gen-arch';
import { snowSlot } from 'wallhammer-web/gen-ground';
import { Debris } from './debris.ts';
import type { DebrisSource } from './debris.ts';
import { DIMS, GROUND_MATERIAL, GROUND_Y, PALETTE, SCENARIOS, SIZE, groundAt, groundField, structures } from './scene.ts';

const q = new URLSearchParams(location.hash.slice(1));
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const WEATHER: Record<string, Partial<WeatherState>> = {
  clear: {},
  clouds: { cloudCover: 0.45 },
  rain: { cloudCover: 0.8, precipitation: 0.7, precipitationKind: 'rain', wetness: 0.8, fog: 0.25 },
  snow: { cloudCover: 0.7, precipitation: 0.6, precipitationKind: 'snow', snowCover: 0.8, fog: 0.2 },
};

// --- Engine -------------------------------------------------------------------------------------------------------
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;
const engine = createEngine({
  canvas,
  view: new PerspectiveOrbitRig({ fovYDeg: 40, minDistance: 12, maxDistance: 220 }, { yawDeg: num('yaw', 35), pitchDeg: num('pitch', 24), distance: num('dist', 95) }),
  palette: PALETTE,
  background: PALETTE.color('sky'),
  slots: [snowSlot(), windowLightSlot()],
  renderer: { shadowSoftnessM: 0.3 },
  environment: { mode: 'day', site: { latitudeDeg: 50.7, longitudeDeg: 14, dayOfYear: num('day', 250), utcOffsetHours: 2 }, hour: num('hour', 14), hoursPerSecond: 0.5, weather: WEATHER[q.get('w') ?? 'clear'] ?? {}, wind: { fromDeg: 230, speedMs: 4 } },
  orbitControls: true,
  precipitation: true,
});
const { renderer, env, view } = engine;
env.day.pause();
view.target = [num('tx', SIZE / 2), num('ty', 4), num('tz', SIZE / 2)];
renderer.bounds = { min: [0, GROUND_Y - 2, 0], max: [SIZE, GROUND_Y + 30, SIZE] };

// --- Scene: ground, one layer per structure, rubble, debris ------------------------------------------------------
const groundMat = renderer.material(GROUND_MATERIAL);
engine.add(new MeshLayer({ material: groundMat, mesh: renderer.createMesh(heightFieldMesh(groundField(), GROUND_Y - 3), groundMat), uniforms: { u_albedo: { vec3: PALETTE.color('ground') } } }));

const SPECS = structures();
const DESCS: StructureDesc[] = buildBuildingMesh(SPECS, [], groundAt, DIMS, { describe: true }).structures;
const COMPILED = DESCS.map((d) => compileStructure(d));
const structMat: Material = renderer.material(structureMaterial(DIMS, { damage: true }));
const structUniforms = structureUniforms({ glass: PALETTE.index('glass'), glassLit: PALETTE.index('glassLit'), plinth: PALETTE.index('plinth') });
const layers = new Map<number, MeshLayer>();
for (const b of SPECS) {
  const layer = new MeshLayer({ material: structMat, uniforms: structUniforms });
  layers.set(b.id, layer);
  engine.add(layer);
}
const rubbleLayer = new MeshLayer({ material: structMat, uniforms: structUniforms });
engine.add(rubbleLayer);
const debris = new Debris(renderer);
engine.add(debris.layer);
const transient = new TransientLayer(renderer, { maxPieces: Math.max(0, Math.round(num('budget', 320))), clock: () => env.time.time });
const fallMat: Material = renderer.material(fallingMaterial(DIMS));
engine.add(transient);

const replace = (layer: MeshLayer, data: MeshData): void => {
  const old: Mesh | null = layer.mesh;
  layer.mesh = data.count > 0 ? renderer.createMesh(data, structMat) : null;
  if (old) engine.device.deleteMesh(old);
};

// --- State ---------------------------------------------------------------------------------------------------------
let states = new Map<number, StructureState>();
let tick = Math.max(0, Math.round(num('t', 0)));
let radius = Math.min(8, Math.max(0.5, num('r', 3)));
let energy = Math.min(5000, Math.max(50, num('e', 900)));
let showHud = q.get('hud') !== '0';
let debrisOn = true;
/** Present events (falling pieces, staged rubble)? Off while scripted scenarios load without `at`. */
let presentOn = true;
let lastEventAt = 0;
/** Clock time and duration of the rubble growth of each gone part, by `structure:part` (part 0: the whole ruin). */
const arrivals = new Map<string, { start: number; seconds: number }>();
const history: { states: Map<number, StructureState>; tick: number }[] = [];
let lastRegenMs = 0;
let lastPresentMs = 0;
/** Events at one clock time are presented together: the state before them, their gone parts, their batches. */
interface Instant {
  at: number;
  states: Map<number, StructureState>;
  changes: Map<number, FallChange[]>;
  before: Map<number, MeshData>;
  batches: number[];
  puffs: DustPuff[];
}
let instant: Instant = { at: NaN, states, changes: new Map(), before: new Map(), batches: [], puffs: [] };
function newInstant(at: number): void {
  instant = { at, states, changes: new Map(), before: new Map(), batches: [], puffs: [] };
}
let lastEventMs = 0;
let lastChanges = 0;
if (q.has('d')) {
  const r = decodeStates(q.get('d') ?? '');
  states = r.states;
  if (r.errors.length) console.warn('destruction: ignored parts of the state', r.errors);
}

/** Regenerates the mesh of the given structures from their state and re-uploads it; then the rubble. */
function rebuild(ids: Iterable<number>): void {
  const t0 = performance.now();
  for (const id of ids) {
    const spec = SPECS.find((b) => b.id === id);
    const layer = layers.get(id);
    if (!spec || !layer) continue;
    const r = buildBuildingMesh([spec], [], groundAt, DIMS, { states });
    replace(layer, r.mesh);
  }
  const footprints = COMPILED.flatMap((s) => {
    const st = states.get(s.desc.id);
    return st ? rubbleFootprints(s, st) : [];
  });
  replace(rubbleLayer, buildRubbleMesh(footprints, rubbleColours(SPECS), groundAt, (fp) => arrivals.get(`${fp.structure}:${fp.part}`)));
  lastRegenMs = performance.now() - t0;
  writeHash();
  engine.invalidate();
}

function writeHash(): void {
  const p = new URLSearchParams(location.hash.slice(1));
  p.set('r', String(radius));
  p.set('e', String(energy));
  p.set('t', String(tick));
  const d = encodeStates(states.values());
  if (d) p.set('d', d);
  else p.delete('d');
  const v = view.state();
  p.set('yaw', v.yawDeg.toFixed(1));
  p.set('pitch', v.pitchDeg.toFixed(1));
  p.set('dist', v.distance.toFixed(1));
  history.length > 200 && history.shift();
  window.history.replaceState(null, '', `#${p.toString()}`);
  drawHud();
}

function drawHud(): void {
  hud.classList.toggle('hidden', !showHud);
  let damaged = 0;
  let ruins = 0;
  for (const s of states.values()) {
    damaged += s.parts.size;
    if (s.ruin) ruins++;
  }
  hud.textContent =
    `radius ${radius.toFixed(1)} m  [ ]    energy ${energy}  - =\n` +
    `events ${tick}   damaged parts ${damaged}${ruins ? `   ruins ${ruins}` : ''}   state ${stateHash([...states.values()])}\n` +
    `last event ${lastEventMs.toFixed(2)} ms, ${lastChanges} changes, regenerate ${lastRegenMs.toFixed(1)} ms\n` +
    (fallen ? `falling ${fallen} pieces${fallenDust ? `, ${fallenDust} over budget (dust only)` : ''}\n` : '') +
    `click blast · drag orbit · Z undo · R reset · D debris · H hide`;
}

/** Sends one event at a point (metres). Returns the number of changed parts. */
function blast(x: number, y: number, z: number, r = radius, e = energy): number {
  const ev = destructionEvent({ position: [x, y, z], radius: r, energy: e, seed: hashInts(0xd357, tick), tick });
  const t0 = performance.now();
  const res = applyEventToAll(COMPILED, states, ev);
  lastEventMs = performance.now() - t0;
  lastChanges = res.changes.length;
  history.push({ states, tick });
  tick++;
  if (res.changes.length === 0) {
    writeHash();
    return 0;
  }
  const at = env.time.time;
  if (at !== instant.at) newInstant(at);
  states = res.states;
  const changed = new Set(res.changes.map((c) => c.structure));
  if (presentOn) present(res.changes, res.timeline, { x, y, z, radius: r, energy: e, seed: ev.seed }, at);
  // Debris from the parts that broke away (cosmetic only).
  if (debrisOn) {
    const sources: DebrisSource[] = [];
    for (const c of res.changes) {
      if (c.to !== 3 || sources.length > 60) continue;
      const s = COMPILED.find((k) => k.desc.id === c.structure)!;
      const i = s.index.get(c.part);
      if (i === undefined) continue;
      const cx = s.centre[i * 3]! / 100;
      const cy = s.centre[i * 3 + 1]! / 100;
      const cz = s.centre[i * 3 + 2]! / 100;
      const dx = cx - x;
      const dz = cz - z;
      const l = Math.hypot(dx, dz) || 1;
      sources.push({ x: cx, y: cy, z: cz, dx: dx / l, dz: dz / l, size: Math.min(3, (s.box[i * 6 + 1]! - s.box[i * 6]! + s.box[i * 6 + 5]! - s.box[i * 6 + 4]!) / 200) });
    }
    if (sources.length) debris.burst(ev.seed, sources, GROUND_Y, at);
  }
  rebuild(changed);
  return res.changes.length;
}

let fallen = 0;
let fallenDust = 0;

/**
 * Presentation of one event: the parts it took away become falling pieces, in the order of the event's timeline, and
 * their rubble grows in when they land. The state is already final; this only schedules what the clock will show.
 * Events at the same clock time (a scripted scenario) are presented as one: the pieces are cut out of the structures
 * as they stood at that time, and the budget goes to the best pieces of all of them.
 */
function present(
  changes: readonly { structure: number; part: number; to: number; cause: string }[],
  timeline: Uint16Array,
  ev: FallEvent,
  at: number,
): void {
  lastEventAt = at;
  changes.forEach((c, k) => {
    if (c.to !== 3) return;
    const l = instant.changes.get(c.structure) ?? [];
    l.push({ part: c.part, hit: c.cause === 'damage', delay: (timeline[k] ?? 0) * TIMELINE_TICK_S, event: ev });
    instant.changes.set(c.structure, l);
  });
  const t0 = performance.now();
  for (const id of instant.batches) transient.remove(id);
  instant.batches = [];
  instant.puffs.push({ x: ev.x, y: ev.y, z: ev.z, start: at, size: Math.min(6, 1 + ev.radius) });
  let room = transient.room(at);
  fallen = 0;
  fallenDust = 0;
  const outs: { id: number; state: StructureState; out: FallOutput }[] = [];
  for (const [id, list] of instant.changes) {
    const s = COMPILED.find((k) => k.desc.id === id);
    const spec = SPECS.find((b) => b.id === id);
    const state = states.get(id);
    if (!s || !spec || !state) continue;
    // The structure as it stood, drawn part by part: the pieces are cut out of it.
    let before = instant.before.get(id);
    if (!before) {
      before = buildBuildingMesh([spec], [], groundAt, DIMS, { states: instant.states, byParts: true }).mesh;
      instant.before.set(id, before);
    }
    const out = fallPieces({ desc: s.desc, state, before, changes: list, event: ev, at, groundAt, budget: room });
    room = Math.max(0, room - out.pieces);
    outs.push({ id, state, out });
  }
  outs.forEach(({ id, state, out }, k) => {
    fallen += out.pieces;
    fallenDust += out.dust;
    const puffs = k === 0 ? [...instant.puffs, ...out.puffs] : out.puffs;
    instant.batches.push(transient.addBatch({ data: out.mesh, material: fallMat, uniforms: structUniforms, start: out.start, end: out.end, pieces: out.pieces, dust: out.dust, puffs }));
    let last = { start: at, seconds: 0.7 };
    for (const [part, a] of out.arrivals) {
      arrivals.set(`${id}:${part}`, a);
      if (a.start > last.start) last = a;
    }
    // A ruin leaves one heap (part 0): it grows in with the last piece.
    if (state.ruin) arrivals.set(`${id}:0`, last);
  });
  if (outs.length === 0) instant.batches.push(transient.addBatch({ data: { layout: FALL_LAYOUT, vertices: new Float32Array(0), indices: null, count: 0 }, material: fallMat, start: at, end: at, pieces: 0, dust: 0, puffs: instant.puffs }));
  lastPresentMs = performance.now() - t0;
}

/** Blast under a canvas point (CSS pixels). The ray hits a part; without a hit it hits the ground plane. */
function blastAtScreen(cssX: number, cssY: number): number {
  const k = canvas.width / Math.max(1, canvas.clientWidth);
  const ray = view.screenRay(cssX * k, cssY * k);
  const hit = raycastParts(DESCS, ray.origin, ray.dir, (s, p) => {
    const st = states.get(s);
    return !!st && (st.ruin || (st.parts.get(p) ?? 0) % 4 === 3);
  });
  if (hit) return blast(hit.point[0], hit.point[1], hit.point[2]);
  if (ray.dir[1] >= -1e-4) return 0;
  const t = (GROUND_Y - ray.origin[1]) / ray.dir[1];
  return blast(ray.origin[0] + ray.dir[0] * t, GROUND_Y + 0.5, ray.origin[2] + ray.dir[2] * t);
}

function reset(): void {
  history.push({ states, tick });
  states = new Map();
  debris.clear();
  transient.clear();
  newInstant(NaN);
  arrivals.clear();
  fallen = 0;
  rebuild(SPECS.map((b) => b.id));
}

// --- Input ---------------------------------------------------------------------------------------------------------
let down: [number, number] | null = null;
canvas.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
canvas.addEventListener('pointerup', (e) => {
  if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5 && e.button === 0) {
    const rect = canvas.getBoundingClientRect();
    blastAtScreen(e.clientX - rect.left, e.clientY - rect.top);
  }
  down = null;
  writeHash();
});
const KEYS: Record<string, () => void> = {
  '[': () => (radius = Math.max(0.5, radius - 0.5)),
  ']': () => (radius = Math.min(8, radius + 0.5)),
  '-': () => (energy = Math.max(50, Math.round(energy / 1.25 / 10) * 10)),
  '=': () => (energy = Math.min(5000, Math.round((energy * 1.25) / 10) * 10)),
  z: () => {
    const h = history.pop();
    if (!h) return;
    const ids = new Set([...states.keys(), ...h.states.keys()]);
    states = h.states;
    newInstant(NaN);
    tick = h.tick;
    rebuild(ids);
  },
  r: reset,
  h: () => (showHud = !showHud),
  d: () => ((debrisOn = !debrisOn), debrisOn || debris.clear()),
  ' ': () => env.day.toggle(),
};
window.addEventListener('keydown', (e) => {
  const f = KEYS[e.key.toLowerCase()];
  if (!f) return;
  f();
  writeHash();
  engine.invalidate();
});

// Debris and falling pieces follow the engine clock; frames are requested while anything is in flight.
let debrisFrozen: number | null = null;
let wasBusy = false;
const tickPresent = (): void => {
  const t = env.time.time;
  if (debris.active && debrisFrozen === null) {
    debris.update(t);
    engine.invalidate();
  }
  const busy = transient.busy(t);
  if (busy) engine.invalidate();
  else if (wasBusy) {
    transient.drop(t);
    drawHud();
  }
  wasBusy = busy;
  requestAnimationFrame(tickPresent);
};
requestAnimationFrame(tickPresent);

rebuild(SPECS.map((b) => b.id));
// Scripted events from the URL (only when no state is given): `#s=corner,collapse`.
// With `at=<seconds>` the events are presented (pieces, staged rubble) and the clock stops that long after the last one.
if (!q.has('d') && q.has('s')) {
  debrisOn = false;
  presentOn = q.has('at');
  for (const name of (q.get('s') ?? '').split(',')) for (const ev of SCENARIOS[name] ?? []) blast(ev.at[0], ev.at[1], ev.at[2], ev.r, ev.e);
  debrisOn = true;
  presentOn = true;
  if (q.has('at')) {
    env.time.pause();
    env.time.set(lastEventAt + num('at', 0));
  }
}

// --- Script interface (screenshots, tests) ----------------------------------------------------------------------------
const now = <T>(f: () => T): T => {
  const r = f();
  engine.renderNow();
  return r;
};
(window as unknown as { __wh: unknown }).__wh = {
  kind: 'orbit',
  ready: new Promise<void>((resolve) => requestAnimationFrame(() => (engine.renderNow(), resolve()))),
  presets: () => [
    { name: 'overview', yawDeg: 35, pitchDeg: 26, distance: 95 },
    { name: 'corner', yawDeg: 140, pitchDeg: 14, distance: 42 },
    { name: 'low', yawDeg: 320, pitchDeg: 9, distance: 55 },
  ],
  setView: (v: { yawDeg?: number; pitchDeg?: number; distance?: number; target?: [number, number, number] }) =>
    now(() => {
      if (v.target) view.target = v.target;
      view.setState(v);
    }),
  getView: () => ({ ...view.state(), target: view.target }),
  setTimeOfDay: (h: number) => now(() => (env.day.pause(), env.day.set(h))),
  setTime: (s: number) => now(() => (env.time.pause(), env.time.set(s))),
  setWeather: (name: string) => now(() => (env.weather = { ...DEFAULT_WEATHER, ...(WEATHER[name] ?? {}) })),
  blast: (x: number, y: number, z: number, r?: number, e?: number) => now(() => blast(x, y, z, r, e)),
  blastAtScreen: (x: number, y: number) => now(() => blastAtScreen(x, y)),
  reset: () => now(reset),
  setState: (text: string) =>
    now(() => {
      const ids = new Set([...states.keys()]);
      states = decodeStates(text).states;
      newInstant(NaN);
      for (const k of states.keys()) ids.add(k);
      rebuild(ids);
    }),
  /** Debris at a fixed age in seconds (null lets it run again). */
  debrisAt: (age: number | null) => now(() => ((debrisFrozen = age), age !== null && debris.update(0, age))),
  /** Freezes the clock `t` seconds after the last presented event (null plays it again). */
  collapseAt: (t: number | null) => now(() => (t === null ? env.time.play() : (env.time.pause(), env.time.set(lastEventAt + t)))),
  /** Pieces in flight, over-budget pieces and dust puffs, and the clock time of the last event. */
  falling: () => ({ ...transient.stats(env.time.time), fallen, fallenDust, presentMs: lastPresentMs, lastEventAt, now: env.time.time, busy: transient.busy(env.time.time) }),
  hud: (on: boolean) => now(() => ((showHud = on), drawHud())),
  structures: () => DESCS.map((d) => ({ id: d.id, parts: d.parts.length, bonds: d.bonds.length, cx: d.cx / 100, cz: d.cz / 100 })),
  /** Regenerates one structure `n` times and returns the mean time in ms (the cost of one damaged re-upload). */
  regenCost: (id: number, n = 20): number => {
    const t0 = performance.now();
    for (let k = 0; k < n; k++) rebuild([id]);
    return (performance.now() - t0) / n;
  },
  stats: () => ({
    ...renderer.lastStats,
    renderer: engine.device.name,
    tick,
    radius,
    energy,
    state: stateHash([...states.values()]),
    encoded: encodeStates(states.values()),
    damaged: [...states.values()].reduce((n, s) => n + s.parts.size, 0),
    regenMs: lastRegenMs,
    eventMs: lastEventMs,
  }),
  /** Average frame time over `n` frames; with `dt` the clock steps by `dt` per frame (and is restored after). */
  benchmark: (n: number, dt = 0): number => {
    const t = env.time.time;
    const ms = renderer.benchmark(view, n, () => {
      if (dt) env.time.set(env.time.time + dt);
    });
    env.time.set(t);
    return ms;
  },
};
engine.start();
