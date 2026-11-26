// The steed: a slender runner on four long legs, half fox, half antelope, built for the gallop. A deep chest with broad
// shoulders, a waist tucked up behind it and a full croup whose haunches run down into the thighs; a short thick neck
// carried forward; a fox's head (a round skull, wide cheeks, a clear stop, a long fine muzzle to a small dark nose,
// almond eyes seated on the flat sides of the skull, a lower jaw that opens on a dark mouth with small teeth and a
// tongue); instead of ears two long narrow leaf feathers swept back, and a long curved tail, thick at the root,
// that ends in two leaves of the same kind. A russet coat over cream under the belly, on the breast, the throat and the
// jaw and down the inside and the back of the legs (one skin, two tones by the faces' place, parted along one clean
// low-poly edge), small dark paws of two toes. Saddled with a woven rug (a
// zigzag band, tassels), a braided rope harness round the chest and the neck with two rope handles for the rider,
// rope stirrup loops, and a lit lantern hung from the rug's front corner.
//
// Shapes in metres in the rest pose (authored at `SIZE` 1, the whole figure scaled by it): x to the animal's left, y
// up, z forward; the root stands on the ground under the middle of the body. At `SIZE` 1 the withers are at about
// 1.45 m, the trunk 2.2 m from the breast to the buttock, 0.78 m deep and 0.56 m wide at the girth, 3.1 m from the
// nose to the buttock, the tail 1.55 m and its leaves another 0.6 m: long enough that the 1.7 m pathfinder sits on it
// small, its seat on the rug behind the withers.
//
// Bones. The trunk is four: `body` (the middle, under the rug) carries `chest` (withers, front legs, neck) and `loin`,
// which carries `croup` (hips, hind legs, tail), so the back rounds and stretches over two joints in the gallop. The
// neck is two bones, then the head with a leaf feather of two bones on each side, the lower jaw (`jaw`), the tongue
// on it (`tongue`, `tongue2`) and an eyelid over each eye (`lidL`, `lidR`, made open and turned shut). The legs are built like a cursorial
// runner's (an antelope's, a greyhound's), both pairs alike below the knee. A fore leg: the shoulder blade (`blade`,
// sloping forward and down from the withers to the point of the shoulder, swung by the gait), the upper arm back to
// an elbow under the chest (the shoulder over it is the chest's own surface), a muscled forearm tapering to the carpus (at about 0.33 m), the cannon to the fetlock, a
// sloped pastern and the paw. A hind leg: the thigh out of the haunch (the croup's own surface) forward and down to a stifle at the belly line,
// the gaskin back to a hock at about 0.42 m, a near-vertical cannon, the pastern and the paw. Under each paw a `toe`
// bone where the paw turns when the heel rises. The reach of a leg (`TwoBoneChain`) goes from the shoulder joint or
// the hip through the elbow or stifle to the toe (`SteedKind.steps.legs`): the carpus or hock is folded before the
// reach (in the swing), the fetlock flicks in the swing and gives under the weight in the stance, the heel rises as
// the leg trails, and the reach takes the folded leg as it is. The tail is five bones and a `tuft` for its leaves; the
// feathers, the tail, its tuft, the lantern and the three big tassels of the rug (`tasselFR`, `tasselHL`, `tasselHR`)
// are chains of the engine's `ChainLag` (`lag`).
//
// The legs are not keyframed: `QuadGait` (quad-gait.ts) steps them with the engine's `StepCycle` in the patterns of
// `STEED_STEPS` and lowers and tilts the trunk onto the ground under the paws; at a gallop a swinging leg also reaches
// out beyond its path (`SteedLeg.reach`: the fore legs far forward and up before they land, the hind legs far back
// after they push off), so the flight after the hind legs is the full stretch. The motions here move the trunk, neck,
// head, feathers, tail and lantern: `stand` on the clock (breathing, a shift of weight, a look aside now and then, a
// flick of a feather or of the tail at times drawn from named hash streams) and `walk`, `trot`, `gallop` on the phase
// of the step cycle (`unit: 'phase'`), each in step with its own pattern of footfalls. On top of them `steps.life`
// moves the face and the breath from the state `QuadGait` keeps over the simulation's time (`SteedLife`): the mouth
// shut when calm; open with the tongue out once the animal has worked (in the gallop with the stride, panting with
// the breath afterwards until the effort has gone); standing rested, a yawn or a lick of the nose now and then; blinks
// (all three at times drawn from named hash streams).
//
// Sockets: `seat` (on the rug, the carried body's place: its left, up and forward are the animal's), `gripL` and
// `gripR` (the ends of the rope handle), `stirrupL` and `stirrupR` (where a rider's ankle rests in the rope loop, a
// foot pointing forward). Looks: four coats (russet, ash, dark chestnut, sand) with their feathers and rugs; variant
// 4 and up a combination of them.

import { hashInts, unit } from 'wallhammer-web/gen-core';
import type { StepPattern, TwoBoneChain } from 'wallhammer-web/motion';
import { Bones, TAU, shift, smooth, turn } from './kind.ts';
import type { FigureKind, FigureLook, FigureMotion } from './kind.ts';
import { FigureMesh, MAT, add, cross, lerp, mul, norm, ringOn, rgb, sub } from './mesh.ts';
import type { FaceTone, P, RGB } from './mesh.ts';

type Leg = 'FL' | 'FR' | 'HL' | 'HR';
type Bone =
  | 'root' | 'body' | 'chest' | 'loin' | 'croup' | 'neck' | 'neck2' | 'head'
  | 'jaw' | 'tongue' | 'tongue2' | 'lidL' | 'lidR'
  | 'featherL' | 'featherL2' | 'featherR' | 'featherR2'
  | 'tail' | 'tail2' | 'tail3' | 'tail4' | 'tail5' | 'tuft' | 'lantern' | `tassel${'FR' | 'HL' | 'HR'}`
  | `blade${'FL' | 'FR'}` | `upper${Leg}` | `lower${Leg}` | `cannon${Leg}` | `pastern${Leg}` | `hoof${Leg}` | `toe${Leg}`;

/** The whole steed's size against its authored shapes (joints, parts, sockets, homes and strides scale with it). */
const SIZE = 1.35;

/** Colour slots of a look. */
const SLOT = { coat: 0, feather: 1, rug: 2, trim: 3 } as const;

const WHITE: RGB = [1, 1, 1];
const CREAM = rgb('#f0d6a8');
const HOOF = rgb('#2b211d');
const NOSE = rgb('#211714');
const EYE = rgb('#1a110e');
const EYE_RIM = rgb('#f3e8d2');
const MOUTH = rgb('#4a1a1c');
const TONGUE = rgb('#d0677a');
const TOOTH = rgb('#f3ead8');
const TAIL_TIP = rgb('#5c2c18');
const ROPE = rgb('#cfa86c');
const ROPE_DARK = rgb('#8d6a3f');
const RUG_LIGHT = rgb('#ebc888');
const RUG_DARK = rgb('#3a2219');
const TASSEL = rgb('#d99a3a');
const PAD = rgb('#563321');
const IRON = rgb('#3a2a21');
const BRASS = rgb('#c99a45');
const GLASS: RGB = [0.56, 0.27, 0.04];
const GLASS_CORE: RGB = [0.8, 0.62, 0.3];
/** The underside of a leaf feather against its top (both tinted by the look's feather colour). */
const LEAF_UNDER: RGB = [1.55, 1.6, 1.45];
const LEAF_RIB = rgb('#b4d8c2');

/** The steed's speeds (m/s) the patterns of `STEED_STEPS` belong to. */
export interface SteedSpeeds {
  walk: number;
  trot: number;
  gallop: number;
}
/** The one source of the steed's speeds: its patterns, its walker (examples' ride.ts) and its rider's seat motions. */
export const STEED_SPEEDS: Readonly<SteedSpeeds> = { walk: 1.7, trot: 3.8, gallop: 9 };

/** Speed ranges ([lowest, ideal, highest], m/s) of motions for standing and for the three gaits at the speeds `s`. */
export function gaitBands(s: Readonly<SteedSpeeds>): { still: readonly [number, number, number]; walk: readonly [number, number, number]; trot: readonly [number, number, number]; gallop: readonly [number, number, number] } {
  const wt = (s.walk + s.trot) / 2, tg = (s.trot + s.gallop) / 2;
  return { still: [0, 0, 0.35 * s.walk], walk: [0.35 * s.walk, s.walk, wt], trot: [wt, s.trot, tg], gallop: [tg, s.gallop, 1.5 * s.gallop] };
}

/** Ways of stepping of the steed, for the engine's `StepCycle` (legs in the order front left, front right, hind left, hind right). */
export const STEED_STEPS: readonly StepPattern[] = [
  // Walk: four beats, one hoof at a time (hind left, front left, hind right, front right), three hooves mostly down.
  { speed: STEED_SPEEDS.walk, stride: 1.3 * SIZE, offsets: [0.25, 0.75, 0, 0.5], duty: 0.63, lift: [0.12 * SIZE, 0.12 * SIZE, 0.1 * SIZE, 0.1 * SIZE] },
  // Trot: the diagonal pairs together, a short moment of flight between them.
  { speed: STEED_SPEEDS.trot, stride: 2.35 * SIZE, offsets: [0, 0.5, 0.5, 0], duty: 0.42, lift: [0.2 * SIZE, 0.2 * SIZE, 0.17 * SIZE, 0.17 * SIZE] },
  // Gallop, rotary with two flights: front left, front right, a gathered flight with the legs under the body, hind
  // right, hind left, then the stretched flight with the fore legs reaching forward and the hind legs trailing.
  { speed: STEED_SPEEDS.gallop, stride: 4.1 * SIZE, offsets: [0, 0.08, 0.53, 0.45], duty: 0.24, lift: [0.3 * SIZE, 0.3 * SIZE, 0.26 * SIZE, 0.26 * SIZE] },
];
/** Per pattern of `STEED_STEPS` the share of the legs' stretch and late fold it uses (the gallop's). */
const STRETCH_SHARE: readonly number[] = [0, 0, 1];
/** Per pattern of `STEED_STEPS` the share of the carpus' and hock's fold: a walk lifts its feet lower than a trot. */
const FOLD_SHARE: readonly number[] = [0.62, 1, 1];

/** One leg of the steed in `SteedKind.steps.legs`. */
export interface SteedLeg {
  /**
   * Pivot → elbow (stifle) → the leg's end, for the reach: the hoof, or a toe bone below it (a child of `hoof` at the
   * front of the foot) for a leg that stands on its toe; such a leg is reached at the hoof's joint, the toe kept on
   * its target as the hoof turns.
   */
  chain: TwoBoneChain;
  /** The bone whose joint is the carpus (hock): turned to fold the leg in its swing. */
  cannon: number;
  /** The hoof (the chain's end, or the toe's parent): kept level with the ground under it. */
  hoof: number;
  /** Fold of the carpus (hock) at the fullest of the swing, radians about the leg's x (+ the hoof back, − forward). */
  fold: number;
  /** Fold of the fetlock at the fullest of the swing, radians. */
  flick: number;
  /** At a full stretch the share of the swing (from, to) the carpus (hock) folds within; outside it the leg is straight. */
  foldIn: readonly [number, number];
  /**
   * At a full stretch (the gallop) how far the end reaches beyond its swing's path: each lobe from `from` to `to` of
   * the swing, fullest at `at`, by `d` (m forward (+) and up). Zero at both ends of a lobe, so the end still lifts and
   * lands where the cycle puts it.
   */
  reach: readonly SteedReach[];
  /** Where the elbow (stifle) turns, in the animal's frame. */
  pole: P;
  /** Where the hoof rests under the body, in the animal's frame (x, 0, z). */
  home: P;
  /** Height of the chain's end above the ground while the hoof stands. */
  endHeight: number;
  /**
   * The pastern (the bone between the cannon and the hoof, its joint the fetlock), when the leg has one: it takes the
   * fetlock's fold in the swing (`flick`, the hoof following it) and gives under the weight in the stance (`give`).
   */
  pastern?: number;
  /** How far the fetlock gives (sinks, the pastern toward level) in the middle of a stance at the walk, radians. */
  give?: number;
  /** Where the fold of the carpus (hock) rises from, is fullest and is gone again, shares of the swing (not at a stretch). Default [0, 0.5, 1]. */
  swingFold?: readonly [number, number, number];
  /** The shoulder blade: a bone above the pivot turned by `share` of the leg's angle forward or back from its pivot. */
  blade?: { readonly bone: number; readonly share: number };
  /**
   * The heel's rise about the toe (a leg whose chain ends at a toe below the hoof): `lift` radians once the leg's angle
   * from under its pivot is `to` behind it, nothing ahead of `from` (radians, − behind), eased between. It carries on
   * into the swing, so the paw peels off the ground and is not snapped from flat to folded.
   */
  heel?: { readonly lift: number; readonly from: number; readonly to: number };
  /**
   * A swinging end out of reach is raised toward the pivot's height (the leg reaches out level) instead of pulled in
   * toward the pivot, and the reach is the chain's as it is folded now, not its rest length.
   */
  liftClamp?: boolean;
}

/** One lobe of a leg's reach beyond its swing's path (`SteedLeg.reach`). */
export interface SteedReach {
  from: number;
  at: number;
  to: number;
  d: readonly [number, number];
}

/** What the steps of the kind need (`QuadGait`). */
export interface SteedSteps {
  legs: readonly SteedLeg[];
  patterns: readonly StepPattern[];
  /** Per pattern the share of the legs' stretch and late fold it uses. */
  stretch: readonly number[];
  /** The bone lowered and tilted onto the ground under the hooves. */
  trunk: number;
  speeds: Readonly<SteedSpeeds>;
  /** Fewest passes a second of the step cycle while a leg has to move (`StepCycleDesc.minRate`). Default 1.2. */
  minRate?: number;
  /** Per pattern the share of the legs' fold (`SteedLeg.fold`, `flick`) it uses. Default 1 for all. */
  foldShare?: readonly number[];
  /**
   * What the kind does on top of its motions each frame, from the state `QuadGait` keeps over time (the face: the jaw,
   * the tongue, the eyelids; the breath). It adds to the pose the motions made. Optional.
   */
  life?: (pose: MotionPose, s: Readonly<SteedLife>) => void;
}

type MotionPose = Parameters<FigureMotion['sample']>[0];

/** The state `SteedSteps.life` is a pure function of. All of it is advanced by the simulation's steps only. */
export interface SteedLife {
  /** Seconds since the gait was reset. */
  time: number;
  /** How hard the animal has been working, 0 (rested) to 1 (after a long gallop): rises with fast going, falls slowly at rest. */
  effort: number;
  /** The breath, in breaths (its fraction is the phase of one breath); faster with effort. */
  breath: number;
  /** Ground speed, smoothed, m/s. */
  speed: number;
  /** The step cycle's phase, 0–1 a pass. */
  phase: number;
  /** The gait's seed (`QuadGaitOptions.seed`). */
  seed: number;
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const mixN = (a: number, b: number, t: number): number => a + (b - a) * t;

function steed(): FigureKind & { readonly steps: SteedSteps } {
  // --- Skeleton -------------------------------------------------------------------------------------------------------
  /**
   * Rest joints of a fore leg on side `s` (+1 left): the shoulder blade's turning point high on the ribs (the blade
   * slopes forward and down from the withers to the point of the shoulder; it turns about a point above the shoulder,
   * so the shoulder slides forward and back without rising), the point of the shoulder at the front of the chest, the
   * elbow back under the chest's floor, the carpus, the fetlock, the joint above the paw, the toe (where the paw
   * pivots when the heel rises; the leg's reach ends there).
   */
  const front = (s: number): P[] => [[0.16 * s, 1.3, 0.6], [0.225 * s, 1.0, 0.8], [0.2 * s, 0.68, 0.56], [0.16 * s, 0.33, 0.6], [0.155 * s, 0.115, 0.605], [0.155 * s, 0.05, 0.645], [0.155 * s, 0.008, 0.705]];
  /** Rest joints of a hind leg: the hip, the stifle forward under the flank, the hock, the fetlock, the paw, the toe. */
  const hind = (s: number): P[] => [[0.16 * s, 1.12, -0.88], [0.2 * s, 0.75, -0.63], [0.155 * s, 0.42, -0.98], [0.15 * s, 0.115, -0.955], [0.15 * s, 0.05, -0.915], [0.15 * s, 0.008, -0.86]];
  const legBones = (leg: Leg, parent: Bone, at: P[]): (readonly [Bone, Bone, P])[] => {
    const fore = leg === 'FL' || leg === 'FR';
    const k = fore ? 1 : 0;
    const top: (readonly [Bone, Bone, P])[] = fore ? [[`blade${leg as 'FL' | 'FR'}`, parent, at[0]!]] : [];
    return [
      ...top,
      [`upper${leg}`, fore ? `blade${leg as 'FL' | 'FR'}` : parent, at[k]!],
      [`lower${leg}`, `upper${leg}`, at[k + 1]!],
      [`cannon${leg}`, `lower${leg}`, at[k + 2]!],
      [`pastern${leg}`, `cannon${leg}`, at[k + 3]!],
      [`hoof${leg}`, `pastern${leg}`, at[k + 4]!],
      [`toe${leg}`, `hoof${leg}`, at[k + 5]!],
    ];
  };
  /** The neck's joints (base, middle) and the poll. */
  const NECK0: P = [0, 1.32, 0.84], NECK1: P = [0, 1.49, 1.03], POLL: P = [0, 1.66, 1.22];
  /** The leaf feathers on the head: where they grow (behind the brow, where ears would be), the way they point (back, up, out), their length. */
  const FEATHER_ROOT: P = [0.06, POLL[1] + 0.095, POLL[2] + 0.02];
  const featherDir = (s: number): P => norm([0.36 * s, 0.42, -1]);
  const FEATHER_LEN = 0.64;
  /** The tail: its root and the length of each of its five links, straight back in the rest pose. */
  const TAIL_ROOT: P = [0, 1.3, -1.24];
  const TAIL_LINK = 0.31;
  const tailAt = (k: number): P => [0, TAIL_ROOT[1], TAIL_ROOT[2] - TAIL_LINK * k];
  const LANTERN: P = [0.35, 1.1, 0.37];

  // --- Profiles: the shapes the joints and the parts are placed on ---------------------------------------------------
  /** `t` from 0 at `a` to 1 at `b`, held at both ends. */
  const ramp = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
  /**
   * The trunk's profile: z, centre height, half width, half height. A deep chest (0.78 deep, 0.56 wide at the
   * girth), the lower ribs carried back, the belly tucked up to a waist half as deep over two stations, a full croup
   * with round haunches, the buttock and the breast rounded off.
   */
  const TRUNK: readonly (readonly [number, number, number, number])[] = [
    [-1.3, 1.25, 0.08, 0.1],
    [-1.2, 1.21, 0.18, 0.215],
    [-1.02, 1.18, 0.235, 0.265],
    [-0.78, 1.19, 0.225, 0.25],
    [-0.5, 1.22, 0.195, 0.215],
    [-0.22, 1.17, 0.23, 0.285],
    [0.1, 1.08, 0.268, 0.37],
    [0.4, 1.05, 0.278, 0.39],
    [0.7, 1.09, 0.24, 0.33],
    [0.92, 1.14, 0.135, 0.2],
  ];
  /** Centre height, half width and half height of the trunk at `z`. */
  const prof = (z: number): [number, number, number] => {
    let k = 0;
    while (k + 2 < TRUNK.length && TRUNK[k + 1]![0] < z) k++;
    const A = TRUNK[k]!, C = TRUNK[k + 1]!;
    // Eased between stations, so the outline curves rather than breaks at them.
    const t = clamp01((z - A[0]) / (C[0] - A[0]));
    const e = t * t * (3 - 2 * t);
    const u = 0.5 * t + 0.5 * e;
    return [mixN(A[1], C[1], u), mixN(A[2], C[2], u), mixN(A[3], C[3], u)];
  };
  /** How much the chest narrows to a keel below (deep and narrow in front, round at the waist). */
  const keel = (z: number): number => 0.3 * clamp01((z + 0.35) / 0.6);
  /** 1 at `c`, falling smoothly to 0 at `w` either side of it. */
  const bell = (z: number, c: number, w: number): number => {
    const t = Math.abs(z - c) / w;
    return t >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * t);
  };
  /** The haunches: the croup's sides swell out and run down into the thighs (the trunk's own surface, no seam). */
  const haunch = (z: number): number => bell(z, -0.9, 0.36);
  /** The shoulders: the chest's sides swell over the upper arms. */
  const shoulder = (z: number): number => bell(z, 0.6, 0.34);
  /** A point of the trunk's surface at `z`, at the angle `a` round it (0 the left side, π/2 the top), grown by `grow`. */
  const across = (z: number, a: number, grow = 1): P => {
    const [yc, hw, hh] = prof(z);
    const c = Math.cos(a), s = Math.sin(a);
    const narrow = 1 - 0.28 * Math.max(0, s) ** 1.5 - keel(z) * Math.max(0, -s) ** 1.3;
    const side = Math.abs(c) ** 0.8;
    // Wider over the side and below it (most at about 30° under the side), the lower flank drawn down where it swells.
    const low = Math.max(0, -s) * Math.abs(c);
    const out = (0.075 * haunch(z) + 0.085 * shoulder(z)) * (side * (1 - 0.35 * Math.max(0, s)));
    const down = (0.2 * haunch(z) + 0.06 * shoulder(z)) * low ** 0.9;
    return [Math.sign(c) * (side * narrow * hw + out) * grow, yc + s * hh * grow - down * grow, z];
  };
  const trunkRing = (z: number, grow = 1, n = 14): P[] => Array.from({ length: n }, (_, k) => across(z, ((k + 0.5) / n) * TAU, grow));
  /** The rider's seat on the rug (the socket `seat`), behind the withers. */
  const SEAT: P = [0, across(-0.08, Math.PI / 2, 1.11)[1] + 0.004, -0.08];
  /** The rug: along z from its back to its front edge, down each side to below the widest of the ribs. */
  const RUG_Z0 = -0.46, RUG_Z1 = 0.32;
  /** The rug's rows from the spine down: angles round the trunk (π/2 the top), and what each row shows. */
  const RUG_ROWS: readonly (readonly [number, 'base' | 'light' | 'zig' | 'dark'])[] = [
    [Math.PI / 2, 'base'],
    [1.1, 'base'],
    [0.66, 'light'],
    [0.56, 'base'],
    [0.44, 'zig'],
    [0.12, 'light'],
    [0.02, 'dark'],
    [-0.2, 'dark'],
  ];
  const RUG_COLS = 10;
  /** A point of the rug: on the trunk grown by a little above its widest, hanging straight down below it. */
  const rugAt = (z: number, a: number, s: number, lift = 0): P => {
    const grow = 1.055 + lift;
    if (a >= 0.12) {
      const p = across(z, a, grow);
      return [p[0] * s, p[1], z];
    }
    const top = across(z, 0.12, grow), low = across(z, a, grow);
    return [top[0] * s, low[1], z];
  };
  /** The head's line from the poll to the nose; `HV` across it, from the jaw to the forehead. */
  const H0: P = POLL;
  const HU: P = norm([0, -0.3, 1]);
  const HV: P = [0, HU[2], -HU[1]];
  /** A point `t` along the head's line, `v` toward the forehead (− the jaw), `x` to the left. */
  const onHead = (t: number, v = 0, x = 0): P => [x, H0[1] + HU[1] * t + HV[1] * v, H0[2] + HU[2] * t + HV[2] * v];
  /**
   * The head's profile along its line: t (m from the poll), half width, half depth, centre offset toward the forehead.
   * A fox's: a round skull, wide cheeks behind the eyes, a clear stop, a long fine muzzle to a small nose. One flat
   * stretch from 0.075 to 0.215 on each side carries the eye.
   */
  const HEAD: readonly (readonly [number, number, number, number])[] = [
    [-0.07, 0.065, 0.075, 0.03],
    [0.02, 0.11, 0.108, 0.016],
    [0.075, 0.128, 0.112, -0.001],
    [0.215, 0.09, 0.086, -0.023],
    [0.29, 0.062, 0.066, -0.026],
    [0.39, 0.045, 0.051, -0.028],
    [0.47, 0.032, 0.037, -0.03],
    [0.52, 0.013, 0.019, -0.032],
  ];
  const headSize = (t: number): [number, number, number] => {
    let k = 0;
    while (k + 2 < HEAD.length && HEAD[k + 1]![0] < t) k++;
    const A = HEAD[k]!, C = HEAD[k + 1]!;
    const u = clamp01((t - A[0]) / (C[0] - A[0]));
    return [mixN(A[1], C[1], u), mixN(A[2], C[2], u), mixN(A[3], C[3], u)];
  };
  /**
   * The angles of the points round the head's section (0 the left side, 90° the forehead): the flat side the eye sits
   * on (−18° to 30°), the corner of the lips (−38°), then the three points of the underside, which from the corner of
   * the mouth forward are the palate.
   */
  const HEAD_ANGLES: readonly number[] = [-18, 30, 60, 90, 120, 150, 198, 218, 250, 270, 290, 322].map((d) => (d * Math.PI) / 180);
  /** How far below the section's middle the lips meet, a share of its half depth. */
  const LIPS = Math.sin((38 * Math.PI) / 180);
  /** Where the mouth ends at the back (the corner of the lips), and where the skull's last whole section is. */
  const MOUTH_T0 = 0.215, MOUTH_T1 = 0.25;
  /** The upper half of the skull is squarer than an ellipse (flat sides under the brows), the muzzle round. */
  const squareness = (t: number): number => mixN(0.62, 1, ramp(t, MOUTH_T0, 0.29));
  /** Point `k` of the head's section at `t`; with `palate` the three points of the underside are the roof of the mouth. */
  const headPoint = (t: number, k: number, palate = false): P => {
    const [hw, hd, vc] = headSize(t);
    if (palate && k >= 8 && k <= 10) return onHead(t, vc - LIPS * hd + (k === 9 ? 0.3 * hd : 0), (k - 9) * 0.5 * hw);
    const a = HEAD_ANGLES[k]!;
    const c = Math.cos(a), sn = Math.sin(a);
    const e = sn > 0 ? squareness(t) : 1;
    return onHead(t, vc + Math.sign(sn) * Math.abs(sn) ** e * hd, Math.sign(c) * Math.abs(c) ** e * hw);
  };
  const headRing = (t: number, palate = false): P[] => HEAD_ANGLES.map((_, k) => headPoint(t, k, palate));
  /** The height of the lips' line at `t` (toward the forehead). */
  const lipsAt = (t: number): number => {
    const [, hd, vc] = headSize(t);
    return vc - LIPS * hd;
  };
  /** Where a point is on the head: along its line and toward the forehead. */
  const headUV = (c: P): [number, number] => {
    const d = sub(c, H0);
    return [d[1] * HU[1] + d[2] * HU[2], d[1] * HV[1] + d[2] * HV[2]];
  };
  /**
   * The lower jaw's section at `t`, `g` of its size: the corners under the lips, the underside (the head's own outline
   * there) and the floor of the mouth, a trough for the tongue.
   */
  const jawRing = (t: number, g = 1): P[] => {
    const [hw, hd] = headSize(t);
    const top = lipsAt(t) - 0.003;
    const at = (x: number, down: number): P => onHead(t, top - down * hd * g, x * hw * g);
    return [at(0.74, 0), at(0.342, 0.324), at(0, 0.384), at(-0.342, 0.324), at(-0.74, 0), at(0, 0.12)];
  };
  /** The jaw's hinge under the eye, on the lips' line carried back. */
  const JAW: P = onHead(0.13, -0.07);
  /** The tongue on the floor of the mouth: its middle `t` along the head, and its two joints. */
  const tongueAt = (t: number, x = 0, up = 0): P => {
    const [, hd] = headSize(t);
    return onHead(t, lipsAt(t) - 0.003 - 0.12 * hd + 0.0065 + up, x);
  };
  const TONGUE0: P = tongueAt(0.27), TONGUE1: P = tongueAt(0.375);
  /**
   * A point of the flat side of the skull on side `s`: `t` along the head, `e` up it (0 its lower edge, 1 under the
   * brow), `out` metres off the surface.
   */
  const EYE_T0 = 0.075, EYE_T1 = 0.215;
  const sideAt = (s: number, t: number, e: number, out = 0): P => {
    const p00 = headPoint(EYE_T0, 0), p01 = headPoint(EYE_T0, 1), p10 = headPoint(EYE_T1, 0), p11 = headPoint(EYE_T1, 1);
    const u = (t - EYE_T0) / (EYE_T1 - EYE_T0);
    const n = norm(cross(sub(p01, p00), sub(p10, p00)));
    const o = n[0] < 0 ? -out : out;
    const p = add(lerp(lerp(p00, p10, u), lerp(p01, p11, u), e), mul(n, o));
    return [p[0] * s, p[1], p[2]];
  };
  /** The eye's corners on the side of the skull (t, e): back, top, front, bottom; slanted up toward the back. */
  const EYE_CORNERS: readonly (readonly [number, number])[] = [[0.092, 0.74], [0.152, 0.9], [0.205, 0.47], [0.14, 0.34]];
  const EYE_MID: readonly [number, number] = [0.147, 0.62];
  /** The eye's outline on side `s`, `k` of its size about its middle, `out` off the surface. */
  const eyeRing = (s: number, k: number, out: number): P[] => EYE_CORNERS.map(([t, e]) => sideAt(s, EYE_MID[0] + (t - EYE_MID[0]) * k, EYE_MID[1] + (e - EYE_MID[1]) * k, out));
  /** How far off the surface the eyelid lies when it is shut, and how far it is turned up into the skull when open, rad. */
  const LID_OUT = 0.0075, LID_OPEN = 1.9;
  /** The eyelid's hinge on side `s`: a point on it (over the eye's top corner), its axis (along the eye) and the turn that opens it. */
  const lidHinge = (s: number): { at: P; axis: P; open: number } => {
    const at = sideAt(s, EYE_CORNERS[1]![0], EYE_CORNERS[1]![1] + 0.04, LID_OUT);
    const axis = norm(sub(sideAt(s, EYE_CORNERS[2]![0], EYE_CORNERS[2]![1]), sideAt(s, EYE_CORNERS[0]![0], EYE_CORNERS[0]![1])));
    // Opening turns the lid's lower edge into the skull (toward the middle of the head).
    const low = sub(sideAt(s, EYE_CORNERS[3]![0], EYE_CORNERS[3]![1], LID_OUT), at);
    const swing = cross(axis, low);
    return { at, axis, open: swing[0] * s < 0 ? LID_OPEN : -LID_OPEN };
  };
  /** `p` turned about the line through `at` along the unit `axis` by `a` radians. */
  const about = (p: P, at: P, axis: P, a: number): P => {
    const v = sub(p, at), c = Math.cos(a), sn = Math.sin(a);
    const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
    return add(at, add(add(mul(v, c), mul(cross(axis, v), sn)), mul(axis, d * (1 - c))));
  };
  /** The corners of the rug where a big tassel hangs: front right, hind left, hind right (the front left carries the lantern). */
  const tasselAt = (z: number, s: number): P => {
    const p = rugAt(z, -0.2, s);
    return [p[0], p[1] - 0.012, z];
  };
  const B = new Bones<Bone>(7, [
    ['root', null, [0, 0, 0]],
    ['body', 'root', [0, 1.16, -0.1]],
    ['chest', 'body', [0, 1.18, 0.3]],
    ['loin', 'body', [0, 1.22, -0.36]],
    ['croup', 'loin', [0, 1.2, -0.68]],
    ['neck', 'chest', NECK0],
    ['neck2', 'neck', NECK1],
    ['head', 'neck2', POLL],
    ['jaw', 'head', JAW],
    ['tongue', 'jaw', TONGUE0],
    ['tongue2', 'tongue', TONGUE1],
    ['lidL', 'head', lidHinge(1).at],
    ['lidR', 'head', lidHinge(-1).at],
    ['featherL', 'head', FEATHER_ROOT],
    ['featherL2', 'featherL', add(FEATHER_ROOT, mul(featherDir(1), FEATHER_LEN / 2))],
    ['featherR', 'head', [-FEATHER_ROOT[0], FEATHER_ROOT[1], FEATHER_ROOT[2]]],
    ['featherR2', 'featherR', add([-FEATHER_ROOT[0], FEATHER_ROOT[1], FEATHER_ROOT[2]], mul(featherDir(-1), FEATHER_LEN / 2))],
    ['tail', 'croup', tailAt(0)],
    ['tail2', 'tail', tailAt(1)],
    ['tail3', 'tail2', tailAt(2)],
    ['tail4', 'tail3', tailAt(3)],
    ['tail5', 'tail4', tailAt(4)],
    ['tuft', 'tail5', tailAt(5)],
    ['lantern', 'body', LANTERN],
    ['tasselFR', 'body', tasselAt(RUG_Z1, -1)],
    ['tasselHL', 'body', tasselAt(RUG_Z0, 1)],
    ['tasselHR', 'body', tasselAt(RUG_Z0, -1)],
    ...legBones('FL', 'chest', front(1)),
    ...legBones('FR', 'chest', front(-1)),
    ...legBones('HL', 'croup', hind(1)),
    ...legBones('HR', 'croup', hind(-1)),
  ], SIZE);
  const id = B.id;

  // --- Helpers --------------------------------------------------------------------------------------------------------
  const cream: readonly [RGB, number] = [CREAM, MAT.flat];
  /**
   * A tone from a share of cream by the face's place: cream where it is past one half, the coat elsewhere. The shares
   * are smooth over a surface (by place, or by the normal on a smooth tube), so the border is one clean low-poly edge
   * along the curve where the share crosses one half.
   */
  const blend = (share: (c: P, n: P) => number): FaceTone => (c, n) => (share(c, n) >= 0.5 ? cream : null);
  /** The coat (the look's coat colour) on a bone, cream by the share `fn` gives. */
  const coat = (b: Bone, fn: ((c: P, n: P) => number) | null = null): FigureMesh =>
    B.part(b, SLOT.coat).paint(WHITE, MAT.tint, 0.07).tone(fn ? blend(fn) : null);
  /** A tube through rings `[centre, half width across the body (x), half depth in the plane of the tube]`. */
  const tube = (m: FigureMesh, rings: readonly (readonly [P, number, number])[], n = 6, capA = true, capB = true): void => {
    const out: P[][] = [];
    for (let i = 0; i < rings.length; i++) {
      const a = rings[Math.max(0, i - 1)]![0], b = rings[Math.min(rings.length - 1, i + 1)]![0];
      const ax = norm(sub(b, a));
      const w = norm(cross([1, 0, 0], ax));
      const u = norm(cross(w, ax));
      const [c, rx, rw] = rings[i]!;
      out.push(ringOn(c, u, w, rx, rw, n, 0.5));
    }
    m.loft(out, capA, capB);
  };
  /** A braided rope along `pts`: short links of two tones, each turned half a facet against the last. */
  const rope = (m: FigureMesh, pts: readonly P[], r: number, link = 0.1): void => {
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
  /**
   * A leaf feather from `base` along `dir` (`len` long, `wide` at its widest on each side of the midrib), its blade in
   * the plane of `dir` and `across`, folded along the midrib toward `normal` and swept toward `across` at the tip; dark
   * on top, pale beneath, a pale midrib. Long and narrow: widest a third of the way, tapering to a long point. `split`
   * (0–1 along it) puts the part beyond it on `m2` (a second bone), when given.
   */
  const leaf = (m1: FigureMesh, m2: FigureMesh | null, base: P, dir: P, across: P, len: number, wide: number, split = 0.5): void => {
    const nrm = norm(cross(dir, across));
    const width = (u: number): number => (u < 0.32 ? Math.sin((0.5 * Math.PI * u) / 0.32) ** 0.7 : Math.cos((0.5 * Math.PI * (u - 0.32)) / 0.68) ** 0.9);
    const at = (u: number, e: number, lift = 0): P => {
      const w = wide * width(u);
      const fold = 0.3 * w * (1 - Math.abs(e)) + lift;
      return add(add(add(base, mul(dir, len * u)), mul(across, w * e + 0.14 * len * u * u)), mul(nrm, fold));
    };
    const us = [0, 0.08, 0.2, 0.32, 0.46, 0.6, 0.74, 0.87, 1];
    for (let i = 0; i + 1 < us.length; i++) {
      const u0 = us[i]!, u1 = us[i + 1]!;
      const m = m2 && u0 >= split ? m2 : m1;
      for (const e of [1, -1]) {
        const q0 = at(u0, 0), q1 = at(u1, 0), q2 = at(u1, e), q3 = at(u0, e);
        const mid = mul(add(add(q0, q1), add(q2, q3)), 0.25);
        m.paint(WHITE, MAT.tint, 0.08);
        m.quad(q0, q1, q2, q3, sub(mid, nrm));
        m.paint(LEAF_UNDER, MAT.tint, 0.05);
        m.quad(q0, q1, q2, q3, add(mid, nrm));
        // The midrib: a narrow pale strip a little proud of the top.
        m.paint(LEAF_RIB, MAT.flat, 0.04);
        m.quad(at(u0, 0, 0.004), at(u1, 0, 0.004), at(u1, 0.12 * e, 0.004), at(u0, 0.12 * e, 0.004), sub(mid, nrm));
      }
    }
  };

  // --- Trunk ------------------------------------------------------------------------------------------------------
  /**
   * Cream under the belly (within about 40° of straight down, by the place round the trunk, so the haunches and the
   * shoulders stay coat) and over the breast (the front of the chest below its middle).
   */
  const belly = (c: P): number => {
    const [yc, hw, hh] = prof(c[2]);
    const ang = Math.atan2((c[1] - yc) / hh, Math.abs(c[0]) / hw);
    const under = ang < -Math.PI / 2 + 0.72 - 0.25 * bell(c[2], -0.9, 0.36) ? 1 : 0;
    const breast = c[2] > 0.74 && ang < 0.1 && Math.abs(c[0]) / hw < 0.62 ? 1 : 0;
    return Math.max(under, breast);
  };
  // The trunk in four overlapping pieces, so a back that rounds and stretches over the loin shows no gap: the croup,
  // the loin, the middle under the rug and the chest. Stations between the profile's for a rounder outline.
  const zs = (a: number, b: number, n: number): number[] => Array.from({ length: n + 1 }, (_, k) => a + ((b - a) * k) / n);
  coat('croup', belly).loft(zs(-1.3, -0.5, 7).map((z) => trunkRing(z)));
  coat('loin', belly).loft(zs(-0.72, -0.2, 4).map((z) => trunkRing(z, 0.99)));
  coat('body', belly).loft(zs(-0.36, 0.42, 6).map((z) => trunkRing(z, 0.995)));
  coat('chest', belly).loft(zs(0.18, 0.92, 7).map((z) => trunkRing(z)));

  // --- Neck and head ------------------------------------------------------------------------------------------------
  /** Up and forward the neck rises; across it, from the throat to the crest. */
  const ND: P = norm(sub(POLL, NECK0));
  const NV: P = [0, ND[2], -ND[1]];
  const neckRing = (c: P, hw: number, hd: number): P[] => ringOn(c, [1, 0, 0], NV, hw, hd, 10, 0.5);
  const NECK_LEN = Math.hypot(POLL[1] - NECK0[1], POLL[2] - NECK0[2]);
  /** The neck's half width and half depth `t` along it (0 its base, 1 the poll): thick, and still thick under the jaw. */
  const NECK: readonly (readonly [number, number, number])[] = [[-0.3, 0.215, 0.33], [0.1, 0.175, 0.265], [0.45, 0.145, 0.215], [0.75, 0.13, 0.19], [0.95, 0.115, 0.16], [1.08, 0.08, 0.1]];
  const neckSize = (t: number): [number, number] => {
    let k = 0;
    while (k + 2 < NECK.length && NECK[k + 1]![0] < t) k++;
    const A = NECK[k]!, C = NECK[k + 1]!;
    const u = clamp01((t - A[0]) / (C[0] - A[0]));
    return [mixN(A[1], C[1], u), mixN(A[2], C[2], u)];
  };
  const neckAt = (t: number): P => add(NECK0, mul(ND, t * NECK_LEN));
  const neckRingAt = (t: number): P[] => {
    const [hw, hd] = neckSize(t);
    return neckRing(neckAt(t), hw, hd);
  };
  /** Cream on the throat: the front third of the neck's depth, by the place across it. */
  const throat = (c: P): number => {
    const d = sub(c, NECK0);
    const t = (d[1] * ND[1] + d[2] * ND[2]) / NECK_LEN;
    const v = d[1] * NV[1] + d[2] * NV[2];
    const [hw, hd] = neckSize(t);
    return v / hd < -0.42 && Math.abs(c[0]) / hw < 0.8 ? 1 : 0;
  };
  // A thick neck flowing out of the shoulders and the breast, keeping its thickness up to the jaw.
  coat('neck', throat).loft([-0.3, -0.05, 0.2, 0.45, 0.62].map(neckRingAt));
  coat('neck2', throat).loft([0.5, 0.68, 0.84, 0.97, 1.08].map(neckRingAt));
  // Cream cheeks, jaw and the lower muzzle, a dark nose; the roof of the mouth and its back wall dark.
  const headTone: FaceTone = (c, n) => {
    const [t, v] = headUV(c);
    const [, hd, vc] = headSize(t);
    const low = (vc - v) / hd;
    if (t > MOUTH_T0 + 0.001 && low > 0.4 && (n[1] * HV[1] + n[2] * HV[2] < -0.7 || (t < MOUTH_T1 && low > LIPS + 0.004))) return [MOUTH, MAT.flat];
    if (t > 0.485) return [NOSE, MAT.flat];
    // The upper lip and, behind the eyes, the lower cheek: a line rising toward the back of the head.
    return low > 0.3 - 0.45 * ramp(0.2 - t, 0, 0.2) ? cream : null;
  };
  // The skull and the upper jaw: whole sections back to the corner of the mouth, from there forward open beneath (the
  // palate). The lower jaw is its own part on its own bone, so the mouth opens.
  B.part('head', SLOT.coat).paint(WHITE, MAT.tint, 0.06).tone(headTone).loft([
    ...[-0.07, 0.02, EYE_T0, MOUTH_T0].map((t) => headRing(t)),
    ...[MOUTH_T1, 0.29, 0.39, 0.47, 0.52].map((t) => headRing(t, true)),
  ]);
  {
    // The lower jaw: within the cheeks at the back (smaller than the skull there), the head's own outline from the
    // corner of the mouth to the chin; cream outside, the floor of the mouth dark.
    const jawTone: FaceTone = (_c, n) => (n[1] * HV[1] + n[2] * HV[2] > 0.5 ? [MOUTH, MAT.flat] : null);
    B.part('jaw', SLOT.coat).paint(CREAM, MAT.flat, 0.06).tone(jawTone).loft([jawRing(0.15, 0.84), jawRing(0.205, 0.9), jawRing(MOUTH_T1, 1), jawRing(0.29), jawRing(0.39), jawRing(0.448), jawRing(0.47, 0.62)]);
    // The tongue on the floor of the mouth, on two bones: it slides out and its tip hangs or curls.
    const tongueRing = (t: number, hw: number): P[] => ringOn(tongueAt(t), [1, 0, 0], HV, hw, 0.0055, 6, 0);
    B.part('tongue', SLOT.trim).paint(TONGUE, MAT.flat, 0.05).tone(null).loft([tongueRing(0.255, 0.021), tongueRing(0.3, 0.025), tongueRing(0.385, 0.022)]);
    B.part('tongue2', SLOT.trim).paint(TONGUE, MAT.flat, 0.05).tone(null).loft([tongueRing(0.37, 0.022), tongueRing(0.41, 0.02), tongueRing(0.432, 0.015), tongueRing(0.442, 0.007)]);
    // Small teeth inside the lips: a row on each side of the lower jaw with a longer one in front, a row above. Shut,
    // each row stands inside the other jaw.
    const lower = B.part('jaw', SLOT.trim).paint(TOOTH, MAT.flat, 0.04).tone(null);
    const upper = B.part('head', SLOT.trim).paint(TOOTH, MAT.flat, 0.04).tone(null);
    for (const s of [1, -1]) {
      const edge = (t: number, x: number, v: number): P => onHead(t, lipsAt(t) + v, x * headSize(t)[0] * s);
      for (let i = 0; i < 5; i++) {
        const t0 = 0.3 + 0.028 * i, t1 = t0 + 0.028;
        lower.both(edge(t0, 0.6, -0.0045), edge(t1, 0.6, -0.0045), edge((t0 + t1) / 2, 0.6, i === 4 ? 0.0095 : 0.0035));
        upper.both(edge(t0 + 0.014, 0.52, 0), edge(t1 + 0.014, 0.52, 0), edge((t0 + t1) / 2 + 0.014, 0.52, -0.007));
      }
    }
  }
  for (const s of [1, -1]) {
    // The brow over each eye, and the cheek and the angle of the jaw behind and below it.
    coat('head').blob(onHead(0.125, 0.066, 0.069 * s), [0.04, 0.02, 0.06], 21 + s, 0.03, 8, 3);
    B.part('head', SLOT.coat).paint(WHITE, MAT.tint, 0.06).tone(headTone).blob(onHead(0.07, -0.06, 0.075 * s), [0.05, 0.055, 0.075], 23 + s, 0.04, 8, 3);
    // The dark edge of the upper lip from the corner of the mouth to the nose.
    const mouth = B.part('head', SLOT.trim).paint(NOSE, MAT.flat, 0).tone(null);
    const lip = (t: number, up: number): P => {
      const [hw, hd] = headSize(t);
      return onHead(t, lipsAt(t) + up, (Math.cos((38 * Math.PI) / 180) * hw + 0.0025 + (0.55 * up * hw) / hd) * s);
    };
    mouth.plate([lip(MOUTH_T1, 0), lip(0.36, 0), lip(0.48, 0), lip(0.48, 0.008), lip(0.36, 0.006), lip(MOUTH_T1, 0.005)]);
  }
  // Almond eyes on the flat sides of the skull, slanted up toward the back: a pale rim, a dark eye raised to a low
  // point (four facets), a light facet near its front. Each stands a little proud of the skull on a base sunk into it.
  // An eyelid on its own bone, hinged over the eye and turned up into the skull while the eye is open.
  for (const s of [1, -1]) {
    const e = B.part('head', SLOT.trim).tone(null);
    e.paint(EYE_RIM, MAT.flat, 0);
    e.loft([eyeRing(s, 1.06, -0.006), eyeRing(s, 1, 0.0015)], false, true);
    e.paint(EYE, MAT.flat, 0.02);
    const iris = eyeRing(s, 0.8, 0.0035);
    const apex = sideAt(s, EYE_MID[0], EYE_MID[1], 0.0065);
    e.loft([eyeRing(s, 0.84, 0), iris], false, false);
    e.cone(iris, apex);
    // The light facet: on the eye's upper front facet (top corner, front corner, point), a hair above it.
    e.paint(EYE_RIM, MAT.flat, 0);
    const lift = sub(sideAt(s, EYE_MID[0], EYE_MID[1], 0.0012), sideAt(s, EYE_MID[0], EYE_MID[1]));
    const on = (a: number, t: number, f: number): P => add(add(add(mul(apex, a), mul(iris[1]!, t)), mul(iris[2]!, f)), lift);
    e.both(on(0.62, 0.28, 0.1), on(0.42, 0.2, 0.38), on(0.3, 0.52, 0.18));
    // The lid, written open: the shut lid (a plate over the whole eye) turned about its hinge.
    const h = lidHinge(s);
    const lid = B.part(s > 0 ? 'lidL' : 'lidR', SLOT.coat).paint(WHITE, MAT.tint, 0.05).tone(null);
    lid.plate(eyeRing(s, 1.22, LID_OUT).map((q) => about(q, h.at, h.axis, h.open)));
  }
  // The leaf feathers: a russet socket where each grows, then the long narrow blade on two bones.
  for (const [b, b2, s] of [['featherL', 'featherL2', 1], ['featherR', 'featherR2', -1]] as const) {
    const root: P = [FEATHER_ROOT[0] * s, FEATHER_ROOT[1], FEATHER_ROOT[2]];
    coat('head').blob(add(root, [0, -0.012, 0.015]), [0.038, 0.035, 0.05], 25 + s, 0.03, 8, 3);
    const d = featherDir(s);
    const acrossLeaf = norm(cross(d, [s, 0, 0]));
    const up: P = acrossLeaf[1] < 0 ? mul(acrossLeaf, -1) : acrossLeaf;
    leaf(B.part(b, SLOT.feather).tone(null), B.part(b2, SLOT.feather).tone(null), root, d, up, FEATHER_LEN, 0.075);
  }

  // --- Tail -------------------------------------------------------------------------------------------------------
  {
    // Thick at the root, where the croup runs out into it, tapering over five long links, cream beneath, the last link
    // darker; two long narrow leaves.
    const tails = ['tail', 'tail2', 'tail3', 'tail4', 'tail5'] as const;
    const r = (k: number): number => 0.092 - 0.013 * k;
    const under = (_c: P, n: P): number => (n[1] < -0.6 ? 1 : 0);
    const stub = (z: number, yc: number, hw: number, hh: number): P[] => ringOn([0, yc, z], [1, 0, 0], [0, 1, 0], hw, hh, 10, 0.5);
    // The croup's stub ends at the tail's joint, at the size of the ball the first link starts with: the ball is
    // centred on the joint, so however the tail is turned its root stays flush with the stub.
    const ball = r(0) + 0.006;
    coat('croup', under).loft([stub(-1.08, 1.27, 0.15, 0.14), stub(-1.17, 1.283, 0.123, 0.12), stub(TAIL_ROOT[2], TAIL_ROOT[1], ball, ball)]);
    coat('tail', under).blob(TAIL_ROOT, [ball, ball, ball], 0, 0, 10, 4);
    tails.forEach((b, k) => {
      const m = k < 4 ? coat(b, under) : B.part(b, SLOT.trim).paint(TAIL_TIP, MAT.flat, 0.06).tone(null);
      m.limb(tailAt(k), tailAt(k + 1.1), r(k), r(k + 1), 8, 0.92);
      // Each further link starts with a ball on its joint too, so a bend of the tail shows no step.
      if (k > 0) m.blob(tailAt(k), [0.92 * r(k), 0.9 * r(k), 0.92 * r(k)], 0, 0, 8, 3);
    });
    const tip = tailAt(5);
    const m = B.part('tuft', SLOT.feather).tone(null);
    for (const [dy, dx, len, k] of [[0.2, 0.07, 0.64, 0], [-0.14, -0.06, 0.56, 1]] as const) {
      const d = norm([dx, dy, -1]);
      const acrossTuft = norm(cross(d, [1, 0, 0]));
      leaf(m, null, add(tip, [0, 0, 0.04 - 0.02 * k]), d, acrossTuft[1] < 0 ? mul(acrossTuft, -1) : acrossTuft, len, 0.068);
    }
  }

  // --- Legs -------------------------------------------------------------------------------------------------------
  // Both pairs of one build. The shoulder and the haunch are the trunk's own surface (`across`): the leg's top grows
  // out of it, its upper rings inside the trunk, so the joint turns within the body. Below them a muscled upper arm and
  // forearm, a thigh and gaskin taper to the carpus and the hock, the cannon tapers to a wider fetlock, the pastern
  // widens again into a compact dark paw of two toes. The coat runs down the outer front of each leg to the paw and the
  // cream down its inside and back, the border running along the leg.
  /**
   * Cream on the inside and the back of the leg segment `a`→`b` on side `s`, by where the face sits round the
   * segment's axis: the angle from straight inward (0) toward the back (π/2); cream within `from`…`to` of it.
   */
  const legTone = (s: number, a: P, b: P, from: number, to: number) => (c: P): number => {
    const ab = sub(b, a);
    const t = clamp01(((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2));
    const o = sub(c, lerp(a, b, t));
    const ang = Math.atan2(-o[2], -o[0] * s);
    return ang >= from && ang <= to ? 1 : 0;
  };
  /** The fetlock, the pastern and the paw below `fet`, `coffin` (the joint above the paw) of leg `l`, `k` its size. */
  const foot = (l: Leg, s: number, fet: P, coffin: P, k: number, key: number): void => {
    const cr = coat(`pastern${l}`, legTone(s, fet, coffin, -1.3, 3.0));
    cr.blob([fet[0], fet[1], fet[2] - 0.006], [0.044 * k, 0.046 * k, 0.05 * k], 85 + key, 0.03, 8, 2);
    tube(cr, [[[fet[0], fet[1] - 0.01, fet[2] + 0.002], 0.037 * k, 0.04 * k], [lerp(fet, coffin, 0.55), 0.036 * k, 0.039 * k], [[coffin[0], coffin[1] + 0.016, coffin[2] - 0.002], 0.041 * k, 0.043 * k]], 8);
    // The paw: a rounded pad from the heel to the toes on a flat sole, two toes split a little at the front.
    const paw = B.part(`hoof${l}`, SLOT.trim).paint(HOOF, MAT.flat, 0.05).tone(null);
    const x = coffin[0], z = coffin[2];
    const station = (dz: number, hw: number, top: number): P[] => ringOn([x, (top / 2) * k, z + dz * k], [1, 0, 0], [0, 1, 0], hw * k, (top / 2) * k, 8, 0.5).map((p): P => [p[0], Math.max(p[1], 0.002), p[2]]);
    paw.loft([station(-0.05, 0.026, 0.05), station(-0.03, 0.04, 0.074), station(0.0, 0.047, 0.08), station(0.035, 0.048, 0.062), station(0.062, 0.042, 0.042), station(0.08, 0.027, 0.025)]);
    for (const t of [1, -1]) paw.blob([x + 0.022 * t * k, 0.022 * k, z + 0.07 * k], [0.022 * k, 0.021 * k, 0.03 * k], 95 + key + t, 0.03, 6, 2);
  };
  const foreLeg = (l: 'FL' | 'FR', s: number): void => {
    const [, sh, elbow, carpus, fet, coffin] = front(s) as [P, P, P, P, P, P];
    // The upper arm from inside the shoulder (its top rings within the chest) back and down to the elbow, the triceps
    // filling the angle behind it; one tapering loft. Its outer face leaves the chest's side at a shallow angle (it
    // comes out of it a little above the joint and stands out slowly), so the shoulder is one slope, not a slab.
    const upper = coat(`upper${l}`, legTone(s, sh, elbow, -0.9, 0.9));
    tube(upper, [[[sh[0] - 0.05 * s, sh[1] + 0.16, sh[2] - 0.04], 0.05, 0.13], [[sh[0] - 0.035 * s, sh[1] + 0.07, sh[2] - 0.04], 0.072, 0.158], [[sh[0] - 0.014 * s, sh[1] - 0.04, sh[2] - 0.045], 0.074, 0.17], [lerp(sh, elbow, 0.45), 0.085, 0.15], [lerp(sh, elbow, 0.8), 0.075, 0.11], [[elbow[0], elbow[1] + 0.01, elbow[2] - 0.005], 0.068, 0.085]], 8);
    // The forearm: thick at the top (its extensors in front), tapering to the carpus.
    const lower = coat(`lower${l}`, legTone(s, elbow, carpus, -0.9, 1.3));
    tube(lower, [[[elbow[0], elbow[1] + 0.04, elbow[2] + 0.005], 0.07, 0.085], [[elbow[0], elbow[1] - 0.07, elbow[2] + 0.025], 0.074, 0.09], [lerp(elbow, carpus, 0.45), 0.059, 0.069], [lerp(elbow, carpus, 0.75), 0.047, 0.052], [[carpus[0], carpus[1] + 0.02, carpus[2]], 0.042, 0.046]], 8);
    // The carpus, the cannon tapering to the fetlock.
    const cannon = coat(`cannon${l}`, legTone(s, carpus, fet, -1.25, 2.9));
    cannon.blob([carpus[0], carpus[1] - 0.004, carpus[2] + 0.004], [0.044, 0.048, 0.047], 61 + s, 0.03, 8, 2);
    tube(cannon, [[[carpus[0], carpus[1] - 0.02, carpus[2]], 0.039, 0.042], [lerp(carpus, fet, 0.5), 0.033, 0.036], [[fet[0], fet[1] + 0.03, fet[2]], 0.03, 0.034]], 8);
    foot(l, s, fet, coffin, 1, s);
  };
  const hindLeg = (l: 'HL' | 'HR', s: number): void => {
    const [hip, stifle, hock, fet, coffin] = hind(s) as [P, P, P, P, P];
    // The thigh from inside the haunch forward and down to the stifle, the hamstrings behind it: one tapering loft whose
    // upper rings lie within the croup.
    const upper = coat(`upper${l}`, legTone(s, hip, stifle, -0.9, 0.9));
    tube(upper, [[[hip[0] - 0.06 * s, hip[1] + 0.06, hip[2] - 0.08], 0.06, 0.2], [[hip[0] + 0.02 * s, hip[1] - 0.1, hip[2] - 0.06], 0.085, 0.24], [lerp(hip, stifle, 0.55), 0.088, 0.19], [lerp(hip, stifle, 0.82), 0.072, 0.12], [[stifle[0], stifle[1] + 0.005, stifle[2] + 0.005], 0.056, 0.065]], 8);
    // The gaskin back and down to the hock, its muscle behind at the top.
    const lower = coat(`lower${l}`, legTone(s, stifle, hock, -0.9, 1.2));
    const g = (t: number, dz = 0): P => add(lerp(stifle, hock, t), [0, 0, dz]);
    tube(lower, [[g(-0.04, 0.005), 0.058, 0.07], [g(0.2, -0.035), 0.066, 0.1], [g(0.45, -0.03), 0.056, 0.076], [g(0.72, -0.012), 0.044, 0.052], [[hock[0], hock[1] + 0.025, hock[2]], 0.039, 0.044]], 8);
    // The hock with a small point behind, the cannon tapering to the fetlock.
    const cannon = coat(`cannon${l}`, legTone(s, hock, fet, -1.25, 2.9));
    cannon.blob(hock, [0.04, 0.046, 0.047], 65 + s, 0.03, 8, 2);
    cannon.blob([hock[0], hock[1] + 0.02, hock[2] - 0.035], [0.027, 0.035, 0.03], 71 + s, 0.03, 6, 2);
    tube(cannon, [[[hock[0], hock[1] - 0.02, hock[2]], 0.038, 0.042], [lerp(hock, fet, 0.5), 0.032, 0.036], [[fet[0], fet[1] + 0.03, fet[2]], 0.029, 0.033]], 8);
    foot(l, s, fet, coffin, 0.93, 4 + s);
  };
  foreLeg('FL', 1);
  foreLeg('FR', -1);
  hindLeg('HL', 1);
  hindLeg('HR', -1);

  // --- Tack: the rug, the rope harness, the lantern ---------------------------------------------------------------
  {
    const rug = B.part('body', SLOT.rug).tone(null);
    const inside = (c: RGB): RGB => [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55];
    for (const s of [1, -1]) {
      for (let j = 0; j + 1 < RUG_ROWS.length; j++) {
        const [a0, kind] = RUG_ROWS[j]!, a1 = RUG_ROWS[j + 1]![0];
        for (let i = 0; i < RUG_COLS; i++) {
          const z0 = RUG_Z0 + ((RUG_Z1 - RUG_Z0) * i) / RUG_COLS, z1 = RUG_Z0 + ((RUG_Z1 - RUG_Z0) * (i + 1)) / RUG_COLS;
          const TL = rugAt(z0, a0, s), TR = rugAt(z1, a0, s), BL = rugAt(z0, a1, s), BR = rugAt(z1, a1, s);
          const centre: P = [0, 1.15, (z0 + z1) / 2];
          // The front and back columns are a dark border.
          const edge = i === 0 || i === RUG_COLS - 1;
          const paint = (k: 'base' | 'light' | 'dark'): void => {
            if (k === 'base' && !edge) rug.paint(WHITE, MAT.tint, 0.05);
            else rug.paint(k === 'light' && !edge ? RUG_LIGHT : RUG_DARK, MAT.flat, 0.05);
          };
          if (kind === 'zig' && !edge) {
            // The zigzag: each quad cut on alternating diagonals, its lower triangle light, its upper the rug's colour.
            if (i % 2 === 0) {
              paint('light');
              rug.tri(TL, BL, BR, centre);
              paint('base');
              rug.tri(TL, BR, TR, centre);
            } else {
              paint('light');
              rug.tri(TR, BL, BR, centre);
              paint('base');
              rug.tri(TL, BL, TR, centre);
            }
          } else {
            paint(kind === 'zig' ? 'dark' : kind);
            rug.quad(TL, BL, BR, TR, centre);
          }
          // The inside, darker.
          rug.paint(inside(kind === 'base' && !edge ? RUG_DARK : RUG_DARK), MAT.flat, 0.03);
          const out: P = [TL[0] * 3, TL[1], (z0 + z1) / 2];
          rug.quad(TL, BL, BR, TR, out);
        }
      }
    }
    // Tassels along the lower edges and bigger ones at the corners.
    // The big ones hang on bones of their own and swing (the front left corner carries the lantern instead).
    const small = B.part('body', SLOT.trim).paint(TASSEL, MAT.flat, 0.12).tone(null);
    const corner = (i: number, s: number): Bone | null => (i === 0 ? (s > 0 ? 'tasselHL' : 'tasselHR') : i === RUG_COLS && s < 0 ? 'tasselFR' : null);
    for (const s of [1, -1]) {
      for (let i = 0; i <= RUG_COLS; i += 2) {
        const z = RUG_Z0 + ((RUG_Z1 - RUG_Z0) * i) / RUG_COLS;
        const p = rugAt(z, -0.2, s);
        const big = i === 0 || i === RUG_COLS;
        const len = big ? 0.13 : 0.075, r = big ? 0.024 : 0.016;
        const own = corner(i, s);
        const tassel = own ? B.part(own, SLOT.trim).paint(TASSEL, MAT.flat, 0.12).tone(null) : small;
        if (big) tassel.blob([p[0], p[1] - 0.01, z], [0.022, 0.02, 0.022], 101 + i + (s > 0 ? 0 : 50), 0.05, 5, 1);
        tassel.cone(ringOn([p[0], p[1] - (big ? 0.025 : 0.005), z], [1, 0, 0], [0, 0, 1], r, r, 4, 0.5), [p[0], p[1] - len, z]);
      }
    }
    // A low pad under the seat.
    const pad = B.part('body', SLOT.trim).paint(PAD, MAT.flat, 0.06).tone(null);
    const padRing = (z: number): P[] => [rugAt(z, 0.95, 1, 0.03), rugAt(z, 1.3, 1, 0.055), rugAt(z, 1.84, 1, 0.055), rugAt(z, 2.19, 1, 0.03)].map((p, k): P => (k < 2 ? p : [-Math.abs(p[0]), p[1], p[2]]));
    // A pad: the rings over the back from left to right, closed by a bottom row on the rug.
    const padRows = [-0.33, -0.2, 0.05, 0.16].map((z) => {
      const r = padRing(z);
      return [...r, rugAt(z, 2.19, 1, 0.0).map((v, k) => (k === 0 ? -Math.abs(v) : v)) as unknown as P, rugAt(z, 0.95, 1, 0.0)];
    });
    pad.loft(padRows);
  }
  // The rope harness: a breast rope round the front of the chest, a collar round the base of the neck, a rope rein from
  // the collar's rings back over the withers to the rider's hands, a loop between the hands, and a stirrup loop down
  // each side. The grips and the stirrups are placed in metres from the seat at any `SIZE` (they are for a rider whose
  // size does not change with the steed's): the hands low ahead of the seat, the feet high at the flanks.
  const GRIP: P = [0.09 / SIZE, SEAT[1] + 0.2 / SIZE, SEAT[2] + 0.4 / SIZE];
  const STIRRUP: P = [0.27, SEAT[1] - 0.2 / SIZE, SEAT[2] + 0.06 / SIZE];
  {
    for (const s of [1, -1]) {
      const breast = B.part('chest', SLOT.trim).tone(null);
      const on = (z: number, a: number): P => {
        const p = across(z, a, 1.07);
        return [p[0] * s, p[1], p[2]];
      };
      rope(breast, [on(0.5, 1.2), on(0.7, 0.62), on(0.82, 0.12), on(0.9, -0.5), on(0.93, -1.1), on(0.935, -Math.PI / 2)], 0.019);
    }
    const collar = B.part('neck', SLOT.trim).tone(null);
    const COLLAR: P = neckAt(0.16);
    const [cw, cd] = neckSize(0.16);
    const cr = ringOn(COLLAR, [1, 0, 0], NV, cw + 0.012, cd + 0.012, 12, 0.5);
    rope(collar, [...cr, cr[0]!], 0.019);
    // A brass ring on each side of the collar where the rein is tied.
    /** The collar's ring on side `s`, a little up its side toward the crest. */
    const ringAt = (s: number): P => add(add(COLLAR, [(cw + 0.004) * s, 0, 0]), mul(NV, 0.3 * cd));
    for (const s of [1, -1]) collar.paint(BRASS, MAT.flat, 0).blob(ringAt(s), [0.025, 0.025, 0.025], 91 + s, 0.05, 5, 1);
    const handles = B.part('body', SLOT.trim).tone(null);
    // The rein: from the hands it sags onto the withers and rises along the neck to the collar's rings.
    for (const s of [1, -1]) {
      const g: P = [GRIP[0] * s, GRIP[1], GRIP[2]];
      const withers: P = [0.1 * s, 1.5, Math.max(GRIP[2] + 0.18, 0.5)];
      rope(handles, [g, [0.095 * s, (GRIP[1] + withers[1]) / 2 - 0.01, (GRIP[2] + withers[2]) / 2], withers, [0.13 * s, 1.51, 0.72], ringAt(s)], 0.015);
    }
    // The loop between the hands, hanging back toward the seat.
    rope(handles, [[GRIP[0], GRIP[1], GRIP[2]], [0.03, GRIP[1] - 0.05, GRIP[2] - 0.06], [-0.03, GRIP[1] - 0.05, GRIP[2] - 0.06], [-GRIP[0], GRIP[1], GRIP[2]]], 0.015);
    for (const s of [1, -1]) {
      const top: P = rugAt(SEAT[2] - 0.02, 1.0, s, 0.01);
      const x = STIRRUP[0] * s, y = STIRRUP[1] - 0.09;
      rope(handles, [[top[0], top[1], top[2] - 0.07], [x, y, STIRRUP[2] - 0.06], [x, y, STIRRUP[2] + 0.06], [top[0], top[1], top[2] + 0.05]], 0.014, 0.08);
    }
  }
  // The lantern on its hook at the rug's front corner: a ring, a pointed cap, four posts and glowing panes.
  {
    const hook = B.part('body', SLOT.trim).paint(IRON, MAT.flat, 0.05).tone(null);
    const corner = rugAt(RUG_Z1, 0.05, 1);
    hook.limb([corner[0] - 0.01, corner[1] + 0.02, corner[2] - 0.02], [LANTERN[0], LANTERN[1] + 0.02, LANTERN[2]], 0.01, 0.01, 4);
    const l = B.part('lantern', SLOT.trim).paint(IRON, MAT.flat, 0.05).tone(null);
    const [x, , z] = LANTERN;
    const sq = (y: number, h: number): P[] => [[x - h, y, z - h], [x + h, y, z - h], [x + h, y, z + h], [x - h, y, z + h]];
    const TOP = LANTERN[1] - 0.075, FOOT = LANTERN[1] - 0.21, HT = 0.052, HF = 0.04;
    l.limb([x, LANTERN[1] + 0.01, z], [x, TOP + 0.06, z], 0.008, 0.008, 3);
    l.loft([sq(TOP, HT + 0.016), sq(TOP + 0.014, HT + 0.016)]);
    l.cone(sq(TOP + 0.014, HT + 0.006), [x, TOP + 0.065, z]);
    l.loft([sq(FOOT - 0.016, HF + 0.012), sq(FOOT, HF + 0.012)]);
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) l.limb([x + dx * HF, FOOT, z + dz * HF], [x + dx * HT, TOP, z + dz * HT], 0.009, 0.009, 4);
    const mid = (FOOT + TOP) / 2, hm = (HF + HT) / 2;
    for (const [ux, uz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const at = (y: number, h: number, side: number, out = 0): P => [x + ux * (h + out) - uz * side * h, y, z + uz * (h + out) + ux * side * h];
      l.paint(GLASS, MAT.glow, 0.03).quad(at(FOOT, HF, -0.9), at(FOOT, HF, 0.9), at(TOP, HT, 0.9), at(TOP, HT, -0.9), [x, mid, z]);
      l.paint(GLASS_CORE, MAT.glow, 0);
      l.quad(at(mid - 0.035, hm - 0.006, 0, 0.004), at(mid, hm, 0.5, 0.004), at(mid + 0.04, hm + 0.006, 0, 0.004), at(mid, hm, -0.5, 0.004), [x, mid, z]);
    }
  }

  // --- Motions (trunk, neck, head, feathers, tail, lantern; the legs are the step cycle's) ---------------------------
  const S = SIZE;
  /** Named hash streams of the standing motion's chance events. */
  const STREAM = { featherL: 0x46_4c_31, featherR: 0x46_4c_32, tail: 0x54_41_49, look: 0x4c_4f_4b } as const;
  /**
   * A twitch −1 to 1 at times drawn from the stream `key`: time is cut into windows of `period` s, in each window a
   * twitch of `len` s happens with the chance `chance` at a drawn moment, its side drawn too. 0 between twitches.
   */
  const twitch = (t: number, period: number, key: number, seed: number, chance: number, len: number): number => {
    const k = Math.floor(t / period);
    const h = (i: number): number => unit(hashInts(key, Math.round(seed * 4096), k, i));
    if (h(0) > chance) return 0;
    const x = (t - (k + 0.1 + 0.55 * h(1)) * period) / len;
    if (x < 0 || x > 1) return 0;
    return Math.sin(Math.PI * x) * (h(2) < 0.5 ? -1 : 1);
  };
  /** As `twitch`, but how far through the event the time is (0–1), −1 between events. */
  const during = (t: number, period: number, key: number, seed: number, chance: number, len: number): number => {
    const k = Math.floor(t / period);
    const h = (i: number): number => unit(hashInts(key, Math.round(seed * 4096), k, i));
    if (h(0) > chance) return -1;
    const x = (t - (k + 0.1 + 0.55 * h(1)) * period) / len;
    return x < 0 || x > 1 ? -1 : x;
  };
  type Pose = MotionPose;
  /** The tail's links turned up (+) or down by `pitch`, sideways by `yaw`, each. */
  const tailPose = (pose: Pose, pitch: readonly number[], yaw: readonly number[]): void => {
    turn(pose, id.tail, pitch[0]!, yaw[0]!);
    turn(pose, id.tail2, pitch[1]!, yaw[1]!);
    turn(pose, id.tail3, pitch[2]!, yaw[2]!);
    turn(pose, id.tail4, pitch[3]!, yaw[3]!);
    turn(pose, id.tail5, pitch[4]!, yaw[4]!);
  };
  /** The feathers: raised (+) or laid back (−) by `lift`, folded in by `fold`, each tip fluttering by `flutterL`/`R`. */
  const feathers = (pose: Pose, lift: number, fold: number, flutterL: number, flutterR: number): void => {
    turn(pose, id.featherL, lift + 0.5 * flutterL, fold);
    turn(pose, id.featherL2, 0.08 + flutterL, 0.3 * fold);
    turn(pose, id.featherR, lift + 0.5 * flutterR, -fold);
    turn(pose, id.featherR2, 0.08 + flutterR, -0.3 * fold);
  };
  /** The neck tilted by `n1` and `n2` (+ lowers it), the head turned back so that it stays level (plus `nod`). */
  const neckAndHead = (pose: Pose, n1: number, n2: number, trunk: number, nod: number, yaw = 0): void => {
    turn(pose, id.neck, n1, 0.4 * yaw);
    turn(pose, id.neck2, n2, 0.35 * yaw);
    turn(pose, id.head, nod - n1 - n2 - trunk, 0.25 * yaw);
  };
  const stand: FigureMotion = {
    sample(pose, t, f) {
      const w = f.seed * TAU;
      const breath = Math.sin((TAU * t) / 3.4 + w);
      const sway = Math.sin((TAU * t) / 10.5 + 2 * w);
      shift(pose, id.body, 0.008 * S * sway, 0.005 * S * breath, 0);
      turn(pose, id.body, 0.004 * breath, 0, 0.01 * sway);
      turn(pose, id.chest, -0.007 * breath);
      turn(pose, id.loin, 0.003 * breath);
      turn(pose, id.croup, 0.002 * breath);
      // Now and then the head turns to one side and back.
      const look = twitch(t, 7.5, STREAM.look, f.seed, 0.7, 2.6);
      neckAndHead(pose, 0.1 + 0.02 * Math.sin((TAU * t) / 6.1 + w), 0.04, 0.004 * breath - 0.007 * breath, 0.04 * Math.sin((TAU * t) / 4.9 + w), 0.45 * look);
      // The feathers stand a little and twitch; the tail hangs in a curve, its tip up, and swishes at times.
      const fl = twitch(t, 3.3, STREAM.featherL, f.seed, 0.55, 0.45), fr = twitch(t, 3.7, STREAM.featherR, f.seed, 0.55, 0.45);
      feathers(pose, 0.04 + 0.02 * breath + 0.22 * Math.abs(fl), 0.05, 0.25 * fl * Math.sin(TAU * 2.2 * t), 0.25 * fr * Math.sin(TAU * 2.2 * t + 1));
      const swish = twitch(t, 4.6, STREAM.tail, f.seed, 0.6, 1.1);
      const sw = (k: number): number => 0.22 * swish * Math.sin(TAU * 1.6 * t - 0.9 * k);
      // A dip behind the root, then rising toward the leaves.
      tailPose(pose, [-0.5 + 0.02 * breath, -0.16, 0.42, 0.44, 0.3], [sw(0), sw(1), sw(2), sw(3), sw(4)]);
      turn(pose, id.lantern, -0.004 * breath, 0, 0.02 * sway);
    },
  };
  // In the moving motions `t` is the phase of the step cycle (0–1 a pass), so the trunk moves with the footfalls.
  const bands = gaitBands(STEED_SPEEDS);
  const walk: FigureMotion = {
    unit: 'phase',
    speed: bands.walk,
    sample(pose, p) {
      // Footfalls: hind left 0, front left 0.25, hind right 0.5, front right 0.75, each hoof down 0.63 of the pass. A
      // leg carries most in the middle of its stance: front left about 0.57, front right 0.07, hind left 0.32, hind
      // right 0.82. `fore` and `hind` are +1 when the left leg of the pair carries, −1 the right; `two` +1 while a
      // fore leg stands under its shoulder.
      const fore = Math.cos(TAU * (p - 0.57));
      const hind = Math.cos(TAU * (p - 0.32));
      const two = Math.cos(2 * TAU * (p - 0.07));
      // The settling of the shoulders onto a fore leg just after it lands (front left 0.25, front right 0.75), over
      // before the other fore leg's carpus is fullest; `side` +1 while the front left settles, −1 the right.
      const settle = Math.cos(2 * TAU * (p - 0.34));
      const side = Math.cos(TAU * (p - 0.4));
      // The weight moves over the legs that carry it; the trunk sinks as each fore leg takes it.
      shift(pose, id.body, 0.024 * S * (0.55 * side + 0.45 * hind), (-0.022 - 0.026 * settle) * S, 0.008 * S * Math.cos(2 * TAU * (p - 0.2)));
      const pitch = 0.012 * two + 0.02 * settle;
      turn(pose, id.body, pitch, 0.012 * (fore - hind), 0);
      // The shoulder over the loaded fore leg drops and the swinging one is drawn forward; the hips roll and swing
      // the same way over the hind legs (the hip of the leg that pushes goes back).
      turn(pose, id.chest, 0.045 * settle, 0.05 * fore, -0.07 * side);
      turn(pose, id.loin, -0.006 * Math.cos(2 * TAU * (p - 0.32)), 0.02 * hind, -0.02 * hind);
      turn(pose, id.croup, -0.008 * Math.cos(2 * TAU * (p - 0.32)), 0.04 * hind, -0.04 * hind);
      // The head nods down each time a fore leg takes the weight and up as it pushes off (the neck swings, the head
      // follows it half way), and turns a little with the shoulders.
      neckAndHead(pose, 0.12 + 0.18 * settle, 0.03 + 0.065 * settle, pitch + 0.045 * settle, -0.1 * settle, -0.12 * fore);
      feathers(pose, -0.02 - 0.04 * two, 0.08, 0.06 * Math.sin(2 * TAU * (p - 0.15)), 0.06 * Math.sin(2 * TAU * (p - 0.15) + 1.3));
      // The tail swings with the hips, a wave running down it.
      const sw = (k: number): number => 0.09 * hind + 0.09 * Math.sin(TAU * (p - 0.32) - 0.8 * k);
      tailPose(pose, [-0.4 + 0.04 * Math.cos(2 * TAU * (p - 0.4)), -0.1, 0.24, 0.28, 0.2], [sw(0), sw(1), sw(2), sw(3), sw(4)]);
      turn(pose, id.lantern, 0.06 * Math.sin(2 * TAU * (p - 0.15)), 0, 0.07 * fore);
    },
  };
  const trot: FigureMotion = {
    unit: 'phase',
    speed: bands.trot,
    sample(pose, p) {
      // Front left with hind right land at 0, the other pair at 0.5, each down 0.42 of the pass: the trunk is lowest in
      // the middle of a stance (0.21, 0.71), springs up off the pair and floats over the flight between them. `diag` is
      // +1 while front left and hind right carry, −1 the other pair.
      const two = Math.cos(2 * TAU * (p - 0.21));
      const diag = Math.cos(TAU * (p - 0.21));
      shift(pose, id.body, 0.006 * S * diag, (-0.016 - 0.032 * two) * S, 0);
      const pitch = 0.012 * Math.sin(2 * TAU * (p - 0.12));
      turn(pose, id.body, pitch, 0, 0);
      // The loaded fore leg's shoulder drops, the loaded hind leg's hip drops: the trunk twists between the diagonals.
      turn(pose, id.chest, 0.02 * two, 0.025 * diag, -0.035 * diag);
      turn(pose, id.loin, -0.008 * two, -0.012 * diag, 0.016 * diag);
      turn(pose, id.croup, -0.012 * two, -0.018 * diag, 0.024 * diag);
      // The neck dips after the trunk (it lags a little), the head held steady on it.
      const lag = Math.cos(2 * TAU * (p - 0.27));
      neckAndHead(pose, 0.18 + 0.06 * lag, 0.02 + 0.03 * lag, pitch + 0.02 * two, -0.025 * lag);
      feathers(pose, -0.1 - 0.05 * lag, 0.12, 0.08 * Math.sin(2 * TAU * (p - 0.3)), 0.08 * Math.sin(2 * TAU * (p - 0.3) + 1.1));
      // The tail bobs against the trunk's bounce and swings with the hips.
      const wave = (k: number): number => 0.07 * Math.cos(2 * TAU * (p - 0.3) - 0.9 * k);
      tailPose(pose, [-0.3 + wave(0), -0.04 + wave(1), 0.2 + wave(2), 0.22 + wave(3), 0.16 + wave(4)], [0.05 * diag, 0.02 * diag, 0, 0, 0]);
      turn(pose, id.lantern, 0.1 * lag, 0, 0.04 * diag);
    },
  };
  const gallop: FigureMotion = {
    unit: 'phase',
    speed: bands.gallop,
    sample(pose, p) {
      // Front legs down 0–0.32, the gathered flight, hind legs 0.45–0.77, the stretched flight about 0.89. The back
      // rounds in the gathered flight (croup down, chest down) and lies long, a little hollow, in the stretch; the bend
      // is spread over the loin and the croup. The trunk rocks nose down on the front legs and nose up on the hind legs
      // and rises in both flights.
      const flex = Math.cos(TAU * (p - 0.39));
      const round = flex > 0 ? flex : 0.55 * flex;
      shift(pose, id.body, 0, (0.035 * Math.cos(2 * TAU * (p - 0.39)) - 0.015) * S, 0.03 * S * flex);
      const pitch = 0.085 * Math.cos(TAU * (p - 0.17));
      turn(pose, id.body, pitch);
      turn(pose, id.loin, -0.2 * round);
      turn(pose, id.croup, -0.24 * round);
      turn(pose, id.chest, 0.24 * round);
      // The neck reaches out low in the stretch and lifts in the gathered flight; the head stays level.
      const reach = Math.cos(TAU * (p - 0.89));
      neckAndHead(pose, 0.48 + 0.1 * reach, 0.1 + 0.04 * Math.cos(TAU * (p - 0.95)), pitch + 0.15 * round, 0.1);
      // The feathers laid flat back, fluttering; the tail level behind, a wave running down it.
      feathers(pose, -0.2, 0.12, 0.12 * Math.sin(4 * TAU * p), 0.12 * Math.sin(4 * TAU * p + 1.7));
      // The fore legs' landing pitches the trunk nose down and throws the lagging tail up; it is held down against
      // that through the fore stance, so it stays a level line behind.
      const wave = (k: number): number => 0.1 * Math.sin(TAU * (p - 0.12 * k));
      const hold = Math.max(0, Math.cos(TAU * (p - 0.14)));
      tailPose(pose, [-0.12 - 0.06 * reach + 0.25 * round - 0.3 * hold, -0.06 - 0.12 * hold + wave(1), 0.16 + wave(2), 0.18 + wave(3), 0.14 + wave(4)], [0.04 * Math.sin(TAU * p), 0, 0, 0, 0]);
      turn(pose, id.lantern, -0.2 - 0.1 * Math.cos(TAU * (p - 0.2)), 0, 0.05 * Math.sin(TAU * p));
    },
  };

  // --- The face and the breath (on top of the motions) ---------------------------------------------------------------
  /** Named hash streams of the face's chance events. */
  const FACE = { blink: 0x42_4c_4b, yawn: 0x59_41_57, lick: 0x4c_49_43 } as const;
  /** Turns a bone further about its own x by `a` (after what the motions gave it). */
  const pitchMore = (pose: Pose, bone: number, a: number): void => {
    const r = pose.rot, o = bone * 4;
    const x = r[o]!, y = r[o + 1]!, z = r[o + 2]!, w = r[o + 3]!;
    const sx = Math.sin(a / 2), cx = Math.cos(a / 2);
    r[o] = w * sx + x * cx;
    r[o + 1] = y * cx + z * sx;
    r[o + 2] = z * cx - y * sx;
    r[o + 3] = w * cx - x * sx;
  };
  const lidL = lidHinge(1), lidR = lidHinge(-1);
  /** An eyelid shut by `shut` (0 open, as it is made; 1 over the eye): turned about its hinge. */
  const lid = (pose: Pose, bone: number, h: { axis: P; open: number }, shut: number): void => {
    const a = -0.5 * h.open * shut, sn = Math.sin(a), o = bone * 4;
    pose.rot[o] = h.axis[0] * sn;
    pose.rot[o + 1] = h.axis[1] * sn;
    pose.rot[o + 2] = h.axis[2] * sn;
    pose.rot[o + 3] = Math.cos(a);
  };
  /**
   * The mouth, the tongue, the eyelids and the breath. Calm, the mouth is shut. Worked hard (`effort`) it hangs open
   * with the tongue out: in the gallop opening with the stride, afterwards panting with the breath until the effort
   * has gone. Standing rested it yawns now and then (the head lifted, the eyes shut) or licks its nose. It blinks.
   */
  const life = (pose: Pose, s: Readonly<SteedLife>): void => {
    const still = 1 - ramp(s.speed, 0.15, 0.6);
    const pant = smooth(ramp(s.effort, 0.18, 0.5));
    const run = ramp(s.speed, 5, 8);
    const b = Math.sin(TAU * s.breath);
    const yx = during(s.time, 19, FACE.yawn, s.seed, 0.6, 3.6);
    const yawn = yx < 0 ? 0 : still * (1 - pant) * smooth(ramp(yx, 0, 0.4)) * (1 - smooth(ramp(yx, 0.72, 1)));
    const lx = yx < 0 ? during(s.time, 6.5, FACE.lick, s.seed, 0.5, 1.1) : -1;
    const lick = lx < 0 ? 0 : still * (1 - pant) * Math.sin(Math.PI * lx);
    const bx = during(s.time, 2.9, FACE.blink, s.seed, 0.85, 0.2);
    const blink = bx < 0 ? 0 : Math.sin(Math.PI * bx);
    // The jaw: with the breath when panting, with the stride in the gallop (widest as the fore legs land).
    const beat = mixN(b, Math.cos(TAU * (s.phase - 0.05)), run);
    turn(pose, id.jaw, pant * (0.2 + 0.055 * beat) + 0.62 * yawn + 0.13 * lick);
    // The tongue slides out along the jaw; its tip hangs over the chin when panting (flapping in the gallop), curls up
    // in a yawn, and sweeps up over the nose in a lick.
    const out = (0.072 * pant + 0.02 * yawn + 0.07 * lick) * S;
    shift(pose, id.tongue, 0, HU[1] * out, HU[2] * out);
    turn(pose, id.tongue, -0.1 * yawn - 0.22 * lick, 0.1 * run * pant * Math.sin(TAU * s.phase));
    turn(pose, id.tongue2, pant * (0.5 + 0.14 * Math.sin(TAU * s.breath - 0.9) * (1 - run) + 0.2 * run * Math.cos(TAU * (s.phase - 0.2))) - 0.45 * yawn - 0.9 * lick, (lx < 0 ? 0 : 0.5 * lick * Math.cos(Math.PI * lx)) + 0.25 * run * pant * Math.sin(TAU * (s.phase - 0.15)));
    // The eyelids: a blink, shut through the middle of a yawn, narrowed against the wind in the gallop.
    const shut = Math.max(blink, smooth(ramp(yawn, 0.35, 0.9)), 0.3 * run);
    lid(pose, id.lidL, lidL, shut);
    lid(pose, id.lidR, lidR, shut);
    // The yawn lifts the head; the breath heaves the chest when it is short.
    pitchMore(pose, id.head, -0.2 * yawn);
    pitchMore(pose, id.neck2, -0.08 * yawn);
    const heave = pant * (1 - run) * b;
    pose.offset[id.body * 3 + 1] = pose.offset[id.body * 3 + 1]! + 0.006 * S * heave;
    pitchMore(pose, id.chest, -0.018 * heave);
    pitchMore(pose, id.neck, 0.012 * heave);
  };

  // --- Sockets ----------------------------------------------------------------------------------------------------
  /** A socket at a rest point of a bone, turned about x by `ax`. */
  const socket = (bone: Bone, at: P, ax = 0): { bone: number; local: number[] } => {
    const p = B.local(bone, at);
    const c = Math.cos(ax), s = Math.sin(ax);
    return { bone: p.bone, local: [1, 0, 0, 0, c, s, 0, -s, c, p.at[0], p.at[1], p.at[2]] };
  };

  // --- Looks ------------------------------------------------------------------------------------------------------
  const COATS = ['#c4622a', '#8f877c', '#7d3a20', '#c99d63', '#a24d26', '#b5713c'].map(rgb);
  const FEATHERS = ['#235f57', '#3c5f86', '#5b7a2c', '#2a6670', '#5a3f72', '#2f6d4c'].map(rgb);
  const RUGS = ['#7a2f22', '#2e566e', '#a8742c', '#5e2a48', '#3f5a2a', '#6a3a24'].map(rgb);
  const SHEET: FigureLook[] = [0, 1, 2, 3].map((k): FigureLook => ({ colors: [COATS[k]!, FEATHERS[k]!, RUGS[k]!], features: 0 }));
  const look = (variant: number): FigureLook => {
    const v = Math.trunc(Math.abs(variant));
    if (v < 4) return SHEET[v]!;
    const pick = (k: number, n: number): number => Math.floor(unit(hashInts(5813, v, k)) * n) % n;
    return { colors: [COATS[pick(0, COATS.length)]!, FEATHERS[pick(1, FEATHERS.length)]!, RUGS[pick(2, RUGS.length)]!], features: 0 };
  };

  const legOf = (l: Leg, s: number, forward: boolean): SteedLeg => {
    const at = forward ? front(s).slice(1) : hind(s);
    const toe = at[5]!;
    return {
      chain: { upper: id[`upper${l}`], lower: id[`lower${l}`], end: id[`toe${l}`], bend: forward ? [1, 0, 0] : [-1, 0, 0] },
      cannon: id[`cannon${l}`],
      pastern: id[`pastern${l}`],
      hoof: id[`hoof${l}`],
      fold: forward ? 1.6 : -1.2,
      flick: forward ? 1.0 : 0.8,
      give: forward ? 0.42 : 0.36,
      // The carpus folds early, fullest before the middle of the swing, and opens again over the rest of it until the
      // paw lands; the hock folds first as the hind leg is drawn forward under the body.
      swingFold: forward ? [0, 0.4, 1] : [0, 0.34, 1],
      ...(forward ? { blade: { bone: id[`blade${l as 'FL' | 'FR'}`], share: 0.4 } } : {}),
      // The heel rises about the toe as the leg trails behind its pivot at the end of a stance.
      heel: forward ? { lift: 0.62, from: -0.06, to: -0.34 } : { lift: 0.58, from: -0.04, to: -0.32 },
      // At a gallop: fore legs fold tight under the chest as they come forward and straighten only to reach out before
      // they land; hind legs trail straight back after the push and fold late, as they swing forward under the body.
      foldIn: forward ? [0, 0.74] : [0.3, 1],
      // Fore legs: tucked back under the chest early in the swing, then far forward and up before they land (the
      // stretched flight's leap, the leg level with the ground). Hind legs: far back and up after the push, then
      // forward under the belly, past where the fore feet stand, before they land. Raised, not pulled in, when out of
      // reach (`liftClamp`).
      reach: forward
        ? [{ from: 0, at: 0.2, to: 0.55, d: [-0.25 * S, 0.5 * S] }, { from: 0.5, at: 0.84, to: 1, d: [1.0 * S, 0.24 * S] }]
        : [{ from: 0, at: 0.18, to: 0.46, d: [-1.25 * S, 0.5 * S] }, { from: 0.42, at: 0.75, to: 1, d: [0.65 * S, 0.4 * S] }],
      liftClamp: true,
      pole: forward ? [at[0]![0] * S, 0.75 * S, -1.4 * S] : [at[0]![0] * S, 0.8 * S, 1.4 * S],
      home: [toe[0] * S, 0, toe[2] * S],
      endHeight: toe[1] * S,
    };
  };

  return {
    name: 'steed',
    skeleton: B.skeleton,
    parts: B.parts(),
    motions: { stand, walk, trot, gallop },
    anchors: { head: B.local('head', onHead(0.15)), seat: B.local('body', SEAT) },
    look,
    heightM: 2.05 * S,
    capacity: 4,
    shadowRangeM: 160,
    legs: {
      chains: [legOf('FL', 1, true).chain, legOf('FR', -1, true).chain, legOf('HL', 1, false).chain, legOf('HR', -1, false).chain],
      pelvis: id.body,
    },
    gaze: {
      bones: [id.neck, id.neck2, id.head],
      shares: [0.35, 0.3, 0.35],
      eye: B.local('head', onHead(0.14, 0.04)).at,
      maxYaw: 70 * (Math.PI / 180),
      maxUp: 15 * (Math.PI / 180),
      maxDown: 25 * (Math.PI / 180),
    },
    lag: [
      // The tail: long and light, slow to follow, swinging after a stop.
      { bones: [id.tail, id.tail2, id.tail3, id.tail4, id.tail5], end: [0, 0, -0.5 * S], stiffness: 110, damping: 13, gravity: 0.12, maxAngle: 0.3 },
      // The leaves at its tip follow it late.
      { bones: [id.tuft], end: [0, 0, -0.45 * S], stiffness: 70, damping: 7, gravity: 0.1, maxAngle: 0.45 },
      // The leaf feathers: stiff near the head, the tips light.
      { bones: [id.featherL, id.featherL2], end: mul(featherDir(1), (FEATHER_LEN / 2) * S), stiffness: 170, damping: 10, gravity: 0.08, maxAngle: 0.35 },
      { bones: [id.featherR, id.featherR2], end: mul(featherDir(-1), (FEATHER_LEN / 2) * S), stiffness: 170, damping: 10, gravity: 0.08, maxAngle: 0.35 },
      // The lantern on its hook, swinging.
      { bones: [id.lantern], end: [0, -0.2 * S, 0], stiffness: 30, damping: 3.5, gravity: 0.6, maxAngle: 0.7 },
      // The big tassels at the corners of the rug.
      ...[id.tasselFR, id.tasselHL, id.tasselHR].map((b) => ({ bones: [b], end: [0, -0.12 * S, 0] as [number, number, number], stiffness: 55, damping: 4.5, gravity: 0.5, maxAngle: 0.6 })),
    ],
    sockets: {
      seat: socket('body', SEAT),
      gripL: socket('body', GRIP, -0.5),
      gripR: socket('body', [-GRIP[0], GRIP[1], GRIP[2]], -0.5),
      stirrupL: socket('body', STIRRUP),
      stirrupR: socket('body', [-STIRRUP[0], STIRRUP[1], STIRRUP[2]]),
    },
    steps: {
      legs: [legOf('FL', 1, true), legOf('FR', -1, true), legOf('HL', 1, false), legOf('HR', -1, false)],
      patterns: STEED_STEPS,
      stretch: STRETCH_SHARE,
      trunk: id.body,
      speeds: STEED_SPEEDS,
      foldShare: FOLD_SHARE,
      // A slow walk keeps its long stride (under one pass a second) rather than shortening it.
      minRate: 0.9,
      life,
    },
  };
}

/** The kind with what its legs need for `QuadGait`. */
export type SteedKind = ReturnType<typeof steed>;

export const STEEDS = { steed } as const;
