#!/usr/bin/env node

import { runActionPlannerCli } from './action-planner.mjs';

try {
  await runActionPlannerCli();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
