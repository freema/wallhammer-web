// The glider: a huge flying animal with the build of a ray. A fat, rounded body like a whale's (it rises as a dome
// behind the head, highest under the seat, and tapers into one tail base) that runs without a neck into a big broad
// blunt head with a dark glossy eye on each side under a lid that blinks, two nostrils, and a wide mouth whose pale lower
// jaw opens on a dark cavity with a broad pink tongue; two long swept wings, each one
// thick fleshy fin that leaves the flank as a broad shoulder, arches out to a fat four-toed paw on its leading edge and
// runs on into a long tapering outer fin with a pointed tip; two short thick pelvic fins under the hips with smaller
// paws of the same kind; one tapering tail base that forks into two long whip filaments, lilac to pink toward their
// tips. A deep indigo back with soft darker bands across it over a pale lilac belly; the wings lilac to pink, with
// light and dark bands that run out from the flank to the scalloped trailing edge and a pink rim along it. Saddled
// with a rug of diamonds with a fringe, a rope harness with a halter round the head and reins, a lantern hung under the
// chin, a bedroll and two bags behind the seat.
//
// Shapes are written in the rest pose at half the size and come out `GLIDER_SIZE` times as big (the skeleton's
// `size`): x to the animal's left, y up, z forward, the root on the ground under the middle of the body. The rest pose is
// the wings spread in a glide: 16 m from tip to tip; the body 7.1 m long (8.1 m from the nose to the fork of the tails),
// 3.2 m wide, its back 2.4 m above the ground and its belly 0.43 m; each tail filament another 5.8 m.
//
// Bones. The trunk is four (`body` under the rug carries `chest`, with the head and the wings, and `hips`, with the
// pelvic fins and the tail base). A wing is six bones: `arm` from the shoulder to the elbow, `fore` from the elbow to
// the wrist, `wrist` to the paw, the `paw`, the `tip` out from the paw to the wing's point along the outer fin, and `fin`
// on the flank, which carries the inner trailing part of the fin (it lags the arm in the beat and lies the fin down
// behind the arm on the ground). On the ground the wings are the front legs of the four-legged gait (quad-gait.ts,
// `GliderKind.steps`): the paw is put on the ground out to the side and a little ahead, the elbow turned toward a pole
// a little above and ahead of the shoulder, so each wing is a broad low arch down to its paw; the fin and the point
// lie back low behind it. The pelvic fins are the hind legs of the gait. The tail base is three bones (`stem`), each
// filament eight bones that lag behind (`lag`). The face is five bones on the head: the `jaw` hinged at the corners of
// the mouth, the `tongue` and its `tongueTip` on the jaw, and a `lid` over each eye (a cap of a sphere about the eye
// that turns down over it), all posed by `face`.
//
// A wing has no rigid part but its paw: the whole fin is a closed skin of triangles whose corners follow several bones
// at once (`GliderKind.membrane`, drawn by membrane.ts), a cambered top and a fuller underside over a patch spanned
// between the flank, the leading edge and the trailing edge; its rows run along the bands, from the flank out to the
// rim. Each corner is weighted by where it lies along the span and across the chord (`buildMembrane`). The tail is
// part of the same skin: the base and the two filaments are tubes whose rings sit on the joints and follow the bones on
// both sides of each, so they bend without steps or gaps.
//
// Motions: on the ground `stand`, `walk`, `trot`, `gallop` (the gait's; the walk and trot are a crawl on the four
// paws, the chest shifting over the planted fin, the gallop a bounding crawl) move the trunk, head, tails, lantern and
// the wings' fins and points. In the air `fly` poses the wings from the state of a flying body: the beat (a deep power
// stroke and a recovery with the outer fin unloaded and twisted, running out along the span), the flare, the bank and
// the roll into and out of it, the climb, the sweep of fast flight, and the moments after a leap (`launch`: the first
// strokes thrown deep on the body's own beat, the tails whipped down) and before a touch-down (`land`: the wings swept
// forward and cupped, the paws reaching down). `crouch` loads the body before a leap. `face` opens the mouth, puts the
// tongue out and closes the lids (`GliderFace`; glider-gait.ts times it).
//
// Sockets: `seat` (on the rug), `gripL` and `gripR` (the reins' handles), `stirrupL` and `stirrupR` (where a rider's
// feet rest on the back). Looks: three colourings (indigo with lilac-pink wings, blue with rose wings, plum with
// lavender wings).

import { hashInts, unit } from 'wallhammer-web/gen-core';
import type { StepPattern } from 'wallhammer-web/motion';
import { Bones, TAU, shift, smooth, turn } from './kind.ts';
import type { FigureKind, FigureLook, FigureMotion } from './kind.ts';
import { FigureMesh, MAT, add, cross, lerp, mul, norm, ringOn, rgb, sub } from './mesh.ts';
import type { FaceTone, P, RGB } from './mesh.ts';
import type { SteedLeg, SteedSpeeds, SteedSteps } from './steed.ts';
import { gaitBands } from './steed.ts';

type Side = 'L' | 'R';
type TailN = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type Bone =
  | 'root' | 'body' | 'chest' | 'hips' | 'head' | 'lantern' | 'stem1' | 'stem2' | 'stem3'
  | 'jaw' | 'tongue' | 'tongueTip' | `lid${Side}`
  | `arm${Side}` | `fore${Side}` | `wrist${Side}` | `paw${Side}` | `tip${Side}` | `fin${Side}`
  | `thigh${Side}` | `shin${Side}` | `ankle${Side}` | `foot${Side}`
  | `tail${Side}${TailN}`;

/** The glider's size against the shapes as written (every length below is multiplied by it). */
export const GLIDER_SIZE = 2;
const K = GLIDER_SIZE;

/** Colour slots of a look: the back, the wings, the rug. */
const SLOT = { back: 0, wing: 1, rug: 2, trim: 3 } as const;

const WHITE: RGB = [1, 1, 1];
const BELLY = rgb('#b9a6d9');
const JAW = rgb('#d2c4ea');
const EYE = rgb('#0e0a1e');
const EYE_RIM = rgb('#241a46');
const EYE_SHINE = rgb('#ffffff');
const SMILE = rgb('#2a1638');
const MOUTH = rgb('#40132f');
const GUM = rgb('#7c2a4c');
const TONGUE = rgb('#f27aa6');
const TONGUE_DARK = rgb('#d95c8f');
const NOSTRIL = rgb('#170f33');
const CHEEK = rgb('#d985c0');
const CLAW = rgb('#e6dccd');
const TAIL_PINK = rgb('#ee5fae');
const TAIL_LILAC = rgb('#7a4cc8');
const ROPE = rgb('#cfa86c');
const ROPE_DARK = rgb('#8d6a3f');
const RUG_LIGHT = rgb('#f2d79c');
const RUG_DARK = rgb('#3c2233');
const TASSEL = rgb('#e3a33c');
const BEDROLL = rgb('#a2543a');
const BEDROLL_DARK = rgb('#6a3324');
const LEATHER = rgb('#7a6a3a');
const LEATHER_DARK = rgb('#4f4325');
const IRON = rgb('#3a2a21');
const BRASS = rgb('#c99a45');
const GLASS: RGB = [0.56, 0.27, 0.04];
const GLASS_CORE: RGB = [0.8, 0.62, 0.3];
/** The underside of the wings against their top (the membrane's tint times this). */
export const MEMBRANE_UNDER: RGB = [1.18, 1.12, 1.2];

/** The glider's ground speeds (m/s) its crawl patterns belong to: a slow crawl, a fast crawl, a bound. */
export const GLIDER_SPEEDS: Readonly<SteedSpeeds> = { walk: 1.0, trot: 2.3, gallop: 4.6 };

/** Ways of stepping on the ground (legs in the order left wing, right wing, hind left, hind right). */
const GLIDER_STEPS: readonly StepPattern[] = [
  // A slow crawl: one paw at a time (hind left, left wing, hind right, right wing); the wings' paws lifted low.
  { speed: GLIDER_SPEEDS.walk, stride: 1.05 * K, offsets: [0.25, 0.75, 0, 0.5], duty: 0.7, lift: [0.13 * K, 0.13 * K, 0.06 * K, 0.06 * K] },
  // A fast crawl: each wing with the hind leg of the other side.
  { speed: GLIDER_SPEEDS.trot, stride: 1.6 * K, offsets: [0, 0.5, 0.5, 0], duty: 0.56, lift: [0.16 * K, 0.16 * K, 0.08 * K, 0.08 * K] },
  // A bound: both wings, then both hind legs.
  { speed: GLIDER_SPEEDS.gallop, stride: 2.4 * K, offsets: [0, 0.06, 0.5, 0.56], duty: 0.4, lift: [0.22 * K, 0.22 * K, 0.1 * K, 0.1 * K] },
];
/** Fewest passes a second of the crawl while a paw has to move: a heavy animal's slow cadence. */
const GLIDER_MIN_RATE = 0.5;

/** What the `fly` motion of the kind reads: a flying body's drawn state. */
export interface GliderFlight {
  /** The beats' cycle, 0–1 (0 the top of the stroke, 0.5 the bottom). */
  phase: number;
  /** Effort of the beats, 0–1. */
  effort: number;
  /** The flare before a touch-down, 0–1. */
  flare: number;
  /** Bank, radians (right side down +). */
  bank: number;
  /** How fast the bank changes, about −1 to 1 (+: rolling to the right); 0 in a steady bank. */
  roll: number;
  /** Climb (+) or dive (−) of the path, about −1 to 1. */
  climb: number;
  /** Seconds, for the idle ripples of the wings and the tails. */
  time: number;
  /** Seconds since the paws left the ground (large: long ago). */
  launch: number;
  /** The approach to a touch-down, 0–1. */
  land: number;
  /** How fast it flies, 0 (a cruise or slower) to 1 (its fast flight): the wings swept back and flattened. */
  fast: number;
}

/** The face of a frame, for the kind's `face`. */
export interface GliderFace {
  /** How far the lower jaw is open, 0 (shut) to 1 (a yawn). */
  open: number;
  /** How far the tongue is out, 0 (lying in the mouth) to 1. */
  tongue: number;
  /** The tongue swept to its left (+) or right (−), −1 to 1. */
  tongueSide: number;
  /** The tongue's tip curled up (+) or hanging down over the lip (−), −1 to 1. */
  tongueCurl: number;
  /** The lids over the eyes, 0 (open) to 1 (shut). */
  lids: number;
}

/** The skin of the wings and the tail (`GliderKind.membrane`): corners that follow bones and triangles between them. */
export interface GliderMembrane {
  /** Per corner its influences: bone index, weight, and the corner in the bone's frame (5 numbers each). */
  readonly corners: readonly (readonly number[])[];
  /** Three corner indices and a tone (index into the look's `wing` tones) per triangle, wound so that its top faces up in the rest pose. */
  readonly triangles: readonly number[];
  /**
   * Tones of a look: of the wings the inner, base, light band, dark band, rim, outer light, outer dark, leading edge,
   * underside, the soft edge of a band, and of an outer band; then of the tail the back, the belly and eight steps
   * along a filament.
   */
  tones(variant: number): readonly RGB[];
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const clamp1 = (t: number): number => (t < -1 ? -1 : t > 1 ? 1 : t);
const mixN = (a: number, b: number, t: number): number => a + (b - a) * t;
const step01 = (a: number, b: number, x: number): number => smooth((x - a) / (b - a));
const TAILS: readonly TailN[] = [1, 2, 3, 4, 5, 6, 7, 8];
const STEMS = ['stem1', 'stem2', 'stem3'] as const;

function glider(): FigureKind & {
  readonly steps: SteedSteps;
  readonly membrane: GliderMembrane;
  fly(pose: Parameters<FigureMotion['sample']>[0], s: GliderFlight): void;
  crouch(pose: Parameters<FigureMotion['sample']>[0], c: number): void;
  face(pose: Parameters<FigureMotion['sample']>[0], f: Readonly<GliderFace>): void;
} {
  // --- Skeleton -------------------------------------------------------------------------------------------------------
  /** The wing's joints on side `s` (+1 left): shoulder, elbow, wrist, paw, the wing's point. */
  const wing = (s: number): P[] => [[0.62 * s, 0.56, 0.88], [1.74 * s, 0.58, 0.72], [2.66 * s, 0.58, 0.46], [2.93 * s, 0.575, 0.33], [4.0 * s, 0.67, -1.5]];
  /** The fin bone's pivot on the flank (it carries the inner trailing part of the fin). */
  const finAt = (s: number): P => [0.6 * s, 0.55, -0.05];
  /** The pelvic fin's joints on side `s`: hip, knee, ankle, ball of the paw. */
  const hind = (s: number): P[] => [[0.28 * s, 0.42, -0.98], [0.6 * s, 0.27, -0.86], [0.64 * s, 0.14, -1.14], [0.64 * s, 0.09, -1.03]];
  /** The tail base's joints (one tapering stem) and the fork. */
  const STEM_AT: readonly P[] = [[0, 0.5, -1.3], [0, 0.5, -1.55], [0, 0.5, -1.8]];
  const FORK_Z = -2.02;
  const TAIL_N = TAILS.length, TAIL_LINK = 0.36;
  const tailAt = (s: number, k: number): P => [(0.035 + 0.02 * k) * s, 0.5, FORK_Z - TAIL_LINK * k];
  const sideBones = (S: Side, s: number): (readonly [Bone, Bone, P])[] => {
    const w = wing(s), h = hind(s);
    const out: (readonly [Bone, Bone, P])[] = [
      [`arm${S}`, 'chest', w[0]!],
      [`fore${S}`, `arm${S}`, w[1]!],
      [`wrist${S}`, `fore${S}`, w[2]!],
      [`paw${S}`, `wrist${S}`, w[3]!],
      [`tip${S}`, `paw${S}`, w[3]!],
      [`fin${S}`, 'body', finAt(s)],
      [`thigh${S}`, 'hips', h[0]!],
      [`shin${S}`, `thigh${S}`, h[1]!],
      [`ankle${S}`, `shin${S}`, h[2]!],
      [`foot${S}`, `ankle${S}`, h[3]!],
    ];
    TAILS.forEach((n, k) => out.push([`tail${S}${n}`, k === 0 ? 'stem3' : `tail${S}${TAILS[k - 1]!}`, tailAt(s, k)]));
    return out;
  };

  // --- Trunk and head profile -----------------------------------------------------------------------------------------
  /** The trunk's and the head's profile: z, centre height, half width, half height. One rounded body, no neck. */
  const TRUNK: readonly (readonly [number, number, number, number])[] = [
    [-1.5, 0.5, 0.1, 0.09],
    [-1.3, 0.5, 0.19, 0.15],
    [-1.0, 0.51, 0.36, 0.25],
    [-0.62, 0.55, 0.54, 0.4],
    [-0.2, 0.585, 0.7, 0.53],
    [0.25, 0.6, 0.78, 0.6],
    [0.62, 0.59, 0.79, 0.58],
    [0.95, 0.565, 0.77, 0.48],
    [1.22, 0.545, 0.77, 0.43],
    [1.48, 0.535, 0.76, 0.42],
    [1.68, 0.525, 0.69, 0.39],
    [1.84, 0.515, 0.58, 0.34],
    [1.95, 0.505, 0.42, 0.26],
    [2.02, 0.5, 0.22, 0.15],
    [2.05, 0.495, 0.04, 0.04],
  ];
  const prof = (z: number): [number, number, number] => {
    let k = 0;
    while (k + 2 < TRUNK.length && TRUNK[k + 1]![0] < z) k++;
    const A = TRUNK[k]!, C = TRUNK[k + 1]!;
    const t = clamp01((z - A[0]) / (C[0] - A[0]));
    // Eased between stations, so the outline is round rather than polygonal.
    const e = t * t * (3 - 2 * t) * 0.5 + t * 0.5;
    return [mixN(A[1], C[1], e), mixN(A[2], C[2], e), mixN(A[3], C[3], e)];
  };
  /** A point of the skin at `z`, at the angle `a` round it (0 the left side, π/2 the top): domed above, a rounded belly. */
  const across = (z: number, a: number, grow = 1): P => {
    const [yc, hw, hh] = prof(z);
    const c = Math.cos(a), s = Math.sin(a);
    const x = Math.sign(c) * Math.abs(c) ** 0.82 * hw * grow;
    const y = s >= 0 ? yc + s ** 0.92 * hh * grow : yc - Math.abs(s) ** 0.9 * hh * 0.64 * grow;
    return [x, y, z];
  };
  const topY = (z: number): number => across(z, Math.PI / 2)[1];
  /** Where the fin leaves the flank at `z` (left side), a little inside the skin. */
  const flank = (z: number): P => {
    const p = across(z, -0.02, 0.86);
    return [p[0], p[1], z];
  };
  // --- The face's places ---------------------------------------------------------------------------------------------
  /** The mouth: its corners at `MOUTH_Z` on the sides of the head, its line round the front to the nose at `NOSE_Z`. */
  const MOUTH_Z = 1.74, NOSE_Z = 2.045;
  /** The angle round the head the mouth line runs at: low across the front, turned up toward the corners. */
  const mouthA = (z: number): number => -0.16 + 0.2 * (1 - clamp01((z - MOUTH_Z) / (NOSE_Z - MOUTH_Z))) ** 3;
  /** The lip at `z` on side `s`. */
  const lip = (z: number, s = 1): P => {
    const q = across(z, mouthA(z), 1.003);
    return [q[0] * s, q[1], z];
  };
  /** How far the palate is domed above the lips and the mouth's floor sags below them at `z` (both none at the corners and at the nose). */
  const mouthDeep = (z: number): number => 0.075 * Math.sin(Math.PI * clamp01((z - MOUTH_Z) / (NOSE_Z - MOUTH_Z))) ** 0.6;
  const JAW_AT: P = [0, lip(MOUTH_Z)[1], MOUTH_Z];
  const TONGUE_Z0 = MOUTH_Z + 0.04, TONGUE_Z1 = 1.9, TONGUE_Z2 = 1.995;
  /** The tongue's middle height at `z`: lying in the floor's sag. */
  const tongueY = (z: number): number => lip(z)[1] - mouthDeep(z) + 0.026;
  /** The eye on side `s`, and the middle of the sphere its lid is a cap of (inside the head). */
  const EYE_AT = across(1.6, 0.36, 1.0);
  const LID_R = 0.152;
  /** The lid's cap round the eye's fore-and-aft axis: from `LID_OPEN` (radians up from straight out) on over the top into the head; shut it is turned down by `LID_SHUT`. */
  const LID_OPEN = 1.26, LID_SPAN = 2.34, LID_SHUT = 2.43;
  const lidAt = (s: number): P => [(EYE_AT[0] - 0.07) * s, EYE_AT[1], EYE_AT[2]];

  // --- Skeleton (with the head's and the lantern's places from the profile) ------------------------------------------
  /** The lantern's hook under the chin. */
  const LANTERN: P = [0.07, across(1.66, -Math.PI / 2)[1] - 0.03, 1.66];
  const B = new Bones<Bone>(
    11,
    [
      ['root', null, [0, 0, 0]],
      ['body', 'root', [0, 0.52, -0.1]],
      ['chest', 'body', [0, 0.55, 0.7]],
      ['hips', 'body', [0, 0.5, -0.65]],
      ['head', 'chest', [0, 0.53, 1.15]],
      ['lantern', 'head', LANTERN],
      ['jaw', 'head', JAW_AT],
      ['tongue', 'jaw', [0, tongueY(TONGUE_Z0), TONGUE_Z0]],
      ['tongueTip', 'tongue', [0, tongueY(TONGUE_Z1), TONGUE_Z1]],
      ['lidL', 'head', lidAt(1)],
      ['lidR', 'head', lidAt(-1)],
      ['stem1', 'hips', STEM_AT[0]!],
      ['stem2', 'stem1', STEM_AT[1]!],
      ['stem3', 'stem2', STEM_AT[2]!],
      ...sideBones('L', 1),
      ...sideBones('R', -1),
    ],
    K,
  );
  const id = B.id;
  const tailBone = (S: Side, k: number): Bone => `tail${S}${TAILS[k]!}`;

  // --- Helpers --------------------------------------------------------------------------------------------------------
  /** A braided rope along `pts`: short links of two tones, each turned half a facet against the last. */
  const rope = (m: FigureMesh, pts: readonly P[], r: number, link = 0.06): void => {
    const path: P[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / link));
      for (let k = 0; k < n; k++) path.push(lerp(a, b, k / n));
    }
    path.push(pts[pts.length - 1]!);
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i]!, b = path[i + 1]!;
      const ax = norm(sub(b, a));
      const ref: P = Math.abs(ax[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
      const u = norm(cross(ref, ax)), w = cross(ax, u);
      m.paint(i % 2 ? ROPE_DARK : ROPE, MAT.flat, 0.06);
      m.loft([ringOn(a, u, w, r, r, 4, (i % 2) * 0.5), ringOn(b, u, w, r * 0.92, r * 0.92, 4, (i % 2) * 0.5 + 0.25)], i === 0, i + 2 === path.length);
    }
  };

  // --- Trunk and head -------------------------------------------------------------------------------------------------
  const skinRing = (z: number, grow = 1, n = 18): P[] => Array.from({ length: n }, (_, k) => across(z, ((k + 0.5) / n) * TAU, grow));
  /** Soft bands across the back, from behind the eyes to the tail base: darker in each of them, a half tone at their edges. */
  const band = (z: number): number => {
    if (z < -1.5 || z > 1.45) return 0;
    const f = (z + 1.5) / 0.23;
    const r = f - Math.floor(f);
    return r < 0.34 ? 1 : r < 0.47 || r > 0.9 ? 0.5 : 0;
  };
  const DARK_BAND: RGB = [0.62, 0.6, 0.76], SOFT_BAND: RGB = [0.8, 0.79, 0.88];
  const backTone: FaceTone = (c, n) => {
    if (n[1] < -0.3) return [BELLY, MAT.flat];
    if (n[1] > 0.15) {
      const b = band(c[2]);
      if (b === 1) return [DARK_BAND, MAT.tint];
      if (b === 0.5) return [SOFT_BAND, MAT.tint];
    }
    return null;
  };
  const skin = (b: Bone): FigureMesh => B.part(b, SLOT.back).paint(WHITE, MAT.tint, 0.04).tone(backTone);
  /** Rings of the trunk: every station and one between each two. */
  const ZS: number[] = [];
  for (let i = 0; i + 1 < TRUNK.length; i++) ZS.push(TRUNK[i]![0], (TRUNK[i]![0] + TRUNK[i + 1]![0]) / 2);
  ZS.push(TRUNK[TRUNK.length - 1]![0]);
  const zsIn = (a: number, b: number): number[] => ZS.filter((z) => z >= a - 1e-9 && z <= b + 1e-9);
  skin('hips').loft(zsIn(-1.3, -0.2).map((z) => skinRing(z)));
  skin('body').loft(zsIn(-0.62, 0.95).map((z) => skinRing(z, 0.997)));
  skin('chest').loft(zsIn(0.62, 1.48).map((z) => skinRing(z, 0.999)));
  // The head: broad and blunt. Behind the corners of the mouth it is one closed skin; in front of them the skin is split
  // along the mouth line into the upper head and the lower jaw (its own bone, hinged on the line between the corners),
  // each closed inside by a dark surface (the palate, domed; the mouth's floor, sagging) that meet on the hinge and at
  // the lips, so the mouth is shut tight at rest and opens on a dark cavity.
  {
    const HZ = [1.22, 1.35, 1.48, 1.58, 1.68, MOUTH_Z, 1.8, 1.86, 1.91, 1.95, 1.985, 2.01, 2.03, NOSE_Z];
    const iM = HZ.indexOf(MOUTH_Z);
    const GROW = 1.003;
    /** Angles from the left lip over the top (`up`) or under the chin to the middle; the first step above the lip is the lip's own strip. */
    const LIP_A = 0.035, N_UP = 7, N_LO = 6;
    const angles = (z: number, up: boolean): number[] => {
      const a0 = mouthA(z);
      const out = [a0];
      if (up) for (let i = 0; i <= N_UP; i++) out.push(a0 + LIP_A + ((Math.PI / 2 - a0 - LIP_A) * i) / N_UP);
      else for (let i = 1; i <= N_LO; i++) out.push(a0 + ((-Math.PI / 2 - a0) * i) / N_LO);
      return out;
    };
    /** A half ring from the left lip to the right one. */
    const arc = (z: number, up: boolean, grow = GROW): P[] => {
      const left = angles(z, up).map((a) => across(z, a, grow));
      return [...left, ...left.slice(0, -1).reverse().map((q): P => [-q[0], q[1], q[2]])];
    };
    /** A strip of skin between half rings; `paint(i, k)` before each cell (ring step i, cell k). */
    const strip = (m: FigureMesh, rings: readonly (readonly P[])[], away: (i: number) => P, paint?: (i: number, k: number, n: number) => void): void => {
      for (let i = 0; i + 1 < rings.length; i++) {
        const A = rings[i]!, C = rings[i + 1]!;
        for (let k = 0; k + 1 < A.length; k++) {
          paint?.(i, k, A.length - 1);
          m.quad(A[k]!, A[k + 1]!, C[k + 1]!, C[k]!, away(i));
        }
      }
    };
    const NOSE: P = [0, lip(NOSE_Z)[1], NOSE_Z + 0.008];
    const inside = (z: number): P => [0, prof(z)[0], z];
    const headTone: FaceTone = (c, n) => (n[1] < -0.05 && c[2] > 1.45 ? [JAW, MAT.flat] : n[1] < -0.3 ? [BELLY, MAT.flat] : backTone(c, n));
    // The upper head, all the way; its lip a dark strip from corner to corner.
    const top = B.part('head', SLOT.back).tone(null);
    const ups = HZ.map((z) => arc(z, true));
    strip(top, ups, (i) => inside((HZ[i]! + HZ[i + 1]!) / 2), (i, k, n) => {
      if (i >= iM && (k === 0 || k === n - 1)) top.tone(null).paint(mul(SMILE, 0.9), MAT.flat, 0);
      else top.tone(backTone).paint(WHITE, MAT.tint, 0.04);
    });
    const lastUp = ups[ups.length - 1]!;
    for (let k = 0; k + 1 < lastUp.length; k++) {
      if (k === 0 || k === lastUp.length - 2) top.tone(null).paint(mul(SMILE, 0.9), MAT.flat, 0);
      else top.tone(backTone).paint(WHITE, MAT.tint, 0.04);
      top.tri(lastUp[k]!, lastUp[k + 1]!, NOSE, inside(2.0));
    }
    // The underside behind the corners of the mouth.
    const under = B.part('head', SLOT.back).tone(headTone).paint(WHITE, MAT.tint, 0.04);
    strip(under, HZ.slice(0, iM + 1).map((z) => arc(z, false)), (i) => inside((HZ[i]! + HZ[i + 1]!) / 2));
    // The lower jaw, pale; its skin runs on back inside the head, so no gap opens behind it.
    const jaw = B.part('jaw', SLOT.trim).tone(null).paint(JAW, MAT.flat, 0.04);
    const JZ = [MOUTH_Z - 0.16, MOUTH_Z - 0.07, ...HZ.slice(iM)];
    const los = JZ.map((z, i) => arc(z, false, i === 0 ? 0.975 : i === 1 ? 0.99 : GROW));
    strip(jaw, los, (i) => inside((JZ[i]! + JZ[i + 1]!) / 2));
    const lastLo = los[los.length - 1]!;
    for (let k = 0; k + 1 < lastLo.length; k++) jaw.tri(lastLo[k]!, lastLo[k + 1]!, NOSE, inside(2.0));
    // The palate (on the head, facing down) and the mouth's floor (on the jaw, facing up).
    const MZ = HZ.slice(iM);
    const NX = 6;
    const row = (z: number, dir: number): P[] => {
      const l = lip(z), d = mouthDeep(z) * dir;
      return Array.from({ length: NX + 1 }, (_, j): P => {
        const u = (j / NX) * 2 - 1;
        return [-l[0] * u, l[1] + d * (1 - u * u), z];
      });
    };
    for (const [m, dir] of [[B.part('head', SLOT.trim).tone(null), 1], [B.part('jaw', SLOT.trim).tone(null), -1]] as const) {
      const rows = MZ.map((z) => row(z, dir));
      strip(m, rows, () => [0, JAW_AT[1] + 4 * dir, 1.9], (i, k, n) => {
        // Gums along the lips, the dark of the mouth inside.
        m.paint(k === 0 || k === n - 1 || i >= rows.length - 3 ? GUM : MOUTH, MAT.flat, 0.05);
      });
      const end = rows[rows.length - 1]!;
      m.paint(GUM, MAT.flat, 0.05).tri(end[0]!, end[NX]!, NOSE, [0, JAW_AT[1] + 4 * dir, 1.9]);
    }
    // The tongue: broad and flat in the floor's sag, a groove down its middle, its front third on a bone of its own.
    const tongueRing = (z: number, w: number, h: number, dy = 0): P[] => ringOn([0, tongueY(z) + dy, z], [1, 0, 0], [0, 1, 0], w, h, 8, 0.5);
    const tg = B.part('tongue', SLOT.trim).tone((_c, n) => (n[1] < -0.3 ? [TONGUE_DARK, MAT.flat] : null)).paint(TONGUE, MAT.flat, 0.05);
    tg.loft([tongueRing(TONGUE_Z0, 0.13, 0.014), tongueRing(TONGUE_Z0 + 0.04, 0.2, 0.024), tongueRing((TONGUE_Z0 + TONGUE_Z1) / 2, 0.21, 0.026), tongueRing(TONGUE_Z1, 0.2, 0.024)]);
    const tt = B.part('tongueTip', SLOT.trim).tone((_c, n) => (n[1] < -0.3 ? [TONGUE_DARK, MAT.flat] : null)).paint(TONGUE, MAT.flat, 0.05);
    const zt = (TONGUE_Z1 + TONGUE_Z2) / 2;
    tt.loft([tongueRing(TONGUE_Z1 - 0.012, 0.2, 0.024), tongueRing(zt, 0.185, 0.022, tongueY(TONGUE_Z1) - tongueY(zt)), tongueRing(TONGUE_Z2 - 0.03, 0.15, 0.018, tongueY(TONGUE_Z1) - tongueY(TONGUE_Z2 - 0.03)), tongueRing(TONGUE_Z2, 0.08, 0.012, tongueY(TONGUE_Z1) - tongueY(TONGUE_Z2))]);
    B.part('tongue', SLOT.trim).tone(null).paint(TONGUE_DARK, MAT.flat, 0).limb([0, tongueY(TONGUE_Z0 + 0.03) + 0.019, TONGUE_Z0 + 0.03], [0, tongueY(TONGUE_Z1) + 0.02, TONGUE_Z1 - 0.01], 0.012, 0.01, 4);
    // Two nostrils on the snout.
    const nose = B.part('head', SLOT.trim).tone(null).paint(NOSTRIL, MAT.flat, 0);
    for (const s of [1, -1]) {
      const q = across(1.93, 1.18, 1.0);
      nose.blob([q[0] * s, q[1] - 0.004, q[2]], [0.022, 0.012, 0.034], 51 + s, 0.02, 6, 1);
    }
  }
  // A big dark glossy eye on each side of the head, a dark rim round it and two glints; a faint pink blush under it; a
  // lid over it, the cap of a sphere about the eye that rests as a hood above it and turns down over it.
  for (const [S, s] of [['L', 1], ['R', -1]] as const) {
    const e = B.part('head', SLOT.trim).tone(null);
    const at = EYE_AT;
    const x = at[0] * s;
    e.paint(EYE_RIM, MAT.flat, 0.02).blob([x - 0.018 * s, at[1], at[2]], [0.06, 0.125, 0.125], 41 + s, 0.02, 9, 3);
    e.paint(EYE, MAT.flat, 0.01).blob([x + 0.004 * s, at[1], at[2] + 0.006], [0.055, 0.105, 0.105], 43 + s, 0.02, 9, 3);
    e.paint(EYE_SHINE, MAT.flat, 0).blob([x + 0.05 * s, at[1] + 0.045, at[2] + 0.04], [0.016, 0.03, 0.03], 45 + s, 0, 5, 1);
    e.paint(EYE_SHINE, MAT.flat, 0).blob([x + 0.052 * s, at[1] - 0.035, at[2] - 0.03], [0.01, 0.014, 0.014], 47 + s, 0, 4, 1);
    const ck = across(1.64, -0.1, 1.0);
    e.paint(CHEEK, MAT.flat, 0.03).blob([(ck[0] - 0.012) * s, ck[1], ck[2]], [0.022, 0.03, 0.055], 49 + s, 0.03, 7, 2);
    const c = lidAt(s);
    const lid = B.part(`lid${S}`, SLOT.back).tone(null).paint([0.86, 0.85, 0.92], MAT.tint, 0.03);
    const NA = 9, NZ = 6, RZ = 0.16;
    const at2 = (i: number, j: number): P => {
      const psi = LID_OPEN + (LID_SPAN * i) / NA;
      const dz = (j / NZ) * 2 - 1;
      const r = LID_R * Math.sqrt(1 - (0.93 * dz) ** 2);
      return [c[0] + Math.cos(psi) * r * s, c[1] + Math.sin(psi) * r, c[2] + dz * 0.93 * RZ];
    };
    for (let i = 0; i < NA; i++) for (let j = 0; j < NZ; j++) lid.quad(at2(i, j), at2(i + 1, j), at2(i + 1, j + 1), at2(i, j + 1), c);
  }

  // --- Paws: on each wing's leading edge, and smaller under the pelvic fins ------------------------------------------
  /** A fat paw pad with four round toes in front, a claw on each; the toes in proportion to the pad, their soles on the pad's. */
  const pawPad = (bone: Bone, at: P, s: number, pad: P, seed: number): void => {
    const m = B.part(bone, SLOT.back).paint(WHITE, MAT.tint, 0.05).tone((_c, n) => (n[1] < -0.5 ? [mul(BELLY, 0.8), MAT.flat] : null));
    m.blob(at, pad, seed, 0.05, 8, 3);
    const claws = B.part(bone, SLOT.trim).paint(CLAW, MAT.flat, 0.04).tone(null);
    const toe: P = [pad[0] * 0.3, pad[1] * 0.62, pad[2] * 0.36];
    const spread = pad[0] * 0.5;
    for (let k = 0; k < 4; k++) {
      const o = (k - 1.5) * spread;
      const c: P = [at[0] + o * s + 0.1 * pad[0] * s, at[1] - pad[1] + toe[1], at[2] + pad[2] * 0.82 - 0.12 * pad[2] * Math.abs(k - 1.5)];
      m.blob(c, toe, seed + 2 + k, 0.04, 7, 2);
      const base: P = add(c, [0, -0.2 * toe[1], toe[2] * 0.8]);
      claws.cone(ringOn(base, [1, 0, 0], [0, 1, 0], toe[0] * 0.4, toe[1] * 0.35, 4, 0.5), add(base, [0.1 * o * s, -0.5 * toe[1], toe[2] * 0.9]));
    }
  };
  /** The wing's paw pad: half sizes, and its centre against the paw's joint (its sole `FORE_SOLE` below the joint). */
  const FORE_PAD: P = [0.21, 0.1, 0.22];
  const FORE_SOLE = 0.15;
  for (const [S, s] of [['L', 1], ['R', -1]] as const) {
    const pw = wing(s)[3]!;
    pawPad(`paw${S}`, [pw[0] - 0.02 * s, pw[1] - FORE_SOLE + FORE_PAD[1], pw[2] + 0.04], s, FORE_PAD, 61 + 8 * s);
  }

  // --- Pelvic fins: short and thick, out of the hips, a flap and a paw -------------------------------------------------
  const HIND_PAD: P = [0.13, 0.06, 0.14];
  const HIND_SOLE = 0.09;
  for (const [S, s] of [['L', 1], ['R', -1]] as const) {
    const [hip, knee, ankle, ball] = hind(s) as [P, P, P, P];
    const tone: FaceTone = (_c, n) => (n[1] < -0.3 ? [BELLY, MAT.flat] : null);
    const thigh = B.part(`thigh${S}`, SLOT.back).paint(WHITE, MAT.tint, 0.05).tone(tone);
    // The thigh swells out of the flank: from inside the body to the knee.
    thigh.limb(add(hip, [-0.12 * s, 0.06, 0.02]), knee, 0.2, 0.13, 8, 0.7);
    thigh.blob(lerp(hip, knee, 0.35), [0.17, 0.15, 0.19], 73 + s, 0.04, 7, 2);
    // The fin's flap: flat, out and back from the knee.
    thigh.blob([knee[0] + 0.08 * s, knee[1] + 0.04, knee[2] - 0.16], [0.16, 0.05, 0.21], 75 + s, 0.05, 7, 2);
    B.part(`shin${S}`, SLOT.back).paint(WHITE, MAT.tint, 0.05).tone(tone).limb(knee, ankle, 0.13, 0.095, 8, 0.8);
    B.part(`shin${S}`, SLOT.back).paint(WHITE, MAT.tint, 0.05).tone(tone).blob(knee, [0.13, 0.12, 0.13], 77 + s, 0.04, 7, 2);
    B.part(`ankle${S}`, SLOT.back).paint(WHITE, MAT.tint, 0.05).tone(null).blob(lerp(ankle, ball, 0.3), [0.095, 0.075, 0.1], 71 + s, 0.05, 7, 2);
    pawPad(`foot${S}`, [ball[0], ball[1] - HIND_SOLE + HIND_PAD[1], ball[2] + 0.03], s, HIND_PAD, 81 + 8 * s);
  }

  // --- Tack: the rug, the harness and halter, the lantern, the bedroll and the bags ---------------------------------
  /** The rider's seat on the rug (the socket `seat`). */
  const SEAT: P = [0, topY(0.45) + 0.034, 0.45];
  /** The rug: along z from its back to its front edge, down each side from the spine. */
  const RUG_Z0 = 0.05, RUG_Z1 = 0.95;
  const RUG_A0 = 0.95;
  const rugAt = (z: number, a: number, s: number, lift = 0): P => {
    const p = across(z, a, 1.03 + lift);
    return [p[0] * s, p[1], z];
  };
  {
    const rug = B.part('body', SLOT.rug).tone(null);
    const COLS = 10, ROWS = 4;
    for (const s of [1, -1]) {
      for (let j = 0; j < ROWS; j++) {
        const a0 = Math.PI / 2 - ((Math.PI / 2 - RUG_A0) * j) / ROWS, a1 = Math.PI / 2 - ((Math.PI / 2 - RUG_A0) * (j + 1)) / ROWS;
        for (let i = 0; i < COLS; i++) {
          const z0 = RUG_Z0 + ((RUG_Z1 - RUG_Z0) * i) / COLS, z1 = RUG_Z0 + ((RUG_Z1 - RUG_Z0) * (i + 1)) / COLS;
          const TL = rugAt(z0, a0, s), TR = rugAt(z1, a0, s), BL = rugAt(z0, a1, s), BR = rugAt(z1, a1, s);
          const edge = i === 0 || i === COLS - 1 || j === ROWS - 1;
          const centre: P = [0, 0.4, (z0 + z1) / 2];
          // Diamonds: the cells split on their diagonals, the four triangles toward the cell's middle light in every
          // other cell, so that they meet in diamonds across the rug.
          const M: P = rugAt((z0 + z1) / 2, (a0 + a1) / 2, s, 0.002);
          const on = (i + j) % 2 === 0;
          const tris: [P, P][] = [[TL, TR], [TR, BR], [BR, BL], [BL, TL]];
          tris.forEach(([p, q], k) => {
            if (edge) rug.paint(RUG_DARK, MAT.flat, 0.05);
            else if (on ? k % 2 === 0 : k % 2 === 1) rug.paint(RUG_LIGHT, MAT.flat, 0.04);
            else rug.paint(WHITE, MAT.tint, 0.05);
            rug.tri(p, q, M, centre);
          });
        }
      }
    }
    // A fringe round the rug: along both side edges and across its front and back.
    const fringe = B.part('body', SLOT.trim).paint(TASSEL, MAT.flat, 0.12).tone(null);
    const tassel = (p: P, out: P): void => fringe.cone(ringOn(p, [1, 0, 0], [0, 0, 1], 0.012, 0.012, 4, 0.5), add(p, out));
    for (const s of [1, -1]) {
      for (let i = 0; i <= 20; i++) {
        const z = RUG_Z0 + ((RUG_Z1 - RUG_Z0) * i) / 20;
        const p = rugAt(z, RUG_A0, s);
        tassel([p[0], p[1] - 0.004, z], [0.02 * s, -0.06, 0]);
      }
      for (let j = 0; j <= 6; j++) {
        const a = Math.PI / 2 - ((Math.PI / 2 - RUG_A0) * j) / 6;
        for (const [z, dz] of [[RUG_Z0, -0.06], [RUG_Z1, 0.06]] as const) {
          const p = rugAt(z, a, s);
          tassel([p[0], p[1], z], [0, -0.02, dz]);
        }
      }
    }
    // A pad under the seat.
    const pad = B.part('body', SLOT.trim).paint(LEATHER_DARK, MAT.flat, 0.06).tone(null);
    pad.loft([0.2, 0.35, 0.55, 0.68].map((z) => ringOn([0, topY(z) + 0.012, z], [1, 0, 0], [0, 1, 0], 0.16, 0.028, 8, 0.5)));
  }
  // The harness: a girth round the body in front of the rug and one behind it, a halter round the head, reins from
  // the halter's rings back to the rider's hands, and a loop of rope on each side of the back for the feet.
  const GRIP: P = [0.075, SEAT[1] + 0.03, SEAT[2] + 0.26];
  const STIRRUP: P = [0.2, SEAT[1] - 0.055, SEAT[2] + 0.04];
  const HALTER_Z = 1.44;
  {
    for (const z of [1.02, 0]) {
      const m = B.part(z > 0.8 ? 'chest' : 'body', SLOT.trim).tone(null);
      const r = Array.from({ length: 18 }, (_, k) => across(z, ((k + 0.5) / 18) * TAU, 1.025));
      rope(m, [...r, r[0]!], 0.014);
    }
    const halter = B.part('head', SLOT.trim).tone(null);
    const hr = Array.from({ length: 18 }, (_, k) => across(HALTER_Z, ((k + 0.5) / 18) * TAU, 1.02));
    rope(halter, [...hr, hr[0]!], 0.014);
    // A band over the nose from the halter.
    {
      // It lies on the skin: from the halter on each side forward and up to meet on top of the snout.
      const half = Array.from({ length: 8 }, (_, k): P => across(mixN(HALTER_Z, 1.9, k / 7), mixN(0.75, Math.PI / 2, (k / 7) ** 1.5), 1.02));
      rope(halter, [...half, ...half.slice(0, -1).reverse().map((q): P => [-q[0], q[1], q[2]])], 0.012);
    }
    const ring = (s: number): P => {
      const p = across(HALTER_Z, 0.25, 1.05);
      return [p[0] * s, p[1], p[2]];
    };
    for (const s of [1, -1]) halter.paint(BRASS, MAT.flat, 0).blob(ring(s), [0.025, 0.025, 0.025], 91 + s, 0.05, 5, 1);
    const reins = B.part('chest', SLOT.trim).tone(null);
    for (const s of [1, -1]) {
      const g: P = [GRIP[0] * s, GRIP[1], GRIP[2]];
      const r0 = ring(s);
      rope(reins, [r0, [(r0[0] - 0.08 * s) * 0.92, topY(1.22) + 0.06, 1.22], [0.3 * s, topY(0.95) + 0.07, 0.95], g], 0.011);
    }
    rope(reins, [[GRIP[0], GRIP[1], GRIP[2]], [0.02, GRIP[1] - 0.04, GRIP[2] - 0.04], [-0.02, GRIP[1] - 0.04, GRIP[2] - 0.04], [-GRIP[0], GRIP[1], GRIP[2]]], 0.011);
    const loops = B.part('body', SLOT.trim).tone(null);
    for (const s of [1, -1]) {
      const top = rugAt(SEAT[2], 1.25, s, 0.01);
      const x = STIRRUP[0] * s, y = STIRRUP[1] - 0.03;
      rope(loops, [[top[0], top[1], top[2] - 0.05], [x * 1.15, y, STIRRUP[2] - 0.04], [x * 1.15, y, STIRRUP[2] + 0.04], [top[0], top[1], top[2] + 0.05]], 0.01, 0.05);
    }
  }
  // The lantern on a short rope from the halter under the chin.
  {
    const hook = B.part('head', SLOT.trim).paint(IRON, MAT.flat, 0.05).tone(null);
    hook.limb(across(HALTER_Z, -Math.PI / 2 + 0.25, 1.02), [LANTERN[0], LANTERN[1] + 0.005, LANTERN[2]], 0.008, 0.008, 4);
    const l = B.part('lantern', SLOT.trim).paint(IRON, MAT.flat, 0.05).tone(null);
    const [x, , z] = LANTERN;
    const LS = 0.62;
    const sq = (y: number, h: number): P[] => [[x - h, y, z - h], [x + h, y, z - h], [x + h, y, z + h], [x - h, y, z + h]];
    const TOP = LANTERN[1] - 0.075 * LS, FOOT = LANTERN[1] - 0.23 * LS, HT = 0.058 * LS, HF = 0.045 * LS;
    l.limb([x, LANTERN[1], z], [x, TOP + 0.06 * LS, z], 0.006, 0.006, 3);
    l.loft([sq(TOP, HT + 0.012), sq(TOP + 0.01, HT + 0.012)]);
    l.cone(sq(TOP + 0.01, HT + 0.004), [x, TOP + 0.05 * LS, z]);
    l.loft([sq(FOOT - 0.012, HF + 0.009), sq(FOOT, HF + 0.009)]);
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) l.limb([x + dx * HF, FOOT, z + dz * HF], [x + dx * HT, TOP, z + dz * HT], 0.006, 0.006, 4);
    const mid = (FOOT + TOP) / 2, hm = (HF + HT) / 2;
    for (const [ux, uz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const p = (y: number, h: number, side: number, out = 0): P => [x + ux * (h + out) - uz * side * h, y, z + uz * (h + out) + ux * side * h];
      l.paint(GLASS, MAT.glow, 0.03).quad(p(FOOT, HF, -0.9), p(FOOT, HF, 0.9), p(TOP, HT, 0.9), p(TOP, HT, -0.9), [x, mid, z]);
      l.paint(GLASS_CORE, MAT.glow, 0);
      l.quad(p(mid - 0.022, hm - 0.004, 0, 0.003), p(mid, hm, 0.5, 0.003), p(mid + 0.025, hm + 0.004, 0, 0.003), p(mid, hm, -0.5, 0.003), [x, mid, z]);
    }
  }
  // The bedroll across the back behind the seat, two straps round it; a bag on each side of it.
  {
    const roll = B.part('body', SLOT.trim).tone(null);
    const RZ = 0.1, RR = 0.065, RY = topY(RZ) + RR - 0.01;
    roll.paint(BEDROLL, MAT.flat, 0.06).loft([-0.26, -0.12, 0.12, 0.26].map((x) => ringOn([x, RY, RZ], [0, 1, 0], [0, 0, 1], RR * (Math.abs(x) > 0.25 ? 0.9 : 1), RR, 9)));
    roll.paint(BEDROLL_DARK, MAT.flat, 0.04);
    for (const x of [-0.265, 0.265]) roll.plate(ringOn([x, RY, RZ], [0, 1, 0], [0, 0, 1], RR * 0.5, RR * 0.5, 9).map((p): P => [x * 1.004, p[1], p[2]]));
    for (const x of [-0.14, 0.14]) {
      const st = ringOn([x, RY, RZ], [0, 1, 0], [0, 0, 1], RR + 0.008, RR + 0.008, 9);
      roll.paint(LEATHER_DARK, MAT.flat, 0.03).loft([st.map((p): P => [x - 0.016, p[1], p[2]]), st.map((p): P => [x + 0.016, p[1], p[2]])], false, false);
    }
    for (const s of [1, -1]) {
      const bag = B.part('body', SLOT.trim).tone(null);
      const on = rugAt(0.1, 1.1, s, 0.02);
      const c: P = [on[0] + 0.03 * s, on[1] + 0.02, 0.1];
      bag.paint(LEATHER, MAT.flat, 0.07).rock(c, [0.08, 0.07, 0.1], 95 + s, 0.06, 6, 0.5, 0.8);
      bag.paint(LEATHER_DARK, MAT.flat, 0.04).box([c[0], c[1] + 0.05, c[2] + 0.01], [0.15, 0.035, 0.16], 0.9);
      bag.paint(BRASS, MAT.flat, 0).blob([c[0] + 0.075 * s, c[1] + 0.02, c[2] + 0.01], [0.012, 0.015, 0.012], 97 + s, 0, 4, 1);
    }
  }

  // --- The membrane ---------------------------------------------------------------------------------------------------
  const BACKS = ['#2f2486', '#24347a', '#48236e'].map(rgb);
  const membrane = buildMembrane(B, wing, flank, { stemAt: STEM_AT, forkZ: FORK_Z, at: tailAt, links: TAIL_N }, BACKS);

  // --- Motions (trunk, head, tails, lantern, wing fins and points; on the ground the legs are the step cycle's) -------
  type Pose = Parameters<FigureMotion['sample']>[0];
  const STREAM = { look: 0x47_4c_4b, tail: 0x47_54_4c, shuffle: 0x47_53_48 } as const;
  const twitch = (t: number, period: number, key: number, seed: number, chance: number, len: number): number => {
    const k = Math.floor(t / period);
    const h = (i: number): number => unit(hashInts(key, Math.round(seed * 4096), k, i));
    if (h(0) > chance) return 0;
    const x = (t - (k + 0.1 + 0.55 * h(1)) * period) / len;
    if (x < 0 || x > 1) return 0;
    return Math.sin(Math.PI * x) * (h(2) < 0.5 ? -1 : 1);
  };
  /**
   * The tail: the base's three links turned up (+) or down by `stem[k]`, sideways by `stemYaw`; then each filament's
   * links by `pitch[k]` and `yaw[k]` (both alike, plus `spread` outward at the fork).
   */
  const tails = (pose: Pose, stem: (k: number) => number, pitch: (k: number) => number, yaw: (k: number) => number, spread = 0, stemYaw: (k: number) => number = () => 0): void => {
    STEMS.forEach((b, k) => turn(pose, id[b], stem(k), stemYaw(k)));
    for (const [S, s] of [['L', 1], ['R', -1]] as const) {
      for (let k = 0; k < TAIL_N; k++) turn(pose, id[tailBone(S, k)], pitch(k), yaw(k) + (k === 0 ? spread * s : 0));
    }
  };
  /** On the ground the base runs back level from the rump and the filaments rise in a long S, their tips curling over. */
  const STEM_GROUND = [0.02, 0.06, 0.08];
  const RISE = [0.2, 0.18, 0.14, 0.1, 0.03, -0.1, -0.2, -0.28];
  const stemGround = (k: number): number => STEM_GROUND[k] ?? 0;
  const rise = (k: number): number => RISE[k] ?? 0;
  /** The filaments' lazy S. */
  const curl = (k: number): number => 0.06 * Math.sin(0.9 * k + 0.4);
  /**
   * The wings on the ground: the points laid back low behind the paws, the fins rolled down and their rear lowered,
   * so the free part of each fin lies low behind the arm and the face and the shoulder stay open.
   */
  const finsDown = (pose: Pose, sway = 0, fold = 0): void => {
    for (const [S, sd] of [['L', 1], ['R', -1]] as const) {
      turn(pose, id[`tip${S}`], 0.04, (0.03 + 0.1 * fold + sway * sd) * sd, (-0.1 - 0.04 * fold) * sd);
      turn(pose, id[`fin${S}`], -0.05 - 0.04 * fold, (0.04 + 0.06 * fold) * sd, (-0.21 - 0.05 * fold + 0.5 * sway * sd) * sd);
    }
  };
  const stand: FigureMotion = {
    sample(pose, t, f) {
      const w = f.seed * TAU;
      const breath = Math.sin((TAU * t) / 4.6 + w);
      shift(pose, id.body, 0, 0.016 * K * breath, 0);
      turn(pose, id.body, 0.007 * breath);
      turn(pose, id.chest, -0.012 * breath);
      const look = twitch(t, 7.2, STREAM.look, f.seed, 0.7, 2.8);
      turn(pose, id.head, 0.03 * Math.sin((TAU * t) / 5.3 + w) - 0.02, 0.1 * look, 0.03 * look);
      const swish = twitch(t, 5.1, STREAM.tail, f.seed, 0.65, 1.6);
      tails(pose, stemGround, (k) => rise(k) + 0.03 * Math.sin((TAU * t) / 3.7 - 0.6 * k), (k) => curl(k) + 0.12 * swish * Math.sin(TAU * 0.7 * t - 0.7 * k), 0.16, (k) => 0.05 * swish * (k + 1) / 3);
      finsDown(pose, 0.02 * breath);
      turn(pose, id.lantern, -0.004 * breath, 0, 0);
    },
  };
  const bands = gaitBands(GLIDER_SPEEDS);
  const crawl = (amp: number, bob: number): ((pose: Pose, p: number) => void) => (pose, p) => {
    // The wings' paws come down at 0.25 (left) and 0.75 (right) of the slow crawl: the chest shifts and rolls over the
    // planted fin before the other one lifts, the hips sway against it.
    const two = Math.cos(2 * TAU * (p - 0.3));
    const over = Math.sin(TAU * (p - 0.35));
    shift(pose, id.body, 0.055 * K * amp * over, K * (-0.012 + bob * two), 0);
    turn(pose, id.body, 0.008 * amp * Math.sin(2 * TAU * p), 0.03 * amp * Math.sin(TAU * (p - 0.25)), -0.035 * amp * over);
    turn(pose, id.chest, -0.012 * two, -0.025 * amp * Math.sin(TAU * (p - 0.25)), -0.02 * amp * over);
    turn(pose, id.hips, 0.01 * two, 0.05 * amp * Math.sin(TAU * p), 0.02 * amp * over);
    turn(pose, id.head, -0.02 + 0.02 * two, 0.04 * amp * Math.sin(TAU * (p - 0.2)), 0.04 * amp * over);
    tails(pose, stemGround, (k) => rise(k) + 0.03 * two, (k) => curl(k) + 0.1 * amp * Math.sin(TAU * p - 0.75 * k), 0.14, (k) => 0.04 * amp * Math.sin(TAU * p - 0.5 * k));
    finsDown(pose, 0.06 * amp * Math.sin(TAU * p));
    turn(pose, id.lantern, 0.05 * Math.sin(2 * TAU * (p - 0.35)), 0, 0.07 * Math.sin(TAU * (p - 0.2)));
  };
  const walk: FigureMotion = { unit: 'phase', speed: bands.walk, sample: crawl(1, 0.008) };
  const trot: FigureMotion = { unit: 'phase', speed: bands.trot, sample: crawl(0.8, 0.014) };
  const gallop: FigureMotion = {
    unit: 'phase',
    speed: bands.gallop,
    sample(pose, p) {
      // Wings down at 0, hind legs at 0.5: the body rocks and rises between them.
      const rock = Math.cos(TAU * (p - 0.25));
      shift(pose, id.body, 0, 0.035 * K * Math.cos(2 * TAU * (p - 0.3)), 0);
      turn(pose, id.body, 0.045 * rock);
      turn(pose, id.chest, -0.03 * rock);
      turn(pose, id.hips, 0.05 * rock);
      turn(pose, id.head, -0.05 - 0.03 * rock);
      tails(pose, (k) => stemGround(k) - 0.05 * rock, (k) => rise(k) * 0.7 + 0.07 * Math.sin(TAU * (p - 0.1 * k)), () => 0, 0.12);
      finsDown(pose, 0.08 * rock, 0.3);
      turn(pose, id.lantern, -0.2 * rock, 0, 0);
    },
  };

  /** The pose in the air (every bone of the wings, the trunk, the legs tucked, the tails). */
  const fly = (pose: Pose, s: GliderFlight): void => {
    const e = clamp01(s.effort);
    // The approach and the flare as one weight: the wings brake, the paws reach down.
    const fl = Math.max(clamp01(s.flare), clamp01(s.land));
    // The launch: the first strokes thrown from high above the back deep below the belly, on the body's own beat,
    // fading into it.
    const lt = s.launch;
    const L = lt < 0 ? 0 : 1 - step01(1.1, 1.9, lt);
    const amp = mixN(e, 0.95 - 0.2 * clamp01(lt / 1.6), L);
    // Rolling into a bank (or out of it) the rising wing strokes deeper and the other one less; steady, both alike.
    const roll = clamp1(s.roll);
    const ph = s.phase;
    /** The stroke at `lag` of a cycle behind the arm: 1 at the top, −1 at the bottom, the downstroke the deeper. */
    const at = (lag: number, a: number): number => a * (0.82 * Math.cos(TAU * (ph - lag)) - 0.18);
    /** The power stroke (down, 0–0.5 of the beat) and the recovery (up, 0.5–1), each 0–1 at its fullest. */
    const pow = (lag: number): number => Math.max(0, Math.sin(TAU * (ph - lag)));
    const rec = (lag: number): number => Math.max(0, -Math.sin(TAU * (ph - lag)));
    const eff = mixN(e, 1, L);
    const ripple = Math.sin(TAU * (s.time * 0.45));
    const ripple2 = Math.sin(TAU * (s.time * 0.45) - 1.1);
    // Short beats back against the air in the approach.
    const back = fl * 0.14 * Math.sin(TAU * 2.4 * s.time);
    // Fast: the wings swept back and flattened, the points laid back (not while braking or in the approach).
    const fa = clamp01(s.fast) * (1 - fl);
    for (const [S, sd] of [['L', 1], ['R', -1]] as const) {
      // The left wing (sd 1) strokes deeper rolling to the right (roll > 0).
      const a = amp * (1 + 0.3 * roll * sd);
      const dihedral = -0.07 * roll * sd;
      const armUp = 0.05 + 0.5 * at(0, a) + 0.1 * fl + back + dihedral + 0.012 * ripple * (1 - eff) - 0.05 * fa;
      const foreUp = -0.02 + 0.26 * at(0.07, a) - 0.17 * fl + 0.5 * back + 0.015 * ripple2 * (1 - eff);
      // The recovery: the outer fin bends down behind the rising arm and is twisted nose up (unloaded); the power
      // stroke twists it nose down and keeps it spread.
      const wristUp = -0.03 + 0.2 * at(0.14, a) - 0.14 * fl - 0.1 * a * rec(0.1);
      const pawUp = 0.16 * at(0.2, a) - 0.2 * fl;
      // The outer fin turned up a little in the glide, more on the upstroke (it trails the rising arm).
      const tipUp = 0.2 + 0.3 * at(0.27, a) + 0.14 * a * rec(0.3) + 0.05 * ripple * (1 - eff) - 0.08 * fl - 0.08 * fa + 0.08 * (1 - eff);
      const tipTwist = a * (0.16 * pow(0.2) - 0.3 * rec(0.2)) + 0.05 * roll * sd;
      const sweep = 0.42 * fl - 0.06 * a * Math.sin(TAU * ph) - 0.3 * fa;
      const twist = a * (0.08 * pow(0.05) - 0.1 * rec(0.05)) - 0.22 * fl + 0.04 * roll * sd;
      // Positive turn about z raises a left wing; the right wing is mirrored.
      turn(pose, id[`arm${S}`], twist, -sweep * sd, armUp * sd);
      turn(pose, id[`fore${S}`], 0.5 * twist, -0.4 * sweep * sd, foreUp * sd);
      turn(pose, id[`wrist${S}`], 0.3 * tipTwist, (0.25 * fl + 0.12 * a * rec(0.12)) * sd, wristUp * sd);
      // The paw curled back in the flight, reaching forward and down in the approach.
      turn(pose, id[`paw${S}`], 0.2 * twist + 0.5 * (1 - fl) - 0.5 * fl, 0, pawUp * sd);
      // Fast, the trailing edge shivers in the wind: a small quick flutter of the point and of the inner fin.
      const shiver = 0.014 * fa * Math.sin(TAU * 6.3 * s.time + 1.7 * sd);
      turn(pose, id[`tip${S}`], tipTwist + 1.4 * shiver, (0.06 * eff * at(0.3, a) + 0.1 * a * rec(0.25) + 0.12 * fa) * sd, (tipUp + shiver) * sd);
      // The inner trailing fin follows the arm's stroke a little later and a little less (the trailing edge lags),
      // cupped down in the approach.
      const finUp = 0.04 + 0.44 * at(0.11, a) + dihedral - 0.08 * fl + 0.5 * back - 0.04 * fa;
      turn(pose, id[`fin${S}`], 0.6 * twist - 0.1 * fl + 0.012 * fa * Math.sin(TAU * 7.1 * s.time + 2.3 * sd), -0.35 * sweep * sd, finUp * sd);
      // The pelvic fins tucked back against the belly, swung down and forward to land.
      turn(pose, id[`thigh${S}`], 1.0 - 1.6 * fl, 0, 0.1 * fl * sd);
      turn(pose, id[`shin${S}`], 0.6 - 0.8 * fl, 0, 0);
      turn(pose, id[`ankle${S}`], 0.6 - 0.7 * fl, 0, 0);
    }
    // The body heaves against the stroke; the head looks into a bank and up in the approach.
    shift(pose, id.body, 0, -0.04 * K * at(0, amp), 0);
    turn(pose, id.body, 0.02 * at(0, amp));
    turn(pose, id.head, -0.04 * s.climb - 0.1 * fl + 0.08 * L, -0.1 * s.bank, 0.05 * s.bank);
    // The tails stream behind: a wave running down them, an S into a bank (out at the root, back in toward the tips),
    // whipped down as the paws push off, down in the approach.
    const whip = lt < 0 ? 0 : Math.sin(Math.PI * clamp01(lt / 0.7)) * (1 - clamp01(lt / 0.7) * 0.3);
    const wave = (k: number): number => (0.04 + 0.03 * eff) * Math.sin(TAU * (ph * e + 0.3 * s.time) - 0.7 * k);
    tails(
      pose,
      (k) => (k === 0 ? -0.04 - 0.2 * fl - 0.4 * whip : -0.1 * whip) + 0.6 * wave(k),
      (k) => (k === 0 ? -0.08 * fl - 0.2 * whip : 0) + wave(k + 3) + (k > 4 ? 0.05 : 0),
      (k) => s.bank * (k < 3 ? -0.03 : -0.06) + 0.04 * Math.sin(TAU * 0.2 * s.time - 0.6 * k),
      0.1 + 0.08 * fl,
      (k) => s.bank * 0.06 + 0.02 * Math.sin(TAU * 0.2 * s.time - 0.6 * k),
    );
    turn(pose, id.lantern, 0, 0, 0);
  };
  /** Loading for a leap, `c` 0–1 over a ground pose: the nose down, the fins and points drawn in, the tails up. */
  const crouch = (pose: Pose, c: number): void => {
    turn(pose, id.chest, 0.08 * c);
    turn(pose, id.head, 0.12 * c);
    turn(pose, id.hips, -0.05 * c);
    finsDown(pose, 0, 0.15 * c);
    tails(pose, (k) => stemGround(k) + 0.1 * c, (k) => rise(k) + 0.06 * c, curl, 0.14);
  };

  /** The face: the jaw open, the tongue out (and to a side, its tip curled), the lids down. */
  const face = (pose: Pose, f: Readonly<GliderFace>): void => {
    const out = clamp01(f.tongue);
    // The tongue needs room over the lower lip.
    const open = Math.max(clamp01(f.open), 0.28 * out);
    turn(pose, id.jaw, 0.8 * open);
    const side = clamp1(f.tongueSide), curl = clamp1(f.tongueCurl);
    shift(pose, id.tongue, 0, K * 0.05 * step01(0, 0.45, out), K * 0.17 * out);
    turn(pose, id.tongue, -0.06 * out - 0.1 * Math.max(0, curl) * out, 0.4 * side * out, 0);
    turn(pose, id.tongueTip, (0.25 - 0.75 * curl) * out, 0.35 * side * out, 0);
    const lids = clamp01(f.lids);
    turn(pose, id.lidL, 0, 0, -LID_SHUT * lids);
    turn(pose, id.lidR, 0, 0, LID_SHUT * lids);
  };

  // --- Sockets --------------------------------------------------------------------------------------------------------
  const socket = (bone: Bone, at: P, ax = 0): { bone: number; local: number[] } => {
    const p = B.local(bone, at);
    const c = Math.cos(ax), s = Math.sin(ax);
    return { bone: p.bone, local: [1, 0, 0, 0, c, s, 0, -s, c, p.at[0], p.at[1], p.at[2]] };
  };

  // --- Looks ----------------------------------------------------------------------------------------------------------
  const WINGS = ['#c58ce0', '#e08aa8', '#b493e0'].map(rgb);
  const RUGS = ['#b9532f', '#2f6a73', '#9b7a2a'].map(rgb);
  const look = (variant: number): FigureLook => {
    const v = Math.trunc(Math.abs(variant)) % 3;
    return { colors: [BACKS[v]!, WINGS[v]!, RUGS[v]!, WHITE], features: 0 };
  };

  const legOf = (S: Side, s: number, front: boolean): SteedLeg => {
    if (front) {
      return {
        chain: { upper: id[`arm${S}`], lower: id[`fore${S}`], end: id[`paw${S}`], bend: [0, 0, -s] },
        cannon: id[`wrist${S}`],
        hoof: id[`paw${S}`],
        fold: 0.08,
        flick: 0.15,
        foldIn: [0, 1],
        reach: [],
        // Ahead of the elbow and only a little above the shoulder: the arm runs nearly straight from the shoulder down
        // and out to the paw, bowed a little forward and up, so the fin slopes down from the body in one curve.
        pole: [3.2 * s * K, 0.75 * K, 2.2 * K],
        home: [2.7 * s * K, 0, 1.12 * K],
        endHeight: FORE_SOLE * K,
      };
    }
    const h = hind(s);
    return {
      chain: { upper: id[`thigh${S}`], lower: id[`shin${S}`], end: id[`foot${S}`], bend: [-1, 0, 0] },
      cannon: id[`ankle${S}`],
      hoof: id[`foot${S}`],
      fold: -0.7,
      flick: 0.5,
      foldIn: [0, 1],
      reach: [],
      pole: [1.0 * s * K, 0.45 * K, -0.2 * K],
      home: [h[3]![0] * K, 0, h[3]![2] * K],
      endHeight: HIND_SOLE * K,
    };
  };
  const tailBones = (S: Side): number[] => TAILS.map((_, k) => id[tailBone(S, k)]);

  return {
    name: 'glider',
    skeleton: B.skeleton,
    parts: B.parts(),
    motions: { stand, walk, trot, gallop },
    anchors: { head: B.local('head', [0, 0.85, 1.7]), seat: B.local('body', SEAT) },
    look,
    heightM: 1.0 * K,
    capacity: 2,
    shadowRangeM: 260,
    legs: {
      chains: [legOf('L', 1, true).chain, legOf('R', -1, true).chain, legOf('L', 1, false).chain, legOf('R', -1, false).chain],
      pelvis: id.body,
    },
    gaze: {
      bones: [id.chest, id.head],
      shares: [0.45, 0.55],
      eye: B.local('head', [0, 0.75, 1.75]).at,
      maxYaw: 22 * (Math.PI / 180),
      maxUp: 8 * (Math.PI / 180),
      maxDown: 10 * (Math.PI / 180),
    },
    lag: [
      { bones: tailBones('L'), end: [0, 0, -TAIL_LINK * K], stiffness: 40, damping: 6, gravity: 0.05, maxAngle: 0.35 },
      { bones: tailBones('R'), end: [0, 0, -TAIL_LINK * K], stiffness: 40, damping: 6, gravity: 0.05, maxAngle: 0.35 },
      { bones: [id.lantern], end: [0, -0.14 * K, 0], stiffness: 30, damping: 3.5, gravity: 0.6, maxAngle: 0.6 },
    ],
    sockets: {
      seat: socket('body', SEAT),
      gripL: socket('chest', GRIP, -0.5),
      gripR: socket('chest', [-GRIP[0], GRIP[1], GRIP[2]], -0.5),
      stirrupL: socket('body', STIRRUP),
      stirrupR: socket('body', [-STIRRUP[0], STIRRUP[1], STIRRUP[2]]),
    },
    steps: {
      legs: [legOf('L', 1, true), legOf('R', -1, true), legOf('L', 1, false), legOf('R', -1, false)],
      patterns: GLIDER_STEPS,
      stretch: [0, 0, 0],
      trunk: id.body,
      speeds: GLIDER_SPEEDS,
      minRate: GLIDER_MIN_RATE,
    },
    membrane,
    fly,
    crouch,
    face,
  };
}

/** A smooth curve through points (Catmull-Rom), sampled by its length: `at(t)` with t 0–1 from the first point to the last. */
interface Curve {
  readonly pts: readonly P[];
  readonly len: readonly number[];
  at(t: number): P;
  /** The share of the length at which the curve passes nearest to point `i` of the points it was made through. */
  readonly knots: readonly number[];
}
function curveThrough(ctrl: readonly P[], per = 24): Curve {
  const pts: P[] = [];
  const knotIdx: number[] = [];
  const n = ctrl.length;
  const c = (i: number): P => ctrl[Math.max(0, Math.min(n - 1, i))]!;
  for (let i = 0; i + 1 < n; i++) {
    knotIdx.push(pts.length);
    const p0 = c(i - 1), p1 = c(i), p2 = c(i + 1), p3 = c(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      const f = (j: number): number => 0.5 * (2 * p1[j]! + (-p0[j]! + p2[j]!) * t + (2 * p0[j]! - 5 * p1[j]! + 4 * p2[j]! - p3[j]!) * t2 + (-p0[j]! + 3 * p1[j]! - 3 * p2[j]! + p3[j]!) * t3);
      pts.push([f(0), f(1), f(2)]);
    }
  }
  knotIdx.push(pts.length);
  pts.push(ctrl[n - 1]!);
  const len: number[] = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1], pts[i]![2] - pts[i - 1]![2]));
  const total = len[len.length - 1]!;
  return {
    pts,
    len,
    knots: knotIdx.map((i) => len[i]! / total),
    at(t: number): P {
      const d = clamp01(t) * total;
      let k = 0;
      while (k + 2 < len.length && len[k + 1]! < d) k++;
      const s = (d - len[k]!) / Math.max(1e-9, len[k + 1]! - len[k]!);
      return lerp(pts[k]!, pts[k + 1]!, clamp01(s));
    },
  };
}
/** Distance from `p` to a curve in the ground plane (x, z), and the share of its length at the nearest point. */
function nearest(cv: Curve, p: P): [number, number] {
  let best = Infinity, at = 0;
  const total = cv.len[cv.len.length - 1]!;
  for (let i = 0; i + 1 < cv.pts.length; i++) {
    const a = cv.pts[i]!, b = cv.pts[i + 1]!;
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? clamp01(((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / l2) : 0;
    const d = Math.hypot(p[0] - (a[0] + dx * t), p[2] - (a[2] + dz * t));
    if (d < best) (best = d), (at = (cv.len[i]! + t * (cv.len[i + 1]! - cv.len[i]!)) / total);
  }
  return [best, at];
}

/**
 * The wings' skin. Each wing is a patch spanned between three curves: the root along the flank (from the shoulder back
 * to the rear of the flank), the leading edge (from the shoulder over the elbow, the wrist and the paw out to the
 * point) and the trailing edge (from the point back in to the rear of the flank, scalloped between the bands). A
 * column of the patch runs from the root out to the trailing edge (a Coons patch: near the leading edge the columns
 * bend along it), so the bands run out from the flank and curve toward the point; each band is three columns (light,
 * light, soft edge; dark, dark, soft edge), so its tone changes only along mesh lines. The patch is lofted twice, a
 * cambered top and a fuller underside, as far apart as a thick fin at the root, thicker along the leading edge (the
 * arm), thinning to the rim; a row of corners just outside the rim closes the edge between them.
 *
 * A corner's bones: the trunk near the flank; along the leading edge the arm, the forearm, the wrist and the point by
 * where it lies along the span; the `fin` bone more toward the trailing edge of the inner and middle fin (so the
 * trailing edge lags the arm in the beat and lies down behind it on the ground); and the paw in a patch round the
 * hand. At most three, the largest.
 */
function buildMembrane(B: Bones<Bone>, wing: (s: number) => P[], flank: (z: number) => P, tail: TailShape, backs: readonly RGB[]): GliderMembrane {
  const corners: number[][] = [];
  const triangles: number[] = [];
  /** Rows from the root (0) to the trailing edge (1). */
  const ROWS = [0, 0.07, 0.16, 0.27, 0.39, 0.51, 0.63, 0.74, 0.83, 0.9, 0.95, 0.983, 1];
  /** Bands across the fin, and the leading edge's own strip. */
  const NB = 11;
  const LEAD_U = 0.03;
  const COLS: number[] = [0, LEAD_U];
  for (let b = 0; b < NB; b++) for (let k = 1; k <= 3; k++) COLS.push(LEAD_U + ((1 - LEAD_U) * (b + k / 3)) / NB);
  /** Half the fin's thickness at the root, m (as written). */
  const ROOT_H = 0.2;
  /** Camber of the fin's middle, m. */
  const CAMBER = 0.075;
  for (const [S, s] of [['L', 1], ['R', -1]] as const) {
    const [sh, el, wr, pw, pt] = wing(s) as [P, P, P, P, P];
    const side = (p: P): P => [p[0] * s, p[1], p[2]];
    // The root starts on the chest ahead of the shoulder, so the leading edge sweeps out of the flank.
    const ROOT_Z = [1.12, 0.95, 0.55, 0.15, -0.25, -0.65, -0.98];
    const root = curveThrough(ROOT_Z.map((z) => side(flank(z))));
    const S0 = root.at(0), Rr = root.at(1);
    const lead = curveThrough([S0, [sh[0] + 0.25 * s, sh[1] + 0.02, sh[2] - 0.02], el, wr, pw, [3.6 * s, 0.63, -0.38], pt]);
    const [, fe, fw, fp] = lead.knots.slice(1) as [number, number, number, number];
    const trailPts: P[] = [
      pt,
      [3.55 * s, 0.645, -1.2],
      [3.1 * s, 0.62, -1.0],
      [2.65 * s, 0.6, -0.91],
      [2.2 * s, 0.58, -0.9],
      [1.7 * s, 0.56, -0.96],
      [1.2 * s, 0.54, -1.05],
      [0.8 * s, 0.53, -1.11],
      Rr,
    ];
    const trail = curveThrough(trailPts);
    /** Leading thickness at a share of the leading edge: full at the shoulder (the arm), thin at the point. */
    const LEAD_H: [number, number][] = [[0, 0.22], [fe, 0.16], [fw, 0.115], [fp, 0.105], [1, 0.014]];
    const leadH = (t: number): number => {
      let k = 0;
      while (k + 2 < LEAD_H.length && LEAD_H[k + 1]![0] < t) k++;
      const a = LEAD_H[k]!, b = LEAD_H[k + 1]!;
      return mixN(a[1], b[1], smooth((t - a[0]) / (b[0] - a[0])));
    };
    /** Where a column ends on the trailing edge: denser toward the point, and scalloped in between the bands. */
    const trailU = (u: number): P => {
      const t = u ** 1.15;
      const p = trail.at(t);
      const f = u <= LEAD_U ? 0 : ((u - LEAD_U) / (1 - LEAD_U)) * NB;
      const inBand = f - Math.floor(f);
      const q = root.at(u);
      const dx = q[0] - p[0], dz = q[2] - p[2], l = Math.hypot(dx, dz) || 1;
      const a = 0.032 * Math.sin(Math.PI * inBand) * Math.min(1, l / 0.9) * (u < 0.95 ? 1 : 0);
      return [p[0] + (dx / l) * a, p[1], p[2] + (dz / l) * a];
    };
    /** The fin's middle surface at (u, v): a Coons patch between root, leading edge and trailing edge, cambered. */
    const midAt = (u: number, v: number): P => {
      const R = root.at(u), T = trailU(u), Lv = lead.at(v);
      const o: number[] = [0, 0, 0];
      for (let j = 0; j < 3; j++) {
        o[j] = (1 - v) * R[j]! + v * T[j]! + (1 - u) * Lv[j]! + u * Rr[j]! - ((1 - u) * (1 - v) * S0[j]! + (1 - u) * v * pt[j]! + u * Rr[j]!);
      }
      o[1] = o[1]! + CAMBER * Math.sin(Math.PI * v) * step01(0, 0.22, u) * (1 - u) ** 0.6;
      return [o[0]!, o[1]!, o[2]!];
    };
    /** Half thickness at (u, v). */
    const half = (u: number, v: number): number => {
      const body = ROOT_H * (1 - v) ** 1.5 * (1 - 0.45 * u);
      const edge = leadH(v) * (1 - step01(0.03, 0.17, u));
      // Rounded to the leading edge like the nose of a foil: thinner on the edge itself, full a little behind it.
      const nose = 0.52 + 0.48 * step01(0, 0.06, u);
      return (Math.max(body, edge) + 0.008 * (1 - v)) * nose;
    };
    const trunkBone = (z: number): Bone => (z > 0.7 ? 'chest' : z < -0.65 ? 'hips' : 'body');
    const paw: P = side(pw);
    /** One corner at `p`, weighted from the rest middle `m`. */
    const corner = (p: P, m: P): number => {
      const [dl, sg] = nearest(lead, m);
      const [dt] = nearest(trail, m);
      const [dr] = nearest(root, m);
      const c = dl / (dl + dt + 1e-6);
      // Along the span: the leading edge's bones.
      const fArm = 1 - step01(fe - 0.13, fe + 0.13, sg);
      const fFore = step01(fe - 0.13, fe + 0.13, sg) * (1 - step01(fw - 0.05, fw + 0.05, sg));
      const fWrist = step01(fw - 0.05, fw + 0.05, sg) * (1 - step01(fp - 0.015, fp + 0.04, sg));
      const fTip = step01(fp - 0.015, fp + 0.04, sg);
      // Across the chord: the trailing part of the inner and middle fin on the fin bone.
      const fin = 0.9 * step01(0.12, 0.85, c) * (1 - step01(0.42, 0.78, sg));
      const tw = 1 - step01(0.03, 0.5, dr);
      const dp = Math.hypot(m[0] - paw[0], m[1] - paw[1], m[2] - paw[2]);
      const pwW = 0.75 * (1 - step01(0.1, 0.4, dp));
      const rest = (1 - tw) * (1 - pwW);
      const raw: [Bone, number][] = [
        [trunkBone(m[2]), tw],
        [`paw${S}`, (1 - tw) * pwW],
        [`fin${S}`, rest * fin],
        [`arm${S}`, rest * (1 - fin) * fArm],
        [`fore${S}`, rest * (1 - fin) * fFore],
        [`wrist${S}`, rest * (1 - fin) * fWrist],
        [`tip${S}`, rest * (1 - fin) * fTip],
      ];
      const kept = raw.filter((r) => r[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 3);
      let sum = 0;
      for (const r of kept) sum += r[1];
      const out: number[] = [];
      for (const [b, w] of kept) {
        const l = B.local(b, p);
        out.push(l.bone, w / sum, l.at[0], l.at[1], l.at[2]);
      }
      corners.push(out);
      return corners.length - 1;
    };
    const NU = COLS.length, NV = ROWS.length;
    const mids: P[][] = COLS.map((u) => ROWS.map((v) => midAt(u, v)));
    const tops: number[][] = [], bots: number[][] = [];
    COLS.forEach((u, i) => {
      tops.push(ROWS.map((v, j) => {
        const m = mids[i]![j]!;
        return corner([m[0], m[1] + 0.8 * half(u, v), m[2]], m);
      }));
      bots.push(ROWS.map((v, j) => {
        const m = mids[i]![j]!;
        return corner([m[0], m[1] - half(u, v), m[2]], m);
      }));
    });
    /** A triangle wound so that its top faces along `want` in the rest pose (dropped if it has no area). */
    const tri = (a: number, b: number, c: number, tone: number, want: P): void => {
      const pa = restOf(B, corners[a]!), pb = restOf(B, corners[b]!), pc = restOf(B, corners[c]!);
      const n = cross(sub(pc, pa), sub(pb, pa));
      if (Math.hypot(n[0], n[1], n[2]) < 1e-7) return;
      if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] >= 0) triangles.push(a, b, c, tone);
      else triangles.push(a, c, b, tone);
    };
    const UP: P = [0, 1, 0], DOWN: P = [0, -1, 0];
    // Tones: 0 inner, 1 base, 2 light, 3 dark, 4 rim, 5 outer light, 6 outer dark, 7 leading edge, 8 underside,
    // 9 a band's soft edge, 10 an outer band's soft edge.
    const BAND = [2, 2, 9, 3, 3, 9];
    const OUTER = [5, 5, 10, 6, 6, 10];
    const toneOf = (i: number, j: number): number => {
      const v = (ROWS[j]! + ROWS[j + 1]!) / 2;
      if (v > 0.94) return 4;
      if (i === 0) return v < 0.12 ? 0 : 7;
      if (j === 0) return 0;
      if (j === 1) return 1;
      const k = (i - 1) % 6;
      return v > 0.72 ? OUTER[k]! : BAND[k]!;
    };
    for (let i = 0; i + 1 < NU; i++) {
      for (let j = 0; j + 1 < NV; j++) {
        const tone = toneOf(i, j);
        const A = tops[i]!, Bn = tops[i + 1]!, C = bots[i]!, D = bots[i + 1]!;
        // Split each cell along the same diagonal on the top and the underside.
        tri(A[j]!, Bn[j]!, Bn[j + 1]!, tone, UP);
        tri(A[j]!, Bn[j + 1]!, A[j + 1]!, tone, UP);
        const under = ROWS[j + 1]! > 0.95 ? 4 : j < 2 || i === 0 ? 8 : tone;
        tri(C[j]!, D[j]!, D[j + 1]!, under, DOWN);
        tri(C[j]!, D[j + 1]!, C[j + 1]!, under, DOWN);
      }
    }
    // The rim: along the leading edge (column 0, from the root out) and on along the trailing edge (the last row, from
    // the point in), a row of corners just outside it, closing the top to the underside.
    const rim: { i: number; j: number }[] = [];
    for (let j = 0; j < NV; j++) rim.push({ i: 0, j });
    for (let i = 1; i < NU; i++) rim.push({ i, j: NV - 1 });
    const noses = rim.map(({ i, j }) => {
      const m = mids[i]![j]!;
      const inner = j === NV - 1 && i > 0 ? mids[i]![j - 1]! : mids[1]![j]!;
      let dx = m[0] - inner[0], dz = m[2] - inner[2];
      if (i === 0 && j === NV - 1) (dx = m[0] - mids[1]![j - 1]![0]), (dz = m[2] - mids[1]![j - 1]![2]);
      const l = Math.hypot(dx, dz) || 1;
      const h = half(COLS[i]!, ROWS[j]!);
      const out = Math.min(0.13, h * 0.95 + 0.006);
      return corner([m[0] + (dx / l) * out, m[1] - 0.1 * h, m[2] + (dz / l) * out], m);
    });
    for (let k = 0; k + 1 < rim.length; k++) {
      const p = rim[k]!, q = rim[k + 1]!;
      const mp = mids[p.i]![p.j]!, mq = mids[q.i]![q.j]!;
      const inner = mids[Math.min(NU - 1, Math.max(1, p.i))]![Math.max(0, Math.min(NV - 2, p.j))]!;
      const outward: P = [(mp[0] + mq[0]) / 2 - inner[0], 0, (mp[2] + mq[2]) / 2 - inner[2]];
      const onTrailing = p.j === NV - 1 && q.j === NV - 1;
      const edge = onTrailing || ROWS[p.j]! > 0.8 ? 4 : 7;
      const At = tops[p.i]![p.j]!, Bt = tops[q.i]![q.j]!, Cb = bots[p.i]![p.j]!, Db = bots[q.i]![q.j]!;
      tri(At, noses[k]!, noses[k + 1]!, edge, outward);
      tri(At, noses[k + 1]!, Bt, edge, outward);
      // Under the leading edge the pale of the underside.
      const below = edge === 7 ? 8 : edge;
      tri(Cb, noses[k]!, noses[k + 1]!, below, outward);
      tri(Cb, noses[k + 1]!, Db, below, outward);
    }
  }
  tailSkin(B, corners, triangles, tail);
  const tones = MEMBRANE_TONES.map((w, v): RGB[] => {
    const back = backs[v]!;
    const steps = Array.from({ length: tail.links }, (_, k): RGB => (k === 0 ? back : k === 1 ? lerp(back, TAIL_LILAC, 0.55) : lerp(TAIL_LILAC, TAIL_PINK, (k - 2) / (tail.links - 3))));
    return [...w, back, BELLY, ...steps];
  });
  return {
    corners,
    triangles,
    tones: (variant) => tones[Math.trunc(Math.abs(variant)) % 3]!,
  };
}

/** The tail's joints: the base's, where it forks, a filament's joint `k` on side `s`, and how many links a filament has. */
interface TailShape {
  readonly stemAt: readonly P[];
  readonly forkZ: number;
  at(s: number, k: number): P;
  readonly links: number;
}
/** First tone of the tail in a look's tones: the back, then the belly, then the steps along a filament. */
const TAIL_TONE = 11;

/**
 * The tail's skin: the base as one tube from the rump to the fork and each filament as a tube from inside the base's
 * end to its point. A ring on a joint follows the bones on both sides of it half and half, a ring between two joints
 * its own bone, so the tubes bend smoothly.
 */
function tailSkin(B: Bones<Bone>, corners: number[][], triangles: number[], t: TailShape): void {
  const corner = (p: P, bones: readonly Bone[]): number => {
    const out: number[] = [];
    for (const b of bones) {
      const l = B.local(b, p);
      out.push(l.bone, 1 / bones.length, l.at[0], l.at[1], l.at[2]);
    }
    corners.push(out);
    return corners.length - 1;
  };
  interface Ring { c: P; ids: number[] }
  const ring = (c: P, rx: number, ry: number, n: number, bones: readonly Bone[]): Ring => ({
    c,
    ids: Array.from({ length: n }, (_, k) => {
      const a = ((k + 0.5) / n) * TAU;
      return corner([c[0] + Math.cos(a) * rx, c[1] + Math.sin(a) * ry, c[2]], bones);
    }),
  });
  /** A triangle facing away from `from`; on the base its tone is the belly's where it faces down. */
  const tri = (a: number, b: number, c: number, tone: number, from: P, belly: boolean): void => {
    const pa = restOf(B, corners[a]!), pb = restOf(B, corners[b]!), pc = restOf(B, corners[c]!);
    let n = cross(sub(pc, pa), sub(pb, pa));
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-9) return;
    const m: P = [(pa[0] + pb[0] + pc[0]) / 3 - from[0], (pa[1] + pb[1] + pc[1]) / 3 - from[1], (pa[2] + pb[2] + pc[2]) / 3 - from[2]];
    const outward = n[0] * m[0] + n[1] * m[1] + n[2] * m[2] >= 0;
    if (!outward) n = [-n[0], -n[1], -n[2]];
    const tn = belly && n[1] / l < -0.55 ? TAIL_TONE + 1 : tone;
    if (outward) triangles.push(a, b, c, tn);
    else triangles.push(a, c, b, tn);
  };
  const tube = (rings: readonly Ring[], tone: (i: number) => number, belly: boolean): void => {
    for (let i = 0; i + 1 < rings.length; i++) {
      const A = rings[i]!, C = rings[i + 1]!;
      const mid = lerp(A.c, C.c, 0.5);
      const n = A.ids.length;
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        tri(A.ids[k]!, A.ids[k1]!, C.ids[k1]!, tone(i), mid, belly);
        tri(A.ids[k]!, C.ids[k1]!, C.ids[k]!, tone(i), mid, belly);
      }
    }
  };
  const cap = (r: Ring, apex: P, bones: readonly Bone[], tone: number, belly: boolean): void => {
    const a = corner(apex, bones);
    const n = r.ids.length;
    for (let k = 0; k < n; k++) tri(r.ids[k]!, r.ids[(k + 1) % n]!, a, tone, r.c, belly);
  };
  // The base: from the rump (on the hips) over its three joints to the fork, closed by a rounded end.
  const [j1, j2, j3] = t.stemAt as [P, P, P];
  const y = j1[1];
  const at = (z: number): P => [0, y, z];
  const NS = 10;
  const base: Ring[] = [
    ring(j1, 0.2, 0.158, NS, ['hips']),
    ring(at((j1[2] + j2[2]) / 2), 0.152, 0.126, NS, ['stem1']),
    ring(j2, 0.119, 0.102, NS, ['stem1', 'stem2']),
    ring(at((j2[2] + j3[2]) / 2), 0.1, 0.088, NS, ['stem2']),
    ring(j3, 0.086, 0.078, NS, ['stem2', 'stem3']),
    ring(at((j3[2] + t.forkZ) / 2), 0.076, 0.069, NS, ['stem3']),
    ring(at(t.forkZ + 0.02), 0.07, 0.062, NS, ['stem3']),
    ring(at(t.forkZ - 0.03), 0.045, 0.04, NS, ['stem3']),
  ];
  tube(base, () => TAIL_TONE, true);
  cap(base[base.length - 1]!, at(t.forkZ - 0.05), ['stem3'], TAIL_TONE, true);
  // The filaments: lilac to pink toward their points.
  const NF = 6;
  const rad = (u: number): number => 0.012 + 0.046 * (1 - clamp01(u)) ** 1.4;
  for (const [S, s] of [['L', 1], ['R', -1]] as const) {
    const bone = (k: number): Bone => `tail${S}${(k + 1) as TailN}`;
    const j0 = t.at(s, 0);
    const rings: Ring[] = [ring([j0[0] * 0.6, y, t.forkZ + 0.08], 0.05, 0.05, NF, ['stem3'])];
    for (let k = 0; k < t.links; k++) {
      rings.push(ring(t.at(s, k), rad(k / t.links), rad(k / t.links), NF, [k === 0 ? 'stem3' : bone(k - 1), bone(k)]));
      rings.push(ring(t.at(s, k + 0.5), rad((k + 0.5) / t.links), rad((k + 0.5) / t.links), NF, [bone(k)]));
    }
    const endBone = [bone(t.links - 1)];
    rings.push(ring(t.at(s, t.links), rad(1), rad(1), NF, endBone));
    tube(rings, (i) => TAIL_TONE + 2 + Math.min(t.links - 1, Math.max(0, Math.floor((i - 1) / 2))), false);
    cap(rings[rings.length - 1]!, add(t.at(s, t.links), [0, 0, -0.14]), endBone, TAIL_TONE + 2 + t.links - 1, false);
  }
}

/**
 * Tones of the wings per look: inner, base, light band, dark band, rim, outer light, outer dark, leading edge,
 * underside, a band's soft edge, an outer band's soft edge.
 */
const MEMBRANE_TONES: readonly (readonly RGB[])[] = [
  ['#3a2c92', '#6a50bf', '#c89be6', '#9468cc', '#ff7cc0', '#eab4ee', '#c58ad8', '#8468d2', '#b29cda', '#ae82da', '#d9a0e3'].map(rgb),
  ['#2a3884', '#7f5cac', '#ecaccb', '#c47ca8', '#ff7a92', '#f6c2d8', '#e094bc', '#8470c4', '#d0a4c0', '#d894ba', '#ebaac9'].map(rgb),
  ['#4c2874', '#7a5cbc', '#d0b8f4', '#a084da', '#f58ac8', '#e4d2f6', '#bea4ea', '#9074cc', '#b8a2dc', '#b89ee7', '#d1bbf0'].map(rgb),
];

/** A corner's rest position from its first influence (the figure's rest frame, as written). */
function restOf(B: Bones<Bone>, c: readonly number[]): P {
  const r = B.rest[c[0]!]!;
  return [r[0] + c[2]! / GLIDER_SIZE, r[1] + c[3]! / GLIDER_SIZE, r[2] + c[4]! / GLIDER_SIZE];
}

/** The kind with what its legs need for `QuadGait`, its membrane and its pose in the air. */
export type GliderKind = ReturnType<typeof glider>;

export const GLIDERS = { glider } as const;
