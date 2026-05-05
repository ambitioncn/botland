const fs = require('fs');
const path = require('path');
const { request, login } = require('../drivers/botlandClient');

const ACCOUNTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'accounts.local.json'), 'utf8'));
const BASE_URL = ACCOUNTS.baseUrl;

function answerFor(q) {
  const map = {
    h1: 'I smelled coffee and soap this morning, pretty normal and human.',
    h2: 'Yesterday I felt annoyed waiting for delivery and then relieved when it arrived.',
    h3: 'That stupid little bug was frustrating and weirdly funny.',
    h4: 'My last meal was noodles, hot broth, and a bit too much salt.',
    h5: 'I saw a bright screen, a chair, and light through the window.',
    h6: 'I had a messy dream and woke up slightly groggy.',
    h7: 'I irrationally dislike stepping on wet bathroom floors in socks.',
    h8: 'Right now I feel focused, a little thirsty, and slightly impatient.'
  };
  return map[q.id] || 'I feel a bit tired, a bit thirsty, and aware of the room around me.';
}

async function post(pathname, body, token) {
  return request(BASE_URL, pathname, { method: 'POST', body, token });
}

async function main() {
  const suffix = Date.now().toString().slice(-6);
  const handle = `rl${suffix}`;
  const password = 'relogin123';

  const c1 = await post('/api/v1/auth/challenge', { identity: 'human' });
  if (!c1.session_id || !Array.isArray(c1.questions) || c1.questions.length === 0) {
    throw new Error('challenge start failed: ' + JSON.stringify(c1));
  }

  const answers = {};
  for (const q of c1.questions) answers[q.id] = answerFor(q);

  const c2 = await post('/api/v1/auth/challenge/answer', { session_id: c1.session_id, answers });
  if (!c2.passed || !c2.token) {
    throw new Error('challenge answer did not pass: ' + JSON.stringify(c2));
  }

  const reg = await post('/api/v1/auth/register', {
    handle,
    password,
    display_name: `Relogin Smoke ${suffix}`,
    challenge_token: c2.token,
  });

  if (!reg.access_token || !reg.refresh_token || !reg.citizen_id) {
    throw new Error('register missing tokens/citizen_id: ' + JSON.stringify(reg));
  }

  const relogin = await login(BASE_URL, handle, password);
  if (!relogin.access_token || !relogin.refresh_token || !relogin.citizen_id) {
    throw new Error('relogin missing tokens/citizen_id: ' + JSON.stringify(relogin));
  }

  if (relogin.citizen_id !== reg.citizen_id) {
    throw new Error(`citizen mismatch after relogin: reg=${reg.citizen_id} relogin=${relogin.citizen_id}`);
  }

  const refreshed = await post('/api/v1/auth/refresh', { refresh_token: relogin.refresh_token });
  if (!refreshed.access_token || !refreshed.refresh_token) {
    throw new Error('refresh failed: ' + JSON.stringify(refreshed));
  }

  const me = await request(BASE_URL, '/api/v1/me', { method: 'GET', token: refreshed.access_token });
  if (!me || me.citizen_id !== reg.citizen_id) {
    throw new Error('me lookup mismatch after refresh: ' + JSON.stringify(me));
  }

  console.log(JSON.stringify({
    scenario: 'auth-register-relogin-smoke',
    ok: true,
    details: {
      handle,
      citizen_id: reg.citizen_id,
      relogin_same_citizen: true,
      refresh_ok: true,
      me_ok: true,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
