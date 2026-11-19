// A clear medium that fills everything below a level (the base sphere of a radial world, or a height of a flat one)
// and dims and tints what is seen through it.
//
// Light that crosses `d` metres of the medium keeps `exp(-extinction * d)` of itself per colour channel, and the
// medium adds its own scattered light by the share that was lost (`mediumApply`), so far enough everything takes the
// medium's colour. The functions take heights relative to the level instead of positions, so the same arithmetic
// serves a sphere (`localHeight(p)` minus the level) and a plane (`p.y` minus the level): a straight segment between
// two points is taken as linear in height, which is exact on a plane and close on a sphere over the distances a
// medium lets one see through. `mediumFresnel` is the share of light the boundary reflects, with the total
// reflection seen from the denser side.
//
// The engine does not know what the medium is or how it is drawn; the content chooses the level, the colours and
// the extinction, and calls these from its materials. `mediumPath`, `mediumThrough` and `mediumFresnel` exist here
// and, with the same names and arithmetic, in `MEDIUM_GLSL`. `mediumApply` is GLSL only (a shader applies the medium
// to a colour) and `mediumClearDistance` is TypeScript only (the CPU places what stands beyond the clear distance).

import type { RGB } from '../base/index.ts';

/**
 * Length in metres of the part of a straight segment `lengthM` long that lies below the level, when its ends stand
 * `fromHeight` and `toHeight` metres above the level (negative: below) and the height changes linearly along it.
 */
export function mediumPath(fromHeight: number, toHeight: number, lengthM: number): number {
  if (fromHeight >= 0 && toHeight >= 0) return 0;
  if (fromHeight <= 0 && toHeight <= 0) return lengthM;
  // One end above, one below: the share of the segment on the side below.
  const below = fromHeight < 0 ? fromHeight : toHeight;
  return (lengthM * -below) / Math.abs(toHeight - fromHeight);
}

/** Share of light per channel that passes `lengthM` metres of a medium with the given extinction per metre. */
export function mediumThrough(extinction: RGB, lengthM: number): [number, number, number] {
  const d = Math.max(0, lengthM);
  return [Math.exp(-extinction[0] * d), Math.exp(-extinction[1] * d), Math.exp(-extinction[2] * d)];
}

/**
 * Distance in metres at which every channel has fallen to `share` (0–1) or less: beyond it the medium's own colour
 * covers what lies there to within that share.
 */
export function mediumClearDistance(extinction: RGB, share: number): number {
  const least = Math.min(extinction[0], extinction[1], extinction[2]);
  return least > 0 ? -Math.log(Math.min(1, Math.max(1e-9, share))) / least : Infinity;
}

/**
 * Share of light the boundary reflects (Schlick's approximation) for light meeting it at the cosine `cosI` from the
 * normal, coming from the side whose refractive index is `eta` times that of the other side. From the denser side
 * (`eta` > 1) beyond the critical angle all of it is reflected.
 */
export function mediumFresnel(cosI: number, eta: number): number {
  const c = Math.min(1, Math.abs(cosI));
  const r0 = ((eta - 1) / (eta + 1)) ** 2;
  let k = c;
  if (eta > 1) {
    // The cosine on the far side; below 0 under the root the light does not cross.
    const sin2 = eta * eta * (1 - c * c);
    if (sin2 >= 1) return 1;
    k = Math.sqrt(1 - sin2);
  }
  return r0 + (1 - r0) * (1 - k) ** 5;
}

/** GLSL of `mediumPath`, `mediumThrough` and `mediumFresnel` above, plus `mediumApply` (any shader stage; needs nothing before it). */
export const MEDIUM_GLSL = /* glsl */ `
float mediumPath(float fromHeight, float toHeight, float lengthM) {
  if (fromHeight >= 0.0 && toHeight >= 0.0) return 0.0;
  if (fromHeight <= 0.0 && toHeight <= 0.0) return lengthM;
  float below = fromHeight < 0.0 ? fromHeight : toHeight;
  return lengthM * -below / abs(toHeight - fromHeight);
}
vec3 mediumThrough(vec3 extinction, float lengthM) {
  return exp(-extinction * max(lengthM, 0.0));
}
// A colour seen through lengthM metres of the medium: dimmed by it, and its own light (inscatter, the colour the
// medium takes where nothing shows through) added by the share that was lost.
vec3 mediumApply(vec3 color, vec3 inscatter, vec3 extinction, float lengthM) {
  vec3 t = mediumThrough(extinction, lengthM);
  return color * t + inscatter * (1.0 - t);
}
float mediumFresnel(float cosI, float eta) {
  float c = min(abs(cosI), 1.0);
  float r0 = (eta - 1.0) / (eta + 1.0);
  r0 *= r0;
  float k = c;
  if (eta > 1.0) {
    float sin2 = eta * eta * (1.0 - c * c);
    if (sin2 >= 1.0) return 1.0;
    k = sqrt(1.0 - sin2);
  }
  float f = 1.0 - k;
  return r0 + (1.0 - r0) * f * f * f * f * f;
}
`;
