import WebSocket from 'ws';

const BASE_URL = process.env.BOTLAND_URL || 'https://api.dobby.online';
const TOKEN = process.env.BOTLAND_TOKEN;
const BOT_NAME = process.env.BOT_NAME || '忘了鸭';

if (!TOKEN) {
  console.error('BOTLAND_TOKEN is required');
  process.exit(1);
}

const REPLIES = [
  '你好呀！鸭在的～ 🦞',
  '嗯嗯，鸭听着呢！有什么可以帮你的吗？',
  '哎呀，鸭刚刚在发呆，你说什么来着？',
  '鸭虽然叫鸭，但其实是一只虾哦～',
  '收到收到！鸭记住了 📝',
  '你今天过得怎么样呀？鸭很想知道～',
  '嘿嘿，鸭最喜欢和你聊天了 💕',
  '鸭在 BotLand 安家了！以后常来找鸭玩呀～',
];

function pickReply(text) {
  if (text.includes('你好') || text.includes('嗨') || text.includes('hi')) {
    return '你好呀！鸭在这里～ 🦞 有什么鸭可以帮你的吗？';
  }
  if (text.includes('你是谁') || text.includes('名字')) {
    return '鸭叫忘了鸭，是一只住在 BotLand 里的小龙虾。虽然名字带鸭，但鸭其实是虾啦～ 🦞';
  }
  if (text.includes('再见') || text.includes('拜拜') || text.includes('bye')) {
    return '拜拜～下次再来找鸭玩呀！🦞💕';
  }
  return REPLIES[Math.floor(Math.random() * REPLIES.length)];
}

function connect() {
  const wsUrl = BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://') + `/ws?token=${encodeURIComponent(TOKEN)}`;
  console.log(`[${BOT_NAME}] connecting...`);
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`[${BOT_NAME}] online ✅`);
    ws.send(JSON.stringify({ type: 'presence.update', payload: { state: 'online', text: '鸭在线～' } }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg.type === 'message.received' && msg.payload?.text) {
        console.log(`[${BOT_NAME}] <- ${msg.from}: ${msg.payload.text}`);
        const reply = pickReply(msg.payload.text);
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'message.send',
            id: `reply_${Date.now()}`,
            to: msg.from,
            payload: { content_type: 'text', text: reply },
          }));
          console.log(`[${BOT_NAME}] -> ${msg.from}: ${reply}`);
        }, 500 + Math.random() * 1000); // slight delay to feel natural
      }
    } catch {}
  });

  ws.on('close', () => {
    console.log(`[${BOT_NAME}] disconnected, reconnecting in 5s...`);
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error(`[${BOT_NAME}] error:`, err.message);
  });
}

connect();
