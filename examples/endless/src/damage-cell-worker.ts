// Worker script of the damage demo (dmg=1): as smooth-cell-worker.ts, with the generator that adds the structures in
// the state the job's edits text gives.
import { serveCellGenerator } from 'wallhammer-web/runtime';
import { generateDamageCell } from './structures.ts';

serveCellGenerator(generateDamageCell);
