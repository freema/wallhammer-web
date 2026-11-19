// Cloud shadows from a texture and the cloud weather map: two layers that draw nothing in the passes and fill their
// own targets in `prepare`.
//
// `CloudShadowLayer` draws the cloud shadow texture of the slot `cloudShadowSlot` (see env/cloud-shadow.ts): 512²
// texels over a square of 24 cloud sizes across the light around the eye, every few frames, snapped to whole texels.
// `cloudLight` then costs one lookup where the texture reaches instead of the noise octaves of the cloud pattern.
// With a source (the volumetric clouds) the texture holds the shadows of the source's clouds instead of the pattern.
// `CloudWeatherMap` holds the weather of the clouds over every place: a cube map under radial up, a tile around the
// eye on a flat world, with the cover, the cloud type and the precipitation. The volumetric clouds and the cloud shell
// read it.

import type { Vec3 } from '../base/math.ts';
import type { View } from '../base/view.ts';
import type { EnvSlot } from '../base/env-slot.ts';
import type { ColorTarget, CubeTarget, Device, Program, Texture } from '../gpu/index.ts';
import type { Uniforms } from '../base/material.ts';
import type { DrawContext, Layer, Renderer } from '../render/index.ts';
import { CLOUD_FIELD_SLOT, CLOUD_SHADOW_UNIT, DEFAULT_CLOUD_WEATHER_RULES, cloudShadowFillFs, cloudWeatherFillFs } from '../env/index.ts';
import type { CloudFieldValues, CloudShadowParams, CloudShadowValues, CloudWeatherRules } from '../env/index.ts';
import type { EnvironmentLink } from './environment-link.ts';

const FILL_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** The eye of a perspective view, or null for an orthographic one. */
function viewEye(view: View): Vec3 | null {
  if (view.pixelGrowth <= 0) return null;
  const o = view.cornerRays()[0]!.origin;
  return [o[0], o[1], o[2]];
}

export interface CloudShadowOptions {
  /** Edge of the texture's square in metres. Default 24 cloud sizes (`CloudConfig.sizeM`; 57.6 km for 2400 m). */
  extentM?: number;
  /** Texels along each edge. Default 512. */
  size?: number;
  /** The texture is drawn again every this many frames (and when the eye has left an eighth of the square). Default 4. */
  interval?: number;
}

/** Clouds that cast the shadows of the cloud shadow texture (`CloudShadowLayer.source`): the volumetric clouds. */
export interface CloudShadowSource {
  /**
   * GLSL that defines `vec2 cloudShadowDepth(vec3 point, vec3 L)` with what it reads: the clouds' optical depth along
   * the light from a point of the base surface (render space) and how much it replaces the pattern (see
   * `cloudShadowFillFs`'s `depth`). Read once.
   */
  readonly shadowDepthGlsl: string;
  /**
   * Binds the source's textures for a draw of the texture and returns its uniforms, or null when the pattern alone
   * should make this draw (the source is faded out or not ready).
   */
  bindShadowDepth(device: Device): Uniforms | null;
  /** Takes the textures of `bindShadowDepth` off their units after the draw. */
  unbindShadowDepth(device: Device): void;
}

/**
 * Draws the cloud shadow texture for the slot it is given (which must be part of the link's Frame block, so the link
 * registered the texture variant of `cloudLight`). Add it like any layer; `enabled = false` makes `cloudLight`
 * compute the share everywhere again (the same picture, at the old cost), for comparisons.
 */
export class CloudShadowLayer implements Layer {
  /** Name in profiles (`Layer.name`). */
  readonly name: string = 'cloud-shadows';
  readonly slot: EnvSlot<CloudShadowParams, CloudShadowValues>;
  /** Frames between two draws of the texture. */
  interval: number;
  /** Times the texture has been drawn. */
  draws = 0;
  /**
   * Clouds whose shadows the texture holds instead of the pattern's, or null (`createEngine` sets the volumetric
   * clouds here when it makes both). Beyond the texture `cloudLight` still follows the pattern.
   */
  source: CloudShadowSource | null = null;
  private readonly link: EnvironmentLink;
  private readonly renderer: Renderer;
  private readonly target: ColorTarget | null;
  private readonly program: Program | null;
  private readonly byPlace: boolean;
  /** The program with the source's depth, and the source it was made for. */
  private sourceProgram: { source: CloudShadowSource; program: Program } | null = null;
  private _enabled = true;
  private sinceDraw = Infinity;

  constructor(renderer: Renderer, link: EnvironmentLink, slot: EnvSlot<CloudShadowParams, CloudShadowValues>, o: CloudShadowOptions = {}) {
    this.slot = slot;
    this.link = link;
    this.renderer = renderer;
    this.interval = Math.max(1, o.interval ?? 4);
    const p = slot.params;
    if (o.extentM !== undefined) p.extentM = o.extentM;
    if (o.size !== undefined) p.size = o.size;
    this.target = renderer.device.colorTarget(p.size, p.size, 1, 'rgba8');
    const byPlace = link.block.slots.some((s) => s.name === CLOUD_FIELD_SLOT);
    this.byPlace = byPlace;
    this.program = this.target ? renderer.device.program('cloud shadow', FILL_VS, renderer.resolve(cloudShadowFillFs({ cloudField: byPlace }), 'other')) : null;
    // A fresh context holds an empty texture.
    renderer.device.onRestored(() => (this.sinceDraw = Infinity));
    // Before the environment is packed, so this frame's eye and draw decision go into this frame's block.
    renderer.beforeFrame.unshift((view) => {
      p.active = this._enabled && this.target !== null;
      p.eye = viewEye(view);
      const c = renderer.upCenter();
      const wo = renderer.worldOrigin;
      p.reference = c ?? [-wo[0], -wo[1], -wo[2]];
      p.radiusM = c && renderer.radialUp ? renderer.radialUp.radiusM : null;
      this.sinceDraw++;
      p.redraw = this.sinceDraw >= this.interval || this.eyeLeft(p);
    });
  }

  /** True while `cloudLight` reads the texture. */
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(on: boolean) {
    if (on && !this._enabled) this.sinceDraw = Infinity;
    this._enabled = on;
  }

  /** The texture (R: the share of the sun), or null where it cannot be made. Read it when it is used: a restore replaces it. */
  get texture(): Texture | null {
    return this.target ? this.target.textures[0]! : null;
  }

  /** Draws the texture at once in the next frame (after the light or the clouds jumped). */
  invalidate(): void {
    this.sinceDraw = Infinity;
  }

  /** True when the eye's place on the base surface is more than an eighth of the square from its centre. */
  private eyeLeft(p: CloudShadowParams): boolean {
    const last = p.last;
    if (!last || !p.eye) return true;
    const ref = p.reference;
    const e: Vec3 = [p.eye[0] - ref[0], p.eye[1] - ref[1], p.eye[2] - ref[2]];
    let g: Vec3;
    if (p.radiusM !== null) {
      const l = Math.hypot(e[0], e[1], e[2]) || 1;
      g = [(e[0] / l) * p.radiusM, (e[1] / l) * p.radiusM, (e[2] / l) * p.radiusM];
    } else g = [e[0], 0, e[2]];
    const d: Vec3 = [g[0] - last.origin[0], g[1] - last.origin[1], g[2] - last.origin[2]];
    const du = d[0] * last.axisU[0] + d[1] * last.axisU[1] + d[2] * last.axisU[2];
    const dv = d[0] * last.axisV[0] + d[1] * last.axisV[1] + d[2] * last.axisV[2];
    return Math.max(Math.abs(du), Math.abs(dv)) > last.extentM / 8;
  }

  prepare(device: Device, _view: View): void {
    const v = this.link.value(this.slot);
    if (v?.redraw && v.projection && this.target && this.program) {
      // The texture must not be read on its unit while it is drawn into.
      device.texture(CLOUD_SHADOW_UNIT, null);
      const texels = { u_cloudShadowTexels: { float: this.target.width } };
      const source = this.source;
      const extra = source ? source.bindShadowDepth(device) : null;
      if (source && extra) {
        if (this.sourceProgram?.source !== source) {
          const fs = this.renderer.resolve(cloudShadowFillFs({ cloudField: this.byPlace, depth: source.shadowDepthGlsl }), 'other');
          this.sourceProgram = { source, program: device.program('cloud shadow (source)', FILL_VS, fs) };
        }
        device.fill(this.target, this.sourceProgram.program, { ...texels, ...extra });
        source.unbindShadowDepth(device);
      } else device.fill(this.target, this.program, texels);
      this.slot.params.last = v.projection;
      this.sinceDraw = 0;
      this.draws++;
    }
    // On its unit for every layer of the frame; the unit selected afterwards is a spare one.
    device.texture(CLOUD_SHADOW_UNIT, this.texture);
    device.texture(CLOUD_SHADOW_UNIT + 1, null);
  }

  draw(_ctx: DrawContext): void {}
}

export interface CloudWeatherMapOptions {
  /** Texels along each edge of a cube face (radial up) or of the tile (flat). Default 256 and 128. */
  size?: number;
  /** Edge of the tile around the eye on a flat world, in metres. Default 64 km. */
  tileM?: number;
  /** Frames between two refreshes while what the map is made of changes. Default 30. */
  interval?: number;
}

/**
 * The cloud weather map: cloud cover (R), cloud type (G: the deck share, 0 heaped clouds, 1 a flat deck) and
 * precipitation (B) over every place; G and B follow from the cover by `rules` (`cloudWeatherKind`). Radial
 * up: a cube map indexed by unit up in render space (about 6 × 256² texels, 1.5 MB); the cover is the slot
 * `cloudFieldSlot`'s cover by place when the block holds it, otherwise the frame's cover. Flat: a tile of `tileM`
 * around the eye with the frame's cover. It is made whole in the first frame and after a context loss; while its
 * inputs change it is refreshed every `interval` frames, one cube face per frame. Read it with `CLOUD_WEATHER_GLSL`
 * after `bind`.
 */
export class CloudWeatherMap implements Layer {
  readonly name: string = 'cloud-weather';
  interval: number;
  /**
   * How the clouds of a place are typed by its cover: where they flatten into a deck, where they start to rain or
   * snow and how much of that rain falls from tall clouds. Set it to match the app's own weather (the cover from which
   * its places have precipitation). Change it at any time: the map is refreshed as for a change of the cover.
   */
  rules: CloudWeatherRules = { ...DEFAULT_CLOUD_WEATHER_RULES };
  /** Cube faces (or tiles) drawn so far. */
  draws = 0;
  /** Flat worlds: (centre x, centre z in render space, edge in metres, 0) of the tile, for `cloudWeatherTile`. */
  readonly tile: [number, number, number, number] = [0, 0, 0, 0];
  readonly cube: CubeTarget | null;
  private readonly flat: ColorTarget | null;
  private readonly program: Program | null;
  private readonly size: number;
  private readonly tileM: number;
  private readonly fieldSlot: EnvSlot<any, CloudFieldValues> | null;
  private readonly link: EnvironmentLink;
  private readonly renderer: Renderer;
  /** Faces still to draw in this refresh. */
  private pending: number[] = [];
  private madeFrom = '';
  private sinceRefresh = Infinity;

  constructor(renderer: Renderer, link: EnvironmentLink, o: CloudWeatherMapOptions = {}) {
    this.renderer = renderer;
    this.link = link;
    this.interval = Math.max(1, o.interval ?? 30);
    const radial = renderer.radialUp !== null;
    this.size = o.size ?? (radial ? 256 : 128);
    this.tileM = o.tileM ?? 64000;
    this.fieldSlot = (link.block.slots.find((s) => s.name === CLOUD_FIELD_SLOT) as EnvSlot<any, CloudFieldValues> | undefined) ?? null;
    this.cube = radial ? renderer.device.cubeTarget(this.size, 'rgba8') : null;
    this.flat = radial ? null : renderer.device.colorTarget(this.size, this.size, 1, 'rgba8');
    this.program = this.cube || this.flat ? renderer.device.program('cloud weather', FILL_VS, renderer.resolve(cloudWeatherFillFs({ cloudField: radial && this.fieldSlot !== null }), 'other')) : null;
    renderer.device.onRestored(() => (this.madeFrom = ''));
  }

  /** What the map is made of in this frame, as text: a change starts a refresh. */
  private inputs(view: View): string {
    const cover = this.link.frame?.cloudCover ?? 0;
    const k = this.rules;
    const rules = `${k.deckCover.join(',')}|${k.rainCover.join(',')}|${k.convection}`;
    return `${rules}|${this.coverInputs(view, cover)}`;
  }

  private coverInputs(view: View, cover: number): string {
    if (!this.cube) {
      const eye = viewEye(view) ?? [0, 0, 0];
      const step = this.tileM / 8;
      return `${cover}|${Math.round(eye[0] / step)}|${Math.round(eye[2] / step)}`;
    }
    const f = this.fieldSlot ? this.link.value(this.fieldSlot) : undefined;
    const r = this.renderer.radialUp?.radiusM ?? 0;
    if (!f) return `${cover}|${r}`;
    return [f.axis.join(','), f.patchAmount, f.patchOffset.join(','), f.invPatchSize, f.zonal.join(','), f.patchWarp, r].join('|');
  }

  prepare(device: Device, view: View): void {
    if (!this.program) return;
    this.sinceRefresh++;
    const now = this.inputs(view);
    // First frame or a fresh context: every face in this frame. Later, while the inputs change, one face per frame.
    const whole = this.madeFrom === '';
    if (whole || (now !== this.madeFrom && this.pending.length === 0 && this.sinceRefresh >= this.interval)) {
      this.pending = this.cube ? [0, 1, 2, 3, 4, 5] : [0];
      this.madeFrom = now;
      this.sinceRefresh = 0;
      if (this.flat) this.placeTile(view);
    }
    if (this.pending.length === 0) return;
    const k = this.rules;
    const uniforms = {
      u_weatherTexels: { float: this.size },
      u_weatherTile: { vec4: this.tile },
      u_weatherRules: { vec4: [k.deckCover[0], k.deckCover[1], k.rainCover[0], k.rainCover[1]] },
      u_weatherConvection: { float: k.convection },
    } as const;
    if (this.flat) {
      this.pending.length = 0;
      device.fill(this.flat, this.program, uniforms);
      this.draws++;
      return;
    }
    const n = whole ? 6 : 1;
    for (let i = 0; i < n && this.pending.length > 0; i++) {
      const face = this.pending.shift()!;
      device.fillLayer(this.cube!, face, this.program, { ...uniforms, u_weatherFace: { int: face } });
      this.draws++;
    }
  }

  private placeTile(view: View): void {
    const eye = viewEye(view) ?? [0, 0, 0];
    const step = this.tileM / this.size;
    this.tile[0] = Math.round(eye[0] / step) * step;
    this.tile[1] = Math.round(eye[2] / step) * step;
    this.tile[2] = this.tileM;
  }

  /** Binds the map to a texture unit: the cube map (radial up, a `samplerCube`) or the tile (a `sampler2D`). */
  bind(device: Device, unit: number): void {
    if (this.cube) device.cubeTexture(unit, this.cube);
    else device.texture(unit, this.flat ? this.flat.textures[0]! : null);
  }

  draw(_ctx: DrawContext): void {}
}
