#!/usr/bin/env node
// This repository's `wallhammer-marks set` (the package's command-line tool, packages/wallhammer-web/src/marks-store/
// commands.ts, run from its source): changes a mark through the example server's store, with this repository's
// defaults: the store's folder internal/marks/ (or WH_MARKS_DIR) and the example server http://127.0.0.1:5281.
//
//   node tools/marks/set.mjs m0007 --status seen --by agent:clouds
//   node tools/marks/set.mjs m0007 --status fixed --by agent:clouds --text "the edge fades over 200 m" \
//        --after internal/marks/m0007-after-1.png
//   options: --category bug|look|idea|none   --url http://127.0.0.1:5281   --dir <folder>
//
// `fixed` needs --after (tools/marks/shoot.mjs takes the picture); accepted and reopened are the developer's.

import { runMarksCli } from '../../packages/wallhammer-web/src/marks-store/commands.ts';
import { withRepoDefaults } from './common.mjs';

process.exitCode = await runMarksCli(['set', ...withRepoDefaults(process.argv.slice(2))]);
