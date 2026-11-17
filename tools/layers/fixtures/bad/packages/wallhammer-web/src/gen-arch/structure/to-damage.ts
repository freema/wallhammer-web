// Known bad: structure imports a value from damage, a later subfolder.
import { piece } from '../damage/piece.ts';
export const pieceMass = piece.mass;
