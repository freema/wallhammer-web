// Layers of the data view: the ground in flat class colours (data pass) and single-colour lines over everything.

import type { RGB } from '../base/math.ts';
import type { Mesh, Program } from '../gpu/index.ts';
import { MeshLayer } from '../render/index.ts';
import type { DrawContext, Layer, Renderer } from '../render/index.ts';
import { DATA_TERRAIN_FS, LINE_FS, LINE_VS } from './data-view-glsl.ts';
import type { DataViewSetup } from './debug-view.ts';

/** Texture units used by the data ground. */
const CLASS_UNIT = 2;
const COLOR_UNIT = 3;
const MASK_UNIT = 4;

export interface DataViewOptions {
  /** Vertex shader of the ground mesh. It must pass `v_world`, `v_normal` and `flat v_kind` (> 0.5 = side skirt). May use includes. */
  groundVs: string;
  groundAttribs: Record<string, number>;
  /** Colour of the side skirt (drawn at 60 %). */
  skirt: RGB;
}

export class DataView {
  /** `null` = nothing to draw. */
  setup: DataViewSetup | null = null;
  /** The ground in class colours. Its `mesh` is the ground mesh of the scene. */
  readonly ground: MeshLayer;
  /** Lines over everything, without a depth test. Register it after all other layers of the data pass. */
  readonly lines: Layer;

  constructor(renderer: Renderer, o: DataViewOptions) {
    const material = renderer.material({ name: 'data view', attribs: o.groundAttribs, passes: { data: { vs: o.groundVs, fs: DATA_TERRAIN_FS } } });
    this.ground = new MeshLayer({
      material,
      passes: ['data'],
      bind: (p: Program, ctx: DrawContext) => {
        const dv = this.setup;
        if (!dv) return;
        ctx.device.texture(CLASS_UNIT, dv.classes);
        ctx.device.texture(COLOR_UNIT, dv.colors);
        p.int('u_classes', CLASS_UNIT);
        p.int('u_colors', COLOR_UNIT);
        p.float('u_classStep', dv.classStep);
        p.vec3v('u_earth', o.skirt);
        // Without a mask the unit still gets an integer texture, so the sampler type always matches.
        ctx.device.texture(MASK_UNIT, dv.mask ? dv.mask.texture : dv.classes);
        p.int('u_mask', MASK_UNIT);
        p.int('u_maskOn', dv.mask ? 1 : 0);
        if (dv.mask) {
          p.vec3('u_maskColor', dv.mask.color[0], dv.mask.color[1], dv.mask.color[2]);
          p.float('u_hatchM', dv.mask.hatchM);
          p.float('u_maskOpacity', dv.mask.opacity);
        }
      },
    });
    const line = renderer.device.program('data view lines', renderer.resolve(LINE_VS), LINE_FS, { a_pos: 0 });
    this.lines = {
      draw: (ctx: DrawContext): void => {
        const dv = this.setup;
        if (ctx.pass !== 'data' || !dv) return;
        ctx.device.setState({ depthTest: false });
        ctx.device.use(line);
        for (const set of dv.lines) {
          line.vec3('u_color', set.color[0], set.color[1], set.color[2]);
          drawLines(ctx, set.mesh);
        }
      },
    };
  }
}

function drawLines(ctx: DrawContext, mesh: Mesh): void {
  ctx.device.draw(mesh);
  ctx.count(0);
}
