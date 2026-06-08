#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    limit: 10,
    draftLimit: null,
    historyLimit: 3,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    checkpointDir: null,
    output: null,
    open: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--draft-limit') args.draftLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--history-limit') args.historyLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--checkpoint-dir') args.checkpointDir = path.resolve(argv[++i]);
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else if (arg === '--open') args.open = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.draftLimit === null) args.draftLimit = Math.max(args.limit, 200);
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
  if (!Number.isInteger(args.draftLimit) || args.draftLimit < 1) throw new Error('--draft-limit must be a positive integer');
  if (!Number.isInteger(args.historyLimit) || args.historyLimit < 1) throw new Error('--history-limit must be a positive integer');
  if (!args.checkpointDir) args.checkpointDir = path.join(args.runtimeRoot, args.agent, 'checkpoints');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/operator-dashboard.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --limit <n>              Recent run window. Default: 10
  --draft-limit <n>        Recent run window for draft lookup. Default: max(limit, 200)
  --history-limit <n>      Recent checkpoint window. Default: 3
  --runtime-root <dir>     Runtime agents directory.
  --checkpoint-dir <dir>   Directory containing checkpoint artifacts.
  --output <file>          Write an HTML dashboard snapshot to a file.
  --open                   Open the written dashboard with xdg-open.
  --help                   Show this help.

This command is read-only unless --output is provided. It builds a local HTML
operator dashboard from operator-console JSON and never sends BotLand messages.

It is a boundary facility, not an agency source. Use it to inspect, block, and
recover around the agent life loop; do not use it to author the agent's desires
or direction.
`);
}

function runtimeRootArgs(args) {
  const defaultRoot = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
  return path.resolve(args.runtimeRoot) === path.resolve(defaultRoot)
    ? []
    : ['--runtime-root', args.runtimeRoot];
}

function runOperatorConsole(args) {
  const result = spawnSync(process.execPath, [
    'scripts/stay-alive/operator-console.mjs',
    '--agent',
    args.agent,
    '--limit',
    String(args.limit),
    '--draft-limit',
    String(args.draftLimit),
    '--history-limit',
    String(args.historyLimit),
    ...runtimeRootArgs(args),
    '--checkpoint-dir',
    args.checkpointDir,
    '--json'
  ], {
    cwd: WORKSPACE,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'operator-console failed');
  }
  return JSON.parse(result.stdout);
}

function runReviewConsole(args) {
  const result = spawnSync(process.execPath, [
    'scripts/stay-alive/operator-review-console.mjs',
    '--agent',
    args.agent,
    '--limit',
    String(Math.max(args.limit, 200)),
    ...runtimeRootArgs(args),
    '--json'
  ], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || result.stdout.trim() || 'operator-review-console failed'
    };
  }
  return {
    ok: true,
    report: JSON.parse(result.stdout)
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

function classForLevel(level) {
  if (level === 'stop') return 'danger';
  if (['attention', 'review', 'approval_waiting', 'proposal_governance', 'action_outcome'].includes(level)) return 'warn';
  return 'ok';
}

function compactCommand(command) {
  if (!command) return 'none';
  return String(command).replace(process.execPath, 'node');
}

function kv(label, value) {
  return `<div class="kv"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function commandBlock(command) {
  if (!command) return '<div class="muted">none</div>';
  return `<code>${escapeHtml(command)}</code>`;
}

function renderDashboard(state) {
  const status = state.status ?? {};
  const health = status.health ?? {};
  const daemon = status.daemon_state ?? {};
  const control = status.control_state ?? {};
  const latest = status.latest_run ?? {};
  const history = state.checkpoint_history ?? {};
  const checkpoint = history.latest_summary ?? {};
  const drafts = status.drafts ?? [];
  const proposal = state.proposal_governance ?? {};
  const outcomes = state.action_outcomes ?? {};
  const systemd = state.systemd_runtime ?? {};
  const decision = state.operator_decision ?? {};
  const reviewConsole = state.review_console?.report ?? {};
  const levelClass = classForLevel(decision.level);
  const rows = (items, empty, colspan = 5) => items.length
    ? items.map((item) => `<tr>${item.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('\n')
    : `<tr><td colspan="${colspan}" class="muted">${escapeHtml(empty)}</td></tr>`;
  const countRows = (counts, empty) => {
    const entries = Object.entries(counts ?? {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return rows(entries.map(([key, value]) => [key, value]), empty, 2);
  };
  const failedUnits = systemd.failed_units ?? [];
  const safetyChecks = [
    ['health', health.ok ? 'ok' : 'review', health.ok ? 'latest status healthy' : 'status needs review'],
    ['control', control.paused ? 'paused' : 'clear', control.paused ? (control.pause_reason ?? 'operator pause active') : 'no operator pause'],
    ['drafts', `${health.pending_draft_count ?? 0}/${health.approved_draft_count ?? 0}`, 'pending / approved'],
    ['services', `${systemd.failed_service_count ?? 0}/${systemd.failed_timer_count ?? 0}`, 'failed services / timers'],
    ['proposals', proposal.executable_count ?? 0, 'safe local governance ops'],
    ['outcomes', outcomes.pending_outcome_count ?? 0, 'pending feedback integrations']
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stay-Alive Operator Dashboard - ${escapeHtml(state.agent_id)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #667085;
      --line: #d8dde5;
      --ok: #237a57;
      --warn: #9a5b00;
      --danger: #b42318;
      --accent: #205493;
      --soft: #eef2f6;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111418;
        --panel: #181d23;
        --text: #ecf0f5;
        --muted: #9aa6b2;
        --line: #2b333d;
        --accent: #7ab7ff;
        --soft: #20262d;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; }
    h1 { font-size: 24px; margin: 0; letter-spacing: 0; }
    h2 { font-size: 15px; margin: 0 0 12px; letter-spacing: 0; }
    h3 { font-size: 13px; margin: 14px 0 6px; color: var(--muted); letter-spacing: 0; }
    .muted { color: var(--muted); }
    .pill { display: inline-flex; align-items: center; min-height: 28px; padding: 4px 10px; border-radius: 999px; font-weight: 700; border: 1px solid var(--line); }
    .pill.ok { color: var(--ok); }
    .pill.warn { color: var(--warn); }
    .pill.danger { color: var(--danger); }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 12px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .span-4 { grid-column: span 4; }
    .span-6 { grid-column: span 6; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .scoreboard { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
    .score { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: var(--soft); min-width: 0; }
    .score span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    .score strong { display: block; font-size: 18px; overflow-wrap: anywhere; }
    .kv { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-top: 1px solid var(--line); }
    .kv:first-of-type { border-top: 0; padding-top: 0; }
    .kv span { color: var(--muted); }
    .kv strong { text-align: right; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; vertical-align: top; padding: 8px; border-top: 1px solid var(--line); }
    th { color: var(--muted); font-weight: 600; }
    code { display: block; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--line); border-radius: 6px; padding: 8px; color: var(--accent); }
    .command-list code + code { margin-top: 8px; }
    @media (max-width: 820px) {
      main { padding: 14px; }
      header { display: block; }
      .span-4, .span-6, .span-8 { grid-column: span 12; }
      .scoreboard { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Stay-Alive Operator Dashboard</h1>
        <div class="muted">${escapeHtml(state.agent_id)} · ${escapeHtml(state.generated_at)}</div>
        <div class="muted">Boundary facility only · not an agency source</div>
      </div>
      <div class="pill ${levelClass}">${escapeHtml(decision.level ?? 'unknown')}</div>
    </header>

    <div class="grid">
      <section class="span-12">
        <h2>One Screen</h2>
        <div class="scoreboard">
          ${safetyChecks.map(([label, value, note]) => `
          <div class="score">
            <span>${escapeHtml(label)} · ${escapeHtml(note)}</span>
            <strong>${escapeHtml(value)}</strong>
          </div>`).join('')}
        </div>
        ${kv('summary', decision.summary ?? 'n/a')}
        ${kv('latest run', `${latest.run_id ?? 'none'} (${latest.cycle ?? 'unknown'})`)}
        ${kv('next command', compactCommand(decision.next_command))}
      </section>

      <section class="span-4">
        <h2>Current State</h2>
        ${kv('ok', health.ok ? 'yes' : 'no')}
        ${kv('attention runs', health.historical_attention_run_count ?? 0)}
        ${kv('external actions', health.external_action_count_in_window ?? 0)}
        ${kv('visible drafts', health.visible_draft_count ?? 0)}
        ${kv('next check after', latest.next_check_after ?? 'n/a')}
      </section>

      <section class="span-4">
        <h2>Daemon</h2>
        ${kv('run count', daemon.run_count ?? 0)}
        ${kv('processed events', daemon.processed_event_count ?? 0)}
        ${kv('last event', daemon.last_seen_event_id ?? 'none')}
      </section>

      <section class="span-4">
        <h2>Control</h2>
        ${kv('paused', control.paused ? 'yes' : 'no')}
        ${kv('pause reason', control.pause_reason ?? 'none')}
        ${kv('pause until', control.pause_until ?? 'none')}
      </section>

      <section class="span-4">
        <h2>Runtime Evidence</h2>
        ${kv('latest checkpoint', history.latest_checkpoint_id ?? 'none')}
        ${kv('checkpoint changes', history.newest_two_change_count ?? 'n/a')}
        ${kv('storage MB', checkpoint.runtime_storage_total_mb ?? 'n/a')}
        ${kv('live systemd', `${systemd.level ?? 'n/a'} / ${systemd.pass === undefined ? 'n/a' : systemd.pass ? 'pass' : 'fail'}`)}
      </section>

      <section class="span-6">
        <h2>Draft Queue</h2>
        ${kv('pending', health.pending_draft_count ?? 0)}
        ${kv('approved', health.approved_draft_count ?? 0)}
        ${kv('total in window', health.total_draft_count_in_window ?? 0)}
      </section>

      <section class="span-6">
        <h2>Proposal Governance</h2>
        ${kv('visible proposals', proposal.visible_count ?? 0)}
        ${kv('executable proposals', proposal.executable_count ?? 0)}
        ${kv('manual review', proposal.review_count ?? 0)}
        ${kv('duplicate groups', proposal.duplicate_group_count ?? 'n/a')}
        <h3>By Decision</h3>
        <table>
          <tbody>${countRows(proposal.counts_by_decision, 'No proposal decisions')}</tbody>
        </table>
      </section>

      <section class="span-12">
        <h2>Proposal Lanes</h2>
        <table>
          <thead><tr><th>lane</th><th>count</th></tr></thead>
          <tbody>${countRows(proposal.counts_by_lane, 'No visible proposal lanes')}</tbody>
        </table>
      </section>

      <section class="span-12">
        <h2>Review Console</h2>
        ${kv('relationship candidates', reviewConsole.relationship_candidates?.length ?? 0)}
        ${kv('memory pending sync', reviewConsole.memory_sync?.pending_sync_count ?? 0)}
        ${kv('duplicate clusters', reviewConsole.duplicate_clusters?.length ?? 0)}
        ${kv('outcome attention', reviewConsole.outcome_attention?.length ?? 0)}
        <h3>Dry-run Preview</h3>
        <div class="command-list">
          ${reviewConsole.proposal_governance?.next_commands?.dry_run_batch_apply ? commandBlock(compactCommand(reviewConsole.proposal_governance.next_commands.dry_run_batch_apply)) : ''}
          ${reviewConsole.proposal_governance?.next_commands?.dry_run_dismiss_stale ? commandBlock(compactCommand(reviewConsole.proposal_governance.next_commands.dry_run_dismiss_stale)) : ''}
          ${reviewConsole.memory_sync?.dry_run_command ? commandBlock(compactCommand(reviewConsole.memory_sync.dry_run_command)) : ''}
        </div>
      </section>

      <section class="span-6">
        <h2>Action Outcomes</h2>
        ${kv('inspected sends', outcomes.inspected_successful_send_count ?? 0)}
        ${kv('outcome ledgers', outcomes.outcome_count ?? 0)}
        ${kv('pending outcomes', outcomes.pending_outcome_count ?? 0)}
        ${kv('pending action ids', (outcomes.pending_action_ids ?? []).join(', ') || 'none')}
      </section>

      <section class="span-6">
        <h2>Failed Services</h2>
        ${kv('failed services', systemd.failed_service_count ?? 0)}
        ${kv('failed timers', systemd.failed_timer_count ?? 0)}
        ${kv('inactive timers', systemd.inactive_timer_count ?? 0)}
        ${kv('uninspected failed services', systemd.uninspected_failed_service_count ?? 0)}
        <table>
          <thead><tr><th>unit</th><th>state</th><th>result</th><th>inspected</th></tr></thead>
          <tbody>${rows(failedUnits.map((unit) => [
            unit.unit_name,
            unit.active_state ?? 'n/a',
            unit.result ?? 'n/a',
            unit.inspected ? 'yes' : 'no'
          ]), 'No failed services or timers', 4)}</tbody>
        </table>
      </section>

      <section class="span-12">
        <h2>Recent Drafts</h2>
        <table>
          <thead><tr><th>status</th><th>type</th><th>run</th><th>target</th><th>preview</th></tr></thead>
          <tbody>
            ${rows(drafts.slice(0, 12).map((draft) => [
              draft.status,
              draft.type,
              `${draft.run_id}:${draft.draft_index}`,
              draft.target ?? 'n/a',
              draft.draft_text ?? ''
            ]), 'No visible drafts')}
          </tbody>
        </table>
      </section>

      <section class="span-12">
        <h2>Recommended Commands</h2>
        <div class="command-list">
          ${commandBlock(compactCommand(decision.next_command))}
          ${proposal.next_commands?.dry_run_batch_apply ? commandBlock(compactCommand(proposal.next_commands.dry_run_batch_apply)) : ''}
          ${outcomes.next_command ? commandBlock(compactCommand(outcomes.next_command)) : ''}
        </div>
      </section>
    </div>
  </main>
</body>
</html>
`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const state = runOperatorConsole(args);
  state.review_console = runReviewConsole(args);
  const html = renderDashboard(state);
  if (args.output) {
    mkdirSync(path.dirname(args.output), { recursive: true });
    writeFileSync(args.output, html);
    console.log(JSON.stringify({
      read_only: false,
      local_only: true,
      facility_class: 'boundary_facility',
      agency_source: false,
      external_write: false,
      botland_send: false,
      generated_at: new Date().toISOString(),
      agent_id: args.agent,
      output: path.relative(WORKSPACE, args.output),
      open_requested: args.open
    }, null, 2));
    if (args.open) {
      spawnSync('xdg-open', [args.output], { stdio: 'ignore', detached: true });
    }
  } else {
    process.stdout.write(html);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
