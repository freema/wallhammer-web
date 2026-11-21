// Atmosphere layer: uploads the tables of the atmosphere slot, keeps them bound for every layer drawn after it, and
// draws the air behind the scene: one triangle across the screen, first in the colour pass, with the stars and the
// sun's disc behind the air. Only perspective views get it. Every frame it hands the view's eye and its height above
// the ground sphere to the slot, which carries them into the Frame block for the air in front of the scene
// (`atmosphereAir`, `atmosphereApply`) and for the light on surfaces (`atmosphereLight`).
//
// The sky table. The light along a view ray of the sky is not integrated per pixel: before the passes of a frame
// (`prepare`) the layer fills a small table on the graphics card with that integral for directions spread over the
// whole sky of the eye, and every pixel reads it. The table is filled again only when the environment's part of the
// Frame block or the centre of up has changed. Its three textures (16-bit float) hold what `atmSegmentParts` of the
// include `<atmosphere>` gives: the light of molecules with the light scattered more than once, the light of
// particles before its phase value (the pixel multiplies that in, so the glow round the sun stays sharp), and the
// share of light from behind the air that passes.
//   - Columns: the cosine of the angle, round the up of the eye, between the direction and the sun. Seen from one
//     place the air depends on that angle through its cosine alone, so the columns are evenly spaced in it.
//   - Rows, in two halves that never blend into each other, so the horizon stays a line: the lower half holds the
//     directions that end on the ground sphere, from its horizon down to straight down; the upper half the others,
//     from the horizon up to straight up, or to the rim of the shell for an eye above the air. Both by the square
//     root of the angle from the horizon: the rows crowd there, where the light changes fastest.
// Where the graphics card cannot draw into float textures, and in the slot's reference quality
// (`AtmosphereParams.reference`), every pixel integrates its own ray as `atmosphereSky` does.

import type { Vec3 } from '../base/math.ts';
import type { View } from '../base/view.ts';
import type { ColorTarget, Device, Program, Texture } from '../gpu/index.ts';
import type { DrawContext, Layer, Renderer } from '../render/index.ts';
import { ATMOSPHERE_TABLE_UNIT } from '../env/index.ts';
import type { AtmosphereSlot } from '../env/index.ts';
import { SKY_VS } from './sky.ts';

/** Size of the sky table in texels: columns round the up of the eye, rows in two halves below and above the horizon. */
export const ATMOSPHERE_SKY_TABLE = { width: 64, height: 128 } as const;

const SKY_W = ATMOSPHERE_SKY_TABLE.width.toFixed(1);
const SKY_HALF = (ATMOSPHERE_SKY_TABLE.height / 2).toFixed(1);
/** First texture unit the three textures of the sky table are bound to while the sky is drawn. */
const SKY_UNIT = 1;

/** What the sky table is laid out by, shared by the program that fills it and the one that reads it. Needs `<atmosphere>`. */
const SKY_TABLE_GLSL = /* glsl */ `
const float ATM_PI = 3.14159265;
struct AtmSkyFrame {
  vec3 ro;       // the eye relative to the centre of the sphere
  vec3 up;       // unit up at the eye
  vec3 toSun;    // unit and level at the eye, toward the sun
  vec3 side;     // unit and level, square to both
  float r0;      // distance of the eye from the centre
  float h;       // height of the eye above the ground sphere
  float horizon; // angle from straight up to the horizon of the ground sphere
  float top;     // angle from straight up to the first direction with air: 0 inside the shell, its rim from above
};
AtmSkyFrame atmSkyFrame() {
  AtmSkyFrame f;
  f.ro = atmEye(f.h);
  float Rg = u_atmShell.x;
  float Rt = u_atmShell.y;
  f.r0 = Rg + f.h;
  f.up = f.ro / f.r0;
  vec3 s = u_atmSun.xyz - f.up * dot(u_atmSun.xyz, f.up);
  // With the sun straight above or below the sky is the same all the way round: any level direction serves.
  if (dot(s, s) < 1e-8) s = cross(f.up, abs(f.up.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
  f.toSun = normalize(s);
  f.side = cross(f.up, f.toSun);
  // Both angles from lengths that stay exact a metre above the ground and a metre above the air.
  f.horizon = 0.5 * ATM_PI + atan(sqrt(f.h * (2.0 * Rg + f.h)), Rg);
  f.top = f.r0 > Rt ? ATM_PI - atan(Rt, sqrt((f.r0 - Rt) * (f.r0 + Rt))) : 0.0;
  return f;
}
`;

/** Fills the sky table: one direction per texel, integrated as `atmosphereSky` does. Needs `SKY_VS`. */
export const ATMOSPHERE_TABLE_FS = /* glsl */ `#include <header>
#include <atmosphere>
${SKY_TABLE_GLSL}
layout(location = 0) out vec4 o_base;
layout(location = 1) out vec4 o_mie;
layout(location = 2) out vec4 o_through;
void main() {
  AtmSkyFrame f = atmSkyFrame();
  vec2 cell = floor(gl_FragCoord.xy);
  bool down = cell.y < ${SKY_HALF};
  float c = (down ? cell.y : cell.y - ${SKY_HALF}) / (${SKY_HALF} - 1.0);
  float theta = down ? f.horizon + c * c * (ATM_PI - f.horizon) : f.horizon - c * c * (f.horizon - f.top);
  float cosPhi = cell.x / (${SKY_W} - 1.0) * 2.0 - 1.0;
  float mu = cos(theta);
  vec3 dir = f.up * mu + (f.toSun * cosPhi + f.side * sqrt(max(1.0 - cosPhi * cosPhi, 0.0))) * sin(theta);
  // The piece of the ray inside the shell; the half of the table says whether it ends on the ground, so the two
  // rows at the horizon hold the two sides of that line.
  float Rt = u_atmShell.y;
  float b = f.r0 * mu;
  float sq = sqrt(max(b * b - (f.r0 - Rt) * (f.r0 + Rt), 0.0));
  float t0 = max(-b - sq, 0.0);
  float t1 = -b + sq;
  if (down) t1 = min(t1, -b - sqrt(max(b * b - f.h * (2.0 * u_atmShell.x + f.h), 0.0)));
  vec3 mie = vec3(0.0);
  vec3 through = vec3(1.0);
  vec3 base = vec3(0.0);
  if (u_atmSun.w > 0.0 && t1 > t0) base = atmSegmentParts(f.ro + dir * t0, dir, t1 - t0, ATM_SKY_STEPS, mie, through);
  o_base = vec4(base, 1.0);
  o_mie = vec4(mie, 1.0);
  o_through = vec4(through, 1.0);
}`;

export const ATMOSPHERE_FS = /* glsl */ `#include <header>
#include <noise>
#include <atmosphere>
${SKY_TABLE_GLSL}
uniform highp sampler2D u_atmSkyBase;    // sky table: light of molecules and light scattered more than once
uniform highp sampler2D u_atmSkyMie;     // sky table: light of particles before its phase value
uniform highp sampler2D u_atmSkyThrough; // sky table: share of light from behind the air that passes
uniform float u_atmMarch; // 1: every pixel integrates its own ray, 0: the sky table is read
uniform vec3 u_rayCenter; // view ray through the screen centre, scaled so that its depth along the view is 1
uniform vec3 u_rayRight;  // change of the ray from the centre to the right edge
uniform vec3 u_rayUp;     // change of the ray from the centre to the top edge
uniform vec2 u_screen;    // drawing surface in physical pixels
out vec4 o_color;

// Stars: at most one per cell of a cube-map grid over the directions, from an integer hash. Fixed in the world and
// never narrower than a pixel.
float atmStars(vec3 dir, float pixelAngle) {
  vec3 a = abs(dir);
  vec2 uv;
  uint face;
  float major;
  if (a.x >= a.y && a.x >= a.z) { uv = dir.zy / a.x; face = dir.x > 0.0 ? 0u : 1u; major = a.x; }
  else if (a.y >= a.z) { uv = dir.xz / a.y; face = dir.y > 0.0 ? 2u : 3u; major = a.y; }
  else { uv = dir.xy / a.z; face = dir.z > 0.0 ? 4u : 5u; major = a.z; }
  const float CELLS = 160.0;
  vec2 g = (uv * 0.5 + 0.5) * CELLS;
  vec2 cf = floor(g);
  ivec2 cell = ivec2(cf);
  uint seed = 400u + face * 8u;
  if (hash2(cell, seed) > 0.3) return 0.0;
  vec2 at = 0.2 + 0.6 * vec2(hash2(cell, seed + 1u), hash2(cell, seed + 2u));
  float m = hash2(cell, seed + 3u);
  float bright = 0.12 + 0.88 * m * m * m * m;
  float px = pixelAngle * CELLS * 0.5 / major;
  float r = max(0.8 * px, 0.01);
  vec2 off = g - cf - at;
  return bright * exp(-dot(off, off) / (r * r));
}

// The air along a view ray from the eye, read from the sky table: what atmosphereSky gives.
vec3 atmSkyRead(vec3 dir, out vec3 through, out float ground) {
  through = vec3(1.0);
  ground = 0.0;
  if (u_atmSun.w <= 0.0) return vec3(0.0);
  AtmSkyFrame f = atmSkyFrame();
  float Rt = u_atmShell.y;
  float mu = dot(dir, f.up);
  float b = f.r0 * mu;
  float ct = (f.r0 - Rt) * (f.r0 + Rt);
  // No air along the ray: it passes the shell by, or the shell lies behind an eye above it.
  if (b * b - ct <= 0.0 || (ct > 0.0 && b >= 0.0)) return vec3(0.0);
  bool down = b < 0.0 && b * b - f.h * (2.0 * u_atmShell.x + f.h) > 0.0;
  ground = down ? 1.0 : 0.0;
  float theta = acos(clamp(mu, -1.0, 1.0));
  float x = down ? (theta - f.horizon) / (ATM_PI - f.horizon) : (f.horizon - theta) / (f.horizon - f.top);
  float row = sqrt(clamp(x, 0.0, 1.0)) * (${SKY_HALF} - 1.0) + (down ? 0.0 : ${SKY_HALF});
  vec3 level = dir - f.up * mu;
  float l = length(level);
  float cosPhi = l > 1e-5 ? dot(level, f.toSun) / l : 1.0;
  vec2 at = (vec2((cosPhi * 0.5 + 0.5) * (${SKY_W} - 1.0), row) + 0.5) / vec2(${SKY_W}, 2.0 * ${SKY_HALF});
  through = textureLod(u_atmSkyThrough, at, 0.0).rgb;
  return textureLod(u_atmSkyBase, at, 0.0).rgb + textureLod(u_atmSkyMie, at, 0.0).rgb * atmPhaseMie(dot(dir, u_atmSun.xyz));
}

void main() {
  vec2 s = gl_FragCoord.xy / u_screen * 2.0 - 1.0;
  vec3 dir = normalize(u_rayCenter + u_rayRight * s.x + u_rayUp * s.y);
  float pa = max(length(fwidth(dir)), 1e-5);
  vec3 through;
  float ground;
  vec3 light;
  if (u_atmMarch > 0.5) light = atmosphereSky(dir, through, ground);
  else light = atmSkyRead(dir, through, ground);
  vec3 c = atmDisplay(light);
#ifdef WH_ATM_PAINT
  c = atmospherePaintSky(dir, c);
#endif
  // Behind the air, where the ground sphere is not in the way: the stars, lost in a bright sky, and the sun's disc,
  // so bright that only a long way through the air gives it a colour.
  float behind = 1.0 - ground;
  float dark = 1.0 - max(c.r, max(c.g, c.b));
  dark *= dark;
  c += vec3(0.88, 0.92, 1.0) * through * (atmStars(dir, pa) * u_atmTune.w * dark * dark * behind);
  float rs = u_atmShell.w;
  float disc = (1.0 - smoothstep(rs - pa, rs + pa, length(dir - u_atmSun.xyz))) * behind;
  vec3 lit = c + (1.0 - c) * (1.0 - exp(-through * 30.0));
#ifdef WH_ATM_PAINT
  // The painted disc: one colour while any of the sun passes the air.
  lit = mix(lit, u_atmPaintSun.rgb, u_atmPaintZenith.w * (1.0 - exp(-max(through.r, through.g) * 30.0)));
#endif
  c = mix(c, lit, disc);
  o_color = vec4(c, 1.0);
}`;

export class AtmosphereLayer implements Layer {
  /** Name in profiles (`Layer.name`). */
  readonly name: string = 'atmosphere';
  readonly slot: AtmosphereSlot;
  private readonly renderer: Renderer;
  private readonly program: Program;
  private readonly tables: Texture;
  /** The sky table and the program that fills it, or null where float textures cannot be drawn into. */
  private readonly sky: ColorTarget | null;
  private readonly skyProgram: Program | null;
  /** What the sky table was last filled from, or null when it has to be filled whatever the frame holds. */
  private filledFrom: Float32Array | null = null;

  /** The slot must be part of the renderer's Frame block (and its `EnvironmentLink`), so `<atmosphere>` is the real one. */
  constructor(renderer: Renderer, slot: AtmosphereSlot) {
    this.slot = slot;
    this.renderer = renderer;
    this.tables = renderer.device.createTexture(slot.tables.texture);
    // Every program that declares the sampler reads it from the same unit.
    renderer.device.fixSampler('u_atmTables', ATMOSPHERE_TABLE_UNIT);
    this.program = renderer.device.program('atmosphere', SKY_VS, renderer.resolve(ATMOSPHERE_FS));
    this.sky = renderer.device.colorTarget(ATMOSPHERE_SKY_TABLE.width, ATMOSPHERE_SKY_TABLE.height, 3, 'rgba16f');
    this.skyProgram = this.sky ? renderer.device.program('atmosphere sky table', SKY_VS, renderer.resolve(ATMOSPHERE_TABLE_FS, 'other')) : null;
    // A fresh context holds an empty table.
    renderer.device.onRestored(() => (this.filledFrom = null));
    // Before the environment is packed, so the eye of this frame's view goes into this frame's block.
    renderer.beforeFrame.unshift((view) => {
      const eye = viewEye(view);
      const p = slot.params;
      p.eye = eye;
      if (!eye) return;
      const c = renderer.upCenter();
      p.eyeHeightM = c ? Math.hypot(eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]) - slot.medium.radiusM : eye[1] - p.groundY;
    });
  }

  /**
   * Binds the tables to their unit (`ATMOSPHERE_TABLE_UNIT`) and selects a spare unit, for a layer that reads the
   * air in its own `prepare` (before this layer's draw has bound them in the frame).
   */
  bindTables(device: Device): void {
    device.texture(ATMOSPHERE_TABLE_UNIT, this.tables);
    device.texture(ATMOSPHERE_TABLE_UNIT - 1, null);
  }

  /** True when the sky is read from the sky table in this frame, false when every pixel integrates its own ray. */
  get usesSkyTable(): boolean {
    return this.sky !== null && !this.slot.params.reference;
  }

  /** Fills the sky table when what it was filled from has changed. */
  prepare(device: Device, view: View): void {
    const p = this.slot.params;
    if (!this.sky || !this.skyProgram) return;
    if (!this.usesSkyTable || view.pixelGrowth <= 0 || !(p.exposure > 0)) {
      this.filledFrom = null;
      return;
    }
    if (!this.frameChanged()) return;
    device.texture(ATMOSPHERE_TABLE_UNIT, this.tables);
    device.texture(ATMOSPHERE_TABLE_UNIT - 1, null);
    device.fill(this.sky, this.skyProgram);
  }

  /**
   * Compares what the sky table depends on with what it was filled from, and remembers the new values: the
   * environment's part of the Frame block (the slot's members among them) and the centre of up.
   */
  private frameChanged(): boolean {
    const { afterLight, afterView } = this.renderer.frameSlots;
    const c = this.renderer.upCenter() ?? [0, 0, 0];
    const n = afterLight.length + afterView.length + 3;
    let last = this.filledFrom;
    let changed = false;
    if (!last || last.length !== n) {
      last = this.filledFrom = new Float32Array(n);
      changed = true;
    }
    let at = 0;
    for (const part of [afterLight, afterView, c]) {
      for (let i = 0; i < part.length; i++, at++) {
        const v = Math.fround(part[i]!);
        if (last[at] !== v) {
          last[at] = v;
          changed = true;
        }
      }
    }
    return changed;
  }

  draw(ctx: DrawContext): void {
    if (ctx.pass !== 'color') return;
    const view = ctx.view;
    // The tables stay on their unit for the layers that follow; the unit selected afterwards is a spare one, so a
    // texture made later in the frame does not land on the tables' unit.
    ctx.device.texture(ATMOSPHERE_TABLE_UNIT, this.tables);
    ctx.device.texture(ATMOSPHERE_TABLE_UNIT - 1, null);
    if (view.pixelGrowth <= 0) return;
    const f = view.axes().forward;
    // Corner rays: left-bottom, left-top, right-bottom, right-top. Scaled to depth 1 they interpolate linearly across the screen.
    const [lb, lt, rb] = view.cornerRays().map((r) => {
      const k = 1 / (r.dir[0] * f[0] + r.dir[1] * f[1] + r.dir[2] * f[2]);
      return [r.dir[0] * k, r.dir[1] * k, r.dir[2] * k] as Vec3;
    }) as [Vec3, Vec3, Vec3, Vec3];
    const right: Vec3 = [(rb[0] - lb[0]) / 2, (rb[1] - lb[1]) / 2, (rb[2] - lb[2]) / 2];
    const up: Vec3 = [(lt[0] - lb[0]) / 2, (lt[1] - lb[1]) / 2, (lt[2] - lb[2]) / 2];
    const center: Vec3 = [lb[0] + right[0] + up[0], lb[1] + right[1] + up[1], lb[2] + right[2] + up[2]];
    ctx.device.setState({ depthTest: false, depthWrite: false, cullBack: false });
    ctx.device.use(this.program);
    this.program.set('u_rayCenter', { vec3: center });
    this.program.set('u_rayRight', { vec3: right });
    this.program.set('u_rayUp', { vec3: up });
    this.program.set('u_screen', { vec2: [view.width, view.height] });
    // The sky table on three units of its own for this draw. Without it the samplers still need textures of their
    // kind: the slot's tables stand in, unread.
    const sky = this.usesSkyTable ? this.sky : null;
    const samplers = ['u_atmSkyBase', 'u_atmSkyMie', 'u_atmSkyThrough'];
    samplers.forEach((name, i) => {
      ctx.device.texture(SKY_UNIT + i, sky ? sky.textures[i]! : this.tables);
      this.program.int(name, SKY_UNIT + i);
    });
    this.program.float('u_atmMarch', sky ? 0 : 1);
    ctx.device.drawFullscreen();
    samplers.forEach((_, i) => ctx.device.texture(SKY_UNIT + i, null));
    ctx.device.texture(ATMOSPHERE_TABLE_UNIT - 1, null);
    ctx.count(1);
  }
}

/** The eye of a perspective view (where its corner rays start), or null for an orthographic one. */
function viewEye(view: View): Vec3 | null {
  if (view.pixelGrowth <= 0) return null;
  const o = view.cornerRays()[0]!.origin;
  return [o[0], o[1], o[2]];
}
