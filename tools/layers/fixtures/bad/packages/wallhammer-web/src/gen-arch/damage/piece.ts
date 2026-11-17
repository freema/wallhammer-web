// Known bad fixture helper: a clean file in damage that the back imports below point to.
export interface Piece {
  mass: number;
}
export const piece: Piece = { mass: 1 };
