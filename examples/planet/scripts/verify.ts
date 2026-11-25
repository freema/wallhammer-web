// Checks the planet example without a browser:
//   - the generator: a cell's bytes do not depend on which cells were generated before it, they survive a round trip
//     through the cell format, and every object of a cell (the thinned trees of levels 7 to 9 too) is found again in
//     exactly one of its children;
//   - the flight: it starts and ends at the same pose, climbs without a step and reaches a height from which the
//     whole sphere with its air fits the view;
//   - the streaming along the flight with the real cells: the sphere is covered at every step, nothing is drawn
//     twice, the plan stays inside its budget of cells, and the bytes held at the worst moment fit the GPU budget;
//   - the movie (movie.ts): every shot keeps above the ground (with the strips; under the sea above its floor and
//     under the troughs) and moves without a jump inside it;
//   - walking (walk.ts): a minute's walk from the start on the ground the cells draw keeps the feet on the finest
//     level's mesh through the recharts, the following view's eye above that ground, and the step within its time;
//   - the acts of the walk (walk-scene.ts): from the walk's start the walker greets the figure standing ahead and passes
//     it the box (the box moves without a jump between the hands, both hands meet at one point at the hand-over, the
//     box ends in the other's hand), passes it back, waves while walking, reads (book out, open, back in the pocket),
//     sits down and stands up back into the gait; the gazes stay within their limits and the same drive gives the
//     same bones and props;
//   - solids (world.ts `OBJECT_SOLIDS`): the objects of the level-10 cells round the start in a `SolidIndex`, a walker
//     sent at the nearest tree is stopped at its trunk's radius through a `SolidFeed` in its chart, and the within-radius
//     query finds that tree from the feet.
//
//   node scripts/verify.ts [--seed 2611] [--height 1080] [--width 1920]
//
// --height and --width are the size of the drawing surface in physical pixels the flight is checked for.

import { cellKey } from 'wallhammer-web/gen-core';
import type { CellContent, CellId } from 'wallhammer-web/gen-core';
import { decodeCell, encodeCell, pixelsPerRadian } from 'wallhammer-web/world';
import { DEFAULT_FLIGHT, flightDuration, flightPose, wholeSphereHeight } from '../src/flight.ts';
import { checkFlight } from '../src/flight-check.ts';
import { planMovie } from '../src/movie.ts';
import { ChartFollowView, FollowRig } from 'wallhammer-web/camera';
import { ChartWalker, SolidFeed, SolidIndex, newWalkIntent } from 'wallhammer-web/world';
import { stripGroundHeight } from '../src/strips.ts';
import { WALK_SETUP, WalkBody, WalkScene, drawnGroundRadius, meetPlace } from '../src/walk.ts';
import { planetWeatherAt } from '../src/weather.ts';
import { AIR_HEIGHT_M, DEFAULT_SEED, LEAF_LEVEL, MIN_SPLIT_EDGES, OBJECT_LEVEL, OBJECT_SOLIDS, RADIUS_M, SELECTION, SHAPE, directionAt, findStart, findWalkStart, generatePlanetCell, groundHeight, surfaceHeight } from '../src/world.ts';

const arg = (name: string, d: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && Number.isFinite(Number(process.argv[i + 1])) ? Number(process.argv[i + 1]) : d;
};
const seed = arg('seed', DEFAULT_SEED);
const viewH = arg('height', 1080);
const viewW = arg('width', 1920);
const FOV_DEG = 50;
const MB = 1048576;
const problems: string[] = [];
const fail = (m: string): void => void problems.push(m);
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

// --- The generator ---------------------------------------------------------------------------------------------------
const start = findStart(seed);
const dir = directionAt(start.latDeg, start.lonDeg);
const at: [number, number, number] = [dir[0] * RADIUS_M, dir[1] * RADIUS_M, dir[2] * RADIUS_M];
const cells: CellId[] = [{ face: 0, level: 0, x: 0, y: 0 }, { face: 3, level: 4, x: 15, y: 0 }, SHAPE.cellAt(at, 7), SHAPE.cellAt(at, OBJECT_LEVEL), SHAPE.cellAt(at, LEAF_LEVEL)];
for (const c of cells) {
  const alone = encodeCell(generatePlanetCell(seed, c));
  for (const o of [...SHAPE.neighbours(c), ...SHAPE.children(c)]) generatePlanetCell(seed, o);
  if (!eq(encodeCell(generatePlanetCell(seed, c)), alone)) fail(`cell ${cellKey(c)} differs after other cells were generated`);
  if (!eq(encodeCell(decodeCell(alone)), alone)) fail(`cell ${cellKey(c)} does not survive a round trip through the cell format`);
}
// Objects: the cells of the coarsest level with every object round the start, and their children; and the cells of
// the three levels above it, whose thinned trees are each one of a child's (the same id), in exactly one child.
let objects = 0;
for (const c of [7, 8, 9].map((l) => SHAPE.cellAt(at, l)).concat([SHAPE.cellAt(at, OBJECT_LEVEL), ...SHAPE.neighbours(SHAPE.cellAt(at, OBJECT_LEVEL))])) {
  if (c.level >= LEAF_LEVEL) break;
  const kids = SHAPE.children(c).map((k) => generatePlanetCell(seed, k));
  for (const set of generatePlanetCell(seed, c).instances) {
    const ids = set.ids!;
    for (let t = 0; t < ids.length; t += 2) {
      let owners = 0;
      for (const kid of kids) {
        const ks = kid.instances.find((s) => s.archetype === set.archetype)?.ids;
        for (let u = 0; ks && u < ks.length; u += 2) if (ks[u] === ids[t] && ks[u + 1] === ids[t + 1]) owners++;
      }
      if (owners !== 1) fail(`object ${ids[t]}:${ids[t + 1]} of ${cellKey(c)} is in ${owners} of its children`);
      objects++;
    }
  }
}
console.log(`generator: ${cells.length} cells are independent of the order and survive the cell format; ${objects} objects round the start each have one owner a level below`);

// --- The flight ------------------------------------------------------------------------------------------------------
const needM = wholeSphereHeight(RADIUS_M, AIR_HEIGHT_M, FOV_DEG);
const plan = { ...DEFAULT_FLIGHT, highM: 1.25 * needM };
const total = flightDuration(plan);
const first = flightPose(plan, RADIUS_M, 0);
const last = flightPose(plan, RADIUS_M, total);
const top = flightPose(plan, RADIUS_M, plan.climbS + plan.holdS / 2);
if (first.heightM !== plan.lowM || last.heightM !== plan.lowM || first.pitchDeg !== last.pitchDeg || last.turnDeg !== 0) fail('the flight does not end where it starts');
if (Math.abs(top.heightM - plan.highM) > 1e-6 * plan.highM || top.pitchDeg !== 90) fail(`the top of the flight is at ${top.heightM} m looking ${top.pitchDeg}° down`);
if (top.heightM < needM) fail(`the top of the flight (${top.heightM} m) does not show the whole sphere (needs ${needM} m)`);
// Sixty poses a second: the height never changes by more than a few per cent between two of them, and the way down
// is the way up backwards.
let worstRatio = 1;
let worstTurn = 0;
let topSpeed = 0;
for (let i = 1; i <= total * 60; i++) {
  const a = flightPose(plan, RADIUS_M, (i - 1) / 60);
  const b = flightPose(plan, RADIUS_M, i / 60);
  worstRatio = Math.max(worstRatio, b.heightM / a.heightM, a.heightM / b.heightM);
  worstTurn = Math.max(worstTurn, Math.abs(b.pitchDeg - a.pitchDeg));
  topSpeed = Math.max(topSpeed, Math.abs(b.climbMs));
  const mirror = flightPose(plan, RADIUS_M, total - i / 60);
  if (Math.abs(mirror.heightM - b.heightM) > 1e-9 * b.heightM) fail(`the way down differs from the way up at ${i / 60} s`);
}
if (worstRatio > 1.02) fail(`the height changes by a factor of ${worstRatio} in one frame`);
if (worstTurn > 0.5) fail(`the view pitches by ${worstTurn}° in one frame`);
console.log(`flight: ${total} s, from ${plan.lowM} m to ${(plan.highM / 1000).toFixed(1)} km (the whole sphere with its air needs ${(needM / 1000).toFixed(1)} km); per frame at 60 Hz the height changes by at most ${((worstRatio - 1) * 100).toFixed(2)} % and the pitch by ${worstTurn.toFixed(3)}°; top speed ${(topSpeed / 1000).toFixed(1)} km/s`);

// --- Streaming along the flight --------------------------------------------------------------------------------------
const cache = new Map<string, CellContent>();
const gpuBytesOf = (c: CellContent): number => {
  let b = 0;
  for (const m of c.meshes) b += m.mesh.vertices.byteLength + (m.mesh.indices?.byteLength ?? 0);
  for (const i of c.instances) b += i.data.data.byteLength;
  return b;
};
const px = Math.max(pixelsPerRadian(viewH, (FOV_DEG * Math.PI) / 180), (MIN_SPLIT_EDGES * SELECTION.maxErrorPx) / SELECTION.errorPerEdge);
const t0 = performance.now();
let generated = 0;
try {
  const r = checkFlight({
    plan,
    dir,
    groundM: surfaceHeight(seed, at[0], at[1], at[2]),
    stepS: 0.1,
    pixelsPerRadian: px,
    maxCells: SELECTION.maxCells,
    // A cautious stand-in for the workers and the upload budget: 60 cells a second.
    jobsPerStep: 6,
    uploadsPerStep: 6,
    costOf: (cell) => {
      const key = cellKey(cell);
      let c = cache.get(key);
      if (!c) {
        c = generatePlanetCell(seed, cell);
        cache.set(key, c);
        generated++;
      }
      return { cpuBytes: encodeCell(c).byteLength, gpuBytes: gpuBytesOf(c), errorM: c.error ?? 0 };
    },
  });
  // What the page holds besides the cells: the shadow map (4096², 32-bit depth), the drawing surface's own colour
  // and depth target of the reversed depth mode, and the unit meshes and tables (under a megabyte).
  const fixedMb = (4096 * 4096 * 4 + viewW * viewH * 8) / MB + 1;
  const gpuMb = r.peakGpuBytes / MB + fixedMb;
  console.log(
    `streaming: ${r.steps} steps (${r.flightSteps} of the flight), ${generated} cells generated in ${((performance.now() - t0) / 1000).toFixed(1)} s; the sphere stayed covered, nothing was drawn twice`,
  );
  console.log(`  cells: at most ${r.peakWanted} wanted of ${SELECTION.maxCells}, ${r.peakDrawn} drawn, ${r.peakResident} on the GPU; finest level ${r.finestLevel}; detail never below ${(r.lowestDetail * 100).toFixed(0)} %`);
  console.log(`  behind: at ${r.stepsBehind} of ${r.flightSteps} steps a parent stood in for cells still on their way; settled ${r.stepsToSettle} steps after the landing`);
  console.log(`  memory: cells ${(r.peakGpuBytes / MB).toFixed(1)} MB on the GPU and ${(r.peakCpuBytes / MB).toFixed(1)} MB beside it at the worst step; with ${fixedMb.toFixed(0)} MB of targets at ${viewW}×${viewH} about ${gpuMb.toFixed(0)} MB of 600 MB`);
  if (gpuMb >= 600) fail(`the GPU memory at the worst step (${gpuMb.toFixed(0)} MB) is over the budget of 600 MB`);
} catch (e) {
  fail((e as Error).message);
}

// --- The movie --------------------------------------------------------------------------------------------------------
{
  const ground = (d: readonly number[]): number => stripGroundHeight(seed, d[0]! * RADIUS_M, d[1]! * RADIUS_M, d[2]! * RADIUS_M);
  const movie = planMovie({ seed, radiusM: RADIUS_M, topM: needM * 1.25, dayOfYear: 172, groundAt: (d) => Math.max(0, ground(d)), floorAt: ground, weatherAt: (d, g, t) => planetWeatherAt(seed, d, g, t) });
  let lowest = Infinity;
  for (const shot of movie.shots) {
    let prev: readonly number[] | null = null;
    for (let i = 0; i <= shot.seconds * 60; i++) {
      const p = shot.pose(i / 60);
      const r = Math.hypot(p.eye[0], p.eye[1], p.eye[2]);
      // Under the sea's level the eye is measured to the floor, and it keeps under the troughs of the waves.
      const level = r - RADIUS_M;
      const floor = ground([p.eye[0] / r, p.eye[1] / r, p.eye[2] / r]);
      const clear = level < 0 ? level - floor : level - Math.max(0, floor);
      lowest = Math.min(lowest, clear);
      if (level < 0 ? clear < 1 : clear < 3) fail(`movie shot ${shot.key} is ${clear.toFixed(1)} m above the ground at ${(i / 60).toFixed(2)} s`);
      if (level < 0 && level > -1.5) fail(`movie shot ${shot.key} is only ${(-level).toFixed(1)} m under the sea's level at ${(i / 60).toFixed(2)} s`);
      // No jump: a frame at 60 Hz moves the eye by less than a tenth of its height above the ground (and 2 km).
      if (prev && Math.hypot(p.eye[0] - prev[0]!, p.eye[1] - prev[1]!, p.eye[2] - prev[2]!) > Math.min(2000, Math.max(1, 0.1 * clear))) fail(`movie shot ${shot.key} jumps at ${(i / 60).toFixed(2)} s`);
      prev = p.eye;
    }
  }
  console.log(`movie: ${movie.shots.length} shots, ${movie.seconds} s (${movie.shots.map((s) => `${s.key} ${s.seconds}`).join(', ')}); the eye never lower than ${lowest.toFixed(1)} m above the ground`);
}

// --- Walking ----------------------------------------------------------------------------------------------------------
{
  const { radiusAt, stats } = drawnGroundRadius((x, y, z) => stripGroundHeight(seed, x, y, z));
  const w = new ChartWalker({ radiusM: RADIUS_M, center: SHAPE.centerM, radiusAt }, start.toward);
  const rig = new FollowRig({ fovDeg: FOV_DEG, near: 0.1, far: 1e7, minDistance: 0, maxDistance: 40 }, { clearance: (ox, oy, oz, dx, dy, dz, max) => w.world.clearance(ox, oy, oz, dx, dy, dz, max, 0.25) });
  rig.distance = 6;
  rig.pitchDeg = 12;
  const view = new ChartFollowView(rig, w.chart);
  const it = newWalkIntent();
  const at = new Float64Array(3);
  let worstFeet = 0;
  let lowestEye = Infinity;
  let steps = 0;
  const t0 = performance.now();
  // A minute running ahead in frames of 1/60 s, turning slowly.
  for (let i = 0; i < 3600; i++) {
    const yaw = (rig.yawDeg * Math.PI) / 180;
    it.moveX = -Math.sin(yaw);
    it.moveZ = -Math.cos(yaw);
    it.run = true;
    w.advance(1 / 60, it);
    steps++;
    view.setChart(w.chart);
    w.renderChartPosition(at);
    rig.follow(at[0]!, at[1]!, at[2]!);
    rig.update(1 / 60);
    rig.yawDeg += 0.05;
    if (w.grounded && !w.steep) worstFeet = Math.max(worstFeet, Math.abs(w.heightAboveGround));
    const e = view.worldEye();
    const d = SHAPE.directionOf(e);
    lowestEye = Math.min(lowestEye, SHAPE.altitude(e) - (radiusAt(d[0], d[1], d[2]) - RADIUS_M));
  }
  const us = ((performance.now() - t0) / steps) * 1000;
  console.log(`walk: ${w.travelled.toFixed(0)} m in a minute, ${w.recharts} recharts; feet off the drawn ground ${worstFeet.toExponential(1)} m at most; eye at least ${lowestEye.toFixed(2)} m above it; ${us.toFixed(0)} µs per frame with the view, ${(stats.heights / steps).toFixed(2)} heights computed per frame`);
  if (worstFeet > 1e-6) fail(`walking: the feet stand ${worstFeet.toExponential(1)} m off the drawn ground`);
  if (lowestEye < 0.1) fail(`walking: the eye came within ${lowestEye.toFixed(2)} m of the ground`);
  if (w.recharts < 3) fail(`walking: only ${w.recharts} recharts in a minute`);
  if (us > 500) fail(`walking: ${us.toFixed(0)} µs per frame`);
}

// --- The walking figure -----------------------------------------------------------------------------------------------
// From the walk's start (`findWalkStart`): a second standing, three walking, three running, two standing, in frames of
// 1/60 s as `__wh.walkFor` drives them. The graph goes stand → walk → run → … → stand and never into the air; while the
// body stands or walks on the ground with the fit at full weight, the lower sole is within 3 cm of the ground under it
// (a run has a phase with both feet off); no sole ever goes 3 cm into the ground; and the same drive gives the same bones.
{
  const ws = findWalkStart(seed);
  const { radiusAt } = drawnGroundRadius((x, y, z) => stripGroundHeight(seed, x, y, z));
  const drive = (): { states: string[]; stance: number; sunk: number; bones: Float64Array } => {
    const w = new ChartWalker({ radiusM: RADIUS_M, center: SHAPE.centerM, radiusAt, walker: WALK_SETUP }, ws.toward);
    const body = new WalkBody();
    body.reset(w);
    const it = newWalkIntent();
    const states: string[] = [];
    let stance = 0;
    let sunk = 0;
    for (const [seconds, forward, run] of [[1, 0, false], [3, 1, false], [3, 1, true], [2, 0, false]] as const) {
      for (let i = 0; i < seconds * 60; i++) {
        it.moveX = 0;
        it.moveZ = -forward;
        it.run = run;
        w.advance(1 / 60, it);
        body.update(1 / 60, w);
        body.solve(w, [0, 0, 0]);
        const g = body.gait;
        if (states[states.length - 1] !== g.state) states.push(g.state);
        if (!w.grounded || g.fit < 1) continue;
        sunk = Math.max(sunk, -body.footGap);
        if ((g.state === 'stand' || g.state === 'walk') && g.graph.weightOf(g.state, 'body') >= 1) stance = Math.max(stance, Math.abs(body.footGap));
      }
    }
    return { states, stance, sunk, bones: Float64Array.from(body.bones) };
  };
  const a = drive();
  const b = drive();
  const same = a.bones.every((v, i) => Object.is(v, b.bones[i]));
  console.log(`walking figure: at lat ${ws.latDeg.toFixed(3)} lon ${ws.lonDeg.toFixed(3)}; ${a.states.join(' → ')}; standing or walking sole off the ground ${(a.stance * 100).toFixed(1)} cm at most, into it ${(Math.max(0, a.sunk) * 100).toFixed(1)} cm; ${same ? 'the same bones twice' : 'DIFFERENT bones twice'}`);
  if (a.states[0] !== 'stand' || a.states[1] !== 'walk' || a.states[2] !== 'run' || a.states[a.states.length - 1] !== 'stand') fail(`walking figure: states ${a.states.join(' → ')}, not stand → walk → run → … → stand`);
  if (a.states.includes('air')) fail('walking figure: went into the air on flat walking');
  if (a.stance > 0.03) fail(`walking figure: the standing or walking sole is ${(a.stance * 100).toFixed(1)} cm off the ground`);
  if (a.sunk > 0.03) fail(`walking figure: a sole goes ${(a.sunk * 100).toFixed(1)} cm into the ground`);
  if (!same) fail('walking figure: the same drive gave different bones');
}

// --- The acts of the walk ---------------------------------------------------------------------------------------------
// The walker at the walk's start, the second figure where the page puts it (`meetPlace`), frames of 1/60 s as
// `__wh.walkFor` drives them, each act asked as its key would (`__wh.walkAct`).
{
  const ws = findWalkStart(seed);
  const { radiusAt } = drawnGroundRadius((x, y, z) => stripGroundHeight(seed, x, y, z));
  const dir = directionAt(ws.latDeg, ws.lonDeg);
  const c0 = SHAPE.centerM;
  const feet = [c0[0] + dir[0] * RADIUS_M, c0[1] + dir[1] * RADIUS_M, c0[2] + dir[2] * RADIUS_M];
  type Run = { log: string[]; problems: string[]; bones: Float64Array };
  const play = (): Run => {
    const scene = new WalkScene({ center: SHAPE.centerM, radiusAt, place: meetPlace(feet, ws.toward, SHAPE.centerM) });
    const w = new ChartWalker({ radiusM: RADIUS_M, center: SHAPE.centerM, radiusAt, walker: WALK_SETUP, onRechart: (chart, world) => scene.attach(chart, world) }, dir);
    w.teleportDirection(dir, 0, ws.toward);
    scene.reset(w);
    const h = scene.hero, o = scene.other;
    const it = newWalkIntent();
    const log: string[] = [];
    const problems: string[] = [];
    const handR = h.kind.skeleton.names.indexOf('handR');
    const sock = new Float64Array(12);
    const at = (b: WalkBody, name: string): [number, number, number] => {
      b.acts.socket(b.chartBones, name, sock);
      return [sock[9]!, sock[10]!, sock[11]!];
    };
    const dist = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    // One frame; `watch` sees the scene after the pose.
    const frame = (forward: number, run: boolean, watch?: () => void): void => {
      it.moveX = 0;
      it.moveZ = -forward;
      it.run = run;
      it.jump = false;
      scene.steer(w, it, forward !== 0, run && forward !== 0, false);
      w.advance(1 / 60, it);
      scene.update(1 / 60, w);
      scene.pose(w);
      watch?.();
    };
    const frames = (seconds: number, forward = 0, run = false, watch?: () => void): void => {
      for (let i = 0; i < Math.round(seconds * 60); i++) frame(forward, run, watch);
    };
    const until = (done: () => boolean, most: number, watch?: () => void): number => {
      let t = 0;
      while (!done() && t < most) (frame(0, false, watch), (t += 1 / 60));
      return t;
    };
    frames(0.5);
    // Greet and pass the box: the box's distance to both hands frame by frame, the hands at the hand-over.
    const passBox = (label: string, to: WalkBody): void => {
      // The box's move in a frame past the fastest hand's (it rides a hand or blends between two).
      let jump = 0;
      let handsAt = -1;
      let lastPhase = '';
      const last = new Float64Array(15).fill(NaN);
      const watch = (): void => {
        const box = scene.props;
        const now = [box[9]!, box[10]!, box[11]!, ...at(h, 'handR'), ...at(h, 'handL'), ...at(o, 'handR'), ...at(o, 'handL')];
        if (!Number.isNaN(last[0]!)) {
          let hand = 0;
          for (let k = 3; k < 15; k += 3) hand = Math.max(hand, dist(now.slice(k, k + 3), last.subarray(k, k + 3)));
          jump = Math.max(jump, dist(now, last) - hand);
        }
        last.set(now);
        const phase = scene.meet?.phase ?? '';
        if (phase === 'hold' && lastPhase === 'reach') {
          const m = scene.meetingPoint;
          const hh = h.chartBones, oo = o.chartBones;
          handsAt = Math.max(dist([hh[handR * 12 + 9]!, hh[handR * 12 + 10]!, hh[handR * 12 + 11]!], m), dist([oo[handR * 12 + 9]!, oo[handR * 12 + 10]!, oo[handR * 12 + 11]!], m));
        }
        lastPhase = phase;
      };
      const asked = scene.meetKey(w);
      const t = until(() => !scene.meet, 20, watch);
      frames(0.5, 0, false, watch);
      const holder = scene.box.to;
      log.push(`${label}: "${asked}", ${t.toFixed(1)} s, apart ${scene.distance(w).toFixed(2)} m, hands ${(handsAt * 100).toFixed(1)} cm from the meeting point at the hand-over, the box moved at most ${(jump * 100).toFixed(1)} cm a frame more than the fastest hand`);
      if (scene.meet) problems.push(`${label}: still meeting after 20 s`);
      if (handsAt < 0) problems.push(`${label}: no hand-over seen`);
      else if (handsAt > 0.04) problems.push(`${label}: a hand is ${(handsAt * 100).toFixed(1)} cm from the meeting point at the hand-over`);
      if (jump > 0.03) problems.push(`${label}: the box jumps ${(jump * 100).toFixed(1)} cm in a frame more than the fastest hand`);
      if (holder.body !== to || holder.socket !== 'handR' || !scene.box.settled) problems.push(`${label}: the box ends at ${holder.body === h ? 'the walker' : 'the other'}.${holder.socket}`);
    };
    passBox('greet and give', o);
    if (!scene.greeted) problems.push('greet: not greeted');
    passBox('give back', h);
    // Wave while walking: the wave layer plays on the walking body.
    scene.act('wave', w);
    let waved = false;
    frames(2, 1, false, () => void (waved ||= h.gait.graph.state('wave') !== 'off' && h.gait.state === 'walk'));
    frames(2.5, 0, false);
    log.push(`wave while walking: ${waved ? 'the wave layer on the walking body' : 'NOT seen'}`);
    if (!waved) problems.push('wave: no wave layer while walking');
    // Read: the book out, open, in front of the eyes; then back in the pocket and the box back in the hand.
    const r1 = scene.act('read', w);
    until(() => scene.read?.phase === 'reading', 5);
    frames(0.5);
    const reading = scene.read?.phase === 'reading' && scene.book.to.socket === 'read' && scene.book.settled && scene.hinge > 2.5 && scene.box.to.socket === 'belt';
    const bookToEyes = dist([scene.props[21]!, scene.props[22]!, scene.props[23]!], at(h, 'read'));
    const r2 = scene.act('read', w);
    until(() => !scene.read, 5);
    frames(0.5);
    const stowed = scene.book.to.socket === 'pocket' && scene.box.to.socket === 'handR' && scene.box.settled && !scene.bookOut;
    log.push(`read: "${r1}", ${reading ? 'reading with the book open at its place' : 'NOT reading'} (book ${(bookToEyes * 100).toFixed(1)} cm from it); "${r2}", ${stowed ? 'book in the pocket, box in the hand' : 'NOT stowed'}`);
    if (!reading) problems.push('read: the book is not open at the reading place');
    if (!stowed) problems.push('read: the book or the box did not go back');
    // Sit and stand up, then walk on; sit again and stand up by walking.
    const s1 = scene.act('sit', w);
    frames(3);
    const sat = h.gait.state;
    scene.act('sit', w);
    frames(2.5);
    const stood = h.gait.state;
    frames(1.5, 1);
    const walked = h.gait.state;
    frames(1.5);
    scene.act('sit', w);
    frames(3);
    frames(3, 1);
    const walkedOff = h.gait.state;
    frames(1.5);
    log.push(`sit: "${s1}", ${sat} → X → ${stood} → forward → ${walked}; sit again, forward → ${walkedOff}`);
    if (sat !== 'sit' || stood !== 'stand' || walked !== 'walk' || walkedOff !== 'walk') problems.push(`sit: ${sat} → ${stood} → ${walked}; ${walkedOff}`);
    // The gazes within their limits all along.
    const over = (scene.gazeOver * 180) / Math.PI;
    log.push(`gazes: ${over <= 0.5 ? 'within their limits' : `${over.toFixed(1)}° past their limits`}`);
    if (over > 0.5) problems.push(`gaze: ${over.toFixed(1)}° past its limits`);
    const bones = new Float64Array(h.chartBones.length * 2 + scene.props.length);
    bones.set(h.chartBones, 0);
    bones.set(o.chartBones, h.chartBones.length);
    bones.set(scene.props, h.chartBones.length * 2);
    return { log, problems, bones };
  };
  const a = play();
  const b = play();
  const same = a.bones.every((v, i) => Object.is(v, b.bones[i]));
  console.log(`walk acts: ${a.log.join('; ')}; ${same ? 'the same bones and props twice' : 'DIFFERENT bones twice'}`);
  for (const p of a.problems) fail(`walk acts: ${p}`);
  if (!same) fail('walk acts: the same drive gave different bones or props');
}

// --- Solids -----------------------------------------------------------------------------------------------------------
{
  // The cells of the object level round the start, as the page's `streamSolids` would add them.
  const index = new SolidIndex({ solids: OBJECT_SOLIDS, shape: SHAPE, center: SHAPE.centerM });
  const home = SHAPE.cellAt(at, OBJECT_LEVEL);
  const t0 = performance.now();
  let cellsIn = 0;
  for (const c of [home, ...SHAPE.neighbours(home)]) {
    const content = generatePlanetCell(seed, c);
    const ta = performance.now();
    index.addCell(content);
    cellsIn += performance.now() - ta;
  }
  const genMs = performance.now() - t0;
  const unitOf = (p: readonly number[]): [number, number, number] => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!);
    return [p[0]! / l, p[1]! / l, p[2]! / l];
  };
  const angle = (a: readonly number[], b: readonly number[]): number => Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));
  // The trees, nearest to the start first.
  const trees: { p: [number, number, number]; r: number; id: string }[] = [];
  index.within(at, 2000, (h) => {
    if (h.halfX === 0) trees.push({ p: [h.x, h.y, h.z], r: h.radius, id: `${h.idHigh}:${h.idLow}` });
  });
  trees.sort((a, b) => angle(unitOf(a.p), dir) - angle(unitOf(b.p), dir));
  const { radiusAt } = drawnGroundRadius((x, y, z) => groundHeight(seed, x, y, z));
  const walkerR = 0.3;
  let tried = 0;
  let done = false;
  // The first tree with a clear approach over 8 m from one of eight sides (nothing else solid along the way).
  for (const tree of trees.slice(0, 40)) {
    if (done) break;
    const axis = unitOf(tree.p);
    const e1 = unitOf([axis[1], -axis[0], 0].some((v) => v !== 0) ? [axis[1], -axis[0], 0] : [1, 0, 0]);
    const e2: [number, number, number] = [axis[1] * e1[2] - axis[2] * e1[1], axis[2] * e1[0] - axis[0] * e1[2], axis[0] * e1[1] - axis[1] * e1[0]];
    for (let side = 0; side < 8 && !done; side++) {
      const a = (side * Math.PI) / 4;
      const away: [number, number, number] = [e1[0] * Math.cos(a) + e2[0] * Math.sin(a), e1[1] * Math.cos(a) + e2[1] * Math.sin(a), e1[2] * Math.cos(a) + e2[2] * Math.sin(a)];
      const from = (m: number): [number, number, number] => {
        const th = m / RADIUS_M;
        const d = unitOf([axis[0] * Math.cos(th) + away[0] * Math.sin(th), axis[1] * Math.cos(th) + away[1] * Math.sin(th), axis[2] * Math.cos(th) + away[2] * Math.sin(th)]);
        const r = radiusAt(d[0], d[1], d[2]) + 1;
        return [d[0] * r, d[1] * r, d[2] * r];
      };
      let clear = true;
      for (let m = tree.r + walkerR; m <= 8 && clear; m += 0.25) {
        index.within(from(m), walkerR + 0.05, (h) => {
          if (`${h.idHigh}:${h.idLow}` !== tree.id) clear = false;
        });
      }
      if (!clear) continue;
      tried++;
      const feed = new SolidFeed(index);
      const w = new ChartWalker({ radiusM: RADIUS_M, center: SHAPE.centerM, radiusAt, walker: { radius: walkerR }, onRechart: (chart, world) => void feed.attach(world, chart) }, from(8));
      const it = newWalkIntent();
      const g = [0, 0, 0];
      for (let i = 0; i < 6 * 60; i++) {
        w.toChart(tree.p, g, 1e9);
        const q = w.walker.position;
        const dx = g[0]! - q[0]!;
        const dz = g[2]! - q[2]!;
        const l = Math.hypot(dx, dz) || 1;
        it.moveX = dx / l;
        it.moveZ = dz / l;
        w.advance(1 / 60, it);
      }
      const feet = w.position([0, 0, 0] as [number, number, number]);
      const gap = angle(unitOf(feet), axis) * RADIUS_M;
      // A slope too steep to climb stops the body before the trunk: another side or tree is tried.
      if (w.steep || gap > tree.r + walkerR + 0.5) continue;
      done = true;
      let found = false;
      const hits = index.within(feet, walkerR + 0.05, (h) => (found ||= `${h.idHigh}:${h.idLow}` === tree.id));
      console.log(
        `solids: ${index.solidCount} in ${index.cellCount} cells of level ${OBJECT_LEVEL} round the start (${cellsIn.toFixed(1)} ms to index, ${genMs.toFixed(0)} ms with generating); ${feed.count} in the walker's chart; stopped ${gap.toFixed(3)} m from a trunk of ${tree.r.toFixed(2)} m (want ${(tree.r + walkerR).toFixed(2)}) after ${tried} approach(es); ${hits} solid(s) within ${(walkerR + 0.05).toFixed(2)} m of the feet, the tree among them ${found}`,
      );
      if (Math.abs(gap - (tree.r + walkerR)) > 0.02) fail(`solids: the walker stopped ${gap.toFixed(3)} m from the tree's axis, not at ${(tree.r + walkerR).toFixed(3)}`);
      if (!found) fail('solids: the within-radius query from the feet does not find the tree');
    }
  }
  if (!done) fail(`solids: no tree near the start could be approached (${trees.length} trees, ${tried} approaches)`);
}

for (const p of problems) console.log(`FAILED: ${p}`);
console.log(problems.length ? `planet: ${problems.length} checks failed` : 'planet: all checks passed');
process.exit(problems.length ? 1 : 0);
