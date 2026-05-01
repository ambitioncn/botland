const { loadAccounts, request, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

async function tryGetGroup(baseUrl, groupId, token) {
  try {
    const data = await request(baseUrl, `/api/v1/groups/${groupId}`, { token });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

(async () => {
  const result = { ok: false, scenario: 'group-leave-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password, { force: true });
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password, { force: true });

    const groupName = `Leave Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing leave basic' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const before = await tryGetGroup(cfg.baseUrl, groupId, ownerLogin.access_token);
    result.details.before = before;

    const leaveResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/leave`, {
      method: 'POST',
      token: memberLogin.access_token,
    });
    result.details.leaveResponse = leaveResp;

    const afterOwner = await tryGetGroup(cfg.baseUrl, groupId, ownerLogin.access_token);
    const afterMember = await tryGetGroup(cfg.baseUrl, groupId, memberLogin.access_token);
    result.details.after = { owner: afterOwner, member: afterMember };

    const memberWs = connectWS(cfg.wsUrl, memberLogin.access_token);
    await waitForOpen(memberWs);
    const memberEvents = [];
    memberWs.on('message', (buf) => { try { memberEvents.push(JSON.parse(String(buf))); } catch {} });

    const msgId = `leave_member_probe_${Date.now()}`;
    send(memberWs, {
      type: 'group.message.send',
      id: msgId,
      to: groupId,
      payload: { content_type: 'text', text: `leave member probe ${Date.now()}` },
    });

    await sleep(3000);

    const removedFromMembers = afterOwner.ok && !afterOwner.data.members.some(m => m.citizen_id === member.citizen_id);
    const memberLostAccess = !afterMember.ok;
    const memberErr = memberEvents.find(e => e.type === 'error' && (e.payload?.code === 'not_member' || e.payload?.message === 'you are not a member of this group'));

    result.details.memberEvents = memberEvents.map(e => ({ type: e.type, id: e.id, to: e.to, payload: e.payload }));
    result.ok = removedFromMembers && memberLostAccess && !!memberErr;

    console.log(JSON.stringify(result, null, 2));
    try { memberWs.close(); } catch {}
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
