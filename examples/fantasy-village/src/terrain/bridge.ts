// The stone bridge over the river on the south street (owner: terrain, B2/B3): one segmental arch of dressed
// voussoirs, rough coursed spandrel walls, a string course, parapets with coping and pillars, a cobbled deck that
// carries the street across, and lanterns on the four end pillars.
//
// Frame (common.ts bridgeFrame): s along the deck (local +z, toward the bridge's yaw), t across (local +x). The arch
// springs just under the water level at s = ±half and rises to its intrados crown 0.95 m under the deck middle.
//
//   arch        ~15 voussoirs per face, alternately deeper and shallower, a taller keystone; they stand 8 cm proud of
//               the wall face. Between the faces the barrel vault (soffit) is laid in staggered courses
//   spandrels   pillowed rough blocks in courses 0.5–0.65 m high, clipped to the arch below and the deck slope above,
//               running down into the banks at both ends
//   string      a thin projecting course under the parapet, following the deck's hump
//   parapets    blocks along both edges, pitched with the deck, with a coping on top; pillars at both ends and over
//               both springs, with caps
//   deck        a mortar bed and cobbles on it, continuing the street's paving (paving.ts leaves the deck to us)
//   lanterns    iron lanterns with glowing glass on the four end pillars, and two evening lights

import {
  MAT,
  GLOW,
  MeshBuilder,
  PALETTE,
  bakeAo,
  bevelBox,
  compose34,
  groundAo,
  hex,
  mixRgb,
  scaleRgb,
  vary,
  VARY_RICH,
  VARY_SUBTLE,
} from "../kit/index.ts";
import type {
  ContentModule,
  PointLight,
  SolidDef,
  RGB,
  Vec2,
  Vec3,
} from "../kit/index.ts";
import {
  bridgeFrame,
  cachedGround,
  cobble,
  pillowBlock,
  settOutline,
} from "./common.ts";

const STONE = hex("#9a8f8a");
const STONE_WARM = hex("#a8967e");
const VOUSSOIR = hex("#b0a08a");
const MORTAR = hex("#5e5046");

/** A six-faced block from 8 corners (bottom 4, then top 4 in the same order), flat shaded, faces outward. */
function hexa(b: MeshBuilder, c: readonly Vec3[], color: RGB, ao = 1): void {
  const cx = c.reduce((a, p) => a + p[0], 0) / 8,
    cy = c.reduce((a, p) => a + p[1], 0) / 8,
    cz = c.reduce((a, p) => a + p[2], 0) / 8;
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  for (const f of faces) {
    let pts = f.map((i) => c[i]!);
    // Newell normal.
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let i = 0; i < 4; i++) {
      const p = pts[i]!,
        q = pts[(i + 1) % 4]!;
      nx += (p[1] - q[1]) * (p[2] + q[2]);
      ny += (p[2] - q[2]) * (p[0] + q[0]);
      nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    const fx = pts.reduce((a, p) => a + p[0], 0) / 4 - cx,
      fy = pts.reduce((a, p) => a + p[1], 0) / 4 - cy,
      fz = pts.reduce((a, p) => a + p[2], 0) / 4 - cz;
    if (nx * fx + ny * fy + nz * fz < 0) {
      pts = [...pts].reverse();
      ((nx = -nx), (ny = -ny), (nz = -nz));
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    const n: Vec3 = [nx / l, ny / l, nz / l];
    const light = n[1] > 0.5 ? 1.1 : n[1] < -0.5 ? 0.62 : 0.94;
    const first = b.vertexCount;
    for (const p of pts)
      b.vertex(p, n, scaleRgb(color, light), n[1] < -0.5 ? ao * 0.7 : ao);
    b.quad(first, first + 1, first + 2, first + 3);
  }
}

export const bridge: ContentModule = {
  name: "bridge",
  build(ctx) {
    const bf = bridgeFrame(ctx);
    const s = ctx.stream("bridge");
    const heightAt = ctx.heightAt;
    const { half, spring, crown, radius: R, centerY } = bf.arch;
    const L2 = bf.halfLength;
    const hw = bf.halfWidth;
    const deckY = bf.deckY;
    const groundAt = (sa: number, t: number): number =>
      heightAt(...bf.world(sa, t));
    const b = new MeshBuilder().set({ cls: MAT.stone });
    const lanternMesh = new MeshBuilder().set({ cls: MAT.metal });
    const stats = { voussoirs: 0, wallBlocks: 0, deckStones: 0 };

    const wallTop = (u: number): number => deckY(u) - 0.12;
    const thSpring = Math.atan2(spring - centerY, half);
    const extra = 0.6;
    /** Extrados height over the arch at s = u (the spandrel's lower edge inside the span). */
    const extrados = (u: number): number =>
      centerY + Math.sqrt(Math.max(0, (R + extra) ** 2 - u * u));
    const pierS = [-(L2 - 0.4), -(half + 0.3), half + 0.3, L2 - 0.4];

    const frame = compose34([bf.x, 0, bf.z], bf.yaw);
    b.with(frame, () => {
      // --- Arch ring and barrel vault --------------------------------------------------------------------------------
      const N = 15;
      for (let k = 0; k < N; k++) {
        const a0 = thSpring + ((Math.PI - 2 * thSpring) * k) / N;
        const a1 = thSpring + ((Math.PI - 2 * thSpring) * (k + 1)) / N;
        const key = k === (N - 1) / 2;
        const depth = key ? 0.85 : k % 2 === 0 ? 0.62 : 0.78;
        const gap = 0.006;
        const ring = (a: number, r: number, t: number): Vec3 => [
          t,
          centerY + Math.sin(a) * r,
          Math.cos(a) * r,
        ];
        // Face voussoirs on both faces, proud of the wall by 8 cm.
        for (const side of [-1, 1]) {
          const tIn = side * (hw - 0.62),
            tOut = side * (hw + 0.08 + (key ? 0.04 : 0));
          const col = vary(
            key ? scaleRgb(VOUSSOIR, 1.06) : VOUSSOIR,
            VARY_RICH,
            s,
            1,
            k,
            side,
          );
          const c: Vec3[] = [
            ring(a0 + gap, R, tIn),
            ring(a1 - gap, R, tIn),
            ring(a1 - gap, R, tOut),
            ring(a0 + gap, R, tOut),
            ring(a0 + gap, R + depth, tIn),
            ring(a1 - gap, R + depth, tIn),
            ring(a1 - gap, R + depth, tOut),
            ring(a0 + gap, R + depth, tOut),
          ];
          // A little hand-cut irregularity on the outer corners.
          for (let i = 4; i < 8; i++)
            c[i] = [
              c[i]![0],
              c[i]![1] + s.jitter(0.03, 2, k, side, i),
              c[i]![2] + s.jitter(0.03, 3, k, side, i),
            ];
          hexa(b, c, col);
          stats.voussoirs++;
        }
        // Soffit: courses across between the face rings, staggered.
        const tSpan = 2 * (hw - 0.62);
        const nAcross = 3;
        const shift = (k % 2) * 0.5;
        for (let i = -1; i < nAcross; i++) {
          const ta = Math.max(
            -tSpan / 2,
            -tSpan / 2 + ((i + shift) * tSpan) / nAcross,
          );
          const tb = Math.min(
            tSpan / 2,
            -tSpan / 2 + ((i + 1 + shift) * tSpan) / nAcross,
          );
          if (tb - ta < 0.1) continue;
          const col = vary(
            mixRgb(STONE, PALETTE.stoneDark, 0.25),
            VARY_RICH,
            s,
            4,
            k,
            i,
          );
          hexa(
            b,
            [
              ring(a0 + gap, R + 0.02, ta + 0.01),
              ring(a1 - gap, R + 0.02, ta + 0.01),
              ring(a1 - gap, R + 0.02, tb - 0.01),
              ring(a0 + gap, R + 0.02, tb - 0.01),
              ring(a0, R + 0.5, ta),
              ring(a1, R + 0.5, ta),
              ring(a1, R + 0.5, tb),
              ring(a0, R + 0.5, tb),
            ],
            col,
            0.7,
          );
        }
      }
      // --- Spandrel walls ----------------------------------------------------------------------------------------------
      for (const side of [-1, 1]) {
        const o: Vec3 = [side * hw, 0, 0];
        const uDir: Vec2 = [0, 1];
        const out: Vec2 = [side, 0];
        const ground = (u: number): number => groundAt(u, side * hw) - 0.6;
        const B = (u: number): number =>
          Math.abs(u) < half
            ? extrados(u)
            : Math.min(ground(u), Math.abs(u) < half + 1.2 ? spring : Infinity);
        let lowest = Infinity;
        for (let u = -L2; u <= L2; u += 0.5) lowest = Math.min(lowest, B(u));
        let y0 = lowest;
        for (let c = 0; y0 < deckY(0); c++) {
          const h = s.range(0.5, 0.65, 10, c, side);
          const y1 = y0 + h;
          let u = -L2 + (c % 2 === 0 ? 0 : -s.range(0.3, 0.6, 11, c, side));
          for (let i = 0; u < L2; i++) {
            const len = s.range(0.8, 1.4, 12, c, i, side);
            const u0 = Math.max(-L2, u),
              u1 = Math.min(L2, u + len);
            u += len;
            if (u1 - u0 < 0.2) continue;
            const yb = y0,
              yt = y1;
            const col = vary(
              mixRgb(STONE, STONE_WARM, s.float(13, c, i, side)),
              VARY_RICH,
              s,
              14,
              c,
              i,
              side,
            );
            const ok = pillowBlock(
              b,
              o,
              uDir,
              out,
              u0 + 0.025,
              u1 - 0.025,
              (uu) => Math.max(yb + 0.02, B(uu)),
              (uu) => Math.min(yt - 0.02, wallTop(uu)),
              0.5,
              s.range(0.03, 0.07, 15, c, i, side),
              col,
            );
            if (ok) stats.wallBlocks++;
          }
          y0 = y1;
        }
      }
      // --- Deck: mortar bed, cobbles ----------------------------------------------------------------------------------
      {
        const tIn = hw - 0.4;
        const rows: number[][] = [];
        const n = Math.ceil((2 * L2) / 0.5);
        for (let j = 0; j <= n; j++) {
          const u = -L2 + (2 * L2 * j) / n;
          const line: number[] = [];
          for (const t of [-hw + 0.02, -tIn, 0, tIn, hw - 0.02])
            line.push(
              b.vertex(
                [t, deckY(u) - 0.02, u],
                [0, 1, 0],
                vary(MORTAR, VARY_SUBTLE, s, 20, j, Math.round(t * 10)),
                0.8,
              ),
            );
          rows.push(line);
        }
        // Local +x across, +z along: (j, i) → (j + 1, i) → (j + 1, i + 1) winds counter-clockwise seen from above.
        for (let j = 0; j < n; j++)
          for (let i = 0; i < 4; i++)
            b.quad(
              rows[j]![i]!,
              rows[j + 1]![i]!,
              rows[j + 1]![i + 1]!,
              rows[j]![i + 1]!,
            );
        const deckH = (_x: number, z: number): number => deckY(z);
        let u = -L2 + 0.05;
        for (let row = 0; u < L2 - 0.1; row++) {
          const len = s.range(0.42, 0.58, 21, row);
          const ua = u,
            ub = Math.min(L2 - 0.05, u + len);
          u = ub;
          let v = -tIn - s.range(0, 0.3, 22, row);
          for (let k = 0; v < tIn; k++) {
            const w = s.range(0.42, 0.66, 23, row, k);
            const va = Math.max(v, -tIn),
              vb = Math.min(v + w, tIn);
            v += w;
            if (vb - va < 0.2) continue;
            const outline = settOutline(
              ua + 0.03,
              ub - 0.03,
              va + 0.03,
              vb - 0.03,
              s,
              [row, k],
              (uu, vv) => [vv, uu],
            );
            const col = vary(
              mixRgb(PALETTE.cobble, STONE, s.float(24, row, k)),
              VARY_RICH,
              s,
              25,
              row,
              k,
            );
            cobble(
              b,
              outline,
              deckH,
              s.range(0.06, 0.1, 26, row, k),
              0.02,
              col,
              [s.jitter(0.03, 27, row, k), s.jitter(0.03, 28, row, k)],
            );
            stats.deckStones++;
          }
        }
      }
      // --- String course, parapets, coping, pillars ---------------------------------------------------------------------
      const stepU = 0.6;
      for (const side of [-1, 1]) {
        const tOuter = side * (hw + 0.07),
          tInner = side * (hw - 0.45);
        // String course: segments following the hump.
        for (let u = -L2; u < L2 - 1e-6; u += stepU) {
          const ua = u,
            ub = Math.min(L2, u + stepU);
          const col = vary(
            STONE_WARM,
            VARY_SUBTLE,
            s,
            30,
            Math.round(u * 10),
            side,
          );
          hexa(
            b,
            [
              [tInner, wallTop(ua), ua],
              [tOuter, wallTop(ua), ua],
              [tOuter, wallTop(ub), ub],
              [tInner, wallTop(ub), ub],
              [tInner, wallTop(ua) + 0.16, ua],
              [tOuter, wallTop(ua) + 0.16, ua],
              [tOuter, wallTop(ub) + 0.16, ub],
              [tInner, wallTop(ub) + 0.16, ub],
            ],
            col,
          );
        }
        // Parapet blocks between the pillars.
        const pt = [side * (hw - 0.4), side * (hw - 0.02)];
        for (let p = 0; p < pierS.length - 1; p++) {
          const sa = pierS[p]! + 0.3,
            sb = pierS[p + 1]! - 0.3;
          let u = sa;
          for (let i = 0; u < sb - 0.05; i++) {
            const len = s.range(0.7, 1.1, 31, p, i, side);
            const ua = u,
              ub = Math.min(sb, u + len);
            u = ub;
            const g = 0.015;
            const yb = (x: number): number => wallTop(x) + 0.16;
            const yt = (x: number): number => deckY(x) + 0.62;
            const col = vary(
              mixRgb(STONE, STONE_WARM, s.float(32, p, i, side)),
              VARY_RICH,
              s,
              33,
              p,
              i,
              side,
            );
            hexa(
              b,
              [
                [pt[0]!, yb(ua + g), ua + g],
                [pt[1]!, yb(ua + g), ua + g],
                [pt[1]!, yb(ub - g), ub - g],
                [pt[0]!, yb(ub - g), ub - g],
                [pt[0]!, yt(ua + g), ua + g],
                [pt[1]!, yt(ua + g), ua + g],
                [pt[1]!, yt(ub - g), ub - g],
                [pt[0]!, yt(ub - g), ub - g],
              ],
              col,
            );
            // Coping, slightly wider.
            const cc = vary(
              scaleRgb(STONE_WARM, 1.08),
              VARY_SUBTLE,
              s,
              34,
              p,
              i,
              side,
            );
            const c0 = side * (hw - 0.46),
              c1 = side * (hw + 0.05);
            hexa(
              b,
              [
                [c0, yt(ua + g), ua + g],
                [c1, yt(ua + g), ua + g],
                [c1, yt(ub - g), ub - g],
                [c0, yt(ub - g), ub - g],
                [c0, yt(ua + g) + 0.12, ua + g],
                [c1, yt(ua + g) + 0.12, ua + g],
                [c1, yt(ub - g) + 0.12, ub - g],
                [c0, yt(ub - g) + 0.12, ub - g],
              ],
              cc,
            );
          }
        }
        // Pillars.
        for (const [pi, ps] of pierS.entries()) {
          const tc = side * (hw - 0.2);
          const yb = Math.min(wallTop(ps - 0.3), wallTop(ps + 0.3));
          const top = deckY(ps) + 0.98;
          const col = vary(STONE_WARM, VARY_RICH, s, 40, pi, side);
          bevelBox(b, [tc, yb, ps], [0.62, top - yb, 0.62], col, {
            bevel: 0.05,
            noBottom: true,
          });
          bevelBox(b, [tc, top, ps], [0.76, 0.14, 0.76], scaleRgb(col, 1.08), {
            bevel: 0.04,
          });
          bevelBox(
            b,
            [tc, top + 0.14, ps],
            [0.56, 0.1, 0.56],
            scaleRgb(col, 1.02),
            { bevel: 0.04, taper: [0.7, 0.7] },
          );
          // Lanterns on the end pillars.
          if (pi === 0 || pi === pierS.length - 1) {
            const y = top + 0.24;
            const lm = lanternMesh;
            // The lantern mesh is its own builder: give it the bridge's frame too.
            lm.with(frame, () => {
              lm.set({ cls: MAT.metal, glow: 0 });
              bevelBox(lm, [tc, y, ps], [0.34, 0.05, 0.34], PALETTE.iron, {
                bevel: 0.015,
              });
              for (const [dx, dz] of [
                [-1, -1],
                [1, -1],
                [1, 1],
                [-1, 1],
              ] as const)
                bevelBox(
                  lm,
                  [tc + dx * 0.14, y + 0.05, ps + dz * 0.14],
                  [0.04, 0.42, 0.04],
                  PALETTE.iron,
                  { bevel: 0.01 },
                );
              lm.set({ cls: MAT.glass, glow: 1, channel: GLOW.evening });
              bevelBox(
                lm,
                [tc, y + 0.06, ps],
                [0.24, 0.38, 0.24],
                PALETTE.windowGlow,
                { bevel: 0.02 },
              );
              lm.set({ cls: MAT.metal, glow: 0 });
              bevelBox(
                lm,
                [tc, y + 0.47, ps],
                [0.42, 0.06, 0.42],
                PALETTE.iron,
                { bevel: 0.015 },
              );
              bevelBox(
                lm,
                [tc, y + 0.53, ps],
                [0.4, 0.2, 0.4],
                PALETTE.ironLight,
                { bevel: 0.02, taper: [0.15, 0.15] },
              );
              bevelBox(
                lm,
                [tc, y + 0.73, ps],
                [0.06, 0.08, 0.06],
                PALETTE.iron,
                { bevel: 0.01 },
              );
            });
          }
        }
      }
    });
    const aoGround = cachedGround(ctx);
    bakeAo(b, { ground: aoGround, rays: 10, reach: 1.6 });
    groundAo(b, aoGround, 0.8, 0.4);

    // Two evening lights, one between the lanterns at each end.
    const lights: PointLight[] = [];
    for (const ps of [pierS[0]!, pierS[pierS.length - 1]!]) {
      const [x, z] = bf.world(ps, 0);
      lights.push({
        position: [x, deckY(ps) + 1.5, z],
        color: PALETTE.windowGlow,
        radius: 9,
        intensity: 1,
        when: "evening",
        flicker: 0.15,
      });
    }

    // Walk mode: the deck as standable slabs following the hump (0.3 m along the axis, each topped by the higher of its
    // two ends), the parapets as walls on both edges. The river limit leaves the bridge's corridor open (water.ts).
    const solids: SolidDef[] = [];
    const quad = (s0: number, s1: number, t0: number, t1: number): number[] => [
      ...bf.world(s0, t0),
      ...bf.world(s1, t0),
      ...bf.world(s1, t1),
      ...bf.world(s0, t1),
    ];
    const SLAB = 0.3;
    for (let u = -L2; u < L2 - 1e-6; u += SLAB) {
      const u1 = Math.min(L2, u + SLAB);
      const top = Math.max(deckY(u), deckY(u1));
      solids.push({ shape: "prism", outline: quad(u, u1, -hw, hw), minY: top - 0.6, maxY: top, label: "bridge-deck", standable: true });
    }
    for (const side of [-1, 1]) {
      const pa = -(L2 - 0.1), pb = L2 - 0.1;
      const top = Math.max(deckY(0), deckY(pa), deckY(pb)) + 0.75;
      solids.push({ shape: "prism", outline: quad(pa, pb, side * (hw - 0.45), side * (hw + 0.07)), minY: Math.min(deckY(pa), deckY(pb)) - 1.5, maxY: top, label: "bridge-parapet", standable: false });
    }

    return {
      solids,
      statics: [
        { material: "solid", mesh: b, name: "bridge" },
        {
          material: "solid",
          mesh: lanternMesh,
          name: "bridge-lanterns",
          castShadow: false,
        },
      ],
      lights,
      stats: {
        ...stats,
        span: Math.round(half * 20) / 10,
        crown: Math.round(crown * 100) / 100,
      },
    };
  },
};
