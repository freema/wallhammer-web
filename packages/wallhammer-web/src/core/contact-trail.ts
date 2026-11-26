// A contact trail: marks laid on a surface where something touched it, kept in a ring of fixed capacity. A mark is a
// small rectangle lying in the surface: its centre, the surface's normal there, a heading in the surface, a width and
// a length, a kind (a small integer the game gives meaning to: what touched, how it looks), the time it was laid and
// the seconds it lives. When the ring is full the newest mark takes the place of the oldest.
//
// The ring is plain numbers (`CONTACT_TRAIL_FLOATS` per mark, in a Float32Array a renderer can upload as it is) and
// keeps the span of marks changed since the last `clean`, so a layer uploads only what was laid. Nothing is
// allocated after construction. Time is whatever clock the game lays marks in; the layer that draws them is given
// "now" in the same clock, and the marks fade with their age (`contactTrailFade`, the same arithmetic as
// `CONTACT_TRAIL_GLSL`).
//
// `ContactStreaks` lays a continuous contact (something that slides or rolls along the surface) as a chain of marks,
// each from the last point to the next one far enough away.

/** Floats per mark: x, y, z, time laid; the normal (3), heading; width, length, kind, life. */
export const CONTACT_TRAIL_FLOATS = 12;
/** A mark keeps its full strength over this share of its life, then fades out. */
export const CONTACT_TRAIL_FADE_FROM = 0.4;

/**
 * Strength of a mark `age` seconds after it was laid, of `life` seconds: 1 at first, falling smoothly from
 * `CONTACT_TRAIL_FADE_FROM` of its life to 0 at its end; 0 before it was laid and after it ended.
 */
export function contactTrailFade(age: number, life: number): number {
  if (!(age >= 0) || !(life > 0) || age >= life) return 0;
  const t = (age / life - CONTACT_TRAIL_FADE_FROM) / (1 - CONTACT_TRAIL_FADE_FROM);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - k * k * (3 - 2 * k);
}

/** `contactTrailFade` in GLSL, with the same name and arithmetic. */
export const CONTACT_TRAIL_GLSL = /* glsl */ `
float contactTrailFade(float age, float life) {
  if (!(age >= 0.0) || !(life > 0.0) || age >= life) return 0.0;
  float k = clamp((age / life - ${CONTACT_TRAIL_FADE_FROM.toFixed(4)}) / ${(1 - CONTACT_TRAIL_FADE_FROM).toFixed(4)}, 0.0, 1.0);
  return 1.0 - k * k * (3.0 - 2.0 * k);
}
`;

/** One mark, for `ContactTrail.lay`. */
export interface ContactMark {
  /** Centre, in the coordinates the marks are drawn in. */
  x: number;
  y: number;
  z: number;
  /** Unit normal of the surface there (default straight up). */
  nx?: number;
  ny?: number;
  nz?: number;
  /** Heading of the mark's length, radians about the up axis: 0 runs toward −z, π/2 toward −x. */
  heading: number;
  /** Width across and length along the heading, metres. */
  width: number;
  length: number;
  /** The game's kind of mark, 0 or more. */
  kind: number;
  /** Time the mark is laid at, in the game's clock (seconds). */
  time: number;
  /** Seconds it lives (fading over the end of it). */
  life: number;
}

/** Marks in a ring of fixed capacity: the newest replaces the oldest. */
export class ContactTrail {
  readonly capacity: number;
  /** `CONTACT_TRAIL_FLOATS` per slot (see the layout there); a renderer uploads it as it is. */
  readonly data: Float32Array;
  /** Marks laid in all; the newest is in slot `(laid − 1) % capacity`. */
  laid = 0;
  /** Slots changed since the last `clean`: `dirtyFrom` to `dirtyTo` (exclusive); equal when nothing changed. */
  dirtyFrom = 0;
  dirtyTo = 0;
  /** End of the longest-living mark laid (time plus life), −Infinity before the first. */
  lastEnd = -Infinity;

  constructor(capacity: number) {
    const n = Math.floor(capacity);
    if (!(n >= 1)) throw new Error(`ContactTrail: capacity must be 1 or more, got ${capacity}`);
    this.capacity = n;
    this.data = new Float32Array(n * CONTACT_TRAIL_FLOATS);
  }

  /** Marks the ring holds now (at most `capacity`, whether faded or not). */
  get count(): number {
    return this.laid < this.capacity ? this.laid : this.capacity;
  }

  /** Lays one mark; returns its slot. */
  lay(m: ContactMark): number {
    return this.layRaw(m.x, m.y, m.z, m.nx ?? 0, m.ny ?? 1, m.nz ?? 0, m.heading, m.width, m.length, m.kind, m.time, m.life);
  }

  /** `lay` with plain numbers (no object), for hot paths. The normal is used as given (pass a unit vector). */
  layRaw(x: number, y: number, z: number, nx: number, ny: number, nz: number, heading: number, width: number, length: number, kind: number, time: number, life: number): number {
    const slot = this.laid % this.capacity;
    const o = slot * CONTACT_TRAIL_FLOATS;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = time;
    d[o + 4] = nx;
    d[o + 5] = ny;
    d[o + 6] = nz;
    d[o + 7] = heading;
    d[o + 8] = width;
    d[o + 9] = length;
    d[o + 10] = kind;
    d[o + 11] = life;
    this.laid++;
    if (time + life > this.lastEnd) this.lastEnd = time + life;
    // The changed span grows to cover the slot; one that wraps past the end covers the whole ring.
    if (this.dirtyFrom === this.dirtyTo) {
      this.dirtyFrom = slot;
      this.dirtyTo = slot + 1;
    } else if (slot === this.dirtyTo) this.dirtyTo = slot + 1;
    else if (slot < this.dirtyFrom || slot >= this.dirtyTo) {
      this.dirtyFrom = 0;
      this.dirtyTo = this.capacity;
    }
    return slot;
  }

  /** Strength of the mark in `slot` at `now` (0 for a slot never written). */
  fadeAt(slot: number, now: number): number {
    if (slot < 0 || slot >= this.count) return 0;
    const o = slot * CONTACT_TRAIL_FLOATS;
    return contactTrailFade(now - this.data[o + 3]!, this.data[o + 11]!);
  }

  /** Marks still visible at `now` (counted over the ring; for statistics and checks). */
  visible(now: number): number {
    let n = 0;
    for (let s = 0; s < this.count; s++) if (this.fadeAt(s, now) > 0) n++;
    return n;
  }

  /** Whether any mark is still visible at `now` (cheap: by the longest-living mark). */
  busy(now: number): boolean {
    return now < this.lastEnd;
  }

  /** Forgets the changed span (a layer calls it after uploading). */
  clean(): void {
    this.dirtyFrom = this.dirtyTo = 0;
  }

  /** Forgets every mark (the whole ring counts as changed). */
  clear(): void {
    this.data.fill(0);
    this.laid = 0;
    this.lastEnd = -Infinity;
    this.dirtyFrom = 0;
    this.dirtyTo = this.capacity;
  }
}

/** Options of `ContactStreaks`. */
export interface ContactStreakOptions {
  /** A new mark only once the contact has moved this far from the last point, metres. Default 0.35. */
  minLength?: number;
  /** A jump farther than this starts a new chain instead of a mark (a teleport, a contact that left the surface between two samples), metres. Default 2. */
  maxLength?: number;
}

/**
 * Continuous contacts laid as chains of marks: per source (a slot of the game's own numbering, such as one per
 * contact point), each call while it touches lays a mark from its last point to the new one once that is
 * `minLength` away; a call that does not touch ends the chain. The marks run along the surface between the two points.
 */
export class ContactStreaks {
  readonly trail: ContactTrail;
  readonly minLength: number;
  readonly maxLength: number;
  /** Per source: the last point (x, y, z) and 1 while a chain runs. */
  private readonly last: Float64Array;

  constructor(trail: ContactTrail, sources: number, o: ContactStreakOptions = {}) {
    this.trail = trail;
    this.minLength = o.minLength ?? 0.35;
    this.maxLength = o.maxLength ?? 2;
    this.last = new Float64Array(Math.max(1, Math.floor(sources)) * 4);
  }

  /**
   * One sample of source `slot`: touching or not, the contact point and the surface's unit normal; a mark of `width`,
   * `kind` and `life` is laid at `time` when the chain has moved far enough. Returns whether a mark was laid.
   */
  touch(slot: number, touching: boolean, x: number, y: number, z: number, nx: number, ny: number, nz: number, width: number, kind: number, time: number, life: number): boolean {
    const l = this.last, o = slot * 4;
    if (!touching) {
      l[o + 3] = 0;
      return false;
    }
    if (l[o + 3] === 0) {
      l[o] = x;
      l[o + 1] = y;
      l[o + 2] = z;
      l[o + 3] = 1;
      return false;
    }
    const dx = x - l[o]!, dz = z - l[o + 2]!;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < this.minLength) return false;
    let laid = false;
    if (d < this.maxLength) {
      const dy = y - l[o + 1]!;
      // Heading of the way from the last point (0 toward −z), the length along the surface.
      const heading = Math.atan2(-dx, -dz);
      this.trail.layRaw((x + l[o]!) / 2, (y + l[o + 1]!) / 2, (z + l[o + 2]!) / 2, nx, ny, nz, heading, width, Math.sqrt(d * d + dy * dy), kind, time, life);
      laid = true;
    }
    l[o] = x;
    l[o + 1] = y;
    l[o + 2] = z;
    return laid;
  }

  /** Ends every chain (the trail keeps its marks). */
  reset(): void {
    this.last.fill(0);
  }
}
