// The system's side of the marks (`installMarking` of wallhammer-web/platform): key K (N toggles the names here) while
// the camera is near a body, low enough for its surface to be streamed, and not on a flight or in the movie mode. For
// the dev server only: main.ts loads this file only when `import.meta.env.DEV` holds, so the static build of the live
// demos has none of it; a page driven by a script has none of it unless `#marks=1`. `#marks=0` hides the pins.
//
// It builds on the engine's host for a `FreeRig` (`engineMarkHost` of wallhammer-web/runtime) and changes three things:
//   - The view. The page keeps its own time (the ticks of the system, not the engine's clocks), so the clocks are not
//     recorded; the page's hash of the view (`hash`) carries the body, the place, the exact time `t` with `rate=0` and
//     the water's clock `flow`, and the rig's exact state follows as `mkview=`. Going to a mark first puts the page at
//     that hash (`gotoHash`: the body, its turning frame, the time stopped), then the rig back bit for bit. Before the
//     plan of Hearth is there its surface is the plain one, which may lift the camera to its clearance; the view is
//     put back once more when the plan's surface is there and the camera has not moved meanwhile.
//   - The pick. Near a body the camera's position is in the body's turning frame, whose origin is its centre, so a ray
//     marched (`gapPick`) against the height of that body's surface gives a point of its turning frame: the pin stays
//     on the ground as the body turns. Without a body near enough the mark mode is refused (`allowed`).
//   - The pins. A mark's point belongs to the body it was made on, but the marks of every body share the page. A pin
//     is drawn only while its point lies within a tenth of the radius of the base sphere of the body the camera is
//     near (the bodies' radii, 30 to 140 km, differ by more than that, and the relief is within it), and not behind
//     that body.
//
// The pick sees only the height of the surface (the plan's rivers and lakes included): not the trees, rocks, details,
// structures, creatures, clouds or the strips' own meshes, and a coarse level of the drawn mesh may stand off it.

import type { PickHit, Ray, Vec3 } from 'wallhammer-web/base';
import type { FreeRig } from 'wallhammer-web/camera';
import { hashParam, installMarking, pageMarking } from 'wallhammer-web/platform';
import type { MarkHost, MarkingApi } from 'wallhammer-web/platform';
import { engineMarkHost, gapPick, restoreRigView, rigViewText } from 'wallhammer-web/runtime';
import type { MarkEngine, MarkPick } from 'wallhammer-web/runtime';
import type { SphereWorld } from 'wallhammer-web/world';
import { latLonOf } from './world.ts';

/** The body the camera is near: its surface in its turning frame. */
export interface MarkBody {
  name: string;
  radiusM: number;
  shape: SphereWorld;
  /** Height of the surface at a point of the base sphere (the plan's where there is one). */
  heightAt(x: number, y: number, z: number): number;
}

/** What the marks need of the page (main.ts). */
export interface SystemMarkPage {
  /** The URL hash the page was opened with, without `#`: the page rewrites the address while the camera moves. */
  startHash: string;
  engine: MarkEngine;
  rig: FreeRig;
  /** The key (`KeyboardEvent.code`) of the mark mode. */
  key: string;
  /** The body whose surface is streamed round the camera, or null. */
  body(): MarkBody | null;
  /** Whether marking is possible now (a body near, no flight, no movie). */
  allowed(): boolean;
  /** The page's exact hash of the view: body, place, time to the tick, `rate=0`, `flow`. */
  hash(): string;
  /** Puts the page at a hash written by `hash`. */
  gotoHash(hash: string): void;
  /** False while the surface the pick and the clearance use is still the plain one of a planned body. */
  surfaceReady(): boolean;
  /** What the page knows of the moment of a mark. */
  facts(): Record<string, unknown>;
}

/** Share of a body's radius above which a ray that climbs meets nothing more, and within which its pins lie. */
const BAND = 0.1;

const r2 = (v: number): number => Math.round(v * 100) / 100;
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

export function installMarks(page: SystemMarkPage): MarkingApi | null {
  // What the address said when the page opened (`pageMarking` reads it as it stands now).
  const hash = page.startHash;
  const asked = hashParam(hash, 'marks');
  if (navigator.webdriver && asked !== '1') return null;
  const host = systemMarkHost(page);
  const text = hashParam(hash, 'mkview');
  if (text) host.goto({ hash, rig: text });
  return installMarking(host, { endpoint: pageMarking().endpoint, key: page.key, pins: asked !== '0' });
}

export function systemMarkHost(page: SystemMarkPage): MarkHost {
  const { rig, engine } = page;

  const pick: MarkPick = (ray, pixelGrowth) => {
    const b = page.body();
    if (!b) return null;
    const { shape, radiusM: R } = b;
    const top = BAND * R;
    const eyeAlt = Math.max(0, shape.altitude(ray.origin));
    // To the horizon of the eye over the base sphere and on to the highest ground beyond it.
    const horizon = Math.sqrt((R + eyeAlt) ** 2 - R * R) + Math.sqrt((R + top) ** 2 - R * R);
    return gapPick(
      (p) => {
        const d = shape.noiseDomain(p);
        return shape.altitude(p) - b.heightAt(d[0], d[1], d[2]);
      },
      {
        maxDistanceM: horizon + 1000,
        escaped: (p, r) => shape.altitude(p) > top && dot(r.dir, shape.directionOf(p)) > 0,
        surface: `surface of ${b.name}`,
        place: (p) => {
          const [lat, lon] = latLonOf(shape.directionOf(p));
          return { body: b.name, lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), heightM: r2(shape.altitude(p)) };
        },
        misses: 'trees, rocks, details, structures, creatures, clouds, the strips’ meshes; a coarse level may stand off the height',
      },
    )(ray, pixelGrowth);
  };

  const base = engineMarkHost(engine, {
    pick,
    key: page.key,
    clocks: false,
    hash: page.hash,
    allowed: page.allowed,
    view: () => {
      const b = page.body();
      if (!b) return {};
      const [lat, lon] = latLonOf(b.shape.directionOf(rig.position));
      return { body: b.name, lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), heightM: r2(rig.clearance) };
    },
    facts: (hit: PickHit | null, ray: Ray) => ({
      body: page.body()?.name ?? null,
      eyeHeightM: r2(rig.clearance),
      ...page.facts(),
      ...(hit ? { details: 'unknown (the pick sees only the height of the surface)' } : { hit: 'none: the ray met no surface of the body within its horizon' }),
      eyeM: ray.origin.map(r2),
    }),
    hidden: (w: Vec3, eye: Vec3) => {
      const b = page.body();
      if (!b) return true;
      const R = b.radiusM;
      // A mark of another body.
      if (Math.abs(Math.hypot(w[0], w[1], w[2]) - R) > BAND * R) return true;
      // Behind the body: the line from the eye to the point dips under its base sphere on the way.
      const v: Vec3 = [w[0] - eye[0], w[1] - eye[1], w[2] - eye[2]];
      const s = Math.min(1, Math.max(0, -dot(eye, v) / dot(v, v)));
      return s > 0 && s < 1 && Math.hypot(eye[0] + v[0] * s, eye[1] + v[1] * s, eye[2] + v[2] * s) < R - 50;
    },
  });

  /** A view put back before the plan's surface was there, and the rig's state right after; put back once more then. */
  let again: { hash: string; rig: string; after: string } | null = null;
  engine.renderer.beforeFrame.unshift(() => {
    if (!again || !page.surfaceReady()) return;
    const a = again;
    again = null;
    // Moved meanwhile (keys, a flight): the developer's view wins.
    if (rigViewText(rig) !== a.after) return;
    page.gotoHash(a.hash);
    restoreRigView(rig, a.rig);
  });

  return {
    ...base,
    goto: (v) => {
      page.gotoHash(v.hash);
      base.goto(v);
      again = typeof v.rig === 'string' && !page.surfaceReady() ? { hash: v.hash, rig: v.rig, after: rigViewText(rig) } : null;
    },
  };
}
