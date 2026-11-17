// Environment slots of this module: the season of the year (`u_season`, foliage and grass) and where snow settles. The
// app registers them with the engine (`assembleFrameBlock`); the terrain shader reads the season member and includes
// the snow GLSL. The vegetation shader of gen-vegetation reads the same two slots; they live here so that the ground
// does not depend on the vegetation.

import { smoothstep } from '../base/index.ts';
import type { EnvSlot } from '../base/index.ts';

/**
 * When broadleaf trees leaf out, change colour and shed, in days of the year. Defaults correspond to the Central European
 * lowlands and uplands. Conifers do not change.
 */
export interface PhenologyConfig {
  /** Leaf-out: from when to when the canopy thickens. */
  leafOutStart: number;
  leafOutEnd: number;
  /** Until when the foliage is fresh spring green. */
  springEnd: number;
  /** Colouring: start and peak. */
  colorStart: number;
  colorPeak: number;
  /** Leaf fall: start and bare canopies. */
  dropStart: number;
  dropEnd: number;
  /** Grass: when it turns green and when it starts to dry and brown. */
  grassGreenStart: number;
  grassGreenEnd: number;
  grassBrownStart: number;
  grassBrownEnd: number;
}

/** Vegetation state on one day of the year. Everything 0–1. */
export interface SeasonState {
  /** Broadleaf foliage: 1 full canopies, 0 bare branches. */
  leafDensity: number;
  /** Autumn leaf colouring. */
  autumn: number;
  /** Fresh spring green. */
  fresh: number;
  /** Grass outside the growing season: faded and brownish. */
  dormancy: number;
}

export const DEFAULT_PHENOLOGY: PhenologyConfig = {
  leafOutStart: 95,
  leafOutEnd: 132,
  springEnd: 165,
  colorStart: 262,
  colorPeak: 296,
  dropStart: 288,
  dropEnd: 322,
  grassGreenStart: 72,
  grassGreenEnd: 112,
  grassBrownStart: 285,
  grassBrownEnd: 335,
};

/** Vegetation state on a given day of the year (1–366). Pure function. */
export function seasonAt(dayOfYear: number, p: PhenologyConfig = DEFAULT_PHENOLOGY): SeasonState {
  const d = dayOfYear;
  const leafDensity = Math.min(smoothstep(p.leafOutStart, p.leafOutEnd, d), 1 - smoothstep(p.dropStart, p.dropEnd, d));
  const autumn = d > (p.leafOutEnd + p.colorStart) / 2 ? smoothstep(p.colorStart, p.colorPeak, d) : 0;
  const fresh = smoothstep(p.leafOutStart, p.leafOutEnd - 8, d) * (1 - smoothstep(p.leafOutEnd, p.springEnd, d));
  const dormancy = Math.max(1 - smoothstep(p.grassGreenStart, p.grassGreenEnd, d), smoothstep(p.grassBrownStart, p.grassBrownEnd, d));
  return { leafDensity, autumn, fresh, dormancy };
}

/**
 * Season slot: `u_season` from the day of year. Foliage density changes how much light passes through canopies, so it
 * is part of the shadow key. Order 65 places the member between the engine's weather and fog colour members.
 */
export function seasonSlot(phenology: Partial<PhenologyConfig> = {}): EnvSlot<PhenologyConfig, SeasonState> {
  return {
    name: 'season',
    params: { ...DEFAULT_PHENOLOGY, ...phenology },
    fields: [{ member: 'u_season', order: 65, lanes: 'xyzw', doc: 'x broadleaf foliage, y autumn colour, z spring freshness, w grass outside the growing season' }],
    compute: (env, p) => seasonAt(env.dayOfYear, p),
    lanes: (s) => [s.leafDensity, s.autumn, s.fresh, s.dormancy],
    shadowKey: (s) => s.leafDensity.toFixed(3),
  };
}

/**
 * Snow slot: `snowOn`, how much snow lies on a surface. Only on upward-facing surfaces; the edge of the cover is
 * irregular according to world-anchored noise. It has no Frame members of its own and reads the engine's snow cover.
 * Shaders include it with `#include <snow>` after `lighting`.
 */
export function snowSlot(): EnvSlot<null, null> {
  return {
    name: 'snow',
    params: null,
    fields: [],
    compute: () => null,
    lanes: () => [],
    glsl: SNOW_GLSL,
  };
}

const SNOW_GLSL = /* glsl */ `
// How much snow lies on a surface with normal n: only on upward-facing surfaces, the edge of the cover is irregular
// according to world-anchored noise. bias shifts the threshold: positive = snow lies here longer (roof), negative = it
// vanishes sooner (road). Returns 0–1.
float snowOn(vec3 worldPos, vec3 n, float bias) {
  float s = u_weather.x;
  if (s <= 0.0) return 0.0;
#ifdef WH_LOCAL_UP
  // Up is radial: "upward-facing" is measured against the local up, and the pattern is a field in space.
  float up = smoothstep(0.45, 0.85, dot(n, localUp(worldPos)));
  vec3 sp = worldPos - u_upCenter.xyz;
  float patchN = 0.65 * vnoise3(sp / 7.0, 71u) + 0.35 * vnoise3(sp / 1.7, 72u);
#else
  float up = smoothstep(0.45, 0.85, n.y);
  float patchN = 0.65 * vnoise(worldPos.xz / 7.0, 71u) + 0.35 * vnoise(worldPos.xz / 1.7, 72u);
#endif
  patchN = mix(0.5, patchN, 0.4 + 0.6 * detailVisible(1.7));
  // Cover s goes from 0 (nothing) through patchy spots to 1 (everywhere).
  float t = s * 1.25 + bias - 0.12;
  return up * smoothstep(patchN - 0.12, patchN + 0.12, t);
}
`;

