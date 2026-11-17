// Building mesh: walls extruded from the terrain, a roof by tier, a parapet on flat roofs, and with a façade recipe
// (structure/facade.ts) entrances with steps and canopies, balconies, a cornice, chimneys and roof superstructures as
// geometry. It sits in the module root because it joins the three subfolders: the parts and the plan come from
// structure, the interior plan from interior, the description and the damaged drawing from damage.

import { hashInts, insetRing, ringsArea, unit } from '../gen-core/index.ts';
import type { Ring } from '../gen-core/index.ts';
import type { PropBox } from '../gen-mesh/index.ts';
import type { MeshData, StructureDesc } from '../base/index.ts';
import { buildRoof, chimneyBoxes, edgeSplits, footprintIndex, materialCode, placeEntrances, roofUnits, wallAttr } from './structure/buildings.ts';
import type { BuildingMeshStats, BuildingSpec, Edge, PlannedBox, PlannedCanopy, StructureOptions, StructurePlan } from './structure/buildings.ts';
import { FACADE_DIM, partyShare, wallBoxCorners } from './structure/facade.ts';
import type { ArchMeshDims } from './structure/dims.ts';
import { BUILDING_LAYOUT, KIND, NO_WALL_ATTR, VertexWriter, boxInside, pushBox, wallBox } from './structure/writer.ts';
import type { VertexMaterial, WallAttr } from './structure/writer.ts';
import { canopyKey, partGone } from './structure/parts.ts';
import type { InteriorPlan } from './interior/interior-plan.ts';
import { describeStructure, emitDamaged, interiorPlan } from './damage/damaged.ts';

/**
 * Builds one mesh for all buildings. `groundAt` returns the terrain height; it gives the height above ground
 * (darkening at the wall foot), places steps and checks that walls reach into the ground.
 */
export function buildBuildingMesh(
  specs: BuildingSpec[],
  props: PropBox[],
  groundAt: (x: number, z: number) => number,
  dims: ArchMeshDims,
  options: StructureOptions = {},
): { mesh: MeshData; stats: BuildingMeshStats; anchored: PropBox[]; structures: StructureDesc[]; spans: Uint32Array; interiors: Map<number, InteriorPlan> } {
  const w = new VertexWriter();
  /** First vertex of every structure in the mesh; the last entry is the vertex count. */
  const spans = new Uint32Array(specs.length + 1);
  const structures: StructureDesc[] = [];
  const interiors = new Map<number, InteriorPlan>();
  const stats: BuildingMeshStats = {
    buildings: specs.length,
    tier1: 0,
    tier2: 0,
    tier3: 0,
    roofFallbacks: 0,
    parapets: 0,
    roofUnits: 0,
    roofBoxes: 0,
    roofBoxesDropped: 0,
    roofBoxesLow: 0,
    props: props.length,
    withRecipe: 0,
    entrances: 0,
    entrancesDropped: 0,
    steps: 0,
    canopies: 0,
    balconies: 0,
    corniceWalls: 0,
    chimneys: 0,
    partyWalls: 0,
    blindWalls: 0,
    trianglesPerBuilding: [],
  };
  /** Boxes that must reach the ground (steps), for the scene check. */
  const anchored: PropBox[] = [];

  if (!options.only) for (const p of props) pushBox(w, p);

  const index = footprintIndex(specs);

  specs.forEach((b, self) => {
    spans[self] = w.count;
    if (options.only && !options.only.has(self)) return;
    const startCount = w.count;
    const state = options.states?.get(b.id);
    const damaged = (state !== undefined && (state.ruin || state.parts.size > 0)) || options.byParts === true;
    const mat: VertexMaterial = { seed: unit(b.hash), bayWidth: b.bayWidth, wallColor: b.wallColor, roofColor: b.roofColor, windowStyle: materialCode(b), trimColor: b.trimColor };
    const { roof, fellBack } = buildRoof(b, dims);
    if (fellBack) stats.roofFallbacks++;
    if (roof.tier === 1) stats.tier1++;
    else if (roof.tier === 2) stats.tier2++;
    else stats.tier3++;
    const flat = roof.tier === 3;
    const baseY = b.groundMin - dims.wallBelowGround;
    const eaveY = roof.eaveY;
    const rec = b.facade;
    // Storeys: from the registry when it gives a sensible storey height, otherwise from the wall height.
    const wallH = Math.max(eaveY - b.groundRef, 1);
    const hinted = b.levelsHint > 0 ? wallH / b.levelsHint : 0;
    const floors = hinted >= dims.floorHeightMin && hinted <= dims.floorHeightMax ? b.levelsHint : Math.max(1, Math.round(wallH / b.floorHeightNominal));
    let floorHeight = wallH / floors;
    let groundFloorH = floorHeight;
    if (rec && rec.groundFloorHeight > 0 && floors > 1) {
      const upper = (wallH - rec.groundFloorHeight) / (floors - 1);
      if (upper >= dims.floorHeightMin - 0.1 && upper <= dims.floorHeightMax) {
        floorHeight = upper;
        groundFloorH = rec.groundFloorHeight;
      }
    } else if (rec && floors === 1) {
      groundFloorH = wallH;
    }
    // Storeys are counted from the eave down, so window rows keep their line under the roof even on a slope.
    const floorBase = eaveY - wallH;

    // Parapet: an inset ring. When the inset fails the roof stays without a parapet.
    let insets: (Ring | null)[] = [];
    let parapet = flat ? b.parapetHeight : 0;
    if (parapet > 0) {
      insets = b.rings.map((r) => insetRing(r, dims.parapetThickness));
      if (insets.some((r) => r === null)) parapet = 0;
      else stats.parapets++;
    }
    const wallTopExtra = parapet;

    // --- Façade analysis: edges, shared walls, blind gables, entrances ----------------------------------
    const edges: Edge[] = [];
    b.rings.forEach((ring, ringIndex) => {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const p = (i + n - 1) % n;
        const ax = ring[i * 2]!;
        const az = ring[i * 2 + 1]!;
        const bx = ring[j * 2]!;
        const bz = ring[j * 2 + 1]!;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-3) continue;
        const dx = (bx - ax) / len;
        const dz = (bz - az) / len;
        const cols = Math.max(1, Math.floor(len / b.bayWidth + 0.5));
        // Convexity of the corners: cross product of the incoming and outgoing directions.
        const px = ring[p * 2]!;
        const pz = ring[p * 2 + 1]!;
        const qx = ring[((j + 1) % n) * 2]!;
        const qz = ring[((j + 1) % n) * 2 + 1]!;
        const crossA = (ax - px) * dz - (az - pz) * dx;
        const crossB = dx * (qz - bz) - dz * (qx - bx);
        const topA = roof.topAt(ax, az);
        const topB = roof.topAt(bx, bz);
        const topM = roof.topAt((ax + bx) / 2, (az + bz) / 2);
        edges.push({
          ring: ringIndex,
          i,
          ax,
          az,
          bx,
          bz,
          len,
          dx,
          dz,
          nx: dz,
          nz: -dx,
          cols,
          colW: len / cols,
          party: false,
          blind: false,
          balconies: false,
          levelTop: Math.abs(topA - eaveY) < 0.05 && Math.abs(topB - eaveY) < 0.05 && Math.abs(topM - eaveY) < 0.05,
          // Rings have positive orientation, so for the outer ring a negative cross product is a convex corner.
          convexA: ringIndex === 0 ? crossA < 0 : crossA > 0,
          convexB: ringIndex === 0 ? crossB < 0 : crossB > 0,
          doors: [],
        });
      }
    });

    const canopies: PlannedCanopy[] = [];
    if (rec && index) {
      stats.withRecipe++;
      const elongated = b.box.halfL > 1.6 * b.box.halfW;
      // Parts of one composition never share or blind a wall because of each other.
      const group = b.group;
      const skip = group ? (i: number): boolean => specs[i]!.group === group : undefined;
      for (const e of edges) {
        e.party = partyShare(index, self, e.ax, e.az, e.bx, e.bz, skip) > FACADE_DIM.partyShare;
        const acrossShortAxis = Math.abs(e.dx * b.box.ux + e.dz * b.box.uz) < 0.4;
        e.blind = e.party || (rec.blindEndWalls > 0 && elongated && acrossShortAxis && e.len < rec.blindEndWalls);
        if (e.party) stats.partyWalls++;
        else if (e.blind) stats.blindWalls++;
      }
      // Members of the same group that stand on others never block the footprint tests of this one.
      const above = group && specs.some((s, i) => i !== self && s.group === group && s.raised) ? (i: number): boolean => specs[i]!.group === group && specs[i]!.raised === true : undefined;
      placeEntrances(rec, edges, b, self, index, groundAt, stats, anchored, w, canopies, damaged ? (k) => !partGone(state, canopyKey(k)) : null, above);
      if (rec.balconies) {
        const bal = rec.balconies;
        for (const e of edges) {
          if (e.blind || e.len < bal.minWallLength || floors < 2) continue;
          if (bal.avoidEntranceWalls && e.doors.length > 0) continue;
          // The whole row of balconies must stand free of neighbours, otherwise the wall gets none.
          const pts = wallBoxCorners(e.ax, e.az, e.dx, e.dz, 0.2, e.len - 0.2, 0.05, bal.depth + 0.1);
          if (index.anyOccupied(pts, self, above)) continue;
          e.balconies = true;
        }
      }
    }

    // --- Attachments: collected first and written after the walls, in this order -------------------------
    const balconies: PlannedBox[] = [];
    const cornices: PlannedBox[] = [];
    const tops: PlannedBox[] = [];
    let chimneys: PlannedBox[] = [];
    if (rec) {
      if (rec.balconies) {
        const bal = rec.balconies;
        for (const e of edges) {
          if (!e.balconies) continue;
          const doorCols = new Set(rec.stairStrip ? e.doors.map((d) => Math.floor(d.u / e.colW)) : []);
          for (let c = 0; c < e.cols; c++) {
            if (!((bal.columnMask >> (c & 3)) & 1) || doorCols.has(c)) continue;
            const bw = Math.min(e.colW * FACADE_DIM.balconyColumnShare, FACADE_DIM.balconyMaxWidth);
            const uc = (c + 0.5) * e.colW;
            const u0 = Math.max(FACADE_DIM.wallEndMargin, uc - bw / 2);
            const u1 = Math.min(e.len - FACADE_DIM.wallEndMargin, uc + bw / 2);
            if (u1 - u0 < 1.2) continue;
            for (let f = 1; f < floors; f++) {
              const y = floorBase + groundFloorH + (f - 1) * floorHeight - FACADE_DIM.balconySlab;
              if (y + FACADE_DIM.balconyParapet + FACADE_DIM.balconySlab > eaveY - 0.3) break;
              balconies.push({ edge: edges.indexOf(e), c, f, k: 0, box: wallBox(e.ax, e.az, e.dx, e.dz, u0, u1, 0, bal.depth, y, FACADE_DIM.balconySlab + FACADE_DIM.balconyParapet, rec.colors.accent, hashInts(b.hash, 900, e.i, c, f)) });
              stats.balconies++;
            }
          }
        }
      }
      if (rec.cornice) {
        const cor = rec.cornice;
        edges.forEach((e, k) => {
          if (e.party || !e.levelTop || e.len < 1.5) return;
          // Small per-edge differences keep overlapping corner pieces from sharing a plane.
          const proj = cor.projection + 0.004 * (k % 3);
          const top = eaveY + wallTopExtra - FACADE_DIM.corniceTopGap - 0.003 * (k % 2);
          const u0 = e.convexA ? -proj : 0;
          const u1 = e.len + (e.convexB ? proj : 0);
          cornices.push({ edge: k, c: 0, f: 0, k: 0, box: wallBox(e.ax, e.az, e.dx, e.dz, u0, u1, -0.05, proj, top - cor.height, cor.height, b.trimColor, hashInts(b.hash, 950, k)) });
          stats.corniceWalls++;
        });
      }
    }
    if (flat) {
      const area = ringsArea(b.rings);
      if (rec && rec.roofBoxes) {
        for (const [k, r] of rec.roofBoxes.entries()) {
          const height = r.topY - eaveY;
          if (height < FACADE_DIM.roofBoxMinHeight) {
            stats.roofBoxesDropped++;
            stats.roofBoxesLow++;
            continue;
          }
          // Shrink a box that touches the parapet; drop it when even the shrunk one does not fit.
          let placed = false;
          for (const s of [1, 0.85, 0.7]) {
            const cand = { cx: r.cx, cz: r.cz, ux: r.ux, uz: r.uz, halfL: r.halfL * s, halfW: r.halfW * s };
            if (!boxInside(cand, b.rings, FACADE_DIM.roofBoxMargin)) continue;
            tops.push({ edge: -1, c: 0, f: 0, k, box: { ...cand, baseY: eaveY, height, slope: 0, color: cand.halfL > 1.5 ? b.wallColor : b.roofUnitColor, hash: hashInts(b.hash, 700, k) } });
            stats.roofBoxes++;
            placed = true;
            break;
          }
          if (!placed) stats.roofBoxesDropped++;
        }
      } else {
        const units = roofUnits(b, dims, eaveY, area);
        units.forEach((u, k) => tops.push({ edge: -1, c: 0, f: 0, k, box: u }));
        stats.roofUnits += units.length;
      }
    } else if (rec && rec.chimneys > 0) {
      chimneys = chimneyBoxes(b, rec, roof);
      stats.chimneys += chimneys.length;
    }

    if (options.describe || damaged || options.interiors) {
      const plan: StructurePlan = {
        b,
        rec,
        roof,
        flat,
        baseY,
        eaveY,
        floors,
        floorHeight,
        groundFloorH,
        floorBase,
        parapet,
        insets,
        wallTopExtra,
        mat,
        edges,
        splits: edges.map((e) => {
          const ts = edgeSplits(e.ax, e.az, e.bx, e.bz, roof.creases);
          for (let k = 0; k + 1 < e.doors.length; k++) ts.push((e.doors[k]!.u + e.doors[k + 1]!.u) / 2 / e.len);
          return ts.sort((p, q) => p - q);
        }),
        attrs: edges.map((e) => (rec ? wallAttr(rec, e, groundFloorH, floorHeight) : null)),
        balconies,
        cornice: rec?.cornice ?? null,
        tops,
        chimneys,
        canopies,
        groundAt,
      };
      if (options.describe) structures.push(describeStructure(plan, options.keepOut?.has(b.id) ?? false));
      if (options.interiors) interiors.set(b.id, interiorPlan(plan));
      if (damaged) {
        emitDamaged(w, plan, state ?? { structure: b.id, ruin: false, parts: new Map() });
        stats.trianglesPerBuilding.push((w.count - startCount) / 3);
        return;
      }
    }

    // --- Walls -------------------------------------------------------------------------------------------
    for (const e of edges) {
      const ts = edgeSplits(e.ax, e.az, e.bx, e.bz, roof.creases);
      // Split between doors, so each wall piece carries at most one door.
      for (let k = 0; k + 1 < e.doors.length; k++) ts.push((e.doors[k]!.u + e.doors[k + 1]!.u) / 2 / e.len);
      ts.sort((p, q) => p - q);
      const base: WallAttr | null = rec ? wallAttr(rec, e, groundFloorH, floorHeight) : null;
      for (let k = 0; k + 1 < ts.length; k++) {
        const t0 = ts[k]!;
        const t1 = ts[k + 1]!;
        if (t1 - t0 < 1e-5) continue;
        const x0 = e.ax + (e.bx - e.ax) * t0;
        const z0 = e.az + (e.bz - e.az) * t0;
        const x1 = e.ax + (e.bx - e.ax) * t1;
        const z1 = e.az + (e.bz - e.az) * t1;
        const top0 = roof.topAt(x0, z0) + wallTopExtra;
        const top1 = roof.topAt(x1, z1) + wallTopExtra;
        const g0 = groundAt(x0, z0);
        const g1 = groundAt(x1, z1);
        const u0 = e.len * t0;
        const u1 = e.len * t1;
        let fa = base ?? NO_WALL_ATTR;
        if (base) {
          const door = e.doors.find((d) => d.u >= u0 - 1e-4 && d.u <= u1 + 1e-4);
          if (door) {
            fa = { ...base, doorU: door.u, doorW: door.width, doorY: door.y, bits: [base.bits[0], base.bits[1] | (door.kind << 4), base.bits[2], base.bits[3]] };
          }
        }
        const v = (x: number, y: number, z: number, u: number, g: number): void =>
          w.push(x, y, z, e.nx, 0, e.nz, KIND.wall, u, e.len, y - floorBase, y - g, mat, floors, floorHeight, fa);
        // Two triangles facing out: (bottom0, top1, bottom1) and (bottom0, top0, top1).
        v(x0, baseY, z0, u0, g0);
        v(x1, top1, z1, u1, g1);
        v(x1, baseY, z1, u1, g1);
        v(x0, baseY, z0, u0, g0);
        v(x0, top0, z0, u0, g0);
        v(x1, top1, z1, u1, g1);
      }

      // Parapet: top face and inner face.
      const inner = parapet > 0 ? insets[e.ring] : null;
      if (inner) {
        const ringLen = inner.length / 2;
        const j = (e.i + 1) % ringLen;
        const top = eaveY + parapet;
        const ix0 = inner[e.i * 2]!;
        const iz0 = inner[e.i * 2 + 1]!;
        const ix1 = inner[j * 2]!;
        const iz1 = inner[j * 2 + 1]!;
        const t = (x: number, y: number, z: number, px: number, py: number, pz: number): void =>
          w.push(x, y, z, px, py, pz, KIND.trim, 0, 0, y - eaveY, 100, mat, floors, floorHeight);
        // Top face, facing up.
        t(e.ax, top, e.az, 0, 1, 0);
        t(ix0, top, iz0, 0, 1, 0);
        t(e.bx, top, e.bz, 0, 1, 0);
        t(e.bx, top, e.bz, 0, 1, 0);
        t(ix0, top, iz0, 0, 1, 0);
        t(ix1, top, iz1, 0, 1, 0);
        // Inner face, facing into the roof.
        t(ix0, top, iz0, -e.nx, 0, -e.nz);
        t(ix0, eaveY, iz0, -e.nx, 0, -e.nz);
        t(ix1, top, iz1, -e.nx, 0, -e.nz);
        t(ix1, top, iz1, -e.nx, 0, -e.nz);
        t(ix0, eaveY, iz0, -e.nx, 0, -e.nz);
        t(ix1, eaveY, iz1, -e.nx, 0, -e.nz);
      }
    }

    // --- Façade geometry (balconies, cornice), roof superstructures and chimneys -------------------------
    for (const p of balconies) pushBox(w, p.box);
    const underside = rec?.cornice?.underside === true;
    for (const p of cornices) pushBox(w, p.box, 0, underside);
    for (const p of tops) pushBox(w, p.box);
    for (const p of chimneys) pushBox(w, p.box);

    // Roof. The normal is flat, from the triangle plane.
    const kind = flat ? KIND.roofFlat : KIND.roofPitched;
    const tr = roof.tris;
    for (let t = 0; t < tr.length; t += 9) {
      const ex = tr[t + 3]! - tr[t]!;
      const ey = tr[t + 4]! - tr[t + 1]!;
      const ez = tr[t + 5]! - tr[t + 2]!;
      const fx = tr[t + 6]! - tr[t]!;
      const fy = tr[t + 7]! - tr[t + 1]!;
      const fz = tr[t + 8]! - tr[t + 2]!;
      let nx = ey * fz - ez * fy;
      let ny = ez * fx - ex * fz;
      let nz = ex * fy - ey * fx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      for (let k = 0; k < 9; k += 3) {
        const x = tr[t + k]!;
        const y = tr[t + k + 1]!;
        const z = tr[t + k + 2]!;
        w.push(x, y, z, nx, ny, nz, kind, 0, 0, y - eaveY, 100, mat, floors, floorHeight);
      }
    }
    stats.trianglesPerBuilding.push((w.count - startCount) / 3);
  });
  stats.trianglesPerBuilding.sort((p, q) => p - q);
  spans[specs.length] = w.count;

  return { mesh: { layout: BUILDING_LAYOUT, vertices: w.bytes(), indices: null, count: w.count }, stats, anchored, structures, spans, interiors };
}
