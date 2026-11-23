// What the marks need of a page (`MarkHost`) and how they are switched on (`MarkingOptions`). The record types are
// plain data in `base` (marks.ts); these two live here because they hold the page's canvas and a key of the keyboard.

import type { MarkView, PickHit } from '../../base/marks.ts';
import type { Vec3 } from '../../base/math.ts';
import type { Ray } from '../../base/view.ts';

/** What the marks need of the page. */
export interface MarkHost {
  canvas: HTMLCanvasElement;
  /** Whether marking is possible now (a free camera, say). Outside it the mode closes and the pins hide. */
  allowed(): boolean;
  /** The canvas's size in physical pixels, as the camera uses it. */
  size(): [number, number];
  /** The ray under a point of the canvas in physical pixels from the top-left corner, in world metres. */
  ray(px: number, py: number): Ray;
  /** Where a world point lands on the canvas in physical pixels, or null when it is behind the eye or hidden. */
  toScreen(world: Vec3): [number, number] | null;
  /** The point the ray meets, or null when it meets nothing. */
  pick(ray: Ray): PickHit | null;
  /** The camera now, with a hash that reproduces it. */
  view(): MarkView;
  /** What is known of the picked place (or, for a miss, of the view). */
  facts(hit: PickHit | null, ray: Ray): Record<string, unknown>;
  /** Renders one frame at once; the picture is read from the canvas right after it, in the same task. */
  renderNow(): void;
  /** Asks for a frame. */
  invalidate(): void;
  /** Calls `f` before every frame. */
  onFrame(f: () => void): void;
  /** Puts the camera at a mark's view. */
  goto(view: MarkView): void;
}

export interface MarkingOptions {
  /** The store's URL path: `__marks` under the page's base (`${import.meta.env.BASE_URL}__marks` in a Vite page). */
  endpoint: string;
  /** The key (`KeyboardEvent.code`) that switches the mark mode. */
  key: string;
  /** Whether the pins are drawn. */
  pins: boolean;
}
