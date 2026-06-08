#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { buildCrossAgentOnboardingTemplate, safeAgentId } from './onboarding-lib.mjs';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'agent-template',
    workspace: WORKSPACE,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--workspace') args.workspace = path.resolve(argv[++i]);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.agent = safeAgentId(args.agent);
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/onboarding-template.mjs [options]

Options:
  --agent <id>        Agent id to render commands for. Default: agent-template
  --workspace <dir>   Workspace path to record in the template. Default: current directory
  --json              Print JSON instead of text
  --help              Show this help

This command is read-only. It renders the default cross-agent Stay-Alive
onboarding bundle: life_state initialization, eight timers, governance,
preflight, regression, memory sync, and BotLand write gates.
`);
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(template) {
  const lines = [];
  lines.push(`Stay-Alive cross-agent onboarding template (${template.agent_id})`);
  lines.push(`schema_version: ${template.schema_version}`);
  lines.push(`template_name: ${template.template_name}`);
  lines.push(`read_only: yes`);
  lines.push(`botland_write: no`);
  lines.push('');
  lines.push('Default Bundle');
  for (const gate of template.default_gates) lines.push(`- ${gate}`);
  lines.push('');
  lines.push('Timers');
  for (const timer of template.timers) {
    lines.push(`- ${timer.cycle}: ${timer.schedule} (${timer.service_kind})`);
  }
  lines.push('');
  lines.push('BotLand Write Gate');
  lines.push(`- policy: ${template.botland_write_gate.policy}`);
  lines.push(`- per_action_human_confirmation_required: ${boolLabel(template.botland_write_gate.per_action_human_confirmation_required)}`);
  lines.push(`- required_gates: ${template.botland_write_gate.required_gates.join(', ')}`);
  lines.push('');
  lines.push('Commands');
  for (const [name, command] of Object.entries(template.install_commands)) {
    lines.push(`- ${name}: ${command}`);
  }
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const template = buildCrossAgentOnboardingTemplate({
    agentId: args.agent,
    workspace: args.workspace
  });

  if (args.format === 'json') {
    console.log(JSON.stringify({
      read_only: true,
      external_write: false,
      botland_write: false,
      ...template
    }, null, 2));
  } else {
    process.stdout.write(formatText(template));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
