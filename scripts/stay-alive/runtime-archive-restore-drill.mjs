#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    archiveRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'archives'),
    tempRoot: null,
    manifest: null,
    keepTemp: false,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--archive-root') args.archiveRoot = path.resolve(argv[++i]);
    else if (arg === '--temp-root') args.tempRoot = path.resolve(argv[++i]);
    else if (arg === '--manifest') args.manifest = path.resolve(argv[++i]);
    else if (arg === '--keep-temp') args.keepTemp = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.tempRoot) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
    args.tempRoot = path.join(WORKSPACE, 'tmp', 'stay-alive-restore-drill', stamp);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/runtime-archive-restore-drill.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory
  --archive-root <dir>  Archive root
  --manifest <file>     Specific archive manifest
  --temp-root <dir>     Temporary restore runtime root
  --keep-temp           Keep temporary restore directory
  --json                Print JSON
  --help                Show this help

Restores archive manifest contents into a temporary runtime only, then runs
read-only verification there. It never moves files back into the live runtime.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function listManifests(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listManifests(file);
    return entry.isFile() && entry.name === 'manifest.json' ? [file] : [];
  }).sort().reverse();
}

function latestManifest(args) {
  if (args.manifest) return existsSync(args.manifest) ? args.manifest : null;
  return listManifests(path.join(args.archiveRoot, args.agent))[0] ?? null;
}

function runJson(script, argv, runtimeRoot) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    timeout: 120000
  });
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    parsed = null;
  }
  return {
    command: ['node', script, ...argv].join(' '),
    ok: result.status === 0,
    status: result.status,
    parsed,
    runtime_root: runtimeRoot,
    stderr_preview: String(result.stderr ?? '').slice(0, 1000)
  };
}

function copyBaseState(args, tempAgentDir) {
  mkdirSync(tempAgentDir, { recursive: true });
  const sourceAgentDir = path.join(args.runtimeRoot, args.agent);
  for (const name of ['life_state.json', 'daemon_state.json', 'control_state.json', 'onboarding.json']) {
    const source = path.join(sourceAgentDir, name);
    if (existsSync(source)) cpSync(source, path.join(tempAgentDir, name));
  }
}

function sourceForMovedItem(item) {
  const candidates = [
    item.target,
    item.target_relative ? path.join(WORKSPACE, item.target_relative) : null
  ].filter(Boolean);
  return candidates.find((file) => existsSync(file)) ?? null;
}

function restoreIntoTemp(args, manifestFile) {
  const manifest = readJson(manifestFile);
  const tempAgentDir = path.join(args.tempRoot, args.agent);
  copyBaseState(args, tempAgentDir);
  const restored = [];
  const missing = [];
  for (const item of Array.isArray(manifest.moved) ? manifest.moved : []) {
    const source = sourceForMovedItem(item);
    if (!source) {
      missing.push(item.target_relative ?? item.target ?? item.source_relative ?? 'unknown');
      continue;
    }
    const dirName = item.dir_name ?? path.basename(path.dirname(item.source_relative ?? source));
    const fileName = path.basename(item.source_relative ?? source);
    const target = path.join(tempAgentDir, dirName, fileName);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target);
    restored.push({
      dir_name: dirName,
      source: path.relative(WORKSPACE, source),
      temp_target: path.relative(WORKSPACE, target)
    });
  }
  return { manifest, restored, missing, tempAgentDir };
}

function buildReport(args) {
  const manifestFile = latestManifest(args);
  if (!manifestFile) {
    return {
      read_only: true,
      external_write: false,
      botland_send: false,
      generated_at: new Date().toISOString(),
      agent_id: args.agent,
      drill_status: 'no_manifest',
      pass: true,
      level: 'ok',
      temp_root: args.tempRoot,
      note: 'No archive manifest exists yet; restore drill is a no-op.'
    };
  }
  const restored = restoreIntoTemp(args, manifestFile);
  const checks = [
    runJson('scripts/stay-alive/artifact-inventory.mjs', ['--agent', args.agent, '--runtime-root', args.tempRoot, '--json'], args.tempRoot),
    runJson('scripts/stay-alive/run-verify.mjs', ['--agent', args.agent, '--runtime-root', args.tempRoot, '--limit', '50', '--json'], args.tempRoot)
  ];
  const pass = restored.missing.length === 0 && checks.every((check) => check.ok && (check.parsed?.pass ?? true) !== false);
  if (!args.keepTemp) rmSync(args.tempRoot, { recursive: true, force: true });
  return {
    read_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    drill_status: pass ? 'pass' : 'review',
    pass,
    level: pass ? 'ok' : 'review',
    manifest_path: path.relative(WORKSPACE, manifestFile),
    manifest_policy_version: restored.manifest.policy_version ?? null,
    moved_count: restored.manifest.moved_count ?? restored.restored.length,
    restored_count: restored.restored.length,
    missing_count: restored.missing.length,
    missing: restored.missing,
    temp_root: args.tempRoot,
    temp_kept: args.keepTemp,
    checks,
    safety: {
      live_runtime_mutated: false,
      restore_to_live_performed: false,
      delete_performed: false
    }
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive archive restore drill (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `status: ${report.drill_status}`,
    `pass: ${report.pass ? 'yes' : 'no'}`,
    `manifest: ${report.manifest_path ?? 'none'}`,
    `restored: ${report.restored_count ?? 0}`,
    `missing: ${report.missing_count ?? 0}`,
    `temp_root: ${report.temp_root}${report.temp_kept ? ' (kept)' : ' (removed)'}`,
    'live_runtime_mutated: no'
  ];
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
