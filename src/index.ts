#!/usr/bin/env bun

import { run } from "./cli/run.ts";

const code = await run(process.argv.slice(2));
process.exit(code);
