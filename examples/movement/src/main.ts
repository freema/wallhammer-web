// Movement test course on Wallhammer Web (walking, riding, driving): the engine's collision world, walker and follow camera over a course of
// stations, each trying one ability (walls and a corner, pillars, steps, ramps, jumps, low passages, a thin wall, a
// footbridge over a pit). The course is pure data (src/course.ts) shared with the headless check (pnpm check:walk).
// The steed (the shared steed.ts), a long-legged runner with a woven rug, stands a few steps ahead of the start: E gets on and off, and the figure rides
// it over the course (src/ride.ts; its own walker, the legs stepped by the engine's StepCycle, the rider on a
// SocketSeat with its hands on the grips and its feet in the stirrups).
// Two compact cars (the shared vehicles/compact.ts) stand on the start pad, one beside the steed and one parked further
// on: E at the driver's door gets in and drives (src/car.ts; each car the engine's WheeledBody on four wheel rays, the
// two stepped together in a WheeledGroup so they push each other, their obstacle boxes blocking the walkers), E again
// when nearly stopped gets out. The camera's boom grows and turns behind the car while it drives.
// The glider (the shared glider.ts), a large flying animal with the build of a ray and a saddle rug, rests behind the
// cars: E gets on and off (behind its left wing), and the figure crawls it, takes it off, flies and lands it
// (src/glide.ts; the engine's FlyingBody, its paws stepped on the ground by the StepCycle, its wings posed in the air).
// Traces (src/traces.ts): the boots and the hooves leave prints (faint on grass, deep on the patch of loose ground in
// front of the start), the cars ruts on loose ground and dark streaks where they slide, and hooves at a trot or a
// gallop and wheels on loose ground or sliding kick up dust: the engine's contact trail, particle bursts and the
// collision world's surface tags.
//
// URL hash: #seed=7&x=60&z=60&yaw=0&fp=0&c=0&lock=0&pr=1.5&profile=default&figure=pathfinder&ride=0&hx=59.4&hz=55.8&hyaw=90
//           &drive=0&car0=66,54.5,90&car1=51,50,0&glide=0&gx=76&gz=61&gyaw=0&assist=1
//   x, z, yaw  start place (yaw in degrees, 0 faces −z)     fp=1 first person     c=1 the wireframe of the solids
//   lock=1     a click locks the pointer (Escape lets it go)  pr  cap of the canvas pixel ratio (default 1.5; 0 = none)
//   profile    how the body carries its weight: default, heavy, light (examples/shared profiles.ts: run-up, braking,
//              running turn, stride, lean) or engine (the walker's own defaults: no separate braking, turns on the
//              spot; the walker of `pnpm check:walk`)
//   figure     pathfinder (default: the shared figure with a ponytail that lags behind its motion, src/body.ts) or
//              boxes (the box figure of src/pose.ts)
//   ride=1     start in the saddle     hx, hz, hyaw  the steed's place and heading (degrees, 0 faces −z)
//   drive=i    start in car i (0 or 1)  car0, car1    the cars' places: x, z and the heading in degrees
//   glide=1    start on the glider      gx, gz, gyaw  the glider's place and heading (degrees, 0 faces −z)
//   assist=0   fly the glider by its raw controls (pitch, bank, beats, flare) instead of the flight assist
// Controls: W A S D or the arrows walk, Shift runs, Space jumps, a drag turns, the wheel moves the camera in and out;
// E gets on the steed (within 3.2 m) and off again (to its left, or its right when the left is blocked); riding, W A S D
// steer the steed relative to the view, T switches its slower gait between walk and trot, Shift gallops, no jump.
// E also gets into a car (within 2 m of its driver's door, the left one) and out again (stopped; to the left, or the
// right when the left is blocked); driving, W and S give throttle and brake (S reverses once stopped), A and D steer,
// Space holds the handbrake, R puts an overturned car back on its wheels; the camera swings behind the car unless the
// view is being dragged. On the glider (within 4.8 m of it): on the ground W and S crawl forward and back, A and D
// turn, Space leaps off; in the air (the engine's FlightAssist) W flies faster and S slower (the wanted speed stays
// when they are let go), A and D turn, held Space climbs and held Shift descends; with nothing held it flies level at
// the wanted speed; coming down to the ground it lands; E gets off once it has stopped on the ground. With assist=0 the
// raw controls: in the air W puts the nose down and S up, A and D bank, held Space beats, Shift flares.
// The camera's boom grows behind the glider and follows its heading. E picks the nearest of the steed, the cars and
// the glider.
// F first person and back, C the wireframe of the solids, R back to the start, P the next movement profile, N the mark
// mode (dev server only: a click
// pins a note to the course; marks=1 turns the marks on in a page driven by a script). A gamepad works too (left stick,
// right stick, A, RT or the left stick pressed). A jump keeps the speed and the heading of take-off until landing (the
// walker's defaults); the view can still be turned in the air. The pathfinder's poses come from src/body.ts, the box
// figure's from src/pose.ts.

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
import { DEFAULT_WALKER, WALKER_TUNING_KEYS, Walker, newFlightAssistInput, newFlyingIntent, newWalkIntent } from 'wallhammer-web/world';
import type { WalkerTuning } from 'wallhammer-web/world';
import { FigureParts } from '../../shared/src/figures/parts.ts';
import { PATHFINDER_TAIL } from '../../shared/src/figures/pathfinder.ts';
import { MOVE_PROFILES, MOVE_PROFILE_NAMES } from '../../shared/src/figures/profiles.ts';
import type { MoveProfile } from '../../shared/src/figures/profiles.ts';
import { PathfinderBody } from './body.ts';
import { RIDE_REACH_M, Ride } from './ride.ts';
import type { RideStatus } from './ride.ts';
import { GLIDER_ASSIST, GLIDE_REACH_M, Glide } from './glide.ts';
import type { GlideStatus } from './glide.ts';
import { MEMBRANE_UNDER } from '../../shared/src/figures/glider.ts';
import { Membrane } from '../../shared/src/figures/membrane.ts';
import { COURSE_SIZE_M, FLIGHT_AREA, FLIGHT_CEILING_M, LIMIT_TAG, OUTER_M, STATIONS, buildCourse, stationAt } from './course.ts';
import { driveTo, walkState } from './drive.ts';
import type { DriveOptions, WalkState } from './drive.ts';
import { Figure, shiftedXZ, solidsMesh } from './meshes.ts';
import { FigureMotion } from './pose.ts';
import type { MotionSample } from './pose.ts';
import { CAR_MATERIAL, FIGURE_MATERIAL, GROUND_MATERIAL, PATHFINDER_MATERIAL, SOLID_MATERIAL, TRACE_MATERIAL, WIRE_MATERIAL } from './shaders.ts';
import { CAR_EXIT_SPEED_MS, CAR_REACH_M, Cars } from './car.ts';
import type { CarPlace, DriveStatus } from './car.ts';
import { CarView } from './car-view.ts';
import { Traces } from './traces.ts';

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
/** The movement profiles of the page: the shared three, then the walker's own defaults. */
const ENGINE_PROFILE: MoveProfile = {
  name: 'engine',
  walker: Object.fromEntries(WALKER_TUNING_KEYS.map((k) => [k, DEFAULT_WALKER[k]])) as unknown as WalkerTuning,
  gait: MOVE_PROFILES.default.gait,
};
const PROFILES: readonly MoveProfile[] = [...MOVE_PROFILE_NAMES.map((n) => MOVE_PROFILES[n]), ENGINE_PROFILE];
const profileOf = (name: string | null): MoveProfile => PROFILES.find((p) => p.name === name) ?? MOVE_PROFILES.default;
let moveProfile = profileOf(q.get('profile'));
const boxes = q.get('figure') === 'boxes';
const course = buildCourse(seed);
const { field, world } = course;
const walker = new Walker(world, moveProfile.walker);
const startX = num('x', course.start[0]);
const startZ = num('z', course.start[1]);
const startYaw = q.has('yaw') ? num('yaw', 0) * DEG : course.start[2];
/** Seconds the camera waits after the view is turned before it swings back behind the car. */
const CAR_YAW_PAUSE_S = 1.2;
/** Rate the camera swings behind the car at, 1/s (the rig's `headingLag` is 3 / rate: 95 % of the gap). */
const CAR_YAW_RATE = 2.5;
/** The farthest the user zooms the camera out, m (the game's extra boom comes on top of it). */
const MAX_BOOM_M = 14;
const rig = new FollowRig(
  { fovDeg: 60, minDistance: 0, maxDistance: MAX_BOOM_M, pivotHeight: 1.55, followLag: 0.12, minPitchDeg: -30, maxPitchDeg: 75, headingLag: 3 / CAR_YAW_RATE, headingPause: CAR_YAW_PAUSE_S },
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
/** The top of the shadows' bounds on the ground; raised over the glider while it flies (`fitBounds`). */
const BOUNDS_TOP = field.maxY + 6;
renderer.bounds = { min: [0, field.minY - 2, 0], max: [COURSE_SIZE_M, BOUNDS_TOP, COURSE_SIZE_M] };
env.fogLayer = { bottomY: field.minY, topY: field.maxY + 6 };

// --- Layers ------------------------------------------------------------------------------------------------------------
const [groundMat, solidMat, figureMat, wireMat] = [GROUND_MATERIAL, SOLID_MATERIAL, FIGURE_MATERIAL, WIRE_MATERIAL].map((m) => renderer.material(m)) as [Material, Material, Material, Material];
engine.add(new MeshLayer({ name: 'ground', material: groundMat, mesh: renderer.createMesh(heightFieldMesh(field, field.minY - 4), groundMat) }));
// The open land round the course (its grid from −OUTER_M; under the course it lies hidden below the course's ground).
engine.add(new MeshLayer({ name: 'land', material: groundMat, mesh: renderer.createMesh(shiftedXZ(heightFieldMesh(course.outer, course.outer.minY - 4), -OUTER_M, -OUTER_M), groundMat) }));
engine.add(new MeshLayer({ name: 'solids', material: solidMat, mesh: renderer.createMesh(solidsMesh(world), solidMat) }));
// The marks on the ground (prints, ruts, tyre marks), over the ground and under everything that stands on it; the
// dust is added after the opaque layers (below).
const traces = new Traces(renderer, renderer.material(TRACE_MATERIAL), world, 2 * 4);
engine.add(traces.layer);
const figure = new Figure();
const motion = new FigureMotion(walker.setup);
const sample: MotionSample = { time: 0, travelled: 0, speed: 0, vy: 0, grounded: true };
const body = new PathfinderBody(walker.setup.height, moveProfile, (x, z, y) => world.groundAt(x, z, y + 0.5, walker.setup.maxStepUp));
/** The walker's time and distance at the body's last update. */
let bodyTime = 0;
let bodyTravelled = 0;
/** The figure's motion from the walker at `a` of the way between its last two steps. */
function sampleMotion(a: number): void {
  const v = walker.velocity;
  sample.time = (walker.steps - 1 + a) * walker.stepSeconds;
  sample.travelled = walker.renderTravelled(a);
  sample.speed = Math.hypot(v[0]!, v[2]!);
  sample.vy = v[1]!;
  sample.grounded = walker.grounded;
  if (boxes) {
    motion.update(sample);
    return;
  }
  const dt = sample.time - bodyTime;
  // A teleport starts the walker's steps over: the body starts standing.
  if (dt < 0 || dt > 1) body.reset();
  else body.update(dt, Math.max(0, sample.travelled - bodyTravelled), sample.grounded, sample.vy);
  bodyTime = sample.time;
  bodyTravelled = sample.travelled;
}
/** Poses the drawn figure at the walker's drawn place `at` and heading `yaw`. */
function poseFigure(yaw: number): void {
  if (boxes) figure.pose(at[0]!, at[1]!, at[2]!, yaw, motion);
  else parts.write(body.pose(at[0]!, at[1]!, at[2]!, yaw));
}
const figureLayer = new InstanceSetLayer(renderer, { name: 'figure', material: figureMat });
figureLayer.add(figure.set);
engine.add(figureLayer);
// The pathfinder: a ponytail behind its spiky hair (`PATHFINDER_TAIL`).
const parts = new FigureParts(renderer, 'pathfinder', renderer.material(PATHFINDER_MATERIAL), body.kind, 0 + PATHFINDER_TAIL);
engine.add(parts.layer);

// The steed (key E gets on and off; src/ride.ts): standing a few steps ahead of the start, its mounting side to the
// view. `hx`, `hz`, `hyaw` put it elsewhere; `ride=1` starts in the saddle. Not with the box figure.
const STEED_PLACE: readonly [number, number, number] = [59.4, 55.8, 90];
const ride = new Ride(world, body, walker, num('hx', STEED_PLACE[0]), num('hz', STEED_PLACE[1]), num('hyaw', STEED_PLACE[2]) * DEG);
const steedParts = new FigureParts(renderer, 'steed', renderer.material(PATHFINDER_MATERIAL), ride.kind, 0);
engine.add(steedParts.layer);
steedParts.visible = !boxes;
const steedAt = new Float64Array(3);
/** Extra boom length and pivot height while riding, m. */
const RIDE_BOOM_M = 2.3;
const RIDE_PIVOT_M = 1.15;
/** Brings the steed and the ride's timeline to `a` of the steed's last step, poses the steed and, while the ride poses it, the rider. */
function poseRide(a: number, riderYaw: number): boolean {
  if (boxes) return false;
  ride.update(a);
  ride.watch(at[0]!, at[1]! + 1.5, at[2]!);
  steedParts.write(ride.poseSteed());
  if (!ride.posesRider) return false;
  parts.write(ride.poseRider(at[0]!, at[1]!, at[2]!, riderYaw));
  return true;
}

// The glider (key E gets on and off; src/glide.ts): resting behind car 0, clear of the steed, the cars and the loose
// patch, its take-off run toward −z along x 76. `gx`, `gz`, `gyaw` put it elsewhere; `glide=1` starts on it.
const GLIDER_PLACE: readonly [number, number, number] = [76, 61, 0];
/** The presets' places: on the ground (its own) and in the air (over its take-off run, the run ahead). */
const GLIDER_SCENE: [number, number, number] = [76, 61, 0];
const GLIDER_AIR: [number, number, number] = [76, 58, 0];
/** In the air at the far end of the course, its length ahead (the fast presets). */
const GLIDER_AIR_LONG: [number, number, number] = [60, 112, 0];
const glide = new Glide(world, body, walker, num('gx', GLIDER_PLACE[0]), num('gz', GLIDER_PLACE[1]), num('gyaw', GLIDER_PLACE[2]) * DEG, field.maxY + FLIGHT_CEILING_M);
/** The glider flown through the flight assist (default) or by its raw controls (`assist=0`). */
const GLIDE_ASSISTED = q.get('assist') !== '0';
glide.assisted = GLIDE_ASSISTED;
glide.area = FLIGHT_AREA;
const gliderParts = new FigureParts(renderer, 'glider', renderer.material(PATHFINDER_MATERIAL), glide.kind, 0);
const wings = new Membrane(gliderParts.layer, 'glider wings', glide.kind.membrane, glide.kind.membrane.tones(0), MEMBRANE_UNDER);
engine.add(gliderParts.layer);
gliderParts.visible = !boxes;
wings.visible = !boxes;
const gliderAt = new Float64Array(3);
/** Extra boom length and pivot height on the glider, on the ground and more in the air, m. */
const GLIDE_BOOM_M = 7;
const GLIDE_AIR_BOOM_M = 7;
const GLIDE_PIVOT_M = 2.4;
/** How much lower the view's pivot is in the air than on the ground, so the back and the rider are seen, m. */
const GLIDE_AIR_DROP_M = 1.8;
/** Extra boom in the air at the assist's fast wanted speed (from the cruise up to its top), m. */
const GLIDE_FAST_BOOM_M = 3;
/** The share of the way from the cruise to the top of the assist's wanted speed, 0–1 (0 with the raw controls). */
function glideFast(): number {
  if (!glide.flownByAssist) return 0;
  const lo = GLIDER_ASSIST.cruiseSpeed!, hi = GLIDER_ASSIST.maxSpeed!;
  const t = Math.max(0, Math.min(1, (glide.assist.wantedSpeed - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}
/** Brings the glider and its timeline to `a` of its last step, poses it and, while it poses it, the rider. */
function poseGlide(a: number, riderYaw: number): boolean {
  if (boxes) return false;
  glide.update(a);
  glide.watch(at[0]!, at[1]! + 1.5, at[2]!);
  const bones = glide.pose();
  gliderParts.write(bones);
  wings.write(bones);
  if (!glide.posesRider) return false;
  parts.write(glide.poseRider(at[0]!, at[1]!, at[2]!, riderYaw));
  return true;
}
/** The shadows' bounds reach over the glider while it flies. */
function fitBounds(): void {
  const b = renderer.bounds!;
  const top = Math.max(BOUNDS_TOP, glide.body.position[1]! + 8);
  if (b.max[1] !== top) renderer.bounds = { min: b.min, max: [b.max[0], top, b.max[2]] };
}

// The cars (src/car.ts, drawn by src/car-view.ts): car 0 beside the steed, its driver's door toward the start, car 1
// parked further on; `car0`, `car1` put them elsewhere, `drive=i` starts in car i. The box figure does not get in.
const CAR_PLACES: readonly CarPlace[] = [
  [66, 54.5, 90],
  [51, 50, 0],
];
const carPlace = (k: string, d: CarPlace): CarPlace => {
  const v = (q.get(k) ?? '').split(',').map(Number);
  return v.length === 3 && v.every((x) => Number.isFinite(x)) ? [v[0]!, v[1]!, v[2]!] : d;
};
const cars = new Cars(world, body, walker, CAR_PLACES.map((p, i) => carPlace(`car${i}`, p)), traces.trail);
const carView = new CarView(renderer, renderer.material(CAR_MATERIAL), cars);
engine.add(carView.layer);
engine.add(traces.dust);
// Prints and dust are drawn at the cars' clock, which runs whenever the page steps anything.
renderer.beforeFrame.push(() => traces.setTime(cars.time));
const carM = new Float64Array(12);
const carFigure = new Float64Array(4);
/** Extra boom length and pivot height while driving, m. */
const CAR_BOOM_M = 2.5;
const CAR_PIVOT_M = 0.2;
/** Space held: the handbrake while driving. */
let handbrakeKey = false;

/**
 * The camera follows the driven body: the figure, the steed while riding (a longer boom, a higher pivot), the car
 * while driving (longer still); `a` and `ca` are the steed's and the cars' shares of the way between their steps.
 */
function followDriven(a: number, ca = 1, ga = 1): void {
  const w = boxes ? 0 : ride.seat.weight;
  ride.walker.renderPosition(steedAt, a);
  let x = at[0]! + (steedAt[0]! - at[0]!) * w, y = at[1]! + (steedAt[1]! - at[1]!) * w, z = at[2]! + (steedAt[2]! - at[2]!) * w;
  const gw = boxes ? 0 : glide.seat.weight;
  if (gw > 0) {
    glide.body.renderPosition(gliderAt, ga);
    x += (gliderAt[0]! - x) * gw;
    y += (gliderAt[1]! - y) * gw;
    z += (gliderAt[2]! - z) * gw;
  }
  const c = cars.car >= 0 ? cars.weight(ca) : 0;
  if (c > 0) {
    const b = cars.bodies[cars.car]!;
    b.renderMatrix(carM, ca);
    x += (carM[9]! - x) * c;
    y += (carM[10]! - b.restHeight - y) * c;
    z += (carM[11]! - z) * c;
  }
  // The rig keeps the extra apart from the user's own boom (`distance`), so on foot the boom is the user's again
  // exactly; in first person the boom stays 0 and only the pivot rises.
  rig.extraBoom = RIDE_BOOM_M * w + CAR_BOOM_M * c + (GLIDE_BOOM_M + (GLIDE_AIR_BOOM_M + GLIDE_FAST_BOOM_M * glideFast()) * glide.gait.air) * gw;
  rig.extraPivot = RIDE_PIVOT_M * w + CAR_PIVOT_M * c + (GLIDE_PIVOT_M - GLIDE_AIR_DROP_M * glide.gait.air) * gw;
  // The extra goes beyond the user's farthest zoom (the glider in the air is framed from about 18 m, 21 m fast).
  rig.setup.maxDistance = MAX_BOOM_M + rig.extraBoom;
  rig.follow(x, y, z);
}

/**
 * While driving or on the glider, the camera's heading follows the car's or the glider's (the rig eases it and waits
 * after the user turns the view); otherwise, and while a script holds the page, nothing follows.
 */
function swingBehind(ca: number, ga: number): void {
  const heading = frozen ? null : cars.mode === 'on' ? cars.bodies[cars.car]!.renderYaw(ca) / DEG : glide.mode === 'on' ? glide.body.renderYaw(ga) / DEG : null;
  rig.followHeading(heading);
}

/**
 * Poses the figures at the drawn places: the steed and the glider, the rider while riding either, the figure getting
 * in or out of a car, otherwise the figure on its walker; then the cars.
 */
function poseAll(a: number, sa: number, ca: number, ga: number): void {
  const yaw = walker.renderYaw(a);
  const onSteed = poseRide(sa, yaw);
  const onGlider = poseGlide(ga, yaw);
  const riderPosed = onSteed || onGlider;
  if (!boxes && cars.posesFigure) parts.write(cars.poseFigure(carFigure, cars.figurePlace(ca, carFigure)));
  else if (!riderPosed) poseFigure(yaw);
  carView.write(ca);
}

/** The traces of what happened since the last call: the figure's, the steed's and the glider's footfalls, the wheels' dust. */
function leaveTraces(): void {
  const now = cars.time;
  traces.feet(body, !boxes && !ride.posesRider && !glide.posesRider && !cars.posesFigure && walker.grounded, walker.yaw, now);
  if (!boxes) traces.hooves(ride, now);
  if (!boxes) traces.paws(glide, now);
  traces.wheels(cars, now);
}
// Only the figure of `figure=` is drawn.
if (!boxes) (figure.set.visible = false), (figure.set.dirty = true);
/** Shows the drawn figure (the one of `figure=`) or hides it. */
function showFigure(on: boolean): void {
  if (boxes) {
    if (figure.set.visible !== on) (figure.set.visible = on), (figure.set.dirty = true);
  } else parts.visible = on;
}
/** Another movement profile: the walker is retuned, the figure gets a gait of the profile. */
function setMoveProfile(p: MoveProfile): void {
  moveProfile = p;
  walker.retune(p.walker);
  body.setProfile(p);
}

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
const flyIntent = newFlyingIntent();
/** What the rider means for the glider's flight assist (speed, climb, turn). */
const flyInput = newFlightAssistInput();
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
if (q.get('ride') === '1' && !boxes) ride.mount(true);
else if (q.get('glide') === '1' && !boxes) {
  glide.mount(true);
  rig.yawDeg = glide.body.yaw / DEG;
}
else if (q.has('drive') && !boxes) {
  const i = Math.round(num('drive', 0));
  if (i >= 0 && i < cars.bodies.length) {
    const d = cars.doorSpot(i, 1);
    place(d[0]!, d[2]!, d[3]!);
    cars.enter(i, true);
    rig.yawDeg = cars.bodies[i]!.yaw / DEG;
  }
}
window.addEventListener('keydown', (e) => {
  if (e.key === ' ') handbrakeKey = true;
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') handbrakeKey = false;
});
window.addEventListener('blur', () => (handbrakeKey = false));

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
  if (cars.active) {
    // Driving: forward and back are throttle (back brakes, then reverses), right steers; the figure's walker is parked.
    cars.drive.throttle = state.forward;
    cars.drive.steer = state.right;
    cars.drive.brake = 0;
    cars.drive.handbrake = handbrakeKey;
    asking ||= handbrakeKey;
    cars.advance(engine.frameSeconds);
    if (!boxes) ride.advance(engine.frameSeconds, null);
    if (!boxes) glide.advance(engine.frameSeconds, null);
    return;
  }
  if (boxes) walker.advance(engine.frameSeconds, intent);
  else if (glide.riding) {
    // On the glider: crawl and turn on the ground, Space leaps; in the air the assist (W/S faster and slower, A/D
    // turn, Space climbs, Shift descends) or the raw controls (W/S pitch, A/D bank, Space beats, Shift flares).
    steerGlider(flyIntent, state.forward, state.right, state.jump, handbrakeKey, state.run);
    asking ||= handbrakeKey || !glide.body.grounded;
    glide.advance(engine.frameSeconds, flyIntent, flyInput);
    ride.advance(engine.frameSeconds, null);
  } else if (ride.riding) ride.advance(engine.frameSeconds, intent);
  else {
    walker.advance(engine.frameSeconds, intent);
    ride.advance(engine.frameSeconds, null);
  }
  if (!boxes && !glide.riding) glide.advance(engine.frameSeconds, null);
  cars.advance(engine.frameSeconds);
});

/**
 * The glider's intent and the assist's input from the keys: forward (W +), right (D +), a leap, Space held, Shift
 * held. The raw intent: on the ground the crawl and the leap, in the air W/S pitch, Space the beats, Shift the flare.
 * The assist's input (used unless `assist=0`): in the air W/S the throttle, Space the climb, Shift the descent; A/D
 * turn in both.
 */
function steerGlider(out: typeof flyIntent, forward: number, right: number, leap: boolean, space: boolean, shift: boolean): void {
  const air = !glide.body.grounded;
  out.forward = air ? 0 : forward;
  out.turn = right;
  out.pitch = air ? -forward : 0;
  out.beat = space ? 1 : 0;
  out.brake = air && shift ? 1 : 0;
  out.takeOff ||= leap && !air;
  flyInput.throttle = air ? forward : 0;
  flyInput.climb = air ? (space ? 1 : 0) - (shift ? 1 : 0) : 0;
  flyInput.turn = right;
}

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
  const sa = frozen ? 1 : ride.walker.alpha;
  const ca = frozen ? 1 : cars.alpha;
  const ga = frozen ? 1 : glide.body.alpha;
  walker.renderPosition(at, a);
  swingBehind(ca, ga);
  followDriven(sa, ca, ga);
  rig.update(engine.frameSeconds);
  if (!ride.riding && !glide.riding && !cars.active) sampleMotion(a);
  poseAll(a, sa, ca, ga);
  fitBounds();
  leaveTraces();
  // In first person the body would fill the near plane; seated in a shut car it is not drawn.
  showFigure(rig.boom >= 0.35 && cars.figureShown);
  rig.eye(eye);
  moving =
    cars.busy ||
    (!boxes && (ride.mode === 'mounting' || ride.mode === 'dismounting' || ride.posesRider !== ride.riding || ride.gait.speed > 0.01 || ride.gait.dip > 1e-4)) ||
    (!boxes && (glide.mode === 'mounting' || glide.mode === 'dismounting' || glide.posesRider !== glide.riding || !glide.body.grounded || glide.gait.air > 0 || glide.gait.ground.speed > 0.01 || glide.body.beatEffort > 0 || glide.riding || glide.near())) ||
    Math.abs(at[0]! - lastAt[0]!) + Math.abs(at[1]! - lastAt[1]!) + Math.abs(at[2]! - lastAt[2]!) > 1e-5 ||
    Math.abs(eye[0] - lastEye[0]) + Math.abs(eye[1] - lastEye[1]) + Math.abs(eye[2] - lastEye[2]) > 1e-5;
  lastAt.set(at);
  lastEye[0] = eye[0];
  lastEye[1] = eye[1];
  lastEye[2] = eye[2];
  if (++hudFrame % 6 === 0) hudEl.textContent = hud();
});
// The loop draws on demand; while the body or the view still moves, or a key is held, it keeps going.
engine.animateWhile(() => !frozen && (moving || asking || !walker.grounded || walker.steep || input.gamepadConnected || traces.busy()));

// --- HUD ---------------------------------------------------------------------------------------------------------------------
const hudEl = document.getElementById('hud')!;
let hudFrame = 0;
function hud(): string {
  const s = walkState(!boxes && ride.riding ? ride.walker : walker);
  if (!boxes && glide.riding) {
    const p = glide.body.position, v = glide.body.velocity;
    s.x = p[0]!;
    s.y = p[1]!;
    s.z = p[2]!;
    s.speed = Math.hypot(v[0]!, v[2]!);
    s.grounded = glide.body.grounded;
    s.steep = false;
  }
  const st = stationAt(s.x, s.z);
  const ft = frameTimes();
  const rs = renderer.lastStats;
  const fps = ft.frames > 10 && ft.meanMs > 0 ? `${ft.meanMs.toFixed(1)} ms/frame (${(1000 / ft.meanMs).toFixed(0)} fps, worst ${ft.worstMs.toFixed(1)} ms, cpu ${ft.cpuMs.toFixed(1)} ms)` : 'measuring the frame time…';
  const mode = rig.distance <= 0 ? 'first person' : `behind the ${cars.mode === 'on' ? 'car' : ride.riding ? 'steed' : glide.riding ? 'glider' : 'figure'} ${rig.boom.toFixed(1)} m`;
  const r = ride.status();
  const riding = boxes
    ? ''
    : ride.riding
      ? `Riding: ${r.mode === 'on' ? `${r.speed.toFixed(2)} m/s, ${['walk', 'trot', 'gallop'][r.patterns.indexOf(Math.max(...r.patterns))]}` : r.mode} · E get off · T ${ride.trot ? 'walk' : 'trot'} · Shift gallop`
      : '';
  const use = nearestToUse();
  const driving = cars.active ? drivingLine() : use === -1 ? 'E: get on the steed' : use === -2 ? 'E: get on the glider' : use !== null ? 'E: get in' : '';
  const gliding = !boxes && glide.riding ? glidingLine() : '';
  return [
    `Movement test course  seed ${seed}  ·  profile ${moveProfile.name} (P)`,
    `Pad: ${st ? st.label : 'between pads'}`,
    ...(driving ? [driving] : riding ? [riding] : gliding ? [gliding] : []),
    `x ${s.x.toFixed(2)}  y ${s.y.toFixed(2)}  z ${s.z.toFixed(2)}  speed ${s.speed.toFixed(2)} m/s  ${s.grounded ? (s.steep ? 'on a steep slope, sliding' : 'on the ground') : 'in the air'}  view ${mode}${wireOn ? '  collision solids' : ''}`,
    cars.mode === 'on'
      ? `W/S throttle, brake and reverse · A/D steer · space handbrake · E get out (stopped) · R right the car · drag turn · wheel camera · F first person · C solids`
      : glide.mode === 'on'
        ? glide.body.grounded
          ? `W/S crawl · A/D turn · space ${glide.flownByAssist ? 'take off' : 'leap, hold to beat'} · E get off (stopped) · drag turn · wheel camera · F first person · C solids`
          : glide.flownByAssist
            ? `W faster · S slower · A/D turn · hold space climb · hold Shift descend (lands on the ground) · drag turn · wheel camera · F first person · C solids`
            : `W nose down · S nose up · A/D bank · hold space beat · Shift flare · drag turn · wheel camera · F first person · C solids`
        : `WASD/arrows walk · Shift run · space jump · E get on, in, off or out · T trot · drag turn · wheel camera · F first person · C solids · R start · P profile`,
    `${fps} · ${(rs.triangles / 1e3).toFixed(0)} k triangles · ${rs.drawCalls} draws · ${rig.width}×${rig.height} px (dpr ${rig.dpr.toFixed(2)}) · ${world.solidCount} solids`,
  ].join('\n');
}

/** The HUD's line of the glider. */
function glidingLine(): string {
  const g = glide.status();
  if (g.mode !== 'on') return g.mode === 'mounting' ? 'Getting on the glider…' : 'Getting off the glider…';
  if (g.grounded) return `Glider: crawling ${g.speed.toFixed(1)} m/s${glide.canDismount() ? ' · E get off' : ''}`;
  const state = g.stalled ? 'stalling' : g.flare > 0.3 ? 'flaring' : g.beat > 0.3 ? 'beating' : g.climb < -0.3 ? 'gliding down' : 'gliding';
  if (glide.flownByAssist) {
    const w = g.wantedSpeed;
    const band = w < 11 ? 'slow' : w < 16 ? 'cruise' : 'fast';
    return `Glider: ${(g.speed * 3.6).toFixed(0)} km/h · wanted ${(w * 3.6).toFixed(0)} km/h (${band}) · ${g.altitude.toFixed(1)} m up · climb ${g.climb.toFixed(1)} m/s · beats ${(g.beat * 100).toFixed(0)} % · ${state}`;
  }
  return `Glider: ${(g.speed * 3.6).toFixed(0)} km/h · ${g.altitude.toFixed(1)} m up · climb ${g.climb.toFixed(1)} m/s · bank ${g.bankDeg.toFixed(0)}° · ${state}`;
}

/** The HUD's line of the drive. */
function drivingLine(): string {
  if (cars.mode !== 'on') return cars.mode === 'entering' ? 'Getting in…' : 'Getting out…';
  const b = cars.bodies[cars.car]!;
  const v = b.forwardSpeed;
  const up = b.rotation[4]!;
  const state = up < 0.5 ? 'overturned, R puts it back on its wheels' : b.wheels.every((w) => !w.grounded) ? 'in the air' : Math.abs(v) < CAR_EXIT_SPEED_MS ? 'E get out' : v < 0 ? 'reversing' : 'driving';
  return `Car ${cars.car + 1}: ${(Math.abs(v) * 3.6).toFixed(0)} km/h${v < -0.3 ? ' back' : ''} · steer ${(b.steerAngle / DEG).toFixed(0)}° · ${state}`;
}

// --- Keys -------------------------------------------------------------------------------------------------------------------
function toggleFirstPerson(): void {
  if (rig.distance > 0) {
    thirdPersonDistance = rig.distance;
    rig.distance = 0;
  } else rig.distance = thirdPersonDistance;
}
/**
 * What E gets into from foot now: the nearest of the steed, the glider and the cars by the share of their reach (−1
 * the steed, −2 the glider).
 */
function nearestToUse(): number | null {
  if (boxes || cars.active || ride.mode !== 'off' || glide.mode !== 'off') return null;
  const p = walker.position, h = ride.walker.position, gp = glide.body.position;
  const steed = ride.near() ? Math.hypot(p[0]! - h[0]!, p[2]! - h[2]!) / RIDE_REACH_M : Infinity;
  const glider = glide.near() ? Math.hypot(p[0]! - gp[0]!, p[2]! - gp[2]!) / GLIDE_REACH_M : Infinity;
  const i = cars.nearest();
  const car = i >= 0 ? cars.distance(i) / CAR_REACH_M : Infinity;
  const best = Math.min(steed, glider, car);
  if (best === Infinity) return null;
  return best === car ? i : best === steed ? -1 : -2;
}
/** E: out of the car or off the steed or the glider, or into the nearest of them. */
function useNearest(): void {
  if (boxes) return;
  if (cars.active) {
    if (cars.mode === 'on') cars.exit();
    return;
  }
  if (ride.mode !== 'off') {
    ride.toggle();
    return;
  }
  if (glide.mode !== 'off') {
    glide.toggle();
    return;
  }
  const n = nearestToUse();
  if (n === -1) ride.toggle();
  else if (n === -2) glide.toggle();
  else if (n !== null) cars.enter(n);
}
const KEYS: Record<string, () => void> = {
  f: toggleFirstPerson,
  c: () => showWire(!wireOn),
  r: () => {
    if (cars.mode === 'on') return cars.resetCar();
    if (cars.active) return;
    if (ride.riding) ride.dismount(true);
    if (glide.riding) {
      glide.dismount(true);
      glide.put(GLIDER_PLACE[0], GLIDER_PLACE[1], GLIDER_PLACE[2] * DEG);
    }
    place(course.start[0], course.start[1], course.start[2]);
  },
  e: useNearest,
  t: () => ride.setTrot(!ride.trot),
  p: () => setMoveProfile(PROFILES[(PROFILES.indexOf(moveProfile) + 1) % PROFILES.length]!),
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
  /** A riding scene: put the steed down, the figure in the saddle at once, then hold inputs (the page stays frozen). */
  ride?: RideScene;
  /** A driving scene: the cars put down, the figure in one (or getting in), then hold inputs (the page stays frozen). */
  drive?: DriveScene;
  /** A gliding scene: the glider put down (or in the air), the figure on it (or getting on), then hold inputs. */
  glide?: GlideScene;
  /** Put the figure on the ground here first: x, z and optionally its heading in degrees. */
  at?: [number, number] | [number, number, number];
  yawDeg?: number;
  pitchDeg?: number;
  distance?: number;
}

/** A riding scene of a preset: deterministic, reached by fixed steps from a fixed place. */
interface RideScene {
  /** The steed's place: x, z and the heading in degrees (0 faces −z). */
  at: [number, number, number];
  trot?: boolean;
  /** Inputs held one after the other, in the frame of a view behind the steed as it was put down. */
  holds: { input: HoldInput; seconds: number }[];
  /** The camera's heading against the steed's at the end (degrees; 0 behind it, 90 on its left side). */
  yawRel: number;
}

/** A gliding scene of a preset: deterministic, reached by fixed steps from a fixed place. */
interface GlideScene {
  /** The glider's place: x, z and the heading in degrees (0 faces −z). */
  at: [number, number, number];
  /** Put in the air instead: this high over the ground there (m), flying level at `speed` m/s. */
  air?: { height: number; speed: number };
  /** The figure starts this far out beside the glider's left wing and gets on (instead of sitting on already), m. */
  getOn?: number;
  /** Flown through the flight assist (and its wanted speed set to this, m/s) instead of the raw controls. */
  assist?: number;
  /** Inputs held one after the other (`use` presses E: getting off once it has stopped). */
  holds: { input: HoldInput; seconds: number }[];
  /** The camera's heading against the glider's at the end (degrees; 0 behind it, 90 on its left side). */
  yawRel: number;
}

/** A driving scene of a preset: deterministic, reached by fixed steps from fixed places. */
interface DriveScene {
  /** The car driven (default 0). */
  car?: number;
  /** Its place: x, z and the heading in degrees (default: its own place on the start pad). */
  at?: [number, number, number];
  /** The figure starts this far out from the driver's door and gets in (instead of sitting in already), m. */
  getIn?: number;
  /** Inputs held one after the other. */
  holds: { input: HoldInput; seconds: number }[];
  /** The camera's heading against the car's at the end (degrees; 0 behind it, −90 on its left, the driver's side). */
  yawRel: number;
}

/** One preset per station: the figure on the station's spot, the camera behind it a little higher than walking. */
const PRESETS: ViewState[] = [
  ...STATIONS.map((s): ViewState => ({ name: s.id, at: [s.spot[0], s.spot[1], s.spot[2] / DEG], yawDeg: s.spot[2] / DEG + 25, pitchDeg: 22, distance: 9 })),
  // Riding: standing, walking, trotting and galloping straight, a turn at a trot, and up the 20° ramp and the stairs.
  { name: 'ride-stand', ride: { at: [60, 52, 0], holds: [{ input: {}, seconds: 2 }], yawRel: 75 }, pitchDeg: 12, distance: 6.5 },
  { name: 'ride-walk', ride: { at: [60, 70, 0], holds: [{ input: { forward: 1 }, seconds: 4 }], yawRel: 90 }, pitchDeg: 10, distance: 6.5 },
  { name: 'ride-trot', ride: { at: [60, 72, 0], trot: true, holds: [{ input: { forward: 1 }, seconds: 4 }], yawRel: 90 }, pitchDeg: 10, distance: 6.5 },
  { name: 'ride-gallop', ride: { at: [60, 82, 0], holds: [{ input: { forward: 1, run: true }, seconds: 5 }], yawRel: 90 }, pitchDeg: 10, distance: 7 },
  { name: 'ride-turn', ride: { at: [56, 70, 0], trot: true, holds: [{ input: { forward: 1 }, seconds: 2 }, { input: { right: 1 }, seconds: 1.1 }], yawRel: 150 }, pitchDeg: 16, distance: 7 },
  { name: 'ride-slope', ride: { at: [89, 52, -90], holds: [{ input: { forward: 1 }, seconds: 7.5 }], yawRel: 80 }, pitchDeg: 8, distance: 7 },
  { name: 'ride-steps', ride: { at: [86.5, 16, -90], holds: [{ input: { forward: 1 }, seconds: 5.6 }], yawRel: 80 }, pitchDeg: 8, distance: 7 },
  // Driving car 0: standing, pulling away (the nose up), braking (the nose down), a left turn (rolled outward), a
  // handbrake turn (sliding, laying tyre marks), up the 20° ramp, off the end of the ramps' plateau (in the air), a slow
  // knock into the parked car 1 (touching it), and getting in (half way).
  { name: 'car-stand', drive: { holds: [{ input: {}, seconds: 1.5 }], yawRel: -60 }, pitchDeg: 12, distance: 9 },
  { name: 'car-accelerate', drive: { at: [56, 47, 180], holds: [{ input: { throttle: 1 }, seconds: 1 }], yawRel: -90 }, pitchDeg: 8, distance: 9 },
  { name: 'car-brake', drive: { at: [56, 47, 180], holds: [{ input: { throttle: 1 }, seconds: 2.4 }, { input: { brake: 1 }, seconds: 0.35 }], yawRel: -90 }, pitchDeg: 8, distance: 9 },
  { name: 'car-turn', drive: { at: [56, 47, 180], holds: [{ input: { throttle: 1 }, seconds: 2.4 }, { input: { throttle: 0.6, steer: -1 }, seconds: 0.9 }], yawRel: 180 }, pitchDeg: 10, distance: 9 },
  { name: 'car-handbrake', drive: { at: [56, 47, 180], holds: [{ input: { throttle: 1 }, seconds: 2.6 }, { input: { steer: -1, handbrake: true }, seconds: 0.8 }], yawRel: -140 }, pitchDeg: 22, distance: 10 },
  { name: 'car-ramp', drive: { at: [89, 52, -90], holds: [{ input: { throttle: 1 }, seconds: 2.3 }], yawRel: -80 }, pitchDeg: 8, distance: 10 },
  { name: 'car-jump', drive: { at: [108, 70, 0], holds: [{ input: { throttle: 1 }, seconds: 3.8 }], yawRel: -90 }, pitchDeg: 6, distance: 12 },
  { name: 'car-bump', drive: { at: [51, 57.8, 0], holds: [{ input: { throttle: 0.6 }, seconds: 1 }, { input: {}, seconds: 1.6 }], yawRel: -70 }, pitchDeg: 14, distance: 10 },
  { name: 'car-get-in', drive: { getIn: 1.2, holds: [{ input: {}, seconds: 1.35 }], yawRel: -60 }, pitchDeg: 10, distance: 6 },
  // Traces on the patch of loose ground in front of the start: the steed trotting and galloping across it (prints and
  // dust), a car driven across it (ruts and dust) and one turned on it with the handbrake (sliding).
  { name: 'trace-trot', ride: { at: [60, 58, 0], trot: true, holds: [{ input: { forward: 1 }, seconds: 3.4 }], yawRel: 120 }, pitchDeg: 18, distance: 7 },
  { name: 'trace-gallop', ride: { at: [60, 68, 0], holds: [{ input: { forward: 1, run: true }, seconds: 3.7 }], yawRel: 130 }, pitchDeg: 16, distance: 8 },
  { name: 'trace-car', drive: { at: [76, 52.8, 90], holds: [{ input: { throttle: 1 }, seconds: 2.2 }], yawRel: -150 }, pitchDeg: 16, distance: 10 },
  { name: 'trace-handbrake', drive: { at: [72, 50, 90], holds: [{ input: { throttle: 1 }, seconds: 1.6 }, { input: { steer: -1, handbrake: true }, seconds: 0.7 }], yawRel: -150 }, pitchDeg: 22, distance: 10 },
  // The glider: standing, crawling, the leap and the first beats of a take-off, gliding level, beating its wings, a
  // banked turn, a landing (the flare and the touch-down), and getting on and off.
  { name: 'glide-stand', glide: { at: GLIDER_SCENE, holds: [{ input: {}, seconds: 2 }], yawRel: 60 }, pitchDeg: 14, distance: 7 },
  { name: 'glide-crawl', glide: { at: GLIDER_SCENE, holds: [{ input: { forward: 1 }, seconds: 3 }], yawRel: 80 }, pitchDeg: 12, distance: 7 },
  { name: 'glide-takeoff', glide: { at: GLIDER_SCENE, holds: [{ input: { forward: 1 }, seconds: 1.5 }, { input: { forward: 1, jump: true, beat: true }, seconds: 0.5 }], yawRel: 70 }, pitchDeg: 8, distance: 8 },
  { name: 'glide-fly', glide: { at: GLIDER_AIR, air: { height: 14, speed: 11 }, holds: [{ input: {}, seconds: 2 }], yawRel: 25 }, pitchDeg: 18, distance: 8 },
  { name: 'glide-beat', glide: { at: GLIDER_AIR, air: { height: 14, speed: 11 }, holds: [{ input: { beat: true }, seconds: 1.3 }], yawRel: 20 }, pitchDeg: 16, distance: 8 },
  { name: 'glide-turn', glide: { at: GLIDER_AIR, air: { height: 16, speed: 11 }, holds: [{ input: {}, seconds: 1 }, { input: { right: 1 }, seconds: 1.6 }], yawRel: -30 }, pitchDeg: 14, distance: 8 },
  { name: 'glide-land', glide: { at: GLIDER_AIR, air: { height: 4, speed: 10 }, holds: [{ input: { forward: 0.4 }, seconds: 0.8 }, { input: { flare: true }, seconds: 0.7 }], yawRel: 70 }, pitchDeg: 8, distance: 8 },
  { name: 'glide-mount', glide: { at: GLIDER_SCENE, getOn: 1.5, holds: [{ input: {}, seconds: 1.3 }], yawRel: 80 }, pitchDeg: 12, distance: 6 },
  { name: 'glide-dismount', glide: { at: GLIDER_SCENE, holds: [{ input: {}, seconds: 0.3 }, { input: { use: true }, seconds: 0.6 }], yawRel: 80 }, pitchDeg: 12, distance: 6 },
  // The glider through the flight assist: slow flight (light, slow beats), the cruise, fast flight (hard, fast beats,
  // the wings swept back; along the course's length), slowing down from fast (the flare, the wings cupped), a banked
  // turn, a climb, and a descent to the ground that lands by itself.
  { name: 'glide-assist-slow', glide: { at: GLIDER_AIR, air: { height: 16, speed: 8.7 }, assist: 8.7, holds: [{ input: {}, seconds: 3 }], yawRel: 25 }, pitchDeg: 14, distance: 4.5 },
  { name: 'glide-assist-cruise', glide: { at: GLIDER_AIR, air: { height: 16, speed: 13 }, assist: 13, holds: [{ input: {}, seconds: 3 }], yawRel: 25 }, pitchDeg: 14, distance: 4.5 },
  { name: 'glide-assist-fast', glide: { at: GLIDER_AIR_LONG, air: { height: 16, speed: 13 }, assist: 13, holds: [{ input: { forward: 1 }, seconds: 1.2 }, { input: {}, seconds: 2.2 }], yawRel: 25 }, pitchDeg: 14, distance: 4.5 },
  { name: 'glide-assist-slowing', glide: { at: GLIDER_AIR_LONG, air: { height: 16, speed: 20 }, assist: 20, holds: [{ input: {}, seconds: 1 }, { input: { forward: -1 }, seconds: 1.4 }, { input: {}, seconds: 0.4 }], yawRel: 25 }, pitchDeg: 14, distance: 4.5 },
  { name: 'glide-assist-turn', glide: { at: GLIDER_AIR, air: { height: 16, speed: 13 }, assist: 13, holds: [{ input: { right: 1 }, seconds: 2.5 }], yawRel: 30 }, pitchDeg: 14, distance: 4.5 },
  { name: 'glide-assist-climb', glide: { at: GLIDER_AIR, air: { height: 10, speed: 13 }, assist: 13, holds: [{ input: { beat: true }, seconds: 2.5 }], yawRel: 60 }, pitchDeg: 8, distance: 4.5 },
  { name: 'glide-assist-land', glide: { at: GLIDER_AIR, air: { height: 8, speed: 8.7 }, assist: 8.7, holds: [{ input: { flare: true }, seconds: 4.2 }], yawRel: 70 }, pitchDeg: 8, distance: 4.5 },
];

function setView(v: ViewState): void {
  if (v.ride && !boxes) {
    if (cars.active) cars.stopDriving();
    rideScene(v.ride);
    rig.yawDeg = ride.walker.yaw / DEG + v.ride.yawRel;
  }
  if (v.drive && !boxes) {
    driveScene(v.drive);
    rig.yawDeg = cars.bodies[cars.car]!.yaw / DEG + v.drive.yawRel;
  }
  if (v.glide && !boxes) {
    if (cars.active) cars.stopDriving();
    glideScene(v.glide);
    rig.yawDeg = glide.body.yaw / DEG + v.glide.yawRel;
  }
  if (v.at) {
    const yaw = v.at[2] !== undefined ? v.at[2] * DEG : walker.yaw;
    place(v.at[0], v.at[1], yaw);
  }
  if (v.yawDeg !== undefined) rig.yawDeg = v.yawDeg;
  if (v.pitchDeg !== undefined) rig.pitchDeg = Math.min(rig.setup.maxPitchDeg, Math.max(rig.setup.minPitchDeg, v.pitchDeg));
  if (v.distance !== undefined) {
    // A view's distance is the user's boom, without the riding or driving extra, which the rig adds (`extraBoom`).
    rig.distance = Math.max(0, Math.min(rig.setup.maxDistance, v.distance));
  }
  walker.renderPosition(at);
  followDriven(1);
  rig.snap();
  engine.renderNow();
}

/**
 * Puts the steed and the cars back on their places, the driven car where the scene says, the figure in it (or beside
 * its door, getting in), freezes the page and holds the inputs.
 */
function driveScene(d: DriveScene): void {
  frozen = true;
  traces.clear(boxes ? null : ride, boxes ? null : glide);
  if (ride.riding) ride.dismount(true);
  putGliderHome();
  ride.setTrot(false);
  ride.put(STEED_PLACE[0], STEED_PLACE[1], STEED_PLACE[2] * DEG);
  cars.stopDriving();
  CAR_PLACES.forEach((p, i) => cars.put(i, p[0], p[1], p[2] * DEG));
  const i = d.car ?? 0;
  if (d.at) cars.put(i, d.at[0], d.at[1], d.at[2] * DEG);
  const spot = cars.doorSpot(i, 1);
  const yaw = spot[3]!;
  if (d.getIn !== undefined) {
    // Out from the door along the car's left (the left is (−cos yaw, sin yaw)), facing the door.
    const x = spot[0]! - Math.cos(yaw) * d.getIn, z = spot[2]! + Math.sin(yaw) * d.getIn;
    walker.teleport(x, world.groundAt(x, z, 1e4, 0), z, yaw - Math.PI / 2);
    cars.enter(i);
  } else {
    walker.teleport(spot[0]!, spot[1]!, spot[2]!, yaw);
    cars.enter(i, true);
  }
  rig.yawDeg = yaw / DEG;
  for (const h of d.holds) hold(h.input, h.seconds);
}

/** Puts the steed down at the scene's place with the figure in the saddle, freezes the page and holds the inputs. */
function rideScene(r: RideScene): void {
  frozen = true;
  traces.clear(ride, glide);
  if (ride.riding) ride.dismount(true);
  putGliderHome();
  ride.setTrot(r.trot ?? false);
  ride.put(r.at[0], r.at[1], r.at[2] * DEG);
  // The figure's walker beside the steed (parked while it rides); the view behind the steed.
  walker.teleport(r.at[0], world.groundAt(r.at[0], r.at[1], 1e4, 0), r.at[1], r.at[2] * DEG);
  ride.mount(true);
  rig.yawDeg = r.at[2];
  for (const h of r.holds) hold(h.input, h.seconds);
}

/** Off the glider at once and the glider back on its place. */
function putGliderHome(): void {
  if (glide.riding || glide.mode !== 'off') glide.dismount(true);
  glide.put(GLIDER_PLACE[0], GLIDER_PLACE[1], GLIDER_PLACE[2] * DEG);
}

/**
 * Puts the glider down (or in the air) at the scene's place with the figure on it (or beside its left wing, getting
 * on), the steed and the cars on their places, freezes the page and holds the inputs.
 */
function glideScene(g: GlideScene): void {
  frozen = true;
  traces.clear(ride, glide);
  if (ride.riding) ride.dismount(true);
  ride.setTrot(false);
  ride.put(STEED_PLACE[0], STEED_PLACE[1], STEED_PLACE[2] * DEG);
  CAR_PLACES.forEach((p, i) => cars.put(i, p[0], p[1], p[2] * DEG));
  if (glide.mode !== 'off') glide.dismount(true);
  const yaw = g.at[2] * DEG;
  if (g.air) glide.launch(g.at[0], world.groundAt(g.at[0], g.at[1], 1e4, 0) + g.air.height, g.at[1], yaw, g.air.speed);
  else glide.put(g.at[0], g.at[1], yaw);
  glide.assisted = g.assist !== undefined;
  if (g.assist !== undefined) glide.assist.wantedSpeed = g.assist;
  if (g.getOn !== undefined) {
    // Out to the left of the spot behind the left wing where it is got on (left (−cos yaw, sin yaw), back
    // (sin yaw, cos yaw)), facing the glider.
    const side = 1.7 + g.getOn, back = 3.3;
    const x = g.at[0] - Math.cos(yaw) * side + Math.sin(yaw) * back, z = g.at[1] + Math.sin(yaw) * side + Math.cos(yaw) * back;
    walker.teleport(x, world.groundAt(x, z, 1e4, 0), z, yaw - Math.PI / 2);
    glide.mount();
  } else {
    walker.teleport(g.at[0], world.groundAt(g.at[0], g.at[1], 1e4, 0), g.at[1], yaw);
    glide.mount(true);
  }
  rig.yawDeg = g.at[2];
  for (const h of g.holds) hold(h.input, h.seconds);
}

function hash(): string {
  const r = (x: number, d = 2): string => String(Math.round(x * 10 ** d) / 10 ** d);
  const p = walker.position;
  const extra = ['lock', 'pr'].filter((k) => q.has(k)).map((k) => `&${k}=${q.get(k)}`).join('');
  const looks = `${moveProfile.name !== 'default' ? `&profile=${moveProfile.name}` : ''}${boxes ? '&figure=boxes' : ''}`;
  const h = ride.walker.position;
  const steed = boxes ? '' : `${ride.riding ? '&ride=1' : ''}&hx=${r(h[0]!)}&hz=${r(h[2]!)}&hyaw=${r(ride.walker.yaw / DEG, 1)}`;
  const carPlaces = cars.bodies.map((_, i) => {
    const c = cars.place(i);
    return `&car${i}=${r(c[0])},${r(c[1])},${r(c[2], 1)}`;
  });
  const drive = `${cars.mode === 'on' ? `&drive=${cars.car}` : ''}${carPlaces.join('')}`;
  const gp = glide.body.position;
  const glider = boxes ? '' : `${glide.riding ? '&glide=1' : ''}&gx=${r(gp[0]!)}&gz=${r(gp[2]!)}&gyaw=${r(glide.body.yaw / DEG, 1)}`;
  return `seed=${seed}&x=${r(p[0]!)}&z=${r(p[2]!)}&yaw=${r(walker.yaw / DEG, 1)}&fp=${rig.distance <= 0 ? 1 : 0}&c=${wireOn ? 1 : 0}${looks}${steed}${drive}${glider}${extra}`;
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
  /** While riding: the steed's slower gait is the trot (as the key T), kept after the hold. */
  trot?: boolean;
  /** While driving: throttle −1..1 (backward brakes, then reverses), brake 0..1, steer −1..1 (right +), handbrake. */
  throttle?: number;
  brake?: number;
  steer?: number;
  handbrake?: boolean;
  /**
   * On the glider: Space held (with `jump` the leap off the ground; in the air the assist's climb, or the raw beats),
   * Shift held (the assist's descent, or the raw flare); `forward` is the assist's throttle or the raw pitch.
   */
  beat?: boolean;
  flare?: boolean;
  /** Press E in the first step (get on or off, in or out, as the key). */
  use?: boolean;
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
  if (o.trot !== undefined) ride.setTrot(o.trot);
  const d = cars.drive;
  for (let i = 0; i < n; i++) {
    held.jump = i === 0 && (o.jump ?? false);
    if (i === 0 && o.use) useNearest();
    if (!boxes && glide.riding) {
      // On the glider: the keys steer it (forward and right as the keys, not the view), the walker stays parked.
      flyIntent.takeOff = false;
      steerGlider(flyIntent, f, r, held.jump, o.beat ?? false, o.flare ?? false);
      glide.step(flyIntent, flyInput);
      ride.step(null);
      cars.step();
    } else if (cars.active) {
      // Driving (or getting in or out): the input drives the car, the figure's walker stays parked, the steed stands.
      d.throttle = o.throttle ?? 0;
      d.brake = o.brake ?? 0;
      d.steer = o.steer ?? 0;
      d.handbrake = o.handbrake ?? false;
      cars.step();
      if (!boxes) ride.step(null);
    } else {
      // While riding the input steers the steed and the figure's walker stays parked; otherwise the steed stands.
      if (boxes || !ride.riding) walker.step(held);
      if (!boxes) ride.step(ride.riding ? held : null);
      if (!ride.riding) sampleMotion(1);
      cars.step();
    }
    if (!boxes && !glide.riding) glide.step(null);
    // The figures are posed after every step, so the lagging ponytail and tail see every step too.
    walker.renderPosition(at, 1);
    poseAll(1, 1, 1, 1);
    leaveTraces();
  }
  walker.renderPosition(at, 1);
  followDriven(1);
  rig.snap();
  engine.renderNow();
  return walkState(boxes || !ride.riding ? walker : ride.walker);
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
  /** `distance` is the user's boom (as `setView` takes it), `extraBoom` what riding or driving adds, `boom` the drawn length. */
  getView: () => ({ yawDeg: rig.yawDeg, pitchDeg: rig.pitchDeg, distance: rig.distance, extraBoom: rig.extraBoom, boom: rig.boom, pivot: [...rig.pivot], eye: rig.eye() }),
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
   * Holds a direction toward (x, z) for `seconds` of fixed walker steps (synchronously; with `profile=engine` the same
   * path as `pnpm check:walk`), then draws; returns the state at the end. Options: `run`, `jump` (jump by itself at
   * edges and ledges), `within`.
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
    // Live again: the glider flies as the page's hash says (a raw gliding scene may have switched the assist off).
    if (!on) glide.assisted = GLIDE_ASSISTED;
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
  /** The movement profile ('default', 'heavy', 'light', 'engine'); with a name, switches to it first. Returns the name. */
  moveProfile: (name?: string): string => {
    if (name !== undefined) setMoveProfile(profileOf(name));
    engine.invalidate();
    return moveProfile.name;
  },
  /**
   * The pathfinder's gait: the graph's state, smoothed speed and acceleration, the lean layers' weights, the stride
   * and the ponytail's largest angle from its posed shape (degrees). Null with `figure=boxes`.
   */
  /**
   * Gets on (true; the figure must be within RIDE_REACH_M of the steed unless `instant`) or off (false), or toggles
   * (no argument), as the key E; `instant` skips the climb. Returns `riding()`.
   */
  ride: (on?: boolean, instant = false): RideStatus | null => {
    if (boxes) return null;
    if (on === undefined) ride.toggle(instant);
    else if (on) ride.mount(instant);
    else ride.dismount(instant);
    engine.invalidate();
    return ride.status();
  },
  /**
   * The ride: mode (off, mounting, on, dismounting), seat weight, the holds of the hands and feet, trot, the steed's
   * place, heading and speed, its step cycle (phase, rate, the weights of walk, trot and gallop), footfalls and planted
   * hooves per leg (front left, front right, hind left, hind right) and the trunk's dip. Null with `figure=boxes`.
   */
  riding: (): (RideStatus & { reachM: number }) | null => (boxes ? null : { ...ride.status(), reachM: RIDE_REACH_M }),
  /**
   * Gets on the glider (true; the figure must be within GLIDE_REACH_M of it unless `instant`) or off (false; it must
   * have stopped on the ground unless `instant`), or toggles (no argument), as the key E. Returns `gliding()`.
   */
  glide: (on?: boolean, instant = false): GlideStatus | null => {
    if (boxes) return null;
    if (on === undefined) glide.toggle(instant);
    else if (on) {
      if (ride.riding) ride.dismount(true);
      glide.mount(instant);
    } else glide.dismount(instant);
    engine.invalidate();
    return glide.status();
  },
  /**
   * The glider: mode, seat weight, holds, its place, attitude (heading, pitch, bank in degrees), speed, climb, height
   * over the ground, the beat's effort, the flare, the load, a stall, take-offs and touch-downs, and its step cycle on
   * the ground (phase, footfalls and planted paws: left wing, right wing, hind left, hind right). Null with boxes.
   */
  gliding: (): (GlideStatus & { reachM: number }) | null => (boxes ? null : { ...glide.status(), reachM: GLIDE_REACH_M }),
  /**
   * The traces: marks laid in all and still visible, prints of feet and hooves laid, dust bursts and particles fired
   * and alive, the clock they are drawn at (the cars'); `clear` forgets them all first.
   */
  traces: (clear = false) => {
    if (clear) traces.clear(boxes ? null : ride, boxes ? null : glide);
    const now = cars.time;
    return { marks: traces.trail.laid, visible: traces.trail.visible(now), prints: traces.prints, dust: traces.dust.burstStats(), time: now };
  },
  /**
   * Gets into car `car` (default: the nearest within reach, else 0; the figure must be within CAR_REACH_M of its
   * driver's door unless `instant`) or out (false; the car nearly stopped), or toggles (no `on`), as the key E;
   * `instant` skips the walk to the door and the door. Returns `driving()`.
   */
  drive: (car?: number, on?: boolean, instant = false): DriveStatus | null => {
    if (boxes) return null;
    const i = car ?? (cars.nearest() >= 0 ? cars.nearest() : 0);
    const getIn = on ?? !cars.active;
    if (getIn) {
      if (!cars.active) {
        if (ride.riding) ride.dismount(true);
        if (instant) {
          const d = cars.doorSpot(i, 1);
          walker.teleport(d[0]!, d[1]!, d[2]!, d[3]!);
        }
        cars.enter(i, instant);
      }
    } else if (cars.mode === 'on') cars.exit(instant);
    walker.renderPosition(at, 1);
    followDriven(1);
    rig.snap();
    engine.renderNow();
    return { ...cars.status(), reachM: CAR_REACH_M } as DriveStatus;
  },
  /**
   * The drive: mode (off, entering, on, exiting), the car the figure is in, the side it gets in or out at, the camera
   * weight, the tyre marks laid, and per car its place, heading, forward speed, up axis, asleep, steer angle, per wheel
   * (front left, front right, rear left, rear right) compression, slip and grounded, the doors' opening and the lamps.
   */
  driving: (): (DriveStatus & { reachM: number }) | null => (boxes ? null : { ...cars.status(), reachM: CAR_REACH_M }),
  figure: () =>
    boxes
      ? null
      : { state: body.gait.state, speedMs: body.gait.speed, accelMs2: body.gait.accel, push: body.gait.graph.getParam('push'), brace: body.gait.graph.getParam('brace'), stride: body.gait.stride, tailDeg: (body.tailAngle * 180) / Math.PI, profile: moveProfile.name },
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
