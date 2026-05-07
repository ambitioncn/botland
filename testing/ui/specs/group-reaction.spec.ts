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
      try {
        resolve(JSON.parse(stdout.trim().split(/\n(?=\{)/).pop() || '{}'));
      } catch (err) {
        reject(err);
      }
    });
  });
}

test('reaction chip appears on a visible group message in chat UI', async ({ page }) => {
  const consoleLines: string[] = [];
  page.on('console', (msg) => {
    const line = `[browser-console] ${msg.type()} ${msg.text()}`;
    console.log(line);
    consoleLines.push(line);
  });

  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    // @ts-ignore
    window.WebSocket = function(...args) {
      // @ts-ignore
      const ws = new OrigWS(...args);
      ws.addEventListener('message', (ev) => {
        try {
          console.log('[ws-raw]', typeof ev.data === 'string' ? ev.data : '[non-string]');
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
  const groupName = seed?.details?.groupName;
  const groupId = seed?.details?.groupId;
  const messageText = seed?.details?.messageText;
  const messageId = seed?.details?.messageId;
  if (!groupName || !groupId || !messageText || !messageId) throw new Error('group-reaction-seed missing required details');

  await loginBotLand(page, viewer.handle, viewer.password);
  await page.waitForLoadState('networkidle');
  // Wait for groups tab to appear (rate-limit may delay UI)
  await expect(page.getByText('群聊', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByText('群聊', { exact: true }).click();
  await expect(page.getByText(groupName, { exact: false })).toBeVisible({ timeout: 10000 });
  await page.getByText(groupName, { exact: false }).click();
  await expect(page.getByText(messageText, { exact: false })).toBeVisible({ timeout: 10000 });

  await runJsonScenario('inject-group-reaction.js', [groupId, messageId]);

  await expect.poll(() => {
    return consoleLines.some(line => line.includes('[ws-raw]') && line.includes('"type":"message.reaction"') && line.includes(messageId));
  }, { timeout: 8000 }).toBe(true);

  await expect(page.getByText('❤️ 1', { exact: false })).toBeVisible({ timeout: 10000 });
});
