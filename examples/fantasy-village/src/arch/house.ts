// The house composer of the architecture kit: one rectangular body from a declarative spec. It stacks the parts of
// the kit: a stone plinth (with piers, buttresses and gaps), storeys of half-timbered plaster walls (jetties on chosen
// sides with joists, brackets and a soffit), windows and doors, gables filled under a curved shingle roof with its
// gable timbers, dormers and chimneys. A building is one or more bodies (the inn: the main body and a wing) plus its
// own extras; every body writes into the same builder.
//
// Coordinates: the site's local frame of the structure (x east-ish, z toward the front, y up from the pad).

import type { Vec3 } from '../kit/index.ts';
import { MAT, bevelBox, compose34, lerp } from '../kit/index.ts';
import type { ChimneyOptions } from './stone.ts';
import { buttress, stoneChimney, stonePlinth } from './stone.ts';
import type { DoorOptions, WindowOptions } from './openings.ts';
import { doorAt, doorOpening, windowAt, windowOpening } from './openings.ts';
import type { DormerSpec, RoofHole, RoofShape, RoofSpec, ShingleOptions } from './roof.ts';
import { buildRoof, dormer, dormerHole, roofHoleFor, roofShape } from './roof.ts';
import type { Opening, Rect, Side, Site, Wall } from './site.ts';
import { SIDES, rectRing, rectWalls, wallPoint, woodPaint } from './site.ts';
import type { FrameOptions } from './timber.ts';
import { frameInWall, jettyBracket, jettyJoists, timber } from './timber.ts';
import { plasterPanel } from './walls.ts';

/** A window or door of a house, placed by side, storey and offset from the wall's centre. */
export interface HouseOpening {
  side: Side;
  /** Storey index (0 the ground floor) or 'gable' (the triangle under the roof on a gable side). */
  storey: number | 'gable';
  /** Offset of the centre along the wall from its middle (u, to the right seen from outside). */
  at: number;
  /** A window (its `v` defaults to 1.0 on the ground floor, 0.85 above, 0.5 in a gable) … */
  window?: Omit<WindowOptions, 'u' | 'v'> & { v?: number };
  /** … or a door (on the ground floor; `steps` default to the floor height). */
  door?: Omit<DoorOptions, 'u' | 'v'>;
}

/** A chimney of a house: house-local centre, size, and how far its top rises above the roof's ridge. */
export interface HouseChimney extends Partial<Omit<ChimneyOptions, 'x' | 'z' | 'y0' | 'y1'>> {
  x: number;
  z: number;
  /** Top above the highest point of the ridge (default 1.0); or an absolute local height with `y1`. */
  above?: number;
  y1?: number;
  /** Foot height (default: −0.4 into the ground outside the walls, under the roof inside them). */
  y0?: number;
}

/** A dormer by the wall side it faces and its offset along the ridge from the roof's centre. */
export interface HouseDormer extends Omit<DormerSpec, 's' | 'side'> {
  facing: Side;
  at: number;
}

export interface HouseSpec {
  rect: Rect;
  /** Floor height above the pad = top of the plinth (default 0.75). */
  floorY?: number;
  /** Heights of the storeys, bottom up (default [3]). A short top storey (< 1.6) is a knee wall under the roof. */
  storeys?: readonly number[];
  /** How far every storey above the ground floor stands out on a side (jetty). */
  jetty?: Partial<Record<Side, number>>;
  /** Walls to leave out (`false`) or to build only over a range along the wall (where another body joins). */
  walls?: Partial<Record<Side, false | { from?: number; to?: number }>>;
  /** The same per storey (index), overriding `walls` for that storey (a wall hidden by a lower neighbour). */
  storeyWalls?: Partial<Record<number, Partial<Record<Side, false | { from?: number; to?: number }>>>>;
  /** Plinth: piers rising higher, gaps, buttresses (house-local foot point and outward heading). */
  plinth?: {
    rises?: { side: Side; u0: number; u1: number; top: number }[];
    gaps?: { side: Side; u0: number; u1: number }[];
    buttresses?: { x: number; z: number; yaw: number; width?: number; height?: number; depth?: number }[];
    below?: number;
  };
  /** Timber frame options for every storey (height and openings are filled in). */
  frame?: Omit<FrameOptions, 'height' | 'openings'>;
  openings?: readonly HouseOpening[];
  /** Roof (`false` for none): the ridge axis and shape; the walls and overhangs come from the body. */
  roof?:
    | false
    | {
        axis: 'x' | 'z';
        /** Rise of the ridge as a share of the span (default 0.62). */
        pitch?: number;
        eave?: number;
        gable?: number | readonly [number, number];
        ends?: RoofSpec['ends'];
        sag?: number;
        flare?: number;
        curl?: number;
        dip?: number;
        shingles?: ShingleOptions;
        dormers?: readonly HouseDormer[];
        /** Extra regions without shingles (house-local rectangles: centre and size). */
        holes?: readonly { x: number; z: number; w: number; d: number }[];
        /** Gable timbers (king post, collar, struts) on gable walls (default true). */
        gableFrame?: boolean;
      };
  chimneys?: readonly HouseChimney[];
}

export interface House {
  /** Floor of each storey (local y) and the wall plate under the roof. */
  storeyY: number[];
  eaveY: number;
  /** The rectangle of each storey (jetties included). */
  rects: Rect[];
  /** Walls of each storey. */
  walls: Record<Side, Wall>[];
  roof?: RoofShape;
  /** Local top points of the chimneys (where the smoke starts). */
  chimneyTops: Vec3[];
}

const grow = (r: Rect, j: Partial<Record<Side, number>>): Rect => {
  const f = j.front ?? 0, b = j.back ?? 0, l = j.left ?? 0, rt = j.right ?? 0;
  return { x: r.x + (rt - l) / 2, z: r.z + (f - b) / 2, w: r.w + l + rt, d: r.d + f + b };
};

/** Builds one house body into the site and returns its frame for the details a building adds itself. */
export function buildHouse(site: Site, spec: HouseSpec): House {
  const floorY = spec.floorY ?? 0.75;
  const storeys = spec.storeys ?? [3];
  const jetty = spec.jetty ?? {};
  const rects: Rect[] = [];
  const storeyY: number[] = [];
  let y = floorY;
  for (let k = 0; k < storeys.length; k++) {
    rects.push(k === 0 ? spec.rect : grow(spec.rect, jetty));
    storeyY.push(y);
    y += storeys[k]!;
  }
  const eaveY = y;
  const walls = rects.map((r, k) => rectWalls(r, storeyY[k]!));
  const openings = spec.openings ?? [];
  const range = (side: Side, L: number, storey = -1): [number, number] | undefined => {
    const own = spec.storeyWalls?.[storey];
    const w = own && side in own ? own[side] : spec.walls?.[side];
    if (w === false) return undefined;
    return [Math.max(0, w?.from ?? 0), Math.min(L, w?.to ?? L)];
  };
  const sideIndex = (s: Side): number => SIDES.indexOf(s);

  // --- Plinth ---
  const p = spec.plinth ?? {};
  const skipEdges = SIDES.filter((s) => spec.walls?.[s] === false).map(sideIndex);
  const partialGaps = SIDES.flatMap((s) => {
    const w = spec.walls?.[s];
    if (!w) return [];
    const L = walls[0]![s].length;
    const g: { edge: number; u0: number; u1: number }[] = [];
    if ((w.from ?? 0) > 0.01) g.push({ edge: sideIndex(s), u0: -1, u1: w.from! });
    if ((w.to ?? L) < L - 0.01) g.push({ edge: sideIndex(s), u0: w.to!, u1: L + 1 });
    return g;
  });
  stonePlinth(site.child('plinth'), {
    ring: rectRing(spec.rect),
    top: floorY,
    ...(p.below !== undefined ? { below: p.below } : {}),
    rises: (p.rises ?? []).map((r) => ({ edge: sideIndex(r.side), u0: r.u0, u1: r.u1, top: r.top })),
    gaps: [...(p.gaps ?? []).map((g) => ({ edge: sideIndex(g.side), u0: g.u0, u1: g.u1 })), ...partialGaps],
    skipEdges,
  });
  for (const bt of p.buttresses ?? []) buttress(site.child('buttress'), { ...bt });

  // --- Storeys ---
  for (let k = 0; k < storeys.length; k++) {
    const h = storeys[k]!;
    const st = site.child(`storey${k}`);
    for (const side of SIDES) {
      const wall = walls[k]![side];
      const rg = range(side, wall.length, k);
      if (!rg) continue;
      const [from, to] = rg;
      const L = to - from;
      // Openings of this storey and wall, in the shifted frame (u from `from`).
      const ws: { o: Opening; w?: WindowOptions; d?: DoorOptions }[] = [];
      for (const op of openings) {
        if (op.side !== side || op.storey !== k) continue;
        const u = wall.length / 2 + op.at - from;
        if (op.door) {
          const d: DoorOptions = { steps: floorY, ...op.door, u, v: 0 };
          ws.push({ o: doorOpening(d), d });
        } else if (op.window) {
          const w: WindowOptions = { ...op.window, u, v: op.window.v ?? (k === 0 ? 1.0 : 0.85) };
          ws.push({ o: windowOpening(w), w });
        }
      }
      const ops = ws.map((q) => q.o);
      st.at(compose34([0, 0, 0]), (s0) =>
        s0.onWall(wall, (w0) =>
          w0.at(compose34([from, 0, 0]), (w) => {
            plasterPanel(w, { height: h, to: L, openings: ops, footDark: k === 0 ? 0.22 : 0.06 });
            frameInWall(w, L, {
              height: h,
              openings: ops,
              rail: h < 1.6 ? false : 0.47,
              cornerStart: from < 0.01,
              ...(h < 1.6 ? { braces: 'none' as const } : {}),
              ...spec.frame,
            });
            for (const q of ws) {
              if (q.w) windowAt(w.child('win'), q.w);
              if (q.d) doorAt(w.child('door'), q.d);
            }
          }),
        ),
      );
    }
    // Jetty zone under this storey: joists, brackets and the soffit on every jettied side of the storey below.
    if (k > 0) {
      for (const side of SIDES) {
        const j = jetty[side] ?? 0;
        if (j < 0.05) continue;
        const below = walls[k - 1]![side];
        const rg = range(side, below.length);
        if (!rg) continue;
        const hb = storeys[k - 1]!;
        st.onWall(below, (w) => {
          jettyJoists(w, { v: hb - 0.16, jetty: j, from: rg[0] + 0.3, to: rg[1] - 0.3 });
          // Soffit: planks under the overhang, from wall to wall line of the storey above.
          w.b.withFlags({ cls: MAT.wood }, () =>
            bevelBox(w.b, [(rg[0] + rg[1]) / 2, hb - 0.05, j / 2 + 0.05], [rg[1] - rg[0] + 0.1, 0.06, j + 0.12], woodPaint(w.pal.plank), { bevel: 0.01, anchor: 'center' }),
          );
          // Curved brackets under the corner posts of the storey above and every few metres between.
          const n = Math.max(1, Math.round((rg[1] - rg[0]) / 3.2));
          for (let i = 0; i <= n; i++) {
            const u = lerp(rg[0] + 0.45, rg[1] - 0.45, i / n);
            jettyBracket(w, u, hb - 1.15, hb - 0.3, j + 0.02, 0.24);
          }
        });
      }
    }
  }

  // --- Roof ---
  let roof: RoofShape | undefined;
  const chimneyTops: Vec3[] = [];
  const top = rects[rects.length - 1]!;
  if (spec.roof !== false && spec.roof) {
    const ro = spec.roof;
    const alongX = ro.axis === 'x';
    const length = alongX ? top.w : top.d;
    const span = alongX ? top.d : top.w;
    roof = roofShape({
      x: top.x,
      z: top.z,
      y: eaveY,
      axis: ro.axis,
      length,
      span,
      rise: (ro.pitch ?? 0.62) * span,
      ...(ro.eave !== undefined ? { eave: ro.eave } : {}),
      ...(ro.gable !== undefined ? { gable: ro.gable } : {}),
      ...(ro.ends ? { ends: ro.ends } : {}),
      ...(ro.sag !== undefined ? { sag: ro.sag } : {}),
      ...(ro.flare !== undefined ? { flare: ro.flare } : {}),
      ...(ro.curl !== undefined ? { curl: ro.curl } : {}),
      ...(ro.dip !== undefined ? { dip: ro.dip } : {}),
    });
    const shape = roof;
    // Dormers: the side of the roof frame a wall side faces.
    const dormers: DormerSpec[] = (ro.dormers ?? []).map((d) => {
      const n = { front: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0] }[d.facing];
      const [, q] = shape.toRoof(top.x + n[0]! * 2, top.z + n[1]! * 2);
      const [sAt] = shape.toRoof(top.x + (alongX ? d.at : 0), top.z + (alongX ? 0 : d.at));
      const { facing: _f, at: _a, ...rest } = d;
      return { ...rest, s: sAt, side: q > 0 ? 1 : -1 } as DormerSpec;
    });
    const holes: RoofHole[] = [
      ...dormers.map((d) => dormerHole(shape, d)),
      ...(ro.holes ?? []).map((h) => roofHoleFor(shape, h.x, h.z, h.w, h.d)),
      ...(spec.chimneys ?? []).map((c) => roofHoleFor(shape, c.x, c.z, (c.w ?? 1.2) + 0.1, (c.d ?? 1.0) + 0.1, 0.08)),
    ];
    buildRoof(site.child('roof'), shape, { holes, ...(ro.shingles ? { shingles: ro.shingles } : {}) });
    dormers.forEach((d, i) => dormer(site.child(`dormer${i}`), shape, d));
    // Gables: plaster up to the roof's underside, gable timbers, gable windows.
    const ends = ro.ends ?? ['gable', 'gable'];
    const gableSides: Side[] = alongX ? ['left', 'right'] : ['front', 'back'];
    for (const side of gableSides) {
      const wall = rectWalls(top, eaveY)[side];
      const mid = wallPoint(wall, wall.length / 2, 0);
      const [sMid] = shape.toRoof(mid[0], mid[2]);
      if (ends[sMid < 0 ? 0 : 1] !== 'gable') continue;
      const rg = range(side, wall.length);
      if (!rg) continue;
      const L = wall.length;
      const topAt = (u: number): number => {
        const pnt = wallPoint(wall, Math.min(L, Math.max(0, u)), 0);
        return shape.underside(pnt[0], pnt[2]) - eaveY;
      };
      const gs = site.child(`gable-${side}`);
      const ws: WindowOptions[] = openings
        .filter((o) => o.side === side && o.storey === 'gable' && o.window)
        .map((o) => ({ ...o.window!, u: L / 2 + o.at, v: o.window!.v ?? 0.5 }));
      const ops = ws.map(windowOpening);
      const rise = topAt(L / 2);
      gs.onWall(wall, (w) => {
        plasterPanel(w, { height: rise + 0.2, top: topAt, breaks: [L / 2], to: L, openings: ops, footDark: 0, cell: 0.55 });
        if (ro.gableFrame !== false) {
          const bw = 0.34;
          const out = 0.1;
          const wc = out - 0.14;
          // King post, collar and two struts, leaving the gable windows free.
          const free = (u: number, v: number): boolean => !ops.some((q) => u > q.u0 - 0.3 && u < q.u1 + 0.3 && v > q.v0 - 0.3 && v < q.v1 + 0.3);
          if (free(L / 2, rise * 0.5)) timber(w, [L / 2, 0.1, wc], [L / 2, rise - 0.05, wc], { width: bw, depth: 0.28, sag: 0 });
          const cv = rise * 0.48;
          // Collar ends where the roof comes down to it.
          let ua = 0;
          while (ua < L / 2 && topAt(ua) < cv + 0.2) ua += 0.05;
          if (L / 2 - ua > 0.6) {
            const collarFree = !ops.some((q) => q.v0 < cv + 0.2 && q.v1 > cv - 0.2);
            if (collarFree) timber(w, [ua - 0.1, cv, wc + 0.01], [L - ua + 0.1, cv, wc + 0.01], { width: bw * 0.9, depth: 0.28, sag: 0.03 });
          }
          for (const sx of [-1, 1]) {
            const ub = L / 2 + sx * (L / 2 - ua) * 0.85;
            const head = L / 2 + sx * 0.25;
            if (free(lerp(ub, head, 0.5), cv * 0.5)) timber(w, [ub, 0.15, wc - 0.01], [head, cv - 0.1, wc - 0.01], { width: bw * 0.75, depth: 0.26, sag: 0 });
          }
          // Rafters along the roof's underside at the gable face (verge rafters).
          for (const [u0, u1] of [[0.05, L / 2], [L - 0.05, L / 2]] as const) {
            timber(w, [u0, topAt(u0) - 0.18, wc], [u1, topAt(u1) - 0.2, wc], { width: 0.26, depth: 0.26, sag: 0.02 });
          }
        }
        for (const q of ws) windowAt(w.child('gwin'), q);
      });
    }
  }

  // --- Chimneys ---
  for (const c of spec.chimneys ?? []) {
    const inside = Math.abs(c.x - spec.rect.x) < spec.rect.w / 2 && Math.abs(c.z - spec.rect.z) < spec.rect.d / 2;
    const ridge = roof ? roof.ridgeY : eaveY;
    const y0 = c.y0 ?? (inside ? (roof ? Math.min(roof.heightAt(c.x, c.z) - 1.2, ridge - 1.2) : eaveY - 0.5) : -0.4);
    const y1 = c.y1 ?? ridge + (c.above ?? 1.0);
    const { above: _a, y1: _y1, y0: _y0, ...rest } = c;
    const t = stoneChimney(site.child('chimney'), { ...rest, x: c.x, z: c.z, y0, y1 });
    chimneyTops.push([t[0], t[1], t[2]]);
  }
  return { storeyY, eaveY, rects, walls, ...(roof ? { roof } : {}), chimneyTops };
}
