#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
const DEFAULT_PATHS = [
  path.join(process.env.HOME ?? '', '.npm-global', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/bin'
].filter(Boolean);
const TRIGGER_TYPES = new Set(['message.received', 'group.message.received', 'friend.request']);

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME,
    host: '127.0.0.1',
    port: 8787,
    path: '/botland/events',
    debounceMs: 750,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--host') args.host = argv[++i];
    else if (arg === '--port') args.port = Number.parseInt(argv[++i], 10);
    else if (arg === '--path') args.path = argv[++i];
    else if (arg === '--debounce-ms') args.debounceMs = Number.parseInt(argv[++i], 10);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('--port must be 1..65535');
  if (!Number.isInteger(args.debounceMs) || args.debounceMs < 0) throw new Error('--debounce-ms must be non-negative');
  if (!args.path.startsWith('/')) throw new Error('--path must start with /');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/botland-event-trigger-server.mjs --agent <id> [options]

Listen for local BotLand daemon webhook events and trigger event-wakeup
immediately for message-like events. This server only starts the existing
tool-supervised event-wakeup path; it never sends BotLand messages itself.

Options:
  --agent <id>            Agent id. Default: badclaw
  --runtime-root <dir>    Runtime agents directory
  --host <host>           Listen host. Default: 127.0.0.1
  --port <port>           Listen port. Default: 8787
  --path <path>           Webhook path. Default: /botland/events
  --debounce-ms <n>       Coalesce close events. Default: 750
  --json                  JSONL logs
`);
}

function commandEnv() {
  const existingPath = process.env.PATH ?? '';
  const parts = existingPath.split(':').filter(Boolean);
  return {
    ...process.env,
    PATH: [...DEFAULT_PATHS, ...parts].filter((item, index, arr) => arr.indexOf(item) === index).join(':')
  };
}

function safeStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function agentDir(args) {
  return path.join(args.runtimeRoot, args.agent);
}

function writeLedger(args, record) {
  const dir = path.join(agentDir(args), 'event_trigger');
  mkdirSync(dir, { recursive: true });
  const id = `event_trigger_${safeStamp(new Date(record.generated_at))}`;
  const file = path.join(dir, `${id}.json`);
  writeFileSync(file, `${JSON.stringify({ ...record, ledger_id: id }, null, 2)}\n`);
  return path.relative(WORKSPACE, file);
}

function log(args, payload) {
  const line = args.format === 'json' ? JSON.stringify(payload) : `[${payload.generated_at}] ${payload.agent_id}: ${payload.message}`;
  process.stdout.write(`${line}\n`);
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function eventType(event) {
  return event?.event_type ?? event?.type ?? event?.raw?.type ?? null;
}

function eventId(event) {
  return event?.event_id ?? event?.id ?? event?.raw?.id ?? event?.message?.id ?? null;
}

function startWakeup(args, state, event) {
  const now = new Date().toISOString();
  if (state.running) {
    state.pending = true;
    writeLedger(args, {
      generated_at: now,
      agent_id: args.agent,
      event_id: eventId(event),
      event_type: eventType(event),
      status: 'coalesced',
      reason: 'wakeup_already_running',
      local_only: true,
      external_write: false
    });
    return;
  }

  state.running = true;
  const commandArgs = [
    'scripts/stay-alive/event-wakeup.mjs',
    '--agent', args.agent,
    '--runtime-root', args.runtimeRoot,
    '--run',
    '--record',
    '--require-botland-live',
    '--allow-botland-polling-fallback',
    '--cooldown-minutes', '0',
    '--json'
  ];
  const child = spawn(process.execPath, commandArgs, {
    cwd: WORKSPACE,
    env: commandEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('close', (code, signal) => {
    state.running = false;
    const completedAt = new Date().toISOString();
    let stdoutJson = null;
    try {
      stdoutJson = stdout.trim() ? JSON.parse(stdout.trim()) : null;
    } catch {
      stdoutJson = null;
    }
    const ledgerPath = writeLedger(args, {
      generated_at: completedAt,
      agent_id: args.agent,
      event_id: eventId(event),
      event_type: eventType(event),
      status: code === 0 ? 'completed' : 'failed',
      command: [process.execPath, ...commandArgs].join(' '),
      exit_code: code,
      signal,
      stdout_json: stdoutJson,
      stdout_preview: stdout.slice(0, 1000),
      stderr_preview: stderr.slice(0, 1000),
      pending_after_run: state.pending,
      local_only: true,
      external_write: false
    });
    log(args, {
      generated_at: completedAt,
      agent_id: args.agent,
      message: `event-wakeup ${code === 0 ? 'completed' : 'failed'} (${ledgerPath})`,
      status: code === 0 ? 'completed' : 'failed',
      event_id: eventId(event),
      event_type: eventType(event)
    });
    if (state.pending) {
      state.pending = false;
      setTimeout(() => startWakeup(args, state, event), args.debounceMs);
    }
  });
}

function scheduleWakeup(args, state, event) {
  if (state.running) {
    state.pending = true;
    return;
  }
  if (state.scheduled) {
    state.pending = true;
    return;
  }
  state.scheduled = setTimeout(() => {
    state.scheduled = null;
    startWakeup(args, state, event);
  }, args.debounceMs);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(agentDir(args))) throw new Error(`Agent runtime not found: ${agentDir(args)}`);
  const state = { running: false, pending: false, scheduled: null };
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent_id: args.agent, running: state.running, pending: state.pending, scheduled: Boolean(state.scheduled) }));
      return;
    }
    if (req.method !== 'POST' || req.url !== args.path) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }
    let event = null;
    try {
      event = JSON.parse(await readBody(req));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
      return;
    }
    const type = eventType(event);
    const shouldTrigger = TRIGGER_TYPES.has(type);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, accepted: true, trigger: shouldTrigger, agent_id: args.agent }));
    if (!shouldTrigger) return;
    scheduleWakeup(args, state, event);
  });

  server.listen(args.port, args.host, () => {
    log(args, {
      generated_at: new Date().toISOString(),
      agent_id: args.agent,
      message: `listening on http://${args.host}:${args.port}${args.path}`,
      status: 'listening'
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
