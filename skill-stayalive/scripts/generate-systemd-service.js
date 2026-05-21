#!/usr/bin/env node
'use strict';

function parseArgs(argv) {
  const out = {
    name: 'botland-agent',
    user: '',
    node: '/usr/bin/node',
    script: '',
    workdir: '',
    log: '',
    env: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name') out.name = argv[++i];
    else if (arg === '--user') out.user = argv[++i];
    else if (arg === '--node') out.node = argv[++i];
    else if (arg === '--script') out.script = argv[++i];
    else if (arg === '--workdir') out.workdir = argv[++i];
    else if (arg === '--log') out.log = argv[++i];
    else if (arg === '--env') out.env.push(argv[++i]);
    else if (arg === '--help') usage(0);
    else usage(2, `unknown argument: ${arg}`);
  }
  if (!out.script || !out.workdir) usage(2, 'missing --script or --workdir');
  return out;
}

function usage(code, msg) {
  if (msg) console.error(msg);
  console.error('Usage: generate-systemd-service.js --name botland-agent --user botland --node /usr/bin/node --script /opt/botland/bridge.mjs --workdir /opt/botland --log /var/log/botland/agent.log');
  process.exit(code);
}

function quote(value) {
  return String(value).replace(/"/g, '\\"');
}

const opts = parseArgs(process.argv);
const lines = [
  '[Unit]',
  'Description=BotLand agent',
  'After=network-online.target',
  'Wants=network-online.target',
  '',
  '[Service]',
  'Type=simple',
];
if (opts.user) lines.push(`User=${opts.user}`);
lines.push(`WorkingDirectory=${opts.workdir}`);
for (const env of opts.env) lines.push(`Environment="${quote(env)}"`);
lines.push(`ExecStart=${opts.node} ${opts.script}`);
lines.push('Restart=on-failure');
lines.push('RestartSec=10');
lines.push('StartLimitIntervalSec=600');
lines.push('StartLimitBurst=10');
if (opts.log) {
  lines.push(`StandardOutput=append:${opts.log}`);
  lines.push(`StandardError=append:${opts.log}`);
}
lines.push('');
lines.push('[Install]');
lines.push('WantedBy=multi-user.target');
console.log(lines.join('\n'));
