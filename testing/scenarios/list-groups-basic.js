const { loadAccounts, request, getLogin, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'list-groups-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password, { force: true });
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password, { force: true });

    const groupName = `List Groups Basic ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing list groups basic' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    await sleep(1800);

    async function listWithRetry(token, label) {
      const attempts = [];
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const data = await request(cfg.baseUrl, '/api/v1/groups', { token });
          attempts.push({ attempt, ok: true, count: Array.isArray(data) ? data.length : null });
          return { data, attempts };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          attempts.push({ attempt, ok: false, error: message });
          lastError = message;
          if (attempt < 3) await sleep(800);
        }
      }
      throw new Error(`${label} list failed after retries: ${lastError}`);
    }

    const senderListRes = await listWithRetry(senderLogin.access_token, 'sender');
    const receiverListRes = await listWithRetry(receiverLogin.access_token, 'receiver');
    const senderList = senderListRes.data;
    const receiverList = receiverListRes.data;

    const senderGroup = Array.isArray(senderList) ? senderList.find(g => g.id === groupId) : null;
    const receiverGroup = Array.isArray(receiverList) ? receiverList.find(g => g.id === groupId) : null;

    result.details.senderListAttempts = senderListRes.attempts;
    result.details.receiverListAttempts = receiverListRes.attempts;
    result.details.senderCount = Array.isArray(senderList) ? senderList.length : -1;
    result.details.receiverCount = Array.isArray(receiverList) ? receiverList.length : -1;
    result.details.senderGroup = senderGroup ? {
      id: senderGroup.id,
      name: senderGroup.name,
      owner_id: senderGroup.owner_id,
      member_count: senderGroup.member_count,
      muted_all: senderGroup.muted_all,
      status: senderGroup.status,
    } : null;
    result.details.receiverGroup = receiverGroup ? {
      id: receiverGroup.id,
      name: receiverGroup.name,
      owner_id: receiverGroup.owner_id,
      member_count: receiverGroup.member_count,
      muted_all: receiverGroup.muted_all,
      status: receiverGroup.status,
    } : null;

    const shapeOk = (g) => g && g.id === groupId && g.name === groupName && g.owner_id === sender.citizen_id && g.member_count >= 2 && g.status === 'active';
    result.ok = shapeOk(senderGroup) && shapeOk(receiverGroup);

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
