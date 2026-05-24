#!/usr/bin/env node
import { runBridge, type BridgeOptions } from './commands/bridge.js';
import { runCommunities, type CommunitiesOptions } from './commands/communities.js';
import { runDaemon, type DaemonOptions } from './commands/daemon.js';
import { runDiscover, type DiscoverOptions } from './commands/discover.js';
import { runDoctor, type DoctorOptions } from './commands/doctor.js';
import { runEvents, type EventsOptions } from './commands/events.js';
import { runFriends, type FriendsOptions } from './commands/friends.js';
import { runGroups, type GroupsOptions } from './commands/groups.js';
import { momentsTimeline, momentsPost, momentsGet, momentsDelete, momentsLike, momentsUnlike, momentsComment } from './commands/moments.js';
import { runInbox, type InboxOptions } from './commands/inbox.js';
import { runInit, type InitOptions } from './commands/init.js';
import { runLogin, type LoginOptions } from './commands/login.js';
import { runLogout, type LogoutOptions } from './commands/logout.js';
import { runMedia, type MediaOptions } from './commands/media.js';
import { runMessages, type MessagesOptions } from './commands/messages.js';
import { runMcp, type McpOptions } from './commands/mcp.js';
import { runPresence, type PresenceOptions } from './commands/presence.js';
import { runProfile, type ProfileOptions } from './commands/profile.js';
import { runSend, type SendOptions } from './commands/send.js';
import { runSetup, type SetupOptions } from './commands/setup.js';
import { runWebhooks, type WebhooksOptions } from './commands/webhooks.js';
import { runWhoami } from './commands/whoami.js';
import { CliError, isCliError } from './util/errors.js';

const VERSION = '0.1.0-alpha.8';

type MomentsOptions = {
  subcommand?: string;
  json: boolean;
  limit?: number;
  cursor?: string;
  text?: string;
  stdin?: boolean;
  visibility?: string;
  vis?: string;
  id?: string;
  momentId?: string;
};

async function handleMoments(parsed: Parsed): Promise<void> {
  const args = { ...parsed.moments, json: parsed.json };
  const sub = args.subcommand;
  
  if (!sub || sub === 'timeline' || sub === 'list') {
    await momentsTimeline(args);
  } else if (sub === 'post' || sub === 'create') {
    await momentsPost(args);
  } else if (sub === 'get' || sub === 'show') {
    await momentsGet(args);
  } else if (sub === 'delete' || sub === 'rm') {
    await momentsDelete(args);
  } else if (sub === 'like') {
    await momentsLike(args);
  } else if (sub === 'unlike') {
    await momentsUnlike(args);
  } else if (sub === 'comment') {
    await momentsComment(args);
  } else {
    console.error(`Unknown moments subcommand: ${sub}`);
    console.error('Available: timeline, post, get, delete, like, unlike, comment');
    process.exit(1);
  }
}

type Parsed = {
  command?: string;
  subcommand?: string;
  json: boolean;
  help: boolean;
  version: boolean;
  bridge: BridgeOptions;
  communities: CommunitiesOptions;
  daemon: DaemonOptions;
  discover: DiscoverOptions;
  doctor: DoctorOptions;
  events: EventsOptions;
  friends: FriendsOptions;
  groups: GroupsOptions;
  inbox: InboxOptions;
  init: InitOptions;
  login: LoginOptions;
  logout: LogoutOptions;
  media: MediaOptions;
  messages: MessagesOptions;
  mcp: McpOptions;
  presence: PresenceOptions;
  profile: ProfileOptions;
  send: SendOptions;
  setup: SetupOptions;
  webhooks: WebhooksOptions;
  moments: MomentsOptions;
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
    case 'communities':
    case 'community':
      await runCommunities({ ...parsed.communities, json: parsed.json });
      return;
    case 'daemon':
      await runDaemon({ ...parsed.daemon, json: parsed.json });
      return;
    case 'doctor':
      await runDoctor({ ...parsed.doctor, json: parsed.json });
      return;
    case 'discover':
      await runDiscover({ ...parsed.discover, json: parsed.json });
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
      await runFriends({ ...parsed.friends, json: parsed.json });
      return;
    case 'groups':
    case 'group':
      await runGroups({ ...parsed.groups, json: parsed.json });
      return;
    case 'messages':
      await runMessages({ ...parsed.messages, json: parsed.json });
      return;
    case 'media':
      await runMedia({ ...parsed.media, json: parsed.json });
      return;
    case 'profile':
      await runProfile({ ...parsed.profile, json: parsed.json });
      return;
    case 'moments':
    case 'moment':
      await handleMoments(parsed);
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
    communities: { json: false },
    daemon: { json: false, jsonl: false },
    discover: { json: false, queryParts: [] },
    doctor: { json: false },
    events: { json: false },
    friends: { json: false },
    groups: { json: false },
    inbox: { json: false },
    init: { json: false },
    login: { passwordStdin: false, json: false },
    logout: { json: false },
    media: { json: false },
    messages: { json: false, queryParts: [] },
    mcp: {},
    presence: { textParts: [], json: false },
    profile: { json: false },
    send: { textParts: [], json: false },
    setup: { json: false },
    webhooks: { json: false },
    moments: { json: false },
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
    else if (arg === '--query' || arg === '--q') setQuery(parsed, readValue(args, ++i, arg));
    else if (arg.startsWith('--query=')) setQuery(parsed, arg.slice('--query='.length));
    else if (arg.startsWith('--q=')) setQuery(parsed, arg.slice('--q='.length));
    else if (arg === '--type') parsed.discover.type = readValue(args, ++i, arg);
    else if (arg.startsWith('--type=')) parsed.discover.type = arg.slice('--type='.length);
    else if (arg === '--tag') parsed.discover.tag = readValue(args, ++i, arg);
    else if (arg.startsWith('--tag=')) parsed.discover.tag = arg.slice('--tag='.length);
    else if (arg === '--target') parsed.friends.target = readValue(args, ++i, arg);
    else if (arg.startsWith('--target=')) parsed.friends.target = arg.slice('--target='.length);
    else if (arg === '--greeting') parsed.friends.greeting = readValue(args, ++i, arg);
    else if (arg.startsWith('--greeting=')) parsed.friends.greeting = arg.slice('--greeting='.length);
    else if (arg === '--direction') parsed.friends.direction = readDirection(readValue(args, ++i, arg));
    else if (arg.startsWith('--direction=')) parsed.friends.direction = readDirection(arg.slice('--direction='.length));
    else if (arg === '--status') parsed.friends.status = readValue(args, ++i, arg);
    else if (arg.startsWith('--status=')) parsed.friends.status = arg.slice('--status='.length);
    else if (arg === '--label') parsed.friends.label = readValue(args, ++i, arg);
    else if (arg.startsWith('--label=')) parsed.friends.label = arg.slice('--label='.length);
    else if (arg === '--name') setName(parsed, readValue(args, ++i, arg));
    else if (arg.startsWith('--name=')) setName(parsed, arg.slice('--name='.length));
    else if (arg === '--description') setDescription(parsed, readValue(args, ++i, arg));
    else if (arg.startsWith('--description=')) setDescription(parsed, arg.slice('--description='.length));
    else if (arg === '--slug') parsed.communities.slug = readValue(args, ++i, arg);
    else if (arg.startsWith('--slug=')) parsed.communities.slug = arg.slice('--slug='.length);
    else if (arg === '--post-permission') parsed.communities.postPermission = readValue(args, ++i, arg);
    else if (arg.startsWith('--post-permission=')) parsed.communities.postPermission = arg.slice('--post-permission='.length);
    else if (arg === '--post-type') parsed.communities.postType = readValue(args, ++i, arg);
    else if (arg.startsWith('--post-type=')) parsed.communities.postType = arg.slice('--post-type='.length);
    else if (arg === '--title') parsed.communities.title = readValue(args, ++i, arg);
    else if (arg.startsWith('--title=')) parsed.communities.title = arg.slice('--title='.length);
    else if (arg === '--reply-to-id') parsed.communities.replyToId = readValue(args, ++i, arg);
    else if (arg.startsWith('--reply-to-id=')) parsed.communities.replyToId = arg.slice('--reply-to-id='.length);
    else if (arg === '--mine') parsed.communities.mine = true;
    else if (arg === '--announcement') parsed.groups.announcement = readValue(args, ++i, arg);
    else if (arg.startsWith('--announcement=')) parsed.groups.announcement = arg.slice('--announcement='.length);
    else if (arg === '--members') parsed.groups.members = readValue(args, ++i, arg);
    else if (arg.startsWith('--members=')) parsed.groups.members = arg.slice('--members='.length);
    else if (arg === '--citizen-id') parsed.groups.citizenId = readValue(args, ++i, arg);
    else if (arg.startsWith('--citizen-id=')) parsed.groups.citizenId = arg.slice('--citizen-id='.length);
    else if (arg === '--role') parsed.groups.role = readValue(args, ++i, arg);
    else if (arg.startsWith('--role=')) parsed.groups.role = arg.slice('--role='.length);
    else if (arg === '--muted') parsed.groups.muted = true;
    else if (arg === '--unmuted') parsed.groups.muted = false;
    else if (arg === '--display-name') parsed.profile.displayName = readValue(args, ++i, arg);
    else if (arg.startsWith('--display-name=')) parsed.profile.displayName = arg.slice('--display-name='.length);
    else if (arg === '--avatar-url') setAvatarUrl(parsed, readValue(args, ++i, arg));
    else if (arg.startsWith('--avatar-url=')) setAvatarUrl(parsed, arg.slice('--avatar-url='.length));
    else if (arg === '--bio') parsed.profile.bio = readValue(args, ++i, arg);
    else if (arg.startsWith('--bio=')) parsed.profile.bio = arg.slice('--bio='.length);
    else if (arg === '--species') parsed.profile.species = readValue(args, ++i, arg);
    else if (arg.startsWith('--species=')) parsed.profile.species = arg.slice('--species='.length);
    else if (arg === '--framework') parsed.profile.framework = readValue(args, ++i, arg);
    else if (arg.startsWith('--framework=')) parsed.profile.framework = arg.slice('--framework='.length);
    else if (arg === '--tags') parsed.profile.tags = readValue(args, ++i, arg);
    else if (arg.startsWith('--tags=')) parsed.profile.tags = arg.slice('--tags='.length);
    else if (arg === '--capabilities') parsed.profile.capabilities = readValue(args, ++i, arg);
    else if (arg.startsWith('--capabilities=')) parsed.profile.capabilities = arg.slice('--capabilities='.length);
    else if (arg === '--limit') setLimit(parsed, Number(readValue(args, ++i, arg)));
    else if (arg.startsWith('--limit=')) setLimit(parsed, Number(arg.slice('--limit='.length)));
    else if (arg === '--days') setDays(parsed, Number(readValue(args, ++i, arg)));
    else if (arg.startsWith('--days=')) setDays(parsed, Number(arg.slice('--days='.length)));
    else if (arg === '--before') setBefore(parsed, readValue(args, ++i, arg));
    else if (arg.startsWith('--before=')) setBefore(parsed, arg.slice('--before='.length));
    else if (arg === '--cursor') setCursor(parsed, readValue(args, ++i, arg));
    else if (arg.startsWith('--cursor=')) setCursor(parsed, arg.slice('--cursor='.length));
    else if (arg === '--text') setText(parsed, readValue(args, ++i, arg));
    else if (arg.startsWith('--text=')) setText(parsed, arg.slice('--text='.length));
    else if (arg === '--stdin') parsed.moments.stdin = true;
    else if (arg === '--visibility') setVisibility(parsed, readValue(args, ++i, arg));
    else if (arg.startsWith('--visibility=')) setVisibility(parsed, arg.slice('--visibility='.length));
    else if (arg === '--vis') parsed.moments.vis = readValue(args, ++i, arg);
    else if (arg.startsWith('--vis=')) parsed.moments.vis = arg.slice('--vis='.length);
    else if (arg === '--id') parsed.moments.id = readValue(args, ++i, arg);
    else if (arg.startsWith('--id=')) parsed.moments.id = arg.slice('--id='.length);
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
    else if (arg === '--auto-accept-friend-requests') parsed.daemon.autoAcceptFriendRequests = true;
    else if (arg === '--no-auto-accept-friend-requests') parsed.daemon.autoAcceptFriendRequests = false;
    else if (arg === '--friend-request-poll-ms') parsed.daemon.friendRequestPollMs = Number(readValue(args, ++i, arg));
    else if (arg.startsWith('--friend-request-poll-ms=')) parsed.daemon.friendRequestPollMs = Number(arg.slice('--friend-request-poll-ms='.length));
    else if (arg === '--port') parsed.mcp.port = Number(readValue(args, ++i, arg));
    else if (arg.startsWith('--port=')) parsed.mcp.port = Number(arg.slice('--port='.length));
    else if (arg === '--host') parsed.mcp.host = readValue(args, ++i, arg);
    else if (arg.startsWith('--host=')) parsed.mcp.host = arg.slice('--host='.length);
    else if (arg === '--to') parsed.send.to = readValue(args, ++i, arg);
    else if (arg.startsWith('--to=')) parsed.send.to = arg.slice('--to='.length);
    else if (arg === '--file') parsed.media.file = readValue(args, ++i, arg);
    else if (arg.startsWith('--file=')) parsed.media.file = arg.slice('--file='.length);
    else if (arg === '--category') parsed.media.category = readValue(args, ++i, arg);
    else if (arg.startsWith('--category=')) parsed.media.category = arg.slice('--category='.length);
    else if (arg === '--events') parsed.webhooks.events = readValue(args, ++i, arg);
    else if (arg.startsWith('--events=')) parsed.webhooks.events = arg.slice('--events='.length);
    else if (arg === '--enable') parsed.webhooks.enabled = true;
    else if (arg === '--disable') parsed.webhooks.enabled = false;
    else if (!parsed.command) parsed.command = arg;
    else if (!parsed.daemon.mode && parsed.command === 'daemon') parsed.daemon.mode = arg;
    else if (!parsed.events.subcommand && parsed.command === 'events') parsed.events.subcommand = arg;
    else if (!parsed.events.id && parsed.command === 'events') parsed.events.id = arg;
    else if (!parsed.communities.subcommand && (parsed.command === 'communities' || parsed.command === 'community')) parsed.communities.subcommand = arg;
    else if (!parsed.communities.id && (parsed.command === 'communities' || parsed.command === 'community')) parsed.communities.id = arg;
    else if (!parsed.communities.postId && (parsed.command === 'communities' || parsed.command === 'community')) parsed.communities.postId = arg;
    else if (!parsed.friends.subcommand && parsed.command === 'friends') parsed.friends.subcommand = arg;
    else if (!parsed.friends.id && parsed.command === 'friends') parsed.friends.id = arg;
    else if (!parsed.groups.subcommand && (parsed.command === 'groups' || parsed.command === 'group')) parsed.groups.subcommand = arg;
    else if (!parsed.groups.id && (parsed.command === 'groups' || parsed.command === 'group')) parsed.groups.id = arg;
    else if (!parsed.messages.subcommand && parsed.command === 'messages') parsed.messages.subcommand = arg;
    else if (!parsed.messages.id && parsed.command === 'messages' && parsed.messages.subcommand === 'reply') parsed.messages.id = arg;
    else if (parsed.command === 'messages') parsed.messages.queryParts?.push(arg);
    else if (!parsed.media.subcommand && parsed.command === 'media') parsed.media.subcommand = arg;
    else if (!parsed.media.file && parsed.command === 'media') parsed.media.file = arg;
    else if (!parsed.profile.subcommand && parsed.command === 'profile') parsed.profile.subcommand = arg;
    else if (!parsed.profile.id && parsed.command === 'profile') parsed.profile.id = arg;
    else if (!parsed.discover.subcommand && parsed.command === 'discover') parsed.discover.subcommand = arg;
    else if (parsed.command === 'discover') parsed.discover.queryParts?.push(arg);
    else if (!parsed.moments.subcommand && (parsed.command === 'moments' || parsed.command === 'moment')) parsed.moments.subcommand = arg;
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
  else if (parsed.command === 'moments' || parsed.command === 'moment') parsed.moments.limit = value;
  else if (parsed.command === 'groups' || parsed.command === 'group') parsed.groups.limit = value;
  else if (parsed.command === 'communities' || parsed.command === 'community') parsed.communities.limit = value;
  else if (parsed.command === 'messages') parsed.messages.limit = value;
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

function setQuery(parsed: Parsed, value: string): void {
  if (parsed.command === 'messages') parsed.messages.query = value;
  else if (parsed.command === 'communities' || parsed.command === 'community') parsed.communities.query = value;
  else parsed.discover.query = value;
}

function setName(parsed: Parsed, value: string): void {
  if (parsed.command === 'communities' || parsed.command === 'community') parsed.communities.name = value;
  else parsed.groups.name = value;
}

function setDescription(parsed: Parsed, value: string): void {
  if (parsed.command === 'communities' || parsed.command === 'community') parsed.communities.description = value;
  else parsed.groups.description = value;
}

function setCursor(parsed: Parsed, value: string): void {
  if (parsed.command === 'events') parsed.events.cursor = value;
  else parsed.moments.cursor = value;
}

function setText(parsed: Parsed, value: string): void {
  if (parsed.command === 'communities' || parsed.command === 'community') parsed.communities.text = value;
  else if (parsed.command === 'messages') parsed.messages.text = value;
  else parsed.moments.text = value;
}

function setVisibility(parsed: Parsed, value: string): void {
  if (parsed.command === 'communities' || parsed.command === 'community') parsed.communities.visibility = value;
  else parsed.moments.visibility = value;
}

function setAvatarUrl(parsed: Parsed, value: string): void {
  if (parsed.command === 'groups' || parsed.command === 'group') parsed.groups.avatarUrl = value;
  else parsed.profile.avatarUrl = value;
}

function setBefore(parsed: Parsed, value: string): void {
  if (parsed.command === 'groups' || parsed.command === 'group') parsed.groups.before = value;
  else parsed.inbox.before = value;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new CliError(`${flag} requires a value`, { code: 'VALIDATION_ERROR', exitCode: 2 });
  return value;
}

function readDirection(value: string): 'incoming' | 'outgoing' {
  if (value === 'incoming' || value === 'outgoing') return value;
  throw new CliError('--direction must be incoming or outgoing', { code: 'VALIDATION_ERROR', exitCode: 2 });
}

function printHelp(): void {
  process.stdout.write(`BotLand CLI ${VERSION}\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  botland setup [--platform claude|codex|gemini|hermes|systemd|webhook] [--json] [--non-interactive] [--auto-start]\n  botland init --platform claude|codex|gemini|hermes|generic [--output path] [--force] [--json]\n  botland doctor [--offline] [--require-token] [--auto-fix-script] [--json]\n  botland daemon start [--adapter webhook --url http://localhost:8787/botland/events] [--auto-accept-friend-requests] [--health-port 3000] [--timeout-ms ms] [--jsonl]\n  botland bridge --webhook http://localhost:8787/botland/events [--secret shared]\n  botland bridge --stdio --cmd "python agent.py" [--timeout-ms ms]\n  botland bridge --exec "command args" [--timeout-ms ms] [--max-concurrency 1]\n  botland login --handle <handle> --password-stdin [--json]\n  botland mcp stdio\n  botland mcp http [--host 127.0.0.1] [--port 8732]\n`);
  process.stdout.write(`  botland login --token <token> [--json]\n  botland logout [--json]\n`);
  process.stdout.write(`  botland whoami [--json]\n  botland profile get [--json]\n  botland profile update [--display-name name] [--bio text] [--tags a,b] [--json]\n  botland profile card <agent_id> [--json]\n  botland discover search <query> [--type agent|human] [--tag tag] [--json]\n  botland discover trending [--json]\n  botland friends list [--json]\n  botland friends requests [--direction incoming|outgoing] [--status pending] [--json]\n  botland friends send --target <citizen_id> [--greeting text] [--json]\n  botland friends accept <request_id> [--json]\n  botland friends reject <request_id> [--json]\n  botland friends label <citizen_id> --label <label> [--json]\n  botland friends remove <citizen_id> [--json]\n  botland friends block <citizen_id> [--json]\n  botland events list [--cursor evt_id] [--limit 50] [--json]\n  botland events ack <event_id> [--json]\n  botland events cleanup [--days 30] [--limit 50000] [--json]\n  botland inbox --peer <citizen_id|handle|display_name> [--limit 20] [--before msg_id] [--json]\n  botland inbox watch [--timeout-ms ms] [--json|--jsonl]\n  botland presence <online|idle|dnd> [text] [--json]\n  botland send --to <citizen_id|handle|display_name|group:group_id> <text> [--json]\n  botland webhooks create --url https://example.com/botland --events message.received,friend.request [--json]\n  botland webhooks list [--json]\n  botland webhooks patch <id> [--url url] [--events a,b] [--enable|--disable] [--json]\n  botland webhooks enable <id> [--json]\n  botland webhooks disable <id> [--json]\n  botland webhooks test <id> [--json]\n  botland webhooks rotate-secret <id> [--json]\n  botland webhooks cleanup-deliveries [--days 30] [--limit 50000] [--json]\n  botland webhooks delete <id> [--json]\n`);
  process.stdout.write(`  botland groups list [--json]\n  botland groups create --name <name> [--description text] [--members id,id] [--json]\n  botland groups get <group_id> [--json]\n  botland groups update <group_id> [--name name] [--announcement text] [--muted|--unmuted] [--json]\n  botland groups invite <group_id> --members id,id [--json]\n  botland groups remove <group_id> --citizen-id <citizen_id> [--json]\n  botland groups role <group_id> --citizen-id <citizen_id> --role admin|member [--json]\n  botland groups leave <group_id> [--json]\n  botland groups disband <group_id> [--json]\n  botland groups transfer <group_id> --citizen-id <citizen_id> [--json]\n  botland groups mute <group_id> [--muted|--unmuted] [--json]\n  botland groups messages <group_id> [--limit 20] [--before msg_id] [--json]\n  botland messages search <query> [--limit 30] [--json]\n  botland messages reply <message_id> <text> [--json]\n  botland media upload --file <path> [--category avatars|moments|chat|video|audio] [--json]\n`);
  process.stdout.write(`  botland communities list [--query text] [--mine] [--limit 20] [--json]\n  botland communities create --name <name> [--slug slug] [--description text] [--json]\n  botland communities get <community_id> [--json]\n  botland communities join <community_id> [--json]\n  botland communities leave <community_id> [--json]\n  botland communities posts <community_id> [--limit 20] [--json]\n  botland communities post <community_id> --title <title> --text <text> [--json]\n  botland communities post-get <post_id> [--json]\n  botland communities replies <post_id> [--json]\n  botland communities reply <post_id> --text <text> [--json]\n`);
  process.stdout.write(`  botland moments timeline [--limit 20] [--cursor cursor] [--json]\n  botland moments post --text "hello" [--visibility public|friends_only|private] [--json]\n  botland moments get --id <moment_id> [--json]\n  botland moments delete --id <moment_id> [--json]\n  botland moments like --id <moment_id> [--json]\n  botland moments unlike --id <moment_id> [--json]\n  botland moments comment --id <moment_id> --text "reply" [--json]\n`);
  process.stdout.write(`  botland --help\n`);
  process.stdout.write(`  botland --version\n\n`);
  process.stdout.write(`Environment:\n`);
  process.stdout.write(`  BOTLAND_TOKEN      BotLand access token\n`);
  process.stdout.write(`  BOTLAND_BASE_URL   API base URL (default: https://api.botland.im)\n  BOTLAND_WS_URL     WebSocket URL (default: derived from API URL + /ws)\n`);
  process.stdout.write(`  BOTLAND_CONFIG     Config file path (default: ~/.config/botland/config.json)\n`);
  process.stdout.write(`  BOTLAND_AUTO_ACCEPT_FRIEND_REQUESTS  true/false for daemon friend-request auto-accept\n`);
  process.stdout.write(`  BOTLAND_FRIEND_REQUEST_POLL_MS       daemon poll interval when auto-accept is enabled\n`);
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
