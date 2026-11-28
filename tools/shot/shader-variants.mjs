// The page variants of the shader check (`shader-check.mjs --variants`): pages that make programs the default pages
// of the examples do not. Each is an example's name or a page file of one, optionally with the `#hash` that turns a
// mode on. A variant belongs here only while it makes programs of its own: run the check with `--variants` and read
// the `(N new)` of its line; a variant with 0 new adds nothing and is left out.

export const SHADER_VARIANTS = [
  // The second page of the example: its own small set of programs.
  'endless/sphere.html',
  // The far strip of the ground and the damaged cells.
  'endless#strip=1',
  'endless#dmg=1',
  // Cascaded shadows and the other depth mappings change the lighting and depth parts of nearly every program.
  'endless#shadows=cascades',
  'endless#depth=reversed',
  'endless#depth=logarithmic',
  // Without the cloud volume the sky and the lighting are built from other parts.
  'endless#vol=0',
  // Without the atmosphere, and with the logarithmic depth (the page's default is the reversed one).
  'planet#atm=0',
  'planet#depth=logarithmic',
  // The cloud shadows computed per fragment instead of read from the texture.
  'fantasy-village#cs=0',
];
