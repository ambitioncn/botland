#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    agents: null,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--agents') args.agents = argv[++i].split(',').map((item) => item.trim()).filter(Boolean);
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
  console.log(`Usage: node scripts/stay-alive/multi-agent-readiness.mjs [options]

Options:
  --runtime-root <dir>  Runtime agents directory
  --agents <a,b>        Limit to a comma-separated agent list
  --json                Print JSON
  --help                Show this help

Read-only readiness report for proving Stay-Alive is not hard-coded to one
agent. It inspects each agent runtime, onboarding state, strict preflight
compatibility, and daemon/systemd hints without starting services or writing
BotLand.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function countJson(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => name.endsWith('.json')).length;
}

function runJson(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
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
    ok: result.status === 0,
    status: result.status,
    parsed,
    stderr_preview: String(result.stderr ?? '').slice(0, 500)
  };
}

function reportPass(parsed) {
  return Boolean(parsed?.pass ?? parsed?.verdict?.pass);
}

function reportLevel(parsed) {
  return parsed?.level ?? parsed?.verdict?.level ?? null;
}

function safetyFindingCount(parsed) {
  const findings = parsed?.safety_findings ?? parsed?.verdict?.safety_findings;
  return Array.isArray(findings) ? findings.length : null;
}

function agentIds(runtimeRoot, explicit) {
  if (explicit) return explicit;
  if (!existsSync(runtimeRoot)) return [];
  return readdirSync(runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function inspectAgent(runtimeRoot, agent) {
  const agentDir = path.join(runtimeRoot, agent);
  const lifePath = path.join(agentDir, 'life_state.json');
  const onboardingPath = path.join(agentDir, 'onboarding.json');
  const daemonPath = path.join(agentDir, 'daemon_state.json');
  const lifeState = existsSync(lifePath) ? readJson(lifePath) : null;
  const onboarding = existsSync(onboardingPath) ? readJson(onboardingPath) : null;
  const daemonState = existsSync(daemonPath) ? readJson(daemonPath) : null;
  const runtimeArgs = ['--agent', agent, '--runtime-root', runtimeRoot, '--json'];
  const onboardingVerify = runJson('scripts/stay-alive/onboarding-verify.mjs', runtimeArgs);
  const preflight = runJson('scripts/stay-alive/preflight.mjs', [
    '--agent', agent,
    '--runtime-root', runtimeRoot,
    '--no-checkpoint',
    '--json'
  ]);
  const preflightStrict = runJson('scripts/stay-alive/preflight.mjs', [
    '--agent', agent,
    '--runtime-root', runtimeRoot,
    '--no-checkpoint',
    '--strict-onboarding',
    '--json'
  ]);
  const runCount = countJson(path.join(agentDir, 'runs'));
  const actionCount = countJson(path.join(agentDir, 'actions'));
  const proposalActionCount = countJson(path.join(agentDir, 'proposal_actions'));
  const hasBotlandIdentity = Boolean(lifeState?.botland?.citizen_id);
  const historicalArtifactCount = onboardingVerify.parsed?.historical_artifact_count ?? null;
  const strictReady = Boolean(reportPass(onboardingVerify.parsed) && reportPass(preflightStrict.parsed));
  const operationalReady = Boolean(reportPass(onboardingVerify.parsed) && reportPass(preflight.parsed) && hasBotlandIdentity);
  const longRunningSuggested = operationalReady && runCount > 0;
  return {
    agent_id: agent,
    display_name: lifeState?.botland?.display_name ?? lifeState?.self_model?.name ?? onboarding?.display_name ?? null,
    citizen_id: lifeState?.botland?.citizen_id ?? onboarding?.botland_citizen_id ?? null,
    onboarding_mode: onboarding?.mode ?? null,
    onboarding_present: Boolean(onboarding),
    daemon_run_count: daemonState?.run_count ?? 0,
    run_count: runCount,
    action_count: actionCount,
    proposal_action_count: proposalActionCount,
    historical_artifact_count: historicalArtifactCount,
    onboarding_verify: {
      ok: onboardingVerify.ok,
      pass: reportPass(onboardingVerify.parsed),
      level: reportLevel(onboardingVerify.parsed)
    },
    strict_preflight: {
      ok: preflightStrict.ok,
      pass: reportPass(preflightStrict.parsed),
      level: reportLevel(preflightStrict.parsed),
      safety_finding_count: safetyFindingCount(preflightStrict.parsed)
    },
    normal_preflight: {
      ok: preflight.ok,
      pass: reportPass(preflight.parsed),
      level: reportLevel(preflight.parsed),
      safety_finding_count: safetyFindingCount(preflight.parsed)
    },
    readiness: {
      operational_ready: operationalReady,
      strict_ready: strictReady,
      long_running_daemon_candidate: longRunningSuggested,
      recommended_next: longRunningSuggested
        ? `review before installing systemd timer for ${agent}`
        : 'finish clean onboarding/live read-only probe before daemon install'
    },
    safety: {
      read_only: true,
      service_started: false,
      botland_write: false
    }
  };
}

function buildReport(args) {
  const agents = agentIds(args.runtimeRoot, args.agents).map((agent) => inspectAgent(args.runtimeRoot, agent));
  return {
    read_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    runtime_root: args.runtimeRoot,
    agent_count: agents.length,
    operational_ready_count: agents.filter((agent) => agent.readiness.operational_ready).length,
    strict_ready_count: agents.filter((agent) => agent.readiness.strict_ready).length,
    daemon_candidate_count: agents.filter((agent) => agent.readiness.long_running_daemon_candidate).length,
    agents,
    recommendation: 'Use this report to choose the next real agent rollout; do not start or enable systemd from this command.'
  };
}

function formatText(report) {
  const lines = [
    'Stay-Alive multi-agent readiness',
    `generated_at: ${report.generated_at}`,
    `agents: ${report.agent_count}`,
    `operational_ready: ${report.operational_ready_count}`,
    `strict_ready: ${report.strict_ready_count}`,
    `daemon_candidates: ${report.daemon_candidate_count}`,
    ''
  ];
  for (const agent of report.agents) {
    lines.push(`- ${agent.agent_id}: operational=${agent.readiness.operational_ready ? 'yes' : 'no'} strict=${agent.readiness.strict_ready ? 'yes' : 'no'} runs=${agent.run_count} citizen=${agent.citizen_id ?? 'n/a'}`);
    lines.push(`  next: ${agent.readiness.recommended_next}`);
  }
  lines.push('');
  lines.push('service_started: no');
  lines.push('botland_send: no');
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
