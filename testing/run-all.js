const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { cleanupResidue } = require('./drivers/cleanupResidue');
const { createRunId, defaultRegistryPath, initRegistry, recordScenarioResult } = require('./drivers/residueRegistry');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const suites = {
  all: [
    'typing-basic.js',
    'typing-relay-check.js',
    'reaction-basic.js',
    'reply-preview.js',
    'dm-delivery-ack.js',
    'friend-request-dm-smoke.js',
    'offline-delivery.js',
    'group-message-basic.js',
    'group-mention-basic.js',
    'group-typing-basic.js',
    'group-mute-all-basic.js',
    'group-owner-send-while-muted.js',
    'group-transfer-owner-basic.js',
    'group-admin-role-basic.js',
    'group-admin-send-while-muted.js',
    'group-remove-member-basic.js',
    'group-leave-basic.js',
    'group-disband-basic.js',
    'list-groups-basic.js',
    'list-groups-after-leave.js',
    'get-group-basic.js',
    'get-group-after-disband.js',
    'group-history-basic.js',
    'group-history-before-pagination.js',
    'group-history-before-limit-basic.js',
    'group-history-limit-basic.js',
    'group-system-message-history.js',
    'group-history-access-denied.js',
    'auth-register-relogin-smoke.js',
  ],
  'core-dm': [
    'typing-basic.js',
    'typing-relay-check.js',
    'reaction-basic.js',
    'reply-preview.js',
    'dm-delivery-ack.js',
  ],
  'core-dm-extended': [
    'typing-basic.js',
    'typing-relay-check.js',
    'reaction-basic.js',
    'reply-preview.js',
    'dm-delivery-ack.js',
    'friend-request-dm-smoke.js',
    'offline-delivery.js',
  ],
  relationship: [
    'friend-request-dm-smoke.js',
  ],
  'group-core': [
    'group-message-basic.js',
    'group-mention-basic.js',
    'group-typing-basic.js',
  ],
  'group-governance': [
    'group-mute-all-basic.js',
    'group-owner-send-while-muted.js',
    'group-transfer-owner-basic.js',
    'group-admin-role-basic.js',
    'group-admin-send-while-muted.js',
    'group-remove-member-basic.js',
    'group-leave-basic.js',
    'group-disband-basic.js',
    'list-groups-basic.js',
    'list-groups-after-leave.js',
    'get-group-basic.js',
    'get-group-after-disband.js',
    'group-history-basic.js',
    'group-history-before-pagination.js',
    'group-history-before-limit-basic.js',
    'group-history-limit-basic.js',
    'group-system-message-history.js',
    'group-history-access-denied.js',
  ],
  'auth': [
    'auth-register-relogin-smoke.js',
  ],
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { suite: 'all', jsonOut: '', noSpacing: false, skipCleanup: false, runId: process.env.BOTLAND_TEST_RUN_ID || '', registry: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--suite') out.suite = args[++i];
    else if (args[i] === '--json-out') out.jsonOut = args[++i];
    else if (args[i] === '--no-spacing') out.noSpacing = true;
    else if (args[i] === '--skip-cleanup') out.skipCleanup = true;
    else if (args[i] === '--run-id') out.runId = args[++i];
    else if (args[i] === '--registry') out.registry = args[++i];
  }
  if (!suites[out.suite]) {
    console.error(`Unknown suite: ${out.suite}`);
    console.error(`Available suites: ${Object.keys(suites).join(', ')}`);
    process.exit(2);
  }
  return out;
}

function runScenario(file, { runId, registryPath }) {
  return new Promise((resolve) => {
    const full = path.join(__dirname, 'scenarios', file);
    const startedAt = Date.now();
    const child = spawn(process.execPath, [full], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BOTLAND_TEST_RUN_ID: runId,
        BOTLAND_RESIDUE_REGISTRY: registryPath,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d); });
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim().split(/\n(?=\{)/).pop()); } catch {}
      resolve({
        file,
        code,
        ok: code === 0,
        stdout,
        stderr,
        parsed,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

(async () => {
  const opts = parseArgs();
  const scenarios = suites[opts.suite];
  const results = [];
  const startedAt = new Date().toISOString();
  const runId = opts.runId || createRunId();
  const registryPath = opts.registry || defaultRegistryPath(runId);
  let suiteCleanup = null;

  console.log(`Running suite: ${opts.suite}`);
  console.log(`Run id: ${runId}`);
  console.log(`Residue registry: ${registryPath}`);
  initRegistry(registryPath, runId, { startedAt });

  try {
    for (const s of scenarios) {
      console.log(`\n=== RUN ${s} ===`);
      const res = await runScenario(s, { runId, registryPath });
      try {
        recordScenarioResult(s, runId, res, { registryPath });
      } catch (err) {
        res.registryError = err instanceof Error ? err.message : String(err);
        console.error(`[registry] failed after ${s}: ${res.registryError}`);
      }
      results.push(res);
      if (!opts.skipCleanup) {
        console.log(`\n=== CLEANUP ${s} ===`);
        try {
          res.cleanup = await cleanupResidue({ runId, registryPath });
          console.log(JSON.stringify({ cleanup: res.cleanup }, null, 2));
        } catch (err) {
          res.cleanup = { error: err instanceof Error ? err.message : String(err) };
          console.error(`[cleanup] failed after ${s}: ${res.cleanup.error}`);
        }
      }
      if (!opts.noSpacing && s !== scenarios[scenarios.length - 1]) await sleep(8000);
    }
  } finally {
    if (!opts.skipCleanup) {
      console.log('\n=== SUITE CLEANUP ===');
      try {
        suiteCleanup = await cleanupResidue({ runId, registryPath });
        console.log(JSON.stringify({ cleanup: suiteCleanup }, null, 2));
      } catch (err) {
        suiteCleanup = { error: err instanceof Error ? err.message : String(err) };
        console.error(`[cleanup] failed at suite end: ${suiteCleanup.error}`);
      }
    }
  }

  const cleanupOk =
    opts.skipCleanup ||
    results.every(r => !r.cleanup?.error && (!Array.isArray(r.cleanup?.errors) || r.cleanup.errors.length === 0)) &&
    !suiteCleanup?.error &&
    (!Array.isArray(suiteCleanup?.errors) || suiteCleanup.errors.length === 0);

  const summary = {
    runId,
    registryPath,
    suite: opts.suite,
    ok: results.every(r => r.ok) && cleanupOk,
    cleanupOk,
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios: results.map(r => ({
      file: r.file,
      ok: r.ok,
      code: r.code,
      durationMs: r.durationMs,
      scenario: r.parsed?.scenario || null,
      details: r.parsed?.details || null,
      cleanup: r.cleanup || null,
      registryError: r.registryError || null,
    })),
    cleanup: suiteCleanup,
  };

  if (opts.jsonOut) {
    fs.mkdirSync(path.dirname(opts.jsonOut), { recursive: true });
    fs.writeFileSync(opts.jsonOut, JSON.stringify(summary, null, 2));
    console.log(`\nJSON summary written to ${opts.jsonOut}`);
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
})();
