import { test, expect } from '@playwright/test';
import { loadAccounts } from '../helpers/accounts';
import { loginBotLand } from '../helpers/login';
import { spawn } from 'child_process';
import path from 'path';

test('reaction chip appears on a visible message in chat UI', async ({ page }) => {
  const cfg = loadAccounts();
  const viewer = cfg.actors.lobster_receiver;
  const targetName = cfg.actors.lobster_sender?.ui_name || '忘了鸭';

  await loginBotLand(page, viewer.handle, viewer.password);
  await page.waitForLoadState('networkidle');
  await page.getByText(targetName, { exact: false }).click();
  await expect(page.getByPlaceholder('输入消息...')).toBeVisible({ timeout: 10000 });

  const seedText = `ui reaction seed ${Date.now()}`;
  await page.getByPlaceholder('输入消息...').fill(seedText);
  await page.getByText('发送', { exact: true }).click();
  await expect(page.getByText(seedText, { exact: false })).toBeVisible({ timeout: 10000 });

  const messageNode = page.getByText(seedText, { exact: false });
  const msgId = await messageNode.evaluate((el) => {
    let cur = el as HTMLElement | null;
    while (cur) {
      const reactFiber = Object.keys(cur).find(k => k.startsWith('__reactFiber$'));
      if (reactFiber) {
        let node: any = (cur as any)[reactFiber];
        while (node) {
          const id = node.memoizedProps?.item?.id;
          if (id) return id;
          node = node.return;
        }
      }
      cur = cur.parentElement;
    }
    return null;
  });

  if (!msgId) throw new Error('could not extract message id from rendered message');

  const scenarioPath = path.resolve(process.cwd(), '../scenarios/inject-reaction.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scenarioPath, msgId], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(null);
      else reject(new Error(`inject-reaction failed: ${stderr || code}`));
    });
  });

  await expect(page.getByText('❤️ 1', { exact: false })).toBeVisible({ timeout: 10000 });
});
