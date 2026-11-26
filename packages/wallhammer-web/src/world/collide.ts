// Collision world: a base surface given as a height function plus upright solids (prisms over outlines and
// cylinders), kept in a uniform grid of cells. Queries visit only the cells they touch, allocate nothing and use
// only + − × ÷ and Math.sqrt on the hot paths, so the same inputs give the same numbers.
//
// Scope: a flat world with +y up. A curved world (a sphere, up pointing away from a centre) is not built. Where it
// would plug in is marked "UP:" below: the vertical span of a solid, the height of the base and the vertical
// distance in `clearance` would be measured along a local up instead of along y.

import { detSinCos } from '../base/trig.ts';
import { pointInRings, ringSignedArea } from '../gen-core/geometry.ts';
import type { Ring } from '../gen-core/geometry.ts';
import { marchSurface, rayPrism } from './pick.ts';

export interface CollisionWorldOptions {
  /** Height of the base surface at a point, metres. */
  heightAt(x: number, z: number): number;
  /** Edge of a cell of the lookup grid, metres. Default 8. */
  cellSize?: number;
  /**
   * Lowest and highest value `heightAt` returns, when known. A ray only searches for the base surface between them,
   * so a ray above the highest point costs nothing. Default: unknown (the whole ray is searched).
   */
  baseMinY?: number;
  baseMaxY?: number;
  /** Horizontal step of the ray search for the base surface, metres. Default 0.5; finer for a sharper surface. */
  baseStep?: number;
  /**
   * Where the base surface exists, as [minX, minZ, maxX, maxZ] in metres, when it ends somewhere (a terrain of a given
   * size). A ray searches for the base only inside it, so a ray that leaves it (toward an empty horizon) stops early.
   * Default: everywhere, and a ray that misses everything searches the base to its end (`maxT`, at most 1e5 lengths,
   * which takes milliseconds); pass a finite `maxT` or this extent for endless rays.
   */
  baseExtent?: readonly [number, number, number, number];
  /**
   * Surface tag of the base surface at a point: a small integer the game gives meaning to (what the ground is made of,
   * how it marks or dusts), reported by `groundTagAt` and in ray hits on the base. Default: −1 everywhere.
   */
  baseTagAt?(x: number, z: number): number;
}

export interface SolidOptions {
  /** Can be stood on (its top is a walkable surface). Default true. */
  standable?: boolean;
  /** Stops a ray and a camera boom. Default true (false for invisible limits). */
  blocksSight?: boolean;
  /** Caller's number, returned in hits. */
  tag?: number;
}

/**
 * A ray hit: parameter `t` along the ray, the point, the unit normal (turned against the ray), the solid id (−1 for the
 * base surface) and its tag (for the base surface the `baseTagAt` of the world's options there, −1 without it).
 */
export interface RayHit { t: number; x: number; y: number; z: number; nx: number; ny: number; nz: number; solid: number; tag: number }

/** Result of `slide`: the reached centre, whether a side was touched, the last contact normal (unit, horizontal) and that solid (−1: none). */
export interface SlideResult { x: number; z: number; hit: boolean; nx: number; nz: number; solid: number }

/** A read-only description of one solid, for debug drawing (`forEachSolid`). */
/** The body `CollisionWorld.standSpot` and `firstStandSpot` fit: an upright cylinder and its limits. */
export interface StandSpotOptions {
  /** Radius of the body's cylinder, m. */
  radius: number;
  /** Height of the cylinder from its feet, m. */
  height: number;
  /** The step the body climbs: solids lower than this over the feet do not block the way. */
  maxStepUp: number;
  /** Most the ground at the spot may lie above or below the given level, m. Default `maxStepUp`. */
  maxRise?: number;
  /** Farthest the cylinder may end from the spot after sliding there, m. Default 0.02. */
  tolerance?: number;
}

export interface SolidInfo {
  kind: 'prism' | 'cylinder';
  /** Prism: the outline as x, z pairs (do not change it). Cylinder: null. */
  outline: Float32Array | null;
  /** Cylinder: centre and radius. Prism: 0. */
  x: number;
  z: number;
  radius: number;
  minY: number;
  maxY: number;
  standable: boolean;
  blocksSight: boolean;
  tag: number;
}

/**
 * Result of `sphereContacts`: `count` contacts, each a depth (metres, positive: how far the sphere reaches in), the
 * unit normal that leads the sphere out (x, y, z) and the solid's id (−1 for the base surface). Arrays of a fixed
 * capacity, reused from call to call.
 */
export interface SphereContacts {
  count: number;
  readonly depth: Float64Array;
  readonly nx: Float64Array;
  readonly ny: Float64Array;
  readonly nz: Float64Array;
  readonly solid: Int32Array;
}

/** A fresh `SphereContacts` holding at most `capacity` contacts (allocate once, reuse). */
export function newSphereContacts(capacity = 8): SphereContacts {
  const n = capacity > 0 ? Math.floor(capacity) : 1;
  return { count: 0, depth: new Float64Array(n), nx: new Float64Array(n), ny: new Float64Array(n), nz: new Float64Array(n), solid: new Int32Array(n) };
}

/** A fresh `RayHit` to pass to `raycast` (allocate once, reuse). */
export function newRayHit(): RayHit {
  return { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, solid: -1, tag: -1 };
}

/** A fresh `SlideResult` to pass to `slide` (allocate once, reuse). */
export function newSlideResult(): SlideResult {
  return { x: 0, z: 0, hit: false, nx: 0, nz: 0, solid: -1 };
}

const KIND_FREE = 0;
const KIND_PRISM = 1;
const KIND_CYLINDER = 2;
const F_STANDABLE = 1;
const F_SIGHT = 2;
/** Cell indices are offset into a positive range and packed into one safe integer. */
const GRID_OFFSET = 1 << 20;
const GRID_SPAN = 1 << 21;
/** A slide moves at most half the radius per sub-step (so no side thinner than that is skipped), at least this far. */
const MIN_SUBSTEP = 0.02;
const MAX_SUBSTEPS = 4096;
/** Push-out passes per sub-step; a sub-step that still overlaps after them is undone (the circle stops). */
const RESOLVE_PASSES = 8;
/** Times an unresolvable sub-step is halved before the circle stops where it was. */
const SUBSTEP_HALVINGS = 5;
/** Passes for a circle that starts inside solids. */
const START_PASSES = 32;
/** Overlap below this depth, metres, is not a contact. */
const CONTACT_EPS = 1e-7;
/** Overlap still accepted after the passes (rounding), metres. */
const RESOLVE_TOLERANCE = 1e-5;
/** Half the spacing of the finite differences for the normal of the base surface, metres. */
const BASE_NORMAL_EPS = 0.05;
/** Longest ray parameter `raycast` searches. */
const MAX_RAY_T = 1e5;

function cellKeyOf(i: number, j: number): number {
  return (i + GRID_OFFSET) * GRID_SPAN + (j + GRID_OFFSET);
}

/**
 * Upright solids over a base surface, for walking and for the camera: ground and ceiling under and over a point,
 * a circle sliding along the sides, a ray, and how far a sphere can travel. Ids are never reused: removing a solid
 * leaves every other id as it was.
 */
export class CollisionWorld {
  readonly cellSize: number;
  private readonly heightAt: (x: number, z: number) => number;
  private readonly baseTag: ((x: number, z: number) => number) | null;
  private readonly baseMinY: number;
  private readonly baseMaxY: number;
  private readonly baseStep: number;
  private readonly extent: readonly [number, number, number, number] | null;
  /** Rectangle around every solid ever added (it only grows), which ends the walk of a ray through the cells. */
  private sx0 = Infinity;
  private sx1 = -Infinity;
  private sz0 = Infinity;
  private sz1 = -Infinity;

  // One entry per id (struct of arrays).
  private readonly kind: number[] = [];
  private readonly flag: number[] = [];
  private readonly tagOf: number[] = [];
  private readonly lowY: number[] = [];
  private readonly highY: number[] = [];
  private readonly x0: number[] = [];
  private readonly x1: number[] = [];
  private readonly z0: number[] = [];
  private readonly z1: number[] = [];
  /** Prism: one ring in an array (the shape `pointInRings` and `rayPrism` take); null otherwise. */
  private readonly rings: (Ring[] | null)[] = [];
  /** Prism: +1 when the outline runs counter-clockwise (positive `ringSignedArea`), −1 otherwise. */
  private readonly orient: number[] = [];
  private readonly cx: number[] = [];
  private readonly cz: number[] = [];
  private readonly cr: number[] = [];
  /** Keys of the cells a solid is listed in, for removal. */
  private readonly cellsOf: (number[] | null)[] = [];

  private readonly cells = new Map<number, number[]>();
  private live = 0;

  // Query scratch: visit marks, the candidate list, the direction of the last `nearest`, the moving centre.
  private mark = new Uint32Array(64);
  private stamp = 0;
  private cand = new Int32Array(64);
  private dirX = 0;
  private dirZ = 0;
  private px = 0;
  private pz = 0;
  private readonly normal = new Float64Array(3);
  private readonly rayScratch: RayHit = newRayHit();
  /** The solid whose top the last `groundAt` returned, −1 the base. */
  private groundSolid = -1;
  private readonly standSlide: SlideResult = newSlideResult();

  constructor(options: CollisionWorldOptions) {
    this.heightAt = options.heightAt;
    this.baseTag = options.baseTagAt ? (x, z) => options.baseTagAt!(x, z) : null;
    this.cellSize = options.cellSize ?? 8;
    if (!(this.cellSize > 0)) throw new Error('CollisionWorld: cellSize must be positive');
    this.baseMinY = options.baseMinY ?? -Infinity;
    this.baseMaxY = options.baseMaxY ?? Infinity;
    this.baseStep = options.baseStep ?? 0.5;
    if (!(this.baseStep > 0)) throw new Error('CollisionWorld: baseStep must be positive');
    this.extent = options.baseExtent ?? null;
  }

  /** Number of solids not removed. */
  get solidCount(): number {
    return this.live;
  }

  /** Vertical prism over a closed outline (x, z pairs), from minY to maxY. Returns the solid's id. */
  addPrism(outline: ArrayLike<number>, minY: number, maxY: number, options?: SolidOptions): number {
    let n = Math.floor(outline.length / 2);
    if (outline.length % 2 !== 0) throw new Error('CollisionWorld.addPrism: the outline needs x, z pairs');
    // A repeated closing point is dropped.
    if (n > 3 && outline[0] === outline[(n - 1) * 2] && outline[1] === outline[(n - 1) * 2 + 1]) n--;
    if (n < 3) throw new Error('CollisionWorld.addPrism: the outline needs at least 3 points');
    const ring = new Float32Array(n * 2);
    let a = Infinity;
    let b = -Infinity;
    let c = Infinity;
    let d = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = outline[i * 2]!;
      const z = outline[i * 2 + 1]!;
      ring[i * 2] = x;
      ring[i * 2 + 1] = z;
    }
    for (let i = 0; i < n * 2; i += 2) {
      a = Math.min(a, ring[i]!);
      b = Math.max(b, ring[i]!);
      c = Math.min(c, ring[i + 1]!);
      d = Math.max(d, ring[i + 1]!);
    }
    const area = ringSignedArea(ring);
    if (area === 0) throw new Error('CollisionWorld.addPrism: the outline has no area');
    const id = this.push(KIND_PRISM, minY, maxY, a, b, c, d, options);
    this.rings[id] = [ring];
    this.orient[id] = area > 0 ? 1 : -1;
    this.register(id);
    return id;
  }

  /** Upright cylinder with its axis at (x, z). Returns the solid's id. */
  addCylinder(x: number, z: number, radius: number, minY: number, maxY: number, options?: SolidOptions): number {
    if (!(radius > 0)) throw new Error('CollisionWorld.addCylinder: radius must be positive');
    const id = this.push(KIND_CYLINDER, minY, maxY, x - radius, x + radius, z - radius, z + radius, options);
    this.cx[id] = x;
    this.cz[id] = z;
    this.cr[id] = radius;
    this.register(id);
    return id;
  }

  /**
   * Oriented box; a convenience over addPrism. `yawRad` turns it about +y the way a view's yaw does: the local +x
   * axis points to (cos yaw, −sin yaw) in x, z.
   */
  addBox(x: number, z: number, halfX: number, halfZ: number, yawRad: number, minY: number, maxY: number, options?: SolidOptions): number {
    const sc = detSinCos(yawRad);
    const s = sc[0];
    const c = sc[1];
    // Local corners (±halfX, ±halfZ), counter-clockwise in x, z.
    const ax = halfX * c;
    const az = -halfX * s;
    const bx = halfZ * s;
    const bz = halfZ * c;
    return this.addPrism([x - ax - bx, z - az - bz, x + ax - bx, z + az - bz, x + ax + bx, z + az + bz, x - ax + bx, z - az + bz], minY, maxY, options);
  }

  /** Removes a solid. Other ids stay valid; a removed or unknown id is ignored. */
  remove(id: number): void {
    if (!(id >= 0 && id < this.kind.length) || this.kind[id] === KIND_FREE) return;
    const keys = this.cellsOf[id]!;
    for (const key of keys) {
      const list = this.cells.get(key);
      if (!list) continue;
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) this.cells.delete(key);
    }
    this.kind[id] = KIND_FREE;
    this.rings[id] = null;
    this.cellsOf[id] = null;
    this.live--;
  }

  /**
   * Moves and turns a box in place, keeping its id, tag and options: the solid must be a prism of four corners (one
   * made by `addBox`). The arguments are those of `addBox`. For a solid that moves every step (the hull of a moving
   * body as an obstacle for walkers); the grid lists are updated as by a removal and an addition, the id stays.
   */
  setBox(id: number, x: number, z: number, halfX: number, halfZ: number, yawRad: number, minY: number, maxY: number): void {
    if (!(id >= 0 && id < this.kind.length) || this.kind[id] !== KIND_PRISM || this.rings[id]![0]!.length !== 8) {
      throw new Error('CollisionWorld.setBox: not a box (a prism of four corners)');
    }
    if (!(maxY > minY)) throw new Error('CollisionWorld: maxY must be above minY');
    if (!(halfX > 0) || !(halfZ > 0)) throw new Error('CollisionWorld.setBox: half extents must be positive');
    const keys = this.cellsOf[id]!;
    for (const key of keys) {
      const list = this.cells.get(key);
      if (!list) continue;
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) this.cells.delete(key);
    }
    const sc = detSinCos(yawRad);
    const s = sc[0];
    const c = sc[1];
    const ax = halfX * c;
    const az = -halfX * s;
    const bx = halfZ * s;
    const bz = halfZ * c;
    const ring = this.rings[id]![0]!;
    ring[0] = x - ax - bx;
    ring[1] = z - az - bz;
    ring[2] = x + ax - bx;
    ring[3] = z + az - bz;
    ring[4] = x + ax + bx;
    ring[5] = z + az + bz;
    ring[6] = x - ax + bx;
    ring[7] = z - az + bz;
    let a = Infinity;
    let b = -Infinity;
    let cz = Infinity;
    let d = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      a = Math.min(a, ring[i]!);
      b = Math.max(b, ring[i]!);
      cz = Math.min(cz, ring[i + 1]!);
      d = Math.max(d, ring[i + 1]!);
    }
    const g = this.cellSize;
    if (Math.floor(a / g) < -GRID_OFFSET || Math.floor(cz / g) < -GRID_OFFSET || Math.floor(b / g) >= GRID_OFFSET || Math.floor(d / g) >= GRID_OFFSET) {
      throw new Error('CollisionWorld: solid outside the grid range');
    }
    if (a < this.sx0) this.sx0 = a;
    if (b > this.sx1) this.sx1 = b;
    if (cz < this.sz0) this.sz0 = cz;
    if (d > this.sz1) this.sz1 = d;
    this.x0[id] = a;
    this.x1[id] = b;
    this.z0[id] = cz;
    this.z1[id] = d;
    this.lowY[id] = minY;
    this.highY[id] = maxY;
    this.orient[id] = ringSignedArea(ring) > 0 ? 1 : -1;
    this.register(id);
  }

  /**
   * Where a sphere overlaps the base surface and the solids, into `out` (at most its capacity; returns the count): one
   * contact for the base surface when the sphere reaches below it (solid −1; the depth measured along the base's
   * normal) and one per overlapping solid, with the depth and the unit normal that leads the sphere out the shortest
   * way (a side, a top, an underside or a rounded edge between them). Every solid takes part whatever its options,
   * except those whose tag equals `skipTag` (default none). Allocates nothing.
   */
  sphereContacts(x: number, y: number, z: number, radius: number, out: SphereContacts, skipTag = Number.NaN): number {
    const cap = out.depth.length;
    let n = 0;
    // UP: the base and the vertical span would be measured along the local up.
    const h = this.heightAt(x, z);
    if (y - h < radius) {
      const e = BASE_NORMAL_EPS;
      const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
      const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
      const len = Math.sqrt(gx * gx + 1 + gz * gz);
      const dist = (y - h) / len;
      if (dist < radius) {
        out.depth[0] = radius - dist;
        out.nx[0] = -gx / len;
        out.ny[0] = 1 / len;
        out.nz[0] = -gz / len;
        out.solid[0] = -1;
        n = 1;
      }
    }
    const m = this.gather(x - radius, z - radius, x + radius, z + radius);
    for (let k = 0; k < m && n < cap; k++) {
      const id = this.cand[k]!;
      if (this.tagOf[id] === skipTag) continue;
      const low = this.lowY[id]!;
      const high = this.highY[id]!;
      if (y - radius >= high || y + radius <= low) continue;
      const dh = this.nearest(id, x, z);
      if (dh >= radius) continue;
      let depth: number;
      let nx = 0;
      let ny = 0;
      let nz = 0;
      if (dh > 0) {
        const dv = y > high ? y - high : y < low ? y - low : 0;
        if (dv === 0) {
          depth = radius - dh;
          nx = this.dirX;
          nz = this.dirZ;
        } else {
          const dist = Math.sqrt(dh * dh + dv * dv);
          if (dist >= radius) continue;
          depth = radius - dist;
          nx = (this.dirX * dh) / dist;
          ny = dv / dist;
          nz = (this.dirZ * dh) / dist;
        }
      } else if (y >= high) {
        depth = radius - (y - high);
        ny = 1;
      } else if (y <= low) {
        depth = radius - (low - y);
        ny = -1;
      } else {
        // The centre is inside: out by the shortest of the side, the top and the underside.
        const side = -dh;
        const up = high - y;
        const down = y - low;
        if (side <= up && side <= down) {
          depth = side + radius;
          nx = this.dirX;
          nz = this.dirZ;
        } else if (up <= down) {
          depth = up + radius;
          ny = 1;
        } else {
          depth = down + radius;
          ny = -1;
        }
      }
      if (!(depth > CONTACT_EPS)) continue;
      out.depth[n] = depth;
      out.nx[n] = nx;
      out.ny[n] = ny;
      out.nz[n] = nz;
      out.solid[n] = id;
      n++;
    }
    out.count = n;
    return n;
  }

  /** Height of the base surface at a point (the `heightAt` the world was made with). */
  baseHeightAt(x: number, z: number): number {
    // UP: the height would be measured along the local up.
    return this.heightAt(x, z);
  }

  /**
   * Slope of the base surface at a point: writes the gradient (rise per metre along x and along z) into `out[0]`,
   * `out[1]` and returns its length (the tangent of the slope angle). Central differences 0.05 m apart.
   */
  baseSlopeAt(x: number, z: number, out: Float64Array | number[]): number {
    const e = BASE_NORMAL_EPS;
    const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    out[0] = gx;
    out[1] = gz;
    return Math.sqrt(gx * gx + gz * gz);
  }

  /** Whether `id` is a solid that has not been removed. */
  has(id: number): boolean {
    return id >= 0 && id < this.kind.length && this.kind[id] !== KIND_FREE;
  }

  /**
   * Visits every solid whose outline comes within `radius` of the point (x, z) horizontally, whatever its height span
   * and options, with its id, its tag and its signed horizontal distance (negative inside). Returns how many it visited.
   * Allocates nothing; `visit` must not query this world again (the candidate list is shared).
   */
  query(x: number, z: number, radius: number, visit: (id: number, tag: number, distance: number) => void): number {
    const r = radius > 0 ? radius : 0;
    const n = this.gather(x - r, z - r, x + r, z + r);
    let hits = 0;
    for (let k = 0; k < n; k++) {
      const id = this.cand[k]!;
      const d = this.nearest(id, x, z);
      if (d > r) continue;
      hits++;
      visit(id, this.tagOf[id]!, d);
    }
    return hits;
  }

  /** Calls `fn` for every solid not removed, in id order (debug drawing; allocates). */
  forEachSolid(fn: (id: number, info: SolidInfo) => void): void {
    for (let id = 0; id < this.kind.length; id++) {
      const k = this.kind[id];
      if (k === KIND_FREE) continue;
      const f = this.flag[id]!;
      const prism = k === KIND_PRISM;
      fn(id, {
        kind: prism ? 'prism' : 'cylinder',
        outline: prism ? this.rings[id]![0]! : null,
        x: prism ? 0 : this.cx[id]!,
        z: prism ? 0 : this.cz[id]!,
        radius: prism ? 0 : this.cr[id]!,
        minY: this.lowY[id]!,
        maxY: this.highY[id]!,
        standable: (f & F_STANDABLE) !== 0,
        blocksSight: (f & F_SIGHT) !== 0,
        tag: this.tagOf[id]!,
      });
    }
  }

  /**
   * Highest surface (base or a standable top) that is not above `y + maxStepUp`. The base counts always, even above
   * that limit. With `radius` a top counts when it reaches within `radius` of the point (a disc stands on an edge).
   */
  groundAt(x: number, z: number, y: number, maxStepUp: number, radius = 0): number {
    // UP: the base height and the tops would be measured along the local up.
    let best = this.heightAt(x, z);
    const limit = y + maxStepUp;
    const n = this.gather(x - radius, z - radius, x + radius, z + radius);
    let from = -1;
    for (let k = 0; k < n; k++) {
      const id = this.cand[k]!;
      if ((this.flag[id]! & F_STANDABLE) === 0) continue;
      const top = this.highY[id]!;
      if (top > limit || top <= best) continue;
      if (this.nearest(id, x, z) <= radius) {
        best = top;
        from = id;
      }
    }
    this.groundSolid = from;
    return best;
  }

  /**
   * Surface tag of the ground `groundAt` finds with the same arguments: the tag of the standable solid whose top it is,
   * or the base surface's (`baseTagAt` of the options, −1 without it). For a ground contact (a foot put down, a wheel
   * rolling) the game reads what the ground is made of here.
   */
  groundTagAt(x: number, z: number, y: number, maxStepUp: number, radius = 0): number {
    this.groundAt(x, z, y, maxStepUp, radius);
    const id = this.groundSolid;
    return id >= 0 ? this.tagOf[id]! : this.baseTag ? this.baseTag(x, z) : -1;
  }

  /** Surface tag of the base surface at a point (`baseTagAt` of the options, −1 without it), whatever stands on it. */
  baseTagAt(x: number, z: number): number {
    return this.baseTag ? this.baseTag(x, z) : -1;
  }

  /**
   * Lowest underside at or above `y` at the point (for the head when jumping); Infinity when open. Every solid counts,
   * whatever its options. With `radius` an underside counts when the solid reaches within `radius` of the point.
   */
  ceilingAt(x: number, z: number, y: number, radius = 0): number {
    let best = Infinity;
    const n = this.gather(x - radius, z - radius, x + radius, z + radius);
    for (let k = 0; k < n; k++) {
      const id = this.cand[k]!;
      const low = this.lowY[id]!;
      if (low < y || low >= best) continue;
      if (this.nearest(id, x, z) <= radius) best = low;
    }
    return best;
  }

  /**
   * Whether a standing body fits at the spot (tx, tz): its cylinder (`radius`, from `y + maxStepUp` to `y + height`)
   * moved there from (sx, sz) is not stopped by a solid and ends within `tolerance` of the spot, and the ground there
   * lies within `maxRise` of `y`. Returns that ground's height, or NaN when the body does not fit. A start inside a
   * solid is pushed out first, so start just outside the body it leaves (a wall beyond then shows). `y` is the level
   * the body stands at now (or the ground of what it leaves). Nothing allocates.
   */
  standSpot(sx: number, sz: number, tx: number, tz: number, y: number, o: StandSpotOptions): number {
    const out = this.slide(sx, sz, o.radius, y + o.maxStepUp, y + o.height, tx - sx, tz - sz, this.standSlide);
    const ex = out.x - tx, ez = out.z - tz;
    const tol = o.tolerance ?? 0.02;
    if (out.hit || ex * ex + ez * ez > tol * tol) return NaN;
    const rise = o.maxRise ?? o.maxStepUp;
    const g = this.groundAt(tx, tz, y, rise);
    const d = g - y;
    return d <= rise && d >= -rise ? g : NaN;
  }

  /**
   * The first of several candidate spots where a standing body fits (`standSpot`): `spots` holds four numbers per
   * candidate, the start of the way (x, z) and the spot (x, z), tried in order. Returns the candidate's index, or −1
   * when none fits; `out`, when given, gets the spot and its ground (x, y, z).
   */
  firstStandSpot(spots: ArrayLike<number>, y: number, o: StandSpotOptions, out?: { [i: number]: number }): number {
    const n = (spots.length / 4) | 0;
    for (let i = 0; i < n; i++) {
      const tx = spots[i * 4 + 2]!, tz = spots[i * 4 + 3]!;
      const g = this.standSpot(spots[i * 4]!, spots[i * 4 + 1]!, tx, tz, y, o);
      if (g !== g) continue;
      if (out) {
        out[0] = tx;
        out[1] = g;
        out[2] = tz;
      }
      return i;
    }
    return -1;
  }

  /**
   * Moves a circle of `radius` by (dx, dz) against the sides of solids that overlap the height span, sliding along them.
   * A solid takes part when its span overlaps (minY, maxY) (touching does not count), whatever its options. The move is
   * split into sub-steps of at most half the radius, so no side is skipped; a circle that starts inside solids is first
   * pushed out the shortest way. In a corner the circle stops: a sub-step that cannot be resolved is undone.
   */
  slide(x: number, z: number, radius: number, minY: number, maxY: number, dx: number, dz: number, out: SlideResult): SlideResult {
    out.hit = false;
    out.nx = 0;
    out.nz = 0;
    out.solid = -1;
    this.px = x;
    this.pz = z;
    // Out of whatever the circle starts in.
    let n = this.gather(x - radius, z - radius, x + radius, z + radius);
    if (n > 0) this.resolve(n, radius, minY, maxY, START_PASSES, out);
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len > 0) {
      const sx0 = this.px;
      const sz0 = this.pz;
      // Pushes along oblique sides can carry the circle off the straight path, hence the margin of two radii.
      const m = radius * 2;
      n = this.gather(Math.min(sx0, sx0 + dx) - m, Math.min(sz0, sz0 + dz) - m, Math.max(sx0, sx0 + dx) + m, Math.max(sz0, sz0 + dz) + m);
      let steps = Math.ceil(len / Math.max(radius * 0.5, MIN_SUBSTEP));
      if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS;
      const sx = dx / steps;
      const sz = dz / steps;
      for (let s = 0; s < steps; s++) {
        const bx = this.px;
        const bz = this.pz;
        // A sub-step that cannot be resolved (a narrowing corner) is undone and tried at half the length, a few times.
        let frac = 1;
        let done = false;
        for (let tries = 0; tries <= SUBSTEP_HALVINGS; tries++, frac *= 0.5) {
          this.px = bx + sx * frac;
          this.pz = bz + sz * frac;
          if (n === 0 || this.resolve(n, radius, minY, maxY, RESOLVE_PASSES, out)) {
            done = true;
            break;
          }
        }
        if (!done || frac < 1) {
          if (!done) {
            this.px = bx;
            this.pz = bz;
          }
          break;
        }
      }
    }
    out.x = this.px;
    out.z = this.pz;
    return out;
  }

  /**
   * First hit of a ray with the base surface and the solids, for t in [0, maxT]. The direction need not be unit; `t` is
   * measured in its lengths. Solids with `blocksSight: false` are not hit. Writes `out` and returns true on a hit.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, out: RayHit): boolean {
    // An endless ray is cut at MAX_RAY_T so the walk through the cells ends.
    let best = maxT < MAX_RAY_T ? maxT : MAX_RAY_T;
    let hit = -2; // −2 none, −1 base, ≥ 0 a solid
    let nx = 0;
    let ny = 0;
    let nz = 0;
    // The base surface.
    const tb = this.rayBase(ox, oy, oz, dx, dy, dz, best);
    if (tb < Infinity && tb <= best) {
      best = tb;
      hit = -1;
      const x = ox + dx * tb;
      const z = oz + dz * tb;
      const e = BASE_NORMAL_EPS;
      const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
      const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
      const len = Math.sqrt(gx * gx + 1 + gz * gz);
      nx = -gx / len;
      ny = 1 / len;
      nz = -gz / len;
    }
    // The solids, cell by cell along the ray's projection, until no later cell can hold a nearer hit.
    this.nextStamp();
    const s = this.cellSize;
    let i = Math.floor(ox / s);
    let j = Math.floor(oz / s);
    const stepI = dx > 0 ? 1 : -1;
    const stepJ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? s / Math.abs(dx) : Infinity;
    const tDeltaZ = dz !== 0 ? s / Math.abs(dz) : Infinity;
    let tNextX = dx !== 0 ? ((dx > 0 ? (i + 1) * s : i * s) - ox) / dx : Infinity;
    let tNextZ = dz !== 0 ? ((dz > 0 ? (j + 1) * s : j * s) - oz) / dz : Infinity;
    const nrm = this.normal;
    // Past the rectangle of all solids no cell holds one.
    const tSolids = slabExit(ox, oz, dx, dz, this.sx0, this.sz0, this.sx1, this.sz1);
    for (;;) {
      const list = this.cells.get(cellKeyOf(i, j));
      if (list) {
        for (let k = 0; k < list.length; k++) {
          const id = list[k]!;
          if (this.mark[id] === this.stamp) continue;
          this.mark[id] = this.stamp;
          if ((this.flag[id]! & F_SIGHT) === 0) continue;
          const t = this.kind[id] === KIND_PRISM
            ? rayPrism(ox, oy, oz, dx, dy, dz, this.rings[id]!, this.lowY[id]!, this.highY[id]!, this.x0[id]!, this.x1[id]!, this.z0[id]!, this.z1[id]!, 0, best, true, nrm)
            : this.rayCylinder(id, ox, oy, oz, dx, dy, dz, best);
          if (t < best) {
            best = t;
            hit = id;
            nx = nrm[0]!;
            ny = nrm[1]!;
            nz = nrm[2]!;
          }
        }
      }
      const tExit = tNextX < tNextZ ? tNextX : tNextZ;
      if (tExit >= best || tExit === Infinity || tExit > tSolids) break;
      if (tNextX < tNextZ) {
        i += stepI;
        tNextX += tDeltaX;
      } else {
        j += stepJ;
        tNextZ += tDeltaZ;
      }
    }
    if (hit === -2) return false;
    out.t = best;
    out.x = ox + dx * best;
    out.y = oy + dy * best;
    out.z = oz + dz * best;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
    out.solid = hit;
    out.tag = hit >= 0 ? this.tagOf[hit]! : this.baseTag ? this.baseTag(out.x, out.z) : -1;
    return true;
  }

  /**
   * How far a sphere of `radius` can travel from the origin along the direction, at most maxDist (for a camera boom).
   * Solids with `blocksSight: false` do not stop it. 0 when the sphere already overlaps something at the origin. The
   * direction need not be unit; distances are in metres. The sphere is tested every `radius` metres along the way and
   * the contact refined by bisection; the centre line is first cast as a ray, so nothing thin is passed through.
   */
  clearance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, radius: number): number {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 0) || !(maxDist > 0)) return 0;
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    let limit = maxDist;
    if (this.raycast(ox, oy, oz, ux, uy, uz, maxDist, this.rayScratch)) limit = this.rayScratch.t;
    if (!(radius > 0)) return limit;
    if (!this.sphereFree(ox, oy, oz, radius)) return 0;
    let free = 0;
    for (let s = radius; ; s += radius) {
      const at = s < limit ? s : limit;
      if (!this.sphereFree(ox + ux * at, oy + uy * at, oz + uz * at, radius)) {
        let lo = free;
        let hi = at;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          if (this.sphereFree(ox + ux * mid, oy + uy * mid, oz + uz * mid, radius)) lo = mid;
          else hi = mid;
        }
        return lo;
      }
      free = at;
      if (at >= limit) return limit;
    }
  }

  // --- internals ------------------------------------------------------------------------------------------------------

  private push(kind: number, minY: number, maxY: number, a: number, b: number, c: number, d: number, options: SolidOptions | undefined): number {
    if (!(maxY > minY)) throw new Error('CollisionWorld: maxY must be above minY');
    const id = this.kind.length;
    const s = this.cellSize;
    if (Math.floor(a / s) < -GRID_OFFSET || Math.floor(c / s) < -GRID_OFFSET || Math.floor(b / s) >= GRID_OFFSET || Math.floor(d / s) >= GRID_OFFSET) {
      throw new Error('CollisionWorld: solid outside the grid range');
    }
    if (a < this.sx0) this.sx0 = a;
    if (b > this.sx1) this.sx1 = b;
    if (c < this.sz0) this.sz0 = c;
    if (d > this.sz1) this.sz1 = d;
    this.kind.push(kind);
    this.flag.push(((options?.standable ?? true) ? F_STANDABLE : 0) | ((options?.blocksSight ?? true) ? F_SIGHT : 0));
    this.tagOf.push(options?.tag ?? 0);
    this.lowY.push(minY);
    this.highY.push(maxY);
    this.x0.push(a);
    this.x1.push(b);
    this.z0.push(c);
    this.z1.push(d);
    this.rings.push(null);
    this.orient.push(0);
    this.cx.push(0);
    this.cz.push(0);
    this.cr.push(0);
    this.cellsOf.push(null);
    if (id >= this.mark.length) {
      const grown = new Uint32Array(this.mark.length * 2);
      grown.set(this.mark);
      this.mark = grown;
      this.cand = new Int32Array(this.mark.length);
    }
    this.live++;
    return id;
  }

  /**
   * Lists a solid in the cells of its rectangle that its shape reaches: a cell counts when the distance from its
   * centre to the shape is at most half its diagonal (a long turned solid is not listed in every cell of its rectangle).
   */
  private register(id: number): void {
    const s = this.cellSize;
    const reach = s * Math.SQRT1_2;
    const i0 = Math.floor(this.x0[id]! / s);
    const i1 = Math.floor(this.x1[id]! / s);
    const j0 = Math.floor(this.z0[id]! / s);
    const j1 = Math.floor(this.z1[id]! / s);
    const whole = i1 - i0 <= 1 && j1 - j0 <= 1;
    const keys: number[] = [];
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        if (!whole && this.nearest(id, (i + 0.5) * s, (j + 0.5) * s) > reach) continue;
        const key = cellKeyOf(i, j);
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(id);
        keys.push(key);
      }
    }
    this.cellsOf[id] = keys;
  }

  private nextStamp(): void {
    this.stamp++;
    if (this.stamp === 0xffffffff) {
      this.mark.fill(0);
      this.stamp = 1;
    }
  }

  /** Lists every live solid of the cells over a rectangle once, in `cand`, and returns their count. */
  private gather(xa: number, za: number, xb: number, zb: number): number {
    this.nextStamp();
    const s = this.cellSize;
    const i0 = Math.floor(xa / s);
    const i1 = Math.floor(xb / s);
    const j0 = Math.floor(za / s);
    const j1 = Math.floor(zb / s);
    let n = 0;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = this.cells.get(cellKeyOf(i, j));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const id = list[k]!;
          if (this.mark[id] === this.stamp) continue;
          this.mark[id] = this.stamp;
          this.cand[n++] = id;
        }
      }
    }
    return n;
  }

  /**
   * Signed horizontal distance from (x, z) to the side of a solid: negative inside. Leaves in `dirX`, `dirZ` the unit
   * direction that leads out (away from the side outside, toward it inside).
   */
  private nearest(id: number, x: number, z: number): number {
    if (this.kind[id] === KIND_CYLINDER) {
      const ex = x - this.cx[id]!;
      const ez = z - this.cz[id]!;
      const d = Math.sqrt(ex * ex + ez * ez);
      if (d > 0) {
        this.dirX = ex / d;
        this.dirZ = ez / d;
      } else {
        this.dirX = 1;
        this.dirZ = 0;
      }
      return d - this.cr[id]!;
    }
    const rings = this.rings[id]!;
    const ring = rings[0]!;
    const n = ring.length / 2;
    let best = Infinity;
    let bx = 0;
    let bz = 0;
    let enx = 0;
    let enz = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[j * 2]!;
      const az = ring[j * 2 + 1]!;
      const ex = ring[i * 2]! - ax;
      const ez = ring[i * 2 + 1]! - az;
      const l2 = ex * ex + ez * ez;
      let t = l2 > 0 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + ex * t;
      const qz = az + ez * t;
      const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
      if (d2 < best) {
        best = d2;
        bx = qx;
        bz = qz;
        enx = ez;
        enz = -ex;
      }
    }
    const inside = pointInRings(x, z, rings);
    const d = Math.sqrt(best);
    if (d > 1e-12) {
      const s = inside ? -1 / d : 1 / d;
      this.dirX = (x - bx) * s;
      this.dirZ = (z - bz) * s;
    } else {
      // On the side itself: the outward normal of that edge.
      const o = this.orient[id]!;
      const l = Math.sqrt(enx * enx + enz * enz);
      this.dirX = (enx * o) / l;
      this.dirZ = (enz * o) / l;
    }
    return inside ? -d : d;
  }

  /** Pushes the centre (`px`, `pz`) out of the candidates; false when overlap remains after `passes`. */
  private resolve(n: number, radius: number, minY: number, maxY: number, passes: number, out: SlideResult): boolean {
    for (let pass = 0; pass < passes; pass++) {
      let moved = false;
      for (let k = 0; k < n; k++) {
        const id = this.cand[k]!;
        // UP: the vertical span would be measured along the local up.
        if (this.kind[id] === KIND_FREE || this.highY[id]! <= minY || this.lowY[id]! >= maxY) continue;
        const d = this.nearest(id, this.px, this.pz);
        if (d >= radius - CONTACT_EPS) continue;
        const push = radius - d;
        this.px += this.dirX * push;
        this.pz += this.dirZ * push;
        out.hit = true;
        out.nx = this.dirX;
        out.nz = this.dirZ;
        out.solid = id;
        moved = true;
      }
      if (!moved) return true;
    }
    for (let k = 0; k < n; k++) {
      const id = this.cand[k]!;
      if (this.kind[id] === KIND_FREE || this.highY[id]! <= minY || this.lowY[id]! >= maxY) continue;
      if (this.nearest(id, this.px, this.pz) < radius - RESOLVE_TOLERANCE) return false;
    }
    return true;
  }

  /** Whether a sphere at a point stays clear of the base and of the solids that block sight. */
  private sphereFree(x: number, y: number, z: number, r: number): boolean {
    // UP: the height above the base would be measured along the local up.
    if (y - this.heightAt(x, z) < r) return false;
    const n = this.gather(x - r, z - r, x + r, z + r);
    const r2 = r * r;
    for (let k = 0; k < n; k++) {
      const id = this.cand[k]!;
      if ((this.flag[id]! & F_SIGHT) === 0) continue;
      const low = this.lowY[id]!;
      const high = this.highY[id]!;
      const dv = y < low ? low - y : y > high ? y - high : 0;
      if (dv >= r) continue;
      let dh = this.nearest(id, x, z);
      if (dh < 0) dh = 0;
      if (dh * dh + dv * dv < r2) return false;
    }
    return true;
  }

  /** Parameter of the ray's first downward passage through the base surface in [0, maxT], or Infinity. */
  private rayBase(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    let t0 = 0;
    let t1 = maxT;
    // Only the part of the ray between the lowest and the highest base point.
    const hi = this.baseMaxY + 0.01;
    const lo = this.baseMinY - 0.01;
    if (Math.abs(dy) < 1e-12) {
      if (oy > hi || oy < lo) return Infinity;
    } else {
      const ta = (hi - oy) / dy;
      const tb = (lo - oy) / dy;
      const a = ta < tb ? ta : tb;
      const b = ta < tb ? tb : ta;
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
    }
    const ext = this.extent;
    if (ext) {
      // Only the part of the ray over the extent.
      if (!clipSlab(ox, dx, ext[0], ext[2])) return Infinity;
      if (slabA > t0) t0 = slabA;
      if (slabB < t1) t1 = slabB;
      if (!clipSlab(oz, dz, ext[1], ext[3])) return Infinity;
      if (slabA > t0) t0 = slabA;
      if (slabB < t1) t1 = slabB;
    }
    if (!(t1 > t0)) return Infinity;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const stepT = horiz > 1e-9 ? this.baseStep / horiz : (t1 - t0) / 4;
    const t = marchSurface(this.heightAt, ox, oy, oz, dx, dy, dz, t0, t1, stepT, null);
    if (Number.isNaN(t) || t > maxT) return Infinity;
    return t;
  }

  /** Ray against an upright cylinder (side and both caps) for t in [0, tMax); writes `normal`; Infinity on a miss. */
  private rayCylinder(id: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number): number {
    const cx = this.cx[id]!;
    const cz = this.cz[id]!;
    const r = this.cr[id]!;
    const low = this.lowY[id]!;
    const high = this.highY[id]!;
    const nrm = this.normal;
    let best = tMax;
    let face = 0; // 1 side, 2 cap
    const fx = ox - cx;
    const fz = oz - cz;
    const a = dx * dx + dz * dz;
    if (a > 1e-18) {
      const b = fx * dx + fz * dz;
      const c = fx * fx + fz * fz - r * r;
      const disc = b * b - a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        // Entry, then exit (a ray that starts inside).
        for (let k = 0; k < 2; k++) {
          const t = (k === 0 ? -b - sq : -b + sq) / a;
          if (t < 0 || t >= best) continue;
          const y = oy + dy * t;
          if (y < low || y > high) continue;
          best = t;
          face = 1;
          break;
        }
      }
    }
    if (Math.abs(dy) > 1e-12) {
      for (let k = 0; k < 2; k++) {
        const t = ((k === 0 ? high : low) - oy) / dy;
        if (t < 0 || t >= best) continue;
        const ex = fx + dx * t;
        const ez = fz + dz * t;
        if (ex * ex + ez * ez > r * r) continue;
        best = t;
        face = 2;
      }
    }
    if (face === 0) return Infinity;
    if (face === 1) {
      let nx = (fx + dx * best) / r;
      let nz = (fz + dz * best) / r;
      if (nx * dx + nz * dz > 0) {
        nx = -nx;
        nz = -nz;
      }
      nrm[0] = nx;
      nrm[1] = 0;
      nrm[2] = nz;
    } else {
      nrm[0] = 0;
      nrm[1] = dy > 0 ? -1 : 1;
      nrm[2] = 0;
    }
    return best;
  }
}

// Result of `clipSlab`: the parameter range of a ray inside one slab.
let slabA = 0;
let slabB = 0;

/** Range of t for which o + d·t lies in [lo, hi], into `slabA`, `slabB`; false when never. */
function clipSlab(o: number, d: number, lo: number, hi: number): boolean {
  if (d === 0) {
    slabA = -Infinity;
    slabB = Infinity;
    return o >= lo && o <= hi;
  }
  const ta = (lo - o) / d;
  const tb = (hi - o) / d;
  slabA = ta < tb ? ta : tb;
  slabB = ta < tb ? tb : ta;
  return true;
}

/** Parameter at which a ray in x, z leaves a rectangle for good (−Infinity when it never meets it, or it is empty). */
function slabExit(ox: number, oz: number, dx: number, dz: number, x0: number, z0: number, x1: number, z1: number): number {
  if (!(x1 >= x0)) return -Infinity;
  if (!clipSlab(ox, dx, x0, x1)) return -Infinity;
  let a = slabA;
  let b = slabB;
  if (!clipSlab(oz, dz, z0, z1)) return -Infinity;
  if (slabA > a) a = slabA;
  if (slabB < b) b = slabB;
  return b >= a ? b : -Infinity;
}
