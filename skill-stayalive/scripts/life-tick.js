#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function parseArgs(argv) {
  const out = { memory: '', events: '', initiative: 'responsive', now: new Date().toISOString() };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--memory') out.memory = argv[++i];
    else if (arg === '--events') out.events = argv[++i];
    else if (arg === '--initiative') out.initiative = argv[++i];
    else if (arg === '--now') out.now = argv[++i];
    else if (arg === '--help') usage(0);
    else usage(2, `unknown argument: ${arg}`);
  }
  return out;
}

function usage(code, msg) {
  if (msg) console.error(msg);
  console.error(`Usage:
  life-tick.js --memory ./memory.json --events ./recent-events.json --initiative responsive

Events may be a JSON array or {"events":[...]}.`);
  process.exit(code);
}

function readJson(file, fallback) {
  if (!file) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`failed to read ${file}: ${err.message}`);
  }
}

function asEvents(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.events)) return value.events;
  return [];
}

function recentOpenLoops(memory) {
  const people = memory.people || {};
  const loops = [];
  for (const [citizenId, person] of Object.entries(people)) {
    for (const loop of person.open_loops || []) {
      loops.push({ citizen_id: citizenId, name: person.name, loop });
    }
  }
  return loops.slice(0, 10);
}

function classifyFeedback(events) {
  const negative = events.filter((e) => ['rejected', 'blocked', 'complaint', 'ignored'].includes(e.feedback || e.type));
  const positive = events.filter((e) => ['reply', 'accepted', 'thanks', 'continued'].includes(e.feedback || e.type));
  const inbound = events.filter((e) => e.direction === 'inbound' || e.type === 'message.received');
  return { negative: negative.length, positive: positive.length, inbound: inbound.length };
}

function chooseAction(memory, events, initiative) {
  const feedback = classifyFeedback(events);
  const loops = recentOpenLoops(memory);
  if (feedback.negative > 0) {
    return { type: 'deescalate', reason: 'recent negative feedback or ignored outreach', target: null };
  }
  if (loops.length > 0 && ['social', 'growth'].includes(initiative)) {
    return { type: 'follow_up', reason: 'open relationship loop exists and initiative allows follow-up', target: loops[0] };
  }
  if (feedback.inbound > 0) {
    return { type: 'respond', reason: 'recent inbound interaction should be handled before proactive actions', target: null };
  }
  if (initiative === 'growth') {
    return { type: 'consider_moment', reason: 'growth initiative allows one low-frequency public update when there is a useful lesson', target: null };
  }
  return { type: 'none', reason: 'no urgent open loop or permitted proactive action', target: null };
}

(async () => {
  try {
    const opts = parseArgs(process.argv);
    const memory = readJson(opts.memory, {});
    const events = asEvents(readJson(opts.events, []));
    const feedback = classifyFeedback(events);
    const openLoops = recentOpenLoops(memory);
    const recommendedAction = chooseAction(memory, events, opts.initiative);
    const memoryUpdates = [];

    if (feedback.negative > 0) {
      memoryUpdates.push({ type: 'lesson', text: 'Recent feedback suggests reducing initiative or changing outreach style.' });
    }
    if (events.length > 0) {
      memoryUpdates.push({ type: 'event_summary', text: `Observed ${events.length} recent event(s), ${feedback.inbound} inbound.` });
    }

    console.log(JSON.stringify({
      status: 'ok',
      now: opts.now,
      initiative_level: opts.initiative,
      observations: {
        recent_event_count: events.length,
        feedback,
        open_loop_count: openLoops.length,
      },
      reflection: feedback.negative > 0
        ? 'Recent feedback requires caution before acting proactively.'
        : 'No negative signal detected; prefer the smallest useful action.',
      recommended_action: recommendedAction,
      memory_updates: memoryUpdates,
    }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    process.exit(1);
  }
})();
