// Ground colour. At start, one texture with mipmaps is baked from the surface class raster and the palette:
// each class gets three tones from the palette, between which world-anchored noise blends,
// kerbs on the roadway edge and darkening near houses and under canopies. No image is loaded.
// Next to the colour a second texture with the surface kind is baked (vegetation, paved area and roadway, canopy above ground, water),
// from which the terrain shader draws seasons and weather: snow, wetness, puddles, faded grass.

import type { BakeDesc, RGB, TextureData } from '../base/index.ts';
import { boxBlur } from '../gen-tex/index.ts';

/** Appearance of one surface class. */
export interface GroundMaterial {
  /** Three tones (0–1, display space) between which the surface blends. */
  colors: readonly [RGB, RGB, RGB];
  /** Size of colour blobs in metres. */
  patchM: number;
  /** Strength of fine grain at close view, 0–1. */
  grain: number;
  /** Roadway: on the edge with another surface it gets a kerb. */
  kerb?: boolean;
  /** Width of mowing stripes in metres (sports lawn), 0 = no stripes. */
  stripesM?: number;
  /** Surface kind for seasons and weather. Without it the class counts as bare ground. */
  surface?: GroundSurface;
}

/**
 * vegetation: grass and greenery (changes colour with the season), paved: paving and hard surfaces (gets wet, snow disappears from it sooner),
 * road: roadway (like paved, snow is cleared from it first), water: water.
 */
export type GroundSurface = 'vegetation' | 'paved' | 'road' | 'water' | 'bare';

export interface GroundInput {
  /** Class codes, one byte per pixel, rows from the north. */
  codes: Uint8Array;
  cols: number;
  rows: number;
  /** Pixel size of the class raster in metres. */
  step: number;
  /** Appearance by class code. A missing code gets `fallback`. */
  materials: Map<number, GroundMaterial>;
  fallback: GroundMaterial;
  occlusion: OcclusionMask;
  /** What the palette colours are multiplied by before light falls on them. */
  albedoScale: number;
  /**
   * Lowered kerb: rectangles from a to b (local metres [x, z]) with a cross width. Inside, the kerb on the roadway edge
   * is only hinted at and a paved area next to the roadway gets a warning strip (`warningStrip`). Useful for crossings,
   * driveways, stops.
   */
  loweredKerbs?: readonly { a: readonly [number, number]; b: readonly [number, number]; width: number }[];
  /** Warning strip at a lowered kerb: colour and depth from the roadway edge in metres. Without it only an interrupted kerb. */
  warningStrip?: { color: RGB; depthM: number };
}

/** Coarse shadow mask: R share of buildings, G share of canopies, both blurred. */
export interface OcclusionMask {
  data: Uint8Array;
  cols: number;
  rows: number;
}

/** Kerb width in metres. */
const KERB_WIDTH_M = 0.3;
/** How much the ground darkens right next to a house and under a dense canopy. */
const BUILDING_AO = 0.42;
const CANOPY_AO = 0.38;
const LUT_SIZE = 64;

const BAKE_FS = /* glsl */ `#include <header>
#include <noise>
uniform usampler2D u_classes;
uniform sampler2D u_lut;
uniform sampler2D u_occlusion;
uniform float u_step;
uniform vec2 u_worldSize;
uniform vec3 u_kerbColor;
uniform float u_albedoScale;
uniform sampler2D u_lowered;
uniform vec3 u_warnColor;
uniform float u_warnDepth;
layout(location = 0) out vec4 o_color;
layout(location = 1) out vec4 o_surface;

bool isRoad(ivec2 p) {
  ivec2 q = clamp(p, ivec2(0), textureSize(u_classes, 0) - 1);
  return texelFetch(u_lut, ivec2(int(texelFetch(u_classes, q, 0).r), 3), 0).b > 0.5;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int c = int(texelFetch(u_classes, px, 0).r);
  vec2 w = (vec2(px) + 0.5) * u_step;
  vec3 c0 = texelFetch(u_lut, ivec2(c, 0), 0).rgb;
  vec3 c1 = texelFetch(u_lut, ivec2(c, 1), 0).rgb;
  vec3 c2 = texelFetch(u_lut, ivec2(c, 2), 0).rgb;
  vec4 prm = texelFetch(u_lut, ivec2(c, 3), 0);
  vec4 kind = texelFetch(u_lut, ivec2(c, 4), 0);
  float patchM = prm.r * 64.0;
  float stripes = prm.a * 64.0;

  // Blobs at three scales, anchored in the world.
  uint seed = uint(c) * 7919u;
  float n = 0.55 * vnoise(w / patchM, seed) + 0.30 * vnoise(w / (patchM * 0.31), seed + 1u) + 0.15 * vnoise(w / (patchM * 0.09), seed + 2u);
  n = smoothstep(0.22, 0.78, n);
  vec3 col = n < 0.5 ? mix(c0, c1, n * 2.0) : mix(c1, c2, n * 2.0 - 1.0);
  // Slow brightness drift across whole areas, common to all classes.
  col *= 0.93 + 0.14 * vnoise(w / 46.0, 99u);

  if (stripes > 0.0) {
    float s = step(0.5, fract(w.x / (stripes * 2.0)));
    col *= 0.95 + 0.1 * s;
  }

  if (prm.b > 0.5) {
    // Kerb: a roadway that has a different surface within the kerb width.
    int r = int(ceil(${KERB_WIDTH_M.toFixed(2)} / u_step));
    bool edge = false;
    for (int j = -r; j <= r && !edge; j++) {
      for (int i = -r; i <= r; i++) {
        if (i * i + j * j > r * r) continue;
        if (!isRoad(px + ivec2(i, j))) { edge = true; break; }
      }
    }
    if (edge) {
      // The lowered kerb is sunk into the roadway plane: only a faint line of stone remains of the kerb.
      bool lowered = texelFetch(u_lowered, px, 0).r > 0.5;
      col = mix(col, u_kerbColor, lowered ? 0.2 : 0.7);
      kind = vec4(0.0, 0.6, 0.0, 0.0);
    }
  } else if (u_warnDepth > 0.0 && kind.g > 0.3 && texelFetch(u_lowered, px, 0).r > 0.5) {
    // Warning strip: paved area right next to the roadway where the kerb is lowered.
    int r = int(ceil(u_warnDepth / u_step));
    bool near = false;
    for (int j = -r; j <= r && !near; j++) {
      for (int i = -r; i <= r; i++) {
        if (i * i + j * j > r * r) continue;
        if (isRoad(px + ivec2(i, j))) { near = true; break; }
      }
    }
    if (near) {
      // Coarse tile jointing, anchored in the world.
      float tile = 0.92 + 0.08 * step(0.5, fract(w.x / 0.4 + 0.5 * step(0.5, fract(w.y / 0.4))));
      col = u_warnColor * tile;
    }
  }

  vec2 occ = texture(u_occlusion, w / u_worldSize).rg;
  col *= 1.0 - ${BUILDING_AO.toFixed(2)} * smoothstep(0.02, 0.55, occ.r);
  col *= 1.0 - ${CANOPY_AO.toFixed(2)} * smoothstep(0.05, 0.9, occ.g);
  o_color = vec4(col * u_albedoScale, prm.g);
  o_surface = vec4(kind.r, kind.g, smoothstep(0.1, 0.8, occ.g), kind.a);
}`;

/**
 * Describes the ground bake (run it with `renderer.bake`). Targets: `color` rgb colour with alpha the fine-grain
 * strength; `surface` r vegetation, g paved area (0.6) or roadway (1), b canopy above ground, a water. Both with
 * mipmaps, size same as the class raster.
 */
export function groundBake(input: GroundInput, kerb: RGB): BakeDesc {
  const { cols, rows } = input;
  const classes: TextureData = { width: cols, height: rows, format: 'r8ui', data: input.codes };

  const lut = new Uint8Array(LUT_SIZE * 5 * 4);
  for (let code = 0; code < LUT_SIZE; code++) {
    const m = input.materials.get(code) ?? input.fallback;
    m.colors.forEach((c, row) => {
      const o = (row * LUT_SIZE + code) * 4;
      lut[o] = Math.round(c[0] * 255);
      lut[o + 1] = Math.round(c[1] * 255);
      lut[o + 2] = Math.round(c[2] * 255);
      lut[o + 3] = 255;
    });
    const o = (3 * LUT_SIZE + code) * 4;
    lut[o] = Math.round((Math.min(m.patchM, 64) / 64) * 255);
    lut[o + 1] = Math.round(m.grain * 255);
    lut[o + 2] = m.kerb ? 255 : 0;
    lut[o + 3] = Math.round((Math.min(m.stripesM ?? 0, 64) / 64) * 255);
    const k = (4 * LUT_SIZE + code) * 4;
    lut[k] = m.surface === 'vegetation' ? 255 : 0;
    // Paved areas 0.6, roadways 1: the shader tells both apart from this.
    lut[k + 1] = m.surface === 'road' ? 255 : m.surface === 'paved' ? 153 : 0;
    lut[k + 3] = m.surface === 'water' ? 255 : 0;
  }
  const lutTex: TextureData = { width: LUT_SIZE, height: 5, format: 'rgba8', data: lut };

  // Lowered-kerb mask at the class raster resolution.
  const lowered = new Uint8Array(cols * rows);
  for (const k of input.loweredKerbs ?? []) {
    const dx = k.b[0] - k.a[0];
    const dz = k.b[1] - k.a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const ux = dx / len;
    const uz = dz / len;
    const hw = k.width / 2;
    const xs = [k.a[0] - uz * hw, k.a[0] + uz * hw, k.b[0] - uz * hw, k.b[0] + uz * hw];
    const zs = [k.a[1] + ux * hw, k.a[1] - ux * hw, k.b[1] + ux * hw, k.b[1] - ux * hw];
    const c0 = Math.max(0, Math.floor(Math.min(...xs) / input.step));
    const c1 = Math.min(cols - 1, Math.floor(Math.max(...xs) / input.step));
    const r0 = Math.max(0, Math.floor(Math.min(...zs) / input.step));
    const r1 = Math.min(rows - 1, Math.floor(Math.max(...zs) / input.step));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const px = (c + 0.5) * input.step - k.a[0];
        const pz = (r + 0.5) * input.step - k.a[1];
        const u = px * ux + pz * uz;
        const v = -px * uz + pz * ux;
        if (u >= 0 && u <= len && Math.abs(v) <= hw) lowered[r * cols + c] = 255;
      }
    }
  }
  // Texture rows go from the north, same as the class raster.
  const loweredTex: TextureData = { width: cols, height: rows, format: 'r8', data: lowered };
  const occTex: TextureData = { width: input.occlusion.cols, height: input.occlusion.rows, format: 'rg8', data: input.occlusion.data, filter: 'linear' };
  const target = { format: 'rgba8', filter: 'mipmap', anisotropy: 4 } as const;
  return {
    name: 'ground bake',
    width: cols,
    height: rows,
    fs: BAKE_FS,
    inputs: [
      { sampler: 'u_classes', texture: classes },
      { sampler: 'u_lut', texture: lutTex },
      { sampler: 'u_occlusion', texture: occTex },
      { sampler: 'u_lowered', texture: loweredTex },
    ],
    uniforms: {
      u_step: { float: input.step },
      u_worldSize: { vec2: [cols * input.step, rows * input.step] },
      u_kerbColor: { vec3: kerb },
      u_albedoScale: { float: input.albedoScale },
      u_warnColor: { vec3: input.warningStrip ? input.warningStrip.color : [0, 0, 0] },
      u_warnDepth: { float: input.warningStrip?.depthM ?? 0 },
    },
    targets: [target, target],
  };
}

export interface OcclusionInput {
  /** Surface class raster and which class is a building (array of 256 flags by code). */
  codes: Uint8Array;
  codeCols: number;
  codeStep: number;
  isBuilding: Uint8Array;
  /** Canopy coverage 0–255 in a coarser grid in which the mask is computed. */
  cover: Uint8Array;
  cols: number;
  rows: number;
  step: number;
  /** Blur radius in metres: how far from a house and a canopy the ground is still darker. */
  blurM: number;
}

/** Ground shadow mask from the class raster and canopy coverage. */
export function buildOcclusionMask(input: OcclusionInput): OcclusionMask {
  const { codes, codeCols, isBuilding, cover, cols, rows, step } = input;
  const per = Math.round(step / input.codeStep);
  const b = new Float32Array(cols * rows);
  const c = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let n = 0;
      for (let r = j * per; r < (j + 1) * per; r++) {
        const row = r * codeCols;
        for (let q = i * per; q < (i + 1) * per; q++) n += isBuilding[codes[row + q]!]!;
      }
      b[j * cols + i] = n / (per * per);
      c[j * cols + i] = cover[j * cols + i]! / 255;
    }
  }
  const radius = Math.max(1, Math.round(input.blurM / step));
  const bb = boxBlur(b, cols, rows, radius);
  const cb = boxBlur(c, cols, rows, radius);
  const out = new Uint8Array(cols * rows * 2);
  for (let k = 0; k < cols * rows; k++) {
    out[k * 2] = Math.round(Math.min(1, bb[k]!) * 255);
    out[k * 2 + 1] = Math.round(Math.min(1, cb[k]!) * 255);
  }
  return { data: out, cols, rows };
}
