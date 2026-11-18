// Details of the architecture kit that hang on or stand by a building, in a wall frame (u along, v up, w out):
//
//   hangingSign   a sign on a wrought arm with a curved brace, two chains and a framed board with an emblem
//   banner        a long cloth on a pole out of the wall: two-sided, a swallow-tail or pointed foot, trim and emblem
//   wallLantern   an iron bracket with a glazed lantern that glows and casts a warm point light in the evening
//   barrel        a coopered barrel with iron hoops (standing or lying)
//
// Moving parts: the cloth of a banner uses the vertex sway of the solid material (the wind sway of leaves), weighted
// by the distance from the point it hangs on, so it flutters without a part set or any per-frame work. A sign board is
// rigid: given a `SignSwing`, its chains and board go into a separate mesh around the hinge on the arm, and the owner
// turns it about the arm in a part set (`swingSign`); without one, the board sways like the cloth.

import type { FrameInfo, Mat34, PartSet, RGB, Vec3 } from '../kit/index.ts';
import { GLOW, MAT, MeshBuilder, bevelBox, compose34, createPartSet, lathe, lerp, mixRgb, mul34, pushPart, scaleRgb, tube, writePart } from '../kit/index.ts';
import { Site, openSite, woodPaint } from './site.ts';
import { timber } from './timber.ts';

export type Emblem = 'tankard' | 'anvil' | 'wheat' | 'none';

export interface SignOptions {
  /** Where the arm leaves the wall (wall frame u, v) and how far it reaches (default 1.5). */
  u: number;
  v: number;
  reach?: number;
  /** Board size (default 1.0 × 0.72) and the emblem painted on it. */
  w?: number;
  h?: number;
  emblem?: Emblem;
  /** Board colour (default the palette's plank) and emblem colour (default the trim). */
  color?: RGB;
  ink?: RGB;
  /** Swing the board rigidly about the arm: the hanging part goes into `swing.mesh`, its hinge into `swing.hinges`. */
  swing?: SignSwing;
}

/**
 * Hanging boards that swing as rigid bodies. `mesh` holds every board in its hinge frame (origin on the arm, x along
 * the wall, y up, z along the arm out of the wall); `hinges` the hinge frames in the world, one per board, in the
 * order the boards were added. All boards share one mesh, so one part set draws them: give it `hinges.length`
 * instances, each with its own board.
 */
export interface SignSwing {
  mesh: MeshBuilder;
  hinges: Mat34[];
}

export const signSwing = (): SignSwing => ({ mesh: new MeshBuilder(), hinges: [] });

/**
 * Writes the swung hinge of board `i` into `out` (no allocation): `angle` radians about the arm. Use it in `update`
 * with a small wind-driven angle, `rot` a scratch array of 12.
 */
export function swingSign(sw: SignSwing, i: number, angle: number, rot: Mat34, out: Mat34): Mat34 {
  const c = Math.cos(angle), s = Math.sin(angle);
  rot[0] = c; rot[1] = s; rot[2] = 0;
  rot[3] = -s; rot[4] = c; rot[5] = 0;
  rot[6] = 0; rot[7] = 0; rot[8] = 1;
  rot[9] = 0; rot[10] = 0; rot[11] = 0;
  return mul34(sw.hinges[i]!, rot, out);
}

/**
 * The part set of a building's swinging boards and the `update` that rocks them in the wind (no allocation): one
 * draw call for all boards of the building. Returns nothing when there are no boards.
 */
export function swingingSigns(name: string, sw: SignSwing): { parts: PartSet[]; update(f: FrameInfo): void } | undefined {
  const n = sw.hinges.length;
  if (n === 0 || sw.mesh.triangleCount === 0) return undefined;
  const set = createPartSet(name, sw.mesh, n, { dynamic: true, castShadow: true });
  for (const h of sw.hinges) pushPart(set, h);
  const rot: Mat34 = new Float64Array(12);
  const m: Mat34 = new Float64Array(12);
  return {
    parts: [set],
    update(f) {
      for (let i = 0; i < n; i++) {
        // A gust-driven rocking about the arm: a slow swing, a quicker shiver and a slight lean with the wind.
        const t = f.time;
        const a = 0.06 * Math.sin(t * 1.15 + i * 2.3) * (0.6 + 0.4 * Math.sin(t * 0.21 + i)) + 0.018 * Math.sin(t * 2.9 + i * 1.7) + 0.02;
        writePart(set, i, swingSign(sw, i, a, rot, m));
      }
      set.dirty = true;
    },
  };
}

/** Iron bar along a path (thin tube), for arms, chains and brackets. */
function iron(site: Site, path: readonly Vec3[], r: number, col?: RGB): void {
  site.b.withFlags({ cls: MAT.metal }, () => tube(site.b, path, () => r, col ?? site.pal.iron, { sides: 5, caps: true }));
}

/** A hanging sign on an arm out of the wall (wall frame). */
export function hangingSign(site: Site, o: SignOptions): void {
  const reach = o.reach ?? 1.5;
  const pal = site.pal;
  // Wall plate and the arm: a timber beam with an iron scroll brace under it.
  site.b.withFlags({ cls: MAT.metal }, () => bevelBox(site.b, [o.u, o.v - 0.55, 0.02], [0.2, 0.75, 0.05], pal.iron, { bevel: 0.02 }));
  timber(site, [o.u, o.v, -0.1], [o.u, o.v + 0.04, reach + 0.12], { width: 0.13, depth: 0.15, sag: 0.02, color: pal.timberDark, overhang: 0 });
  const brace: Vec3[] = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    brace.push([o.u, o.v - 0.52 + 0.5 * Math.sin((t * Math.PI) / 2) ** 0.7, 0.03 + reach * 0.62 * (1 - Math.cos((t * Math.PI) / 2))]);
  }
  iron(site, brace, 0.022);
  // A curl at the arm's end.
  const curl: Vec3[] = [];
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * Math.PI * 1.6;
    curl.push([o.u, o.v + 0.12 + Math.sin(a) * 0.09 * (1 - k / 16), reach + 0.1 + Math.cos(a) * 0.09 * (1 - k / 16) - 0.09]);
  }
  iron(site, curl, 0.016);
  // Chains and board swing together: rigidly about the arm (o.swing), or by vertex sway growing with the depth.
  const zc = reach * 0.55 + 0.1;
  if (o.swing) {
    const sw = o.swing;
    // A site over the swing mesh whose local frame is the wall frame moved so the hinge is the origin.
    openSite(sw.mesh, compose34([-o.u, -o.v, -zc]), site.s, pal, site.out, (hs) => signBoard(new Site(hs.b, site.m, hs.s, pal, site.out), o, zc, false));
    sw.hinges.push(mul34(site.m, compose34([o.u, o.v, zc])));
  } else signBoard(site, o, zc, true);
}

/** The chains and the board of a hanging sign under the arm at (u, v, zc) of the wall frame. */
function signBoard(site: Site, o: SignOptions, zc: number, swayed: boolean): void {
  const W = o.w ?? 1.0, H = o.h ?? 0.72;
  const pal = site.pal;
  const hang = 0.24;
  const top = o.v - hang;
  const sway = (y: number): number => (swayed ? Math.min(1.2, (o.v - y) * 1.1) : 0);
  for (const dx of [-W * 0.36, W * 0.36]) {
    // Chain links: small flat links alternating in orientation, swinging more the lower they hang.
    for (let k = 0; k < 3; k++) {
      const y = o.v - 0.03 - (k + 0.5) * (hang / 3);
      site.b.withFlags({ cls: MAT.metal, sway: sway(y) }, () =>
        bevelBox(site.b, [o.u, y - 0.04, zc + dx], [k % 2 ? 0.02 : 0.05, 0.08, k % 2 ? 0.05 : 0.02], scaleRgb(pal.iron, 1.2), { bevel: 0.008 }),
      );
    }
  }
  // The board: a frame of four slats round a panel, the emblem on both faces.
  const col = o.color ?? site.tone(pal.plank);
  const ink = o.ink ?? pal.trim;
  site.at(compose34([o.u, top, zc], Math.PI / 2), (bd) => {
    // Board frame: u is now along the arm, the faces look along ±(wall u).
    const b = bd.b;
    b.withFlags({ cls: MAT.wood, sway: sway(top - H / 2) }, () => {
      bevelBox(b, [0, -H, 0], [W, H, 0.06], woodPaint(col), { bevel: 0.02, jitter: 0.008, stream: bd.s });
      const fr = scaleRgb(col, 0.62);
      bevelBox(b, [0, -0.07, 0], [W + 0.06, 0.07, 0.09], woodPaint(fr), { bevel: 0.015 });
      bevelBox(b, [0, -H - 0.02, 0], [W + 0.06, 0.07, 0.09], woodPaint(fr), { bevel: 0.015 });
      for (const sx of [-1, 1]) bevelBox(b, [sx * (W / 2 + 0.01), -H, 0], [0.07, H, 0.09], woodPaint(fr), { bevel: 0.015 });
      // Eye bolts for the chains.
      b.withFlags({ cls: MAT.metal }, () => {
        for (const sx of [-1, 1]) bevelBox(b, [sx * W * 0.36, 0, 0], [0.05, 0.06, 0.03], pal.iron, { bevel: 0.01 });
      });
    });
    for (const face of [-1, 1]) emblem(bd, o.emblem ?? 'tankard', [0, -H / 2, face * 0.035], face, Math.min(W, H) * 0.7, ink, sway(top - H / 2));
  });
}

/** An emblem in relief on a board face (local x right, y up, facing `face` along z). */
function emblem(site: Site, kind: Emblem, at: Vec3, face: number, size: number, ink: RGB, sway = 0): void {
  if (kind === 'none') return;
  const b = site.b;
  const s = size;
  const z = at[2] + face * 0.012;
  // Mirrored on the back face (x by `face`), so both faces read the same way round, as if painted from each side.
  const box = (x: number, y: number, w: number, h: number, col = ink): void =>
    bevelBox(b, [at[0] + x * face, at[1] + y - h / 2, z], [w, h, 0.025], col, { bevel: 0.006, noBottom: false });
  b.withFlags({ cls: MAT.metal, sway }, () => {
    if (kind === 'tankard') {
      // Body, foam, handle and lid.
      box(-0.05 * s, -0.04 * s, 0.42 * s, 0.6 * s);
      box(-0.05 * s, 0.3 * s, 0.5 * s, 0.1 * s, scaleRgb(ink, 1.15));
      box(-0.05 * s, 0.38 * s, 0.36 * s, 0.1 * s, [0.95, 0.92, 0.82]);
      box(0.27 * s, 0.0 * s, 0.08 * s, 0.38 * s);
      box(0.2 * s, 0.17 * s, 0.16 * s, 0.07 * s);
      box(0.2 * s, -0.17 * s, 0.16 * s, 0.07 * s);
      for (const y of [-0.22, 0.12]) box(-0.05 * s, y * s, 0.44 * s, 0.035 * s, scaleRgb(ink, 0.7));
    } else if (kind === 'anvil') {
      box(0, 0.12 * s, 0.7 * s, 0.14 * s);
      box(-0.36 * s, 0.14 * s, 0.14 * s, 0.08 * s);
      box(0, -0.06 * s, 0.22 * s, 0.24 * s);
      box(0, -0.24 * s, 0.5 * s, 0.1 * s);
    } else {
      box(0, -0.1 * s, 0.05 * s, 0.6 * s);
      for (let k = 0; k < 4; k++) for (const sx of [-1, 1]) box(sx * 0.07 * s, (0.02 + k * 0.08) * s, 0.09 * s, 0.06 * s);
    }
  });
  void face;
}

export interface BannerOptions {
  /** Where the pole leaves the wall (wall frame u, v), how far it reaches (default 1.25). */
  u: number;
  v: number;
  reach?: number;
  /** Cloth width (along the pole, default 0.95) and length (default 2.3). */
  w?: number;
  h?: number;
  /** Foot of the cloth: a point or a swallow-tail (default 'point'). */
  foot?: 'point' | 'swallow' | 'straight';
  color?: RGB;
  trim?: RGB;
  emblem?: Emblem;
  /**
   * Which way the cloth faces: 'side' hangs it along the pole (seen from along the street), 'out' hangs it from a
   * crossbar at the end of the pole, facing out from the wall like a tavern banner (default 'side').
   */
  face?: 'side' | 'out';
}

/** A banner hanging from a pole out of the wall (wall frame): pole with finials, a two-sided cloth that sways. */
export function banner(site: Site, o: BannerOptions): void {
  const reach = o.reach ?? 1.25;
  const W = o.w ?? 0.95, H = o.h ?? 2.3;
  const pal = site.pal;
  const col = o.color ?? pal.fabric;
  const trim = o.trim ?? pal.trim;
  const out = o.face === 'out';
  const z0 = reach - W - 0.12;
  // Pole and its wall bracket.
  site.b.withFlags({ cls: MAT.metal }, () => {
    bevelBox(site.b, [o.u, o.v - 0.2, 0.02], [0.16, 0.4, 0.05], pal.iron, { bevel: 0.02 });
  });
  timber(site, [o.u, o.v, -0.05], [o.u, o.v, reach + 0.05], { width: 0.075, depth: 0.075, sag: 0.01, wobble: 0.005, color: pal.timberDark });
  const finial: [number, number][] = [[0.001, 0], [0.05, 0.04], [0.06, 0.08], [0.03, 0.12], [0.04, 0.16], [0.001, 0.22]];
  if (out) {
    // The crossbar across the end of the pole, a finial at each end and a diagonal iron stay back to the wall.
    timber(site, [o.u - W / 2 - 0.14, o.v - 0.02, reach], [o.u + W / 2 + 0.14, o.v - 0.02, reach], { width: 0.07, depth: 0.07, sag: 0.008, wobble: 0.004, color: pal.timberDark });
    site.b.withFlags({ cls: MAT.metal }, () => {
      for (const e of [-1, 1]) lathe(site.b, [o.u + e * (W / 2 + 0.16), o.v - 0.09, reach], finial, trim, { segments: 6, capBottom: true });
      timber(site, [o.u, o.v - 0.75, 0.02], [o.u, o.v - 0.04, reach * 0.8], { width: 0.035, depth: 0.035, sag: 0, wobble: 0.002, color: pal.iron });
    });
  } else {
    site.b.withFlags({ cls: MAT.metal }, () => {
      lathe(site.b, [o.u, o.v - 0.07, reach + 0.08], finial, trim, { segments: 6, capBottom: true });
    });
  }
  // The cloth: a grid in the plane u = const (both faces), its foot cut to a point or a swallow-tail.
  const nx = 4, ny = 9;
  const foot = o.foot ?? 'point';
  const footY = (t: number): number => {
    if (foot === 'straight') return 0;
    if (foot === 'point') return 0.35 * (1 - Math.abs(t * 2 - 1));
    return 0.38 * Math.abs(t * 2 - 1);
  };
  const P = (i: number, j: number, side: number): Vec3 => {
    const t = i / nx;
    const yv = j / ny;
    const len = H - (0.35 - footY(t));
    const y = o.v - 0.08 - yv * len;
    // A gentle fold: the cloth bellies out sideways.
    const fold = Math.sin(t * Math.PI * 2 + 0.6) * 0.035 + Math.sin(yv * Math.PI) * 0.05;
    // 'out': the cloth spans u under the crossbar, its fold bellies along w.
    if (out) return [o.u - W / 2 + t * W, y - 0.02, reach + fold + side * 0.004];
    return [o.u + fold + side * 0.004, y, z0 + t * W];
  };
  const colAt = (i: number, j: number): RGB => {
    const t = i / nx;
    const edge = t < 0.08 || t > 0.92 || j === 0;
    return edge ? trim : scaleRgb(col, 0.9 + 0.12 * Math.sin(i * 1.7 + j * 0.9));
  };
  for (const side of [-1, 1]) {
    site.b.withFlags({ cls: MAT.fabric }, () => {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const pts = [P(i, j, side), P(i + 1, j, side), P(i + 1, j + 1, side), P(i, j + 1, side)];
          const sw = [j, j, j + 1, j + 1].map((k) => (k / ny) * 1.4 + 0.15);
          const cs = [colAt(i, j), colAt(i + 1, j), colAt(i + 1, j + 1), colAt(i, j + 1)];
          const n = out ? [0, 0, side] : [side, 0, 0];
          // Per-vertex sway (the flags in force when each vertex is added), so the rows do not tear apart.
          const ids = pts.map((p, k) => {
            site.b.set({ sway: sw[k]! });
            return site.b.vertex(p, n, cs[k]!);
          });
          // 'side': the corners run +z then down, counter-clockwise seen from +x. 'out': they run +u then down,
          // clockwise seen from +w, so the winding flips.
          if ((side > 0) !== out) site.b.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
          else site.b.quad(ids[0]!, ids[3]!, ids[2]!, ids[1]!);
        }
      }
    });
  }
  // Trim bands and the emblem, sewn on both sides.
  const cy = o.v - 0.08 - H * 0.42;
  for (const side of [-1, 1]) {
    const at: Vec3 = out ? [o.u, cy, reach + side * 0.035 + 0.04] : [o.u + side * 0.035 + 0.04, cy, z0 + W / 2];
    site.at(compose34(at, out ? (side > 0 ? 0 : Math.PI) : (side * Math.PI) / 2), (e) => {
      e.b.withFlags({ cls: MAT.fabric, sway: 0.75 }, () => {
        // A diamond of trim round the emblem.
        const d = W * 0.32;
        const ring: Vec3[] = [[0, d, 0], [d, 0, 0], [0, -d, 0], [-d, 0, 0], [0, d, 0]];
        tube(e.b, ring, () => 0.022, trim, { sides: 4 });
      });
      emblem(e, o.emblem ?? 'tankard', [0, -0.02, 0], 1, W * 0.5, trim, 0.75);
    });
  }
}

export interface LanternOptions {
  /** Wall frame position of the bracket (u, v); the lantern hangs `reach` out (default 0.45). */
  u: number;
  v: number;
  reach?: number;
  /** Light colour, radius and intensity (defaults warm, 7, 1.1). */
  color?: RGB;
  radius?: number;
  intensity?: number;
}

/** A wall lantern (wall frame): a scrolled iron bracket, a glazed cage with a glowing flame, a warm point light. */
export function wallLantern(site: Site, o: LanternOptions): void {
  const reach = o.reach ?? 0.45;
  const pal = site.pal;
  site.b.withFlags({ cls: MAT.metal }, () => bevelBox(site.b, [o.u, o.v - 0.18, 0.02], [0.12, 0.3, 0.04], pal.iron, { bevel: 0.015 }));
  const arm: Vec3[] = [];
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    arm.push([o.u, o.v + 0.05 * Math.sin(t * Math.PI), 0.04 + reach * t]);
  }
  iron(site, arm, 0.02);
  const scroll: Vec3[] = [];
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * Math.PI * 1.4;
    scroll.push([o.u, o.v - 0.16 + Math.sin(a) * 0.12, 0.05 + (1 - Math.cos(a)) * 0.12]);
  }
  iron(site, scroll, 0.015);
  // Cage: a cap, four corner bars, a base, glass panes that glow.
  const cx = o.u, cz = reach + 0.02, top = o.v - 0.06;
  const w = 0.2, h = 0.3;
  site.b.withFlags({ cls: MAT.metal }, () => {
    iron(site, [[cx, o.v, cz], [cx, top + 0.03, cz]], 0.012);
    lathe(site.b, [cx, top - 0.06, cz], [[0.17, 0], [0.13, 0.04], [0.04, 0.1], [0.001, 0.12]], pal.iron, { segments: 4, capBottom: true, faceted: true, phase: Math.PI / 4 });
    bevelBox(site.b, [cx, top - 0.06 - h - 0.05, cz], [w + 0.05, 0.05, w + 0.05], pal.iron, { bevel: 0.012 });
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const)
      bevelBox(site.b, [cx + (sx * w) / 2, top - 0.06 - h, cz + (sz * w) / 2], [0.025, h, 0.025], pal.iron, { bevel: 0.006 });
  });
  site.b.withFlags({ cls: MAT.glass, glow: 1, channel: GLOW.evening }, () => {
    bevelBox(site.b, [cx, top - 0.06 - h, cz], [w - 0.01, h, w - 0.01], mixRgb(pal.glow, [1, 0.95, 0.8], 0.25), { bevel: 0.01, noBottom: true });
  });
  site.light([cx, top - 0.06 - h / 2, cz + 0.05], o.color ?? [1.0, 0.7, 0.36], o.radius ?? 7, o.intensity ?? 1.1, 0.15);
}

export interface BarrelOptions {
  /** Position (bottom centre for standing, the centre of the lowest point for lying) and heading. */
  at: readonly number[];
  yaw?: number;
  /** Height (default 0.9) and the widest radius (default 0.34). */
  h?: number;
  r?: number;
  lying?: boolean;
  color?: RGB;
}

/** A coopered barrel: bulging staves (faceted, varied), iron hoops, a lid of planks. */
export function barrel(site: Site, o: BarrelOptions): void {
  const h = o.h ?? 0.9, r = o.r ?? 0.34;
  const col = o.color ?? site.tone(site.pal.plank, { hue: 0.02, sat: 0.15, val: 0.18 });
  const m = o.lying ? compose34([o.at[0]!, o.at[1]! + r * 0.98, o.at[2]!], o.yaw ?? 0, Math.PI / 2) : compose34(o.at, o.yaw ?? 0);
  site.at(m, (b0) => {
    const b = b0.b;
    const y0 = o.lying ? -h / 2 : 0;
    const prof: [number, number][] = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      prof.push([lerp(r * 0.84, r, Math.sin(t * Math.PI)), y0 + t * h]);
    }
    const seed = b0.s.next() * 5;
    b.withFlags({ cls: MAT.wood }, () =>
      lathe(b, [0, 0, 0], prof, (p, n) => {
        // Staves: alternating shades around the circumference.
        const a = Math.atan2(p[2], p[0]);
        const stave = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 14 + seed) % 3;
        return scaleRgb(col, (0.88 + stave * 0.08) * (0.92 + 0.12 * Math.max(0, n[1])));
      }, { segments: 14, capBottom: true, capTop: false, faceted: true }),
    );
    // Lid sunk a little.
    b.withFlags({ cls: MAT.wood }, () =>
      bevelBox(b, [0, y0 + h - 0.05, 0], [r * 1.6, 0.03, r * 1.6], woodPaint(scaleRgb(col, 0.8)), { bevel: 0.01, anchor: 'base' }),
    );
    b.withFlags({ cls: MAT.metal }, () => {
      for (const t of [0.1, 0.3, 0.7, 0.9]) {
        const rr = lerp(r * 0.84, r, Math.sin(t * Math.PI)) + 0.012;
        lathe(b, [0, 0, 0], [[rr, y0 + t * h - 0.025], [rr + 0.006, y0 + t * h], [rr, y0 + t * h + 0.025]], site.pal.iron, { segments: 14 });
      }
    });
  });
}

