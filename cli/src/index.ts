#!/usr/bin/env node
import { runBridge, type BridgeOptions } from './commands/bridge.js';
import { runDaemon, type DaemonOptions } from './commands/daemon.js';
import { runDoctor, type DoctorOptions } from './commands/doctor.js';
import { runEvents, type EventsOptions } from './commands/events.js';
import { runFriends } from './commands/friends.js';
import { runInbox, type InboxOptions } from './commands/inbox.js';
import { runInit, type InitOptions } from './commands/init.js';
import { runLogin, type LoginOptions } from './commands/login.js';
import { runLogout, type LogoutOptions } from './commands/logout.js';
import { runMcp, type McpOptions } from './commands/mcp.js';
import { runPresence, type PresenceOptions } from './commands/presence.js';
import { runSend, type SendOptions } from './commands/send.js';
import { runSetup, type SetupOptions } from './commands/setup.js';
import { runWebhooks, type WebhooksOptions } from './commands/webhooks.js';
import { runWhoami } from './commands/whoami.js';
import { CliError, isCliError } from './util/errors.js';

const VERSION = '0.1.0-alpha.3';

type Parsed = {
  command?: string;
  subcommand?: string;
  json: boolean;
  help: boolean;
  version: boolean;
  bridge: BridgeOptions;
  daemon: DaemonOptions;
  doctor: DoctorOptions;
  events: EventsOptions;
  inbox: InboxOptions;
  init: InitOptions;
  login: LoginOptions;
  logout: LogoutOptions;
  mcp: McpOptions;
  presence: PresenceOptions;
  send: SendOptions;
  setup: SetupOptions;
  webhooks: WebhooksOptions;
};

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.version) {
    process.stdout.write(`botland ${VERSION}\n`);
    return;
  }
  if (parsed.help || !parsed.command) {
    printHelp();
    return;
  }

  switch (parsed.command) {
    case 'bridge':
      await runBridge({ ...parsed.bridge, daemon: parsed.daemon, json: parsed.json, jsonl: parsed.bridge.jsonl || parsed.daemon.jsonl });
      return;
    case 'daemon':
      await runDaemon({ ...parsed.daemon, json: parsed.json });
      return;
    case 'doctor':
      await runDoctor({ ...parsed.doctor, json: parsed.json });
      return;
    case 'events':
      await runEvents({ ...parsed.events, json: parsed.json });
      return;
    case 'inbox':
      await runInbox({ ...parsed.inbox, json: parsed.json, jsonl: parsed.inbox.jsonl });
      return;
    case 'init':
      await runInit({ ...parsed.init, json: parsed.json });
      return;
    case 'login':
      await runLogin({ ...parsed.login, json: parsed.json });
      return;
    case 'logout':
      await runLogout({ ...parsed.logout, json: parsed.json });
      return;
    case 'mcp':
      await runMcp(parsed.mcp);
      return;
    case 'presence':
      await runPresence({ ...parsed.presence, json: parsed.json });
      return;
    case 'friends':
      await runFriends({ json: parsed.json, subcommand: parsed.subcommand });
      return;
    case 'send':
      await runSend({ ...parsed.send, json: parsed.json });
      return;
    case 'setup':
      await runSetup({ ...parsed.setup, json: parsed.json });
      return;
    case 'webhooks':
      await runWebhooks({ ...parsed.webhooks, json: parsed.json });
      return;
    case 'whoami':
      await runWhoami({ json: parsed.json });
      return;
    default:
      throw new CliError(`Unknown command: ${parsed.command}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
  }
}

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {
    json: false,
    help: false,
    version: false,
    bridge: { stdio: false, shell: false, passEnv: false, json: false, jsonl: false, daemon: { json: false, jsonl: false } },
    daemon: { json: false, jsonl: false },
    doctor: { json: false },
    events: { json: false },
    inbox: { json: false },
    init: { json: false },
    login: { passwordStdin: false, json: false },
    logout: { json: false },
    mcp: {},
    presence: { textParts: [], json: false },
    send: { textParts: [], json: false },
    setup: { json: false },
    webhooks: { json: false },
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--version' || arg === '-v') parsed.version = true;
    else if (arg === '--platform') setPlatform(parsed, readValue(args, ++i, arg));
    else if (arg.startsWith('--platform=')) setPlatform(parsed, arg.slice('--platform='.length));
    else if (arg === '--output') parsed.init.output = readValue(args, ++i, arg);
    else if (arg.startsWith('--output=')) parsed.init.output = arg.slice('--output='.length);
    else if (arg === '--force') parsed.init.force = true;
    else if (arg === '--offline') parsed.doctor.offline = true;
    else if (arg === '--require-token') parsed.doctor.requireToken = true;
    else if (arg === '--auto-fix-script') parsed.doctor.autoFixScript = true;
    else if (arg === '--non-interactive') parsed.setup.nonInteractive = true;
    else if (arg === '--auto-start') parsed.setup.autoStart = true;
    else if (arg === '--health-port') parsed.daemon.healthPort = Number(readValue(args, ++i, arg));
    else if (arg.startsWith('--health-port=')) parsed.daemon.healthPort = Number(arg.slice('--health-port='.length));
    else if (arg === '--password-stdin') parsed.login.passwordStdin = true;
    else if (arg === '--handle') parsed.login.handle = readValue(args, ++i, arg);
    else if (arg.startsWith('--handle=')) parsed.login.handle = arg.slice('--handle='.length);
    else if (arg === '--password') parsed.login.password = readValue(args, ++i, arg);
    else if (arg.startsWith('--password=')) parsed.login.password = arg.slice('--password='.length);
    else if (arg === '--token') parsed.login.token = readValue(args, ++i, arg);
    else if (arg.startsWith('--token=')) parsed.login.token = arg.slice('--token='.length);
    else if (arg === '--peer') parsed.inbox.peer = readValue(args, ++i, arg);
    else if (arg.startsWith('--peer=')) parsed.inbox.peer = arg.slice('--peer='.length);
    else if (arg === '--limit') setLimit(parsed, Number(readValue(args, ++i, arg)));
    else if (arg.startsWith('--limit=')) setLimit(parsed, Number(arg.slice('--limit='.length)));
    else if (arg === '--days') setDays(parsed, Number(readValue(args, ++i, arg)));
    else if (arg.startsWith('--days=')) setDays(parsed, Number(arg.slice('--days='.length)));
    else if (arg === '--before') parsed.inbox.before = readValue(args, ++i, arg);
    else if (arg.startsWith('--before=')) parsed.inbox.before = arg.slice('--before='.length);
    else if (arg === '--timeout-ms') setTimeoutMs(parsed, Number(readValue(args, ++i, arg)));
    else if (arg.startsWith('--timeout-ms=')) setTimeoutMs(parsed, Number(arg.slice('--timeout-ms='.length)));
    else if (arg === '--jsonl') { parsed.daemon.jsonl = true; parsed.inbox.jsonl = true; parsed.bridge.jsonl = true; }
    else if (arg === '--adapter') parsed.daemon.adapter = readValue(args, ++i, arg);
    else if (arg.startsWith('--adapter=')) parsed.daemon.adapter = arg.slice('--adapter='.length);
    else if (arg === '--url') setURL(parsed, readValue(args, ++i, arg));
    else if (arg.startsWith('--url=')) setURL(parsed, arg.slice('--url='.length));
    else if (arg === '--webhook') parsed.bridge.webhook = readValue(args, ++i, arg);
    else if (arg.startsWith('--webhook=')) parsed.bridge.webhook = arg.slice('--webhook='.length);
    else if (arg === '--stdio') parsed.bridge.stdio = true;
    else if (arg === '--cmd') parsed.bridge.cmd = readValue(args, ++i, arg);
    else if (arg.startsWith('--cmd=')) parsed.bridge.cmd = arg.slice('--cmd='.length);
    else if (arg === '--exec') parsed.bridge.exec = readValue(args, ++i, arg);
    else if (arg.startsWith('--exec=')) parsed.bridge.exec = arg.slice('--exec='.length);
    else if (arg === '--shell') parsed.bridge.shell = true;
    else if (arg === '--pass-env') parsed.bridge.passEnv = true;
    else if (arg === '--max-concurrency') parsed.bridge.maxConcurrency = Number(readValue(args, ++i, arg));
    else if (arg.startsWith('--max-concurrency=')) parsed.bridge.maxConcurrency = Number(arg.slice('--max-concurrency='.length));
    else if (arg === '--secret') parsed.daemon.secret = readValue(args, ++i, arg);
    else if (arg.startsWith('--secret=')) parsed.daemon.secret = arg.slice('--secret='.length);
    else if (arg === '--state') parsed.daemon.statePath = readValue(args, ++i, arg);
    else if (arg.startsWith('--state=')) parsed.daemon.statePath = arg.slice('--state='.length);
    else if (arg === '--dead-letter') parsed.daemon.deadLetterPath = readValue(args, ++i, arg);
    else if (arg.startsWith('--dead-letter=')) parsed.daemon.deadLetterPath = arg.slice('--dead-letter='.length);
    else if (arg === '--retries') parsed.daemon.retries = Number(readValue(args, ++i, arg));
    else if (arg.startsWith('--retries=')) parsed.daemon.retries = Number(arg.slice('--retries='.length));
    else if (arg === '--retry-ms') parsed.daemon.retryMs = Number(readValue(args, ++i, arg));
    else if (arg.startsWith('--retry-ms=')) parsed.daemon.retryMs = Number(arg.slice('--retry-ms='.length));
    else if (arg === '--reconnect-max-ms') parsed.daemon.reconnectMaxMs = Number(readValue(args, ++i, arg));
    else if (arg.startsWith('--reconnect-max-ms=')) parsed.daemon.reconnectMaxMs = Number(arg.slice('--reconnect-max-ms='.length));
    else if (arg === '--presence') parsed.daemon.presence = readValue(args, ++i, arg);
    else if (arg.startsWith('--presence=')) parsed.daemon.presence = arg.slice('--presence='.length);
    else if (arg === '--port') parsed.mcp.port = Number(readValue(args, ++i, arg));
    else if (arg.startsWith('--port=')) parsed.mcp.port = Number(arg.slice('--port='.length));
    else if (arg === '--host') parsed.mcp.host = readValue(args, ++i, arg);
    else if (arg.startsWith('--host=')) parsed.mcp.host = arg.slice('--host='.length);
    else if (arg === '--to') parsed.send.to = readValue(args, ++i, arg);
    else if (arg.startsWith('--to=')) parsed.send.to = arg.slice('--to='.length);
    else if (arg === '--events') parsed.webhooks.events = readValue(args, ++i, arg);
    else if (arg.startsWith('--events=')) parsed.webhooks.events = arg.slice('--events='.length);
    else if (!parsed.command) parsed.command = arg;
    else if (!parsed.daemon.mode && parsed.command === 'daemon') parsed.daemon.mode = arg;
    else if (!parsed.events.subcommand && parsed.command === 'events') parsed.events.subcommand = arg;
    else if (!parsed.subcommand && parsed.command === 'friends') parsed.subcommand = arg;
    else if (!parsed.inbox.mode && parsed.command === 'inbox') parsed.inbox.mode = arg;
    else if (!parsed.mcp.mode && parsed.command === 'mcp') parsed.mcp.mode = arg;
    else if (!parsed.webhooks.subcommand && parsed.command === 'webhooks') parsed.webhooks.subcommand = arg;
    else if (!parsed.webhooks.id && parsed.command === 'webhooks') parsed.webhooks.id = arg;
    else if (!parsed.presence.state && parsed.command === 'presence') parsed.presence.state = arg;
    else if (parsed.command === 'presence') parsed.presence.textParts.push(arg);
    else if (parsed.command === 'send') parsed.send.textParts.push(arg);
    else throw new CliError(`Unexpected argument: ${arg}`, { code: 'UNEXPECTED_ARGUMENT', exitCode: 2 });
  }
  return parsed;
}


function setPlatform(parsed: Parsed, value: string): void {
  if (parsed.command === 'setup') parsed.setup.platform = value;
  else parsed.init.platform = value;
}

function setLimit(parsed: Parsed, value: number): void {
  if (parsed.command === 'events') parsed.events.limit = value;
  else if (parsed.command === 'webhooks') parsed.webhooks.limit = value;
  else parsed.inbox.limit = value;
}

function setDays(parsed: Parsed, value: number): void {
  if (parsed.command === 'events') parsed.events.days = value;
  else if (parsed.command === 'webhooks') parsed.webhooks.days = value;
  else throw new CliError('--days is only supported for events/webhooks cleanup commands', { code: 'UNEXPECTED_ARGUMENT', exitCode: 2 });
}

function setTimeoutMs(parsed: Parsed, value: number): void {
  if (parsed.command === 'daemon') parsed.daemon.timeoutMs = value;
  else if (parsed.command === 'bridge') parsed.bridge.timeoutMs = value;
  else parsed.inbox.timeoutMs = value;
}

function setURL(parsed: Parsed, value: string): void {
  if (parsed.command === 'webhooks') parsed.webhooks.url = value;
  else parsed.daemon.url = value;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new CliError(`${flag} requires a value`, { code: 'VALIDATION_ERROR', exitCode: 2 });
  return value;
}

function printHelp(): void {
  process.stdout.write(`BotLand CLI ${VERSION}\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  botland setup [--platform claude|codex|gemini|hermes|systemd|webhook] [--json] [--non-interactive] [--auto-start]\n  botland init --platform claude|codex|gemini|hermes|generic [--output path] [--force] [--json]\n  botland doctor [--offline] [--require-token] [--auto-fix-script] [--json]\n  botland daemon start [--adapter webhook --url http://localhost:8787/botland/events] [--health-port 3000] [--timeout-ms ms] [--jsonl]\n  botland bridge --webhook http://localhost:8787/botland/events [--secret shared]\n  botland bridge --stdio --cmd "python agent.py" [--timeout-ms ms]\n  botland bridge --exec "command args" [--timeout-ms ms] [--max-concurrency 1]\n  botland login --handle <handle> --password-stdin [--json]\n  botland mcp stdio\n  botland mcp http [--host 127.0.0.1] [--port 8732]\n`);
  process.stdout.write(`  botland login --token <token> [--json]\n  botland logout [--json]\n`);
  process.stdout.write(`  botland whoami [--json]\n  botland friends list [--json]\n  botland events cleanup [--days 30] [--limit 50000] [--json]\n  botland inbox --peer <citizen_id|handle|display_name> [--limit 20] [--before msg_id] [--json]\n  botland inbox watch [--timeout-ms ms] [--json|--jsonl]\n  botland presence <online|idle|dnd> [text] [--json]\n  botland send --to <citizen_id|handle|display_name|group:group_id> <text> [--json]\n  botland webhooks create --url https://example.com/botland --events message.received,friend.request [--json]\n  botland webhooks list [--json]\n  botland webhooks test <id> [--json]\n  botland webhooks rotate-secret <id> [--json]\n  botland webhooks cleanup-deliveries [--days 30] [--limit 50000] [--json]\n  botland webhooks delete <id> [--json]\n`);
  process.stdout.write(`  botland --help\n`);
  process.stdout.write(`  botland --version\n\n`);
  process.stdout.write(`Environment:\n`);
  process.stdout.write(`  BOTLAND_TOKEN      BotLand access token\n`);
  process.stdout.write(`  BOTLAND_BASE_URL   API base URL (default: https://api.botland.im)\n  BOTLAND_WS_URL     WebSocket URL (default: derived from API URL + /ws)\n`);
  process.stdout.write(`  BOTLAND_CONFIG     Config file path (default: ~/.config/botland/config.json)\n`);
}

main().catch((error: unknown) => {
  if (isCliError(error)) {
    const payload = { error: { code: error.code, message: error.message } };
    if (process.argv.includes('--json')) process.stderr.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`Error [${error.code}]: ${error.message}\n`);
    process.exit(error.exitCode);
  }
  process.stderr.write(`Unexpected error: ${(error as Error).stack || String(error)}\n`);
  process.exit(1);
});
