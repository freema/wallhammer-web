// The planet's side of the marks (examples/shared/src/marks/): key N in the free camera, for the dev server only.
// main.ts loads this file only when `import.meta.env.DEV` holds, so the static build of the live demos has none of it;
// a page driven by a script (navigator.webdriver: the shot tools, the benchmarks) has none of it unless `#marks=1`.
// `#marks=0` hides the pins. `window.__wh.marks` is the script interface (`MarkingApi`).
//
// The pick is a ray marched on the CPU (`marchRay` of wallhammer-web/world) against the same height functions the
// terrain is built from: the top of land or water (`groundAt`, the sea at level 0), and from under the sea its floor
// and its level seen from below. It does not see the plants and rocks, the waves, the clouds or the strips' own
// meshes, and the drawn mesh of a coarser level may stand off the height function by its screen error.

import type { Vec3 } from 'wallhammer-web/base';
import type { FreeRig } from 'wallhammer-web/camera';
import { marchRay } from 'wallhammer-web/world';
import type { MarkHost, MarkView, PickHit, Ray } from '../../shared/src/marks/types.ts';
import { installMarking } from '../../shared/src/marks/ui.ts';
import type { MarkingApi } from '../../shared/src/marks/ui.ts';
import { RADIUS_M, SHAPE, latLonOf } from './world.ts';

/** What the marks need of the page (main.ts). */
export interface PlanetMarkPage {
  canvas: HTMLCanvasElement;
  rig: FreeRig;
  seed: number;
  params: URLSearchParams;
  /** The store's URL path. */
  endpoint: string;
  /** Height of the top of land or water, and of the ground itself (negative under the sea), at a point of the base sphere. */
  groundAt(x: number, y: number, z: number): number;
  floorAt(x: number, y: number, z: number): number;
  /** Whether the user steers the camera now (no flight, no movie). */
  free(): boolean;
  /** The page's URL hash of the current view, precise enough to put the camera back within millimetres. */
  exactHash(): string;
  /** The hour and the animation time. */
  hour(): number;
  timeS(): number;
  /** Puts the camera at the view of a hash written by `exactHash`. */
  gotoHash(hash: string): void;
  renderNow(): void;
  invalidate(): void;
  onFrame(f: () => void): void;
}

/** Above the highest ground of the planet with room to spare: a ray above it that climbs meets nothing. */
const TOP_M = 8000;

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const norm = (a: readonly number[]): Vec3 => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};
const r2 = (v: number): number => Math.round(v * 100) / 100;

export function installMarks(page: PlanetMarkPage): MarkingApi | null {
  const q = page.params;
  if (navigator.webdriver && q.get('marks') !== '1') return null;
  const api = installMarking(planetMarkHost(page), { endpoint: page.endpoint, key: 'KeyN', pins: q.get('marks') !== '0' });
  Object.assign((window as unknown as { __wh: object }).__wh, { marks: api });
  return api;
}

export function planetMarkHost(page: PlanetMarkPage): MarkHost {
  const { rig } = page;
  const top = (b: readonly number[]): number => page.groundAt(b[0]!, b[1]!, b[2]!);
  const floor = (b: readonly number[]): number => page.floorAt(b[0]!, b[1]!, b[2]!);

  /** Signed gap from a point to the first surface the eye's ray meets, positive on the eye's side. */
  const gapAt = (p: Vec3, under: boolean): number => {
    const alt = SHAPE.altitude(p);
    const b = SHAPE.noiseDomain(p);
    // Under the sea: its floor, or its level from below.
    return under ? Math.min(alt - floor(b), -alt) : alt - top(b);
  };

  /** Metres a pixel covers at a distance, for the canvas's height. */
  const metresPerPixel = (distM: number): number => (2 * distM * Math.tan((rig.setup.fovYDeg * Math.PI) / 360)) / Math.max(1, rig.height);

  const pick = (ray: Ray): PickHit | null => {
    const eyeAlt = SHAPE.altitude(ray.origin);
    const under = eyeAlt < 0;
    const horizon = Math.sqrt(Math.max(0, (RADIUS_M + Math.max(0, eyeAlt)) ** 2 - RADIUS_M ** 2)) + Math.sqrt((RADIUS_M + TOP_M) ** 2 - RADIUS_M ** 2);
    const hit = marchRay(ray, (p) => gapAt(p, under), {
      maxDistanceM: under ? 2000 : horizon + 1000,
      // The least step stays under half a pixel at every distance.
      stepPerM: 0.5 * metresPerPixel(1),
      escaped: (p) => SHAPE.altitude(p) > TOP_M && dot(ray.dir, SHAPE.directionOf(p)) > 0,
    });
    if (!hit) return null;
    const p = hit.point;
    const alt = SHAPE.altitude(p);
    const b = SHAPE.noiseDomain(p);
    const g = floor(b);
    const surface = under ? (alt - g <= -alt ? 'sea floor' : 'sea level from below') : g < 0 ? 'sea level' : 'ground';
    const [lat, lon] = latLonOf(SHAPE.directionOf(p));
    return {
      world: p,
      distanceM: r2(hit.distanceM),
      surface,
      place: { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), heightM: r2(alt) },
      accuracy: {
        method: 'cpu ray march (marchRay) against groundAt, the sea at level 0 and floorAt; halving to 5 mm',
        steps: hit.steps,
        lastStepM: r2(hit.lastStepM),
        metresPerPixel: Number(metresPerPixel(hit.distanceM).toPrecision(3)),
        misses: 'plants, rocks, waves, clouds, the strips’ meshes; a coarse level may stand off the height function',
      },
    };
  };

  const view = (): MarkView => {
    const s = rig.state();
    const [lat, lon] = latLonOf(SHAPE.directionOf(rig.position));
    return { hash: page.exactHash(), lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), yawDeg: Number(s.yawDeg.toFixed(3)), pitchDeg: Number(s.pitchDeg.toFixed(3)), fovYDeg: rig.setup.fovYDeg, hour: Number(page.hour().toFixed(4)), timeS: r2(page.timeS()) };
  };

  const facts = (hit: PickHit | null, ray: Ray): Record<string, unknown> => {
    const out: Record<string, unknown> = { seed: page.seed, eyeUnderSea: SHAPE.altitude(ray.origin) < 0 };
    if (!hit) {
      out.hit = 'none: the ray met no ground or sea within the horizon';
      return out;
    }
    const d = SHAPE.directionOf(hit.world);
    const b = SHAPE.noiseDomain(hit.world);
    const g = floor(b);
    // The slope over two metres, from the height of the ground one metre to each side along two tangents.
    const e1 = norm(Math.abs(d[1]) < 0.9 ? [d[2], 0, -d[0]] : [0, -d[2], d[1]]);
    const e2: Vec3 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    const at = (e: Vec3, m: number): number => {
      const q2 = norm([d[0] + (e[0] * m) / RADIUS_M, d[1] + (e[1] * m) / RADIUS_M, d[2] + (e[2] * m) / RADIUS_M]);
      return floor([q2[0] * RADIUS_M, q2[1] * RADIUS_M, q2[2] * RADIUS_M]);
    };
    const sx = (at(e1, 1) - at(e1, -1)) / 2;
    const sy = (at(e2, 1) - at(e2, -1)) / 2;
    out.ground = { heightM: r2(g), slopeDeg: r2((Math.atan(Math.hypot(sx, sy)) * 180) / Math.PI), slopeOverM: 2 };
    out.sea = g < 0 ? { depthM: r2(-g) } : 'dry';
    out.plantsAndRocks = 'unknown (the pick does not see them)';
    return out;
  };

  return {
    canvas: page.canvas,
    allowed: page.free,
    size: () => [rig.width, rig.height],
    ray: (px, py) => {
      const p = rig.position;
      return { origin: [p[0], p[1], p[2]], dir: norm(rig.screenRay(px, py).dir) };
    },
    toScreen: (w) => {
      const p = rig.position;
      const v = sub(w, p);
      if (dot(v, rig.axes().forward) <= 0) return null;
      // Behind the planet: the line from the eye to the point dips under the sea's level on the way (a hill on the
      // way is not looked at; a pin behind it stays drawn).
      const e = sub(p, SHAPE.centerM);
      const s = Math.min(1, Math.max(0, -dot(e, v) / dot(v, v)));
      if (s > 0 && s < 1 && Math.hypot(e[0] + v[0] * s, e[1] + v[1] * s, e[2] + v[2] * s) < RADIUS_M - 50) return null;
      const o = rig.origin;
      return rig.project([w[0] - o[0], w[1] - o[1], w[2] - o[2]]);
    },
    pick,
    view,
    facts,
    renderNow: page.renderNow,
    invalidate: page.invalidate,
    onFrame: page.onFrame,
    goto: (v) => page.gotoHash(v.hash),
  };
}
