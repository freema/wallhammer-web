// Precipitation layer: rain or snowfall over the whole image in the overlay pass. Wind across the view tilts it.
// In an orthographic view the fall runs down the screen, sheared by the wind. In a perspective view the screen direction
// of the fall (with the wind) is projected at the view centre and the pattern is turned to it.

import { dot } from '../base/math.ts';
import type { Vec3 } from '../base/math.ts';
import type { View } from '../base/view.ts';
import type { Program } from '../gpu/index.ts';
import type { DrawContext, Layer, Renderer } from '../render/index.ts';
import type { EnvironmentLink } from './environment-link.ts';
import { PRECIP_FS, PRECIP_VS } from './precipitation-glsl.ts';

/** Below this strength nothing is drawn. */
const MIN_PRECIPITATION = 0.005;

export class PrecipitationLayer implements Layer {
  /** Name in profiles (`Layer.name`). */
  readonly name: string = 'precipitation';
  private readonly program: Program;
  private readonly link: EnvironmentLink;
  private readonly renderer: Renderer;

  constructor(renderer: Renderer, link: EnvironmentLink) {
    this.program = renderer.device.program('precipitation', PRECIP_VS, renderer.resolve(PRECIP_FS));
    this.link = link;
    this.renderer = renderer;
  }

  draw(ctx: DrawContext): void {
    const E = this.link.frame;
    if (ctx.pass !== 'overlay' || !E || E.precipitation <= MIN_PRECIPITATION) return;
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
    ctx.device.setState({ depthTest: false, blend: { src: 'one', dst: 'one-minus-src-alpha' } });
    ctx.device.use(this.program);
    this.program.float('u_slant', slant);
    this.program.set('u_fall', { vec2: fall });
    this.program.float('u_pxScale', ctx.view.dpr);
    ctx.device.drawFullscreen();
    ctx.count(1);
  }
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
