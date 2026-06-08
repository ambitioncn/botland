#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();
const DEFAULT_DIRS = ['runs', 'checkpoints'];

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    archiveRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'archives'),
    keepRuns: 240,
    keepCheckpoints: 80,
    minAgeDays: 7,
    dirs: DEFAULT_DIRS,
    confirmCompact: null,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--archive-root') args.archiveRoot = path.resolve(argv[++i]);
    else if (arg === '--keep-runs') args.keepRuns = Number.parseInt(argv[++i], 10);
    else if (arg === '--keep-checkpoints') args.keepCheckpoints = Number.parseInt(argv[++i], 10);
    else if (arg === '--min-age-days') args.minAgeDays = Number.parseInt(argv[++i], 10);
    else if (arg === '--dirs') args.dirs = argv[++i].split(',').map((item) => item.trim()).filter(Boolean);
    else if (arg === '--confirm-compact') args.confirmCompact = argv[++i];
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const [name, value] of [
    ['--keep-runs', args.keepRuns],
    ['--keep-checkpoints', args.keepCheckpoints],
    ['--min-age-days', args.minAgeDays]
  ]) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }

  for (const dir of args.dirs) {
    if (!DEFAULT_DIRS.includes(dir)) {
      throw new Error(`Unsupported compaction dir "${dir}". Supported dirs: ${DEFAULT_DIRS.join(', ')}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/runtime-compact.mjs [options]

Options:
  --agent <id>                         Agent id. Default: badclaw
  --runtime-root <dir>                 Runtime agents directory.
  --archive-root <dir>                 Archive root. Default: runtime/stay-alive/archives
  --keep-runs <n>                      Newest run artifacts to keep. Default: 240
  --keep-checkpoints <n>               Newest checkpoint artifacts to keep. Default: 80
  --min-age-days <n>                   Do not archive newer files. Default: 7
  --dirs <runs,checkpoints>            Directories to compact. Default: runs,checkpoints
  --confirm-compact COMPACT_RUNTIME    Move eligible files into archiveRoot.
  --json                               Print JSON instead of text.
  --help                               Show this help.

Default mode is dry-run. Confirmed mode only moves local JSON artifacts into a
timestamped archive directory and writes a manifest; it never deletes files and
never sends BotLand messages.
`);
}

function stampForFilename(date) {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '');
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(dir, name);
      const stat = statSync(file);
      return {
        name,
        file,
        size: stat.size,
        mtime_ms: stat.mtimeMs
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function thresholdFor(args, dir) {
  return dir === 'runs' ? args.keepRuns : args.keepCheckpoints;
}

function buildPlan(args) {
  const now = new Date();
  const nowMs = now.getTime();
  const minAgeMs = args.minAgeDays * 24 * 60 * 60 * 1000;
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const archiveId = `stay_alive_runtime_archive_${stampForFilename(now)}_${args.agent}`;
  const archiveDir = path.join(args.archiveRoot, args.agent, archiveId);
  const directories = [];
  const candidates = [];

  for (const dirName of args.dirs) {
    const sourceDir = path.join(agentDir, dirName);
    const files = listJsonFiles(sourceDir);
    const keepCount = thresholdFor(args, dirName);
    const eligible = files.slice(keepCount).filter((file) => nowMs - file.mtime_ms >= minAgeMs);
    const skippedYoung = files.slice(keepCount).length - eligible.length;
    const dirCandidates = eligible.map((file) => ({
      dir_name: dirName,
      source: file.file,
      source_relative: path.relative(WORKSPACE, file.file),
      archive: path.join(archiveDir, dirName, file.name),
      archive_relative: path.relative(WORKSPACE, path.join(archiveDir, dirName, file.name)),
      bytes: file.size,
      sha256: sha256File(file.file)
    }));

    directories.push({
      dir_name: dirName,
      source_dir: path.relative(WORKSPACE, sourceDir),
      total_json_files: files.length,
      keep_count: keepCount,
      eligible_count: dirCandidates.length,
      skipped_young_count: skippedYoung
    });
    candidates.push(...dirCandidates);
  }

  return {
    local_only: true,
    external_write: false,
    botland_send: false,
    generated_at: now.toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    archive_root: args.archiveRoot,
    archive_id: archiveId,
    archive_dir: path.relative(WORKSPACE, archiveDir),
    dry_run: args.confirmCompact !== 'COMPACT_RUNTIME',
    confirm_required: 'COMPACT_RUNTIME',
    policy: {
      dirs: args.dirs,
      keep_runs: args.keepRuns,
      keep_checkpoints: args.keepCheckpoints,
      min_age_days: args.minAgeDays
    },
    directories,
    candidate_count: candidates.length,
    candidate_bytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
    candidates
  };
}

function applyPlan(plan) {
  const moved = [];
  for (const candidate of plan.candidates) {
    mkdirSync(path.dirname(candidate.archive), { recursive: true });
    renameSync(candidate.source, candidate.archive);
    moved.push({
      ...candidate,
      moved: true
    });
  }

  const manifest = {
    ...plan,
    dry_run: false,
    moved_count: moved.length,
    moved
  };
  const manifestPath = path.join(WORKSPACE, plan.archive_dir, 'manifest.json');
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    ...manifest,
    manifest_path: path.relative(WORKSPACE, manifestPath)
  };
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(3);
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive runtime compaction (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`dry_run: ${report.dry_run ? 'yes' : 'no'}`);
  lines.push(`archive_dir: ${report.archive_dir}`);
  lines.push('');
  lines.push('Policy');
  lines.push(`- dirs: ${report.policy.dirs.join(',')}`);
  lines.push(`- keep_runs: ${report.policy.keep_runs}`);
  lines.push(`- keep_checkpoints: ${report.policy.keep_checkpoints}`);
  lines.push(`- min_age_days: ${report.policy.min_age_days}`);
  lines.push('');
  lines.push('Plan');
  lines.push(`- candidates: ${report.candidate_count}`);
  lines.push(`- bytes: ${report.candidate_bytes} (${mb(report.candidate_bytes)} MB)`);
  if (report.moved_count !== undefined) lines.push(`- moved: ${report.moved_count}`);
  if (report.manifest_path) lines.push(`- manifest: ${report.manifest_path}`);
  lines.push('');
  lines.push('Directories');
  for (const dir of report.directories) {
    lines.push(`- ${dir.dir_name}: total=${dir.total_json_files} keep=${dir.keep_count} eligible=${dir.eligible_count} skipped_young=${dir.skipped_young_count}`);
  }
  if (report.dry_run && report.candidate_count > 0) {
    lines.push('');
    lines.push(`To apply: node scripts/stay-alive/runtime-compact.mjs --agent ${report.agent_id} --confirm-compact COMPACT_RUNTIME`);
  }
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildPlan(args);
  const report = plan.dry_run ? plan : applyPlan(plan);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
