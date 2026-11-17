// Distant levels of structures, for views where a house is a few pixels.
//
// Middle level (massing): every structure is an upright prism over its footprint with a flat top, all structures of a
// tile merged into one indexed mesh with a small vertex. Its material shades with the same light, weather and snow as
// the full one and takes the means of what the full shader draws: the wall tint with its share of glass, the mean
// glow of lit windows, the roof covering. It fades by `u_fade` (core/level-fade.ts) in the colour and the shadow pass,
// so it can be cross-faded with the full mesh and thinned out towards the far level.
//
// Far level (imprint): nothing is drawn. The footprints are stamped into the ground class raster with the code of
// their roof covering (gen-tex/code-stamp.ts) and the ground bake paints them like any other surface class.
//
// Both work per tile: the mesh can be written relative to a tile origin (drawn with `u_cellOffset`), and a stamp works
// on a rectangle of the raster.

import earcut from 'earcut';
import type { MaterialDesc, MeshData, RGB, Vec3, VertexLayout } from '../../base/index.ts';
import { FADE_GLSL } from '../../core/index.ts';
import { ringSignedArea, unit } from '../../gen-core/index.ts';
import type { Ring } from '../../gen-core/index.ts';
import type { CodeStamp } from '../../gen-tex/index.ts';
import type { BuildingSpec } from './buildings.ts';
import type { ArchMeshDims, ArchShadeDims } from './dims.ts';
import { KIND } from './writer.ts';

// --- Middle level: massing mesh ------------------------------------------------------------------------------------

export const MASSING_ATTRIBS = { a_pos: 0, a_up: 1, a_normal: 2, a_mat: 3, a_seed: 4 } as const;

const STRIDE = 28;

/**
 * Vertex layout of the massing mesh: position, height above the ground the storeys are counted from, normal with the
 * kind of surface in its fourth component (wall 0, top of a pitched roof 1, top of a flat roof 2), palette rows of
 * wall and roof with the window style and the glazed share of the wall (0–255), and the structure's 24-bit tint seed
 * (the same number the full shader derives from the structure hash).
 */
export const MASSING_LAYOUT: VertexLayout = {
  stride: STRIDE,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_up', size: 1, type: 'f32', offset: 12 },
    { name: 'a_normal', size: 4, type: 'i8', offset: 16 },
    { name: 'a_mat', size: 4, type: 'u8', integer: true, offset: 20 },
    { name: 'a_seed', size: 4, type: 'u8', integer: true, offset: 24 },
  ],
};

export interface MassingOptions {
  /** Emit only the structures at these indices of `specs`. */
  only?: ReadonlySet<number>;
  /**
   * Positions are written relative to this point (a tile origin), so they stay exact far from the world origin. Draw
   * the mesh with `u_cellOffset` = origin − render origin. Default [0, 0, 0]: world positions, no offset needed.
   */
  origin?: Vec3;
}

export interface MassingMesh {
  mesh: MeshData;
  /** First vertex of every structure of `specs` in the mesh; the last entry is the vertex count. */
  spans: Uint32Array;
  /** Lowest and highest point (world heights). Both 0 when nothing was emitted. */
  minY: number;
  maxY: number;
  /** Structures emitted. */
  structures: number;
}

/** Top of the prism: the roof surface of a flat roof, halfway up a pitched one (about the same volume). */
function massingTop(b: BuildingSpec, dims: ArchMeshDims): number {
  if (b.roof === 'flat') return b.eaveY;
  const eave = Math.max(b.eaveY, b.groundRef + dims.minWallHeight);
  return Math.max(eave, 0.5 * (eave + b.ridgeY));
}

/** Mean share of a wall that is glass, as the full shader draws it (0–1). */
function glazedShare(b: BuildingSpec): number {
  if (b.facade) {
    const w = b.facade.window;
    return Math.min(0.5, Math.max(0, (w.width * w.height) / Math.max(1, b.bayWidth * b.floorHeightNominal)));
  }
  // Window width × height as shares of a bay and a storey (building-shader.ts, wallColor).
  if (b.windowStyle === 2) return 0.8 * 0.48;
  if (b.windowStyle === 3) return 0.36 * 0.3;
  if (b.windowStyle === 0) return 0;
  const ww = Math.min(0.66, Math.max(0.38, 1.5 / Math.max(b.bayWidth, 0.1)));
  const wh = Math.min(0.62, Math.max(0.3, 1.65 / Math.max(b.floorHeightNominal, 0.1)));
  return ww * wh;
}

/** A ring as point indices in the order that gives the wanted winding (outer ring positive area, holes negative). */
function ringOrder(ring: Ring, hole: boolean): number[] {
  const n = ring.length >> 1;
  const forward = ringSignedArea(ring) > 0 !== hole;
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(forward ? i : n - 1 - i);
  return order;
}

/**
 * Builds the massing mesh: one prism per structure, from below the ground to the roof (see `massingTop`), all in one
 * indexed mesh. Walls carry flat normals, the top is the triangulated footprint with its holes. About 3 triangles per
 * footprint point. Deterministic; the vertices of a structure are consecutive (`spans`), so one structure can be
 * hidden by overwriting its vertices with zeros.
 */
export function buildMassingMesh(specs: readonly BuildingSpec[], dims: ArchMeshDims, options: MassingOptions = {}): MassingMesh {
  const origin = options.origin ?? [0, 0, 0];
  const spans = new Uint32Array(specs.length + 1);
  let points = 0;
  specs.forEach((b, self) => {
    if (options.only && !options.only.has(self)) return;
    for (const r of b.rings) points += r.length >> 1;
  });
  const buf = new ArrayBuffer(points * 5 * STRIDE);
  const f32 = new Float32Array(buf);
  const i8 = new Int8Array(buf);
  const u8 = new Uint8Array(buf);
  const indices: number[] = [];
  let count = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  let structures = 0;

  specs.forEach((b, self) => {
    spans[self] = count;
    if (options.only && !options.only.has(self)) return;
    const baseY = b.groundMin - dims.wallBelowGround;
    const topY = Math.max(massingTop(b, dims), baseY + 0.5);
    // The seed exactly as the full shader gets it: a float attribute of the hash, scaled to 24 bits.
    const seed = Math.trunc(Math.fround(Math.fround(unit(b.hash)) * 16777215));
    const glass = Math.round(glazedShare(b) * 255);
    const topKind = b.roof === 'flat' ? KIND.roofFlat : KIND.roofPitched;

    const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: number): number => {
      const o = count * STRIDE;
      const f = o / 4;
      f32[f] = x - origin[0];
      f32[f + 1] = y - origin[1];
      f32[f + 2] = z - origin[2];
      f32[f + 3] = y - b.groundRef;
      i8[o + 16] = Math.round(nx * 127);
      i8[o + 17] = Math.round(ny * 127);
      i8[o + 18] = Math.round(nz * 127);
      i8[o + 19] = kind;
      u8[o + 20] = b.wallColor;
      u8[o + 21] = b.roofColor;
      u8[o + 22] = b.windowStyle;
      u8[o + 23] = glass;
      u8[o + 24] = seed & 255;
      u8[o + 25] = (seed >> 8) & 255;
      u8[o + 26] = (seed >> 16) & 255;
      u8[o + 27] = 0;
      return count++;
    };

    // Top: the footprint triangulated with its holes, facing up.
    const coords: number[] = [];
    const holes: number[] = [];
    const orders: number[][] = [];
    for (const ring of b.rings) {
      if (ring.length < 6) continue;
      if (coords.length > 0) holes.push(coords.length / 2);
      const order = ringOrder(ring, coords.length > 0);
      orders.push(order);
      for (const i of order) coords.push(ring[i * 2]!, ring[i * 2 + 1]!);
    }
    if (coords.length < 6) return;
    structures++;
    const top0 = count;
    for (let i = 0; i < coords.length; i += 2) push(coords[i]!, topY, coords[i + 1]!, 0, 1, 0, topKind);
    const tris = earcut(coords, holes, 2);
    for (let t = 0; t + 2 < tris.length; t += 3) {
      const a = tris[t]!;
      let p = tris[t + 1]!;
      let q = tris[t + 2]!;
      const area2 = (coords[p * 2]! - coords[a * 2]!) * (coords[q * 2 + 1]! - coords[a * 2 + 1]!) - (coords[q * 2]! - coords[a * 2]!) * (coords[p * 2 + 1]! - coords[a * 2 + 1]!);
      // Facing up means a negative turn in the x–z plane.
      if (area2 > 0) [p, q] = [q, p];
      indices.push(top0 + a, top0 + p, top0 + q);
    }

    // Walls: one quad per footprint edge, the outward normal to the right of the edge direction.
    let at = 0;
    for (const order of orders) {
      const n = order.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = coords[(at + i) * 2]!;
        const az = coords[(at + i) * 2 + 1]!;
        const bx = coords[(at + j) * 2]!;
        const bz = coords[(at + j) * 2 + 1]!;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-3) continue;
        const nx = (bz - az) / len;
        const nz = -(bx - ax) / len;
        const v0 = push(ax, baseY, az, nx, 0, nz, KIND.wall);
        const v1 = push(ax, topY, az, nx, 0, nz, KIND.wall);
        const v2 = push(bx, topY, bz, nx, 0, nz, KIND.wall);
        const v3 = push(bx, baseY, bz, nx, 0, nz, KIND.wall);
        indices.push(v0, v2, v3, v0, v1, v2);
      }
      at += n;
    }
    if (baseY < minY) minY = baseY;
    if (topY > maxY) maxY = topY;
  });
  spans[specs.length] = count;

  const vertices = new Uint8Array(buf, 0, count * STRIDE);
  const mesh: MeshData = {
    layout: MASSING_LAYOUT,
    vertices,
    indices: count <= 65535 ? Uint16Array.from(indices) : Uint32Array.from(indices),
    count: indices.length,
  };
  return { mesh, spans, minY: structures > 0 ? minY : 0, maxY: structures > 0 ? maxY : 0, structures };
}

const MASSING_VS = /* glsl */ `#include <header>
uniform vec3 u_cellOffset;
in vec3 a_pos;
in float a_up;
in vec4 a_normal;
in uvec4 a_mat;
in uvec4 a_seed;
out vec3 v_world;
out float v_up;
flat out vec3 v_normal;
flat out int v_kind;
flat out uvec4 v_mat;
flat out uint v_seed;
void main() {
  vec3 pos = a_pos + u_cellOffset;
  v_world = pos;
  v_up = a_up;
  v_normal = normalize(a_normal.xyz + vec3(0.0, 1e-4, 0.0));
  v_kind = int(a_normal.w);
  v_mat = a_mat;
  v_seed = a_seed.x | (a_seed.y << 8) | (a_seed.z << 16);
  gl_Position = u_viewProj * vec4(pos, 1.0);
}`;

const f = (v: number): string => v.toFixed(3);

/** Means of the full structure shading (building-shader.ts): keep the tint formulas in step with it. */
const massingFs = (dims: ArchShadeDims): string => /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <snow>
uniform ivec4 u_rows; // palette rows: glass, glass with sky reflection (the rest unused here)
in vec3 v_world;
in float v_up;
flat in vec3 v_normal;
flat in int v_kind;
flat in uvec4 v_mat;
flat in uint v_seed;
out vec4 o_color;
${FADE_GLSL}
void main() {
  if (fadeHidden(gl_FragCoord.xy)) discard;
  vec3 n = v_normal;
  uint seed = v_seed;
  vec3 col;
  vec3 glow = vec3(0.0);
  float ao = 1.0;
  if (v_kind == 0) {
    // Wall: the structure's tint, with the mean glass tone over the glazed share.
    vec3 wall = u_palette[v_mat.x].rgb * (0.88 + 0.22 * hash1(seed + 1u));
    wall *= mix(vec3(1.0), vec3(1.05, 1.0, 0.9), hash1(seed + 2u));
    float glass = float(v_mat.w) / 255.0;
    vec3 glassCol = mix(u_palette[u_rows.x].rgb, u_palette[u_rows.y].rgb, 0.23);
    col = mix(wall, glassCol, glass);
    // The wall darkens at its foot, so the house sits on the ground.
    ao = mix(0.5, 1.0, smoothstep(-0.3, ${f(dims.wallBaseShadeHeight)}, v_up));
    if (u_time.z > 0.0) {
      // Lit windows merged into their mean: the share lit tonight in this house times the glazed share.
      float habit = 0.35 + 1.3 * hash1(seed + 9u);
      float lit = clamp(u_time.w * habit * (v_mat.z == 1u ? 1.0 : 0.55), 0.0, 0.95);
      glow = vec3(0.975, 0.77, 0.46) * (glass * lit * u_time.z / u_warmTint.a);
    }
  } else {
    // Roof covering; a pitched roof is a little darker by its courses.
    col = u_palette[v_mat.y].rgb * (0.82 + 0.18 * hash1(seed + 3u)) * (v_kind == 1 ? 0.95 : 1.0);
  }
  col *= 1.0 - u_weather.y * (v_kind == 0 ? 0.1 : 0.22);
  if (v_kind != 0) {
    float snow = snowOn(v_world, n, v_kind == 2 ? 0.18 : 0.06);
    col = mix(col, u_snow.rgb * (0.97 + 0.06 * hash1(seed + 5u)), snow);
  }
  float sun = sunVisibility(v_world, n, 1.6);
  vec3 light = lightOn(n, sun, ao) * mix(0.78, 1.0, ao);
  o_color = vec4(applyFog(toDisplay(col * u_warmTint.rgb * light + glow), v_world), 1.0);
}`;

const MASSING_DEPTH_VS = /* glsl */ `#include <header>
uniform mat4 u_lightRender;
uniform vec3 u_cellOffset;
in vec3 a_pos;
void main() {
  gl_Position = u_lightRender * vec4(a_pos + u_cellOffset, 1.0);
}`;
const MASSING_DEPTH_FS = /* glsl */ `#version 300 es
precision highp float;
${FADE_GLSL}
void main() {
  if (fadeHidden(gl_FragCoord.xy)) discard;
}`;

/**
 * Material of the massing mesh. Uniforms: `u_rows` as the full material (`structureUniforms`), `u_fade` (x share of
 * fragments left out, y pattern side; unset = fully drawn) and `u_cellOffset` (unset = positions are world positions).
 * The shadow thins out with the same fade. Needs the includes and frame slots the full structure material needs.
 */
export function massingMaterial(dims: ArchShadeDims): MaterialDesc {
  return {
    name: 'structures-massing',
    attribs: MASSING_ATTRIBS,
    passes: { shadow: { vs: MASSING_DEPTH_VS, fs: MASSING_DEPTH_FS }, color: { vs: MASSING_VS, fs: massingFs(dims) } },
  };
}

// --- Far level: imprint into the ground class raster ---------------------------------------------------------------

/**
 * Stamps the footprints into a class raster: every structure with the code `codeOf` gives it (for example one class
 * per roof covering). Structures smaller than a raster cell keep their total area (see `CodeStamp`). Returns the cells
 * stamped. With `only`, just the structures at these indices of `specs`.
 */
export function stampFootprints(stamp: CodeStamp, specs: readonly BuildingSpec[], codeOf: (b: BuildingSpec) => number, only?: ReadonlySet<number>): number {
  let n = 0;
  specs.forEach((b, self) => {
    if (only && !only.has(self)) return;
    n += stamp.polygon(b.rings, codeOf(b), b.hash);
  });
  return n;
}

/**
 * Three tones of a roof covering for a ground class that stands for roofs seen from far above: the span of the
 * per-structure tint of the full shader. `albedoScale` is what the ground bake multiplies its colours by; the tones are
 * divided by it, so the baked ground comes out as bright as the roofs were.
 */
export function roofTones(color: RGB, albedoScale = 1): [RGB, RGB, RGB] {
  const tone = (k: number): RGB => [Math.min(1, (color[0] * k) / albedoScale), Math.min(1, (color[1] * k) / albedoScale), Math.min(1, (color[2] * k) / albedoScale)];
  return [tone(0.84), tone(0.91), tone(0.98)];
}
