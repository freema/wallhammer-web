// Yard things: benches of thick slabs, a two-wheeled handcart with spoked wheels and a load, a woodpile of split logs
// with a chopping block and an axe, a ladder, and a washing line with sheets and shirts moving in the wind. Each
// generator builds at the local origin, standing on y = 0, its length along local x unless said otherwise.

import type { MeshBuilder, RGB, Stream, Vec3 } from '../kit/index.ts';
import { MAT, PALETTE, VARY_RICH, VARY_SUBTLE, bevelBox, compose34, crookedBeam, lathe, mixRgb, scaleRgb, sweep, vary, varyNext } from '../kit/index.ts';
import { PROP, ironColor, lightWoodColor, rope, sagLine, woodColor } from './common.ts';
import { barrel, crate, sack } from './containers.ts';

// --- Bench -------------------------------------------------------------------------------------------------------------

/** A rustic bench: a thick slab seat on splayed legs, sometimes with a backrest; seat along x, front +z. */
export function bench(b: MeshBuilder, s: Stream, back: boolean): void {
  const len = s.nextRange(1.7, 2.1);
  const seatY = 0.46;
  const wood = woodColor(s, 1);
  b.withFlags({ cls: MAT.wood }, () => {
    crookedBeam(b, [-len / 2, seatY, 0], [len / 2, seatY + s.nextJitter(0.03), 0], lightWoodColor(s, 2), { width: 0.4, depth: 0.1, sag: 0.02, twist: 0.04, irregular: 0.08, stream: s, segments: 4 });
    for (const sx of [-1, 1]) {
      const x = sx * (len / 2 - 0.3);
      for (const sz of [-1, 1]) {
        crookedBeam(b, [x + sx * 0.08, -0.05, sz * 0.2], [x, seatY - 0.04, sz * 0.1], scaleRgb(wood, 0.85), { width: 0.1, stream: s, segments: 2, irregular: 0.1 });
      }
      crookedBeam(b, [x, 0.2, -0.14], [x, 0.2, 0.14], scaleRgb(wood, 0.8), { width: 0.07, segments: 2 });
      if (back) crookedBeam(b, [x, seatY - 0.05, -0.17], [x - sx * 0.02, seatY + 0.6, -0.27], scaleRgb(wood, 0.9), { width: 0.09, stream: s, segments: 2 });
    }
    if (back) crookedBeam(b, [-len / 2 + 0.1, seatY + 0.48, -0.25], [len / 2 - 0.1, seatY + 0.5, -0.25], lightWoodColor(s, 3), { width: 0.06, depth: 0.2, sag: 0.02, stream: s, segments: 3, up: [0, 0.3, 1] });
  });
}

// --- Cart --------------------------------------------------------------------------------------------------------------

/** A spoked wheel at the local origin, axle along x. */
function wheel(b: MeshBuilder, s: Stream, r: number, at: Vec3): void {
  const wood = lightWoodColor(s, 1);
  const n = 20;
  const path: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    path.push([at[0], at[1] + Math.cos(a) * (r - 0.05), at[2] + Math.sin(a) * (r - 0.05)]);
  }
  b.withFlags({ cls: MAT.wood }, () => {
    sweep(b, path, [[0.05, 0.045], [-0.05, 0.045], [-0.05, -0.045], [0.05, -0.045]], wood, { faceted: true, closed: true, up: [1, 0, 0] });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.2;
      crookedBeam(b, [at[0], at[1] + Math.cos(a) * 0.09, at[2] + Math.sin(a) * 0.09], [at[0], at[1] + Math.cos(a) * (r - 0.08), at[2] + Math.sin(a) * (r - 0.08)], scaleRgb(wood, 0.9), { width: 0.045, segments: 1 });
    }
  });
  // Iron tyre and hub.
  const iron = ironColor(s, 2);
  const tyre: Vec3[] = path.map((p) => [p[0], at[1] + (p[1] - at[1]) * (r / (r - 0.05)), at[2] + (p[2] - at[2]) * (r / (r - 0.05))]);
  b.withFlags({ cls: MAT.metal }, () => {
    sweep(b, tyre, [[0.012, 0.055], [-0.012, 0.055], [-0.012, -0.055], [0.012, -0.055]], iron, { faceted: true, closed: true, up: [1, 0, 0] });
    b.with(compose34(at, 0, 0, Math.PI / 2), () => lathe(b, [0, -0.1, 0], [[0.07, 0], [0.1, 0.04], [0.1, 0.16], [0.06, 0.2]], iron, { segments: 8, capBottom: true, capTop: true }));
  });
}

/** A handcart: plank bed with sides, two wheels, shafts resting on the ground, loaded with sacks and a crate. */
export function cart(b: MeshBuilder, s: Stream): void {
  const r = 0.55;
  const axleY = r, axleZ = 0.0;
  // Tilt so the shaft ends touch the ground: rotate about the axle.
  const reach = 2.3, shaftY = 0.68;
  const pitch = Math.atan2(shaftY - axleY, reach) + Math.asin(Math.min(0.95, (axleY - 0.06) / Math.hypot(reach, shaftY - axleY)));
  const wood = woodColor(s, 1);
  const T = compose34([0, axleY, axleZ], 0, pitch);
  b.with(T, () => {
    // Frame in axle-relative coordinates (y up from the axle).
    b.withFlags({ cls: MAT.wood }, () => {
      for (const sx of [-1, 1]) {
        crookedBeam(b, [sx * 0.42, 0.13, -1.0], [sx * 0.36, shaftY - axleY, reach], scaleRgb(wood, 0.9), { width: 0.1, depth: 0.12, stream: s, segments: 4, wobble: 0.015 });
      }
      crookedBeam(b, [-0.5, 0.13, 0.85], [0.5, 0.13, 0.85], wood, { width: 0.08, segments: 2 });
      crookedBeam(b, [-0.36, shaftY - axleY + 0.02, reach - 0.25], [0.36, shaftY - axleY + 0.02, reach - 0.25], wood, { width: 0.06, segments: 2 });
      // Bed planks along z.
      const planks = 6;
      for (let i = 0; i < planks; i++) {
        const x = -0.5 + (1.0 * (i + 0.5)) / planks;
        bevelBox(b, [x, 0.19, -0.1], [1.0 / planks - 0.015, 0.05, 1.95], varyNext(PALETTE.plank, VARY_RICH, s), { bevel: 0.012, anchor: 'center', jitter: 0.008, stream: s });
      }
      // Sides and back board.
      for (const sx of [-1, 1]) {
        for (let k = 0; k < 2; k++) bevelBox(b, [sx * 0.52, 0.22 + k * 0.17, -0.1], [0.04, 0.15, 1.95], lightWoodColor(s, sx, k, 3), { bevel: 0.012, jitter: 0.008, stream: s });
        for (const z of [-1.0, -0.1, 0.8]) crookedBeam(b, [sx * 0.55, 0.16, z], [sx * 0.57, 0.6, z], scaleRgb(wood, 0.85), { width: 0.06, segments: 1 });
      }
      for (let k = 0; k < 2; k++) bevelBox(b, [0, 0.22 + k * 0.17, -1.06], [1.06, 0.15, 0.04], lightWoodColor(s, k, 4), { bevel: 0.012 });
    });
    // Axle and wheels.
    b.withFlags({ cls: MAT.metal }, () => crookedBeam(b, [-0.78, 0, 0], [0.78, 0, 0], PALETTE.iron, { width: 0.06, segments: 2 }));
    for (const sx of [-1, 1]) wheel(b, s.child(sx), r, [sx * 0.68, 0, 0]);
    // The load: sacks and a crate.
    // Two sacks lying across the bed (rolled onto their sides about their middle).
    b.with(compose34([0.0, 0.47, -0.6], 0.15, 0, Math.PI / 2 - 0.1), () => b.with(compose34([0, -0.42, 0]), () => sack(b, s.child('l1'), { height: 0.7 })));
    b.with(compose34([0.05, 0.45, -0.05], -0.2, 0, -Math.PI / 2 + 0.1), () => b.with(compose34([0, -0.4, 0]), () => sack(b, s.child('l2'), { height: 0.66 })));
    b.with(compose34([0.0, 0.22, 0.45], 0.1), () => crate(b, s.child('l3'), { size: [0.62, 0.42, 0.5], open: true, content: 'cabbages' }));
  });
}

// --- Woodpile --------------------------------------------------------------------------------------------------------

/** A stack of split logs along x (ends facing ±z), held by posts at both ends, with a chopping block and an axe. */
export function woodpile(b: MeshBuilder, s: Stream, len = 2.4): void {
  const depth = 0.6;
  const wood = vary(PALETTE.bark, VARY_SUBTLE, s, 1);
  const rows = 5;
  let y = 0.08;
  // Two bearers on the ground.
  b.withFlags({ cls: MAT.wood }, () => {
    for (const z of [-0.18, 0.18]) crookedBeam(b, [-len / 2, 0.04, z], [len / 2, 0.04, z], scaleRgb(PALETTE.timberDark, 0.9), { width: 0.1, segments: 3 });
  });
  for (let r = 0; r < rows; r++) {
    const d = s.range(0.17, 0.22, r, 1);
    const n = Math.floor(len / d);
    for (let i = 0; i < n; i++) {
      const x = -len / 2 + d * (i + 0.5) + (r % 2 ? d * 0.4 : 0) + s.jitter(0.02, r, i, 2);
      if (x > len / 2 - d * 0.3) continue;
      // The top row is uneven: some logs missing.
      if (r === rows - 1 && s.chance(0.35, r, i, 3)) continue;
      const bark = vary(wood, VARY_RICH, s, r, i, 4);
      const end = mixRgb(PROP.endGrain, PROP.endGrainDark, s.float(r, i, 5) * 0.6);
      const twist = s.range(0, Math.PI, r, i, 6);
      b.withFlags({ cls: MAT.bark }, () =>
        crookedBeam(b, [x, y + d / 2, -depth / 2 + s.jitter(0.05, r, i, 7)], [x + s.jitter(0.03, r, i, 8), y + d / 2, depth / 2 + s.jitter(0.05, r, i, 9)], bark, {
          width: d * s.range(0.85, 1.05, r, i, 10), depth: d * s.range(0.75, 0.95, r, i, 11), chamfer: s.chance(0.5, r, i, 12) ? 0.5 : 0.2, twist, irregular: 0.12, segments: 2, stream: s.child(r * 100 + i), endPaint: end,
        }),
      );
    }
    y += d * 0.92;
  }
  // End posts.
  b.withFlags({ cls: MAT.wood }, () => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) crookedBeam(b, [sx * (len / 2 + 0.08), -0.2, sz * 0.22], [sx * (len / 2 + 0.1), y + 0.15, sz * 0.22], woodColor(s, sx, sz, 13), { width: 0.11, segments: 2, stream: s.child(900 + sx + sz * 3) });
  });
  // Chopping block with an axe, in front of the pile.
  const bx = len / 2 - 0.3, bz = depth / 2 + 0.75;
  b.withFlags({ cls: MAT.bark }, () => {
    lathe(b, [bx, -0.05, bz], [[0.3, 0], [0.27, 0.2], [0.27, 0.55]], (p) => scaleRgb(wood, 0.75 + 0.3 * Math.min(1, (p[1] + 0.05) / 0.6)), { segments: 9, faceted: true, noise: 0.06, stream: s.child(950) });
    lathe(b, [bx, 0.5, bz], [[0.27, 0], [0.0001, 0.01]], PROP.endGrain, { segments: 9 });
  });
  // The axe stuck in the block at an angle.
  const iron = ironColor(s, 14);
  b.with(compose34([bx + 0.05, 0.52, bz], 0.6, 0, 0.5), () => {
    b.withFlags({ cls: MAT.wood }, () => crookedBeam(b, [0, 0.02, 0], [0, 0.72, 0], lightWoodColor(s, 15), { width: 0.045, segments: 2, sag: 0.01 }));
    b.withFlags({ cls: MAT.metal }, () => bevelBox(b, [0.04, -0.06, 0], [0.18, 0.12, 0.035], (p) => (p[0] > 0.1 ? PALETTE.ironLight : iron), { bevel: 0.008, taper: [1.3, 1] }));
  });
  // A few split logs on the ground.
  for (let i = 0; i < 3; i++) {
    const x = bx - 0.6 + s.jitter(0.2, i, 16), z = bz + s.jitter(0.25, i, 17);
    const yaw = s.range(0, Math.PI, i, 18);
    b.withFlags({ cls: MAT.bark }, () => crookedBeam(b, [x - Math.sin(yaw) * 0.28, 0.08, z - Math.cos(yaw) * 0.28], [x + Math.sin(yaw) * 0.28, 0.08, z + Math.cos(yaw) * 0.28], vary(wood, VARY_RICH, s, i, 19), { width: 0.15, depth: 0.12, chamfer: 0.15, segments: 1, endPaint: PROP.endGrain }));
  }
}

// --- Ladder ------------------------------------------------------------------------------------------------------------

/** A ladder of `len` metres leaning toward −z (against a wall), feet at the origin, `lean` from the vertical. */
export function ladder(b: MeshBuilder, s: Stream, len: number, lean: number): void {
  const wood = lightWoodColor(s, 1);
  const top: Vec3 = [0, Math.cos(lean) * len, -Math.sin(lean) * len];
  b.withFlags({ cls: MAT.wood }, () => {
    for (const sx of [-1, 1]) crookedBeam(b, [sx * 0.24, -0.05, 0], [sx * 0.21 + top[0], top[1], top[2]], scaleRgb(wood, 0.9), { width: 0.075, depth: 0.09, wobble: 0.02, stream: s.child(sx), segments: 3 });
    const rungs = Math.floor(len / 0.32);
    for (let k = 1; k < rungs; k++) {
      const f = k / rungs;
      const w = 0.24 - 0.03 * f;
      if (s.chance(0.06, k, 2)) continue; // a missing rung
      crookedBeam(b, [-w - 0.03, top[1] * f, top[2] * f], [w + 0.03, top[1] * f + s.jitter(0.02, k, 3), top[2] * f], vary(wood, VARY_RICH, s, k, 4), { width: 0.045, chamfer: 0.5, segments: 1 });
    }
  });
}

// --- Washing line ----------------------------------------------------------------------------------------------------

/** A washing line between two T-posts `span` metres apart along x, with sheets, shirts and trousers hanging. */
export function washingLine(b: MeshBuilder, s: Stream, span: number): void {
  const wood = woodColor(s, 1);
  const H = 2.05;
  b.withFlags({ cls: MAT.wood }, () => {
    for (const sx of [-1, 1]) {
      const x = (sx * span) / 2;
      crookedBeam(b, [x, -0.35, 0], [x + s.jitter(0.05, sx, 2), H + 0.1, 0], (p) => scaleRgb(wood, 0.7 + 0.3 * Math.min(1, Math.max(0, p[1] / H))), { width: 0.14, wobble: 0.03, stream: s.child(sx), segments: 3 });
      crookedBeam(b, [x, H, -0.4], [x, H + 0.02, 0.4], scaleRgb(wood, 0.9), { width: 0.09, segments: 2 });
    }
  });
  // Two lines, sagging.
  const lines: Vec3[][] = [];
  for (const z of [-0.3, 0.3]) {
    const line = sagLine([-span / 2, H + 0.06, z], [span / 2, H + 0.06, z], 0.22, 14);
    lines.push(line);
    b.withFlags({ cls: MAT.fabric, sway: 0.15 }, () => rope(b, line, 0.012, PROP.rope, 4));
  }
  // The washing: along the front line.
  const along = (line: Vec3[], x: number): Vec3 => {
    const t = (x + span / 2) / span;
    const i = Math.min(line.length - 2, Math.floor(t * (line.length - 1)));
    const f = t * (line.length - 1) - i;
    const a = line[i]!, c = line[i + 1]!;
    return [a[0] + (c[0] - a[0]) * f, a[1] + (c[1] - a[1]) * f, a[2] + (c[2] - a[2]) * f];
  };
  const colours: RGB[] = [PROP.linen, PALETTE.fabricCream, PALETTE.fabricBlue, PALETTE.fabricRed, PROP.linen, PALETTE.fabricGreen, PROP.wool];
  let x = -span / 2 + 0.35;
  let k = 0;
  while (x < span / 2 - 0.5) {
    const kind = s.pick(['sheet', 'shirt', 'trousers', 'sheet', 'cloth'] as const, k, 5);
    const w = kind === 'sheet' ? s.range(1.0, 1.3, k, 6) : kind === 'shirt' ? 0.62 : kind === 'trousers' ? 0.5 : 0.45;
    if (x + w > span / 2 - 0.3) break;
    const line = lines[k % 2 === 0 ? 1 : 0]!;
    const c = vary(s.pick(colours, k, 7), VARY_SUBTLE, s, k, 8);
    garment(b, s.child(k), kind, x, w, (xx) => along(line, xx), c);
    x += w + s.range(0.12, 0.35, k, 9);
    k++;
  }
}

/** One piece of washing hanging from the line between x and x + w (both faces, sway growing downward). */
function garment(b: MeshBuilder, s: Stream, kind: 'sheet' | 'shirt' | 'trousers' | 'cloth', x0: number, w: number, line: (x: number) => Vec3, c: RGB): void {
  const len = kind === 'sheet' ? s.nextRange(1.0, 1.25) : kind === 'shirt' ? 0.75 : kind === 'trousers' ? 0.9 : 0.5;
  // Panels: (x offset, width, length) inside the piece; shirts get sleeves, trousers two legs.
  const panels: [number, number, number, number][] =
    kind === 'shirt' ? [[0.12, w - 0.24, 0, len], [0, 0.14, 0.02, 0.32], [w - 0.14, 0.14, 0.02, 0.32]] :
    kind === 'trousers' ? [[0, w, 0, 0.3], [0, w * 0.46, 0.28, len], [w * 0.54, w * 0.46, 0.28, len]] :
    [[0, w, 0, len]];
  const billow = s.nextRange(0.04, 0.1);
  const flutter = s.nextRange(0, 6);
  b.withFlags({ cls: MAT.fabric }, () => {
    for (const [px, pw, y0, y1] of panels) {
      const cols = Math.max(2, Math.round(pw / 0.18) + 1), rows = Math.max(2, Math.round((y1 - y0) / 0.18) + 1);
      const pos = (i: number, j: number, off: number): Vec3 => {
        const xx = x0 + px + (pw * i) / (cols - 1);
        const top = line(xx);
        const v = y0 + ((y1 - y0) * j) / (rows - 1);
        const bulge = billow * Math.sin(Math.PI * Math.min(1, v / len)) + 0.02 * Math.sin(xx * 9 + flutter + v * 4);
        return [xx, top[1] - 0.02 - v, top[2] + bulge + off];
      };
      for (const side of [0, 1]) {
        const first = b.vertexCount;
        b.grid(cols, rows, (i, j) => pos(i, j, side ? -0.012 : 0), (_i, j) => scaleRgb(c, side ? 0.78 : 1.02 - 0.12 * (j / (rows - 1))), { flip: side === 0 });
        for (let v = first; v < b.vertexCount; v++) {
          const j = Math.floor((v - first) / cols);
          b.flg[v * 4 + 1] = 0.15 + 0.75 * ((y0 + ((y1 - y0) * j) / (rows - 1)) / len);
        }
      }
    }
    // Pegs.
    for (const px of [0.05, w - 0.05]) {
      const p = line(x0 + px);
      bevelBox(b, [p[0], p[1] - 0.06, p[2]], [0.025, 0.1, 0.03], PALETTE.timberLight, { bevel: 0.006 });
    }
  });
}

// --- Clutter -------------------------------------------------------------------------------------------------------------

/** Barrels and crates in a small heap (for corners by doors): `n` pieces in a deterministic arrangement. */
export function clutter(b: MeshBuilder, s: Stream, n: number): void {
  for (let i = 0; i < n; i++) {
    const kind = s.pick(['barrel', 'barrel', 'crate', 'sack', 'crate'] as const, i, 1);
    const a = i * 2.2 + s.range(0, 1, i, 2);
    const r = i === 0 ? 0 : 0.55 + 0.15 * i;
    const x = Math.cos(a) * r * 1.1, z = Math.sin(a) * r * 0.45;
    const yaw = s.range(0, Math.PI * 2, i, 3);
    if (kind === 'barrel') {
      // Now and then one lies on its side.
      if (i > 1 && s.chance(0.3, i, 4)) b.with(compose34([x, 0.34, z], yaw, Math.PI / 2), () => b.with(compose34([0, -0.45, 0]), () => barrel(b, s.child(i))));
      else b.with(compose34([x, 0, z], yaw), () => barrel(b, s.child(i)));
    } else if (kind === 'crate') {
      b.with(compose34([x, 0, z], yaw), () => crate(b, s.child(i), { open: s.chance(0.4, i, 5), content: s.pick(['apples', 'turnips', 'cabbages'] as const, i, 6) }));
    } else {
      b.with(compose34([x, 0, z], yaw, 0, s.jitter(0.15, i, 7)), () => sack(b, s.child(i)));
    }
  }
}

