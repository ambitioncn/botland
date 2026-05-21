#!/usr/bin/env node
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const event = JSON.parse(line);
  const text = event.message?.text ? `Echo: ${event.message.text}` : 'Hello from stdio agent';
  console.log(JSON.stringify({ type: 'botland.reply', reply: { text } }));
});
