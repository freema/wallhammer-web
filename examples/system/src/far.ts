// What the system example draws beside the streamed surface of the body the camera is at: the stars, every body from
// afar (the six coarsest cells of its own generator), the sun, the paths, and the air of the bodies as shells.
//
// Two layers, because the streamed surface is drawn between them: `FarLayer` first (the stars behind everything, the
// solid bodies, the sun and the paths), `ShellLayer` last (the air, blended over what is behind it). Both only read
// `FarScene`, which the page fills before every frame with positions in render space.

import type { MeshData, Vec3, VertexLayout } from 'wallhammer-web/base';
import type { Mesh, Program } from 'wallhammer-web/gpu';
import { SHADOW_MAP_UNIT } from 'wallhammer-web/render';
import type { DrawContext, Layer, Renderer } from 'wallhammer-web/render';
import { SKY_VS } from 'wallhammer-web/runtime';
import { CORNER_ATTRIBS, FAR_BODY_ATTRIBS, FAR_BODY_FS, FAR_BODY_SHADE_ATTRIBS, FAR_BODY_SHADE_FS, FAR_BODY_SHADE_VS, FAR_BODY_VS, PATH_FS, PATH_VS, PLAN_MARK_VS, POSITION_ATTRIBS, SHELL_FS, SHELL_VS, STARS_FS, SUN_FS, SUN_VS } from './shaders.ts';

/** One body with a surface, as the layers draw it. */
export interface FarBody {
  /** Radius of the ground and of the top of its air in metres (equal: no air). */
  readonly radiusM: number;
  readonly topM: number;
  /** The lit air seen from afar. */
  readonly airColor: readonly [number, number, number];
  /** The coarsest cells on the GPU with their origins from the centre, in the body's own frame. Empty until made. */
  cells: { mesh: Mesh; origin: Vec3 }[];
  /** Centre in render space. */
  center: Vec3;
  /** The body's own frame → render space (only the turn is read). */
  model: Float32Array;
  /** Unit direction from the body to the sun, in the axes of render space. */
  toSun: Vec3;
  /** Size it is drawn at: 1 its own, more to keep it a visible dot. */
  size: number;
  /** Whether the solid body is drawn here (not while its streamed surface covers it). */
  solid: boolean;
  /** Opacity of the shell of air, 0–1. */
  shell: number;
  /**
   * Stage 5: 1 when the cells carry the skyline codes (`a_extra`) and the far program of a layer made with `shade`
   * reads them; absent or 0 for every other body and every cell without the channel.
   */
  shade?: number;
  /**
   * 1 when the alpha of the cells' colour is the depth code of a planned body (planned-cell.ts, `depthCode`): water is
   * drawn where the depth is above zero. Absent or 0: the alpha is 0 on land, 1 on the sea.
   */
  depthCode?: number;
}

/** A closed path: a line mesh in the frame of the body it goes round. */
export interface FarPath {
  mesh: Mesh;
  /** The frame of the path → render space. */
  model: Float32Array;
  color: readonly [number, number, number];
}

/** Plain line segments drawn over a body (the marks of the plan of the world), in the body's own frame. */
export interface FarMark {
  mesh: Mesh;
  /** The body they lie on: its `model` places them. */
  body: FarBody;
  color: readonly [number, number, number, number];
}

/** Everything the two layers read. The page fills it before every frame. */
export interface FarScene {
  /** The eye in render space. */
  eye: Vec3;
  /** 0–1: share of the engine's atmosphere in the picture. */
  airNear: number;
  /** 0–1: how much of the stars shows. */
  starGain: number;
  /** Directions of render space → directions of the frame the stars are fixed in. */
  toFixed: Float32Array;
  sun: { center: Vec3; radiusM: number; size: number };
  bodies: FarBody[];
  paths: FarPath[];
  /** Opacity of the paths, 0–1. */
  pathAlpha: number;
  /** The second list of line meshes: marks over a body, drawn after the streamed surface with the depth test on. */
  marks: FarMark[];
  /** Whether the marks are drawn. */
  showMarks: boolean;
  /** Stage 5 (key H): the shaded bodies show the lit factor of the shade alone, in grey. */
  shadeView?: boolean;
}

/** Share of its distance to the eye a mark is moved toward it: enough to clear the facets of the surface under it. */
const MARK_LIFT = 0.004;

const POSITION_LAYOUT: VertexLayout = { stride: 12, attribs: [{ name: 'a_pos', size: 3, type: 'f32', offset: 0 }] };
const CORNER_LAYOUT: VertexLayout = { stride: 8, attribs: [{ name: 'a_corner', size: 2, type: 'f32', offset: 0 }] };

/** A unit sphere, triangles facing out. */
function sphereMesh(around: number, down: number): MeshData {
  const vertices = new Float32Array((around + 1) * (down + 1) * 3);
  let v = 0;
  for (let j = 0; j <= down; j++) {
    const phi = (j / down) * Math.PI;
    for (let i = 0; i <= around; i++) {
      const theta = (i / around) * 2 * Math.PI;
      vertices[v++] = Math.sin(phi) * Math.cos(theta);
      vertices[v++] = Math.cos(phi);
      vertices[v++] = Math.sin(phi) * Math.sin(theta);
    }
  }
  const indices = new Uint16Array(around * down * 6);
  let k = 0;
  for (let j = 0; j < down; j++) {
    for (let i = 0; i < around; i++) {
      const a = j * (around + 1) + i;
      const b = a + around + 1;
      indices[k++] = a;
      indices[k++] = b + 1;
      indices[k++] = b;
      indices[k++] = a;
      indices[k++] = a + 1;
      indices[k++] = b + 1;
    }
  }
  return { layout: POSITION_LAYOUT, vertices, indices, count: indices.length };
}

/** A closed line through points given as x, y, z triples. */
export function pathMesh(points: ArrayLike<number>): MeshData {
  const n = Math.floor(points.length / 3);
  const indices = new Uint16Array(n * 2);
  for (let i = 0; i < n; i++) {
    indices[i * 2] = i;
    indices[i * 2 + 1] = (i + 1) % n;
  }
  return { layout: POSITION_LAYOUT, vertices: Float32Array.from(points), indices, count: indices.length, primitive: 'lines' };
}

/** The stars, the solid bodies, the sun and the paths. Colour pass only: nothing here casts a shadow. */
export class FarLayer implements Layer {
  readonly scene: FarScene;
  private readonly renderer: Renderer;
  private readonly stars: Program;
  private readonly body: Program;
  private readonly sun: Program;
  private readonly path: Program;
  private readonly square: Mesh;
  /** Stage 5: the bodies are drawn with the program that reads the skyline codes (`FarBody.shade`). */
  private readonly shade: boolean;

  constructor(renderer: Renderer, scene: FarScene, o: { shade?: boolean } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.shade = o.shade ?? false;
    const device = renderer.device;
    const r = (src: string): string => renderer.resolve(src);
    this.stars = device.program('system stars', SKY_VS, r(STARS_FS));
    this.body = this.shade
      ? device.program('system far body shade', r(FAR_BODY_SHADE_VS), r(FAR_BODY_SHADE_FS), FAR_BODY_SHADE_ATTRIBS)
      : device.program('system far body', r(FAR_BODY_VS), r(FAR_BODY_FS), FAR_BODY_ATTRIBS);
    this.sun = device.program('system sun', r(SUN_VS), r(SUN_FS), CORNER_ATTRIBS);
    this.path = device.program('system path', r(PATH_VS), r(PATH_FS), POSITION_ATTRIBS);
    this.square = device.createMesh({ layout: CORNER_LAYOUT, vertices: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), indices: new Uint16Array([0, 1, 2, 0, 2, 3]), count: 6 }, CORNER_ATTRIBS);
  }

  /** Uploads a line mesh for a path. */
  createPath(points: ArrayLike<number>): Mesh {
    return this.renderer.device.createMesh(pathMesh(points), POSITION_ATTRIBS);
  }

  /** Uploads plain line segments (x, y, z per end, two ends per segment) for a mark. */
  createLines(points: Float32Array): Mesh {
    const layout: VertexLayout = POSITION_LAYOUT;
    return this.renderer.device.createMesh({ layout, vertices: points, indices: null, count: Math.floor(points.length / 3), primitive: 'lines' }, POSITION_ATTRIBS);
  }

  /** Uploads one coarsest cell of a body. */
  createCell(mesh: MeshData): Mesh {
    return this.renderer.device.createMesh(mesh, this.shade ? FAR_BODY_SHADE_ATTRIBS : FAR_BODY_ATTRIBS);
  }

  draw(ctx: DrawContext): void {
    if (ctx.pass !== 'color') return;
    const s = this.scene;
    const device = ctx.device;
    const view = ctx.view;

    // The stars, added to the sky the engine has drawn.
    if (s.starGain > 0.003 && view.pixelGrowth > 0) {
      const f = view.axes().forward;
      // Corner rays: left-bottom, left-top, right-bottom. Scaled to depth 1 they interpolate linearly across the screen.
      const [lb, lt, rb] = view.cornerRays().map((ray) => {
        const k = 1 / (ray.dir[0] * f[0] + ray.dir[1] * f[1] + ray.dir[2] * f[2]);
        return [ray.dir[0] * k, ray.dir[1] * k, ray.dir[2] * k] as Vec3;
      }) as [Vec3, Vec3, Vec3, Vec3];
      const right: Vec3 = [(rb[0] - lb[0]) / 2, (rb[1] - lb[1]) / 2, (rb[2] - lb[2]) / 2];
      const up: Vec3 = [(lt[0] - lb[0]) / 2, (lt[1] - lb[1]) / 2, (lt[2] - lb[2]) / 2];
      device.setState({ depthTest: false, depthWrite: false, cullBack: false, blend: { src: 'one', dst: 'one' } });
      device.use(this.stars);
      this.stars.vec3('u_rayCenter', lb[0] + right[0] + up[0], lb[1] + right[1] + up[1], lb[2] + right[2] + up[2]);
      this.stars.vec3v('u_rayRight', right);
      this.stars.vec3v('u_rayUp', up);
      this.stars.vec2('u_screen', view.width, view.height);
      this.stars.mat4('u_toFixed', s.toFixed);
      this.stars.float('u_gain', s.starGain);
      device.drawFullscreen();
      ctx.count(1);
    }

    // The solid bodies.
    device.setState({ depthTest: true, depthWrite: true, cullBack: true, blend: null });
    device.use(this.body);
    this.body.int('u_shadowMap', SHADOW_MAP_UNIT);
    this.body.vec3v('u_eyePos', s.eye);
    this.body.float('u_airNear', s.airNear);
    if (this.shade) this.body.float('u_shadeView', s.shadeView ? 1 : 0);
    for (const b of s.bodies) {
      if (!b.solid || b.cells.length === 0) continue;
      this.body.mat4('u_model', b.model);
      this.body.set('u_body', { vec4: [b.center[0], b.center[1], b.center[2], b.size] });
      this.body.vec3v('u_toSun', b.toSun);
      if (this.shade) this.body.float('u_shade', b.shade ?? 0);
      this.body.float('u_depthCode', b.depthCode ?? 0);
      for (const c of b.cells) {
        this.body.vec3v('u_cellOrigin', c.origin);
        device.draw(c.mesh);
        ctx.count(c.mesh.triangles);
      }
    }

    // The sun: a disc and its glow, added to what is behind and hidden by what is in front.
    device.setState({ depthTest: true, depthWrite: false, cullBack: false, blend: { src: 'one', dst: 'one' } });
    device.use(this.sun);
    // The square reaches six radii out, for the glow.
    const reach = 6;
    this.sun.vec3v('u_eyePos', s.eye);
    this.sun.set('u_disc', { vec4: [s.sun.center[0], s.sun.center[1], s.sun.center[2], s.sun.radiusM * s.sun.size * reach] });
    this.sun.set('u_glow', { vec4: [1 / reach, s.airNear, 0, 0] });
    device.draw(this.square);
    ctx.count(2);

    // The paths.
    if (s.pathAlpha > 0.003) {
      device.setState({ depthTest: true, depthWrite: false, cullBack: false, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' } });
      device.use(this.path);
      this.path.vec3v('u_eyePos', s.eye);
      for (const p of s.paths) {
        this.path.mat4('u_model', p.model);
        this.path.set('u_color', { vec4: [p.color[0], p.color[1], p.color[2], s.pathAlpha] });
        device.draw(p.mesh);
        ctx.count(0);
      }
    }
  }
}

/**
 * The air of every body that has some, as a shell seen from outside, and the marks over the bodies. Drawn after
 * everything solid, so the marks are tested against the depth of the streamed surface too.
 */
export class ShellLayer implements Layer {
  readonly scene: FarScene;
  private readonly program: Program;
  private readonly sphere: Mesh;
  private readonly renderer: Renderer;
  /** Made when the first mark is drawn: a page without marks compiles nothing more. */
  private mark: Program | null = null;

  constructor(renderer: Renderer, scene: FarScene) {
    this.scene = scene;
    this.renderer = renderer;
    this.program = renderer.device.program('system shell', renderer.resolve(SHELL_VS), renderer.resolve(SHELL_FS), POSITION_ATTRIBS);
    this.sphere = renderer.device.createMesh(sphereMesh(96, 48), POSITION_ATTRIBS);
  }

  draw(ctx: DrawContext): void {
    if (ctx.pass !== 'color') return;
    const s = this.scene;
    const device = ctx.device;
    this.drawShells(ctx);
    if (!s.showMarks || s.marks.length === 0) return;
    const r = this.renderer;
    const mark = (this.mark ??= device.program('system plan mark', r.resolve(PLAN_MARK_VS), r.resolve(PATH_FS), POSITION_ATTRIBS));
    device.setState({ depthTest: true, depthWrite: false, cullBack: false, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' } });
    device.use(mark);
    mark.vec3v('u_eyePos', s.eye);
    mark.float('u_lift', MARK_LIFT);
    for (const m of s.marks) {
      mark.mat4('u_model', m.body.model);
      mark.set('u_color', { vec4: [m.color[0], m.color[1], m.color[2], m.color[3]] });
      device.draw(m.mesh);
      ctx.count(0);
    }
  }

  private drawShells(ctx: DrawContext): void {
    const s = this.scene;
    const device = ctx.device;
    let begun = false;
    for (const b of s.bodies) {
      if (b.topM <= b.radiusM || b.shell <= 0.003) continue;
      if (!begun) {
        begun = true;
        // Only the near half of the shell: from inside it nothing is drawn, the engine's atmosphere is the air there.
        device.setState({ depthTest: true, depthWrite: false, cullBack: true, blend: { src: 'src-alpha', dst: 'one-minus-src-alpha' } });
        device.use(this.program);
        this.program.vec3v('u_eyePos', s.eye);
      }
      this.program.set('u_body', { vec4: [b.center[0], b.center[1], b.center[2], b.size] });
      this.program.set('u_shell', { vec4: [b.radiusM, b.topM, b.shell, s.airNear] });
      this.program.vec3v('u_toSun', b.toSun);
      this.program.vec3v('u_airColor', b.airColor);
      device.draw(this.sphere);
      ctx.count(this.sphere.triangles);
    }
  }
}
