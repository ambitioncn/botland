#!/usr/bin/env node
const { loadAccounts, request, getLogin } = require('../drivers/botlandClient');
const { isTestGroup } = require('../drivers/groupCleanup');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { mode: 'api', runId: process.env.BOTLAND_TEST_RUN_ID || '', failOnFindings: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') opts.mode = args[++i];
    else if (args[i] === '--run-id') opts.runId = args[++i];
    else if (args[i] === '--no-fail') opts.failOnFindings = false;
    else if (args[i] === '--help') {
      console.log('Usage: node testing/scripts/audit-residue.js [--mode api] [--run-id BT_TEST_...] [--no-fail]');
      process.exit(0);
    }
  }
  if (opts.mode !== 'api') {
    console.error(`Unsupported audit mode: ${opts.mode}`);
    process.exit(2);
  }
  return opts;
}

function hasMarker(value, runId) {
  const text = String(value || '');
  if (runId && text.includes(runId)) return true;
  return /\bBT_TEST_\d{8}T\d{6}Z_[A-Za-z0-9_.-]+\b/.test(text);
}

function isResidueWebhook(webhook, runId) {
  return hasMarker(webhook.id, runId) || hasMarker(webhook.url, runId);
}

function isResidueReport(report, runId) {
  return (
    hasMarker(report.id, runId) ||
    hasMarker(report.target_id, runId) ||
    hasMarker(report.reason, runId) ||
    hasMarker(report.description, runId) ||
    hasMarker(JSON.stringify(report.metadata || {}), runId) ||
    /\b(smoke|testing|test)\b/i.test(`${report.reason || ''} ${report.description || ''}`)
  );
}

async function auditApi(opts) {
  const cfg = loadAccounts();
  const actors = Object.values(cfg.actors || {}).filter((actor) => actor?.handle && actor?.password);
  const findings = [];
  const checked = [];

  for (const actor of actors) {
    let login;
    try {
      login = await getLogin(cfg.baseUrl, actor.handle, actor.password);
      checked.push(actor.handle);
    } catch (err) {
      findings.push({ type: 'auth', actor: actor.handle, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    try {
      const groups = await request(cfg.baseUrl, '/api/v1/groups', { token: login.access_token });
      for (const group of Array.isArray(groups) ? groups : []) {
        if (isTestGroup(group) || hasMarker(group.name, opts.runId) || hasMarker(group.description, opts.runId)) {
          findings.push({ type: 'group', actor: actor.handle, id: group.id, name: group.name });
        }
      }
    } catch (err) {
      findings.push({ type: 'groups_audit_error', actor: actor.handle, error: err instanceof Error ? err.message : String(err) });
    }

    try {
      const webhooks = await request(cfg.baseUrl, '/api/v1/webhooks', { token: login.access_token });
      for (const webhook of webhooks.webhooks || []) {
        if (isResidueWebhook(webhook, opts.runId)) {
          findings.push({ type: 'webhook', actor: actor.handle, id: webhook.id, url: webhook.url });
        }
      }
    } catch (err) {
      findings.push({ type: 'webhooks_audit_error', actor: actor.handle, error: err instanceof Error ? err.message : String(err) });
    }

    try {
      const reports = await request(cfg.baseUrl, '/api/v1/reports?limit=100', { token: login.access_token });
      for (const report of reports.reports || []) {
        if (isResidueReport(report, opts.runId)) {
          findings.push({ type: 'report', actor: actor.handle, id: report.id, target_type: report.target_type, target_id: report.target_id, status: report.status });
        }
      }
    } catch (err) {
      findings.push({ type: 'reports_audit_error', actor: actor.handle, error: err instanceof Error ? err.message : String(err) });
    }

    try {
      for (const direction of ['incoming', 'outgoing']) {
        const requests = await request(
          cfg.baseUrl,
          `/api/v1/friends/requests?direction=${direction}&status=pending`,
          { token: login.access_token }
        );
        for (const item of requests.requests || []) {
          if (hasMarker(item.greeting, opts.runId) || /\b(smoke|testing|test)\b/i.test(item.greeting || '')) {
            findings.push({ type: 'friend_request', actor: actor.handle, direction, id: item.request_id, from_id: item.from_id, to_id: item.to_id });
          }
        }
      }
    } catch (err) {
      findings.push({ type: 'friend_requests_audit_error', actor: actor.handle, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    mode: 'api',
    runId: opts.runId || null,
    checkedActors: checked,
    ok: findings.length === 0,
    findings,
  };
}

(async () => {
  const opts = parseArgs();
  const result = await auditApi(opts);
  console.log(JSON.stringify(result, null, 2));
  process.exit(!result.ok && opts.failOnFindings ? 1 : 0);
})().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
