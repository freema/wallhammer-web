// The blacksmith's corner inside the open forge shelter (B2: the forge with fire, an anvil on a block, barrels and
// crates): a stone hearth with a glowing coal bed and a fireback, a hood and a stone flue, leather bellows on a
// trestle (the pleated bag and the top board are an instanced part that pumps), the anvil on a stump with tongs,
// a quench trough with water, a tool rack on the back wall with hammers, tongs, files and horseshoes, coal sacks,
// a barrel and crates. Placed in the forge's local frame (layout: the anvil at local (0.6, 0.6), the smith works the
// fire from local (−1.8, 1.4)).

import type { BuildContext, Mat34, MeshBuilder, RGB, Stream, Vec3 } from '../kit/index.ts';
import { GLOW, MAT, MeshBuilder as Builder, PALETTE, VARY_RICH, VARY_SUBTLE, bevelBox, compose34, crookedBeam, lathe, mixRgb, mul34, rock, scaleRgb, sweep, vary, varyNext, waterFlags } from '../kit/index.ts';
import type { Structure } from '../layout.ts';
import { toWorld } from '../layout.ts';
import { PROP, facingFace, ironColor, lightWoodColor, woodColor } from './common.ts';
import { barrel, crate, sack } from './containers.ts';

/** Hearth centre and size in the forge's local frame. */
const HX = -1.75, HZ = 0.12;
const HW = 1.5, HD = 1.15, HH = 0.85;
/** Top of the stone flue above the floor. */
const FLUE_TOP = 4.7;
/** The bellows' hinge (nozzle end), local. */
const BELLOWS = { x: -2.62, y: 0.56, z: HZ + 0.05, length: 0.82 };

export interface ForgeAnchors {
  /** World point at the middle of the coal bed (fire particles start here). */
  fire: Vec3;
  /** World point just above the flue (forge smoke). */
  flueTop: Vec3;
  /** World point for the fire light. */
  light: Vec3;
  /** Heading of the forge front (for orienting effects). */
  yaw: number;
}

/** World anchors of the hearth for the effects (src/fx). */
export function forgeAnchors(ctx: BuildContext, forge: Structure): ForgeAnchors {
  const y = ctx.field.padY(forge.id);
  const w = (lx: number, ly: number, lz: number): Vec3 => {
    const [x, z] = toWorld(forge, lx, lz);
    return [x, y + ly, z];
  };
  return { fire: w(HX, HH + 0.08, HZ + 0.05), flueTop: w(HX, FLUE_TOP + 0.15, HZ - 0.22), light: w(HX, HH + 0.65, HZ + 0.45), yaw: forge.yaw };
}

/** Writes a closed loft through rings of equal length (sides flat, outward from each ring's centre), with caps. */
export function loft(b: MeshBuilder, rings: readonly Vec3[][], color: (j: number, k: number) => RGB, caps = true): void {
  const centre = (r: readonly Vec3[]): Vec3 => {
    const c: Vec3 = [0, 0, 0];
    for (const p of r) (c[0] += p[0] / r.length), (c[1] += p[1] / r.length), (c[2] += p[2] / r.length);
    return c;
  };
  for (let j = 0; j + 1 < rings.length; j++) {
    const A = rings[j]!, B = rings[j + 1]!;
    const ca = centre(A), cb = centre(B);
    const mid: Vec3 = [(ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2, (ca[2] + cb[2]) / 2];
    for (let k = 0; k < A.length; k++) {
      const k1 = (k + 1) % A.length;
      const q: Vec3[] = [A[k]!, A[k1]!, B[k1]!, B[k]!];
      const qc: Vec3 = [(q[0]![0] + q[2]![0]) / 2, (q[0]![1] + q[2]![1]) / 2, (q[0]![2] + q[2]![2]) / 2];
      facingFace(b, q, [qc[0] - mid[0], qc[1] - mid[1], qc[2] - mid[2]], color(j, k));
    }
  }
  if (caps) {
    const first = rings[0]!, last = rings[rings.length - 1]!;
    const c0 = centre(first), c1 = centre(last);
    facingFace(b, [...first], [c0[0] - c1[0], c0[1] - c1[1], c0[2] - c1[2]], color(0, -1));
    facingFace(b, [...last], [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]], color(rings.length - 1, -1));
  }
}

/** The teardrop outline of the bellows (local: hinge at x = 0, the bag toward −x), `n` points. */
function teardrop(n: number, grow = 0): [number, number][] {
  const out: [number, number][] = [];
  const L = BELLOWS.length;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = -L / 2 - 0.02 + (L / 2 - 0.04) * Math.cos(a);
    const t = Math.min(1, Math.max(0, (-x - 0.04) / (L - 0.08)));
    const w = 0.08 + 0.26 * Math.sqrt(t) + grow;
    out.push([x + Math.cos(a) * grow, -w * Math.sin(a)]);
  }
  return out;
}

/** Height of the bag top over the hinge at local x (rises toward the back). */
const bagTop = (x: number): number => 0.04 + 0.3 * Math.min(1, -x / BELLOWS.length);

/**
 * The moving part of the bellows in its own frame (origin at the hinge, the bag toward −x): the pleated leather bag
 * and the top board with its handle. The module scales it in y to pump.
 */
export function bellowsPartMesh(s: Stream): MeshBuilder {
  const b = new Builder();
  const outline = teardrop(14);
  const leather = vary(PROP.leather, VARY_SUBTLE, s, 1);
  // Pleats: rings at five levels, alternately drawn in.
  const levels = 6;
  const rings: Vec3[][] = [];
  for (let j = 0; j <= levels; j++) {
    const f = j / levels;
    const inset = j > 0 && j < levels && j % 2 === 1 ? 0.045 : 0;
    rings.push(outline.map(([x, z]) => {
      const cx = -BELLOWS.length / 2;
      const k = 1 - inset / Math.max(0.1, Math.hypot(x - cx, z));
      return [cx + (x - cx) * k, f * bagTop(x), z * k] as Vec3;
    }));
  }
  b.withFlags({ cls: MAT.fabric }, () => loft(b, rings, (j) => scaleRgb(leather, j % 2 ? 0.72 : 1.0), false));
  // The top board: a slab on the slanted top.
  const board = teardrop(14, 0.035);
  const wood = woodColor(s, 2);
  const bottom = board.map(([x, z]) => [x, bagTop(x), z] as Vec3);
  const top = board.map(([x, z]) => [x, bagTop(x) + 0.05, z] as Vec3);
  b.withFlags({ cls: MAT.wood }, () => {
    loft(b, [bottom, top], (_j, k) => (k < 0 ? wood : scaleRgb(wood, 0.85)));
    // Handle: a pole from the back of the board.
    crookedBeam(b, [-BELLOWS.length + 0.08, bagTop(-BELLOWS.length) + 0.04, 0], [-BELLOWS.length - 0.25, bagTop(-BELLOWS.length) + 0.55, 0], scaleRgb(wood, 0.8), { width: 0.06, segments: 2 });
  });
  // Iron studs round the board.
  b.withFlags({ cls: MAT.metal }, () => {
    for (let i = 0; i < 14; i += 2) {
      const [x, z] = board[i]!;
      bevelBox(b, [x * 0.97 - 0.01, bagTop(x) + 0.05, z * 0.9], [0.03, 0.012, 0.03], PALETTE.ironLight, { bevel: 0.006 });
    }
  });
  return b;
}

/** Builds the smithy into `b` (and the trough's water surface into `water`), all in world coordinates. */
export function smithy(ctx: BuildContext, b: MeshBuilder, water: MeshBuilder, forge: Structure): { bellowsHinge: Vec3 } {
  const s = ctx.stream('props.smithy');
  const floor = ctx.field.padY(forge.id);
  const m = compose34([forge.x, floor, forge.z], forge.yaw);
  b.with(m, () => {
    hearth(b, s.child('hearth'));
    bellowsBase(b, s.child('bellows'));
    anvil(b, s.child('anvil'));
    const at = compose34([1.95, 0, 0.75], 0.05);
    b.with(at, () => trough(b, water, s.child('trough'), 1.15, 0.52, 0.56, m, at));
    toolRack(b, s.child('rack'));
    // Stock: coal sacks by the hearth, a water barrel, crates of iron stock.
    const st = s.child('stock');
    for (let k = 0; k < 3; k++) {
      b.with(compose34([-3.05 + st.jitter(0.1, k, 1), 0, -1.25 + k * 0.5], st.range(0, 6, k, 2), 0, st.jitter(0.12, k, 3)), () => sack(b, st.child(k), { color: mixRgb(PROP.burlapDark, PROP.coal, 0.45), full: 0.9 }));
    }
    b.with(compose34([2.95, 0, 1.75], 0.4), () => barrel(b, st.child(10), { lid: false }));
    b.with(compose34([2.9, 0, -1.4], 0.15), () => crate(b, st.child(11)));
    b.with(compose34([2.85, 0.5, -1.38], 0.5), () => crate(b, st.child(12), { size: [0.55, 0.35, 0.45], open: true, content: 'pots' }));
    b.with(compose34([3.0, 0, -0.55], 1.2), () => barrel(b, st.child(13), { height: 0.8 }));
  });
  return { bellowsHinge: [BELLOWS.x, BELLOWS.y, BELLOWS.z] };
}

function hearth(b: MeshBuilder, s: Stream): void {
  const stone = (k: number): RGB => vary(s.pick([PALETTE.stone, PALETTE.stoneWarm, PALETTE.stoneDark], k, 1), VARY_RICH, s, k, 2);
  b.withFlags({ cls: MAT.stone }, () => {
    // Core.
    bevelBox(b, [HX, -0.3, HZ], [HW - 0.1, HH + 0.25, HD - 0.1], scaleRgb(PALETTE.stoneDark, 0.8), { bevel: 0.04 });
    // Facing blocks in courses, staggered.
    const courses = [0.32, 0.3, 0.3];
    let y = -0.3;
    let k = 0;
    courses.forEach((ch, c) => {
      for (const [side, len, axis] of [[1, HW, 0], [-1, HW, 0], [1, HD, 2], [-1, HD, 2]] as const) {
        const block = (at: number, w: number): void => {
          const kk = k++;
          const pos: Vec3 = axis === 0 ? [HX + at, y, HZ + side * (HD / 2)] : [HX + side * (HW / 2), y, HZ + at];
          const size: Vec3 = axis === 0 ? [w - 0.025, ch - 0.02, 0.2] : [0.2, ch - 0.02, w - 0.025];
          bevelBox(b, pos, size, stone(kk), { bevel: 0.05, jitter: 0.025, stream: s.child(kk), anchor: 'base' });
        };
        // Odd courses start with a short block, so the joints are staggered.
        let a = -len / 2;
        if (c % 2) {
          block(a + 0.11, 0.22);
          a += 0.22;
        }
        while (a < len / 2 - 0.05) {
          const w = Math.min(s.range(0.38, 0.56, k, 3), len / 2 - a);
          block(a + w / 2, w);
          a += w;
        }
      }
      y += ch;
    });
    // The rim round the coal pit: four thick flat slabs.
    const rimY = HH - 0.05;
    const pitW = 0.8, pitD = 0.55;
    bevelBox(b, [HX, rimY, HZ + (pitD / 2 + (HD - pitD) / 4)], [HW + 0.06, 0.14, (HD - pitD) / 2], stone(100), { bevel: 0.05, jitter: 0.02, stream: s.child(101) });
    bevelBox(b, [HX, rimY, HZ - (pitD / 2 + (HD - pitD) / 4)], [HW + 0.06, 0.14, (HD - pitD) / 2], stone(102), { bevel: 0.05, jitter: 0.02, stream: s.child(103) });
    bevelBox(b, [HX - (pitW / 2 + (HW - pitW) / 4), rimY, HZ], [(HW - pitW) / 2, 0.13, pitD + 0.02], stone(104), { bevel: 0.05, jitter: 0.02, stream: s.child(105) });
    bevelBox(b, [HX + (pitW / 2 + (HW - pitW) / 4), rimY, HZ], [(HW - pitW) / 2, 0.13, pitD + 0.02], stone(106), { bevel: 0.05, jitter: 0.02, stream: s.child(107) });
    // Fireback: a low stone wall behind the pit up to the hood.
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < 3; i++) {
        const w = HW / 3;
        bevelBox(b, [HX - HW / 2 + w * (i + 0.5) + (c % 2 ? 0.12 : 0) * (i === 2 ? -1 : 1), HH + 0.05 + c * 0.24, HZ - HD / 2 + 0.14], [w - 0.03, 0.22, 0.26], stone(200 + c * 3 + i), { bevel: 0.04, jitter: 0.02, stream: s.child(200 + c * 3 + i) });
      }
    }
  });
  // Coal bed: dark lumps, glowing toward the middle.
  const coal = s.child('coal');
  b.withFlags({ cls: MAT.stone, glow: 0, channel: GLOW.fire }, () => {
    bevelBox(b, [HX, HH - 0.06, HZ], [0.82, 0.12, 0.58], PROP.coal, { bevel: 0.03 });
  });
  for (let i = 0; i < 34; i++) {
    const u = coal.nextJitter(0.38), v = coal.nextJitter(0.26);
    const hot = Math.max(0, 1 - Math.hypot(u / 0.38, v / 0.26) * 1.1);
    const c = hot > 0.15 ? mixRgb(PROP.ember, PALETTE.fire, coal.next()) : varyNext(PROP.coal, VARY_SUBTLE, coal);
    b.withFlags({ cls: MAT.stone, glow: hot > 0.15 ? 0.45 + 0.55 * hot : 0, channel: GLOW.fire }, () => {
      rock(b, [HX + u, HH + 0.0, HZ + v], [coal.nextRange(0.07, 0.13), coal.nextRange(0.05, 0.09), coal.nextRange(0.07, 0.12)], c, { stream: coal.child(i), detail: 1, cuts: 4 });
    });
  }
  // Hood: a tapering plastered and stone-edged hood resting on the fireback and two iron rods, then the flue.
  const hy0 = 1.75, hy1 = 2.55;
  b.withFlags({ cls: MAT.plaster }, () => {
    bevelBox(b, [HX, hy0, HZ - 0.12], [HW + 0.15, hy1 - hy0, HD + 0.05], (p) => scaleRgb(mixRgb(PALETTE.plasterWarm, PALETTE.stoneDark, 0.35), 0.75 + 0.3 * ((p[1] - hy0) / (hy1 - hy0))), { bevel: 0.06, taper: [0.42, 0.5], lean: [0, -0.15] });
  });
  b.withFlags({ cls: MAT.wood }, () => crookedBeam(b, [HX - HW / 2 - 0.15, hy0 + 0.05, HZ + HD / 2 - 0.06], [HX + HW / 2 + 0.15, hy0 + 0.05, HZ + HD / 2 - 0.06], PALETTE.timberDark, { width: 0.16, depth: 0.2, sag: 0.02, segments: 3 }));
  b.withFlags({ cls: MAT.metal }, () => {
    for (const sx of [-1, 1]) crookedBeam(b, [HX + sx * (HW / 2 - 0.05), HH + 0.05, HZ + HD / 2 - 0.08], [HX + sx * (HW / 2 - 0.05), hy0 + 0.02, HZ + HD / 2 - 0.08], PALETTE.iron, { width: 0.045, segments: 2 });
  });
  b.withFlags({ cls: MAT.stone }, () => {
    let y = hy1 - 0.05;
    let c = 0;
    while (y < FLUE_TOP - 0.05) {
      const h = Math.min(0.32, FLUE_TOP - y);
      for (const [dx, dz, w, d] of [[0, 0.17, 0.66, 0.2], [0, -0.17, 0.66, 0.2], [0.24, 0, 0.18, 0.18], [-0.24, 0, 0.18, 0.18]] as const) {
        bevelBox(b, [HX + dx + (c % 2 ? 0.02 : -0.02), y, HZ - 0.22 + dz], [w, h - 0.02, d], stone(300 + c * 4 + Math.round(dx * 10) + Math.round(dz * 10)), { bevel: 0.04, jitter: 0.015, stream: s.child(300 + c) });
      }
      y += h;
      c++;
    }
    // Cap slab and the soot-dark opening.
    bevelBox(b, [HX, FLUE_TOP - 0.02, HZ - 0.22], [0.82, 0.1, 0.62], stone(400), { bevel: 0.04 });
    bevelBox(b, [HX, FLUE_TOP + 0.06, HZ - 0.22], [0.36, 0.04, 0.3], PROP.coal, { bevel: 0.01 });
  });
  // Tuyere: the iron pipe from the bellows into the hearth's side.
  b.withFlags({ cls: MAT.metal }, () => crookedBeam(b, [BELLOWS.x + 0.02, BELLOWS.y + 0.06, BELLOWS.z], [HX - HW / 2 + 0.1, BELLOWS.y + 0.12, BELLOWS.z], PALETTE.iron, { width: 0.07, segments: 2 }));
}

/** The static part of the bellows: the trestle and the bottom board. */
function bellowsBase(b: MeshBuilder, s: Stream): void {
  const wood = woodColor(s, 1);
  b.withFlags({ cls: MAT.wood }, () => {
    for (const dx of [-0.15, -0.65]) {
      const x = BELLOWS.x + dx;
      for (const sz of [-1, 1]) crookedBeam(b, [x, -0.05, BELLOWS.z + sz * 0.28], [x, BELLOWS.y - 0.06, BELLOWS.z + sz * 0.12], scaleRgb(wood, 0.85), { width: 0.08, segments: 2, stream: s.child(Math.round(dx * 10) + sz) });
      crookedBeam(b, [x, BELLOWS.y - 0.08, BELLOWS.z - 0.3], [x, BELLOWS.y - 0.08, BELLOWS.z + 0.3], wood, { width: 0.09, segments: 2 });
    }
    const outline = teardrop(14, 0.035);
    const lo = outline.map(([x, z]) => [BELLOWS.x + x, BELLOWS.y - 0.05, BELLOWS.z + z] as Vec3);
    const hi = outline.map(([x, z]) => [BELLOWS.x + x, BELLOWS.y, BELLOWS.z + z] as Vec3);
    loft(b, [lo, hi], (_j, k) => (k < 0 ? lightWoodColor(s, 2) : scaleRgb(wood, 0.8)));
  });
  b.withFlags({ cls: MAT.metal }, () => bevelBox(b, [BELLOWS.x + 0.02, BELLOWS.y, BELLOWS.z], [0.1, 0.1, 0.16], PALETTE.iron, { bevel: 0.015 }));
}

/** The anvil on its stump, tongs lying across the heel. */
function anvil(b: MeshBuilder, s: Stream): void {
  const ax = 0.6, az = 0.6;
  const stumpH = 0.5;
  const bark = vary(PALETTE.bark, VARY_SUBTLE, s, 1);
  b.withFlags({ cls: MAT.bark }, () => {
    lathe(b, [ax, -0.15, az], [[0.4, 0], [0.36, 0.15], [0.33, 0.4], [0.32, stumpH + 0.13], [0.31, stumpH + 0.15]], (p) => scaleRgb(bark, 0.75 + 0.35 * Math.min(1, (p[1] + 0.15) / 0.65)), { segments: 11, faceted: true, noise: 0.06, stream: s });
    // End grain on top with a darker ring.
    lathe(b, [ax, stumpH + 0.15, az], [[0.31, 0], [0.24, 0.005], [0.0001, 0.01]], (p) => (Math.hypot(p[0] - ax, p[2] - az) > 0.25 ? PROP.endGrainDark : PROP.endGrain), { segments: 11, phase: 0 });
  });
  const iron = ironColor(s, 2);
  const top = (_p: Vec3, n: Vec3): RGB => (n[1] > 0.8 ? mixRgb(PALETTE.ironLight, [0.75, 0.75, 0.8], 0.3) : scaleRgb(iron, 0.85 + 0.25 * Math.max(0, n[1])));
  const y0 = stumpH + 0.16;
  b.withFlags({ cls: MAT.metal }, () => {
    bevelBox(b, [ax, y0, az], [0.42, 0.08, 0.3], iron, { bevel: 0.02, taper: [0.75, 0.8] });
    bevelBox(b, [ax, y0 + 0.08, az], [0.26, 0.13, 0.17], iron, { bevel: 0.02, taper: [0.8, 0.85] });
    bevelBox(b, [ax - 0.02, y0 + 0.21, az], [0.5, 0.12, 0.2], top, { bevel: 0.025 });
    // Heel.
    bevelBox(b, [ax - 0.32, y0 + 0.24, az], [0.16, 0.09, 0.15], top, { bevel: 0.02, taper: [0.8, 0.9] });
    // Horn: a curved cone to +x.
    const horn: Vec3[] = [];
    for (let i = 0; i <= 6; i++) {
      const f = i / 6;
      horn.push([ax + 0.22 + f * 0.33, y0 + 0.27 + 0.03 * Math.sin(f * Math.PI * 0.8) - 0.02 * f, az]);
    }
    const prof: [number, number][] = [];
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      prof.push([Math.cos(a), Math.sin(a)]);
    }
    sweep(b, horn, prof, top, { scale: (f) => 0.075 * (1 - f * 0.88), caps: true });
    // Tongs on the heel side, hanging over the edge.
    crookedBeam(b, [ax - 0.25, y0 + 0.34, az + 0.02], [ax + 0.35, y0 + 0.37, az + 0.16], PALETTE.iron, { width: 0.022, segments: 2 });
    crookedBeam(b, [ax - 0.25, y0 + 0.34, az + 0.06], [ax + 0.35, y0 + 0.36, az + 0.08], PALETTE.iron, { width: 0.022, segments: 2 });
  });
}

/**
 * A plank trough with water, length along local x. The water surface goes into `water` (world coordinates through
 * `world`, the forge's transform).
 */
export function trough(b: MeshBuilder, water: MeshBuilder, s: Stream, len: number, wid: number, h: number, world: Mat34, extra?: Mat34): void {
  const wood = lightWoodColor(s, 1);
  b.withFlags({ cls: MAT.wood }, () => {
    // Feet.
    for (const sx of [-1, 1]) bevelBox(b, [sx * (len / 2 - 0.15), 0, 0], [0.14, 0.12, wid + 0.16], scaleRgb(wood, 0.7), { bevel: 0.03 });
    bevelBox(b, [0, 0.1, 0], [len, 0.07, wid], scaleRgb(wood, 0.75), { bevel: 0.015 });
    for (const sz of [-1, 1]) bevelBox(b, [0, 0.1, sz * (wid / 2 - 0.035)], [len, h - 0.1, 0.07], varyNext(wood, VARY_RICH, s), { bevel: 0.02, jitter: 0.01, stream: s });
    for (const sx of [-1, 1]) bevelBox(b, [sx * (len / 2 - 0.04), 0.1, 0], [0.08, h - 0.08, wid - 0.1], scaleRgb(wood, 0.9), { bevel: 0.02 });
  });
  b.withFlags({ cls: MAT.metal }, () => {
    for (const sx of [-0.3, 0.3]) bevelBox(b, [sx * len, h * 0.35, 0], [0.05, 0.05, wid + 0.03], PALETTE.iron, { bevel: 0.008 });
  });
  // Dark water body under the surface (solid) so the bottom does not show through.
  b.withFlags({ cls: MAT.glass }, () => bevelBox(b, [0, 0.17, 0], [len - 0.15, h - 0.3, wid - 0.13], PROP.waterDeep, { bevel: 0.01 }));
  // The surface in the water material.
  const wy = h - 0.1;
  const corners: Vec3[] = [[-len / 2 + 0.08, wy, -wid / 2 + 0.07], [-len / 2 + 0.08, wy, wid / 2 - 0.07], [len / 2 - 0.08, wy, wid / 2 - 0.07], [len / 2 - 0.08, wy, -wid / 2 + 0.07]];
  water.withFlags(waterFlags(0.12, 0, 1, 0), () => {
    water.with(extra ? mul34(world, extra) : world, () => {
      // Counter-clockwise seen from above: x−z− → x−z+ → x+z+ → x+z− (see layout.rectRing).
      water.face(corners, corners.map(() => [0.14, 0.3, 0.34]), corners.map(() => 0.88));
    });
  });
}

/** The tool rack on the back wall: two posts, two rails, hammers, tongs, a file and horseshoes on pegs. */
function toolRack(b: MeshBuilder, s: Stream): void {
  const z = -2.15;
  const x0 = 0.35, x1 = 2.35;
  const wood = woodColor(s, 1);
  b.withFlags({ cls: MAT.wood }, () => {
    for (const x of [x0, x1]) crookedBeam(b, [x, -0.1, z], [x, 1.95, z], (p) => scaleRgb(wood, 0.7 + 0.3 * Math.min(1, p[1] / 1.9)), { width: 0.14, stream: s.child(Math.round(x * 10)), segments: 3 });
    for (const y of [1.75, 1.05]) crookedBeam(b, [x0 - 0.12, y, z + 0.08], [x1 + 0.12, y, z + 0.08], lightWoodColor(s, y * 10), { width: 0.1, depth: 0.12, sag: 0.015, segments: 3 });
  });
  const iron = ironColor(s, 2);
  const handle = lightWoodColor(s, 3);
  const tools = 6;
  for (let i = 0; i < tools; i++) {
    const x = x0 + 0.2 + ((x1 - x0 - 0.4) * i) / (tools - 1);
    const zf = z + 0.17;
    const yTop = 1.75;
    b.withFlags({ cls: MAT.wood }, () => bevelBox(b, [x, yTop - 0.04, zf - 0.03], [0.03, 0.03, 0.1], scaleRgb(wood, 0.8), { bevel: 0.006 }));
    const kind = i % 3;
    if (kind === 0) {
      // Hammer, head down.
      b.withFlags({ cls: MAT.wood }, () => crookedBeam(b, [x, yTop - 0.02, zf], [x + s.jitter(0.02, i, 4), yTop - 0.42, zf], handle, { width: 0.035, segments: 2 }));
      b.withFlags({ cls: MAT.metal }, () => bevelBox(b, [x, yTop - 0.52, zf], [0.16, 0.08, 0.07], iron, { bevel: 0.012, taper: [1, 0.9] }));
    } else if (kind === 1) {
      // Tongs: two long jaws, slightly apart.
      b.withFlags({ cls: MAT.metal }, () => {
        crookedBeam(b, [x - 0.02, yTop - 0.02, zf], [x - 0.04, yTop - 0.62, zf], iron, { width: 0.022, segments: 2 });
        crookedBeam(b, [x + 0.02, yTop - 0.02, zf], [x + 0.05, yTop - 0.6, zf], iron, { width: 0.022, segments: 2 });
        bevelBox(b, [x, yTop - 0.68, zf], [0.1, 0.06, 0.04], scaleRgb(iron, 0.9), { bevel: 0.01 });
      });
    } else {
      // A file or a punch with a wooden handle.
      b.withFlags({ cls: MAT.wood }, () => crookedBeam(b, [x, yTop - 0.02, zf], [x, yTop - 0.16, zf], handle, { width: 0.04, segments: 1 }));
      b.withFlags({ cls: MAT.metal }, () => crookedBeam(b, [x, yTop - 0.16, zf], [x, yTop - 0.46, zf], scaleRgb(iron, 1.2), { width: 0.028, depth: 0.012, segments: 1 }));
    }
  }
  // Horseshoes on the lower rail.
  b.withFlags({ cls: MAT.metal }, () => {
    for (let i = 0; i < 5; i++) {
      const x = x0 + 0.25 + i * 0.36;
      const y = 1.0, zf = z + 0.16;
      const arc: Vec3[] = [];
      for (let k = 0; k <= 8; k++) {
        const a = Math.PI * 0.15 + (k / 8) * Math.PI * 1.7;
        arc.push([x + Math.sin(a) * 0.07, y - 0.07 - Math.cos(a) * 0.075, zf]);
      }
      sweep(b, arc, [[0.014, 0.008], [-0.014, 0.008], [-0.014, -0.008], [0.014, -0.008]], scaleRgb(iron, 1.1), { caps: true, faceted: true, up: [0, 0, 1] });
    }
  });
}
