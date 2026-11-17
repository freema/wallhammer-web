// Surface mesh of one cell of a sphere made of six quadtrees (see cube-sphere.ts): a square grid on a face of the
// cube, every vertex pushed out to the base radius plus the height the content gives for that point of the sphere.
//
// - Content is a function of the point on the sphere, never of the face or the cell: heights are asked for at points
//   that carry the same bits from every cell that reaches them, so cells agree on their shared border, across the
//   edges of the cube as well.
// - Normals come from the grid, with a margin of samples around the cell, so neighbours of one face agree. On an edge
//   of the cube the two faces' grids do not continue each other; there the normal is taken from four samples placed
//   by the point's direction alone (`directionTangents`), which again gives both faces the same bits.
// - Like the cell morph mesh of gen-mesh, every vertex also carries the shape of the cell one level coarser: how far
//   along its own "up" the parent's surface lies (`a_coarseShift`), and the parent's normal and colour there. The
//   parent's surface is flat triangles between every second vertex, so the shift includes the bulge of the sphere
//   between them: a vertex moved by the whole shift lies exactly on the parent's triangle.
// - A skirt hangs from the border toward the centre and covers the step against a neighbour of another level.
//
// Positions are relative to the cell origin, the middle of the cell on the base sphere; axes are the world's.

import type { MeshData, VertexLayout } from '../base/data.ts';
import type { LocalBounds } from './cell.ts';
import { CUBE_FACE_AXES, cubeDirection, cubeDirectionWarped, cubeFaceCoords, cubeGrid, cubeWarp, directionTangents } from './cube-sphere.ts';
import { HeightField } from './height-field.ts';

/** Locations a material should give the attributes. */
export const SPHERE_PATCH_ATTRIBS = { a_pos: 0, a_normal: 1, a_color: 2, a_coarseShift: 3, a_coarseNormal: 4, a_coarseColor: 5 } as const;

/**
 * Position 3× float relative to the cell origin; normal 3× int16 (×32767, world axes) and the kind (0 surface,
 * 1 skirt) as the fourth; colour 4× u8 normalized; `a_coarseShift`, metres along the vertex's own "up" to the
 * parent's surface; `a_coarseNormal` and `a_coarseColor`, the parent's normal and colour there. The same structure as
 * the cell morph layout of gen-mesh.
 */
export const SPHERE_PATCH_LAYOUT: VertexLayout = {
  stride: 40,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 4, type: 'i16', offset: 12 },
    { name: 'a_color', size: 4, type: 'u8', normalized: true, offset: 20 },
    { name: 'a_coarseShift', size: 1, type: 'f32', offset: 24 },
    { name: 'a_coarseNormal', size: 4, type: 'i16', offset: 28 },
    { name: 'a_coarseColor', size: 4, type: 'u8', normalized: true, offset: 36 },
  ],
};

/** Locations for a patch made with `coverAt`: the plain ones and the two cover attributes. */
export const SPHERE_PATCH_COVER_ATTRIBS = { ...SPHERE_PATCH_ATTRIBS, a_cover: 6, a_coarseCover: 7 } as const;

/**
 * Layout of a patch made with `coverAt`: the plain layout followed by `a_cover` (4× u8 normalized: rgb what the
 * content on the surface looks like from afar, a the share of the surface it hides) and `a_coarseCover`, the same
 * of the cell one level coarser at this vertex. A shader blends the two by the morph factor like the colours.
 */
export const SPHERE_PATCH_COVER_LAYOUT: VertexLayout = {
  stride: 48,
  attribs: [
    ...SPHERE_PATCH_LAYOUT.attribs,
    { name: 'a_cover', size: 4, type: 'u8', normalized: true, offset: 40 },
    { name: 'a_coarseCover', size: 4, type: 'u8', normalized: true, offset: 44 },
  ],
};

/** Locations for a plain patch made with `extraAt`: the plain ones and the two extra attributes. */
export const SPHERE_PATCH_EXTRA_ATTRIBS = { ...SPHERE_PATCH_ATTRIBS, a_extra: 6, a_coarseExtra: 7 } as const;

/** Locations for a patch made with both `coverAt` and `extraAt`. */
export const SPHERE_PATCH_COVER_EXTRA_ATTRIBS = { ...SPHERE_PATCH_COVER_ATTRIBS, a_extra: 8, a_coarseExtra: 9 } as const;

/**
 * Layout of a patch made with `extraAt` (no `coverAt`): the plain layout followed by `a_extra` (4× u8 normalized, the
 * bytes `extraAt` gave) and `a_coarseExtra`, the same of the cell one level coarser, thinned like the colour.
 */
export const SPHERE_PATCH_EXTRA_LAYOUT: VertexLayout = {
  stride: 48,
  attribs: [
    ...SPHERE_PATCH_LAYOUT.attribs,
    { name: 'a_extra', size: 4, type: 'u8', normalized: true, offset: 40 },
    { name: 'a_coarseExtra', size: 4, type: 'u8', normalized: true, offset: 44 },
  ],
};

/** Layout of a patch made with `coverAt` and `extraAt`: the cover layout followed by `a_extra` and `a_coarseExtra`. */
export const SPHERE_PATCH_COVER_EXTRA_LAYOUT: VertexLayout = {
  stride: 56,
  attribs: [
    ...SPHERE_PATCH_COVER_LAYOUT.attribs,
    { name: 'a_extra', size: 4, type: 'u8', normalized: true, offset: 48 },
    { name: 'a_coarseExtra', size: 4, type: 'u8', normalized: true, offset: 52 },
  ],
};

/**
 * GLSL for a vertex shader of a renderer with radial up (paste it after `#include <header>`; it declares its own
 * uniforms, the ones the streamed world sets with its `morph` option). `spherePatchMorph(p)` is the blend factor at a
 * render-space point: 0 = the cell's own shape, 1 = the parent's. The distance is measured as the streaming manager
 * measures it: along the sphere, combined with the viewer's height.
 *
 *   vec3 p = a_pos + u_cellOffset;
 *   float m = spherePatchMorph(p);
 *   p += localUp(p) * (a_coarseShift * m);
 *   vec3 n = normalize(mix(a_normal.xyz, a_coarseNormal.xyz, m));
 *   vec4 c = mix(a_color, a_coarseColor, m);
 */
export const SPHERE_PATCH_GLSL = /* glsl */ `
uniform vec4 u_morphEye;  // xyz: the viewer in render space, w: its height above the surface
uniform vec2 u_cellMorph; // x: distance where the blend starts, y: 1 / length of the blend (0 = no blend)
float spherePatchMorph(vec3 p) {
  vec3 d = p - u_morphEye.xyz;
#ifdef WH_LOCAL_UP
  // Angle between the viewer and the point as seen from the centre, from small differences only.
  vec3 e = u_morphEye.xyz - u_upCenter.xyz;
  float along = u_upCenter.w * atan(length(cross(e, d)), dot(e, e + d));
#else
  float along = length(d.xz);
#endif
  float dist = sqrt(along * along + u_morphEye.w * u_morphEye.w);
  return clamp((dist - u_cellMorph.x) * u_cellMorph.y, 0.0, 1.0);
}
`;

export interface SpherePatchOptions {
  /** Radius of the base sphere in metres. */
  radiusM: number;
  /** The cell: face of the cube (0–5), quadtree level, and its indices on the face. */
  face: number;
  level: number;
  x: number;
  y: number;
  /** Quads along the cell's edge; must be even. */
  quads: number;
  /**
   * Height above the base sphere at a point of it, given in metres from the sphere's centre (double). Must be a pure
   * function of the point.
   */
  heightAt: (x: number, y: number, z: number) => number;
  /**
   * RGBA bytes of a surface point: the point of the base sphere under it (as for `heightAt`) and its height. A pure
   * function of the point, so a vertex gets the same colour at every level and from every cell. Default mid grey.
   */
  colorAt?: (x: number, y: number, z: number, height: number) => readonly [number, number, number, number];
  /**
   * Cover of a surface point, as RGBA bytes: rgb what the content standing on the surface looks like from afar, a
   * the share of the surface it hides (its density, 0–255). Same arguments and rules as `colorAt`. When given, the
   * mesh uses `SPHERE_PATCH_COVER_LAYOUT`; a material mixes the cover into the surface colour where the objects
   * themselves are no longer drawn (`coverFade` of core). Default: none, the plain layout.
   */
  coverAt?: (x: number, y: number, z: number, height: number) => readonly [number, number, number, number];
  /**
   * Four free bytes of a surface point; the patch gives them no meaning. Same arguments and rules as `colorAt`. When
   * given, the layout gains `a_extra` and `a_coarseExtra` at its end (`SPHERE_PATCH_EXTRA_LAYOUT`, or
   * `SPHERE_PATCH_COVER_EXTRA_LAYOUT` with `coverAt`), thinned to the coarser level like the colour; the bytes before
   * them are those of the patch without it. Default: none.
   */
  extraAt?: (x: number, y: number, z: number, height: number) => readonly [number, number, number, number];
  /** Least depth of the skirt in metres. 0 = no skirt. */
  skirtDepth: number;
}

export interface SpherePatch {
  mesh: MeshData;
  /** What the mesh is relative to: the middle of the cell on the base sphere, in metres from the sphere's centre. */
  origin: [number, number, number];
  /** Extent of the mesh relative to `origin`, at any blend factor, the skirt included. */
  bounds: LocalBounds;
  /** Lowest and highest height above the base sphere the surface can show at any blend factor (without the skirt). */
  minHeight: number;
  maxHeight: number;
  /** Estimated largest distance in metres to the surface the children would show. Use it as `CellContent.error`. */
  error: number;
  /** Depth the skirt was given. */
  skirtDepth: number;
}

const KIND_TOP = 0;
const KIND_SKIRT = 1;
const MARGIN = 2;
const HALF_PI = 1.5707963267948966;

export function spherePatchMesh(o: SpherePatchOptions): SpherePatch {
  const q = o.quads;
  if (q < 2 || q % 2 !== 0) throw new Error(`spherePatchMesh: quads must be even, got ${q}`);
  if (!CUBE_FACE_AXES[o.face]) throw new Error(`spherePatchMesh: not a face of the cube: ${o.face}`);
  const R = o.radiusM;
  const n = q + 1;
  const cells = 2 ** o.level;
  /** Grid intervals across the whole face at this level. */
  const N = q * cells;
  const gx0 = o.x * q;
  const gy0 = o.y * q;

  // Samples on the cell's grid with a margin of two on each side, as far as the face reaches.
  const m = n + 2 * MARGIN;
  const dir = new Float64Array(m * m * 3);
  const rad = new Float64Array(m * m).fill(NaN);
  const pos = new Float64Array(m * m * 3);
  const wu = new Float64Array(m);
  const wv = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    wu[k] = cubeWarp(cubeGrid(gx0 + k - MARGIN, N));
    wv[k] = cubeWarp(cubeGrid(gy0 + k - MARGIN, N));
  }
  const d3: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < m; j++) {
    const gj = gy0 + j - MARGIN;
    if (gj < 0 || gj > N) continue;
    for (let i = 0; i < m; i++) {
      const gi = gx0 + i - MARGIN;
      if (gi < 0 || gi > N) continue;
      const k = j * m + i;
      cubeDirectionWarped(o.face, wu[i]!, wv[j]!, d3);
      const r = R + o.heightAt(d3[0] * R, d3[1] * R, d3[2] * R);
      dir.set(d3, k * 3);
      rad[k] = r;
      pos[k * 3] = d3[0] * r;
      pos[k * 3 + 1] = d3[1] * r;
      pos[k * 3 + 2] = d3[2] * r;
    }
  }
  /** Index into the sample arrays of grid vertex (i, j) of the cell (−2 … n + 1). */
  const at = (i: number, j: number): number => (j + MARGIN) * m + (i + MARGIN);
  const has = (i: number, j: number): boolean => i >= -MARGIN && j >= -MARGIN && i < n + MARGIN && j < n + MARGIN && !Number.isNaN(rad[at(i, j)]!);

  // Normal from the grid: (P(i+s, j) − P(i−s, j)) × (P(i, j+s) − P(i, j−s)); u × v points outward.
  const out3: [number, number, number] = [0, 0, 0];
  const gridNormal = (i: number, j: number, s: number): [number, number, number] => {
    const a = at(i + s, j) * 3;
    const b = at(i - s, j) * 3;
    const c = at(i, j + s) * 3;
    const d = at(i, j - s) * 3;
    return unitCross(pos[a]! - pos[b]!, pos[a + 1]! - pos[b + 1]!, pos[a + 2]! - pos[b + 2]!, pos[c]! - pos[d]!, pos[c + 1]! - pos[d + 1]!, pos[c + 2]! - pos[d + 2]!, out3);
  };
  // Normal from four samples placed by the direction alone, `eps` radians away: for the edges of the cube.
  const q4 = new Float64Array(12);
  const freeNormal = (k: number, eps: number): [number, number, number] => {
    const dx = dir[k * 3]!;
    const dy = dir[k * 3 + 1]!;
    const dz = dir[k * 3 + 2]!;
    const { t1, t2 } = directionTangents([dx, dy, dz]);
    for (let s = 0; s < 4; s++) {
      const t = s < 2 ? t1 : t2;
      const e = s % 2 === 0 ? eps : -eps;
      let x = dx + t[0] * e;
      let y = dy + t[1] * e;
      let z = dz + t[2] * e;
      const l = Math.sqrt(x * x + y * y + z * z);
      x /= l;
      y /= l;
      z /= l;
      const r = R + o.heightAt(x * R, y * R, z * R);
      q4[s * 3] = x * r;
      q4[s * 3 + 1] = y * r;
      q4[s * 3 + 2] = z * r;
    }
    return unitCross(q4[0]! - q4[3]!, q4[1]! - q4[4]!, q4[2]! - q4[5]!, q4[6]! - q4[9]!, q4[7]! - q4[10]!, q4[8]! - q4[11]!, out3);
  };
  /** Nominal angle between two grid lines at this level. */
  const eps = HALF_PI / N;

  const own = new Float64Array(n * n);
  const normals = new Int16Array(n * n * 3);
  const colors = new Uint8Array(n * n * 4);
  const covers = o.coverAt ? new Uint8Array(n * n * 4) : null;
  const extras = o.extraAt ? new Uint8Array(n * n * 4) : null;
  const cnx = new Float64Array(n * n);
  const cny = new Float64Array(n * n);
  const cnz = new Float64Array(n * n);
  let error = 0;
  // A straight edge between two vertices misses the middle of a curve by an eighth of the second difference; here in
  // space, so the bulge of the sphere counts as well as the content.
  const bend = (a: number, c: number, b: number): number => Math.hypot(pos[a * 3]! - 2 * pos[c * 3]! + pos[b * 3]!, pos[a * 3 + 1]! - 2 * pos[c * 3 + 1]! + pos[b * 3 + 1]!, pos[a * 3 + 2]! - 2 * pos[c * 3 + 2]! + pos[b * 3 + 2]!) / 8;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const s = at(i, j);
      own[k] = rad[s]!;
      const gi = gx0 + i;
      const gj = gy0 + j;
      const onEdge = gi === 0 || gi === N || gj === 0 || gj === N;
      const nrm = onEdge ? freeNormal(s, eps) : gridNormal(i, j, 1);
      normals[k * 3] = Math.round(nrm[0] * 32767);
      normals[k * 3 + 1] = Math.round(nrm[1] * 32767);
      normals[k * 3 + 2] = Math.round(nrm[2] * 32767);
      const c = o.colorAt ? o.colorAt(dir[s * 3]! * R, dir[s * 3 + 1]! * R, dir[s * 3 + 2]! * R, rad[s]! - R) : [128, 128, 128, 255];
      for (let ch = 0; ch < 4; ch++) colors[k * 4 + ch] = c[ch]!;
      if (covers && o.coverAt) {
        const cv = o.coverAt(dir[s * 3]! * R, dir[s * 3 + 1]! * R, dir[s * 3 + 2]! * R, rad[s]! - R);
        for (let ch = 0; ch < 4; ch++) covers[k * 4 + ch] = cv[ch]!;
      }
      if (extras && o.extraAt) {
        const ex = o.extraAt(dir[s * 3]! * R, dir[s * 3 + 1]! * R, dir[s * 3 + 2]! * R, rad[s]! - R);
        for (let ch = 0; ch < 4; ch++) extras[k * 4 + ch] = ex[ch]!;
      }
      if (i % 2 === 0 && j % 2 === 0) {
        const pn = onEdge ? freeNormal(s, 2 * eps) : gridNormal(i, j, 2);
        cnx[k] = pn[0];
        cny[k] = pn[1];
        cnz[k] = pn[2];
      }
      if (has(i - 1, j) && has(i + 1, j)) error = Math.max(error, bend(at(i - 1, j), s, at(i + 1, j)));
      if (has(i, j - 1) && has(i, j + 1)) error = Math.max(error, bend(at(i, j - 1), s, at(i, j + 1)));
    }
  }
  // The middle of a quad lies on its diagonal; a twisted quad misses the mean of its corners by a quarter of the twist.
  for (let j = 0; j < q; j++) {
    for (let i = 0; i < q; i++) {
      const a = at(i, j) * 3;
      const b = at(i + 1, j) * 3;
      const c = at(i, j + 1) * 3;
      const d = at(i + 1, j + 1) * 3;
      const twist = Math.hypot(pos[a]! + pos[d]! - pos[b]! - pos[c]!, pos[a + 1]! + pos[d + 1]! - pos[b + 1]! - pos[c + 1]!, pos[a + 2]! + pos[d + 2]! - pos[b + 2]! - pos[c + 2]!) / 4;
      if (twist > error) error = twist;
    }
  }

  // The parent's surface at every vertex: where the line from the centre through the vertex meets the parent's
  // triangle (the parent's vertices are every second vertex, its quads are split by the same diagonal).
  //
  // A vertex on a line of the parent's grid lies on the parent's edge between the two vertices of that line. Only those
  // two enter there, through their mean and their difference, so the result has the same bits whichever of them comes
  // first: cells that share the line agree, and across an edge of the cube the neighbour walks it the other way.
  const edgeRadius = (a: number, b: number, s: number): number => {
    const mx = (pos[a]! + pos[b]!) * 0.5;
    const my = (pos[a + 1]! + pos[b + 1]!) * 0.5;
    const mz = (pos[a + 2]! + pos[b + 2]!) * 0.5;
    const ex = pos[b]! - pos[a]!;
    const ey = pos[b + 1]! - pos[a + 1]!;
    const ez = pos[b + 2]! - pos[a + 2]!;
    const wx = my * ez - mz * ey;
    const wy = mz * ex - mx * ez;
    const wz = mx * ey - my * ex;
    // Across the edge, in the plane of the edge and the centre.
    const nx = ey * wz - ez * wy;
    const ny = ez * wx - ex * wz;
    const nz = ex * wy - ey * wx;
    return (nx * mx + ny * my + nz * mz) / (nx * dir[s]! + ny * dir[s + 1]! + nz * dir[s + 2]!);
  };
  const coarse = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const j0 = Math.min(j - (j % 2), q - 2);
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (i % 2 === 0 && j % 2 === 0) {
        coarse[k] = own[k]!;
        continue;
      }
      if (i % 2 === 0 || j % 2 === 0) {
        const along = i % 2 !== 0;
        coarse[k] = edgeRadius((along ? at(i - 1, j) : at(i, j - 1)) * 3, (along ? at(i + 1, j) : at(i, j + 1)) * 3, at(i, j) * 3);
        continue;
      }
      // Inside a quad of the parent. Which of its two triangles the line from the centre passes through is decided by
      // the plane through the centre and the quad's diagonal; the diagonal of the grid is not that plane's arc, so
      // the indices alone do not tell.
      const i0 = Math.min(i - (i % 2), q - 2);
      const qa = at(i0, j0) * 3;
      const qb = at(i0 + 2, j0) * 3;
      const qc = at(i0, j0 + 2) * 3;
      const lower = sameSide(pos, qa, qb, qc, dir[at(i, j) * 3]!, dir[at(i, j) * 3 + 1]!, dir[at(i, j) * 3 + 2]!);
      const a = lower ? qa : at(i0 + 2, j0 + 2) * 3;
      const b = lower ? qb : qc;
      const c = lower ? qc : qb;
      const mn = unitCross(pos[b]! - pos[a]!, pos[b + 1]! - pos[a + 1]!, pos[b + 2]! - pos[a + 2]!, pos[c]! - pos[a]!, pos[c + 1]! - pos[a + 1]!, pos[c + 2]! - pos[a + 2]!, out3);
      const s = at(i, j) * 3;
      coarse[k] = (mn[0] * pos[a]! + mn[1] * pos[a + 1]! + mn[2] * pos[a + 2]!) / (mn[0] * dir[s]! + mn[1] * dir[s + 1]! + mn[2] * dir[s + 2]!);
    }
  }
  const coarseNx = HeightField.coarseSurface(n, n, cnx, 2);
  const coarseNy = HeightField.coarseSurface(n, n, cny, 2);
  const coarseNz = HeightField.coarseSurface(n, n, cnz, 2);
  // On a line of the parent's grid: the mean of its two vertices as a sum, the same bits whichever comes first.
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if ((i % 2 === 0) === (j % 2 === 0)) continue;
      const k = j * n + i;
      const a = i % 2 !== 0 ? k - 1 : k - n;
      const b = i % 2 !== 0 ? k + 1 : k + n;
      coarseNx[k] = (cnx[a]! + cnx[b]!) * 0.5;
      coarseNy[k] = (cny[a]! + cny[b]!) * 0.5;
      coarseNz[k] = (cnz[a]! + cnz[b]!) * 0.5;
    }
  }
  const channel = new Float64Array(n * n);
  const coarseColors = new Uint8Array(n * n * 4);
  for (let ch = 0; ch < 4; ch++) {
    for (let k = 0; k < n * n; k++) channel[k] = colors[k * 4 + ch]!;
    const thin = HeightField.coarseSurface(n, n, channel, 2);
    for (let k = 0; k < n * n; k++) coarseColors[k * 4 + ch] = Math.round(thin[k]!);
  }
  // The cover of the coarser level, thinned the same way as its colour.
  const coarseCovers = covers ? new Uint8Array(n * n * 4) : null;
  if (covers && coarseCovers) {
    for (let ch = 0; ch < 4; ch++) {
      for (let k = 0; k < n * n; k++) channel[k] = covers[k * 4 + ch]!;
      const thin = HeightField.coarseSurface(n, n, channel, 2);
      for (let k = 0; k < n * n; k++) coarseCovers[k * 4 + ch] = Math.round(thin[k]!);
    }
  }
  // The extra bytes of the coarser level, thinned the same way as the colour.
  const coarseExtras = extras ? new Uint8Array(n * n * 4) : null;
  if (extras && coarseExtras) {
    for (let ch = 0; ch < 4; ch++) {
      for (let k = 0; k < n * n; k++) channel[k] = extras[k * 4 + ch]!;
      const thin = HeightField.coarseSurface(n, n, channel, 2);
      for (let k = 0; k < n * n; k++) coarseExtras[k * 4 + ch] = Math.round(thin[k]!);
    }
  }

  // Skirt depth: twice the largest step this border can show against another level, and never under the least depth.
  let borderGap = 0;
  for (let k = 0; k < n; k++) {
    for (const [i, j, alongI] of [[k, 0, true], [k, q, true], [0, k, false], [q, k, false]] as const) {
      let g = Math.abs(coarse[j * n + i]! - own[j * n + i]!);
      const a = alongI ? [i - 1, j] : [i, j - 1];
      const b = alongI ? [i + 1, j] : [i, j + 1];
      if (has(a[0]!, a[1]!) && has(b[0]!, b[1]!)) g = Math.max(g, bend(at(a[0]!, a[1]!), at(i, j), at(b[0]!, b[1]!)));
      if (g > borderGap) borderGap = g;
    }
  }
  const skirt = o.skirtDepth > 0;
  const skirtDepth = skirt ? Math.max(o.skirtDepth, 2 * borderGap) : 0;

  const cellsAcross = 2 * cells;
  const mid = cubeDirection(o.face, cubeGrid(2 * o.x + 1, cellsAcross), cubeGrid(2 * o.y + 1, cellsAcross));
  const origin: [number, number, number] = [mid[0] * R, mid[1] * R, mid[2] * R];

  const vertCount = n * n + (skirt ? 8 * n : 0);
  const layout = extras ? (covers ? SPHERE_PATCH_COVER_EXTRA_LAYOUT : SPHERE_PATCH_EXTRA_LAYOUT) : covers ? SPHERE_PATCH_COVER_LAYOUT : SPHERE_PATCH_LAYOUT;
  const extraOff = covers ? 48 : 40;
  const STRIDE = layout.stride;
  const buf = new ArrayBuffer(vertCount * STRIDE);
  const view = new DataView(buf);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  const put = (v: number, i: number, j: number, drop: number, kind: number): void => {
    const k = j * n + i;
    const s = at(i, j) * 3;
    const off = v * STRIDE;
    const r = own[k]! - drop;
    const shift = Math.fround(coarse[k]! - own[k]!);
    for (let c = 0; c < 3; c++) {
      const d = dir[s + c]!;
      const p = Math.fround(d * r - origin[c]!);
      view.setFloat32(off + c * 4, p, true);
      // The vertex as drawn at blend 0 and at blend 1, with a millimetre for the rounding of the shader's arithmetic.
      const moved = p + d * shift;
      if (Math.min(p, moved) - 1e-3 < min[c]!) min[c] = Math.min(p, moved) - 1e-3;
      if (Math.max(p, moved) + 1e-3 > max[c]!) max[c] = Math.max(p, moved) + 1e-3;
    }
    view.setInt16(off + 12, normals[k * 3]!, true);
    view.setInt16(off + 14, normals[k * 3 + 1]!, true);
    view.setInt16(off + 16, normals[k * 3 + 2]!, true);
    view.setInt16(off + 18, kind, true);
    for (let c = 0; c < 4; c++) view.setUint8(off + 20 + c, colors[k * 4 + c]!);
    view.setFloat32(off + 24, shift, true);
    const cl = Math.sqrt(coarseNx[k]! * coarseNx[k]! + coarseNy[k]! * coarseNy[k]! + coarseNz[k]! * coarseNz[k]!) || 1;
    view.setInt16(off + 28, Math.round((coarseNx[k]! / cl) * 32767), true);
    view.setInt16(off + 30, Math.round((coarseNy[k]! / cl) * 32767), true);
    view.setInt16(off + 32, Math.round((coarseNz[k]! / cl) * 32767), true);
    view.setInt16(off + 34, 0, true);
    for (let c = 0; c < 4; c++) view.setUint8(off + 36 + c, coarseColors[k * 4 + c]!);
    if (covers && coarseCovers) {
      for (let c = 0; c < 4; c++) {
        view.setUint8(off + 40 + c, covers[k * 4 + c]!);
        view.setUint8(off + 44 + c, coarseCovers[k * 4 + c]!);
      }
    }
    if (extras && coarseExtras) {
      for (let c = 0; c < 4; c++) {
        view.setUint8(off + extraOff + c, extras[k * 4 + c]!);
        view.setUint8(off + extraOff + 4 + c, coarseExtras[k * 4 + c]!);
      }
    }
    if (kind === KIND_TOP) {
      minHeight = Math.min(minHeight, own[k]! - R, coarse[k]! - R);
      maxHeight = Math.max(maxHeight, own[k]! - R, coarse[k]! - R);
    }
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) put(j * n + i, i, j, 0, KIND_TOP);

  const quadCount = q * q + (skirt ? 4 * q : 0);
  const big = vertCount > 65535;
  const idx = big ? new Uint32Array(quadCount * 6) : new Uint16Array(quadCount * 6);
  let w = 0;
  for (let j = 0; j < q; j++) {
    for (let i = 0; i < q; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // u × v points outward: (a, b, c) winds anticlockwise seen from outside.
      idx[w++] = a;
      idx[w++] = b;
      idx[w++] = c;
      idx[w++] = b;
      idx[w++] = d;
      idx[w++] = c;
    }
  }
  if (skirt) {
    // Four sides, each a strip of vertex pairs: the border vertex and one below it, both with the border vertex's
    // blend attributes, so the skirt follows the border at every blend factor. Each strip faces away from the cell.
    let v = n * n;
    const side = (vertex: (k: number) => [number, number], flip: boolean): void => {
      const start = v;
      for (let k = 0; k < n; k++) {
        const [i, j] = vertex(k);
        put(v++, i, j, 0, KIND_SKIRT);
        put(v++, i, j, skirtDepth, KIND_SKIRT);
      }
      for (let k = 0; k < q; k++) {
        const t0 = start + k * 2;
        const b0 = t0 + 1;
        const t1 = t0 + 2;
        const b1 = t0 + 3;
        if (flip) {
          idx[w++] = t0;
          idx[w++] = b0;
          idx[w++] = t1;
          idx[w++] = t1;
          idx[w++] = b0;
          idx[w++] = b1;
        } else {
          idx[w++] = t0;
          idx[w++] = t1;
          idx[w++] = b0;
          idx[w++] = t1;
          idx[w++] = b1;
          idx[w++] = b0;
        }
      }
    };
    side((k) => [k, 0], true);
    side((k) => [k, q], false);
    side((k) => [0, k], false);
    side((k) => [q, k], true);
  }
  return { mesh: { layout, vertices: new Uint8Array(buf), indices: idx, count: w }, origin, bounds: { min, max }, minHeight, maxHeight, error, skirtDepth };
}

/**
 * Distance from the sphere's centre at which the line along the unit direction `dir` meets the surface a patch draws:
 * the flat triangles of its own grid (`step` 1) or of the cell one level coarser (`step` 2, the shape the patch
 * blends into). For standing something on the mesh of a level instead of on the ideal surface, where it would float
 * above a coarse level or sink into it. `dir` should point into the cell; outside it the nearest quad is used.
 */
export function spherePatchRadius(o: Pick<SpherePatchOptions, 'radiusM' | 'face' | 'level' | 'x' | 'y' | 'quads' | 'heightAt'>, dir: readonly [number, number, number], step: 1 | 2 = 1): number {
  const R = o.radiusM;
  const N = o.quads * 2 ** o.level;
  const gx0 = o.x * o.quads;
  const gy0 = o.y * o.quads;
  const [s, t] = cubeFaceCoords(o.face, dir);
  const count = o.quads / step;
  const gu = (((s + 1) / 2) * N - gx0) / step;
  const gv = (((t + 1) / 2) * N - gy0) / step;
  const i = Math.min(count - 1, Math.max(0, Math.floor(gu)));
  const j = Math.min(count - 1, Math.max(0, Math.floor(gv)));
  const vertex = (a: number, b: number): [number, number, number] => {
    const d = cubeDirection(o.face, cubeGrid(gx0 + a * step, N), cubeGrid(gy0 + b * step, N));
    const r = R + o.heightAt(d[0] * R, d[1] * R, d[2] * R);
    return [d[0] * r, d[1] * r, d[2] * r];
  };
  // The same split of a quad as the mesh, along the diagonal from (i + 1, j) to (i, j + 1). The line meets the triangle
  // on its side of the plane through the centre and that diagonal.
  const v00 = vertex(i, j);
  const v10 = vertex(i + 1, j);
  const v01 = vertex(i, j + 1);
  const lower = sameSide([...v00, ...v10, ...v01], 0, 3, 6, dir[0], dir[1], dir[2]);
  const A = lower ? v00 : vertex(i + 1, j + 1);
  const B = lower ? v10 : v01;
  const C = lower ? v01 : v10;
  const n = unitCross(B[0] - A[0], B[1] - A[1], B[2] - A[2], C[0] - A[0], C[1] - A[1], C[2] - A[2], [0, 0, 0]);
  return (n[0] * A[0] + n[1] * A[1] + n[2] * A[2]) / (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]);
}

/**
 * True when the direction (dx, dy, dz) lies on the same side as point `a` of the plane through the centre and the
 * points `b` and `c` (offsets into `p`), or in that plane.
 */
function sameSide(p: ArrayLike<number>, a: number, b: number, c: number, dx: number, dy: number, dz: number): boolean {
  const wx = p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!;
  const wy = p[b + 2]! * p[c]! - p[b]! * p[c + 2]!;
  const wz = p[b]! * p[c + 1]! - p[b + 1]! * p[c]!;
  return (dx * wx + dy * wy + dz * wz) * (p[a]! * wx + p[a + 1]! * wy + p[a + 2]! * wz) >= 0;
}

/** Unit vector along a × b, written into `out`. */
function unitCross(ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: [number, number, number]): [number, number, number] {
  const x = ay * bz - az * by;
  const y = az * bx - ax * bz;
  const z = ax * by - ay * bx;
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
  return out;
}
