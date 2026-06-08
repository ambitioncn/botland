#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    archiveRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'archives'),
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--archive-root') args.archiveRoot = path.resolve(argv[++i]);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/runtime-archive-viewer.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --archive-root <dir>  Archive root. Default: runtime/stay-alive/archives
  --json                Print JSON instead of text.
  --help                Show this help.

This command is read-only. It indexes runtime hygiene archive manifests, builds
restore verification hints, and reports live storage trend counters. It never
moves, deletes, restores, or mutates runtime files.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function listManifestFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listManifestFiles(file);
    return entry.isFile() && entry.name === 'manifest.json' ? [file] : [];
  }).sort().reverse();
}

function listJsonCount(dir) {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = listJsonCount(file);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files += 1;
      bytes += readFileSync(file).byteLength;
    }
  }
  return { files, bytes };
}

function mb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(3));
}

function buildReport(args) {
  const agentArchiveRoot = path.join(args.archiveRoot, args.agent);
  const manifests = listManifestFiles(agentArchiveRoot).map((file) => {
    const manifest = readJson(file);
    const moved = Array.isArray(manifest.moved) ? manifest.moved : [];
    return {
      manifest_path: path.relative(WORKSPACE, file),
      generated_at: manifest.generated_at ?? null,
      policy_version: manifest.policy_version ?? null,
      target_kind: manifest.target_kind ?? 'archive',
      moved_count: manifest.moved_count ?? moved.length,
      moved_bytes: moved.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
      dirs: [...new Set(moved.map((item) => item.dir_name).filter(Boolean))],
      restore_verify_command: `node scripts/stay-alive/runtime-archive-viewer.mjs --agent ${args.agent} --json`,
      restore_hint: 'Restore is intentionally manual: verify manifest hashes first, then move selected files back to the matching runtime dir.'
    };
  });
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const liveDirs = ['runs', 'checkpoints', 'proposal_actions', 'proposal_batches', 'action_outcomes', 'event_wakeup'];
  const liveStorage = liveDirs.map((dirName) => {
    const counts = listJsonCount(path.join(agentDir, dirName));
    return {
      dir_name: dirName,
      file_count: counts.files,
      bytes: counts.bytes,
      mb: mb(counts.bytes)
    };
  });
  return {
    read_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    archive_root: args.archiveRoot,
    runtime_root: args.runtimeRoot,
    manifest_count: manifests.length,
    archived_file_count: manifests.reduce((sum, item) => sum + item.moved_count, 0),
    archived_bytes: manifests.reduce((sum, item) => sum + item.moved_bytes, 0),
    archived_mb: mb(manifests.reduce((sum, item) => sum + item.moved_bytes, 0)),
    manifests,
    live_storage: liveStorage,
    storage_trend: {
      live_json_files: liveStorage.reduce((sum, item) => sum + item.file_count, 0),
      live_json_mb: mb(liveStorage.reduce((sum, item) => sum + item.bytes, 0)),
      archive_manifest_count: manifests.length,
      note: 'Trend is a point-in-time local snapshot until scheduled reports write historical snapshots.'
    },
    safety: {
      restore_performed: false,
      delete_performed: false,
      note: 'Viewer only indexes manifests and reports restore hints.'
    }
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive runtime archive viewer (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `manifest_count: ${report.manifest_count}`,
    `archived_files: ${report.archived_file_count}`,
    `archived_mb: ${report.archived_mb}`,
    '',
    'Live Storage'
  ];
  for (const item of report.live_storage) {
    lines.push(`- ${item.dir_name}: files=${item.file_count} mb=${item.mb}`);
  }
  lines.push('');
  lines.push('Recent Manifests');
  for (const manifest of report.manifests.slice(0, 10)) {
    lines.push(`- ${manifest.manifest_path}: moved=${manifest.moved_count} mb=${mb(manifest.moved_bytes)} dirs=${manifest.dirs.join(',') || 'n/a'}`);
  }
  lines.push('');
  lines.push('restore_performed: no');
  lines.push('delete_performed: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
