// Lantern posts (B2: lanterns on wooden posts with an arm): a thick crooked post in a collar of stones, an arm with a
// diagonal brace reaching over the street, an iron hook and a short chain, and a lantern of iron frame and cap. The
// glass is not in the static mesh: it is one instanced part per lantern (`lanternGlassMesh`), so the module can let it
// flicker in the evening by writing the instance glow each frame.

import type { MeshBuilder, Stream } from '../kit/index.ts';
import { GLOW, MAT, MeshBuilder as Builder, PALETTE, bevelBox, crookedBeam, lathe, rock, scaleRgb, vary, VARY_SUBTLE } from '../kit/index.ts';
import { ironColor, woodColor } from './common.ts';

/** Height of the lantern's glass centre above the foot of the post, and its reach along the arm. */
export const LANTERN_GLASS_Y = 2.42;
export const LANTERN_REACH = 0.92;

/** Height of the post above its foot. */
const POST_H = 3.3;

/**
 * One lantern post at the local origin, its arm toward +z, everything but the glass. `k` keys the variation.
 */
export function lanternPost(b: MeshBuilder, s: Stream, k: number): void {
  const wood = woodColor(s, k, 1);
  const dark = scaleRgb(wood, 0.75);
  b.withFlags({ cls: MAT.wood, glow: 0 }, () => {
    crookedBeam(b, [0, -0.4, 0], [s.jitter(0.06, k, 2), POST_H, s.jitter(0.04, k, 3)], (p) => scaleRgb(wood, 0.68 + 0.4 * Math.min(1, Math.max(0, p[1] / POST_H))), {
      width: s.range(0.24, 0.3, k, 4), wobble: 0.04, twist: 0.3, irregular: 0.12, stream: s.child(k * 10 + 1), segments: 4,
    });
    // A cap on the post top.
    bevelBox(b, [0, POST_H - 0.02, 0], [0.36, 0.1, 0.36], scaleRgb(wood, 0.9), { bevel: 0.035, taper: 0.75 });
    // Arm and brace.
    crookedBeam(b, [0, POST_H - 0.28, -0.22], [0, POST_H - 0.3, LANTERN_REACH + 0.18], dark, { width: 0.17, depth: 0.2, sag: 0.03, stream: s.child(k * 10 + 2), segments: 3 });
    crookedBeam(b, [0, POST_H - 1.0, 0.06], [0, POST_H - 0.38, 0.62], dark, { width: 0.12, depth: 0.12, stream: s.child(k * 10 + 3), segments: 2 });
  });
  // Stones round the foot.
  b.withFlags({ cls: MAT.stone }, () => {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + s.range(0, 1, k, 5);
      const r = 0.3;
      rock(b, [Math.cos(a) * r, -0.12, Math.sin(a) * r], [s.range(0.26, 0.36, k, i, 6), s.range(0.2, 0.3, k, i, 7), s.range(0.24, 0.34, k, i, 8)], vary(PALETTE.stone, VARY_SUBTLE, s, k, i, 9), { stream: s.child(k * 100 + i), detail: 2, cuts: 5 });
    }
  });
  // Hook, chain and the lantern's iron.
  const iron = ironColor(s, k, 10);
  const cz = LANTERN_REACH, cy = LANTERN_GLASS_Y;
  b.withFlags({ cls: MAT.metal }, () => {
    bevelBox(b, [0, POST_H - 0.42, cz], [0.05, 0.05, 0.05], iron, { bevel: 0.01 });
    for (let i = 0; i < 3; i++) bevelBox(b, [0, cy + 0.33 + i * 0.08, cz], [i % 2 ? 0.02 : 0.05, 0.07, i % 2 ? 0.05 : 0.02], iron, { bevel: 0.006 });
    // Base plate with a drip pan.
    bevelBox(b, [0, cy - 0.27, cz], [0.32, 0.06, 0.32], iron, { bevel: 0.015 });
    lathe(b, [0, cy - 0.33, cz], [[0.0001, 0], [0.06, 0.0], [0.12, 0.06]], scaleRgb(iron, 0.85), { segments: 8, faceted: true });
    // Corner bars.
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) bevelBox(b, [sx * 0.15, cy - 0.22, cz + sz * 0.15], [0.035, 0.42, 0.035], iron, { bevel: 0.008 });
    // Cap: a flared pyramid with a ring on top.
    bevelBox(b, [0, cy + 0.19, cz], [0.42, 0.06, 0.42], iron, { bevel: 0.015 });
    bevelBox(b, [0, cy + 0.24, cz], [0.36, 0.12, 0.36], scaleRgb(iron, 1.15), { bevel: 0.02, taper: 0.3 });
    lathe(b, [0, cy + 0.34, cz], [[0.04, 0], [0.05, 0.02], [0.04, 0.05], [0.0001, 0.06]], PALETTE.ironLight, { segments: 6 });
  });
}

/**
 * The glass of one lantern, at the local origin (its centre): a warm box, lighter toward the top.
 * Drawn as an instanced part; the instance glow (evening channel) makes it shine.
 */
export function lanternGlassMesh(): MeshBuilder {
  const b = new Builder();
  b.withFlags({ cls: MAT.glass, glow: 0.55, channel: GLOW.evening }, () => {
    bevelBox(b, [0, -0.2, 0], [0.27, 0.4, 0.27], (p) => scaleRgb(PALETTE.windowGlow, 0.9 + 0.25 * (p[1] + 0.2) / 0.4), { bevel: 0.02, edgeLight: 1.05 });
  });
  return b;
}
