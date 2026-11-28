// The cars drawn: one instance set each for the bodies, the front doors (the left door's mesh, mirrored for the right
// one), the wheels (mirrored on the left, so the spokes face out) and the roof loads of the cars that carry one (the
// rack with its crates and bundle, on the body's transform). Written every frame from the cars' drawn places
// (src/car.ts); nothing is allocated per frame. The tyre marks are in the page's contact trail (src/traces.ts).

import type { Material, Renderer } from 'wallhammer-web/render';
import { InstanceSetLayer, instanceSet, writeInstance } from 'wallhammer-web/render';
import type { InstanceSet } from 'wallhammer-web/render';
import { compactCarMeshes, compactRoofLoadMesh, doorHinge } from '../../shared/src/vehicles/compact.ts';
import type { Cars } from './car.ts';

/** Paint of the cars, in order (a warm red, a slate blue). */
export const CAR_PAINTS: readonly (readonly [number, number, number])[] = [
  [0.74, 0.16, 0.1],
  [0.2, 0.36, 0.52],
];

/** out = a · b for 3 × 4 matrices (columns x, y, z, translation). */
function mul34(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): Float64Array {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 3]!, b1 = b[c * 3 + 1]!, b2 = b[c * 3 + 2]!;
    for (let r = 0; r < 3; r++) out[c * 3 + r] = a[r]! * b0 + a[3 + r]! * b1 + a[6 + r]! * b2 + (c === 3 ? a[9 + r]! : 0);
  }
  return out;
}

export class CarView {
  readonly bodies: InstanceSet;
  readonly doors: InstanceSet;
  readonly wheels: InstanceSet;
  readonly roofLoads: InstanceSet;
  readonly layer: InstanceSetLayer;
  private readonly cars: Cars;
  private readonly m = new Float64Array(12);
  private readonly h = new Float64Array(12);
  private readonly d = new Float64Array(12);
  /** The x mirror (as a 3 × 4 matrix). */
  private readonly mirror = new Float64Array([-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  private readonly mirrored = new Float64Array(12);

  constructor(renderer: Renderer, carMaterial: Material, cars: Cars) {
    this.cars = cars;
    const n = cars.bodies.length;
    const meshes = compactCarMeshes(cars.restHeight);
    this.bodies = instanceSet(meshes.body, n, { name: 'car bodies' });
    this.doors = instanceSet(meshes.door, n * 2, { name: 'car doors' });
    this.wheels = instanceSet(meshes.wheel, n * 4, { name: 'car wheels' });
    this.roofLoads = instanceSet(compactRoofLoadMesh(cars.restHeight), n, { name: 'car roof loads' });
    this.layer = new InstanceSetLayer(renderer, { name: 'cars', material: carMaterial });
    this.layer.add(this.bodies);
    this.layer.add(this.doors);
    this.layer.add(this.wheels);
    this.layer.add(this.roofLoads);
  }

  /** Writes every car at `a` of the way between the cars' last two steps. */
  write(a: number): void {
    const cars = this.cars, m = this.m;
    let loads = 0;
    for (let i = 0; i < cars.bodies.length; i++) {
      const b = cars.bodies[i]!;
      const paint = CAR_PAINTS[i % CAR_PAINTS.length]!;
      b.renderMatrix(m, a);
      writeInstance(this.bodies, i, m, paint[0], paint[1], paint[2], cars.lamps(i));
      if (cars.roofLoad(i)) writeInstance(this.roofLoads, loads++, m, 1, 1, 1, 0);
      // The left door about its hinge; the right one is the same turn of the mirrored door.
      mul34(m, doorHinge(cars.door(i * 2, a), this.h), this.d);
      writeInstance(this.doors, i * 2, this.d, paint[0], paint[1], paint[2], 0);
      mul34(this.mirror, doorHinge(cars.door(i * 2 + 1, a), this.h), this.mirrored);
      mul34(m, this.mirrored, this.d);
      writeInstance(this.doors, i * 2 + 1, this.d, paint[0], paint[1], paint[2], 0);
      for (let w = 0; w < b.wheels.length; w++) {
        b.wheelMatrix(w, m, a);
        // The wheel's outer face is +x; on the left it faces −x.
        if (b.wheels[w]!.spec.x < 0) (m[0] = -m[0]!), (m[1] = -m[1]!), (m[2] = -m[2]!);
        writeInstance(this.wheels, i * 4 + w, m, 1, 1, 1, 0);
      }
    }
    this.bodies.count = cars.bodies.length;
    this.doors.count = cars.bodies.length * 2;
    this.wheels.count = cars.bodies.length * 4;
    this.roofLoads.count = loads;
    this.bodies.dirty = this.doors.dirty = this.wheels.dirty = this.roofLoads.dirty = true;
  }
}
