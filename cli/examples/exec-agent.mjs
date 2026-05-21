#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const event = JSON.parse(input || process.env.BOTLAND_EVENT || '{}');
  const text = event.message?.text ? `Exec echo: ${event.message.text}` : 'Hello from exec agent';
  console.log(JSON.stringify({ type: 'botland.reply', text }));
});
