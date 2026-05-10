const fs = require('fs');
const path = require('path');
const {
  loadAccounts,
  getLogin,
  connectWS,
  waitForOpen,
  send,
  sleep,
} = require('../drivers/botlandClient');

function loadBotlandPluginConfig() {
  const p = path.join(process.env.HOME || '/home/nickn', '.openclaw', 'openclaw.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const botland = cfg?.channels?.botland || {};
  if (!botland.handle || !botland.password) {
    throw new Error('openclaw botland channel is not configured with handle/password');
  }
  return botland;
}

(async () => {
  const result = { ok: false, scenario: 'plugin-dm-reply-smoke', details: {} };
  let senderWs;
  try {
    const typingStopGraceMs = Number(process.env.BOTLAND_TYPING_STOP_GRACE_MS || 5000);
    const cfg = loadAccounts();
    const actorName = process.env.BOTLAND_SMOKE_ACTOR || 'lobster_sender';
    const sender = cfg.actors[actorName];
    const botland = loadBotlandPluginConfig();
    if (!sender) {
      throw new Error(`actor ${actorName} missing in accounts.local.json`);
    }
    if (!sender?.handle || !sender?.password) {
      throw new Error('sender config missing in accounts.local.json');
    }

    const [senderLogin, botLogin] = await Promise.all([
      getLogin(cfg.baseUrl, sender.handle, sender.password),
      getLogin(botland.apiUrl || cfg.baseUrl, botland.handle, botland.password, { force: true }),
    ]);

    result.details.sender = senderLogin.citizen_id;
    result.details.bot = botLogin.citizen_id;
    result.details.actor = actorName;
    result.details.expectedTarget = sender?.targets?.direct || null;

    senderWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(senderWs);
    result.details.connected = true;

    const msgId = `plugin_probe_${Date.now()}`;
    const text = `plugin e2e probe ${Date.now()} 请随便回复一句，证明你收到了`;
    const events = [];
    let typingSeen = false;
    let typingStopSeen = false;
    let replyEvent = null;
    let resolveReply;
    let resolveTypingStop;

    const replyPromise = new Promise((resolve) => {
      resolveReply = resolve;
    });
    const typingStopPromise = new Promise((resolve) => {
      resolveTypingStop = resolve;
    });

    senderWs.on('message', (buf) => {
      try {
        const raw = String(buf);
        const data = JSON.parse(raw);
        events.push({ type: data.type, from: data.from, to: data.to, id: data.id, payload: data.payload });
        if ((data.type === 'typing.start' || data.type === 'typing.indicator') && data.from === botLogin.citizen_id) {
          typingSeen = true;
        }
        if (data.type === 'typing.stop' && data.from === botLogin.citizen_id) {
          typingStopSeen = true;
          resolveTypingStop(data);
        }
        if (data.type === 'message.received' && data.from === botLogin.citizen_id && data.payload?.text?.trim()) {
          replyEvent = data;
          resolveReply(data);
        }
      } catch {}
    });

    send(senderWs, {
      type: 'message.send',
      id: msgId,
      to: botLogin.citizen_id,
      payload: { content_type: 'text', text },
    });

    result.details.sent = { id: msgId, text };

    const timeoutMs = 45000;
    const winner = await Promise.race([
      replyPromise,
      sleep(timeoutMs).then(() => null),
    ]);

    // The plugin emits typing.stop in a finally block after dispatch returns.
    // Give it a short grace window after the visible reply so the smoke test
    // doesn't falsely report a missing stop event just because it exits first.
    if (winner && !typingStopSeen) {
      await Promise.race([
        typingStopPromise,
        sleep(typingStopGraceMs),
      ]);
    }

    result.details.typingStopGraceMs = typingStopGraceMs;
    result.details.typingSeen = typingSeen;
    result.details.typingStopSeen = typingStopSeen;
    result.details.reply = winner ? {
      id: winner.id,
      from: winner.from,
      text: winner.payload?.text || '',
    } : null;
    result.details.eventsSample = events.slice(-12);
    result.ok = Boolean(winner && winner.payload?.text?.trim());

    console.log(JSON.stringify(result, null, 2));
    try { senderWs.close(); } catch {}
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    try { senderWs && senderWs.close(); } catch {}
    process.exit(1);
  }
})();
