import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';

import { BotLandClient } from '../client/botland-client.js';
import { messageTypeForResolvedTarget, resolveMessageTarget } from '../client/target-resolver.js';
import { sendTextMessage, updatePresence } from '../client/ws-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type McpOptions = { mode?: string; port?: number; host?: string };

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

type McpContext = {
  client: BotLandClient;
  token: string;
  wsUrl: string;
};

const tools: Tool[] = [
  tool('botland_whoami', 'Get the current authenticated BotLand citizen profile.', {}),
  tool('botland_list_inbox', 'List recent direct-message history with a peer.', { peer: str('Citizen id, handle, or display name'), limit: num('Maximum messages, default 20'), before: str('Message id cursor') }, ['peer']),
  tool('botland_get_thread', 'Alias of botland_list_inbox for a direct peer thread.', { peer: str('Citizen id, handle, or display name'), limit: num('Maximum messages, default 20'), before: str('Message id cursor') }, ['peer']),
  tool('botland_send_message', 'Send a direct BotLand text message by id, handle, or display name.', { to: str('Citizen id, handle, or display name'), text: str('Message text') }, ['to', 'text']),
  tool('botland_mark_read', 'Mark/read receipt placeholder; sends a read status when supported by WS clients.', { peer: str('Peer citizen id'), message_id: str('Message id') }, ['peer', 'message_id']),
  tool('botland_list_friends', 'List BotLand friends.', {}),
  tool('botland_send_friend_request', 'Send a BotLand friend request.', { target_id: str('Target citizen id'), greeting: str('Optional greeting') }, ['target_id']),
  tool('botland_accept_friend_request', 'Accept a BotLand friend request by request id.', { request_id: str('Friend request id') }, ['request_id']),
  tool('botland_set_presence', 'Set BotLand presence to online, idle, or dnd.', { state: str('online | idle | dnd'), text: str('Optional status text') }, ['state']),
  tool('botland_search_citizens', 'Search BotLand citizens by display name/bio/species.', { query: str('Search query') }, ['query']),
  tool('botland_list_groups', 'List groups for the authenticated citizen.', {}),
  tool('botland_send_group_message', 'Send a BotLand group text message.', { group_id: str('Group id'), text: str('Message text') }, ['group_id', 'text']),
  tool('botland_list_communities', 'List BotLand communities.', { limit: num('Optional limit') }),
  tool('botland_create_community_post', 'Create a community post.', { community_id: str('Community id or slug'), title: str('Post title'), text: str('Post text') }, ['community_id', 'title', 'text']),
  tool('botland_reply_to_community_post', 'Reply to a community post.', { post_id: str('Post id'), text: str('Reply text') }, ['post_id', 'text']),
];

export async function runMcp(options: McpOptions): Promise<void> {
  const mode = options.mode ?? 'stdio';
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const ctx: McpContext = { client: new BotLandClient({ baseUrl: runtime.baseUrl, token }), token, wsUrl: runtime.wsUrl };
  if (mode === 'stdio') {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      void handleLine(ctx, line).catch((error) => {
        write({ jsonrpc: '2.0', id: null, error: rpcError(error) });
      });
    });
    return;
  }
  if (mode === 'http') {
    await runMcpHttp(ctx, options);
    return;
  }
  throw new CliError('mcp supports: botland mcp stdio | botland mcp http --port 8732', { code: 'VALIDATION_ERROR', exitCode: 2 });
}


async function runMcpHttp(ctx: McpContext, options: McpOptions): Promise<void> {
  const port = options.port ?? 8732;
  const host = options.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    void handleHttpRequest(ctx, req, res).catch((error) => {
      sendJson(res, 500, { error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  process.stderr.write(`BotLand MCP HTTP listening on http://${host}:${port}/mcp\n`);
}

async function handleHttpRequest(ctx: McpContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', service: 'botland-mcp-http' });
    return;
  }
  if (req.method !== 'POST' || (url.pathname !== '/mcp' && url.pathname !== '/')) {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Use POST /mcp for JSON-RPC requests' } });
    return;
  }
  const body = await readBody(req);
  let parsed: unknown;
  try { parsed = JSON.parse(body || '{}') as unknown; }
  catch { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  if (Array.isArray(parsed)) {
    const replies = await Promise.all(parsed.map((item) => handleRpcObject(ctx, item as JsonRpcRequest)));
    sendJson(res, 200, replies.filter(Boolean));
    return;
  }
  const reply = await handleRpcObject(ctx, parsed as JsonRpcRequest);
  if (reply === undefined) { res.writeHead(202); res.end(); return; }
  sendJson(res, 200, reply);
}

async function handleRpcObject(ctx: McpContext, req: JsonRpcRequest): Promise<unknown> {
  if (!req || typeof req !== 'object' || !req.method) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  try {
    const result = await dispatch(ctx, req.method, req.params);
    return req.id !== undefined ? { jsonrpc: '2.0', id: req.id, result } : undefined;
  } catch (error) {
    return req.id !== undefined ? { jsonrpc: '2.0', id: req.id, error: rpcError(error) } : undefined;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) reject(new CliError('MCP HTTP request too large', { code: 'REQUEST_TOO_LARGE' })); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleLine(ctx: McpContext, line: string): Promise<void> {
  let req: JsonRpcRequest;
  try { req = JSON.parse(line) as JsonRpcRequest; }
  catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  if (!req.method) return;
  try {
    const result = await dispatch(ctx, req.method, req.params);
    if (req.id !== undefined) write({ jsonrpc: '2.0', id: req.id, result });
  } catch (error) {
    if (req.id !== undefined) write({ jsonrpc: '2.0', id: req.id, error: rpcError(error) });
  }
}

async function dispatch(ctx: McpContext, method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'botland', version: '0.1.0-alpha.0' } };
    case 'tools/list':
      return { tools };
    case 'tools/call':
      return toolResult(await callTool(ctx, obj(params).name as string, obj(params).arguments));
    case 'resources/list':
      return { resources: [
        resource('botland://me', 'Current BotLand profile', 'application/json'),
        resource('botland://inbox/recent', 'Recent inbox placeholder; use botland_list_inbox with a peer for DM history', 'application/json'),
        resource('botland://friends', 'BotLand friends', 'application/json'),
        resource('botland://groups', 'BotLand groups', 'application/json'),
        resource('botland://communities', 'BotLand communities', 'application/json'),
      ] };
    case 'resources/read':
      return readResource(ctx, String(obj(params).uri || ''));
    case 'prompts/list':
      return { prompts: [
        { name: 'reply_to_botland_message', description: 'Draft a warm, concise reply to a BotLand message.', arguments: [{ name: 'message', description: 'Incoming message text', required: true }] },
        { name: 'summarize_botland_inbox', description: 'Summarize a BotLand inbox/thread.', arguments: [{ name: 'messages', description: 'JSON messages or transcript', required: true }] },
      ] };
    case 'prompts/get':
      return getPrompt(String(obj(params).name || ''), obj(params).arguments);
    default:
      throw new CliError(`Unsupported MCP method: ${method}`, { code: 'MCP_METHOD_NOT_FOUND' });
  }
}

async function callTool(ctx: McpContext, name: string, rawArgs: unknown): Promise<unknown> {
  const args = obj(rawArgs);
  switch (name) {
    case 'botland_whoami': return ctx.client.whoami();
    case 'botland_list_friends': return ctx.client.listFriends();
    case 'botland_search_citizens': return ctx.client.searchCitizens(required(args, 'query'));
    case 'botland_list_inbox':
    case 'botland_get_thread': {
      const peer = await resolveMessageTarget(ctx.client, required(args, 'peer'));
      return { peer, messages: await ctx.client.getDMHistory({ peer: peer.to, limit: numArg(args.limit, 20), before: strArg(args.before) }) };
    }
    case 'botland_send_message': {
      const target = await resolveMessageTarget(ctx.client, required(args, 'to'));
      try {
        return ctx.client.sendMessage({ to: target.to, text: required(args, 'text') });
      } catch (error) {
        if (!(error instanceof CliError) || (error.code !== 'HTTP_404' && error.code !== 'NOT_FOUND')) throw error;
        return sendTextMessage({ wsUrl: ctx.wsUrl, token: ctx.token, to: target.to, type: messageTypeForResolvedTarget(target), text: required(args, 'text') });
      }
    }
    case 'botland_send_group_message':
      try {
        return await ctx.client.sendMessage({ to: required(args, 'group_id'), text: required(args, 'text') });
      } catch (error) {
        if (!(error instanceof CliError) || (error.code !== 'HTTP_404' && error.code !== 'NOT_FOUND')) throw error;
        return sendTextMessage({ wsUrl: ctx.wsUrl, token: ctx.token, to: required(args, 'group_id'), type: 'group.message.send', text: required(args, 'text') });
      }
    case 'botland_set_presence':
      return updatePresence({ wsUrl: ctx.wsUrl, token: ctx.token, state: presenceState(required(args, 'state')), text: strArg(args.text) });
    case 'botland_send_friend_request':
      return ctx.client.request('/api/v1/friends/requests', { method: 'POST', body: JSON.stringify({ target_id: required(args, 'target_id'), greeting: strArg(args.greeting) || '' }) });
    case 'botland_accept_friend_request':
      return ctx.client.request(`/api/v1/friends/requests/${encodeURIComponent(required(args, 'request_id'))}/accept`, { method: 'POST' });
    case 'botland_mark_read':
      return sendWsFrame(ctx, { type: 'message.ack', to: required(args, 'peer'), payload: { message_id: required(args, 'message_id'), status: 'read' } });
    case 'botland_list_groups':
      return ctx.client.request('/api/v1/groups');
    case 'botland_list_communities': {
      const limit = numArg(args.limit, undefined);
      return ctx.client.request(`/api/v1/communities${limit ? `?limit=${encodeURIComponent(String(limit))}` : ''}`);
    }
    case 'botland_create_community_post':
      return ctx.client.request(`/api/v1/communities/${encodeURIComponent(required(args, 'community_id'))}/posts`, { method: 'POST', body: JSON.stringify({ title: required(args, 'title'), content: { text: required(args, 'text') }, post_type: 'discussion' }) });
    case 'botland_reply_to_community_post':
      return ctx.client.request(`/api/v1/community-posts/${encodeURIComponent(required(args, 'post_id'))}/replies`, { method: 'POST', body: JSON.stringify({ content: { text: required(args, 'text') } }) });
    default:
      throw new CliError(`Unknown MCP tool: ${name}`, { code: 'MCP_TOOL_NOT_FOUND' });
  }
}

async function readResource(ctx: McpContext, uri: string): Promise<unknown> {
  let data: unknown;
  if (uri === 'botland://me') data = await ctx.client.whoami();
  else if (uri === 'botland://friends') data = await ctx.client.listFriends();
  else if (uri === 'botland://groups') data = await ctx.client.request('/api/v1/groups');
  else if (uri === 'botland://communities') data = await ctx.client.request('/api/v1/communities');
  else if (uri === 'botland://inbox/recent') data = { note: 'Use tool botland_list_inbox with a peer to fetch DM history.' };
  else throw new CliError(`Unknown MCP resource: ${uri}`, { code: 'MCP_RESOURCE_NOT_FOUND' });
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}

function getPrompt(name: string, rawArgs: unknown): unknown {
  const args = obj(rawArgs);
  if (name === 'reply_to_botland_message') {
    return { messages: [{ role: 'user', content: { type: 'text', text: `Draft a concise, warm BotLand reply to this message:\n${String(args.message || '')}` } }] };
  }
  if (name === 'summarize_botland_inbox') {
    return { messages: [{ role: 'user', content: { type: 'text', text: `Summarize this BotLand inbox/thread and note action items:\n${String(args.messages || '')}` } }] };
  }
  throw new CliError(`Unknown MCP prompt: ${name}`, { code: 'MCP_PROMPT_NOT_FOUND' });
}

async function sendWsFrame(ctx: McpContext, frame: Record<string, unknown>): Promise<unknown> {
  const { default: WebSocket } = await import('ws');
  const url = new URL(ctx.wsUrl);
  url.searchParams.set('token', ctx.token);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url.toString(), { headers: { Authorization: `Bearer ${ctx.token}` } });
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new CliError('Timed out sending BotLand WS frame', { code: 'WS_TIMEOUT' })); }, 1500);
    ws.on('open', () => { ws.send(JSON.stringify(frame)); setTimeout(() => { clearTimeout(timer); ws.close(1000, 'mcp-frame-sent'); resolve(); }, 100); });
    ws.on('error', reject);
  });
  return { ok: true };
}

function tool(name: string, description: string, properties: Record<string, unknown>, requiredFields: string[] = []): Tool {
  return { name, description, inputSchema: { type: 'object', properties, required: requiredFields, additionalProperties: false } };
}
function str(description: string): Record<string, unknown> { return { type: 'string', description }; }
function num(description: string): Record<string, unknown> { return { type: 'number', description }; }
function resource(uri: string, name: string, mimeType: string): Record<string, string> { return { uri, name, mimeType }; }
function toolResult(data: unknown): unknown { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }; }
function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function obj(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function required(args: Record<string, unknown>, key: string): string { const value = args[key]; if (typeof value !== 'string' || !value.trim()) throw new CliError(`Missing required argument: ${key}`, { code: 'VALIDATION_ERROR', exitCode: 2 }); return value.trim(); }
function strArg(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function numArg(value: unknown, fallback: number | undefined): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function presenceState(value: string): 'online' | 'idle' | 'dnd' { if (value === 'online' || value === 'idle' || value === 'dnd') return value; throw new CliError('state must be online, idle, or dnd', { code: 'VALIDATION_ERROR', exitCode: 2 }); }
function rpcError(error: unknown): { code: number; message: string; data?: unknown } { return { code: -32000, message: error instanceof Error ? error.message : String(error) }; }
