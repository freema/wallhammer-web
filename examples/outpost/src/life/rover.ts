// The six-wheeled rover: a chassis with a cabin (teal glass), an orange-trimmed deck carrying cargo, a sensor mast,
// and six wheels on swing arms. Moving parts are part sets: the body (one record), six wheels, six suspension arms and
// the sensor head. `poseRover` places them from a position and heading on the ground: every wheel stands on the
// ground under it, the body pitches and rolls to the mean of the wheels, the arms reach from the body to each hub,
// and the wheels turn by the distance driven.
//
// Local frame: front +z, left +x, ground y = 0 under the body centre.

import { MeshBuilder } from '../kit/mesh.ts';
import { compose, place, rotateX, rotateY, rotateZ, scale, transformPoint, translate } from '../kit/math.ts';
import type { Mat, V3 } from '../kit/math.ts';
import { instanceSet, writeInstance } from 'wallhammer-web/render';
import type { InstanceSet } from 'wallhammer-web/render';
import { box, cylinder, frustumBox, polygon, tube } from '../kit/shapes.ts';
import { frameAlong } from '../kit/shapes.ts';
import { rgb } from '../style/palette.ts';

export const ROVER = {
  /** Uniform scale of the whole rover (the numbers below are before it): sized to the concept art against 1.8 m figures. */
  size: 1.2,
  wheelR: 0.44,
  wheelW: 0.34,
  /** Wheel centres: x either side, z per axle. */
  track: 1.16,
  axles: [1.3, 0, -1.3],
  /** Where each swing arm leaves the body (x either side, height over the body origin). */
  armX: 0.66,
  armY: 0.84,
  /** Body origin height over the mean wheel contact. */
  ride: 0,
  /** Sensor head pivot on the mast (body frame). */
  sensor: [0.5, 2.62, -0.55] as V3,
} as const;

/** Points of a bilinear inset of a quad (a, b, c, d counter-clockwise), from u0..u1 along a→b, v0..v1 along a→d, lifted by `lift` along `n`. */
function inset(q: readonly V3[], u0: number, u1: number, v0: number, v1: number, n: V3, lift: number): V3[] {
  const at = (u: number, v: number): V3 => {
    const p: number[] = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const ab = q[0]![k]! + (q[1]![k]! - q[0]![k]!) * u;
      const dc = q[3]![k]! + (q[2]![k]! - q[3]![k]!) * u;
      p[k] = ab + (dc - ab) * v + n[k]! * lift;
    }
    return p as unknown as V3;
  };
  return [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
}

function faceNormal(q: readonly V3[]): V3 {
  const a = q[0]!, b = q[1]!, d = q[3]!;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
  return [n[0]! / l, n[1]! / l, n[2]! / l];
}

/** Top of the deck over the body origin. */
const DECK = 1.24;

/** The body: everything that does not move against the chassis. */
export function roverBody(b: MeshBuilder): void {
  // Chassis frame and the under-tray.
  b.paint(rgb('metal'));
  b.with(place(0, 0.62, 0), () => box(b, [1.3, 0.3, 3.5]));
  // Deck: an off-white slab with an orange side stripe.
  b.paint(rgb('shell'));
  b.with(place(0, 0.9, -0.05), () => box(b, [1.78, 0.34, 3.55]));
  b.outline = false;
  b.paint(rgb('orange'));
  for (const s of [-1, 1]) b.with(place(s * 0.893, 1.0, -0.05, (s * Math.PI) / 2), () => box(b, [3.4, 0.1, 0.01], { lines: false }));
  b.outline = true;
  // Fenders over the wheels.
  b.paint(rgb('shellPanel'));
  for (const s of [-1, 1]) for (const z of ROVER.axles) b.with(place(s * 1.1, 1.12, z), () => box(b, [0.56, 0.08, 0.86]));
  // Front bumper with two lamps.
  b.paint(rgb('metalMid'));
  b.with(place(0, 0.66, 1.84), () => box(b, [1.6, 0.18, 0.16]));
  b.paint(rgb('lamp'));
  for (const s of [-1, 1]) b.with(place(s * 0.55, 0.98, 1.73), () => box(b, [0.26, 0.12, 0.04]));

  // Cabin over the front half: a frustum of a box leaning back, glass on the front and the sides.
  const y0 = DECK, h = 0.98;
  const bw = 0.82, bd = 0.82, tw = 0.72, td = 0.55, sz = -0.25, cz = 0.85;
  b.paint(rgb('shell'));
  b.with(place(0, y0, cz), () => frustumBox(b, [bw * 2, bd * 2], [tw * 2, td * 2], h, { shift: [0, sz] }));
  const B: V3[] = [[-bw, y0, cz + bd], [bw, y0, cz + bd], [bw, y0, cz - bd], [-bw, y0, cz - bd]];
  const T: V3[] = [[-tw, y0 + h, cz + sz + td], [tw, y0 + h, cz + sz + td], [tw, y0 + h, cz + sz - td], [-tw, y0 + h, cz + sz - td]];
  b.outline = false;
  b.paint(rgb('teal'));
  const front: V3[] = [B[0]!, B[1]!, T[1]!, T[0]!];
  const fn = faceNormal(front);
  polygon(b, inset(front, 0.08, 0.92, 0.3, 0.88, fn, 0.012));
  for (const [q, u0, u1] of [[[B[1]!, B[2]!, T[2]!, T[1]!], 0.12, 0.62], [[B[3]!, B[0]!, T[0]!, T[3]!], 0.38, 0.88]] as const) {
    const n = faceNormal(q);
    polygon(b, inset(q, u0, u1, 0.3, 0.85, n, 0.012));
  }
  b.outline = true;
  // Roof box with a beacon.
  b.paint(rgb('shellPanel'));
  b.with(place(0, y0 + h, cz + sz), () => box(b, [0.9, 0.1, 0.7]));
  b.paint(rgb('orange'));
  b.with(place(-0.45, y0 + h + 0.1, cz + sz - 0.2), () => cylinder(b, 0.07, 0.12, { segments: 8 }));

  // Cargo on the rear deck: an orange equipment box, an off-white case, a drum lying across, a rail round the back.
  b.paint(rgb('orange'));
  b.with(place(-0.35, DECK, -0.95), () => box(b, [0.85, 0.5, 0.8]));
  b.paint(rgb('shellPanel'));
  b.outline = false;
  for (const y of [DECK + 0.12, DECK + 0.24, DECK + 0.36]) b.with(place(-0.35, y, -0.548), () => box(b, [0.6, 0.04, 0.01], { lines: false }));
  b.outline = true;
  b.paint(rgb('shell'));
  b.with(place(0.42, DECK, -1.25), () => box(b, [0.62, 0.42, 0.6]));
  b.paint(rgb('metalMid'));
  b.with(compose(place(-0.3, DECK + 0.2, -1.62), rotateZ(Math.PI / 2), translate(0, -0.4, 0)), () => cylinder(b, 0.2, 0.8, { segments: 12, bottom: true }));
  b.paint(rgb('metal'));
  for (const s of [-1, 1]) tube(b, [s * 0.82, DECK, -1.78], [s * 0.82, DECK + 0.45, -1.78], 0.03, { segments: 6, top: true });
  tube(b, [-0.82, DECK + 0.45, -1.78], [0.82, DECK + 0.45, -1.78], 0.03, { segments: 6, top: true, bottom: true });

  // Sensor mast at the rear left, up to the head pivot.
  b.paint(rgb('metalMid'));
  const [mx, my, mz] = ROVER.sensor;
  b.with(place(mx, DECK, mz), () => cylinder(b, 0.08, 0.12, { segments: 10 }));
  b.paint(rgb('metalLight'));
  b.with(place(mx, DECK + 0.12, mz), () => cylinder(b, 0.045, my - DECK - 0.12, { segments: 8, rTop: 0.035 }));
  b.paint(rgb('orange'));
  b.with(place(mx, DECK + 0.55, mz), () => cylinder(b, 0.06, 0.12, { segments: 8 }));
}

/** A wheel about the x axis through the origin: a dark tyre with tread lugs and orange hubs on both faces. */
export function roverWheel(b: MeshBuilder): void {
  const r = ROVER.wheelR, w = ROVER.wheelW;
  b.paint(rgb('rubber'));
  b.with(compose(rotateZ(-Math.PI / 2), translate(0, -w / 2, 0)), () => cylinder(b, r - 0.04, w, { segments: 22, bottom: true }));
  // Tread: chevron-like lugs alternating across the tyre.
  const n = 14;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const x = k % 2 ? 0.07 : -0.07;
    b.with(compose(rotateX(a), translate(x, r - 0.06, 0)), () => box(b, [w * 0.55, 0.07, 0.1]));
  }
  // Hubs: an orange disc and a dark cap on each face.
  for (const s of [-1, 1]) {
    b.paint(rgb('orange'));
    b.with(compose(rotateZ((-s * Math.PI) / 2), translate(0, w / 2 - 0.01, 0)), () => cylinder(b, 0.21, 0.03, { segments: 14 }));
    b.paint(rgb('metal'));
    b.with(compose(rotateZ((-s * Math.PI) / 2), translate(0, w / 2 + 0.02, 0)), () => cylinder(b, 0.08, 0.04, { segments: 10 }));
  }
}

/** A swing arm one metre long along +y (the record stretches it from the body to the hub). */
export function roverArm(b: MeshBuilder): void {
  b.paint(rgb('metalMid'));
  b.with(place(0, 0, 0), () => box(b, [0.1, 1, 0.14], { lines: false }));
}

/** The sensor head: a box with two teal lenses and a small dish on top, turning about +y. */
export function roverSensor(b: MeshBuilder): void {
  b.paint(rgb('shell'));
  b.with(place(0, 0, 0), () => box(b, [0.44, 0.24, 0.26]));
  b.paint(rgb('metal'));
  b.with(place(0, 0.24, 0), () => cylinder(b, 0.035, 0.12, { segments: 6 }));
  b.paint(rgb('shellPanel'));
  b.with(place(0, 0.36, 0), () => cylinder(b, 0.09, 0.04, { segments: 10 }));
  b.paint(rgb('teal'));
  for (const s of [-1, 1]) b.with(compose(place(s * 0.11, 0.12, 0.13), rotateX(Math.PI / 2)), () => cylinder(b, 0.06, 0.04, { segments: 10 }));
}

export interface RoverParts {
  body: InstanceSet;
  wheels: InstanceSet;
  arms: InstanceSet;
  sensor: InstanceSet;
}

export function roverParts(): RoverParts {
  const mk = (name: string, fill: (b: MeshBuilder) => void, n: number): InstanceSet => {
    const m = new MeshBuilder();
    fill(m);
    const s = instanceSet(m.build(), n, { name });
    s.count = n;
    return s;
  };
  return { body: mk('rover body', roverBody, 1), wheels: mk('rover wheels', roverWheel, 6), arms: mk('rover arms', roverArm, 6), sensor: mk('rover sensor', roverSensor, 1) };
}

/**
 * Poses the rover at ground point (x, z) facing `heading` (0: +z), wheels turned by `spin` radians and the sensor
 * head by `look`. `heightAt` is the ground.
 */
export function poseRover(p: RoverParts, x: number, z: number, heading: number, spin: number, look: number, heightAt: (x: number, z: number) => number): void {
  const s = Math.sin(heading), c = Math.cos(heading);
  const k = ROVER.size;
  // Contact points and their ground heights.
  const hubs: { side: number; az: number; x: number; z: number; y: number }[] = [];
  for (const side of [1, -1]) for (const az of ROVER.axles) {
    const lx = side * ROVER.track * k, lz = az * k;
    const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
    hubs.push({ side, az, x: wx, z: wz, y: heightAt(wx, wz) });
  }
  const mean = (f: (h: (typeof hubs)[number]) => boolean): number => {
    const l = hubs.filter(f);
    return l.reduce((a, h) => a + h.y, 0) / l.length;
  };
  const front = mean((h) => h.az > 0.5), rear = mean((h) => h.az < -0.5);
  const left = mean((h) => h.side > 0), right = mean((h) => h.side < 0);
  const y = mean(() => true) + ROVER.ride;
  const span = (ROVER.axles[0] - ROVER.axles[2]) * k;
  const pitch = -Math.atan2(front - rear, span);
  const roll = Math.atan2(left - right, ROVER.track * 2 * k);
  const body: Mat = compose(translate(x, y, z), rotateY(heading), rotateX(pitch), rotateZ(roll), scale(k));
  writeInstance(p.body, 0, body);
  hubs.forEach((h, i) => {
    const hub: V3 = [h.x, h.y + ROVER.wheelR * k, h.z];
    writeInstance(p.wheels, i, compose(translate(hub[0], hub[1], hub[2]), rotateY(heading), rotateX(spin), scale(k)));
    // The arm from the body to the inner face of the hub.
    const from = transformPoint(body, [h.side * ROVER.armX, ROVER.armY, h.az]);
    const inner: V3 = [hub[0] - h.side * c * (ROVER.wheelW / 2) * k, hub[1], hub[2] + h.side * s * (ROVER.wheelW / 2) * k];
    const f = frameAlong(from, inner);
    writeInstance(p.arms, i, compose(f.m, scale(k, f.len, k)));
  });
  writeInstance(p.sensor, 0, compose(body, translate(ROVER.sensor[0], ROVER.sensor[1], ROVER.sensor[2]), rotateY(look)));
  p.body.dirty = p.wheels.dirty = p.arms.dirty = p.sensor.dirty = true;
}
