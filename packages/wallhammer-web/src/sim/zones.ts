// Conflict zones of the `lanes` collision mode: where segments of two paths on different lanes come closer than a
// clearance (a smaller one for segments side by side), both stretches belong to one zone, and stretches that touch along a path or are linked through other
// paths merge into the same zone (a whole junction becomes one zone). Entities on the same lane are left to
// following; a zone is what following cannot see: paths that cut, merge or turn across each other.
//
// Built once from the paths of a network, in a fixed order (path id, segment, sample), so the zones are the same on
// every machine. Geometry is done in floating point on millimetre inputs with IEEE operations only (no
// transcendental functions), the result is whole millimetres.

import type { Path } from './paths.ts';

export interface ZoneIntervals {
  /** Per path id: zone stretches ascending along the path, mm, and the zone of each. */
  byPath: Map<number, { s0: Int32Array; s1: Int32Array; zone: Int32Array }>;
  count: number;
}

interface Seg {
  path: number;
  /** Index of the path in the input list. */
  pi: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  s0: number;
  len: number;
  lane: number;
}

const CELL = 16000;
const STEP = 250;
/** Stretches on one path closer than this merge (mm). */
const MERGE = 1000;

function segDist2(x: number, z: number, s: Seg): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = s.ax + dx * t - x;
  const pz = s.az + dz * t - z;
  return px * px + pz * pz;
}

/** The part of segment `a` (mm from its start) within `c` of segment `b`, or null. */
function near(a: Seg, b: Seg, c: number): [number, number] | null {
  let lo = -1;
  let hi = -1;
  const c2 = c * c;
  for (let t = 0; ; t += STEP) {
    const u = Math.min(t, a.len);
    const k = a.len > 0 ? u / a.len : 0;
    const x = a.ax + (a.bx - a.ax) * k;
    const z = a.az + (a.bz - a.az) * k;
    if (segDist2(x, z, b) < c2) {
      if (lo < 0) lo = u;
      hi = u;
    }
    if (u >= a.len) break;
  }
  return lo < 0 ? null : [lo, hi];
}

/** Segments whose directions are within about 18 degrees of each other or of the opposite (cos² > 0.9). */
function parallel(a: Seg, b: Seg): boolean {
  const ax = a.bx - a.ax;
  const az = a.bz - a.az;
  const bx = b.bx - b.ax;
  const bz = b.bz - b.az;
  const dot = ax * bx + az * bz;
  return dot * dot > 0.9 * (ax * ax + az * az) * (bx * bx + bz * bz);
}

export function buildZoneIntervals(paths: readonly Path[], clearance: number, parallelClearance = clearance): ZoneIntervals {
  const segs: Seg[] = [];
  paths.forEach((p, pi) => {
    const n = p.xs.length;
    for (let s = 0; s < p.segments; s++) {
      const b = (s + 1) % n;
      segs.push({
        path: p.id,
        pi,
        ax: Math.round(p.xs[s]! * 1000),
        az: Math.round(p.zs[s]! * 1000),
        bx: Math.round(p.xs[b]! * 1000),
        bz: Math.round(p.zs[b]! * 1000),
        s0: p.segStart[s]!,
        len: p.segStart[s + 1]! - p.segStart[s]!,
        lane: p.segLane[s]!,
      });
    }
  });
  // Segments into grid cells by their box swollen by the clearance.
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number): number => (cx + 0x8000) * 0x10000 + (cz + 0x8000);
  segs.forEach((s, i) => {
    const x0 = Math.floor((Math.min(s.ax, s.bx) - clearance) / CELL);
    const x1 = Math.floor((Math.max(s.ax, s.bx) + clearance) / CELL);
    const z0 = Math.floor((Math.min(s.az, s.bz) - clearance) / CELL);
    const z1 = Math.floor((Math.max(s.az, s.bz) + clearance) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  });
  // Stretches found, as union-find nodes.
  const st: { pi: number; s0: number; s1: number }[] = [];
  const parent: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const seen = new Set<number>();
  const keys = [...grid.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    const list = grid.get(k)!;
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const i = Math.min(list[x]!, list[y]!);
        const j = Math.max(list[x]!, list[y]!);
        const pair = i * segs.length + j;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const a = segs[i]!;
        const b = segs[j]!;
        if (a.lane === b.lane) continue;
        if (a.pi === b.pi) {
          // Neighbours along one path are always close: only far parts of a path conflict with each other.
          const p = paths[a.pi]!;
          let gap = Math.max(b.s0 - (a.s0 + a.len), a.s0 - (b.s0 + b.len));
          if (p.loop) gap = Math.min(gap, p.length - (Math.max(a.s0 + a.len, b.s0 + b.len) - Math.min(a.s0, b.s0)));
          if (gap < 4 * clearance) continue;
        }
        const cl = parallel(a, b) ? Math.min(clearance, parallelClearance) : clearance;
        const na = near(a, b, cl);
        if (!na) continue;
        const nb = near(b, a, cl) ?? [0, 0];
        const ia = st.length;
        st.push({ pi: a.pi, s0: a.s0 + na[0], s1: a.s0 + na[1] });
        parent.push(ia);
        st.push({ pi: b.pi, s0: b.s0 + nb[0], s1: b.s0 + nb[1] });
        parent.push(ia + 1);
        union(ia, ia + 1);
      }
    }
  }
  // Stretches that overlap or nearly touch on one path are one zone.
  const perPath = new Map<number, number[]>();
  st.forEach((s, i) => {
    const list = perPath.get(s.pi);
    if (list) list.push(i);
    else perPath.set(s.pi, [i]);
  });
  for (const list of perPath.values()) {
    list.sort((a, b) => st[a]!.s0 - st[b]!.s0 || a - b);
    let end = -Infinity;
    let last = -1;
    for (const i of list) {
      if (last >= 0 && st[i]!.s0 <= end + MERGE) union(last, i);
      if (st[i]!.s1 > end || last < 0) {
        end = Math.max(end, st[i]!.s1);
      }
      last = i;
    }
  }
  // Zone numbers in order of first appearance (input path order, then along the path).
  const zoneOf = new Map<number, number>();
  const byPath: ZoneIntervals['byPath'] = new Map();
  const pis = [...perPath.keys()].sort((a, b) => a - b);
  for (const pi of pis) {
    const list = perPath.get(pi)!;
    const s0: number[] = [];
    const s1: number[] = [];
    const zone: number[] = [];
    for (const i of list) {
      const root = find(i);
      let z = zoneOf.get(root);
      if (z === undefined) {
        z = zoneOf.size;
        zoneOf.set(root, z);
      }
      const k = s0.length - 1;
      // Merge with the previous stretch of the same zone when they overlap or touch.
      if (k >= 0 && zone[k] === z && st[i]!.s0 <= s1[k]! + MERGE) s1[k] = Math.max(s1[k]!, st[i]!.s1);
      else {
        s0.push(st[i]!.s0);
        s1.push(st[i]!.s1);
        zone.push(z);
      }
    }
    byPath.set(paths[pi]!.id, { s0: Int32Array.from(s0), s1: Int32Array.from(s1), zone: Int32Array.from(zone) });
  }
  return { byPath, count: zoneOf.size };
}
