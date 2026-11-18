// The scene as pure data: a plain of flat ground with a handful of structures from the structure generator, each a
// different recipe (flat roof with a full façade recipe, gable, hip, an L-shaped block, a long block with roof boxes).

import { HeightField, orientedBox, ringSignedArea } from 'wallhammer-web/gen-core';
import type { Ring } from 'wallhammer-web/gen-core';
import { definePalette } from 'wallhammer-web';
import type { MaterialDesc } from 'wallhammer-web/base';
import { HEIGHT_FIELD_ATTRIBS } from 'wallhammer-web/gen-mesh';
import { GROUND_FLOOR } from 'wallhammer-web/gen-arch';
import type { ArchDims, BuildingSpec, FacadeRecipe, RoofKind } from 'wallhammer-web/gen-arch';

export const PALETTE = definePalette({
  sky: '#9db4c4',
  ground: '#6f7457',
  wallA: '#9b8d78',
  wallB: '#b8b2a5',
  wallC: '#847566',
  wallD: '#a3937a',
  roofBrown: '#574e42',
  roofSlate: '#444451',
  roofBrick: '#804c3d',
  roofGrey: '#5a565a',
  frame: '#cbc5ba',
  plinth: '#5b554d',
  door: '#4a3b2e',
  accent: '#7d6b58',
  chimney: '#6d5a4c',
  roofUnit: '#77736d',
  glass: '#22272c',
  glassLit: '#56646e',
});
const P = (k: Parameters<typeof PALETTE.index>[0]): number => PALETTE.index(k);

export const DIMS: ArchDims = {
  minWallHeight: 2.6,
  wallBelowGround: 0.6,
  floorHeightMin: 2.7,
  floorHeightMax: 4.6,
  parapetThickness: 0.35,
  roofSlopeMin: 0.32,
  roofSlopeMax: 1.2,
  roofUnitMinRoofArea: 60,
  roofUnitAreaPerUnit: 40,
  roofUnitMaxCount: 3,
  roofUnitMinSize: 1.2,
  roofUnitMaxSize: 3,
  roofUnitMinHeight: 0.8,
  roofUnitMaxHeight: 2,
  plinthHeight: 0.5,
  wallBaseShadeHeight: 1.2,
  parapetHeight: 0.6,
};

/** The plain: flat ground, `SIZE` metres square. */
export const SIZE = 120;
export const GROUND_Y = 0;
export const groundAt = (): number => GROUND_Y;
export function groundField(): HeightField {
  const n = SIZE / 4 + 1;
  return new HeightField(4, n, n, new Float32Array(n * n).fill(GROUND_Y));
}

const ring = (pts: number[]): Ring => {
  const r = Float32Array.from(pts);
  if (ringSignedArea(r) > 0) return r;
  const out = new Float32Array(r.length);
  for (let i = 0; i < r.length / 2; i++) {
    out[i * 2] = r[r.length - 2 - i * 2]!;
    out[i * 2 + 1] = r[r.length - 1 - i * 2]!;
  }
  return out;
};
const rect = (x: number, z: number, w: number, d: number): Ring => ring([x, z, x + w, z, x + w, z + d, x, z + d]);

const recipe = (o: Partial<FacadeRecipe>): FacadeRecipe => ({
  groundFloorHeight: 3.6,
  groundFloor: GROUND_FLOOR.glazed,
  plinthHeight: 0.5,
  curtainShare: 0.4,
  blindShare: 0.2,
  panelJoints: false,
  blindEndWalls: 6,
  window: { width: 1.2, height: 1.5, sill: 0.9, mullions: 1, transom: true, narrowMask: 0 },
  balconies: null,
  cornice: { height: 0.4, projection: 0.3 },
  entrances: [],
  stairStrip: false,
  chimneys: 0,
  roofBoxes: null,
  colors: { frame: P('frame'), plinth: P('plinth'), door: P('door'), accent: P('accent'), chimney: P('chimney') },
  ...o,
});

function spec(id: number, rings: Ring[], roof: RoofKind, eave: number, ridge: number, wall: number, roofColor: number, facade?: FacadeRecipe): BuildingSpec {
  return {
    id,
    hash: Math.imul(id, 2654435761) >>> 0,
    rings,
    box: orientedBox(rings[0]!),
    groundMin: GROUND_Y,
    groundRef: GROUND_Y,
    eaveY: GROUND_Y + eave,
    ridgeY: GROUND_Y + ridge,
    roof,
    ridgeAcross: false,
    levelsHint: Math.max(1, Math.round(eave / 3.1)),
    floorHeightNominal: 3.1,
    bayWidth: 3,
    windowStyle: 1,
    parapetHeight: 0.6,
    wallColor: wall,
    roofColor,
    trimColor: P('frame'),
    roofUnitColor: P('roofUnit'),
    ...(facade ? { facade } : {}),
  };
}

/** Five structures around the middle of the plain. */
export function structures(): BuildingSpec[] {
  const c = SIZE / 2;
  return [
    spec(
      1,
      [rect(c - 22, c - 18, 16, 10)],
      'flat',
      12.6,
      12.6,
      P('wallA'),
      P('roofGrey'),
      recipe({
        balconies: { kind: 'balcony', depth: 1.2, columnMask: 0b0101, minWallLength: 8 },
        entrances: [{ x: c - 14, z: c - 18, kind: 'door', width: 1.4, raise: 0.3, canopy: 1 }],
        stairStrip: true,
      }),
    ),
    spec(2, [rect(c + 4, c - 17, 14, 9)], 'gable', 9.4, 14.2, P('wallB'), P('roofBrick'), recipe({ groundFloor: GROUND_FLOOR.windows, cornice: null, chimneys: 2 })),
    spec(3, [rect(c - 20, c + 4, 12, 10)], 'hip', 6.4, 10.4, P('wallD'), P('roofSlate')),
    spec(4, [ring([c - 2, c + 2, c + 18, c + 2, c + 18, c + 9, c + 7, c + 9, c + 7, c + 18, c - 2, c + 18])], 'flat', 9.4, 9.4, P('wallC'), P('roofGrey'), recipe({ groundFloor: GROUND_FLOOR.windows, panelJoints: true })),
    spec(5, [rect(c + 24, c - 6, 8, 24)], 'gable', 6.3, 9.8, P('wallA'), P('roofBrown'), recipe({ groundFloor: GROUND_FLOOR.windows, cornice: null, chimneys: 1, entrances: [{ x: c + 24, z: c + 6, kind: 'garage', width: 2.8, raise: 0, canopy: 0 }] })),
  ];
}

const GROUND_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec4 a_normal;
out vec3 v_world;
void main() {
  v_world = a_pos;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const GROUND_FS = /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <snow>
uniform vec3 u_albedo;
in vec3 v_world;
out vec4 o_color;
void main() {
  vec3 n = vec3(0.0, 1.0, 0.0);
  float patchN = vnoise(v_world.xz / 7.0, 11u) * 0.6 + vnoise(v_world.xz / 1.9, 12u) * 0.4 * detailVisibleAt(1.9, v_world);
  vec3 col = u_albedo * (0.86 + 0.24 * patchN);
  col = mix(col, u_snow.rgb, snowOn(v_world, n, 0.1));
  float sun = sunVisibility(v_world, n, 1.2);
  o_color = vec4(applyFog(toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0)), v_world), 1.0);
}`;

export const GROUND_MATERIAL: MaterialDesc = {
  name: 'ground',
  attribs: HEIGHT_FIELD_ATTRIBS,
  passes: { shadow: 'depth', color: { vs: GROUND_VS, fs: GROUND_FS } },
};

/** Scripted events by name (metres, radius, energy), applied in order by `#s=name,name`. */
export const SCENARIOS: Record<string, readonly { at: [number, number, number]; r: number; e: number }[]> = {
  // Light hits on the L-shaped block: cracked bays only.
  cracked: [
    { at: [70, 5.5, 78.6], r: 3, e: 260 },
    { at: [78.6, 3, 70], r: 2.5, e: 240 },
  ],
  // The corner of the block with balconies blown out over two storeys; one bay next to it breached.
  corner: [
    { at: [37.6, 1.6, 41.6], r: 2.6, e: 650 },
    { at: [37.6, 2.4, 41.6], r: 3.3, e: 1600 },
    { at: [37.4, 5, 47], r: 2.2, e: 420 },
  ],
  // The ground storey of the long block taken out along one side: the storey above loses its support and falls.
  collapse: [
    { at: [92.6, 0.9, 61], r: 2.3, e: 1700 },
    { at: [92.6, 0.9, 65], r: 2.3, e: 1700 },
    { at: [92.6, 0.9, 69], r: 2.3, e: 1700 },
  ],
  // The whole ground storey of the long block taken out: everything above loses its support and comes down.
  fall: [
    { at: [88, 1, 54.6], r: 3.5, e: 5000 },
    { at: [88, 1, 77.4], r: 3.5, e: 5000 },
    { at: [88, 1, 57], r: 4.5, e: 5000 },
    { at: [88, 1, 63], r: 4.5, e: 5000 },
    { at: [88, 1, 69], r: 4.5, e: 5000 },
    { at: [88, 1, 75], r: 4.5, e: 5000 },
  ],
  // One deep hit into the corridor block: three storeys cut open, slabs, partitions and the stair core on view.
  cut: [{ at: [44.2, 6, 40], r: 6, e: 900 }],
  // The cut plus a hit from above: a roof section gone, the top storey seen from the sky.
  roof: [
    { at: [44.2, 6, 40], r: 6, e: 900 },
    { at: [48, 12.6, 48], r: 3.5, e: 1400 },
  ],
};
