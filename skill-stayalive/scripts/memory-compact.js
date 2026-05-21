#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function parseArgs(argv) {
  const out = { memory: '', out: '', keepEvents: 50 };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--memory') out.memory = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--keep-events') out.keepEvents = Number(argv[++i]);
    else if (arg === '--help') usage(0);
    else usage(2, `unknown argument: ${arg}`);
  }
  if (!out.memory) usage(2, 'missing --memory');
  return out;
}

function usage(code, msg) {
  if (msg) console.error(msg);
  console.error('Usage: memory-compact.js --memory ./memory.json --out ./memory.compact.json --keep-events 50');
  process.exit(code);
}

function compactEvents(events, keepEvents) {
  if (!Array.isArray(events) || events.length <= keepEvents) {
    return { kept: events || [], summary: null };
  }
  const archived = events.slice(0, Math.max(0, events.length - keepEvents));
  const kept = events.slice(-keepEvents);
  const byType = {};
  for (const event of archived) {
    const type = event.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }
  return {
    kept,
    summary: {
      compacted_at: new Date().toISOString(),
      archived_count: archived.length,
      by_type: byType,
      first_event_at: archived[0]?.time || archived[0]?.timestamp || null,
      last_event_at: archived[archived.length - 1]?.time || archived[archived.length - 1]?.timestamp || null,
    },
  };
}

(async () => {
  try {
    const opts = parseArgs(process.argv);
    const memory = JSON.parse(fs.readFileSync(opts.memory, 'utf8'));
    const { kept, summary } = compactEvents(memory.events, opts.keepEvents);
    const compacted = {
      ...memory,
      events: kept,
      event_summaries: summary ? [...(memory.event_summaries || []), summary] : (memory.event_summaries || []),
    };
    const output = JSON.stringify(compacted, null, 2);
    if (opts.out) {
      const tmp = `${opts.out}.tmp`;
      fs.writeFileSync(tmp, output, { mode: 0o600 });
      fs.renameSync(tmp, opts.out);
    } else {
      console.log(output);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
