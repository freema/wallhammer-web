// Timber of the architecture kit: thick crooked beams (0.35–0.5 m, B2), curved braces and brackets, and the
// half-timbered wall frame: corner posts, sill, plate with overhanging heads, posts flanking every opening, a mid rail,
// lintels and window rails, diagonal braces and crosses in the closed panels; jetty joists whose ends stick out under
// an overhanging upper storey. Every member gets its own colour and its own little crookedness.

import type { RGB, Vec3 } from '../kit/index.ts';
import { MAT, crookedBeam, lerp, sweep } from '../kit/index.ts';
import type { Opening, Site, Wall } from './site.ts';
import { woodPaint } from './site.ts';

export interface TimberOptions {
  /** Face width and depth of the section (defaults 0.4 and 0.3). */
  width?: number;
  depth?: number;
  /** Sag (horizontal members), wobble and twist (defaults small, from the stream). */
  sag?: number;
  wobble?: number;
  twist?: number;
  /** Beyond each end (overhanging heads). */
  overhang?: number;
  /** Base colour (default the palette's timber, varied per member). */
  color?: RGB;
  /** Up hint of the section (default world up). */
  up?: readonly number[];
}

/** One hewn timber from `a` to `b` (site coordinates). */
export function timber(site: Site, a: readonly number[], b: readonly number[], o: TimberOptions = {}): void {
  const s = site.s;
  const c = site.tone(o.color ?? site.pal.timber, { hue: 0.015, sat: 0.12, val: 0.16 });
  const width = o.width ?? 0.4;
  site.b.withFlags({ cls: MAT.wood }, () =>
    crookedBeam(site.b, a, b, woodPaint(c), {
      width,
      depth: o.depth ?? 0.3,
      sag: o.sag ?? s.nextRange(0, 0.05),
      wobble: o.wobble ?? 0.03,
      twist: o.twist ?? s.nextJitter(0.06),
      irregular: 0.12,
      chamfer: 0.3,
      overhang: o.overhang ?? 0,
      // Rings about every 1.3 m (straight short members need no more than the minimum).
      segments: Math.max(3, Math.ceil(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!) / 1.3) + 1),
      stream: s,
      ...(o.up ? { up: o.up } : {}),
    }),
  );
}

/** A section outline: a chamfered rectangle (counter-clockwise), for curved members. */
function chamferedSection(w: number, d: number, ch = 0.3): [number, number][] {
  const hw = w / 2, hd = d / 2, c = ch * Math.min(hw, hd);
  return [[hw, hd - c], [hw - c, hd], [-hw + c, hd], [-hw, hd - c], [-hw, -hd + c], [-hw + c, -hd], [hw - c, -hd], [hw, -hd + c]];
}

/**
 * A curved timber from `a` to `b` bent toward the control point `c` (a quadratic curve): brackets under a jetty,
 * arched braces, sign arms. Flat-shaded hewn faces, capped ends.
 */
export function curvedTimber(site: Site, a: readonly number[], c: readonly number[], b: readonly number[], o: TimberOptions = {}): void {
  const col = site.tone(o.color ?? site.pal.timber, { hue: 0.015, sat: 0.12, val: 0.16 });
  const path: Vec3[] = [];
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const k0 = (1 - t) * (1 - t), k1 = 2 * t * (1 - t), k2 = t * t;
    path.push([k0 * a[0]! + k1 * c[0]! + k2 * b[0]!, k0 * a[1]! + k1 * c[1]! + k2 * b[1]!, k0 * a[2]! + k1 * c[2]! + k2 * b[2]!]);
  }
  const w = o.width ?? 0.3, d = o.depth ?? w;
  // Slightly thicker in the middle, as if cut from a grown bend.
  site.b.withFlags({ cls: MAT.wood }, () =>
    sweep(site.b, path, chamferedSection(w, d), woodPaint(col), { closed: true, caps: true, faceted: true, scale: (f) => 1 + 0.12 * Math.sin(Math.PI * f), ...(o.up ? { up: o.up } : {}) }),
  );
}

export interface FrameOptions {
  /** Wall height of this storey (v from 0 to height). */
  height: number;
  /** Openings of this storey in the wall frame (doors start at v = 0). */
  openings?: readonly Opening[];
  /** Target distance between posts (default 2.1). */
  spacing?: number;
  /** Face width of posts and rails, of corner posts, and the section depth (defaults 0.38, 0.48, 0.28). */
  width?: number;
  corner?: number;
  depth?: number;
  /** How far the timber faces stand out of the plaster (w of the outer face, default 0.1). */
  out?: number;
  /** Members to build (all default true; `rail` may be a height share, default 0.47). */
  sill?: boolean;
  plate?: boolean;
  rail?: boolean | number;
  /** Plate heads beyond the wall ends (default 0.38 at both ends; 0 for none). */
  plateOverhang?: readonly [number, number];
  /** Brace style of closed panels: 'auto' mixes diagonals and crosses, 'diagonal', 'cross' or 'none'. */
  braces?: 'auto' | 'diagonal' | 'cross' | 'none';
  /** Corner posts at the start (default true) and the end (default false) of the wall. */
  cornerStart?: boolean;
  cornerEnd?: boolean;
  /** Height of the corner posts' foot (default 0; negative lets them run down over the plinth). */
  cornerFoot?: number;
}

/**
 * The half-timbered frame of one storey of one wall, in that wall's frame. Members stand `out` proud of the
 * plaster plane w = 0. Posts flank every opening; lintels and window rails close the openings; closed panels get
 * braces. Walls of a footprint each build the corner post at their start, so every corner gets exactly one.
 */
export function timberFrame(site: Site, wall: Wall, o: FrameOptions): void {
  site.onWall(wall, (w) => frameInWall(w, wall.length, o));
}

/** `timberFrame` already inside a wall frame of length `L`. */
export function frameInWall(site: Site, L: number, o: FrameOptions): void {
  const s = site.s;
  const h = o.height;
  const bw = o.width ?? 0.38;
  const cs = o.corner ?? 0.48;
  const bd = o.depth ?? 0.28;
  const out = o.out ?? 0.1;
  const wc = out - bd / 2;
  const openings = o.openings ?? [];
  const sillH = bw * 0.85;
  const plateH = bw * 1.08;
  const railShare = typeof o.rail === 'number' ? o.rail : 0.47;
  const hasRail = o.rail !== false;
  const railV = h * railShare;
  const top = o.plate === false ? h : h - plateH;
  const bottom = o.sill === false ? 0 : sillH;
  const beam = (a: Vec3, b: Vec3, opt: TimberOptions = {}): void => timber(site, a, b, { width: bw, depth: bd, ...opt });

  // Sill: split where doors reach the floor.
  if (o.sill !== false) {
    const cuts = openings.filter((q) => q.v0 < sillH).map((q) => [q.u0 - 0.02, q.u1 + 0.02] as const).sort((a, b) => a[0] - b[0]);
    let u = -out;
    for (const [c0, c1] of [...cuts, [L + out, L + out] as const]) {
      if (c0 - u > 0.2) beam([u, sillH / 2, wc], [c0, sillH / 2, wc], { width: sillH, depth: bd + 0.04, sag: 0 });
      u = Math.max(u, c1);
    }
  }
  // Plate with overhanging heads.
  if (o.plate !== false) {
    const [o0, o1] = o.plateOverhang ?? [0.38, 0.38];
    beam([-o0 - out, h - plateH / 2, wc], [L + o1 + out, h - plateH / 2, wc], { width: plateH, depth: bd + 0.06, sag: s.nextRange(0.02, 0.06) });
  }
  // Corner posts.
  const cornerFoot = o.cornerFoot ?? 0;
  const corner = (u: number): void => {
    const lean = s.nextJitter(0.04);
    timber(site, [u, cornerFoot, out - cs / 2], [u + lean, top + 0.04, out - cs / 2 + s.nextJitter(0.02)], { width: cs, depth: cs, sag: 0, color: site.pal.timberDark });
  };
  if (o.cornerStart !== false) corner(cs / 2 - out);
  if (o.cornerEnd) corner(L - (cs / 2 - out));
  // Post positions: the wall ends (as panel bounds), both sides of every opening, then fill wide gaps.
  const lo = o.cornerStart !== false ? cs - out : 0;
  const hi = o.cornerEnd ? L - (cs - out) : L;
  const blocked = (u: number): boolean => openings.some((q) => u > q.u0 - bw * 0.6 && u < q.u1 + bw * 0.6);
  let posts: number[] = [];
  for (const q of openings) {
    if (q.u0 - bw / 2 > lo + bw * 0.6) posts.push(q.u0 - bw / 2);
    if (q.u1 + bw / 2 < hi - bw * 0.6) posts.push(q.u1 + bw / 2);
  }
  posts.sort((a, b) => a - b);
  const spacing = o.spacing ?? 2.1;
  const bounds = [lo - bw / 2, ...posts, hi + bw / 2];
  const filled: number[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i]!, b = bounds[i + 1]!;
    const gap = b - a;
    const k = Math.floor(gap / spacing + 0.25);
    for (let j = 1; j < k; j++) {
      const u = a + (gap * j) / k;
      if (!blocked(u)) filled.push(u);
    }
  }
  posts = [...posts, ...filled].sort((a, b) => a - b);
  // Merge posts that would touch.
  const merged: number[] = [];
  for (const u of posts) {
    if (merged.length && u - merged[merged.length - 1]! < bw * 1.5) merged[merged.length - 1] = (merged[merged.length - 1]! + u) / 2;
    else merged.push(u);
  }
  for (const u of merged) {
    // Posts stop under a door lintel? No: posts flank openings, so they run full height.
    beam([u, bottom - 0.04, wc], [u + s.nextJitter(0.035), top + 0.04, wc], { sag: 0, wobble: 0.025 });
  }
  // Panels between posts (with the wall ends as bounds).
  const edges = [lo - bw / 2, ...merged, hi + bw / 2];
  const panels = edges.length - 1;
  for (let i = 0; i < panels; i++) {
    const pa = edges[i]! + bw / 2, pb = edges[i + 1]! - bw / 2;
    if (pb - pa < 0.25) continue;
    const inPanel = openings.filter((q) => q.u0 < pb - 0.05 && q.u1 > pa + 0.05);
    const blocks = (v0: number, v1: number): boolean => inPanel.some((q) => q.v0 < v1 && q.v1 > v0);
    // Mid rail.
    if (hasRail && !blocks(railV - bw, railV + bw)) beam([pa - 0.05, railV, wc + 0.01], [pb + 0.05, railV, wc + 0.01], { width: bw * 0.9, sag: s.nextRange(0, 0.03) });
    // Lintels and window rails.
    for (const q of inPanel) {
      if (q.v1 + bw * 0.45 < top - bw * 0.3) beam([pa - 0.05, q.v1 + bw * 0.42, wc + 0.015], [pb + 0.05, q.v1 + bw * 0.42, wc + 0.015], { width: bw * 0.85, sag: s.nextRange(0.01, 0.04) });
      if (q.v0 > bottom + 0.5) {
        beam([pa - 0.05, q.v0 - bw * 0.42, wc + 0.015], [pb + 0.05, q.v0 - bw * 0.42, wc + 0.015], { width: bw * 0.8, sag: 0 });
        // A small cross under some windows.
        const lowTop = q.v0 - bw * 0.84, lowBot = bottom;
        if (lowTop - lowBot > 0.45 && pb - pa > 0.7 && s.next() < 0.6) {
          beam([pa + 0.04, lowBot + 0.04, wc - 0.01], [pb - 0.04, lowTop - 0.02, wc - 0.01], { width: bw * 0.62, sag: 0 });
          beam([pb - 0.04, lowBot + 0.04, wc - 0.02], [pa + 0.04, lowTop - 0.02, wc - 0.02], { width: bw * 0.62, sag: 0 });
        }
      }
    }
    if (inPanel.length || o.braces === 'none' || pb - pa < 0.7) continue;
    // Braces in the lower and upper fields of a closed panel: diagonals that lean toward the nearer wall end
    // (mirrored about the middle), crosses in some panels.
    const style = o.braces ?? 'auto';
    const toEnd = (pa + pb) / 2 < L / 2 ? -1 : 1;
    const fields: [number, number][] = hasRail ? [[bottom, railV - bw * 0.45], [railV + bw * 0.45, top]] : [[bottom, top]];
    fields.forEach(([v0, v1], fi) => {
      if (v1 - v0 < 0.45) return;
      const cross = style === 'cross' || (style === 'auto' && (i + fi) % 3 === 1 && v1 - v0 < 1.8);
      const bwB = bw * 0.75;
      const footU = toEnd < 0 ? pb : pa, headU = toEnd < 0 ? pa : pb;
      if (cross) {
        beam([pa, v0 + 0.03, wc - 0.01], [pb, v1 - 0.03, wc - 0.01], { width: bwB, sag: 0 });
        beam([pb, v0 + 0.03, wc - 0.02], [pa, v1 - 0.03, wc - 0.02], { width: bwB, sag: 0 });
      } else {
        // Lower field: from the foot near the middle up to the post toward the end; upper field mirrored.
        if (fi === 0) beam([footU, v0 + 0.03, wc - 0.01], [headU, v1 - 0.03, wc - 0.01], { width: bwB, sag: 0 });
        else beam([headU, v0 + 0.03, wc - 0.01], [footU, v1 - 0.03, wc - 0.01], { width: bwB, sag: 0 });
      }
    });
  }
}

export interface JettyOptions {
  /** Height of the joists' centre in the wall frame. */
  v: number;
  /** How far the upper storey stands out (the joist ends reach this plus `tip`). */
  jetty: number;
  tip?: number;
  /** Joist spacing and section (defaults 0.7 and 0.26). */
  spacing?: number;
  size?: number;
  /** Range along the wall (from defaults to 0.25). */
  from?: number;
  to: number;
}

/** Joist ends sticking out of a wall under a jettied upper storey (in the wall frame). */
export function jettyJoists(site: Site, o: JettyOptions): void {
  const spacing = o.spacing ?? 0.7, size = o.size ?? 0.26, tip = o.tip ?? 0.16;
  const from = o.from ?? 0.25, to = o.to;
  const n = Math.max(1, Math.round((to - from) / spacing));
  for (let k = 0; k <= n; k++) {
    const u = lerp(from, to, k / n) + site.s.nextJitter(0.04);
    const end = o.jetty + tip + site.s.nextJitter(0.05);
    timber(site, [u, o.v, -0.25], [u, o.v + site.s.nextJitter(0.02), end], { width: size * site.s.nextRange(0.9, 1.1), depth: size * 1.1, sag: 0.01, color: site.pal.timberDark });
  }
}

/** A curved bracket under a jetty in a wall frame: from the wall at (u, v0) up and out to (u, v1, reach). */
export function jettyBracket(site: Site, u: number, v0: number, v1: number, reach: number, width = 0.26): void {
  curvedTimber(site, [u, v0, 0.0], [u, v1 - 0.05, 0.02], [u, v1, reach], { width, depth: width * 1.2, color: site.pal.timberDark });
}
