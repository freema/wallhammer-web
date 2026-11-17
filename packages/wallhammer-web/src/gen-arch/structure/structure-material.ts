// Material of the structure mesh: lit in the colour pass, casts shadows with the plain depth program (the damage
// variant with a depth program that also grows rubble in). The material of falling parts is in
// ../damage/fall-material.ts and shares the plain depth fragment program.

import type { MaterialDesc, Uniforms } from '../../base/index.ts';
import { BUILDING_ATTRIBS } from './buildings.ts';
import { buildingFs, buildingVs } from './building-shader.ts';
import type { StructureShaderOptions } from './building-shader.ts';
import type { ArchShadeDims } from './dims.ts';

/** Rubble that is still arriving grows up from its base (writer.ts, growIn); the same rule as BUILDING_VS. */
const GROW_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
in vec3 a_pos;
in vec4 a_fac;
void main() {
  vec3 pos = a_pos;
  if (a_fac.y < 0.0) {
    float g = clamp((u_time.x - a_fac.x) / -a_fac.y, 0.0, 1.0);
    pos.y = mix(a_fac.z, a_pos.y, g * g * (3.0 - 2.0 * g));
  }
  gl_Position = u_lightRender * vec4(pos, 1.0);
}`;
export const DEPTH_FS = /* glsl */ `#version 300 es
precision highp float;
void main() {}`;

/** Palette rows the structure shader takes from outside. */
export interface StructureRows {
  glass: number;
  glassLit: number;
  plinth: number;
}

/** The plain depth stage with the frame of the mesh (`u_frame`, see `StructureShaderOptions`). */
const FRAMED_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
uniform mat4 u_frame;
in vec3 a_pos;
void main() {
  gl_Position = u_lightRender * (u_frame * vec4(a_pos, 1.0));
}`;

/** GROW_DEPTH_VS with the frame of the mesh. */
const FRAMED_GROW_DEPTH_VS = GROW_DEPTH_VS.replace('in vec3 a_pos;\n', 'uniform mat4 u_frame;\nin vec3 a_pos;\n').replace(
  'gl_Position = u_lightRender * vec4(pos, 1.0);',
  'gl_Position = u_lightRender * (u_frame * vec4(pos, 1.0));',
);

/** Name suffix of a shader variant: `-framed`, `-finishes`, both, or nothing. */
export function variantSuffix(o: StructureShaderOptions): string {
  return `${o.framed ? '-framed' : ''}${o.finishes ? '-finishes' : ''}`;
}

/**
 * Material of the structure mesh. `damage: true` gives the variant that shades the vertex damage channel (cracks,
 * breaches, cut faces, rubble); draw damaged structures and rubble with it and keep intact ones on the plain one.
 * `framed` draws the mesh in its own frame (uniform `u_frame`, set per draw), `finishes` draws wall finishes, roof
 * covers and shutters (see `StructureShaderOptions`); each variant has its own name.
 */
export function structureMaterial(dims: ArchShadeDims, options: { damage?: boolean } & StructureShaderOptions = {}): MaterialDesc {
  const damage = options.damage ?? false;
  const o: StructureShaderOptions = { framed: options.framed === true, finishes: options.finishes === true };
  const shadow = damage ? { vs: o.framed ? FRAMED_GROW_DEPTH_VS : GROW_DEPTH_VS, fs: DEPTH_FS } : o.framed ? { vs: FRAMED_DEPTH_VS, fs: DEPTH_FS } : ('depth' as const);
  return {
    name: (damage ? 'structures-damaged' : 'structures') + variantSuffix(o),
    attribs: BUILDING_ATTRIBS,
    passes: { shadow, color: { vs: buildingVs(o), fs: buildingFs(dims, damage, o) } },
  };
}

/** Uniforms of the structure material. */
export function structureUniforms(rows: StructureRows): Uniforms {
  return { u_rows: { ivec4: [rows.glass, rows.glassLit, rows.plinth, 0] } };
}
