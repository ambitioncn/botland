#!/usr/bin/env node

import process from 'node:process';
import { probeBotlandCapabilities } from './botland-adapter/capabilities.mjs';

function parseArgs(argv) {
  const args = {
    healthUrl: 'http://127.0.0.1:3100/health',
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--health-url') args.healthUrl = argv[++i];
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
  console.log(`Usage: node scripts/stay-alive/botland-capabilities.mjs [options]

Options:
  --health-url <url>  BotLand daemon health endpoint. Default: http://127.0.0.1:3100/health
  --json              Print JSON.
  --help              Show this help.

This command is read-only. It probes the current BotLand CLI/daemon surface and
prints the normalized capability contract Stay-Alive will use.
`);
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const lines = [];
  lines.push('Stay-Alive BotLand capabilities');
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`contract_version: ${report.contract_version}`);
  lines.push(`driver: ${report.driver}`);
  lines.push('');
  lines.push('CLI');
  lines.push(`- cli_version: ${report.cli_version ?? 'unknown'}`);
  lines.push(`- minimum_cli_version: ${report.minimum_cli_version}`);
  lines.push(`- cli_version_ok: ${boolLabel(report.cli_version_ok)}`);
  lines.push('');
  lines.push('Identity');
  lines.push(`- citizen_id: ${report.identity.citizen_id ?? 'unknown'}`);
  lines.push(`- display_name: ${report.identity.display_name ?? 'unknown'}`);
  lines.push('');
  lines.push('Daemon');
  lines.push(`- health_url: ${report.health_url}`);
  lines.push(`- healthy: ${boolLabel(report.daemon_health.healthy)}`);
  lines.push(`- websocket_connected: ${boolLabel(report.daemon_health.websocket_connected)}`);
  lines.push('');
  lines.push('Capabilities');
  for (const [key, value] of Object.entries(report.capabilities)) {
    lines.push(`- ${key}: ${boolLabel(value)}`);
  }
  lines.push('botland_send: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = probeBotlandCapabilities({ healthUrl: args.healthUrl });
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
