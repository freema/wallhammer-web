// Keeps a collision world in step with a `SolidIndex`: every solid of the index becomes an upright cylinder or turned
// box of a `CollisionWorld`, added when its cell enters the index and removed when the cell leaves it.
//
// Two ways to use it. On a flat world the collision world is in world coordinates and lives as long as you like:
// `attach(world)` once. On a sphere a `ChartWalker` makes a new collision world in a new chart at every rechart:
// `attach(world, chart)` from its `onRechart` puts the solids near the chart's origin there, in chart coordinates, and
// cells that arrive or leave until the next rechart are added to or taken from that chart's world. A solid stands along
// the chart's y there, which is the local up of a sphere; it is laid flat in the chart like any solid of a chart.

import type { SurfaceChart } from '../base/chart.ts';
import { detAtan2 } from '../base/trig.ts';
import type { CellId } from '../gen-core/cell.ts';
import { cellKey } from '../gen-core/cell.ts';
import type { CollisionWorld } from './collide.ts';
import type { SolidHit, SolidIndex } from './solid-index.ts';

export interface SolidFeedOptions {
  /**
   * With a chart: only the solids within this distance of the chart's origin (on its ground) are added, metres; the
   * rest wait for a later chart. Default 160 m: a chart walker's default `rechartM` (48 m) plus a camera boom and
   * margin. Without a chart every solid is added.
   */
  reachM?: number;
}

export class SolidFeed {
  readonly index: SolidIndex;
  readonly reachM: number;
  private target: CollisionWorld | null = null;
  private chart: SurfaceChart | null = null;
  /** Collision ids added to the current world, by cell key. */
  private readonly ids = new Map<string, number[]>();
  private added = 0;
  private readonly at: [number, number, number] = [0, 0, 0];
  private readonly c3: [number, number, number] = [0, 0, 0];
  private readonly v3: [number, number, number] = [0, 0, 0];
  private readonly stop: () => void;
  private list: number[] | null = null;
  private readonly addHit = (h: SolidHit): void => {
    if (this.chart && h.distance > this.reachM) return;
    const key = cellKey(h.cell);
    let list = this.list;
    if (!list) {
      list = this.ids.get(key) ?? [];
      this.ids.set(key, list);
    }
    list.push(this.addSolid(h));
  };

  constructor(index: SolidIndex, options: SolidFeedOptions = {}) {
    this.index = index;
    this.reachM = options.reachM ?? 160;
    if (!(this.reachM > 0)) throw new Error('SolidFeed: reachM must be positive');
    this.stop = index.listen((cell, added) => (added ? this.cellAdded(cell) : this.cellRemoved(cell)));
  }

  /** The collision world solids are added to, or null. */
  get world(): CollisionWorld | null {
    return this.target;
  }

  /** Solids this feed has in its current world. */
  get count(): number {
    return this.added;
  }

  /**
   * Makes `world` the one to keep in step and adds the index's solids to it: all of them, or with `chart` those within
   * `reachM` of the chart's origin, in chart coordinates. This feed's solids are first taken out of the world attached
   * before (`detach`), so attaching the same world again does not add them twice, and a world left behind holds none
   * of them (a chart walker's old world is dropped anyway; the removal is cheap). Each solid's `tag` is its slot in the
   * index (`SolidIndex.get`). Returns the number added.
   */
  attach(world: CollisionWorld, chart: SurfaceChart | null = null): number {
    this.detach();
    this.target = world;
    this.chart = chart;
    if (chart) {
      chart.toWorld(0, world.baseHeightAt(0, 0), 0, this.at);
      this.index.within(this.at, this.reachM, this.addHit);
    } else {
      this.index.within(this.at, Infinity, this.addHit);
    }
    return this.added;
  }

  /** Removes this feed's solids from its world and forgets the world. */
  detach(): void {
    const w = this.target;
    if (w) for (const list of this.ids.values()) for (const id of list) w.remove(id);
    this.ids.clear();
    this.added = 0;
    this.target = null;
    this.chart = null;
  }

  /** `detach` and stop listening to the index. */
  dispose(): void {
    this.detach();
    this.stop();
  }

  private cellAdded(cell: CellId): void {
    if (!this.target) return;
    const key = cellKey(cell);
    const list: number[] = [];
    this.list = list;
    try {
      this.index.forEachOfCell(cell, this.addHit, this.chart ? this.at : undefined);
    } finally {
      this.list = null;
    }
    if (list.length > 0) this.ids.set(key, list);
  }

  private cellRemoved(cell: CellId): void {
    const key = cellKey(cell);
    const list = this.ids.get(key);
    if (!list) return;
    const w = this.target;
    if (w) for (const id of list) w.remove(id);
    this.added -= list.length;
    this.ids.delete(key);
  }

  /** One solid into the current world, in its coordinates; returns the collision id. */
  private addSolid(h: SolidHit): number {
    const w = this.target!;
    const options = { standable: h.standable, blocksSight: h.blocksSight, tag: h.slot };
    this.added++;
    let x = h.x;
    let y = h.y;
    let z = h.z;
    let yaw = 0;
    const chart = this.chart;
    if (chart) {
      const c = chart.fromWorld(h.x, h.y, h.z, this.c3);
      x = c[0];
      y = c[1];
      z = c[2];
      if (h.halfX > 0) {
        const v = chart.vectorFromWorld(x, z, h.axisX, h.axisY, h.axisZ, this.v3);
        yaw = detAtan2(-v[2], v[0]);
      }
    } else if (h.halfX > 0) {
      yaw = detAtan2(-h.axisZ, h.axisX);
    }
    const lo = y - h.below;
    const hi = y + h.height;
    return h.halfX > 0 ? w.addBox(x, z, h.halfX, h.halfZ, yaw, lo, hi, options) : w.addCylinder(x, z, h.radius, lo, hi, options);
  }
}
