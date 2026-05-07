const { loadAccounts, getLogin, connectWS, waitForOpen, send } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'inject-group-reaction', details: {} };
  try {
    const cfg = loadAccounts();
    const actor = cfg.actors.lobster_sender;
    const groupId = process.argv[2];
    const messageId = process.argv[3];
    if (!actor?.handle || !actor?.password || !groupId || !messageId) throw new Error('usage: inject-group-reaction <groupId> <messageId>');

    const loginData = await getLogin(cfg.baseUrl, actor.handle, actor.password, { force: true });
    const ws = connectWS(cfg.wsUrl, loginData.access_token);
    await waitForOpen(ws);

    send(ws, {
      type: 'message.reaction',
      id: `rx_${Date.now()}`,
      to: groupId,
      payload: { message_id: messageId, emoji: '❤️' },
    });

    // Wait briefly to ensure server processes it
    await new Promise(r => setTimeout(r, 500));

    result.ok = true;
    result.details.groupId = groupId;
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
