// Sky layer: one triangle across the screen, drawn first in the colour pass, that computes the sky per pixel from the
// view ray (`skyView` from the include `<sky>`). Only perspective views see a sky; an orthographic view draws nothing
// here and keeps the plain background. Every frame it hands the view's eye to the sky slot, which carries it into the
// Frame block for the haze on distant geometry (`aerialPerspective`).
//
// Behind the scene (`behindScene`, default off): the same triangle is drawn later in the colour pass, at the far end
// of the depth range with the depth test on and without writing depth, so the sky is computed only for the pixels and
// samples nothing has covered yet instead of for the whole screen before the scene overdraws most of it. Every
// covered sample keeps its colour and every uncovered one gets the colour it got before, so the image is the same as
// long as the layers drawn before the sky are opaque (they write depth where they draw). Move the layer behind them
// with `Engine.moveSkyBefore`.

import type { Vec3 } from '../base/math.ts';
import { newCornerRays, newOrthoFrame } from '../base/view.ts';
import type { EnvSlot } from '../base/env-slot.ts';
import type { Program } from '../gpu/index.ts';
import type { DrawContext, Layer, Renderer } from '../render/index.ts';
import type { SkyParams, SkyValues } from '../env/index.ts';

export const SKY_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);
}`;

export const SKY_FS = /* glsl */ `#include <header>
#include <noise>
#include <sky>
uniform vec3 u_rayCenter; // view ray through the screen centre, scaled so that its depth along the view is 1
uniform vec3 u_rayRight;  // change of the ray from the centre to the right edge
uniform vec3 u_rayUp;     // change of the ray from the centre to the top edge
uniform vec2 u_screen;    // drawing surface in physical pixels
out vec4 o_color;
void main() {
  vec2 s = gl_FragCoord.xy / u_screen * 2.0 - 1.0;
  vec3 dir = normalize(u_rayCenter + u_rayRight * s.x + u_rayUp * s.y);
  o_color = vec4(skyView(dir), 1.0);
}`;

/** Draw state of the sky behind the scene: only where the depth is still the far end, depth kept as it is. */
const BEHIND_STATE = { depthTest: true, depthFunc: 'lequal', depthWrite: false, cullBack: false } as const;
const FIRST_STATE = { depthTest: false, depthWrite: false, cullBack: false } as const;

export class SkyLayer implements Layer {
  readonly name = 'sky';
  readonly slot: EnvSlot<SkyParams, SkyValues>;
  /**
   * Draw only where nothing was drawn yet (see the top of this file). Default false: the sky covers the whole screen
   * and must be the first layer. True: put the layer after the opaque layers and before the transparent ones.
   */
  behindScene = false;
  private readonly renderer: Renderer;
  private readonly program: Program;
  private behindProgram: Program | null = null;
  /** Scratch, so a frame allocates nothing here. */
  private readonly axes = newOrthoFrame();
  private readonly rays = newCornerRays();
  private readonly eye: Vec3 = [0, 0, 0];

  /** The slot must be part of the renderer's Frame block (and its `EnvironmentLink`), so `<sky>` is the real one. */
  constructor(renderer: Renderer, slot: EnvSlot<SkyParams, SkyValues>) {
    this.slot = slot;
    this.renderer = renderer;
    this.program = renderer.device.program('sky', SKY_VS, renderer.resolve(SKY_FS));
    // Before the environment is packed, so the eye of this frame's view goes into this frame's block.
    renderer.beforeFrame.unshift((view) => {
      if (view.pixelGrowth <= 0) {
        slot.params.eye = null;
        return;
      }
      const o = view.cornerRays(this.rays)[0]!.origin;
      const e = this.eye;
      e[0] = o[0];
      e[1] = o[1];
      e[2] = o[2];
      slot.params.eye = e;
    });
  }

  /**
   * The program of the sky behind the scene, made at its first use: the triangle at the far end of the depth range
   * of the renderer's depth mode. In the logarithmic mode the fragment shader is not wrapped (it would write a near
   * depth); the pipeline's depth of the far end is used instead.
   */
  private behind(): Program {
    if (this.behindProgram) return this.behindProgram;
    const r = this.renderer;
    const far = r.depthMode === 'reversed' ? '0.0' : '1.0';
    const vs = SKY_VS.replace('gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);', `gl_Position = vec4(p * 2.0 - 1.0, ${far}, 1.0);`);
    this.behindProgram = r.device.program('sky behind', vs, r.resolve(SKY_FS, r.depthMode === 'logarithmic' ? 'other' : 'main'));
    return this.behindProgram;
  }

  draw(ctx: DrawContext): void {
    const view = ctx.view;
    if (ctx.pass !== 'color' || view.pixelGrowth <= 0) return;
    const f = view.axes(this.axes).forward;
    // Corner rays: left-bottom, left-top, right-bottom, right-top. Scaled to depth 1 they interpolate linearly across the screen.
    const rays = view.cornerRays(this.rays);
    const lb = rays[0]!.dir;
    const lt = rays[1]!.dir;
    const rb = rays[2]!.dir;
    const klb = 1 / (lb[0] * f[0] + lb[1] * f[1] + lb[2] * f[2]);
    const klt = 1 / (lt[0] * f[0] + lt[1] * f[1] + lt[2] * f[2]);
    const krb = 1 / (rb[0] * f[0] + rb[1] * f[1] + rb[2] * f[2]);
    const lb0 = lb[0] * klb;
    const lb1 = lb[1] * klb;
    const lb2 = lb[2] * klb;
    const rx = (rb[0] * krb - lb0) / 2;
    const ry = (rb[1] * krb - lb1) / 2;
    const rz = (rb[2] * krb - lb2) / 2;
    const ux = (lt[0] * klt - lb0) / 2;
    const uy = (lt[1] * klt - lb1) / 2;
    const uz = (lt[2] * klt - lb2) / 2;
    const program = this.behindScene ? this.behind() : this.program;
    ctx.device.setState(this.behindScene ? BEHIND_STATE : FIRST_STATE);
    ctx.device.use(program);
    program.vec3('u_rayCenter', lb0 + rx + ux, lb1 + ry + uy, lb2 + rz + uz);
    program.vec3('u_rayRight', rx, ry, rz);
    program.vec3('u_rayUp', ux, uy, uz);
    program.vec2('u_screen', view.width, view.height);
    ctx.device.drawFullscreen();
    ctx.count(1);
  }
}
