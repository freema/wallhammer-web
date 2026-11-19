// Cloud cover by place, an opt-in environment slot for radial up. Without it the cloud cover is one number for the
// whole world (`weather.cloudCover`). With it the cover over a place is a profile by the angle between the place's up
// and an axis, plus drifting patches; the shadow pattern over it is the engine's cloud field. The frame's light stays
// dimmed by the global cover, so the shader divides by that dimming: a constant field equal to `weather.cloudCover`
// gives the picture without the slot.
// The slot has no GLSL of its own: the functions arrive with the lighting include (`lightingGlsl({ cloudField: true })`),
// which the environment link registers when the block holds a slot of this name.

import { clamp, smoothstep } from '../base/math.ts';
import type { Vec3 } from '../base/math.ts';
import type { EnvSlot } from '../base/env-slot.ts';
import { cloudCoverTerms, cloudDeckClosed } from './environment.ts';

/** A cloud cover that varies by place. */
export interface CloudCoverField {
  /** Unit axis in the frame the field is fixed in (the frame of radial up). */
  axis: Vec3;
  /** 8 covers 0–1 at |dot(up, axis)| = 0, 1/7 … 1, linear between. */
  zonal: readonly number[];
  /** 0–1: how far patches move the cover up and down. */
  patchAmount: number;
  /** Size of the patches in metres. */
  patchSizeM: number;
  /** 0 = none: one more lookup bends the patches, in patch sizes. */
  patchWarp: number;
  /** Metres the patch pattern has drifted (the app moves it with its time). */
  patchOffset: Vec3;
  /** Darkness of the cloud shadows, as `CloudConfig.darkness`. */
  darkness: number;
}

/** What the slot hands the Frame block each frame. */
export interface CloudFieldValues {
  axis: Vec3;
  patchAmount: number;
  patchOffset: Vec3;
  invPatchSize: number;
  zonal: readonly number[];
  darkness: number;
  /** Share of the sun the frame's light keeps under the global cover (`G`). */
  frameSun: number;
  patchWarp: number;
  /** 0 when every cover is 0: the shader then returns full sun without a lookup. */
  active: number;
}

/** Name of the slot; the environment link switches the lighting include when a block holds it. */
export const CLOUD_FIELD_SLOT = 'cloudField';

function zonalAt(zonal: readonly number[], a: number): number {
  let c = 0;
  for (let k = 0; k < 8; k++) c += (zonal[k] ?? 0) * Math.max(1 - Math.abs(a - k), 0);
  return c;
}

/** The slot of a cloud cover by place. Its members follow those of the sky and the atmosphere (orders 1200–1240). */
export function cloudFieldSlot(params: CloudCoverField): EnvSlot<CloudCoverField, CloudFieldValues> {
  return {
    name: CLOUD_FIELD_SLOT,
    params,
    fields: [
      { member: 'u_cloudFieldAxis', order: 1200, lanes: 'xyzw', doc: 'xyz axis of the cover profile, w patch amount' },
      { member: 'u_cloudFieldPatch', order: 1210, lanes: 'xyzw', doc: 'xyz patch drift in metres, w 1 / patch size' },
      { member: 'u_cloudFieldZonalA', order: 1220, lanes: 'xyzw', doc: 'covers at |up · axis| 0, 1/7, 2/7, 3/7' },
      { member: 'u_cloudFieldZonalB', order: 1230, lanes: 'xyzw', doc: 'covers at |up · axis| 4/7, 5/7, 6/7, 1' },
      { member: 'u_cloudFieldLight', order: 1240, lanes: 'xyzw', doc: 'x shadow darkness, y sun share of the frame, z warp, w 0 = no cover' },
    ],
    compute(env, p) {
      const zonal = Array.from({ length: 8 }, (_, k) => clamp(p.zonal[k] ?? 0, 0, 1));
      const any = zonal.some((z) => z > 0) || p.patchAmount > 0;
      return {
        axis: p.axis,
        patchAmount: clamp(p.patchAmount, 0, 1),
        patchOffset: p.patchOffset,
        invPatchSize: p.patchSizeM > 0 ? 1 / p.patchSizeM : 0,
        zonal,
        darkness: p.darkness,
        frameSun: cloudCoverTerms(env.cloudCover, p.darkness).sunShare,
        patchWarp: Math.max(p.patchWarp, 0),
        active: any ? 1 : 0,
      };
    },
    lanes: (v) => [
      v.axis[0], v.axis[1], v.axis[2], v.patchAmount,
      v.patchOffset[0], v.patchOffset[1], v.patchOffset[2], v.invPatchSize,
      v.zonal[0]!, v.zonal[1]!, v.zonal[2]!, v.zonal[3]!,
      v.zonal[4]!, v.zonal[5]!, v.zonal[6]!, v.zonal[7]!,
      v.darkness, v.frameSun, v.patchWarp, v.active,
    ],
  };
}

// --- The integer hash and value noise of the shader include `noise`, repeated in TypeScript ----------------------

function hashU(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function hash3(x: number, y: number, z: number, seed: number): number {
  const hz = hashU(((z >>> 0) + seed) >>> 0);
  const hy = hashU((Math.imul(y >>> 0, 0xc2b2ae35) ^ hz) >>> 0);
  return hashU((Math.imul(x >>> 0, 0x9e3779b1) ^ hy) >>> 0) / 4294967296;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function vnoise3(px: number, py: number, pz: number, seed: number): number {
  const fx = Math.floor(px), fy = Math.floor(py), fz = Math.floor(pz);
  let tx = px - fx, ty = py - fy, tz = pz - fz;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  tz = tz * tz * (3 - 2 * tz);
  const ix = fx | 0, iy = fy | 0, iz = fz | 0;
  const a = mix(hash3(ix, iy, iz, seed), hash3(ix + 1, iy, iz, seed), tx);
  const b = mix(hash3(ix, iy + 1, iz, seed), hash3(ix + 1, iy + 1, iz, seed), tx);
  const c = mix(hash3(ix, iy, iz + 1, seed), hash3(ix + 1, iy, iz + 1, seed), tx);
  const d = mix(hash3(ix, iy + 1, iz + 1, seed), hash3(ix + 1, iy + 1, iz + 1, seed), tx);
  return mix(mix(a, b, ty), mix(c, d, ty), tz);
}

/** The shader's cloud cover 0–1 at unit up `up` on a sphere of radius `radiusM`, in the frame of the field. */
export function cloudFieldCover(f: CloudCoverField, up: Vec3, radiusM: number): number {
  const a = Math.abs(up[0] * f.axis[0] + up[1] * f.axis[1] + up[2] * f.axis[2]) * 7;
  let c = zonalAt(f.zonal.map((z) => clamp(z, 0, 1)), a);
  const amount = clamp(f.patchAmount, 0, 1);
  if (amount > 0 && f.patchSizeM > 0) {
    const inv = 1 / f.patchSizeM;
    let qx = (up[0] * radiusM - f.patchOffset[0]) * inv;
    let qy = (up[1] * radiusM - f.patchOffset[1]) * inv;
    let qz = (up[2] * radiusM - f.patchOffset[2]) * inv;
    if (f.patchWarp > 0) {
      const w = f.patchWarp * (vnoise3(qx * 0.6 + 31, qy * 0.6 + 31, qz * 0.6 + 31, 73) - 0.5);
      qx += w;
      qy += w;
      qz += w;
    }
    const p = 0.65 * vnoise3(qx, qy, qz, 71) + 0.35 * vnoise3(qx * 2.3 + 17, qy * 2.3 + 17, qz * 2.3 + 17, 72);
    c += amount * (2 * p - 1);
  }
  return clamp(c, 0, 1);
}

/**
 * Sun share S under a cloud cover where the shadow pattern has the value `noise` (0–1): the pattern's darkness and
 * thresholds and the overcast dimming of `cloudCoverTerms` for that cover. Under a closing deck (cover from 0.7 to
 * 0.78) the pattern's gaps close too, so from 0.78 the share no longer depends on `noise`.
 */
export function cloudFieldSun(cover: number, noise: number, darkness: number): number {
  const t = cloudCoverTerms(cover, darkness);
  const s = smoothstep(t.lo, t.hi, noise);
  return (1 - t.darkness * (s + (1 - s) * cloudDeckClosed(cover))) * t.sunShare;
}
