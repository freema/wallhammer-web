// Buildings: façades with window rows per storey, plinth, cornice, roof covering. The shader draws all of it
// from the position on the wall that the generator wrote into the vertices. Patterns are analytically
// antialiased: once a window is smaller than a pixel the wall turns into its average colour and nothing shimmers.
//
// Two façade paths: the simple one (window style only) and the recipe path (facade.ts), selected per wall by
// the recipe bit. The recipe path adds a ground floor, entrances, window formats, frames, mullions, sills,
// curtains and blinds, stairwell strips, loggia recesses and prefab panel joints.

import { FACADE_DIM, FACADE_FLAG } from './facade.ts';
import { ARCH_WINDOW_BIT, WIN_TALL } from './writer.ts';
import { INTERIOR_DIM } from './dims.ts';
import type { ArchShadeDims } from './dims.ts';

/**
 * Variants of the structure shaders. `framed`: the mesh is in a frame of its own and `uniform mat4 u_frame` (rotation
 * and translation only) takes it into render space; light, shadow, fog and snow work in render space, patterns and
 * damage stay in the frame of the mesh, and "up" is the frame's y axis. `finishes`: wall finishes, roof covers and
 * shutters of the material byte are drawn (`materialCode`). Both off: the texts are those of the plain material.
 */
export interface StructureShaderOptions {
  framed?: boolean;
  finishes?: boolean;
}

export const BUILDING_VS = /* glsl */ `#include <header>
in vec3 a_pos;
in vec4 a_normal;
in vec4 a_surf;
in vec4 a_bld;
in uvec4 a_mat;
in vec4 a_fac;
in uvec4 a_win;
in uvec4 a_bits;
in uvec4 a_col;
out vec3 v_world;
// Rest position and normal: patterns are anchored to them, so they stay on a piece that moves (fallVs).
out vec3 v_pat;
flat out vec3 v_patN;
flat out vec3 v_normal;
flat out int v_kind;
flat out int v_damage;
out vec4 v_surf;
flat out vec4 v_bld;
flat out uvec4 v_mat;
flat out vec4 v_fac;
flat out uvec4 v_win;
flat out uvec4 v_bits;
flat out uvec4 v_col;
void main() {
  vec3 pos = a_pos;
  // Rubble that is still arriving grows up from its base (writer.ts, growIn).
  if (a_fac.y < 0.0) {
    float g = clamp((u_time.x - a_fac.x) / -a_fac.y, 0.0, 1.0);
    pos.y = mix(a_fac.z, a_pos.y, g * g * (3.0 - 2.0 * g));
  }
  v_world = pos;
  v_pat = pos;
  v_patN = normalize(a_normal.xyz);
  v_normal = normalize(a_normal.xyz);
  // Low three bits: kind of surface; above them the damage level (writer.ts, DAMAGE_STEP).
  int kindWord = int(a_normal.w);
  v_kind = kindWord & 7;
  v_damage = kindWord >> 3;
  v_surf = a_surf;
  v_bld = a_bld;
  v_mat = a_mat;
  v_fac = a_fac;
  v_win = a_win;
  v_bits = a_bits;
  v_col = a_col;
  gl_Position = u_viewProj * vec4(pos, 1.0);
}`;

/** Replaces `from` by `to` in `text`, and fails loudly when `from` is not there (the text changed shape). */
function must(text: string, from: string | RegExp, to: string, what: string): string {
  const out = text.replace(from, to);
  if (out === text) throw new Error(`structure shader: ${what} changed shape`);
  return out;
}

/**
 * A vertex stage of the structure shaders turned into its framed form: positions and normals go through `u_frame`
 * into render space, while `v_pat` and `v_patN` (patterns, damage) stay in the frame of the mesh.
 */
export function frameVs(vs: string): string {
  let out = must(vs, 'out vec3 v_world;\n', 'uniform mat4 u_frame; // frame of the mesh → render space\nout vec3 v_world;\n', 'frame uniform');
  out = must(out, '  v_world = pos;\n', '  v_world = (u_frame * vec4(pos, 1.0)).xyz;\n', 'v_world');
  out = must(out, /v_normal = normalize\((.+?)\);/, 'v_normal = normalize(mat3(u_frame) * ($1));', 'v_normal');
  return must(out, 'gl_Position = u_viewProj * vec4(pos, 1.0);', 'gl_Position = u_viewProj * vec4(v_world, 1.0);', 'gl_Position');
}

/** Vertex stage of the structures; `BUILDING_VS` is `buildingVs()`. */
export function buildingVs(o: StructureShaderOptions = {}): string {
  return o.framed ? frameVs(BUILDING_VS) : BUILDING_VS;
}

const f = (v: number): string => v.toFixed(3);

/**
 * Fragment shader of the structures; `dims` sizes are baked in as constants. `damage` adds the damage shading of the
 * vertex damage channel; it is a separate program, so intact structures pay nothing for it. `o` picks the framed and
 * the finishes variant (see `StructureShaderOptions`); without it the text is that of the plain material.
 */
export function buildingFs(dims: ArchShadeDims, damage = false, o: StructureShaderOptions = {}): string {
  const text = plainFs(dims, damage, o.finishes === true);
  return o.framed ? frameFs(text, damage) : text;
}

/** The fragment stage turned into its framed form: every "up" is the y axis of the frame in render space. */
function frameFs(fs: string, damage: boolean): string {
  let out = must(fs, 'uniform ivec4 u_rows; // palette rows: glass, glass with sky reflection, plinth, unused\n', 'uniform ivec4 u_rows; // palette rows: glass, glass with sky reflection, plinth, unused\nuniform mat4 u_frame; // frame of the mesh → render space\n// Up of the frame of the mesh, in render space.\nvec3 frameUp() { return normalize(u_frame[1].xyz); }\n', 'frame uniform');
  out = must(out, 'float s = v_surf.z / max(sqrt(1.0 - n.y * n.y), 0.2);', 'float ny = dot(n, frameUp());\n    float s = v_surf.z / max(sqrt(1.0 - ny * ny), 0.2);', 'roof slope');
  out = must(out, 'if (n.y < 0.5) ao =', 'if (dot(n, frameUp()) < 0.5) ao =', 'side faces');
  if (damage) {
    out = must(out, '  float up = clamp(u_sunDir.y * 4.0, 0.0, 1.0);\n  vec2 s = u_sunDir.xz / max(length(u_sunDir.xz), 1e-3);', '  // The sun in the frame of the mesh, where the room directions are.\n  vec3 sl = transpose(mat3(u_frame)) * u_sunDir.xyz;\n  float up = clamp(sl.y * 4.0, 0.0, 1.0);\n  vec2 s = sl.xz / max(length(sl.xz), 1e-3);', 'room fill');
  }
  return out;
}

/** Finishes of walls and covers of roofs (`materialCode`), only in the `finishes` variant. */
const FINISH_GLSL = (dims: ArchShadeDims): string => /* glsl */ `// Wall finish by the material byte (bits 2–3): 1 timber frame over the render, 2 coursed stone, 3 upright boards.
// gfH, fh: heights of the ground floor and of the storeys above; top: the eave above the floor base.
vec3 finishWall(vec3 col, uint seed, float u, float len, float yRel, float above, float gfH, float fh, float top) {
  int finish = int((v_mat.z >> 2u) & 3u);
  if (finish == 0) return col;
  float fwU = fwidth(u), fwY = fwidth(yRel);
  if (finish == 1) {
    // Posts about every 1.2 m, rails at the storey lines, a diagonal brace in some fields; above the plinth only.
    float plinth = max(float(v_win.w) * 0.02, ${f(dims.plinthHeight)});
    float n = max(1.0, floor(len / 1.2 + 0.5));
    float pw = len / n;
    float cu = u / pw;
    float post = pulseFaded(cu + 0.09 / pw, fwU / pw, 0.0, 0.18 / pw);
    bool low = yRel < gfH;
    float flH = low ? gfH : fh;
    float sl = low ? yRel / gfH : 1.0 + (yRel - gfH) / fh;
    float rail = pulseFaded(sl + 0.08 / flH, fwY / flH, 0.0, 0.16 / flH);
    // The gable above the eave has rails every storey height as well, and its own fields.
    float h = hash2(ivec2(int(floor(cu)), int(floor(sl))), seed + 61u);
    float brace = 0.0;
    if (h < 0.4) {
      float fx = fract(cu), fy = fract(sl);
      float d = h < 0.2 ? fx - fy : fx + fy - 1.0;
      float dm = abs(d) * min(pw, flH) * 0.7071;
      float fw = max(fwU, fwY);
      brace = (1.0 - smoothstep(0.08 - fw, 0.08 + fw, dm)) * detailVisible(0.16);
    }
    float m = max(max(post, rail), brace) * boxCover(above, fwY, plinth, 1.0e4);
    vec3 timber = u_palette[v_mat.w].rgb * (0.85 + 0.12 * hash1(seed + 63u));
    return mix(col, timber, m * 0.95);
  }
  if (finish == 2) {
    // Courses of 0.3 m, stones about 0.55 m long with staggered joints, a tone per stone.
    float cv = yRel / 0.3;
    float row = floor(cv);
    float along = u / 0.55 + 0.5 * row;
    float tone = hash2(ivec2(int(floor(along)), int(row)), seed + 62u);
    col *= 1.0 + 0.24 * (tone - 0.5) * detailVisible(0.3);
    float jh = pulseFaded(cv, fwY / 0.3, 0.0, 0.1);
    float jv = pulseFaded(along, fwU / 0.55, 0.0, 0.055);
    return col * (1.0 - 0.32 * max(jh, jv));
  }
  // Upright boards of 0.18 m with dark joints, a tone per board.
  float cu = u / 0.18;
  float tone = hash2(ivec2(int(floor(cu)), 3), seed + 64u);
  col *= 1.0 + 0.18 * (tone - 0.5) * detailVisible(0.18);
  col *= 0.94 + 0.08 * vnoise(vec2(u * 0.5, yRel * 4.0), seed + 65u) * detailVisible(0.1);
  return col * (1.0 - 0.38 * pulseFaded(cu, fwU / 0.18, 0.0, 0.12));
}

// Cover of a pitched roof by the material byte (bits 4–5): 1 thatch, 2 slate, 3 shingle. s: metres up the slope from
// the eave; across: metres along the eave (in the frame of the mesh).
vec3 coverRoof(vec3 base, uint seed, float s, float across) {
  int cover = int((v_mat.z >> 4u) & 3u);
  float ws = fwidth(s), wa = fwidth(across);
  if (cover == 1) {
    // Soft courses of 0.5 m, strong streaks down the fall line, a darker ragged eave.
    base *= 1.0 - 0.12 * pulseFaded(s / 0.5, ws / 0.5, 0.0, 0.35);
    float streak = vnoise(vec2(across * 7.0, s * 0.35), seed + 66u);
    base *= 1.0 + 0.4 * (streak - 0.5) * detailVisible(0.12);
    base *= 0.93 + 0.14 * vnoise(vec2(across, s) * 0.6, seed + 67u);
    float edge = 0.3 + 0.22 * vnoise(vec2(across * 2.5, 0.5), seed + 68u);
    return base * mix(0.62, 1.0, smoothstep(edge - 0.06 - ws, edge + 0.06 + ws, s));
  }
  float c = cover == 2 ? 0.25 : 0.18;
  float pl = cover == 2 ? 0.4 : 0.22;
  float row = floor(s / c);
  float along = across / pl + 0.5 * row;
  float tone = hash2(ivec2(int(floor(along)), int(row)), seed + 69u);
  float vis = detailVisible(c);
  base *= 1.0 + (cover == 2 ? 0.14 : 0.3) * (tone - 0.5) * vis;
  float jh = pulseFaded(s / c, ws / c, 0.0, 0.14);
  float jv = pulseFaded(along, wa / pl, 0.0, 0.05);
  return base * (1.0 - 0.3 * max(jh, jv));
}

`;

/** Shutter leaves beside a window of the recipe path, only in the `finishes` variant (inside `recipeWall`). */
const SHUTTER_GLSL = /* glsl */ `    if ((v_mat.z & 64u) != 0u && !balconyColumn) {
      // A leaf on each side, 0.45 × the window width, with horizontal slats.
      float sw = 0.45 * (x1 - x0), gap = 0.03 / colW;
      float leaves = (cellBox(fu, fwu, x0 - gap - sw, x0 - gap) + cellBox(fu, fwu, x1 + gap, x1 + gap + sw)) * cellBox(fv, fwv, y0, y1) * inFloors;
      vec3 sc = u_palette[v_col.w].rgb * (0.9 + 0.14 * pulseFaded(fv * flH / 0.12, fwv * flH / 0.12, 0.0, 0.5) * fine);
      col = mix(col, sc, leaves);
    }
`;

/** The fragment text without a frame; `finishes` adds the wall finishes, roof covers and shutters. */
function plainFs(dims: ArchShadeDims, damage: boolean, finishes: boolean): string {
  const text = plainFsText(dims, damage, finishes);
  return finishes ? text.split('int style = int(v_mat.z);').join('int style = int(v_mat.z & 3u);') : text;
}

const plainFsText = (dims: ArchShadeDims, damage: boolean, finishes: boolean): string => /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <snow>
uniform ivec4 u_rows; // palette rows: glass, glass with sky reflection, plinth, unused
in vec3 v_world;
in vec3 v_pat;
flat in vec3 v_patN;
flat in vec3 v_normal;
flat in int v_kind;
flat in int v_damage;
in vec4 v_surf;
flat in vec4 v_bld;
flat in uvec4 v_mat;
flat in vec4 v_fac;
flat in uvec4 v_win;
flat in uvec4 v_bits;
flat in uvec4 v_col;
out vec4 o_color;

// Share of the interval [x − w/2, x + w/2] that lies inside [a, b].
float boxCover(float x, float w, float a, float b) {
  w = max(w, 1e-5);
  return clamp((min(x + 0.5 * w, b) - max(x - 0.5 * w, a)) / w, 0.0, 1.0);
}
// The same for a pattern repeating in every unit cell: a pulse from a to b.
float pulseIntegral(float x, float a, float b) {
  return floor(x) * (b - a) + clamp(fract(x), a, b) - a;
}
float pulseCover(float x, float w, float a, float b) {
  w = max(w, 1e-5);
  return clamp((pulseIntegral(x + 0.5 * w, a, b) - pulseIntegral(x - 0.5 * w, a, b)) / w, 0.0, 1.0);
}

// A repeated pattern for drawing: antialiased over the pixel footprint and faded out as well. Box filtering
// alone is not enough: a pattern with a period of one to two pixels still beats with the screen grid and makes
// stripes. So below about three pixels per period it fades into its mean, and below two it is only the mean.
float pulseFaded(float x, float w, float a, float b) {
  return mix(pulseCover(x, w, a, b), b - a, smoothstep(0.3, 0.5, w));
}
// The same for one rectangle inside a cell whose coordinate f runs 0–1 (w = cell coordinate per pixel).
float cellBox(float f, float w, float a, float b) {
  return mix(boxCover(f, w, a, b), max(b - a, 0.0), smoothstep(0.3, 0.5, w));
}

${finishes ? FINISH_GLSL(dims) : ''}// Light of lit windows at the current wall point: lamp colour, zero where nothing is lit.
vec3 g_windowGlow = vec3(0.0);

vec3 wallColor(uint seed) {
  float u = v_surf.x, len = v_surf.y, yRel = v_surf.z, above = v_surf.w;
  float floorH = v_bld.x, floors = v_bld.y, bay = v_bld.w;
  int style = int(v_mat.z);
  vec3 trim = u_palette[v_mat.w].rgb;

  // Building tint and slow plaster blotches.
  vec3 wall = u_palette[v_mat.x].rgb * (0.88 + 0.22 * hash1(seed + 1u));
  wall *= mix(vec3(1.0), vec3(1.05, 1.0, 0.9), hash1(seed + 2u));
  wall *= 0.95 + 0.1 * vnoise(vec2(u, yRel) * 0.4, seed);
  vec3 col = ${finishes ? 'finishWall(wall, seed, u, len, yRel, above, floorH, floorH, floors * floorH)' : 'wall'};

  float fwU = fwidth(u), fwY = fwidth(yRel);
  float top = floors * floorH;

  if (style != 0 && len > bay * 0.7) {
    float n = max(1.0, floor(len / bay + 0.5));
    float bayW = len / n;
    float cu = u / bayW, cv = yRel / floorH;
    float fu = fwU / bayW, fv = fwY / floorH;
    // Window width, height and sill as a share of the cell.
    float ww, wh, sill;
    if (style == 2) { ww = 0.8; wh = 0.48; sill = 0.3; }
    else if (style == 3) { ww = 0.36; wh = 0.3; sill = 0.42; }
    else { ww = clamp(1.5 / bayW, 0.38, 0.66); wh = clamp(1.65 / floorH, 0.3, 0.62); sill = 0.9 / floorH; }
    float inFloors = boxCover(yRel, fwY, 0.0, top);
    float gx = pulseFaded(cu, fu, 0.5 - 0.5 * ww, 0.5 + 0.5 * ww);
    float gy = pulseFaded(cv, fv, sill, sill + wh);
    float glass = gx * gy * inFloors;
    float fr = 0.09 / bayW, frV = 0.09 / floorH;
    float frame = pulseFaded(cu, fu, 0.5 - 0.5 * ww - fr, 0.5 + 0.5 * ww + fr)
                * pulseFaded(cv, fv, sill - 1.6 * frV, sill + wh + frV) * inFloors;
    // Every window has its own glass tone. From afar, where windows merge, it turns into the mean.
    float r = hash2(ivec2(floor(cu), floor(cv)), seed + uint(len * 31.0));
    float vis = detailVisible(bayW * 0.6);
    float bright = mix(0.3, r * r, vis);
    // Sky reflection in the upper part of the window.
    float inWin = clamp((fract(cv) - sill) / wh, 0.0, 1.0);
    vec3 glassCol = mix(u_palette[u_rows.x].rgb, u_palette[u_rows.y].rgb, bright * (0.55 + 0.45 * mix(0.5, inWin, vis)));
    col = mix(col, trim, frame * 0.8);
    col = mix(col, glassCol, glass);
    if (u_time.z > 0.0) {
      // Windows are lit in the evening. Each window decides by its own hash against the share of lit windows,
      // so they turn on and off one by one. Every house has its habit: lights almost everywhere or almost
      // nowhere, fewer in halls and works (strip and sparse windows) than in flats.
      float habit = 0.35 + 1.3 * hash1(seed + 9u);
      float share = clamp(u_time.w * habit * (style == 1 ? 1.0 : 0.55), 0.0, 0.95);
      float h = hash2(ivec2(floor(cu), floor(cv)), seed + 77u + uint(len * 31.0));
      float on = 1.0 - smoothstep(share - 0.012, share + 0.012, h);
      // From afar, where windows merge, the wall glows with the mean.
      on = mix(share, on, vis);
      // Warm bulbs, now and then a cooler fluorescent tube. Brightness differs a little per window.
      vec3 lamp = mix(vec3(1.0, 0.74, 0.38), vec3(0.86, 0.9, 0.82), step(0.82, r));
      g_windowGlow = lamp * (glass * on * (0.75 + 0.5 * mix(0.5, fract(h * 53.0), vis)));
    }
    // Thin line at every storey's ceiling.
    col *= 1.0 - 0.1 * pulseFaded(cv, fv, 0.0, 0.04) * inFloors;
  }

  // Cornice under the roof and plinth at the ground.
  col = mix(col, trim, 0.55 * boxCover(yRel, fwY, top - 0.18, top + 0.7));
  col = mix(col, u_palette[u_rows.z].rgb, 0.85 * boxCover(above, fwY, -1000.0, ${f(dims.plinthHeight)}));
  return col;
}

// --- Recipe path ------------------------------------------------------------------------------------------

// Share of windows lit tonight in this house, and whether a given window is lit (0–1, mean from afar).
float litShare(uint seed, float factor) {
  float habit = 0.35 + 1.3 * hash1(seed + 9u);
  return clamp(u_time.w * habit * factor, 0.0, 0.95);
}
float litWindow(float share, float h, float vis) {
  float on = 1.0 - smoothstep(share - 0.012, share + 0.012, h);
  return mix(share, on, vis);
}

// Window cell of the recipe façade at a wall point: column and storey, the window rectangle in the cell and which
// columns hold doors, stairwell strips and balconies. Shared by the outer face and the inner face (wallInside).
struct RCell {
  float colW, cu, column, fu, fwu, fl, flH, fv, fwv, vis, doorH, top, inFloors, ww, y0, y1;
  int c4;
  bool groundFloor, hasDoor, doorColumn, stairColumn, balconyColumn, windows;
};
RCell recipeCell(float u, float len, float yRel, float fwU, float fwY) {
  float fh = v_bld.x, floors = v_bld.y, bay = v_bld.w;
  float gfH = v_fac.w;
  uint flags = v_bits.x;
  // Bit 7 of bits.y: arched window, its height stored on the tall scale.
  bool archWin = (v_bits.y & ${ARCH_WINDOW_BIT}u) != 0u;
  float winW = float(v_win.x) * 0.02, winH = float(v_win.y) * 0.02 * (archWin ? ${f(WIN_TALL)} : 1.0), sill = float(v_win.z) * 0.02;
  int gfKind = int((v_bits.y >> 2u) & 3u);
  int doorKind = int((v_bits.y >> 4u) & 7u);
  uint balMask = v_bits.w & 15u, narrowMask = v_bits.w >> 4u;
  bool blindWall = (flags & ${FACADE_FLAG.blind}u) != 0u;
  bool stairStrip = (flags & ${FACADE_FLAG.stairStrip}u) != 0u;
  bool balconies = (flags & ${FACADE_FLAG.balconies}u) != 0u;
  float top = gfH + (floors - 1.0) * fh;
  float inFloors = boxCover(yRel, fwY, 0.0, top);

  // Window columns along the wall, storeys up the wall (the ground floor has its own height).
  float n = max(1.0, floor(len / bay + 0.5));
  float colW = len / n;
  float cu = u / colW;
  float column = floor(cu);
  float fu = fract(cu);
  float fwu = fwU / colW;
  bool groundFloor = yRel < gfH;
  float fl = groundFloor ? 0.0 : 1.0 + floor((yRel - gfH) / fh);
  float flH = groundFloor ? gfH : fh;
  float fv = groundFloor ? yRel / gfH : fract((yRel - gfH) / fh);
  float fwv = fwY / flH;
  int c4 = int(mod(column, 4.0));
  float vis = detailVisible(colW * 0.6);

  bool hasDoor = doorKind > 0;
  float doorCol = floor(v_fac.x / colW);
  bool doorColumn = hasDoor && column == doorCol;
  float doorH = doorKind == 4 ? v_fac.y * ${f(FACADE_DIM.archHeightPerWidth)} : doorKind == 2 ? ${f(FACADE_DIM.garageDoorHeight)} : doorKind == 3 ? ${f(FACADE_DIM.portalHeight)} : ${f(FACADE_DIM.doorHeight)};
  bool stairColumn = doorColumn && stairStrip && doorKind != 2;
  bool balconyColumn = balconies && !groundFloor && ((balMask >> uint(c4)) & 1u) != 0u && !stairColumn;

  // Window rectangle in the cell (x across the column, y up the storey), by storey and column format.
  float ww = winW * (((narrowMask >> uint(c4)) & 1u) != 0u ? 0.55 : 1.0) / colW;
  float y0 = sill / flH, y1 = (sill + winH) / flH;
  bool windows = !blindWall;
  if (groundFloor) {
    if (gfKind == 1) { ww = min(0.82, (colW - 0.5) / colW); y0 = 0.4 / gfH; y1 = (gfH - 0.45) / gfH; }
    else if (gfKind == 2) { ww *= 0.85; y0 = (gfH - 1.15) / gfH; y1 = (gfH - 0.45) / gfH; }
    else if (gfKind == 3) windows = false;
    if (doorColumn) windows = false;
  }
  if (stairColumn) windows = false;
  // A balcony door reaches down to the floor behind the parapet.
  if (balconyColumn) y0 = 0.06 / flH;
  ww = min(ww, 0.86);

  RCell k;
  k.colW = colW; k.cu = cu; k.column = column; k.fu = fu; k.fwu = fwu; k.fl = fl; k.flH = flH; k.fv = fv; k.fwv = fwv;
  k.vis = vis; k.doorH = doorH; k.top = top; k.inFloors = inFloors; k.ww = ww; k.y0 = y0; k.y1 = y1; k.c4 = c4;
  k.groundFloor = groundFloor; k.hasDoor = hasDoor; k.doorColumn = doorColumn; k.stairColumn = stairColumn;
  k.balconyColumn = balconyColumn; k.windows = windows;
  return k;
}

vec3 recipeWall(uint seed) {
  float u = v_surf.x, len = v_surf.y, yRel = v_surf.z, above = v_surf.w;
  float fh = v_bld.x;
  float gfH = v_fac.w;
  uint flags = v_bits.x;
  vec3 trim = u_palette[v_mat.w].rgb;
  vec3 frameC = u_palette[v_col.x].rgb;
  vec3 plinthC = u_palette[v_col.y].rgb;
  vec3 doorC = u_palette[v_col.z].rgb;
  float plinthH = float(v_win.w) * 0.02;
  int mullions = int(v_bits.y & 3u);
  int gfKind = int((v_bits.y >> 2u) & 3u);
  int doorKind = int((v_bits.y >> 4u) & 7u);
  bool archWin = (v_bits.y & ${ARCH_WINDOW_BIT}u) != 0u;
  float curtainShare = float(v_bits.z & 15u) / 15.0, blindShare = float(v_bits.z >> 4u) / 15.0;
  bool loggia = (flags & ${FACADE_FLAG.loggia}u) != 0u;
  uint wallSeed = seed + uint(len * 31.0);

  // Building tint: wider spread than the simple path, so neighbours differ more. Slow plaster blotches.
  vec3 col = u_palette[v_mat.x].rgb * (0.84 + 0.3 * hash1(seed + 1u));
  col *= mix(vec3(1.0), vec3(1.06, 1.0, 0.88), hash1(seed + 2u));
  col *= mix(vec3(1.0), vec3(0.95, 0.99, 1.04), hash1(seed + 4u));
  col *= 0.95 + 0.1 * vnoise(vec2(u, yRel) * 0.4, seed);
${finishes ? '  col = finishWall(col, seed, u, len, yRel, above, gfH, fh, gfH + (v_bld.y - 1.0) * fh);\n' : ''}
  float fwU = fwidth(u), fwY = fwidth(yRel);
  RCell k = recipeCell(u, len, yRel, fwU, fwY);
  float top = k.top, inFloors = k.inFloors;
  float colW = k.colW, cu = k.cu, column = k.column, fu = k.fu, fwu = k.fwu;
  bool groundFloor = k.groundFloor;
  float fl = k.fl, flH = k.flH, fv = k.fv, fwv = k.fwv;
  int c4 = k.c4;
  float vis = k.vis;
  bool hasDoor = k.hasDoor, stairColumn = k.stairColumn, balconyColumn = k.balconyColumn, windows = k.windows;
  float doorH = k.doorH;
  float doorTopRel = v_fac.z + doorH - (v_pat.y - yRel);
  float ww = k.ww, y0 = k.y0, y1 = k.y1;

  // Prefab panels: a slight tone per panel, joints along storeys and columns.
  if ((flags & ${FACADE_FLAG.panelJoints}u) != 0u) {
    float jl = (yRel - gfH) / fh;
    float tone = hash2(ivec2(int(column), int(floor(jl))), seed + 21u) - 0.5;
    col *= 1.0 + 0.09 * tone * detailVisible(min(colW, fh) * 0.5);
    float jh = pulseFaded(jl + 0.5 * 0.05 / fh, fwY / fh, 0.0, 0.05 / fh);
    float jv = pulseFaded(cu + 0.5 * 0.05 / colW, fwu, 0.0, 0.05 / colW);
    col *= 1.0 - 0.22 * max(jh, jv) * inFloors;
  }

  // Loggia recess: the band between the parapet and the slab above lies in deep shade.
  if (balconyColumn && loggia) {
    float bw = min(${f(FACADE_DIM.balconyColumnShare)}, ${f(FACADE_DIM.balconyMaxWidth)} / colW);
    float recess = cellBox(fu, fwu, 0.5 - 0.5 * bw, 0.5 + 0.5 * bw) * cellBox(fv, fwv, 0.0, 1.0 - ${f(FACADE_DIM.balconySlab)} / flH);
    col = mix(col, col * 0.5, recess * inFloors);
  }

  // Rain streaks under windows, darkest right under the sill.
  if (windows) {
    float sx = cellBox(fu, fwu, 0.5 - 0.42 * ww, 0.5 + 0.42 * ww);
    float below = clamp(1.0 - (y0 - fv) * flH / 1.1, 0.0, 1.0) * step(fv, y0);
    col *= 1.0 - 0.07 * sx * below * inFloors * detailVisible(0.6);
  }

  if (windows) {
    float x0 = 0.5 - 0.5 * ww, x1 = 0.5 + 0.5 * ww;
    float gx = cellBox(fu, fwu, x0, x1);
    float gy = cellBox(fv, fwv, y0, y1);
    float glass = gx * gy * inFloors;
    float fr = 0.07 / colW, frV = 0.07 / flH;
    float frame = cellBox(fu, fwu, x0 - fr, x1 + fr) * cellBox(fv, fwv, y0 - frV, y1 + frV) * inFloors;
    if (archWin) {
      // Half-round head as wide as the window: above the spring line only the half circle stays glass and frame.
      float rr = 0.5 * (x1 - x0) * colW;
      vec2 p = vec2((fu - 0.5) * colW, (fv - y1) * flH + rr);
      float fwd = max(fwU, fwY);
      float d = p.y > 0.0 ? length(p) : 0.0;
      glass *= 1.0 - smoothstep(rr - fwd, rr + fwd, d);
      frame *= 1.0 - smoothstep(rr + 0.07 - fwd, rr + 0.07 + fwd, d);
    }
    // Sill: a light ledge under the window, a little wider than the frame.
    float sillBand = cellBox(fu, fwu, x0 - 2.0 * fr, x1 + 2.0 * fr) * cellBox(fv, fwv, y0 - 0.07 / flH - frV, y0 - frV) * inFloors;
    // Position inside the glass (0–1) for bars, curtains and blinds.
    float wx = (fu - x0) / max(x1 - x0, 1e-4);
    float wy = (fv - y0) / max(y1 - y0, 1e-4);
    float fwx = fwu / max(x1 - x0, 1e-4), fwy = fwv / max(y1 - y0, 1e-4);
    float winWm = (x1 - x0) * colW, winHm = (y1 - y0) * flH;
    float bar = 0.0;
    float bw = 0.06 / winWm;
    if (mullions == 1 || (mullions == 2 && winWm < 1.3)) bar = cellBox(wx, fwx, 0.5 - bw, 0.5 + bw);
    else if (mullions == 2) bar = max(cellBox(wx, fwx, 0.333 - bw, 0.333 + bw), cellBox(wx, fwx, 0.667 - bw, 0.667 + bw));
    if ((flags & ${FACADE_FLAG.transom}u) != 0u && !balconyColumn) bar = max(bar, cellBox(wy, fwy, 0.7 - 0.06 / winHm, 0.7 + 0.06 / winHm));

    ivec2 cell = ivec2(int(column), int(fl));
    float r = hash2(cell, wallSeed);
    float bright = mix(0.3, r * r, vis);
    vec3 glassCol = mix(u_palette[u_rows.x].rgb, u_palette[u_rows.y].rgb, bright * (0.55 + 0.45 * mix(0.5, clamp(wy, 0.0, 1.0), vis)));
    // Curtains (side panels) and blinds (lowered from the top), chosen per window.
    float hc = hash2(cell, wallSeed + 131u);
    float fine = detailVisible(winWm * 0.25);
    float curtain = 0.0, blind = 0.0;
    if (hc < curtainShare) curtain = max(cellBox(wx, fwx, 0.0, 0.2 + 0.1 * r), cellBox(wx, fwx, 0.8 - 0.1 * r, 1.0));
    else if (hc < curtainShare + blindShare) {
      float depth = 0.25 + 0.65 * fract(hc * 37.0);
      blind = cellBox(wy, fwy, 1.0 - depth, 1.0) * (0.92 + 0.08 * pulseFaded(wy * winHm / 0.07, fwy * winHm / 0.07, 0.0, 0.5));
    }
    vec3 cloth = mix(frameC, vec3(0.78, 0.70, 0.58), 0.55);
    glassCol = mix(glassCol, cloth * 0.85, 0.75 * curtain * fine);
    glassCol = mix(glassCol, frameC * 0.88, blind * fine);
    // Mean of curtains and blinds from afar, so the wall does not change tone between zooms.
    glassCol = mix(glassCol, mix(glassCol, cloth * 0.85, 0.12 * curtainShare + 0.3 * blindShare), 1.0 - fine);

${finishes ? SHUTTER_GLSL : ''}    col = mix(col, mix(frameC, vec3(0.9, 0.88, 0.84), 0.35), sillBand * 0.85);
    col = mix(col, frameC, frame * 0.85);
    col = mix(col, glassCol, glass);
    col = mix(col, frameC, glass * bar * 0.9);
    if (u_time.z > 0.0) {
      float share = litShare(seed, groundFloor && gfKind != 0 ? 0.5 : 1.0);
      float h = hash2(cell, seed + 77u + uint(len * 31.0));
      float on = litWindow(share, h, vis);
      vec3 lamp = mix(vec3(1.0, 0.74, 0.38), vec3(0.86, 0.9, 0.82), step(0.82, r));
      // A curtain warms and dims the light, a blind holds most of it back.
      float pass = 1.0 - 0.75 * blind * fine - 0.3 * curtain * fine;
      lamp *= mix(vec3(1.0), vec3(1.0, 0.85, 0.7), curtain * fine);
      g_windowGlow = lamp * (glass * (1.0 - bar) * on * pass * (0.75 + 0.5 * mix(0.5, fract(h * 53.0), vis)));
    }
  }

  // Stairwell strip above the entrance: landing windows half a storey off the flat windows.
  if (stairColumn) {
    float tl = (yRel - gfH) / fh + 0.5;
    float k = floor(tl);
    float bottom = gfH + (k - 0.5) * fh + 0.5 * fh - 0.6;
    float sw = min(0.9, colW * 0.4) / colW;
    float ok = step(doorTopRel + 0.45, bottom) * step(bottom + 1.2, top - 0.25);
    float sg = cellBox(fu, fwu, 0.5 - 0.5 * sw, 0.5 + 0.5 * sw) * cellBox(fract(tl), fwY / fh, 0.5 - 0.6 / fh, 0.5 + 0.6 / fh) * ok;
    float sf = cellBox(fu, fwu, 0.5 - 0.5 * sw - 0.06 / colW, 0.5 + 0.5 * sw + 0.06 / colW) * cellBox(fract(tl), fwY / fh, 0.5 - 0.66 / fh, 0.5 + 0.66 / fh) * ok;
    vec3 sglass = mix(u_palette[u_rows.x].rgb, u_palette[u_rows.y].rgb, 0.45);
    col = mix(col, frameC, sf * 0.85);
    col = mix(col, sglass, sg);
    if (u_time.z > 0.0) {
      // Stairwell lights run on timers: lit more often than flats, cooler light.
      float on = litWindow(clamp(0.25 + 0.6 * u_time.w, 0.0, 0.9), hash2(ivec2(int(column), int(k)), wallSeed + 313u), vis);
      g_windowGlow += vec3(0.92, 0.9, 0.78) * sg * on * 0.8;
    }
  }

  // Cornice band: geometry draws a real cornice, otherwise a painted band under the roof (and the parapet).
  if ((flags & ${FACADE_FLAG.cornice}u) == 0u) col = mix(col, trim, 0.55 * boxCover(yRel, fwY, top - 0.18, top + 0.7));
  else col = mix(col, trim, 0.45 * boxCover(yRel, fwY, top + 0.1, top + 0.7));
  // Plinth: from the recipe, at least a hint where it is not given.
  col = mix(col, plinthC, 0.85 * boxCover(above, fwY, -1000.0, max(plinthH, 0.25)));

  // Entrance: frame, door leaf by kind, a lamp above at night.
  if (hasDoor) {
    float wy = v_pat.y;
    float hw = 0.5 * v_fac.y;
    float du = u - v_fac.x;
    float fr = 0.09;
    float outer = boxCover(du, fwU, -hw - fr, hw + fr) * boxCover(wy, fwY, v_fac.z, v_fac.z + doorH + fr);
    float leaf = boxCover(du, fwU, -hw, hw) * boxCover(wy, fwY, v_fac.z, v_fac.z + doorH);
    float dv = (wy - v_fac.z) / doorH;
    vec3 dc = doorC;
    if (doorKind == 4) {
      // Arch: a half-round head as wide as the opening, a leaf of vertical boards.
      vec2 p = vec2(du, wy - (v_fac.z + doorH - hw));
      float d = p.y > 0.0 ? length(p) : 0.0;
      float fwd = max(fwU, fwY);
      outer *= 1.0 - smoothstep(hw + fr - fwd, hw + fr + fwd, d);
      leaf *= 1.0 - smoothstep(hw - fwd, hw + fwd, d);
      dc *= 0.92 + 0.1 * pulseFaded(du / 0.18, fwU / 0.18, 0.0, 0.5);
    } else if (doorKind == 2) {
      // Garage door: ribbed sheet metal.
      dc *= 0.9 + 0.12 * pulseFaded(wy / 0.16, fwY / 0.16, 0.0, 0.5);
    } else {
      // Glass in the upper part of the leaf (door) or almost all of it (portal), split by a bar.
      float gl0 = doorKind == 3 ? 0.06 : 0.45;
      vec3 dglass = mix(u_palette[u_rows.x].rgb, u_palette[u_rows.y].rgb, 0.35);
      float g = boxCover(dv, fwY / doorH, gl0, 0.94) * boxCover(abs(du), fwU, 0.0, hw - 0.1);
      float split = boxCover(du, fwU, -0.04, 0.04);
      dc = mix(dc, dglass, g * (1.0 - split));
      if (u_time.z > 0.0) g_windowGlow += vec3(1.0, 0.8, 0.5) * g * (1.0 - split) * 0.55 * leaf;
    }
    col = mix(col, frameC * 0.95, outer * 0.9);
    col = mix(col, dc, leaf);
    if (u_time.z > 0.0 && doorKind != 2) {
      float lamp = boxCover(du, fwU, -0.12, 0.12) * boxCover(wy, fwY, v_fac.z + doorH + 0.12, v_fac.z + doorH + 0.32);
      g_windowGlow += vec3(1.0, 0.78, 0.45) * lamp * 1.5;
    }
  }
  return col;
}

${damage ? DAMAGE_GLSL + INTERIOR_GLSL : ''}vec3 roofColor(uint seed, vec3 n) {
  vec3 base = u_palette[v_mat.y].rgb * (0.82 + 0.18 * hash1(seed + 3u));
  if (v_kind == 1) {
    // Courses of roofing along the fall line. Distance up the roof from the height above the eave and the slope.
    const float COURSE_M = 0.36;
    float s = v_surf.z / max(sqrt(1.0 - n.y * n.y), 0.2);
    float w = fwidth(s) / COURSE_M;
    base *= 1.0 - 0.2 * pulseFaded(s / COURSE_M, w, 0.0, 0.25);
    base *= 0.9 + 0.2 * vnoise(v_pat.xz * 0.55, seed);
${finishes ? '    if (((v_mat.z >> 4u) & 3u) != 0u) {\n      // A cover of its own instead of the plain courses; across the slope in the frame of the mesh.\n      vec2 fall = v_patN.xz / max(length(v_patN.xz), 1e-4);\n      base = coverRoof(u_palette[v_mat.y].rgb * (0.82 + 0.18 * hash1(seed + 3u)), seed, s, dot(v_pat.xz, vec2(-fall.y, fall.x)));\n    }\n' : ''}  } else {
    // Flat roof: large blotches and fine grain.
    base *= 0.9 + 0.2 * vnoise(v_pat.xz * 0.21, seed);
    base *= 1.0 + 0.12 * (vnoise(v_pat.xz / 0.3, 31u) - 0.5) * detailVisible(0.3);
  }
  return base;
}

void main() {
  vec3 n = v_normal;
  uint seed = uint(v_bld.z * 16777215.0);
${damage ? '  if (v_kind == 4) {\n    o_color = interiorShade(seed, n);\n    return;\n  }\n  if (v_kind == 5) {\n    o_color = wallInsideShade(seed, n);\n    return;\n  }\n' : ''}  vec3 col;
  float ao = 1.0;
  if (v_kind == 0) {
    col = (v_bits.x & ${FACADE_FLAG.recipe}u) != 0u ? recipeWall(seed) : wallColor(seed);
    // The wall darkens at its foot, so the house sits on the ground.
    ao = mix(0.5, 1.0, smoothstep(-0.3, ${f(dims.wallBaseShadeHeight)}, v_surf.w));
  } else if (v_kind == 3) {
    col = u_palette[v_mat.w].rgb * (0.92 + 0.1 * hash1(seed + 1u));
    // Side faces darken towards their foot (parapet inner face, boxes on the roof and on the ground).
    if (n.y < 0.5) ao = mix(0.6, 1.0, smoothstep(0.0, ${f(dims.parapetHeight)}, v_surf.z));
  } else {
    col = roofColor(seed, n);
  }
${damage ? '  if (v_damage > 0) col = damageShade(col, seed);\n' : ''}  // Wet: roofs and fittings darken more than walls, which rain wets only partly.
  col *= 1.0 - u_weather.y * (v_kind == 0 ? 0.1 : 0.22);
  if (v_kind != 0) {
    // Snow on roofs, parapets, roof superstructures and cars. Flat roofs hold it longest.
    float snow = snowOn(v_world, n, v_kind == 2 ? 0.18 : 0.06);
    col = mix(col, u_snow.rgb * (0.97 + 0.06 * hash1(seed + 5u)), snow);
  }
  float sun = sunVisibility(v_world, n, 1.6);
  vec3 light = lightOn(n, sun, ao) * mix(0.78, 1.0, ao);
  // Windows glow on their own, independent of ambient light. Exposure is divided out so they do not blow out at night.
  vec3 glow = g_windowGlow * (u_time.z / u_warmTint.a);
  o_color = vec4(applyFog(toDisplay(col * u_warmTint.rgb * light + glow), v_world), 1.0);
}`;

/** Damage shading (vertex damage channel, see writer.ts). Only in the damage variant of the program. */
const DAMAGE_GLSL = /* glsl */ `// Damage: 1 cracked (crack network and spalled plaster in patches), 2 heavily damaged (all over, with soot),
// 3 cut and inner faces (bare core), 4 rubble (dusty broken material). Only damaged vertices (v_damage > 0) come here.

// Distance to the nearest cell border of a jittered grid (F2 − F1 of cellular noise), in cell units.
float cellEdge(vec2 p, uint seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 c = ivec2(i) + ivec2(x, y);
      vec2 o = vec2(hash2(c, seed), hash2(c, seed + 1u));
      float d = length(vec2(x, y) + o - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
  }
  return d2 - d1;
}

vec3 damageShade(vec3 col, uint seed) {
  // Projected from the rest position: the pattern stays on a piece that moves.
  vec3 m = v_patN;
  vec2 p = abs(m.y) > 0.7 ? v_pat.xz : vec2(dot(v_pat.xz, vec2(-m.z, m.x)), v_pat.y);
  float grain = vnoise(p * 4.0, seed + 41u);
  if (v_damage == 3) {
    // Broken core: dark masonry with a little brick in it.
    return mix(col * 0.38, vec3(0.3, 0.22, 0.18), 0.45) * (0.8 + 0.4 * grain);
  }
  if (v_damage >= 4) {
    // Rubble: the material broken up and covered in dust.
    return mix(col, vec3(0.66, 0.62, 0.56), 0.55) * (0.85 + 0.35 * grain * detailVisible(0.25));
  }
  float heavy = v_damage >= 2 ? 1.0 : 0.0;
  // Where the damage lies: patches when cracked, everywhere when heavy.
  float patchN = vnoise(p * 0.3, seed + 79u);
  float area = mix(0.25 + 0.75 * smoothstep(0.3, 0.55, patchN), 1.0, heavy);
  // Crack network: borders of jagged cells, about a metre across, plus finer ones near the worst spots.
  vec2 q = p * 0.9 + 0.35 * vec2(vnoise(p * 2.3, seed + 70u), vnoise(p * 2.3 + 9.0, seed + 71u));
  float e = cellEdge(q, seed + 72u);
  float px = length(fwidth(q));
  float crack = 1.0 - smoothstep(0.006, 0.006 + 1.1 * px, e);
  vec2 q2 = q * 2.6;
  float e2 = cellEdge(q2, seed + 73u);
  float px2 = length(fwidth(q2));
  float fine = (1.0 - smoothstep(0.004, 0.004 + 1.1 * px2, e2)) * smoothstep(0.55, 0.75, patchN + 0.4 * heavy);
  float lines = max(crack, 0.7 * fine) * area * detailVisible(0.08);
  // Spalled plaster: brick shows through in blotches along the cracks.
  float spallN = vnoise(p * 1.2, seed + 81u) + 0.25 * (1.0 - smoothstep(0.0, 0.25, e));
  float spall = smoothstep(mix(0.8, 0.66, heavy), mix(0.86, 0.72, heavy), spallN) * area;
  col = mix(col, vec3(0.5, 0.33, 0.26) * (0.8 + 0.3 * grain), spall * 0.85);
  // Soot and dust.
  float soot = smoothstep(0.4, 0.85, vnoise(p * 0.22, seed + 80u)) * (0.12 + 0.45 * heavy) * area;
  col *= 1.0 - soot * 0.7;
  col = mix(col, col * 0.3, lines * 0.85);
  return col;
}

`;

/**
 * Interior surfaces of a damaged structure (interior.ts): room paint, ceilings, floors by room type, bare concrete,
 * stairs and the roof space. Daylight comes in through the openings (sun with shadows) plus a soft bounce; at night a
 * room glows when one of its windows is lit (same hash as the window light). Only in the damage variant.
 */
const INTERIOR_GLSL = /* glsl */ `// Calm wall paints, picked per room by its hash.
const vec3 ROOM_PAINTS[8] = vec3[8](
  vec3(0.74, 0.71, 0.64), vec3(0.64, 0.69, 0.62), vec3(0.78, 0.69, 0.55), vec3(0.62, 0.66, 0.70),
  vec3(0.74, 0.63, 0.58), vec3(0.79, 0.77, 0.72), vec3(0.66, 0.63, 0.52), vec3(0.69, 0.73, 0.74));

vec3 interiorColor(uint rs, int finish, int type, vec2 p, float h, out float ao) {
  ao = 1.0;
  vec2 fw = fwidth(p);
  float vis = detailVisible(0.1);
  vec3 col;
  if (finish == 0 || finish == 5) {
    if (finish == 5) {
      // Roof space: rough boards between rafters.
      col = vec3(0.56, 0.44, 0.32) * (0.9 + 0.2 * hash1(rs + 7u));
      col *= 1.0 - 0.35 * pulseFaded(p.x / 0.9, fw.x / 0.9, 0.0, 0.12) * vis;
    } else {
      col = ROOM_PAINTS[int(hash1(rs) * 8.0) & 7] * (0.95 + 0.08 * hash1(rs + 3u));
      if (type == 1) col *= 0.8;
      else if (type == 2) col = mix(col, vec3(0.7, 0.7, 0.68), 0.55);
      // Skirting board and a darker band where wall meets floor and ceiling.
      col = mix(col, col * 0.55, boxCover(p.y, fw.y, -1.0, 0.08));
      ao = mix(0.7, 1.0, smoothstep(0.0, 0.6, p.y)) * mix(0.82, 1.0, smoothstep(0.0, 0.45, h - p.y));
    }
    col *= 0.96 + 0.08 * vnoise(p * 0.7, rs + 2u);
  } else if (finish == 1) {
    col = vec3(0.8, 0.79, 0.76) * (0.97 + 0.05 * vnoise(p * 0.5, rs + 4u));
  } else if (finish == 2 || finish == 6) {
    float pick = hash1(rs + 5u);
    if (type == 1 || type == 2) {
      // Corridor and stairwell: dark terrazzo tiles.
      col = vec3(0.42, 0.4, 0.37) * (0.92 + 0.16 * hash1(rs + 6u));
      vec2 q = p / 0.4;
      col *= 1.0 - 0.18 * max(pulseFaded(q.x, fw.x / 0.4, 0.0, 0.04), pulseFaded(q.y, fw.y / 0.4, 0.0, 0.04)) * vis;
      col *= 0.92 + 0.16 * vnoise(p * 6.0, rs + 8u) * vis;
    } else if (finish == 6 || pick < 0.55) {
      // Planks: parquet in rooms, boards in the roof space.
      float wPl = finish == 6 ? 0.2 : 0.11;
      float row = floor(p.y / wPl);
      float along = p.x + 0.37 * row;
      col = (finish == 6 ? vec3(0.44, 0.36, 0.27) : vec3(0.6, 0.41, 0.24)) * (0.85 + 0.25 * hash2(ivec2(int(row), int(floor(along / 0.9))), rs + 9u));
      col *= 1.0 - 0.22 * max(pulseFaded(p.y / wPl, fw.y / wPl, 0.0, 0.06), pulseFaded(along / 0.9, fw.x / 0.9, 0.0, 0.015)) * vis;
    } else {
      // Linoleum in a quiet colour.
      col = mix(vec3(0.55, 0.52, 0.45), vec3(0.5, 0.55, 0.52), hash1(rs + 10u)) * (0.95 + 0.06 * vnoise(p * 1.3, rs + 11u));
    }
  } else if (finish == 4) {
    col = vec3(0.6, 0.58, 0.55) * (0.94 + 0.08 * vnoise(p * 3.0, rs + 12u));
  } else {
    // Bare concrete at slab edges and on partition tops.
    col = vec3(0.56, 0.55, 0.52) * (0.85 + 0.25 * vnoise(p * 2.5, rs + 13u));
  }
  return col;
}

// Daylight reaching into a room: a little from the sky through any gap, much more through its windows (glazed share
// of the floor area, 0–1), more again when they face the sun. Returns the fill light.
vec3 roomFill(float day, vec2 dir, float ao) {
  float up = clamp(u_sunDir.y * 4.0, 0.0, 1.0);
  vec2 s = u_sunDir.xz / max(length(u_sunDir.xz), 1e-3);
  float side = max(dot(dir, s), 0.0);
  float gain = 0.45 + day * (1.6 + 1.2 * side * up);
  return (u_ambient.rgb * 0.45 + u_skyFill.rgb * 0.15 + u_bounce.rgb * 0.55 + u_sunColor.rgb * 0.07) * gain * ao;
}
// Is the room lamp on: rooms by their lowest lit-window threshold (own one without windows), shared spaces on timers.
float roomOn(int mode, float lit, float own, uint seed) {
  if (u_time.z <= 0.0 || mode == 2) return 0.0;
  if (mode == 1) {
    float share = clamp(0.25 + 0.6 * u_time.w, 0.0, 0.9);
    return 1.0 - smoothstep(share - 0.012, share + 0.012, own);
  }
  float share = litShare(seed, 1.0);
  float key = lit < 1.5 ? lit : own;
  return 1.0 - smoothstep(share - 0.012, share + 0.012, key);
}
// Warm bulbs in rooms, cooler tubes in corridors and stairwells.
vec3 roomLamp(int mode, uint rs) {
  return mode == 1 ? vec3(0.9, 0.88, 0.78) : mix(vec3(1.0, 0.72, 0.4), vec3(1.0, 0.82, 0.55), hash1(rs + 14u));
}

vec4 interiorShade(uint seed, vec3 n) {
  uint rs = uint(v_surf.w * 16777215.0) >> 16u;
  int finish = int(v_bits.x), type = int(v_bits.y);
  float ao;
  vec3 col = interiorColor(rs, finish, type, v_surf.xy, v_surf.z, ao);
  // Damage: full on walls, softer on floors and ceilings (dust and cracks rather than spalled plaster).
  if (v_damage > 0) col = mix(col, damageShade(col, seed), abs(v_patN.y) > 0.7 ? 0.4 : 0.7);
  // Sun through the openings (shadow map), plus the daylight of the room's windows.
  float sun = sunVisibility(v_world, n, 1.6);
  float day = float(v_win.x) / 255.0;
  vec2 dir = (vec2(v_win.yz) - 128.0) / 127.0;
  vec3 light = u_sunColor.rgb * (max(dot(n, u_sunDir.xyz), 0.0) * sun) + roomFill(day, dir, ao);
  int mode = int(v_fac.w + 0.5);
  vec3 glow = col * roomLamp(mode, rs) * (roomOn(mode, v_fac.x, v_fac.z, seed) * 0.95 * ao);
  return vec4(applyFog(toDisplay(col * u_warmTint.rgb * light + glow * (u_time.z / u_warmTint.a)), v_world), 1.0);
}

// What a window shows from inside, in light units: sky above, the street and the houses opposite below.
vec3 viewOut(float wy) {
  vec3 sky = vec3(0.7, 0.8, 0.95) * (u_skyFill.rgb * 1.5 + u_ambient.rgb * 0.9 + u_sunColor.rgb * 0.3);
  vec3 street = vec3(0.6, 0.58, 0.52) * (u_ambient.rgb + u_skyFill.rgb * 0.5 + u_sunColor.rgb * 0.45);
  return mix(street, sky, smoothstep(0.2, 0.65, wy));
}

// Inner face of an outer wall (KIND.wallInside): room paint with the wall's own windows and doors, found from the same
// façade data as the outside (recipeCell, or the simple window grid), so every opening sits exactly behind its
// outside. Each opening reads as a hole in a thick wall: plaster reveals (the soffit darker), a frame set back in it,
// a window board under it. The glass shows daylight, at night the dark pane mirrors the room when that window is lit.
vec4 wallInsideShade(uint seed, vec3 n) {
  uint pk = uint(v_surf.w + 0.5);
  uint rs = pk & 255u;
  float litB = float((pk >> 8u) & 255u);
  float lit = litB > 254.5 ? 2.0 : litB / 254.0;
  float own = float((pk >> 16u) & 255u) / 255.0;
  int finish = int(v_mat.x & 3u), type = int((v_mat.x >> 2u) & 3u), mode = int((v_mat.x >> 4u) & 3u);
  float day = float(v_mat.y) / 255.0;
  vec2 dir = (vec2(float(v_mat.w), float(v_win.w)) - 128.0) / 127.0;
  float u = v_surf.x, len = v_surf.y, yRel = v_surf.z;
  float fwU = fwidth(u), fwY = fwidth(yRel);
  float fh = v_bld.x, gfH = v_fac.w;
  bool recipe = (v_bits.x & ${FACADE_FLAG.recipe}u) != 0u;
  // Storey of the point and the room pattern coordinates (height above that storey's floor).
  bool gfl = yRel < gfH;
  float sfl = gfl ? 0.0 : 1.0 + floor((yRel - gfH) / fh);
  float base = gfl ? 0.0 : gfH + (sfl - 1.0) * fh;
  float clear = (gfl ? gfH : fh) - ${f(INTERIOR_DIM.slab)};
  float ao;
  vec3 col = interiorColor(rs, finish, type, vec2(u, yRel - base), clear, ao);

  // Opening masks in cell units: fu, fv position in the cell, x0–x1 × y0–y1 the window.
  float glass = 0.0, frame = 0.0, reveal = 0.0, soffit = 0.0, board = 0.0, bar = 0.0, curtain = 0.0, blind = 0.0;
  float wy = 0.5, on = 0.0, fine = 1.0, side = 0.0;
  vec3 frameC = vec3(0.86, 0.85, 0.82);
  if (recipe) frameC = mix(u_palette[v_col.x].rgb, vec3(0.9, 0.89, 0.86), 0.55);
  float colW = 1.0, flH = 1.0, fu = 0.0, fv = 0.0, fwu = 1.0, fwv = 1.0, x0 = 0.0, x1 = 0.0, y0 = 0.0, y1 = 0.0, vis = 1.0, inFl = 0.0;
  bool win = false;
  ivec2 cell = ivec2(0);
  float share = 0.0, hLit = 1.0, wallLen = len;
  if (recipe) {
    RCell k = recipeCell(u, len, yRel, fwU, fwY);
    win = k.windows;
    colW = k.colW; flH = k.flH; fu = k.fu; fv = k.fv; fwu = k.fwu; fwv = k.fwv; vis = k.vis; inFl = k.inFloors;
    x0 = 0.5 - 0.5 * k.ww; x1 = 0.5 + 0.5 * k.ww; y0 = k.y0; y1 = k.y1;
    cell = ivec2(int(k.column), int(k.fl));
    int gfKind = int((v_bits.y >> 2u) & 3u);
    share = litShare(seed, k.groundFloor && gfKind != 0 ? 0.5 : 1.0);
    hLit = hash2(cell, seed + 77u + uint(len * 31.0));
  } else {
    int style = int(v_mat.z);
    float bay = v_bld.w, floors = v_bld.y;
    if (style != 0 && len > bay * 0.7) {
      float nn = max(1.0, floor(len / bay + 0.5));
      colW = len / nn; flH = fh;
      float cu = u / colW, cv = yRel / fh;
      fu = fract(cu); fv = fract(cv); fwu = fwU / colW; fwv = fwY / fh;
      float ww, wh, sl;
      if (style == 2) { ww = 0.8; wh = 0.48; sl = 0.3; }
      else if (style == 3) { ww = 0.36; wh = 0.3; sl = 0.42; }
      else { ww = clamp(1.5 / colW, 0.38, 0.66); wh = clamp(1.65 / fh, 0.3, 0.62); sl = 0.9 / fh; }
      x0 = 0.5 - 0.5 * ww; x1 = 0.5 + 0.5 * ww; y0 = sl; y1 = sl + wh;
      win = true;
      inFl = boxCover(yRel, fwY, 0.0, floors * fh);
      vis = detailVisible(colW * 0.6);
      cell = ivec2(floor(cu), floor(cv));
      share = litShare(seed, style == 1 ? 1.0 : 0.55);
      hLit = hash2(cell, seed + 77u + uint(len * 31.0));
    }
  }
  float spill = 0.0;
  if (win && finish != 5) {
    // Reveal: the hole is a little wider than the frame, splayed inwards; the window board closes it at the bottom.
    float rv = 0.12 / colW, rvV = 0.12 / flH, fr = 0.06 / colW, frV = 0.06 / flH;
    float hole = cellBox(fu, fwu, x0 - rv, x1 + rv) * cellBox(fv, fwv, y0, y1 + rvV) * inFl;
    frame = cellBox(fu, fwu, x0, x1) * cellBox(fv, fwv, y0, y1) * inFl;
    glass = cellBox(fu, fwu, x0 + fr, x1 - fr) * cellBox(fv, fwv, y0 + frV, y1 - frV) * inFl;
    reveal = max(hole - frame, 0.0);
    soffit = reveal * cellBox(fv, fwv, y1, y1 + rvV);
    side = fu < 0.5 ? 1.0 : -1.0;
    board = cellBox(fu, fwu, x0 - rv - 0.04 / colW, x1 + rv + 0.04 / colW) * cellBox(fv, fwv, y0 - 0.05 / flH, y0) * inFl;
    float wx = (fu - x0) / max(x1 - x0, 1e-4);
    wy = (fv - y0) / max(y1 - y0, 1e-4);
    float fwx = fwu / max(x1 - x0, 1e-4), fwy = fwv / max(y1 - y0, 1e-4);
    float winWm = (x1 - x0) * colW, winHm = (y1 - y0) * flH;
    fine = detailVisible(winWm * 0.25);
    if (recipe) {
      int mullions = int(v_bits.y & 3u);
      float bw = 0.06 / winWm;
      if (mullions == 1 || (mullions == 2 && winWm < 1.3)) bar = cellBox(wx, fwx, 0.5 - bw, 0.5 + bw);
      else if (mullions == 2) bar = max(cellBox(wx, fwx, 0.333 - bw, 0.333 + bw), cellBox(wx, fwx, 0.667 - bw, 0.667 + bw));
      // Curtains and blinds: the same windows as outside (same hashes), seen from the room side.
      uint wallSeed = seed + uint(len * 31.0);
      float r = hash2(cell, wallSeed);
      float hc = hash2(cell, wallSeed + 131u);
      float curtainShare = float(v_bits.z & 15u) / 15.0, blindShare = float(v_bits.z >> 4u) / 15.0;
      if (hc < curtainShare) curtain = max(cellBox(wx, fwx, -0.08, 0.2 + 0.1 * r), cellBox(wx, fwx, 0.8 - 0.1 * r, 1.08)) * cellBox(wy, fwy, -0.04, 1.06);
      else if (hc < curtainShare + blindShare) {
        float depth = 0.25 + 0.65 * fract(hc * 37.0);
        blind = cellBox(wy, fwy, 1.0 - depth, 1.0) * cellBox(wx, fwx, 0.0, 1.0);
      }
    } else {
      bar = cellBox(wx, fwx, 0.5 - 0.06 / winWm, 0.5 + 0.06 / winWm);
    }
    if (u_time.z > 0.0) on = litWindow(share, hLit, vis);
    // Daylight spills onto the wall around the opening: distance to the window in metres, soft falloff.
    float ddx = max(max((x0 - fu) * colW, (fu - x1) * colW), 0.0);
    float ddy = max(max((y0 - fv) * flH, (fv - y1) * flH), 0.0);
    spill = exp(-length(vec2(ddx, ddy)) / 0.7) * inFl;
  }

  // Entrance seen from the hall: frame and leaf; the glazed part shows daylight like a window.
  float leaf = 0.0, leafGlass = 0.0, dframe = 0.0;
  vec3 leafC = vec3(0.0);
  int doorKind = int((v_bits.y >> 4u) & 7u);
  if (recipe && doorKind > 0) {
    // Seen from inside, an arch is a rectangle of its full height.
    float doorH = doorKind == 4 ? v_fac.y * ${f(FACADE_DIM.archHeightPerWidth)} : doorKind == 2 ? ${f(FACADE_DIM.garageDoorHeight)} : doorKind == 3 ? ${f(FACADE_DIM.portalHeight)} : ${f(FACADE_DIM.doorHeight)};
    float wyw = v_pat.y, hw = 0.5 * v_fac.y, du = u - v_fac.x;
    dframe = boxCover(du, fwU, -hw - 0.1, hw + 0.1) * boxCover(wyw, fwY, v_fac.z, v_fac.z + doorH + 0.1);
    leaf = boxCover(du, fwU, -hw, hw) * boxCover(wyw, fwY, v_fac.z, v_fac.z + doorH);
    leafC = u_palette[v_col.z].rgb * 0.9;
    if (doorKind == 2) leafC *= 0.9 + 0.12 * pulseFaded(wyw / 0.16, fwY / 0.16, 0.0, 0.5);
    else if (doorKind != 4) {
      float gl0 = doorKind == 3 ? 0.06 : 0.45;
      float dv = (wyw - v_fac.z) / doorH;
      leafGlass = boxCover(dv, fwY / doorH, gl0, 0.94) * boxCover(abs(du), fwU, 0.0, hw - 0.1) * (1.0 - boxCover(du, fwU, -0.04, 0.04)) * leaf;
    }
  }

  // Surfaces of the wall: paint, then reveal, board, frame, bars, cloth, the door.
  float detail = detailVisible(0.08);
  vec3 plaster = mix(col, vec3(0.86, 0.85, 0.82), 0.6);
  col = mix(col, plaster * (soffit > 0.01 ? 0.62 : (side > 0.0 ? 0.95 : 0.74)), reveal * detail + reveal * (1.0 - detail) * 0.6);
  col = mix(col, vec3(0.8, 0.77, 0.72), board * 0.95);
  col = mix(col, frameC, frame);
  col = mix(col, frameC, dframe * 0.9);
  col = mix(col, leafC, leaf);
  vec3 cloth = recipe ? mix(u_palette[v_col.x].rgb, vec3(0.78, 0.70, 0.58), 0.55) : vec3(0.7, 0.65, 0.56);

  if (v_damage > 0) col = mix(col, damageShade(col, seed), 0.7);
  float sun = sunVisibility(v_world, n, 1.6);
  vec3 light = u_sunColor.rgb * (max(dot(n, u_sunDir.xyz), 0.0) * sun) + roomFill(day, dir, ao) * (1.0 + 0.45 * spill);
  float roomLit = roomOn(mode, lit, own, seed);
  vec3 lamp = roomLamp(mode, rs);
  vec3 surf = col * u_warmTint.rgb * light + col * lamp * (roomLit * 0.95 * ao) * (u_time.z / u_warmTint.a);

  // The pane: daylight from outside; at night dark, with the lit room mirrored in it when this window is lit.
  float pane = glass * (1.0 - bar * 0.9);
  // Once the windows light up outside it is dark: the pane turns into a mirror of the room.
  float dusk = clamp(u_time.z, 0.0, 1.0);
  vec3 outside = viewOut(wy) * u_warmTint.rgb * (1.0 - 0.88 * dusk);
  vec3 night = vec3(0.012, 0.016, 0.026) + plaster * lamp * on * 0.22 * (u_time.z / u_warmTint.a);
  vec3 paneC = outside + night;
  vec3 res = mix(surf, paneC, pane);
  res = mix(res, frameC * u_warmTint.rgb * light + frameC * lamp * roomLit * 0.8 * (u_time.z / u_warmTint.a), glass * bar * 0.9);
  // Cloth hangs in front of the pane: lit by the room, and by day the light comes through it.
  vec3 clothC = cloth * 0.85 * (u_warmTint.rgb * light + lamp * roomLit * 0.9 * (u_time.z / u_warmTint.a)) + cloth * outside * 0.35;
  res = mix(res, clothC, max(curtain * 0.9, blind) * fine * (glass + reveal + frame > 0.0 ? 1.0 : 0.0));
  vec3 dglassC = viewOut(0.7) * u_warmTint.rgb * 0.8 * (1.0 - 0.88 * dusk) + vec3(0.012, 0.016, 0.026);
  res = mix(res, dglassC, leafGlass);
  return vec4(applyFog(toDisplay(res), v_world), 1.0);
}

`;
