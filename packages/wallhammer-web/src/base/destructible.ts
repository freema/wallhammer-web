// Destructible structures as data: the contract between a generator that knows a structure and the deterministic
// module that decides what breaks (sim/destruction). Destruction is state, not geometry: a structure is a graph of
// parts with stable keys, and its damage is a small map `part key → entry`. Geometry is regenerated from that map.
//
// Everything that takes part in a decision is an integer: positions and sizes in centimetres, mass in kilograms,
// energy in abstract units. Generators round their float geometry once, when they emit the description.

/** Rungs of the damage ladder of one part. */
export const DAMAGE = { intact: 0, cracked: 1, breached: 2, gone: 3 } as const;
export type DamageRung = (typeof DAMAGE)[keyof typeof DAMAGE];

/** Part flags. */
export const PART_FLAG = {
  /** Touches the ground: the source of support in the connectivity test. */
  anchor: 1,
  /** Never takes damage (ground, foundations). */
  indestructible: 2,
  /** Lies inside the outline of its structure: it falls straight down and its rubble stays within its own footprint. */
  inner: 4,
} as const;

/**
 * Generic role of a part. The content decides which of its elements gets which role; the engine only uses the role
 * to pick a default rubble archetype.
 */
export const PART_ROLE = {
  /** Under everything else, usually an anchor. */
  foundation: 0,
  /** Carries what rests on it (a wall-like part). */
  bearing: 1,
  /** Spans between bearing parts (a slab or cover section). */
  span: 2,
  /** Hangs on the side of another part. */
  attached: 3,
  /** Stands on top of another part. */
  fixture: 4,
} as const;
export type PartRole = (typeof PART_ROLE)[keyof typeof PART_ROLE];

/**
 * Convex piece of a part: a vertical prism over a convex polygon. `xz` holds the polygon corners as x, z pairs in
 * centimetres, counter-clockwise when x points right and z points down (the same sense as a positive signed area
 * of `x·z' − z·x'`). A box is a prism with four corners.
 */
export interface ConvexPiece {
  xz: Int32Array;
  /** Bottom and top in centimetres. */
  y0: number;
  y1: number;
}

/** Thresholds of one destructible material in energy units. 0 for `breach` means the material has no breach rung. */
export interface DestructibleMaterial {
  crack: number;
  breach: number;
  gone: number;
  /** Density in kg/m³ of the solid the part stands for; turns mass into rubble volume. */
  density: number;
}

/** One part of a structure. */
export interface StructurePart {
  /**
   * Stable key, unique inside the structure (unsigned 32-bit). It comes from the structure's input (a rule id and the
   * part's path in the recipe), never from the order in which a generator emits geometry.
   */
  key: number;
  role: PartRole;
  /** Index into `StructureDesc.materials`. */
  material: number;
  /** Mass in kilograms. */
  mass: number;
  piece: ConvexPiece;
  /** `PART_FLAG` bits. */
  flags: number;
  /**
   * How many lateral bonds the part may hang from a part that rests on something below (a heuristic load path on
   * top of plain connectivity). 255 = plain connectivity.
   */
  maxSpan: number;
}

/** A bond between two parts through a shared face. */
export interface StructureBond {
  /** Part keys. For a bearing bond `a` is below and carries `b`. */
  a: number;
  b: number;
  /** True when `b` rests on `a`; false for a lateral tie (side by side, or hanging on a side). */
  bearing: boolean;
  /** Centre of the shared face in centimetres and its area in cm². */
  x: number;
  y: number;
  z: number;
  area: number;
}

/** Everything the deterministic module needs to know about one structure. */
export interface StructureDesc {
  /** Stable id of the structure (its anchor in the input), the key of its damage edit. */
  id: number;
  /** Protected: events never change it. */
  keepOut: boolean;
  /** Ground level under the structure and its centre, in centimetres. */
  groundY: number;
  cx: number;
  cz: number;
  /** Convex outline of the whole structure (x, z pairs in cm), the footprint of a ruin. */
  outline: Int32Array;
  materials: DestructibleMaterial[];
  /** Sorted by key. */
  parts: StructurePart[];
  /** Sorted by (a, b). */
  bonds: StructureBond[];
}

/**
 * Damage entry of one part, packed into one integer: rung (2 bits), fall direction (4 bits, 0–7 compass octants
 * counted from +x toward +z, 8 = straight down) and a variant (8 bits) chosen at the moment of the event.
 * Rubble of a gone part is a pure function of the part and its entry.
 */
export type DamageEntry = number;

export function packEntry(rung: DamageRung, dir: number, variant: number): DamageEntry {
  return (rung & 3) | ((dir & 15) << 2) | ((variant & 255) << 6);
}
export function entryRung(e: DamageEntry): DamageRung {
  return (e & 3) as DamageRung;
}
export function entryDir(e: DamageEntry): number {
  return (e >> 2) & 15;
}
export function entryVariant(e: DamageEntry): number {
  return (e >> 6) & 255;
}

/** Damage state of one structure: the authoritative edit. Intact parts have no entry. */
export interface StructureState {
  structure: number;
  /** Coarsened into a ruin (the budget was exceeded): every destructible part counts as gone. */
  ruin: boolean;
  parts: ReadonlyMap<number, DamageEntry>;
}

/** Rubble archetypes. */
export const RUBBLE = { heap: 0, slabs: 1, scatter: 2, ruin: 3 } as const;
export type RubbleArchetype = (typeof RUBBLE)[keyof typeof RUBBLE];

/**
 * Where rubble lies: an oriented rectangle on the ground with a height. This is the only result of destruction that
 * other systems (navigation, cover, saves) may read. Centimetres.
 */
export interface RubbleFootprint {
  structure: number;
  /** Key of the part the rubble came from (0 for the ruin of a whole structure). */
  part: number;
  archetype: RubbleArchetype;
  /** Material index of the source part, so the rubble has its colour. */
  material: number;
  cx: number;
  cz: number;
  y: number;
  /** Unit long axis scaled by 1024. */
  ux: number;
  uz: number;
  halfL: number;
  halfW: number;
  height: number;
  /** Corners as x, z pairs, counter-clockwise. */
  corners: Int32Array;
  seed: number;
}

/**
 * A canonical destruction event: what an input command or the simulation sends. Integers only, so the same event
 * gives the same result everywhere. Position and radius in cm, energy in abstract units.
 */
export interface DestructionEvent {
  x: number;
  y: number;
  z: number;
  radius: number;
  energy: number;
  seed: number;
  tick: number;
}
