#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();
const REQUIRED_FILES = new Set(['life_state.json', 'daemon_state.json']);
const OPTIONAL_FILES = new Set(['control_state.json', 'onboarding.json']);
const KNOWN_DIRS = new Set(['runs', 'actions', 'checkpoints', 'proposal_actions', 'proposal_batches', 'local_governance', 'lifecycle_evolution', 'action_outcomes', 'trace_reviews', 'planner_patches', 'agency_journal', 'self_discovery_growth', 'growth_continuity', 'growth_apply', 'durable_becoming', 'growth_proposal_applications', 'self_model_versions', 'desire_state_machine', 'real_interaction_smoke_loops', 'live_identity_probes', 'botland_auth_readiness', 'botland_auth_configure', 'profile_drift_reviews', 'profile_update_applications', 'memory_updates', 'relationship_updates', 'relationship_promotions', 'commitment_updates', 'commitment_promotions', 'commitment_lifecycle', 'desire_updates', 'desire_promotions', 'desire_lifecycle', 'event_wakeup', 'botland_daemon_watchdog', 'memory_sync', 'memory_backend_json', 'memory_backend_sqlite', 'service_failure_inspections', 'service_failure_recoveries']);
const JSON_ONLY_DIRS = new Set(['runs', 'actions', 'checkpoints', 'proposal_actions', 'proposal_batches', 'local_governance', 'lifecycle_evolution', 'action_outcomes', 'trace_reviews', 'planner_patches', 'agency_journal', 'self_discovery_growth', 'growth_continuity', 'growth_apply', 'durable_becoming', 'growth_proposal_applications', 'self_model_versions', 'desire_state_machine', 'real_interaction_smoke_loops', 'live_identity_probes', 'botland_auth_readiness', 'botland_auth_configure', 'profile_drift_reviews', 'profile_update_applications', 'memory_updates', 'relationship_updates', 'relationship_promotions', 'commitment_updates', 'commitment_promotions', 'commitment_lifecycle', 'desire_updates', 'desire_promotions', 'desire_lifecycle', 'event_wakeup', 'botland_daemon_watchdog', 'memory_sync', 'memory_backend_json', 'service_failure_inspections', 'service_failure_recoveries']);

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
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
  console.log(`Usage: node scripts/stay-alive/artifact-inventory.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --json                Print JSON instead of inventory text.
  --help                Show this help.

This command is read-only. It inventories the local Stay-Alive runtime artifact
tree and reports unknown files, unknown directories, non-JSON artifacts, and
unparseable JSON. It never approves drafts, dismisses drafts, or sends BotLand
messages.
`);
}

function addIssue(issues, level, code, message, file = null) {
  issues.push({
    level,
    code,
    message,
    path: file ? path.relative(WORKSPACE, file) : null
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function isIgnoredEntry(name) {
  return name === '.DS_Store' || name.endsWith('~') || name.endsWith('.swp') || name.endsWith('.tmp');
}

function inspectJsonFile(file, issues) {
  try {
    readJson(file);
    return true;
  } catch (error) {
    addIssue(
      issues,
      'error',
      'json_parse_failed',
      error instanceof Error ? error.message : String(error),
      file
    );
    return false;
  }
}

function listDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => {
    const file = path.join(dir, name);
    return { name, file, stat: statSync(file) };
  });
}

function inspectKnownDir(agentDir, dirName, issues) {
  const dir = path.join(agentDir, dirName);
  const files = [];
  const dirs = [];
  let jsonParseErrorCount = 0;

  if (!existsSync(dir)) {
    return {
      dir_name: dirName,
      path: path.relative(WORKSPACE, dir),
      exists: false,
      file_count: 0,
      json_file_count: 0,
      non_json_file_count: 0,
      subdir_count: 0,
      json_parse_error_count: 0
    };
  }

  for (const entry of listDir(dir)) {
    if (entry.stat.isDirectory()) {
      dirs.push(entry.file);
      addIssue(issues, 'error', 'unexpected_subdir', 'Artifact directories must not contain nested directories', entry.file);
      continue;
    }

    if (!entry.stat.isFile()) {
      addIssue(issues, 'error', 'unexpected_artifact_entry', 'Artifact directory entry must be a regular file', entry.file);
      continue;
    }

    files.push(entry.file);
    if (!JSON_ONLY_DIRS.has(dirName)) {
      continue;
    }

    if (isIgnoredEntry(entry.name) || !entry.name.endsWith('.json')) {
      addIssue(issues, 'error', 'non_json_artifact_file', 'Artifact directory contains a non-JSON file', entry.file);
      continue;
    }

    if (!inspectJsonFile(entry.file, issues)) {
      jsonParseErrorCount += 1;
    }
  }

  return {
    dir_name: dirName,
    path: path.relative(WORKSPACE, dir),
    exists: true,
    file_count: files.length,
    json_file_count: files.filter((file) => path.basename(file).endsWith('.json')).length,
    non_json_file_count: files.filter((file) => !path.basename(file).endsWith('.json')).length,
    subdir_count: dirs.length,
    json_parse_error_count: jsonParseErrorCount
  };
}

function inspectTopLevel(args, agentDir, issues) {
  const entries = listDir(agentDir);
  const foundFiles = new Set();
  const foundDirs = new Set();

  if (!existsSync(agentDir)) {
    addIssue(issues, 'error', 'agent_runtime_dir_missing', `No agent runtime directory found: ${agentDir}`);
    return { foundFiles, foundDirs };
  }

  for (const entry of entries) {
    if (entry.stat.isDirectory()) {
      foundDirs.add(entry.name);
      if (!KNOWN_DIRS.has(entry.name)) {
        addIssue(issues, 'error', 'unknown_runtime_dir', 'Unknown top-level runtime directory', entry.file);
      }
      continue;
    }

    if (!entry.stat.isFile()) {
      addIssue(issues, 'error', 'unknown_runtime_entry', 'Top-level runtime entry must be a regular file or known directory', entry.file);
      continue;
    }

    foundFiles.add(entry.name);
    if (!REQUIRED_FILES.has(entry.name) && !OPTIONAL_FILES.has(entry.name)) {
      addIssue(issues, 'error', 'unknown_runtime_file', 'Unknown top-level runtime file', entry.file);
      continue;
    }

    if (!entry.name.endsWith('.json')) {
      addIssue(issues, 'error', 'non_json_runtime_file', 'Known runtime file must be JSON', entry.file);
      continue;
    }

    inspectJsonFile(entry.file, issues);
  }

  for (const fileName of REQUIRED_FILES) {
    if (!foundFiles.has(fileName)) {
      addIssue(issues, 'error', 'required_runtime_file_missing', `Missing required runtime file: ${fileName}`, path.join(agentDir, fileName));
    }
  }

  if (!foundDirs.has('runs')) {
    addIssue(issues, 'error', 'runs_dir_missing', 'Missing required runs artifact directory', path.join(agentDir, 'runs'));
  }

  return { foundFiles, foundDirs };
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const issues = [];
  const topLevel = inspectTopLevel(args, agentDir, issues);
  const directories = [...KNOWN_DIRS].map((dirName) => inspectKnownDir(agentDir, dirName, issues));
  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  const directoryCounts = directories.reduce((counts, dir) => {
    counts.file_count += dir.file_count;
    counts.json_file_count += dir.json_file_count;
    counts.non_json_file_count += dir.non_json_file_count;
    counts.subdir_count += dir.subdir_count;
    counts.json_parse_error_count += dir.json_parse_error_count;
    return counts;
  }, {
    file_count: 0,
    json_file_count: 0,
    non_json_file_count: 0,
    subdir_count: 0,
    json_parse_error_count: 0
  });

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    agent_dir: path.relative(WORKSPACE, agentDir),
    expected: {
      required_files: [...REQUIRED_FILES],
      optional_files: [...OPTIONAL_FILES],
      known_dirs: [...KNOWN_DIRS],
      json_only_dirs: [...JSON_ONLY_DIRS]
    },
    pass: errors.length === 0,
    level: errors.length > 0 ? 'stop' : warnings.length > 0 ? 'review' : 'ok',
    error_count: errors.length,
    warning_count: warnings.length,
    unknown_runtime_file_count: issues.filter((issue) => issue.code === 'unknown_runtime_file').length,
    unknown_runtime_dir_count: issues.filter((issue) => issue.code === 'unknown_runtime_dir').length,
    non_json_artifact_file_count: issues.filter((issue) => issue.code === 'non_json_artifact_file').length,
    unexpected_subdir_count: issues.filter((issue) => issue.code === 'unexpected_subdir').length,
    json_parse_error_count: issues.filter((issue) => issue.code === 'json_parse_failed').length,
    required_missing_count: issues.filter((issue) => issue.code === 'required_runtime_file_missing' || issue.code === 'runs_dir_missing').length,
    top_level: {
      files: [...topLevel.foundFiles].sort(),
      dirs: [...topLevel.foundDirs].sort()
    },
    directory_counts: directoryCounts,
    directories,
    errors,
    warnings
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const lines = [];

  lines.push(`Stay-Alive artifact inventory (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only: ${boolLabel(report.read_only)}`);
  lines.push(`agent_dir: ${report.agent_dir}`);
  lines.push('');
  lines.push('Verdict');
  lines.push(`- level: ${report.level}`);
  lines.push(`- pass: ${boolLabel(report.pass)}`);
  lines.push(`- errors: ${report.error_count}`);
  lines.push(`- warnings: ${report.warning_count}`);
  lines.push('');
  lines.push('Counts');
  lines.push(`- files: ${report.directory_counts.file_count}`);
  lines.push(`- json_files: ${report.directory_counts.json_file_count}`);
  lines.push(`- non_json_artifacts: ${report.non_json_artifact_file_count}`);
  lines.push(`- unknown_runtime_files: ${report.unknown_runtime_file_count}`);
  lines.push(`- unknown_runtime_dirs: ${report.unknown_runtime_dir_count}`);
  lines.push(`- unexpected_subdirs: ${report.unexpected_subdir_count}`);
  lines.push(`- json_parse_errors: ${report.json_parse_error_count}`);
  lines.push(`- required_missing: ${report.required_missing_count}`);
  lines.push('');
  lines.push('Directories');
  for (const dir of report.directories) {
    lines.push(`- ${dir.dir_name}: exists=${boolLabel(dir.exists)} files=${dir.file_count} json=${dir.json_file_count} non_json=${dir.non_json_file_count} subdirs=${dir.subdir_count}`);
  }

  if (report.errors.length > 0) {
    lines.push('');
    lines.push('Errors');
    for (const issue of report.errors) {
      lines.push(`- ${issue.code}: ${issue.path ?? 'n/a'} ${issue.message}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const issue of report.warnings) {
      lines.push(`- ${issue.code}: ${issue.path ?? 'n/a'} ${issue.message}`);
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
  if (!report.pass) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
