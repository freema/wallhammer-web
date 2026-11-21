// Colours of the ground, shared by the page's ground mesh and the picture script, so both judge the same look.

export type V3 = [number, number, number];

export const mix = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const sat = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Colour of the ground (linear 0–1) from its height (metres), its slope (1 − the normal's y) and how far it lies above
 * the water that may stand there (metres): grass low, drier grass and rock higher up, rock on steep slopes, gravel
 * and sand just above the water.
 */
export function groundColour(height: number, slope: number, overWater: number): V3 {
  let c: V3 = mix([0.3, 0.4, 0.17], [0.44, 0.45, 0.27], sat(height / 220));
  c = mix(c, [0.56, 0.55, 0.5], sat((height - 250) / 120));
  c = mix(c, [0.43, 0.4, 0.37], sat((slope - 0.45) / 0.35));
  // Gravel and sand just above the water.
  return mix([0.63, 0.59, 0.47], c, Math.max(sat((overWater - 0.05) / 0.2), sat((slope - 0.15) / 0.25)));
}
