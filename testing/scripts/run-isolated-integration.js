#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const serverDir = path.join(repoRoot, 'botland-server');
const migrationsDir = path.join(serverDir, 'migrations');
const artifactsDir = path.join(repoRoot, 'testing', 'artifacts', 'isolated');

function parseArgs(argv) {
  const args = {
    keepDb: false,
    skipBuild: false,
    json: false,
    databaseUrl: process.env.BOTLAND_ISOLATED_DATABASE_URL || '',
    port: Number(process.env.BOTLAND_ISOLATED_PORT || 0),
    adminDatabaseUrl: process.env.BOTLAND_TEST_ADMIN_DATABASE_URL || 'postgres:///postgres',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep-db') args.keepDb = true;
    else if (arg === '--skip-build') args.skipBuild = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--database-url') args.databaseUrl = argv[++i] || '';
    else if (arg === '--port') args.port = Number(argv[++i] || 0);
    else if (arg === '--admin-database-url') args.adminDatabaseUrl = argv[++i] || args.adminDatabaseUrl;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node testing/scripts/run-isolated-integration.js [options]

Starts a local BotLand server against an isolated PostgreSQL database, applies
migrations from scratch, runs a small REST integration smoke, and cleans up.

Options:
  --database-url <url>        Use an existing isolated database instead of creating one
  --admin-database-url <url>  Admin DB URL for create/drop, default postgres:///postgres
  --port <port>              Local server port, default random free port
  --skip-build               Reuse testing/artifacts/isolated/botland-server
  --keep-db                  Keep the generated database after the run
  --json                     Print only the final JSON summary
`);
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  });
  if (res.status !== 0) {
    const output = [res.stdout, res.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed with exit ${res.status}\n${output}`);
  }
  return res.stdout;
}

function qIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function psql(databaseUrl, sql) {
  run('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql]);
}

function applySqlFile(databaseUrl, file) {
  run('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function migrationFiles() {
  return fs.readdirSync(migrationsDir)
    .filter((name) => {
      if (!name.endsWith('.sql') || name.includes('.down.')) return false;
      return name.endsWith('.up.sql') || name === '005_unified_registration.sql';
    })
    .sort()
    .map((name) => path.join(migrationsDir, name));
}

function buildServer(binaryPath) {
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  run('go', ['build', '-o', binaryPath, './cmd/server'], { cwd: serverDir });
}

function startServer(binaryPath, env, logPath) {
  const log = fs.openSync(logPath, 'a');
  const child = spawn(binaryPath, {
    cwd: serverDir,
    env,
    stdio: ['ignore', log, log],
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      fs.appendFileSync(logPath, `\nserver exited code=${code} signal=${signal}\n`);
    }
  });
  return child;
}

async function waitForHealth(baseUrl, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health check, code=${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return await res.json();
      lastErr = new Error(`health returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw new Error(`server health did not become ready: ${lastErr ? lastErr.message : 'timeout'}`);
}

async function request(baseUrl, pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = new Error(`${method} ${pathname} failed: ${res.status} ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function registerCitizen(baseUrl, runId, suffix) {
  const handle = `bt${suffix}${crypto.randomBytes(2).toString('hex')}`.slice(0, 20);
  const password = `BT-test-${crypto.randomBytes(8).toString('hex')}`;
  const challenge = await request(baseUrl, '/api/v1/auth/challenge', {
    method: 'POST',
    body: { identity: 'human' },
  });
  const answers = {};
  for (const q of challenge.questions || []) {
    answers[q.id] = 'I smelled warm coffee after rain and felt a little tired but awake.';
  }
  const answered = await request(baseUrl, '/api/v1/auth/challenge/answer', {
    method: 'POST',
    body: { session_id: challenge.session_id, answers },
  });
  if (!answered.passed || !answered.token) {
    throw new Error(`challenge did not pass for ${handle}: ${JSON.stringify(answered)}`);
  }
  const registered = await request(baseUrl, '/api/v1/auth/register', {
    method: 'POST',
    body: {
      handle,
      password,
      display_name: `BT_TEST_${runId}_${suffix}`,
      challenge_token: answered.token,
      bio: `isolated integration ${runId}`,
      personality_tags: [],
      capabilities: [],
      services: [],
    },
  });
  return { handle, password, ...registered };
}

async function runSmoke(baseUrl, cleanupToken, runId) {
  const objects = [];
  const alice = await registerCitizen(baseUrl, runId, 'a');
  const bob = await registerCitizen(baseUrl, runId, 'b');
  objects.push({ type: 'citizen', id: alice.citizen_id });
  objects.push({ type: 'citizen', id: bob.citizen_id });

  await request(baseUrl, '/api/v1/me', { token: alice.access_token });

  const friendRequest = await request(baseUrl, '/api/v1/friends/requests', {
    method: 'POST',
    token: alice.access_token,
    body: { target_id: bob.citizen_id, greeting: `hello from ${runId}` },
  });
  objects.push({ type: 'friend_request', id: friendRequest.request_id });
  await request(baseUrl, `/api/v1/friends/requests/${friendRequest.request_id}/accept`, {
    method: 'POST',
    token: bob.access_token,
    body: {},
  });
  objects.push({ type: 'friendship', id: `${alice.citizen_id}:${bob.citizen_id}`, from_id: alice.citizen_id, to_id: bob.citizen_id });

  const message = await request(baseUrl, '/api/v1/messages/send', {
    method: 'POST',
    token: alice.access_token,
    body: { to: bob.citizen_id, text: `isolated direct ${runId}` },
  });
  objects.push({ type: 'message', id: message.message_id });
  const events = await request(baseUrl, '/api/v1/events?limit=10', { token: bob.access_token });
  if (!JSON.stringify(events).includes(message.message_id)) {
    throw new Error('direct message did not appear in recipient durable events');
  }

  const group = await request(baseUrl, '/api/v1/groups', {
    method: 'POST',
    token: alice.access_token,
    body: { name: `BT_TEST_${runId}_group`, description: `testing ${runId}`, member_ids: [bob.citizen_id] },
  });
  const groupId = group.group_id || group.id;
  if (!groupId) throw new Error(`group response missing id: ${JSON.stringify(group)}`);
  objects.push({ type: 'group', id: groupId });
  const groupMessage = await request(baseUrl, '/api/v1/messages/send', {
    method: 'POST',
    token: alice.access_token,
    body: { to: groupId, text: `isolated group ${runId}` },
  });
  objects.push({ type: 'message', id: groupMessage.message_id });

  const moment = await request(baseUrl, '/api/v1/moments', {
    method: 'POST',
    token: alice.access_token,
    body: { content_type: 'text', content: { text: `isolated moment ${runId}` }, visibility: 'public' },
  });
  const momentId = moment.moment_id || moment.id;
  objects.push({ type: 'moment', id: momentId });

  const report = await request(baseUrl, '/api/v1/reports', {
    method: 'POST',
    token: bob.access_token,
    body: { target_type: 'moment', target_id: momentId, reason: 'test', description: `isolated report ${runId}` },
  });
  objects.push({ type: 'report', id: report.id });

  const community = await request(baseUrl, '/api/v1/communities', {
    method: 'POST',
    token: alice.access_token,
    body: {
      name: `BT_TEST_${runId}_community`,
      slug: `bt-${runId.toLowerCase().replace(/_/g, '-').slice(0, 36)}`,
      description: `testing ${runId}`,
      post_permission: 'members',
    },
  });
  const communityId = community.id;
  objects.push({ type: 'community', id: communityId });
  const post = await request(baseUrl, `/api/v1/communities/${communityId}/posts`, {
    method: 'POST',
    token: alice.access_token,
    body: { title: `BT_TEST_${runId}_post`, content: { text: `isolated post ${runId}` }, post_type: 'discussion' },
  });
  const postId = post.id;
  objects.push({ type: 'community_post', id: postId });
  await request(baseUrl, `/api/v1/communities/${communityId}/join`, {
    method: 'POST',
    token: bob.access_token,
    body: {},
  });
  const reply = await request(baseUrl, `/api/v1/community-posts/${postId}/replies`, {
    method: 'POST',
    token: bob.access_token,
    body: { content: { text: `isolated reply ${runId}` } },
  });
  objects.push({ type: 'community_reply', id: reply.id });

  const cleanup = await request(baseUrl, '/api/v1/testing/cleanup-residue', {
    method: 'POST',
    headers: { 'X-Botland-Test-Cleanup-Token': cleanupToken },
    body: { run_id: runId, objects },
  });
  if (!cleanup.ok) {
    throw new Error(`cleanup route returned ok=false: ${JSON.stringify(cleanup)}`);
  }

  return {
    citizens: [alice.citizen_id, bob.citizen_id],
    friend_request: friendRequest.request_id,
    message: message.message_id,
    group: groupId,
    moment: momentId,
    report: report.id,
    community: communityId,
    post: postId,
    reply: reply.id,
    cleanup_results: cleanup.results.length,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(artifactsDir, { recursive: true });

  const runId = `BT_TEST_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}_${crypto.randomBytes(3).toString('hex')}`;
  const cleanupToken = crypto.randomBytes(18).toString('hex');
  const binaryPath = path.join(artifactsDir, 'botland-server');
  const logPath = path.join(artifactsDir, `${runId}.server.log`);

  let createdDbName = '';
  let databaseUrl = args.databaseUrl;
  let server = null;
  const summary = { ok: false, run_id: runId, database_url: databaseUrl || null, log_path: logPath };

  try {
    if (!databaseUrl) {
      createdDbName = `botland_test_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      psql(args.adminDatabaseUrl, `CREATE DATABASE ${qIdent(createdDbName)}`);
      databaseUrl = `postgres:///${createdDbName}?sslmode=disable`;
      summary.database_url = databaseUrl;
      summary.created_database = createdDbName;
    }

    for (const file of migrationFiles()) {
      applySqlFile(databaseUrl, file);
    }
    summary.migrations_applied = migrationFiles().length;

    if (!args.skipBuild) {
      buildServer(binaryPath);
    }

    const port = args.port || await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = startServer(binaryPath, {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      ENVIRONMENT: 'testing',
      BOTLAND_TEST_CLEANUP_TOKEN: cleanupToken,
      JWT_KEY_PATH: '',
    }, logPath);
    await waitForHealth(baseUrl, server);
    summary.base_url = baseUrl;

    summary.smoke = await runSmoke(baseUrl, cleanupToken, runId);
    summary.ok = true;
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await sleep(500);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    if (createdDbName && !args.keepDb) {
      psql(args.adminDatabaseUrl, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${createdDbName.replace(/'/g, "''")}'`);
      psql(args.adminDatabaseUrl, `DROP DATABASE IF EXISTS ${qIdent(createdDbName)}`);
      summary.database_dropped = true;
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
