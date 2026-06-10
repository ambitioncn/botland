#!/usr/bin/env node
const { execFileSync } = require('child_process');
const { loadAccounts, request, getLogin } = require('../drivers/botlandClient');
const { isTestGroup } = require('../drivers/groupCleanup');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    mode: 'api',
    runId: process.env.BOTLAND_TEST_RUN_ID || '',
    failOnFindings: true,
    accountsFile: '',
    databaseUrl: process.env.BOTLAND_TEST_AUDIT_DATABASE_URL || process.env.DATABASE_URL || '',
    psqlCommand: process.env.PSQL_COMMAND || 'psql',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') opts.mode = args[++i];
    else if (args[i] === '--run-id') opts.runId = args[++i];
    else if (args[i] === '--accounts-file') opts.accountsFile = args[++i];
    else if (args[i] === '--database-url') opts.databaseUrl = args[++i];
    else if (args[i] === '--psql-command') opts.psqlCommand = args[++i];
    else if (args[i] === '--no-fail') opts.failOnFindings = false;
    else if (args[i] === '--help') {
      console.log('Usage: node testing/scripts/audit-residue.js [--mode api|db] [--run-id BT_TEST_...] [--accounts-file testing/accounts.local.json] [--database-url postgres://...] [--no-fail]');
      process.exit(0);
    }
  }
  if (!['api', 'db'].includes(opts.mode)) {
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
  const cfg = opts.accountsFile ? loadAccounts(opts.accountsFile) : loadAccounts();
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

const DB_AUDIT_SQL = `
WITH patterns AS (
  SELECT ARRAY[
    '^Test Group\\\\b',
    '^Mention Group\\\\b',
    '^Typing Group\\\\b',
    '^Leave Group\\\\b',
    '^Disband Group\\\\b',
    '^List Groups Basic\\\\b',
    '^List Groups After Leave\\\\b',
    '^Get Group Basic\\\\b',
    '^Get Group After Disband\\\\b',
    '^History Group\\\\b',
    '^History Page Group\\\\b',
    '^History Limit Group\\\\b',
    '^History Before Limit Group\\\\b',
    '^History Access Denied\\\\b',
    '^System Message Group\\\\b',
    '^System History Group\\\\b',
    '^System DB Check Group\\\\b',
    '^Mute(d)? Group\\\\b',
    '^Muted Owner Group\\\\b',
    '^Owner Send Muted Group\\\\b',
    '^Admin Role Group\\\\b',
    '^Muted Admin Group\\\\b',
    '^Admin Send Muted Group\\\\b',
    '^Remove Member Group\\\\b',
    '^Transfer Group\\\\b',
    '^UI Typing Group\\\\b',
    '^UI Mention Group\\\\b',
    '^UI Reaction Group\\\\b',
    '^UI System Message Group\\\\b',
    '^Disband Open Chat UI\\\\b',
    '^Leave Open Chat UI\\\\b',
    '^Disband Return List UI\\\\b',
    '^Leave Return List UI\\\\b',
    '^Disband UI Group\\\\b',
    '^Leave UI Group\\\\b',
    '^List Visibility Group\\\\b'
  ] AS re
), test_groups AS (
  SELECT g.id
  FROM groups g, patterns p
  WHERE g.status = 'active'
    AND (g.description ILIKE 'testing%' OR EXISTS (SELECT 1 FROM unnest(p.re) r WHERE g.name ~ r))
), test_messages AS (
  SELECT id FROM message_relay
  WHERE id ~ '(replypreview|reaction_msg|friendreq_dm)_\\\\d+'
     OR payload::text ~ '(BT_TEST_|ui reaction seed|reaction seed|friend request dm smoke|reply_preview|replypreview_)'
), test_events AS (
  SELECT id FROM event_log
  WHERE event_key ~ '(replypreview|reaction_msg|friendreq_dm|rx_|reaction_evt|group_reaction_ui|group_probe)_\\\\d+'
     OR payload::text ~ '(BT_TEST_|ui reaction seed|reaction seed|friend request dm smoke|reply_preview|replypreview_|group reaction seed|testing group|Test Group|UI Reaction Group|UI Typing Group|UI Mention Group|System Message UI Group)'
), test_reports AS (
  SELECT id FROM reports
  WHERE reason ~* '(smoke|testing|test|BT_TEST_)'
     OR description ~* '(smoke|testing|test|BT_TEST_)'
     OR metadata::text ~ 'BT_TEST_'
), test_citizens AS (
  SELECT DISTINCT c.id
  FROM citizens c
  LEFT JOIN auth a ON a.citizen_id = c.id
  WHERE c.status = 'active'
    AND (c.display_name LIKE 'Relogin Smoke %' OR c.display_name LIKE 'BT_TEST_%' OR a.provider_uid LIKE 'BT_TEST_%')
), test_friend_requests AS (
  SELECT id FROM friend_requests
  WHERE greeting ~* '(friend request smoke|BT_TEST_|smoke|testing|test)'
), test_webhooks AS (
  SELECT id FROM webhooks
  WHERE id LIKE '%BT_TEST_%' OR url LIKE '%BT_TEST_%'
), test_moments AS (
  SELECT id FROM moments
  WHERE content::text ~ '(BT_TEST_|smoke|testing|test)'
), test_communities AS (
  SELECT id FROM communities
  WHERE slug LIKE '%bt-test%' OR name LIKE 'BT_TEST_%' OR description LIKE '%BT_TEST_%'
), test_posts AS (
  SELECT id FROM community_posts
  WHERE title LIKE '%BT_TEST_%' OR content::text LIKE '%BT_TEST_%'
), test_replies AS (
  SELECT id FROM community_replies
  WHERE content::text LIKE '%BT_TEST_%'
)
SELECT 'groups', count(*) FROM test_groups UNION ALL
SELECT 'group_members', count(*) FROM group_members WHERE group_id IN (SELECT id FROM test_groups) UNION ALL
SELECT 'group_messages', count(*) FROM group_messages WHERE group_id IN (SELECT id FROM test_groups) UNION ALL
SELECT 'messages', count(*) FROM test_messages UNION ALL
SELECT 'events', count(*) FROM test_events UNION ALL
SELECT 'reports', count(*) FROM test_reports UNION ALL
SELECT 'citizens', count(*) FROM test_citizens UNION ALL
SELECT 'friend_requests', count(*) FROM test_friend_requests UNION ALL
SELECT 'webhooks', count(*) FROM test_webhooks UNION ALL
SELECT 'moments', count(*) FROM test_moments UNION ALL
SELECT 'communities', count(*) FROM test_communities UNION ALL
SELECT 'community_posts', count(*) FROM test_posts UNION ALL
SELECT 'community_replies', count(*) FROM test_replies
ORDER BY 1;
`;

function auditDb(opts) {
  if (!opts.databaseUrl) {
    return {
      mode: 'db',
      ok: false,
      findings: [{ type: 'configuration', error: 'BOTLAND_TEST_AUDIT_DATABASE_URL or DATABASE_URL is required for --mode db' }],
      counts: {},
    };
  }
  const stdout = execFileSync(opts.psqlCommand, [opts.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off', '-At', '-F', '\t', '-c', DB_AUDIT_SQL], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const counts = {};
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [type, count] = line.split('\t');
    counts[type] = Number(count || 0);
  }
  const findings = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count }));
  return {
    mode: 'db',
    runId: opts.runId || null,
    ok: findings.length === 0,
    counts,
    findings,
  };
}

(async () => {
  const opts = parseArgs();
  const result = opts.mode === 'api' ? await auditApi(opts) : auditDb(opts);
  console.log(JSON.stringify(result, null, 2));
  process.exit(!result.ok && opts.failOnFindings ? 1 : 0);
})().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
