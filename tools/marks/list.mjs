#!/usr/bin/env node
// This repository's `wallhammer-marks list` (the package's command-line tool, packages/wallhammer-web/src/marks-store/
// commands.ts, run from its source): the same options (--open, --md, --json, --dir, --url), with this repository's
// defaults: the store's folder internal/marks/ (or WH_MARKS_DIR) and the example server http://127.0.0.1:5281.
//
//   node tools/marks/list.mjs --open
//   node tools/marks/list.mjs --md

import { runMarksCli } from '../../packages/wallhammer-web/src/marks-store/commands.ts';
import { withRepoDefaults } from './common.mjs';

process.exitCode = await runMarksCli(['list', ...withRepoDefaults(process.argv.slice(2))]);
