// The vertex layout of the ground, the sea floor and the trees (described in ground-mesh.ts). In a file of its own,
// because the ground's mesh and the trees both need it and the ground's mesh reads the trees' cover.

import type { VertexLayout } from 'wallhammer-web/base';
import { CELL_SURFACE_ATTRIBS, CELL_SURFACE_LAYOUT } from 'wallhammer-web/gen-mesh';

export const GROUND_LAYOUT: VertexLayout = {
  stride: 32,
  attribs: [
    ...CELL_SURFACE_LAYOUT.attribs,
    { name: 'a_path', size: 4, type: 'i8', offset: 24 },
    { name: 'a_pathOn', size: 4, type: 'u8', normalized: true, offset: 28 },
  ],
};
export const GROUND_ATTRIBS = { ...CELL_SURFACE_ATTRIBS, a_path: 3, a_pathOn: 4 } as const;
/** Steps of a path's vector in a metre, and the longest vector the layout carries, metres. */
export const PATH_UNITS = 16;
export const PATH_FAR_M = 127 / PATH_UNITS;
