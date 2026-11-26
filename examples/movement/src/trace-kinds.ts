// The kinds of marks the course's ground takes (the engine's `ContactTrail` kinds): what made them and on what, and how
// long each lasts. Pure data, shared by the cars (src/car.ts, also run by the headless check), the page's prints
// (src/traces.ts) and the trail's material (src/shaders.ts, which draws each kind).

/** Kinds of marks, in the trail's `kind` numbers. */
export const TRACE_KIND = {
  /** A sliding tyre: a dark rubber streak. */
  skid: 0,
  /** A tyre rolling on loose ground: a rut of darker, packed earth with a tread. */
  rut: 1,
  /** The figure's boot on grass: a faint pressed sole. */
  bootGrass: 2,
  /** The figure's boot on loose ground: a deep sole with a heel. */
  bootLoose: 3,
  /** A hoof on grass: a faint round print. */
  hoofGrass: 4,
  /** A hoof on loose ground: a deep round print with a frog. */
  hoofLoose: 5,
} as const;

/** Seconds each kind of mark lasts (fading over its last 60 %), by kind. */
export const TRACE_LIFE_S: readonly number[] = [8, 14, 10, 20, 10, 20];
