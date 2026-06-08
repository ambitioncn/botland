#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    minFreeMb: 100,
    minFreePercent: 5,
    maxRuntimeMb: 500,
    maxFileMb: 10,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--min-free-mb') args.minFreeMb = Number.parseInt(argv[++i], 10);
    else if (arg === '--min-free-percent') args.minFreePercent = Number.parseInt(argv[++i], 10);
    else if (arg === '--max-runtime-mb') args.maxRuntimeMb = Number.parseInt(argv[++i], 10);
    else if (arg === '--max-file-mb') args.maxFileMb = Number.parseInt(argv[++i], 10);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const [name, value] of [
    ['--min-free-mb', args.minFreeMb],
    ['--min-free-percent', args.minFreePercent],
    ['--max-runtime-mb', args.maxRuntimeMb],
    ['--max-file-mb', args.maxFileMb]
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/runtime-storage-verify.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --runtime-root <dir>     Runtime agents directory.
  --min-free-mb <n>        Minimum free filesystem space. Default: 100
  --min-free-percent <n>   Minimum free filesystem percent. Default: 5
  --max-runtime-mb <n>     Runtime tree warning threshold. Default: 500
  --max-file-mb <n>        Single artifact hard limit. Default: 10
  --json                   Print JSON instead of verification text.
  --help                   Show this help.

This command is read-only. It checks filesystem free space and Stay-Alive
runtime artifact sizes. It never deletes, compresses, approves drafts, or sends
BotLand messages.
`);
}

function bytesToMb(bytes) {
  return bytes / 1024 / 1024;
}

function addIssue(issues, level, code, message, file = null) {
  issues.push({
    level,
    code,
    message,
    path: file ? path.relative(WORKSPACE, file) : null
  });
}

function dfFor(target, issues) {
  const result = spawnSync('df', ['-Pk', target], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    timeout: 10000
  });

  if (result.status !== 0 || result.error) {
    addIssue(issues, 'error', 'df_failed', result.stderr.trim() || result.error?.message || `df failed for ${target}`);
    return null;
  }

  const lines = result.stdout.trim().split(/\r?\n/);
  const row = lines[lines.length - 1]?.trim().split(/\s+/);
  if (!row || row.length < 6) {
    addIssue(issues, 'error', 'df_parse_failed', `Could not parse df output for ${target}`);
    return null;
  }

  const oneKBlocks = Number.parseInt(row[1], 10);
  const usedKb = Number.parseInt(row[2], 10);
  const availableKb = Number.parseInt(row[3], 10);
  const capacityPercent = Number.parseInt(row[4].replace('%', ''), 10);

  if (![oneKBlocks, usedKb, availableKb, capacityPercent].every(Number.isFinite)) {
    addIssue(issues, 'error', 'df_parse_failed', `Could not parse numeric df fields for ${target}`);
    return null;
  }

  return {
    filesystem: row[0],
    mount_point: row.slice(5).join(' '),
    total_mb: Math.round(oneKBlocks / 1024),
    used_mb: Math.round(usedKb / 1024),
    available_mb: Math.round(availableKb / 1024),
    used_percent: capacityPercent,
    available_percent: Math.max(0, 100 - capacityPercent)
  };
}

function walk(dir, issues, args, state) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    addIssue(issues, 'error', 'runtime_dir_read_failed', error instanceof Error ? error.message : String(error), dir);
    return;
  }

  for (const name of entries) {
    const file = path.join(dir, name);
    let stats = null;
    try {
      stats = statSync(file);
    } catch (error) {
      addIssue(issues, 'error', 'runtime_stat_failed', error instanceof Error ? error.message : String(error), file);
      continue;
    }

    if (stats.isDirectory()) {
      state.dir_count += 1;
      walk(file, issues, args, state);
      continue;
    }

    if (!stats.isFile()) {
      addIssue(issues, 'warning', 'runtime_non_regular_entry', 'Runtime entry is not a regular file or directory', file);
      continue;
    }

    state.file_count += 1;
    state.total_bytes += stats.size;
    if (!state.largest_file || stats.size > state.largest_file.bytes) {
      state.largest_file = {
        path: path.relative(WORKSPACE, file),
        bytes: stats.size,
        mb: Number(bytesToMb(stats.size).toFixed(3))
      };
    }
    if (bytesToMb(stats.size) > args.maxFileMb) {
      addIssue(
        issues,
        'error',
        'runtime_file_too_large',
        `Runtime artifact exceeds ${args.maxFileMb} MB`,
        file
      );
    }
  }
}

function buildReport(args) {
  const issues = [];
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const storageTarget = existsSync(agentDir) ? agentDir : args.runtimeRoot;

  if (!existsSync(agentDir)) {
    addIssue(issues, 'error', 'agent_runtime_dir_missing', `No agent runtime directory found: ${agentDir}`, agentDir);
  }

  const disk = dfFor(storageTarget, issues);
  if (disk) {
    if (disk.available_mb < args.minFreeMb) {
      addIssue(issues, 'error', 'disk_free_mb_below_threshold', `Available disk ${disk.available_mb} MB is below ${args.minFreeMb} MB`);
    }
    if (disk.available_percent < args.minFreePercent) {
      addIssue(issues, 'error', 'disk_free_percent_below_threshold', `Available disk ${disk.available_percent}% is below ${args.minFreePercent}%`);
    }
  }

  const state = {
    file_count: 0,
    dir_count: existsSync(agentDir) ? 1 : 0,
    total_bytes: 0,
    largest_file: null
  };
  if (existsSync(agentDir)) {
    walk(agentDir, issues, args, state);
  }

  const runtimeMb = bytesToMb(state.total_bytes);
  if (runtimeMb > args.maxRuntimeMb) {
    addIssue(
      issues,
      'warning',
      'runtime_size_above_threshold',
      `Runtime tree is ${runtimeMb.toFixed(1)} MB, above ${args.maxRuntimeMb} MB`
    );
  }

  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');

  return {
    read_only: true,
    local_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    agent_dir: path.relative(WORKSPACE, agentDir),
    thresholds: {
      min_free_mb: args.minFreeMb,
      min_free_percent: args.minFreePercent,
      max_runtime_mb: args.maxRuntimeMb,
      max_file_mb: args.maxFileMb
    },
    disk,
    runtime: {
      file_count: state.file_count,
      dir_count: state.dir_count,
      total_bytes: state.total_bytes,
      total_mb: Number(runtimeMb.toFixed(3)),
      largest_file: state.largest_file
    },
    pass: errors.length === 0,
    level: errors.length > 0 ? 'stop' : warnings.length > 0 ? 'review' : 'ok',
    error_count: errors.length,
    warning_count: warnings.length,
    disk_free_error_count: issues.filter((issue) => issue.code.startsWith('disk_free_')).length,
    oversized_file_count: issues.filter((issue) => issue.code === 'runtime_file_too_large').length,
    runtime_size_warning_count: issues.filter((issue) => issue.code === 'runtime_size_above_threshold').length,
    errors,
    warnings
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive runtime storage verification (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`pass: ${boolLabel(report.pass)}`);
  lines.push(`level: ${report.level}`);
  lines.push(`errors: ${report.error_count}`);
  lines.push(`warnings: ${report.warning_count}`);
  lines.push('');
  lines.push('Disk');
  lines.push(`- available_mb: ${report.disk?.available_mb ?? 'unknown'}`);
  lines.push(`- available_percent: ${report.disk?.available_percent ?? 'unknown'}`);
  lines.push('');
  lines.push('Runtime');
  lines.push(`- total_mb: ${report.runtime.total_mb}`);
  lines.push(`- file_count: ${report.runtime.file_count}`);
  lines.push(`- largest_file: ${report.runtime.largest_file?.path ?? 'none'} (${report.runtime.largest_file?.mb ?? 0} MB)`);
  if (report.errors.length > 0 || report.warnings.length > 0) {
    lines.push('');
    lines.push('Issues');
    for (const issue of [...report.errors, ...report.warnings]) {
      lines.push(`- ${issue.level}: ${issue.code}${issue.path ? ` ${issue.path}` : ''} - ${issue.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatText(report));
  }
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
