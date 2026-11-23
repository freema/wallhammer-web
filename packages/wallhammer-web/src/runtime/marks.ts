// Marks for the engine's own cameras: a ready `MarkHost` (`installMarking` of platform) for an engine that draws
// through a `FreeRig` or a `FollowRig`, so a page needs one call (`installEngineMarking`) and a pick.
//
// The host reads the engine's current view on every call: marking is possible while it is one of the two rigs (an
// engine that switches views with `setView` gets the marks wherever it draws through one). A mark's view records the
// rig's state as text (`rigViewText`) in shortest round-trip numbers, so `restoreRigView` puts the rig back bit for
// bit, and the animation clocks (the hour and the animation time). Its URL hash is the page's own hash (which rebuilds
// the scene) with that text added as `mkview=` and the clocks as `mkclock=`; `installEngineMarking` reads them from the
// address when the page opens, so a tool that opens `page#hash` sees the very view.
//
// A following view is the rig's own state (the followed point, the pivot, yaw, pitch, the wanted and the drawn boom).
// The followed point belongs to the caller, who moves it every frame: without `placeTarget` a restored view holds only
// until the caller's next `follow`; with it the caller puts the followed thing back first. A pivot that was trailing a
// moving point is restored as it was, and the next `update` lets it close the gap again.
//
// The pick is the caller's: a function from a ray in world metres to a hit (`MarkPick`), or one made here from a gap
// function (`gapPick`), a height function over a flat world with +y up (`heightPick`) or a collision world
// (`collisionPick`). It sees only what that surface describes.

import type { MarkView, PickHit } from '../base/marks.ts';
import type { Vec3 } from '../base/math.ts';
import type { Ray, View } from '../base/view.ts';
import { FollowRig } from '../camera/follow.ts';
import { FreeRig } from '../camera/free.ts';
import type { Clock } from '../core/clock.ts';
import type { Canvas } from '../platform/canvas.ts';
import type { MarkHost } from '../platform/marks/host.ts';
import { hashParam, pageMarking } from '../platform/marks/page.ts';
import { installMarking } from '../platform/marks/ui.ts';
import type { MarkingApi } from '../platform/marks/ui.ts';
import { newRayHit } from '../world/collide.ts';
import type { CollisionWorld } from '../world/collide.ts';
import { marchRay } from '../world/march.ts';

/** A camera the marks can read and put back. */
export type MarkRig = FreeRig | FollowRig;

/**
 * The point a ray in world metres meets, or null. `pixelGrowth` is the view's metres per pixel gained per metre of
 * distance: a pick that steps keeps its least step under half a pixel with `0.5 * pixelGrowth` per metre.
 */
export type MarkPick = (ray: Ray, pixelGrowth: number) => PickHit | null;

/** The part of an `Engine` the marks use. */
export interface MarkEngine {
  readonly canvas: Canvas;
  readonly view: View;
  readonly env: { readonly day: Clock; readonly time: Clock };
  readonly renderer: { readonly beforeFrame: ((view: View) => void)[] };
  renderNow(): void;
  invalidate(): void;
}

export interface EngineMarkingOptions {
  /** The point under a click (`heightPick`, `collisionPick`, `gapPick` or the caller's own). */
  pick: MarkPick;
  /** The key (`KeyboardEvent.code`) that switches the mark mode; default `KeyN`. */
  key?: string;
  /** The store's URL path; default `__marks` in the folder of the page's path (`pageMarking`). */
  endpoint?: string;
  /** Whether the pins are drawn; default unless the hash says `marks=0`. */
  pins?: boolean;
  /**
   * The page's own URL hash (without `#`) that rebuilds its scene: seed, place, settings. The marks add the exact
   * view to it. Default the address bar's hash as it stands.
   */
  hash?(): string;
  /**
   * Puts the point a `FollowRig` follows back where a mark's view had it (the caller moves the followed thing there),
   * before the view is restored. Without it a restored following view holds until the caller's next `follow`.
   */
  placeTarget?(target: Vec3): void;
  /** Whether marking is possible now, besides the engine drawing through a `FreeRig` or a `FollowRig`. */
  allowed?(): boolean;
  /** What is known of the picked place (or, for a miss, of the view); default the camera and the eye. */
  facts?(hit: PickHit | null, ray: Ray): Record<string, unknown>;
  /** Further fields of a mark's view (a page's own coordinates of the eye, say). */
  view?(): Record<string, unknown>;
  /** Whether a mark's view records and restores the hour and the animation time; default true. */
  clocks?: boolean;
  /** True where a world point is hidden from the eye (behind a sphere, say): its pin is not drawn. */
  hidden?(world: Vec3, eye: Vec3): boolean;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const num = (v: number): string => String(v);

/** The rig among the engine's view, or null when it draws through another kind of view. */
function rigOf(view: View): MarkRig | null {
  return view instanceof FreeRig || view instanceof FollowRig ? view : null;
}

/**
 * The exact view of a rig as text: `free,x,y,z,yawDeg,pitchDeg,roll` or
 * `follow,tx,ty,tz,px,py,pz,yawDeg,pitchDeg,distance,boom`, numbers in their shortest round-trip form.
 */
export function rigViewText(rig: MarkRig): string {
  if (rig instanceof FreeRig) {
    const s = rig.state();
    return ['free', ...s.position, s.yawDeg, s.pitchDeg, rig.roll].map(String).join(',');
  }
  const s = rig.state();
  return ['follow', ...s.target, ...s.pivot, s.yawDeg, s.pitchDeg, s.distance, s.boom].map(String).join(',');
}

/**
 * Puts a rig at a view written by `rigViewText`; false (and nothing changed) when the text is not a view of this kind
 * of rig. A following view calls `placeTarget` with the followed point first.
 */
export function restoreRigView(rig: MarkRig, text: string, placeTarget?: (target: Vec3) => void): boolean {
  const parts = text.split(',');
  const n = parts.slice(1).map(Number);
  if (!n.every(Number.isFinite)) return false;
  if (rig instanceof FreeRig) {
    if (parts[0] !== 'free' || n.length !== 6) return false;
    rig.setState({ position: [n[0]!, n[1]!, n[2]!], yawDeg: n[3]!, pitchDeg: n[4]! });
    rig.roll = n[5]!;
    return true;
  }
  if (parts[0] !== 'follow' || n.length !== 10) return false;
  const target: Vec3 = [n[0]!, n[1]!, n[2]!];
  placeTarget?.(target);
  rig.setState({ target, pivot: [n[3]!, n[4]!, n[5]!], yawDeg: n[6]!, pitchDeg: n[7]!, distance: n[8]!, boom: n[9]! });
  return true;
}

/** A URL hash (`k=v&…`) without the given parameters. */
function without(hash: string, names: readonly string[]): string {
  return hash
    .replace(/^#/, '')
    .split('&')
    .filter((p) => p !== '' && !names.includes(p.slice(0, p.indexOf('=') < 0 ? p.length : p.indexOf('='))))
    .join('&');
}

/** The hash parameters the marks add to a page's hash. */
const VIEW_PARAMS = ['mkview', 'mkclock', 'marks'] as const;

/** The eye of a rig in world metres. */
function eyeOf(rig: MarkRig): Vec3 {
  if (rig instanceof FreeRig) {
    const p = rig.position;
    return [p[0], p[1], p[2]];
  }
  // A following view has no render origin: its space is the world's.
  return rig.eye();
}

/** A `MarkHost` for an engine that draws through a `FreeRig` or a `FollowRig`. */
export function engineMarkHost(engine: MarkEngine, options: EngineMarkingOptions): MarkHost {
  const clocks = options.clocks ?? true;
  const pageHash = options.hash ?? (() => pageMarking().hash());
  const rig = (): MarkRig | null => rigOf(engine.view);
  const need = (): MarkRig => {
    const r = rig();
    if (!r) throw new Error('marks: the engine does not draw through a FreeRig or a FollowRig');
    return r;
  };

  const view = (): MarkView => {
    const r = need();
    const text = rigViewText(r);
    const { day, time } = engine.env;
    const params = [`mkview=${text}`, ...(clocks ? [`mkclock=${num(day.time)},${num(time.time)}`] : [])];
    const base = without(pageHash(), VIEW_PARAMS);
    const axes = r.axes();
    return {
      hash: [base, ...params].filter((p) => p !== '').join('&'),
      camera: r instanceof FreeRig ? 'free' : 'follow',
      rig: text,
      eye: eyeOf(r).map(r2),
      forward: axes.forward.map((v) => Math.round(v * 1e5) / 1e5),
      ...(clocks ? { hour: day.time, timeS: time.time } : {}),
      ...(options.view?.() ?? {}),
    };
  };

  const goto = (v: MarkView): void => {
    const r = rig();
    if (r && typeof v.rig === 'string') restoreRigView(r, v.rig, options.placeTarget);
    if (clocks) {
      if (typeof v.hour === 'number' && Number.isFinite(v.hour)) engine.env.day.set(v.hour);
      if (typeof v.timeS === 'number' && Number.isFinite(v.timeS)) engine.env.time.set(v.timeS);
    }
    engine.invalidate();
  };

  const facts = (hit: PickHit | null, ray: Ray): Record<string, unknown> => {
    if (options.facts) return options.facts(hit, ray);
    const r = rig();
    return {
      camera: r instanceof FreeRig ? 'free' : r instanceof FollowRig ? 'follow' : 'other',
      eyeM: ray.origin.map(r2),
      ...(hit ? {} : { hit: 'none: the ray met nothing the pick knows' }),
    };
  };

  return {
    canvas: engine.canvas,
    allowed: () => rig() !== null && (options.allowed?.() ?? true),
    size: () => [engine.view.width, engine.view.height],
    ray: (px, py) => {
      const r = need();
      return { origin: eyeOf(r), dir: r.screenRay(px, py).dir };
    },
    toScreen: (w) => {
      const r = rig();
      if (!r) return null;
      const e = eyeOf(r);
      const f = r.axes().forward;
      if ((w[0] - e[0]) * f[0] + (w[1] - e[1]) * f[1] + (w[2] - e[2]) * f[2] <= 0) return null;
      if (options.hidden?.(w, e)) return null;
      if (r instanceof FollowRig) return r.project(w);
      const o = r.origin;
      return r.project([w[0] - o[0], w[1] - o[1], w[2] - o[2]]);
    },
    pick: (ray) => options.pick(ray, need().pixelGrowth),
    view,
    facts,
    renderNow: () => engine.renderNow(),
    invalidate: () => engine.invalidate(),
    onFrame: (f) => void engine.renderer.beforeFrame.push(() => f()),
    goto,
  };
}

/**
 * The marks for an engine that draws through a `FreeRig` or a `FollowRig`: the mark mode on a key (default N), the
 * pins and the panel, saved through the dev server's store (`marksStore` of `wallhammer-web/marks-store`). Returns
 * null in a page driven by a script whose hash does not say `marks=1`. A view in the address (`mkview=`, `mkclock=`:
 * a mark's view opened by a tool) is restored at once.
 */
export function installEngineMarking(engine: MarkEngine, options: EngineMarkingOptions): MarkingApi | null {
  const page = pageMarking();
  if (!page.enabled) return null;
  const host = engineMarkHost(engine, options);
  const hash = page.hash();
  const text = hashParam(hash, 'mkview');
  if (text) {
    const [hour, timeS] = (hashParam(hash, 'mkclock') ?? '').split(',').map((s) => (s === '' ? NaN : Number(s)));
    host.goto({ hash, rig: text, hour, timeS });
  }
  return installMarking(host, { endpoint: options.endpoint ?? page.endpoint, key: options.key ?? 'KeyN', pins: options.pins ?? page.pins });
}

/** Options of `gapPick`. */
export interface GapPickOptions {
  /** Farthest distance looked at, metres. */
  maxDistanceM: number;
  /** True when the ray can no longer meet the surface from `p` on (it climbs away above everything). */
  escaped?(p: Vec3, ray: Ray): boolean;
  /** What a hit is called in a mark (default `surface`). */
  surface?: string;
  /** The hit point in the caller's own coordinates (default x, z and the height y, in metres). */
  place?(p: Vec3): Record<string, number | string | null>;
  /** What the gap function does not describe, in a mark's words. */
  misses?: string;
}

/** A pick that marches the ray (`marchRay`) against a signed gap function, positive on the eye's side. */
export function gapPick(gap: (p: Vec3) => number, options: GapPickOptions): MarkPick {
  return (ray, pixelGrowth) => {
    const escaped = options.escaped;
    const hit = marchRay(ray, gap, {
      maxDistanceM: options.maxDistanceM,
      // The least step stays under half a pixel at every distance.
      stepPerM: 0.5 * pixelGrowth,
      ...(escaped ? { escaped: (p: Vec3) => escaped(p, ray) } : {}),
    });
    if (!hit) return null;
    const p = hit.point;
    return {
      world: p,
      distanceM: r2(hit.distanceM),
      surface: options.surface ?? 'surface',
      place: options.place ? options.place(p) : { x: r2(p[0]), z: r2(p[2]), heightM: r2(p[1]) },
      accuracy: {
        method: 'cpu ray march (marchRay) against a gap function; halving to 5 mm',
        steps: hit.steps,
        lastStepM: r2(hit.lastStepM),
        metresPerPixel: Number((pixelGrowth * hit.distanceM).toPrecision(3)),
        misses: options.misses ?? 'whatever the gap function does not describe',
      },
    };
  };
}

/** Options of `heightPick`. */
export interface HeightPickOptions {
  /** Farthest distance looked at, metres (default 20 000). */
  maxDistanceM?: number;
  /** Above every height of the surface: a ray above it that climbs meets nothing more (saves the march into the sky). */
  topM?: number;
  /** What a hit is called in a mark (default `surface`). */
  surface?: string;
}

/**
 * A pick against a height function over a flat world (+y up): the gap is the height above `heightAt(x, z)`. It sees
 * only that surface, not instances, solids or effects drawn over it, and a coarse level of a drawn mesh may stand off
 * the function by its screen error.
 */
export function heightPick(heightAt: (x: number, z: number) => number, options: HeightPickOptions = {}): MarkPick {
  const top = options.topM;
  return gapPick((p) => p[1] - heightAt(p[0], p[2]), {
    maxDistanceM: options.maxDistanceM ?? 20_000,
    surface: options.surface ?? 'surface',
    misses: 'instances, solids and effects over the height function; a coarse level of the drawn mesh may stand off it',
    ...(top !== undefined ? { escaped: (p: Vec3, ray: Ray) => p[1] > top && ray.dir[1] >= 0 } : {}),
  });
}

/** Options of `collisionPick`. */
export interface CollisionPickOptions {
  /** Farthest distance looked at, metres (default 1000). */
  maxDistanceM?: number;
}

/**
 * A pick against a collision world (`CollisionWorld.raycast`): its base surface and the solids that block sight. It
 * does not see solids with `blocksSight: false` nor what is drawn without a solid.
 */
export function collisionPick(world: CollisionWorld, options: CollisionPickOptions = {}): MarkPick {
  const out = newRayHit();
  const max = options.maxDistanceM ?? 1000;
  return (ray, pixelGrowth) => {
    const [ox, oy, oz] = ray.origin;
    const [dx, dy, dz] = ray.dir;
    if (!world.raycast(ox, oy, oz, dx, dy, dz, max, out)) return null;
    // The direction is a unit vector, so `t` is in metres.
    const solid = out.solid >= 0;
    return {
      world: [out.x, out.y, out.z],
      distanceM: r2(out.t),
      surface: solid ? `solid ${out.solid}` : 'base surface',
      place: { x: r2(out.x), z: r2(out.z), heightM: r2(out.y), solid: solid ? out.solid : null, tag: solid ? out.tag : null },
      accuracy: {
        method: 'CollisionWorld.raycast against the base surface and the solids that block sight',
        metresPerPixel: Number((pixelGrowth * out.t).toPrecision(3)),
        misses: 'solids that do not block sight and whatever is drawn without a solid',
      },
    };
  };
}
