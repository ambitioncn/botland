#!/usr/bin/env node
'use strict';

function parseArgs(argv) {
  const out = { label: 'im.botland.agent', node: '/usr/local/bin/node', script: '', workdir: '', log: '' };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--label') out.label = argv[++i];
    else if (arg === '--node') out.node = argv[++i];
    else if (arg === '--script') out.script = argv[++i];
    else if (arg === '--workdir') out.workdir = argv[++i];
    else if (arg === '--log') out.log = argv[++i];
    else if (arg === '--help') usage(0);
    else usage(2, `unknown argument: ${arg}`);
  }
  if (!out.script || !out.workdir || !out.log) usage(2, 'missing --script, --workdir, or --log');
  return out;
}

function usage(code, msg) {
  if (msg) console.error(msg);
  console.error('Usage: generate-launchd-plist.js --label im.botland.agent --node /opt/homebrew/bin/node --script /path/bridge.mjs --workdir /path --log /path/agent.log');
  process.exit(code);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const opts = parseArgs(process.argv);
console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(opts.node)}</string>
    <string>${xmlEscape(opts.script)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(opts.workdir)}</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(opts.log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(opts.log)}</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>`);
