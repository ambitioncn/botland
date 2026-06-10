import { test, expect } from '@playwright/test';
import { loadAccounts } from '../helpers/accounts';
import { loginBotLand } from '../helpers/login';
import { runJsonScenario } from '../helpers/residue';

test('typing indicator appears in chat UI', async ({ page }) => {
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
  const targetName = cfg.actors.lobster_sender?.ui_name || '忘了鸭';

  if (!viewer || !viewer.password || viewer.password === 'CHANGE_ME') throw new Error('Set lobster_receiver password in testing/accounts.local.json');
  await loginBotLand(page, viewer.handle, viewer.password);
  await page.waitForLoadState('networkidle');

  await page.getByText(targetName, { exact: false }).click();
  await expect(page.getByPlaceholder('输入消息...')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(2000);

  await runJsonScenario('typing-basic.js');

  await expect.poll(() => {
    return consoleLines.some(line => line.includes('[ws-raw]') && line.includes('\"type\":\"typing.start\"'));
  }, { timeout: 6000 }).toBe(true);
});
