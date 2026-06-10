const path = require('path');
const { spawn } = require('child_process');
const {
  addObject,
  createRunId,
  defaultRegistryPath,
  initRegistry,
  recordScenarioResult,
  writeRegistry,
} = require('../../drivers/residueRegistry');

function residueContext() {
  const runId = process.env.BOTLAND_TEST_RUN_ID || createRunId();
  const registryPath = process.env.BOTLAND_RESIDUE_REGISTRY || defaultRegistryPath(runId);
  initRegistry(registryPath, runId, { startedAt: new Date().toISOString() });
  return { runId, registryPath };
}

function parseLastJson(stdout) {
  return JSON.parse(stdout.trim().split(/\n(?=\{)/).pop() || '{}');
}

async function runJsonScenario(scriptName, args = []) {
  const { runId, registryPath } = residueContext();
  const scenarioPath = path.resolve(process.cwd(), `../scenarios/${scriptName}`);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scenarioPath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BOTLAND_TEST_RUN_ID: runId,
        BOTLAND_RESIDUE_REGISTRY: registryPath,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = parseLastJson(stdout); } catch {}

      recordScenarioResult(scriptName, runId, {
        file: scriptName,
        code,
        ok: code === 0,
        stdout,
        stderr,
        parsed,
        durationMs: Date.now() - startedAt,
      }, { registryPath });

      if (code !== 0) return reject(new Error(`${scriptName} failed: ${stderr || code}`));
      if (!parsed) return reject(new Error(`${scriptName} did not emit JSON`));
      resolve(parsed);
    });
  });
}

function registerResidueObject(obj) {
  const { runId, registryPath } = residueContext();
  const registry = initRegistry(registryPath, runId, { startedAt: new Date().toISOString() });
  addObject(registry, {
    ...obj,
    run_id: obj.run_id || runId,
    source: obj.source || 'ui',
  });
  writeRegistry(registryPath, registry);
}

module.exports = { registerResidueObject, runJsonScenario };
