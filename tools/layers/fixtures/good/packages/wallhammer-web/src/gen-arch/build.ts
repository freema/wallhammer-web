// Known good: a file directly in the module folder ranks after all subfolders and may import every one of them.
import { ridgeHeight } from './structure/roof.ts';
import { ceiling } from './interior/plan.ts';
import { fallHeight } from './damage/collapse.ts';
export const total = ridgeHeight + ceiling + fallHeight;
