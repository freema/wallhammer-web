// Stage 4 of the plan of the world: the roads of Hearth. A least-cost network over the grid of the plan joins the
// settlements (cost from slope, shore and rivers), is smoothed into lines that keep off lakes and the sea, gets a deck
// wherever it comes to a river, heights solved over the whole graph of nodes under a grade limit, and lands in the plan
// as road and deck lines (appended after the lanes) and the table of routes. Pure; called by `worldPlan`.
//
// Deterministic: no seed of its own, a pure function of the stage-3 plan. Every order comes from indices (sites,
// routes, grid nodes); maps and sets are only looked up, never iterated for an order. Arithmetic, Math.sqrt / floor /
// abs / min / max and the reproducible trigonometry of base only.

import type { Vec3 } from 'wallhammer-web/base';
import { RAD_PER_TURN, detAtan2, detSinCosTurns } from 'wallhammer-web/base';
import { gridDirection, gridNeighbours, gridNodeAt, limitGrade, lineAt, lineLengths, regionLinks, routeGrid, routeRegions, routeScratch, smoothLine } from 'wallhammer-web/gen-plan';
import type { LineTiles, StepCost } from 'wallhammer-web/gen-plan';
import { planGround, planLakeHold, planScope, planWater } from './ground.ts';
import { planLineTiles } from './plan-tiles.ts';
/** A way inside the domain of a lake keeps at least this far above its level (m). */
const LAKE_WAY_ABOVE_M = 0.5;
import type { Scope } from './ground.ts';
import { DECK_PROFILE, PROFILES, ROAD_PROFILE, tileLinesAtPoint } from './plan-lines.ts';
import { LINE_KIND, STAGE, tileReachM } from './plan.ts';
import type { PlanLines, RouteTable, WorldPlan } from './plan.ts';
import { siteFrame, siteLocal, sitePoint } from './settlement.ts';

/**
 * Numbers of the roads (all but `gradeMax` are starting values, tuned in README.md): the grade limit and the grade the
 * heights are designed to, the steepest grid step that stays open, half-width, metres between points, longest line,
 * cap on the points of all roads and decks, deck clearance over the water (base, per metre of river width, most), the
 * least clearance asserted, the skirt of a deck.
 */
export const ROAD = {
  gradeMax: 0.12,
  gradeDesign: 0.118,
  gridGradeMax: 0.09,
  halfM: 3,
  pointM: 50,
  lineMaxM: 1200,
  pointCap: 60000,
  deckClearM: [1.0, 0.05, 4.0],
  deckClearMinM: 0.6,
  // The same as DECK_SKIRT_M of plan-lines.ts (a literal: the modules import each other).
  deckSkirtM: 1.2,
} as const;

/** Class of the roads and decks (6c of the architecture: rivers ≥ 5 m and roads). */
const ROAD_CLASS = 1;
/** Cost of a step: slope at which the cost doubles, factor next to the shore, charge for stepping onto a river. */
const SLOPE_UNIT = 0.04;
const SHORE_FACTOR = 1.5;
const WET_BASE_M = 300;
const WET_PER_HALF_WIDTH_M = 20;
/** A step that is already laid costs this share of its metres. */
const LAID_SHARE = 0.35;
/**
 * A site that the closed steep steps wall off from every other site of its landmass is joined over steep steps at
 * this many times their cost (the grade pass keeps the road under the limit with cut and fill).
 */
const STEEP_FACTOR = 8;
/** Ground at least this high above the sea (units of 0.5 m) counts as land. */
const LAND_RELIEF = 2;
/** The built-up ring a road stops at, in radii of the site; ring points every this many turns. */
const RING = 1.3;
const RING_STEP_TURNS = 1 / 12;
/** Smoothing rounds of a trunk; the least share of its control line it keeps. */
const SMOOTH_ROUNDS = 3;
const MIN_SHARE = 0.8;
/** Shoulder of the road profile (plan-lines.ts) and the metre beyond it that a river's bank keeps from a road. */
const ROAD_SHOULDER_M = 5;
const BANK_EXTRA_M = 1;
/** Ends of a wet interval found to this many metres; intervals closer than this are one. */
const SPAN_EPS_M = 0.5;
const SPAN_MERGE_M = 40;
/**
 * An interval this near to an end of a trunk starts at that end. Both this and the merge keep every road piece longer
 * than the corners of its nodes (3.2 × 3 m at each end), which the strip tool needs.
 */
const SPAN_SNAP_M = 40;
/** A wet interval becomes a deck only where it comes this near to a river's water (else the road keeps to the bank). */
const SPAN_WATER_M = 0.5;
/** Samples along a deck for the water under it, metres apart. */
const DECK_SAMPLE_M = 10;

/** What the routes stage adds to the plan. */
export interface PlanRoutes {
  routes: RouteTable;
  lines: PlanLines;
  tiles: LineTiles;
  /** Sites with no road (no link to any other site): reported, never hidden. */
  lone: number[];
}

/** A node of the road graph before it gets a plan index. */
interface GNode {
  dir: Vec3;
  /** Plan node index of a gate (stage 3), else −1 until the lines are written. */
  plan: number;
  gate: boolean;
  /** Abutment of a deck: its wanted height is at least `deckWant`. */
  deckWant: number;
  heightM: number;
}

/** A piece of a trunk: a road between two graph nodes, or a deck. */
interface Piece {
  deck: boolean;
  a: number;
  b: number;
  /** Unit directions. */
  pts: number[];
  /** Deck: the widest river line under it (−1 for a road). */
  river: number;
}

/** A chain of laid steps between two ends (a site or a junction). */
interface Trunk {
  /** Vertices: grid node ≥ 0, or −1 − site. */
  verts: number[];
  /** Per end: the grid node inside the site's ring that the trunk left from (−1 at a junction). */
  zoneStart: number;
  zoneEnd: number;
  route: number;
  pieces: Piece[];
}

/** The routes of the plan and its road and deck lines. `view` holds stages 1–3 and tiles over its lines. */
export function planRoutes(view: WorldPlan): PlanRoutes {
  const sites = view.sites;
  if (!sites) throw new Error('planRoutes: the plan has no sites');
  const g = view.grid;
  const R = g.radiusM;
  const n = g.n;
  const nn = n * n;
  const count = g.count;
  const L = view.lines;
  const scope = planScope(view, STAGE.sites, null);
  const ground = (d: ArrayLike<number>): number => planGround(scope, d[0]! * R, d[1]! * R, d[2]! * R);

  // 1. Masks per node.
  const land = new Uint8Array(count);
  for (let i = 0; i < count; i++) if (view.pool[i] === 0 && view.relief[i]! >= LAND_RELIEF) land[i] = 1;
  const shore = new Uint8Array(count);
  const nb = new Int32Array(8);
  for (let i = 0; i < count; i++) {
    if (!land[i]) continue;
    const k = gridNeighbours(g, i, nb);
    for (let j = 0; j < k; j++) {
      if (!land[nb[j]!]) {
        shore[i] = 1;
        break;
      }
    }
  }
  const wet = new Uint8Array(count);
  const wetHalf = new Float32Array(count);
  const r0 = L.kindStart[LINE_KIND.river]!;
  const r1 = L.kindStart[LINE_KIND.river + 1]!;
  for (let p = L.start[r0]!; p < L.start[r1]!; p++) {
    const node = gridNodeAt(g, L.points[3 * p]!, L.points[3 * p + 1]!, L.points[3 * p + 2]!);
    wet[node] = 1;
    wetHalf[node] = Math.max(wetHalf[node]!, L.halfWidth[p]!);
  }

  // Step lengths inside a face, the same on every face: per node of face 0 and neighbour slot (gridNeighbours order).
  const steps = new Float32Array(nn * 8);
  {
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        gridDirection(g, i, a);
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < n && yy < n) {
              gridDirection(g, yy * n + xx, b);
              steps[i * 8 + k] = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) * R;
            }
            k++;
          }
        }
      }
    }
  }
  const ma: Vec3 = [0, 0, 0];
  const mb: Vec3 = [0, 0, 0];
  const SLOT = new Map<number, number>([
    [-n - 1, 0],
    [-n, 1],
    [-n + 1, 2],
    [-1, 3],
    [1, 4],
    [n - 1, 5],
    [n, 6],
    [n + 1, 7],
  ]);
  /** Metres between two neighbouring nodes (chord). */
  const metres = (a: number, b: number): number => {
    const fa = Math.floor(a / nn);
    if (fa === Math.floor(b / nn)) {
      const slot = SLOT.get(b - a);
      if (slot !== undefined) return steps[(a - fa * nn) * 8 + slot]!;
    }
    gridDirection(g, a, ma);
    gridDirection(g, b, mb);
    return Math.sqrt((ma[0] - mb[0]) ** 2 + (ma[1] - mb[1]) ** 2 + (ma[2] - mb[2]) ** 2) * R;
  };

  // 2. Base cost. `stepCost(a, b, steep)`: with `steep` a grid step over `gridGradeMax` stays open at STEEP_FACTOR
  // times its cost (only for the rescue of sites the closed steps wall in, see 3).
  const stepCost = (a: number, b: number, steep: boolean): number => {
    if (!land[b]) return Infinity;
    if (wet[a] && wet[b]) return Infinity;
    const m = metres(a, b);
    const slope = (Math.abs(view.relief[b]! - view.relief[a]!) * 0.5) / m;
    const closed = slope > ROAD.gridGradeMax;
    if (closed && !steep) return Infinity;
    const q = slope / SLOPE_UNIT;
    let c = m * (1 + q * q);
    if (closed) c *= STEEP_FACTOR;
    if (shore[b]) c *= SHORE_FACTOR;
    if (wet[b]) c += WET_BASE_M + WET_PER_HALF_WIDTH_M * wetHalf[b]!;
    return c;
  };
  const base: StepCost = (a, b) => stepCost(a, b, false);
  const steepBase: StepCost = (a, b) => stepCost(a, b, true);

  // 3. Which sites are joined: regions, links, the nearest of each, then a spanning tree per landmass.
  const S = sites.count;
  const regions = routeRegions(g, { sources: sites.node, cost: base, maxNodes: count });
  const links = regionLinks(g, regions, base);
  const nearLink = new Int32Array(S).fill(-1);
  const other = (k: number, s: number): number => (links.a[k] === s ? links.b[k]! : links.a[k]!);
  for (let k = 0; k < links.a.length; k++) {
    for (const s of [links.a[k]!, links.b[k]!]) {
      const best = nearLink[s]!;
      if (best < 0 || links.cost[k]! < links.cost[best]! || (links.cost[k] === links.cost[best] && other(k, s) < other(best, s))) nearLink[s] = k;
    }
  }
  const parent = Int32Array.from({ length: S }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const keptLink = new Uint8Array(links.a.length);
  for (let s = 0; s < S; s++) {
    const k = nearLink[s]!;
    if (k < 0) continue;
    keptLink[k] = 1;
    parent[find(links.a[k]!)] = find(links.b[k]!);
  }
  const byCost = Array.from({ length: links.a.length }, (_, k) => k).sort((p, q) => links.cost[p]! - links.cost[q]! || links.a[p]! - links.a[q]! || links.b[p]! - links.b[q]!);
  for (const k of byCost) {
    const x = find(links.a[k]!);
    const y = find(links.b[k]!);
    if (x === y) continue;
    keptLink[k] = 1;
    parent[x] = y;
  }
  const routeLinks = byCost.filter((k) => keptLink[k] === 1);
  // Rescue: the closed steep steps can wall a site (or a group of them) off from the rest of its landmass. The tree
  // goes on over the links of regions in which steep steps are open but dear (`steepBase`), cheapest first, joining
  // only what is still apart; a link there exists only over land, so the sea still parts landmasses.
  let steepRegions: ReturnType<typeof routeRegions> | null = null;
  const rescueA: number[] = [];
  const rescueB: number[] = [];
  {
    let apart = false;
    for (let s = 1; s < S && !apart; s++) if (find(s) !== find(0)) apart = true;
    if (apart) {
      steepRegions = routeRegions(g, { sources: sites.node, cost: steepBase, maxNodes: count });
      const sl = regionLinks(g, steepRegions, steepBase);
      const order2 = Array.from({ length: sl.a.length }, (_, k) => k).sort((p, q) => sl.cost[p]! - sl.cost[q]! || sl.a[p]! - sl.a[q]! || sl.b[p]! - sl.b[q]!);
      for (const k of order2) {
        const x = find(sl.a[k]!);
        const y = find(sl.b[k]!);
        if (x === y) continue;
        parent[x] = y;
        rescueA.push(sl.a[k]!);
        rescueB.push(sl.b[k]!);
      }
    }
  }
  const joinedSite = new Uint8Array(S);
  for (const k of routeLinks) joinedSite[links.a[k]!] = joinedSite[links.b[k]!] = 1;
  for (let i = 0; i < rescueA.length; i++) joinedSite[rescueA[i]!] = joinedSite[rescueB[i]!] = 1;
  const lone: number[] = [];
  for (let s = 0; s < S; s++) if (!joinedSite[s]) lone.push(s);

  // The ring of each site a road stops at, as a chord of the unit sphere; the zone of a node (−1: none).
  const siteDir = (s: number): Vec3 => [sites.dir[3 * s]!, sites.dir[3 * s + 1]!, sites.dir[3 * s + 2]!];
  const zoneMemo = new Map<number, number>();
  const zd: Vec3 = [0, 0, 0];
  const zoneOf = (node: number): number => {
    const known = zoneMemo.get(node);
    if (known !== undefined) return known;
    gridDirection(g, node, zd);
    let z = -1;
    for (let s = 0; s < S && z < 0; s++) {
      const c = (RING * sites.radiusM[s]!) / R;
      const dx = zd[0] - sites.dir[3 * s]!;
      const dy = zd[1] - sites.dir[3 * s + 1]!;
      const dz = zd[2] - sites.dir[3 * s + 2]!;
      if (dx * dx + dy * dy + dz * dz < c * c) z = s;
    }
    zoneMemo.set(node, z);
    return z;
  };
  const vid = (node: number): number => {
    const z = zoneOf(node);
    return z >= 0 ? -1 - z : node;
  };

  // 4. Paths, route by route, over what is already laid.
  const laid = new Set<number>();
  const stepKey = (a: number, b: number): number => (a < b ? a * count + b : b * count + a);
  const laidNode = new Uint8Array(count);
  const scratch = routeScratch(g);
  const paths: number[][] = [];
  const routeA: number[] = [];
  const routeB: number[] = [];
  // The links of the tree first (in order of cost), then the rescue links over their own regions and steep cost.
  const linkA: number[] = routeLinks.map((k) => links.a[k]!).concat(rescueA);
  const linkB: number[] = routeLinks.map((k) => links.b[k]!).concat(rescueB);
  for (let li = 0; li < linkA.length; li++) {
    const a = linkA[li]!;
    const b = linkB[li]!;
    const rescued = li >= routeLinks.length;
    const own = rescued ? steepRegions!.owner : regions.owner;
    const cost0 = rescued ? steepBase : base;
    const inRegions = (v: number): boolean => own[v] === a || own[v] === b;
    const cost: StepCost = (u, v) => {
      if (!inRegions(v)) return Infinity;
      if (laid.has(stepKey(u, v))) return LAID_SHARE * metres(u, v);
      if ((laidNode[u] && wet[u]) || (laidNode[v] && wet[v])) return Infinity;
      return cost0(u, v);
    };
    let path = routeGrid(g, { from: sites.node[a]!, to: sites.node[b]!, cost, maxNodes: count, scratch });
    // Closed by a laid crossing: the plain cost inside the two regions (the roads may then meet on a river).
    path ??= routeGrid(g, { from: sites.node[a]!, to: sites.node[b]!, cost: (u, v) => (inRegions(v) ? cost0(u, v) : Infinity), maxNodes: count, scratch });
    if (!path) continue;
    // Only the part between the last node in the ring of a and the first node in the ring of b after it.
    let i0 = 0;
    for (let i = 0; i < path.length; i++) if (zoneOf(path[i]!) === a) i0 = i;
    let i1 = path.length - 1;
    for (let i = i0 + 1; i < path.length; i++) {
      if (zoneOf(path[i]!) === b) {
        i1 = i;
        break;
      }
    }
    const eff = Array.from(path.subarray(i0, i1 + 1));
    for (let i = 0; i + 1 < eff.length; i++) {
      laid.add(stepKey(eff[i]!, eff[i + 1]!));
      laidNode[eff[i]!] = 1;
      laidNode[eff[i + 1]!] = 1;
    }
    paths.push(eff);
    routeA.push(a);
    routeB.push(b);
  }
  const routeCount = paths.length;

  // The collapsed graph: every node inside a site's ring is that site. Edges once each, with the ring node they leave.
  const edgeKey = (x: number, y: number): string => (x < y ? `${x},${y}` : `${y},${x}`);
  const edgeZone = new Map<string, number>();
  const degree = new Map<number, number>();
  const seqs: number[][] = [];
  for (const eff of paths) {
    const seq: number[] = [];
    for (let i = 0; i < eff.length; i++) {
      const v = vid(eff[i]!);
      if (seq.length > 0 && seq[seq.length - 1] === v) continue;
      if (seq.length > 0) {
        const key = edgeKey(seq[seq.length - 1]!, v);
        if (!edgeZone.has(key)) {
          // The ring node: the one of the step that lies inside a site's ring.
          const prevNode = eff[i - 1]!;
          edgeZone.set(key, v < 0 ? eff[i]! : seq[seq.length - 1]! < 0 ? prevNode : -1);
          degree.set(v, (degree.get(v) ?? 0) + 1);
          degree.set(seq[seq.length - 1]!, (degree.get(seq[seq.length - 1]!) ?? 0) + 1);
        }
      }
      seq.push(v);
    }
    seqs.push(seq);
  }
  const isEnd = (v: number): boolean => v < 0 || degree.get(v) !== 2;

  // Trunks, numbered as the routes first meet them; each route as trunks with a direction.
  const trunks: Trunk[] = [];
  const trunkOfEdge = new Map<string, number>();
  const travel: { trunk: number; forward: boolean }[][] = [];
  seqs.forEach((seq, r) => {
    const out: { trunk: number; forward: boolean }[] = [];
    let start = 0;
    for (let j = 1; j < seq.length; j++) {
      if (!isEnd(seq[j]!) && j < seq.length - 1) continue;
      const piece = seq.slice(start, j + 1);
      const key = edgeKey(piece[0]!, piece[1]!);
      let t = trunkOfEdge.get(key);
      if (t === undefined) {
        t = trunks.length;
        trunks.push({
          verts: piece,
          zoneStart: piece[0]! < 0 ? edgeZone.get(key)! : -1,
          zoneEnd: piece[piece.length - 1]! < 0 ? edgeZone.get(edgeKey(piece[piece.length - 2]!, piece[piece.length - 1]!))! : -1,
          route: r,
          pieces: [],
        });
        for (let i = 0; i + 1 < piece.length; i++) trunkOfEdge.set(edgeKey(piece[i]!, piece[i + 1]!), t);
        out.push({ trunk: t, forward: true });
      } else {
        const tv = trunks[t]!.verts;
        out.push({ trunk: t, forward: tv[0] === piece[0] && tv[1] === piece[1] });
      }
      start = j;
    }
    travel.push(out);
  });

  // The graph nodes: gates by plan node, junctions by grid node, then abutments and plain nodes as made.
  const gnodes: GNode[] = [];
  const gateNode = new Map<number, number>();
  const junctionNode = new Map<number, number>();
  const nodeOfGate = (planNode: number): number => {
    let i = gateNode.get(planNode);
    if (i === undefined) {
      i = gnodes.length;
      gnodes.push({ dir: [L.nodes[4 * planNode]!, L.nodes[4 * planNode + 1]!, L.nodes[4 * planNode + 2]!], plan: planNode, gate: true, deckWant: -Infinity, heightM: L.nodes[4 * planNode + 3]! });
      gateNode.set(planNode, i);
    }
    return i;
  };
  const nodeOfJunction = (gridNode: number): number => {
    let i = junctionNode.get(gridNode);
    if (i === undefined) {
      i = gnodes.length;
      gnodes.push({ dir: gridDirection(g, gridNode, [0, 0, 0]), plan: -1, gate: false, deckWant: -Infinity, heightM: 0 });
      junctionNode.set(gridNode, i);
    }
    return i;
  };
  const newNode = (dir: Vec3): number => {
    gnodes.push({ dir, plan: -1, gate: false, deckWant: -Infinity, heightM: 0 });
    return gnodes.length - 1;
  };
  /** Sites without a gate get one node on their radius toward the trunk (reported in the notes of README.md). */
  const extraGate = new Map<string, number>();

  // 5. and 6. Geometry of every trunk, its spans; redone with a doubled point spacing over the cap.
  let pointM: number = ROAD.pointM;
  for (;;) {
    gnodes.length = 0;
    gateNode.clear();
    junctionNode.clear();
    extraGate.clear();
    let total = 0;
    for (const t of trunks) {
      t.pieces = trunkPieces(t);
      for (const p of t.pieces) total += p.pts.length / 3;
    }
    if (total <= ROAD.pointCap) break;
    pointM *= 2;
  }

  /** The end of a trunk at a site: the gate nearest the ring node it left from, and ring points when needed. */
  function siteEnd(s: number, zoneNode: number, next: Vec3): { node: number; ring: Vec3[] } {
    const zd2 = gridDirection(g, zoneNode, [0, 0, 0]);
    const f = siteFrame(view, s);
    const r = sites!.radiusM[s]!;
    let gate = -1;
    let best = Infinity;
    for (let k = sites!.gates[s]!; k < sites!.gates[s + 1]!; k++) {
      const pn = sites!.gateNodes[k]!;
      const d = (L.nodes[4 * pn]! - zd2[0]) ** 2 + (L.nodes[4 * pn + 1]! - zd2[1]) ** 2 + (L.nodes[4 * pn + 2]! - zd2[2]) ** 2;
      if (d < best) {
        best = d;
        gate = pn;
      }
    }
    let node: number;
    let gx: number;
    let gz: number;
    if (gate >= 0) {
      node = nodeOfGate(gate);
      const q = siteLocal(f, L.nodes[4 * gate]!, L.nodes[4 * gate + 1]!, L.nodes[4 * gate + 2]!);
      gx = q.x;
      gz = q.z;
    } else {
      // No gate: a new node on the radius toward the ring node.
      const q = siteLocal(f, zd2[0], zd2[1], zd2[2]);
      const l = Math.sqrt(q.x * q.x + q.z * q.z) || 1;
      gx = (q.x / l) * r;
      gz = (q.z / l) * r;
      const key = `${s}`;
      const known = extraGate.get(key);
      if (known !== undefined) node = known;
      else {
        const p = sitePoint(f, gx, gz);
        node = newNode(p.dir);
        gnodes[node]!.gate = true;
        gnodes[node]!.heightM = p.heightM;
        extraGate.set(key, node);
      }
    }
    // Ring points when the straight way from the gate to the next point enters the built-up radius.
    const q = siteLocal(f, next[0], next[1], next[2]);
    const ex = q.x - gx;
    const ez = q.z - gz;
    const e2 = ex * ex + ez * ez;
    const tt = e2 > 0 ? Math.min(1, Math.max(0, -(gx * ex + gz * ez) / e2)) : 0;
    const cx = gx + ex * tt;
    const cz = gz + ez * tt;
    const ring: Vec3[] = [];
    if (Math.sqrt(cx * cx + cz * cz) < r - 0.5) {
      const tg = turnsOf(gz, gx);
      const tq = turnsOf(q.z, q.x);
      let delta = tq - tg;
      delta -= Math.floor(delta + 0.5);
      const sign = delta < 0 ? -1 : 1;
      for (let k = 0; k * RING_STEP_TURNS < Math.abs(delta); k++) {
        const [sn, cs] = detSinCosTurns(tg + sign * k * RING_STEP_TURNS);
        ring.push(sitePoint(f, RING * r * cs, RING * r * sn).dir);
      }
    }
    return { node, ring };
  }

  /** Control points, smoothing, points and spans of one trunk. */
  function trunkPieces(t: Trunk): Piece[] {
    const v = t.verts;
    const inner: Vec3[] = [];
    for (let i = 1; i < v.length - 1; i++) inner.push(gridDirection(g, v[i]!, [0, 0, 0]));
    const first = v[0]!;
    const last = v[v.length - 1]!;
    const endDir = (vv: number): Vec3 => (vv >= 0 ? gridDirection(g, vv, [0, 0, 0]) : siteDir(-1 - vv));
    let aNode: number;
    let bNode: number;
    const ctrl: Vec3[] = [];
    // The start.
    const nextOfStart = inner.length > 0 ? inner[0]! : endDir(last);
    if (first < 0) {
      const e = siteEnd(-1 - first, t.zoneStart, nextOfStart);
      aNode = e.node;
      ctrl.push(gnodes[aNode]!.dir, ...e.ring);
    } else {
      aNode = nodeOfJunction(first);
      ctrl.push(gnodes[aNode]!.dir);
    }
    ctrl.push(...inner);
    const prevOfEnd = inner.length > 0 ? inner[inner.length - 1]! : endDir(first);
    if (last < 0) {
      const e = siteEnd(-1 - last, t.zoneEnd, prevOfEnd);
      bNode = e.node;
      ctrl.push(...e.ring.reverse(), gnodes[bNode]!.dir);
    } else {
      bNode = nodeOfJunction(last);
      ctrl.push(gnodes[bNode]!.dir);
    }
    const control = new Float64Array(3 * ctrl.length);
    ctrl.forEach((p, i) => control.set(p, 3 * i));
    const controlLen = lineLengths(control, R);
    const controlM = controlLen[controlLen.length - 1]!;
    // Smooth, resample, and back off the smoothing while a point is in a lake or the sea, or the line got too short.
    let pts: Float64Array = control;
    // When no round keeps every point dry, the round with the fewest wet points wins (ties: the fewer rounds).
    let best: Float64Array | null = null;
    let bestWet = Infinity;
    let ok = false;
    for (let rounds = SMOOTH_ROUNDS; rounds >= 0; rounds--) {
      const sm = smoothLine(control, rounds);
      pts = resample(sm, pointM);
      const len = lineLengths(pts, R);
      const long = len[len.length - 1]! >= MIN_SHARE * controlM;
      ok = long;
      // A line that got too short is no candidate, unless it is the last round.
      if (!long && rounds > 0) continue;
      let wet = 0;
      for (let i = 0; i < pts.length / 3; i++) {
        const px = pts[3 * i]! * R;
        const py = pts[3 * i + 1]! * R;
        const pz = pts[3 * i + 2]! * R;
        const w = planWater(scope, px, py, pz).kind;
        let dry = !(w === 1 || w === 2);
        // Inside a lake's domain no way lower than its level and half a metre (plan-lakes.ts).
        if (dry) {
          const hold = planLakeHold(scope, px, py, pz);
          if (hold === hold && planGround(scope, px, py, pz) < hold + LAKE_WAY_ABOVE_M) dry = false;
        }
        if (!dry) {
          ok = false;
          wet++;
          // This round can no longer beat the best one.
          if (wet > bestWet) break;
        }
      }
      if (ok) break;
      if (wet <= bestWet) {
        best = pts;
        bestWet = wet;
      }
    }
    if (!ok && best) pts = best;
    return spans(pts, aNode, bNode);
  }

  /** A line of unit directions resampled to equal pieces of at most `stepM`, its two ends kept bit for bit. */
  function resample(p: Float64Array, stepM: number): Float64Array {
    const len = lineLengths(p, R);
    const total = len[len.length - 1]!;
    const k = Math.max(1, Math.ceil(total / stepM));
    const out = new Float64Array(3 * (k + 1));
    const at = { dir: [0, 0, 0] as Vec3, heading: [0, 0, 0] as Vec3 };
    for (let i = 0; i <= k; i++) {
      if (i === 0 || i === k) {
        const src = i === 0 ? 0 : p.length - 3;
        out[3 * i] = p[src]!;
        out[3 * i + 1] = p[src + 1]!;
        out[3 * i + 2] = p[src + 2]!;
        continue;
      }
      lineAt(p, len, (total * i) / k, at);
      out.set(at.dir, 3 * i);
    }
    return out;
  }

  /** River probe at a unit direction: the least (distance − half-width − bank) and (distance − half-width), and the line of the second. */
  function riverAt(d: ArrayLike<number>): { wet: number; water: number; line: number; halfWidth: number; gradeM: number } {
    const x = d[0]! * R;
    const y = d[1]! * R;
    const z = d[2]! * R;
    let wetMin = Infinity;
    let waterMin = Infinity;
    let line = -1;
    let halfWidth = 0;
    let gradeM = 0;
    for (const l of tileLinesAtPoint(view, STAGE.water, x, y, z)) {
      const bank = PROFILES[L.profile[l]!]!.shoulderM + ROAD_SHOULDER_M + BANK_EXTRA_M;
      for (let p = L.start[l]!; p + 1 < L.start[l + 1]!; p++) {
        const ax = L.points[3 * p]! * R;
        const ay = L.points[3 * p + 1]! * R;
        const az = L.points[3 * p + 2]! * R;
        const ex = L.points[3 * p + 3]! * R - ax;
        const ey = L.points[3 * p + 4]! * R - ay;
        const ez = L.points[3 * p + 5]! * R - az;
        const e2 = ex * ex + ey * ey + ez * ez;
        const t = e2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / e2)) : 0;
        const dist = Math.sqrt((ax + ex * t - x) ** 2 + (ay + ey * t - y) ** 2 + (az + ez * t - z) ** 2);
        const hw = L.halfWidth[p]! + (L.halfWidth[p + 1]! - L.halfWidth[p]!) * t;
        wetMin = Math.min(wetMin, dist - hw - bank);
        if (dist - hw < waterMin) {
          waterMin = dist - hw;
          line = l;
          halfWidth = hw;
          gradeM = L.grade[p]! + (L.grade[p + 1]! - L.grade[p]!) * t;
        }
      }
    }
    return { wet: wetMin, water: waterMin, line, halfWidth, gradeM };
  }

  /** The params (metres along a segment a → b of `segM` metres) of closest approach to the river segments near it. */
  function approaches(a: ArrayLike<number>, b: ArrayLike<number>, segM: number, out: number[]): void {
    const ax = a[0]! * R;
    const ay = a[1]! * R;
    const az = a[2]! * R;
    const ux = b[0]! * R - ax;
    const uy = b[1]! * R - ay;
    const uz = b[2]! * R - az;
    const uu = ux * ux + uy * uy + uz * uz;
    if (!(uu > 0)) return;
    const lines = new Set<number>();
    for (const q of [a, b]) for (const l of tileLinesAtPoint(view, STAGE.water, q[0]! * R, q[1]! * R, q[2]! * R)) lines.add(l);
    const sorted = [...lines].sort((p, q) => p - q);
    for (const l of sorted) {
      for (let p = L.start[l]!; p + 1 < L.start[l + 1]!; p++) {
        const cx = L.points[3 * p]! * R;
        const cy = L.points[3 * p + 1]! * R;
        const cz = L.points[3 * p + 2]! * R;
        const vx = L.points[3 * p + 3]! * R - cx;
        const vy = L.points[3 * p + 4]! * R - cy;
        const vz = L.points[3 * p + 5]! * R - cz;
        const wx = ax - cx;
        const wy = ay - cy;
        const wz = az - cz;
        const uv = ux * vx + uy * vy + uz * vz;
        const vv = vx * vx + vy * vy + vz * vz;
        const uw = ux * wx + uy * wy + uz * wz;
        const vw = vx * wx + vy * wy + vz * wz;
        const den = uu * vv - uv * uv;
        let s = den > 1e-9 ? (uv * vw - vv * uw) / den : 0;
        s = Math.min(1, Math.max(0, s));
        let tv = vv > 0 ? (uv * s + vw) / vv : 0;
        if (tv < 0 || tv > 1) {
          tv = Math.min(1, Math.max(0, tv));
          s = Math.min(1, Math.max(0, (uv * tv - uw) / uu));
        }
        if (s > 0 && s < 1) out.push(s * segM);
      }
    }
  }

  /** The spans of a trunk (wet intervals that reach the water) as decks between new abutments, roads between. */
  function spans(pts: Float64Array, aNode: number, bNode: number): Piece[] {
    const len = lineLengths(pts, R);
    const total = len[len.length - 1]!;
    const m = pts.length / 3;
    const at = { dir: [0, 0, 0] as Vec3, heading: [0, 0, 0] as Vec3 };
    const pointAt = (s: number): Vec3 => {
      lineAt(pts, len, s, at);
      return [at.dir[0], at.dir[1], at.dir[2]];
    };
    // Samples: every point, and per segment the closest approaches to the rivers near it.
    const samples: { s: number; wet: boolean; water: number; line: number; hw: number; grade: number }[] = [];
    const add = (s: number): void => {
      const d = s === 0 ? pts.subarray(0, 3) : s === total ? pts.subarray(pts.length - 3) : pointAt(s);
      const r = riverAt(d);
      samples.push({ s, wet: r.wet < 0, water: r.water, line: r.line, hw: r.halfWidth, grade: r.gradeM });
    };
    const extra: number[] = [];
    for (let i = 0; i < m; i++) {
      add(len[i]!);
      if (i + 1 >= m) break;
      extra.length = 0;
      approaches(pts.subarray(3 * i, 3 * i + 3), pts.subarray(3 * i + 3, 3 * i + 6), len[i + 1]! - len[i]!, extra);
      extra.sort((p, q) => p - q);
      for (const e of extra) add(len[i]! + e);
    }
    samples.sort((p, q) => p.s - q.s);
    // Intervals, their ends found by bisection.
    const wetAt = (s: number): boolean => riverAt(pointAt(s)).wet < 0;
    const edge = (dry: number, wetS: number): number => {
      let lo = dry;
      let hi = wetS;
      while (Math.abs(hi - lo) > SPAN_EPS_M) {
        const mid = (lo + hi) / 2;
        if (wetAt(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    const intervals: { s0: number; s1: number; water: number; line: number; hw: number; grade: number }[] = [];
    let cur: (typeof intervals)[number] | null = null;
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i]!;
      if (p.wet) {
        if (!cur) {
          const s0 = i === 0 ? p.s : edge(samples[i - 1]!.s, p.s);
          cur = { s0, s1: p.s, water: Infinity, line: -1, hw: 0, grade: -Infinity };
          intervals.push(cur);
        }
        cur.s1 = p.s;
        if (p.water < SPAN_WATER_M) {
          cur.water = Math.min(cur.water, p.water);
          if (p.hw > cur.hw || cur.line < 0) {
            cur.hw = p.hw;
            cur.line = p.line;
          }
          cur.grade = Math.max(cur.grade, p.grade);
        }
      } else if (cur) {
        cur.s1 = edge(p.s, cur.s1);
        cur = null;
      }
    }
    // Merge near intervals; keep those that reach the water; snap to the ends.
    const merged: typeof intervals = [];
    for (const iv of intervals) {
      const prev = merged[merged.length - 1];
      if (prev && iv.s0 - prev.s1 < SPAN_MERGE_M) {
        prev.s1 = iv.s1;
        if (iv.line >= 0 && (prev.line < 0 || iv.hw > prev.hw)) {
          prev.line = iv.line;
          prev.hw = iv.hw;
        }
        prev.water = Math.min(prev.water, iv.water);
        prev.grade = Math.max(prev.grade, iv.grade);
      } else merged.push({ ...iv });
    }
    const decks = merged.filter((iv) => iv.line >= 0 && iv.water < SPAN_WATER_M);
    for (const iv of decks) {
      if (iv.s0 < SPAN_SNAP_M) iv.s0 = 0;
      if (iv.s1 > total - SPAN_SNAP_M) iv.s1 = total;
    }
    // Pieces in order along the trunk.
    const pieces: Piece[] = [];
    let s = 0;
    let node = aNode;
    let k = 0;
    const roadTo = (s1: number, toNode: number): void => {
      const out: number[] = [];
      const head = s === 0 ? pts.subarray(0, 3) : gnodes[node]!.dir;
      out.push(head[0]!, head[1]!, head[2]!);
      for (let i = 0; i < m; i++) if (len[i]! > s + SPAN_EPS_M && len[i]! < s1 - SPAN_EPS_M) out.push(pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!);
      const tail = gnodes[toNode]!.dir;
      out.push(tail[0], tail[1], tail[2]);
      pieces.push({ deck: false, a: node, b: toNode, pts: out, river: -1 });
    };
    for (const iv of decks) {
      const n0 = iv.s0 === 0 ? aNode : newNode(pointAt(iv.s0));
      const n1 = iv.s1 === total ? bNode : newNode(pointAt(iv.s1));
      if (iv.s0 > 0) roadTo(iv.s0, n0);
      // The water under the deck: the river's grade there and every level `planWater` reports along it.
      const d0 = gnodes[n0]!.dir;
      const d1 = gnodes[n1]!.dir;
      const deckM = Math.sqrt((d0[0] - d1[0]) ** 2 + (d0[1] - d1[1]) ** 2 + (d0[2] - d1[2]) ** 2) * R;
      let water = iv.grade;
      const samplesN = Math.max(2, Math.ceil(deckM / DECK_SAMPLE_M));
      for (let j = 0; j <= samplesN; j++) {
        const u = j / samplesN;
        const x = d0[0] + (d1[0] - d0[0]) * u;
        const y = d0[1] + (d1[1] - d0[1]) * u;
        const z = d0[2] + (d1[2] - d0[2]) * u;
        const l = Math.sqrt(x * x + y * y + z * z);
        const w = planWater(scope, (x / l) * R, (y / l) * R, (z / l) * R);
        if (w.kind !== 0) water = Math.max(water, w.levelM);
      }
      const clear = Math.min(ROAD.deckClearM[0] + ROAD.deckClearM[1] * 2 * iv.hw, ROAD.deckClearM[2]);
      for (const a of [n0, n1]) gnodes[a]!.deckWant = Math.max(gnodes[a]!.deckWant, water + clear);
      pieces.push({ deck: true, a: n0, b: n1, pts: [d0[0], d0[1], d0[2], d1[0], d1[1], d1[2]], river: iv.line });
      s = iv.s1;
      node = n1;
      k++;
    }
    if (s < total) roadTo(total, bNode);
    return pieces;
  }

  // 7. Node heights over the graph: wanted heights, the two cones under the grade, their middle, the cones of the gates.
  // At a turn the straight distance between two points of the road is shorter than the way along it: a turn by θ
  // shortens it to cos(θ/2) of the way at worst (for any two points that hold only that vertex between them). Each
  // segment is therefore allowed only gradeDesign · cos(θ/2) of the sharper turn at its two ends, so the road climbs
  // under the limit measured straight too (routePoint sampled at any step). The allowance of a segment is that grade
  // times its metres; heights are solved in the cumulative allowance instead of metres.
  const G = ROAD.gradeDesign;
  const edges: { a: number; b: number; m: number }[] = [];
  const pieceLen = new Map<Piece, Float64Array>();
  const pieceAllow = new Map<Piece, Float64Array>();
  /** Unit direction of the segment from point i to point i + 1 of a piece. */
  const segDir = (pts: number[], i: number): Vec3 => {
    const x = pts[3 * i + 3]! - pts[3 * i]!;
    const y = pts[3 * i + 4]! - pts[3 * i + 1]!;
    const z = pts[3 * i + 5]! - pts[3 * i + 2]!;
    const l = Math.sqrt(x * x + y * y + z * z);
    return l > 0 ? [x / l, y / l, z / l] : [0, 0, 0];
  };
  /** cos(θ/2) of the turn from direction `inn` to `out` (both unit; 1 for a zero vector). */
  const halfCos = (inn: Vec3, out: Vec3): number => {
    if ((inn[0] === 0 && inn[1] === 0 && inn[2] === 0) || (out[0] === 0 && out[1] === 0 && out[2] === 0)) return 1;
    const c = inn[0] * out[0] + inn[1] * out[1] + inn[2] * out[2];
    return Math.sqrt(Math.max(0, Math.min(1, (1 + c) / 2)));
  };
  // Per graph node, the directions in which its pieces leave it; its factor is that of the sharpest pass through it.
  const leaving: Vec3[][] = gnodes.map(() => []);
  for (const t of trunks) {
    for (const p of t.pieces) {
      const k = p.pts.length / 3;
      const d0 = segDir(p.pts, 0);
      const d1 = segDir(p.pts, k - 2);
      leaving[p.a]!.push(d0);
      leaving[p.b]!.push([-d1[0], -d1[1], -d1[2]]);
    }
  }
  const nodeFactor = leaving.map((ds) => {
    let f = 1;
    for (let i = 0; i < ds.length; i++) {
      for (let j = i + 1; j < ds.length; j++) {
        const inn = ds[i]!;
        f = Math.min(f, halfCos([-inn[0], -inn[1], -inn[2]], ds[j]!));
      }
    }
    return f;
  });
  for (const t of trunks) {
    for (const p of t.pieces) {
      const len = lineLengths(p.pts, R);
      pieceLen.set(p, len);
      const k = p.pts.length / 3;
      // Factor at each point: the node's at the ends, the turn's inside.
      const f = new Float64Array(k);
      f[0] = nodeFactor[p.a]!;
      f[k - 1] = nodeFactor[p.b]!;
      for (let i = 1; i < k - 1; i++) f[i] = halfCos(segDir(p.pts, i - 1), segDir(p.pts, i));
      const allow = new Float64Array(k);
      if (p.deck) {
        // A deck is one straight ramp: its grade is the least of all its segments'.
        let fm = 1;
        for (let i = 0; i < k; i++) fm = Math.min(fm, f[i]!);
        for (let i = 1; i < k; i++) allow[i] = G * fm * len[i]!;
      } else {
        for (let i = 1; i < k; i++) allow[i] = allow[i - 1]! + G * Math.min(f[i - 1]!, f[i]!) * (len[i]! - len[i - 1]!);
      }
      pieceAllow.set(p, allow);
      edges.push({ a: p.a, b: p.b, m: allow[k - 1]! });
    }
  }
  const N = gnodes.length;
  const want = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const gn = gnodes[i]!;
    want[i] = gn.gate ? gn.heightM : Math.max(ground(gn.dir), gn.deckWant);
  }
  const relax = (h: Float64Array, upward: boolean): void => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const e of edges) {
        const d = e.m;
        if (upward) {
          if (h[e.b]! - d > h[e.a]!) {
            h[e.a] = h[e.b]! - d;
            changed = true;
          }
          if (h[e.a]! - d > h[e.b]!) {
            h[e.b] = h[e.a]! - d;
            changed = true;
          }
        } else {
          if (h[e.b]! + d < h[e.a]!) {
            h[e.a] = h[e.b]! + d;
            changed = true;
          }
          if (h[e.a]! + d < h[e.b]!) {
            h[e.b] = h[e.a]! + d;
            changed = true;
          }
        }
      }
    }
  };
  const up = Float64Array.from(want);
  const lo = Float64Array.from(want);
  relax(up, true);
  relax(lo, false);
  const floorG = new Float64Array(N).fill(-Infinity);
  const ceilG = new Float64Array(N).fill(Infinity);
  for (let i = 0; i < N; i++) {
    if (!gnodes[i]!.gate) continue;
    floorG[i] = gnodes[i]!.heightM;
    ceilG[i] = gnodes[i]!.heightM;
  }
  relax(floorG, true);
  relax(ceilG, false);
  for (let i = 0; i < N; i++) {
    const gn = gnodes[i]!;
    if (gn.gate) continue;
    const mid = (up[i]! + lo[i]!) / 2;
    gn.heightM = mid < floorG[i]! ? floorG[i]! : mid > ceilG[i]! ? ceilG[i]! : mid;
  }

  // 8. Grades: a road piece follows the ground under the limit between its node heights; a deck is straight.
  const grades = new Map<Piece, Float64Array>();
  for (const t of trunks) {
    for (const p of t.pieces) {
      const len = pieceLen.get(p)!;
      const k = p.pts.length / 3;
      const h = new Float64Array(k);
      for (let i = 0; i < k; i++) h[i] = i === 0 ? gnodes[p.a]!.heightM : i === k - 1 ? gnodes[p.b]!.heightM : p.deck ? 0 : ground(p.pts.slice(3 * i, 3 * i + 3));
      if (p.deck) {
        const total = len[k - 1]!;
        for (let i = 1; i < k - 1; i++) h[i] = h[0]! + ((h[k - 1]! - h[0]!) * len[i]!) / total;
        grades.set(p, h);
      } else grades.set(p, limitGrade(pieceAllow.get(p)!, h, 1));
    }
  }

  // 9. Lines: roads cut at plain nodes to at most `lineMaxM`, then decks; nodes get their plan indices as met.
  const start: number[] = Array.from(L.start);
  const pts: number[] = Array.from(L.points);
  const grade: number[] = Array.from(L.grade);
  const hw: number[] = Array.from(L.halfWidth);
  const profile: number[] = Array.from(L.profile);
  const cls: number[] = Array.from(L.cls);
  const owner: number[] = Array.from(L.owner);
  const from: number[] = Array.from(L.from);
  const to: number[] = Array.from(L.to);
  const planNodes: number[] = Array.from(L.nodes);
  const planIndex = (i: number): number => {
    const gn = gnodes[i]!;
    if (gn.plan < 0) {
      gn.plan = planNodes.length / 4;
      planNodes.push(gn.dir[0], gn.dir[1], gn.dir[2], gn.heightM);
    }
    return gn.plan;
  };
  const laneEnd = L.kindStart[LINE_KIND.lane + 1]!;
  /** Per trunk, its lines in order along it (roads and decks as they lie). */
  const trunkLines: number[][] = trunks.map(() => []);
  const deckRiver = new Map<number, number>();
  const emit = (t: number, p: Piece, a: number, b: number, i0: number, i1: number, h: Float64Array, kind: number): number => {
    const line = owner.length;
    for (let i = i0; i <= i1; i++) {
      pts.push(p.pts[3 * i]!, p.pts[3 * i + 1]!, p.pts[3 * i + 2]!);
      grade.push(h[i]!);
      hw.push(ROAD.halfM);
    }
    start.push(pts.length / 3);
    profile.push(kind === LINE_KIND.deck ? DECK_PROFILE : ROAD_PROFILE);
    cls.push(ROAD_CLASS);
    owner.push(trunks[t]!.route);
    from.push(planIndex(a));
    to.push(planIndex(b));
    return line;
  };
  // Positions of the lines of a trunk, to put roads and decks back in their order along it.
  const order: { t: number; pos: number; line: number }[] = [];
  trunks.forEach((t, ti) => {
    t.pieces.forEach((p, pi) => {
      if (p.deck) return;
      const h = grades.get(p)!;
      const len = pieceLen.get(p)!;
      const k = h.length;
      const parts = Math.max(1, Math.ceil(len[k - 1]! / ROAD.lineMaxM));
      const cuts: number[] = [0];
      for (let j = 1; j < parts; j++) {
        const want2 = (len[k - 1]! * j) / parts;
        let best = -1;
        for (let i = 1; i < k - 1; i++) if (best < 0 || Math.abs(len[i]! - want2) < Math.abs(len[best]! - want2)) best = i;
        if (best > cuts[cuts.length - 1]!) cuts.push(best);
      }
      cuts.push(k - 1);
      let a = p.a;
      for (let j = 0; j + 1 < cuts.length; j++) {
        const i1 = cuts[j + 1]!;
        let b = p.b;
        if (i1 < k - 1) {
          b = newNode([p.pts[3 * i1]!, p.pts[3 * i1 + 1]!, p.pts[3 * i1 + 2]!]);
          gnodes[b]!.heightM = h[i1]!;
        }
        order.push({ t: ti, pos: pi * 1000 + j, line: emit(ti, p, a, b, cuts[j]!, i1, h, LINE_KIND.road) });
        a = b;
      }
    });
  });
  const roadEnd = owner.length;
  trunks.forEach((t, ti) => {
    t.pieces.forEach((p, pi) => {
      if (!p.deck) return;
      const line = emit(ti, p, p.a, p.b, 0, p.pts.length / 3 - 1, grades.get(p)!, LINE_KIND.deck);
      deckRiver.set(line, p.river);
      order.push({ t: ti, pos: pi * 1000, line });
    });
  });
  const deckEnd = owner.length;
  order.sort((p, q) => p.t - q.t || p.pos - q.pos);
  for (const o of order) trunkLines[o.t]!.push(o.line);

  const lines: PlanLines = {
    kindStart: Uint32Array.from([L.kindStart[0]!, L.kindStart[1]!, laneEnd, roadEnd, deckEnd]),
    start: Uint32Array.from(start),
    points: Float32Array.from(pts),
    grade: Float32Array.from(grade),
    halfWidth: Float32Array.from(hw),
    profile: Uint8Array.from(profile),
    cls: Uint8Array.from(cls),
    owner: Uint32Array.from(owner),
    from: Int32Array.from(from),
    to: Int32Array.from(to),
    nodes: Float32Array.from(planNodes),
  };

  // 10. The table of routes.
  const lineStart: number[] = [0];
  const lineOf: number[] = [];
  const lengthM = new Float32Array(routeCount);
  const lineLenM = (l: number): number => {
    const a = lines.start[l]!;
    const b = lines.start[l + 1]!;
    const len = lineLengths(lines.points.subarray(3 * a, 3 * b), R);
    return len[len.length - 1]!;
  };
  for (let r = 0; r < routeCount; r++) {
    let sum = 0;
    for (const step of travel[r]!) {
      const tl = trunkLines[step.trunk]!;
      const seq = step.forward ? tl : [...tl].reverse();
      for (const l of seq) {
        lineOf.push(l);
        sum += lineLenM(l);
      }
    }
    lineStart.push(lineOf.length);
    lengthM[r] = sum;
  }
  const spanCount = deckEnd - roadEnd;
  const span = { route: new Uint16Array(spanCount), deck: new Uint32Array(spanCount), river: new Uint32Array(spanCount), ends: new Float32Array(8 * spanCount), widthM: new Float32Array(spanCount) };
  for (let i = 0; i < spanCount; i++) {
    const l = roadEnd + i;
    span.route[i] = lines.owner[l]!;
    span.deck[i] = l;
    span.river[i] = deckRiver.get(l)!;
    // The deck runs along the trunk as its first route travels it: its first end is the one nearer to a.
    for (const [k, node] of [lines.from[l]!, lines.to[l]!].entries()) {
      for (let c = 0; c < 4; c++) span.ends[8 * i + 4 * k + c] = lines.nodes[4 * node + c]!;
    }
    span.widthM[i] = 2 * ROAD.halfM;
  }
  const routes: RouteTable = {
    count: routeCount,
    a: Uint16Array.from(routeA),
    b: Uint16Array.from(routeB),
    lengthM,
    lineStart: Uint32Array.from(lineStart),
    lineOf: Uint32Array.from(lineOf),
    spans: span,
  };

  // The index of all lines: the lines of stages 1–3 with exactly the reach they had there, roads and decks their own.
  const lineCount = lines.owner.length;
  const nodeWidest = new Float64Array(lines.nodes.length / 4);
  const widest = new Float64Array(lineCount);
  const widen = (from0: number, to0: number): void => {
    for (let l = from0; l < to0; l++) {
      const a = lines.start[l]!;
      const b = lines.start[l + 1]!;
      for (let p = a; p < b; p++) widest[l] = Math.max(widest[l]!, lines.halfWidth[p]!);
      if (lines.from[l]! >= 0) nodeWidest[lines.from[l]!] = Math.max(nodeWidest[lines.from[l]!]!, lines.halfWidth[a]!);
      if (lines.to[l]! >= 0) nodeWidest[lines.to[l]!] = Math.max(nodeWidest[lines.to[l]!]!, lines.halfWidth[b - 1]!);
    }
  };
  const reachM = new Float64Array(lineCount);
  const reach = (from0: number, to0: number): void => {
    for (let l = from0; l < to0; l++) {
      const f = lines.from[l]!;
      const t = lines.to[l]!;
      reachM[l] = tileReachM(Math.max(widest[l]!, f >= 0 ? nodeWidest[f]! : 0, t >= 0 ? nodeWidest[t]! : 0));
    }
  };
  widen(0, laneEnd);
  reach(0, laneEnd);
  widen(laneEnd, lineCount);
  reach(laneEnd, roadEnd);
  for (let l = roadEnd; l < deckEnd; l++) reachM[l] = tileReachM(ROAD.halfM);
  const tiles = planLineTiles({ level: view.tiles.level, radiusM: R, start: lines.start, points: lines.points, reachM }, view.tiles);
  return { routes, lines, tiles, lone };
}

/** Bearing in turns (0 = east, 0.25 = north) of a local point. */
function turnsOf(z: number, x: number): number {
  const t = detAtan2(z, x) / RAD_PER_TURN;
  return t < 0 ? t + 1 : t;
}

// --- Points along routes and lines -----------------------------------------------------------------------------------

/** Per plan, derived once: lengths of lines and the direction each route runs them. */
interface Along {
  lineLen: Map<number, Float64Array>;
  routes: { lines: number[]; forward: boolean[]; cum: Float64Array }[];
}
const alongOf = new WeakMap<WorldPlan, Along>();

function alongFor(plan: WorldPlan): Along {
  let a = alongOf.get(plan);
  if (a) return a;
  a = { lineLen: new Map(), routes: [] };
  alongOf.set(plan, a);
  const rt = plan.routes;
  if (!rt) return a;
  const L = plan.lines;
  const end = (l: number, last: boolean): Vec3 => {
    const k = last ? L.start[l + 1]! - 1 : L.start[l]!;
    return [L.points[3 * k]!, L.points[3 * k + 1]!, L.points[3 * k + 2]!];
  };
  const d2 = (p: Vec3, q: Vec3): number => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  for (let r = 0; r < rt.count; r++) {
    const lines = Array.from(rt.lineOf.subarray(rt.lineStart[r]!, rt.lineStart[r + 1]!));
    const forward: boolean[] = [];
    const cum = new Float64Array(lines.length + 1);
    // The first line runs away from site a; each next one from the end the previous one left at.
    const s = rt.a[r]!;
    let here: Vec3 = [plan.sites!.dir[3 * s]!, plan.sites!.dir[3 * s + 1]!, plan.sites!.dir[3 * s + 2]!];
    lines.forEach((l, i) => {
      const fw = d2(here, end(l, false)) <= d2(here, end(l, true));
      forward.push(fw);
      here = end(l, fw);
      const len = lengthsOf(plan, a!, l);
      cum[i + 1] = cum[i]! + len[len.length - 1]!;
    });
    a.routes.push({ lines, forward, cum });
  }
  return a;
}

function lengthsOf(plan: WorldPlan, a: Along, line: number): Float64Array {
  let len = a.lineLen.get(line);
  if (!len) {
    const L = plan.lines;
    len = lineLengths(L.points.subarray(3 * L.start[line]!, 3 * L.start[line + 1]!), plan.grid.radiusM);
    a.lineLen.set(line, len);
  }
  return len;
}

/**
 * Length of plan line `line` as `lanePoint` measures it, metres. Unlike `lineLengthM` (plan-lines.ts), which knows only
 * the carved kinds, it holds for decks too.
 */
export function laneLengthM(plan: WorldPlan, line: number): number {
  const len = lengthsOf(plan, alongFor(plan), line);
  return len[len.length - 1]!;
}

/** A point of plan line `line` at `alongM` from its first point (clamped): direction, grade, heading. */
function linePoint(plan: WorldPlan, line: number, alongM: number, forward: boolean): { dir: Vec3; heightM: number; heading: Vec3 } {
  const L = plan.lines;
  const a = alongFor(plan);
  const len = lengthsOf(plan, a, line);
  const p0 = L.start[line]!;
  const pts = L.points.subarray(3 * p0, 3 * L.start[line + 1]!);
  const total = len[len.length - 1]!;
  const s = Math.min(total, Math.max(0, forward ? alongM : total - alongM));
  const out = { dir: [0, 0, 0] as Vec3, heading: [0, 0, 0] as Vec3 };
  lineAt(pts, len, s, out);
  // The grade, linear in metres along the piece that holds s.
  let i = 0;
  while (i + 2 < len.length && len[i + 1]! <= s) i++;
  const j = Math.min(len.length - 1, i + 1);
  const span = len[j]! - len[i]!;
  const t = span > 0 ? (s - len[i]!) / span : 0;
  const heightM = L.grade[p0 + i]! + (L.grade[p0 + j]! - L.grade[p0 + i]!) * t;
  if (!forward) {
    out.heading[0] = -out.heading[0];
    out.heading[1] = -out.heading[1];
    out.heading[2] = -out.heading[2];
  }
  return { dir: out.dir, heightM, heading: out.heading };
}

/** The point of route `route` at `alongM` metres from the gate of its site a (clamped to the route). */
export function routePoint(plan: WorldPlan, route: number, alongM: number): { dir: Vec3; heightM: number; heading: Vec3 } {
  const r = alongFor(plan).routes[route];
  if (!r || r.lines.length === 0) throw new Error(`routePoint: the plan has no route ${route}`);
  const total = r.cum[r.lines.length]!;
  const s = Math.min(total, Math.max(0, alongM));
  let i = 0;
  while (i + 1 < r.lines.length && r.cum[i + 1]! <= s) i++;
  return linePoint(plan, r.lines[i]!, s - r.cum[i]!, r.forward[i]!);
}

/** The point of plan line `line` (a lane, road or deck) at `alongM` metres from its first point (clamped). */
export function lanePoint(plan: WorldPlan, line: number, alongM: number): { dir: Vec3; heightM: number; heading: Vec3 } {
  if (!(line >= 0 && line < plan.lines.owner.length)) throw new Error(`lanePoint: the plan has no line ${line}`);
  return linePoint(plan, line, alongM, true);
}

/** What the roads of a plan are: counts, lone sites, length, the steepest grade, deck clearance and span, deepest cut. */
export interface RouteStats {
  routes: number;
  lines: number;
  spans: number;
  lone: number[];
  lengthKm: number;
  maxGrade: number;
  minClearM: number;
  maxSpanM: number;
  maxCutM: number;
}

/** Statistics of the roads of a plan (stage ≥ 4); measured from its bytes. */
export function routeStats(plan: WorldPlan): RouteStats {
  const rt = plan.routes;
  const S = plan.sites;
  if (!rt || !S) return { routes: 0, lines: 0, spans: 0, lone: [], lengthKm: 0, maxGrade: 0, minClearM: 0, maxSpanM: 0, maxCutM: 0 };
  const L = plan.lines;
  const R = plan.grid.radiusM;
  const a = alongFor(plan);
  const k0 = L.kindStart[LINE_KIND.road]!;
  const k1 = L.kindStart[LINE_KIND.deck + 1]!;
  const joined = new Uint8Array(S.count);
  for (let r = 0; r < rt.count; r++) {
    joined[rt.a[r]!] = 1;
    joined[rt.b[r]!] = 1;
  }
  const lone: number[] = [];
  for (let s = 0; s < S.count; s++) if (!joined[s]) lone.push(s);
  const scope: Scope = planScope(plan, STAGE.sites, null);
  let lengthM = 0;
  let maxGrade = 0;
  let maxCutM = 0;
  for (let l = k0; l < k1; l++) {
    const len = lengthsOf(plan, a, l);
    lengthM += len[len.length - 1]!;
    const p0 = L.start[l]!;
    for (let i = 0; i + 1 < len.length; i++) {
      const ds = len[i + 1]! - len[i]!;
      if (ds > 0) maxGrade = Math.max(maxGrade, Math.abs(L.grade[p0 + i + 1]! - L.grade[p0 + i]!) / ds);
    }
    if (l < L.kindStart[LINE_KIND.deck]!) {
      for (let i = 0; i < len.length; i++) {
        const p = p0 + i;
        const own = planGround(scope, L.points[3 * p]! * R, L.points[3 * p + 1]! * R, L.points[3 * p + 2]! * R);
        maxCutM = Math.max(maxCutM, own - L.grade[p]!);
      }
    }
  }
  let minClearM = Infinity;
  let maxSpanM = 0;
  const n = rt.spans.deck.length;
  for (let i = 0; i < n; i++) {
    const e = rt.spans.ends;
    const d0: Vec3 = [e[8 * i]!, e[8 * i + 1]!, e[8 * i + 2]!];
    const d1: Vec3 = [e[8 * i + 4]!, e[8 * i + 5]!, e[8 * i + 6]!];
    const h0 = e[8 * i + 3]!;
    const h1 = e[8 * i + 7]!;
    const len = lengthsOf(plan, a, rt.spans.deck[i]!);
    maxSpanM = Math.max(maxSpanM, len[len.length - 1]!);
    const steps = Math.max(2, Math.ceil(len[len.length - 1]! / DECK_SAMPLE_M));
    for (let j = 0; j <= steps; j++) {
      const u = j / steps;
      const x = d0[0] + (d1[0] - d0[0]) * u;
      const y = d0[1] + (d1[1] - d0[1]) * u;
      const z = d0[2] + (d1[2] - d0[2]) * u;
      const l = Math.sqrt(x * x + y * y + z * z);
      const w = planWater(scope, (x / l) * R, (y / l) * R, (z / l) * R);
      if (w.kind !== 0) minClearM = Math.min(minClearM, h0 + (h1 - h0) * u - w.levelM);
    }
  }
  return {
    routes: rt.count,
    lines: k1 - k0,
    spans: n,
    lone,
    lengthKm: lengthM / 1000,
    maxGrade,
    minClearM: minClearM === Infinity ? 0 : minClearM,
    maxSpanM,
    maxCutM,
  };
}
