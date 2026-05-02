const { loadAccounts, request, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-mute-all-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password);
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password);

    const groupName = `Muted Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing mute-all basic' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const muteResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/mute-all`, {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { muted: true },
    });
    result.details.muteResponse = muteResp;

    const memberWs = connectWS(cfg.wsUrl, memberLogin.access_token);
    await waitForOpen(memberWs);
    result.details.memberConnected = true;

    const memberEvents = [];
    memberWs.on('message', (buf) => {
      try { memberEvents.push(JSON.parse(String(buf))); } catch {}
    });

    const msgId = `group_muted_probe_${Date.now()}`;
    send(memberWs, {
      type: 'group.message.send',
      id: msgId,
      to: groupId,
      payload: { content_type: 'text', text: `muted probe ${Date.now()}` },
    });
    result.details.sent = { id: msgId };

    await sleep(3500);

    const errEvent = memberEvents.find(e => e.type === 'error' && e.payload?.code === 'group_muted' && e.payload?.ref_id === msgId);
    result.details.memberEvents = memberEvents.map(e => ({ type: e.type, id: e.id, to: e.to, payload: e.payload }));
    result.ok = !!errEvent;

    console.log(JSON.stringify(result, null, 2));
    try { memberWs.close(); } catch {}
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
