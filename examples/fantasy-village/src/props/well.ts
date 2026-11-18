// The village well on the square (B3: layout.well): a ring of rough stone blocks in staggered courses with a coping,
// two thick posts carrying a windlass with a crank and wound rope, the bucket hanging from the rope, and a little
// gable roof of shingles in uneven rows. Built at the local origin (ground at y = 0).

import type { MeshBuilder, RGB, Stream, Vec3 } from '../kit/index.ts';
import { MAT, PALETTE, VARY_RICH, basis34, bevelBox, crookedBeam, lathe, mixRgb, norm3, scaleRgb, vary } from '../kit/index.ts';
import { PROP, facingFace, ironColor, rope, woodColor } from './common.ts';

const R_OUT = 1.0;
const R_IN = 0.7;
/** Top of the coping above the ground. */
const WALL_H = 0.78;
const AXLE_Y = 1.75;
const ROOF_EAVE = 2.25;
const ROOF_RIDGE = 2.9;

/** The well into `b` (local frame); its water surface goes into `water` through `world` (local to world). */
export function well(b: MeshBuilder, water: MeshBuilder, s: Stream, world: (p: Vec3) => Vec3): void {
  const stone = (k: number): RGB => vary(s.pick([PALETTE.stone, PALETTE.stoneWarm, PALETTE.stone, PALETTE.stoneDark], k, 1), VARY_RICH, s, k, 2);
  // Stone courses: wedge blocks around, every other course turned by half a block.
  const courses = [0.32, 0.3, 0.28];
  let y = -0.25;
  let k = 0;
  b.withFlags({ cls: MAT.stone }, () => {
    courses.forEach((h, c) => {
      const n = 9 + (c % 2);
      const ph = c * 0.37;
      for (let i = 0; i < n; i++) {
        const a = ph + (i / n) * Math.PI * 2;
        const span = (Math.PI * 2) / n;
        const rm = (R_OUT + R_IN) / 2;
        const w = 2 * rm * Math.sin(span / 2) - 0.04;
        // A frame per block: x along the ring, z outward.
        const out: Vec3 = [Math.cos(a), 0, Math.sin(a)];
        const tan: Vec3 = [Math.sin(a), 0, -Math.cos(a)];
        const centre: Vec3 = [out[0] * rm, y, out[2] * rm];
        b.with(basis34(tan, [0, 1, 0], out, centre), () => {
          bevelBox(b, [0, 0, 0], [w, h - 0.025, R_OUT - R_IN], stone(k), { bevel: 0.055, jitter: 0.03, stream: s.child(k), taper: [1, 1] });
        });
        k++;
      }
      y += h;
    });
    // Coping: flatter, wider stones.
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = 0.2 + (i / n) * Math.PI * 2;
      const rm = (R_OUT + R_IN) / 2 + 0.02;
      const w = 2 * rm * Math.sin(Math.PI / n) - 0.03;
      const out: Vec3 = [Math.cos(a), 0, Math.sin(a)];
      const tan: Vec3 = [Math.sin(a), 0, -Math.cos(a)];
      b.with(basis34(tan, [0, 1, 0], out, [out[0] * rm, y, out[2] * rm]), () => {
        bevelBox(b, [0, 0, 0], [w, 0.13, R_OUT - R_IN + 0.12], scaleRgb(stone(500 + i), 1.08), { bevel: 0.05, jitter: 0.02, stream: s.child(500 + i) });
      });
    }
  });
  // The dark shaft and the water, low inside the ring.
  const wp: Vec3[] = [];
  for (let i = 0; i < 12; i++) {
    // Counter-clockwise seen from above (x east, z south): angle decreasing in this convention.
    const a = -(i / 12) * Math.PI * 2;
    wp.push(world([Math.cos(a) * (R_IN - 0.02), 0.02, Math.sin(a) * (R_IN - 0.02)]));
  }
  water.face(wp, wp.map(() => [0.08, 0.2, 0.24]), wp.map(() => 0.92));
  // A dark bottom just under the surface (the shaft seen through the water).
  const dark: Vec3[] = [];
  for (let i = 0; i < 12; i++) {
    const a = -(i / 12) * Math.PI * 2;
    dark.push([Math.cos(a) * (R_IN + 0.02), -0.02, Math.sin(a) * (R_IN + 0.02)]);
  }
  b.withFlags({ cls: MAT.stone }, () => facingFace(b, dark, [0, 1, 0], scaleRgb(PALETTE.stoneDark, 0.3)));

  // Posts and the windlass.
  const wood = woodColor(s, 3);
  b.withFlags({ cls: MAT.wood }, () => {
    for (const sx of [-1, 1]) {
      crookedBeam(b, [sx * (R_OUT - 0.05), -0.3, 0], [sx * (R_OUT - 0.08), ROOF_EAVE + 0.15, 0], (p) => scaleRgb(wood, 0.7 + 0.35 * Math.min(1, Math.max(0, p[1] / ROOF_EAVE))), {
        width: 0.24, depth: 0.22, wobble: 0.03, twist: 0.2, stream: s.child(10 + sx), segments: 4,
      });
    }
    // Axle (a round log) between the posts, with the rope wound in the middle.
    const axle: Vec3[] = [[-(R_OUT + 0.1), AXLE_Y, 0], [R_OUT + 0.1, AXLE_Y, 0]];
    crookedBeam(b, axle[0]!, axle[1]!, scaleRgb(wood, 1.1), { width: 0.17, chamfer: 0.45, segments: 3, irregular: 0.05 });
    crookedBeam(b, [-0.28, AXLE_Y, 0], [0.28, AXLE_Y, 0], PROP.rope, { width: 0.24, chamfer: 0.5, segments: 4, irregular: 0.12, stream: s.child(20) });
  });
  // Crank on the east end.
  const iron = ironColor(s, 4);
  b.withFlags({ cls: MAT.metal }, () => {
    const x = R_OUT + 0.14;
    crookedBeam(b, [x, AXLE_Y, 0], [x + 0.06, AXLE_Y - 0.32, 0.04], iron, { width: 0.04, segments: 2 });
    crookedBeam(b, [x + 0.06, AXLE_Y - 0.32, 0.04], [x + 0.28, AXLE_Y - 0.33, 0.06], iron, { width: 0.04, segments: 2 });
  });
  b.withFlags({ cls: MAT.wood }, () => crookedBeam(b, [R_OUT + 0.3, AXLE_Y - 0.33, 0.06], [R_OUT + 0.48, AXLE_Y - 0.33, 0.06], PALETTE.timberLight, { width: 0.06, segments: 2 }));
  // Rope down to the bucket, hanging just above the coping.
  const bucketY = WALL_H + 0.17;
  b.withFlags({ cls: MAT.fabric }, () => rope(b, [[0.05, AXLE_Y - 0.11, 0.07], [0.04, (AXLE_Y + bucketY + 0.46) / 2, 0.04], [0.03, bucketY + 0.45, 0.02]], 0.018, PROP.rope, 4));
  bucket(b, s.child('bucket'), [0.03, bucketY, 0.02]);
  roof(b, s.child('roof'));
}

/** A small coopered bucket with two hoops and an iron handle, bottom at `at`. */
export function bucket(b: MeshBuilder, s: Stream, at: Vec3): void {
  const h = 0.3, r0 = 0.15, r1 = 0.19;
  const staves = 10;
  const shades: RGB[] = [];
  for (let k = 0; k < staves; k++) shades.push(vary(PALETTE.plank, VARY_RICH, s, k));
  b.withFlags({ cls: MAT.wood }, () => {
    lathe(b, at, [[r0, 0], [(r0 + r1) / 2, h / 2], [r1, h]], (_p, n) => {
      const a = Math.atan2(-n[2], n[0]);
      const k = ((Math.floor((a / (Math.PI * 2)) * staves) % staves) + staves) % staves;
      return shades[k]!;
    }, { segments: staves, faceted: true, capBottom: true });
    // Water inside, near the rim.
    lathe(b, [at[0], at[1] + h - 0.04, at[2]], [[r1 - 0.01, 0], [0.0001, 0.005]], PROP.waterDeep, { segments: staves });
  });
  const iron = ironColor(s, 1);
  b.withFlags({ cls: MAT.metal }, () => {
    for (const f of [0.2, 0.8]) {
      const r = r0 + (r1 - r0) * f + 0.008;
      lathe(b, [at[0], at[1] + h * f - 0.02, at[2]], [[r - 0.008, 0], [r, 0.006], [r, 0.034], [r - 0.008, 0.04]], iron, { segments: staves, faceted: true });
    }
    const arc: Vec3[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * Math.PI;
      arc.push([at[0] + Math.cos(a) * r1, at[1] + h + Math.sin(a) * 0.16, at[2]]);
    }
    for (let i = 0; i < arc.length - 1; i++) crookedBeam(b, arc[i]!, arc[i + 1]!, iron, { width: 0.018, segments: 1, irregular: 0 });
  });
}

/** Gable roof along x: rafters, a ridge beam and uneven rows of shingles on both slopes. */
function roof(b: MeshBuilder, s: Stream): void {
  const half = 1.35;
  const run = 1.15;
  const wood = woodColor(s, 1);
  b.withFlags({ cls: MAT.wood }, () => {
    crookedBeam(b, [-half - 0.15, ROOF_RIDGE, 0], [half + 0.15, ROOF_RIDGE, 0], scaleRgb(wood, 0.85), { width: 0.18, depth: 0.2, sag: 0.04, stream: s.child(1), segments: 4 });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        crookedBeam(b, [sx * (R_OUT - 0.08), ROOF_RIDGE - 0.05, 0], [sx * (R_OUT - 0.08), ROOF_EAVE - 0.08, sz * (run + 0.1)], scaleRgb(wood, 0.8), { width: 0.12, depth: 0.14, stream: s.child(2 + sx + sz * 3), segments: 3 });
      }
      // Tie beam across under the rafters.
      crookedBeam(b, [sx * (R_OUT - 0.08), ROOF_EAVE + 0.05, -run * 0.75], [sx * (R_OUT - 0.08), ROOF_EAVE + 0.05, run * 0.75], scaleRgb(wood, 0.9), { width: 0.12, segments: 3 });
    }
  });
  // Shingles: in a frame per slope (x along the ridge, y the roof normal, z down the slope).
  const red = s.pick([PALETTE.roofRed, PALETTE.roofRust], 1);
  for (const sz of [-1, 1]) {
    const down = norm3([0, ROOF_EAVE - ROOF_RIDGE, sz * run]);
    const nrm = norm3([0, run, sz * (ROOF_RIDGE - ROOF_EAVE)]);
    const L = Math.hypot(ROOF_RIDGE - ROOF_EAVE, run) + 0.25;
    const xAxis: Vec3 = [sz, 0, 0];
    b.withFlags({ cls: MAT.roof }, () => {
      b.with(basis34(xAxis, nrm, down, [0, ROOF_RIDGE + 0.1, 0]), () => {
        const rows = 4;
        for (let r = 0; r < rows; r++) {
          const z0 = (L * r) / rows;
          const sw = 0.36;
          const n = Math.ceil((2 * half + 0.4) / sw);
          const sag = 0.035 * Math.sin((Math.PI * (r + 0.5)) / rows);
          for (let i = 0; i < n; i++) {
            const x = -half - 0.2 + sw * (i + 0.5) + (r % 2 ? sw / 2 : 0);
            if (x > half + 0.25) continue;
            const len = L / rows + 0.14 + s.jitter(0.05, sz, r, i, 3);
            const c = mixRgb(vary(red, VARY_RICH, s, sz, r, i, 4), PALETTE.roofMoss, s.chance(0.12, sz, r, i, 5) ? 0.4 : 0);
            const edge = Math.abs(x) / half;
            bevelBox(b, [x, -sag * (1 - edge * edge) + (rows - r) * 0.014, z0 + len / 2 - 0.02], [sw - 0.02, 0.045, len], (p) => scaleRgb(c, 0.8 + 0.3 * (1 - (p[2] - z0) / len)), {
              bevel: 0.015, anchor: 'center', jitter: 0.012, stream: s.child(sz * 1000 + r * 50 + i),
            });
          }
        }
      });
    });
  }
}
