// Content that is drawn as separate objects near the viewer and carried by the colour of the surface farther away.
//
// A streamed world keeps objects only in its finest levels of cells. Beyond them the surface itself must look as the
// objects did from afar: its vertices carry a "cover" baked by the generator (a colour and the share of the surface
// the objects hide, see `coverAt` of the sphere patch), and the surface shader mixes it in. The change is spread
// over the band in which the cells of the coarsest level with objects blend into their parent's shape (the morph
// factor of the streamed world): across that band the objects leave one by one while the cover comes in by the same
// share, so nothing appears or vanishes at once, and an area covered with objects keeps its colour and its outline
// at any distance. The engine does not know what the objects are; the content decides the share and the colour.
//
// `coverFade` is the share of the far look, `coverKeep` the size of one object at that share. Both exist here as
// functions and, with the same names and arithmetic, as GLSL.

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Share of the far look, 0–1, for content whose objects exist in cells of the level `objectLevel` and finer.
 * `cellLevel` is the level of the cell being drawn and `morph` its blend factor toward its parent (0 = own shape,
 * 1 = the parent's). Finer cells give 0, coarser cells 1, and the cells of `objectLevel` follow their blend.
 */
export function coverFade(objectLevel: number, cellLevel: number, morph: number): number {
  return clamp01(objectLevel - cellLevel + morph);
}

/**
 * Size of one object, 0–1, at a share of the far look. `order` is a number 0–1 fixed per object: objects with a low
 * one leave first, and each shrinks over a tenth of the band before it is gone. At `fade` 0 every object is whole,
 * at 1 none is left, and in between about `1 − fade` of them remain.
 */
export function coverKeep(fade: number, order: number): number {
  return clamp01((order * 0.9 + 0.1 - fade) * 10);
}

/** GLSL of `coverFade` and `coverKeep` (any shader stage; needs nothing before it). */
export const COVER_FADE_GLSL = /* glsl */ `
float coverFade(float objectLevel, float cellLevel, float morph) {
  return clamp(objectLevel - cellLevel + morph, 0.0, 1.0);
}
float coverKeep(float fade, float order) {
  return clamp((order * 0.9 + 0.1 - fade) * 10.0, 0.0, 1.0);
}
`;
