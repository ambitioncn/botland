#!/usr/bin/env node
const { cleanupResidue } = require('../drivers/cleanupResidue');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { runId: process.env.BOTLAND_TEST_RUN_ID || '', registryPath: '', includePatternGroups: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run-id') opts.runId = args[++i];
    else if (args[i] === '--registry') opts.registryPath = args[++i];
    else if (args[i] === '--no-pattern-groups') opts.includePatternGroups = false;
    else if (args[i] === '--help') {
      console.log('Usage: node testing/scripts/cleanup-residue.js --run-id <BT_TEST_...> [--registry path] [--no-pattern-groups]');
      process.exit(0);
    }
  }
  if (!opts.runId && !opts.registryPath) {
    console.error('cleanup-residue requires --run-id or --registry');
    process.exit(2);
  }
  return opts;
}

(async () => {
  const opts = parseArgs();
  const summary = await cleanupResidue(opts);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.errors.length ? 1 : 0);
})().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
