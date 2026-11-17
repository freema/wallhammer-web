// Materials of the ground and the markings, as plain descriptions for the renderer.

import type { MaterialDesc, RGB, Uniforms } from '../base/index.ts';
import { HEIGHT_FIELD_ATTRIBS } from '../gen-mesh/index.ts';
import { MARKING_ATTRIBS } from './markings.ts';
import { MARKING_FS, MARKING_VS, TERRAIN_FS, TERRAIN_VS } from './terrain-shader.ts';

/** The terrain mesh (`heightFieldMesh`) with the baked ground texture. Colour pass only, it casts no shadows. */
export const TERRAIN_MATERIAL: MaterialDesc = {
  name: 'terrain',
  attribs: HEIGHT_FIELD_ATTRIBS,
  passes: { color: { vs: TERRAIN_VS, fs: TERRAIN_FS } },
};

/** Markings drawn over the terrain triangles with the same depth: paint over the ground by its coverage, the target alpha stays. */
export const MARKING_MATERIAL: MaterialDesc = {
  name: 'markings',
  attribs: MARKING_ATTRIBS,
  passes: { color: { vs: MARKING_VS, fs: MARKING_FS } },
  state: { color: { blend: { src: 'src-alpha', dst: 'one-minus-src-alpha', srcAlpha: 'zero', dstAlpha: 'one' }, depthFunc: 'lequal', depthWrite: false } },
};

/** Samplers of the terrain and marking materials, in binding order. */
export const GROUND_SAMPLERS = ['u_ground', 'u_surface'] as const;

/** What the terrain and marking materials read besides the samplers. */
export interface GroundShading {
  /** Extent of the ground texture in metres. */
  sizeX: number;
  sizeZ: number;
  /** Highest terrain point. */
  topY: number;
  /** Colour of the side skirt. */
  skirt: RGB;
}

export function groundUniforms(g: GroundShading): Uniforms {
  return { u_invWorldSize: { vec2: [1 / g.sizeX, 1 / g.sizeZ] }, u_earth: { vec3: g.skirt }, u_topY: { float: g.topY } };
}
