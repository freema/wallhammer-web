// Architecture kit of the village (owner: architecture): half-timbered walls, stone plinths, curved shingle roofs,
// windows, doors, chimneys, dormers, signs and banners, shared by every building. See README.md in this folder.
//
// `placeholderStructure` stays for the buildings that are not built yet: a plain block per footprint rectangle with
// a gable roof, standing on the structure's pad.

export * from './site.ts';
export * from './palette.ts';
export * from './stone.ts';
export * from './timber.ts';
export * from './walls.ts';
export * from './openings.ts';
export * from './roof.ts';
export * from './details.ts';
export * from './house.ts';

import { MAT, MeshBuilder, PALETTE, bevelBox, compose34 } from '../kit/index.ts';
import type { BuildContext, RGB } from '../kit/index.ts';
import type { LocalRect, Structure } from '../layout.ts';

/** Storey height used by the placeholder. */
export const STOREY = 3;

/** Roof colour of a structure's covering. */
export function roofColor(s: Structure): RGB {
  switch (s.roof) {
    case 'slate':
      return PALETTE.slate;
    case 'red':
      return PALETTE.roofRed;
    case 'rust':
      return PALETTE.roofRust;
    case 'thatch':
      return PALETTE.thatch;
    default:
      return PALETTE.stone;
  }
}

/** A gable roof over a local rectangle, ridge along local x, eaves overhanging by `over`. */
function gable(b: MeshBuilder, r: LocalRect, y: number, rise: number, over: number, color: RGB): void {
  const x0 = r.x - r.w / 2 - over, x1 = r.x + r.w / 2 + over;
  const z0 = r.z - r.d / 2 - over, z1 = r.z + r.d / 2 + over;
  const yr = y + rise;
  const e = y - over * 0.5;
  b.withFlags({ cls: MAT.roof }, () => {
    b.paint(color);
    // Front and back slopes (counter-clockwise from outside).
    b.face([[x0, e, z1], [x1, e, z1], [x1, yr, r.z], [x0, yr, r.z]]);
    b.face([[x1, e, z0], [x0, e, z0], [x0, yr, r.z], [x1, yr, r.z]]);
    // Undersides, so the overhang does not show through from below.
    b.face([[x0, yr - 0.08, r.z], [x1, yr - 0.08, r.z], [x1, e - 0.08, z1], [x0, e - 0.08, z1]]);
    b.face([[x1, yr - 0.08, r.z], [x0, yr - 0.08, r.z], [x0, e - 0.08, z0], [x1, e - 0.08, z0]]);
  });
  b.withFlags({ cls: MAT.plaster }, () => {
    b.paint(PALETTE.plaster);
    const g0 = r.z - r.d / 2, g1 = r.z + r.d / 2;
    // Gable ends.
    b.face([[r.x + r.w / 2, y, g1], [r.x + r.w / 2, y, g0], [r.x + r.w / 2, yr - 0.05, r.z]]);
    b.face([[r.x - r.w / 2, y, g0], [r.x - r.w / 2, y, g1], [r.x - r.w / 2, yr - 0.05, r.z]]);
  });
}

/**
 * Placeholder of a structure: plinth, walls and a gable roof for the body and each wing, in world coordinates on
 * the structure's pad. About 200 triangles; the real builders replace it.
 */
export function placeholderStructure(ctx: BuildContext, s: Structure, b = new MeshBuilder()): MeshBuilder {
  const y = ctx.field.padY(s.id);
  const m = compose34([s.x, y, s.z], s.yaw);
  b.with(m, () => {
    [s.body, ...s.wings].forEach((r, i) => {
      const floors = i === 0 ? s.stories : Math.max(1, s.stories - 1);
      const h = floors * STOREY;
      b.withFlags({ cls: MAT.stone }, () => bevelBox(b, [r.x, -0.6, r.z], [r.w + 0.3, 1.2, r.d + 0.3], PALETTE.stone, { bevel: 0.12 }));
      b.withFlags({ cls: MAT.plaster }, () => bevelBox(b, [r.x, 0.6, r.z], [r.w, h - 0.6, r.d], PALETTE.plaster, { bevel: 0.08, noBottom: true }));
      // Door marker on the front of the body (a darker slab), glowing window above it in the evening.
      if (i === 0) {
        const dx = s.kind === 'inn' ? -1.5 : 0;
        b.withFlags({ cls: MAT.wood }, () => bevelBox(b, [dx, 0.6, r.z + r.d / 2 + 0.02], [1.3, 2.2, 0.12], PALETTE.timberDark, { bevel: 0.03 }));
        b.withFlags({ cls: MAT.glass, glow: 1 }, () => bevelBox(b, [dx + 2.2, 1.6, r.z + r.d / 2 + 0.02], [0.9, 1.0, 0.1], PALETTE.windowGlow, { bevel: 0.02 }));
      }
      gable(b, r, 0.6 + h - 0.6, Math.min(r.d, 7) * 0.55, 0.5, roofColor(s));
    });
  });
  return b;
}
