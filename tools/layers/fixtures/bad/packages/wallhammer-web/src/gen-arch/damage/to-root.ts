// Known bad: a subfolder file imports a file of the module root, which ranks after all subfolders.
import { shape } from '../index.ts';
export const shaped = shape() + 1;
