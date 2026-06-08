#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

const DURABLE_DIRS = new Set([
  'actions',
  'agency_journal',
  'self_discovery_growth',
  'growth_continuity',
  'growth_apply',
  'durable_becoming',
  'growth_proposal_applications',
  'self_model_versions',
  'desire_state_machine',
  'real_interaction_smoke_loops',
  'trace_reviews',
  'planner_patches',
  'memory_updates',
  'memory_sync',
  'relationship_updates',
  'relationship_promotions',
  'commitment_updates',
  'commitment_promotions',
  'commitment_lifecycle',
  'desire_updates',
  'desire_promotions',
  'desire_lifecycle',
  'memory_backend_json',
  'memory_backend_sqlite'
]);

const ARCHIVE_POLICIES = {
  runs: { keep: 360, minAgeDays: 14, reason: 'cycle evidence already summarized into durable proposals/memory over time' },
  checkpoints: { keep: 120, minAgeDays: 14, reason: 'checkpoint history is sampled evidence; newest window remains live' },
  proposal_actions: { keep: 240, minAgeDays: 30, reason: 'proposal governance ledger remains useful but old local actions can be archived after review' },
  proposal_batches: { keep: 80, minAgeDays: 30, reason: 'batch packets are derived operator views once proposal actions are recorded' },
  action_outcomes: { keep: 120, minAgeDays: 30, reason: 'outcome ledgers are useful feedback evidence; archive only after a larger live window' },
  event_wakeup: { keep: 120, minAgeDays: 14, reason: 'event wakeup ledgers are operational traces once daemon state has advanced' },
  botland_daemon_watchdog: { keep: 120, minAgeDays: 14, reason: 'daemon watchdog ledgers are operational traces for bridge self-healing' },
  service_failure_inspections: { keep: 80, minAgeDays: 30, reason: 'failure inspections are operational evidence; newest incident window remains live' },
  service_failure_recoveries: { keep: 80, minAgeDays: 30, reason: 'reset acknowledgements remain live for recent failed-service audit only' }
};

const TRASH_POLICIES = {
  proposal_batches: { keep: 20, minAgeDays: 60, reason: 'derived packet view; proposal_actions are the authoritative ledger' },
  event_wakeup: { keep: 40, minAgeDays: 60, reason: 'derived wakeup trace once daemon processed_event_ids and runs are retained' },
  botland_daemon_watchdog: { keep: 40, minAgeDays: 60, reason: 'derived watchdog trace once daemon health has stayed stable' }
};

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    archiveRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'archives'),
    trashRoot: path.join(os.homedir(), '.trash', 'stay-alive-runtime-hygiene'),
    confirmArchive: null,
    confirmTrash: null,
    includeTrashCandidates: false,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--archive-root') args.archiveRoot = path.resolve(argv[++i]);
    else if (arg === '--trash-root') args.trashRoot = path.resolve(argv[++i]);
    else if (arg === '--confirm-archive') args.confirmArchive = argv[++i];
    else if (arg === '--confirm-trash') args.confirmTrash = argv[++i];
    else if (arg === '--include-trash-candidates') args.includeTrashCandidates = true;
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
  console.log(`Usage: node scripts/stay-alive/runtime-hygiene.mjs [options]

Options:
  --agent <id>                         Agent id. Default: badclaw
  --runtime-root <dir>                 Runtime agents directory.
  --archive-root <dir>                 Archive root. Default: runtime/stay-alive/archives
  --trash-root <dir>                   Recoverable trash root. Default: ~/.trash/stay-alive-runtime-hygiene
  --include-trash-candidates           Also classify low-value derived artifacts that may move to trash.
  --confirm-archive ARCHIVE_RUNTIME_HYGIENE
                                       Move archive candidates to archiveRoot.
  --confirm-trash TRASH_RUNTIME_HYGIENE
                                       Move trash candidates to trashRoot. Requires --include-trash-candidates.
  --json                               Print JSON instead of text.
  --help                               Show this help.

Default mode is dry-run. This command classifies Stay-Alive runtime state into
durable long-term state, archive candidates, and optional recoverable-trash
candidates. It never deletes files, never mutates life_state.json, and never
sends BotLand messages.
`);
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
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
        mtime_ms: stat.mtimeMs,
        json: readJson(file)
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function classifyDurableDir(agentDir, dirName) {
  const files = listJsonFiles(path.join(agentDir, dirName));
  const promoted = files.filter((item) => {
    const payload = item.json ?? {};
    return Boolean(
      payload.applied_at
      || payload.promoted_at
      || payload.synced_at
      || payload.status === 'successful_send_inspected'
      || payload.status === 'sent'
      || payload.result?.ok === true
    );
  }).length;

  return {
    dir_name: dirName,
    classification: 'long_term_durable',
    file_count: files.length,
    bytes: files.reduce((sum, item) => sum + item.size, 0),
    promoted_or_synced_count: promoted,
    policy: 'keep_live',
    reason: durableReason(dirName)
  };
}

function durableReason(dirName) {
  if (dirName === 'actions') return 'external write audit, approvals, inspections, and local recovery actions are authoritative evidence';
  if (dirName === 'self_discovery_growth') return 'self-question, self-model, relationship-growth, and private experiment contexts are agent becoming evidence';
  if (dirName === 'growth_continuity') return 'growth promotion, self-question lifecycle, experiment execution, identity/desire evolution, and interaction calibration evidence';
  if (dirName === 'growth_apply') return 'growth promotion apply, self-question threads, journal reflections, identity governance, desire lifecycle proposals, and smoke plans are agent becoming evidence';
  if (dirName === 'durable_becoming') return 'durable becoming context records controlled apply readiness, self-model versioning, desire state transitions, growth-memory retrieval, and smoke loops';
  if (dirName === 'growth_proposal_applications') return 'staged growth proposal application ledgers are provenance and rollback evidence before durable memory or state mutation';
  if (dirName === 'self_model_versions') return 'self-model version candidates preserve additive identity patches, provenance, and rollback hints';
  if (dirName === 'desire_state_machine') return 'desire state transition candidates are durable motivation lifecycle evidence';
  if (dirName === 'real_interaction_smoke_loops') return 'real-interaction smoke loop plans preserve no-execute validation routes before live action intentions';
  if (dirName === 'memory_updates' || dirName === 'memory_sync') return 'durable memory contract and sync ledgers are long-term state';
  if (dirName === 'trace_reviews') return 'trace-guided self-improvement reviews are agent learning evidence and heuristic proposal history';
  if (dirName === 'planner_patches') return 'planner self-improvement patch ledgers are bounded local learning state with TTL and rollback conditions';
  if (dirName.includes('relationship')) return 'relationship evolution ledgers are durable social memory evidence';
  if (dirName.includes('commitment')) return 'commitment lifecycle ledgers are durable continuity evidence';
  if (dirName.includes('desire')) return 'desire lifecycle ledgers are durable identity/goal evidence';
  if (dirName.startsWith('memory_backend')) return 'backend-owned storage must be managed by the backend driver, not runtime hygiene';
  return 'authoritative local state ledger';
}

function buildMoveCandidate(args, runId, item, dirName, policy, targetKind) {
  const targetRoot = targetKind === 'trash' ? args.trashRoot : path.join(args.archiveRoot, args.agent);
  const targetId = targetKind === 'trash'
    ? `stay_alive_runtime_trash_${runId}_${args.agent}`
    : `stay_alive_runtime_archive_${runId}_${args.agent}`;
  const target = path.join(targetRoot, targetId, dirName, item.name);
  return {
    dir_name: dirName,
    target_kind: targetKind,
    source: item.file,
    source_relative: path.relative(WORKSPACE, item.file),
    target,
    target_relative: path.relative(WORKSPACE, target),
    bytes: item.size,
    sha256: sha256File(item.file),
    reason: policy.reason,
    created_at: item.json?.created_at ?? item.json?.generated_at ?? item.json?.run_at ?? null
  };
}

function classifyRetentionDir(args, agentDir, runId, dirName, policy, targetKind) {
  const nowMs = Date.now();
  const minAgeMs = policy.minAgeDays * 24 * 60 * 60 * 1000;
  const files = listJsonFiles(path.join(agentDir, dirName));
  const afterKeep = files.slice(policy.keep);
  const candidates = afterKeep
    .filter((item) => nowMs - item.mtime_ms >= minAgeMs)
    .map((item) => buildMoveCandidate(args, runId, item, dirName, policy, targetKind));

  return {
    dir_name: dirName,
    classification: targetKind === 'trash' ? 'recoverable_trash_candidate' : 'archive_candidate',
    total_json_files: files.length,
    keep_count: policy.keep,
    min_age_days: policy.minAgeDays,
    candidate_count: candidates.length,
    candidate_bytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
    skipped_newest_or_young_count: files.length - candidates.length,
    reason: policy.reason,
    candidates
  };
}

function buildPlan(args) {
  const now = new Date();
  const runId = stamp(now);
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const durable = [...DURABLE_DIRS].map((dirName) => classifyDurableDir(agentDir, dirName));
  const archive = Object.entries(ARCHIVE_POLICIES).map(([dirName, policy]) => (
    classifyRetentionDir(args, agentDir, runId, dirName, policy, 'archive')
  ));
  const trash = args.includeTrashCandidates
    ? Object.entries(TRASH_POLICIES).map(([dirName, policy]) => classifyRetentionDir(args, agentDir, runId, dirName, policy, 'trash'))
    : [];
  const archiveCandidates = archive.flatMap((entry) => entry.candidates);
  const trashCandidates = trash.flatMap((entry) => entry.candidates);

  return {
    local_only: true,
    external_write: false,
    botland_send: false,
    generated_at: now.toISOString(),
    operation_id: runId,
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    agent_dir: path.relative(WORKSPACE, agentDir),
    dry_run: args.confirmArchive !== 'ARCHIVE_RUNTIME_HYGIENE' && args.confirmTrash !== 'TRASH_RUNTIME_HYGIENE',
    archive_confirm_required: 'ARCHIVE_RUNTIME_HYGIENE',
    trash_confirm_required: 'TRASH_RUNTIME_HYGIENE',
    include_trash_candidates: args.includeTrashCandidates,
    policy_version: 'stay_alive.runtime_hygiene.v1',
    policy: {
      long_term_durable_dirs: [...DURABLE_DIRS],
      archive_policies: ARCHIVE_POLICIES,
      trash_policies: TRASH_POLICIES
    },
    long_term_durable: durable,
    archive_plan: archive,
    trash_plan: trash,
    archive_candidate_count: archiveCandidates.length,
    archive_candidate_bytes: archiveCandidates.reduce((sum, item) => sum + item.bytes, 0),
    trash_candidate_count: trashCandidates.length,
    trash_candidate_bytes: trashCandidates.reduce((sum, item) => sum + item.bytes, 0),
    candidates: {
      archive: archiveCandidates,
      trash: trashCandidates
    }
  };
}

function applyMoves(plan, candidates, manifestRoot, manifestName, targetKind) {
  const moved = [];
  for (const candidate of candidates) {
    mkdirSync(path.dirname(candidate.target), { recursive: true });
    renameSync(candidate.source, candidate.target);
    moved.push({
      ...candidate,
      moved: true
    });
  }

  const manifest = {
    local_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    policy_version: plan.policy_version,
    agent_id: plan.agent_id,
    target_kind: targetKind,
    moved_count: moved.length,
    moved
  };
  mkdirSync(manifestRoot, { recursive: true });
  const manifestPath = path.join(manifestRoot, manifestName);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    moved_count: moved.length,
    manifest_path: path.relative(WORKSPACE, manifestPath),
    moved
  };
}

function applyPlan(args, plan) {
  const runId = plan.operation_id;
  const applied = {};

  if (args.confirmArchive === 'ARCHIVE_RUNTIME_HYGIENE') {
    const manifestRoot = path.join(args.archiveRoot, args.agent, `stay_alive_runtime_archive_${runId}_${args.agent}`);
    applied.archive = applyMoves(plan, plan.candidates.archive, manifestRoot, 'manifest.json', 'archive');
  }

  if (args.confirmTrash === 'TRASH_RUNTIME_HYGIENE') {
    if (!args.includeTrashCandidates) {
      throw new Error('--confirm-trash requires --include-trash-candidates');
    }
    const manifestRoot = path.join(args.trashRoot, `stay_alive_runtime_trash_${runId}_${args.agent}`);
    applied.trash = applyMoves(plan, plan.candidates.trash, manifestRoot, 'manifest.json', 'trash');
  }

  return {
    ...plan,
    dry_run: Object.keys(applied).length === 0,
    applied
  };
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(3);
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive runtime hygiene (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`dry_run: ${report.dry_run ? 'yes' : 'no'}`);
  lines.push(`policy: ${report.policy_version}`);
  lines.push('');
  lines.push('Long-term durable state');
  for (const item of report.long_term_durable) {
    lines.push(`- ${item.dir_name}: keep_live files=${item.file_count} promoted_or_synced=${item.promoted_or_synced_count} bytes=${mb(item.bytes)} MB`);
  }
  lines.push('');
  lines.push('Archive plan');
  lines.push(`- candidates: ${report.archive_candidate_count}`);
  lines.push(`- bytes: ${report.archive_candidate_bytes} (${mb(report.archive_candidate_bytes)} MB)`);
  for (const item of report.archive_plan) {
    lines.push(`- ${item.dir_name}: total=${item.total_json_files} keep=${item.keep_count} min_age_days=${item.min_age_days} eligible=${item.candidate_count}`);
  }
  if (report.include_trash_candidates) {
    lines.push('');
    lines.push('Recoverable trash plan');
    lines.push(`- candidates: ${report.trash_candidate_count}`);
    lines.push(`- bytes: ${report.trash_candidate_bytes} (${mb(report.trash_candidate_bytes)} MB)`);
    for (const item of report.trash_plan) {
      lines.push(`- ${item.dir_name}: total=${item.total_json_files} keep=${item.keep_count} min_age_days=${item.min_age_days} eligible=${item.candidate_count}`);
    }
  }
  if (report.applied?.archive) lines.push(`archive_manifest: ${report.applied.archive.manifest_path}`);
  if (report.applied?.trash) lines.push(`trash_manifest: ${report.applied.trash.manifest_path}`);
  if (report.dry_run) {
    lines.push('');
    lines.push(`To archive: node scripts/stay-alive/runtime-hygiene.mjs --agent ${report.agent_id} --confirm-archive ARCHIVE_RUNTIME_HYGIENE`);
    lines.push(`To classify trash candidates: add --include-trash-candidates; to move them: --confirm-trash TRASH_RUNTIME_HYGIENE`);
  }
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildPlan(args);
  const report = applyPlan(args, plan);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
