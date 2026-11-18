// The ground (owner: terrain): one painted height field for the whole world, plus the mountain ranges on the horizon
// and a few slow mist banks in the hollows.
//
//   core      a 1 m grid over the village (±64 m): fine enough for path edges, door steps, the river banks
//   ring      a 2 m grid out to ±128 m (the hill ring, both ends of the river)
//   far       an 8 m grid out to a disc of ~390 m (the backdrop hills of height.ts)
//   ranges    a polar skirt from ~360 m to 620 m: two layered ridges rising behind the backdrop, painted from forest
//             green through violet to pale lavender tops, with mist in their valleys (no shadows)
//
// Where two grids meet, the finer grid's border vertices are moved onto the coarser grid's edges (linear between the
// coarse vertices), so there are no cracks. Every vertex samples `heightAt` once (normals from the neighbours), so
// everything that stands on `heightAt` stands on this mesh.
//
// The colour of a vertex is painted from what is around it: grass in several shades with patches and speckle, dry
// and lush spots, earth on slopes and rock on steep ones, mortar under the cobbles and worn, rutted earth along the
// streets, ruts on the dirt tracks, trampled earth round the houses and at the doors, dark tilled soil in the
// gardens, bare earth, roots and needle litter under the trees (with their shade baked as occlusion), gravel on the
// river banks, a dark wet line at the water and a stony, weedy bed under it, and cooler, hazier greens far out.

import { valueNoise2 } from 'wallhammer-web/gen-core';
import { MAT, MeshBuilder, clamp, segmentSolid, gradient, hex, lerp, mixRgb, norm3, scaleRgb, smoothstep, vary, VARY_SUBTLE } from '../kit/index.ts';
import type { ContentModule, ParticleSource, RGB, SolidDef } from '../kit/index.ts';
import { pathNear, structureDist, toLocal } from '../layout.ts';
import type { TreeSpot } from '../layout.ts';
import { bridgeFrame, orientToNormals, within } from './common.ts';

// Ground colours (base colours from the concept; generators vary them per vertex).
const C = {
  grassDeep: hex('#4b7428'),
  grass: hex('#6c9838'),
  grassWarm: hex('#8aa63c'),
  grassLight: hex('#a6c452'),
  grassDry: hex('#b5aa58'),
  grassCool: hex('#4f7448'),
  dirt: hex('#8a6440'),
  dirtLight: hex('#ae8a5c'),
  dirtDark: hex('#5c4230'),
  mortar: hex('#584a3e'),
  soil: hex('#4a3224'),
  soilLight: hex('#6a4a32'),
  litter: hex('#6e4c30'),
  root: hex('#4e3826'),
  rock: hex('#6c6470'),
  gravelA: hex('#a89884'),
  gravelB: hex('#8e8890'),
  gravelC: hex('#bcab8e'),
  wet: hex('#4c4438'),
  bed: hex('#4a5440'),
  bedStone: hex('#6a665e'),
  farGreen: hex('#56704a'),
  forest: hex('#36523e'),
  ridgeViolet: hex('#6e5e8e'),
  ridgeBlue: hex('#5c6a9a'),
  ridgeTop: hex('#c7a6b4'),
  mist: hex('#d4b6c2'),
};

/** Grid sizes (metres). */
const CORE = 64;
const RING = 128;
const FAR_DISC = 388;
const FAR_HALF = 392;

export const ground: ContentModule = {
  name: 'ground',
  build(ctx) {
    const { layout, field } = ctx;
    const stream = ctx.stream('ground');
    const nSeed = stream.seed;
    const heightAt = field.heightAt;
    const bf = bridgeFrame(ctx);

    // Trees in 10 m buckets for the shade and litter under them.
    const treeBuckets = new Map<number, TreeSpot[]>();
    const bkey = (x: number, z: number): number => Math.floor(x / 10) * 4099 + Math.floor(z / 10);
    for (const t of layout.trees) {
      const reach = t.kind === 'giant' ? 12 : 6;
      for (let dz = -reach; dz <= reach; dz += 10) {
        for (let dx = -reach; dx <= reach; dx += 10) {
          const k = bkey(t.x + dx, t.z + dz);
          let l = treeBuckets.get(k);
          if (!l) treeBuckets.set(k, (l = []));
          if (!l.includes(t)) l.push(t);
        }
      }
    }

    /** The painted colour (rgb) and baked occlusion of a ground vertex. */
    const paint = (x: number, z: number, y: number, ny: number, ix: number, iz: number): [RGB, number] => {
      const r = Math.hypot(x, z);
      let ao = 1;
      // Grass: big patches, medium clumps, small speckle.
      const n1 = valueNoise2(x, z, 23, nSeed);
      const n2 = valueNoise2(x, z, 7.5, nSeed + 1);
      const n3 = valueNoise2(x, z, 2.7, nSeed + 2);
      const n4 = valueNoise2(x, z, 13, nSeed + 3);
      let c = gradient([[0, C.grassDeep], [0.42, C.grass], [0.72, C.grassWarm], [1, C.grassLight]], clamp(n1 * 0.62 + n2 * 0.38, 0, 1));
      c = mixRgb(c, C.grassDry, smoothstep(0.62, 0.82, n4) * 0.55);
      c = scaleRgb(c, 0.9 + 0.2 * n3);
      // Dark clumps (lush tufts) and light flecks.
      if (n3 > 0.74) c = mixRgb(c, C.grassDeep, (n3 - 0.74) * 2.2);
      c = vary(c, VARY_SUBTLE, stream, ix, iz);
      // Slopes: earth, then rock.
      c = mixRgb(c, C.dirt, smoothstep(0.86, 0.66, ny) * (0.6 + 0.4 * n2));
      c = mixRgb(c, C.rock, smoothstep(0.66, 0.46, ny));
      ao *= lerp(0.82, 1, smoothstep(0.5, 0.9, ny));
      // Hills: a little drier on the tops of the ring.
      c = mixRgb(c, C.grassDry, smoothstep(10, 22, y) * smoothstep(60, 110, r) * 0.25 * n2);

      if (Math.abs(x) < RING + 4 && Math.abs(z) < RING + 4) {
        // Streets and tracks.
        const p = pathNear(layout.paths, x, z);
        if (p.path && p.dist < p.path.width / 2 + 2) {
          const half = p.path.width / 2;
          const d = p.dist;
          const wobble = (valueNoise2(x, z, 1.7, nSeed + 5) - 0.5) * 0.5;
          if (p.path.kind === 'cobble') {
            // Mortar under the setts, worn earth along the edges, a darker rut where carts run off the paving.
            const worn = within(d + wobble, half + 0.2, half + 1.3);
            c = mixRgb(c, mixRgb(C.dirtLight, C.dirt, n3), worn * 0.85);
            const rut = within(Math.abs(d - half - 0.4 - wobble * 0.4), 0.12, 0.42) * smoothstep(0.35, 0.6, n2);
            c = mixRgb(c, C.dirtDark, rut * 0.6);
            ao *= 1 - rut * 0.12;
            c = mixRgb(c, C.mortar, within(d, half - 0.15, half + 0.15));
          } else {
            // A dirt track: bare earth, two wheel ruts, grass between them.
            const track = within(d + wobble * 0.6, half - 0.2, half + 0.7);
            c = mixRgb(c, mixRgb(C.dirtLight, C.dirt, 0.4 + 0.4 * n3), track * 0.9);
            const ruts = within(Math.abs(d - half * 0.5), 0.1, 0.32) * track;
            c = mixRgb(c, C.dirtDark, ruts * 0.55);
            ao *= 1 - ruts * 0.1;
            c = mixRgb(c, mixRgb(C.grass, C.dirt, 0.4), within(d, 0.12, 0.3) * track * 0.45);
          }
        }
        // The square: mortar under the paving, a worn ring round it.
        const ds = Math.hypot(x - layout.square.x, z - layout.square.z);
        c = mixRgb(c, mixRgb(C.dirtLight, C.dirt, n3), within(ds, layout.square.radius + 0.3, layout.square.radius + 1.6) * 0.8);
        c = mixRgb(c, C.mortar, within(ds, layout.square.radius - 0.1, layout.square.radius + 0.2));
        // The bridge deck end: earth where the street meets it.
        if (bf.onDeck(x, z, 1.4)) c = mixRgb(c, C.dirt, 0.5);
        // Round the houses: trampled earth, darker in the corners at the walls; worn earth at the doors.
        const sd = structureDist(layout.structures, x, z);
        if (sd < 2.5) {
          c = mixRgb(c, mixRgb(C.dirt, C.dirtLight, n2), within(sd + wobbleOf(n3), 0.2, 1.7) * 0.7);
          ao *= lerp(0.55, 1, smoothstep(-0.2, 1.5, sd));
        }
        for (const s of layout.structures) {
          const dd = Math.hypot(x - s.door.x, z - s.door.z);
          if (dd < 3) c = mixRgb(c, C.dirtLight, within(dd, 0.6, 2.6) * 0.75);
        }
        // Gardens: tilled soil in rows.
        for (const g of layout.gardens) {
          const [lx, lz] = toLocal({ x: g.x, z: g.z, yaw: g.yaw }, x, z);
          const m = Math.min(g.w / 2 + 0.3 - Math.abs(lx), g.d / 2 + 0.3 - Math.abs(lz));
          if (m > -0.8) {
            const rows = 0.5 + 0.5 * Math.cos((lz / 0.55) * Math.PI * 2);
            c = mixRgb(c, mixRgb(C.soil, C.soilLight, rows * 0.7), smoothstep(-0.8, 0.2, m));
            ao *= 1 - 0.1 * smoothstep(-0.2, 0.3, m) * (1 - rows);
          }
        }
      }
      // Under the trees: bare earth, roots, needle litter, and the canopy's shade.
      const bucket = treeBuckets.get(bkey(x, z));
      if (bucket) {
        for (const t of bucket) {
          const d = Math.hypot(x - t.x, z - t.z);
          if (t.kind === 'giant') {
            const s = t.scale;
            const roots = 0.5 + 0.5 * Math.sin(Math.atan2(z - t.z, x - t.x) * 7 + t.variant * 20);
            c = mixRgb(c, mixRgb(C.dirt, C.root, roots * 0.6), within(d, 3.2 * s, 6.5 * s) * (0.55 + 0.35 * roots));
            ao *= 1 - 0.28 * within(d, 6 * s, 11 * s);
          } else if (t.kind === 'conifer') {
            c = mixRgb(c, C.litter, within(d, 1.4 * t.scale, 2.8 * t.scale) * 0.7);
            ao *= 1 - 0.2 * within(d, 2 * t.scale, 3.6 * t.scale);
          } else if (t.kind === 'broadleaf') {
            c = mixRgb(c, mixRgb(C.dirt, C.grassDeep, 0.4), within(d, 1.2 * t.scale, 2.6 * t.scale) * 0.6);
            ao *= 1 - 0.18 * within(d, 2.8 * t.scale, 5 * t.scale);
          } else {
            ao *= 1 - 0.12 * within(d, 0.8 * t.scale, 1.8 * t.scale);
          }
        }
      }
      // The river: a stony, weedy bed under the water, a dark wet line, gravel up the banks.
      const rv = field.river(x, z);
      const edge = rv.dist - rv.at.width / 2;
      if (edge < 3.5) {
        const pick = stream.float(ix, iz, 7);
        const gravel = pick < 0.34 ? C.gravelA : pick < 0.67 ? C.gravelB : C.gravelC;
        const gReach = 1.4 + 1.6 * n2;
        c = mixRgb(c, scaleRgb(gravel, 0.9 + 0.2 * n3), within(edge, gReach - 0.6, gReach + 0.4) * 0.9);
        c = mixRgb(c, C.wet, within(Math.abs(edge + 0.05), 0.12, 0.6) * 0.8);
        if (edge < 0) {
          const deep = smoothstep(0, -2.5, edge);
          c = mixRgb(mixRgb(C.bedStone, C.bed, n2), C.bed, deep * 0.5);
          c = scaleRgb(c, 1 - 0.3 * deep);
          ao *= 1 - 0.25 * deep;
        }
      }
      // Far out: cooler, darker green that the haze takes over.
      c = mixRgb(c, C.farGreen, smoothstep(118, 330, r) * 0.55);
      c = mixRgb(c, C.forest, smoothstep(240, 380, r) * smoothstep(0.5, 0.2, n1) * 0.5);
      return [c, ao];
    };

    /**
     * One grid ring: vertices every `step` over ±`half`, quads inside ±`hole` left out (a finer grid covers them),
     * border vertices snapped onto the coarser `outerStep` grid outside, quads beyond the disc `disc` dropped.
     */
    const ringGrid = (b: MeshBuilder, step: number, half: number, hole: number, outerStep: number, disc = Infinity): void => {
      const n = Math.round((half * 2) / step);
      const idx = new Int32Array((n + 1) * (n + 1)).fill(-1);
      const H = new Float32Array((n + 1) * (n + 1)).fill(Number.NaN);
      const X = (i: number): number => -half + i * step;
      const quadUsed = (i: number, j: number): boolean => {
        const cx = X(i) + step / 2, cz = X(j) + step / 2;
        if (Math.abs(cx) < hole && Math.abs(cz) < hole) return false;
        return Math.hypot(cx, cz) <= disc;
      };
      // Height of grid vertex (i, j), snapped on the outer border to the coarse grid.
      const h = (i: number, j: number): number => {
        const k = j * (n + 1) + i;
        if (!Number.isNaN(H[k]!)) return H[k]!;
        const x = X(i), z = X(j);
        let y: number;
        const onX = i === 0 || i === n, onZ = j === 0 || j === n;
        if (outerStep > step && (onX || onZ)) {
          // Along the border, between coarse vertices.
          const along = onX ? z : x;
          const a0 = Math.floor((along + half) / outerStep) * outerStep - half;
          const a1 = a0 + outerStep;
          const t = (along - a0) / outerStep;
          const ya = onX ? heightAt(x, a0) : heightAt(a0, z);
          const yb = onX ? heightAt(x, a1) : heightAt(a1, z);
          y = t < 1e-6 ? ya : lerp(ya, yb, t);
        } else y = heightAt(x, z);
        H[k] = y;
        return y;
      };
      const vert = (i: number, j: number): number => {
        const k = j * (n + 1) + i;
        if (idx[k]! >= 0) return idx[k]!;
        const x = X(i), z = X(j), y = h(i, j);
        const hx = (i < n ? h(i + 1, j) : heightAt(x + step, z)) - (i > 0 ? h(i - 1, j) : heightAt(x - step, z));
        const hz = (j < n ? h(i, j + 1) : heightAt(x, z + step)) - (j > 0 ? h(i, j - 1) : heightAt(x, z - step));
        const nrm = norm3([-hx, 2 * step, -hz]);
        const [col, ao] = paint(x, z, y, nrm[1], Math.round(x * 2), Math.round(z * 2));
        const v = b.vertex([x, y, z], nrm, col, ao);
        idx[k] = v;
        return v;
      };
      const first = b.indexCount;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          if (!quadUsed(i, j)) continue;
          const a = vert(i, j), bb = vert(i + 1, j), c = vert(i + 1, j + 1), d = vert(i, j + 1);
          // Split along the diagonal that follows the ground best (the smaller height difference).
          if (Math.abs(h(i, j) - h(i + 1, j + 1)) <= Math.abs(h(i + 1, j) - h(i, j + 1))) {
            b.tri(a, d, c);
            b.tri(a, c, bb);
          } else {
            b.tri(a, d, bb);
            b.tri(bb, d, c);
          }
        }
      }
      orientToNormals(b, first);
    };

    const near = new MeshBuilder().set({ cls: MAT.ground });
    ringGrid(near, 1, CORE, 0, 2);
    const ring = new MeshBuilder().set({ cls: MAT.ground });
    ringGrid(ring, 2, RING, CORE, 8);
    const far = new MeshBuilder().set({ cls: MAT.ground });
    ringGrid(far, 8, FAR_HALF, RING, 8, FAR_DISC);

    // --- Mountain ranges on the horizon ---------------------------------------------------------------------------------
    const ranges = new MeshBuilder().set({ cls: MAT.ground });
    {
      const segs = 300;
      const radii = [360, 378, 392, 404, 425, 450, 478, 505, 535, 565, 595, 622];
      // Two ridges: a nearer forested one and a higher, bluer one behind it. Their crest heights vary around.
      const ridge = (a: number, r: number): { extra: number; layer: number; crest: number } => {
        const cx = Math.cos(a), cz = Math.sin(a);
        const n1 = valueNoise2(cx * 480, cz * 480, 70, nSeed + 11);
        const n2 = valueNoise2(cx * 480, cz * 480, 26, nSeed + 12);
        const n3 = valueNoise2(cx * 640, cz * 640, 110, nSeed + 13);
        const n4 = valueNoise2(cx * 640, cz * 640, 38, nSeed + 14);
        const h1 = 22 + 60 * Math.pow(n1, 1.5) + 14 * n2;
        const h2 = 60 + 130 * Math.pow(n3, 1.4) + 24 * n4;
        const b1 = Math.exp(-(((r - 458) / 45) ** 2));
        const b2 = Math.exp(-(((r - 568) / 55) ** 2));
        // Below the far grid's edge the skirt tucks under it.
        const tuck = r < 404 ? (-2 * (404 - r)) / 44 : 0;
        const rise = smoothstep(404, 440, r);
        const e1 = h1 * b1 * rise, e2 = h2 * b2;
        return { extra: tuck + Math.max(e1, e2 * 0.98) + Math.min(e1, e2) * 0.15, layer: e2 > e1 ? 1 : 0, crest: e2 > e1 ? h2 : h1 };
      };
      const P: number[][] = [];
      for (let j = 0; j < radii.length; j++) {
        for (let i = 0; i <= segs; i++) {
          const a = (i / segs) * Math.PI * 2;
          const r = radii[j]!;
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          const rg = ridge(a, r);
          P.push([x, field.natural(x, z) + rg.extra, z, rg.extra, rg.layer, rg.crest]);
        }
      }
      const at = (i: number, j: number): number[] => P[j * (segs + 1) + i]!;
      const first = ranges.vertexCount;
      for (let j = 0; j < radii.length; j++) {
        for (let i = 0; i <= segs; i++) {
          const p = at(i, j);
          const pi = at(Math.min(segs, i + 1), j), mi = at(Math.max(0, i - 1), j);
          const pj = at(i, Math.min(radii.length - 1, j + 1)), mj = at(i, Math.max(0, j - 1));
          const du = [pi[0]! - mi[0]!, pi[1]! - mi[1]!, pi[2]! - mi[2]!];
          const dv = [pj[0]! - mj[0]!, pj[1]! - mj[1]!, pj[2]! - mj[2]!];
          let n = norm3([du[1]! * dv[2]! - du[2]! * dv[1]!, du[2]! * dv[0]! - du[0]! * dv[2]!, du[0]! * dv[1]! - du[1]! * dv[0]!]);
          if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
          const share = clamp(p[3]! / Math.max(1, p[5]!), 0, 1);
          // Forest at the foot, bare violet rock above, pale lit tops; the near ridge greener, the far one bluer.
          const base = p[4]! > 0.5 ? mixRgb(C.ridgeBlue, C.ridgeViolet, 0.4) : mixRgb(C.forest, C.ridgeViolet, 0.35);
          let col = mixRgb(base, C.ridgeTop, smoothstep(0.55, 1, share) * (p[4]! > 0.5 ? 0.7 : 0.4));
          col = scaleRgb(col, 0.9 + 0.2 * valueNoise2(p[0]!, p[2]!, 30, nSeed + 15));
          // Mist lies in the valleys: the low parts of each ridge fade to the haze colour.
          col = mixRgb(col, C.mist, (1 - smoothstep(0.05, 0.5, share)) * smoothstep(420, 500, radii[j]!) * 0.75);
          ranges.vertex([p[0]!, p[1]!, p[2]!], n, col, 1);
        }
      }
      const firstIdx = ranges.indexCount;
      for (let j = 0; j < radii.length - 1; j++) {
        for (let i = 0; i < segs; i++) {
          const a = first + j * (segs + 1) + i;
          const c = a + segs + 1;
          ranges.quad(a, a + 1, c + 1, c);
        }
      }
      orientToNormals(ranges, firstIdx);
    }

    // --- Mist banks: slow, large, faint puffs in the hollows of the hills and over the river's gorges --------------------
    const particles: ParticleSource[] = [];
    const mistSpots: [number, number][] = [];
    for (let k = 0; k < 40 && mistSpots.length < 7; k++) {
      const a = stream.range(0, Math.PI * 2, 300, k);
      const r = stream.range(150, 260, 301, k);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      // Hollows: lower than the surroundings.
      const y = heightAt(x, z);
      const around = (heightAt(x + 25, z) + heightAt(x - 25, z) + heightAt(x, z + 25) + heightAt(x, z - 25)) / 4;
      if (around - y < 1.5) continue;
      if (mistSpots.some(([px, pz]) => Math.hypot(px - x, pz - z) < 70)) continue;
      mistSpots.push([x, z]);
    }
    const riverEnds = [layout.river.dense[0]!, layout.river.dense[layout.river.dense.length - 1]!];
    for (const e of riverEnds) mistSpots.push([e.x, e.z]);
    for (const [x, z] of mistSpots) {
      particles.push({
        kind: 'steam', position: [x, heightAt(x, z) + 2.5, z], count: 6, life: 70, size: [26, 46], rise: 0.04, spread: [32, 0.35], wind: 0.12,
        colorStart: [0.95, 0.86, 0.9, 0.13], colorEnd: [0.95, 0.88, 0.94, 0],
      });
    }

    return {
      statics: [
        { material: 'solid', mesh: near, name: 'ground-core' },
        { material: 'solid', mesh: ring, name: 'ground-ring' },
        { material: 'solid', mesh: far, name: 'ground-far', castShadow: false },
        { material: 'solid', mesh: ranges, name: 'ranges', castShadow: false },
      ],
      particles,
      solids: mapEdge(),
      stats: { groundVertices: near.vertexCount + ring.vertexCount + far.vertexCount, mistBanks: mistSpots.length },
    };
  },
};

/** A small offset from a noise value, for ragged edges. */
function wobbleOf(n: number): number {
  return (n - 0.5) * 0.6;
}

/** Radius of the walkable land, metres: inside the terrain's detailed core (112 m), past the windmill. */
export const WALK_EDGE = 108;

/**
 * The edge of the map for the walk mode: a ring of invisible walls (64 segments at `WALK_EDGE`) that do not block
 * sight. Beyond it the hills climb and the far terrain loses detail.
 */
function mapEdge(): SolidDef[] {
  const out: SolidDef[] = [];
  const N = 64;
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2;
    // A little longer than the chord so the corners close.
    const r = WALK_EDGE + 0.5;
    const sd = segmentSolid('edge', Math.cos(a0 - 0.01) * r, Math.sin(a0 - 0.01) * r, Math.cos(a1 + 0.01) * r, Math.sin(a1 + 0.01) * r, 1, -50, 200, { standable: false, blocksSight: false });
    if (sd) out.push(sd);
  }
  return out;
}
