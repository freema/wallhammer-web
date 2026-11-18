// Which cells a baked area needs: the streaming manager is run headless (no GPU, no clock) for viewers standing on a
// grid of points around the centre, every request is answered at once, and the union of what was requested is kept.
// The same manager the browser runs decides it, so the baked area is exactly what those viewers will ask for.

import { DEFAULT_STREAMING, StreamingManager } from 'wallhammer-web/world';
import type { StreamingConfig, Ticket } from 'wallhammer-web/world';
import type { CellId } from 'wallhammer-web/gen-core';
import { cellKey, compareCells } from 'wallhammer-web/gen-core';
import { FACE, LEAF_LEVEL, ROOT_LEVEL, SHAPE, SMOOTH_SELECTION, SMOOTH_STREAMING } from '../src/terrain.ts';

/** The manager's settings for a bake. `smooth`: those of smooth levels of detail (lod=smooth in the example). */
export function bakeConfig(smooth = false): StreamingConfig {
  const base: StreamingConfig = { ...DEFAULT_STREAMING, shape: SHAPE, face: FACE, rootLevel: ROOT_LEVEL, leafLevel: LEAF_LEVEL, memoryBudgetBytes: Number.MAX_SAFE_INTEGER, maxInFlight: 1 << 20 };
  return smooth ? { ...base, ...SMOOTH_STREAMING, screenError: { ...SMOOTH_SELECTION } } : base;
}

/**
 * Cells requested by viewers at `altitude` on a (2·steps+1)² grid of points `spacing` apart around (cx, cz). With
 * `errorOf` the plan is the one of smooth levels of detail: the manager selects by screen-space error (for the
 * reference view of `SMOOTH_SELECTION`) and is told the error of every cell it loads.
 */
export function planArea(cx: number, cz: number, steps: number, spacing: number, altitude: number, errorOf?: (cell: CellId) => number | undefined): CellId[] {
  const all = new Map<string, CellId>();
  for (let j = -steps; j <= steps; j++) {
    for (let i = -steps; i <= steps; i++) {
      const m = new StreamingManager(bakeConfig(errorOf !== undefined));
      const t: Ticket[] = [{ id: 'camera', kind: 'camera', center: [cx + i * spacing, 0, cz + j * spacing], altitude, base: 0 }];
      for (let round = 0; round < 64; round++) {
        const a = m.update(t);
        for (const r of a.requests) {
          all.set(r.key, r.cell);
          m.complete(r, 1, errorOf?.(r.cell));
        }
        for (const c of a.uploads) m.resident(c, 1);
        if (m.settled && a.requests.length === 0 && a.uploads.length === 0) break;
      }
    }
  }
  return [...all.values()].sort(compareCells);
}

export { cellKey };
