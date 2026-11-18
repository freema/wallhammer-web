// Evening effects: fireflies over the gardens and the river banks, motes of dust glinting in the lantern light, and a
// low mist creeping along the river at dusk. All are 'evening' emitters: invisible in the afternoon.

import type { BuildContext, ParticleSource, Vec3 } from '../kit/index.ts';
import { LANTERN_GLASS_Y, LANTERN_REACH } from '../props/lantern.ts';

/** Fireflies: a slow cloud of tiny yellow-green lights hovering low. */
function fireflies(at: Vec3, r: number, n: number): ParticleSource {
  return { kind: 'spark', position: at, count: n, life: 4.5, size: [0.07, 0.05], rise: 0.12, spread: [r, 0.22], gravity: 0.04, wind: 0.15, when: 'evening', colorStart: [1.3, 1.6, 0.45, 1], colorEnd: [0.9, 1.3, 0.3, 0] };
}

export function nightEffects(ctx: BuildContext): ParticleSource[] {
  const { layout, heightAt } = ctx;
  const out: ParticleSource[] = [];
  // Over each garden.
  for (const g of layout.gardens) out.push(fireflies([g.x, heightAt(g.x, g.z) + 0.7, g.z], Math.max(g.w, g.d) * 0.5, 12));
  // Along the river banks: every few river points, alternating banks.
  const pts = layout.river.dense;
  const step = Math.max(1, Math.floor(pts.length / 8));
  for (let i = step >> 1, k = 0; i < pts.length; i += step, k++) {
    const p = pts[i]!, q = pts[Math.min(pts.length - 1, i + 1)]!;
    const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1;
    const side = k % 2 ? 1 : -1;
    const off = (p.width / 2 + 1.2) * side;
    const x = p.x - (dz / l) * off, z = p.z + (dx / l) * off;
    out.push(fireflies([x, heightAt(x, z) + 0.8, z], 2.6, 14));
    // Mist on the water at dusk.
    out.push({ kind: 'steam', position: [p.x, p.y + 0.2, p.z], count: 14, life: 9, size: [1.8, 4.5], rise: 0.04, spread: [p.width * 0.4, 0.12], wind: 0.5, when: 'evening', colorStart: [0.78, 0.8, 0.88, 0.12], colorEnd: [0.78, 0.8, 0.88, 0] });
  }
  // Dust motes in the lantern light.
  for (const l of layout.lanterns) {
    const x = l.x + Math.sin(l.yaw) * LANTERN_REACH, z = l.z + Math.cos(l.yaw) * LANTERN_REACH;
    out.push({ kind: 'spark', position: [x, heightAt(l.x, l.z) + LANTERN_GLASS_Y - 0.35, z], count: 5, life: 7, size: [0.022, 0.018], rise: 0.05, spread: [0.45, 0.06], wind: 0.25, when: 'evening', colorStart: [1.2, 0.85, 0.5, 0.7], colorEnd: [1.0, 0.7, 0.4, 0] });
  }
  return out;
}
