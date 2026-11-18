// Numeric checks of the villagers (shapes, figures, simulation), run in the dev container:
//   docker compose exec -T dev sh -c 'cd /app/examples/fantasy-village && npx vite build --ssr src/villagers/check.ts --outDir node_modules/.vcheck --emptyOutDir --logLevel warn && node node_modules/.vcheck/check.js'
// Prints the mesh reports, per-figure sizes and triangle counts, and a long simulation run: footprint intrusions,
// water, stuck walkers, arrivals per agent, NaN and below-ground parts after rendering frames.

import { createBuildContext } from '../context.ts';
import { formatReport, inspect } from '../kit/index.ts';
import type { FrameInfo } from '../kit/index.ts';
import { PART_FLOATS } from '../kit/index.ts';
import { villageLayout } from '../layout.ts';
import { heightField } from '../terrain/height.ts';
import { cat, chicken, CHICKEN_LOOKS, dog } from './animals.ts';
import { makeGround, villagers } from './index.ts';
import { SET, makePeople } from './looks.ts';
import { HUMAN_CHANNELS, actionPose, poseIn, solve, ACT } from './rig.ts';
import { blobMesh, blockMesh, headMesh, segmentMesh } from './shapes.ts';
import { mat34Multiply } from 'wallhammer-web/base';
import { M } from './vmath.ts';

const seed = Number(process.argv[2] ?? 7);
const l = villageLayout(seed);
const field = heightField(l, seed);
const meshes = [headMesh(), blobMesh(), segmentMesh(), blockMesh()];
const names = ['head', 'blob', 'segment', 'block'];
meshes.forEach((m, k) => console.log(formatReport(inspect(names[k]!, m))));
const tris = meshes.map((m) => m.triangleCount);

// Mesh bounds as 8 corners.
const corners = meshes.map((m) => {
  const b = m.bounds();
  const out: number[][] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
});

const people = makePeople(createBuildContext(seed, l, field).stream('villagers'), l.stalls.map((q) => q.goods));
const animals = [...CHICKEN_LOOKS.map(([n, f, t, s]) => chicken(n, f, t, s)), dog(), cat()];
const bones = new Float64Array(24 * M);
const pose = new Float64Array(HUMAN_CHANNELS);
const pin = poseIn();
const part = new Float64Array(M);
let total = 0, inst = 0;
for (const f of [...people, ...animals]) {
  pose.fill(0);
  if ('role' in f) {
    pin.armOut = f.body.armOut;
    actionPose(pose, ACT.stand, 0, pin);
  }
  solve(f.skel, 0, 0, 0, 0, pose, bones);
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let t = 0;
  const big: string[] = [];
  for (const p of f.parts) {
    const pb = new Float64Array(p.m);
    mat34Multiply(bones.subarray(p.bone * M, p.bone * M + M), pb, part);
    t += tris[p.set]!;
    // Parts shown only in some modes or actions still count, they are just collapsed.
    for (const c of corners[p.set]!) {
      const x = part[0]! * c[0]! + part[3]! * c[1]! + part[6]! * c[2]! + part[9]!;
      const y = part[1]! * c[0]! + part[4]! * c[1]! + part[7]! * c[2]! + part[10]!;
      const z = part[2]! * c[0]! + part[5]! * c[1]! + part[8]! * c[2]! + part[11]!;
      if (p.show === 0 && p.acts === 0) {
        minY = Math.min(minY, y); maxY = Math.max(maxY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
    }
    const det = part[0]! * (part[4]! * part[8]! - part[5]! * part[7]!) - part[3]! * (part[1]! * part[8]! - part[2]! * part[7]!) + part[6]! * (part[1]! * part[5]! - part[2]! * part[4]!);
    if (det <= 0) big.push(`neg det set ${p.set}`);
  }
  total += t;
  inst += f.parts.length;
  const H = 'role' in f ? f.body.H : 0;
  console.log(`${f.name.padEnd(16)} parts ${String(f.parts.length).padStart(3)} tris ${String(t).padStart(6)}  y ${minY.toFixed(3)}…${maxY.toFixed(3)} (H ${H})  x ${minX.toFixed(2)}…${maxX.toFixed(2)}  z ${minZ.toFixed(2)}…${maxZ.toFixed(2)} ${big.slice(0, 3).join(' ')}`);
}
console.log(`total instances ${inst} (+14 sparks), triangles ${total}`);
console.log('sets: head', SET.head);

// Simulation.
const ctx = createBuildContext(seed, l, field);
const t0 = Date.now();
const c = villagers.build(ctx);
console.log('build ms', Date.now() - t0);
const ground = makeGround(ctx);
const sim = ctx.sim;
const frame: FrameInfo = { time: 0, dt: 0.016, evening: 0, alpha: 0.5, eye: [0, 10, 0], villagersVisible: true };
const lifeState = (sim as unknown as { states: { name: string }[] }).states.find((q) => q.name === 'villagers-life') as unknown as {
  n: number; x: Float64Array; z: Float64Array; mode: Int32Array; stepIx: Int32Array; act: Int32Array; tx: Float64Array; tz: Float64Array; spd: Float64Array; defs: { kind: number }[];
};
const L = lifeState;
const intrusions = new Int32Array(L.n), water = new Int32Array(L.n), arrivals = new Int32Array(L.n), stuck = new Int32Array(L.n);
const still = new Float64Array(L.n);
const lastStep = Int32Array.from(L.stepIx);
let nan = 0, below = 0, talkTicks = 0, hammer = 0;
const ticks = Number(process.argv[3] ?? 6000);
const tt0 = Date.now();
for (let k = 0; k < ticks; k++) {
  sim.step(1);
  for (let i = 0; i < L.n; i++) {
    if (L.mode[i] === 3) continue;
    const x = L.x[i]!, z = L.z[i]!;
    const far = Math.hypot(L.tx[i]! - x, L.tz[i]! - z) > 1.6;
    if (L.mode[i] === 0 && far && ground.block(x, z) < -0.05) intrusions[i]!++;
    const r = field.river(x, z);
    const br = l.bridge;
    const along = (x - br.x) * Math.sin(br.yaw) + (z - br.z) * Math.cos(br.yaw);
    const onBridge = Math.abs(along) < br.length / 2 && Math.abs((x - br.x) * Math.cos(br.yaw) - (z - br.z) * Math.sin(br.yaw)) < br.width / 2 + 0.3;
    if (r.inWater && !onBridge) water[i]!++;
    if (L.stepIx[i] !== lastStep[i]) (arrivals[i]!++, (lastStep[i] = L.stepIx[i]!));
    if (L.mode[i] === 0 && L.spd[i]! < 0.05) {
      still[i]! += 0.1;
      if (still[i]! > 15) (stuck[i]!++, (still[i] = 0));
    } else still[i] = 0;
    if (L.act[i] === ACT.talk) talkTicks++;
    if (L.act[i] === ACT.hammer) hammer++;
  }
  if (k % 7 === 0) {
    frame.time = k / 10;
    frame.alpha = (k % 10) / 10;
    c.update!(frame);
    for (const set of c.parts!) {
      for (let q = 0; q < set.count; q++) {
        const o = q * PART_FLOATS;
        for (let e = 0; e < 16; e++) if (!Number.isFinite(set.data[o + e]!)) nan++;
        const x = set.data[o + 9]!, y = set.data[o + 10]!, z = set.data[o + 11]!;
        if (y > -500 && y < field.heightAt(x, z) - 0.25 && !(Math.abs(x - l.bridge.x) < 9 && Math.abs(z - l.bridge.z) < 9)) below++;
      }
    }
  }
}
console.log(`sim ${ticks} ticks in ${Date.now() - tt0} ms (with ${Math.floor(ticks / 7)} frames)`);
console.log('NaN values', nan, 'part origins >0.25 m under ground', below, 'talk agent-ticks', talkTicks, 'hammer agent-ticks', hammer);
for (let i = 0; i < L.n; i++) {
  console.log(`agent ${String(i).padStart(2)} kind ${L.defs[i]!.kind} steps changed ${arrivals[i]} intrusions ${intrusions[i]} water ${water[i]} stuck ${stuck[i]} at ${L.x[i]!.toFixed(1)},${L.z[i]!.toFixed(1)} mode ${L.mode[i]} act ${L.act[i]}`);
}
console.log('sim hash', sim.stateHash());
