const { spawn } = require('child_process');
const path = require('path');

const scenarios = [
  'typing-basic.js',
  'reaction-basic.js',
  'reply-preview.js',
];

function runScenario(file) {
  return new Promise((resolve) => {
    const full = path.join(__dirname, 'scenarios', file);
    const child = spawn(process.execPath, [full], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d); });
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim().split(/\n(?=\{)/).pop()); } catch {}
      resolve({ file, code, ok: code === 0, stdout, stderr, parsed });
    });
  });
}

(async () => {
  const results = [];
  for (const s of scenarios) {
    console.log(`\n=== RUN ${s} ===`);
    const res = await runScenario(s);
    results.push(res);
  }
  const summary = {
    ok: results.every(r => r.ok),
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    scenarios: results.map(r => ({
      file: r.file,
      ok: r.ok,
      code: r.code,
      scenario: r.parsed?.scenario || null,
      details: r.parsed?.details || null,
    })),
  };
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
})();
