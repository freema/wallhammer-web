// The six signs a pathfinder may wear on its chest, as flat shapes: every sign is a list of convex polygons in a square
// of side 1 about the origin (x right, y up). They are painted as coloured faces a little proud of a surface, never as
// a texture: `glyphFaces` lays a sign into any plane (the pathfinder's mesh puts it on the front of its cape).
// Pure data and pure functions: no state, no randomness.

export type Glyph = 'waypoint' | 'water' | 'path' | 'hexagon' | 'home' | 'ladder';
export const GLYPHS: readonly Glyph[] = ['waypoint', 'water', 'path', 'hexagon', 'home', 'ladder'];

type V2 = readonly [number, number];
type Poly = readonly V2[];

/** A line of the width `w` through the points: one quad a stretch, each a little longer than its stretch so they join. */
function stroke(pts: readonly V2[], w: number, capped = true): Poly[] {
  const out: Poly[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const dx = (b[0] - a[0]) / l;
    const dy = (b[1] - a[1]) / l;
    // Inner joints are lengthened by half the width; the two ends only when `capped`.
    const e0 = i > 0 || capped ? w / 2 : 0;
    const e1 = i + 2 < pts.length || capped ? w / 2 : 0;
    const p: V2 = [a[0] - dx * e0, a[1] - dy * e0];
    const q: V2 = [b[0] + dx * e1, b[1] + dy * e1];
    const nx = (-dy * w) / 2;
    const ny = (dx * w) / 2;
    out.push([[p[0] + nx, p[1] + ny], [p[0] - nx, p[1] - ny], [q[0] - nx, q[1] - ny], [q[0] + nx, q[1] + ny]]);
  }
  return out;
}

const W = 0.11;
const hexAt = (k: number, r: number): V2 => [Math.cos((k * Math.PI) / 3) * r, Math.sin((k * Math.PI) / 3) * r];
const between = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

const SHAPES: Readonly<Record<Glyph, readonly Poly[]>> = {
  // A diamond on a stem: a place on the way.
  waypoint: [...stroke([[0, 0.5], [0.3, 0.2], [0, -0.1], [-0.3, 0.2], [0, 0.5]], W, false), ...stroke([[0, -0.24], [0, -0.5]], W, false)],
  // Two waves: water.
  water: [...stroke([[-0.46, 0.08], [-0.23, 0.27], [0, 0.08], [0.23, 0.27], [0.46, 0.08]], W * 1.2), ...stroke([[-0.46, -0.27], [-0.23, -0.08], [0, -0.27], [0.23, -0.08], [0.46, -0.27]], W * 1.2)],
  // A stepped line with an arrow head: the way goes on.
  path: [...stroke([[-0.5, -0.2], [-0.27, -0.2], [-0.06, 0.12], [0.24, 0.12]], W), [[0.22, 0.32], [0.22, -0.08], [0.5, 0.12]]],
  // A hexagon open to the right: a shrine, a light.
  hexagon: [...stroke([hexAt(1, 0.42), hexAt(2, 0.42), hexAt(3, 0.42), hexAt(4, 0.42), hexAt(5, 0.42)], W * 1.15), ...stroke([hexAt(1, 0.42), between(hexAt(1, 0.42), hexAt(0, 0.42), 0.45)], W * 1.15), ...stroke([hexAt(5, 0.42), between(hexAt(5, 0.42), hexAt(0, 0.42), 0.45)], W * 1.15)],
  // A roof over a square: home.
  home: [...stroke([[-0.4, 0.04], [0, 0.4], [0.4, 0.04]], W * 1.3), [[-0.14, -0.46], [0.14, -0.46], [0.14, -0.14], [-0.14, -0.14]]],
  // A stem with three rungs: a climb, a count.
  ladder: [...stroke([[0, -0.5], [0, 0.5]], W, false), ...stroke([[-0.3, 0.26], [0.3, 0.26]], W, false), ...stroke([[-0.3, 0.02], [0.3, 0.02]], W, false), ...stroke([[-0.3, -0.22], [0.3, -0.22]], W, false)],
};

/** The convex polygons of a sign in the unit square about the origin, counter-clockwise or clockwise as they come. */
export function glyphShape(g: Glyph): readonly (readonly (readonly [number, number])[])[] {
  return SHAPES[g];
}

/**
 * A sign laid into a plane: its polygons as points in space, for a sign `size` across with its middle at `origin`,
 * `right` and `up` being the unit axes of the plane. Lift `origin` a little off the surface it is painted on.
 */
export function glyphFaces(g: Glyph, origin: readonly [number, number, number], right: readonly [number, number, number], up: readonly [number, number, number], size: number): [number, number, number][][] {
  return SHAPES[g].map((poly) => poly.map(([x, y]): [number, number, number] => [origin[0] + (right[0] * x + up[0] * y) * size, origin[1] + (right[1] * x + up[1] * y) * size, origin[2] + (right[2] * x + up[2] * y) * size]));
}
