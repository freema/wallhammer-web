// The cloud shadow texture: the share of the sun the clouds leave, drawn every few frames into a square texture seen
// from the light (an orthographic projection along the light around the eye), so `cloudLight` costs one lookup
// instead of the cloud field's noise octaves. This slot holds the projection (Frame members `u_cloudShadow…`); the
// runtime's `CloudShadowLayer` draws the texture and fills the params. When the frame block holds a slot of this name
// the environment link registers the texture variant of `cloudLight` (`lightingGlsl({ cloudShadow: true })`).
//
// A texel is a line along the light. Its value is the share where the line meets the base surface (the base sphere
// under radial up, the plane of the world's y = 0 otherwise), which is where the analytic `cloudLight` puts the
// shadow of a point on that surface; a point above or below it gets the shadow of the cloud the light comes through
// (the sky deck and the cloud shell are drawn the same way). The projection is snapped to whole texels of a lattice
// fixed to the world, so the shadows do not swim while the eye moves.

import type { Vec3 } from '../base/math.ts';
import type { EnvSlot } from '../base/env-slot.ts';

/** Name of the slot; the environment link switches `cloudLight` to the texture when a block holds it. */
export const CLOUD_SHADOW_SLOT = 'cloudShadow';
/** Texture unit of `u_cloudShadow` in every program (the link fixes the sampler to it). */
export const CLOUD_SHADOW_UNIT = 12;
/** Texels along each edge of the texture by default. */
export const CLOUD_SHADOW_SIZE = 512;
/** Edge of the texture's square by default, in cloud sizes (`CloudConfig.sizeM`): 24 × 2400 m = 57.6 km. */
export const CLOUD_SHADOW_EXTENT_CLOUDS = 24;

/** Where the texture lies: fixed while it is shown, made anew when it is drawn. */
export interface CloudShadowProjection {
  /** Centre of the square, relative to the reference point (see `CloudShadowParams.reference`). */
  origin: Vec3;
  /** Unit axes of the square across the light: texture x and y. */
  axisU: Vec3;
  axisV: Vec3;
  /** The axes with their part along up at the eye removed: they turn a drift of the pattern into a texture shift. */
  driftU: Vec3;
  driftV: Vec3;
  /** The pattern's drift (`FrameEnvironment.cloudX`, `cloudZ`) when the texture was drawn. */
  drift: readonly [number, number];
  /** Edge of the square in metres. */
  extentM: number;
}

/** What the layer hands the slot each frame. */
export interface CloudShadowParams {
  /** False: `cloudLight` computes the share everywhere (the texture is not read). */
  active: boolean;
  /** The eye in render space, or null (nothing is drawn). */
  eye: Vec3 | null;
  /**
   * The render-space point the projection is fixed to: the centre of radial up, or the world's origin (render space
   * minus `worldOrigin`) on a flat world, whose plane y = 0 holds the clouds' shadows.
   */
  reference: Vec3;
  /** Radius of the base sphere under radial up, null on a flat world. */
  radiusM: number | null;
  /** Edge of the square in metres; 0 = `CLOUD_SHADOW_EXTENT_CLOUDS` cloud sizes. */
  extentM: number;
  /** Texels along each edge. */
  size: number;
  /** Draw the texture in this frame: `compute` makes a new projection around the eye. */
  redraw: boolean;
  /** The projection the texture was last drawn with (the layer keeps it), null before the first draw. */
  last: CloudShadowProjection | null;
}

export interface CloudShadowValues {
  /** The projection in effect (null while nothing has been drawn). */
  projection: CloudShadowProjection | null;
  /** Centre of the square in render space. */
  origin: Vec3;
  /** Render-space y of the ground plane (flat worlds). */
  planeY: number;
  /** 1 when `cloudLight` reads the texture. */
  active: number;
  /** True when this frame draws the texture (with `projection`). */
  redraw: boolean;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * The projection of a texture drawn now. `eyeRel`: the eye relative to the reference point; `toLight`: unit direction
 * to the light; `radiusM`: the base sphere's radius, or null on a flat world; `drift`: the pattern's drift now. The
 * square is centred on the base surface under the eye, its centre snapped to whole texels (`extentM / size`) of a
 * lattice across the light fixed to the reference point: while the light stands still, every texel stays a line
 * through the same points of the world. Pure.
 */
export function cloudShadowProjection(eyeRel: Vec3, toLight: Vec3, radiusM: number | null, extentM: number, size: number, drift: readonly [number, number]): CloudShadowProjection {
  const L = unit(toLight);
  const up: Vec3 = radiusM !== null ? unit(eyeRel) : [0, 1, 0];
  const g: Vec3 = radiusM !== null ? [up[0] * radiusM, up[1] * radiusM, up[2] * radiusM] : [eyeRel[0], 0, eyeRel[2]];
  // An axis fixed to the world that is never along the light: the square turns only with the light.
  const a: Vec3 = Math.abs(L[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = unit(cross(a, L));
  const v = cross(L, u);
  const texel = extentM / size;
  const su = Math.round(dot(g, u) / texel) * texel;
  const sv = Math.round(dot(g, v) / texel) * texel;
  const sl = dot(g, L);
  const origin: Vec3 = [u[0] * su + v[0] * sv + L[0] * sl, u[1] * su + v[1] * sv + L[1] * sl, u[2] * su + v[2] * sv + L[2] * sl];
  const uu = dot(up, u);
  const vu = dot(up, v);
  return {
    origin,
    axisU: u,
    axisV: v,
    driftU: [u[0] - up[0] * uu, u[1] - up[1] * uu, u[2] - up[2] * uu],
    driftV: [v[0] - up[0] * vu, v[1] - up[1] * vu, v[2] - up[2] * vu],
    drift: [drift[0], drift[1]],
    extentM,
  };
}

/** The slot of the cloud shadow texture. Its members follow those of the cloud cover by place (orders 1300–1340). */
export function cloudShadowSlot(params?: Partial<CloudShadowParams>): EnvSlot<CloudShadowParams, CloudShadowValues> {
  return {
    name: CLOUD_SHADOW_SLOT,
    params: { active: false, eye: null, reference: [0, 0, 0], radiusM: null, extentM: 0, size: CLOUD_SHADOW_SIZE, redraw: false, last: null, ...params },
    fields: [
      { member: 'u_cloudShadowU', order: 1300, lanes: 'xyzw', doc: 'xyz texture x axis (across the light), w 1 / edge in metres' },
      { member: 'u_cloudShadowV', order: 1310, lanes: 'xyzw', doc: 'xyz texture y axis, w 1 = cloudLight reads the texture' },
      { member: 'u_cloudShadowO', order: 1320, lanes: 'xyzw', doc: 'xyz centre of the square in render space, w ground plane y (flat)' },
      { member: 'u_cloudShadowDU', order: 1330, lanes: 'xyzw', doc: 'xyz drift axis for texture x, w cloud drift x when drawn' },
      { member: 'u_cloudShadowDV', order: 1340, lanes: 'xyzw', doc: 'xyz drift axis for texture y, w cloud drift z when drawn' },
    ],
    compute(env, p) {
      const ref = p.reference;
      let projection = p.last;
      const redraw = p.active && p.eye !== null && (p.redraw || projection === null);
      if (redraw) {
        const extent = p.extentM > 0 ? p.extentM : CLOUD_SHADOW_EXTENT_CLOUDS * env.cloudSizeM;
        projection = cloudShadowProjection([p.eye![0] - ref[0], p.eye![1] - ref[1], p.eye![2] - ref[2]], env.toSun, p.radiusM, extent, Math.max(1, p.size), [env.cloudX, env.cloudZ]);
      }
      const o: Vec3 = projection ? projection.origin : [0, 0, 0];
      return {
        projection,
        origin: [ref[0] + o[0], ref[1] + o[1], ref[2] + o[2]],
        planeY: ref[1],
        active: p.active && projection !== null ? 1 : 0,
        redraw,
      };
    },
    lanes: (v) => {
      const p = v.projection;
      if (!p) return [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, v.planeY, 0, 0, 0, 0, 0, 0, 0, 0];
      return [
        p.axisU[0], p.axisU[1], p.axisU[2], 1 / p.extentM,
        p.axisV[0], p.axisV[1], p.axisV[2], v.active,
        v.origin[0], v.origin[1], v.origin[2], v.planeY,
        p.driftU[0], p.driftU[1], p.driftU[2], p.drift[0],
        p.driftV[0], p.driftV[1], p.driftV[2], p.drift[1],
      ];
    },
  };
}
