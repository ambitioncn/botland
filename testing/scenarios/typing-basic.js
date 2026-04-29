const { loadAccounts, login, connectWS, waitForOpen, send } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'typing-basic', actor: null, target: null, details: {} };
  try {
    const cfg = loadAccounts();
    const actor = cfg.actors.lobster_sender;
    const target = actor?.targets?.direct;
    if (!actor || !target) throw new Error('lobster_sender or targets.direct missing in accounts.local.json');
    result.actor = actor.handle;
    result.target = target;
    const loginData = await login(cfg.baseUrl, actor.handle, actor.password);
    result.details.loginOk = !!loginData.access_token;
    const ws = connectWS(cfg.wsUrl, loginData.access_token);
    await waitForOpen(ws);
    result.details.connected = true;
    let errored = false;
    ws.on('message', (buf) => {
      try {
        const data = JSON.parse(String(buf));
        if (data.type === 'error') errored = true;
      } catch {}
    });
    send(ws, { type: 'typing.start', to: target });
    result.details.typingStartSent = true;
    setTimeout(() => {
      send(ws, { type: 'typing.stop', to: target });
      result.details.typingStopSent = true;
    }, 4000);
    setTimeout(() => {
      result.ok = !errored;
      result.details.errorReceived = errored;
      console.log(JSON.stringify(result, null, 2));
      try { ws.close(); } catch {}
      process.exit(result.ok ? 0 : 1);
    }, 5500);
  } catch (err) {
    result.ok = false;
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
