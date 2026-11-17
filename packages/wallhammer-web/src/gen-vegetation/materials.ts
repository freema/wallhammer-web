// Materials of the vegetation, as plain descriptions for the renderer.

import type { MaterialDesc, Uniforms } from '../base/index.ts';
import { TREE_ATTRIBS } from './trees.ts';
import { DEPTH_TREE_FS, DEPTH_TREE_VS, TREE_FS, TREE_VS } from './tree-shader.ts';

/** Instanced vegetation (`buildTreeBatches`): lit in the colour pass, casts shadows with its own depth program. */
export const VEGETATION_MATERIAL: MaterialDesc = {
  name: 'vegetation',
  attribs: TREE_ATTRIBS,
  passes: { shadow: { vs: DEPTH_TREE_VS, fs: DEPTH_TREE_FS }, color: { vs: TREE_VS, fs: TREE_FS } },
};

/** Palette rows of the season colours: autumn yellow, orange, rust, bare twigs; and the spring leaf. */
export function vegetationUniforms(seasonRows: readonly [number, number, number, number], springRow: number): Uniforms {
  return { u_seasonRows: { ivec4: [seasonRows[0], seasonRows[1], seasonRows[2], seasonRows[3]] }, u_springRow: { int: springRow } };
}

/** Sparse canopies (spring, autumn, winter) become transparent via alpha-to-coverage: the antialiasing samples act as a fine sieve. */
export function vegetationSieve(foliage: number): boolean {
  return foliage < 0.999;
}
