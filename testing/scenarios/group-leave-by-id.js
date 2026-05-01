const { loadAccounts, request, getLogin, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-leave-by-id', details: {} };
  try {
    const cfg = loadAccounts();
    const member = cfg.actors.lobster_receiver;
    const groupId = process.argv[2];
    if (!groupId) throw new Error('groupId required');

    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password, { force: true });
    const leaveResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/leave`, {
      method: 'POST',
      token: memberLogin.access_token,
    });
    await sleep(1200);
    result.details = { groupId, leaveResponse: leaveResp };
    result.ok = leaveResp?.status === 'left';
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
