// Cobbles of the square and the streets, grass along their edges, pebbles on the dirt tracks (owner: terrain, B2/B3).
//
//   square    concentric rings of setts round the square's centre, a darker band every few rings, a ring of long
//             kerb setts at the rim; the well's spot is left free for the props
//   streets   every cobbled street in the village (within ~70 m of the square) is laid as rows of separate rounded
//             setts across the street, staggered from row to row, of varied size and colour. Toward the edges the
//             setts sink, tilt and go missing (worn, rutted edges); the street ends raggedly in the grass. Where
//             streets meet, the first one laid owns the ground; the bridge deck belongs to the bridge
//   far       beyond the village the same streets become a cheap painted ribbon: one strip a little above the ground,
//             its vertex colours mottled like setts and mortar, edges tucked into the worn earth
//   edges     grass tufts (swaying blades) overhang the street and square edges; dirt tracks get sparser tufts and
//             loose pebbles
//
// All stones of the module are one static mesh per kind (setts, ribbon, tufts and pebbles), merged into chunks by the
// scene assembly. The ground under the paving is painted as dark mortar and worn earth (terrain/ground.ts).

import { valueNoise2 } from 'wallhammer-web/gen-core';
import { MAT, MeshBuilder, PALETTE, clamp, hex, mixRgb, nearestOnPolyline, norm3, rock, vary, VARY_RICH } from '../kit/index.ts';
import type { ContentModule, RGB, Vec2 } from '../kit/index.ts';
import type { PathLine } from '../layout.ts';
import { structureDist } from '../layout.ts';
import { bridgeFrame, cobble, frameAt, grassTuft, orientToNormals, pathLength, settOutline } from './common.ts';

/** Streets are laid stone by stone within this radius of the origin (± a ragged noise), as a ribbon beyond. */
export const PAVING_NEAR = 70;

const SETT = {
  stone: [hex('#a69684'), hex('#958a86'), hex('#b3a08a'), hex('#8c8076'), hex('#a3958f'), hex('#9d8a74')] as RGB[],
  band: hex('#7e6a58'),
  kerb: hex('#8a8288'),
  mortarRibbon: hex('#625446'),
};

const GRASS: RGB[] = [PALETTE.grass, PALETTE.grassLight, hex('#8aa63c'), hex('#4b7428'), hex('#7fa448')];

export const paving: ContentModule = {
  name: 'paving',
  build(ctx) {
    const { layout, field } = ctx;
    const heightAt = field.heightAt;
    const s = ctx.stream('paving');
    const nSeed = s.seed;
    const bf = bridgeFrame(ctx);
    const sq = layout.square;
    const well = layout.well;
    const cobblePaths = layout.paths.filter((p) => p.kind === 'cobble');

    const setts = new MeshBuilder().set({ cls: MAT.stone });
    const ribbon = new MeshBuilder().set({ cls: MAT.stone });
    const tufts = new MeshBuilder().set({ cls: MAT.foliage });
    const pebbles = new MeshBuilder().set({ cls: MAT.stone });
    let stones = 0;

    const nearZone = (x: number, z: number): boolean => Math.hypot(x, z) < PAVING_NEAR + (valueNoise2(x, z, 9, nSeed) - 0.5) * 10;
    const inWater = (x: number, z: number): boolean => field.river(x, z).inWater;
    /** Ground taken by something else: a house, the water, the bridge deck, the well. */
    const blocked = (x: number, z: number, margin = 0.2): boolean =>
      structureDist(layout.structures, x, z) < margin || inWater(x, z) || bf.onDeck(x, z, 0.12) || Math.hypot(x - well.x, z - well.z) < 1.35;
    /** Paved by an earlier street (index below `upTo`) or by the square. */
    const pavedBefore = (x: number, z: number, upTo: number, grow = 0.08): boolean => {
      if (Math.hypot(x - sq.x, z - sq.z) < sq.radius + grow) return true;
      for (let k = 0; k < upTo; k++) {
        const q = cobblePaths[k]!;
        if (nearestOnPolyline(q.dense, q.lengths, x, z).dist < q.width / 2 + grow) return true;
      }
      return false;
    };
    const pick = (k: number, ...keys: number[]): RGB => vary(SETT.stone[Math.floor(s.float(...keys, k) * SETT.stone.length) % SETT.stone.length]!, VARY_RICH, s, ...keys, k + 1);

    // --- The square: concentric rings -------------------------------------------------------------------------------------
    {
      // The centre stone.
      const centre: Vec2[] = [];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        centre.push([sq.x + Math.cos(a) * 0.36, sq.z + Math.sin(a) * 0.36]);
      }
      cobble(setts, centre, heightAt, 0.1, 0.02, SETT.band);
      stones++;
      let rIn = 0.46;
      let ring = 0;
      while (rIn < sq.radius - 0.05) {
        const kerb = rIn > sq.radius - 0.75;
        const width = kerb ? sq.radius - rIn + 0.05 : s.range(0.46, 0.54, 10, ring);
        const rMid = rIn + width / 2;
        const unit = kerb ? 0.95 : s.range(0.5, 0.64, 11, ring);
        const count = Math.max(4, Math.round((Math.PI * 2 * rMid) / unit));
        const start = s.range(0, Math.PI * 2, 12, ring);
        const band = !kerb && ring > 1 && ring % 5 === 0;
        const arc = (Math.PI * 2 * rMid) / count;
        for (let k = 0; k < count; k++) {
          // Arc length u along the ring, v outward from rIn.
          const len = arc * s.range(0.82, 1.15, 13, ring, k);
          const u0 = k * arc + s.jitter(arc * 0.06, 14, ring, k);
          const u1 = Math.min(u0 + len, (k + 1) * arc + arc * 0.12);
          const map = (u: number, v: number): Vec2 => {
            const a = start + u / rMid;
            const r = rIn + v;
            return [sq.x + Math.cos(a) * r, sq.z + Math.sin(a) * r];
          };
          const [cx, cz] = map((u0 + u1) / 2, width / 2);
          if (blocked(cx, cz, 0.3)) continue;
          const gap = 0.035;
          const outline = settOutline(u0 + gap, u1 - gap, gap, width - gap, s, [ring, k], map);
          const col = band ? vary(SETT.band, VARY_RICH, s, 15, ring, k) : kerb ? vary(SETT.kerb, VARY_RICH, s, 16, ring, k) : pick(0, 17, ring, k);
          cobble(setts, outline, heightAt, kerb ? 0.13 : s.range(0.07, 0.11, 18, ring, k), 0.02, col, [s.jitter(0.04, 19, ring, k), s.jitter(0.04, 20, ring, k)]);
          stones++;
        }
        rIn += width;
        ring++;
      }
    }

    // --- Streets: rows of setts ---------------------------------------------------------------------------------------------
    const ribbonRuns: { p: PathLine; a0: number; a1: number }[] = [];
    cobblePaths.forEach((p, pi) => {
      const total = pathLength(p);
      const half0 = p.width / 2;
      let a = 0;
      let row = 0;
      let runStart = -1;
      const f = { x: 0, z: 0, dx: 0, dz: 1 };
      while (a < total) {
        const len = s.range(0.42, 0.6, 30 + pi, row);
        const a0 = a, a1 = Math.min(total, a + len);
        a = a1;
        row++;
        frameAt(p.dense, p.lengths, (a0 + a1) / 2, f);
        const near = nearZone(f.x, f.z);
        // The far ribbon: collect the runs of rows outside the village.
        const farHere = !near;
        if (farHere && runStart < 0) runStart = a0;
        if (!farHere && runStart >= 0) {
          ribbonRuns.push({ p, a0: runStart, a1: a0 });
          runStart = -1;
        }
        if (!near) continue;
        // Ragged edges: the paved half width wanders along the street; the ends of a street fray.
        const endFray = Math.min(1, Math.min(a0, total - a1) / 3);
        const half = half0 + (valueNoise2(f.x, f.z, 2.3, nSeed + 3) - 0.5) * 0.4 - (1 - endFray) * 0.4;
        let v = -half - s.range(0, 0.35, 31 + pi, row);
        let k = 0;
        while (v < half) {
          const w = s.range(0.42, 0.68, 32 + pi, row, k);
          const v0 = Math.max(v, -half), v1 = Math.min(v + w, half);
          v += w;
          k++;
          if (v1 - v0 < 0.2) continue;
          const vc = (v0 + v1) / 2;
          const edge = clamp((Math.abs(vc) - (half - 0.6)) / 0.6, 0, 1);
          // Worn edges: some setts are gone.
          if (s.chance(edge * 0.32 + (1 - endFray) * 0.25, 33 + pi, row, k)) continue;
          const map = (u: number, vv: number): Vec2 => {
            const g = frameAt(p.dense, p.lengths, u);
            return [g.x + g.dz * vv, g.z - g.dx * vv];
          };
          const [cx, cz] = map((a0 + a1) / 2, vc);
          if (blocked(cx, cz) || pavedBefore(cx, cz, pi)) continue;
          const gap = 0.03;
          const outline = settOutline(a0 + gap, a1 - gap, v0 + gap, v1 - gap, s, [100 + pi, row, k], map);
          if (outline.some(([x, z]) => blocked(x, z, 0.05) || pavedBefore(x, z, pi, -0.05))) continue;
          let col = pick(0, 34 + pi, row, k);
          // Mud and wear darken the edge setts; a few warm odd stones.
          col = mixRgb(col, PALETTE.dirt, edge * 0.35);
          const dome = s.range(0.06, 0.11, 35 + pi, row, k) * (1 - edge * 0.45);
          const sink = 0.02 + edge * s.range(0.02, 0.07, 36 + pi, row, k);
          const tilt: Vec2 = [s.jitter(0.04 + edge * 0.1, 37 + pi, row, k), s.jitter(0.04 + edge * 0.1, 38 + pi, row, k)];
          cobble(setts, outline, heightAt, dome, sink, col, tilt);
          stones++;
        }
      }
      if (runStart >= 0) ribbonRuns.push({ p, a0: runStart, a1: total });
    });

    // --- Far streets: a mottled ribbon --------------------------------------------------------------------------------------
    for (const run of ribbonRuns) {
      const { p } = run;
      const pi = cobblePaths.indexOf(p);
      const half = p.width / 2;
      const across = [-half - 0.35, -half + 0.05, -half * 0.5, 0, half * 0.5, half - 0.05, half + 0.35];
      const rows: number[][] = [];
      const step = 0.45;
      const n = Math.max(1, Math.ceil((run.a1 - run.a0) / step));
      const f = { x: 0, z: 0, dx: 0, dz: 1 };
      for (let j = 0; j <= n; j++) {
        const a = run.a0 + ((run.a1 - run.a0) * j) / n;
        frameAt(p.dense, p.lengths, a, f);
        const line: number[] = [];
        for (let i = 0; i < across.length; i++) {
          const v = across[i]! + (i > 0 && i < across.length - 1 ? s.jitter(0.08, 50 + pi, j, i) : 0);
          const x = f.x + f.dz * v, z = f.z - f.dx * v;
          const outer = i === 0 || i === across.length - 1;
          const y = heightAt(x, z) + (outer ? -0.04 : 0.1);
          // Setts and mortar: a vertex is a stone or a joint, mottled, the edges muddy.
          const joint = s.chance(0.3, 51 + pi, j, i);
          let c = joint ? SETT.mortarRibbon : pick(0, 52 + pi, j, i);
          if (outer) c = mixRgb(PALETTE.dirt, PALETTE.dirtLight, s.float(53 + pi, j, i));
          else if (i === 1 || i === across.length - 2) c = mixRgb(c, PALETTE.dirt, 0.35);
          line.push(ribbon.vertex([x, y, z], [0, 1, 0], c, joint ? 0.8 : 1));
        }
        rows.push(line);
      }
      const first = ribbon.indexCount;
      for (let j = 0; j < n; j++) for (let i = 0; i < across.length - 1; i++) ribbon.quad(rows[j]![i]!, rows[j + 1]![i]!, rows[j + 1]![i + 1]!, rows[j]![i + 1]!);
      orientToNormals(ribbon, first);
    }
    // Smooth normals of the ribbon from its own surface (it follows the hills).
    recomputeNormals(ribbon);

    // --- Grass along the edges --------------------------------------------------------------------------------------------
    let tuftCount = 0;
    const tuftAt = (x: number, z: number, size: number, key: number): void => {
      if (blocked(x, z, 0.4)) return;
      grassTuft(tufts, x, heightAt(x, z), z, size, s, key, GRASS);
      tuftCount++;
    };
    layout.paths.forEach((p, pi) => {
      const total = pathLength(p);
      const half = p.width / 2;
      const ci = cobblePaths.indexOf(p);
      const f = { x: 0, z: 0, dx: 0, dz: 1 };
      let k = 0;
      for (let a = 0.4; a < total; a += p.kind === 'cobble' ? s.range(0.45, 0.8, 60 + pi, k) : s.range(0.8, 1.6, 60 + pi, k)) {
        k++;
        frameAt(p.dense, p.lengths, a, f);
        if (Math.hypot(f.x, f.z) > PAVING_NEAR + 18) continue;
        for (const side of [-1, 1]) {
          if (!s.chance(p.kind === 'cobble' ? 0.8 : 0.5, 61 + pi, k, side)) continue;
          const v = side * (half + s.range(-0.05, 0.38, 62 + pi, k, side));
          const x = f.x + f.dz * v, z = f.z - f.dx * v;
          // Not on another street's paving or on the square.
          if (pavedBefore(x, z, cobblePaths.length, 0.05) && !(ci >= 0 && pavedOnlyBy(x, z, ci))) continue;
          tuftAt(x, z, s.range(0.24, 0.44, 63 + pi, k, side), pi * 100000 + k * 2 + (side > 0 ? 1 : 0));
        }
        // Dirt tracks: grass in the middle strip between the ruts.
        if (p.kind === 'dirt' && s.chance(0.35, 64 + pi, k)) tuftAt(f.x + s.jitter(0.1, 65 + pi, k), f.z + s.jitter(0.1, 66 + pi, k), s.range(0.16, 0.26, 67 + pi, k), 5e6 + pi * 10000 + k);
      }
    });
    // Round the square.
    {
      const count = Math.round((Math.PI * 2 * (sq.radius + 0.3)) / 0.5);
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2 + s.jitter(0.02, 70, k);
        const r = sq.radius + s.range(0.05, 0.42, 71, k);
        const x = sq.x + Math.cos(a) * r, z = sq.z + Math.sin(a) * r;
        if (!s.chance(0.85, 72, k)) continue;
        let onStreet = false;
        for (const q of cobblePaths) if (nearestOnPolyline(q.dense, q.lengths, x, z).dist < q.width / 2 + 0.25) onStreet = true;
        if (onStreet) continue;
        tuftAt(x, z, s.range(0.24, 0.42, 73, k), 7e6 + k);
      }
    }

    // A tuft position is paved only by street `ci` itself (its own edge, which is where tufts belong).
    function pavedOnlyBy(x: number, z: number, ci: number): boolean {
      if (Math.hypot(x - sq.x, z - sq.z) < sq.radius + 0.05) return false;
      for (let k = 0; k < cobblePaths.length; k++) {
        if (k === ci) continue;
        const q = cobblePaths[k]!;
        if (nearestOnPolyline(q.dense, q.lengths, x, z).dist < q.width / 2 + 0.05) return false;
      }
      return true;
    }

    // --- Pebbles on the dirt tracks ---------------------------------------------------------------------------------------
    let pebbleCount = 0;
    layout.paths.forEach((p, pi) => {
      if (p.kind !== 'dirt') return;
      const total = pathLength(p);
      const f = { x: 0, z: 0, dx: 0, dz: 1 };
      for (let k = 0; k < total / 1.3; k++) {
        const a = s.range(0, total, 80 + pi, k);
        frameAt(p.dense, p.lengths, a, f);
        const v = s.jitter(p.width / 2 + 0.4, 81 + pi, k);
        const x = f.x + f.dz * v, z = f.z - f.dx * v;
        if (blocked(x, z, 0.3)) continue;
        const size = s.range(0.14, 0.32, 82 + pi, k);
        const col = vary(mixRgb(PALETTE.stone, PALETTE.stoneWarm, s.float(83 + pi, k)), VARY_RICH, s, 84 + pi, k);
        rock(pebbles, [x, heightAt(x, z) - size * 0.3, z], [size * 1.2, size * 0.7, size], col, { stream: s.child(pi * 1000 + k), detail: 1, cuts: 4 });
        pebbleCount++;
      }
    });

    return {
      statics: [
        { material: 'solid', mesh: setts, name: 'setts' },
        { material: 'solid', mesh: ribbon, name: 'street-ribbon', castShadow: false },
        { material: 'solid', mesh: tufts, name: 'edge-grass', castShadow: false },
        { material: 'solid', mesh: pebbles, name: 'pebbles', castShadow: false },
      ],
      stats: { setts: stones, edgeTufts: tuftCount, pebbles: pebbleCount, ribbonRuns: ribbonRuns.length },
    };
  },
};

/** Smooth vertex normals from the triangles (area weighted), for strips that follow the ground. */
function recomputeNormals(b: MeshBuilder): void {
  const acc = new Float64Array(b.vertexCount * 3);
  const P = b.positionData;
  for (let t = 0; t < b.indexCount; t += 3) {
    const a = b.indexData[t]!, c = b.indexData[t + 1]!, d = b.indexData[t + 2]!;
    const e1 = [P[c * 3]! - P[a * 3]!, P[c * 3 + 1]! - P[a * 3 + 1]!, P[c * 3 + 2]! - P[a * 3 + 2]!];
    const e2 = [P[d * 3]! - P[a * 3]!, P[d * 3 + 1]! - P[a * 3 + 1]!, P[d * 3 + 2]! - P[a * 3 + 2]!];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    for (const v of [a, c, d]) for (let k = 0; k < 3; k++) acc[v * 3 + k] = acc[v * 3 + k]! + n[k]!;
  }
  b.edit((_p, out, _v, v) => {
    const n = norm3([acc[v * 3]!, acc[v * 3 + 1]!, acc[v * 3 + 2]!]);
    if (n[1] < 0) (n[0] = -n[0]), (n[1] = -n[1]), (n[2] = -n[2]);
    out[0] = n[0];
    out[1] = n[1];
    out[2] = n[2];
  });
}
