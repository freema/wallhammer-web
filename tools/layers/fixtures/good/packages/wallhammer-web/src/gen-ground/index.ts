// Known good: a content module may name what it generates (trees, roads, building façades) and import the generator layers.
import { add } from '../base/math.ts';
import type { MeshData } from 'wallhammer-web/base';
import { lineMesh } from '../gen-mesh/line.ts';
export function shape(): MeshData {
  return lineMesh(add(1, 1));
}
export const ROAD_WIDTH = 6;
