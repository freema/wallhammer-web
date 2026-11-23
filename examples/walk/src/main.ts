// Walking test course on Wallhammer Web: the engine's collision world, walker and follow camera over a course of
// stations, each trying one ability (walls and a corner, pillars, steps, ramps, jumps, low passages, a thin wall, a
// footbridge over a pit). The course is pure data (src/course.ts) shared with the headless check (pnpm check:walk).
//
// URL hash: #seed=7&x=60&z=60&yaw=0&fp=0&c=0&lock=0&pr=1.5
//   x, z, yaw  start place (yaw in degrees, 0 faces −z)     fp=1 first person     c=1 the wireframe of the solids
//   lock=1     a click locks the pointer (Escape lets it go)  pr  cap of the canvas pixel ratio (default 1.5; 0 = none)
// Controls: W A S D or the arrows walk, Shift runs, Space jumps, a drag turns, the wheel moves the camera in and out;
// F first person and back, C the wireframe of the solids, R back to the start, N the mark mode (dev server only: a click
// pins a note to the course; marks=1 turns the marks on in a page driven by a script). A gamepad works too (left stick,
// right stick, A, RT or the left stick pressed). A jump keeps the speed and the heading of take-off until landing (the
// walker's defaults); the view can still be turned in the air. The figure's poses come from src/pose.ts.

import { definePalette } from 'wallhammer-web/core';
import { heightFieldMesh } from 'wallhammer-web/gen-mesh';
import { FollowRig } from 'wallhammer-web/camera';
import { bindWalkInput } from 'wallhammer-web/platform';
import type { WalkInputState } from 'wallhammer-web/platform';
import { InstanceSetLayer, MeshLayer } from 'wallhammer-web/render';
import type { Material } from 'wallhammer-web/render';
import { collisionPick, createEngine, installEngineMarking } from 'wallhammer-web/runtime';
import { collisionLines, formatProfile, profileFrame } from 'wallhammer-web/tools';
import type { FrameProfile } from 'wallhammer-web/tools';
import { Walker, newWalkIntent } from 'wallhammer-web/world';
import { COURSE_SIZE_M, LIMIT_TAG, STATIONS, buildCourse, stationAt } from './course.ts';
import { driveTo, walkState } from './drive.ts';
import type { DriveOptions, WalkState } from './drive.ts';
import { Figure, solidsMesh } from './meshes.ts';
import { FigureMotion } from './pose.ts';
import type { MotionSample } from './pose.ts';
import { FIGURE_MATERIAL, GROUND_MATERIAL, SOLID_MATERIAL, WIRE_MATERIAL } from './shaders.ts';

const q = new URLSearchParams(location.hash.slice(1));
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const seed = Math.round(num('seed', 7));
/** Cap of the canvas pixel ratio; 0 or less: the device's own ratio. */
const pixelRatioCap = num('pr', 1.5);
const DEG = Math.PI / 180;
/** Boom length behind the figure, metres. */
const BOOM_M = 4.5;
/** Radius of the sphere the boom is cleared with: a little more than the corner of the near plane. */
const BOOM_RADIUS_M = 0.25;

// --- Course, walker, view --------------------------------------------------------------------------------------------
const course = buildCourse(seed);
const { field, world } = course;
const walker = new Walker(world);
const startX = num('x', course.start[0]);
const startZ = num('z', course.start[1]);
const startYaw = q.has('yaw') ? num('yaw', 0) * DEG : course.start[2];
const rig = new FollowRig(
  { fovDeg: 60, minDistance: 0, maxDistance: 14, pivotHeight: 1.55, followLag: 0.12, minPitchDeg: -30, maxPitchDeg: 75 },
  { clearance: (ox, oy, oz, dx, dy, dz, max) => world.clearance(ox, oy, oz, dx, dy, dz, max, BOOM_RADIUS_M) },
);
rig.distance = q.get('fp') === '1' ? 0 : BOOM_M;
rig.pitchDeg = 16;
/** The boom length F returns to from first person. */
let thirdPersonDistance = BOOM_M;

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const engine = createEngine({
  canvas,
  view: rig,
  palette: definePalette({ sky: '#a9c4d8' }),
  background: [0.66, 0.77, 0.85],
  renderer: { shadowSoftnessM: 0.12, shadowDistanceM: 70 },
  ...(pixelRatioCap > 0 ? { maxPixelRatio: pixelRatioCap } : {}),
  environment: {
    mode: 'day',
    site: { latitudeDeg: 50, longitudeDeg: 14, dayOfYear: 200, utcOffsetHours: 1 },
    hour: 15.5,
    weather: { cloudCover: 0.15 },
    wind: { fromDeg: 240, speedMs: 3 },
    clouds: { sizeM: 500 },
  },
  sky: { hazeDistanceM: 900 },
});
const { renderer, env } = engine;
env.day.pause();
renderer.bounds = { min: [0, field.minY - 2, 0], max: [COURSE_SIZE_M, field.maxY + 6, COURSE_SIZE_M] };
env.fogLayer = { bottomY: field.minY, topY: field.maxY + 6 };

// --- Layers ------------------------------------------------------------------------------------------------------------
const [groundMat, solidMat, figureMat, wireMat] = [GROUND_MATERIAL, SOLID_MATERIAL, FIGURE_MATERIAL, WIRE_MATERIAL].map((m) => renderer.material(m)) as [Material, Material, Material, Material];
engine.add(new MeshLayer({ name: 'ground', material: groundMat, mesh: renderer.createMesh(heightFieldMesh(field, field.minY - 4), groundMat) }));
engine.add(new MeshLayer({ name: 'solids', material: solidMat, mesh: renderer.createMesh(solidsMesh(world), solidMat) }));
const figure = new Figure();
const motion = new FigureMotion(walker.setup);
const sample: MotionSample = { time: 0, travelled: 0, speed: 0, vy: 0, grounded: true };
/** The figure's motion from the walker at `a` of the way between its last two steps. */
function sampleMotion(a: number): void {
  const v = walker.velocity;
  sample.time = (walker.steps - 1 + a) * walker.stepSeconds;
  sample.travelled = walker.renderTravelled(a);
  sample.speed = Math.hypot(v[0]!, v[2]!);
  sample.vy = v[1]!;
  sample.grounded = walker.grounded;
  motion.update(sample);
}
const figureLayer = new InstanceSetLayer(renderer, { name: 'figure', material: figureMat });
figureLayer.add(figure.set);
engine.add(figureLayer);

// The wireframe of the collision world (C): standable solids, solids that only block, invisible limits.
const wire = (name: string, color: [number, number, number], select: Parameters<typeof collisionLines>[1]): { layer: MeshLayer; mesh: ReturnType<typeof renderer.createMesh> } => {
  const mesh = renderer.createMesh(collisionLines(world, { ...select, floorY: field.minY - 1 }), wireMat);
  const layer = new MeshLayer({ name, material: wireMat, mesh: null, uniforms: { u_color: { vec3: color } } });
  engine.add(layer);
  return { layer, mesh };
};
const wires = [
  wire('wire-standable', [1, 0.86, 0.2], { select: (s) => s.blocksSight && s.standable }),
  wire('wire-blocking', [1, 0.36, 0.24], { select: (s) => s.blocksSight && !s.standable }),
  wire('wire-limits', [0.85, 0.3, 1], { select: (s) => !s.blocksSight || s.tag === LIMIT_TAG }),
];
let wireOn = q.get('c') === '1';
function showWire(on: boolean): void {
  wireOn = on;
  for (const w of wires) w.layer.mesh = on ? w.mesh : null;
  engine.invalidate();
}
showWire(wireOn);

// --- Input and the frame -------------------------------------------------------------------------------------------------
const input = bindWalkInput(canvas, rig, { onChange: () => engine.invalidate(), pointerLock: q.get('lock') === '1', draggingClass: 'dragging' });
const state: WalkInputState = { forward: 0, right: 0, run: false, jump: false };
const intent = newWalkIntent();
const fw = [0, 0, 0];
const at = new Float64Array(3);
/** The drawn position and eye of the last frame, to tell whether anything still moves. */
const lastAt = new Float64Array(3);
const lastEye: [number, number, number] = [0, 0, 0];
const eye: [number, number, number] = [0, 0, 0];
let moving = false;
let asking = false;
/** While true the frame loop does not move the walker: a script steps it with `__wh.hold` and photographs a pose. */
let frozen = false;

function place(x: number, z: number, yaw: number): void {
  walker.teleport(x, world.groundAt(x, z, 1e4, 0), z, yaw);
  rig.yawDeg = yaw / DEG;
  walker.renderPosition(at);
  rig.follow(at[0]!, at[1]!, at[2]!);
  rig.snap();
}
place(startX, startZ, startYaw);

engine.onInput(() => {
  input.read(state, engine.frameSeconds);
  if (frozen) {
    asking = false;
    return;
  }
  rig.forward(fw);
  // Forward along the view's heading, right along screen right (−fw.z, fw.x).
  intent.moveX = fw[0]! * state.forward - fw[2]! * state.right;
  intent.moveZ = fw[2]! * state.forward + fw[0]! * state.right;
  intent.run = state.run;
  intent.jump = state.jump;
  asking = state.forward !== 0 || state.right !== 0 || state.jump;
  walker.advance(engine.frameSeconds, intent);
});

// Measured frame times over the last FRAME_WINDOW frames (ring buffers; nothing is allocated per frame).
const FRAME_WINDOW = 120;
const frameIntervals = new Float32Array(FRAME_WINDOW);
const frameCpu = new Float32Array(FRAME_WINDOW);
let frameCount = 0;
let lastReal = performance.now();
function frameTimes(): { meanMs: number; worstMs: number; cpuMs: number; frames: number } {
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

engine.onExtract(() => {
  const now = performance.now();
  const realMs = now - lastReal;
  lastReal = now;
  // Idle gaps (the loop draws only on demand while nothing moves) are not frame times.
  if (realMs > 0 && realMs < 250) {
    const k = frameCount++ % FRAME_WINDOW;
    frameIntervals[k] = realMs;
    frameCpu[k] = renderer.lastStats.cpuMs;
  }
  // A frozen walker is drawn at its last step.
  const a = frozen ? 1 : walker.alpha;
  walker.renderPosition(at, a);
  rig.follow(at[0]!, at[1]!, at[2]!);
  rig.update(engine.frameSeconds);
  sampleMotion(a);
  figure.pose(at[0]!, at[1]!, at[2]!, walker.renderYaw(a), motion);
  // In first person the body would fill the near plane.
  const firstPerson = rig.boom < 0.35;
  if (figure.set.visible === firstPerson) {
    figure.set.visible = !firstPerson;
    figure.set.dirty = true;
  }
  rig.eye(eye);
  moving =
    Math.abs(at[0]! - lastAt[0]!) + Math.abs(at[1]! - lastAt[1]!) + Math.abs(at[2]! - lastAt[2]!) > 1e-5 ||
    Math.abs(eye[0] - lastEye[0]) + Math.abs(eye[1] - lastEye[1]) + Math.abs(eye[2] - lastEye[2]) > 1e-5;
  lastAt.set(at);
  lastEye[0] = eye[0];
  lastEye[1] = eye[1];
  lastEye[2] = eye[2];
  if (++hudFrame % 6 === 0) hudEl.textContent = hud();
});
// The loop draws on demand; while the body or the view still moves, or a key is held, it keeps going.
engine.animateWhile(() => !frozen && (moving || asking || !walker.grounded || walker.steep || input.gamepadConnected));

// --- HUD ---------------------------------------------------------------------------------------------------------------------
const hudEl = document.getElementById('hud')!;
let hudFrame = 0;
function hud(): string {
  const s = walkState(walker);
  const st = stationAt(s.x, s.z);
  const ft = frameTimes();
  const rs = renderer.lastStats;
  const fps = ft.frames > 10 && ft.meanMs > 0 ? `${ft.meanMs.toFixed(1)} ms/frame (${(1000 / ft.meanMs).toFixed(0)} fps, worst ${ft.worstMs.toFixed(1)} ms, cpu ${ft.cpuMs.toFixed(1)} ms)` : 'measuring the frame time…';
  const mode = rig.distance <= 0 ? 'first person' : `behind the figure ${rig.boom.toFixed(1)} m`;
  return [
    `Walking test course  seed ${seed}`,
    `Pad: ${st ? st.label : 'between pads'}`,
    `x ${s.x.toFixed(2)}  y ${s.y.toFixed(2)}  z ${s.z.toFixed(2)}  speed ${s.speed.toFixed(2)} m/s  ${s.grounded ? (s.steep ? 'on a steep slope, sliding' : 'on the ground') : 'in the air'}  view ${mode}${wireOn ? '  collision solids' : ''}`,
    `WASD/arrows walk · Shift run · space jump · drag turn · wheel camera · F first person · C solids · R start`,
    `${fps} · ${(rs.triangles / 1e3).toFixed(0)} k triangles · ${rs.drawCalls} draws · ${rig.width}×${rig.height} px (dpr ${rig.dpr.toFixed(2)}) · ${world.solidCount} solids`,
  ].join('\n');
}

// --- Keys -------------------------------------------------------------------------------------------------------------------
function toggleFirstPerson(): void {
  if (rig.distance > 0) {
    thirdPersonDistance = rig.distance;
    rig.distance = 0;
  } else rig.distance = thirdPersonDistance;
}
const KEYS: Record<string, () => void> = {
  f: toggleFirstPerson,
  c: () => showWire(!wireOn),
  r: () => place(course.start[0], course.start[1], course.start[2]),
};
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const fn = KEYS[e.key.toLowerCase()];
  if (!fn) return;
  e.preventDefault();
  fn();
  engine.invalidate();
  hudEl.textContent = hud();
});

// --- Script interface ---------------------------------------------------------------------------------------------------
interface ViewState {
  name?: string;
  /** Put the figure on the ground here first: x, z and optionally its heading in degrees. */
  at?: [number, number] | [number, number, number];
  yawDeg?: number;
  pitchDeg?: number;
  distance?: number;
}

/** One preset per station: the figure on the station's spot, the camera behind it a little higher than walking. */
const PRESETS: ViewState[] = STATIONS.map((s) => ({ name: s.id, at: [s.spot[0], s.spot[1], s.spot[2] / DEG], yawDeg: s.spot[2] / DEG + 25, pitchDeg: 22, distance: 9 }));

function setView(v: ViewState): void {
  if (v.at) {
    const yaw = v.at[2] !== undefined ? v.at[2] * DEG : walker.yaw;
    place(v.at[0], v.at[1], yaw);
  }
  if (v.yawDeg !== undefined) rig.yawDeg = v.yawDeg;
  if (v.pitchDeg !== undefined) rig.pitchDeg = Math.min(rig.setup.maxPitchDeg, Math.max(rig.setup.minPitchDeg, v.pitchDeg));
  if (v.distance !== undefined) rig.distance = Math.max(0, Math.min(rig.setup.maxDistance, v.distance));
  walker.renderPosition(at);
  rig.follow(at[0]!, at[1]!, at[2]!);
  rig.snap();
  engine.renderNow();
}

function hash(): string {
  const r = (x: number, d = 2): string => String(Math.round(x * 10 ** d) / 10 ** d);
  const p = walker.position;
  const extra = ['lock', 'pr'].filter((k) => q.has(k)).map((k) => `&${k}=${q.get(k)}`).join('');
  return `seed=${seed}&x=${r(p[0]!)}&z=${r(p[2]!)}&yaw=${r(walker.yaw / DEG, 1)}&fp=${rig.distance <= 0 ? 1 : 0}&c=${wireOn ? 1 : 0}${extra}`;
}

/**
 * Frame profile of the current view (`profileFrame`). `running` walks the figure in a circle for the measured frames
 * (a moving shadow caster, as while walking); the walker is put back afterwards.
 */
function profile(frames = 20): FrameProfile {
  engine.renderNow();
  const p0 = walker.position;
  const back: [number, number, number, number] = [p0[0]!, p0[1]!, p0[2]!, walker.yaw];
  const circle = newWalkIntent();
  const dt = engine.frameSeconds;
  engine.frameSeconds = 1 / 60;
  const result = profileFrame(renderer, rig, {
    frames,
    step: (i) => {
      circle.moveX = Math.cos(i * 0.1);
      circle.moveZ = Math.sin(i * 0.1);
      walker.step(circle);
      engine.extract();
    },
  });
  engine.frameSeconds = dt;
  place(back[0], back[2], back[3]);
  engine.renderNow();
  return result;
}

/** A held input for `__wh.hold`: forward and right in the view's frame (−1..1), as the keys give them. */
interface HoldInput {
  forward?: number;
  right?: number;
  run?: boolean;
  /** Ask a jump in the first step. */
  jump?: boolean;
}

const held = newWalkIntent();
/**
 * Holds an input for `seconds` of fixed walker steps, synchronously, the direction taken from the view as the keys
 * take it; the figure sees every step, as frames at the step rate would. Then draws and returns the state.
 */
function hold(o: HoldInput, seconds: number): WalkState {
  const n = Math.max(0, Math.round(seconds * walker.setup.stepHz));
  const f = o.forward ?? 0;
  const r = o.right ?? 0;
  rig.forward(fw);
  held.moveX = fw[0]! * f - fw[2]! * r;
  held.moveZ = fw[2]! * f + fw[0]! * r;
  held.run = o.run ?? false;
  for (let i = 0; i < n; i++) {
    held.jump = i === 0 && (o.jump ?? false);
    walker.step(held);
    sampleMotion(1);
  }
  walker.renderPosition(at, 1);
  rig.follow(at[0]!, at[1]!, at[2]!);
  rig.snap();
  engine.renderNow();
  return walkState(walker);
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
let resolveReady: () => void = () => {};
const ready = new Promise<void>((resolve) => (resolveReady = resolve));

(window as unknown as { __wh: unknown }).__wh = {
  kind: 'follow',
  ready,
  presets: () => PRESETS,
  /** The view: `{ at?: [x, z, yawDeg?], yawDeg?, pitchDeg?, distance? }`; `at` puts the figure there first. */
  setView,
  getView: () => ({ yawDeg: rig.yawDeg, pitchDeg: rig.pitchDeg, distance: rig.distance, boom: rig.boom, pivot: [...rig.pivot], eye: rig.eye() }),
  hash,
  hud,
  settled: async (): Promise<boolean> => {
    for (let i = 0; i < 3; i++) {
      engine.renderNow();
      await nextFrame();
    }
    return true;
  },
  /** Position, velocity, `grounded`, `steep`, heading and the station under the feet. */
  state: (): WalkState => walkState(walker),
  /**
   * Holds a direction toward (x, z) for `seconds` of fixed walker steps (synchronously, the same path as
   * `pnpm check:walk`), then draws; returns the state at the end. Options: `run`, `jump` (jump by itself at edges and
   * ledges), `within`.
   */
  walkTo: (x: number, z: number, seconds: number, o: DriveOptions = {}): WalkState => {
    const end = driveTo(walker, world, x, z, seconds, o);
    walker.renderPosition(at);
    rig.follow(at[0]!, at[1]!, at[2]!);
    rig.snap();
    engine.renderNow();
    return end;
  },
  /**
   * Holds `{ forward?, right?, run?, jump? }` (in the view's frame, as the keys) for `seconds` of fixed steps, the
   * figure posed after every step, then draws. With `freeze(true)` first the page then stays at that step.
   */
  hold,
  /** true: the frame loop stops moving the walker (a script steps it with `hold` and photographs it); false: back. */
  freeze: (on: boolean): void => {
    frozen = on;
    engine.invalidate();
  },
  /** Puts the feet at (x, y, z); y omitted or NaN: on the ground there. */
  teleport: (x: number, y?: number, z?: number, yawDeg?: number): WalkState => {
    const zz = z ?? 0;
    const yaw = yawDeg !== undefined ? yawDeg * DEG : walker.yaw;
    if (y === undefined || !Number.isFinite(y)) place(x, zz, yaw);
    else {
      walker.teleport(x, y, zz, yaw);
      walker.renderPosition(at);
      rig.follow(at[0]!, at[1]!, at[2]!);
      rig.snap();
    }
    engine.renderNow();
    return walkState(walker);
  },
  setWire: (on: boolean) => (showWire(on), engine.renderNow()),
  stations: () => STATIONS.map((s) => ({ id: s.id, label: s.label, rect: s.rect, spot: s.spot })),
  stats: () => ({ ...renderer.lastStats, renderer: engine.device.name, seed, solids: world.solidCount, frameTimes: frameTimes(), walker: walkState(walker), boom: rig.boom }),
  profile,
  profileText: (frames = 20): string => formatProfile(profile(frames)),
};

// Marks (key N): notes pinned to points of the course, picked against the collision world. A mark's view puts the
// walker back on its spot. Only in the dev server (the live demos have none); `__wh.marks` is the script interface.
if (import.meta.env.DEV) {
  const marks = installEngineMarking(engine, { pick: collisionPick(world), hash, placeTarget: (t) => walker.teleport(t[0], t[1], t[2]) });
  Object.assign((window as unknown as { __wh: object }).__wh, { marks });
}

// Start once the loading screen has painted.
const loadingEl = document.getElementById('loading');
function begin(): void {
  engine.renderNow();
  engine.start();
  hudEl.textContent = hud();
  loadingEl?.classList.add('done');
  setTimeout(() => loadingEl?.remove(), 600);
  resolveReady();
}
if (document.hidden) setTimeout(begin, 0);
else requestAnimationFrame(() => requestAnimationFrame(begin));
