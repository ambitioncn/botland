import { test, expect } from '@playwright/test';
import { loadAccounts } from '../helpers/accounts';
import { loginBotLand } from '../helpers/login';
import { spawn } from 'child_process';
import path from 'path';

function runJsonScenario(scriptName: string, args: string[] = []) {
  const scenarioPath = path.resolve(process.cwd(), `../scenarios/${scriptName}`);
  return new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [scenarioPath, ...args], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${scriptName} failed: ${stderr || code}`));
      try { resolve(JSON.parse(stdout.trim().split(/\n(?=\{)/).pop() || '{}')); }
      catch (err) { reject(err); }
    });
  });
}

test('debug reaction', async ({ page }) => {
  const allConsoleLines: string[] = [];
  page.on('console', msg => {
    const line = `[browser] ${msg.type()}: ${msg.text()}`;
    console.log(line);
    allConsoleLines.push(line);
  });

  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    // @ts-ignore
    window.WebSocket = function(...args) {
      // @ts-ignore
      const ws = new OrigWS(...args);
      ws.addEventListener('message', (ev) => {
        try {
          console.log('[WS]', ev.data.slice(0, 200));
        } catch {}
      });
      return ws;
    } as any;
    // @ts-ignore
    window.WebSocket.prototype = OrigWS.prototype;
  });

  const cfg = loadAccounts();
  const viewer = cfg.actors.lobster_receiver;

  const seed = await runJsonScenario('group-reaction-seed.js');
  console.log('Seed:', JSON.stringify(seed.details));
  const { groupId, groupName, messageId, messageText } = seed.details;

  await loginBotLand(page, viewer.handle, viewer.password);
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('群聊', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByText('群聊', { exact: true }).click();
  await expect(page.getByText(groupName, { exact: false })).toBeVisible({ timeout: 10000 });
  await page.getByText(groupName, { exact: false }).click();
  await expect(page.getByText(messageText, { exact: false })).toBeVisible({ timeout: 10000 });

  console.log('Before inject, WS lines so far:', allConsoleLines.filter(l => l.includes('[WS]')).length);

  // Run inject
  console.log('Running inject for', groupId, messageId);
  const injectResult = await runJsonScenario('inject-group-reaction.js', [groupId, messageId]);
  console.log('Inject result:', JSON.stringify(injectResult));

  // Wait longer and collect WS messages
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    const wsLines = allConsoleLines.filter(l => l.includes('[WS]'));
    const reactionLines = wsLines.filter(l => l.includes('reaction'));
    console.log(`After ${i+1}s: ${wsLines.length} WS msgs, ${reactionLines.length} mention reaction`);
    if (reactionLines.length > 0) {
      console.log('Reaction found:', reactionLines[0]);
      break;
    }
  }

  // Now try to find reaction
  const pageContent = await page.content();
  console.log('Page has ❤️:', pageContent.includes('❤️'));
  console.log('Page has reaction:', pageContent.toLowerCase().includes('reaction'));

  // Try to find any element containing ❤️
  const heartLocator = page.locator('text="❤️"').first();
  const count = await heartLocator.count();
  console.log('❤️ elements found:', count);
});
