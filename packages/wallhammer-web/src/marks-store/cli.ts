#!/usr/bin/env node
// `wallhammer-marks`, the `bin` of the package: list the marks and change one through the dev server's store
// (commands.ts says how). `npx wallhammer-marks list --open` in a project that installed wallhammer-web.

import { runMarksCli } from './commands.ts';

process.exitCode = await runMarksCli(process.argv.slice(2));
