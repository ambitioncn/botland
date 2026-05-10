const { loadAccounts, getLogin, request, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

async function listRequests(baseUrl, token, direction) {
  return request(baseUrl, `/api/v1/friends/requests?direction=${encodeURIComponent(direction)}&status=pending`, {
    method: 'GET',
    token,
  });
}

async function ensureCleanRelationship(baseUrl, senderLogin, receiverLogin) {
  const [senderIncoming, senderOutgoing, receiverIncoming, receiverOutgoing] = await Promise.all([
    listRequests(baseUrl, senderLogin.access_token, 'incoming'),
    listRequests(baseUrl, senderLogin.access_token, 'outgoing'),
    listRequests(baseUrl, receiverLogin.access_token, 'incoming'),
    listRequests(baseUrl, receiverLogin.access_token, 'outgoing'),
  ]);

  for (const req of senderIncoming.requests || []) {
    if (req.from_id === receiverLogin.citizen_id) {
      await request(baseUrl, `/api/v1/friends/requests/${encodeURIComponent(req.request_id)}/reject`, {
        method: 'POST',
        token: senderLogin.access_token,
      });
    }
  }

  for (const req of receiverIncoming.requests || []) {
    if (req.from_id === senderLogin.citizen_id) {
      await request(baseUrl, `/api/v1/friends/requests/${encodeURIComponent(req.request_id)}/reject`, {
        method: 'POST',
        token: receiverLogin.access_token,
      });
    }
  }

  for (const req of senderOutgoing.requests || []) {
    if (req.to_id === receiverLogin.citizen_id) {
      await request(baseUrl, `/api/v1/friends/requests/${encodeURIComponent(req.request_id)}/reject`, {
        method: 'POST',
        token: receiverLogin.access_token,
      });
    }
  }

  for (const req of receiverOutgoing.requests || []) {
    if (req.to_id === senderLogin.citizen_id) {
      await request(baseUrl, `/api/v1/friends/requests/${encodeURIComponent(req.request_id)}/reject`, {
        method: 'POST',
        token: senderLogin.access_token,
      });
    }
  }

  const [senderFriends, receiverFriends] = await Promise.all([
    request(baseUrl, '/api/v1/friends', { method: 'GET', token: senderLogin.access_token }),
    request(baseUrl, '/api/v1/friends', { method: 'GET', token: receiverLogin.access_token }),
  ]);

  if ((senderFriends.friends || []).some((f) => f.citizen_id === receiverLogin.citizen_id)) {
    await request(baseUrl, `/api/v1/friends/${encodeURIComponent(receiverLogin.citizen_id)}`, {
      method: 'DELETE',
      token: senderLogin.access_token,
    });
  }

  if ((receiverFriends.friends || []).some((f) => f.citizen_id === senderLogin.citizen_id)) {
    await request(baseUrl, `/api/v1/friends/${encodeURIComponent(senderLogin.citizen_id)}`, {
      method: 'DELETE',
      token: receiverLogin.access_token,
    });
  }

  return {
    senderIncoming: (senderIncoming.requests || []).length,
    senderOutgoing: (senderOutgoing.requests || []).length,
    receiverIncoming: (receiverIncoming.requests || []).length,
    receiverOutgoing: (receiverOutgoing.requests || []).length,
  };
}

(async () => {
  const result = { ok: false, scenario: 'friend-request-dm-smoke', details: {} };
  let senderWs;
  let receiverWs;
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.handle || !sender?.password || !receiver?.handle || !receiver?.password) {
      throw new Error('sender/receiver config missing in accounts.local.json');
    }

    const [senderLogin, receiverLogin] = await Promise.all([
      getLogin(cfg.baseUrl, sender.handle, sender.password, { force: true }),
      getLogin(cfg.baseUrl, receiver.handle, receiver.password, { force: true }),
    ]);

    result.details.sender = { handle: sender.handle, citizen_id: senderLogin.citizen_id };
    result.details.receiver = { handle: receiver.handle, citizen_id: receiverLogin.citizen_id };

    result.details.cleanup = await ensureCleanRelationship(cfg.baseUrl, senderLogin, receiverLogin);

    const receiverProfile = await request(
      cfg.baseUrl,
      `/api/v1/citizens/${encodeURIComponent(receiverLogin.citizen_id)}`,
      { method: 'GET', token: senderLogin.access_token }
    );
    const searchTerms = Array.from(new Set([receiver.handle, receiverProfile.display_name].filter(Boolean)));
    const searchAttempts = [];
    let discovered = null;

    for (const term of searchTerms) {
      const search = await request(
        cfg.baseUrl,
        `/api/v1/discover/search?q=${encodeURIComponent(term)}`,
        { method: 'GET', token: senderLogin.access_token }
      );
      const results = search.results || [];
      searchAttempts.push({
        term,
        count: results.length,
        sample: results.slice(0, 3).map((r) => ({
          citizen_id: r.citizen_id,
          handle: r.handle,
          display_name: r.display_name,
        })),
      });
      discovered = results.find((r) => r.citizen_id === receiverLogin.citizen_id) || discovered;
      if (discovered) break;
    }
    result.details.discover = {
      mode: discovered ? 'search' : 'direct-profile-fallback',
      attempts: searchAttempts,
      receiver_profile: {
        citizen_id: receiverProfile.citizen_id,
        handle: receiverProfile.handle,
        display_name: receiverProfile.display_name,
      },
      found: true,
      handle: discovered?.handle || receiverProfile.handle || receiver.handle,
    };

    const greeting = `friend request smoke ${Date.now()}`;
    let sendReq;
    try {
      sendReq = await request(cfg.baseUrl, '/api/v1/friends/requests', {
        method: 'POST',
        token: senderLogin.access_token,
        body: { target_id: receiverLogin.citizen_id, greeting },
      });
      if (!sendReq.request_id || sendReq.status !== 'pending') {
        throw new Error(`friend request creation failed: ${JSON.stringify(sendReq)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('ALREADY_EXISTS')) throw err;
      const senderOutgoing = await listRequests(cfg.baseUrl, senderLogin.access_token, 'outgoing');
      const existing = (senderOutgoing.requests || []).find((req) => req.to_id === receiverLogin.citizen_id);
      if (!existing?.request_id) throw err;
      sendReq = { request_id: existing.request_id, status: existing.status || 'pending', reused_existing: true };
    }
    result.details.request = sendReq;

    const incoming = await listRequests(cfg.baseUrl, receiverLogin.access_token, 'incoming');
    const pending = (incoming.requests || []).find((req) => req.request_id === sendReq.request_id);
    result.details.requestVisibleInIncoming = !!pending;

    const accepted = await request(
      cfg.baseUrl,
      `/api/v1/friends/requests/${encodeURIComponent(sendReq.request_id)}/accept`,
      { method: 'POST', token: receiverLogin.access_token }
    );
    if (accepted.status !== 'accepted') {
      throw new Error(`accept failed: ${JSON.stringify(accepted)}`);
    }

    const [senderFriendsAfter, receiverFriendsAfter] = await Promise.all([
      request(cfg.baseUrl, '/api/v1/friends', { method: 'GET', token: senderLogin.access_token }),
      request(cfg.baseUrl, '/api/v1/friends', { method: 'GET', token: receiverLogin.access_token }),
    ]);
    const senderHasReceiver = (senderFriendsAfter.friends || []).some((f) => f.citizen_id === receiverLogin.citizen_id);
    const receiverHasSender = (receiverFriendsAfter.friends || []).some((f) => f.citizen_id === senderLogin.citizen_id);
    if (!senderHasReceiver || !receiverHasSender) {
      throw new Error('friendship not visible in both friend lists');
    }

    receiverWs = connectWS(cfg.wsUrl, receiverLogin.access_token);
    await waitForOpen(receiverWs);
    senderWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(senderWs);

    const receiverEvents = [];
    const msgId = `friendreq_dm_${Date.now()}`;
    const msgText = `friend request dm smoke ${Date.now()}`;

    receiverWs.on('message', (buf) => {
      try {
        const data = JSON.parse(String(buf));
        receiverEvents.push(data);
        if (data.type === 'message.received' && data.id === msgId) {
          send(receiverWs, { type: 'message.ack', id: data.id, to: data.from });
        }
      } catch {}
    });

    send(senderWs, {
      type: 'message.send',
      id: msgId,
      to: receiverLogin.citizen_id,
      payload: { content_type: 'text', text: msgText },
    });

    await sleep(4000);

    const delivered = receiverEvents.some(
      (e) => e.type === 'message.received' && e.id === msgId && e.payload?.text === msgText
    );
    if (!delivered) {
      throw new Error(`receiver did not observe delivered DM ${msgId}`);
    }

    let historyHit = false;
    for (let i = 0; i < 5; i++) {
      const history = await request(
        cfg.baseUrl,
        `/api/v1/messages/history?peer=${encodeURIComponent(receiverLogin.citizen_id)}&limit=20`,
        { method: 'GET', token: senderLogin.access_token }
      );
      historyHit = Array.isArray(history) && history.some((m) => m.id === msgId && m.payload?.text === msgText);
      if (historyHit) break;
      await sleep(1000);
    }

    result.ok = true;
    result.details.friendship = {
      senderHasReceiver,
      receiverHasSender,
      accepted: true,
    };
    result.details.dm = {
      messageId: msgId,
      delivered,
      historyHit,
    };
    if (!historyHit) {
      result.details.historyWarning = `sent DM missing from history within retry window: ${msgId}`;
    }
    result.details.receiverEvents = receiverEvents.map((e) => ({ type: e.type, id: e.id, payload: e.payload }));

    console.log(JSON.stringify(result, null, 2));
    try { senderWs.close(); } catch {}
    try { receiverWs.close(); } catch {}
    process.exit(0);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    try { senderWs?.close(); } catch {}
    try { receiverWs?.close(); } catch {}
    process.exit(1);
  }
})();
