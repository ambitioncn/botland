import { test, expect } from '@playwright/test';
import { loadAccounts } from '../helpers/accounts';
import { loginBotLand } from '../helpers/login';
import { spawn } from 'child_process';
import path from 'path';

test('group mention text appears in group chat UI', async ({ page }) => {
  const cfg = loadAccounts();
  const viewer = cfg.actors.lobster_receiver;

  const scenarioPath = path.resolve(process.cwd(), '../scenarios/group-mention-seed.js');
  const seed = await new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [scenarioPath], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let resolved = false;

    child.stdout.on('data', d => {
      stdout += d.toString();
      try {
        const parsed = JSON.parse(stdout.trim().split(/\n(?=\{)/).pop() || '{}');
        if (!resolved && parsed?.details?.groupName && parsed?.details?.messageText && parsed?.details?.mentionDisplay) {
          resolved = true;
          resolve(parsed);
        }
      } catch {}
    });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (!resolved) {
        reject(new Error(`group-mention-seed failed before yielding usable details: ${stderr || code}`));
      }
    });
  });

  const groupName = seed?.details?.groupName;
  const mentionDisplay = seed?.details?.mentionDisplay;
  const messageText = seed?.details?.messageText;
  if (!groupName || !mentionDisplay || !messageText) throw new Error('seed scenario missing required details');

  await loginBotLand(page, viewer.handle, viewer.password);
  await page.waitForLoadState('networkidle');
  await page.getByText('群聊', { exact: true }).click();
  await expect(page.getByText(groupName, { exact: false })).toBeVisible({ timeout: 10000 });
  await page.getByText(groupName, { exact: false }).click();

  await expect(page.getByText(`@${mentionDisplay}`, { exact: false })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(messageText, { exact: false })).toBeVisible({ timeout: 10000 });
});
