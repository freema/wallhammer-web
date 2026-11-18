// Effects (owner: props and effects): the forge fire (flames, hot core, sparks, embers, smoke from the flue and a
// dancing light), chimney smoke, steam at the weir, and the evening effects (fireflies, lantern dust, river mist).
//
// Chimney smoke: buildings own their chimneys and add `chimneySmoke(top)` (src/fx/smoke.ts) to their own particles.
// FALLBACK_CHIMNEYS (off) would emit a stand-in above the inn and cottage roofs for buildings without chimneys.
// The forge smoke leaves from the mouth of the forge building's chimney (`forgeChimneyTop`), which encloses the
// smithy's flue.

import type { ContentModule, FrameInfo, ParticleSource, PointLight } from '../kit/index.ts';
import { toWorld } from '../layout.ts';
import { forgeChimneyTop } from '../buildings/forge.ts';
import { forgeAnchors } from '../props/smithy.ts';
import { forgeFire, swayFireLight } from './fire.ts';
import type { ForgeFire } from './fire.ts';
import { nightEffects } from './night.ts';
import { chimneySmoke } from './smoke.ts';

export { chimneySmoke } from './smoke.ts';
export type { SmokeOptions } from './smoke.ts';

/** Emit stand-in chimney smoke for the inn and cottages. Off: every building emits its own chimney smoke. */
export const FALLBACK_CHIMNEYS: boolean = false;

export const fx: ContentModule = {
  name: 'fx',
  build(ctx) {
    const { layout, field } = ctx;
    const particles: ParticleSource[] = [];
    const lights: PointLight[] = [];
    if (FALLBACK_CHIMNEYS) {
      for (const s of layout.structures) {
        if (s.kind !== 'inn' && s.kind !== 'cottage') continue;
        const [x, z] = toWorld(s, s.body.x + s.body.w * 0.3, s.body.z);
        const y = field.padY(s.id) + s.stories * 3 + Math.min(s.body.d, 7) * 0.55 + 0.8;
        particles.push(...chimneySmoke([x, y, z], { strength: s.kind === 'inn' ? 1.3 : 1 }));
      }
    }
    let fire: ForgeFire | undefined;
    const forge = layout.structures.find((s) => s.kind === 'forge');
    if (forge) {
      const a = forgeAnchors(ctx, forge);
      fire = forgeFire(a.fire, forgeChimneyTop(ctx, forge), a.light);
      particles.push(...fire.particles);
      lights.push(fire.light);
    }
    const w = layout.weir;
    particles.push({ kind: 'steam', position: [w.x, w.bottom + 0.2, w.z], count: 30, life: 3, size: [0.8, 2.4], rise: 0.35, spread: [w.width / 2, 0.2], wind: 0.6, colorStart: [0.9, 0.92, 0.95, 0.22], colorEnd: [0.9, 0.92, 0.95, 0] });
    particles.push(...nightEffects(ctx));
    let total = 0;
    for (const p of particles) total += p.count;
    const update = fire
      ? (f: FrameInfo): void => {
          swayFireLight(fire!, f.time);
        }
      : undefined;
    return { particles, lights, update, stats: { emitters: particles.length, particles: total } };
  },
};
