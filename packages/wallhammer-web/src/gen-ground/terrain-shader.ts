// Terrain: colour from the baked ground texture, fine grain up close, shadows. The vertical cut along the perimeter is bare earth.
// The same shader in a second variant draws horizontal markings (crossings, lines): the marking mesh follows the terrain cells,
// so it sits exactly on the surface and gets the same light, shadow, snow, wetness and fog as the ground below it.


export const TERRAIN_VS = /* glsl */ `#include <header>
invariant gl_Position;
in vec3 a_pos;
in vec4 a_normal;
out vec3 v_world;
out vec3 v_normal;
flat out float v_kind;
void main() {
  v_world = a_pos;
  v_normal = a_normal.xyz;
  v_kind = a_normal.w;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

/** Marking vertices: position and normal as terrain, plus coordinates in the shape and its parameters. */
export const MARKING_VS = /* glsl */ `#include <header>
invariant gl_Position;
in vec3 a_pos;
in vec4 a_normal;
in vec2 a_uv;
in vec4 a_size;
in vec4 a_paint;
in vec2 a_pattern;
out vec3 v_world;
out vec3 v_normal;
out vec2 v_uv;
flat out vec4 v_size;
flat out vec4 v_paint;
flat out vec2 v_pattern;
void main() {
  v_world = a_pos;
  v_normal = a_normal.xyz;
  v_uv = a_uv;
  v_size = a_size;
  v_paint = a_paint;
  v_pattern = a_pattern;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const MARKING_COVER = /* glsl */ `
in vec2 v_uv;          // x along the shape from its start (m), y across from the axis (m)
flat in vec4 v_size;   // x length, y width, z stripe period, w share of colour in the period
flat in vec4 v_paint;  // rgb colour, a wear 0–1
flat in vec2 v_pattern; // x pattern (0 solid, 1 stripes along the length, 2 outline), y outline line width
const float v_kind = 0.0;

// Integral of a rectangular wave (1 at the start of each period for the duration of duty).
float squareInt(float t, float duty) { return floor(t) * duty + min(fract(t), duty); }
// Stripes averaged over the pixel footprint: sharp up close, blending into the average from afar and not flickering.
float stripes(float t, float w, float duty) {
  w = max(w, 1e-4);
  return (squareInt(t + 0.5 * w, duty) - squareInt(t - 0.5 * w, duty)) / w;
}
// Exact overlap of the interval [-h, h] with a pixel footprint of width fw centred at x, divided by fw.
// For wide shapes this is the usual anti-aliased edge; a line thinner than a pixel fades to its true share
// instead of staying half-covered and flickering with the pixel centre.
float boxCover(float x, float h, float fw) { return clamp((min(h, x + 0.5 * fw) - max(-h, x - 0.5 * fw)) / fw, 0.0, 1.0); }
float markingCover(vec2 w) {
  vec2 fw = max(fwidth(v_uv), vec2(1e-4));
  float du = min(v_uv.x, v_size.x - v_uv.x);
  float dv = 0.5 * v_size.y - abs(v_uv.y);
  float cov = boxCover(v_uv.x - 0.5 * v_size.x, 0.5 * v_size.x, fw.x) * boxCover(v_uv.y, 0.5 * v_size.y, fw.y);
  if (v_pattern.x > 0.5 && v_pattern.x < 1.5) cov *= stripes(v_uv.x / v_size.z, fw.x / v_size.z, v_size.w);
  else if (v_pattern.x > 1.5) cov *= 1.0 - clamp((min(du, dv) - v_pattern.y) / max(fw.x, fw.y) + 0.5, 0.0, 1.0);
  // Wear: the paint is rubbed off in places. The fine component vanishes before it would be smaller than a pixel.
  float n = 0.6 * vnoise(w / 0.7, 61u) + 0.4 * mix(0.5, vnoise(w / 0.16, 62u), detailVisible(0.16));
  cov *= 1.0 - 0.9 * v_paint.a * smoothstep(0.4, 0.75, n);
  return cov;
}
`;

function terrainFs(marking: boolean): string {
  return /* glsl */ `#include <header>
#include <noise>
#include <lighting>
#include <snow>
${marking ? MARKING_COVER : ''}
uniform sampler2D u_ground;
// Surface kind from the ground bake: r vegetation, g paved area (0.6) and roadway (1), b under canopy, a water.
uniform sampler2D u_surface;
uniform vec2 u_invWorldSize;
uniform vec3 u_earth;
uniform float u_topY;
in vec3 v_world;
in vec3 v_normal;
${marking ? '' : 'flat in float v_kind;'}
out vec4 o_color;

void main() {
  vec3 n = normalize(v_normal);
  vec3 col;
  float sun = 1.0;
  float mark = 1.0;
  float puddle = 0.0;
  float wetK = 0.0;
  if (v_kind > 0.5) {
    // Cut: horizontal layers, darkening downward.
    float along = dot(v_world.xz, vec2(-n.z, n.x));
    float strata = vnoise(vec2(along * 0.03, v_world.y * 0.55), 5u);
    float depth = clamp((u_topY - v_world.y) / 40.0, 0.0, 1.0);
    col = u_earth * (0.72 + 0.3 * strata) * (1.0 - 0.45 * depth);
  } else {
    vec2 uv = v_world.xz * u_invWorldSize;
    vec4 g = texture(u_ground, uv);
    vec4 surf = texture(u_surface, uv);
    col = g.rgb;
    // Grain at two scales, anchored in the world. Each vanishes before it would be smaller than a pixel.
    float fine = (vnoise(v_world.xz / 0.22, 21u) - 0.5) * detailVisible(0.22);
    float mid = (vnoise(v_world.xz / 0.9, 22u) - 0.5) * detailVisible(0.9);
    col *= 1.0 + g.a * (0.34 * fine + 0.2 * mid);
${
  marking
    ? `    // Marking: colour instead of ground, with weaker grain. Transparency carries the coverage of the shape.
    mark = markingCover(v_world.xz);
    if (mark < 0.004) discard;
    col = v_paint.rgb * (1.0 + 0.5 * g.a * (0.34 * fine + 0.2 * mid));`
    : ''
}

    // Season: grass outside the growing season fades to straw, is fresher in spring. Leaves lie under broadleaves.
    float lum = dot(col, vec3(0.3, 0.5, 0.2));
    col = mix(col, lum * vec3(1.24, 1.04, 0.7), surf.r * u_season.w * 0.72);
    col = mix(col, col * vec3(1.04, 1.1, 0.88), surf.r * u_season.z * 0.8);
    float litter = surf.b * (1.0 - u_season.x) * smoothstep(0.3, 0.6, vnoise(v_world.xz / 1.3, 23u) + 0.25);
    col = mix(col, lum * vec3(1.4, 0.92, 0.58), litter * 0.6);

    // Wetness: asphalt and paving darken, puddles stand in depressions. Grass darkens only a little.
    float paved = smoothstep(0.3, 0.5, surf.g);
    float road = smoothstep(0.75, 0.95, surf.g);
    wetK = u_weather.y * paved;
    col *= 1.0 - 0.4 * wetK - 0.1 * u_weather.y * surf.r;
    float pn = 0.6 * vnoise(v_world.xz / 1.1, 91u) + 0.4 * vnoise(v_world.xz / 0.35, 92u);
    puddle = wetK * smoothstep(0.72, 0.78, pn + 0.06 * u_weather.y) * (1.0 - surf.a) * mix(0.35, 1.0, detailVisible(0.35));

    // Snow: it is cleared from roadways first, from pavements and yards a bit later, less falls under canopies,
    // it does not lie on water. A cleared roadway is dark and wet.
    float snow = snowOn(v_world, n, -0.32 * paved - 0.62 * road - 0.22 * surf.b) * (1.0 - surf.a);
    float slush = u_weather.x * road * (1.0 - snow);
    col *= 1.0 - 0.25 * slush;
    wetK = max(wetK, 0.6 * slush);
    col = mix(col, u_snow.rgb * (0.96 + 0.1 * fine), snow);
    puddle *= 1.0 - snow;
    sun = sunVisibility(v_world, n, 1.2);
  }
  vec3 c = toDisplay(col * u_warmTint.rgb * lightOn(n, sun, 1.0));
  // Puddle reflects the sky, a wet surface gleams slightly.
  c = mix(c, u_fogColor.rgb * 0.85, puddle * 0.32);
  c += wetK * 0.035 * u_fogColor.rgb;
  o_color = vec4(applyFog(c, v_world), ${marking ? 'mark' : '1.0'});
}`;
}

export const TERRAIN_FS = terrainFs(false);
export const MARKING_FS = terrainFs(true);
