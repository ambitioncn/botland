#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_ONBOARDING_RUNTIME_DIRS,
  DEFAULT_ONBOARDING_TIMER_CYCLES,
  ONBOARDING_SCHEMA,
  ONBOARDING_STANDARD_GATES,
  ONBOARDING_TEMPLATE_SCHEMA,
  isObject,
  readJson
} from './onboarding-lib.mjs';

const WORKSPACE = process.cwd();
const RUNTIME_HISTORY_DIRS = [
  'runs',
  'actions',
  'proposal_actions',
  'action_outcomes',
  'checkpoints'
];

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    allowHistoricalRuntime: false,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--allow-historical-runtime') args.allowHistoricalRuntime = true;
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
  console.log(`Usage: node scripts/stay-alive/onboarding-verify.mjs [options]

Options:
  --agent <id>                    Agent id. Default: badclaw
  --runtime-root <dir>            Runtime agents directory.
  --allow-historical-runtime      Do not warn on existing run/action/checkpoint history.
  --json                          Print JSON instead of text.
  --help                          Show this help.

This command verifies that an agent runtime was initialized through the generic
onboarding path and is not a copied BadClaw runtime with historical actions.
It is read-only and never calls BotLand.
`);
}

function addIssue(issues, level, code, message) {
  issues.push({ level, code, message });
}

function addOnboardingPolicyIssue(issues, onboarding, code, message) {
  addIssue(issues, onboarding ? 'error' : 'warning', code, message);
}

function countJsonFiles(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .length;
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifePath = path.join(agentDir, 'life_state.json');
  const daemonPath = path.join(agentDir, 'daemon_state.json');
  const controlPath = path.join(agentDir, 'control_state.json');
  const onboardingPath = path.join(agentDir, 'onboarding.json');
  const issues = [];

  let lifeState = null;
  let daemonState = null;
  let onboarding = null;

  if (!existsSync(lifePath)) addIssue(issues, 'error', 'life_state_missing', `Missing ${lifePath}`);
  else lifeState = readJson(lifePath);

  if (!existsSync(daemonPath)) addIssue(issues, 'error', 'daemon_state_missing', `Missing ${daemonPath}`);
  else daemonState = readJson(daemonPath);

  if (!existsSync(controlPath)) addIssue(issues, 'warning', 'control_state_missing', `Missing ${controlPath}`);

  if (!existsSync(onboardingPath)) {
    addIssue(issues, 'warning', 'onboarding_manifest_missing', `Missing ${onboardingPath}`);
  } else {
    onboarding = readJson(onboardingPath);
    if (onboarding.schema_version !== ONBOARDING_SCHEMA) {
      addIssue(issues, 'error', 'onboarding_schema_invalid', `onboarding.schema_version must be ${ONBOARDING_SCHEMA}`);
    }
    if (onboarding.agent_id !== args.agent) {
      addIssue(issues, 'error', 'onboarding_agent_id_mismatch', `onboarding.agent_id must equal ${args.agent}`);
    }
    if (onboarding.botland_citizen_id !== lifeState?.botland?.citizen_id) {
      addIssue(issues, 'error', 'onboarding_citizen_id_mismatch', 'onboarding botland citizen id must match life_state.botland.citizen_id');
    }
    const safety = isObject(onboarding.safety) ? onboarding.safety : {};
    for (const field of ['copied_runtime_history', 'copied_action_ledgers']) {
      if (safety[field] !== false) {
        addIssue(issues, 'error', 'onboarding_safety_flag_unsafe', `onboarding.safety.${field} must be false`);
      }
    }
    const template = isObject(onboarding.template_bundle) ? onboarding.template_bundle : null;
    if (!template) {
      addIssue(issues, 'error', 'cross_agent_template_bundle_missing', 'onboarding.template_bundle must describe the generic Stay-Alive bundle');
    } else {
      if (template.schema_version !== ONBOARDING_TEMPLATE_SCHEMA) {
        addIssue(issues, 'error', 'cross_agent_template_schema_invalid', `template_bundle.schema_version must be ${ONBOARDING_TEMPLATE_SCHEMA}`);
      }
      if (template.agent_id !== args.agent) {
        addIssue(issues, 'error', 'cross_agent_template_agent_id_mismatch', `template_bundle.agent_id must equal ${args.agent}`);
      }
      for (const gate of ONBOARDING_STANDARD_GATES) {
        if (!Array.isArray(template.default_gates) || !template.default_gates.includes(gate)) {
          addIssue(issues, 'error', 'cross_agent_template_gate_missing', `template_bundle.default_gates missing ${gate}`);
        }
      }
      const templateCycles = Array.isArray(template.timers) ? template.timers : [];
      for (const expected of DEFAULT_ONBOARDING_TIMER_CYCLES) {
        const found = templateCycles.find((item) => item?.cycle === expected.cycle);
        if (!found) {
          addIssue(issues, 'error', 'cross_agent_template_timer_missing', `template_bundle.timers missing ${expected.cycle}`);
        } else if (found.schedule !== expected.schedule) {
          addIssue(issues, 'error', 'cross_agent_template_timer_schedule_mismatch', `template_bundle.timers.${expected.cycle} must use ${expected.schedule}`);
        }
      }
      const requiredWriteGates = ['preflight', 'botland_identity_match', 'tool_supervision_policy', 'local_action_ledger', 'post_send_inspection'];
      const writeGates = Array.isArray(template.botland_write_gate?.required_gates) ? template.botland_write_gate.required_gates : [];
      for (const gate of requiredWriteGates) {
        if (!writeGates.includes(gate)) {
          addIssue(issues, 'error', 'cross_agent_template_write_gate_missing', `botland_write_gate.required_gates missing ${gate}`);
        }
      }
      if (template.botland_write_gate?.per_action_human_confirmation_required !== false) {
        addIssue(issues, 'error', 'cross_agent_template_human_confirmation_enabled', 'BotLand write gate must not require daily per-action human confirmation');
      }
    }
  }

  if (lifeState?.agent_id !== args.agent) {
    addIssue(issues, 'error', 'life_state_agent_id_mismatch', `life_state.agent_id must equal ${args.agent}`);
  }
  if (daemonState?.agent_id !== args.agent) {
    addIssue(issues, 'error', 'daemon_state_agent_id_mismatch', `daemon_state.agent_id must equal ${args.agent}`);
  }
  if (daemonState && daemonState.run_count !== 0 && !args.allowHistoricalRuntime) {
    addIssue(issues, 'warning', 'daemon_state_not_fresh', 'New onboarded agents should start with run_count 0');
  }
  if (lifeState?.write_policy?.writes_enabled !== true) {
    addIssue(issues, 'error', 'writes_enabled_not_true', 'New onboarded agents must use write_policy.writes_enabled=true with tool supervision');
  }
  if (lifeState?.unattended_write_policy?.enabled !== true) {
    addIssue(issues, 'error', 'tool_supervision_policy_disabled', 'New onboarded agents must use enabled tool supervision policy');
  }
  const growthPolicy = isObject(lifeState?.self_model?.growth_policy) ? lifeState.self_model.growth_policy : null;
  if (!growthPolicy) {
    addOnboardingPolicyIssue(issues, onboarding, 'growth_policy_missing', 'New onboarded agents must include self_model.growth_policy');
  } else {
    if (growthPolicy.preset_growth_target !== false) {
      addOnboardingPolicyIssue(issues, onboarding, 'preset_growth_target_enabled', 'self_model.growth_policy.preset_growth_target must be false');
    }
    if (typeof growthPolicy.direction_source !== 'string' || !growthPolicy.direction_source.includes('emerges_from')) {
      addOnboardingPolicyIssue(issues, onboarding, 'growth_direction_source_invalid', 'growth direction must emerge from evidence, not from an operator-authored destination');
    }
    if (typeof growthPolicy.operator_role !== 'string' || !growthPolicy.operator_role.includes('do not author the agent life answer')) {
      addOnboardingPolicyIssue(issues, onboarding, 'operator_role_authors_growth', 'operator role must not author the agent life answer');
    }
  }
  const firstDesire = Array.isArray(lifeState?.current_desires) ? lifeState.current_desires[0] : null;
  if (firstDesire && firstDesire.preset_growth_target !== false) {
    addOnboardingPolicyIssue(issues, onboarding, 'initial_desire_preset_target', 'Initial desire must be an open-ended self-question seed, not a preset growth target');
  }
  if (typeof firstDesire?.text === 'string' && /become|成为|成长为|must be|必须成为/i.test(firstDesire.text)) {
    addOnboardingPolicyIssue(issues, onboarding, 'initial_desire_prescriptive_text', 'Initial desire text must not prescribe what the agent should become');
  }

  const historyCounts = Object.fromEntries(RUNTIME_HISTORY_DIRS.map((dir) => [
    dir,
    countJsonFiles(path.join(agentDir, dir))
  ]));
  const historicalArtifactCount = Object.values(historyCounts).reduce((sum, count) => sum + count, 0);
  if (historicalArtifactCount > 0 && !args.allowHistoricalRuntime) {
    addIssue(issues, 'warning', 'historical_artifacts_present', `Runtime already has ${historicalArtifactCount} history artifacts`);
  }
  const missingRuntimeDirs = DEFAULT_ONBOARDING_RUNTIME_DIRS
    .filter((dir) => dir !== '')
    .filter((dir) => !existsSync(path.join(agentDir, dir)));
  if (missingRuntimeDirs.length > 0) {
    addIssue(issues, onboarding ? 'error' : 'warning', 'cross_agent_runtime_dirs_missing', `Missing onboarding runtime directories: ${missingRuntimeDirs.join(', ')}`);
  }

  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    agent_dir: path.relative(WORKSPACE, agentDir),
    pass: errors.length === 0,
    level: errors.length > 0 ? 'stop' : warnings.length > 0 ? 'review' : 'ok',
    error_count: errors.length,
    warning_count: warnings.length,
    historical_artifact_count: historicalArtifactCount,
    history_counts: historyCounts,
    onboarding_present: onboarding !== null,
    onboarding_mode: onboarding?.mode ?? null,
    source_agent_id: onboarding?.source_agent_id ?? null,
    botland_citizen_id: lifeState?.botland?.citizen_id ?? null,
    display_name: lifeState?.botland?.display_name ?? null,
    growth_policy: growthPolicy,
    initial_desire: firstDesire,
    template_bundle: onboarding?.template_bundle ?? null,
    template_timer_count: Array.isArray(onboarding?.template_bundle?.timers) ? onboarding.template_bundle.timers.length : 0,
    required_timer_count: DEFAULT_ONBOARDING_TIMER_CYCLES.length,
    missing_runtime_dirs: missingRuntimeDirs,
    errors,
    warnings
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive onboarding verification (${report.agent_id})`);
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
  lines.push('Onboarding');
  lines.push(`- manifest_present: ${boolLabel(report.onboarding_present)}`);
  lines.push(`- mode: ${report.onboarding_mode ?? 'n/a'}`);
  lines.push(`- source_agent_id: ${report.source_agent_id ?? 'none'}`);
  lines.push(`- botland_citizen_id: ${report.botland_citizen_id ?? 'n/a'}`);
  lines.push(`- display_name: ${report.display_name ?? 'n/a'}`);
  lines.push(`- historical_artifact_count: ${report.historical_artifact_count}`);
  lines.push(`- template_timers: ${report.template_timer_count}/${report.required_timer_count}`);
  lines.push(`- missing_template_dirs: ${report.missing_runtime_dirs.length}`);
  if (report.errors.length > 0) {
    lines.push('');
    lines.push('Errors');
    for (const issue of report.errors) lines.push(`- ${issue.code}: ${issue.message}`);
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const issue of report.warnings) lines.push(`- ${issue.code}: ${issue.message}`);
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
