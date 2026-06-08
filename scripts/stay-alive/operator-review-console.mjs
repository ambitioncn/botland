#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { WORKSPACE } from './proposal-lib.mjs';
import { buildGovernancePlan, runtimeRootArgs } from './proposal-governance-lib.mjs';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    limit: 200,
    format: 'text',
    output: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/operator-review-console.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --limit <n>           Recent proposals/outcomes to scan. Default: 200
  --output <file>       Write an HTML review console snapshot.
  --json                Print JSON instead of text.
  --help                Show this help.

This command is read-only unless --output writes a local HTML snapshot. It
groups proposal governance, duplicate clusters, relationship candidates, memory
sync state, outcome attention, and existing dry-run batch commands. It never
approves, applies, dismisses, promotes, sends, posts, joins, or reports.

It is a boundary facility, not an agency source. Use it to inspect proposal
queues and local ledgers; do not use it to author the agent's desires or
direction.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort()
    .reverse();
}

function preview(text, limit = 180) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function runJson(command, args) {
  const result = spawnSync(process.execPath, [command, ...args], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  const stdout = result.stdout?.trim() ?? '';
  let parsed = null;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    parsed = null;
  }
  return {
    command: [process.execPath, command, ...args].join(' ').replace(process.execPath, 'node'),
    ok: result.status === 0,
    status: result.status,
    parsed,
    stderr_preview: (result.stderr ?? '').trim().slice(0, 500)
  };
}

function memorySyncSummary(agentDir) {
  const updates = listJsonFiles(path.join(agentDir, 'memory_updates')).map((file) => {
    try {
      return { file, json: readJson(file) };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const sync = listJsonFiles(path.join(agentDir, 'memory_sync')).map((file) => {
    try {
      return { file, json: readJson(file) };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const syncedHashes = new Set(sync.map((item) => item.json.proposal_hash ?? item.json.memory_update_hash).filter(Boolean));
  const applied = updates.filter((item) => item.json.applied_at || item.json.status === 'applied');
  const pending = applied.filter((item) => !syncedHashes.has(item.json.proposal_hash ?? path.basename(item.file, '.json')));
  return {
    applied_count: applied.length,
    sync_ledger_count: sync.length,
    pending_sync_count: pending.length,
    pending: pending.slice(0, 10).map((item) => ({
      file: path.relative(WORKSPACE, item.file),
      proposal_hash: item.json.proposal_hash ?? path.basename(item.file, '.json'),
      text_preview: preview(item.json.payload?.text ?? item.json.payload?.value ?? item.json.text)
    })),
    dry_run_command: `node scripts/stay-alive/sync-memory-updates.mjs --agent ${path.basename(agentDir)} --dry-run --json`,
    confirm_command: `node scripts/stay-alive/sync-memory-updates.mjs --agent ${path.basename(agentDir)} --confirm-sync SYNC_MEMORY --json`
  };
}

function relationshipCandidateSummary(plan) {
  return plan.proposals
    .filter((item) => item.kind === 'relationship_update' && ['proposed', 'approved'].includes(item.status))
    .slice(0, 20)
    .map((item) => ({
      proposal_id: item.proposal_id,
      status: item.status,
      lane: item.lane,
      decision: item.decision,
      target: item.target_path ?? item.type ?? 'relationship_candidate',
      duplicate_count: item.duplicate_count,
      text_preview: item.text_preview,
      review_note: item.lane === 'relationship_update_ledger'
        ? 'local ledger only; promotion still requires promote-relationship'
        : item.reason
    }));
}

function outcomeAttention(agentDir) {
  return listJsonFiles(path.join(agentDir, 'action_outcomes')).slice(0, 50).map((file) => {
    try {
      const item = readJson(file);
      const interpretation = item.observation?.feedback_interpretation ?? {};
      return {
        outcome_id: item.outcome_id,
        status: item.outcome_status,
        action_type: item.action_type,
        send_action_id: item.send_action_id,
        signal_strength: interpretation.signal_strength ?? null,
        maturity: interpretation.maturity ?? null,
        stale_attention: interpretation.close_policy?.stale_attention === true,
        close_silence: interpretation.close_policy?.close_silence === true,
        recommended_next: interpretation.recommended_next ?? null,
        path: path.relative(WORKSPACE, file)
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const plan = buildGovernancePlan(args);
  const applyPreview = runJson('scripts/stay-alive/proposal-batch.mjs', [
    '--agent', args.agent,
    '--limit', String(args.limit),
    ...runtimeRootArgs(args.runtimeRoot),
    '--mode', 'apply-local',
    '--max', '10',
    '--dry-run',
    '--json'
  ]);
  const dismissPreview = runJson('scripts/stay-alive/proposal-batch.mjs', [
    '--agent', args.agent,
    '--limit', String(args.limit),
    ...runtimeRootArgs(args.runtimeRoot),
    '--mode', 'dismiss-stale',
    '--max', '10',
    '--dry-run',
    '--json'
  ]);
  const duplicateClusters = plan.groups
    .filter((group) => group.count > 1)
    .slice(0, 20)
    .map((group) => ({
      ...group,
      visible_items: plan.proposals
        .filter((item) => item.group_key === group.group_key)
        .map((item) => ({
          proposal_id: item.proposal_id,
          status: item.status,
          decision: item.decision,
          lane: item.lane,
          superseded: item.superseded,
          text_preview: item.text_preview
        }))
    }));
  return {
    read_only: true,
    facility_class: 'boundary_facility',
    agency_source: false,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    proposal_governance: {
      proposal_count: plan.proposal_count,
      visible_count: plan.visible_count,
      executable_count: plan.executable_count,
      review_count: plan.review_count,
      duplicate_group_count: plan.duplicate_group_count,
      counts_by_decision: plan.counts_by_decision,
      counts_by_lane: plan.counts_by_lane,
      next_commands: plan.next_commands
    },
    duplicate_clusters: duplicateClusters,
    relationship_candidates: relationshipCandidateSummary(plan),
    memory_sync: memorySyncSummary(agentDir),
    outcome_attention: outcomeAttention(agentDir),
    dry_run_previews: {
      apply_local: applyPreview.parsed,
      dismiss_stale: dismissPreview.parsed
    },
    preview_errors: [applyPreview, dismissPreview].filter((item) => !item.ok).map((item) => ({
      command: item.command,
      status: item.status,
      stderr_preview: item.stderr_preview
    })),
    safety: {
      tool_supervised: true,
      direct_mutation_bypass: false,
      note: 'The review console is a boundary facility. It only shows existing tool-supervised commands and local dry-run previews; it must not author agent desires or direction.'
    }
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHtml(report) {
  const rows = (items, cols) => items.length
    ? items.map((item) => `<tr>${cols.map((col) => `<td>${escapeHtml(typeof col === 'function' ? col(item) : item[col])}</td>`).join('')}</tr>`).join('\n')
    : `<tr><td colspan="${cols.length}" class="muted">none</td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stay-Alive Review Console - ${escapeHtml(report.agent_id)}</title>
  <style>
    body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: #f6f7f9; color: #17202a; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    section { background: #fff; border: 1px solid #d8dde5; border-radius: 8px; padding: 14px; margin: 12px 0; }
    h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: 0; }
    h2 { font-size: 16px; margin: 0 0 10px; letter-spacing: 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; vertical-align: top; padding: 8px; border-top: 1px solid #d8dde5; }
    th, .muted { color: #667085; }
    code { display: block; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #d8dde5; border-radius: 6px; padding: 8px; color: #205493; }
  </style>
</head>
<body>
<main>
  <h1>Stay-Alive Review Console</h1>
  <div class="muted">${escapeHtml(report.agent_id)} · ${escapeHtml(report.generated_at)}</div>
  <div class="muted">Boundary facility only · not an agency source</div>
  <section>
    <h2>Proposal Governance</h2>
    <p>visible=${escapeHtml(report.proposal_governance.visible_count)} · executable=${escapeHtml(report.proposal_governance.executable_count)} · duplicate_groups=${escapeHtml(report.proposal_governance.duplicate_group_count)} · manual_review=${escapeHtml(report.proposal_governance.review_count)}</p>
    <code>${escapeHtml(report.proposal_governance.next_commands.dry_run_batch_apply)}</code>
    <code>${escapeHtml(report.proposal_governance.next_commands.dry_run_dismiss_stale)}</code>
  </section>
  <section>
    <h2>Duplicate Clusters</h2>
    <table><thead><tr><th>group</th><th>count</th><th>latest</th><th>target</th></tr></thead><tbody>${rows(report.duplicate_clusters, ['group_key', 'count', 'latest_proposal_id', 'target'])}</tbody></table>
  </section>
  <section>
    <h2>Relationship Candidates</h2>
    <table><thead><tr><th>proposal</th><th>status</th><th>lane</th><th>preview</th></tr></thead><tbody>${rows(report.relationship_candidates, ['proposal_id', 'status', 'lane', 'text_preview'])}</tbody></table>
  </section>
  <section>
    <h2>Memory Sync</h2>
    <p>applied=${escapeHtml(report.memory_sync.applied_count)} · sync_ledgers=${escapeHtml(report.memory_sync.sync_ledger_count)} · pending=${escapeHtml(report.memory_sync.pending_sync_count)}</p>
    <code>${escapeHtml(report.memory_sync.dry_run_command)}</code>
  </section>
  <section>
    <h2>Outcome Attention</h2>
    <table><thead><tr><th>outcome</th><th>status</th><th>signal</th><th>next</th></tr></thead><tbody>${rows(report.outcome_attention.slice(0, 20), ['outcome_id', 'status', 'signal_strength', 'recommended_next'])}</tbody></table>
  </section>
</main>
</body>
</html>`;
}

function formatText(report) {
  const lines = [
    `Stay-Alive operator review console (${report.agent_id})`,
    'facility_class: boundary_facility',
    'agency_source: no',
    `generated_at: ${report.generated_at}`,
    `read_only: yes`,
    '',
    'Proposal Governance',
    `- visible: ${report.proposal_governance.visible_count}`,
    `- executable: ${report.proposal_governance.executable_count}`,
    `- duplicate_groups: ${report.proposal_governance.duplicate_group_count}`,
    `- manual_review: ${report.proposal_governance.review_count}`,
    '',
    'Dry-run preview commands',
    `- apply_local: ${report.proposal_governance.next_commands.dry_run_batch_apply}`,
    `- dismiss_stale: ${report.proposal_governance.next_commands.dry_run_dismiss_stale}`,
    '',
    `relationship_candidates: ${report.relationship_candidates.length}`,
    `memory_pending_sync: ${report.memory_sync.pending_sync_count}`,
    `outcome_attention_items: ${report.outcome_attention.length}`,
    '',
    'external_write: no',
    'botland_send: no',
    'promotion_or_lifecycle_mutation: no'
  ];
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.output) {
    mkdirSync(path.dirname(args.output), { recursive: true });
    writeFileSync(args.output, renderHtml(report));
    report.output_path = path.relative(WORKSPACE, args.output);
  }
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
