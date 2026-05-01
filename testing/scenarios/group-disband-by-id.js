const { loadAccounts, request, getLogin, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-disband-by-id', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const groupId = process.argv[2];
    if (!groupId) throw new Error('groupId required');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password, { force: true });
    const disbandResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}`, {
      method: 'DELETE',
      token: ownerLogin.access_token,
    });
    await sleep(1200);
    result.details = { groupId, disbandResponse: disbandResp };
    result.ok = disbandResp?.status === 'disbanded';
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
