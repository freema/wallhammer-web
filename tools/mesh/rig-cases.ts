// Cases of rig meshes for check:mesh: parts on a clock and swings about y and z (`RigPart.rate`, `RigPart.axis`), the
// full frame of an instance (`RigDesc.orient`, `writeRigFrame`) and the phase of a clock (`rigClockPhase`). The
// shader that reads them is not compiled here; these cases hold the data contract it relies on.

import { RIG_CLOCK_STEP, RIG_INSTANCE_FLOATS, RIG_MOTION, RIG_SWING_KIND, RIG_VERTEX_FLOATS, rigClockPhase, rigClockRates, rigExtended, writeRigFrame, writeRigInstance } from '../../packages/wallhammer-web/src/base/rig.ts';
import type { RigDesc, RigInstance, RigPart } from '../../packages/wallhammer-web/src/base/rig.ts';
import { rigMesh } from '../../packages/wallhammer-web/src/gen-mesh/rig-mesh.ts';

interface Result {
  ok: boolean;
  detail: string;
}

const body: RigPart = { shape: { kind: 'box', size: [0.4, 0.3, 1] }, at: [0, 1, 0], slot: 0 };
const wing = (side: number, rate: number | undefined, axis: 'x' | 'y' | 'z' = 'z'): RigPart => ({
  shape: { kind: 'box', size: [1.2, 0.04, 0.5] },
  at: [side * 0.8, 1, 0],
  pivot: [side * 0.2, 1, 0],
  motion: 'swing',
  axis,
  amount: side * 0.5,
  ...(rate !== undefined ? { rate } : {}),
  slot: 1,
});
const flyer = (parts: RigPart[], orient?: 'frame'): RigDesc => ({ name: 'flyer', parts: [body, ...parts], segments: [{ shadow: [0, 0, 0] }], height: 1, radius: 1.5, ...(orient ? { orient } : {}) });

/** Motion kinds of the vertices of each part, in part order (every vertex of a part carries the same kind). */
function kinds(desc: RigDesc): number[] {
  const out: number[] = [];
  for (const p of desc.parts) {
    const v = rigMesh({ ...desc, parts: [p] }).vertices;
    out.push(v[9]!);
  }
  return out;
}

export const RIG_CASES: [string, () => Result][] = [
  ['rig-clock-kinds', () => {
    // Two wings on one clock, a tail on a second; the kinds carry the clock's index above the motion.
    const tail: RigPart = { shape: { kind: 'box', size: [0.1, 0.1, 0.4] }, at: [0, 1, -0.7], pivot: [0, 1, -0.5], motion: 'bend', axis: 'x', amount: 0.4, phase: 0.3, rate: 0.5 };
    const prop: RigPart = { shape: { kind: 'roller', radius: 0.2, width: 0.05, sides: 6 }, at: [0, 1, 0.6], motion: 'spin', rate: 3 };
    const desc = flyer([wing(1, 2), wing(-1, 2), tail, prop]);
    const rates = rigClockRates(desc);
    const v = rigMesh(desc).vertices;
    const seen = new Set<number>();
    for (let i = 0; i < v.length; i += RIG_VERTEX_FLOATS) seen.add(v[i + 9]!);
    const want = [0, RIG_SWING_KIND.z + RIG_CLOCK_STEP, RIG_MOTION.bend + 0 + 2 * RIG_CLOCK_STEP, RIG_MOTION.spin + 3 * RIG_CLOCK_STEP];
    const ok = rates.join() === '2,0.5,3' && want.every((k) => seen.has(k)) && seen.size === want.length && rigExtended(desc);
    return { ok, detail: `rates ${rates.join(', ')} /s; kinds ${[...seen].sort((a, b) => a - b).join(', ')} (want ${want.join(', ')})` };
  }],
  ['rig-plain-kinds-unchanged', () => {
    // Without a clock or another axis the kinds are those of before (a swing about x is 4) and the kind is not extended.
    const arm: RigPart = { ...wing(1, undefined, 'x') };
    delete (arm as { axis?: string }).axis;
    const plain = flyer([arm]);
    const explicit = flyer([wing(1, undefined, 'x')]);
    const a = rigMesh(plain).vertices;
    const b = rigMesh(explicit).vertices;
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    const k = kinds(plain);
    const ok = same && k[1] === RIG_MOTION.swing && !rigExtended(plain) && !rigExtended(explicit) && rigExtended(flyer([wing(1, undefined, 'y')])) && kinds(flyer([wing(1, undefined, 'y')]))[1] === RIG_SWING_KIND.y;
    return { ok, detail: `swing about x: kind ${k[1]}, axis 'x' given or not the same ${a.length} floats; about y: kind ${RIG_SWING_KIND.y}, extended` };
  }],
  ['rig-clock-limits', () => {
    const errors: string[] = [];
    const tryIt = (desc: RigDesc): void => {
      try {
        rigClockRates(desc);
      } catch (e) {
        errors.push((e as Error).message);
      }
    };
    tryIt(flyer([wing(1, 1), wing(-1, 2), wing(1, 3), wing(-1, 4), wing(1, 5)]));
    tryIt(flyer([{ ...body, motion: 'limb', amount: 1, rate: 1 }]));
    tryIt(flyer([wing(1, Infinity)]));
    tryIt(flyer([wing(1, 1), wing(-1, 2), wing(1, 3), wing(-1, 4)]));
    return { ok: errors.length === 3, detail: `${errors.length} refused (five rates, a limb on a clock, an infinite rate); four rates pass` };
  }],
  ['rig-clock-phase', () => {
    // The fraction is taken before the seed is added, so a large time keeps its precision; equal at whole periods.
    const a = rigClockPhase(0.25, 2, 0.1, 0.2);
    const far = rigClockPhase(3_600_000.25, 2, 0.1, 0.2);
    const back = rigClockPhase(0.25, -2, 0, 0);
    const ok = Math.abs(a - 0.8) < 1e-12 && Math.abs(far - a) < 1e-9 && Math.abs(back - 0.5) < 1e-12 && a >= 0 && a < 1;
    return { ok, detail: `0.25 s at 2/s with seed 0.1 and phase 0.2: ${a.toFixed(6)}; 1000 h later ${far.toFixed(6)}; backward ${back.toFixed(6)}` };
  }],
  ['rig-full-frame-record', () => {
    // writeRigFrame fills floats 6–11 after writeRigInstance and leaves the rest of the record as it was.
    const r: RigInstance = { x: 1, y: 2, z: 3, slope: 0, dirX: 0, dirZ: 1, x1: 9, y1: 9, z1: 9, slope1: 9, dirX1: 9, dirZ1: 9, distance: 4, speed: 5, turnRate: 0, seed: 0.5, state: 0, heightScale: 1, widthScale: 1, variants: 0, colors: [1, 2, 3, 4] };
    const out = new Float32Array(2 * RIG_INSTANCE_FLOATS);
    writeRigInstance(out, 1, r);
    const before = Array.from(out.subarray(RIG_INSTANCE_FLOATS));
    writeRigFrame(out, 1, [0, 0.5, 0.866], [0, 0.866, -0.5]);
    const after = Array.from(out.subarray(RIG_INSTANCE_FLOATS));
    const frame = after.slice(6, 12).map((x) => Math.round(x * 1000) / 1000).join();
    const rest = after.every((x, i) => (i >= 6 && i < 12) || x === before[i]);
    // A full frame needs the extended program (two segments with it are refused by RigLayer.addKind).
    const refused = rigExtended(flyer([], 'frame'));
    const ok = frame === '0,0.5,0.866,0,0.866,-0.5' && rest && out[0] === 0 && refused;
    return { ok, detail: `floats 6–11: ${frame}; others unchanged: ${rest}; orient 'frame' is extended: ${refused}` };
  }],
];
