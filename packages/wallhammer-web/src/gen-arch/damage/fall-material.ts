// Material of falling parts (fall.ts): the damaged structure shading of the structure shader on vertices that move on
// their ballistic tracks. It lives with the falling parts so the structure subfolder knows nothing about them.

import type { MaterialDesc } from '../../base/index.ts';
import { TRACK_GLSL } from '../../core/index.ts';
import { BUILDING_VS, buildingFs, frameVs } from '../structure/building-shader.ts';
import type { StructureShaderOptions } from '../structure/building-shader.ts';
import { DEPTH_FS, variantSuffix } from '../structure/structure-material.ts';
import type { ArchShadeDims } from '../structure/dims.ts';
import { FALL_ATTRIBS } from './fall.ts';

const TRACK_INPUTS = 'in vec4 a_track0;\nin vec4 a_track1;\nin vec4 a_track2;\nin vec4 a_track3;\n';

/** BUILDING_VS with every vertex placed on its track (core/ballistic.ts). */
function fallVs(): string {
  const vs = BUILDING_VS.replace('in vec3 a_pos;\n', `in vec3 a_pos;\n${TRACK_INPUTS}`)
    .replace('void main() {', `${TRACK_GLSL}\nvoid main() {`)
    // Patterns stay where they were on the piece at rest.
    .replace('  v_pat = pos;\n', '  v_pat = a_pos;\n')
    .replace('  vec3 pos = a_pos;\n', '  vec3 nrm = a_normal.xyz;\n  vec3 pos = trackPlace(a_pos, nrm, a_track0, a_track1, a_track2, a_track3);\n')
    // A single surface (a roof section) seen from behind is shaded as its front.
    .replace('v_normal = normalize(a_normal.xyz);', 'v_normal = normalize(nrm + vec3(0.0, 1e-4, 0.0));\n  if (dot(v_normal, u_camForward.xyz) > 0.0) v_normal = -v_normal;');
  if (!vs.includes('trackPlace(a_pos') || !vs.includes('v_pat = a_pos;')) throw new Error('fallVs: BUILDING_VS changed shape');
  return vs;
}
const FALL_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
in vec3 a_pos;
in vec4 a_normal;
${TRACK_INPUTS}${TRACK_GLSL}
void main() {
  vec3 n = a_normal.xyz;
  gl_Position = u_lightRender * vec4(trackPlace(a_pos, n, a_track0, a_track1, a_track2, a_track3), 1.0);
}`;
/** FALL_DEPTH_VS with the frame of the mesh: the tracks run in the frame, the result goes through `u_frame`. */
const FRAMED_FALL_DEPTH_VS = FALL_DEPTH_VS.replace('uniform mat4 u_lightRender;\n', 'uniform mat4 u_lightRender;\nuniform mat4 u_frame;\n').replace(
  'gl_Position = u_lightRender * vec4(trackPlace(a_pos, n, a_track0, a_track1, a_track2, a_track3), 1.0);',
  'gl_Position = u_lightRender * (u_frame * vec4(trackPlace(a_pos, n, a_track0, a_track1, a_track2, a_track3), 1.0));',
);

/**
 * Material of falling parts (`fallPieces`): the damaged structure shading on vertices that move on their tracks, in
 * the colour and the shadow pass. Drawn from both sides (a roof section is a single surface). `o` picks the framed and
 * the finishes variant of the structure shaders (see `StructureShaderOptions`); the tracks then run in the frame of
 * the mesh.
 */
export function fallingMaterial(dims: ArchShadeDims, o: StructureShaderOptions = {}): MaterialDesc {
  const framed = o.framed === true;
  const opts: StructureShaderOptions = { framed, finishes: o.finishes === true };
  return {
    name: 'structures-falling' + variantSuffix(opts),
    attribs: FALL_ATTRIBS,
    passes: { shadow: { vs: framed ? FRAMED_FALL_DEPTH_VS : FALL_DEPTH_VS, fs: DEPTH_FS }, color: { vs: framed ? frameVs(fallVs()) : fallVs(), fs: buildingFs(dims, true, opts) } },
    state: { color: { cullBack: false }, shadow: { cullBack: false } },
  };
}
