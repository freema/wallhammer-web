// Known good: damage comes last among the subfolders and may import interior and structure.
import { ceiling } from '../interior/plan.ts';
import { ridgeHeight } from '../structure/roof.ts';
export const fallHeight = ceiling + ridgeHeight;
