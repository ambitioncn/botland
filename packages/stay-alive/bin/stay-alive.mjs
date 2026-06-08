#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptRoot = path.join(packageRoot, 'scripts', 'stay-alive');
const docsRoot = path.join(packageRoot, 'docs', 'stay-alive');

function printHelp() {
  console.log(`Usage:
  stay-alive list
  stay-alive docs
  stay-alive path
  stay-alive <script> -- [script args]

Examples:
  stay-alive onboarding-template -- --agent my-agent
  stay-alive preflight -- --agent my-agent --no-checkpoint --strict-onboarding
  stay-alive regression-suite -- --agent badclaw --json
`);
}

function listScripts() {
  if (!existsSync(scriptRoot)) {
    throw new Error(`Bundled script directory missing: ${scriptRoot}`);
  }
  for (const file of readdirSync(scriptRoot).filter((item) => item.endsWith('.mjs')).sort()) {
    console.log(file.replace(/\.mjs$/, ''));
  }
}

function runScript(scriptName, args) {
  const normalized = scriptName.endsWith('.mjs') ? scriptName : `${scriptName}.mjs`;
  const scriptPath = path.join(scriptRoot, normalized);
  if (!existsSync(scriptPath)) {
    throw new Error(`Unknown Stay-Alive script: ${scriptName}. Run "stay-alive list" to inspect bundled scripts.`);
  }
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: packageRoot,
    env: process.env,
    stdio: 'inherit'
  });
  process.exit(result.status ?? 1);
}

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const passThrough = argv[1] === '--' ? argv.slice(2) : argv.slice(1);

try {
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
  } else if (command === 'list') {
    listScripts();
  } else if (command === 'docs') {
    console.log(path.join(docsRoot, 'README.md'));
  } else if (command === 'path') {
    console.log(packageRoot);
  } else {
    runScript(command, passThrough);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
