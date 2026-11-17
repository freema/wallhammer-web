// Distance fields in the x-z plane: how far the nearest polygon outline or line edge is from a given point.
// Segments lie in a coarse grid of bins and the query computes the exact distance to the nearest ones,
// so the result is not burdened by the raster resolution. Placement rules query this.

import { distToSegment, pointInRings } from './geometry.ts';
import type { Ring } from './geometry.ts';

/** A set of segments with a distance query. Each segment may have a width (half the width is subtracted from the distance). */
export class SegmentField {
  readonly sizeX: number;
  readonly sizeZ: number;
  /** Edge of a square bin in metres. */
  readonly bucketM: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly buckets: number[][];
  /** Five numbers per segment: ax, az, bx, bz, half width. */
  private readonly segs: number[] = [];
  /** Number of the line (polygon, path) the segment belongs to. */
  private readonly owner: number[] = [];

  constructor(sizeX: number, sizeZ: number, bucketM = 8) {
    this.sizeX = sizeX;
    this.sizeZ = sizeZ;
    this.bucketM = bucketM;
    this.cols = Math.max(1, Math.ceil(sizeX / bucketM));
    this.rows = Math.max(1, Math.ceil(sizeZ / bucketM));
    this.buckets = Array.from({ length: this.cols * this.rows }, () => []);
  }

  get count(): number {
    return this.owner.length;
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.bucketM)));
  }

  private row(z: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor(z / this.bucketM)));
  }

  add(ax: number, az: number, bx: number, bz: number, halfWidth = 0, owner = 0): void {
    const id = this.owner.length;
    this.segs.push(ax, az, bx, bz, halfWidth);
    this.owner.push(owner);
    const c0 = this.col(Math.min(ax, bx) - halfWidth);
    const c1 = this.col(Math.max(ax, bx) + halfWidth);
    const r0 = this.row(Math.min(az, bz) - halfWidth);
    const r1 = this.row(Math.max(az, bz) + halfWidth);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.buckets[r * this.cols + c]!.push(id);
  }

  /** Polyline as a flat array x, z. */
  addPolyline(points: ArrayLike<number>, halfWidth = 0, owner = 0, closed = false): void {
    const n = points.length / 2;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n;
      this.add(points[i * 2]!, points[i * 2 + 1]!, points[j * 2]!, points[j * 2 + 1]!, halfWidth, owner);
    }
  }

  /**
   * Distance to the nearest segment reduced by its half width, at most `maxDistance`.
   * `skipOwner` omits the segments of one line.
   */
  distance(x: number, z: number, maxDistance: number, skipOwner = -1): number {
    let best = maxDistance;
    const c0 = this.col(x - maxDistance);
    const c1 = this.col(x + maxDistance);
    const r0 = this.row(z - maxDistance);
    const r1 = this.row(z + maxDistance);
    const s = this.segs;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const id of this.buckets[r * this.cols + c]!) {
          if (this.owner[id] === skipOwner) continue;
          const o = id * 5;
          const d = distToSegment(x, z, s[o]!, s[o + 1]!, s[o + 2]!, s[o + 3]!) - s[o + 4]!;
          if (d < best) best = d;
        }
      }
    }
    return best;
  }
}

/** How far the outline field searches at most. Beyond that no rule needs the distance. */
const OUTLINE_SEARCH_M = 24;

/** Signed distance field to the outlines of a set of polygons (each a ring set with holes). */
export class OutlineField {
  readonly sizeX: number;
  readonly sizeZ: number;
  private readonly segments: SegmentField;
  private readonly polygons: Ring[][];
  private readonly bucketM: number;
  private readonly cols: number;
  private readonly rows: number;
  /** Polygons whose bounding rectangle reaches into the bin. */
  private readonly inBucket: number[][];

  /** `polygons[i]` are the rings of one polygon: outer boundary and possible holes. */
  constructor(polygons: Ring[][], sizeX: number, sizeZ: number, bucketM = 8) {
    this.sizeX = sizeX;
    this.sizeZ = sizeZ;
    this.polygons = polygons;
    this.bucketM = bucketM;
    this.cols = Math.max(1, Math.ceil(sizeX / bucketM));
    this.rows = Math.max(1, Math.ceil(sizeZ / bucketM));
    this.inBucket = Array.from({ length: this.cols * this.rows }, () => []);
    this.segments = new SegmentField(sizeX, sizeZ, bucketM);
    const clampCol = (x: number): number => Math.min(this.cols - 1, Math.max(0, Math.floor(x / bucketM)));
    const clampRow = (z: number): number => Math.min(this.rows - 1, Math.max(0, Math.floor(z / bucketM)));
    polygons.forEach((rings, i) => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const ring of rings) {
        this.segments.addPolyline(ring, 0, i, true);
        for (let k = 0; k < ring.length; k += 2) {
          minX = Math.min(minX, ring[k]!);
          maxX = Math.max(maxX, ring[k]!);
          minZ = Math.min(minZ, ring[k + 1]!);
          maxZ = Math.max(maxZ, ring[k + 1]!);
        }
      }
      for (let r = clampRow(minZ); r <= clampRow(maxZ); r++) for (let c = clampCol(minX); c <= clampCol(maxX); c++) this.inBucket[r * this.cols + c]!.push(i);
    });
  }

  /** Does a point lie inside some polygon? */
  inside(x: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ) return false;
    const b = Math.floor(z / this.bucketM) * this.cols + Math.floor(x / this.bucketM);
    for (const i of this.inBucket[b] ?? []) if (pointInRings(x, z, this.polygons[i]!)) return true;
    return false;
  }

  /**
   * Distance from a point to the nearest outline in metres, at most `maxDistance`. Negative inside a polygon.
   * Computed exactly to the polygon edges, not from the raster.
   */
  distance(x: number, z: number, maxDistance = OUTLINE_SEARCH_M): number {
    const d = this.segments.distance(x, z, maxDistance);
    return this.inside(x, z) ? -d : d;
  }

  /** The field written out to a raster with step `step` (value at the cell centre), for textures and debugging. */
  rasterize(step: number, maxDistance = OUTLINE_SEARCH_M): { data: Float32Array; cols: number; rows: number; step: number } {
    const cols = Math.ceil(this.sizeX / step);
    const rows = Math.ceil(this.sizeZ / step);
    const data = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) data[j * cols + i] = this.distance((i + 0.5) * step, (j + 0.5) * step, maxDistance);
    return { data, cols, rows, step };
  }
}
