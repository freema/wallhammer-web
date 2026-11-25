// Feeds a `SolidIndex` (world) from a `StreamedWorld`: the cells of one level of the quadtree enter the index when they
// reach the GPU and leave it when they leave the GPU. A streamed world holds a cell at several levels at once (a coarse
// parent stays resident under its children), so one level is chosen: the coarsest level whose cells hold every object
// that should be solid near the viewer. Its cells are resident wherever that level or a finer one is drawn.

import type { SolidIndex } from '../world/index.ts';
import type { StreamedWorld } from './streaming.ts';

export interface StreamSolidsOptions {
  /** The quadtree level whose cells feed the index. */
  level: number;
}

/**
 * Keeps `index` in step with the resident cells of `level` of `world`: the cells resident now are added at once, later
 * ones as they arrive (new content of a cell replaces its solids), and a released cell's solids are removed. Several
 * links and the world's own `onResident` / `onReleased` coexist. Returns the function that ends the link (it leaves the
 * index as it is; `index.clear()` empties it).
 */
export function streamSolids(world: StreamedWorld, index: SolidIndex, options: StreamSolidsOptions): () => void {
  const level = options.level;
  world.forEachResident((cell, content) => {
    if (cell.level === level) index.addCell(content);
  });
  return world.listen({
    resident: (cell, _meshes, content) => {
      if (cell.level === level) index.addCell(content);
    },
    released: (cell) => {
      if (cell.level === level) index.removeCell(cell);
    },
  });
}
