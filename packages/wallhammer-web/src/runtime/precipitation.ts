// Precipitation layer: rain or snowfall in the overlay pass, the last layer drawn.
//
// In a perspective view (the look 'world', default) the drops and flakes are quads in the world round the eye: two
// ranges of world tiles (dense small tiles to about 16 m, coarse large ones to about 60 m), only the tiles in the
// view, each drop placed by the model of env (`precipitationDrop`) in the vertex shader from its index, its tile and
// the animation time, so the CPU does nothing per drop.
// They are depth tested against the scene (not written), so they end at the ground and behind walls. Where the scene's
// depth can be read (`Device.sceneDepth`), one triangle over the screen first draws the landing marks on surfaces that
// face up near the eye: splashes and rings of rain, specks of snow. Order: marks, the far box, the near box.
//
// In an orthographic view, and with the look 'screen', the old pattern over the whole image is drawn instead: the fall
// runs down the screen, sheared by the wind, or (perspective) turned to the screen direction of the fall at the view
// centre.

import { dot } from '../base/math.ts';
import { boxInVolume } from '../base/view.ts';
import type { Vec3 } from '../base/math.ts';
import type { View } from '../base/view.ts';
import type { Program } from '../gpu/index.ts';
import type { DrawContext, Layer, Renderer } from '../render/index.ts';
import {
  PRECIPITATION_IMPACT_PERIOD_M,
  PRECIPITATION_MAX_TILES,
  PRECIPITATION_MIN,
  RAIN_FALL,
  RAIN_RINGS,
  RAIN_SHELLS,
  RAIN_SPLASHES,
  SNOW_FALL,
  SNOW_SHELLS,
  SNOW_SPECKS,
  cloudVolumeDepthMap,
  precipitationClock,
  precipitationCount,
  precipitationDown,
  precipitationEyeOffset,
  precipitationTiles,
  precipitationImpactClock,
  precipitationVelocity,
} from '../env/index.ts';
import type { PrecipitationImpact } from '../env/index.ts';
import type { EnvironmentLink } from './environment-link.ts';
import { PRECIP_DROP_FS, PRECIP_DROP_VS, PRECIP_FS, PRECIP_IMPACT_FS, PRECIP_VS } from './precipitation-glsl.ts';

/** Options of the precipitation layer (`createEngine({ precipitation })`). */
export interface PrecipitationOptions {
  /** Multiplies the number of drops and flakes; 1 (default) is the model's count. */
  density?: number;
  /**
   * Marks where the drops land: splashes and rings of rain, specks of snow (default true). They read the scene's
   * depth: in the standard depth mode `createEngine` then draws the frame offscreen (`RendererOptions.readableDepth`);
   * a renderer whose depth cannot be read draws no marks.
   */
  impacts?: boolean;
  /** 'world' (default): drops and flakes in the world round the eye. 'screen': the pattern over the image. */
  look?: 'world' | 'screen';
}

/** Whether a layer with these options, in a view like this, reads the scene's depth (the engine asks before it makes the context). */
export function precipitationNeedsDepth(options: PrecipitationOptions, view: Pick<View, 'pixelGrowth'>): boolean {
  return (options.impacts ?? true) && (options.look ?? 'world') === 'world' && view.pixelGrowth > 0;
}

/** Width of a rain streak and radius of a flake in metres, before the shell's scale. */
const RAIN_WIDTH_M = 0.0025;
const SNOW_RADIUS_M = 0.008;
/** The exposure a streak is drawn over, in seconds. */
const RAIN_EXPOSURE_S = 0.035;
/** No drop is drawn thinner than this many pixels; its alpha falls instead. */
const MIN_PIXELS = 1.1;
/** Opacity of a rain streak and of a flake at full strength. */
const RAIN_OPACITY = 0.55;
const SNOW_OPACITY = 0.9;
/** Landing marks fade out between these distances (metres from the eye). */
const IMPACT_RANGE_M: [number, number] = [18, 30];
/** The texture unit the scene's depth is read from during the marks' draw. */
const DEPTH_UNIT = 1;

export class PrecipitationLayer implements Layer {
  /** Name in profiles (`Layer.name`). */
  readonly name: string = 'precipitation';
  /**
   * Where the clouds over the eye are known: how much of the frame's precipitation falls here (`rainShare`, 0–1; the
   * volumetric clouds give it, so the eye under a gap stays dry). Null: all of it.
   */
  source: { readonly rainShare: number } | null = null;
  /** Multiplies the number of drops and flakes (`PrecipitationOptions.density`). */
  density: number;
  /** Draw the landing marks where the scene's depth can be read (`PrecipitationOptions.impacts`). */
  impacts: boolean;
  /** Draw the drops and flakes (false leaves only the marks; for measuring). */
  drops = true;
  /** The look in a perspective view (`PrecipitationOptions.look`). */
  look: 'world' | 'screen';
  /** Drops drawn per range in the last frame (near first); for statistics. */
  readonly lastDrops: number[] = [0, 0];
  private readonly tiles = new Float32Array(PRECIPITATION_MAX_TILES * 4);
  private readonly screenProgram: Program;
  private readonly dropProgram: Program;
  private readonly impactProgram: Program;
  private readonly link: EnvironmentLink;
  private readonly renderer: Renderer;

  constructor(renderer: Renderer, link: EnvironmentLink, options: PrecipitationOptions = {}) {
    const device = renderer.device;
    this.screenProgram = device.program('precipitation', PRECIP_VS, renderer.resolve(PRECIP_FS));
    this.dropProgram = device.program('precipitation-drops', renderer.resolve(PRECIP_DROP_VS), renderer.resolve(PRECIP_DROP_FS));
    // Drawn without the depth test: no depth of its own in any mode.
    this.impactProgram = device.program('precipitation-impacts', PRECIP_VS, renderer.resolve(PRECIP_IMPACT_FS, 'other'));
    this.link = link;
    this.renderer = renderer;
    this.density = options.density ?? 1;
    this.impacts = options.impacts ?? true;
    this.look = options.look ?? 'world';
  }

  draw(ctx: DrawContext): void {
    const E = this.link.frame;
    const share = this.source ? Math.min(1, Math.max(0, this.source.rainShare)) : 1;
    this.lastDrops[0] = this.lastDrops[1] = 0;
    if (ctx.pass !== 'overlay' || !E || E.precipitation * share <= PRECIPITATION_MIN) return;
    if (ctx.view.pixelGrowth > 0 && this.look === 'world') this.drawWorld(ctx, E.precipitation * share);
    else this.drawScreen(ctx, share);
  }

  private drawWorld(ctx: DrawContext, strength: number): void {
    const E = this.link.frame!;
    const view = ctx.view;
    const device = ctx.device;
    const snow = E.precipitationKind > 0.5;
    const fall = snow ? SNOW_FALL : RAIN_FALL;
    const eye = view.cornerRays()[0]!.origin;
    const wo = this.renderer.worldOrigin;
    const eyeWorld: Vec3 = [eye[0] + wo[0], eye[1] + wo[1], eye[2] + wo[2]];
    const center = this.renderer.upCenter();
    const down = precipitationDown(eye, center);
    const velocity = precipitationVelocity(fall, down, E.windX, E.windZ, this.link.env.wind.speedMs);
    const time = E.time;
    const blend = { src: 'one', dst: 'one-minus-src-alpha' } as const;

    if (this.impacts) this.drawImpacts(ctx, strength, snow, eye, eyeWorld, down, time);

    if (!this.drops) return;
    const p = this.dropProgram;
    device.setState({ depthTest: true, depthFunc: 'less', depthWrite: false, cullBack: false, blend });
    device.use(p);
    const clock = precipitationClock(time, fall.lifeS);
    // The light that reaches the flakes: less under a closed deck.
    const light = 0.35 + 0.4 * (1 - E.cloudCover);
    p.set('u_pcEye', { vec3: [eye[0], eye[1], eye[2]] });
    p.set('u_pcVelocity', { vec3: velocity });
    p.set('u_pcClock', { vec2: clock });
    p.set('u_pcLook', { vec4: [(snow ? SNOW_OPACITY : RAIN_OPACITY) * (0.55 + 0.45 * Math.min(1, strength)), light, 0, 0] });
    const shells = snow ? SNOW_SHELLS : RAIN_SHELLS;
    // The tiles in the view: boxes relative to the eye against the view's volume (in render space).
    const volume = view.cullVolume();
    const visible = (min: Vec3, max: Vec3): boolean => boxInVolume({ min: [min[0] + eye[0], min[1] + eye[1], min[2] + eye[2]], max: [max[0] + eye[0], max[1] + eye[1], max[2] + eye[2]] }, volume);
    // The far range first: the near drops blend over it.
    for (let s = shells.length - 1; s >= 0; s--) {
      const shell = shells[s]!;
      const count = precipitationCount(shell, strength, this.density);
      const perTile = Math.ceil(count);
      if (perTile <= 0) continue;
      const tiles = precipitationTiles(shell, fall, velocity, eyeWorld, visible);
      const n = tiles.length / 4;
      if (n === 0) continue;
      this.tiles.set(tiles);
      p.vec4v('u_pcTiles', this.tiles.subarray(0, tiles.length));
      p.set('u_pcShell', { vec4: [shell.tileM, fall.lifeS, fall.swayM, fall.swayCycles] });
      p.set('u_pcRange', { vec4: [shell.nearM[0], shell.nearM[1], shell.farM[0], shell.farM[1]] });
      p.float('u_pcCount', count);
      p.int('u_pcPerTile', perTile);
      p.set('u_pcSize', { vec4: [(snow ? SNOW_RADIUS_M : RAIN_WIDTH_M) * shell.size, RAIN_EXPOSURE_S * (0.6 + 0.4 * shell.size), MIN_PIXELS, snow ? 1 : 0] });
      device.drawVertices(n * perTile * 6);
      ctx.count(n * perTile * 2);
      this.lastDrops[s] = n * perTile;
    }
  }

  private drawImpacts(ctx: DrawContext, strength: number, snow: boolean, eye: Vec3, eyeWorld: Vec3, down: Vec3, time: number): void {
    const device = ctx.device;
    const depth = device.sceneDepth();
    if (!depth) return;
    const E = this.link.frame!;
    const view = ctx.view;
    const projection = this.renderer.projection;
    const p = this.impactProgram;
    device.setState({ depthTest: false, depthWrite: false, cullBack: false, blend: { src: 'one', dst: 'one-minus-src-alpha' } });
    device.use(p);
    device.texture(DEPTH_UNIT, depth);
    p.int('u_pcDepth', DEPTH_UNIT);
    p.set('u_pcDepthMap', { vec4: cloudVolumeDepthMap(device.depthMode, projection.viewProj, projection.logScale) });
    p.set('u_pcScreen', { vec2: [view.width, view.height] });
    // Rays at depth 1 along the view: left-bottom, left-top, right-bottom.
    const f = view.axes().forward;
    const [lb, lt, rb] = view.cornerRays().map((ray) => {
      const k = 1 / (ray.dir[0] * f[0] + ray.dir[1] * f[1] + ray.dir[2] * f[2]);
      return [ray.dir[0] * k, ray.dir[1] * k, ray.dir[2] * k] as Vec3;
    }) as [Vec3, Vec3, Vec3];
    const right: Vec3 = [(rb[0] - lb[0]) / 2, (rb[1] - lb[1]) / 2, (rb[2] - lb[2]) / 2];
    const up: Vec3 = [(lt[0] - lb[0]) / 2, (lt[1] - lb[1]) / 2, (lt[2] - lb[2]) / 2];
    p.set('u_pcRayCenter', { vec3: [lb[0] + right[0] + up[0], lb[1] + right[1] + up[1], lb[2] + right[2] + up[2]] });
    p.set('u_pcRayRight', { vec3: right });
    p.set('u_pcRayUp', { vec3: up });
    p.set('u_pcEye', { vec3: [eye[0], eye[1], eye[2]] });
    p.set('u_pcImpactOffset', { vec3: precipitationEyeOffset(eyeWorld, PRECIPITATION_IMPACT_PERIOD_M) });
    // The cells lie across the world axis nearest to the up at the eye.
    const ax = Math.abs(down[0]), ay = Math.abs(down[1]), az = Math.abs(down[2]);
    p.int('u_pcAxis', ay >= ax && ay >= az ? 1 : ax >= az ? 0 : 2);
    p.set('u_pcRangeM', { vec2: IMPACT_RANGE_M });
    const a = snow ? SNOW_SPECKS : RAIN_SPLASHES;
    const b = snow ? SNOW_SPECKS : RAIN_RINGS;
    const s = Math.min(1, strength);
    const ca = precipitationImpactClock(a, time);
    const cb = precipitationImpactClock(b, time);
    p.set('u_pcSpecA', { vec4: impactSpec(a, s) });
    p.set('u_pcSpecB', { vec4: impactSpec(b, s) });
    p.set('u_pcClocks', { vec4: [ca[0], ca[1], cb[0], cb[1]] });
    p.int('u_pcSeedA', a.seed);
    p.int('u_pcSeedB', b.seed);
    const light = 0.35 + 0.4 * (1 - E.cloudCover);
    // Rings stand on wet ground: more of them the wetter it is.
    const rings = snow ? 0 : smooth01(0.2, 0.9, E.wetness);
    p.set('u_pcLook', { vec4: [snow ? 1 : 0, 0.55 + 0.45 * s, light, rings] });
    device.drawFullscreen();
    ctx.count(1);
    device.texture(DEPTH_UNIT, null);
  }

  private drawScreen(ctx: DrawContext, share: number): void {
    const E = this.link.frame!;
    const view = ctx.view;
    const right = view.axes().right;
    const across = E.windX * right[0] + E.windZ * right[2];
    const speed = this.link.env.wind.speedMs;
    // Rain falls fast, wind tilts it less than light flakes.
    const drift = Math.min(0.6, speed * (E.precipitationKind > 0.5 ? 0.09 : 0.035));
    let slant = across * drift;
    let fall: [number, number] = [0, -1];
    if (view.pixelGrowth > 0) {
      const center = this.renderer.upCenter();
      fall = screenFall(view, center ? radialFall(view, center, E.windX, E.windZ, drift) : [E.windX * drift, -1, E.windZ * drift]);
      slant = 0;
    }
    const program = this.screenProgram;
    ctx.device.setState({ depthTest: false, blend: { src: 'one', dst: 'one-minus-src-alpha' } });
    ctx.device.use(program);
    program.float('u_slant', slant);
    program.set('u_fall', { vec2: fall });
    program.float('u_pxScale', ctx.view.dpr);
    program.float('u_precipShare', share);
    ctx.device.drawFullscreen();
    ctx.count(1);
  }
}

function smooth01(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The shader's vec4 of a kind of mark: cell, life over slot, radius, rate times strength. */
function impactSpec(m: PrecipitationImpact, strength: number): [number, number, number, number] {
  return [m.cellM, m.lifeS / m.slotS, m.radiusM, m.rate * strength];
}

/**
 * The motion of the fall under radial up: along the local down at the eye, tilted by the part of the wind that lies
 * across that down.
 */
function radialFall(view: View, center: Vec3, windX: number, windZ: number, drift: number): Vec3 {
  const eye = view.cornerRays()[0]!.origin;
  const ux = eye[0] - center[0], uy = eye[1] - center[1], uz = eye[2] - center[2];
  const len = Math.hypot(ux, uy, uz);
  if (len <= 1e-6) return [windX * drift, -1, windZ * drift];
  const down: Vec3 = [-ux / len, -uy / len, -uz / len];
  const along = windX * down[0] + windZ * down[2];
  const wx = windX - down[0] * along, wy = -down[1] * along, wz = windZ - down[2] * along;
  return [down[0] + wx * drift, down[1] + wy * drift, down[2] + wz * drift];
}

/** Screen direction (unit, y up) of a world motion seen at the centre of a perspective view. */
function screenFall(view: View, motion: Vec3): [number, number] {
  const f = view.axes().forward;
  const eye = view.cornerRays()[0]!.origin;
  const t = view.refDepth - dot(f, eye);
  const c: Vec3 = [eye[0] + f[0] * t, eye[1] + f[1] * t, eye[2] + f[2] * t];
  const m = view.viewProj(c, 1);
  const clip = (p: Vec3): [number, number] => {
    const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
    return [(m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!) / w, (m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!) / w];
  };
  const a = clip(c);
  const b = clip([c[0] + motion[0], c[1] + motion[1], c[2] + motion[2]]);
  const dx = (b[0] - a[0]) * view.width;
  const dy = (b[1] - a[1]) * view.height;
  const len = Math.hypot(dx, dy);
  // Looking straight down the fall has no screen direction; keep the default.
  return len > 1e-6 ? [dx / len, dy / len] : [0, -1];
}
