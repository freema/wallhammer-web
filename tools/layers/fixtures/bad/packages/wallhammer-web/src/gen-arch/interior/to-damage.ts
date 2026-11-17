// Known bad: interior imports a type from damage; a type import is still a back import.
import type { Piece } from '../damage/piece.ts';
export const heavy = (p: Piece): boolean => p.mass > 1;
