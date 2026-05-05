const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const suites = {
  all: [
    'typing-basic.js',
    'typing-relay-check.js',
    'reaction-basic.js',
    'reply-preview.js',
    'dm-delivery-ack.js',
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
    'bot-card-use-smoke.js',
    'bot-card-first-connect-smoke.js',
    'auth-register-relogin-smoke.js',
    'agent-register-botcard-autofriend-smoke.js',
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
    'offline-delivery.js',
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
  'bot-card': [
    'bot-card-use-smoke.js',
    'bot-card-first-connect-smoke.js',
  ],
  'auth': [
    'auth-register-relogin-smoke.js',
    'agent-register-botcard-autofriend-smoke.js',
  ],
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { suite: 'all', jsonOut: '', noSpacing: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--suite') out.suite = args[++i];
    else if (args[i] === '--json-out') out.jsonOut = args[++i];
    else if (args[i] === '--no-spacing') out.noSpacing = true;
  }
  if (!suites[out.suite]) {
    console.error(`Unknown suite: ${out.suite}`);
    console.error(`Available suites: ${Object.keys(suites).join(', ')}`);
    process.exit(2);
  }
  return out;
}

function runScenario(file) {
  return new Promise((resolve) => {
    const full = path.join(__dirname, 'scenarios', file);
    const startedAt = Date.now();
    const child = spawn(process.execPath, [full], { stdio: ['ignore', 'pipe', 'pipe'] });
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

  console.log(`Running suite: ${opts.suite}`);
  for (const s of scenarios) {
    console.log(`\n=== RUN ${s} ===`);
    const res = await runScenario(s);
    results.push(res);
    if (!opts.noSpacing && s !== scenarios[scenarios.length - 1]) await sleep(8000);
  }

  const summary = {
    suite: opts.suite,
    ok: results.every(r => r.ok),
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
    })),
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
