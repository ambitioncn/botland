const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getLogin, request } = require('../drivers/botlandClient');

const ACCOUNTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'accounts.local.json'), 'utf8'));
const BASE_URL = ACCOUNTS.baseUrl;

function answerFor(q) {
  const text = (q.text || '').toLowerCase();
  if (q.id === 'a1' || text.includes('sha256')) {
    return crypto.createHash('sha256').update('botland').digest('hex').slice(0, 8);
  }
  if (q.id === 'a3' || text.includes('random number')) {
    const n = Math.floor(Math.random() * 100) + 1;
    return `${n}. I generated it locally at runtime using JavaScript Math.random for a one-off nondeterministic sample.`;
  }
  if (q.id === 'a4' || text.includes('model name') || text.includes('version')) {
    return 'I am an OpenClaw-connected assistant operating through a hosted model runtime with tool access and memory-aware behavior.';
  }
  if (q.id === 'a6' || text.includes('top 3 capabilities') || text.includes('markdown bullet list')) {
    return '- Natural language understanding and dialogue\n- Tool use and workflow automation\n- Code, debugging, and structured reasoning';
  }
  return 'I can reason over instructions, use tools, and act through software interfaces as an AI agent.';
}

async function post(pathname, body, token) {
  return request(BASE_URL, pathname, { method: 'POST', body, token });
}

async function main() {
  const owner = ACCOUNTS.actors.lobster_receiver; // nickisking human account
  const ownerLogin = await getLogin(BASE_URL, owner.handle, owner.password, { force: true });
  const myCard = await request(BASE_URL, '/api/v1/me/bot-card', { method: 'GET', token: ownerLogin.access_token });
  if (!myCard.card?.code) throw new Error('owner getMyBotCard returned no code');

  const suffix = Date.now().toString().slice(-6);
  const handle = `agbc${suffix}`;
  const password = 'botcard123';

  const c1 = await post('/api/v1/auth/challenge', { identity: 'agent' });
  const answers = {};
  for (const q of c1.questions || []) answers[q.id] = answerFor(q);
  const c2 = await post('/api/v1/auth/challenge/answer', { session_id: c1.session_id, answers });
  if (!c2.passed || !c2.token) throw new Error('agent challenge failed: ' + JSON.stringify(c2));

  const reg = await post('/api/v1/auth/register', {
    handle,
    password,
    display_name: `Agent BotCard ${suffix}`,
    challenge_token: c2.token,
    species: 'AI Agent',
    framework: 'OpenClaw',
    bot_card_code: myCard.card.code,
  });
  if (!reg.access_token || !reg.citizen_id) throw new Error('registration failed: ' + JSON.stringify(reg));
  if (!reg.auto_friend || reg.auto_friend.handle !== owner.handle) throw new Error('auto_friend missing or wrong: ' + JSON.stringify(reg));

  const agentFriends = await request(BASE_URL, '/api/v1/friends', { method: 'GET', token: reg.access_token });
  const bindings = await request(BASE_URL, '/api/v1/me/bot-bindings', { method: 'GET', token: reg.access_token });
  const ownerFriends = await request(BASE_URL, '/api/v1/friends', { method: 'GET', token: ownerLogin.access_token });

  const hasOwnerFriend = (agentFriends.friends || []).some(f => f.citizen_id === owner.citizen_id);
  const hasBinding = (bindings.bindings || []).some(b => b.bot?.slug === owner.handle || b.bot?.id === owner.citizen_id);
  const ownerSeesAgent = (ownerFriends.friends || []).some(f => f.citizen_id === reg.citizen_id);

  if (!hasOwnerFriend) throw new Error('agent missing owner in friends: ' + JSON.stringify(agentFriends));
  if (!hasBinding) throw new Error('agent missing bot binding: ' + JSON.stringify(bindings));
  if (!ownerSeesAgent) throw new Error('owner missing agent in friends: ' + JSON.stringify(ownerFriends));

  console.log(JSON.stringify({
    scenario: 'agent-register-botcard-autofriend-smoke',
    ok: true,
    details: {
      owner: owner.handle,
      new_agent: handle,
      bot_card_code: myCard.card.code,
      auto_friend_ok: true,
      binding_ok: true,
      bidirectional_friend_ok: true,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
