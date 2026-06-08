#!/usr/bin/env node

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    host: '127.0.0.1',
    port: 4873,
    dryRun: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--host') args.host = argv[++i];
    else if (arg === '--port') args.port = Number.parseInt(argv[++i], 10);
    else if (arg === '--dry-run') args.dryRun = true;
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
  console.log(`Usage: node scripts/stay-alive/operator-review-server.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory
  --host <host>         Bind host. Default: 127.0.0.1
  --port <port>         Bind port. Default: 4873
  --dry-run             Validate startup and exit
  --help                Show this help

Local tool-supervision console server. GET / renders a review page. POST /api/execute can
only call proposal-batch and requires the existing batch confirm token. It never
calls BotLand send/post/reply/join/report and does not bypass governance.

It is a boundary facility, not an agency source. Use it to inspect and execute
tool-supervised local proposal batches; do not use it to author the agent's desires
or direction.
`);
}

function runJson(script, argv) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024
  });
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    parsed = null;
  }
  return {
    ok: result.status === 0,
    status: result.status,
    parsed,
    stderr: String(result.stderr ?? '').slice(0, 2000)
  };
}

function baseArgs(args) {
  return ['--agent', args.agent, '--runtime-root', args.runtimeRoot];
}

function reviewReport(args) {
  return runJson('scripts/stay-alive/operator-review-console.mjs', [...baseArgs(args), '--json']);
}

function executeBatch(args, body) {
  const mode = body.mode;
  const token = body.confirm_batch;
  const allowed = new Set(['apply-local', 'dismiss-stale', 'apply-and-dismiss']);
  if (!allowed.has(mode)) {
    return { ok: false, status: 400, error: 'unsupported mode' };
  }
  const max = Number.isInteger(body.max) ? String(Math.max(1, Math.min(body.max, 50))) : '10';
  return runJson('scripts/stay-alive/proposal-batch.mjs', [
    ...baseArgs(args),
    '--mode', mode,
    '--max', max,
    '--confirm-batch', String(token ?? ''),
    '--json'
  ]);
}

function page(report) {
  const data = report.parsed ?? {};
  const governance = data.proposal_governance ?? {};
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stay-Alive Operator Review</title>
<style>
body{font:14px system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;background:#f7f7f4;color:#20201d}
main{max-width:1120px;margin:0 auto}.bar{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.tile{border:1px solid #d8d5cc;border-radius:6px;padding:12px;background:#fff}
button{border:1px solid #565142;border-radius:6px;background:#fff;padding:8px 10px;cursor:pointer}input,select{padding:7px;border:1px solid #bbb;border-radius:5px}
pre{white-space:pre-wrap;background:#181816;color:#f2f2e8;padding:12px;border-radius:6px;overflow:auto}.muted{color:#666}
</style></head><body><main>
<h1>Stay-Alive Operator Review</h1>
<p class="muted">Boundary facility only. Local tool-supervised console; execution requires existing proposal-batch confirm tokens.</p>
<section class="bar">
<div class="tile">proposals<br><strong>${governance.proposal_count ?? 0}</strong></div>
<div class="tile">visible<br><strong>${governance.visible_count ?? 0}</strong></div>
<div class="tile">executable<br><strong>${governance.executable_count ?? 0}</strong></div>
<div class="tile">duplicates<br><strong>${governance.duplicate_group_count ?? 0}</strong></div>
</section>
<h2>Execute Batch</h2>
<p>
<select id="mode"><option>apply-local</option><option>dismiss-stale</option><option>apply-and-dismiss</option></select>
<input id="token" placeholder="confirm token" size="38">
<input id="max" type="number" value="10" min="1" max="50">
<button onclick="execute()">Run</button>
<button onclick="location.reload()">Refresh</button>
</p>
<pre id="out">${escapeHtml(JSON.stringify(data, null, 2).slice(0, 12000))}</pre>
<script>
async function execute(){
 const body={mode:document.getElementById('mode').value,confirm_batch:document.getElementById('token').value,max:Number(document.getElementById('max').value)};
 const res=await fetch('/api/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 document.getElementById('out').textContent=JSON.stringify(await res.json(),null,2);
}
</script>
</main></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function start(args) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/') {
        const report = reviewReport(args);
        response.writeHead(report.ok ? 200 : 500, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page(report));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/review') {
        const report = reviewReport(args);
        response.writeHead(report.ok ? 200 : 500, { 'content-type': 'application/json' });
        response.end(JSON.stringify(report.parsed ?? report, null, 2));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/execute') {
        const body = JSON.parse(await readBody(request) || '{}');
        const result = executeBatch(args, body);
        response.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result.parsed ?? result, null, 2));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'not found' }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  });
  server.listen(args.port, args.host, () => {
    console.log(JSON.stringify({
      ok: true,
      local_only: true,
      facility_class: 'boundary_facility',
      agency_source: false,
      external_write: false,
      botland_send: false,
      url: `http://${args.host}:${args.port}/`
    }, null, 2));
  });
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      local_only: true,
      facility_class: 'boundary_facility',
      agency_source: false,
      external_write: false,
      botland_send: false,
      would_listen: `http://${args.host}:${args.port}/`
    }, null, 2));
  } else {
    start(args);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
