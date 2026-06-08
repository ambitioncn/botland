#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { compactFailedService, isFailedService, WORKSPACE } from './service-failure-lib.mjs';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    unit: null,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    journalLines: 80,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--unit') args.unit = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--journal-lines') args.journalLines = Number.parseInt(argv[++i], 10);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.journalLines) || args.journalLines < 1) {
    throw new Error('--journal-lines must be a positive integer');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/failed-service-packet.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --unit <unit.service>    Failed service unit. Default: newest failed Stay-Alive service.
  --runtime-root <dir>     Runtime agents directory.
  --journal-lines <n>      User journal lines to include. Default: 80
  --json                   Print JSON instead of text.
  --help                   Show this help.

This command is read-only. It inspects failed Stay-Alive systemd services,
recent journal lines, and matching local run artifacts. It never resets units
and never calls BotLand.
`);
}

function runJson(script, scriptArgs) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs, '--json'], {
    cwd: WORKSPACE,
    encoding: 'utf8'
  });
  if (!result.stdout.trim() && result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${script} failed`);
  }
  return JSON.parse(result.stdout);
}

function runJournal(unit, lines) {
  const result = spawnSync('journalctl', [
    '--user',
    '-u',
    unit,
    '-n',
    String(lines),
    '--no-pager',
    '--output=short-iso'
  ], {
    encoding: 'utf8'
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
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

function cycleFromUnit(agent, unit) {
  const prefix = `stay-alive-${agent}-`;
  if (!unit.startsWith(prefix) || !unit.endsWith('.service')) return null;
  return unit.slice(prefix.length, -'.service'.length);
}

function latestRunsForCycle(args, cycle) {
  if (!cycle) return [];
  const runsDir = path.join(args.runtimeRoot, args.agent, 'runs');
  return listJsonFiles(runsDir)
    .map((file) => {
      try {
        const run = readJson(file);
        return {
          run_id: run.run_id ?? path.basename(file, '.json'),
          created_at: run.created_at ?? null,
          cycle: run.cycle ?? null,
          health: run.health ?? null,
          chosen_action: run.chosen_action ?? null,
          external_action_count: Array.isArray(run.external_actions) ? run.external_actions.length : 0,
          draft_count: Array.isArray(run.drafts) ? run.drafts.length : 0,
          run_path: path.relative(WORKSPACE, file)
        };
      } catch {
        return null;
      }
    })
    .filter((run) => run && run.cycle === cycle)
    .slice(0, 5);
}

function buildPacket(args) {
  const runtime = runJson('scripts/stay-alive/systemd-runtime-verify.mjs', [
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot
  ]);
  const failedServices = runtime.services
    .filter(isFailedService)
    .map(compactFailedService);
  const target = args.unit
    ? failedServices.find((service) => service.unit_name === args.unit)
    : failedServices[0] ?? null;

  if (!target) {
    return {
      read_only: true,
      local_only: true,
      external_write: false,
      botland_send: false,
      generated_at: new Date().toISOString(),
      agent_id: args.agent,
      requested_unit: args.unit,
      failed_service_count: failedServices.length,
      failed_services: failedServices,
      packet: null,
      result: { ok: true, status: 'no_failed_service' }
    };
  }

  const journal = runJournal(target.unit_name, args.journalLines);
  const cycle = cycleFromUnit(args.agent, target.unit_name);
  const packet = {
    unit_name: target.unit_name,
    failure_fingerprint: target.fingerprint,
    failure: target,
    cycle,
    recent_runs: latestRunsForCycle(args, cycle),
    journal: {
      ok: journal.ok,
      status: journal.status,
      line_count: journal.stdout ? journal.stdout.split(/\r?\n/).length : 0,
      stdout: journal.stdout,
      stderr: journal.stderr || null
    },
    suggested_commands: {
      inspect: `node scripts/stay-alive/inspect-service-failure.mjs --agent ${args.agent} --unit ${target.unit_name} --failure-fingerprint ${target.fingerprint}`,
      reset_after_inspection: `node scripts/stay-alive/reset-service-failure.mjs --agent ${args.agent} --unit ${target.unit_name} --failure-fingerprint ${target.fingerprint} --confirm-reset RESET_FAILED_SERVICE`
    }
  };

  return {
    read_only: true,
    local_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    failed_service_count: failedServices.length,
    failed_services: failedServices,
    packet,
    result: { ok: true, status: 'packet_ready' }
  };
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive failed service packet (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`failed_services: ${report.failed_service_count}`);
  if (!report.packet) {
    lines.push('packet: none');
  } else {
    lines.push(`unit: ${report.packet.unit_name}`);
    lines.push(`fingerprint: ${report.packet.failure_fingerprint}`);
    lines.push(`cycle: ${report.packet.cycle ?? 'unknown'}`);
    lines.push(`active_state: ${report.packet.failure.active_state ?? 'unknown'}`);
    lines.push(`result: ${report.packet.failure.result ?? 'unknown'}`);
    lines.push(`recent_runs: ${report.packet.recent_runs.length}`);
    lines.push(`journal_lines: ${report.packet.journal.line_count}`);
    lines.push('');
    lines.push('Suggested');
    lines.push(`- inspect: ${report.packet.suggested_commands.inspect}`);
    lines.push(`- reset_after_inspection: ${report.packet.suggested_commands.reset_after_inspection}`);
  }
  lines.push('');
  lines.push('read_only: yes');
  lines.push('external_write: no');
  lines.push('botland_send: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildPacket(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
