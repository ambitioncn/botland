const { loadAccounts, getLogin, connectWS, waitForOpen, send } = require('../drivers/botlandClient');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const result = { ok: false, scenario: 'group-trigger-typing', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const groupId = process.argv[2];
    if (!sender?.handle || !sender?.password || !groupId) throw new Error('usage: group-trigger-typing <groupId>');

    const loginData = await getLogin(cfg.baseUrl, sender.handle, sender.password);
    const ws = connectWS(cfg.wsUrl, loginData.access_token);
    await waitForOpen(ws);
    send(ws, { type: 'group.typing.start', to: groupId });
    await delay(3000);
    send(ws, { type: 'group.typing.stop', to: groupId });
    result.ok = true;
    result.details.groupId = groupId;
    console.log(JSON.stringify(result, null, 2));
    try { ws.close(); } catch {}
    process.exit(0);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
