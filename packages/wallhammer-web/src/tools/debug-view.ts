// Data view for debugging: a surface in flat false colours by class code, without light and shadows,
// with outlines over it. The engine does not know what the codes mean: the app supplies codes, colours and lines
// (`codeTexture`, `colorTable` from gen-tex and `lineMesh` from gen-mesh, uploaded with the renderer).

import type { RGB } from '../base/math.ts';
import type { Mesh, Texture } from '../gpu/index.ts';

/** What the data view draws. Assigned to `DataView.setup`, `null` turns it off. */
export interface DataViewSetup {
  /** Class raster as an unsigned integer texture (`codeTexture`). Pixel (0, 0) is at x = 0, z = 0. */
  classes: Texture;
  /** Pixel size of the class raster in metres. */
  classStep: number;
  /** Colours by class code (`colorTable`). */
  colors: Texture;
  /** Lines over the surface, each set in its own colour (`lineMesh`). Drawn without a depth test, always on top. */
  lines: { mesh: Mesh; color: RGB }[];
  /** Optional mask over the class colours. `null` or missing = none. */
  mask?: DataViewMask | null;
}

/**
 * Mask drawn over the class colours: an unsigned integer texture on the same grid as `classes`.
 * Value 0 = nothing, 1 = diagonal hatch, 2 and more = cross-hatch. The edge of the masked area gets a solid outline.
 */
export interface DataViewMask {
  texture: Texture;
  color: RGB;
  /** Distance of hatch lines in metres. */
  hatchM: number;
  /** Opacity of the hatch lines, 0–1. The outline is always opaque. */
  opacity: number;
}
