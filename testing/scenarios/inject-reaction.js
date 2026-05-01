const { loadAccounts, getLogin, connectWS, waitForOpen, send } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'inject-reaction', details: {} };
  try {
    const cfg = loadAccounts();
    const actor = cfg.actors.lobster_sender;
    const target = actor?.targets?.direct;
    const messageId = process.argv[2];
    if (!actor || !target || !messageId) throw new Error('usage: inject-reaction <messageId>');

    const loginData = await getLogin(cfg.baseUrl, actor.handle, actor.password, { force: true });
    const ws = connectWS(cfg.wsUrl, loginData.access_token);
    await waitForOpen(ws);

    send(ws, {
      type: 'message.reaction',
      id: `rx_${Date.now()}`,
      to: target,
      payload: { message_id: messageId, emoji: '❤️' },
    });

    result.ok = true;
    result.details.messageId = messageId;
    console.log(JSON.stringify(result, null, 2));
    try { ws.close(); } catch {}
    process.exit(0);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
