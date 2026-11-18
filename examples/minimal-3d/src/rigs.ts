// Rig demo: a two-segment cart and porters on a track round the outside of the stone ring, drawn by the engine's
// instanced rig layer (`RigLayer`). The rigs are plain data written here (`RigDesc`: rigid parts with pivots and a
// motion each); the layer poses them in the vertex shader from one record per instance. The fixed-step simulation
// moves them (`Movers`), and every frame `extractPose` gives what a rig needs: position, heading, distance travelled
// (gait and wheel phase), speed and turn rate (steering, lean).

import { packRgb, writeRigInstance } from 'wallhammer-web/base';
import type { RigDesc, RigInstance, RigPart } from 'wallhammer-web/base';
import type { HeightField } from 'wallhammer-web/gen-core';
import type { RigLayer } from 'wallhammer-web/render';
import { MOVER_STATE, POSE_STRIDE } from 'wallhammer-web/sim';
import type { Movers } from 'wallhammer-web/sim';

/** Cart: steering axle ahead of the fixed one, the hitch behind it, the trailer's axle behind the hitch. */
export const CART = { wheelbase: 1.7, hitch: 1.0, trailerAxle: 2.1, wheel: 0.36 } as const;
/** Tags of the movers on the track. */
export const TRACK_TAG = { cart: 1, porter: 2 } as const;

const WOOD: [number, number, number] = [0.5, 0.36, 0.24];
const IRON: [number, number, number] = [0.16, 0.16, 0.17];

function wheelPair(parts: RigPart[], z: number, steer: boolean, segment: 0 | 1, half: number): void {
  for (const side of [-1, 1]) {
    const at: [number, number, number] = [half * side, CART.wheel, z];
    const motion = steer ? 'spin-steer' : 'spin';
    parts.push({ shape: { kind: 'roller', radius: CART.wheel, width: 0.12, sides: 12 }, at, motion, amount: CART.wheel, segment, tint: IRON });
    // Spokes: a bar through the hub that turns with the wheel, so the spin reads.
    parts.push({ shape: { kind: 'box', size: [0.14, CART.wheel * 1.7, 0.06] }, at, motion, amount: CART.wheel, segment, tint: WOOD, nearOnly: true });
  }
}

/**
 * The cart: a motor box with a canopy on the leading segment (steered front wheels), a flat trailer with a load on the
 * trailing one. Colour slots: 0 body, 1 canopy, 2 trailer, 3 load.
 */
export function cartRig(): RigDesc {
  const parts: RigPart[] = [];
  const front = CART.wheelbase + 0.55;
  // Leading segment, anchored on its fixed axle.
  parts.push({ shape: { kind: 'box', size: [1.2, 0.5, front + 0.45] }, at: [0, 0.62, (front - 0.45) / 2], slot: 0 });
  parts.push({ shape: { kind: 'box', size: [0.9, 0.45, 0.6] }, at: [0, 1.1, CART.wheelbase - 0.1], slot: 0 });
  parts.push({ shape: { kind: 'box', size: [1.3, 0.06, 1.3] }, at: [0, 1.95, 0.35], slot: 1 });
  for (const [x, z] of [[-0.6, -0.25], [0.6, -0.25], [-0.6, 0.95], [0.6, 0.95]] as const) {
    parts.push({ shape: { kind: 'box', size: [0.05, 1.05, 0.05] }, at: [x, 1.4, z], slot: 1, nearOnly: true });
  }
  for (const side of [-1, 1]) {
    parts.push({ shape: { kind: 'box', size: [0.16, 0.1, 0.04] }, at: [0.4 * side, 0.85, front + 0.01], tint: [0.9, 0.88, 0.8], finish: 'lamp-front', nearOnly: true });
  }
  wheelPair(parts, 0, false, 0, 0.66);
  wheelPair(parts, CART.wheelbase, true, 0, 0.66);
  // Trailing segment, anchored on its axle: a bed reaching to the hitch, a drawbar and the load.
  const bedFront = CART.trailerAxle - 0.5;
  parts.push({ shape: { kind: 'box', size: [1.3, 0.14, bedFront + 1.1] }, at: [0, 0.78, (bedFront - 1.1) / 2], segment: 1, slot: 2 });
  for (const side of [-1, 1]) parts.push({ shape: { kind: 'box', size: [0.05, 0.3, bedFront + 1.1] }, at: [0.63 * side, 0.98, (bedFront - 1.1) / 2], segment: 1, slot: 2 });
  parts.push({ shape: { kind: 'rod', dir: [0, 0, 1], length: 0.62, thickness: 0.08 }, at: [0, 0.6, bedFront - 0.1], segment: 1, tint: IRON });
  parts.push({ shape: { kind: 'box', size: [0.55, 0.45, 0.6] }, at: [-0.28, 1.08, 0.1], segment: 1, slot: 3 });
  parts.push({ shape: { kind: 'box', size: [0.5, 0.36, 0.55] }, at: [0.3, 1.03, -0.5], segment: 1, slot: 3 });
  parts.push({ shape: { kind: 'frustum', r0: 0.22, r1: 0.2, height: 0.55, sides: 8 }, at: [0.3, 0.85, 0.55], segment: 1, tint: WOOD });
  parts.push({ shape: { kind: 'box', size: [0.12, 0.12, 0.04] }, at: [0.45, 0.8, -1.12], segment: 1, tint: [0.6, 0.1, 0.08], finish: 'lamp-rear', nearOnly: true });
  wheelPair(parts, 0, false, 1, 0.74);
  return {
    name: 'cart',
    parts,
    segments: [{ shadow: [0.8, front / 2 + 0.45, (front - 0.45) / 2] }, { shadow: [0.85, (bedFront + 1.1) / 2 + 0.1, (bedFront - 1.1) / 2] }],
    steerBase: CART.wheelbase,
    roll: 0.03,
    rollLimit: 0.08,
    bob: 0.025,
    height: 2,
    radius: 3.5,
  };
}

/** A porter with a pack, a staff in the right hand and a hood. Colour slots: 0 coat, 1 legs, 2 skin, 3 pack. */
export function porterRig(): RigDesc {
  const hip = 0.86;
  const parts: RigPart[] = [];
  for (const side of [-1, 1] as const) {
    const phase = side < 0 ? 0 : 0.5;
    const pivot: [number, number, number] = [0.1 * side, hip, 0];
    parts.push({ shape: { kind: 'box', size: [0.14, hip - 0.05, 0.16] }, at: [0.1 * side, hip / 2 + 0.025, 0], pivot, motion: 'limb', amount: hip, phase, slot: 1 });
    parts.push({ shape: { kind: 'box', size: [0.13, 0.08, 0.27] }, at: [0.1 * side, 0.04, 0.05], pivot, motion: 'limb', amount: hip, phase, tint: [0.2, 0.15, 0.12], nearOnly: true });
    const shoulder: [number, number, number] = [0.25 * side, 1.38, 0];
    parts.push({ shape: { kind: 'box', size: [0.1, 0.62, 0.12] }, at: [0.25 * side, 1.08, 0], pivot: shoulder, motion: 'swing', amount: side < 0 ? 0.35 : 0.12, phase: side < 0 ? 0.5 : 0, slot: 0 });
  }
  // The staff swings a little with the right arm.
  parts.push({ shape: { kind: 'rod', dir: [0, 1, 0.08], length: 1.85, thickness: 0.05 }, at: [0.3, 0.02, 0.18], pivot: [0.25, 1.38, 0], motion: 'swing', amount: 0.12, tint: [0.42, 0.3, 0.2] });
  parts.push({ shape: { kind: 'frustum', r0: 0.2, r1: 0.24, height: 0.58, sides: 8, depth: 0.65, cap: true }, at: [0, hip - 0.04, 0], slot: 0 });
  const neck: [number, number, number] = [0, 1.45, 0];
  parts.push({ shape: { kind: 'frustum', r0: 0.09, r1: 0.1, height: 0.21, sides: 8, cap: true }, at: [0, 1.47, 0.01], pivot: neck, motion: 'look', amount: 0.5, slot: 2 });
  parts.push({ shape: { kind: 'frustum', r0: 0.15, r1: 0.04, height: 0.24, sides: 8, cap: true }, at: [0, 1.6, -0.02], pivot: neck, motion: 'look', amount: 0.5, slot: 0 });
  parts.push({ shape: { kind: 'box', size: [0.38, 0.5, 0.24] }, at: [0, 1.15, -0.24], slot: 3 });
  parts.push({ shape: { kind: 'frustum', r0: 0.1, r1: 0.1, height: 0.42, sides: 6 }, at: [0, 1.42, -0.24], slot: 3, nearOnly: true });
  return { name: 'porter', parts, segments: [{ shadow: [0.34, 0.3, 0] }], stride: 1.35, height: 1.85, radius: 1.2 };
}

const PORTER_COLOURS: readonly (readonly [number, number, number, number])[] = [
  [packRgb(0.45, 0.32, 0.24), packRgb(0.28, 0.25, 0.22), packRgb(0.78, 0.6, 0.48), packRgb(0.55, 0.5, 0.36)],
  [packRgb(0.3, 0.36, 0.4), packRgb(0.24, 0.22, 0.2), packRgb(0.62, 0.45, 0.34), packRgb(0.5, 0.36, 0.26)],
  [packRgb(0.52, 0.46, 0.36), packRgb(0.3, 0.28, 0.26), packRgb(0.86, 0.7, 0.58), packRgb(0.36, 0.4, 0.3)],
  [packRgb(0.36, 0.3, 0.38), packRgb(0.22, 0.22, 0.24), packRgb(0.7, 0.52, 0.4), packRgb(0.6, 0.55, 0.45)],
];
const CART_COLOURS = [packRgb(0.42, 0.5, 0.42), packRgb(0.78, 0.74, 0.62), packRgb(0.52, 0.38, 0.26), packRgb(0.66, 0.55, 0.4)] as const;

/** Places the movers on the track as rig instances for this frame. */
export class TrackRigs {
  private readonly layer: RigLayer;
  private readonly cart: number;
  private readonly porter: number;
  private readonly pose = new Float32Array(32 * POSE_STRIDE);
  private readonly p: [number, number] = [0, 0];
  private readonly rec: RigInstance = {
    x: 0, y: 0, z: 0, slope: 0, dirX: 0, dirZ: 1, x1: 0, y1: 0, z1: 0, slope1: 0, dirX1: 0, dirZ1: 1,
    distance: 0, speed: 0, turnRate: 0, seed: 0, state: 0, heightScale: 1, widthScale: 1, variants: 0, colors: CART_COLOURS,
  };

  constructor(layer: RigLayer) {
    this.layer = layer;
    this.cart = layer.addKind(cartRig(), 4);
    this.porter = layer.addKind(porterRig(), 28);
  }

  update(movers: Movers, alpha: number, field: HeightField): void {
    const n = movers.extractPose(alpha, this.pose);
    const t = movers.table;
    const carts = this.layer.staging(this.cart);
    const porters = this.layer.staging(this.porter);
    let nc = 0;
    let np = 0;
    const r = this.rec;
    const p = this.p;
    for (let i = 0; i < n; i++) {
      const o = i * POSE_STRIDE;
      const x = this.pose[o]!;
      const z = this.pose[o + 1]!;
      const d = this.pose[o + 4]!;
      const path = movers.paths.get(t.col.path[i]!);
      r.x = r.x1 = x;
      r.z = r.z1 = z;
      r.y = r.y1 = field.heightAt(x, z);
      r.dirX = r.dirX1 = this.pose[o + 2]!;
      r.dirZ = r.dirZ1 = this.pose[o + 3]!;
      r.slope = r.slope1 = 0;
      r.distance = d;
      r.speed = this.pose[o + 5]!;
      r.turnRate = this.pose[o + 6]!;
      r.state = this.pose[o + 7] === MOVER_STATE.moving ? 0 : 1;
      r.seed = ((t.idAt(i) * 0.618) % 1 + 1) % 1;
      if (t.col.tag[i] === TRACK_TAG.cart) {
        // Leading segment: heading toward its steering axle on the track. Trailing segment: its axle on the track
        // behind, heading toward the hitch, so it cuts the corner like a real trailer.
        movers.paths.pointAt(path, (d + CART.wheelbase) * 1000, p);
        let dx = p[0] - x;
        let dz = p[1] - z;
        let l = Math.hypot(dx, dz) || 1;
        r.dirX = dx /= l;
        r.dirZ = dz /= l;
        const hx = x - dx * CART.hitch;
        const hz = z - dz * CART.hitch;
        movers.paths.pointAt(path, (d - CART.hitch - CART.trailerAxle) * 1000, p);
        let ex = hx - p[0];
        let ez = hz - p[1];
        l = Math.hypot(ex, ez) || 1;
        ex /= l;
        ez /= l;
        r.dirX1 = ex;
        r.dirZ1 = ez;
        r.x1 = hx - ex * CART.trailerAxle;
        r.z1 = hz - ez * CART.trailerAxle;
        r.y1 = field.heightAt(r.x1, r.z1);
        r.slope = (field.heightAt(x + dx * CART.wheelbase, z + dz * CART.wheelbase) - r.y) / CART.wheelbase;
        r.slope1 = (field.heightAt(hx, hz) - r.y1) / CART.trailerAxle;
        r.heightScale = r.widthScale = 1;
        r.variants = 0;
        r.colors = CART_COLOURS;
        writeRigInstance(carts, nc++, r);
      } else {
        const k = t.idAt(i);
        r.heightScale = 0.94 + 0.12 * (((k * 0.37) % 1 + 1) % 1);
        r.widthScale = 0.95 + 0.1 * (((k * 0.73) % 1 + 1) % 1);
        r.variants = 0;
        r.colors = PORTER_COLOURS[k % PORTER_COLOURS.length]!;
        writeRigInstance(porters, np++, r);
      }
    }
    this.layer.commit(this.cart, nc);
    this.layer.commit(this.porter, np);
  }
}
