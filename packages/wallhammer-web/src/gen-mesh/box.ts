// Box primitive shared by generators: a single-coloured oriented box with an optional tilt.

/** Single-coloured box standing on a surface, optionally tilted along its longer axis to follow a slope. */
export interface PropBox {
  cx: number;
  cz: number;
  /** Height of the bottom face at the box centre. */
  baseY: number;
  /** Unit direction of the longer axis. */
  ux: number;
  uz: number;
  halfL: number;
  halfW: number;
  height: number;
  /** Rise along the longer axis (height change per metre), so the box lies on a slope. */
  slope: number;
  /** Palette row. */
  color: number;
  hash: number;
}
