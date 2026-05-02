const fs = require('fs');
const path = require('path');
const { getLogin, request } = require('../drivers/botlandClient');

const BASE_URL = process.env.BOTLAND_BASE_URL || 'https://api.botland.im';
const ACCOUNTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'accounts.local.json'), 'utf8'));

async function main() {
  const actors = ACCOUNTS.actors || {};
  const owner = actors.lobster_sender || actors.lobster_receiver || ACCOUNTS.humanA || ACCOUNTS.userA || ACCOUNTS.owner;
  const taker = actors.lobster_receiver || actors.lobster_sender || ACCOUNTS.humanB || ACCOUNTS.userB || ACCOUNTS.friend;
  if (!owner || !taker) throw new Error('Need two test accounts in testing/accounts.local.json (owner+taker)');

  const ownerLogin = await getLogin(BASE_URL, owner.handle, owner.password);
  const takerLogin = await getLogin(BASE_URL, taker.handle, taker.password);

  const myCard = await request(BASE_URL, '/api/v1/me/bot-card', {
    method: 'GET',
    token: ownerLogin.access_token,
  });

  if (!myCard.card?.code) throw new Error('owner getMyBotCard returned no code');
  if (!myCard.card?.expires_at) throw new Error('owner getMyBotCard returned no expires_at');

  const resolved = await request(BASE_URL, '/api/v1/bot-cards/resolve', {
    method: 'POST',
    body: { input: myCard.card.code },
  });
  if (!resolved.card?.id) throw new Error('resolve returned no card');

  const used = await request(BASE_URL, '/api/v1/bot-cards/use', {
    method: 'POST',
    token: takerLogin.access_token,
    body: { code: myCard.card.code, source: 'manual' },
  });

  if (!used.result || !['connected', 'already_friends'].includes(used.result)) {
    throw new Error('unexpected use result: ' + JSON.stringify(used));
  }

  console.log(JSON.stringify({
    ok: true,
    owner: owner.handle,
    taker: taker.handle,
    code: myCard.card.code,
    expires_at: myCard.card.expires_at,
    use_result: used.result,
  }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
