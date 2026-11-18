// An equipment crate: an off-white body, a lid a little wider than the body, orange latches on the front, a dark
// handle on each side and dark corner guards at the foot. Built at the local origin, front toward +z.

import type { MeshBuilder } from '../kit/mesh.ts';
import { place } from '../kit/math.ts';
import type { V3 } from '../kit/math.ts';
import { box } from '../kit/shapes.ts';
import { rgb } from '../style/palette.ts';

export function crate(b: MeshBuilder, size: V3): void {
  const [w, h, d] = size;
  const lid = Math.min(0.22, h * 0.22);
  b.paint(rgb('shell'));
  box(b, [w, h - lid, d]);
  b.paint(rgb('shellPanel'));
  b.with(place(0, h - lid, 0), () => box(b, [w + 0.05, lid, d + 0.05]));
  // Latches on the front, handles on the sides.
  b.paint(rgb('orange'));
  for (const x of [-w * 0.3, w * 0.3]) b.with(place(x, h - lid - 0.22, d / 2), () => box(b, [0.12, 0.2, 0.05]));
  b.paint(rgb('metal'));
  for (const s of [-1, 1]) b.with(place((s * (w + 0.03)) / 2, h * 0.52, 0, Math.PI / 2), () => box(b, [d * 0.4, 0.06, 0.04]));
  // Corner guards at the foot.
  b.paint(rgb('metalMid'));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.with(place((sx * (w - 0.1)) / 2, 0, (sz * (d - 0.1)) / 2), () => box(b, [0.14, 0.12, 0.14]));
}
