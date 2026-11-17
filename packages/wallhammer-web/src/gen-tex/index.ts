// Layer 3, gen-tex: texture generators. Pure functions that return texture data; the GPU never appears here.

export { boxBlur, codeTexture, colorTable } from './textures.ts';
export { NO_VALUE, VALUE_RAMPS, VALUE_TABLE_WIDTH, VALUE_WORD_MAX, colorRamp, quantizeValues, rampColor, valueTableSize, wordTexture, wordValue } from './value-textures.ts';
export type { RampStop, ValueRampName } from './value-textures.ts';
export { CodeStamp } from './code-stamp.ts';
export type { CodeRegion } from './code-stamp.ts';
export { SurfaceRaster, horizonTexture, lightHorizon } from './light-horizon.ts';
export type { HorizonTexture } from './light-horizon.ts';
