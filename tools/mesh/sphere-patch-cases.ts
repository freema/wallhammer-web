// Cases of the sphere patch for check:mesh: the choice of each quad's diagonal (`SpherePatchOptions.split`), the
// nearest-parent copy of the extra channel (`coarseExtra: 'nearest'`) and the extra channel of the ground's vertex
// shaders (`SphereGroundOptions.extra` of env). The GLSL is not compiled here (the `shaders` compose service does
// that); these cases hold the data and the text it relies on. The bytes are pinned by golden recipes as well.

import { sphereGroundDepthVs, sphereGroundVs } from '../../packages/wallhammer-web/src/env/sphere-ground.ts';
import { cubeDirection, cubeGrid, cubeNeighbour } from '../../packages/wallhammer-web/src/gen-core/cube-sphere.ts';
import { hashInts, unit } from '../../packages/wallhammer-web/src/gen-core/hash.ts';
import { valueNoise3 } from '../../packages/wallhammer-web/src/gen-core/noise.ts';
import { SPHERE_PATCH_COVER_EXTRA_LAYOUT, SPHERE_PATCH_COVER_LAYOUT, spherePatchMesh, spherePatchRadius, spherePatchSplitsAD } from '../../packages/wallhammer-web/src/gen-core/sphere-patch.ts';
import { sphereStripSurface } from '../../packages/wallhammer-web/src/gen-core/strip-surface.ts';
import type { SpherePatch, SpherePatchOptions } from '../../packages/wallhammer-web/src/gen-core/sphere-patch.ts';

interface Result {
  ok: boolean;
  detail: string;
}

const R = 100_000;
const Q = 16;
/** Rolling ground with walls: steps of 120 m where a coarse noise crosses one half. */
const heightAt = (px: number, py: number, pz: number): number => 400 * valueNoise3(px, py, pz, 5000, 7) + (valueNoise3(px, py, pz, 700, 9) > 0.5 ? 120 : 0);
const colorAt = (_x: number, _y: number, _z: number, h: number): [number, number, number, number] => [90, Math.max(0, Math.min(255, Math.round(100 + h * 0.2))), 60, 0];
const coverAt = (px: number, py: number, pz: number): [number, number, number, number] => [40, 90, 30, Math.round(255 * valueNoise3(px, py, pz, 3000, 11))];
/** Four categories in r (0, 85, 170, 255), a free byte in g. */
const CATEGORIES = new Set([0, 85, 170, 255]);
const extraAt = (px: number, py: number, pz: number, h: number): [number, number, number, number] => [85 * Math.min(3, Math.floor(4 * valueNoise3(px, py, pz, 900, 31))), Math.max(0, Math.min(255, Math.round(h / 2))), 0, 255];

const at = (face: number, level: number, x: number, y: number, more: Partial<SpherePatchOptions> = {}): SpherePatchOptions => ({ radiusM: R, face, level, x, y, quads: Q, heightAt, colorAt, coverAt, skirtDepth: 20, ...more });

const S = SPHERE_PATCH_COVER_LAYOUT.stride;
const SX = SPHERE_PATCH_COVER_EXTRA_LAYOUT.stride;

/** Position of vertex v (float bytes + origin), in double. */
function position(p: SpherePatch, stride: number, v: number): [number, number, number] {
  const bytes = p.mesh.vertices as Uint8Array;
  const f = new DataView(bytes.buffer, bytes.byteOffset + v * stride, 12);
  return [f.getFloat32(0, true) + p.origin[0], f.getFloat32(4, true) + p.origin[1], f.getFloat32(8, true) + p.origin[2]];
}

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
};

/** Distance from the centre where the ray along `dir` meets one of the top triangles of the patch (NaN: none). */
function rayMesh(p: SpherePatch, stride: number, dir: readonly [number, number, number]): number {
  return rayHit(p, stride, dir).r;
}

/** The top triangle (index of its first index) the ray along `dir` meets, and where; t −1 and r NaN for none. */
function rayHit(p: SpherePatch, stride: number, dir: readonly [number, number, number]): { t: number; r: number } {
  const idx = p.mesh.indices;
  for (let t = 0; t < Q * Q * 6; t += 3) {
    const A = position(p, stride, idx[t]!);
    const B = position(p, stride, idx[t + 1]!);
    const C = position(p, stride, idx[t + 2]!);
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const den = n[0]! * dir[0] + n[1]! * dir[1] + n[2]! * dir[2];
    if (Math.abs(den) < 1e-12) continue;
    const r = (n[0]! * A[0] + n[1]! * A[1] + n[2]! * A[2]) / den;
    const P = [dir[0] * r, dir[1] * r, dir[2] * r];
    // Inside: P on the inner side of all three edges (signed volumes along the normal), with a small slack.
    let inside = true;
    for (const [U, V] of [[A, B], [B, C], [C, A]] as const) {
      const ex = [V[0] - U[0], V[1] - U[1], V[2] - U[2]];
      const px = [P[0]! - U[0], P[1]! - U[1], P[2]! - U[2]];
      const c = [ex[1]! * px[2]! - ex[2]! * px[1]!, ex[2]! * px[0]! - ex[0]! * px[2]!, ex[0]! * px[1]! - ex[1]! * px[0]!];
      if (c[0]! * n[0]! + c[1]! * n[1]! + c[2]! * n[2]! < -1e-6 * (n[0]! * n[0]! + n[1]! * n[1]! + n[2]! * n[2]!)) {
        inside = false;
        break;
      }
    }
    if (inside && r > 0) return { t, r };
  }
  return { t: -1, r: NaN };
}

/** Direction of a point of cell (face, level, x, y) at shares (u, v) of its edges. */
function dirIn(face: number, level: number, x: number, y: number, u: number, v: number): [number, number, number] {
  const N = 2 ** level;
  return cubeDirection(face, cubeGrid(x + u, N), cubeGrid(y + v, N));
}

/** Distance from the centre of grid vertex (gi, gj) of a face at a level, as the patch computes it. */
function cornerR(face: number, level: number, gi: number, gj: number): number {
  const d = cubeDirection(face, cubeGrid(gi, Q * 2 ** level), cubeGrid(gj, Q * 2 ** level));
  return R + heightAt(d[0] * R, d[1] * R, d[2] * R);
}

export const SPHERE_PATCH_CASES: [string, () => Result][] = [
  ['sphere-split-fixed-default', () => {
    const o = at(2, 6, 13, 40);
    const a = spherePatchMesh(o);
    const b = spherePatchMesh({ ...o, split: 'fixed' });
    const c = spherePatchMesh({ ...o, extraAt });
    const d = spherePatchMesh({ ...o, extraAt, coarseExtra: 'blend' });
    const ok = sameBytes(a.mesh.vertices, b.mesh.vertices) && sameBytes(a.mesh.indices, b.mesh.indices) && sameBytes(c.mesh.vertices, d.mesh.vertices) && sameBytes(c.mesh.indices, d.mesh.indices);
    return { ok, detail: `split 'fixed' and coarseExtra 'blend' given = left out: ${ok ? 'same bytes' : 'differ'}` };
  }],
  ['sphere-split-shorter-borders', () => {
    const n = Q + 1;
    const problems: string[] = [];
    let adQuads = 0;
    let borderEdges = 0;
    for (const [face, level, x, y] of [[2, 6, 13, 40], [0, 6, 63, 20]] as const) {
      const fixed = spherePatchMesh(at(face, level, x, y));
      const short = spherePatchMesh(at(face, level, x, y, { split: 'shorter' }));
      const va = fixed.mesh.vertices as Uint8Array;
      const vb = short.mesh.vertices as Uint8Array;
      if (va.length !== vb.length) problems.push('vertex counts differ');
      // Border and skirt vertices: the same bytes in both splits.
      for (let v = 0; v < va.length / S; v++) {
        const i = v % n;
        const j = Math.floor(v / n);
        const border = v >= n * n || i === 0 || j === 0 || i === Q || j === Q;
        if (border && !sameBytes(va.subarray(v * S, v * S + S), vb.subarray(v * S, v * S + S))) problems.push(`border vertex ${v} differs`);
      }
      // Skirt triangles: the same indices.
      if (!sameBytes(fixed.mesh.indices.subarray(Q * Q * 6), short.mesh.indices.subarray(Q * Q * 6))) problems.push('skirt indices differ');
      // Each quad: cut along the diagonal of the rule; the two triangles hold the quad's four corners.
      const ib = short.mesh.indices;
      for (let jq = 0; jq < Q; jq++) {
        for (let iq = 0; iq < Q; iq++) {
          const t = (jq * Q + iq) * 6;
          const a = jq * n + iq;
          const dIdx = a + n + 1;
          const gi = x * Q + iq;
          const gj = y * Q + jq;
          const want = spherePatchSplitsAD('shorter', cornerR(face, level, gi, gj), cornerR(face, level, gi + 1, gj), cornerR(face, level, gi, gj + 1), cornerR(face, level, gi + 1, gj + 1));
          const got = ib[t + 2] === dIdx;
          if (got) adQuads++;
          if (want !== got) problems.push(`quad ${iq},${jq}: diagonal against the rule`);
          const corners = new Set(Array.from(ib.subarray(t, t + 6)));
          if (corners.size !== 4 || !corners.has(a) || !corners.has(a + 1) || !corners.has(a + n) || !corners.has(dIdx)) problems.push(`quad ${iq},${jq}: triangles do not hold its corners`);
        }
      }
      // Edges between two border vertices: always one step along the border, the same set in both splits.
      const edges = (idx: ArrayLike<number>): Set<string> => {
        const out = new Set<string>();
        for (let t = 0; t < Q * Q * 6; t += 3) {
          for (let e = 0; e < 3; e++) {
            const p0 = idx[t + e]!;
            const p1 = idx[t + ((e + 1) % 3)]!;
            const [i0, j0, i1, j1] = [p0 % n, Math.floor(p0 / n), p1 % n, Math.floor(p1 / n)];
            const onBorder = (i: number, j: number): boolean => i === 0 || j === 0 || i === Q || j === Q;
            if (!onBorder(i0, j0) || !onBorder(i1, j1)) continue;
            const sameLine = (i0 === i1 && (i0 === 0 || i0 === Q)) || (j0 === j1 && (j0 === 0 || j0 === Q));
            if (sameLine && Math.abs(i0 - i1) + Math.abs(j0 - j1) !== 1) problems.push(`an edge spans the border from ${i0},${j0} to ${i1},${j1}`);
            if (sameLine) out.add(`${Math.min(p0, p1)}-${Math.max(p0, p1)}`);
          }
        }
        return out;
      };
      const ea = edges(fixed.mesh.indices);
      const eb = edges(ib);
      borderEdges += eb.size;
      if (ea.size !== 4 * Q || eb.size !== 4 * Q || [...ea].some((e) => !eb.has(e))) problems.push(`border edges: fixed ${ea.size}, shorter ${eb.size}, want ${4 * Q} each and the same`);
    }
    const ok = problems.length === 0 && adQuads > 0 && adQuads < 2 * Q * Q;
    return { ok, detail: `quads cut along a–d ${adQuads} of ${2 * Q * Q}, border edges ${borderEdges}${problems.length ? `; ${problems.slice(0, 3).join('; ')}` : ''}` };
  }],
  ['sphere-split-shorter-radius', () => {
    const o = at(2, 6, 13, 40, { split: 'shorter' });
    const p = spherePatchMesh(o);
    let worst = 0;
    let missed = 0;
    let differs = 0;
    for (let s = 0; s < 300; s++) {
      const d = dirIn(2, 6, 13, 40, 0.01 + 0.98 * unit(hashInts(5, s, 1)), 0.01 + 0.98 * unit(hashInts(5, s, 2)));
      const drawn = rayMesh(p, S, d);
      if (Number.isNaN(drawn)) {
        missed++;
        continue;
      }
      worst = Math.max(worst, Math.abs(drawn - spherePatchRadius(o, d, 1)));
      if (Math.abs(drawn - spherePatchRadius({ ...o, split: 'fixed' }, d, 1)) > 0.05) differs++;
    }
    const ok = missed === 0 && worst < 0.01 && differs > 0;
    return { ok, detail: `spherePatchRadius on the drawn triangles: worst ${worst.toFixed(5)} m, missed ${missed}, ${differs} samples where the fixed split would be off` };
  }],
  ['sphere-split-shorter-coarse', () => {
    // Child 2/7/26/80 of parent 2/6/13/40: a child vertex moved by its whole shift lies on the parent's drawn triangles.
    const child = at(2, 7, 26, 80, { split: 'shorter' });
    const parent = at(2, 6, 13, 40, { split: 'shorter' });
    const p = spherePatchMesh(child);
    const bytes = p.mesh.vertices as Uint8Array;
    const n = Q + 1;
    let worst = 0;
    let worstSelf = 0;
    let centresAD = 0;
    for (let v = 0; v < n * n; v++) {
      const q = position(p, S, v);
      const l = Math.hypot(q[0], q[1], q[2]);
      const d: [number, number, number] = [q[0] / l, q[1] / l, q[2] / l];
      const shift = new DataView(bytes.buffer, bytes.byteOffset + v * S + 24, 4).getFloat32(0, true);
      worst = Math.max(worst, Math.abs(l + shift - spherePatchRadius(parent, d, 1)));
      worstSelf = Math.max(worstSelf, Math.abs(l + shift - spherePatchRadius(child, d, 2)));
      const i = v % n;
      const j = Math.floor(v / n);
      if (i % 2 === 1 && j % 2 === 1) {
        const gi = 26 * Q + i - 1;
        const gj = 80 * Q + j - 1;
        if (spherePatchSplitsAD('shorter', cornerR(2, 7, gi, gj), cornerR(2, 7, gi + 2, gj), cornerR(2, 7, gi, gj + 2), cornerR(2, 7, gi + 2, gj + 2))) centresAD++;
      }
    }
    const ok = worst < 0.01 && worstSelf < 0.01 && centresAD > 0;
    return { ok, detail: `own + shift against the parent's drawn surface: worst ${worst.toFixed(5)} m (step 2: ${worstSelf.toFixed(5)} m), parent quads cut along a–d ${centresAD}` };
  }],
  ['sphere-split-shorter-strip-cuts', () => {
    // A way cut by `sphereStripSurface` with the same split: every piece between two shares lies on one drawn triangle.
    const o = at(2, 6, 13, 40, { split: 'shorter' });
    const p = spherePatchMesh(o);
    const surface = sphereStripSurface({ radiusM: R, quads: Q, heightAt, split: 'shorter' });
    const plain = sphereStripSurface({ radiusM: R, quads: Q, heightAt });
    const cell = { face: 2, level: 6, x: 13, y: 40 };
    const base = (u: number, v: number): [number, number, number] => {
      const d = dirIn(2, 6, 13, 40, u, v);
      return [d[0] * R, d[1] * R, d[2] * R];
    };
    const unitOf = (q: readonly number[]): [number, number, number] => {
      const l = Math.hypot(q[0]!, q[1]!, q[2]!);
      return [q[0]! / l, q[1]! / l, q[2]! / l];
    };
    let pieces = 0;
    let split = 0;
    let plainSplit = 0;
    let worst = 0;
    const ways: [[number, number], [number, number]][] = [[[-0.2, 0.13], [1.2, 0.91]], [[1.1, 0.05], [-0.1, 0.97]], [[0.37, -0.1], [0.61, 1.1]], [[-0.1, 0.52], [1.1, 0.44]]];
    for (const [ua, ub] of ways) {
      const a = base(ua[0], ua[1]);
      const b = base(ub[0], ub[1]);
      const along = (t: number): [number, number, number] => unitOf([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      for (const [cuts, count] of [[surface.cuts(cell, a, b), true], [plain.cuts(cell, a, b), false]] as const) {
        for (let k = 0; k + 1 < cuts.length; k++) {
          const t0 = cuts[k]!;
          const t1 = cuts[k + 1]!;
          const h1 = rayHit(p, S, along(t0 + (t1 - t0) * 0.25));
          const h2 = rayHit(p, S, along(t0 + (t1 - t0) * 0.75));
          if (!count) {
            if (h1.t !== h2.t) plainSplit++;
            continue;
          }
          pieces++;
          if (h1.t !== h2.t) split++;
          const d = along((t0 + t1) / 2);
          worst = Math.max(worst, Math.abs(rayMesh(p, S, d) - R - surface.heightOn(6, [d[0] * R, d[1] * R, d[2] * R])));
        }
      }
    }
    const ok = pieces > 0 && split === 0 && worst < 0.01 && plainSplit > 0;
    return { ok, detail: `${pieces} pieces, ${split} across two triangles (the fixed split's cuts: ${plainSplit}); heightOn against the drawn surface ${worst.toFixed(5)} m` };
  }],
  ['sphere-coarse-extra-nearest', () => {
    const problems: string[] = [];
    const n = Q + 1;
    let blendMixed = 0;
    let checked = 0;
    for (const split of ['fixed', 'shorter'] as const) {
      const lists = new Map<string, Map<string, string>>();
      const cells: [number, number, number, number][] = [[2, 6, 13, 40], [2, 6, 14, 40], [0, 6, 63, 20]];
      const across = cubeNeighbour(0, 6, 63, 20, 1, 0);
      if (!across) return { ok: false, detail: 'no cell across the edge of the cube' };
      cells.push([across.face, 6, across.x, across.y]);
      for (const [face, level, x, y] of cells) {
        const near = spherePatchMesh(at(face, level, x, y, { split, extraAt, coarseExtra: 'nearest' }));
        const blend = spherePatchMesh(at(face, level, x, y, { split, extraAt }));
        const a = near.mesh.vertices as Uint8Array;
        const b = blend.mesh.vertices as Uint8Array;
        const byPos = new Map<string, string>();
        for (let v = 0; v < a.length / SX; v++) {
          // Everything but the coarse extra is the blended mesh's.
          if (!sameBytes(a.subarray(v * SX, v * SX + 52), b.subarray(v * SX, v * SX + 52))) problems.push(`vertex ${v}: bytes before the coarse extra differ`);
          const coarse = Array.from(a.subarray(v * SX + 52, v * SX + 56));
          if (!CATEGORIES.has(coarse[0]!)) problems.push(`vertex ${v}: coarse category ${coarse[0]} is a mix`);
          if (!CATEGORIES.has(b[v * SX + 52]!)) blendMixed++;
          if (v < n * n) {
            // The coarse extra is the extra of a parent vertex within one step.
            const i = v % n;
            const j = Math.floor(v / n);
            const from: string[] = [];
            for (let jj = j - 1; jj <= j + 1; jj++) for (let ii = i - 1; ii <= i + 1; ii++) if (ii >= 0 && jj >= 0 && ii <= Q && jj <= Q && ii % 2 === 0 && jj % 2 === 0) from.push(Array.from(a.subarray((jj * n + ii) * SX + 48, (jj * n + ii) * SX + 52)).join(','));
            if (!from.includes(coarse.join(','))) problems.push(`vertex ${i},${j}: coarse extra from no parent vertex near it`);
            checked++;
          }
          const q = position(near, SX, v);
          byPos.set(`${Math.round(q[0] * 10)},${Math.round(q[1] * 10)},${Math.round(q[2] * 10)}`, coarse.join(','));
        }
        lists.set(`${face}/${x}/${y}`, byPos);
      }
      // Neighbours agree on the coarse extra of their shared vertices, inside a face and over an edge of the cube.
      for (const [m, o] of [['2/13/40', '2/14/40'], ['0/63/20', `${across.face}/${across.x}/${across.y}`]] as const) {
        const A = lists.get(m)!;
        let shared = 0;
        for (const [k, e] of lists.get(o)!) {
          const mine = A.get(k);
          if (mine === undefined) continue;
          shared++;
          if (mine !== e) problems.push(`${m} and ${o} disagree on a shared coarse extra (${mine} against ${e})`);
        }
        if (shared < Q + 1) problems.push(`${m} and ${o}: only ${shared} shared vertices`);
      }
    }
    const ok = problems.length === 0 && blendMixed > 0;
    return { ok, detail: `${checked} vertices, the blend mixes ${blendMixed} categories, nearest none${problems.length ? `; ${problems.slice(0, 3).join('; ')}` : ''}` };
  }],
  ['sphere-ground-extra-glsl', () => {
    const base = { thinRank: [0.12, 0.25, 0.5, 1], thinFrom: [0.75, 0.6, 0.55, 0.5], lift: 'float coverLift(float a, float b, float c) { return 0.0; }' };
    const hook = 'vec3 groundVertex(vec3 p, vec4 extra) { return p + localUp(p) * extra.g; }';
    const off = [sphereGroundVs(base), sphereGroundDepthVs(base)];
    const handed = [sphereGroundVs({ ...base, extra: {} }), sphereGroundDepthVs({ ...base, extra: {} })];
    const hooked = [sphereGroundVs({ ...base, extra: { vertex: hook } }), sphereGroundDepthVs({ ...base, extra: { vertex: hook } })];
    const problems: string[] = [];
    const tokens = /a_extra|a_coarseExtra|v_extra|groundVertex/;
    if (off.some((t) => tokens.test(t))) problems.push('the programs without extra name the channel');
    // Taking out every line that names the channel gives the program without it.
    const strip = (t: string): string => t.split('\n').filter((l) => !tokens.test(l)).join('\n');
    if (strip(handed[0]!) !== off[0] || strip(hooked[0]!) !== off[0] || strip(hooked[1]!) !== off[1]) problems.push('the channel changes more than its own lines');
    if (handed[1] !== off[1]) problems.push('without a hook the shadow pass must stay as it is');
    if (!handed[0]!.includes('in vec4 a_extra;') || !handed[0]!.includes('in vec4 a_coarseExtra;') || !handed[0]!.includes('out vec4 v_extra;') || !handed[0]!.includes('  vec4 extra = mix(a_extra, a_coarseExtra, m);\n  v_extra = extra;')) problems.push('the colour pass does not hand on v_extra');
    if (handed[0]!.includes('groundVertex')) problems.push('a hook is called that was not given');
    // The hook: called in both passes at the same place, after the blend between levels and before the lift.
    for (const t of hooked) {
      const main = t.slice(t.indexOf('void main()'));
      const morph = main.indexOf('p += localUp(p) * (a_coarseShift * m);');
      const call = main.indexOf('  p = groundVertex(p, extra);');
      const lift = main.indexOf('coverLift(');
      if (!(morph >= 0 && morph < call && call < lift)) problems.push('the hook is not called between the blend and the lift');
      if (!t.includes(hook)) problems.push('the hook is not pasted');
    }
    return { ok: problems.length === 0, detail: problems.length ? problems.join('; ') : 'off = unchanged text; extra hands on v_extra; the hook moves the vertex in both passes before the lift' };
  }],
];
