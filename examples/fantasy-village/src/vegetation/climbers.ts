// Ivy on chosen corners of the houses and moss cushions on stones: the green that creeps up the walls in the
// concept. A corner of ivy is a column of flattened leaf clusters rising from the ground at a building corner (where
// the corner posts are, not over windows), spreading a little along both walls near the top.

import type { Stream, Vec3 } from '../kit/index.ts';
import { MAT, MeshBuilder, add3, norm3, pointInRing, scale3 } from '../kit/index.ts';
import type { Structure } from '../layout.ts';
import { IVY, leafCluster } from './foliage.ts';

/**
 * Ivy at corner `k` of a footprint ring (flat x, z pairs), from the ground up to `height` above `groundY`. Clusters
 * stand `out` metres outside the wall line so they cover a stone plinth too.
 */
export function cornerIvy(b: MeshBuilder, ring: readonly number[], k: number, groundY: number, height: number, s: Stream, out = 0.42): void {
  const n = ring.length / 2;
  const cx = ring[k * 2]!, cz = ring[k * 2 + 1]!;
  const px = ring[((k - 1 + n) % n) * 2]!, pz = ring[((k - 1 + n) % n) * 2 + 1]!;
  const nx = ring[((k + 1) % n) * 2]!, nz = ring[((k + 1) % n) * 2 + 1]!;
  const e1 = norm3([px - cx, 0, pz - cz]);
  const e2 = norm3([nx - cx, 0, nz - cz]);
  const bis = norm3([-(e1[0] + e2[0]), 0, -(e1[2] + e2[2])]);
  // Outward normal of the wall along an edge direction: the side that is outside the ring.
  const wallOut = (e: Vec3): Vec3 => {
    const a: Vec3 = [-e[2], 0, e[0]];
    const tx = cx + e[0] * 0.8 + a[0] * 0.3, tz = cz + e[2] * 0.8 + a[2] * 0.3;
    return pointInRing(ring, tx, tz) ? scale3(a, -1) : a;
  };
  const o1 = wallOut(e1), o2 = wallOut(e2);
  b.set({ cls: MAT.foliage });
  const corner: Vec3 = [cx, groundY, cz];
  const steps = Math.max(3, Math.round(height / 0.45));
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const y = groundY + 0.25 + t * height;
    const c = add3(add3(corner, scale3(bis, out + s.nextJitter(0.08))), [0, y - groundY, 0]);
    const r = s.nextRange(0.38, 0.55) * (1 - 0.3 * t);
    leafCluster(b, c, [r, r * 1.1, r], IVY, s, { shade: 0.9 + 0.15 * t, underLeaves: 0.5 });
  }
  // Spread along both walls, lower and thinner away from the corner.
  for (const [e, o] of [[e1, o1], [e2, o2]] as const) {
    const reach = s.nextRange(0.8, 2.2);
    const m = Math.max(1, Math.round(reach / 0.55));
    for (let i = 1; i <= m; i++) {
      const d = (i / m) * reach;
      const top = height * (1 - 0.55 * (i / m)) * s.nextRange(0.7, 1);
      const c = add3(add3(corner, add3(scale3(e, d), scale3(o, out * 0.85))), [0, 0.3 + top * s.nextRange(0.3, 0.9), 0]);
      const r = s.nextRange(0.3, 0.45);
      leafCluster(b, c, [r, r, r], IVY, s, { shade: 0.95, underLeaves: 0.5 });
      if (s.next() < 0.6) {
        const c2: Vec3 = [c[0], groundY + 0.25 + (c[1] - groundY) * 0.4, c[2]];
        leafCluster(b, c2, [r * 0.9, r, r * 0.9], IVY, s, { shade: 0.85, underLeaves: 0.5 });
      }
    }
  }
  b.set({ cls: MAT.generic });
}

/** Which corners of which buildings get ivy: deterministic from the stream, away from doors and water. */
export function ivyCorners(structures: readonly Structure[], s: Stream, bad: (x: number, z: number) => boolean): { s: Structure; ring: number[]; k: number }[] {
  const out: { s: Structure; ring: number[]; k: number }[] = [];
  const want: Record<string, number> = { inn: 2, mill: 1, 'cottage-0': 1, 'cottage-1': 2, 'cottage-3': 1, 'cottage-4': 1, 'cottage-5': 1 };
  structures.forEach((st, si) => {
    const n = want[st.id];
    if (!n) return;
    const ring = st.footprints[0]!;
    const m = ring.length / 2;
    const corners: number[] = [];
    for (let k = 0; k < m; k++) {
      const x = ring[k * 2]!, z = ring[k * 2 + 1]!;
      if (Math.hypot(x - st.door.x, z - st.door.z) < 3.2) continue;
      // Probe outside the corner along the bisector: it must be dry open ground, not another wing.
      const px = ring[((k - 1 + m) % m) * 2]!, pz = ring[((k - 1 + m) % m) * 2 + 1]!;
      const nx = ring[((k + 1) % m) * 2]!, nz = ring[((k + 1) % m) * 2 + 1]!;
      const bis = norm3([2 * x - px - nx, 0, 2 * z - pz - nz]);
      if (bad(x + bis[0] * 0.7, z + bis[2] * 0.7)) continue;
      corners.push(k);
    }
    // Shuffle by the stream, keep n.
    corners.sort((a, b) => s.float(si, a, 1) - s.float(si, b, 1));
    for (const k of corners.slice(0, n)) out.push({ s: st, ring, k });
  });
  return out;
}
