// The pathfinders: little travelling people on foot. Stocky toy proportions (a big head, short legs, big boots, mitten
// hands) under a poncho with a zigzag hem in a second colour and a painted sign on the chest; a tall collar, a
// scarf or a hood; spiky hair, a ponytail or a bun; on the back a pack with a bedroll and a pole whose arm carries a
// glowing lantern beside the head.
//
// One kind, many looks: every part belongs to a colour slot (cloak, trim, hair, skin, neckwear) and may belong to a
// feature (a hood, a kind of hair, a sign, the side of the pole). `look(variant)` gives the colours and the features
// of a variant: 0–3 are the four colourways of the model sheet, any other number a combination found from it.
// Shapes in metres in the rest pose: x to the figure's left, y up, z forward.
//
// Besides its parts the kind names its arms and its gaze as chains for the engine's reach and aim, sockets for held
// things (a hand each, a place in front of the chest to read at, a pocket on the side of the pack) and two props: a
// small box and a book in two halves (the front half turns about the spine to open it). The motions for the upper
// body (`wave`, `offer`, `take`, `read`) move only the arms and are meant for a layer masked to them; `sitDown` and
// `standUp` lead from standing into `sit` and back. `push` and `brace` are additive: the body leaning into a start and
// back against a stop, for layers weighted by the figure's acceleration. The ponytail hangs on a chain of three bones
// (`lag`) that a figure may let lag behind its motion (the engine's `ChainLag`).

import { hashInts, unit } from 'wallhammer-web/gen-core';
import type { Pose } from 'wallhammer-web/motion';
import { GLYPHS, glyphFaces } from './glyphs.ts';
import { Bones, TAU, mix, shift, smooth, turn } from './kind.ts';
import type { FigureKind, FigureLook, FigureMotion } from './kind.ts';
import { FigureMesh, MAT, rgb } from './mesh.ts';
import type { P, RGB } from './mesh.ts';
import { SIDES, STEPS, kite, stride } from './biped.ts';

type Bone = 'root' | 'torso' | 'head' | 'armL' | 'foreL' | 'armR' | 'foreR' | 'legL' | 'shinL' | 'legR' | 'shinR' | 'cloak' | 'lampL' | 'lampR' | 'tail' | 'footL' | 'footR' | 'handL' | 'handR' | 'tail2' | 'tail3';

/** Colour slots of a look. */
const SLOT = { cloak: 0, trim: 1, hair: 2, skin: 3, neck: 4 } as const;
/** Feature bits of a look. */
export const PATHFINDER = {
  collar: 1,
  scarf: 2,
  hood: 4,
  spiky: 8,
  ponytail: 16,
  bun: 32,
  beard: 64,
  poleL: 128,
  poleR: 256,
  torch: 512,
  /** The first of the six signs (glyphs.ts, in the order of `GLYPHS`). */
  glyph: 1024,
  /** The ponytail without the ponytail's scalp, behind any other hair (`PATHFINDER_TAIL`). */
  tail: 65536,
} as const;

const WHITE: RGB = [1, 1, 1];
const TUNIC = rgb('#e3cfa2');
const SLEEVE = rgb('#7b5a41');
const TROUSERS = rgb('#4b3b34');
const BOOT = rgb('#8a5330');
const BOOT_DARK = rgb('#6d3f26');
const LEATHER = rgb('#8b5a35');
const LEATHER_DARK = rgb('#6b4229');
const LEATHER_LIGHT = rgb('#9c6a40');
const BRASS = rgb('#d6a84a');
const ROLL = rgb('#e2cfa0');
const ROLL_DARK = rgb('#b99f6e');
const WOOD = rgb('#7d4f2e');
const IRON = rgb('#4a3023');
const FACE = rgb('#35241d');
const GLASS: RGB = [0.56, 0.27, 0.04];
const GLASS_CORE: RGB = [0.8, 0.62, 0.3];
const FLAME: RGB = [1.0, 0.36, 0.06];

/** An eight-sided ring at height `y`: a rectangle of half sizes `hx` and `zf` (front) / `zb` (back) with its corners cut by `b`. Starts at the front left. */
function rrect(y: number, hx: number, zf: number, zb: number, b: number, dz = 0): P[] {
  return [
    [hx - b, y, zf + dz], [hx, y, zf - b + dz], [hx, y, -(zb - b) + dz], [hx - b, y, -zb + dz],
    [-(hx - b), y, -zb + dz], [-hx, y, -(zb - b) + dz], [-hx, y, zf - b + dz], [-(hx - b), y, zf + dz],
  ];
}
/** A ring with a point added in the middle of every edge. */
const twice = (r: readonly P[]): P[] => r.flatMap((p, i): P[] => {
  const q = r[(i + 1) % r.length]!;
  return [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]];
});
const mid = (ps: readonly P[]): P => {
  let x = 0, y = 0, z = 0;
  for (const p of ps) (x += p[0]), (y += p[1]), (z += p[2]);
  return [x / ps.length, y / ps.length, z / ps.length];
};

/**
 * A cloth between rings of the same number of points: its outside in the colour given, its inside darker. Open at
 * both ends.
 */
function cloth(m: FigureMesh, rings: readonly (readonly P[])[], color: RGB, mat: number, vary = 0.1, inside = 0.6): void {
  for (let r = 0; r + 1 < rings.length; r++) {
    const A = rings[r]!, B = rings[r + 1]!;
    const c = mid([...A, ...B]);
    for (let k = 0; k < A.length; k++) {
      const k1 = (k + 1) % A.length;
      const quad = [A[k]!, B[k]!, B[k1]!, A[k1]!] as const;
      const q = mid(quad);
      const out: P = [q[0] * 2 - c[0], q[1] * 2 - c[1], q[2] * 2 - c[2]];
      m.paint(color, mat, vary);
      m.quad(quad[0], quad[1], quad[2], quad[3], c);
      m.paint([color[0] * inside, color[1] * inside, color[2] * inside], mat, 0.04);
      m.quad(quad[0], quad[1], quad[2], quad[3], out);
    }
  }
}

function pathfinder(): FigureKind {
  const B = new Bones<Bone>(11, [
    ['root', null, [0, 0.56, 0]],
    ['torso', 'root', [0, 0.6, 0]],
    ['head', 'torso', [0, 1.2, 0]],
    ['armL', 'torso', [0.21, 1.1, 0]],
    ['foreL', 'armL', [0.31, 0.9, 0]],
    ['armR', 'torso', [-0.21, 1.1, 0]],
    ['foreR', 'armR', [-0.31, 0.9, 0]],
    ['legL', 'root', [0.13, 0.56, 0]],
    ['shinL', 'legL', [0.13, 0.34, 0]],
    ['legR', 'root', [-0.13, 0.56, 0]],
    ['shinR', 'legR', [-0.13, 0.34, 0]],
    ['cloak', 'torso', [0, 1.1, 0]],
    ['lampL', 'torso', [0.56, 1.75, -0.4]],
    ['lampR', 'torso', [-0.56, 1.75, -0.4]],
    ['tail', 'head', [0, 1.6, -0.2]],
    // The ankles: the boots hang on them, so a foot can lie on a slope.
    ['footL', 'shinL', [0.13, 0.1, 0]],
    ['footR', 'shinR', [-0.13, 0.1, 0]],
    // The wrists: the ends of the arms' chains and the sockets of the hands (the hands' meshes stay on the forearms).
    ['handL', 'foreL', [0.42, 0.665, 0.03]],
    ['handR', 'foreR', [-0.42, 0.665, 0.03]],
    // The ponytail's lower links (after every other bone, so the indices above stay as they were).
    ['tail2', 'tail', [0, 1.61, -0.38]],
    ['tail3', 'tail2', [0, 1.44, -0.46]],
  ]);
  const id = B.id;
  const F = PATHFINDER;

  // --- Body under the cloak ---
  B.part('root').paint(TROUSERS, MAT.flat, 0.06).loft([rrect(0.48, 0.2, 0.14, 0.14, 0.05), rrect(0.64, 0.19, 0.14, 0.14, 0.05)]);
  const t = B.part('torso');
  t.paint(TUNIC, MAT.flat, 0.06).loft([rrect(0.6, 0.19, 0.14, 0.14, 0.05), rrect(1.08, 0.21, 0.14, 0.14, 0.05), rrect(1.2, 0.09, 0.08, 0.08, 0.03)]);
  t.paint(LEATHER, MAT.flat, 0.06).loft([rrect(0.62, 0.2, 0.15, 0.15, 0.05), rrect(0.69, 0.2, 0.15, 0.15, 0.05)]);
  for (const s of SIDES) {
    const L = s > 0;
    B.part(L ? 'armL' : 'armR').paint(SLEEVE, MAT.flat, 0.08).limb([0.21 * s, 1.1, 0], [0.31 * s, 0.9, 0], 0.085, 0.08, 5);
    const f = B.part(L ? 'foreL' : 'foreR');
    f.paint(SLEEVE, MAT.flat, 0.08).limb([0.31 * s, 0.9, 0], [0.4 * s, 0.74, 0.02], 0.08, 0.075, 5);
    const hand = B.part(L ? 'foreL' : 'foreR', SLOT.skin);
    hand.paint(WHITE, MAT.tint, 0.05).blob([0.42 * s, 0.665, 0.03], [0.075, 0.085, 0.085], 3, 0.06, 6, 2);
    hand.blob([0.4 * s, 0.68, 0.1], [0.035, 0.045, 0.04], 4, 0.05, 4, 1);
    B.part(L ? 'legL' : 'legR').paint(TROUSERS, MAT.flat, 0.06).limb([0.13 * s, 0.58, 0], [0.13 * s, 0.33, 0], 0.11, 0.105, 6);
    const sh = B.part(L ? 'shinL' : 'shinR');
    sh.paint(TROUSERS, MAT.flat, 0.06).limb([0.13 * s, 0.36, 0], [0.13 * s, 0.26, 0], 0.105, 0.1, 6);
    // The boot: a wide shaft with a cuff on a long blunt foot.
    const boot = B.part(L ? 'footL' : 'footR');
    boot.paint(BOOT, MAT.flat, 0.07).box([0.14 * s, 0.17, -0.01], [0.22, 0.22, 0.24], 1.08);
    boot.paint(BOOT_DARK, MAT.flat, 0.05).box([0.14 * s, 0.295, -0.01], [0.26, 0.06, 0.28]);
    boot.paint(BOOT, MAT.flat, 0.07).box([0.14 * s, 0.065, 0.07], [0.24, 0.13, 0.4], 0.84);
    boot.paint(BOOT_DARK, MAT.flat, 0.04).box([0.14 * s, 0.012, 0.07], [0.25, 0.024, 0.41]);
  }

  // --- The poncho: a cape over the shoulders on the torso, the long part swinging from the neck ---
  const SHOULDER = rrect(1.12, 0.275, 0.19, 0.19, 0.08);
  const WAIST = rrect(0.92, 0.385, 0.27, 0.27, 0.1);
  cloth(B.part('torso', SLOT.cloak), [rrect(1.21, 0.12, 0.11, 0.11, 0.04), SHOULDER, WAIST], WHITE, MAT.tint, 0.1);
  // Around the lower part: 16 points; the hem hangs lower in front and behind than over the arms, and a little askew.
  const N = 16;
  const around = (yOf: (i: number, side: number, a: number) => number): P[] =>
    Array.from({ length: N }, (_, i): P => {
      const unitRing = twice(rrect(0, 1, 1, 1, 0.3))[i]!;
      const a = Math.atan2(unitRing[2], unitRing[0]);
      const y = yOf(i, Math.abs(unitRing[0]), a);
      const k = Math.min(1, Math.max(0, (0.96 - y) / 0.66));
      const p = twice(rrect(y, 0.365 + 0.18 * k, 0.255 + 0.14 * k, 0.255 + 0.15 * k, 0.1 + 0.05 * k))[i]!;
      return [p[0], y, p[2]];
    });
  const hemY = (side: number, a: number): number => 0.27 + 0.3 * side * side * side + 0.06 * Math.sin(a + 0.9);
  const top = around(() => 0.96);
  const band = around((i, side, a) => hemY(side, a) + 0.1 + (i & 1 ? 0.24 : 0));
  const edge = around((i, side, a) => hemY(side, a) + (i & 1 ? 0 : 0.05));
  cloth(B.part('cloak', SLOT.cloak), [top, band], WHITE, MAT.tint, 0.1);
  cloth(B.part('cloak', SLOT.trim), [band, edge], WHITE, MAT.tint, 0.06);

  // --- The sign on the chest: flat faces a little proud of the cape's front ---
  const up: P = [0, 0.928, -0.371], out: P = [0, 0.371, 0.928];
  GLYPHS.forEach((g, i) => {
    const m = B.part('torso', SLOT.trim, F.glyph << i);
    m.paint(WHITE, MAT.tint, 0);
    const c: P = [out[0] * 0.012, 0.995 + out[1] * 0.012, 0.24 + out[2] * 0.012];
    for (const poly of glyphFaces(g, c, [-1, 0, 0], up, 0.25)) for (let k = 1; k + 1 < poly.length; k++) m.tri(poly[0]!, poly[k]!, poly[k + 1]!, [0, 1, 0]);
  });

  // --- Neckwear ---
  // A tall collar, open in front.
  const collarTop = rrect(1.37, 0.24, 0.21, 0.23, 0.08, -0.01).map((p): P => [p[0], p[1] - (p[2] > 0 ? 0.55 * p[2] : 0), p[2]]);
  cloth(B.part('torso', SLOT.neck, F.collar), [rrect(1.14, 0.17, 0.15, 0.15, 0.05), collarTop], [0.88, 0.88, 0.88], MAT.tint, 0.08, 0.86);
  // A thick scarf with one end hanging in front.
  const sc = B.part('torso', SLOT.neck, F.scarf);
  sc.paint(WHITE, MAT.tint, 0.12).loft([rrect(1.12, 0.19, 0.18, 0.17, 0.07), rrect(1.19, 0.25, 0.235, 0.21, 0.09), rrect(1.28, 0.2, 0.19, 0.19, 0.07)]);
  sc.paint([0.86, 0.86, 0.86], MAT.tint, 0.08);
  sc.loft([[[0.12, 1.19, 0.21], [0.25, 1.2, 0.17], [0.25, 1.2, 0.21], [0.12, 1.19, 0.25]], [[0.17, 0.9, 0.27], [0.29, 0.93, 0.23], [0.29, 0.93, 0.27], [0.17, 0.9, 0.31]]]);

  // --- Head ---
  const skin = B.part('head', SLOT.skin);
  skin.paint(WHITE, MAT.tint, 0.035).loft([rrect(1.2, 0.1, 0.09, 0.09, 0.03), rrect(1.27, 0.175, 0.165, 0.17, 0.055), rrect(1.37, 0.205, 0.188, 0.19, 0.06), rrect(1.53, 0.205, 0.188, 0.19, 0.06), rrect(1.63, 0.15, 0.13, 0.14, 0.05)]);
  for (const s of SIDES) skin.box([0.212 * s, 1.41, -0.01], [0.04, 0.085, 0.07], 0.8);
  skin.paint([0.9, 0.82, 0.8], MAT.tint, 0).box([0, 1.395, 0.197], [0.034, 0.034, 0.02], 0.7);
  const face = B.part('head');
  face.paint(FACE, MAT.flat, 0);
  for (const s of SIDES) {
    face.box([0.078 * s, 1.435, 0.189], [0.036, 0.066, 0.012], 0.8);
    // Brows, a little raised toward the middle.
    face.quad([0.045 * s, 1.512, 0.196], [0.115 * s, 1.498, 0.196], [0.115 * s, 1.482, 0.196], [0.045 * s, 1.494, 0.196], [0, 1.45, 0]);
    // The smile: a level stroke with raised ends.
    face.quad([0.03 * s, 1.318, 0.181], [0.062 * s, 1.338, 0.178], [0.062 * s, 1.324, 0.176], [0.03 * s, 1.304, 0.179], [0, 1.4, 0]);
  }
  face.quad([-0.031, 1.318, 0.181], [0.031, 1.318, 0.181], [0.031, 1.304, 0.179], [-0.031, 1.304, 0.179], [0, 1.4, 0]);
  // A beard round the jaw with a moustache.
  const beard = B.part('head', SLOT.hair, F.beard);
  beard.paint(WHITE, MAT.tint, 0.1).loft([rrect(1.19, 0.12, 0.13, 0.05, 0.04, 0.03), rrect(1.27, 0.2, 0.2, 0.1, 0.06, 0.02), rrect(1.36, 0.215, 0.205, 0.02, 0.05, 0.0)]);
  beard.box([0, 1.355, 0.2], [0.13, 0.03, 0.03]);

  // --- Hair ---
  /** The hair over the skull, down to the nape, with a fringe. */
  const scalp = (m: FigureMesh): void => {
    m.paint(WHITE, MAT.tint, 0.1).loft([rrect(1.5, 0.222, 0.205, 0.21, 0.06), rrect(1.6, 0.21, 0.19, 0.205, 0.07), rrect(1.69, 0.13, 0.11, 0.14, 0.05)]);
    m.loft([rrect(1.3, 0.2, -0.02, 0.19, 0.05), rrect(1.4, 0.222, -0.02, 0.215, 0.06), rrect(1.52, 0.222, -0.02, 0.215, 0.06)]);
  };
  const spiky = B.part('head', SLOT.hair, F.spiky);
  scalp(spiky);
  for (const [x, y, z, ax, ay, az, r] of [
    [0.0, 1.66, 0.08, 0.03, 1.8, 0.22, 0.08], [0.11, 1.64, 0.06, 0.2, 1.79, 0.14, 0.075], [-0.11, 1.64, 0.06, -0.19, 1.77, 0.17, 0.075],
    [0.14, 1.62, -0.06, 0.29, 1.74, -0.1, 0.08], [-0.14, 1.62, -0.06, -0.3, 1.72, -0.07, 0.08], [0.0, 1.66, -0.05, 0.02, 1.84, -0.08, 0.09],
    [0.07, 1.6, -0.15, 0.12, 1.7, -0.31, 0.08], [-0.08, 1.58, -0.15, -0.14, 1.66, -0.3, 0.08], [0.0, 1.46, -0.17, 0.0, 1.45, -0.31, 0.09],
  ] as const) {
    const n: P = [ax - x, ay - y, az - z];
    const u: P = Math.abs(n[1]) > Math.abs(n[0]) ? [1, 0, 0] : [0, 1, 0];
    const v: P = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const vl = Math.hypot(v[0], v[1], v[2]) || 1;
    const w: P = [v[0] / vl, v[1] / vl, v[2] / vl];
    spiky.cone([0, 1, 2, 3].map((k): P => {
      const a = (k / 4) * TAU, c = Math.cos(a) * r, s = Math.sin(a) * r;
      const u2: P = [n[1] * w[2] - n[2] * w[1], n[2] * w[0] - n[0] * w[2], n[0] * w[1] - n[1] * w[0]];
      const ul = Math.hypot(u2[0], u2[1], u2[2]) || 1;
      return [x + w[0] * c + (u2[0] / ul) * s, y + w[1] * c + (u2[1] / ul) * s, z + w[2] * c + (u2[2] / ul) * s];
    }), [ax, ay, az]);
  }
  for (const [x, w] of [[-0.11, 0.1], [0.0, 0.11], [0.11, 0.1]] as const) kite(spiky, [x, 1.56, 0.2], [x * 1.1 + 0.02, 1.45, 0.205], w, [0, 0, 1], 0.3, 0.012);

  for (const [feature, bun] of [[F.ponytail, false], [F.bun, true]] as const) {
    const m = B.part('head', SLOT.hair, feature);
    scalp(m);
    // Locks beside the face and a parted fringe.
    for (const s of SIDES) {
      kite(m, [0.2 * s, 1.56, 0.13], [0.215 * s, bun ? 1.2 : 1.3, 0.15], 0.13, [s, 0, 0.4], 0.4, 0.02);
      kite(m, [0.02 * s, 1.6, 0.2], [0.17 * s, 1.44, 0.2], 0.12, [0, 0, 1], 0.5, 0.012);
    }
    if (bun) {
      m.paint(WHITE, MAT.tint, 0.1).blob([0, 1.58, -0.27], [0.13, 0.12, 0.12], 21, 0.1, 6, 2);
      m.paint([0.85, 0.85, 0.85], MAT.tint, 0.1).blob([0, 1.4, -0.24], [0.11, 0.1, 0.09], 22, 0.1, 6, 2);
    }
  }
  // The ponytail in three links, one on each bone of its chain: the tie and the root, the body, the point.
  const TAIL_RINGS: P[][] = [
    [[0.06, 1.72, -0.26], [0.06, 1.62, -0.25], [-0.06, 1.62, -0.25], [-0.06, 1.72, -0.26]],
    [[0.09, 1.7, -0.4], [0.09, 1.52, -0.36], [-0.09, 1.52, -0.36], [-0.09, 1.7, -0.4]],
    [[0.05, 1.5, -0.5], [0.05, 1.38, -0.42], [-0.05, 1.38, -0.42], [-0.05, 1.5, -0.5]],
  ];
  const tail = B.part('tail', SLOT.hair, F.ponytail | F.tail);
  tail.paint([0.85, 0.85, 0.85], MAT.tint, 0.06).limb([0, 1.62, -0.19], [0, 1.66, -0.27], 0.05, 0.05, 5);
  tail.paint(WHITE, MAT.tint, 0.1).loft([TAIL_RINGS[0]!, TAIL_RINGS[1]!]);
  B.part('tail2', SLOT.hair, F.ponytail | F.tail).paint(WHITE, MAT.tint, 0.1).loft([TAIL_RINGS[1]!, TAIL_RINGS[2]!]);
  B.part('tail3', SLOT.hair, F.ponytail | F.tail).paint(WHITE, MAT.tint, 0.1).cone(TAIL_RINGS[2]!, [0, 1.3, -0.5]);

  // --- Hood: round the head, its point behind, the face open ---
  const hood = B.part('head', SLOT.cloak, F.hood);
  cloth(hood, [
    rrect(1.2, 0.22, 0.12, 0.2, 0.07),
    rrect(1.34, 0.265, 0.15, 0.25, 0.08),
    rrect(1.52, 0.27, 0.2, 0.26, 0.08),
    rrect(1.64, 0.235, 0.25, 0.25, 0.08),
    rrect(1.75, 0.14, 0.12, 0.21, 0.05, -0.03),
  ], WHITE, MAT.tint, 0.1, 0.5);
  hood.paint(WHITE, MAT.tint, 0.1).cone(rrect(1.75, 0.14, 0.12, 0.21, 0.05, -0.03), [0, 1.88, -0.16]);

  // --- The pack: a box with a lid and a pocket, the bedroll strapped on top ---
  t.paint(LEATHER, MAT.flat, 0.07).box([0, 0.86, -0.4], [0.44, 0.42, 0.26], 0.94);
  // The flap: over the top and half down the back, a strap with a buckle holding it.
  t.paint(LEATHER_LIGHT, MAT.flat, 0.05).box([0, 1.055, -0.41], [0.46, 0.07, 0.3], 0.92);
  t.loft([[[-0.21, 1.07, -0.535], [0.21, 1.07, -0.535], [0.21, 1.07, -0.555], [-0.21, 1.07, -0.555]], [[-0.19, 0.9, -0.54], [0.19, 0.9, -0.54], [0.19, 0.9, -0.565], [-0.19, 0.9, -0.565]], [[-0.1, 0.83, -0.54], [0.1, 0.83, -0.54], [0.1, 0.83, -0.565], [-0.1, 0.83, -0.565]]]);
  t.paint(LEATHER_DARK, MAT.flat, 0.04).box([0, 0.9, -0.575], [0.06, 0.34, 0.02]);
  t.paint(BRASS, MAT.flat, 0).box([0, 0.85, -0.59], [0.085, 0.07, 0.016]);
  t.paint(LEATHER_DARK, MAT.flat, 0.05);
  for (const s of SIDES) t.box([0.235 * s, 0.8, -0.4], [0.07, 0.22, 0.17]);
  // Shoulder straps over the cape's back.
  for (const s of SIDES) t.limb([0.15 * s, 1.17, -0.17], [0.17 * s, 0.98, -0.3], 0.03, 0.03, 4, 0.5);
  // The bedroll: a thick roll whose ends show the spiral of its layers.
  const RX = 0.28, RY = 1.24, RZ = -0.4, RR = 0.155;
  t.paint(ROLL, MAT.flat, 0.07).limb([-RX, RY, RZ], [RX, RY, RZ], RR, RR, 6);
  for (const s of SIDES) {
    // Rings from the rim inward, each a little proud of the last, and a step where the spiral's end lies.
    [[0.118, ROLL_DARK], [0.088, ROLL], [0.058, ROLL_DARK], [0.03, ROLL]].forEach(([rad, col], k) => {
      const x0 = (RX - 0.004 + 0.004 * k) * s, x1 = (RX + 0.004 + 0.004 * k) * s;
      t.paint(col as RGB, MAT.flat, 0).limb([x0, RY + 0.012 * k, RZ - 0.008 * k], [x1, RY + 0.012 * k, RZ - 0.008 * k], rad as number, rad as number, 6);
    });
    t.paint(ROLL_DARK, MAT.flat, 0).box([(RX + 0.01) * s, RY - 0.06, RZ + 0.115], [0.012, 0.05, 0.06]);
  }
  t.paint(LEATHER_DARK, MAT.flat, 0.05);
  for (const s of SIDES) t.box([0.14 * s, RY - 0.01, RZ], [0.04, 0.335, 0.33]);

  // --- The pole with its arm, and the lantern hanging from the arm's end ---
  for (const s of SIDES) {
    const p = B.part('torso', 0, s > 0 ? F.poleL : F.poleR);
    p.paint(WOOD, MAT.flat, 0.08).limb([0.3 * s, 0.72, -0.42], [0.3 * s, 1.9, -0.42], 0.032, 0.028, 4);
    p.limb([0.2 * s, 1.78, -0.42], [0.62 * s, 1.78, -0.42], 0.028, 0.026, 4);
    p.limb([0.3 * s, 1.6, -0.42], [0.45 * s, 1.77, -0.42], 0.02, 0.02, 4);
    p.paint(ROLL, MAT.flat, 0.05).limb([0.3 * s, 1.74, -0.42], [0.3 * s, 1.82, -0.42], 0.04, 0.04, 4);
    const l = B.part(s > 0 ? 'lampL' : 'lampR', 0, s > 0 ? F.poleL : F.poleR);
    const x = 0.56 * s, z = -0.4;
    const sq = (y: number, h: number): P[] => [[x - h, y, z - h], [x + h, y, z - h], [x + h, y, z + h], [x - h, y, z + h]];
    // A ring to hang by, a pointed cap, four posts on a foot; the panes lean out toward the cap.
    const TOP = 1.6, FOOT = 1.38, HT = 0.105, HF = 0.075;
    l.paint(IRON, MAT.flat, 0.05).limb([x, 1.76, z], [x, 1.7, z], 0.014, 0.014, 3);
    l.loft([sq(TOP, HT + 0.03), sq(TOP + 0.025, HT + 0.03)]);
    l.cone(sq(TOP + 0.025, HT + 0.012), [x, TOP + 0.12, z]);
    l.loft([sq(FOOT - 0.03, HF + 0.02), sq(FOOT, HF + 0.02)]);
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) l.limb([x + dx * HF, FOOT, z + dz * HF], [x + dx * HT, TOP, z + dz * HT], 0.017, 0.017, 4);
    // Every pane: an amber field with a lighter heart, a little proud of it.
    const mid = (FOOT + TOP) / 2, hm = (HF + HT) / 2;
    for (const [ux, uz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const at = (y: number, h: number, side: number, out = 0): P => [x + ux * (h + out) - uz * side * h, y, z + uz * (h + out) + ux * side * h];
      l.paint(GLASS, MAT.glow, 0.03).quad(at(FOOT, HF, -0.9), at(FOOT, HF, 0.9), at(TOP, HT, 0.9), at(TOP, HT, -0.9), [x, mid, z]);
      l.paint(GLASS_CORE, MAT.glow, 0);
      l.quad(at(mid - 0.07, hm - 0.012, 0, 0.006), at(mid, hm, 0.5, 0.006), at(mid + 0.075, hm + 0.012, 0, 0.006), at(mid, hm, -0.5, 0.006), [x, mid, z]);
    }
  }

  // --- A torch in the right hand: it lies along the forearm's front at rest and stands up when the arm is raised ---
  const torch = B.part('foreR', 0, F.torch);
  torch.paint(WOOD, MAT.flat, 0.08).limb([-0.42, 0.66, -0.12], [-0.42, 0.66, 0.5], 0.026, 0.03, 4);
  torch.paint(IRON, MAT.flat, 0.05).limb([-0.42, 0.66, 0.46], [-0.42, 0.66, 0.56], 0.045, 0.055, 5);
  torch.paint(FLAME, MAT.glow, 0.2).blob([-0.42, 0.66, 0.66], [0.075, 0.075, 0.12], 31, 0.18, 5, 2);
  torch.paint([1.0, 0.5, 0.1], MAT.glow, 0.1).cone([[-0.47, 0.66, 0.7], [-0.42, 0.71, 0.7], [-0.37, 0.66, 0.7], [-0.42, 0.61, 0.7]], [-0.42, 0.69, 0.92]);

  // --- Motions ---
  /** What every motion shares: the cloak in the wind, the ponytail, and the lanterns, which hang plumb whatever the body does. */
  const dress = (pose: Pose, time: number, w: number, back: number, wind: number, pitch: number): void => {
    turn(pose, id.cloak, back + wind * (0.05 * Math.sin(1.3 * time + w) + 0.025 * Math.sin(2.9 * time + 2 * w)), 0, wind * 0.04 * Math.sin(0.9 * time + 1 + w));
    turn(pose, id.tail, 0.5 * back + wind * 0.12 * Math.sin(1.7 * time + w), wind * 0.1 * Math.sin(1.1 * time + 2 * w));
    const sx = -pitch + (0.07 + 0.25 * back) * Math.sin(2.1 * time + w), sz = 0.07 * Math.sin(1.63 * time + 2 * w);
    turn(pose, id.lampL, sx, 0, sz);
    turn(pose, id.lampR, sx, 0, sz);
  };
  const stand: FigureMotion = {
    sample(pose, time, f) {
      const w = f.seed * TAU;
      const breath = Math.sin(1.7 * time + w);
      shift(pose, id.root, 0, -0.005 * (1 + breath), 0);
      turn(pose, id.torso, 0.015 + 0.012 * breath, 0.04 * Math.sin(0.23 * time + w), 0.012 * Math.sin(0.4 * time + w));
      turn(pose, id.head, 0.03 * Math.sin(0.37 * time + w) - 0.01 * breath, 0.3 * Math.sin(0.19 * time + 2 * w), 0.03 * Math.sin(0.27 * time + w));
      turn(pose, id.armL, 0.03, 0, 0.02 * breath);
      turn(pose, id.armR, 0.03, 0, -0.02 * breath);
      dress(pose, time, w, 0.03, 1, 0.02);
    },
  };
  const WALK_S = 0.8, RUN_S = 0.5;
  const walk: FigureMotion = {
    duration: WALK_S,
    strideM: 1.0,
    marks: STEPS,
    sample(pose, time, f) {
      const ph = time / WALK_S;
      stride(pose, id, ph, { swing: 0.5, knee: 0.8, arm: 0.32, elbow: 0.15, bob: 0.025, lean: 0.04, twist: 0.07 });
      dress(pose, time, f.seed * TAU, 0.08 + 0.04 * Math.sin(ph * TAU * 2), 0.6, 0.04);
    },
  };
  /** Walking with the right arm raised: the torch (feature `torch`) stands up in the hand. */
  const bear: FigureMotion = {
    duration: WALK_S,
    strideM: 1.0,
    marks: STEPS,
    sample(pose, time, f) {
      const ph = time / WALK_S;
      stride(pose, id, ph, { swing: 0.5, knee: 0.8, arm: 0.32, elbow: 0.15, bob: 0.025, lean: 0.04, twist: 0.05 });
      turn(pose, id.armR, -0.75 + 0.04 * Math.sin(ph * TAU * 2), 0, -0.25);
      turn(pose, id.foreR, -0.82);
      dress(pose, time, f.seed * TAU, 0.08 + 0.04 * Math.sin(ph * TAU * 2), 0.6, 0.04);
    },
  };
  /** Standing with the torch raised. */
  const hold: FigureMotion = {
    sample(pose, time, f) {
      stand.sample(pose, time, f);
      turn(pose, id.armR, -0.75 + 0.03 * Math.sin(1.1 * time), 0, -0.25);
      turn(pose, id.foreR, -0.82);
    },
  };
  const run: FigureMotion = {
    duration: RUN_S,
    strideM: 2.3,
    marks: STEPS,
    sample(pose, time, f) {
      const ph = time / RUN_S;
      stride(pose, id, ph, { swing: 0.95, knee: 1.5, arm: 0.95, elbow: 1.1, bob: 0.05, lean: 0.24, twist: 0.14 });
      shift(pose, id.root, 0, 0.05 * Math.abs(Math.cos(ph * TAU)) - 0.03, 0);
      dress(pose, time, f.seed * TAU, 0.42 + 0.08 * Math.sin(ph * TAU * 2), 1.2, 0.24);
    },
  };
  /**
   * In the air, after a jump or off an edge: over its first quarter second the knees come up (the left one more), the
   * arms lift out to the sides and the cloak rises. `time`: seconds since leaving the ground; the pose then holds.
   */
  const leap: FigureMotion = {
    sample(pose, time, f) {
      const k = smooth(time / 0.25);
      const w = f.seed * TAU;
      turn(pose, id.torso, 0.1 * k);
      turn(pose, id.head, -0.12 * k);
      for (const s of SIDES) {
        const L = s > 0;
        turn(pose, L ? id.legL : id.legR, (L ? -0.6 : -0.2) * k, 0, 0.06 * s * k);
        turn(pose, L ? id.shinL : id.shinR, (L ? 0.95 : 0.55) * k);
        turn(pose, L ? id.footL : id.footR, (L ? -0.25 : -0.15) * k);
        turn(pose, L ? id.armL : id.armR, -0.3 * k, 0, 0.6 * s * k);
        turn(pose, L ? id.foreL : id.foreR, -0.45 * k);
      }
      dress(pose, time, w, 0.03 + 0.3 * k, 1.4, 0.1 * k);
    },
  };
  /** Seated: the figure's place is the seat (the saddle anchor of a mount). */
  const ride: FigureMotion = {
    sample(pose, time, f) {
      const w = f.seed * TAU;
      const lean = 0.22 + 0.03 * Math.sin(1.1 * time + w);
      shift(pose, id.root, 0, -0.56 + 0.1, 0);
      turn(pose, id.torso, lean, 0.03 * Math.sin(0.5 * time + w));
      turn(pose, id.head, -0.18, 0.15 * Math.sin(0.3 * time + w));
      for (const s of SIDES) {
        const L = s > 0;
        turn(pose, L ? id.legL : id.legR, -1.25, 0, 0.55 * s);
        turn(pose, L ? id.shinL : id.shinR, 1.2);
        turn(pose, L ? id.armL : id.armR, -0.8, 0, -0.2 * s);
        turn(pose, L ? id.foreL : id.foreR, -0.5);
      }
      // The cloak streams behind in the wind of the flight.
      turn(pose, id.cloak, 0.75 + 0.07 * Math.sin(6.1 * time + w) + 0.04 * Math.sin(9.7 * time), 0, 0.05 * Math.sin(4.3 * time + w));
      turn(pose, id.tail, 0.7 + 0.15 * Math.sin(7.3 * time + w), 0.1 * Math.sin(5.1 * time));
      const sx = -lean + 0.35 + 0.1 * Math.sin(3.7 * time + w);
      turn(pose, id.lampL, sx, 0, 0.08 * Math.sin(2.3 * time));
      turn(pose, id.lampR, sx, 0, 0.08 * Math.sin(2.3 * time));
    },
  };

  /**
   * Seated on the ground, knees drawn up, the arms over them, looking ahead: the figure's place is the ground under
   * its seat. `param` 0–1 stretches the legs out and leans the body back on its pack. Every rhythm passes a whole
   * number of times in `SIT_LOOP_S`, so a scene that plays in a circle of that length has no seam; the
   * head turns `look` radians to its left at its far point (the seed's sign chooses the side it favours).
   */
  const sit: FigureMotion = {
    duration: SIT_LOOP_S,
    sample(pose, time, f) {
      const w = f.seed * TAU;
      const out = Math.min(1, Math.max(0, f.param));
      /** A sine that passes `n` times in the loop. */
      const s = (n: number, phase = 0): number => Math.sin((TAU * n * time) / SIT_LOOP_S + phase);
      const breath = s(14, w);
      const lean = 0.2 - 0.36 * out + 0.012 * breath + 0.012 * s(3, 2 * w);
      shift(pose, id.root, 0, -0.56 + 0.15 - 0.004 * (1 + breath), 0);
      turn(pose, id.torso, lean, 0.03 * s(2, w), 0.012 * s(3, w + 1));
      // The head looks out over the water, wanders slowly and now and then turns to the side for a while.
      const glance = Math.max(0, s(1, 3 * w) - 0.72) / 0.28;
      const side = f.seed < 0.5 ? 1 : -1;
      turn(pose, id.head, -0.5 * lean - 0.04 + 0.03 * s(4, w) - 0.01 * breath, 0.14 * s(2, 2 * w) + 0.05 * s(5, w) + side * 0.5 * glance * glance * (3 - 2 * glance), 0.02 * s(3, w));
      for (const sd of SIDES) {
        const L = sd > 0;
        const ph = L ? 0 : 1.3;
        // Knees up (the heels dug in) or the legs out, the far one a little more than the near one.
        const thigh = -2.02 + (0.55 + 0.1 * sd) * out + 0.012 * s(2, w + ph);
        turn(pose, L ? id.legL : id.legR, thigh, 0, (0.2 + 0.1 * out) * sd);
        turn(pose, L ? id.shinL : id.shinR, 1.5 - (1.2 + 0.1 * sd) * out + 0.02 * s(3, w + ph));
        // The arms reach forward over the knees; leaning back they prop the body behind it.
        turn(pose, L ? id.armL : id.armR, -1.0 + 1.55 * out - lean + 0.02 * breath, 0, (-0.12 - 0.3 * out) * sd);
        turn(pose, L ? id.foreL : id.foreR, -0.55 + 0.45 * out + 0.03 * s(4, w + ph));
      }
      // The cloak spreads on the ground behind; a light wind moves it and the lantern on its pole.
      turn(pose, id.cloak, 0.1 - 0.5 * lean + 0.03 * s(9, w) + 0.015 * s(22, 2 * w), 0, 0.025 * s(7, w + 1));
      turn(pose, id.tail, 0.05 + 0.08 * s(13, w), 0.06 * s(8, 2 * w));
      const sx = -lean + 0.07 * s(17, w), sz = 0.05 * s(13, 2 * w);
      turn(pose, id.lampL, sx, 0, sz);
      turn(pose, id.lampR, sx, 0, sz);
    },
  };

  // --- Additive motions of the whole body, weighted by its acceleration ---
  /** Leaning into a start: the trunk forward, the head kept level, the arms driving. */
  const push: FigureMotion = {
    sample(pose) {
      turn(pose, id.torso, 0.2);
      turn(pose, id.head, -0.13);
      turn(pose, id.armL, -0.25, 0, 0.05);
      turn(pose, id.armR, 0.25, 0, -0.05);
      turn(pose, id.cloak, 0.12);
    },
  };
  /** Braced against a stop: the trunk back, the knees bent, the legs ahead of the body, the arms out for balance. */
  const brace: FigureMotion = {
    sample(pose) {
      // The knees bend; the ground fit lowers the hips until the feet reach the ground again.
      turn(pose, id.torso, -0.2);
      turn(pose, id.head, 0.14);
      for (const s of SIDES) {
        const L = s > 0;
        turn(pose, L ? id.legL : id.legR, -0.22, 0, 0.04 * s);
        turn(pose, L ? id.shinL : id.shinR, 0.3);
        turn(pose, L ? id.armL : id.armR, -0.45, 0, 0.2 * s);
        turn(pose, L ? id.foreL : id.foreR, -0.3);
      }
      turn(pose, id.cloak, -0.25);
      turn(pose, id.lampL, 0.2);
      turn(pose, id.lampR, 0.2);
    },
  };

  // --- Motions of the upper body (for a layer masked to the arms) ---
  /** The right arm raised high, the forearm waving from side to side; one wave a pass. */
  const wave: FigureMotion = {
    duration: WAVE_S,
    sample(pose, time) {
      const a = Math.sin((time / WAVE_S) * TAU);
      turn(pose, id.armR, -0.3, 0, -2.45 + 0.05 * a);
      turn(pose, id.foreR, -0.3, 0, 0.55 * a);
      turn(pose, id.armL, 0.03, 0, 0.03);
    },
  };
  /** The right arm held forward, the forearm a little raised: a hand that gives (the reach puts it on its target). */
  const offer: FigureMotion = {
    sample(pose, time) {
      turn(pose, id.armR, -1.05 + 0.01 * Math.sin(1.3 * time), 0, 0.15);
      turn(pose, id.foreR, -0.55);
    },
  };
  /** The right arm forward and lower, the hand open below the other's: a hand that takes. */
  const take: FigureMotion = {
    sample(pose, time) {
      turn(pose, id.armR, -0.85 + 0.01 * Math.sin(1.1 * time), 0, 0.2);
      turn(pose, id.foreR, -0.8);
    },
  };
  /** Both forearms raised in front of the chest, the hands holding something open between them. */
  const read: FigureMotion = {
    sample(pose, time) {
      const b = 0.01 * Math.sin(1.7 * time);
      for (const s of SIDES) {
        const L = s > 0;
        turn(pose, L ? id.armL : id.armR, -0.55 + b, 0, -0.3 * s);
        turn(pose, L ? id.foreL : id.foreR, -1.45 + b, 0.2 * s);
      }
    },
  };
  /**
   * From standing (k = 0) to the seat of `sit` (k = 1): the knees draw up, the body leans forward on the way down and
   * settles; `drop` lowers the pelvis.
   */
  const seat = (pose: Pose, time: number, f: { seed: number }, k: number, drop: number): void => {
    const w = f.seed * TAU;
    shift(pose, id.root, 0, -0.41 * drop, 0);
    turn(pose, id.torso, mix(0.015, 0.2, k) + 0.4 * Math.sin(Math.PI * Math.min(1, Math.max(0, drop))));
    turn(pose, id.head, mix(0, -0.14, k) - 0.2 * Math.sin(Math.PI * Math.min(1, Math.max(0, drop))));
    for (const sd of SIDES) {
      const L = sd > 0;
      turn(pose, L ? id.legL : id.legR, mix(0, -2.02, k), 0, mix(0, 0.2, k) * sd);
      turn(pose, L ? id.shinL : id.shinR, mix(0, 1.5, k));
      turn(pose, L ? id.armL : id.armR, mix(0.03, -1.2, k) - 0.3 * Math.sin(Math.PI * k), 0, mix(0, -0.12, k) * sd);
      turn(pose, L ? id.foreL : id.foreR, mix(0, -0.55, k));
    }
    dress(pose, time, w, mix(0.03, 0.0, k), 1, 0.02);
  };
  /** Sitting down on the ground in `SIT_DOWN_S`: the knees bend first, then the pelvis goes down; holds the end. */
  const sitDown: FigureMotion = {
    duration: SIT_DOWN_S,
    loop: false,
    sample(pose, time, f) {
      const t = time / SIT_DOWN_S;
      seat(pose, time, f, smooth(t / 0.8), smooth((t - 0.15) / 0.85));
    },
  };
  /** Standing up from `sit` in `STAND_UP_S`: leaning forward, the pelvis rises, the legs straighten; holds the end. */
  const standUp: FigureMotion = {
    duration: STAND_UP_S,
    loop: false,
    sample(pose, time, f) {
      const t = time / STAND_UP_S;
      seat(pose, time, f, 1 - smooth((t - 0.1) / 0.9), 1 - smooth(t / 0.85));
    },
  };

  // --- Things held: a small box, and a book whose front half turns about the spine ---
  const box = new FigureMesh(901);
  box.paint(WOOD, MAT.flat, 0.08).box([0, 0, 0], [0.2, 0.15, 0.17]);
  box.paint(LEATHER_DARK, MAT.flat, 0.04).box([0, 0, 0], [0.205, 0.04, 0.175]);
  box.paint(BRASS, MAT.flat, 0).box([0, 0, 0.088], [0.04, 0.05, 0.008]);
  // The book in the frame of its socket: the spine along y at x = 0, each half to +x when closed, its pages on the
  // half's side toward −z; the front half (the reader's side) turns about the y axis through (0, 0, −BOOK_HINGE_Z).
  const bookBack = new FigureMesh(902);
  bookBack.paint(rgb('#7a2f2a'), MAT.flat, 0.05).box([0.08, 0, 0.006], [0.165, 0.23, 0.012]);
  bookBack.paint(rgb('#efe6cf'), MAT.flat, 0.03).box([0.077, 0, -0.008], [0.152, 0.215, 0.016]);
  const bookFront = new FigureMesh(903);
  bookFront.paint(rgb('#efe6cf'), MAT.flat, 0.03).box([0.077, 0, -0.024], [0.152, 0.215, 0.016]);
  bookFront.paint(rgb('#7a2f2a'), MAT.flat, 0.05).box([0.08, 0, -0.038], [0.165, 0.23, 0.012]);
  bookFront.paint(BRASS, MAT.flat, 0).box([0.15, 0, -0.045], [0.02, 0.05, 0.004]);

  /** A socket at a rest point of a bone, turned about x by `ax` and then about y by `ay`. */
  const socket = (bone: Bone, at: P, ax = 0, ay = 0): { bone: number; local: number[] } => {
    const p = B.local(bone, at);
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
    // Columns of Rx(ax) · Ry(ay).
    return { bone: p.bone, local: [cy, sx * sy, -cx * sy, 0, cx, sx, sy, -sx * cy, cx * cy, p.at[0], p.at[1], p.at[2]] };
  };

  // --- Looks ---
  const CLOAKS = ['#a9402f', '#ecdcb4', '#6f7f3a', '#dca638', '#3f6f96', '#7a3a52', '#3f8c84', '#c9682c'].map(rgb);
  const TRIMS = ['#ecd7a8', '#3f8c84', '#dba032', '#7a2a3a', '#e8d3a4', '#e0b040', '#ecdcb4', '#f0e0b8'].map(rgb);
  const HAIRS = ['#3b2a26', '#e8cf9c', '#6b4a2e', '#a8532e', '#22201f', '#c98a3c', '#8a8580'].map(rgb);
  const SKINS = ['#e3ac7e', '#edbd92', '#c98e62', '#a8714c'].map(rgb);
  const dark = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
  const glyphBit = (i: number): number => F.glyph << (((i % GLYPHS.length) + GLYPHS.length) % GLYPHS.length);
  const SHEET: FigureLook[] = [
    { colors: [CLOAKS[0]!, TRIMS[0]!, HAIRS[0]!, SKINS[0]!, dark(CLOAKS[0]!, 0.95)], features: F.collar | F.spiky | F.poleL | glyphBit(4) },
    { colors: [CLOAKS[1]!, TRIMS[1]!, HAIRS[1]!, SKINS[1]!, CLOAKS[1]!], features: F.collar | F.ponytail | F.poleL | glyphBit(0) },
    { colors: [CLOAKS[2]!, TRIMS[2]!, HAIRS[2]!, SKINS[0]!, TRIMS[2]!], features: F.hood | F.scarf | F.beard | F.poleL | glyphBit(5) },
    { colors: [CLOAKS[3]!, TRIMS[3]!, HAIRS[3]!, SKINS[1]!, TRIMS[3]!], features: F.scarf | F.bun | F.poleL | glyphBit(3) },
  ];
  const looks = new Map<number, FigureLook>();
  /**
   * Variants 0–3: the sheet's four. Bit 2 and up of a larger number are a seed for a combination of its own; adding
   * `PATHFINDER_TORCH` to any variant puts a torch in the hand, `PATHFINDER_MIRROR` the pole on the other side,
   * `PATHFINDER_TAIL` a ponytail behind whatever hair it has.
   */
  const look = (variant: number): FigureLook => {
    let l = looks.get(variant);
    if (l) return l;
    const v = Math.trunc(Math.abs(variant));
    const base = v % PATHFINDER_TORCH;
    const pick = (k: number, n: number): number => Math.floor(unit(hashInts(7411, base, k)) * n) % n;
    let made: FigureLook;
    if (base < 4) made = SHEET[base]!;
    else {
      const c = pick(0, CLOAKS.length);
      const cloak = CLOAKS[c]!, trim = TRIMS[(c + (pick(1, 3) === 0 ? 1 + pick(2, 3) : 0)) % TRIMS.length]!;
      const neck = [F.collar, F.scarf, F.hood | F.scarf, F.collar][pick(3, 4)]!;
      const hooded = (neck & F.hood) !== 0;
      const hair = hooded ? (pick(4, 2) ? F.beard : 0) : [F.spiky, F.ponytail, F.bun][pick(4, 3)]!;
      const beard = !hooded && hair === F.spiky && pick(5, 4) === 0 ? F.beard : 0;
      const neckColor = (neck & F.scarf) !== 0 ? trim : pick(6, 2) ? dark(cloak, 0.95) : cloak;
      made = { colors: [cloak, trim, HAIRS[pick(7, HAIRS.length)]!, SKINS[pick(8, SKINS.length)]!, neckColor], features: neck | hair | beard | F.poleL | glyphBit(pick(9, GLYPHS.length)) };
    }
    let features = made.features;
    if (Math.floor(v / PATHFINDER_MIRROR) & 1) features = (features & ~F.poleL) | F.poleR;
    if (Math.floor(v / PATHFINDER_TORCH) & 1) features |= F.torch;
    if (Math.floor(v / PATHFINDER_TAIL) & 1) features |= F.tail;
    looks.set(variant, (l = { colors: made.colors, features }));
    return l;
  };

  /**
   * Swimming under water: the figure's `up` is the way it swims (head first) and its `forward` the side its chest
   * faces. The arms take turns reaching past the head, the legs kick, the cloak trails along the body.
   */
  const SWIM_S = 2.4;
  const swim: FigureMotion = {
    duration: SWIM_S,
    sample(pose, time, f) {
      const w = f.seed * TAU;
      const a = (time / SWIM_S) * TAU + w;
      turn(pose, id.torso, 0.06 * Math.sin(a), 0.1 * Math.sin(a), 0.05 * Math.sin(a));
      turn(pose, id.head, -0.85 + 0.06 * Math.sin(a + 1), 0.12 * Math.sin(0.5 * a));
      for (const s of SIDES) {
        const L = s > 0;
        // The stroke: from reaching ahead (the arm straight up past the head) down to the hip and back.
        const reach = 0.5 + 0.5 * Math.sin(a + (L ? 0 : Math.PI));
        turn(pose, L ? id.armL : id.armR, -2.75 + 2.3 * (1 - reach), 0, -0.12 * s * reach);
        turn(pose, L ? id.foreL : id.foreR, -0.25 - 0.5 * Math.sin(Math.PI * reach));
        const kick = Math.sin(3 * a + (L ? 0 : Math.PI));
        turn(pose, L ? id.legL : id.legR, 0.1 + 0.3 * kick, 0, 0.06 * s);
        turn(pose, L ? id.shinL : id.shinR, 0.3 + 0.28 * Math.sin(3 * a + (L ? 0 : Math.PI) - 1.1));
      }
      dress(pose, time, w, 0.1, 1.6, 0);
    },
  };

  return {
    name: 'pathfinder',
    skeleton: B.skeleton,
    parts: B.parts(),
    motions: { stand, walk, run, bear, hold, ride, swim, sit, leap, wave, offer, take, read, sitDown, standUp, push, brace },
    anchors: { lantern: B.local('lampL', [0.56, 1.53, -0.4]), head: B.local('head', [0, 1.7, 0]), torch: B.local('foreR', [-0.42, 0.66, 0.7]) },
    look,
    heightM: 1.72,
    capacity: 32,
    shadowRangeM: 160,
    legs: {
      chains: [
        { upper: id.legL, lower: id.shinL, end: id.footL },
        { upper: id.legR, lower: id.shinR, end: id.footR },
      ],
      pelvis: id.root,
    },
    arms: {
      left: { chain: { upper: id.armL, lower: id.foreL, end: id.handL, bend: [-1, 0, 0] }, pole: [0.75, 0.75, -0.55] },
      right: { chain: { upper: id.armR, lower: id.foreR, end: id.handR, bend: [-1, 0, 0] }, pole: [-0.75, 0.75, -0.55] },
    },
    gaze: { bones: [id.torso, id.head], shares: [0.25, 0.75], eye: B.local('head', [0, 1.43, 0.19]).at, maxYaw: 80 * (Math.PI / 180), maxUp: 35 * (Math.PI / 180), maxDown: 55 * (Math.PI / 180) },
    // The ponytail: stiff enough to keep its shape, swinging a few times after a stop; a little gravity.
    lag: [{ bones: [id.tail, id.tail2, id.tail3], end: [0, -0.14, -0.04], stiffness: 90, damping: 7, gravity: 0.25, maxAngle: 1.0 }],
    sockets: {
      handL: socket('handL', [0.42, 0.575, 0.07]),
      handR: socket('handR', [-0.42, 0.575, 0.07]),
      read: socket('torso', [0, 1.1, 0.45], 0.75),
      pocket: socket('torso', [-0.3, 0.86, -0.3], 0, Math.PI / 2),
      belt: socket('torso', [-0.33, 0.66, 0.14], 0, 0.5),
    },
    props: { box: box.mesh(), bookBack: bookBack.mesh(), bookFront: bookFront.mesh() },
  };
}

/** Seconds of one wave of the pathfinder's motion `wave`. */
export const WAVE_S = 0.6;
/** Seconds of the pathfinder's `sitDown` and `standUp`. */
export const SIT_DOWN_S = 1.3;
export const STAND_UP_S = 1.1;
/** Where the front half of the pathfinder's book turns: the y axis through (0, 0, −BOOK_HINGE_Z) of its socket. */
export const BOOK_HINGE_Z = 0.016;

/** Seconds after which the pathfinder's motion `sit` repeats exactly. */
export const SIT_LOOP_S = 60;
/** Added to a pathfinder's variant: a torch in the right hand (use the motions `bear` and `hold`). */
export const PATHFINDER_TORCH = 4096;
/** Added to a pathfinder's variant: the pole and its lantern on the right side instead of the left. */
export const PATHFINDER_MIRROR = 8192;
/** Added to a pathfinder's variant: a ponytail (on the lagging chain of `lag`) behind whatever hair the look has. */
export const PATHFINDER_TAIL = 16384;

export const PATHFINDERS = { pathfinder } as const;
