// The four part meshes every villager and animal is assembled from (one instanced set each, B4):
//   head     a stylised head: skull, cheeks and jaw, a big nose, ears, brow, eyes and mouth (skin, tinted per person)
//   blob     a lumpy ellipsoid of radius 1 (hair masses, beards, hands, boot toes, bellies, hats, shields, bodies of
//            the chickens, apples)
//   segment  a tapered, rounded limb along +y from 0 to 1 with soft cloth folds, radius 0.72 at y = 0 and 1 at y = 1
//            (torsos, limbs, necks, tool shafts; turned upside down it is a skirt, an apron or a cloak)
//   block    a unit bevelled block centred on the origin (hammer heads, blades, soles, buckles, sparks)
// The vertex colours are near white with painted shading (darker underneath, darker in the folds), so the per-instance
// tint gives each part its colour. Every mesh is closed and faces outward.

import { MAT, MeshBuilder, bevelBox } from '../kit/index.ts';
import type { Vec3 } from '../kit/index.ts';

type Pos = (u: number, v: number) => Vec3;
type Col = (u: number, v: number, p: Vec3) => readonly [number, number, number, number];

/**
 * A closed surface from a function of (u around 0–1, v bottom to top 0–1), written as a grid with normals from the
 * function itself. Positions go around as x = cos, z = −sin (as in the kit's lathe), which makes d/du × d/dv point out.
 */
function surface(b: MeshBuilder, cols: number, rows: number, pos: Pos, col: Col): void {
  const first = b.vertexCount;
  const e = 1e-3;
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      const p = pos(u, v);
      const vn = Math.min(1 - 2 * e, Math.max(2 * e, v));
      const pu0 = pos(u - e, vn), pu1 = pos(u + e, vn), pv0 = pos(u, vn - e), pv1 = pos(u, vn + e);
      const du = [pu1[0] - pu0[0], pu1[1] - pu0[1], pu1[2] - pu0[2]];
      const dv = [pv1[0] - pv0[0], pv1[1] - pv0[1], pv1[2] - pv0[2]];
      let n: Vec3 = [du[1]! * dv[2]! - du[2]! * dv[1]!, du[2]! * dv[0]! - du[0]! * dv[2]!, du[0]! * dv[1]! - du[1]! * dv[0]!];
      if (Math.hypot(n[0], n[1], n[2]) < 1e-9) n = [0, v < 0.5 ? -1 : 1, 0];
      const c = col(u, v, p);
      b.vertex(p, n, [c[0], c[1], c[2]], c[3]);
    }
  }
  const w = cols + 1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = first + j * w + i;
      const bb = a + 1, c = a + 1 + w, d = a + w;
      // Skip the fully collapsed triangles at the poles.
      if (j === 0) b.tri(a, c, d);
      else if (j === rows - 1) b.tri(a, bb, c);
      else b.quad(a, bb, c, d);
    }
  }
}

/** An ellipsoid with a gentle lumpy outline and a shading that darkens underneath. */
function ellipsoid(b: MeshBuilder, c: readonly number[], r: readonly number[], cols: number, rows: number, tone: readonly number[], o: { lump?: number; seed?: number; shade?: number; pitch?: number } = {}): void {
  const lump = o.lump ?? 0;
  const k = o.seed ?? 0;
  const shade = o.shade ?? 0.25;
  const cp = Math.cos(o.pitch ?? 0), sp = Math.sin(o.pitch ?? 0);
  surface(b, cols, rows, (u, v) => {
    const a = u * Math.PI * 2, t = v * Math.PI;
    const f = 1 + lump * (Math.sin(3 * a + 1.3 + k) * Math.sin(2 * t) * 0.6 + Math.cos(5 * a + 2 * t + k * 2.1) * 0.4 * Math.sin(t));
    const x = Math.sin(t) * Math.cos(a) * r[0]! * f;
    const y0 = -Math.cos(t) * r[1]! * f;
    const z0 = -Math.sin(t) * Math.sin(a) * r[2]! * f;
    // Optional tilt about x (positive tips +y toward +z).
    const y = y0 * cp - z0 * sp, z = y0 * sp + z0 * cp;
    return [c[0]! + x, c[1]! + y, c[2]! + z];
  }, (_u, v) => {
    const g = 1 - shade * (1 - v) * (1 - v);
    return [tone[0]! * g, tone[1]! * g, tone[2]! * g, 0.7 + 0.3 * v];
  });
}

/** The head (height 1, origin at the bottom of the jaw line where the neck meets it, facing +z). */
export function headMesh(): MeshBuilder {
  const b = new MeshBuilder();
  b.withFlags({ cls: MAT.skin }, () => {
    // Skull: an egg, fuller at the top and the back.
    surface(b, 14, 10, (u, v) => {
      const a = u * Math.PI * 2, t = v * Math.PI;
      const back = -Math.sin(t) * Math.sin(a) < 0 ? 1.08 : 1;
      const x = Math.sin(t) * Math.cos(a) * 0.37;
      const y = 0.56 - Math.cos(t) * 0.42 * (v > 0.5 ? 1.02 : 0.95);
      const z = -Math.sin(t) * Math.sin(a) * 0.38 * back - 0.03;
      return [x, y, z];
    }, (u, v) => {
      // Rosy cheeks low on the front sides, slightly darker under the chin.
      const a = u * Math.PI * 2;
      const front = Math.max(0, -Math.sin(a));
      const cheek = front * Math.max(0, Math.abs(Math.cos(a)) - 0.3) * Math.max(0, 1 - Math.abs(v - 0.4) * 4);
      const g = 0.86 + 0.14 * Math.min(1, v * 2);
      return [g, g * (1 - 0.25 * cheek), g * (1 - 0.28 * cheek), 0.8 + 0.2 * v];
    });
    // Jaw and cheeks: a wide rounded mass at the front bottom.
    ellipsoid(b, [0, 0.33, 0.07], [0.32, 0.27, 0.32], 12, 8, [0.97, 0.9, 0.88], { shade: 0.3 });
    // The big nose, drooping a little.
    ellipsoid(b, [0, 0.42, 0.38], [0.075, 0.12, 0.1], 8, 6, [1, 0.86, 0.82], { pitch: 0.35, shade: 0.15 });
    // Ears.
    for (const s of [-1, 1]) ellipsoid(b, [s * 0.36, 0.5, -0.02], [0.06, 0.12, 0.085], 8, 6, [0.98, 0.84, 0.8], { shade: 0.2 });
    // Brow ridge.
    ellipsoid(b, [0, 0.62, 0.29], [0.26, 0.055, 0.08], 10, 5, [0.94, 0.94, 0.94], { shade: 0.3 });
  });
  b.withFlags({ cls: MAT.generic }, () => {
    // Eyes: dark beads under the brow (the tint barely lightens them).
    for (const s of [-1, 1]) ellipsoid(b, [s * 0.13, 0.535, 0.32], [0.05, 0.055, 0.04], 6, 5, [0.09, 0.07, 0.07], { shade: 0 });
    // Mouth: a dark red line.
    ellipsoid(b, [0, 0.27, 0.37], [0.09, 0.022, 0.03], 6, 4, [0.45, 0.16, 0.14], { shade: 0 });
  });
  return b;
}

/** A lumpy ellipsoid of radius 1 centred on the origin. */
export function blobMesh(): MeshBuilder {
  const b = new MeshBuilder();
  b.withFlags({ cls: MAT.fabric }, () => ellipsoid(b, [0, 0, 0], [1, 1, 1], 10, 7, [1, 1, 1], { lump: 0.06, seed: 0.7, shade: 0.3 }));
  return b;
}

/** Radius of the limb segment along its unit length y (rounded ends below 0 and above 1). */
function segmentRadius(y: number): number {
  if (y < 0) return 0.72 * Math.sqrt(Math.max(0, 1 - (y / 0.1) ** 2));
  if (y > 1) return Math.sqrt(Math.max(0, 1 - ((y - 1) / 0.1) ** 2));
  return 0.72 + 0.28 * (1 - (1 - y) * (1 - y));
}

/** Ring heights of the segment, denser at the rounded ends. */
const SEGMENT_RINGS = [-0.1, -0.07, -0.02, 0.2, 0.5, 0.8, 0.97, 1.05, 1.1];

/** The tapered limb (unit length along +y, radius 1 at the top). */
export function segmentMesh(): MeshBuilder {
  const b = new MeshBuilder();
  const rows = SEGMENT_RINGS.length - 1;
  const yAt = (v: number): number => {
    const f = Math.max(0, Math.min(rows, v * rows));
    const j = Math.min(rows - 1, Math.floor(f));
    const t = f - j;
    return SEGMENT_RINGS[j]! + (SEGMENT_RINGS[j + 1]! - SEGMENT_RINGS[j]!) * t;
  };
  b.withFlags({ cls: MAT.fabric }, () => surface(b, 10, rows, (u, v) => {
    const a = u * Math.PI * 2;
    const y = yAt(v);
    // Soft cloth folds: a few lengthwise ridges that wander.
    const fold = 1 + 0.03 * Math.sin(6 * a + 5 * y) * Math.min(1, Math.max(0, y) * 4) * Math.min(1, Math.max(0, 1 - y) * 6);
    const r = segmentRadius(y) * fold;
    return [r * Math.cos(a), y, -r * Math.sin(a)];
  }, (u, v) => {
    const a = u * Math.PI * 2;
    const y = yAt(v);
    const fold = 0.5 + 0.5 * Math.sin(6 * a + 5 * y);
    const g = (0.8 + 0.2 * Math.max(0, Math.min(1, y))) * (0.94 + 0.06 * fold);
    return [g, g, g, 0.78 + 0.22 * Math.max(0, Math.min(1, y))];
  }));
  return b;
}

/** A unit bevelled block centred on the origin. */
export function blockMesh(): MeshBuilder {
  const b = new MeshBuilder();
  b.withFlags({ cls: MAT.metal }, () => bevelBox(b, [0, 0, 0], [1, 1, 1], [0.95, 0.95, 0.95], { bevel: 0.14, anchor: 'center', edgeLight: 1.15 }));
  return b;
}
