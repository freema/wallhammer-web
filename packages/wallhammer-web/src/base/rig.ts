// An instanced rig as plain data: rigid parts with pivots and a motion each, in one or two segments that follow the
// same path. The pose is not stored anywhere: a vertex shader computes it from the instance record (position,
// heading, distance travelled, speed, turn rate, seed, state) with closed-form functions. Types and layouts only;
// gen-mesh builds the part meshes, the render module draws them.

import type { VertexLayout } from './data.ts';

/**
 * How a part moves, about its pivot (local axes: x right, y up, z forward, origin on the ground under the segment
 * anchor):
 * - `fixed`: moves with the segment body (bob, roll, sway)
 * - `spin`: turns about the x axis by distance / `amount` (a roller of radius `amount`); not sprung
 * - `spin-steer`: like `spin`, and turns about y toward the curve by atan(base · curvature) (`RigDesc.steerBase`)
 * - `limb`: a leg of length `amount` swinging about x through the pivot in the gait; the foot keeps still on the
 *   ground during the stance half, `phase` 0 or 0.5 picks the side (any phase with `RigDesc.gait` 'free')
 * - `swing`: swings about x in the gait by up to `amount` radians (arms, something carried)
 * - `look`: turns about y while standing, slowly, up to `amount` radians
 * - `wobble`: small noise about x and y with time and distance, up to `amount` radians
 * - `bend`: a link of a chain; the links of one chain share their `pivot` (the root). Every vertex turns about the
 *   root, about the part's `axis`, by `amount` (radians per metre) × its rest distance from the root × a wave that
 *   travels along the chain with the gait (`phase`: lag in cycles per metre), and slowly while standing
 *
 * `spin`, `swing` and `bend` may run on a clock instead of the distance travelled (`RigPart.rate`).
 */
export type RigMotion = 'fixed' | 'spin' | 'spin-steer' | 'limb' | 'swing' | 'look' | 'wobble' | 'bend';
export const RIG_MOTION: Readonly<Record<RigMotion, number>> = { fixed: 0, spin: 1, 'spin-steer': 2, limb: 3, swing: 4, look: 5, wobble: 6, bend: 7 };
/** Index of a `bend` axis; the mesh writes the motion kind `RIG_MOTION.bend + RIG_BEND_AXIS[axis]`. */
export const RIG_BEND_AXIS: Readonly<Record<'x' | 'y' | 'z', number>> = { x: 0, y: 1, z: 2 };
/** Motion kind of a `swing` about each axis: about x it is `RIG_MOTION.swing` as before, about y and z new kinds. */
export const RIG_SWING_KIND: Readonly<Record<'x' | 'y' | 'z', number>> = { x: 4, y: 10, z: 11 };
/**
 * A part on a clock writes the motion kind `kind + RIG_CLOCK_STEP × (clock + 1)`, `clock` its index in
 * `rigClockRates(desc)`; a part without a clock writes `kind` alone, as before clocks existed.
 */
export const RIG_CLOCK_STEP = 16;
/** Most different rates of one rig kind. */
export const RIG_MAX_CLOCKS = 4;

/**
 * How a part's surface reads in the image. Lamps light up with `RigLayer.lamps`; `glow` is glass with a lit interior
 * at night; `tiles` is matte with a 0.5 m grid of joints in world space on upward faces (a paved top that lines up
 * across instances).
 */
export type RigFinish = 'matte' | 'glass' | 'lamp-front' | 'lamp-rear' | 'glow' | 'tiles';
export const RIG_FINISH: Readonly<Record<RigFinish, number>> = { matte: 0, glass: 1, 'lamp-front': 2, 'lamp-rear': 3, glow: 4, tiles: 5 };

/** Shape of a part, around its own centre before it is placed. */
export type RigShape =
  | { kind: 'box'; size: readonly [number, number, number] }
  /** Upright frustum: radius at the bottom and top, height, sides; `depth` squashes it front to back. */
  | { kind: 'frustum'; r0: number; r1: number; height: number; sides: number; depth?: number; cap?: boolean }
  /** Cylinder lying along x (rollers): radius, width, sides. */
  | { kind: 'roller'; radius: number; width: number; sides: number }
  /** Thin rod from the centre along a local direction: length and thickness. */
  | { kind: 'rod'; dir: readonly [number, number, number]; length: number; thickness: number };

export interface RigPart {
  shape: RigShape;
  /** Where the shape's centre sits (box, roller) or its foot (frustum, rod start), segment-local metres. */
  at: readonly [number, number, number];
  /** The point it moves about; default `at`. */
  pivot?: readonly [number, number, number];
  motion?: RigMotion;
  amount?: number;
  /** Gait phase offset 0–1 (`limb`, `swing`). */
  phase?: number;
  /** 0 the leading segment, 1 the trailing one. */
  segment?: 0 | 1;
  /** Colour: an instance colour slot 0–3 times `tint`, or a fixed colour when `slot` is missing. */
  slot?: 0 | 1 | 2 | 3;
  tint?: readonly [number, number, number];
  finish?: RigFinish;
  /** Drawn only when the instance has this variant bit set (0–7). */
  variant?: number;
  /** Left out of the far level of detail. */
  nearOnly?: boolean;
  /** `bend`: the axis the link turns about (default 'y'). `swing`: the axis it swings about (default 'x'). */
  axis?: 'x' | 'y' | 'z';
  /**
   * `spin`, `swing` and `bend` only: the motion runs on the layer's clock (`RigLayer.time`) at this many cycles per
   * second instead of on the distance travelled, at full size whatever the speed. Its phase in cycles is
   * `rigClockPhase(time, rate, seed, phase)`: `spin` turns once per cycle about x, `swing` swings by
   * `amount · sin(2π · phase)`, a `bend` link's wave is `sin(2π · (cycles − phase · d))`. Negative runs backward.
   * At most `RIG_MAX_CLOCKS` different rates per kind.
   */
  rate?: number;
}

export interface RigSegment {
  /** Contact shadow under the segment: half width, half length, centre offset forward (metres). */
  shadow: readonly [number, number, number];
}

export interface RigDesc {
  name: string;
  parts: readonly RigPart[];
  /** One or two segments; the second follows the same path behind (the app places it). */
  segments: readonly RigSegment[];
  /** Gait cycle length in metres (two steps) at scale 1. Default 1.4. */
  stride?: number;
  /** Distance between the steering and the fixed axle, metres (`spin-steer`). */
  steerBase?: number;
  /** Body roll per (speed × turn rate), radians per m/s², and its limit. Positive leans out of the curve. */
  roll?: number;
  rollLimit?: number;
  /** Suspension bob amplitude in metres while moving. */
  bob?: number;
  /** Below this size on screen (CSS pixels for the rig height) the far level of detail is used; below `hidePx` none. */
  farPx?: number;
  hidePx?: number;
  /** Height of the rig in metres at scale 1, for the screen size and culling. */
  height: number;
  /** Reach from the anchor, metres, for culling. */
  radius: number;
  /**
   * How the `limb` parts keep their end points on the ground. 'pair' (default): two stance phases, the body dips by
   * the geometry of the first limb, `phase` 0 or 0.5. 'free': every limb plants its own end point for any `phase`
   * and `amount`, aimed at it and stretched along its length; the body dips by `dip`.
   */
  gait?: 'pair' | 'free';
  /** 'free' only: body dip per step in metres at scale 1, twice per cycle. Default 0. */
  dip?: number;
  /** 'free' only: the speeds between which the gait fades in, m/s at scale 1. Default [0.15, 0.9]. */
  walkSpeed?: readonly [number, number];
  /**
   * How an instance is turned. 'heading' (default): about up by its heading (`dirX`, `dirZ`), with the slope as a
   * shear and the body roll of curves. 'frame': by a full frame, a forward and an up direction in world space written
   * with `writeRigFrame` into the floats of the trailing segment (one segment only), for bank and pitch of any size
   * (a flyer, a body on a wall). The heading fields still place the contact shadow.
   */
  orient?: 'heading' | 'frame';
}

/**
 * True when a description needs the extended pose (a 'free' gait or any `bend` part); such kinds are drawn by a
 * second program, every other kind by the same program as before these options existed.
 */
export function rigExtended(desc: RigDesc): boolean {
  return desc.gait === 'free' || desc.orient === 'frame' || desc.parts.some((p) => p.motion === 'bend' || p.rate !== undefined || (p.motion === 'swing' && (p.axis ?? 'x') !== 'x'));
}

/** The different clock rates of a description's parts, in the order they first appear; a part's clock is its index. */
export function rigClockRates(desc: RigDesc): number[] {
  const rates: number[] = [];
  for (const p of desc.parts) {
    if (p.rate === undefined) continue;
    if (!Number.isFinite(p.rate)) throw new Error(`rig ${desc.name}: a rate must be a finite number`);
    if (p.motion !== 'spin' && p.motion !== 'swing' && p.motion !== 'bend') throw new Error(`rig ${desc.name}: only spin, swing and bend run on a clock, not ${p.motion ?? 'fixed'}`);
    if (!rates.includes(p.rate)) rates.push(p.rate);
  }
  if (rates.length > RIG_MAX_CLOCKS) throw new Error(`rig ${desc.name}: ${rates.length} different rates, at most ${RIG_MAX_CLOCKS}`);
  return rates;
}

/**
 * Phase in cycles (0–1) of a clocked motion at `time` seconds: `fract(fract(time · rate) + seed + phase)`, as the
 * shader computes it (the layer hands it `fract(time · rate)` worked out in double precision). A cycle starts where it
 * is 0; for a `swing` that is the middle of its sweep, moving toward positive angles.
 */
export function rigClockPhase(time: number, rate: number, seed: number, phase = 0): number {
  const c = time * rate;
  const x = c - Math.floor(c) + seed + phase;
  return x - Math.floor(x);
}

/**
 * Writes the full frame of instance `index` (kinds with `orient: 'frame'`): the forward and up directions in world
 * space into floats 6–11 of the record (where a second segment would keep its heading and anchor). They need not be
 * of unit length or at right angles; the shader takes forward as it is and up from the plane of the two.
 */
export function writeRigFrame(out: Float32Array, index: number, forward: readonly [number, number, number], up: readonly [number, number, number]): void {
  const o = index * RIG_INSTANCE_FLOATS;
  out[o + 6] = forward[0];
  out[o + 7] = forward[1];
  out[o + 8] = forward[2];
  out[o + 9] = up[0];
  out[o + 10] = up[1];
  out[o + 11] = up[2];
}

/** Vertex of a rig mesh: position, normal, pivot, motion (kind, amount, segment, colour slot), colour, extra (phase, variant, near only). */
export const RIG_VERTEX_LAYOUT: VertexLayout = {
  stride: 76,
  attribs: [
    { name: 'a_pos', size: 3, type: 'f32', offset: 0 },
    { name: 'a_normal', size: 3, type: 'f32', offset: 12 },
    { name: 'a_pivot', size: 3, type: 'f32', offset: 24 },
    { name: 'a_motion', size: 4, type: 'f32', offset: 36 },
    { name: 'a_color', size: 4, type: 'f32', offset: 52 },
    { name: 'a_extra', size: 2, type: 'f32', offset: 68 },
  ],
};
export const RIG_VERTEX_FLOATS = 19;

/**
 * One rig instance, `RIG_INSTANCE_FLOATS` floats:
 * - 0–3: leading segment anchor x, y, z, slope (rise per metre forward)
 * - 4–7: leading direction x, z, trailing direction x, z
 * - 8–11: trailing segment anchor x, y, z, slope
 *   (kinds with `orient: 'frame'`: 6–8 forward x, y, z and 9–11 up x, y, z in world space, see `writeRigFrame`)
 * - 12–15: distance travelled (m), speed (m/s), turn rate (rad/s, positive right), seed 0–1
 * - 16–19: state (0 moving, 1 standing, 2 parked; kept for the owner, no shader of the engine reads it), height scale,
 *   width scale, variant bits
 * - 20–23: four colours, each 0xRRGGBB as a float
 */
export const RIG_INSTANCE_FLOATS = 24;
export const RIG_INSTANCE_LAYOUT: VertexLayout = {
  stride: RIG_INSTANCE_FLOATS * 4,
  attribs: [
    { name: 'i_p0', size: 4, type: 'f32', offset: 0 },
    { name: 'i_dir', size: 4, type: 'f32', offset: 16 },
    { name: 'i_p1', size: 4, type: 'f32', offset: 32 },
    { name: 'i_move', size: 4, type: 'f32', offset: 48 },
    { name: 'i_look', size: 4, type: 'f32', offset: 64 },
    { name: 'i_colors', size: 4, type: 'f32', offset: 80 },
  ],
};
export const RIG_ATTRIBS: Readonly<Record<string, number>> = {
  a_pos: 0,
  a_normal: 1,
  a_pivot: 2,
  a_motion: 3,
  a_color: 4,
  a_extra: 5,
  i_p0: 6,
  i_dir: 7,
  i_p1: 8,
  i_move: 9,
  i_look: 10,
  i_colors: 11,
};

/** Packs an RGB colour (0–1 per channel) into one float for the instance record. */
export function packRgb(r: number, g: number, b: number): number {
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return q(r) * 65536 + q(g) * 256 + q(b);
}

/**
 * One instance as named fields, for `writeRigInstance`. Reuse one object for every instance of a frame. A rig of one
 * segment leaves the trailing fields at the leading values (or anything: they are not read).
 */
export interface RigInstance {
  x: number;
  y: number;
  z: number;
  /** Rise per metre forward along the heading. */
  slope: number;
  dirX: number;
  dirZ: number;
  /** Trailing segment: anchor, slope and heading. */
  x1: number;
  y1: number;
  z1: number;
  slope1: number;
  dirX1: number;
  dirZ1: number;
  /** Distance travelled in metres (gait and wheel phase), speed m/s, turn rate rad/s (positive right). */
  distance: number;
  speed: number;
  turnRate: number;
  /** 0–1, varies idle motion between instances. */
  seed: number;
  /**
   * 0 moving, 1 standing, 2 parked. Stored in the record for the owner (and a game material); no shader of the engine
   * reads it: the pose follows from speed and distance alone.
   */
  state: number;
  heightScale: number;
  widthScale: number;
  /** Bit i set = parts with `variant: i` are present. */
  variants: number;
  /** Colours of the four slots, each from `packRgb`. */
  colors: readonly [number, number, number, number];
}

/** Writes instance `index` into a record buffer of `RIG_INSTANCE_FLOATS` floats per instance. */
export function writeRigInstance(out: Float32Array, index: number, r: RigInstance): void {
  const o = index * RIG_INSTANCE_FLOATS;
  out[o] = r.x;
  out[o + 1] = r.y;
  out[o + 2] = r.z;
  out[o + 3] = r.slope;
  out[o + 4] = r.dirX;
  out[o + 5] = r.dirZ;
  out[o + 6] = r.dirX1;
  out[o + 7] = r.dirZ1;
  out[o + 8] = r.x1;
  out[o + 9] = r.y1;
  out[o + 10] = r.z1;
  out[o + 11] = r.slope1;
  out[o + 12] = r.distance;
  out[o + 13] = r.speed;
  out[o + 14] = r.turnRate;
  out[o + 15] = r.seed;
  out[o + 16] = r.state;
  out[o + 17] = r.heightScale;
  out[o + 18] = r.widthScale;
  out[o + 19] = r.variants;
  out[o + 20] = r.colors[0];
  out[o + 21] = r.colors[1];
  out[o + 22] = r.colors[2];
  out[o + 23] = r.colors[3];
}
